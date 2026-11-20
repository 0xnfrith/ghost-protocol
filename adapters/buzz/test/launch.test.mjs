// The launcher's key handling: the key reaches the server's environment and
// nowhere else, a bad key is refused without being repeated, and the key
// command itself is not passed on.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { identity, keyAbsent, LAUNCH, tempDir } from "./helpers.mjs";

const run = (target, env) =>
  spawnSync(process.execPath, [LAUNCH, target], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: "utf8",
    input: "",
  });

/** A stand-in for buzz-mcp that records facts about its environment, never the values. */
function stubServer(dir) {
  const report = join(dir, "report.json");
  const script = join(dir, "stub-buzz-mcp.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
const key = process.env.BUZZ_PRIVATE_KEY ?? "";
writeFileSync(${JSON.stringify(report)}, JSON.stringify({
  keyIsHex64: /^[0-9a-f]{64}$/.test(key),
  hasKeyCommand: "BUZZ_KEY_COMMAND" in process.env,
  relay: process.env.BUZZ_RELAY_URL,
}));
process.exit(7);
`,
  );
  return { script, report };
}

test("buzz-mcp gets the key in its environment, and not the key command", () => {
  const key = identity();
  const dir = tempDir("launch");
  const { script, report } = stubServer(dir);
  const result = run("buzz-mcp", {
    BUZZ_KEY_COMMAND: `printf %s ${key.nsec}`,
    BUZZ_MCP_PATH: script,
    BUZZ_RELAY_URL: "wss://relay.example.com",
  });
  assert.equal(result.status, 7, "the server's exit code is passed through");
  assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), {
    keyIsHex64: true,
    hasKeyCommand: false,
    relay: "wss://relay.example.com",
  });
  assert.ok(keyAbsent(key, [result.stdout, result.stderr]));
});

test("a malformed key is refused with a fixed message that does not repeat it", () => {
  const bad = [
    `nsec1${"q".repeat(58)}`, // right shape, bad checksum
    "ab".repeat(31), // 62 hex characters
    "not a key at all 0123456789abcdef",
  ];
  for (const value of bad) {
    const result = run("channel", { BUZZ_KEY_COMMAND: `printf %s '${value}'`, BUZZ_RELAY_URL: "wss://relay.example.com" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /private key/);
    assert.ok(!result.stderr.includes(value) && !result.stdout.includes(value));
  }
});

test("a failing key command is reported without its output", () => {
  const leaked = "0123456789abcdef".repeat(4);
  const result = run("channel", {
    BUZZ_KEY_COMMAND: `printf %s ${leaked}; echo ${leaked} >&2; exit 3`,
    BUZZ_RELAY_URL: "wss://relay.example.com",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /BUZZ_KEY_COMMAND failed \(exit 3\)/);
  assert.ok(!result.stderr.includes(leaked) && !result.stdout.includes(leaked));
});

test("without a key command or key, the launcher says what to set", () => {
  const result = run("channel", { BUZZ_RELAY_URL: "wss://relay.example.com" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /set BUZZ_KEY_COMMAND/);
});
