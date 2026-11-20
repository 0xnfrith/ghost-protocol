// The channel's log: stderr plus a small owner-only file that rotates and
// never throws.
import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/config.mjs";
import { createLog } from "../src/log.mjs";
import { identity, tempDir } from "./helpers.mjs";

function fakeStderr(queued = 0) {
  const lines = [];
  return { lines, writableLength: queued, write: (s) => lines.push(s) };
}

test("each line goes to stderr and to the file, owner-only, in a folder it creates", (t) => {
  const dir = tempDir("log");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "state", "channel.log");
  const stderr = fakeStderr();
  const log = createLog({ file, stderr });
  log("connected to ws://relay.example.com");
  log("connection closed (code 1006)");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^\d{4}-\d\d-\d\dT[\d:.]+Z buzz-channel: connection closed \(code 1006\)$/);
  assert.deepEqual(stderr.lines.join("").trim().split("\n"), lines);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "state")).mode & 0o777, 0o700);
});

test("past the size limit the file moves to .1 and a new one starts; one old file is kept", (t) => {
  const dir = tempDir("log-rotate");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "channel.log");
  const log = createLog({ file, maxBytes: 300, stderr: fakeStderr() });
  for (let i = 0; i < 20; i++) log(`line ${String(i).padStart(2, "0")} ${"x".repeat(40)}`);
  assert.ok(statSync(file).size <= 300);
  assert.ok(statSync(`${file}.1`).size <= 300);
  assert.ok(!existsSync(`${file}.2`));
  assert.match(readFileSync(file, "utf8"), /line 19/);
  assert.doesNotMatch(readFileSync(`${file}.1`, "utf8") + readFileSync(file, "utf8"), /line 00/);
  // A restart picks up the size of the file already there.
  const again = createLog({ file, maxBytes: 300, stderr: fakeStderr() });
  again(`line 20 ${"x".repeat(40)}`);
  assert.ok(statSync(file).size <= 300);
});

const asRoot = process.getuid?.() === 0;

test("a log file that cannot be written never throws, says so once, and recovers", { skip: asRoot && "root ignores folder permissions" }, (t) => {
  const dir = tempDir("log-fail");
  t.after(() => {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });
  const file = join(dir, "sub", "channel.log");
  const stderr = fakeStderr();
  chmodSync(dir, 0o500); // no new folder can be made here
  const log = createLog({ file, stderr });
  assert.doesNotThrow(() => {
    log("one");
    log("two");
  });
  assert.equal(stderr.lines.filter((l) => l.includes("could not write the log file")).length, 1);
  chmodSync(dir, 0o700);
  log("three");
  assert.match(readFileSync(file, "utf8"), /three/);
});

test("stderr that nobody reads is not queued without bound", () => {
  const stderr = fakeStderr(10 * 1024 * 1024);
  createLog({ stderr })("dropped from stderr");
  assert.equal(stderr.lines.length, 0);
  const broken = { write: () => { throw new Error("EPIPE"); } };
  assert.doesNotThrow(() => createLog({ stderr: broken })("still fine"));
});

test("the log file defaults to channel.log in the state folder; BUZZ_LOG_FILE moves it", () => {
  const secret = identity().secret;
  const base = { BUZZ_RELAY_URL: "wss://relay.example.com", BUZZ_CHANNELS: "*", BUZZ_STATE_DIR: "/srv/buzz/state" };
  const c = loadConfig(base, secret);
  assert.equal(c.logFile, join("/srv/buzz/state", "channel.log"));
  assert.equal(c.connectTimeoutMs, 15_000);
  const plugin = loadConfig({ BUZZ_RELAY_URL: base.BUZZ_RELAY_URL, BUZZ_CHANNELS: "*", CLAUDE_PLUGIN_DATA: "/data" }, secret);
  assert.equal(plugin.logFile, join("/data", "buzz", "state", "channel.log"));
  assert.equal(loadConfig({ ...base, BUZZ_LOG_FILE: "/var/log/buzz.log" }, secret).logFile, "/var/log/buzz.log");
  assert.equal(loadConfig({ ...base, BUZZ_CONNECT_TIMEOUT_MS: "5000" }, secret).connectTimeoutMs, 5000);
});
