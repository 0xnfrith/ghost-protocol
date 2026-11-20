// One relay subscription that survives drops.
//
// On every connection it answers the relay's NIP-42 challenge, works out the
// rooms to listen in, subscribes from the saved cursor (minus some slack),
// holds the stored events until EOSE, sorts them oldest first and delivers
// them as catch-up. After EOSE, live events are delivered as they arrive.
// Every event is checked again here, whatever the relay's filter did, and
// delivered at most once.
//
// Login: the AUTH event (kind 22242) carries the relay and challenge tags
// and, when the owner's NIP-OA attestation is configured (BUZZ_AUTH_TAG), that
// one `auth` tag too. A relay such as Buzz admits a key that is not a member
// itself through its owner's attestation, and on a WebSocket login it reads
// the attestation from the AUTH event. Without the setting the AUTH event is
// exactly as before.
//
// Reconnect: a connection is replaced, with exponential backoff, when it
// closes, reports an error, does not open in time, has not finished login
// and catch-up in time, stops answering the heartbeat probe, or is left
// closing. Recovery never waits on a `close` event alone: Node's WebSocket
// reports a failed opening handshake (a relay or proxy answering 502 or 503,
// a refused connection, a DNS failure) with an `error` event only, and stays
// in CONNECTING. A watchdog that lives as long as the listener schedules a
// reconnect whenever there is no connection and none pending.
//
// Rooms: with an explicit list, those channels. With `*`, every channel the
// agent's key belongs to, read from relay-signed rosters at start, on every
// reconnect, at once when the relay notifies the agent that it was added to or
// removed from a channel (kinds 44100/44101, which reach a subscription on
// the agent's key), and on a timer for everything else, such as archives.
// (Roster and metadata events themselves are channel-scoped: the relay sends
// them live only to subscriptions scoped to that channel, so a new room's
// roster never reaches the agent until it reads the list again.)
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { channelInfo, directPartners, KIND_GROUP_MEMBERS, KIND_GROUP_METADATA, memberships, roomsFor } from "./rooms.mjs";

export const KIND_MESSAGE = 9;
const KIND_AUTH = 22242;
export const CATCHUP_LIMIT = 500;
const ROOM_QUERY_LIMIT = 1000;
const KIND_MEMBER_ADDED = 44100;
const KIND_MEMBER_REMOVED = 44101;
const AUTH_WAIT_MS = 2000;
const QUERY_TIMEOUT_MS = 15_000;
const THREAD_QUERY_LIMIT = 200;
const THREAD_QUERY_TIMEOUT_MS = 5000;
const CONTEXT_MAX_ENTRIES = 20;
const CONTEXT_MAX_CHARS = 8000;
const REFRESH_DEBOUNCE_MS = 300;
const PREFIX = "buzz-channel";
const PROBE = `${PREFIX}-probe`;
const NO_SUCH_EVENT = "0".repeat(64);
const CONNECTING = 0;
const OPEN = 1;
// Login (AUTH), the room lists (one NIP-11 fetch and two queries, each up to
// QUERY_TIMEOUT_MS) and the catch-up must finish within this after opening.
const LIVE_TIMEOUT_MS = 4 * QUERY_TIMEOUT_MS + AUTH_WAIT_MS;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_FUTURE_SECONDS = 600;

/** A relay-supplied value as text, or "" when it is not a string. */
const text = (value) => (typeof value === "string" ? value : "");

function tagValues(event, name) {
  if (!Array.isArray(event.tags)) return [];
  return event.tags.filter((t) => Array.isArray(t) && t[0] === name && typeof t[1] === "string").map((t) => t[1]);
}

/**
 * The channel an event belongs to: its one distinct `h` tag, when that is on
 * the allowlist. An event with no `h` tag, or with more than one, has none,
 * so a parser difference with the relay cannot slip a second channel past.
 */
export function channelOf(event, channels) {
  const hs = [...new Set(tagValues(event, "h"))];
  return hs.length === 1 && channels.includes(hs[0]) ? hs[0] : undefined;
}

/**
 * The thread root an event replies to, if it is a reply, read from its NIP-10
 * `e` tags the way Buzz files it:
 * - a `reply` marker makes the event a reply. Its thread root is the `root`
 *   marker when there is one, else the `reply` target itself (a direct reply
 *   to the root carries only `reply`);
 * - without a `reply` marker the event is top-level, even with a `root` one;
 * - a tag counts only with a marker and a well-formed event id, and the last
 *   such tag of each marker wins. Unmarked (positional) `e` tags are ignored.
 * Only a well-formed event id is returned: tag values reach the session as
 * attributes, so anything else is dropped.
 */
export function threadOf(event) {
  if (!Array.isArray(event.tags)) return undefined;
  let root;
  let reply;
  for (const t of event.tags) {
    if (!Array.isArray(t) || t[0] !== "e" || typeof t[1] !== "string" || !HEX64.test(t[1])) continue;
    if (t[3] === "root") root = t[1];
    else if (t[3] === "reply") reply = t[1];
  }
  return reply ? (root ?? reply) : undefined;
}

/** Why an event is not a well-formed channel message, or null when it is one. */
function shapeReason(event, now) {
  if (!event || typeof event !== "object") return "malformed";
  if (typeof event.id !== "string" || !HEX64.test(event.id)) return "malformed id";
  if (typeof event.pubkey !== "string" || !HEX64.test(event.pubkey)) return "malformed author";
  if (typeof event.content !== "string" || !Array.isArray(event.tags)) return "malformed";
  const at = event.created_at;
  if (!Number.isSafeInteger(at) || at <= 0 || at > now + MAX_FUTURE_SECONDS) return "bad timestamp";
  if (event.kind !== KIND_MESSAGE) return "kind";
  return null;
}

function signed(event) {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

const byTime = (x, y) => x.created_at - y.created_at || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);

/**
 * The tags of `event` called `name`, whole, whatever their shape. Unlike
 * tagValues it keeps a tag that is malformed, so a caller can refuse an
 * event for one.
 */
const tagsNamed = (event, name) => event.tags.filter((t) => Array.isArray(t) && t[0] === name);

/**
 * The owner of a workflow whose message wakes this agent, or undefined.
 *
 * A workflow's message is signed by the relay's own key, so its author is the
 * relay and says nothing about who set the workflow up. The relay stamps the
 * owner on it (`buzz:workflow-owner`), and the stamp `buzz:workflow-mention`
 * for each agent the owner's own step text names. Only the owner's own text
 * makes that stamp, never a value the trigger fills in. The owner is returned
 * only when all of this holds, the way Block's buzz-acp reads it:
 * - `relayKey`, the key in the relay's NIP-11 document, is known, and it is
 *   the event's author. Anyone can write these tags, so an event signed by
 *   another key gets no special treatment, whatever it claims;
 * - the event is a correctly signed kind 9, checked here again so that no
 *   caller can forget it;
 * - it has exactly one `buzz:workflow` tag, `["buzz:workflow", "true"]`, and
 *   exactly one `buzz:workflow-owner` tag with one public key;
 * - every `buzz:workflow-mention` tag has one public key, none twice, and one
 *   of them is `watchPubkey`. A plain `p` tag names the owner as well, for
 *   the mentions feed, so it is never taken for this.
 * Keys are 64 lower-case hex characters. A tag that breaks any of this voids
 * the stamps as a whole: the event is then judged by its author, the relay.
 */
export function workflowOwner(event, { relayKey, watchPubkey }) {
  if (!relayKey || !event || event.pubkey !== relayKey || event.kind !== KIND_MESSAGE || !Array.isArray(event.tags)) {
    return undefined;
  }
  const oneKey = (tag) => tag.length === 2 && typeof tag[1] === "string" && HEX64.test(tag[1]);
  const markers = tagsNamed(event, "buzz:workflow");
  if (markers.length !== 1 || markers[0].length !== 2 || markers[0][1] !== "true") return undefined;
  const owners = tagsNamed(event, "buzz:workflow-owner");
  if (owners.length !== 1 || !oneKey(owners[0])) return undefined;
  const mentions = tagsNamed(event, "buzz:workflow-mention");
  if (!mentions.every(oneKey)) return undefined;
  const named = new Set(mentions.map((t) => t[1]));
  if (named.size !== mentions.length || !named.has(watchPubkey)) return undefined;
  return signed(event) ? owners[0][1] : undefined;
}

/**
 * Whose standing the sender allowlist judges `event` by, the one rule for
 * every place that asks it: `key` is the workflow's owner when `event` is a
 * workflow message that names this agent (see workflowOwner; `owner` is then
 * set too), and the author otherwise.
 */
export function senderOf(event, { relayKey, watchPubkey }) {
  const owner = workflowOwner(event, { relayKey, watchPubkey });
  return { key: owner ?? event.pubkey, owner };
}

/**
 * Why an event must not be delivered, or null when it may be.
 * `partners` maps each one-to-one DM with a trusted person to that person:
 * in those, every message from them is delivered, mentioned or not.
 * `allows` is the sender allowlist; it is asked only about a correctly
 * signed event, so the key it is asked about is the real one: the author, or
 * the owner of a workflow message from the relay (`relayKey`; see senderOf),
 * which also counts as naming this agent when its stamp does. A workflow
 * message whose owner is the watched identity or `ownPubkey` is the agent's
 * own message, so an agent cannot wake itself through its own workflow.
 */
export function rejectReason(
  event,
  {
    channels,
    watchPubkey,
    ownPubkey,
    relayKey = null,
    partners = new Map(),
    allows = () => true,
    now = Math.floor(Date.now() / 1000),
  },
) {
  const shape = shapeReason(event, now);
  if (shape) return shape;
  // Never deliver what the agent wrote itself, under its own key or as the
  // watched identity: a reply that names the watched identity is tagged with
  // it, and would otherwise come straight back as a new mention.
  if (event.pubkey === watchPubkey || event.pubkey === ownPubkey) return "own message";
  const hs = new Set(tagValues(event, "h"));
  if (hs.size !== 1) return "not exactly one channel";
  const channel = channelOf(event, channels);
  if (!channel) return "channel not allowlisted";
  const sender = senderOf(event, { relayKey, watchPubkey });
  // A workflow the agent owns is its own message too: it must not wake itself.
  if (sender.owner !== undefined && (sender.owner === watchPubkey || sender.owner === ownPubkey)) return "own message";
  const mentioned = tagValues(event, "p").includes(watchPubkey) || sender.owner !== undefined;
  if (!mentioned && partners.get(channel) !== event.pubkey) return "no mention";
  if (!signed(event)) return "bad signature";
  if (!allows(sender.key)) return notAllowedReason(event, sender);
  return null;
}

/**
 * Why a correctly signed event is not delivered: the sender allowlist. It
 * names the author, and the workflow owner too when the owner is whom the
 * allowlist judged (see senderOf).
 */
const notAllowedReason = (event, { owner }) =>
  `not on the sender allowlist (author ${event.pubkey}${owner === undefined ? "" : `, workflow owner ${owner}`})`;

/**
 * The thread context of `delivered`, a message in `thread` in `channel`:
 * the thread's messages since the agent's own last one there (`agents` are
 * its keys; a workflow message owned by one of them is its own too), or since
 * the thread root when it never posted, oldest first,
 * without `delivered` itself and nothing newer than it. Every event is
 * checked like a delivered one: a well-formed, correctly signed kind 9 in
 * exactly this channel, and the root or a reply in this thread. Only the
 * newest CONTEXT_MAX_ENTRIES entries and CONTEXT_MAX_CHARS characters of
 * text are kept; `omitted` counts the older ones left out. `full` says the
 * relay's page was full, so when neither the agent's message nor the root is
 * in it, older ones may be missing too (`partial`). Senders the sender
 * allowlist rejects are kept, with `allowlisted: false`. The sender of a
 * workflow message from the relay is judged as for a delivered one (see
 * senderOf): by its owner, if it names `watchPubkey`, and `workflowOwner`
 * then says so.
 */
export function threadContext(
  events,
  {
    thread,
    channel,
    delivered,
    agents,
    watchPubkey,
    relayKey = null,
    allows = () => true,
    full = false,
    now = Math.floor(Date.now() / 1000),
  },
) {
  const seen = new Set([delivered.id]);
  const inThread = [];
  for (const event of events) {
    if (shapeReason(event, now) || seen.has(event.id)) continue;
    const hs = new Set(tagValues(event, "h"));
    if (hs.size !== 1 || !hs.has(channel)) continue;
    if (event.id !== thread && threadOf(event) !== thread) continue;
    if (event.created_at > delivered.created_at || !signed(event)) continue;
    seen.add(event.id);
    inThread.push(event);
  }
  inThread.sort(byTime);
  const isOwn = (e) => {
    const { owner } = senderOf(e, { relayKey, watchPubkey });
    return agents.includes(e.pubkey) || (owner !== undefined && agents.includes(owner));
  };
  const lastOwn = inThread.findLastIndex(isOwn);
  const window = inThread.slice(lastOwn + 1);
  const entries = [];
  let chars = 0;
  for (let i = window.length - 1; i >= 0 && entries.length < CONTEXT_MAX_ENTRIES; i--) {
    const e = window[i];
    const sender = senderOf(e, { relayKey, watchPubkey });
    const room = CONTEXT_MAX_CHARS - chars;
    // Only the newest entry is ever cut short; an older one that does not fit ends the list.
    if (room <= 0 || (entries.length > 0 && e.content.length > room)) break;
    const text = e.content.slice(0, room);
    chars += text.length;
    entries.unshift({
      id: e.id,
      author: e.pubkey,
      createdAt: e.created_at,
      text,
      truncated: text.length < e.content.length,
      allowlisted: allows(sender.key) === true,
      ...(sender.owner === undefined ? {} : { workflowOwner: sender.owner }),
    });
  }
  return {
    since: lastOwn >= 0 ? "agent_reply" : "thread_root",
    entries,
    omitted: window.length - entries.length,
    partial: full && lastOwn < 0 && !inThread.some((e) => e.id === thread),
  };
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export class RelayListener {
  /**
   * @param {object} o
   * @param {string} o.relayUrl websocket URL
   * @param {Uint8Array} o.secret key used only to answer the relay's AUTH challenge
   * @param {string[]} [o.authTag] the owner's NIP-OA `auth` tag, added to the AUTH event
   * @param {boolean} o.allRooms listen in every channel the key belongs to (BUZZ_CHANNELS=*)
   * @param {string[]} o.channels the listed channel ids (when not allRooms)
   * @param {boolean} o.dmAll deliver every message from the other person in a one-to-one DM, if trusted
   * @param {string[]} o.trusted the people whose one-to-one DMs deliver every message
   * @param {string} o.watchPubkey the identity whose mentions are delivered
   * @param {string} o.ownPubkey the public key of `secret`; its messages are never delivered
   * @param {(pubkey: string) => boolean} [o.allows] the sender allowlist; everyone when absent
   * @param {() => boolean} [o.allowsSettled] whether the allowlist's last "no" was definite
   *   (its file read cleanly); only a definite refusal is recorded. Always, when absent
   * @param {import('./state.mjs').State} o.state
   * @param {(event: object, info: {catchUp: boolean, channel: string, dm: boolean, context?: object}) => object} o.format builds the notification
   * @param {(notification: object, room: {public: boolean}) => Promise<void>} o.deliver writes it to the session (room.public: a public channel, not a DM)
   * @param {(err: Error) => void} o.onDeliveryError called when the session can no longer be written to
   * @param {(msg: string) => void} o.log
   * @param {number} o.backoffMs first reconnect delay; it doubles on each failed attempt
   * @param {number} o.backoffMaxMs the longest reconnect delay (plus up to 20% jitter)
   * @param {number} o.heartbeatMs how often an open connection is probed, and the watchdog runs
   * @param {number} [o.connectTimeoutMs] how long a connection may take to open
   * @param {number} [o.liveTimeoutMs] how long an open connection may take to log in and catch up
   * @param {() => void} [o.onLive] called when a connection has logged in and subscribed
   * @param {() => void} [o.onLost] called when a connection is given up (lost or stopped)
   */
  constructor(o) {
    this.url = o.relayUrl;
    this.httpUrl = o.relayUrl.replace(/^ws/, "http");
    this.secret = o.secret;
    this.authTag = Array.isArray(o.authTag) ? [...o.authTag] : null;
    this.allRooms = o.allRooms === true;
    this.listed = [...(o.channels ?? [])].sort();
    this.channels = this.allRooms ? [] : this.listed;
    this.trusted = new Set(o.trusted ?? []);
    // Every message in a one-to-one DM needs both: BUZZ_DM_MESSAGES=all and
    // the other person in BUZZ_TRUSTED_PUBKEYS.
    this.dmAll = o.dmAll === true && this.trusted.size > 0;
    if (o.dmAll === true && this.trusted.size === 0) {
      o.log("BUZZ_DM_MESSAGES=all has no effect without BUZZ_TRUSTED_PUBKEYS; DMs deliver mentions only");
    }
    this.watchPubkey = o.watchPubkey;
    this.ownPubkey = o.ownPubkey;
    this.allows = o.allows ?? (() => true);
    this.allowsSettled = o.allowsSettled ?? (() => true);
    this.state = o.state;
    this.format = o.format;
    this.deliver = o.deliver;
    this.onDeliveryError = o.onDeliveryError;
    this.log = o.log;
    this.catchupMaxAge = o.catchupMaxAge;
    this.backoffMs = o.backoffMs;
    this.backoffMaxMs = o.backoffMaxMs;
    this.heartbeatMs = o.heartbeatMs;
    this.connectTimeoutMs = o.connectTimeoutMs ?? 15_000;
    this.liveTimeoutMs = o.liveTimeoutMs ?? LIVE_TIMEOUT_MS;
    this.roomsRefreshMs = o.roomsRefreshMs ?? 60_000;
    this.WebSocket = o.WebSocketImpl ?? globalThis.WebSocket;
    this.fetch = o.fetchImpl ?? globalThis.fetch;
    this.random = o.random ?? Math.random;
    this.attempt = 0;
    this.seq = 0;
    this.ws = null;
    this.reconnectTimer = null;
    this.stopped = true;
    this.queue = Promise.resolve();
    this.relayKey = null;
    this.learning = null; // a background read of the relay's key, in progress
    this.heldBack = false; // a workflow's message was judged without the relay's key, and not kept as refused
    this.info = new Map();
    this.partners = new Map();
    this.queries = new Map();
    this.published = new Map(); // event id -> { resolve, timer }, for publishEvent
    this.onLive = o.onLive ?? (() => {});
    this.onLost = o.onLost ?? (() => {});
  }

  start() {
    this.stopped = false;
    clearInterval(this.watchdog);
    this.watchdog = setInterval(() => this.watch(), this.heartbeatMs);
    this.connect();
  }

  stop() {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.abandonSocket();
  }

  connect() {
    if (this.stopped) return;
    let ws;
    try {
      ws = new this.WebSocket(this.url);
    } catch {
      this.log("could not open a connection to the relay");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.authEventId = null;
    this.authed = false;
    this.started = false;
    this.live = false; // set once this connection has subscribed
    this.synced = false; // set once its first catch-up is done (or there is nothing to catch up on)
    this.subId = null;
    this.roomsSubId = null;
    this.inCatchup = false;
    this.buffer = [];
    this.awaitingProbe = false;
    this.connectTimer = setTimeout(() => {
      if (ws === this.ws && ws.readyState === CONNECTING) {
        this.lost(`the connection did not open within ${this.connectTimeoutMs} ms`);
      }
    }, this.connectTimeoutMs);
    ws.onopen = () => {
      if (ws !== this.ws) return;
      clearTimeout(this.connectTimer);
      this.log(`connected to ${this.url}`);
      // A relay that wants AUTH sends its challenge at once. If none comes,
      // carry on without it.
      this.authTimer = setTimeout(() => {
        if (ws === this.ws && !this.started) this.begin(ws);
      }, AUTH_WAIT_MS);
      this.heartbeat = setInterval(() => this.beat(ws), this.heartbeatMs);
      // An open connection that never finishes login and catch-up (say, the
      // relay never answers AUTH but does answer the probe) is no use.
      this.liveTimer = setTimeout(() => {
        if (ws === this.ws && !this.synced) {
          this.lost(`login and catch-up did not finish within ${this.liveTimeoutMs} ms`);
        }
      }, this.liveTimeoutMs);
    };
    ws.onmessage = (msg) => {
      if (ws === this.ws) this.onMessage(msg.data);
    };
    // An error always ends the connection. Before it opened, it is the only
    // event there will be: no `close` follows a failed handshake.
    ws.onerror = () => {
      if (ws !== this.ws) return;
      this.lost(ws.readyState === CONNECTING ? "could not connect to the relay" : "connection error");
    };
    ws.onclose = (event) => {
      if (ws !== this.ws) return;
      this.lost(`connection closed (code ${event?.code ?? "unknown"})`);
    };
  }

  /** Gives up on the current connection, says why, and schedules the next one. */
  lost(reason) {
    this.log(reason);
    this.abandonSocket();
    this.scheduleReconnect();
  }

  /**
   * Runs every heartbeat for as long as the listener does, whatever happens to
   * the connections: with no connection and no reconnect pending, nothing else
   * would ever connect again.
   */
  watch() {
    if (this.stopped || this.ws || this.reconnectTimer) return;
    this.log("no connection and no reconnect pending");
    this.scheduleReconnect();
  }

  send(message) {
    if (this.ws && this.ws.readyState === OPEN) this.ws.send(JSON.stringify(message));
  }

  /** A frame the relay sends. A malformed one is logged and dropped; the connection stays. */
  onMessage(raw) {
    try {
      this.handleFrame(raw);
    } catch {
      this.log("skipped a malformed frame from the relay");
    }
  }

  handleFrame(raw) {
    let data;
    try {
      data = JSON.parse(typeof raw === "string" ? raw : String(raw));
    } catch {
      return;
    }
    if (!Array.isArray(data)) return;
    this.awaitingProbe = false; // any frame proves the relay is still there
    const [type, a, b, c] = data;
    if (type === "AUTH" && typeof a === "string") {
      this.authenticate(a);
    } else if (type === "OK" && a === this.authEventId) {
      if (b === true) {
        this.log("relay accepted AUTH");
        this.authed = true;
        this.begin(this.ws);
      } else {
        this.lost(`relay refused AUTH: ${text(c).slice(0, 200)}`);
      }
    } else if (type === "OK" && typeof a === "string" && this.published.has(a)) {
      this.finishPublish(a, b === true, text(c));
    } else if (typeof a === "string" && this.queries.has(a)) {
      this.onQueryFrame(type, a, b);
    } else if (a === this.subId && a !== null) {
      if (type === "EVENT") this.onEvent(b);
      else if (type === "EOSE") this.onEose();
      else if (type === "CLOSED") this.onSubscriptionClosed(text(b));
    } else if (a === this.roomsSubId && a !== null) {
      // The relay says the agent was added or removed: re-read the rooms.
      if (type === "EVENT" && b?.pubkey === this.relayKey) this.requestRefresh();
    } else if ((type === "EOSE" || type === "CLOSED") && a === PROBE) {
      if (type === "EOSE") this.send(["CLOSE", PROBE]);
    } else if (type === "NOTICE") {
      this.log(`relay notice: ${text(a).slice(0, 200)}`);
    }
    // Frames for an older subscription id are ignored.
  }

  onSubscriptionClosed(reason) {
    this.log(`relay closed the subscription: ${reason.slice(0, 200)}`);
    this.subId = null;
    // Before AUTH, auth-required means: answer the challenge first; the
    // subscription is renewed once AUTH is accepted. After AUTH, or for any
    // other reason, the subscription is dead on a live socket: start over.
    if (reason.startsWith("auth-required") && !this.authed) return;
    this.lost("the subscription is gone");
  }

  authenticate(challenge) {
    const event = finalizeEvent(
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
    this.authEventId = event.id;
    this.send(["AUTH", event]);
  }

  /** After login (or when the relay asks for none): read the rooms, then subscribe. */
  async begin(ws) {
    clearTimeout(this.authTimer);
    this.started = true;
    // The relay's key also tells a workflow's message from a forged one
    // (workflowOwner). readRooms reads it, and waits for it, when there are
    // rooms to list; with a list of channels nobody waits: the login goes on,
    // and learnRelayKey reads it meanwhile and again at each heartbeat.
    if (!this.allRooms && !this.dmAll) this.learnRelayKey();
    await this.refreshRooms(ws);
    if (ws !== this.ws) return;
    this.subscribe();
    if (this.allRooms || this.dmAll) this.subscribeRooms();
    this.live = true;
    this.onLive();
    clearInterval(this.roomsTimer);
    if (this.allRooms || this.dmAll) this.roomsTimer = setInterval(() => this.requestRefresh(), this.roomsRefreshMs);
  }

  /**
   * Reads the relay's signing key in the background, for a listener that
   * subscribes to a list of channels and so has no reason to wait for it. Until
   * it is known a workflow's message is judged by its author, the relay, and
   * that refusal is not kept (see rememberRefused). When the key arrives and
   * such a message was held back, the live connection's subscription starts
   * over from the cursor, so that it is asked for again: whichever connection
   * that is, since a read that was under way when the connection dropped is
   * not started again by the next one. Nothing held back, nothing asked for
   * again; what is older than the cursor less its slack is not asked for. A
   * read that fails is tried again at the next heartbeat (`retry`, which does
   * not log again).
   */
  learnRelayKey(retry = false) {
    if (this.relayKey || this.learning) return;
    this.learning = this.ensureRelayKey(retry)
      .then((key) => {
        if (!key || !this.heldBack || !this.live || this.ws?.readyState !== OPEN) return;
        this.heldBack = false;
        this.log("the relay's key is known now; asking for the messages since the cursor again");
        this.subscribe();
      })
      .catch(() => this.log("could not ask for the messages again after reading the relay's key; continuing"))
      .finally(() => {
        this.learning = null;
      });
  }

  /** Reads the relay's signing key from its NIP-11 document, once. `quiet` logs no failure. */
  async ensureRelayKey(quiet = false) {
    if (this.relayKey) return this.relayKey;
    try {
      const response = await this.fetch(this.httpUrl, {
        headers: { Accept: "application/nostr+json" },
        signal: AbortSignal.timeout(QUERY_TIMEOUT_MS),
      });
      const doc = await response.json();
      if (typeof doc?.self === "string" && HEX64.test(doc.self)) {
        this.relayKey = doc.self;
        this.log("the relay's key is known (NIP-11 self)");
      }
    } catch {
      // handled below
    }
    if (!this.relayKey && !quiet) {
      this.log("the relay does not publish its key (NIP-11 self); room lists, DM detection and workflow owners are off");
    }
    return this.relayKey;
  }

  /**
   * A one-shot REQ: resolves with the events and whether the relay finished
   * (EOSE). Without an open connection it is incomplete at once.
   */
  query(filters, timeoutMs = QUERY_TIMEOUT_MS) {
    if (!this.ws || this.ws.readyState !== OPEN) return Promise.resolve({ events: [], complete: false });
    const id = `${PREFIX}-q-${++this.seq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishQuery(id, false), timeoutMs);
      this.queries.set(id, { events: [], resolve, timer });
      this.send(["REQ", id, ...filters]);
    });
  }

  onQueryFrame(type, id, payload) {
    if (type === "EVENT") this.queries.get(id).events.push(payload);
    else if (type === "EOSE") this.finishQuery(id, true);
    else if (type === "CLOSED") this.finishQuery(id, false);
  }

  finishQuery(id, complete) {
    const q = this.queries.get(id);
    if (!q) return;
    this.queries.delete(id);
    clearTimeout(q.timer);
    this.send(["CLOSE", id]);
    q.resolve({ events: q.events, complete });
  }

  /**
   * Publishes an already signed event on the live connection (the status line
   * and presence, which must ride the connection that keeps the agent
   * online). Resolves true when the relay took it, false when it refused it,
   * did not answer in time, or there is no live connection.
   */
  publishEvent(event, timeoutMs = QUERY_TIMEOUT_MS) {
    if (!this.live || !this.ws || this.ws.readyState !== OPEN) return Promise.resolve(false);
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishPublish(event.id, false, "no answer in time"), timeoutMs);
      this.published.set(event.id, { resolve, timer, kind: event.kind });
      this.send(["EVENT", event]);
    });
  }

  finishPublish(id, ok, reason) {
    const p = this.published.get(id);
    if (!p) return;
    this.published.delete(id);
    clearTimeout(p.timer);
    if (!ok) this.log(`the relay did not take a kind ${p.kind} event: ${reason.slice(0, 200)}`);
    p.resolve(ok);
  }

  requestRefresh() {
    clearTimeout(this.refreshTimer);
    const ws = this.ws;
    this.refreshTimer = setTimeout(() => this.refreshRooms(ws), REFRESH_DEBOUNCE_MS);
  }

  /** Re-reads the rooms; one refresh runs at a time, and a request during one runs after it. */
  refreshRooms(ws) {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = this.readRooms(ws)
      .catch(() => this.log("could not read the rooms; keeping the current ones"))
      .finally(() => {
        this.refreshing = null;
        if (this.refreshAgain && ws === this.ws) {
          this.refreshAgain = false;
          this.refreshRooms(ws);
        }
      });
    return this.refreshing;
  }

  async readRooms(ws) {
    if (!this.allRooms && !this.dmAll) return;
    if (!(await this.ensureRelayKey()) || ws !== this.ws) return;
    // The memberships: every room with *; with a list and trusted DMs, they
    // name the one-to-one DMs with a trusted person, heard beside the list.
    const roster = await this.query([{ kinds: [KIND_GROUP_MEMBERS], "#p": [this.ownPubkey], limit: ROOM_QUERY_LIMIT }]);
    if (ws !== this.ws) return;
    if (!roster.complete) {
      this.log("could not read room memberships; keeping the current rooms");
      return;
    }
    const member = [...memberships(roster.events, this.relayKey, this.ownPubkey)];
    const ids = this.allRooms ? member : [...new Set([...this.listed, ...member])];
    let info = new Map();
    if (ids.length) {
      const meta = await this.query([{ kinds: [KIND_GROUP_METADATA], "#d": ids, limit: ROOM_QUERY_LIMIT }]);
      if (ws !== this.ws) return;
      if (!meta.complete) {
        this.log("could not read channel details; keeping the current rooms");
        return;
      }
      info = channelInfo(meta.events, this.relayKey);
    }
    // With a list: the listed rooms, and the one-to-one DMs with a trusted
    // person (BUZZ_DM_MESSAGES=all), so the operator is heard whatever the list.
    const candidates = this.allRooms ? roomsFor(ids, info) : [...new Set([...this.listed, ...roomsFor(member, info)])];
    const partners = new Map(
      this.dmAll ? [...directPartners(candidates, info, this.ownPubkey)].filter(([, who]) => this.trusted.has(who)) : [],
    );
    const rooms = this.allRooms ? candidates : [...new Set([...this.listed, ...partners.keys()])].sort();
    const before = this.channels;
    const changed = !sameList(rooms, before) || !sameList([...partners.keys()].sort(), [...this.partners.keys()].sort());
    this.info = info;
    this.partners = partners;
    this.channels = rooms;
    if (!changed) return;
    const added = rooms.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !rooms.includes(id));
    this.log(
      `rooms: ${rooms.length}, of which ${partners.size} one-to-one DM(s) with a trusted person` +
        (added.length ? `; joined ${added.join(", ")}` : "") +
        (removed.length ? `; left ${removed.join(", ")}` : ""),
    );
    // During begin() the subscription follows the refresh; after it, a
    // change of rooms renews the subscription under a fresh id.
    if (this.live && ws === this.ws) {
      this.subscribe();
      if (this.allRooms) this.subscribeRooms();
    }
  }

  subscribe() {
    if (this.subId) this.send(["CLOSE", this.subId]);
    this.subId = null;
    this.inCatchup = false;
    this.buffer = [];
    if (this.channels.length === 0) {
      this.log("not in any channel yet; waiting for one");
      this.synced = true; // nothing to catch up on
      return;
    }
    const since = this.state.since(this.catchupMaxAge);
    const base = { kinds: [KIND_MESSAGE], since, limit: CATCHUP_LIMIT };
    const filters = [{ ...base, "#h": this.channels, "#p": [this.watchPubkey] }];
    const dms = [...this.partners.keys()];
    if (dms.length) filters.push({ ...base, "#h": dms });
    this.subId = `${PREFIX}-sub-${++this.seq}`;
    this.inCatchup = true;
    this.send(["REQ", this.subId, ...filters]);
    this.log(
      `subscribed to ${this.channels.length} channel(s)` +
        (dms.length ? ` (all messages in ${dms.length} DM(s) with trusted people)` : "") +
        ` from ${new Date(since * 1000).toISOString()}`,
    );
  }

  /** Live notice from the relay when the agent is added to or removed from a channel. */
  subscribeRooms() {
    if (this.roomsSubId) this.send(["CLOSE", this.roomsSubId]);
    const since = Math.floor(Date.now() / 1000);
    this.roomsSubId = `${PREFIX}-rooms-${++this.seq}`;
    this.send(["REQ", this.roomsSubId, { kinds: [KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED], "#p": [this.ownPubkey], since }]);
  }

  onEvent(event) {
    if (!event || typeof event !== "object" || typeof event.id !== "string" || typeof event.created_at !== "number") {
      this.log("skipped a malformed event from the relay");
      return;
    }
    if (this.inCatchup) this.buffer.push(event);
    else this.enqueue([event], false);
  }

  onEose() {
    if (!this.inCatchup) return;
    this.inCatchup = false;
    const batch = this.buffer;
    this.buffer = [];
    // The limit applies to each filter separately.
    const mentions = batch.filter((e) => tagValues(e, "p").includes(this.watchPubkey)).length;
    const direct = batch.filter((e) => tagValues(e, "h").some((h) => this.partners.has(h))).length;
    if (mentions >= CATCHUP_LIMIT || direct >= CATCHUP_LIMIT) {
      this.log(`catch-up returned the maximum of ${CATCHUP_LIMIT} messages; older missed messages are skipped`);
    }
    batch.sort(byTime);
    this.log(`caught up: ${batch.length} stored message(s) in the window`);
    this.synced = true;
    this.attempt = 0; // a full sync means the connection is healthy
    this.enqueue(batch, true);
  }

  /**
   * The thread context of a message about to be delivered (see threadContext),
   * read from the relay; undefined when the message is not in a thread. Never
   * throws: when the relay cannot be read, it is `{ thread, unavailable: true }`
   * and the message is delivered all the same.
   */
  async readThreadContext(event, channel) {
    const thread = threadOf(event);
    if (!thread) return undefined;
    try {
      const base = { kinds: [KIND_MESSAGE], "#h": [channel] };
      const result = await this.query(
        [
          { ...base, "#e": [thread], limit: THREAD_QUERY_LIMIT },
          { ...base, ids: [thread] },
        ],
        THREAD_QUERY_TIMEOUT_MS,
      );
      if (!result.complete) throw new Error("incomplete");
      const replies = result.events.filter((e) => e?.id !== thread).length;
      return {
        thread,
        ...threadContext(result.events, {
          thread,
          channel,
          delivered: event,
          agents: [this.watchPubkey, this.ownPubkey],
          watchPubkey: this.watchPubkey,
          relayKey: this.relayKey,
          allows: this.allows,
          full: replies >= THREAD_QUERY_LIMIT,
        }),
      };
    } catch {
      this.log(`thread context for ${event.id} unavailable; delivering without it`);
      return { thread, unavailable: true };
    }
  }

  /**
   * Delivers events one at a time, in order. The cursor moves only after a
   * delivery, or past an event that cannot be formatted, so one bad event can
   * never stop the channel or come back on every restart. Only a failure to
   * write to the session stops it.
   *
   * A mention the sender allowlist refuses is recorded apart (State.refuse:
   * bounded, per author too, and never moving the cursor), and never
   * delivered later: when the allowlist changes (a key service restarts its
   * channel for each change), the next catch-up would otherwise deliver every
   * mention it refused before, from whoever is allowed now. The allowlist is
   * asked last, after the signature, so the id recorded is the real event's:
   * a copy with a bad signature is refused before that and never recorded,
   * and so can never keep the real one out.
   */
  enqueue(events, catchUp) {
    this.queue = this.queue
      .then(async () => {
        for (const event of events) {
          const id = typeof event?.id === "string" && HEX64.test(event.id) ? event.id : "(malformed id)";
          if (this.state.has(id)) {
            this.log(`skipped ${id}: already delivered`);
            continue;
          }
          if (this.state.hasRefused(id)) {
            this.log(`skipped ${id}: refused before by the sender allowlist`);
            continue;
          }
          const reason = rejectReason(event, {
            channels: this.channels,
            watchPubkey: this.watchPubkey,
            ownPubkey: this.ownPubkey,
            relayKey: this.relayKey,
            partners: this.partners,
            allows: () => true, // asked below, so that a refusal is recorded
          });
          if (reason) {
            this.log(`skipped ${id}: ${reason}`);
            continue;
          }
          const sender = this.senderOf(event);
          if (!this.allows(sender.key)) {
            this.log(`skipped ${id}: ${notAllowedReason(event, sender)}`);
            // Kept only when definite: a "no" while the allowlist file cannot
            // be read is asked again by the next catch-up.
            if (this.allowsSettled()) this.rememberRefused(event);
            else this.log(`not keeping ${id} as refused: the allowlist file was not read cleanly, so a catch-up asks again`);
            continue;
          }
          const channel = channelOf(event, this.channels);
          const context = await this.readThreadContext(event, channel);
          let notification;
          try {
            notification = this.format(event, {
              catchUp,
              channel,
              dm: this.info.get(channel)?.type === "dm",
              context,
              workflowOwner: sender.owner,
            });
          } catch {
            this.log(`skipped ${id}: could not be formatted`);
            this.remember(event);
            continue;
          }
          try {
            // Beside the notification (never in it): whether the room is a
            // public channel, for the status line's root-id fallback.
            const room = this.info.get(channel);
            await this.deliver(notification, { public: room?.public === true && room.type !== "dm" });
          } catch (err) {
            this.onDeliveryError(err);
            return;
          }
          this.remember(event);
          this.log(`delivered ${id}${catchUp ? " (catch-up)" : ""}`);
        }
      })
      .catch(() => this.log("unexpected error while delivering; continuing"));
  }

  remember(event) {
    try {
      this.state.record(event);
    } catch {
      this.log("could not save the cursor (BUZZ_STATE_DIR); continuing");
    }
  }

  /** Whose standing the allowlist judges `event` by (see senderOf), as this listener knows the relay's key. */
  senderOf(event) {
    return senderOf(event, { relayKey: this.relayKey, watchPubkey: this.watchPubkey });
  }

  rememberRefused(event) {
    // Without the relay's key, a workflow's message was judged by its author,
    // the relay, which says nothing about its owner: that "no" is not definite.
    if (!this.relayKey && tagsNamed(event, "buzz:workflow-owner").length > 0) {
      this.log(`not keeping ${event.id} as refused: the relay's key is not known yet, so a catch-up asks again`);
      this.heldBack = true;
      return;
    }
    try {
      this.state.refuse(event, this.senderOf(event).key);
    } catch {
      this.log("could not save the refused ids (BUZZ_STATE_DIR); continuing");
    }
  }

  beat(ws) {
    if (ws !== this.ws) return;
    // Once open, a connection that is no longer open is on its way out; Node's
    // WebSocket can stay CLOSING with no `close` event when the peer never
    // closes the TCP connection after a close frame.
    if (ws.readyState !== OPEN) {
      this.lost("the connection is no longer open");
      return;
    }
    if (this.awaitingProbe) {
      this.lost("relay stopped answering");
      return;
    }
    if (this.live && !this.allRooms && !this.dmAll) this.learnRelayKey(true);
    this.awaitingProbe = true;
    this.send(["REQ", PROBE, { ids: [NO_SUCH_EVENT], kinds: [KIND_MESSAGE], limit: 1 }]);
  }

  clearConnectionTimers() {
    clearTimeout(this.connectTimer);
    clearTimeout(this.liveTimer);
    clearTimeout(this.authTimer);
    clearInterval(this.heartbeat);
    clearInterval(this.roomsTimer);
    clearTimeout(this.refreshTimer);
    for (const id of [...this.queries.keys()]) this.finishQuery(id, false);
    for (const [id, p] of [...this.published]) {
      this.published.delete(id);
      clearTimeout(p.timer);
      p.resolve(false);
    }
  }

  /** Stops listening to the current socket, without waiting for a close handshake. */
  abandonSocket() {
    const ws = this.ws;
    this.clearConnectionTimers();
    this.ws = null;
    if (!ws) return;
    this.onLost();
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close();
    } catch {
      // already gone
    }
  }

  /**
   * One pending reconnect at most: a later call replaces an earlier one. The
   * delay doubles from backoffMs up to backoffMaxMs, with ±20% jitter, and
   * starts over after a connection completes its catch-up.
   */
  scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const base = Math.min(this.backoffMaxMs, this.backoffMs * 2 ** this.attempt);
    const delay = Math.round(base * (0.8 + 0.4 * this.random()));
    this.attempt = Math.min(this.attempt + 1, 30);
    this.log(`reconnecting in ${delay} ms (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
