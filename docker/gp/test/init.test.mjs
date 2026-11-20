import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "gp-init-"));
process.env.GP_DATA = data;
const { L } = await import("../layout.mjs");
const { main } = await import("../gp.mjs");
const { readJson } = await import("../setup.mjs");
test.after(() => rmSync(data, { recursive: true, force: true }));
const OWNER = "ab".repeat(32);

async function gp(argv) {
  let out = "";
  const o = { header: () => { if (!out) out = "GP_INTERFACE=1\n"; }, kv: (k, v) => (out += `GP_${k}=${v}\n`), raw: (x) => (out += x), log: () => {}, error: (c, m) => { if (!out) out = "GP_INTERFACE=1\n"; out += `GP_ERROR=${c}\nGP_ERROR_MESSAGE=${m}\n`; } };
  const rc = await main(argv, o);
  return { rc, out, kv: (k) => out.match(new RegExp(`^GP_${k}=(.*)$`, "m"))?.[1] };
}

test("init makes the key in the volume, prints its public key, and keeps it", async () => {
  const a = await gp(["init", "--name", "Ada Lovelace", "--relay", "wss://relay.example.com", "--owner", OWNER]);
  assert.equal(a.rc, 0);
  assert.match(a.out, /^GP_INTERFACE=1\nGP_VERSION=.+\nGP_SLUG=ada-lovelace\nGP_AGENT_PUBKEY=[0-9a-f]{64}\n$/);
  assert.equal(statSync(L.key).mode & 0o777, 0o600);
  const secret = readFileSync(L.key, "utf8").trim();
  assert.ok(!a.out.includes(secret), "the secret key is never printed");
  assert.deepEqual(readJson(L.config), { name: "Ada Lovelace", slug: "ada-lovelace", relay_url: "wss://relay.example.com", owner: OWNER });
  const b = await gp(["init", "--name", "Ada", "--relay", "https://other.example.com", "--owner", OWNER]);
  assert.equal(b.rc, 0);
  assert.equal(b.kv("AGENT_PUBKEY"), a.kv("AGENT_PUBKEY"));
  assert.equal(readJson(L.config).relay_url, "https://other.example.com");
});

test("a bad init is init-failed, and changes nothing", async () => {
  const before = readFileSync(L.config, "utf8");
  for (const argv of [
    ["init"],
    ["init", "--name", "A", "--relay", "ftp://x", "--owner", OWNER],
    ["init", "--name", "A", "--relay", "wss://x.example.com", "--owner", "nope"],
    ["init", "--name", "A\nB", "--relay", "wss://x.example.com", "--owner", OWNER],
    ["init", "--name", "  ", "--relay", "wss://x.example.com", "--owner", OWNER],
    ["init", "--name", "A", "--relay", "wss://x.example.com", "--owner", OWNER, "--key", "x"],
  ]) {
    const r = await gp(argv);
    assert.equal(r.rc, 1, argv.join(" "));
    assert.equal(r.kv("ERROR"), "init-failed", argv.join(" "));
    assert.ok(r.out.startsWith("GP_INTERFACE=1\n"));
  }
  assert.equal(readFileSync(L.config, "utf8"), before);
});

test("a name is any one non-empty line", async () => {
  const name = 'Ada "the {first}" \\ Lovelace, who wrote the first program for an engine that was never built';
  const r = await gp(["init", "--name", name, "--relay", "wss://relay.example.com", "--owner", OWNER]);
  assert.equal(r.rc, 0);
  assert.equal(readJson(L.config).name, name);
  assert.match(r.kv("SLUG"), /^[a-z0-9-]{1,40}$/);
});

test("gp slug", async () => {
  assert.equal((await gp(["slug", "My Agent"])).kv("SLUG"), "my-agent");
  assert.equal((await gp(["slug"])).rc, 2);
});
