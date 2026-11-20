// The sender allowlist: whose messages may reach the session.
//
// It is off unless BUZZ_ALLOWED_PUBKEYS or BUZZ_ALLOWLIST_FILE is set. When
// it is on, a message is delivered only if its author is listed in
// BUZZ_ALLOWED_PUBKEYS, in the file, or among the trusted people
// (BUZZ_TRUSTED_PUBKEYS). The file is checked for a change before each
// decision and read again when it changed.
//
// Everything fails closed and nothing here throws: a missing, unreadable or
// malformed file allows nobody from the file, and an entry that is not a
// public key allows nobody. The log names counts, never keys or paths.
import { readFileSync, statSync } from "node:fs";
import { parsePublicKey } from "./config.mjs";

const MAX_FILE_BYTES = 1024 * 1024;
const FORMAT = '{"entries":[{"pubkey":"<hex or npub1>"}]}';

const entries = (n) => `${n} ${n === 1 ? "entry" : "entries"}`;

/**
 * The public keys in an allowlist file, shaped {"entries":[{"pubkey":…}]},
 * and how many entries were skipped. Only `pubkey` is read. Returns null
 * when the text is not that shape at all.
 */
export function parseAllowlistFile(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc) || !Array.isArray(doc.entries)) return null;
  const keys = new Set();
  let skipped = 0;
  for (const entry of doc.entries) {
    try {
      if (!entry || typeof entry !== "object" || typeof entry.pubkey !== "string") throw new Error("no pubkey");
      keys.add(parsePublicKey(entry.pubkey, "pubkey"));
    } catch {
      skipped++;
    }
  }
  return { keys, skipped };
}

export class SenderAllowlist {
  /**
   * @param {object} o
   * @param {{keys: string[], skipped: number} | undefined} o.listed BUZZ_ALLOWED_PUBKEYS, parsed; undefined when unset
   * @param {string | undefined} o.file BUZZ_ALLOWLIST_FILE; undefined when unset
   * @param {string[]} o.trusted BUZZ_TRUSTED_PUBKEYS, always allowed when the allowlist is on
   * @param {(msg: string) => void} o.log
   */
  constructor({ listed, file, trusted = [], log, fs = { readFileSync, statSync } }) {
    this.enabled = listed !== undefined || file !== undefined;
    this.listed = new Set([...(listed?.keys ?? []), ...trusted]);
    this.file = file;
    this.fromFile = new Set();
    this.readCleanly = file === undefined; // the file's last read gave its keys
    this.seen = undefined;
    this.log = log;
    this.fs = fs;
    if (!this.enabled) {
      log(
        "no sender allowlist: anyone who mentions the agent in its rooms reaches the session " +
          "(set BUZZ_ALLOWED_PUBKEYS or BUZZ_ALLOWLIST_FILE to limit who can)",
      );
      return;
    }
    if (listed?.skipped) {
      log(`BUZZ_ALLOWED_PUBKEYS: skipped ${entries(listed.skipped)} that are not hex or npub1 public keys`);
    }
    log(
      `sender allowlist on: ${listed?.keys.length ?? 0} listed and ${trusted.length} trusted key(s)` +
        (file === undefined ? "" : ", plus BUZZ_ALLOWLIST_FILE"),
    );
    try {
      this.reload();
    } catch {
      // allows() tries again, and fails closed meanwhile
    }
  }

  /** Whether a message by `pubkey` may reach the session. Never throws; on any error, no. */
  allows(pubkey) {
    if (!this.enabled) return true;
    try {
      if (this.listed.has(pubkey)) return true;
      this.reload();
      return this.fromFile.has(pubkey);
    } catch {
      this.readCleanly = false;
      return false;
    }
  }

  /**
   * Whether the last "no" from allows() was a definite one: the file, if
   * there is one, was read and parsed. A "no" while it is missing,
   * unreadable, too large or malformed (mid-rewrite, say) only fails closed
   * for now: the sender may be in the file once it can be read, so that
   * refusal must not be kept.
   */
  settled() {
    return this.readCleanly;
  }

  /** Reads the file again when its identity, size or times changed since the last read. */
  reload() {
    if (this.file === undefined) return;
    let stat;
    let signature;
    try {
      stat = this.fs.statSync(this.file);
      signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    } catch (err) {
      signature = `unreadable:${err?.code ?? ""}`;
    }
    if (signature === this.seen) return;
    this.seen = signature;
    this.fromFile = new Set();
    this.readCleanly = false;
    if (!stat) {
      this.log("BUZZ_ALLOWLIST_FILE cannot be read; nobody is allowed from it until it can be");
      return;
    }
    if (stat.size > MAX_FILE_BYTES) {
      this.log("BUZZ_ALLOWLIST_FILE is larger than 1 MB; nobody is allowed from it until it is smaller");
      return;
    }
    let parsed;
    try {
      parsed = parseAllowlistFile(this.fs.readFileSync(this.file, "utf8"));
    } catch {
      this.log("BUZZ_ALLOWLIST_FILE cannot be read; nobody is allowed from it until it can be");
      return;
    }
    if (!parsed) {
      this.log(`BUZZ_ALLOWLIST_FILE is not shaped ${FORMAT}; nobody is allowed from it until it is fixed`);
      return;
    }
    this.fromFile = parsed.keys;
    this.readCleanly = true;
    this.log(
      `BUZZ_ALLOWLIST_FILE read: ${parsed.keys.size} key(s)` +
        (parsed.skipped ? `; skipped ${entries(parsed.skipped)} without a hex or npub1 pubkey` : ""),
    );
  }
}
