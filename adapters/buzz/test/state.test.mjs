import assert from "node:assert/strict";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_REFUSED, MAX_REFUSED_PER_AUTHOR, REFUSED_SAVE_MS, State } from "../src/state.mjs";
import { tempDir } from "./helpers.mjs";

const file = () => join(tempDir("state"), "nested", "cursor.json");
const ev = (id, created_at) => ({ id: id.padEnd(64, "0"), created_at, content: "secret words" });

test("first start sets the cursor to now and persists it", () => {
  const f = file();
  const s = new State(f, { slack: 120, now: () => 1000 }).load();
  assert.deepEqual(s.cursor, { id: null, created_at: 1000 });
  assert.equal(new State(f, { slack: 120, now: () => 5000 }).load().cursor.created_at, 1000);
});

test("since is the cursor minus the slack, capped by the maximum age", () => {
  const s = new State(file(), { slack: 120, now: () => 10_000 }).load();
  assert.equal(s.since(86_400), 10_000, "a fresh start replays nothing");
  s.record(ev("a", 10_000));
  assert.equal(s.since(86_400), 9_880);
  s.now = () => 200_000;
  assert.equal(s.since(86_400), 200_000 - 86_400);
});

test("a future-dated event does not push the cursor past now", () => {
  const s = new State(file(), { slack: 120, now: () => 1000 }).load();
  s.record(ev("f", 999_999));
  assert.equal(s.cursor.created_at, 1000);
  assert.ok(s.has("f".padEnd(64, "0")));
});

test("delivered ids survive a restart; the file holds ids, times and refused authors only, owner-only", () => {
  const f = file();
  const s = new State(f, { slack: 120, now: () => 1000 }).load();
  s.record(ev("a", 1000));
  s.record(ev("b", 1000));
  const again = new State(f, { slack: 120, now: () => 1001 }).load();
  assert.ok(again.has("a".padEnd(64, "0")) && again.has("b".padEnd(64, "0")));
  const text = readFileSync(f, "utf8");
  assert.ok(!text.includes("secret words"));
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["cursor", "refused", "seen", "version"]);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(statSync(join(f, "..")).mode & 0o777, 0o700);
});

test("ids far older than the overlap window are pruned", () => {
  const s = new State(file(), { slack: 100, now: () => 10_000 }).load();
  s.record(ev("old", 9_000));
  s.record(ev("new", 10_000));
  assert.ok(!s.has("old".padEnd(64, "0")));
  assert.ok(s.has("new".padEnd(64, "0")));
});

const hex = (n) => n.toString(16).padStart(64, "0");
const refusedEv = (n, pubkey, created_at) => ({ id: hex(0xf00000 + n), created_at, pubkey, content: "secret words" });

test("a refused id never moves the cursor nor pushes a delivered id out; refused ids are bounded, per author too", () => {
  const s = new State(file(), { slack: 120, now: () => 10_000 }).load();
  for (let i = 0; i < 50; i++) s.record(ev(`d${i}`, 9_990 + (i % 10)));
  const cursor = { ...s.cursor };
  const delivered = [...s.seen.keys()];
  s.save = () => {}; // thousands of refusals: written once, below
  // One author floods: it keeps only its newest few.
  const one = "b".repeat(64);
  for (let i = 0; i < 500; i++) s.refuse(refusedEv(i, one, 10_000 + (i % 3)));
  const ones = [...s.refused].filter(([, [, a]]) => a === one);
  assert.equal(ones.length, MAX_REFUSED_PER_AUTHOR);
  assert.ok(ones.every(([, [at]]) => at === 10_002), "an author's newest refusals are the ones kept");
  // Many authors flood: the refused ids stay within their bound.
  for (let i = 0; i < 3000; i++) s.refuse(refusedEv(1000 + i, hex(i + 1), 10_000));
  assert.equal(s.refused.size, MAX_REFUSED);
  // And none of it touched the cursor or the delivered ids.
  assert.deepEqual(s.cursor, cursor);
  assert.equal(s.seen.size, delivered.length);
  for (const id of delivered) assert.ok(s.has(id) && !s.hasRefused(id));
  // A delivered event is never also refused.
  s.refuse({ ...ev("d0", 9_990), pubkey: one });
  assert.ok(!s.hasRefused("d0".padEnd(64, "0")));
});

test("a refusal is kept under the key the allowlist refused, which for a workflow's message is its owner, not its signer", () => {
  const s = new State(file(), { slack: 120, now: () => 10_000 }).load();
  s.save = () => {};
  const relay = "a".repeat(64);
  const [first, flooding] = ["b".repeat(64), "c".repeat(64)];
  // Every message is signed by the relay; the keys refused are two owners'.
  s.refuse(refusedEv(0, relay, 10_000), first);
  for (let i = 1; i <= 60; i++) s.refuse(refusedEv(i, relay, 10_000 + i), flooding);
  assert.equal([...s.refused].filter(([, [, who]]) => who === first).length, 1, "the first owner's refusal stays");
  assert.equal([...s.refused].filter(([, [, who]]) => who === flooding).length, MAX_REFUSED_PER_AUTHOR);
  assert.equal([...s.refused].filter(([, [, who]]) => who === relay).length, 0, "nothing is kept under the signer");
  // Without a sender, the author is the key, as before.
  s.refuse(refusedEv(100, relay, 10_000));
  assert.equal([...s.refused].filter(([, [, who]]) => who === relay).length, 1);
});

test("refused ids survive a restart without moving the cursor; a file without them loads", () => {
  const f = file();
  const s = new State(f, { slack: 120, now: () => 1000 }).load();
  s.refuse(refusedEv(1, "b".repeat(64), 1000));
  assert.equal(s.cursor.id, null);
  s.flush(); // as the channel does when it stops
  const again = new State(f, { slack: 120, now: () => 1001 }).load();
  assert.ok(again.hasRefused(hex(0xf00001)));
  assert.ok(!again.has(hex(0xf00001)));
  assert.deepEqual(again.cursor, { id: null, created_at: 1000 });
  assert.ok(!readFileSync(f, "utf8").includes("secret words"));
  const old = file();
  mkdirSync(join(old, ".."), { recursive: true });
  writeFileSync(old, JSON.stringify({ version: 1, cursor: { id: null, created_at: 5 }, seen: [] }));
  assert.equal(new State(old, { slack: 120, now: () => 6 }).load().refused.size, 0);
});

test("refused ids are written together, not once each: within the wait, at a delivery, or at flush", async () => {
  assert.ok(REFUSED_SAVE_MS > 0 && REFUSED_SAVE_MS <= 5000);
  const f = file();
  const s = new State(f, { slack: 120, now: () => 1000, refusedSaveMs: 80 }).load();
  const real = s.save.bind(s);
  let writes = 0;
  s.save = () => {
    writes++;
    real();
  };
  const onDisk = () => JSON.parse(readFileSync(f, "utf8")).refused.length;
  // A flood of 200 refusals: no write for any of them yet.
  for (let i = 0; i < 200; i++) s.refuse(refusedEv(i, hex(i + 1), 1000));
  assert.equal(writes, 0, "a refusal wrote the file at once");
  assert.equal(onDisk(), 0);
  // Within the wait, one write holds them all.
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(writes, 1);
  assert.equal(onDisk(), 200);
  // An id already refused writes nothing, not even later.
  s.refuse(refusedEv(5, hex(6), 1000));
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(writes, 1);
  // A delivery writes the waiting ones at once, and no second write follows.
  s.refuse(refusedEv(500, hex(501), 1000));
  s.record(ev("e1", 1000));
  assert.equal(writes, 2);
  assert.equal(onDisk(), 201);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(writes, 2, "the wait wrote again after the delivery had");
  // flush() writes only when something waits.
  s.flush();
  assert.equal(writes, 2);
  s.refuse(refusedEv(501, hex(502), 1000));
  s.flush();
  assert.equal(writes, 3);
  assert.equal(onDisk(), 202);
});
