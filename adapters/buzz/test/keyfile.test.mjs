// src/keyfile.mjs: the key service's key file, written once and read only by
// its owner. Every key here is generated for the test; the checks look at
// what the file and the output hold, and never print a key.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ADAPTER, identity, tempDir } from "./helpers.mjs";

const KEYFILE = join(ADAPTER, "src", "keyfile.mjs");
const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function folder() {
  const d = tempDir("keyfile");
  dirs.push(d);
  return d;
}

function run(args, input = "") {
  const r = spawnSync(process.execPath, [KEYFILE, ...args], { input, encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

/** Neither output holds the key, as hex or as nsec. */
function noKey(r, key) {
  for (const text of [r.out, r.err]) {
    assert.ok(!text.includes(key.hex), "the hex key is in the output");
    assert.ok(!text.includes(key.nsec), "the nsec key is in the output");
  }
}

test("write: a hex key from stdin becomes a 0400 file, and only the public key is printed", () => {
  const key = identity();
  const path = join(folder(), "buzz-key");
  const r = run(["write", path], `${key.hex}\n`);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${key.pubkey}\n`);
  noKey(r, key);
  assert.equal(readFileSync(path, "utf8"), `${key.hex}\n`);
  assert.equal(statSync(path).mode & 0o777, 0o400);
});

test("write: an nsec key is stored as hex", () => {
  const key = identity();
  const path = join(folder(), "buzz-key");
  const r = run(["write", path], key.nsec);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${key.pubkey}\n`);
  noKey(r, key);
  assert.equal(readFileSync(path, "utf8"), `${key.hex}\n`);
});

// A terminal on stdin: a pseudo-terminal from python3's pty support, where
// python3 is there. The child is cut off after 10 s, so a read that waits on
// the terminal fails the test instead of hanging it.
const PTY = [
  "import os, subprocess, sys",
  "m, s = os.openpty()",
  "try:",
  "    sys.exit(subprocess.run(sys.argv[1:], stdin=s, timeout=10).returncode)",
  "except subprocess.TimeoutExpired:",
  "    sys.exit(124)",
].join("\n");
const hasPython = spawnSync("python3", ["-c", "pass"]).status === 0;

test("write: a terminal on stdin is refused before anything is read", { skip: !hasPython && "no python3" }, () => {
  const path = join(folder(), "buzz-key");
  const r = spawnSync("python3", ["-I", "-c", PTY, process.execPath, KEYFILE, "write", path], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /never from a terminal/);
  assert.equal(existsSync(path), false);
});

test("write: a key file that is there is never replaced", () => {
  const first = identity();
  const second = identity();
  const dir = folder();
  const path = join(dir, "buzz-key");
  assert.equal(run(["write", path], first.hex).code, 0);
  const r = run(["write", path], second.hex);
  assert.equal(r.code, 1);
  assert.match(r.err, /already exists; a key file is never replaced/);
  noKey(r, second);
  assert.equal(readFileSync(path, "utf8"), `${first.hex}\n`);
  assert.deepEqual(readdirSync(dir), ["buzz-key"], "no temporary file is left behind");
});

test("write: a link at the path is not written through", () => {
  const key = identity();
  const dir = folder();
  const target = join(dir, "elsewhere");
  writeFileSync(target, "untouched\n");
  symlinkSync(target, join(dir, "buzz-key"));
  const r = run(["write", join(dir, "buzz-key")], key.hex);
  assert.equal(r.code, 1);
  assert.equal(readFileSync(target, "utf8"), "untouched\n");
});

test("write: a bad key is refused with a fixed message that does not repeat it", () => {
  const path = join(folder(), "buzz-key");
  const bad = "not-a-key-0123456789abcdef";
  const r = run(["write", path], bad);
  assert.equal(r.code, 1);
  assert.ok(!r.err.includes(bad));
  assert.equal(existsSync(path), false);
});

test("generate: a new key file, 0400, and its public key printed", () => {
  const path = join(folder(), "buzz-key");
  const r = run(["generate", path]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^[0-9a-f]{64}\n$/);
  const hex = readFileSync(path, "utf8").trim();
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.ok(!r.out.includes(hex), "the key itself is not printed");
  assert.equal(statSync(path).mode & 0o777, 0o400);
  assert.equal(run(["pubkey", path]).out, r.out, "pubkey reads back the same public key");
});

test("pubkey: refuses a key file its group or others can read, a link and a FIFO", () => {
  const key = identity();
  const dir = folder();
  const path = join(dir, "buzz-key");
  writeFileSync(path, key.hex, { mode: 0o440 });
  chmodSync(path, 0o440);
  let r = run(["pubkey", path]);
  assert.equal(r.code, 1);
  assert.match(r.err, /readable by its owner only/);
  noKey(r, key);
  chmodSync(path, 0o400);
  symlinkSync(path, join(dir, "link"));
  assert.equal(run(["pubkey", join(dir, "link")]).code, 1);
  // A FIFO is refused at once: it is opened without waiting for a writer.
  if (spawnSync("mkfifo", [join(dir, "fifo")]).status === 0) {
    const fifo = run(["pubkey", join(dir, "fifo")]);
    assert.equal(fifo.code, 1);
    assert.match(fifo.err, /not a regular file/);
  }
  assert.equal(run(["pubkey", path]).out, `${key.pubkey}\n`);
});

test("usage: a relative path or an unknown command", () => {
  assert.equal(run(["write", "buzz-key"]).code, 2);
  assert.equal(run(["show", "/x"]).code, 2);
  assert.equal(run([]).code, 2);
});
