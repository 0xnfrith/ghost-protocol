import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { schnorr } from "@noble/curves/secp256k1.js";
import { VECTOR, digest, signAuthTag, verifyAuthTag, selfTest, conditionsOk } from "../nipoa.mjs";
import { relayCheck } from "../relaycheck.mjs";
import { main } from "../gp.mjs";
import { startFakeRelay } from "./fake-relay.mjs";

const hex = (b) => Buffer.from(b).toString("hex");
const OWNER_SK = new Uint8Array(32).fill(3);
const OWNER_HEX = hex(OWNER_SK);
const OWNER_PK = hex(schnorr.getPublicKey(OWNER_SK));
const AGENT_PK = hex(schnorr.getPublicKey(new Uint8Array(32).fill(9)));

function capture() {
  let out = "";
  let err = "";
  return {
    o: {
      header: () => { if (!out.startsWith("GP_INTERFACE=1\n")) out = "GP_INTERFACE=1\n" + out; },
      kv: (k, v) => (out += `GP_${k}=${v}\n`),
      log: (l) => (err += l + "\n"),
      raw: (s) => (out += s),
      error: (c, m) => { if (!out.startsWith("GP_INTERFACE=1\n")) out = "GP_INTERFACE=1\n" + out; out += `GP_ERROR=${c}\nGP_ERROR_MESSAGE=${m}\n`; },
    },
    get out() { return out; },
    get err() { return err; },
    kv(k) { const m = out.match(new RegExp(`^GP_${k}=(.*)$`, "m")); return m && m[1]; },
  };
}

function keyFile(content) {
  const dir = mkdtempSync(join(tmpdir(), "gp-attest-"));
  const f = join(dir, "owner.key");
  writeFileSync(f, content, { mode: 0o600 });
  return { f, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the NIP-OA test vector: digest and signature", () => {
  assert.equal(hex(digest(VECTOR.agent, VECTOR.conditions)), VECTOR.digest);
  assert.ok(verifyAuthTag(["auth", VECTOR.owner, VECTOR.conditions, VECTOR.sig], VECTOR.agent));
  assert.equal(selfTest(), null);
});

test("a signed tag verifies for its agent only, and a changed field breaks it", () => {
  const tag = signAuthTag(OWNER_SK, AGENT_PK, "created_at<1800000000");
  assert.equal(tag[1], OWNER_PK);
  assert.ok(verifyAuthTag(tag, AGENT_PK));
  assert.ok(!verifyAuthTag(tag, VECTOR.agent));
  assert.ok(!verifyAuthTag([tag[0], tag[1], "created_at<1800000001", tag[3]], AGENT_PK));
  assert.throws(() => signAuthTag(OWNER_SK, OWNER_PK), /different keys/);
});

test("conditions follow NIP-OA's grammar", () => {
  for (const c of ["", "kind=1", "created_at<1713957000", "kind=1&created_at>5&created_at<9"]) assert.ok(conditionsOk(c), c);
  for (const c of ["kind=01", "kind = 1", "created_at<", "foo=1", "kind=1&", "&kind=1"]) assert.ok(!conditionsOk(c), c);
});

test("gp attest signs with the key from a file and prints the tag", async () => {
  const k = keyFile(OWNER_HEX + "\n");
  const c = capture();
  assert.equal(await main(["attest", AGENT_PK, "--key-file", k.f], c.o), 0);
  k.done();
  assert.ok(c.out.startsWith("GP_INTERFACE=1\nGP_SELF_TEST=passed\n"));
  assert.equal(c.kv("OWNER_PUBKEY"), OWNER_PK);
  const tag = JSON.parse(c.kv("AUTH_TAG"));
  assert.equal(tag[2], "");
  assert.ok(verifyAuthTag(tag, AGENT_PK));
  assert.ok(!c.out.includes(OWNER_HEX) && !c.err.includes(OWNER_HEX), "the secret key is never printed");
});

test("gp attest --expires-in bounds the tag with created_at<", async () => {
  const k = keyFile(OWNER_HEX);
  const c = capture();
  const before = Math.floor(Date.now() / 1000);
  assert.equal(await main(["attest", AGENT_PK, "--key-file", k.f, "--expires-in", "2h"], c.o), 0);
  k.done();
  const t = Number(JSON.parse(c.kv("AUTH_TAG"))[2].replace("created_at<", ""));
  assert.ok(t >= before + 7200 && t <= before + 7205);
});

test("gp attest refuses a key on the command line, bad input, and two kinds of conditions", async () => {
  const cases = [
    [["attest", AGENT_PK, OWNER_HEX], "usage", 2],
    [["attest", AGENT_PK, "--key", OWNER_HEX], "usage", 2],
    [["attest"], "usage", 2],
    [["attest", "abc", "--key-file", "/nonexistent"], "bad-agent-pubkey", 1],
    [["attest", AGENT_PK, "--key-file", "/nonexistent"], "owner-key-unreadable", 1],
    [["attest", AGENT_PK, "--conditions", "kind=01"], "bad-conditions", 2],
    [["attest", AGENT_PK, "--conditions", "", "--expires-in", "1h"], "usage", 2],
  ];
  for (const [argv, code, rc] of cases) {
    const c = capture();
    assert.equal(await main(argv, c.o), rc, argv.join(" "));
    assert.equal(c.kv("ERROR"), code, argv.join(" "));
    assert.ok(c.out.startsWith("GP_INTERFACE=1\n"));
    assert.ok(!c.out.includes(OWNER_HEX), "a key given on the command line is never echoed");
  }
  const k = keyFile("not a key");
  const c = capture();
  assert.equal(await main(["attest", AGENT_PK, "--key-file", k.f], c.o), 1);
  k.done();
  assert.equal(c.kv("ERROR"), "bad-owner-key");
});

test("gp attest --self-test", async () => {
  const c = capture();
  assert.equal(await main(["attest", "--self-test"], c.o), 0);
  assert.equal(c.out, "GP_INTERFACE=1\nGP_SELF_TEST=passed\n");
});

test("the relay check tells connected, refused and unreachable apart", async () => {
  const tag = signAuthTag(OWNER_SK, AGENT_PK);
  for (const [mode, want] of [["accept", "connected"], ["refuse", "refused-not-member"], ["silent", "connected"], ["mute", "unreachable"]]) {
    const r = await startFakeRelay(mode);
    const res = await relayCheck({ url: r.url, secret: OWNER_SK, tag, timeoutMs: 1500, quietMs: 300 });
    await r.close();
    assert.equal(res.relay, want, mode);
    if (mode === "accept") {
      const auth = r.seen.find((m) => m[0] === "AUTH")[1];
      assert.equal(auth.kind, 22242);
      assert.deepEqual(auth.tags.find((t) => t[0] === "auth"), tag);
      assert.deepEqual(auth.tags.find((t) => t[0] === "challenge"), ["challenge", "challenge-1"]);
    }
  }
  const r = await startFakeRelay("accept");
  const url = r.url;
  await r.close();
  assert.equal((await relayCheck({ url, secret: OWNER_SK, timeoutMs: 1500 })).relay, "unreachable");
});

test("gp attest --relay reports the owner's login", async () => {
  const r = await startFakeRelay("refuse");
  const k = keyFile(OWNER_HEX);
  const c = capture();
  assert.equal(await main(["attest", AGENT_PK, "--key-file", k.f, "--relay", r.url], c.o), 0);
  k.done();
  await r.close();
  assert.equal(c.kv("RELAY_OWNER"), "refused-not-member");
  assert.match(c.err, /will refuse this tag/);
});
