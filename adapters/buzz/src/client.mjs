// One relay connection for a few requests, then closed: what the task tools
// (src/task.mjs) need, in the channel's server and in the one-shot
// `launch.mjs task`. It reads (REQ until EOSE) and publishes (EVENT until OK),
// and logs in (NIP-42) the way the one-shot send does:
//   - a relay that sends its challenge at once is answered before any request;
//   - a relay that sends none within a few seconds gets the requests without a
//     login; if it then refuses one with "auth-required:", the client logs in
//     when the challenge comes and sends that request once more.
// With an owner's NIP-OA tag (BUZZ_AUTH_TAG), the login carries it as its one
// `auth` tag, as the channel's and the send's do.
//
// Every request is bounded by the client's deadline. Errors are fixed words or
// the relay's own reason (cut to 200 characters), never the key or a message.
import { finalizeEvent } from "nostr-tools/pure";

const KIND_AUTH = 22242;
const AUTH_WAIT_MS = 3000;
const OPEN = 1;

export class RelayError extends Error {}

/** A relay-supplied value as short text on one line: control characters and line breaks become spaces. */
const text = (value) => (typeof value === "string" ? value.slice(0, 200).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ") : "");

export class RelayClient {
  /**
   * @param {object} o
   * @param {string} o.url the relay's websocket URL
   * @param {Uint8Array} o.secret the key: it signs the login and the events
   * @param {string[]} [o.authTag] the owner's NIP-OA `auth` tag
   * @param {number} [o.timeoutMs] the deadline for everything this client does
   */
  constructor({ url, secret, authTag, timeoutMs = 30_000, WebSocketImpl = globalThis.WebSocket }) {
    this.url = url;
    this.secret = secret;
    this.authTag = Array.isArray(authTag) ? [...authTag] : null;
    this.timeoutMs = timeoutMs;
    this.WebSocket = WebSocketImpl;
    this.seq = 0;
    this.pending = new Map(); // subscription or event id -> handlers
    this.authId = null;
    this.authed = false;
    this.challenge = null;
    this.waiters = []; // resolved when the login is accepted, rejected when refused
    this.dead = null; // the error that ended the connection, once one did
  }

  /** Opens the connection and logs in when the relay asks at once. */
  async open() {
    this.deadline = Date.now() + this.timeoutMs;
    const ws = new this.WebSocket(this.url);
    this.ws = ws;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new RelayError(`no answer from the relay within ${this.timeoutMs} ms`)), this.left());
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new RelayError("could not reach the relay"));
      };
    });
    ws.onmessage = (frame) => this.frame(frame.data);
    ws.onerror = () => this.fail(new RelayError("connection error"));
    ws.onclose = (event) => this.fail(new RelayError(`the relay closed the connection (code ${event?.code ?? "unknown"})`));
    // A relay that wants a login usually sends its challenge at once.
    const asked = Date.now() + Math.min(AUTH_WAIT_MS, this.left());
    while (this.challenge === null && Date.now() < asked) await sleep(25);
    if (this.challenge !== null) await this.loggedIn();
    return this;
  }

  left() {
    return Math.max(0, this.deadline - Date.now());
  }

  close() {
    for (const [, p] of this.pending) p.reject(new RelayError("closed"));
    this.pending.clear();
    if (this.ws) {
      this.ws.onopen = this.ws.onmessage = this.ws.onerror = this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        // already gone
      }
    }
  }

  fail(err) {
    this.dead ??= err;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  send(message) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(message));
  }

  frame(raw) {
    let data;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    if (!Array.isArray(data)) return;
    const [type, a, b, c] = data;
    if (type === "AUTH" && typeof a === "string") {
      if (this.challenge === null) {
        this.challenge = a;
        this.login(a);
      }
    } else if (type === "OK" && this.authId !== null && a === this.authId) {
      if (b === true) {
        this.authed = true;
        for (const w of this.waiters.splice(0)) w.resolve();
      } else {
        this.fail(new RelayError(`the relay refused the login: ${text(c)}`));
      }
    } else if (typeof a === "string" && this.pending.has(a)) {
      const p = this.pending.get(a);
      if (type === "EVENT" && p.events) p.events.push(b);
      else if (type === "EOSE" && p.events) p.done();
      else if (type === "CLOSED" && p.events) p.refused(text(b));
      else if (type === "OK" && !p.events) {
        if (b === true) p.done();
        else p.refused(text(c));
      }
    }
  }

  login(challenge) {
    const auth = finalizeEvent(
      {
        kind: KIND_AUTH,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [
          ["relay", this.url],
          ["challenge", challenge],
          // At most one `auth` tag: NIP-OA reads two or more as none.
          ...(this.authTag ? [[...this.authTag]] : []),
        ],
      },
      this.secret,
    );
    this.authId = auth.id;
    this.send(["AUTH", auth]);
  }

  /** Resolves once the relay accepted the login (whenever its challenge comes), within the deadline. */
  loggedIn() {
    if (this.authed) return Promise.resolve();
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new RelayError(this.challenge === null ? "the relay wants a login but sent no challenge in time" : "the relay did not answer the login in time")),
        this.left(),
      );
      this.waiters.push({
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }

  /** One request: a REQ (events until EOSE) or an EVENT (until OK), once more after a late login. */
  async request(kind, payload) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.once(kind, payload);
      } catch (err) {
        if (!(err instanceof AuthRequired) || this.authed || attempt > 0) throw err.relayError ?? err;
        await this.loggedIn();
      }
    }
  }

  once(kind, payload) {
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => {
      const id = kind === "query" ? `gp-task-${++this.seq}` : payload.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RelayError(`no answer from the relay within ${this.timeoutMs} ms`));
      }, this.left());
      const finish = () => {
        clearTimeout(timer);
        this.pending.delete(id);
      };
      const p = {
        events: kind === "query" ? [] : null,
        done: () => {
          finish();
          if (kind === "query") this.send(["CLOSE", id]);
          resolve(p.events);
        },
        refused: (reason) => {
          finish();
          const err = new RelayError(kind === "query" ? `the relay refused the read: ${reason}` : `the relay refused the event: ${reason}`);
          reject(reason.startsWith("auth-required") ? Object.assign(new AuthRequired(), { relayError: err }) : err);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      };
      this.pending.set(id, p);
      this.send(kind === "query" ? ["REQ", id, ...payload] : ["EVENT", payload]);
    });
  }

  /** The events that match `filters`, as the relay sends them (unchecked). */
  query(filters) {
    return this.request("query", filters);
  }

  /** Signs `template` with the client's key and publishes it; resolves with the event once the relay took it. */
  async publish(template) {
    const event = finalizeEvent(template, this.secret);
    await this.request("publish", event);
    return event;
  }
}

class AuthRequired extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
