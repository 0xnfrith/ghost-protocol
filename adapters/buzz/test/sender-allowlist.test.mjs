// End-to-end tests of the sender allowlist: the real launcher and channel
// against the fake relay. These import nothing from the allowlist module, so
// each one shows what the channel itself does.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { message, startFakeRelay } from "./fake-relay.mjs";
import { closeAll, filesUnder, identity, keyAbsent, startChannel, tempDir, waitFor } from "./helpers.mjs";

const agent = identity(); // the key the channel runs as
const watch = identity(); // the identity whose mentions are delivered
const listed = identity(); // on the sender allowlist
const trustedPerson = identity(); // in BUZZ_TRUSTED_PUBKEYS
const stranger = identity(); // on no list

let relay;
const leakTexts = [];
const dirs = [];
before(async () => {
  relay = await startFakeRelay();
});
after(async () => {
  await closeAll();
  await relay.close();
  for (const dir of dirs) for (const f of filesUnder(dir)) leakTexts.push(f.text);
  assert.ok(keyAbsent(agent, leakTexts), "the private key leaked into output, a log or the state");
});

function setup(label, extra = {}) {
  const dir = tempDir(label);
  dirs.push(dir);
  const chan = randomUUID();
  const env = {
    BUZZ_CHANNELS: chan,
    BUZZ_WATCH_PUBKEY: watch.pubkey,
    BUZZ_STATE_DIR: join(dir, "state"),
    BUZZ_LOG_FILE: join(dir, "channel.log"),
    ...extra,
  };
  return { dir, chan, env, logText: () => readFileSync(env.BUZZ_LOG_FILE, "utf8") };
}

async function open(env) {
  const reqsBefore = relay.stats.reqs.length;
  const ch = await startChannel({ relayUrl: relay.url, key: agent, env });
  await waitFor(() => relay.stats.reqs.slice(reqsBefore).some((r) => r.subId.startsWith("buzz-channel-sub-")), {
    what: "the channel to subscribe",
  });
  return ch;
}

async function shut(ch) {
  leakTexts.push(ch.stderr());
  await ch.close();
}

/** Replaces the file in one step, as the README asks, so the channel never reads half of it. */
function writeAtomically(path, text) {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

const fileOf = (...pubkeys) => JSON.stringify({ entries: pubkeys.map((pubkey) => ({ pubkey, note: "a-note-that-is-never-read" })) });
const ids = (received) => received.map((r) => r.meta.event_id);
const mention = (who, chan, content) => message(who.secret, { channel: chan, mention: watch.pubkey, content });
const dropLine = (event, who) => `skipped ${event.id}: not on the sender allowlist (author ${who.pubkey})`;

test("with listed senders, only they and trusted people reach the session", async () => {
  const { chan, env, logText } = setup("allow-listed", {
    BUZZ_ALLOWED_PUBKEYS: `${listed.npub}, not-a-public-key`,
    BUZZ_TRUSTED_PUBKEYS: trustedPerson.pubkey,
  });
  const ch = await open(env);
  const fromStranger = mention(stranger, chan, "words from a stranger");
  const fromListed = mention(listed, chan, "from the listed sender");
  const fromTrusted = mention(trustedPerson, chan, "from the trusted person");
  for (const e of [fromStranger, fromListed, fromTrusted]) relay.publish(e);
  await waitFor(() => ch.received.length >= 2, { what: "the allowed mentions" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(ids(ch.received), [fromListed.id, fromTrusted.id]);
  const log = logText();
  // The drop is logged by event id and author, never with the message text.
  assert.ok(log.includes(dropLine(fromStranger, stranger)), "the drop is logged");
  assert.ok(!log.includes("words from a stranger"));
  // A bad entry is skipped and counted, never repeated, and stops nothing.
  assert.ok(log.includes("BUZZ_ALLOWED_PUBKEYS: skipped 1 entry"));
  assert.ok(!log.includes("not-a-public-key"));
  assert.ok(!log.includes("no sender allowlist"));
  await shut(ch);
});

test("the allowlist file is read again when it changes", async () => {
  const { dir, chan, env, logText } = setup("allow-file");
  const file = join(dir, "allowed.json");
  writeAtomically(file, fileOf(listed.pubkey));
  const ch = await open({ ...env, BUZZ_ALLOWLIST_FILE: file });

  const s1 = mention(stranger, chan, "stranger, first");
  const l1 = mention(listed, chan, "listed, first");
  for (const e of [s1, l1]) relay.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the listed sender's mention" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(ids(ch.received), [l1.id]);
  assert.ok(logText().includes(dropLine(s1, stranger)));

  // Swap who is on the file: the stranger in (as npub1), the listed sender out.
  writeAtomically(file, fileOf(stranger.npub));
  const l2 = mention(listed, chan, "listed, second");
  const s2 = mention(stranger, chan, "stranger, second");
  for (const e of [l2, s2]) relay.publish(e);
  await waitFor(() => ch.received.length >= 2, { what: "the newly allowed mention" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(ids(ch.received), [l1.id, s2.id]);
  assert.ok(logText().includes(dropLine(l2, listed)));
  assert.ok(!logText().includes("a-note-that-is-never-read"), "fields other than pubkey are not read");
  await shut(ch);
});

test("a mention the allowlist refused is never delivered later, even once its sender is allowed", async () => {
  const { dir, chan, env, logText } = setup("allow-replay");
  const file = join(dir, "allowed.json");
  writeAtomically(file, fileOf(listed.pubkey));
  let ch = await open({ ...env, BUZZ_ALLOWLIST_FILE: file });
  const refused = mention(stranger, chan, "stranger, refused");
  const l1 = mention(listed, chan, "listed, first");
  for (const e of [refused, l1]) relay.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the listed sender's mention" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(ids(ch.received), [l1.id]);
  assert.ok(logText().includes(dropLine(refused, stranger)));
  await shut(ch);

  // The stranger is allowed now, and the channel starts again on the same
  // cursor, as a key service's channel does after every allowlist change.
  // Its catch-up reads both old mentions again: neither comes back.
  writeAtomically(file, fileOf(listed.pubkey, stranger.pubkey));
  ch = await open({ ...env, BUZZ_ALLOWLIST_FILE: file });
  const s2 = mention(stranger, chan, "stranger, now allowed");
  relay.publish(s2);
  await waitFor(() => ch.received.length >= 1, { what: "the newly allowed sender's new mention" });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(ids(ch.received), [s2.id], "the refused mention came back on the catch-up");
  assert.ok(logText().includes(`skipped ${refused.id}: refused before by the sender allowlist`), "the catch-up saw the refused mention and skipped it");
  await shut(ch);
});

test("a refusal just before a stop is written by the stop, and stays refused after it", async () => {
  const { dir, chan, env, logText } = setup("allow-stop-flush");
  const file = join(dir, "allowed.json");
  writeAtomically(file, fileOf(listed.pubkey));
  let ch = await open({ ...env, BUZZ_ALLOWLIST_FILE: file });
  const refused = mention(stranger, chan, "stranger, refused just before the stop");
  relay.publish(refused);
  await waitFor(() => logText().includes(dropLine(refused, stranger)), { what: "the refusal" });
  // Stopped at once, well inside the wait before refused ids are written: the
  // stop itself must write it.
  const pid = ch.pid;
  await shut(ch);
  await waitFor(
    () => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    },
    { what: "the channel to exit" },
  );
  const f = readdirSync(env.BUZZ_STATE_DIR).find((n) => /^cursor-.*\.json$/.test(n));
  const onDisk = JSON.parse(readFileSync(join(env.BUZZ_STATE_DIR, f), "utf8"));
  assert.ok(onDisk.refused.some(([id]) => id === refused.id), "the stop did not write the refused id");
  writeAtomically(file, fileOf(listed.pubkey, stranger.pubkey));
  ch = await open({ ...env, BUZZ_ALLOWLIST_FILE: file });
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(ids(ch.received), [], "the refused mention came back after the stop");
  await shut(ch);
});

test("a flood from a refused sender moves no cursor and pushes out no delivered id, and an allowed mention after it is delivered", async () => {
  const { chan, env } = setup("allow-flood", { BUZZ_ALLOWED_PUBKEYS: listed.pubkey });
  const state = () => {
    const f = readdirSync(env.BUZZ_STATE_DIR).find((n) => /^cursor-.*\.json$/.test(n));
    return JSON.parse(readFileSync(join(env.BUZZ_STATE_DIR, f), "utf8"));
  };
  let ch = await open(env);
  const l1 = mention(listed, chan, "listed, before the flood");
  relay.publish(l1);
  await waitFor(() => ch.received.length >= 1, { what: "the listed sender's mention" });
  await waitFor(() => state().cursor.id === l1.id, { what: "the cursor at the delivered mention" });
  const before = state();
  const flood = Array.from({ length: 40 }, (_, i) => mention(stranger, chan, `flood ${i}`));
  for (const e of flood) relay.publish(e);
  await waitFor(() => state().refused?.length >= 20, { what: "the flood to be refused" });
  await new Promise((r) => setTimeout(r, 300));
  const after = state();
  assert.deepEqual(after.cursor, before.cursor, "the flood moved the cursor");
  assert.ok(after.seen.some(([id]) => id === l1.id), "the flood pushed out a delivered id");
  assert.equal(after.seen.length, before.seen.length, "the flood went in with the delivered ids");
  assert.equal(after.refused.filter(([, , who]) => who === stranger.pubkey).length, 20, "one author keeps at most 20 refused ids");
  const l2 = mention(listed, chan, "listed, after the flood");
  relay.publish(l2);
  await waitFor(() => ch.received.length >= 2, { what: "the allowed mention after the flood" });
  assert.deepEqual(ids(ch.received), [l1.id, l2.id]);
  await shut(ch);
  // A restart catches up over all of it, and delivers nothing again.
  ch = await open(env);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(ids(ch.received), []);
  await shut(ch);
});

test("a malformed or missing allowlist file allows nobody from it, and the channel keeps running", async () => {
  const { dir, chan, env, logText } = setup("allow-bad-file", { BUZZ_TRUSTED_PUBKEYS: trustedPerson.pubkey });
  const file = join(dir, "allowed.json");
  writeAtomically(file, `{"entries": [{"pubkey": "${stranger.pubkey}"`); // cut off
  const ch = await open({ ...env, BUZZ_ALLOWLIST_FILE: file });

  const s1 = mention(stranger, chan, "stranger, while the file is broken");
  const t1 = mention(trustedPerson, chan, "trusted, while the file is broken");
  for (const e of [s1, t1]) relay.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the trusted person's mention" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(ids(ch.received), [t1.id]);
  assert.ok(logText().includes(dropLine(s1, stranger)));
  assert.ok(logText().includes("BUZZ_ALLOWLIST_FILE is not shaped"));

  // Bad entries next to a good one: only the good one counts.
  writeAtomically(
    file,
    JSON.stringify({ entries: [{ pubkey: "nope" }, { pubkey: 42 }, null, "x", { pubkey: stranger.pubkey }] }),
  );
  const s2 = mention(stranger, chan, "stranger, after the fix");
  relay.publish(s2);
  await waitFor(() => ch.received.length >= 2, { what: "the mention after the fix" });
  assert.deepEqual(ids(ch.received), [t1.id, s2.id]);
  assert.ok(logText().includes("BUZZ_ALLOWLIST_FILE read: 1 key(s); skipped 4 entries"));

  // A file that disappears allows nobody, and the channel stays up.
  renameSync(file, `${file}.gone`);
  const s3 = mention(stranger, chan, "stranger, file gone");
  const t2 = mention(trustedPerson, chan, "trusted, file gone");
  for (const e of [s3, t2]) relay.publish(e);
  await waitFor(() => ch.received.length >= 3, { what: "the trusted person's second mention" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(ids(ch.received), [t1.id, s2.id, t2.id]);
  assert.ok(logText().includes(dropLine(s3, stranger)));
  assert.ok(logText().includes("BUZZ_ALLOWLIST_FILE cannot be read"));
  await shut(ch);

  // Those refusals only failed closed: none was kept. With the file back,
  // the channel starts again and its catch-up delivers both mentions sent
  // while it could not be read; nothing else comes twice.
  for (const e of [s1, s3]) assert.ok(logText().includes(`not keeping ${e.id} as refused`), "a refusal while the file could not be read was kept");
  renameSync(`${file}.gone`, file);
  const again = await open({ ...env, BUZZ_ALLOWLIST_FILE: file });
  await waitFor(() => again.received.length >= 2, { what: "the catch-up of the mentions sent while the file was broken" });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(ids(again.received).sort(), [s1.id, s3.id].sort());
  await shut(again);
});

test("with neither option set, anyone who mentions the agent reaches it, and the log warns once", async () => {
  // Unfilled plugin placeholders and empty values count as unset, and trusted
  // people alone do not turn the allowlist on.
  const { chan, env, logText } = setup("allow-open", {
    BUZZ_ALLOWED_PUBKEYS: "${user_config.buzz_allowed_pubkeys}",
    BUZZ_ALLOWLIST_FILE: "",
    BUZZ_TRUSTED_PUBKEYS: trustedPerson.pubkey,
  });
  const ch = await open(env);
  const e = mention(stranger, chan, "anyone may write");
  relay.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the stranger's mention" });
  assert.deepEqual(ids(ch.received), [e.id]);
  assert.equal(logText().match(/no sender allowlist/g)?.length, 1, "one warning at start");
  await shut(ch);
});
