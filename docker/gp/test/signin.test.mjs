import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { schnorr } from "@noble/curves/secp256k1.js";

const data = mkdtempSync(join(tmpdir(), "gp-signin-"));
process.env.GP_DATA = data;
const { L } = await import("../layout.mjs");
const { writeJson, writeFileAtomic } = await import("../setup.mjs");
const { signAuthTag } = await import("../nipoa.mjs");
const { authTag } = await import("../authtag.mjs");
const { token, login, tokenTrialArgs } = await import("../claude.mjs");
test.after(() => rmSync(data, { recursive: true, force: true }));

const hex = (b) => Buffer.from(b).toString("hex");
const OWNER_SK = new Uint8Array(32).fill(5);
const OWNER = hex(schnorr.getPublicKey(OWNER_SK));
const AGENT_SK = new Uint8Array(32).fill(6);
const AGENT = hex(schnorr.getPublicKey(AGENT_SK));
writeFileAtomic(L.key, hex(AGENT_SK) + "\n");
writeJson(L.config, { name: "A", relay_url: "ws://127.0.0.1:9", owner: OWNER });

function capture() {
  const c = { out: "", err: "" };
  c.o = { header: () => { if (!c.out) c.out = "GP_INTERFACE=1\n"; }, kv: (k, v) => (c.out += `GP_${k}=${v}\n`), log: (l) => (c.err += l + "\n"), raw: (x) => (c.out += x), error: () => {} };
  return c;
}

test("auth-tag set keeps a tag the owner signed for this agent", async () => {
  const tag = signAuthTag(OWNER_SK, AGENT, "created_at<1900000000");
  const c = capture();
  let seen;
  const rc = await authTag(["set"], c.o, { stdin: () => JSON.stringify(tag) + "\n", check: async (o) => ((seen = o), { relay: "connected" }) });
  assert.equal(rc, 0);
  assert.equal(c.out, "GP_INTERFACE=1\nGP_AUTH_TAG=accepted\nGP_RELAY=connected\n");
  assert.deepEqual(JSON.parse(readFileSync(L.tag, "utf8")), tag);
  assert.deepEqual(seen.tag, tag);
});

test("auth-tag set refuses a bad tag, one for another key, and one from another owner", async () => {
  const other = new Uint8Array(32).fill(8);
  for (const input of [
    "",
    "\n" + JSON.stringify(signAuthTag(OWNER_SK, AGENT)),
    "not json",
    '["auth","x",""]',
    '["auth","x","",5]',
    '["nope","x","","y"]',
    '["auth","x","","y"]',
    JSON.stringify(signAuthTag(OWNER_SK, hex(schnorr.getPublicKey(other)))),
    JSON.stringify(signAuthTag(other, AGENT)),
  ]) {
    await assert.rejects(authTag(["set"], capture().o, { stdin: () => input, check: async () => ({ relay: "connected" }) }), (e) => e.code === "bad-auth-tag", input);
  }
});

test("claude token: tried once, kept 0600, never printed; a refused one is claude-token-invalid", async () => {
  const t = "sk-ant-oat01-" + "x".repeat(40);
  let c = capture();
  assert.equal(await token(c.o, { stdin: () => t + "\n", tryIt: async (x) => x === t }), 0);
  assert.equal(c.out, "GP_CLAUDE=active\n");
  assert.equal(statSync(L.token).mode & 0o777, 0o600);
  assert.ok(!c.out.includes(t) && !c.err.includes(t));
  c = capture();
  await assert.rejects(token(c.o, { stdin: () => "sk-ant-oat01-" + "y".repeat(40), tryIt: async () => false }), (e) => e.code === "claude-token-invalid");
  await assert.rejects(token(c.o, { stdin: () => "has spaces in it, not a token", tryIt: async () => true }), (e) => e.code === "claude-token-invalid");
  await assert.rejects(token(c.o, { stdin: () => "\n", tryIt: async () => true }), (e) => e.code === "claude-token-invalid");
  assert.equal(readFileSync(L.token, "utf8").trim(), t, "a refused token leaves the kept one");
  // One line is read: what follows the first line is not part of the token.
  c = capture();
  assert.equal(await token(c.o, { stdin: () => t + "\nmore\n", tryIt: async (x) => x === t }), 0);
});

// A stand-in for `claude auth login`: prints the address, reads the code, accepts "good-code".
const fake = join(data, "fake-claude");
writeFileSync(fake, `#!/bin/sh
echo "Opening browser to sign in…"
echo "If the browser didn't open, visit: https://claude.example.com/oauth/authorize?code=true&state=abc"
printf "Paste code here if prompted > "
read code
[ "$code" = good-code ] && { echo "Login successful."; exit 0; }
echo "Login failed: That code wasn't accepted."; exit 1
`);
chmodSync(fake, 0o755);

async function runLogin(code, { early = false } = {}) {
  const c = capture();
  const stdin = new PassThrough();
  if (early) stdin.write(code + "\n");
  const p = login(c.o, { claude: fake, stdin, active: () => true });
  if (!early) setTimeout(() => stdin.write(code + "\n"), 300);
  try {
    return { rc: await p, c };
  } catch (e) {
    return { e, c };
  }
}

test("claude login prints the address, sends the code, and ends active", async () => {
  const { rc, c } = await runLogin("good-code");
  assert.equal(rc, 0);
  assert.match(c.out, /^GP_CLAUDE_LOGIN_URL=https:\/\/claude\.example\.com\/oauth\/authorize\?code=true&state=abc\nGP_CLAUDE=active\n$/);
  assert.ok(!c.err.includes("good-code"));
  assert.ok(!existsSync(L.token), "a new sign-in replaces the setup token");
});

test("claude login: a code written before the address still goes through; a wrong code fails", async () => {
  assert.equal((await runLogin("good-code", { early: true })).rc, 0);
  const { e, c } = await runLogin("bad-code");
  assert.equal(e.code, "claude-login-failed");
  assert.match(c.out, /^GP_CLAUDE_LOGIN_URL=/);
  const c2 = capture();
  const stdin = new PassThrough();
  setTimeout(() => stdin.end(), 300);
  await assert.rejects(login(c2.o, { claude: fake, stdin, active: () => true }), (e) => e.code === "claude-login-failed");
});

test("claude login: an empty line is no code, and fails at once", async () => {
  const t0 = Date.now();
  const { e, c } = await runLogin("");
  assert.equal(e.code, "claude-login-failed");
  assert.match(c.out, /^GP_CLAUDE_LOGIN_URL=/);
  assert.ok(Date.now() - t0 < 5000);
});

test("the token's trial runs without the plugin and with no MCP server, so its channel never logs in", () => {
  const a = tokenTrialArgs();
  assert.equal(a[0], "-p");
  assert.ok(a.includes("--strict-mcp-config"));
  const i = a.indexOf("--settings");
  assert.ok(i > 0);
  assert.deepEqual(JSON.parse(a[i + 1]), { enabledPlugins: { "ghost-protocol@ghost-protocol": false } });
});
