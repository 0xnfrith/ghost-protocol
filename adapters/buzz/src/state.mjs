// The channel's durable state: a cursor, the ids it has already delivered,
// and apart from them, the ids the sender allowlist refused.
//
// The file holds event ids, timestamps and, for a refused event, the public
// key the allowlist refused (its author's, or its workflow's owner's): never
// message content and never key material. It is
// written atomically (temp file, then rename) with owner-only permissions.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MAX_SEEN = 5000;
/** The most refused ids kept in all, and for any one author. */
export const MAX_REFUSED = 1000;
export const MAX_REFUSED_PER_AUTHOR = 20;
/**
 * How long a new refused id may wait before the file is written: refusals in
 * that time go in one write (a delivery or a stop writes them at once).
 */
export const REFUSED_SAVE_MS = 1000;
const HEX64 = /^[0-9a-f]{64}$/;

/** One state file per relay and watched identity, so two setups never share a cursor. */
export function stateFileFor(dir, relayUrl, watchPubkey) {
  const tag = createHash("sha256").update(`${relayUrl}|${watchPubkey}`).digest("hex").slice(0, 16);
  return join(dir, `cursor-${tag}.json`);
}

export class State {
  /**
   * @param {string} file where the state lives
   * @param {object} opts
   * @param {number} opts.slack seconds of overlap kept for late or same-second events
   * @param {() => number} opts.now current unix time in seconds
   * @param {number} [opts.refusedSaveMs] REFUSED_SAVE_MS, for tests
   */
  constructor(file, { slack, now, refusedSaveMs = REFUSED_SAVE_MS }) {
    this.file = file;
    this.slack = slack;
    this.now = now;
    this.refusedSaveMs = refusedSaveMs;
    this.saveTimer = null; // a write of new refused ids, waiting
    this.unsaved = false; // refused ids not in the file yet
    this.cursor = null; // { id: string|null, created_at: number }
    this.seen = new Map(); // id -> created_at
    this.refused = new Map(); // id -> [created_at, refused key], never a delivered id
  }

  load() {
    let data;
    try {
      data = JSON.parse(readFileSync(this.file, "utf8"));
    } catch {
      data = null;
    }
    if (data && data.version === 1) {
      const c = data.cursor;
      if (c && Number.isInteger(c.created_at)) {
        this.cursor = { id: typeof c.id === "string" ? c.id : null, created_at: c.created_at };
      }
      if (Array.isArray(data.seen)) {
        for (const entry of data.seen) {
          if (Array.isArray(entry) && typeof entry[0] === "string" && Number.isInteger(entry[1])) {
            this.seen.set(entry[0], entry[1]);
          }
        }
      }
      if (Array.isArray(data.refused)) {
        for (const e of data.refused) {
          if (Array.isArray(e) && HEX64.test(e[0]) && Number.isInteger(e[1]) && HEX64.test(e[2])) this.refused.set(e[0], [e[1], e[2]]);
        }
        this.pruneRefused();
      }
    }
    if (!this.cursor) {
      // First start: begin at now and replay nothing older. Persist the
      // starting point at once, so a reconnect before the first event
      // still catches up from here.
      this.cursor = { id: null, created_at: this.now() };
      this.save();
    }
    return this;
  }

  has(id) {
    return this.seen.has(id);
  }

  /** Whether the sender allowlist refused this event before. */
  hasRefused(id) {
    return this.refused.has(id);
  }

  /**
   * Records an event the sender allowlist refused, so that a later catch-up
   * (after the allowlist changed, say) never delivers it. `sender` is the key
   * the allowlist refused: the event's author, or the owner of a workflow
   * whose message the relay signed (the caller says so). The caller has
   * checked the event's signature, so its id and that key are real: a sender
   * can put only its own events here, and the relay's key never carries
   * another owner's. Kept apart from the delivered ids: it never
   * moves the cursor (an author outside the allowlist must not move the
   * catch-up past messages nobody has read yet) and never pushes a delivered
   * id out (which would deliver that one twice). And bounded: a sender keeps
   * at most MAX_REFUSED_PER_AUTHOR (its oldest go first), and all together at
   * most MAX_REFUSED (the oldest go first). So a flood pushes out at most
   * other refused ids, which then, once their sender is allowed, may come
   * back on a catch-up within its window.
   *
   * The file is not written for each one: a flood of refused mentions would
   * be a write of the whole file per message. A new refused id is written
   * within REFUSED_SAVE_MS, with any others that came meanwhile, or at once by
   * the next delivery or by flush() (on stop). An id already known writes
   * nothing. So only a crash in that time loses one, which a catch-up then
   * asks the allowlist about again.
   */
  refuse(event, sender = event.pubkey) {
    if (this.refused.has(event.id) || this.seen.has(event.id)) return;
    this.refused.set(event.id, [event.created_at, sender]);
    this.pruneRefused(sender);
    this.unsaved = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        this.save();
      } catch {
        // the next delivery, flush() or refusal writes them
      }
    }, this.refusedSaveMs);
    this.saveTimer.unref?.();
  }

  /** Writes refused ids still waiting for their write, if any. */
  flush() {
    if (this.unsaved) this.save();
  }

  /** Records a delivered event and moves the cursor forward, never past now. */
  record(event) {
    this.seen.set(event.id, event.created_at);
    const at = Math.min(event.created_at, this.now());
    if (at >= this.cursor.created_at) this.cursor = { id: event.id, created_at: at };
    this.prune();
    this.save();
  }

  /**
   * The `since` for the next subscription: the cursor minus the slack, but no
   * older than maxAge. Before the first delivery the cursor is the start time,
   * and nothing older than that is replayed.
   */
  since(maxAge) {
    const from = this.cursor.id === null ? this.cursor.created_at : this.cursor.created_at - this.slack;
    return Math.max(from, this.now() - maxAge);
  }

  prune() {
    const floor = this.cursor.created_at - this.slack * 2;
    for (const [id, at] of this.seen) if (at < floor) this.seen.delete(id);
    if (this.seen.size > MAX_SEEN) {
      const sorted = [...this.seen].sort((a, b) => a[1] - b[1]);
      for (const [id] of sorted.slice(0, this.seen.size - MAX_SEEN)) this.seen.delete(id);
    }
    this.pruneRefused();
  }

  /**
   * The refused ids within their bounds: none older than a catch-up could
   * reach (as for the delivered ones), at most MAX_REFUSED_PER_AUTHOR of
   * `author`'s, and at most MAX_REFUSED in all, the oldest going first.
   */
  pruneRefused(author) {
    if (this.cursor) {
      const floor = this.cursor.created_at - this.slack * 2;
      for (const [id, [at]] of this.refused) if (at < floor) this.refused.delete(id);
    }
    const oldestFirst = (entries) => entries.sort((a, b) => a[1][0] - b[1][0]);
    if (author !== undefined) {
      const mine = oldestFirst([...this.refused].filter(([, [, a]]) => a === author));
      for (const [id] of mine.slice(0, Math.max(0, mine.length - MAX_REFUSED_PER_AUTHOR))) this.refused.delete(id);
    }
    if (this.refused.size > MAX_REFUSED) {
      for (const [id] of oldestFirst([...this.refused]).slice(0, this.refused.size - MAX_REFUSED)) this.refused.delete(id);
    }
  }

  save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const dir = join(this.file, "..");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const refused = [...this.refused].map(([id, [at, author]]) => [id, at, author]);
    const body = JSON.stringify({ version: 1, cursor: this.cursor, seen: [...this.seen], refused });
    writeFileSync(tmp, body, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
    this.unsaved = false;
  }
}
