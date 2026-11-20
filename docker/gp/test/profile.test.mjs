import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyEvent, getPublicKey } from "nostr-tools/pure";
import { startFakeRelay } from "./fake-relay.mjs";

const data = mkdtempSync(join(tmpdir(), "gp-profile-"));
process.env.GP_DATA = data;
const { L } = await import("../layout.mjs");
const { writeJson, readJson } = await import("../files.mjs");
const { relayCheck } = await import("../relaycheck.mjs");
const { publishOnce, profile, profileContent } = await import("../profile.mjs");
const { makeOut } = await import("../out.mjs");
test.after(() => rmSync(data, { recursive: true, force: true }));

const SK_HEX = "11".repeat(32);
const PK = getPublicKey(Buffer.from(SK_HEX, "hex"));
const quick = (o) => relayCheck({ ...o, timeoutMs: 1500, quietMs: 300 });
const setUp = (name, relay_url) => {
  mkdirSync(join(L.key, ".."), { recursive: true });
  writeFileSync(L.key, SK_HEX + "\n");
  writeJson(L.config, { name, slug: "x", relay_url, owner: "ab".repeat(32) });
};
const capture = () => {
  let out = "";
  let err = "";
  const o = makeOut({ write: (s) => (out += s) }, { write: (s) => (err += s) });
  return { o, get out() { return out; }, get err() { return err; } };
};
const events = (r) => r.seen.filter((m) => m[0] === "EVENT").map((m) => m[1]);

test("the profile is a kind-0 with the init name, signed by the agent's key", async () => {
  rmSync(L.profile, { force: true });
  const r = await startFakeRelay("accept");
  setUp('Ada "the agent" Ø', r.url);
  assert.equal(await publishOnce({ check: quick }), "published");
  await r.close();
  const [ev] = events(r);
  assert.equal(ev.kind, 0);
  assert.equal(ev.pubkey, PK);
  assert.ok(verifyEvent(ev));
  assert.deepEqual(JSON.parse(ev.content), { name: 'Ada "the agent" Ø', display_name: 'Ada "the agent" Ø' });
  assert.equal(ev.content, profileContent('Ada "the agent" Ø'));
  // The login came first, and the event only after it was accepted.
  assert.deepEqual(r.seen.map((m) => m[0]), ["AUTH", "EVENT"]);
  const rec = readJson(L.profile);
  assert.equal(rec.event_id, ev.id);
  assert.equal(rec.name, 'Ada "the agent" Ø');
});

test("the same name is not sent again; a new name is, and later in time", async () => {
  const r = await startFakeRelay("accept");
  setUp("Ada", r.url);
  rmSync(L.profile, { force: true });
  assert.equal(await publishOnce({ check: quick, now: 1_000_000_000_000 }), "published");
  assert.equal(await publishOnce({ check: quick, now: 1_000_000_000_000 }), "unchanged");
  setUp("Grace", r.url);
  // Same second: created_at still moves on, so the new name replaces the old.
  assert.equal(await publishOnce({ check: quick, now: 1_000_000_000_000 }), "published");
  await r.close();
  const evs = events(r);
  assert.equal(evs.length, 2);
  assert.equal(JSON.parse(evs[1].content).name, "Grace");
  assert.ok(evs[1].created_at > evs[0].created_at);
});

test("the owner's tag goes in the login", async () => {
  rmSync(L.profile, { force: true });
  const r = await startFakeRelay("accept");
  setUp("Ada", r.url);
  const tag = ["auth", "ab".repeat(32), "", "cd".repeat(64)];
  writeFileSync(L.tag, JSON.stringify(tag) + "\n");
  assert.equal(await publishOnce({ check: quick }), "published");
  await r.close();
  rmSync(L.tag);
  const auth = r.seen.find((m) => m[0] === "AUTH")[1];
  assert.deepEqual(auth.tags.find((t) => t[0] === "auth"), tag);
});

test("a relay that wants the login only after the event gets it, and the event again", async () => {
  rmSync(L.profile, { force: true });
  const r = await startFakeRelay("late");
  setUp("Ada", r.url);
  assert.equal(await publishOnce({ check: quick }), "published");
  await r.close();
  assert.deepEqual(r.seen.map((m) => m[0]), ["EVENT", "AUTH", "EVENT"]);
});

test("a refused login, a refused event and no relay are profile-failed, and nothing is recorded", async () => {
  for (const [mode, why] of [["refuse", /refused-not-member/], ["no-events", /refused the profile: blocked/], ["mute", /unreachable/]]) {
    rmSync(L.profile, { force: true });
    const r = await startFakeRelay(mode);
    setUp("Ada", r.url);
    await assert.rejects(publishOnce({ check: quick }), (e) => e.code === "profile-failed" && why.test(e.message), mode);
    await r.close();
    assert.equal(existsSync(L.profile), false, mode);
  }
});

test("gp profile publish prints the result; --retry waits and tries again", async () => {
  rmSync(L.profile, { force: true });
  setUp("Ada", "ws://127.0.0.1:9");
  let c = capture();
  await assert.rejects(profile(["publish"], c.o, { check: quick }), (e) => e.code === "profile-failed");

  const r = await startFakeRelay("accept");
  const waits = [];
  let tries = 0;
  const flaky = (o) => (++tries < 3 ? Promise.resolve({ relay: "unreachable", detail: "", sent: false }) : quick(o));
  setUp("Ada", r.url);
  c = capture();
  assert.equal(await profile(["publish", "--retry"], c.o, { check: flaky, sleep: async (ms) => waits.push(ms) }), 0);
  await r.close();
  assert.equal(c.out, "GP_INTERFACE=1\nGP_PROFILE=published\n");
  assert.deepEqual(waits, [15000, 30000]);
  assert.match(c.err, /trying again in 15 s/);

  c = capture();
  assert.equal(await profile(["publish"], c.o, { check: quick }), 0);
  assert.equal(c.out, "GP_INTERFACE=1\nGP_PROFILE=unchanged\n");
  await assert.rejects(profile(["publish", "--now"], capture().o), (e) => e.code === "usage");
});

test("not set up is profile-failed", async () => {
  rmSync(L.config, { force: true });
  await assert.rejects(publishOnce({ check: quick }), (e) => e.code === "profile-failed" && /init/.test(e.message));
});
