// Task roots: one top-level message stands for one task, and the agent's
// state reaction on it says where the task is. This file is the one
// definition of the states, their reactions and the moves between them. The
// channel's `task` and `task_list` tools (src/channel.mjs) and the one-shot
// `launch.mjs task` (src/task-cli.mjs, which the auto-mode guard and the
// memory backup run for their alerts) all go through it.
//
// THE STATES:
//   open       something is still left in the root's thread, whoever holds it
//   done       nothing is left; the thread's last message says why
//   emergency  an emergency, and still open (🚨, never just a decision)
//   none       no state: the agent tracks nothing on this root
// A root's state is the agent's newest state reaction on it. Only the agent's
// own reactions count, never anyone else's.
//
// THE REACTIONS: open and done come from the settings, a plain emoji or a
// workspace's custom emoji (a name and its image's URL, which a reaction must
// carry, or Buzz shows the name as text):
//   BUZZ_TASK_OPEN_EMOJI, BUZZ_TASK_OPEN_EMOJI_URL   default ⭕, no URL
//   BUZZ_TASK_DONE_EMOJI, BUZZ_TASK_DONE_EMOJI_URL   default ✅, no URL
// A custom emoji is a name of lower-case letters, digits, _ and - (with or
// without colons); its reaction's content is :name:, with an `emoji` tag
// (NIP-30) naming its image. Emergency is always 🚨.
//
// THE MOVES: any state to any other, except out of done: a done root is never
// reopened, and new work in it gets a new root. `reopen` lets a move out of
// done through, only to correct a premature done.
//
// Setting a state REPLACES, never stacks: the new reaction goes on first,
// then every earlier state reaction of the agent's on that message is
// deleted (kind 5). A reaction is written the way Buzz's own app writes one:
// kind 7, content the emoji, tags h (the channel), e (the message) and, for a
// custom emoji, emoji (its name and image URL). A deletion: kind 5, tags h,
// e (each reaction) and k (7).
import { verifyEvent } from "nostr-tools/pure";
import { ConfigError, setting } from "./config.mjs";

export const STATES = ["open", "done", "emergency", "none"];
export const EMERGENCY = "🚨";
export const KIND_REACTION = 7;
export const KIND_DELETION = 5;
const KIND_MESSAGE = 9;
const HEX64 = /^[0-9a-f]{64}$/;
const CHANNEL = /^[A-Za-z0-9-]{1,64}$/;
const SHORTCODE = /^:?([a-z0-9_-]{1,64}):?$/;
// A plain emoji: no ASCII and no space, at most 64 bytes of UTF-8 (the same
// rule as the manifest's and the key service's checks).
const PLAIN = /^[^\s\x00-\x7f]+$/u;
const PLAIN_BYTES = 64;
const REACTION_QUERY_LIMIT = 100;
export const LIST_QUERY_LIMIT = 500;
const LINE_CHARS = 80;

/** A task tool's refusal: fixed words, safe to show the agent. */
export class TaskError extends Error {}

function emojiForm(env, name, fallback) {
  const raw = setting(env, name);
  const url = setting(env, `${name}_URL`);
  const value = raw ?? fallback;
  const custom = SHORTCODE.exec(value.toLowerCase());
  if (custom && /^[A-Za-z0-9_:-]+$/.test(value)) {
    if (!url) throw new ConfigError(`${name} names a custom emoji: set ${name}_URL to its image's https:// address`);
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new ConfigError(`${name}_URL is not a valid URL`);
    }
    if (parsed.protocol !== "https:" || /\s/.test(url) || url.length > 2048) {
      throw new ConfigError(`${name}_URL must be an https:// address of at most 2048 characters`);
    }
    return { content: `:${custom[1]}:`, name: custom[1], url };
  }
  if (!PLAIN.test(value) || Buffer.byteLength(value, "utf8") > PLAIN_BYTES) {
    throw new ConfigError(`${name} must be a plain emoji, or the name of a custom emoji (lower-case letters, digits, _ and -)`);
  }
  if (url) throw new ConfigError(`${name}_URL is only for a custom emoji: ${name} is a plain emoji`);
  return { content: value };
}

/** The reaction of each state but none, from the settings (task.mjs's header). */
export function taskForms(env) {
  const open = emojiForm(env, "BUZZ_TASK_OPEN_EMOJI", "⭕");
  const done = emojiForm(env, "BUZZ_TASK_DONE_EMOJI", "✅");
  if (open.content === done.content) throw new ConfigError("BUZZ_TASK_OPEN_EMOJI and BUZZ_TASK_DONE_EMOJI must differ");
  if (open.content === EMERGENCY || done.content === EMERGENCY) {
    throw new ConfigError(`${EMERGENCY} is the emergency state's reaction; pick another emoji for open and done`);
  }
  return { open, done, emergency: { content: EMERGENCY } };
}

/** taskForms' result, or the error that says why the settings are not usable. */
export function taskFormsOrError(env) {
  try {
    return { forms: taskForms(env) };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { error: err.message };
  }
}

/** The reactions, for a log line: each state's content, and whether it carries an image. */
export const formsLine = (forms) =>
  ["open", "done", "emergency"].map((s) => `${s} ${forms[s].content}${forms[s].url ? " (custom, with its image)" : ""}`).join(", ");

/** Whether task roots are on: BUZZ_TASK_ROOTS, on or off (the default). */
export function taskRootsOn(env) {
  const v = (setting(env, "BUZZ_TASK_ROOTS") ?? "off").toLowerCase();
  if (v !== "on" && v !== "off") throw new ConfigError("BUZZ_TASK_ROOTS must be on or off");
  return v === "on";
}

/** The state a reaction stands for, or undefined when it is none of them. */
export function stateOf(content, forms) {
  if (typeof content !== "string") return undefined;
  for (const s of ["open", "done", "emergency"]) {
    const c = forms[s].content;
    if (content === c || (forms[s].name && content.toLowerCase() === c)) return s;
  }
  return undefined;
}

/**
 * Whether a move is allowed: undefined when it is, else why not. A move out
 * of done is refused unless `reopen`: a done root is never reopened.
 */
export function moveProblem(from, to, reopen = false) {
  if (!STATES.includes(from) || !STATES.includes(to)) return "not a state: use open, done, emergency or none";
  if (from === "done" && (to === "open" || to === "emergency") && !reopen) {
    return "this root is done, and a done root is never reopened: post a new root for the new work (reopen=true only corrects a premature done, said in its thread)";
  }
  return undefined;
}

/** The message a reaction is on: its last well-formed `e` tag (NIP-25). */
function targetOf(event) {
  if (!Array.isArray(event?.tags)) return undefined;
  let target;
  for (const t of event.tags) {
    if (Array.isArray(t) && t[0] === "e" && typeof t[1] === "string" && HEX64.test(t[1].toLowerCase())) target = t[1].toLowerCase();
  }
  return target;
}

function signed(event) {
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

const newestFirst = (x, y) => y.created_at - x.created_at || (x.id < y.id ? 1 : x.id > y.id ? -1 : 0);

/**
 * The agent's state reactions among `events`: kind 7, by `self`, correctly
 * signed, a state's reaction, on a message; newest first, each with its state
 * and target.
 */
export function stateReactions(events, { self, forms }) {
  const out = [];
  const seen = new Set();
  for (const e of events) {
    if (!e || typeof e !== "object" || e.kind !== KIND_REACTION || e.pubkey !== self || seen.has(e.id)) continue;
    if (!Number.isSafeInteger(e.created_at)) continue;
    const state = stateOf(e.content, forms);
    const target = targetOf(e);
    if (!state || !target || !signed(e)) continue;
    seen.add(e.id);
    out.push({ event: e, state, target });
  }
  return out.sort((x, y) => newestFirst(x.event, y.event));
}

function checkTarget(channel, id) {
  if (typeof channel !== "string" || !CHANNEL.test(channel)) throw new TaskError("channel must be a channel id");
  if (typeof id !== "string" || !HEX64.test(id.toLowerCase())) throw new TaskError("id must be a message's event id (64 hex characters)");
  return id.toLowerCase();
}

/**
 * Sets the state of message `id` in `channel` to `state`, replacing the
 * agent's earlier state reaction there. Returns { from, to, swept, line, note },
 * where line is "<first 8 hex of id>: <from> -> <to>", always bare (the
 * success line the reply guard reads), and note, when set, says an earlier
 * reaction could not be removed. Throws a TaskError for a bad request or a
 * refused move, and a RelayError when the relay fails.
 */
export async function setTask(client, { channel, id, state, reopen = false, self, forms, now = () => Math.floor(Date.now() / 1000) }) {
  const target = checkTarget(channel, id);
  if (!STATES.includes(state)) throw new TaskError("state must be open, done, emergency or none");
  // Scoped to the channel, as every read of channel content is.
  const mine = stateReactions(
    await client.query([{ kinds: [KIND_REACTION], authors: [self], "#h": [channel], "#e": [target], limit: REACTION_QUERY_LIMIT }]),
    { self, forms },
  ).filter((r) => r.target === target);
  const from = mine[0]?.state ?? "none";
  const problem = moveProblem(from, state, reopen === true);
  if (problem) throw new TaskError(problem);
  let keep = null;
  if (state !== "none") {
    const form = forms[state];
    if (mine[0] && mine[0].state === state && mine[0].event.content === form.content) {
      keep = mine[0].event; // already this state, in this form
    } else {
      // Newer than every reaction it replaces, so it reads as the state even
      // if a deletion below does not go through.
      const at = Math.max(now(), ...mine.map((r) => r.event.created_at + 1));
      keep = await client.publish({
        kind: KIND_REACTION,
        created_at: at,
        content: form.content,
        tags: [["h", channel], ["e", target], ...(form.name ? [["emoji", form.name, form.url]] : [])],
      });
    }
  }
  const old = mine.filter((r) => r.event.id !== keep?.id).map((r) => r.event.id);
  let swept = true;
  if (old.length) {
    try {
      await client.publish({
        kind: KIND_DELETION,
        created_at: Math.max(now(), ...mine.map((r) => r.event.created_at)),
        content: "",
        tags: [["h", channel], ...old.map((e) => ["e", e]), ["k", String(KIND_REACTION)]],
      });
    } catch (err) {
      if (state === "none") throw err; // nothing else would change the state
      swept = false;
    }
  }
  return {
    from,
    to: state,
    swept,
    line: `${target.slice(0, 8)}: ${from} -> ${state}`,
    note: swept ? undefined : "an earlier state reaction could not be removed; the new one reads as the state",
  };
}

// Control characters and every line or paragraph separator: none may reach a
// list line, so a root's text can never start a line of its own there.
const BREAKS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Text on one line: every control character or line break becomes a space. */
const oneLine = (value) => String(value ?? "").replace(BREAKS, " ");

/** A root's first line of text, plain and short. */
function firstLine(content) {
  const line =
    String(content ?? "")
      .split(/[\n\r\u0085\u2028\u2029]/)
      .map((l) => oneLine(l).replace(/^[\s#>*-]+|\s+$/g, "").replace(/\*\*/g, ""))
      .find((l) => l.length > 0) ?? "";
  // Code points, not UTF-16 units: an emoji is never cut in half.
  const chars = [...line];
  return chars.length > LINE_CHARS ? `${chars.slice(0, LINE_CHARS - 1).join("")}…` : chars.join("");
}

/** An `h` tag's channel, when it is a channel id and one of `rooms`; else undefined. */
function roomOf(event, rooms) {
  const hs = [...new Set((event?.tags ?? []).filter((t) => Array.isArray(t) && t[0] === "h").map((t) => t[1]))];
  return hs.length === 1 && typeof hs[0] === "string" && CHANNEL.test(hs[0]) && rooms.includes(hs[0]) ? hs[0] : undefined;
}

/**
 * The open task roots in `channels`: each message whose newest state
 * reaction from the agent is open or emergency, newest first. Reads the
 * newest LIST_QUERY_LIMIT reactions of the agent's in those channels, of any
 * kind (state reactions among them). A root's
 * first line is shown only when the agent or one of `trusted` wrote it; other
 * roots, and roots older than what the relay returns, are listed by id alone.
 * Returns { roots: [{ state, channel, id, text, author }], complete }.
 */
export async function listTasks(client, { channels, self, forms, trusted = [] }) {
  const rooms = [...new Set(channels)].filter((c) => typeof c === "string" && CHANNEL.test(c));
  if (!rooms.length) throw new TaskError("no channel to read: name one, or listen in at least one");
  const reactions = await client.query([{ kinds: [KIND_REACTION], authors: [self], "#h": rooms, limit: LIST_QUERY_LIMIT }]);
  const newest = new Map();
  for (const r of stateReactions(reactions, { self, forms })) if (!newest.has(r.target)) newest.set(r.target, r);
  const open = [...newest.values()].filter((r) => r.state === "open" || r.state === "emergency");
  const messages = open.length
    ? await client.query([{ kinds: [KIND_MESSAGE], "#h": rooms, ids: open.map((r) => r.target), limit: open.length }])
    : [];
  const byId = new Map();
  for (const m of messages) if (m && typeof m.id === "string" && signed(m)) byId.set(m.id.toLowerCase(), m);
  const readable = new Set([self, ...trusted]);
  const roots = open.map((r) => {
    const msg = byId.get(r.target);
    // The root's own channel only when it is one asked for; else the
    // reaction's, which the agent wrote; else none.
    const channel = (msg && roomOf(msg, rooms)) ?? roomOf(r.event, rooms) ?? "";
    return {
      state: r.state,
      channel,
      id: r.target,
      author: msg?.pubkey,
      text: msg ? (readable.has(msg.pubkey) ? firstLine(msg.content) : null) : undefined,
    };
  });
  return { roots, complete: reactions.length < LIST_QUERY_LIMIT };
}

/** listTasks' roots as text, one line each, at most `max`. */
export function listText({ roots, complete }, { max = 20, forms }) {
  if (!roots.length) return `none open${complete ? "" : ` (in the agent's newest ${LIST_QUERY_LIMIT} reactions)`}`;
  const lines = roots.slice(0, max).map((r) => {
    const what = r.text === undefined ? "(an older root, text not read)" : r.text === null ? "(text not shown: someone else's root)" : r.text || "(no text)";
    // Each value on one line, whatever reached it: a list line never splits.
    const channel = CHANNEL.test(r.channel) ? r.channel : "(unknown)";
    const id = HEX64.test(r.id) ? r.id : "(unknown)";
    return `- ${forms[r.state].content} ${r.state} channel=${channel} id=${id}: ${oneLine(what)}`;
  });
  if (roots.length > max) lines.push(`- and ${roots.length - max} more`);
  if (!complete) lines.push(`(read the agent's newest ${LIST_QUERY_LIMIT} reactions; older roots may be open too)`);
  return lines.join("\n");
}
