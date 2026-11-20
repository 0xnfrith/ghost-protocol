// The agent's status line: one short line that says whether the agent is
// working, idle or waiting, on what, and for what, published as a NIP-38 user
// status (kind 30315, d=general), with the agent's presence (kind 20001)
// beside it. Every member of the relay can read both, so the line is built
// only from fixed words, event ids, and the text the agent itself gives the
// channel's `status` tool. A message's text has no way in: nothing here takes
// it (see "Status line" in README.md, which is the format's one contract).
//
//   formatLine / parseLine   the line's grammar, its caps and its cutting
//   StatusPublisher          when a line goes out (settle, gap, refresh,
//                            expiry), and presence; on any clock (tests use
//                            a fake one)
//   ownClaude                whether this channel's claude is the instance's
//                            own (hooks/lib/own-claude.sh, in Node)
//   watchInstance            the instance's local inputs: the turn marker
//                            (hooks/turn-state) and the unattended-deny wait
//   readStatuses             the read: each agent's newest line, its name
//                            and its presence, every event checked
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { verifyEvent } from "nostr-tools/pure";

export const KIND_STATUS = 30315;
export const KIND_PRESENCE = 20001;
const KIND_PROFILE = 0;
const KIND_HTTP_AUTH = 27235;

/** Buzz's app drops a status longer than this (UTF-16 units, as JS counts). */
export const LINE_MAX = 100;
export const TASK_MAX = 50;
export const WAIT_MAX = 50;
export const LINE_STATES = ["working", "idle", "waiting"];
/** The wait the unattended-deny hook leaves: fixed words. */
export const DENY_WAIT = "a person to allow a step";

export const SETTLE_MS = 3000;
export const GAP_MS = 15_000;
export const REFRESH_MS = 10 * 60_000;
export const EXPIRY_SECONDS = 30 * 60;
export const PRESENCE_MS = 60_000;
const NAMES_KEPT = 32;
const HEX64 = /^[0-9a-f]{64}$/;

/** Text as one plain line: control characters and line breaks become spaces, `|` becomes `/`, runs of spaces one. */
export function clean(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/\|/g, "/")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Why the agent's own words may not go into the public line, or null when
 * they may: they look like a key (a Nostr nsec1/npub1/… string, or a run of 64
 * hex), a token (a run of 32 or more letters, digits and `_-+=` mixing letters
 * and digits), or a path (any `/` or `\\`). Checked on the words as given,
 * before cleaning and cutting, so a cut cannot hide a key's start.
 */
export function refusedText(text) {
  const s = String(text ?? "");
  if (/(?:nsec|npub|nprofile|nevent|naddr|ncryptsec)1[02-9ac-hj-np-z]{6,}/i.test(s) || /[0-9a-f]{64}/i.test(s)) {
    return "it looks like a key";
  }
  for (const run of s.match(/[A-Za-z0-9_+=-]{32,}/g) ?? []) {
    if (/[0-9]/.test(run) && /[A-Za-z]/.test(run)) return "it looks like a token";
  }
  if (/[/\\]/.test(s)) return "it looks like a path (it has a / or \\)";
  return null;
}

/** Refused words: named() changes nothing. */
export class StatusTextRefused extends Error {}

/** At most `max` UTF-16 units: longer text is cut and ends with "…", never in the middle of a character's pair. */
export function cut(text, max) {
  if (text.length <= max) return text;
  let s = text.slice(0, Math.max(0, max - 1));
  const last = s.charCodeAt(s.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
  return `${s.trimEnd()}…`;
}

/**
 * The line: `<state>[ | task: <text>][ | waits on: <text>]`. idle has neither
 * text; working may name a task; waiting names what it waits on, and may name
 * the task. Each text is cleaned and cut to its cap; when the whole line would
 * pass LINE_MAX, the task is cut further.
 */
export function formatLine({ state, task, waitsOn }) {
  let t = task ? cut(clean(task), TASK_MAX) : "";
  const w = waitsOn ? cut(clean(waitsOn), WAIT_MAX) : "";
  if (state === "working") return t ? `working | task: ${t}` : "working";
  if (state !== "waiting" || !w) return "idle";
  const overhead = "waiting".length + (t ? " | task: ".length : 0) + " | waits on: ".length;
  if (t && t.length + w.length > LINE_MAX - overhead) t = cut(t, LINE_MAX - overhead - w.length);
  return t ? `waiting | task: ${t} | waits on: ${w}` : `waiting | waits on: ${w}`;
}

const LINE = /^(working|idle|waiting)(?: \| task: ([^|]+))?(?: \| waits on: ([^|]+))?$/;

/** The line's parts, or null when it is not a line of this grammar. */
export function parseLine(line) {
  if (typeof line !== "string" || line.length > LINE_MAX) return null;
  const m = LINE.exec(line);
  if (!m) return null;
  const [, state, task = null, waitsOn = null] = m;
  for (const part of [task, waitsOn]) if (part !== null && (part !== clean(part) || part === "")) return null;
  if (state === "idle" && (task || waitsOn)) return null;
  if (state === "working" && waitsOn) return null;
  if (state === "waiting" && !waitsOn) return null;
  return { state, task, waits_on: waitsOn };
}

/** The fallback task name for a root: its first 8 hex. */
export const rootTask = (root) => `task ${root.slice(0, 8)}`;

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (t) => clearInterval(t),
};

/**
 * Decides the line and when it goes out. Its inputs carry no message text:
 * turn() takes "busy" or "idle", delivered() and taskSet() a root's event id
 * (64 hex, anything else is dropped), denied() nothing, and named() the
 * agent's own words from its `status` tool call.
 *
 * - busy, or a message just delivered: working, with the current root's task
 *   (the agent's name for it; without one, the root id only when the root
 *   came from a public channel, else no task);
 * - otherwise, with a wait set: waiting, with the task the wait was set for;
 * - otherwise idle.
 * A change waits settleMs, so a quick turn sends only its result; then the
 * newest line goes out, at most one every gapMs, and not when it is the line
 * already sent. Working and waiting lines expire expirySeconds after they are
 * sent and go out again every refreshMs while still true; idle never expires.
 * The first login sends the current line at once; presence goes out at each
 * login and every presenceMs while connected, and offline at stop().
 */
export class StatusPublisher {
  constructor({
    send,
    presence,
    own = () => true,
    log = () => {},
    clock = realClock,
    settleMs = SETTLE_MS,
    gapMs = GAP_MS,
    refreshMs = REFRESH_MS,
    expirySeconds = EXPIRY_SECONDS,
    presenceMs = PRESENCE_MS,
  }) {
    Object.assign(this, { sendEvent: send, sendPresence: presence, own, log, clock, settleMs, gapMs, refreshMs, expirySeconds, presenceMs });
    this.busy = false;
    this.root = null;
    this.names = new Map(); // root ("" for none) -> the agent's name for its task
    this.publicRoots = new Set(); // roots delivered from a public channel: their id may name the task
    this.wait = null; // { text, key, deny }
    this.sent = null; // { line, at }
    this.timer = null;
    this.refreshTimer = null;
    this.presenceTimer = null;
    this.live = false;
    this.everLive = false;
    this.firstPending = false;
    this.notOwnSaid = false;
    this.stopped = false;
  }

  /** The turn marker changed: "busy" (a turn began) or "idle" (it ended). */
  turn(kind) {
    if (kind === "busy") {
      this.busy = true;
      if (this.wait?.deny) this.wait = null;
    } else if (kind === "idle") {
      this.busy = false;
      if (!this.wait) this.root = null;
    } else return;
    this.changed();
  }

  /**
   * A message was delivered to the session: its thread's root (or its own id,
   * at the top level), and whether it came from a public channel. Only a
   * public channel's root may stand in for an unnamed task: work from a DM or
   * a private channel shows plain `working` until the agent names it.
   */
  delivered(root, { public: open = false } = {}) {
    if (typeof root !== "string" || !HEX64.test(root)) return;
    this.publicRoots.delete(root);
    if (open === true) {
      this.publicRoots.add(root);
      while (this.publicRoots.size > NAMES_KEPT) this.publicRoots.delete(this.publicRoots.values().next().value);
    }
    this.root = root;
    this.busy = true;
    this.changed();
  }

  /** The `task` tool set a root's state. */
  taskSet(root, state) {
    if (typeof root !== "string" || !HEX64.test(root)) return;
    if (state === "open" || state === "emergency") {
      this.root = root;
    } else if (state === "done" || state === "none") {
      this.names.delete(root);
      this.publicRoots.delete(root);
      if (this.wait?.key === root) this.wait = null;
      if (this.root === root) this.root = null;
    } else return;
    this.changed();
  }

  /** The unattended-deny hook refused a dialog: waiting for a person, until the next turn starts. */
  denied() {
    this.wait = { text: DENY_WAIT, key: this.root ?? "", deny: true };
    this.changed();
  }

  /**
   * The agent's `status` call: task names the current task, waits_on what it
   * waits on; "" clears either, undefined leaves it. Returns the line as it
   * stands now. Words that look like a key, a token or a path are refused
   * (StatusTextRefused, and nothing changes).
   */
  named({ task, waitsOn }) {
    for (const [field, text] of [["task", task], ["waits_on", waitsOn]]) {
      const why = typeof text === "string" ? refusedText(text) : null;
      if (why) throw new StatusTextRefused(`${field} refused: ${why}; name it by its issue id and a few plain words. Nothing was changed.`);
    }
    const key = this.root ?? "";
    if (typeof task === "string") {
      const t = cut(clean(task), TASK_MAX);
      if (t) {
        this.names.delete(key);
        this.names.set(key, t);
        while (this.names.size > NAMES_KEPT) this.names.delete(this.names.keys().next().value);
      } else this.names.delete(key);
    }
    if (typeof waitsOn === "string") {
      const w = cut(clean(waitsOn), WAIT_MAX);
      this.wait = w ? { text: w, key, deny: false } : null;
    }
    this.changed();
    return this.line();
  }

  taskOf(key) {
    return this.names.get(key) ?? (key && this.publicRoots.has(key) ? rootTask(key) : null);
  }

  /** The line as the state stands now. */
  line() {
    if (this.busy) return formatLine({ state: "working", task: this.taskOf(this.root ?? "") });
    if (this.wait) return formatLine({ state: "waiting", task: this.taskOf(this.wait.key), waitsOn: this.wait.text });
    return "idle";
  }

  changed() {
    if (this.stopped || this.timer) return;
    this.timer = this.clock.setTimeout(() => this.flush(), this.settleMs);
  }

  /** The newest line, when it is due: `force` sends it even when it is the one already sent. */
  flush(force = false) {
    this.clock.clearTimeout(this.timer);
    this.timer = null;
    if (this.stopped || !this.live) return;
    if (!this.isOwn()) return;
    const line = this.line();
    const now = this.clock.now();
    if (!force && this.sent && this.sent.line === line) return;
    if (this.sent && now - this.sent.at < this.gapMs) {
      this.timer = this.clock.setTimeout(() => this.flush(force), this.sent.at + this.gapMs - now);
      return;
    }
    // Each line a second after the last at least: of two lines with the same
    // created_at, a reader keeps the lower id (NIP-01), which may be the older.
    const createdAt = Math.max(Math.floor(now / 1000), (this.sentAt ?? 0) + 1);
    this.sentAt = createdAt;
    const expires = !line.startsWith("idle");
    const template = {
      kind: KIND_STATUS,
      created_at: createdAt,
      tags: [["d", "general"], ...(expires ? [["expiration", String(createdAt + this.expirySeconds)]] : [])],
      content: line,
    };
    this.sent = { line, at: now };
    this.clock.clearTimeout(this.refreshTimer);
    this.refreshTimer = expires ? this.clock.setTimeout(() => this.refresh(), this.refreshMs) : null;
    Promise.resolve()
      .then(() => this.sendEvent(template))
      .then(
        (ok) => {
          if (ok === false) this.retryLater(line);
        },
        () => this.retryLater(line),
      );
  }

  refresh() {
    this.refreshTimer = null;
    this.flush(true);
  }

  /** A line the relay did not take is sent again after the gap, unless a newer one went out meanwhile. */
  retryLater(line) {
    if (this.sent?.line !== line) return;
    this.sent = { line: null, at: this.sent.at };
    this.changed();
  }

  isOwn() {
    if (this.own()) return true;
    if (!this.notOwnSaid) {
      this.notOwnSaid = true;
      this.log("status line: this session is not the instance's own claude (start's pane-pid); nothing is published");
    }
    return false;
  }

  /** The channel logged in: the first time, the current line goes out at once; presence now and every presenceMs. */
  connected() {
    if (this.stopped) return;
    this.live = true;
    if (!this.everLive) this.firstPending = true;
    this.everLive = true;
    this.clock.clearInterval(this.presenceTimer);
    this.presenceTimer = this.clock.setInterval(() => this.beat(), this.presenceMs);
    this.beat();
    if (this.firstPending || this.timer !== null) return;
    const line = this.line();
    if (!this.sent || this.sent.line !== line) this.changed();
    // The same line, but one that expires and whose refresh is no longer
    // armed (it fell due while the connection was down, and a flush with no
    // connection sends nothing): send it again now, which re-arms the refresh,
    // so a line that still holds never expires.
    else if (!line.startsWith("idle") && this.refreshTimer === null) this.flush(true);
  }

  /** Presence online; and the first line, when it is still to go (the session was not yet known as the instance's own). */
  beat() {
    if (!this.live || this.stopped || !this.isOwn()) return;
    Promise.resolve()
      .then(() => this.sendPresence("online"))
      .catch(() => {});
    if (this.firstPending) {
      this.firstPending = false;
      this.flush(true);
    }
  }

  /** The connection is gone: nothing goes out until the next login. */
  disconnected() {
    this.live = false;
    this.clock.clearInterval(this.presenceTimer);
    this.presenceTimer = null;
  }

  /** A clean stop: presence offline (the line stays as it is). */
  stop() {
    const wasLive = this.live && !this.stopped && this.own();
    this.stopped = true;
    this.clock.clearTimeout(this.timer);
    this.clock.clearTimeout(this.refreshTimer);
    this.clock.clearInterval(this.presenceTimer);
    if (wasLive) {
      try {
        this.sendPresence("offline");
      } catch {
        // going anyway
      }
    }
  }
}

// --- whose claude ---------------------------------------------------------------

const procReader = {
  ppid(pid) {
    try {
      const m = /^PPid:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8"));
      return m ? m[1] : "";
    } catch {
      const r = spawnSync("ps", ["-o", "ppid=", "-p", pid], { encoding: "utf8" });
      return r.status === 0 ? r.stdout.replace(/\s/g, "") : "";
    }
  },
  name(pid) {
    try {
      return readFileSync(`/proc/${pid}/comm`, "utf8").split("\n")[0];
    } catch {
      const r = spawnSync("ps", ["-o", "comm=", "-p", pid], { encoding: "utf8" });
      return r.status === 0 ? r.stdout.trim().split("/").pop() : "";
    }
  },
};

/**
 * True when, walking up from `start` (this process's parent), the first claude
 * met is the pid in <stateDir>/pane-pid: the claude start runs in the
 * instance's pane. A process named claude, or named as the pane's process is,
 * met first is another claude (say, a `claude -p` the agent ran). Fails closed.
 */
export function ownClaude(stateDir, { start = process.ppid, proc = procReader } = {}) {
  let pane;
  try {
    const file = join(stateDir, "pane-pid");
    if (!lstatSync(file).isFile()) return false;
    pane = readFileSync(file, "utf8").split("\n")[0].trim();
  } catch {
    return false;
  }
  const isPid = (p) => /^[0-9]+$/.test(p) && p !== "0" && p !== "1";
  if (!isPid(pane)) return false;
  const paneName = proc.name(pane);
  let p = String(start);
  for (let i = 0; i < 64; i += 1) {
    if (!isPid(p)) return false;
    if (p === pane) return true;
    const name = proc.name(p);
    if (name === "claude" || (paneName && name === paneName)) return false;
    p = proc.ppid(p);
  }
  return false;
}

/** The instance's state folder, from GP_INSTANCE_NAME, or null when this is no instance's session. */
export function instanceStateDir(env) {
  const name = env.GP_INSTANCE_NAME ?? "";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;
  const xdg = env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(xdg, "ghost-protocol", name);
}

/**
 * Reads the instance's local inputs every `everyMs`: the turn marker
 * (<state>/turn, "busy <id>" or "idle <id>": only the word is passed on) and
 * the wait file the unattended-deny hook writes (<state>/status-wait,
 * "deny <seconds>": a change is passed on as denied()). A wait file that was
 * there before the start counts for nothing. Returns a stop function.
 */
export function watchInstance({ stateDir, onTurn, onDenied, everyMs = 1000, clock = realClock }) {
  const read = (name) => {
    try {
      return readFileSync(join(stateDir, name), "utf8").split("\n")[0].slice(0, 100);
    } catch {
      return null;
    }
  };
  let turn = null;
  let wait = read("status-wait");
  const tick = () => {
    const t = read("turn");
    if (t !== turn) {
      turn = t;
      const m = /^(busy|idle)(?: |$)/.exec(t ?? "");
      if (m) onTurn(m[1]);
    }
    const w = read("status-wait");
    if (w !== wait) {
      wait = w;
      if (w !== null && /^deny [0-9]+$/.test(w)) onDenied();
    }
  };
  tick();
  const timer = clock.setInterval(tick, everyMs);
  timer?.unref?.();
  return () => clock.clearInterval(timer);
}

// --- settings -------------------------------------------------------------------

const TIMINGS = [
  ["settleMs", "BUZZ_STATUS_SETTLE_MS", SETTLE_MS],
  ["gapMs", "BUZZ_STATUS_GAP_MS", GAP_MS],
  ["presenceMs", "BUZZ_STATUS_PRESENCE_MS", PRESENCE_MS],
  ["pollMs", "BUZZ_STATUS_POLL_MS", 1000],
];

/**
 * BUZZ_STATUS (on or off, the default) and BUZZ_STATUS_AGENTS (the keys
 * agent_status reads by default). A bad value is off, with the problem said.
 * The timings are for tests (README.md, "Status line"); a bad one is its default.
 */
export function statusSettings(env, parseKey) {
  const raw = (env.BUZZ_STATUS ?? "").trim().toLowerCase();
  const problems = [];
  let on = false;
  if (raw === "on") on = true;
  else if (raw !== "" && raw !== "off" && !raw.startsWith("${")) problems.push("BUZZ_STATUS must be on or off; the status line is off");
  const agents = [];
  for (const entry of (env.BUZZ_STATUS_AGENTS ?? "").split(/[\s,]+/).filter((e) => e && !e.startsWith("${"))) {
    try {
      const key = parseKey(entry, "BUZZ_STATUS_AGENTS");
      if (!agents.includes(key)) agents.push(key);
    } catch {
      problems.push("BUZZ_STATUS_AGENTS: an entry is not a public key; it is skipped");
    }
  }
  const timings = {};
  for (const [field, name, fallback] of TIMINGS) {
    const value = (env[name] ?? "").trim();
    const n = Number(value);
    if (value === "" || value.startsWith("${")) timings[field] = fallback;
    else if (Number.isSafeInteger(n) && n >= 10 && n <= 3_600_000) timings[field] = n;
    else {
      timings[field] = fallback;
      problems.push(`${name} must be a whole number of milliseconds from 10 to 3600000; using ${fallback}`);
    }
  }
  return { on, agents, problems, timings };
}

// --- the read -------------------------------------------------------------------

const oneLine = (text, max) => String(text ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").slice(0, max);
const newer = (a, b) => !b || a.created_at > b.created_at || (a.created_at === b.created_at && a.id < b.id);

function checked(event) {
  try {
    return event && typeof event === "object" && typeof event.content === "string" && Array.isArray(event.tags) && verifyEvent(event);
  } catch {
    return false;
  }
}

/** A status event as Buzz's app takes one: one d tag, general, and no channel. */
const statusShape = (e) =>
  e.kind === KIND_STATUS && e.tags.filter((t) => t[0] === "d").length === 1 && e.tags.some((t) => t[0] === "d" && t[1] === "general") && !e.tags.some((t) => t[0] === "h");

function profileName(event) {
  if (!event) return null;
  try {
    const p = JSON.parse(event.content);
    const name = typeof p?.display_name === "string" && p.display_name.trim() ? p.display_name : p?.name;
    return typeof name === "string" && name.trim() ? oneLine(name, 64).trim() : null;
  } catch {
    return null;
  }
}

/**
 * One row per agent (README.md, "Status line"): pubkey, name, line, state,
 * task, waits_on, set_at, expires_at, expired, presence. `query(filters)`
 * returns events as the relay sent them; each is checked here (signature,
 * author, kind, shape). `presence(agents)` resolves to a Map of pubkey to
 * status, or rejects; then presence is unknown. `now` is in seconds.
 */
export async function readStatuses({ query, presence, agents, now }) {
  const want = new Set(agents);
  const [events, seen] = await Promise.all([
    query([
      { kinds: [KIND_STATUS], authors: agents, "#d": ["general"], limit: agents.length * 4 },
      { kinds: [KIND_PROFILE], authors: agents, limit: agents.length * 4 },
    ]),
    presence(agents).catch(() => null),
  ]);
  const lines = new Map();
  const profiles = new Map();
  for (const e of events ?? []) {
    if (!checked(e) || !want.has(e.pubkey)) continue;
    if (statusShape(e)) {
      if (newer(e, lines.get(e.pubkey))) lines.set(e.pubkey, e);
    } else if (e.kind === KIND_PROFILE && newer(e, profiles.get(e.pubkey))) profiles.set(e.pubkey, e);
  }
  return agents.map((pubkey) => {
    const e = lines.get(pubkey);
    const raw = e ? oneLine(e.content, 200) : null;
    const parsed = raw ? parseLine(raw) : null;
    const exp = e?.tags.find((t) => t[0] === "expiration")?.[1];
    const expiresAt = exp !== undefined && /^[0-9]{1,15}$/.test(exp) ? Number(exp) : null;
    return {
      pubkey,
      name: profileName(profiles.get(pubkey)),
      line: raw,
      state: !raw ? "none" : parsed ? parsed.state : "unknown",
      task: parsed?.task ?? null,
      waits_on: parsed?.waits_on ?? null,
      set_at: e ? e.created_at : null,
      expires_at: expiresAt,
      expired: expiresAt !== null && expiresAt <= now,
      presence: seen ? (seen.get(pubkey) ?? "offline") : "unknown",
    };
  });
}

/**
 * The relay's presence snapshot over HTTP: POST <relay>/query with
 * {kinds:[20001], authors}, signed with NIP-98 (and the owner's NIP-OA tag in
 * x-auth-tag, when there is one). Buzz answers with events it signs itself,
 * one per present author: content the status, one `p` tag the author. Only
 * such events count (signed by `relayKey`, one `p` tag for an asked author);
 * an author with none is offline. Rejects on any failure, or an untrusted
 * answer.
 */
export async function presenceSnapshot({ httpUrl, secret, authTag, relayKey, agents, sign, fetchImpl = globalThis.fetch, timeoutMs = 10_000 }) {
  if (!relayKey) throw new Error("the relay does not publish its key (NIP-11 self)");
  const url = `${httpUrl.replace(/\/+$/, "")}/query`;
  const body = JSON.stringify([{ kinds: [KIND_PRESENCE], authors: agents, limit: agents.length }]);
  const proof = sign(
    {
      kind: KIND_HTTP_AUTH,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["u", url],
        ["method", "POST"],
        ["nonce", randomBytes(16).toString("hex")],
        ["payload", createHash("sha256").update(body).digest("hex")],
      ],
    },
    secret,
  );
  const headers = {
    "content-type": "application/json",
    authorization: `Nostr ${Buffer.from(JSON.stringify(proof)).toString("base64")}`,
    ...(authTag ? { "x-auth-tag": JSON.stringify(authTag) } : {}),
  };
  const response = await fetchImpl(url, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`the relay answered ${response.status}`);
  const events = await response.json();
  if (!Array.isArray(events)) throw new Error("not a list of events");
  const seen = new Map();
  for (const e of events) {
    const subjects = Array.isArray(e?.tags) ? e.tags.filter((t) => t[0] === "p") : [];
    const subject = subjects[0]?.[1];
    if (e?.kind !== KIND_PRESENCE || e.pubkey !== relayKey || subjects.length !== 1 || !agents.includes(subject) || seen.has(subject) || !checked(e)) {
      throw new Error("an untrusted presence answer");
    }
    let status = e.content;
    if (status.startsWith("{")) {
      try {
        status = JSON.parse(status).status;
      } catch {
        status = undefined;
      }
    }
    seen.set(subject, status === "online" || status === "away" || status === "offline" ? status : "unknown");
  }
  return seen;
}
