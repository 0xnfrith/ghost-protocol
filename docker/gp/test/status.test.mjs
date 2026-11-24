import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "gp-status-"));
process.env.GP_DATA = data;
const { L } = await import("../layout.mjs");
const { collect, relayFromLog } = await import("../status.mjs");
const { writeJson } = await import("../setup.mjs");
const { main } = await import("../gp.mjs");
test.after(() => rmSync(data, { recursive: true, force: true }));

const FIELDS = ["interface", "version", "state", "agent_pubkey", "relay_url", "relay", "claude", "update", "previous_version", "error"];
const put = (p, s) => {
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, s);
};
const run = (o = {}) => collect({ probe: async () => o.probe ?? "unreachable", claude: () => o.claude ?? true });

test("the channel's log decides the relay, since the last start only", () => {
  const log = [
    "2026-01-01T00:00:01.000Z buzz-channel: connected to wss://r",
    "2026-01-01T00:00:02.000Z buzz-channel: relay accepted AUTH",
    "2026-01-01T00:00:09.000Z buzz-channel: connected to wss://r",
    "2026-01-01T00:00:09.500Z buzz-channel: relay refused AUTH: restricted: not a relay member",
    "2026-01-01T00:00:09.600Z buzz-channel: connection closed (code 1000)",
  ].join("\n");
  assert.equal(relayFromLog(log), "refused-not-member");
  assert.equal(relayFromLog(log, "2026-01-01T00:00:10Z"), null);
  assert.equal(relayFromLog(log.split("\n").slice(0, 2).join("\n"), "2026-01-01T00:00:02Z"), "connected");
  assert.equal(relayFromLog("2026-01-01T00:00:03.000Z buzz-channel: could not open a connection to the relay"), "unreachable");
});

test("not set up: state error, with every field", async () => {
  const s = await run();
  assert.deepEqual(Object.keys(s), FIELDS);
  assert.equal(s.interface, 1);
  assert.equal(s.state, "error");
  assert.deepEqual(s.error, { code: "not-set-up", message: "the agent is not set up: run init" });
});

test("the states, from the volume", async () => {
  put(L.key, "11".repeat(32) + "\n");
  writeJson(L.config, { name: "A", relay_url: "wss://relay.example.com", owner: "ab".repeat(32) });
  put(L.agentState, "needs-claude 2026-01-01T00:00:00Z\n");
  // Neither the tag nor the sign-in: the tag first.
  let s = await run({ claude: false, probe: "refused-not-member" });
  assert.equal(s.state, "needs-auth-tag");
  assert.equal(s.claude, "not-active");
  assert.match(s.agent_pubkey, /^[0-9a-f]{64}$/);
  assert.equal(s.relay_url, "wss://relay.example.com");
  assert.equal((await run({ claude: false, probe: "unreachable" })).state, "needs-auth-tag");
  // A relay member needs no tag.
  assert.equal((await run({ claude: false, probe: "connected" })).state, "needs-claude");

  put(L.agentState, "running 2026-01-01T00:00:00Z\n");
  s = await run({ probe: "refused-not-member" });
  assert.equal(s.state, "needs-auth-tag");
  assert.equal(s.relay, "refused-not-member");
  put(L.tag, '["auth","x","","y"]\n');
  // The tag, no sign-in: needs-claude.
  assert.equal((await run({ claude: false, probe: "refused-not-member" })).state, "needs-claude");
  s = await run({ probe: "refused-not-member" });
  assert.equal(s.state, "connecting");
  // A refused login does not get in by waiting: the error says so, and says what the relay needs: owner attestations on, and the
  // owner a relay member. It never offers the agent as a relay member, a way that is not supported.
  assert.equal(s.error.code, "relay-refused");
  assert.match(s.error.message, /the relay must have owner attestations on \(BUZZ_ALLOW_NIP_OA_AUTH=true\), and the owner must be a relay member there/);
  assert.doesNotMatch(s.error.message, /\badd\b|this agent .* as a relay member|agent as a (relay )?member/i);
  assert.ok(s.error.message.includes(s.agent_pubkey), "the message names the agent's key");
  assert.equal((await run({ claude: false, probe: "refused-not-member" })).error, null, "needs-claude waits on the user, not the relay");
  s = await run({ probe: "unreachable" });
  assert.equal(s.state, "connecting");
  assert.equal(s.error, null, "an unreachable relay may come back");

  put(L.channelLog, "2026-01-01T00:00:05.000Z buzz-channel: relay accepted AUTH\n");
  s = await run({ probe: "unreachable" });
  assert.equal(s.relay, "connected");
  assert.equal(s.state, "running");
  assert.equal(s.error, null);
  assert.deepEqual(s.update, { available: false, version: null });

  writeJson(L.updateAvailable, { version: "9.9.9" });
  put(L.previousVersion, "0.0.1\n");
  s = await run();
  assert.deepEqual(s.update, { available: true, version: "9.9.9", image: null, digest: null }, "a test's offer without a pin");
  const pin = "ghcr.io/0xnfrith/ghost-protocol:9.9.9@sha256:" + "ab".repeat(32);
  writeJson(L.updateAvailable, { version: "9.9.9", image: pin, digest: "sha256:" + "ab".repeat(32) });
  s = await run();
  assert.deepEqual(s.update, { available: true, version: "9.9.9", image: pin, digest: "sha256:" + "ab".repeat(32) }, "pinned by digest");
  writeJson(L.updateAvailable, { version: "9.9.9", image: "ghcr.io/0xnfrith/ghost-protocol:9.9.9", digest: "sha256:" + "ab".repeat(32) });
  assert.deepEqual((await run()).update, { available: true, version: "9.9.9", image: null, digest: null }, "a bare tag is never passed on");
  writeJson(L.updateAvailable, { version: "9.9.9", image: pin.replace("9.9.9@", "9.9.8@"), digest: "sha256:" + "ab".repeat(32) });
  assert.equal((await run()).update.image, null, "an image of another version is not passed on");
  writeJson(L.updateAvailable, { version: "9.9.9", image: pin, digest: "sha256:" + "cd".repeat(32) });
  assert.equal((await run()).update.image, null, "an image whose digest is not the digest field is not passed on");
  writeJson(L.updateAvailable, { version: "9.9.9", image: pin, digest: "sha256:" + "ab".repeat(32) });
  assert.equal(s.previous_version, "0.0.1");
  writeJson(L.updateState, { state: "updating", action: "update", from: "0.0.0", to: "9.9.9", at: new Date().toISOString() });
  assert.equal((await run()).state, "updating");
  rmSync(L.updateState);
  put(L.agentState, "error 2026-01-01T00:00:00Z\n");
  s = await run();
  assert.equal(s.state, "error");
  assert.equal(s.error.code, "agent-failed");
});

test("gp status --json prints the object alone; gp status prints GP_ lines", async () => {
  let out = "";
  const o = { header: () => (out += "GP_INTERFACE=1\n"), kv: (k, v) => (out += `GP_${k}=${v}\n`), raw: (x) => (out += x), log: () => {}, error: (c, m) => (out += `GP_ERROR=${c}\nGP_ERROR_MESSAGE=${m}\n`) };
  assert.equal(await main(["status", "--json"], o), 0);
  const lines = out.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])), FIELDS);
  out = "";
  assert.equal(await main(["status"], o), 0);
  assert.match(out, /^GP_INTERFACE=1\nGP_VERSION=.*\nGP_STATE=/);
  out = "";
  assert.equal(await main(["status", "--bad"], o), 2);
  assert.match(out, /GP_ERROR=usage/);
});
