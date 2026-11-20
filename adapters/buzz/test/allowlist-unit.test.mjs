// Unit tests of the sender allowlist: parsing, reloads, failing closed.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAllowlistFile, SenderAllowlist } from "../src/allowlist.mjs";
import { loadConfig } from "../src/config.mjs";
import { rejectReason } from "../src/relay.mjs";
import { message } from "./fake-relay.mjs";
import { identity, tempDir } from "./helpers.mjs";

const listed = identity();
const other = identity();
const trustedPerson = identity();

function logger() {
  const lines = [];
  return { lines, log: (m) => lines.push(m), text: () => lines.join("\n") };
}

function writeAtomically(path, text) {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

test("an allowlist file gives its pubkeys and ignores every other field", () => {
  const parsed = parseAllowlistFile(
    JSON.stringify({
      version: 3,
      description: "who may reach the agent",
      entries: [
        { pubkey: listed.pubkey, label: "a name", owner: "someone", status: "anything" },
        { pubkey: other.npub },
        { pubkey: trustedPerson.pubkey.toUpperCase() },
        { pubkey: listed.pubkey },
      ],
    }),
  );
  assert.deepEqual([...parsed.keys].sort(), [listed.pubkey, other.pubkey, trustedPerson.pubkey].sort());
  assert.equal(parsed.skipped, 0);
});

test("an entry without a hex or npub1 pubkey is skipped and counted", () => {
  const parsed = parseAllowlistFile(
    JSON.stringify({
      entries: [{ pubkey: "nope" }, { pubkey: 7 }, {}, null, "text", [listed.pubkey], { pubkey: listed.pubkey }],
    }),
  );
  assert.deepEqual([...parsed.keys], [listed.pubkey]);
  assert.equal(parsed.skipped, 6);
});

test("text that is not the allowlist shape gives null", () => {
  for (const text of ["", "{", "null", "[]", "42", '"x"', "{}", '{"entries":{}}', '{"entries":"x"}', `[{"pubkey":"${listed.pubkey}"}]`]) {
    assert.equal(parseAllowlistFile(text), null, text);
  }
  assert.deepEqual(parseAllowlistFile('{"entries":[]}'), { keys: new Set(), skipped: 0 });
});

test("off unless a list or a file is set: everyone is allowed, and it says so once", () => {
  const { log, lines } = logger();
  const open = new SenderAllowlist({ listed: undefined, file: undefined, trusted: [trustedPerson.pubkey], log });
  assert.equal(open.enabled, false);
  assert.equal(open.allows(other.pubkey), true);
  assert.equal(lines.filter((l) => l.includes("no sender allowlist")).length, 1);
});

test("on with a list: the listed and the trusted are allowed, nobody else", () => {
  const { log, text } = logger();
  const a = new SenderAllowlist({ listed: { keys: [listed.pubkey], skipped: 2 }, trusted: [trustedPerson.pubkey], log });
  assert.equal(a.allows(listed.pubkey), true);
  assert.equal(a.allows(trustedPerson.pubkey), true);
  assert.equal(a.allows(other.pubkey), false);
  assert.ok(text().includes("skipped 2 entries"));
  // A list that is set but empty allows only the trusted people.
  const empty = new SenderAllowlist({ listed: { keys: [], skipped: 1 }, trusted: [], log });
  assert.equal(empty.enabled, true);
  assert.equal(empty.allows(listed.pubkey), false);
});

test("the file is read again only when it changes", () => {
  const dir = tempDir("allowlist-unit");
  const file = join(dir, "allowed.json");
  writeAtomically(file, JSON.stringify({ entries: [{ pubkey: listed.pubkey }] }));
  let reads = 0;
  const fs = {
    statSync,
    readFileSync: (p, enc) => {
      reads++;
      return readFileSync(p, enc);
    },
  };
  const { log } = logger();
  const a = new SenderAllowlist({ file, log, fs });
  assert.equal(a.allows(listed.pubkey), true);
  assert.equal(a.allows(other.pubkey), false);
  assert.equal(a.allows(other.pubkey), false);
  assert.equal(reads, 1, "an unchanged file is not read again");
  writeAtomically(file, JSON.stringify({ entries: [{ pubkey: other.pubkey }] }));
  assert.equal(a.allows(other.pubkey), true);
  assert.equal(a.allows(listed.pubkey), false);
  assert.equal(reads, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("a missing, unreadable, oversized or broken file allows nobody from it, and nothing throws", () => {
  const dir = tempDir("allowlist-unit-bad");
  const { log, text } = logger();
  // Missing.
  const missing = new SenderAllowlist({ file: join(dir, "absent.json"), trusted: [trustedPerson.pubkey], log });
  assert.equal(missing.allows(listed.pubkey), false);
  assert.equal(missing.allows(trustedPerson.pubkey), true);
  // A folder where the file should be.
  mkdirSync(join(dir, "folder.json"));
  assert.equal(new SenderAllowlist({ file: join(dir, "folder.json"), log }).allows(listed.pubkey), false);
  // Larger than 1 MB.
  const big = join(dir, "big.json");
  writeFileSync(big, JSON.stringify({ entries: [{ pubkey: listed.pubkey }], pad: "x".repeat(1024 * 1024) }));
  assert.equal(new SenderAllowlist({ file: big, log }).allows(listed.pubkey), false);
  assert.ok(text().includes("larger than 1 MB"));
  // A file system that throws anything at all.
  const throwing = {
    statSync: () => {
      throw new TypeError("boom");
    },
    readFileSync: () => {
      throw new TypeError("boom");
    },
  };
  assert.equal(new SenderAllowlist({ file: "x", log, fs: throwing }).allows(listed.pubkey), false);
  const readFails = { statSync: () => ({ dev: 1, ino: 1, size: 10, mtimeMs: 1, ctimeMs: 1 }), readFileSync: throwing.readFileSync };
  assert.equal(new SenderAllowlist({ file: "x", log, fs: readFails }).allows(listed.pubkey), false);
  // A log that throws does not make allows() throw.
  const goes = join(dir, "goes.json");
  writeAtomically(goes, JSON.stringify({ entries: [{ pubkey: listed.pubkey }] }));
  const angry = new SenderAllowlist({ file: goes, log });
  assert.equal(angry.allows(listed.pubkey), true);
  angry.log = () => {
    throw new Error("log full");
  };
  rmSync(goes);
  assert.equal(angry.allows(listed.pubkey), false);
  // The log never names a path or a key.
  assert.ok(!text().includes(dir));
  assert.ok(!text().includes(listed.pubkey));
  rmSync(dir, { recursive: true, force: true });
});

test("a no is settled only when the file was read cleanly: never while it is missing, broken or too large", () => {
  const dir = tempDir("allowlist-unit-settled");
  const { log } = logger();
  assert.equal(new SenderAllowlist({ listed: { keys: [listed.pubkey], skipped: 0 }, log }).settled(), true, "a list alone");
  const f = join(dir, "allowed.json");
  writeAtomically(f, JSON.stringify({ entries: [{ pubkey: listed.pubkey }] }));
  const a = new SenderAllowlist({ file: f, log });
  assert.equal(a.allows(other.pubkey), false);
  assert.equal(a.settled(), true, "read cleanly: a definite no");
  writeAtomically(f, `{"entries": [{"pubkey": "${other.pubkey}"`); // mid-rewrite
  assert.equal(a.allows(other.pubkey), false);
  assert.equal(a.settled(), false, "a broken file: not a definite no");
  assert.equal(a.allows(other.pubkey), false);
  assert.equal(a.settled(), false, "still broken, still not");
  rmSync(f);
  assert.equal(a.allows(other.pubkey), false);
  assert.equal(a.settled(), false, "a missing file: not a definite no");
  writeFileSync(f, JSON.stringify({ entries: [{ pubkey: listed.pubkey }], pad: "x".repeat(1024 * 1024) }));
  assert.equal(a.allows(other.pubkey), false);
  assert.equal(a.settled(), false, "too large: not a definite no");
  writeAtomically(f, JSON.stringify({ entries: [{ pubkey: listed.pubkey }, { pubkey: "nope" }] }));
  assert.equal(a.allows(other.pubkey), false);
  assert.equal(a.settled(), true, "read again cleanly (a bad entry is skipped): a definite no");
  const throwing = {
    statSync: () => ({ dev: 1, ino: 1, size: 10, mtimeMs: 1, ctimeMs: 1 }),
    readFileSync: () => {
      throw new TypeError("boom");
    },
  };
  const t = new SenderAllowlist({ file: "x", log, fs: throwing });
  assert.equal(t.allows(other.pubkey), false);
  assert.equal(t.settled(), false, "a read that throws: not a definite no");
  rmSync(dir, { recursive: true, force: true });
});

test("BUZZ_ALLOWED_PUBKEYS skips bad entries instead of failing, and unset or a placeholder is off", () => {
  const secret = identity().secret;
  const base = { BUZZ_RELAY_URL: "wss://relay.example.com", BUZZ_CHANNELS: "*" };
  const c = loadConfig({ ...base, BUZZ_ALLOWED_PUBKEYS: `${listed.npub}, bad-entry,${other.pubkey},${other.pubkey}` }, secret);
  assert.deepEqual(c.allowedPubkeys, { keys: [listed.pubkey, other.pubkey], skipped: 1 });
  assert.equal(loadConfig(base, secret).allowedPubkeys, undefined);
  assert.equal(loadConfig({ ...base, BUZZ_ALLOWED_PUBKEYS: "${user_config.buzz_allowed_pubkeys}" }, secret).allowedPubkeys, undefined);
  assert.deepEqual(loadConfig({ ...base, BUZZ_ALLOWED_PUBKEYS: " , " }, secret).allowedPubkeys, { keys: [], skipped: 0 });
  assert.equal(loadConfig({ ...base, BUZZ_ALLOWLIST_FILE: "~/allowed.json" }, secret).allowlistFile, join(homedir(), "allowed.json"));
  assert.equal(loadConfig({ ...base, BUZZ_ALLOWLIST_FILE: "" }, secret).allowlistFile, undefined);
});

test("rejectReason asks the allowlist only about a correctly signed event, and names the author", () => {
  const channel = "11111111-1111-4111-8111-111111111111";
  const watch = identity();
  const opts = { channels: [channel], watchPubkey: watch.pubkey };
  const asked = [];
  const allows = (pk) => {
    asked.push(pk);
    return pk === listed.pubkey;
  };
  const fromListed = message(listed.secret, { channel, mention: watch.pubkey });
  const fromOther = message(other.secret, { channel, mention: watch.pubkey });
  // Changed after signing. The JSON round trip drops nostr-tools' cached
  // "verified" mark, as the relay connection does.
  const forged = { ...JSON.parse(JSON.stringify(fromOther)), content: "changed" };
  assert.equal(rejectReason(fromListed, { ...opts, allows }), null);
  assert.equal(rejectReason(fromOther, { ...opts, allows }), `not on the sender allowlist (author ${other.pubkey})`);
  // A forged event never reaches the allowlist.
  assert.equal(rejectReason(forged, { ...opts, allows }), "bad signature");
  assert.deepEqual(asked, [listed.pubkey, other.pubkey]);
  // Without an allowlist, everyone passes.
  assert.equal(rejectReason(fromOther, opts), null);
});
