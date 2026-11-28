// gp hosted (hosted.mjs) against a fake order service (fake-order.mjs): the boot from a token and an address alone, the key kept once, the config's checks, the relay's, the
// senders in the allowlist file, the pack, and the status. A volume is made new for each test, and what the commands print is read for the secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, existsSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeOrder } from "./fake-order.mjs";
import { skills } from "./tarball.mjs";

const data = mkdtempSync(join(tmpdir(), "gp-hosted-"));
process.env.GP_DATA = data;
const { L } = await import("../layout.mjs");
const { hosted, orderOrigin, reportStatus, sync } = await import("../hosted.mjs");
const { GpError, makeOut } = await import("../out.mjs");
const { readJson } = await import("../files.mjs");
test.after(() => rmSync(data, { recursive: true, force: true }));

const reset = () => readdirSync(data).forEach((f) => rmSync(join(data, f), { recursive: true, force: true }));
const publicHost = async () => [{ address: "93.184.216.34" }];
const envOf = (s) => ({ GP_BOOT_TOKEN: s.token, GP_ORDER_URL: s.origin });
async function gp(argv, deps = {}) {
  const [so, se] = [[], []];
  const out = makeOut({ write: (t) => so.push(t) }, { write: (t) => se.push(t) });
  let code = 0;
  try {
    code = await hosted(argv, out, { lookup: publicHost, ...deps });
  } catch (err) {
    if (!(err instanceof GpError)) throw err;
    out.error(err.code, err.message);
    code = err.exitCode;
  }
  const [stdout, stderr] = [so.join(""), se.join("")];
  return { code, stdout, stderr, error: /^GP_ERROR=(.*)$/m.exec(stdout)?.[1], all: stdout + stderr };
}
const files = (dir = data) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
const allow = () => readJson(L.allowlist).entries;
const boot = async (s) => (assert.equal((await gp(["start"], { env: envOf(s) })).code, 0), s);

test("a volume boots from a token and an address alone, and the key is in its own file and nowhere else", async () => {
  reset();
  const s = await fakeOrder({ pack: skills("hello-skill") });
  const r = await gp(["start"], { env: envOf(s) });
  assert.equal(r.code, 0, r.all);
  assert.match(r.stdout, /^GP_HOSTED=booted$/m);
  assert.match(r.stdout, /^GP_PACK=installed$/m);
  assert.equal(readFileSync(L.key, "utf8"), `${s.agentSecretKey}\n`);
  assert.equal(statSync(L.key).mode & 0o777, 0o600);
  assert.deepEqual([readJson(L.config).owner, readJson(L.config).relay_url, JSON.parse(readFileSync(L.tag, "utf8"))], [s.ownerPubkey, s.relayUrl, s.attestation]);
  assert.deepEqual([readJson(L.hosted).order_url, readJson(L.hosted).agent_pubkey], [s.origin, s.agentPubkey]);
  assert.deepEqual(s.calls.map((c) => c.slice(0, 2).join(" ")), ["POST /v1/machine/boot", "GET /v1/machine/config", "GET /v1/machine/pack"]);
  assert.ok(existsSync(join(L.skills, "hello-skill", "SKILL.md")), "the pack is installed");
  for (const f of files().filter((f) => f !== L.key)) {
    const text = readFileSync(f).toString("latin1");
    assert.ok(!text.includes(s.agentSecretKey) && !text.includes(s.token), `${f} holds neither the key nor the token`);
  }
  assert.ok(!r.all.includes(s.agentSecretKey) && !r.all.includes(s.token), "neither is printed");
  await s.close();
});

test("the token is spent once", async () => {
  reset();
  const s = await fakeOrder();
  await boot(s);
  const again = await gp(["start"], { env: envOf(s) });
  assert.match(again.stdout, /^GP_HOSTED=ready$/m);
  assert.equal(s.calls.filter((c) => c[1] === "/v1/machine/boot").length, 1);
  reset();
  const fresh = await gp(["start"], { env: envOf(s) });
  assert.deepEqual([fresh.code, fresh.error, existsSync(L.key), existsSync(L.hosted)], [1, "boot-refused", false, false]);
  assert.ok(!fresh.all.includes(s.token));
  await s.close();
});

test("with no token and no earlier boot nothing is done, and a token on a volume with a key of its own is ignored", async () => {
  reset();
  const s = await fakeOrder();
  const none = await gp(["start"], { env: {} });
  assert.deepEqual([none.code, /^GP_HOSTED=none$/m.test(none.stdout), s.calls.length, existsSync(L.config)], [0, true, 0, false]);
  const { writeFileAtomic } = await import("../files.mjs");
  writeFileAtomic(L.key, `${"cd".repeat(32)}\n`);
  const ignored = await gp(["start"], { env: envOf(s) });
  assert.deepEqual([ignored.code, /^GP_HOSTED=none$/m.test(ignored.stdout), s.calls.length, readFileSync(L.key, "utf8")], [0, true, 0, `${"cd".repeat(32)}\n`]);
  await s.close();
});

test("an address that is not the service's alone, and a token that is not one, are refused before anything is sent", async () => {
  reset();
  const s = await fakeOrder();
  for (const url of ["http://example.com", "https://u:p@example.com", "https://example.com/v1", "https://example.com/?a=1", "https://example.com/#x", "ftp://example.com", "nonsense", ""]) {
    const r = await gp(["start"], { env: { GP_BOOT_TOKEN: s.token, GP_ORDER_URL: url } });
    assert.deepEqual([r.code, r.error], [1, url === "" ? "bad-order-url" : "bad-order-url"], url);
  }
  assert.deepEqual([orderOrigin("https://orders.example.com/"), orderOrigin("http://127.0.0.1:8787"), orderOrigin("http://localhost:3000/")], ["https://orders.example.com", "http://127.0.0.1:8787", "http://localhost:3000"]);
  const token = await gp(["start"], { env: { GP_BOOT_TOKEN: "short", GP_ORDER_URL: s.origin } });
  assert.deepEqual([token.error, s.calls.length, existsSync(L.key)], ["bad-boot-token", 0, false]);
  await s.close();
});

test("the first sender must be the owner, and the owner is the first boot's", async () => {
  reset();
  const other = "ee".repeat(32);
  const s = await fakeOrder();
  s.senders = [other, s.ownerPubkey];
  const r = await gp(["start"], { env: envOf(s) });
  assert.deepEqual([r.error, existsSync(L.key), readJson(L.config).relay_url], ["bad-config", true, undefined], "refused, with the key kept and the config not written");
  reset();
  const t = await boot(await fakeOrder());
  const before = readJson(L.config).owner;
  const { generateSecretKey, getPublicKey } = await import("nostr-tools/pure");
  const { signAuthTag } = await import("../nipoa.mjs");
  const next = generateSecretKey();
  t.ownerPubkey = getPublicKey(next);
  t.senders = [t.ownerPubkey];
  t.attestation = signAuthTag(next, t.agentPubkey);
  const swapped = await gp(["sync"]);
  assert.deepEqual([swapped.error, readJson(L.config).owner], ["bad-config", before], "a later config never changes the owner");
  await Promise.all([s.close(), t.close()]);
});

test("an attestation that is not the owner's for this agent is refused", async () => {
  const { generateSecretKey } = await import("nostr-tools/pure");
  const { signAuthTag } = await import("../nipoa.mjs");
  for (const [what, make] of [
    ["another signer", (s) => signAuthTag(generateSecretKey(), s.agentPubkey)],
    ["another agent", (s) => signAuthTag(s.ownerSecret, "ab".repeat(32))],
    ["a changed signature", (s) => [s.attestation[0], s.attestation[1], s.attestation[2], `${s.attestation[3].slice(0, 127)}${s.attestation[3].endsWith("0") ? "1" : "0"}`]],
    ["not four strings", (s) => s.attestation.slice(0, 3)],
  ]) {
    reset();
    const s = await fakeOrder();
    s.attestation = make(s);
    const r = await gp(["start"], { env: envOf(s) });
    assert.deepEqual([what, r.error, readJson(L.config).relay_url], [what, "bad-config", undefined]);
    await s.close();
  }
});

test("a relay that resolves to a private, loopback or link-local address, or is not over TLS, is refused and never written", async () => {
  const refuse = [
    ["a private name", async () => [{ address: "10.0.0.5" }]],
    ["a loopback name", async () => [{ address: "127.0.0.1" }]],
    ["the metadata address", async () => [{ address: "169.254.169.254" }]],
    ["IPv6 loopback", async () => [{ address: "::1" }]],
    ["one of two", async () => [{ address: "93.184.216.34" }, { address: "192.168.1.9" }]],
    ["no such name", async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOTFOUND" }))],
    ["no address", async () => []],
  ];
  for (const [what, lookup] of refuse) {
    reset();
    const s = await fakeOrder();
    s.relayUrl = "wss://relay.example.test";
    const r = await gp(["start"], { env: envOf(s), lookup });
    assert.deepEqual([what, r.error, readJson(L.config).relay_url, existsSync(L.key)], [what, "relay-private", undefined, true]);
    await s.close();
  }
  for (const literal of ["wss://10.1.2.3", "wss://127.0.0.1:3000", "wss://[::1]", "wss://[fe80::1]", "wss://169.254.169.254", "wss://[::ffff:10.0.0.1]"]) {
    reset();
    const s = await fakeOrder();
    s.relayUrl = literal;
    assert.equal((await gp(["start"], { env: envOf(s) })).error, "relay-private", literal);
    await s.close();
  }
  for (const [what, relayUrl, error] of [["a plain ws:// relay", "ws://relay.example.test", "relay-not-tls"], ["http://, which is ws://", "http://relay.example.test", "relay-not-tls"], ["a relay that is not an address", "relay", "bad-config"]]) {
    reset();
    const t = await fakeOrder();
    t.relayUrl = relayUrl;
    const r = await gp(["start"], { env: envOf(t) });
    assert.deepEqual([what, r.error, readJson(L.config).relay_url], [what, error, undefined]);
    await t.close();
  }
  reset();
  const s = await fakeOrder();
  s.relayUrl = "https://relay.example.test";
  assert.equal((await gp(["start"], { env: envOf(s), lookup: async () => [{ address: "10.0.0.5" }] })).error, "relay-private");
  const fixed = await gp(["start"]);
  assert.deepEqual([fixed.code, readJson(L.config).relay_url], [0, "https://relay.example.test"], "the next start, with the name public, goes on from the kept key; https:// is wss://");
  await s.close();
});

test("the other senders are in the allowlist file only: a sync replaces the order's, keeps a local one, never lists the owner", async () => {
  reset();
  const [a, b, c, d] = ["a1", "b2", "c3", "d4"].map((x) => x.repeat(32));
  const s = await fakeOrder();
  s.senders = [s.ownerPubkey, a, b];
  await boot(s);
  assert.deepEqual(allow(), [{ pubkey: a, source: "order" }, { pubkey: b, source: "order" }]);
  const { allow: allowCommand } = await import("../allow.mjs");
  await allowCommand(["add", c], makeOut({ write() {} }, { write() {} }));
  s.senders = [s.ownerPubkey, b, d];
  assert.equal((await gp(["sync"])).code, 0);
  assert.deepEqual(allow(), [{ pubkey: b, source: "order" }, { pubkey: d, source: "order" }, { pubkey: c, source: "local" }]);
  s.senders = [s.ownerPubkey, c];
  await gp(["sync"]);
  assert.deepEqual(allow(), [{ pubkey: c, source: "order" }], "a key the order now lists is the order's");
  assert.ok(!JSON.stringify(allow()).includes(s.ownerPubkey));
  await s.close();
});

test("an answer of the order service that is a redirect, or larger than the cap, is no answer", async () => {
  reset();
  const s = await boot(await fakeOrder());
  s.configRedirect = true;
  assert.equal((await gp(["sync"])).error, "order-unreachable", "a redirect is not followed");
  s.configRedirect = false;
  s.hugeAnswer = true;
  assert.equal((await gp(["sync"])).error, "order-unreachable", "an answer of 100 KB is not read");
  await s.close();
});

test("a volume that was booted starts while the order service is down, and every other failure still stops it", async () => {
  reset();
  const s = await boot(await fakeOrder({ pack: skills("hello-skill") }));
  const [origin, secret] = [s.origin, s.agentSecretKey];
  await s.close();
  const down = await gp(["start"]);
  assert.deepEqual([down.code, down.error, /^GP_PACK=unchecked$/m.test(down.stdout), /^GP_HOSTED=ready$/m.test(down.stdout)], [0, undefined, true, true], "the order service does not answer");
  assert.ok(existsSync(join(L.skills, "hello-skill", "SKILL.md")) && readJson(L.hosted).order_url === origin && readFileSync(L.key, "utf8").trim() === secret);
  const t = await fakeOrder(); // another order service, which knows no such agent: it answers 401
  (await import("../files.mjs")).writeJson(L.hosted, { ...readJson(L.hosted), order_url: t.origin });
  const ended = await gp(["start"]);
  assert.deepEqual([ended.code, ended.error], [1, "config-failed"], "an order service that refuses the agent (401) stops it, as an ended order must");
  t.configRedirect = true;
  assert.equal((await gp(["start"])).code, 0, "a redirect is an answer that is no answer");
  t.configRedirect = false;
  t.configStatus = 503;
  const sick = await gp(["start"]);
  assert.deepEqual([sick.code, /^GP_PACK=unchecked$/m.test(sick.stdout)], [0, true], "a 503 is the service being down");
  t.configStatus = 403;
  assert.deepEqual([(await gp(["start"])).error], ["config-failed"], "a 4xx is an answer, and stops the agent");
  await t.close();
  reset();
  const v = await fakeOrder();
  v.configRedirect = true;
  const half = await gp(["start"], { env: envOf(v) });
  assert.deepEqual([half.code, half.error, existsSync(L.key)], [1, "order-unreachable", true], "a first boot whose first pull fails is not tolerated, and keeps its key");
  assert.equal((await gp(["start"])).code, 0, "the next start, of a volume that is booted now, is");
  await v.close();
  reset();
  const w = await fakeOrder();
  w.configStatus = 503;
  const sickBoot = await gp(["start"], { env: envOf(w) });
  assert.deepEqual([sickBoot.code, sickBoot.error, existsSync(L.key)], [1, "order-unreachable", true], "a first boot whose first pull answers 503 is not tolerated either, and keeps its key");
  await w.close();
  reset();
  const u = await fakeOrder({ pack: skills("a") });
  await u.close();
  const first = await gp(["start"], { env: envOf(u) });
  assert.deepEqual([first.code, first.error, existsSync(L.hosted)], [1, "order-unreachable", false], "a volume never booted is not tolerated");
});

test("a heartbeat pulls, then says error after a failed pull and online after a good one, once the agent runs", async () => {
  reset();
  const s = await boot(await fakeOrder());
  const { writeFileAtomic } = await import("../files.mjs");
  const state = (v) => writeFileAtomic(L.agentState, `${v} 2026-01-01T00:00:00Z\n`);
  state("needs-claude");
  assert.deepEqual([(await gp(["heartbeat"])).code, s.statuses], [0, []], "an agent that is not running yet is not online");
  state("running");
  assert.match((await gp(["heartbeat"])).stdout, /^GP_REPORTED=online$/m);
  s.configRedirect = true;
  const failed = await gp(["heartbeat"]);
  s.configRedirect = false;
  assert.deepEqual([failed.code, s.statuses], [1, ["online", "error"]]);
  assert.equal((await gp(["heartbeat"])).code, 0);
  assert.deepEqual(s.statuses, ["online", "error", "online"], "the status is online again after the good pull");
  await s.close();
});

test("a boot answer whose secret key is not the agent's public key is refused before anything is kept", async () => {
  reset();
  const s = await fakeOrder();
  s.agentSecretKey = "ab".repeat(32);
  const r = await gp(["start"], { env: envOf(s) });
  assert.deepEqual([r.error, existsSync(L.key), existsSync(L.hosted), existsSync(L.config)], ["bad-config", false, false, false]);
  await s.close();
});

test("the agent tells the order service how it is, under its own key", async () => {
  reset();
  const s = await boot(await fakeOrder());
  for (const status of ["online", "error", "stopping"]) assert.equal((await gp(["report", status])).code, 0, status);
  assert.deepEqual(s.statuses, ["online", "error", "stopping"]);
  const bad = await gp(["report", "sleeping"]);
  assert.deepEqual([bad.code, s.statuses.length], [2, 3]);
  await assert.rejects(() => reportStatus("online", { fetchImpl: async () => new Response("{}", { status: 401 }) }), { code: "report-failed" });
  reset();
  await assert.rejects(() => reportStatus("online"), { code: "not-booted" });
  await assert.rejects(() => sync(), { code: "not-booted" });
  await s.close();
});

test("the pack is fetched once while it is current, and its address is never printed or kept", async () => {
  reset();
  const s = await fakeOrder({ pack: skills("hello-skill", "writer") });
  const first = await gp(["start"], { env: envOf(s) });
  const second = await gp(["sync"]);
  assert.match(first.stdout, /^GP_PACK=installed$/m);
  assert.match(second.stdout, /^GP_PACK=current$/m);
  assert.equal(s.calls.filter((c) => c[1] === "/v1/machine/pack").length, 1, "fetched once");
  assert.deepEqual(readJson(L.pack).skills, ["hello-skill", "writer"]);
  assert.deepEqual([readJson(L.pack).name, readJson(L.pack).sha256], [s.pack.name, s.pack.sha256]);
  for (const f of files()) assert.ok(!readFileSync(f).toString("latin1").includes("signature-of-the-test"), `${f} holds no part of the address`);
  assert.ok(!(first.all + second.all).includes("signature-of-the-test"));
  await s.close();
});

test("a pack that is not the one named is refused, and the pack kept stays", async () => {
  reset();
  const s = await fakeOrder({ pack: skills("hello-skill") });
  await boot(s);
  const kept = readFileSync(join(L.skills, "hello-skill", "SKILL.md"), "utf8");
  // The config now names a new pack, so it is fetched: first with a hash the bytes do not have, then with the service's own header naming another.
  const extra = skills("hello-skill", "extra");
  s.pack = { ...s.pack, bytes: extra, sha256: "11".repeat(32) };
  assert.equal((await gp(["sync"])).error, "pack-checksum", "bytes whose hash is not the config's");
  s.pack = { ...s.pack, sha256: createHash("sha256").update(extra).digest("hex"), headerSha256: "00".repeat(32) };
  assert.equal((await gp(["sync"])).error, "pack-refused", "a header that names another hash");
  s.pack.headerSha256 = undefined;
  s.packUrl = "http://127.0.0.1:1/v1/machine/pack?n=x";
  assert.equal((await gp(["sync"])).error, "pack-refused", "an address on another origin");
  s.packUrl = undefined;
  s.packRedirect = `${s.origin}/v1/machine/pack?n=elsewhere`;
  assert.equal((await gp(["sync"])).error, "pack-unreachable", "a redirect is not followed, even to an address that would serve it");
  assert.equal(readFileSync(join(L.skills, "hello-skill", "SKILL.md"), "utf8"), kept);
  assert.ok(!existsSync(join(L.skills, "extra")), "nothing of a refused pack is unpacked");
  s.packRedirect = undefined;
  assert.deepEqual([(await gp(["sync"])).code, existsSync(join(L.skills, "extra", "SKILL.md"))], [0, true], "the right pack is taken when the order service gives it");
  await s.close();
  assert.ok(lstatSync(L.skills).isDirectory());
});
