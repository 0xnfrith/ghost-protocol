// The key service's two modes, in one user's space, with sockets in a temp
// folder. A small stand-in for systemd plays the key service's part: it
// accepts on a Unix socket (Accept=yes), opens the key file and hands it over
// as a named file descriptor (OpenFile=…:buzz-key, LISTEN_FDNAMES), puts the
// owner's tag in a credentials folder (LoadCredential=buzz-auth-tag), and
// starts `launch.mjs serve <server>` with the connection on stdin and stdout
// (StandardInput=socket), one process per connection, up to MaxConnections.
// By default it hands the key over as systemd 255 to 258 really do there:
// the key alone at descriptor 3 (LISTEN_FDS=1), but with the connection's
// name still first in LISTEN_FDNAMES (connection:buzz-key). These tests hold
// the launcher to:
//   - the pipe (BUZZ_KEY_SOCKET): it holds no key, runs no key command,
//     installs nothing, copies bytes both ways, keeps trying (and sends again
//     what the session sent) while the key service has not answered, and
//     exits when either side closes;
//   - serve: it refuses node options and loader settings, a key in its
//     environment, code that anyone but root can change, a buzz-mcp without a
//     safe file root, and a key file others can read; it takes the key only
//     from the named file descriptor and closes it, sets the key from inside
//     its own process (so /proc/self/environ never shows it), runs the server
//     in that same process, and drops the key from its environment once the
//     server has loaded;
//   - the probe: one real connection, an MCP initialize and its answer, and
//     never the handshake's end, so a probed channel never reaches the relay;
//   - end to end: a session reaches the real channel through the pipe, the
//     channel logs in with the tag from the credential, and a mention
//     arrives; the one-shot send works as `serve send`;
//   - unset or a `${...}` placeholder, BUZZ_KEY_SOCKET changes nothing.
// Every key is made here, at test time, and none is ever printed.
//
// serve trusts only code that nobody but root can change, up to /. These
// tests run without root, so they set the test switch (trust this user's
// files too) and run serve from a copy of the adapter and of node in a
// private folder: one under this user's home, whose folders above are not
// writable by others, as /tmp is.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { bytesToHex } from "nostr-tools/utils";
import { keyFdProblem, namedFd, untrustedCode } from "../src/keyservice.mjs";
import { message, startFakeRelay } from "./fake-relay.mjs";
import { ADAPTER, filesUnder, identity, keyAbsent, LAUNCH, tempDir, waitFor } from "./helpers.mjs";

const agent = identity(); // the key the key service holds
const owner = identity(); // who vouches for it (NIP-OA)
const sender = identity();
const TAG = ["auth", owner.pubkey, "created_at<4294967295", bytesToHex(randomBytes(64))];
const sha = (s) => createHash("sha256").update(s).digest("hex");
const LINUX = process.platform === "linux";
const BASE_ENV = { PATH: process.env.PATH };

const ME = process.getuid();
const AS_ROOT = ME === 0;

// The private folder, and in it a copy of node and of the adapter (with its
// dependencies), which is what serve runs. Node is copied, never hard-linked:
// a link shares the original file's permissions, and a CI tool cache's node
// may be writable by its group or by others.
const PRIVATE = mkdtempSync(join(homedir(), ".gp-keyservice-test-"));
chmodSync(PRIVATE, 0o700);
{
  const why = untrustedCode([PRIVATE], new Set([0, ME]));
  if (why) throw new Error(`the private test folder is not private: ${why}`);
}
const privateDir = (label) => mkdtempSync(join(PRIVATE, `${label}-`));
const SERVE_NODE = join(PRIVATE, "node");
copyFileSync(realpathSync(process.execPath), SERVE_NODE);
chmodSync(SERVE_NODE, 0o755);
const SERVE_ADAPTER = join(PRIVATE, "adapter");
for (const part of ["src", "package.json", "buzz-mcp.pin", "node_modules"]) {
  cpSync(join(ADAPTER, part), join(SERVE_ADAPTER, part), { recursive: true, verbatimSymlinks: true });
}
const SERVE_LAUNCH = join(SERVE_ADAPTER, "src", "launch.mjs");
const SERVE_ENV = { ...BASE_ENV, GP_TEST_SERVE_TRUST_OWN_UID: "1" };
/** An environment without the entries set to undefined (a way to leave one out). */
const envOf = (...parts) => Object.fromEntries(Object.entries(Object.assign({}, ...parts)).filter(([, v]) => v !== undefined));

let relay;
const cleanups = [];
const leakTexts = [];
const leakDirs = [];
before(async () => {
  relay = await startFakeRelay();
});
after(async () => {
  for (const c of cleanups.reverse()) await c();
  await relay.close();
  for (const dir of leakDirs) for (const f of filesUnder(dir)) leakTexts.push(f.text);
  rmSync(PRIVATE, { recursive: true, force: true });
  assert.ok(leakTexts.length > 0);
  assert.ok(keyAbsent(agent, leakTexts), "the private key leaked into output, a log or a file");
});

/**
 * A private folder for one key service: its own files (state, log, stubs, the
 * outbox that is buzz-mcp's file root), which the leak check reads, and a
 * credentials folder holding the owner's tag. The key file (0600) is kept in
 * a folder of its own, outside what the check reads.
 */
function keyHome(label, { keyText = `${agent.hex}\n`, tag = JSON.stringify(TAG) } = {}) {
  const dir = privateDir(label);
  leakDirs.push(dir);
  const keyFile = join(privateDir(`${label}-key`), "buzz-key");
  writeFileSync(keyFile, keyText, { mode: 0o600 });
  const creds = join(dir, "credentials");
  mkdirSync(creds, { mode: 0o700 });
  if (tag !== undefined) writeFileSync(join(creds, "buzz-auth-tag"), `${tag}\n`, { mode: 0o600 });
  const outbox = join(dir, "outbox");
  mkdirSync(outbox, { mode: 0o700 });
  return { dir, keyFile, creds, outbox };
}

/**
 * A stand-in for buzz-mcp that reports facts about its own process as one
 * JSON line on stdout (counts and booleans, a hash of the key, never the
 * key), then, one tick later, whether the key has left its environment. It
 * answers each chunk it reads with "echo:<chunk>" and keeps running, as a
 * server with open connections to a relay would.
 */
function stubServer(dir, keyFile) {
  const script = join(dir, "stub-buzz-mcp.mjs");
  writeFileSync(
    script,
    `import { createHash } from "node:crypto";
import { fstatSync, readFileSync, statSync } from "node:fs";
const key = process.env.BUZZ_PRIVATE_KEY ?? "";
let environ = null;
try { environ = readFileSync("/proc/self/environ", "latin1"); } catch {}
const kf = statSync(${JSON.stringify(keyFile)});
let keyFdsOpen = 0;
for (let fd = 0; fd < 256; fd++) {
  try { const st = fstatSync(fd); if (st.ino === kf.ino && st.dev === kf.dev) keyFdsOpen++; } catch {}
}
const report = {
  keySha: createHash("sha256").update(key).digest("hex"),
  environKeyNames: environ === null ? null : environ.split("\\0").filter((e) => e.startsWith("BUZZ_PRIVATE_KEY=")).length,
  environKeyHits: environ === null ? null : (key ? environ.split(key).length - 1 : -1),
  keyFdsOpen,
  listenVars: ["LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES"].filter((n) => n in process.env).length,
  authTag: process.env.BUZZ_AUTH_TAG ?? null,
  mcpRoot: process.env.BUZZ_MCP_ROOT ?? null,
  argv1: process.argv[1],
  args: process.argv.slice(2),
  pid: process.pid,
};
process.stdout.write(JSON.stringify(report) + "\\n");
setImmediate(() => process.stdout.write(JSON.stringify({ keyGone: !("BUZZ_PRIVATE_KEY" in process.env) }) + "\\n"));
process.stdin.on("data", (chunk) => process.stdout.write("echo:" + chunk));
setInterval(() => {}, 1000);
`,
  );
  return script;
}

const SD_WRAP = 'export LISTEN_PID=$$; exec "$0" "$@"'; // systemd sets LISTEN_PID to the server's own pid

/**
 * How the stand-in hands over the key, beside the connection on stdin and
 * stdout (StandardInput=socket, with Accept=yes and OpenFile=…:buzz-key):
 *   - "systemd-255" (the default): what systemd 255 to 258 do. Only the key
 *     is passed, at descriptor 3 (LISTEN_FDS=1), but LISTEN_FDNAMES still
 *     names the connection first: connection:buzz-key. Seen on 255.4.
 *   - "systemd-259": the same with the connection's name dropped
 *     (LISTEN_FDNAMES=buzz-key), as systemd 259 and later do.
 *   - "listed": the connection passed again as descriptor 3 and the key as 4
 *     (LISTEN_FDS=2, connection:buzz-key), one name for each descriptor.
 */
const LAYOUTS = {
  "systemd-255": { connectionFd: false, names: "connection:buzz-key" },
  "systemd-259": { connectionFd: false, names: "buzz-key" },
  listed: { connectionFd: true, names: "connection:buzz-key" },
};

/** The stand-in for systemd's socket units; `layout` is one of LAYOUTS. */
async function keyService({ target, home, env = {}, maxConnections = 8, dropFirst = 0, layout = "systemd-255" }) {
  const how = LAYOUTS[layout];
  assert.ok(how, `no layout ${layout}`);
  const dir = tempDir("socket");
  const path = join(dir, `${target}.sock`);
  const children = new Set();
  const errs = [];
  let dropped = 0;
  const server = createServer({ pauseOnConnect: true }, (conn) => {
    if (dropped < dropFirst || children.size >= maxConnections) {
      dropped += 1;
      conn.destroy(); // what systemd does past MaxConnections=
      return;
    }
    const keyFd = openSync(home.keyFile, "r");
    const stdio = how.connectionFd ? [conn, conn, "pipe", conn, keyFd] : [conn, conn, "pipe", keyFd];
    // Its own process group, so close() stops whatever it started too, as
    // systemd stops a unit's whole control group.
    const child = spawn("/bin/sh", ["-c", SD_WRAP, SERVE_NODE, SERVE_LAUNCH, "serve", target], {
      stdio,
      detached: true,
      env: envOf(SERVE_ENV, {
        LISTEN_FDS: String(stdio.length - 3),
        LISTEN_FDNAMES: how.names,
        CREDENTIALS_DIRECTORY: home.creds,
        BUZZ_MCP_ROOT: home.outbox,
      }, env),
    });
    closeSync(keyFd);
    conn.destroy();
    children.add(child);
    const chunks = [];
    child.stderr.on("data", (c) => chunks.push(c));
    errs.push(() => Buffer.concat(chunks).toString("utf8"));
    child.on("exit", () => children.delete(child));
  });
  await new Promise((resolve) => server.listen(path, resolve));
  const ks = {
    dir,
    path,
    children,
    dropped: () => dropped,
    stderr: () => errs.map((f) => f()).join(""),
    close: async () => {
      for (const c of children) {
        try {
          process.kill(-c.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      await new Promise((resolve) => server.close(resolve));
      leakTexts.push(ks.stderr());
    },
  };
  cleanups.push(ks.close);
  return ks;
}

/** A plain Unix socket server: answers "echo:<chunk>", after dropping the first `dropFirst` connections unanswered. */
async function echoServer({ dropFirst = 0, closeAfterFirst = false } = {}) {
  const dir = tempDir("echo");
  const path = join(dir, "buzz-mcp.sock");
  let connections = 0;
  const received = [];
  const server = createServer((conn) => {
    connections += 1;
    if (connections <= dropFirst) {
      conn.destroy();
      return;
    }
    conn.on("data", (chunk) => {
      received.push(chunk.toString("utf8"));
      conn.write(`echo:${chunk}`);
      if (closeAfterFirst) conn.end();
    });
    conn.on("end", () => received.push("<end>"));
  });
  await new Promise((resolve) => server.listen(path, resolve));
  const es = { dir, path, received, connections: () => connections, close: () => new Promise((r) => server.close(r)) };
  cleanups.push(es.close);
  return es;
}

/** Runs the launcher as Claude Code would start it, with pipes for stdio. */
function startLauncher(args, env, launch = LAUNCH) {
  const child = spawn(process.execPath, [launch, ...args], { env: { ...BASE_ENV, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const out = [];
  const err = [];
  child.stdout.on("data", (c) => out.push(c));
  child.stderr.on("data", (c) => err.push(c));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const run = {
    child,
    exited,
    out: () => Buffer.concat(out).toString("utf8"),
    err: () => Buffer.concat(err).toString("utf8"),
  };
  cleanups.push(async () => {
    child.kill("SIGKILL");
    leakTexts.push(run.out(), run.err());
  });
  return run;
}

const firstLine = (text) => JSON.parse(text.split("\n")[0]);

// ---------------------------------------------------------------- the pipe

test("pipe: bytes go both ways, and the end of the session's input ends the pipe (exit 0)", async () => {
  const es = await echoServer();
  const run = startLauncher(["buzz-mcp"], { BUZZ_KEY_SOCKET: es.dir });
  run.child.stdin.write("ping\n");
  await waitFor(() => run.out() === "echo:ping\n", { what: "the answer through the pipe" });
  run.child.stdin.end();
  assert.equal(await run.exited, 0);
  await waitFor(() => es.received.includes("<end>"), { what: "the far end to see the end" });
});

test("pipe: when the key service closes after answering, the pipe exits 1 and says so", async () => {
  const es = await echoServer({ closeAfterFirst: true });
  const run = startLauncher(["buzz-mcp"], { BUZZ_KEY_SOCKET: es.dir });
  run.child.stdin.write("ping\n");
  assert.equal(await run.exited, 1);
  assert.equal(run.out(), "echo:ping\n");
  assert.match(run.err(), /the key service closed the connection/);
});

test("pipe: connections dropped before the first byte are retried, and what the session sent goes again", async () => {
  const es = await echoServer({ dropFirst: 3 });
  const run = startLauncher(["buzz-mcp"], { BUZZ_KEY_SOCKET: es.dir });
  run.child.stdin.write("initialize\n");
  await waitFor(() => run.out() === "echo:initialize\n", { what: "the replayed message's answer", timeout: 8000 });
  assert.equal(es.connections(), 4);
  assert.deepEqual(es.received, ["initialize\n"]);
  run.child.stdin.end();
  assert.equal(await run.exited, 0);
});

test("pipe: megabytes sent before the first byte survive a dropped connection, without stalling", async () => {
  const SIZE = 3 * 1024 * 1024;
  const dir = tempDir("bulk");
  let connections = 0;
  const server = createServer((conn) => {
    connections += 1;
    if (connections === 1) {
      conn.destroy(); // the first connection is dropped, as a restarting key service would
      return;
    }
    let got = 0;
    conn.on("data", (chunk) => {
      got += chunk.length;
      if (got === SIZE) conn.write(`got:${got}\n`);
    });
  });
  await new Promise((resolve) => server.listen(join(dir, "buzz-mcp.sock"), resolve));
  cleanups.push(() => new Promise((r) => server.close(r)));
  const run = startLauncher(["buzz-mcp"], { BUZZ_KEY_SOCKET: dir });
  run.child.stdin.write(Buffer.alloc(SIZE, 0x61));
  await waitFor(() => run.out() === `got:${SIZE}\n`, { what: "every byte on the second connection", timeout: 10_000 });
  assert.ok(connections >= 2);
  run.child.stdin.end();
  assert.equal(await run.exited, 0);
});

test("pipe: a key service that never answers ends the pipe after the wait (exit 1)", async () => {
  const dir = tempDir("nosocket"); // no socket in it at all
  const started = Date.now();
  const run = startLauncher(["channel"], { BUZZ_KEY_SOCKET: dir, BUZZ_KEY_SOCKET_WAIT_MS: "1500" });
  run.child.stdin.write("initialize\n");
  assert.equal(await run.exited, 1);
  const took = Date.now() - started;
  assert.ok(took >= 1300 && took < 6000, `gave up after ${took} ms`);
  assert.match(run.err(), /did not answer within 1500 ms \(ENOENT\)/);
});

test("pipe: a socket this user may not open fails at once, without retrying", async () => {
  const es = await echoServer();
  chmodSync(es.path, 0o000);
  if (spawnSync("id", ["-u"], { encoding: "utf8" }).stdout.trim() === "0") return; // root opens anything
  const started = Date.now();
  const run = startLauncher(["buzz-mcp"], { BUZZ_KEY_SOCKET: es.dir, BUZZ_KEY_SOCKET_WAIT_MS: "5000" });
  assert.equal(await run.exited, 1);
  assert.ok(Date.now() - started < 3000);
  assert.match(run.err(), /EACCES/);
});

test("pipe: no key command runs, and a key or key command on this side is refused", async () => {
  const es = await echoServer();
  const dir = tempDir("marker");
  leakDirs.push(dir);
  const marker = join(dir, "key-command-ran");
  for (const env of [
    { BUZZ_KEY_COMMAND: `touch ${marker}; printf %s ${agent.hex}` },
    { BUZZ_PRIVATE_KEY: agent.hex },
    { BUZZ_PRIVATE_KEY: "" },
  ]) {
    const run = startLauncher(["buzz-mcp"], { BUZZ_KEY_SOCKET: es.dir, ...env });
    run.child.stdin.end();
    assert.equal(await run.exited, 2, Object.keys(env).join());
    assert.match(run.err(), /this side must hold no key/);
  }
  assert.ok(!existsSync(marker), "the key command ran");
  assert.equal(es.connections(), 0);
});

test("pipe: the one-shot send and a relative socket folder are refused", async () => {
  const es = await echoServer();
  let run = startLauncher(["send", "--channel", "c"], { BUZZ_KEY_SOCKET: es.dir });
  run.child.stdin.end();
  assert.equal(await run.exited, 2);
  assert.match(run.err(), /the one-shot send has no socket/);
  run = startLauncher(["channel"], { BUZZ_KEY_SOCKET: "relative/folder" });
  run.child.stdin.end();
  assert.equal(await run.exited, 2);
  assert.match(run.err(), /must be the absolute path/);
});

test("pipe: it works from a copy of the adapter that has no dependencies, and installs none", async () => {
  const es = await echoServer();
  const copy = tempDir("nodeps");
  cpSync(join(ADAPTER, "src"), join(copy, "src"), { recursive: true });
  cpSync(join(ADAPTER, "package.json"), join(copy, "package.json"));
  cpSync(join(ADAPTER, "package-lock.json"), join(copy, "package-lock.json"));
  const run = startLauncher(["buzz-mcp"], { BUZZ_KEY_SOCKET: es.dir }, join(copy, "src", "launch.mjs"));
  run.child.stdin.write("ping\n");
  await waitFor(() => run.out() === "echo:ping\n", { what: "the answer" });
  run.child.stdin.end();
  assert.equal(await run.exited, 0);
  assert.ok(!existsSync(join(copy, "node_modules")) && !existsSync(join(copy, ".install-lock")));
});

test("pipe: a key service that fails every connection is tried a few times, each wait twice the last, not every 200 ms", async () => {
  const es = await echoServer({ dropFirst: 1000 });
  const started = Date.now();
  const run = startLauncher(["buzz-mcp"], { BUZZ_KEY_SOCKET: es.dir, BUZZ_KEY_SOCKET_WAIT_MS: "3000" });
  run.child.stdin.write("initialize\n");
  assert.equal(await run.exited, 1);
  const took = Date.now() - started;
  // Tries at 0, 0.1, 0.3, 0.7 and 1.5 s, then one last one at the 3 s
  // deadline: 6 in all. A fixed 200 ms would make 15.
  const n = es.connections();
  assert.ok(n >= 5 && n <= 7, `${n} connections in 3 s`);
  assert.ok(took >= 2700 && took < 8000, `gave up after ${took} ms, not at the deadline`);
  assert.match(run.err(), /did not answer within 3000 ms/);
});

test("pipe: the plugin's empty key command is not in the pipe's environment, and the pipe keeps its process and stdio", { skip: !LINUX && "reads /proc" }, async () => {
  for (const value of ["", "${user_config.buzz_key_command}", "  "]) {
    const es = await echoServer();
    const run = startLauncher(["buzz-mcp"], { BUZZ_KEY_SOCKET: es.dir, BUZZ_KEY_COMMAND: value });
    run.child.stdin.write("ping\n");
    await waitFor(() => run.out() === "echo:ping\n", { what: "the answer through the pipe" });
    // The process Claude Code started, as the kernel shows it to others: by name only.
    const names = readFileSync(`/proc/${run.child.pid}/environ`, "latin1")
      .split("\0")
      .map((entry) => entry.split("=")[0]);
    assert.equal(names.filter((n) => n === "BUZZ_KEY_COMMAND").length, 0, `BUZZ_KEY_COMMAND=${JSON.stringify(value)} is still in the pipe's environment`);
    assert.ok(names.includes("BUZZ_KEY_SOCKET"), "the rest of the environment is kept");
    run.child.stdin.end();
    assert.equal(await run.exited, 0);
    assert.doesNotMatch(run.err(), /process\.execve|going on with it/);
  }
});

test("pipe: a node it cannot run again is seen first: the pipe goes on with the empty key command, and says so (a failed execve would abort it)", async () => {
  const es = await echoServer();
  const dir = tempDir("no-reexec");
  const preload = join(dir, "moved-node.mjs");
  writeFileSync(preload, `process.execPath = ${JSON.stringify(join(dir, "no-such-node"))};\n`);
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, LAUNCH, "buzz-mcp"], {
    env: { ...BASE_ENV, BUZZ_KEY_SOCKET: es.dir, BUZZ_KEY_COMMAND: "" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const out = [];
  const err = [];
  child.stdout.on("data", (c) => out.push(c));
  child.stderr.on("data", (c) => err.push(c));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal ?? code)));
  cleanups.push(async () => child.kill("SIGKILL"));
  child.stdin.write("ping\n");
  await waitFor(() => Buffer.concat(out).toString() === "echo:ping\n", { what: "the answer through the pipe" });
  child.stdin.end();
  assert.equal(await exited, 0, "the pipe ended normally, not by an abort");
  assert.match(Buffer.concat(err).toString(), /cannot run .*no-such-node again \(ENOENT\), so the empty BUZZ_KEY_COMMAND stays/);
});

test("BUZZ_KEY_SOCKET unset, empty or a placeholder: the launcher works as before", () => {
  const dir = tempDir("compat");
  const report = join(dir, "report.json");
  const script = join(dir, "stub.mjs");
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(report)}, JSON.stringify({ keyIsHex64: /^[0-9a-f]{64}$/.test(process.env.BUZZ_PRIVATE_KEY ?? "") }));
process.exit(7);
`,
  );
  for (const socket of [undefined, "", "${user_config.buzz_key_socket}"]) {
    const result = spawnSync(process.execPath, [LAUNCH, "buzz-mcp"], {
      env: {
        ...BASE_ENV,
        HOME: process.env.HOME,
        BUZZ_KEY_COMMAND: `printf %s ${agent.nsec}`,
        BUZZ_MCP_PATH: script,
        ...(socket === undefined ? {} : { BUZZ_KEY_SOCKET: socket }),
      },
      encoding: "utf8",
      input: "",
    });
    assert.equal(result.status, 7, String(socket));
    assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { keyIsHex64: true });
    assert.ok(keyAbsent(agent, [result.stdout, result.stderr]));
  }
});

// ---------------------------------------------------------------- serve

/**
 * Runs `launch.mjs serve …` once, the way systemd would start it, and waits
 * for it. The key comes the way systemd 259 hands it over ("plain":
 * LISTEN_FDNAMES=buzz-key), or "listed" (LISTEN_FDS=2, connection:buzz-key).
 * Its stdin is Node's "pipe", which is a socket pair, or `stdin` ("ignore":
 * /dev/null). `keyFd` "pipe" hands over a pipe instead of the key file;
 * `node` and `nodeArgs` change how node is started.
 */
function serveOnce(
  target,
  { home, env = {}, args = [], input = "", layout = "plain", wrap = true, keyFd: keyKind = "file", node = SERVE_NODE, nodeArgs = [], launch = SERVE_LAUNCH, stdin = "pipe" } = {},
) {
  const keyFd = keyKind === "file" ? openSync(home.keyFile, "r") : "pipe";
  const stdio = layout === "listed" ? [stdin, "pipe", "pipe", "pipe", keyFd] : [stdin, "pipe", "pipe", keyFd];
  const argv = [node, ...nodeArgs, launch, "serve", target, ...args];
  try {
    return spawnSync(wrap ? "/bin/sh" : argv[0], wrap ? ["-c", SD_WRAP, ...argv] : argv.slice(1), {
      stdio,
      input,
      encoding: "utf8",
      timeout: 20_000,
      env: envOf(
        SERVE_ENV,
        {
          LISTEN_FDS: String(stdio.length - 3),
          LISTEN_FDNAMES: layout === "listed" ? "connection:buzz-key" : "buzz-key",
          CREDENTIALS_DIRECTORY: home.creds,
          BUZZ_MCP_ROOT: home.outbox,
        },
        env,
      ),
    });
  } finally {
    if (typeof keyFd === "number") closeSync(keyFd);
  }
}

const lines = (text) => text.split("\n").filter(Boolean);

test("serve: the key comes from the named file descriptor, is set from inside, and the server runs in the same process", async () => {
  for (const layout of Object.keys(LAYOUTS)) {
    const home = keyHome(`serve-${layout}`);
    const stub = stubServer(home.dir, home.keyFile);
    const ks = await keyService({ target: "buzz-mcp", home, layout, env: { BUZZ_MCP_PATH: stub } });
    const run = startLauncher(["buzz-mcp"], { BUZZ_KEY_SOCKET: ks.dir });
    await waitFor(() => lines(run.out()).length >= 2, { what: "the server's report" });
    const [r, later] = lines(run.out()).map((l) => JSON.parse(l));
    const [child] = ks.children;
    assert.equal(r.keySha, sha(agent.hex), `${layout}: the server has the key (as hex)`);
    assert.equal(r.pid, child.pid, `${layout}: the server runs in the process systemd started, not a child`);
    assert.equal(r.argv1, stub);
    assert.equal(r.keyFdsOpen, 0, `${layout}: no file descriptor still refers to the key file`);
    assert.equal(r.listenVars, 0);
    assert.equal(r.authTag, JSON.stringify(TAG), `${layout}: the owner's tag comes from the credential`);
    if (LINUX) {
      assert.equal(r.environKeyNames, 0, `${layout}: BUZZ_PRIVATE_KEY is not in /proc/self/environ`);
      assert.equal(r.environKeyHits, 0, `${layout}: the key is nowhere in /proc/self/environ`);
    }
    assert.equal(later.keyGone, true, `${layout}: one tick after the server loaded, the key has left process.env`);
    // A chunk through the pipe reaches the server and comes back.
    run.child.stdin.write("ping\n");
    await waitFor(() => run.out().endsWith("echo:ping\n"), { what: "the echo" });
    // The session ends: the pipe exits, and buzz-mcp with it, though it still had work open.
    run.child.stdin.end();
    assert.equal(await run.exited, 0);
    await waitFor(() => ks.children.size === 0, { what: "buzz-mcp to exit with its connection" });
    assert.ok(keyAbsent(agent, [run.out(), run.err(), ks.stderr()]));
  }
});

test("serve: one connection at a time (MaxConnections=1); a session that restarts gets through once the old server is gone", async () => {
  const home = keyHome("serve-race");
  const stub = stubServer(home.dir, home.keyFile);
  const ks = await keyService({ target: "buzz-mcp", home, maxConnections: 1, env: { BUZZ_MCP_PATH: stub } });
  const first = startLauncher(["buzz-mcp"], { BUZZ_KEY_SOCKET: ks.dir });
  await waitFor(() => first.out().includes("\n"), { what: "the first server" });
  const second = startLauncher(["buzz-mcp"], { BUZZ_KEY_SOCKET: ks.dir });
  second.child.stdin.write("hello\n");
  await waitFor(() => ks.dropped() >= 2, { what: "the second connection to be refused" });
  assert.equal(second.out(), "");
  first.child.stdin.end(); // the old session ends
  assert.equal(await first.exited, 0);
  await waitFor(() => second.out().includes("echo:hello\n"), { what: "the second session's server", timeout: 8000 });
  assert.equal(firstLine(second.out()).keySha, sha(agent.hex));
  second.child.stdin.end();
  assert.equal(await second.exited, 0);
});

test("serve: node options and loader settings are refused before the key is read", () => {
  const home = keyHome("serve-loader");
  const stub = stubServer(home.dir, home.keyFile);
  // A preload that would see the key if serve went on: it records whether
  // BUZZ_PRIVATE_KEY ever appeared, and may also try to hide itself.
  const preload = join(home.dir, "preload.mjs");
  const marker = join(home.dir, "preload-saw");
  writeFileSync(
    preload,
    `import { writeFileSync } from "node:fs";
let saw = false;
const look = () => { if (process.env.BUZZ_PRIVATE_KEY) saw = true; };
setInterval(look, 1).unref();
process.on("exit", () => { look(); writeFileSync(${JSON.stringify(marker)}, saw ? "saw" : "none"); });
if (process.env.PRELOAD_HIDE === "1") delete process.env.NODE_OPTIONS;
`,
  );
  const url = pathToFileURL(preload).href;
  const cases = [
    [{ env: { NODE_OPTIONS: `--import=${url}` } }, /serve: NODE_OPTIONS is set/],
    [{ nodeArgs: ["--import", url] }, /serve: node was started with options/],
    [{ env: { NODE_PATH: join(home.dir, "nowhere") } }, /serve: NODE_PATH is set/],
    [{ env: { NODE_REPL_EXTERNAL_MODULE: "x" } }, /serve: NODE_REPL_EXTERNAL_MODULE is set/],
    [{ env: { LD_PRELOAD: "" } }, /serve: LD_PRELOAD is set/],
    [{ env: { LD_LIBRARY_PATH: join(home.dir, "nowhere") } }, /serve: LD_LIBRARY_PATH is set/],
    [{ env: { LD_AUDIT: "" } }, /serve: LD_AUDIT is set/],
    [{ env: { NODE_COMPILE_CACHE: join(home.dir, "compile-cache") } }, /serve: NODE_COMPILE_CACHE is set/],
    [{ env: { OPENSSL_CONF: join(home.dir, "nowhere.cnf") } }, /serve: OPENSSL_CONF is set/],
    [{ env: { OPENSSL_MODULES: join(home.dir, "nowhere") } }, /serve: OPENSSL_MODULES is set/],
    [{ env: { OPENSSL_ENGINES: join(home.dir, "nowhere") } }, /serve: OPENSSL_ENGINES is set/],
  ];
  // On Linux, a preload that deletes NODE_OPTIONS from process.env is still caught.
  if (LINUX) cases.push([{ env: { NODE_OPTIONS: `--import=${url}`, PRELOAD_HIDE: "1" } }, /serve: NODE_OPTIONS is set/]);
  for (const [opts, why] of cases) {
    rmSync(marker, { force: true });
    const r = serveOnce("buzz-mcp", { home, ...opts, env: { BUZZ_MCP_PATH: stub, ...opts.env } });
    assert.equal(r.status, 2, String(why));
    assert.match(r.stderr, why);
    assert.equal(r.stdout, "", "the server never started");
    if (existsSync(marker)) assert.equal(readFileSync(marker, "utf8"), "none", "the preload never saw the key");
  }
  // The one option a key unit passes is allowed.
  const r = serveOnce("buzz-mcp", { home, nodeArgs: ["--disable-sigusr1"], env: { BUZZ_MCP_PATH: stub } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(firstLine(r.stdout).keySha, sha(agent.hex));
});

test("serve: buzz-mcp needs a file root of its own (BUZZ_MCP_ROOT)", () => {
  const home = keyHome("serve-mcproot");
  const stub = stubServer(home.dir, home.keyFile);
  const cases = [
    [{ BUZZ_MCP_ROOT: undefined }, /set BUZZ_MCP_ROOT/],
    [{ BUZZ_MCP_ROOT: "outbox" }, /BUZZ_MCP_ROOT must be an absolute path/],
    [{ BUZZ_MCP_ROOT: join(home.dir, "nowhere") }, /BUZZ_MCP_ROOT does not exist/],
    [{ BUZZ_MCP_ROOT: "/" }, /BUZZ_MCP_ROOT must not be \//],
    [{ BUZZ_MCP_ROOT: stub }, /BUZZ_MCP_ROOT must be a folder/],
    [{ BUZZ_MCP_ROOT: home.dir }, /must not hold the key service's state or credentials folders/], // holds credentials/
    [{ BUZZ_STATE_DIR: join(home.outbox, "state") }, /must not hold the key service's state or credentials folders/],
    [{ STATE_DIRECTORY: `${join(home.dir, "elsewhere")}:${home.outbox}` }, /must not hold the key service's state or credentials folders/],
  ];
  for (const [env, why] of cases) {
    const r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub, ...env } });
    assert.equal(r.status, 2, JSON.stringify(env));
    assert.match(r.stderr, why);
    assert.equal(r.stdout, "");
  }
  // A root the session's user could write to (here: writable by its group or
  // by others, or under a folder that is) is refused: a link planted there
  // could win buzz-mcp's realpath-then-open race.
  const writableRoot = (mode, parentMode = 0o700) => {
    const parent = privateDir("root-parent");
    chmodSync(parent, parentMode);
    const root = join(parent, "root");
    mkdirSync(root);
    chmodSync(root, mode);
    return { parent, root };
  };
  for (const [mode, parentMode, what] of [
    [0o777, 0o700, "the root, by everyone"],
    [0o770, 0o700, "the root, by its group"],
    [0o1777, 0o700, "the root, sticky and by everyone"],
    [0o700, 0o777, "a folder above the root"],
  ]) {
    const { parent, root } = writableRoot(mode, parentMode);
    const r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub, BUZZ_MCP_ROOT: root } });
    chmodSync(parent, 0o700);
    assert.equal(r.status, 2, what);
    assert.match(r.stderr, /BUZZ_MCP_ROOT must be a folder only root or the key's user can change: .* can be written by its group or by others/, what);
    assert.equal(r.stdout, "", what);
  }
  // A folder of root's is refused, however safe it looks: the root is the
  // key's user's own.
  if (!AS_ROOT) {
    for (const rootOwned of ["/proc", "/etc", "/run"]) {
      const r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub, BUZZ_MCP_ROOT: rootOwned } });
      assert.equal(r.status, 2, rootOwned);
      assert.match(r.stderr, /BUZZ_MCP_ROOT must be a folder owned by the key's user/, rootOwned);
      assert.equal(r.stdout, "", rootOwned);
    }
  }
  // A link to a good root is followed, and buzz-mcp gets the resolved path.
  const linkDir = privateDir("root-link");
  symlinkSync(home.outbox, join(linkDir, "root"));
  const r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub, BUZZ_MCP_ROOT: join(linkDir, "root") } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(firstLine(r.stdout).mcpRoot, realpathSync(home.outbox));
});

test("serve: the key's file descriptor must be a regular file, readable by its owner only", () => {
  const home = keyHome("serve-keyfd");
  const stub = stubServer(home.dir, home.keyFile);
  chmodSync(home.keyFile, 0o640);
  let r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the key file has permissions for its group or for others/);
  chmodSync(home.keyFile, 0o600);
  r = serveOnce("buzz-mcp", { home, keyFd: "pipe", env: { BUZZ_MCP_PATH: stub } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /the key's file descriptor is not a regular file/);
  assert.equal(r.stdout, "");
  // Its owner must be trusted: root, or (in these tests) this user.
  const fd = openSync(home.keyFile, "r");
  try {
    assert.equal(keyFdProblem(fd, new Set([0, ME])), null);
    if (!AS_ROOT) assert.match(keyFdProblem(fd, new Set([0])), /the key file is owned by uid/);
  } finally {
    closeSync(fd);
  }
});

test("serve: without the test switch, only code that root owns is trusted", { skip: AS_ROOT && "running as root" }, () => {
  const home = keyHome("serve-rootonly");
  const stub = stubServer(home.dir, home.keyFile);
  for (const value of [undefined, "yes", "0"]) {
    const r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub, GP_TEST_SERVE_TRUST_OWN_UID: value } });
    assert.equal(r.status, 2, String(value));
    assert.match(r.stderr, new RegExp(`refusing to run code that a user other than root can change: .* is owned by uid ${ME}`));
    assert.doesNotMatch(r.stderr, /test mode/);
    assert.equal(r.stdout, "");
  }
  // Under systemd (INVOCATION_ID set) the switch is ignored, and says so.
  const unit = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub, INVOCATION_ID: "0123456789abcdef0123456789abcdef" } });
  assert.equal(unit.status, 2);
  assert.match(unit.stderr, /serve: GP_TEST_SERVE_TRUST_OWN_UID is ignored under systemd \(INVOCATION_ID is set\)/);
  assert.match(unit.stderr, new RegExp(`refusing to run code that a user other than root can change: .* is owned by uid ${ME}`));
  assert.doesNotMatch(unit.stderr, /test mode/);
  assert.equal(unit.stdout, "");
  const r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /test mode \(GP_TEST_SERVE_TRUST_OWN_UID=1\)/);
});

test("serve: a key in its environment is refused before anything is read", () => {
  const home = keyHome("serve-env");
  const stub = stubServer(home.dir, home.keyFile);
  for (const env of [{ BUZZ_KEY_COMMAND: "true" }, { BUZZ_KEY_COMMAND: "" }, { BUZZ_PRIVATE_KEY: agent.hex }, { BUZZ_PRIVATE_KEY: "" }]) {
    const name = Object.keys(env)[0];
    const r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub, ...env } });
    assert.equal(r.status, 2, name);
    assert.match(r.stderr, new RegExp(`serve: ${name} is set`));
    assert.equal(r.stdout, "", "the server never started");
    assert.ok(keyAbsent(agent, [r.stdout, r.stderr]));
  }
});

test("serve: without the named file descriptor, or with a LISTEN_PID that is not its own, nothing starts", () => {
  const home = keyHome("serve-fd");
  const stub = stubServer(home.dir, home.keyFile);
  const cases = [
    [{ LISTEN_FDS: "" }, /no file descriptors were handed over/],
    [{ LISTEN_FDNAMES: "connection" }, /must name exactly one file descriptor buzz-key/],
    [{ LISTEN_FDNAMES: "buzz-key:buzz-key", LISTEN_FDS: "2" }, /must name exactly one file descriptor buzz-key/],
    [{ LISTEN_FDNAMES: "buzz-key:other" }, /LISTEN_FDNAMES names 2 file descriptor\(s\), but LISTEN_FDS is 1/],
    // systemd 255's left-over connection name is taken only while stdin is
    // a socket (StandardInput=socket); here stdin is /dev/null.
    [{ LISTEN_FDNAMES: "connection:buzz-key" }, /LISTEN_FDNAMES names 2 file descriptor\(s\), but LISTEN_FDS is 1/, "ignore"],
  ];
  for (const [env, why, stdin] of cases) {
    const r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub, ...env }, stdin });
    assert.equal(r.status, 2, JSON.stringify(env));
    assert.match(r.stderr, why);
    assert.equal(r.stdout, "");
  }
  // Without the wrapper, LISTEN_PID is missing: the descriptors are not this process's.
  const r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub }, wrap: false });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /LISTEN_PID does not name this process/);
});

test("namedFd: the lists systemd hands over are taken, and every other list is refused", () => {
  const pid = 4242;
  const env = (fds, names) => ({ LISTEN_FDS: String(fds), LISTEN_PID: String(pid), LISTEN_FDNAMES: names });
  const taken = [
    // systemd 255 to 258 (Accept=yes, StandardInput=socket, OpenFile=): the
    // connection is on stdin and not passed, but its name is still first.
    [env(1, "connection:buzz-key"), true, 3],
    // systemd 259 and later: the name is dropped too.
    [env(1, "buzz-key"), true, 3],
    [env(1, "buzz-key"), false, 3],
    // One name for each descriptor, the connection passed as 3.
    [env(2, "connection:buzz-key"), true, 4],
    [env(2, "connection:buzz-key"), false, 4],
    [env(3, "a:buzz-key:b"), false, 4],
  ];
  for (const [e, stdinIsSocket, fd] of taken) {
    assert.equal(namedFd(e, "buzz-key", pid, { stdinIsSocket }), fd, JSON.stringify([e.LISTEN_FDS, e.LISTEN_FDNAMES, stdinIsSocket]));
  }
  const refused = [
    [env(1, "connection:buzz-key"), false], // the left-over name, but stdin is not the connection
    [env(1, "foo:buzz-key"), true], // only the connection's name can be left over
    [env(1, "buzz-key:other"), true], // the first LISTEN_FDS names are not the list
    [env(1, "connection:connection"), true],
    [env(1, "connection:buzz-key:x"), true],
    [env(1, "connection"), true],
    [env(2, "buzz-key:buzz-key"), true],
    [env(2, "buzz-key"), true], // fewer names than descriptors
    [{ LISTEN_FDS: "1", LISTEN_PID: String(pid) }, true], // no names
  ];
  for (const [e, stdinIsSocket] of refused) {
    assert.equal(typeof namedFd(e, "buzz-key", pid, { stdinIsSocket }), "string", JSON.stringify([e.LISTEN_FDS, e.LISTEN_FDNAMES, stdinIsSocket]));
  }
  assert.match(namedFd(env(1, "connection:buzz-key"), "buzz-key", pid + 1, { stdinIsSocket: true }), /LISTEN_PID/);
  assert.match(namedFd(env(0, "buzz-key"), "buzz-key", pid, { stdinIsSocket: true }), /no file descriptors were handed over/);
});

test("serve: a bad key or a bad tag is refused with a fixed message that repeats neither", () => {
  for (const keyText of ["not a key", "ab".repeat(31), "x".repeat(5000)]) {
    const home = keyHome("serve-badkey", { keyText });
    const stub = stubServer(home.dir, home.keyFile);
    const r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /private key|longer than/);
    assert.ok(!r.stderr.includes(keyText) && r.stdout === "");
  }
  const own = ["auth", agent.pubkey, "", bytesToHex(randomBytes(64))];
  for (const [tag, why] of [
    ["not json at all", /BUZZ_AUTH_TAG must be the owner's NIP-OA auth tag/],
    [JSON.stringify(own), /names the agent's own key/],
  ]) {
    const home = keyHome("serve-badtag", { tag });
    const stub = stubServer(home.dir, home.keyFile);
    const r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, why);
    assert.ok(!r.stderr.includes(tag) && r.stdout === "");
    assert.ok(keyAbsent(agent, [r.stderr]));
  }
});

test("serve: an owner's tag with no end date (empty conditions, which NIP-OA allows) is passed on as it is", () => {
  const open = ["auth", owner.pubkey, "", bytesToHex(randomBytes(64))];
  const home = keyHome("serve-noend", { tag: JSON.stringify(open) });
  const stub = stubServer(home.dir, home.keyFile);
  const r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub } });
  assert.equal(r.status, 0, r.stderr);
  const report = firstLine(r.stdout);
  assert.equal(report.authTag, JSON.stringify(open));
  assert.equal(report.keySha, sha(agent.hex));
  assert.ok(keyAbsent(agent, [r.stdout, r.stderr]));
});

test("serve: buzz-mcp needs an explicit BUZZ_MCP_PATH", () => {
  const home = keyHome("serve-mcppath");
  const r = serveOnce("buzz-mcp", { home, env: { HOME: home.dir } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /set BUZZ_MCP_PATH/);
});

test("serve: code that someone else can change is refused before the key is read", () => {
  const home = keyHome("serve-trust");
  const stub = stubServer(home.dir, home.keyFile);
  // The server file writable by its group, then the folder it sits in by everyone.
  chmodSync(stub, 0o664);
  let r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to run code .*stub-buzz-mcp\.mjs can be written by its group or by others/);
  chmodSync(stub, 0o644);
  chmodSync(home.dir, 0o777);
  // (buzz-mcp's root lives elsewhere here, so the code check is what refuses.)
  r = serveOnce("buzz-mcp", { home, env: { BUZZ_MCP_PATH: stub, BUZZ_MCP_ROOT: privateDir("root-elsewhere") } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to run code .* can be written by its group or by others/);
  chmodSync(home.dir, 0o700);
  // A node binary in a folder others can write (a hard link, so the binary
  // is the same file, reached through that folder).
  const nodeHere = privateDir("node-writable");
  linkSync(SERVE_NODE, join(nodeHere, "node"));
  chmodSync(nodeHere, 0o777);
  try {
    r = serveOnce("buzz-mcp", { home, node: join(nodeHere, "node"), env: { BUZZ_MCP_PATH: stub } });
  } finally {
    chmodSync(nodeHere, 0o700);
    rmSync(nodeHere, { recursive: true, force: true });
  }
  assert.equal(r.status, 2);
  assert.match(r.stderr, /refusing to run code .*node-writable-\w+ can be written by its group or by others/);
  assert.equal(r.stdout, "");
  // And a copy of the adapter with one source file writable by others.
  const copy = privateDir("adapter-copy");
  cpSync(join(SERVE_ADAPTER, "src"), join(copy, "src"), { recursive: true });
  cpSync(join(SERVE_ADAPTER, "package.json"), join(copy, "package.json"));
  symlinkSync(join(SERVE_ADAPTER, "node_modules"), join(copy, "node_modules"));
  chmodSync(join(copy, "src", "config.mjs"), 0o666);
  r = serveOnce("send", { home, launch: join(copy, "src", "launch.mjs"), args: ["--channel", "c"], input: "text", env: { BUZZ_RELAY_URL: relay.url } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /config\.mjs can be written by its group or by others/);
});

test("the code check: owners, write bits, sticky folders, and links", () => {
  const dir = privateDir("trust");
  const code = join(dir, "code");
  mkdirSync(join(code, "lib"), { recursive: true, mode: 0o755 });
  writeFileSync(join(code, "lib", "a.mjs"), "", { mode: 0o644 });
  assert.equal(untrustedCode([code], new Set([0, ME])), null);
  if (!AS_ROOT) assert.match(untrustedCode([code], new Set([0])), /is owned by uid/);
  // A sticky folder anyone can write is refused above the code too: anyone
  // could add a node_modules folder to it, where Node.js looks for packages.
  const sticky = join(dir, "sticky");
  mkdirSync(sticky);
  chmodSync(sticky, 0o1777);
  const inSticky = join(sticky, "code");
  mkdirSync(inSticky, { mode: 0o755 });
  assert.match(untrustedCode([inSticky], new Set([0, ME])), /sticky can be written by its group or by others/);
  assert.match(untrustedCode([sticky], new Set([0, ME])), /sticky can be written by its group or by others/);
  chmodSync(sticky, 0o755);
  assert.equal(untrustedCode([inSticky], new Set([0, ME])), null);
  // A link is followed: a target that someone else can change is refused.
  const outside = join(dir, "outside");
  mkdirSync(outside, { mode: 0o755 });
  writeFileSync(join(outside, "b.mjs"), "");
  chmodSync(join(outside, "b.mjs"), 0o666);
  symlinkSync(outside, join(code, "lib", "link"));
  assert.match(untrustedCode([code], new Set([0, ME])), /outside\/b\.mjs can be written by its group or by others/);
  chmodSync(join(outside, "b.mjs"), 0o644);
  assert.equal(untrustedCode([code], new Set([0, ME])), null);
  symlinkSync(join(dir, "nowhere"), join(code, "dangling"));
  assert.match(untrustedCode([code], new Set([0, ME])), /dangling is missing/);
});

// A built buzz-mcp is not part of this repository (scripts/build-buzz-mcp.sh
// makes one), so this test runs only when GP_TEST_BUZZ_MCP names one.
const BUNDLE = process.env.GP_TEST_BUZZ_MCP;
test(
  "serve: the real buzz-mcp answers initialize and tools/list through the pipe, and stops at the end of its input",
  { skip: !BUNDLE && "set GP_TEST_BUZZ_MCP to a built buzz-mcp.mjs to run it" },
  async () => {
    const home = keyHome("real-buzz-mcp");
    const bundle = join(home.dir, "buzz-mcp.mjs");
    copyFileSync(BUNDLE, bundle);
    chmodSync(bundle, 0o644);
    const ks = await keyService({ target: "buzz-mcp", home, env: { BUZZ_MCP_PATH: bundle, BUZZ_RELAY_URL: relay.url } });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [LAUNCH, "buzz-mcp"],
      env: { BUZZ_KEY_SOCKET: ks.dir },
      stderr: "pipe",
    });
    const errChunks = [];
    transport.stderr.on("data", (c) => errChunks.push(c));
    const client = new Client({ name: "test-session", version: "0.0.0" });
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of ["send", "read", "react"]) assert.ok(names.includes(name), `buzz-mcp lists ${name}`);
    await client.close();
    await waitFor(() => ks.children.size === 0, { what: "buzz-mcp to stop at the end of its input" });
    leakTexts.push(Buffer.concat(errChunks).toString("utf8"));
    assert.ok(keyAbsent(agent, [ks.stderr()]));
  },
);

// ---------------------------------------------------------------- the probe

/** Runs `launch.mjs probe <target>` against the socket folder, and waits for it. */
function runProbe(target, folder, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCH, "probe", target], {
      env: envOf(BASE_ENV, { BUZZ_KEY_SOCKET: folder }, env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("exit", (status) => {
      const r = { status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
      leakTexts.push(r.stdout, r.stderr);
      resolve(r);
    });
  });
}

/**
 * A stand-in for buzz-mcp that speaks MCP's first step: it answers
 * initialize with its name, and says so when the handshake is finished.
 */
function mcpStub(dir, { channel = false, error = false } = {}) {
  const script = join(dir, error ? "stub-mcp-error.mjs" : "stub-mcp.mjs");
  const capabilities = channel ? { experimental: { "claude/channel": {} } } : { tools: {} };
  writeFileSync(
    script,
    `let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  text += chunk;
  for (let i = text.indexOf("\\n"); i >= 0; i = text.indexOf("\\n")) {
    const m = JSON.parse(text.slice(0, i));
    text = text.slice(i + 1);
    if (m.method === "initialize") {
      const result = { protocolVersion: m.params.protocolVersion, capabilities: ${JSON.stringify(capabilities)}, serverInfo: { name: "stub-buzz-mcp", version: "1" } };
      const answer = ${error} ? { error: { code: -32603, message: "no" } } : { result };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...answer }) + "\\n");
    }
  }
});
process.stdin.on("end", () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );
  return script;
}

test("probe: each server answers one real connection through its socket, the way systemd 255 hands the key over", async () => {
  const home = keyHome("probe-mcp");
  const ks = await keyService({ target: "buzz-mcp", home, env: { BUZZ_MCP_PATH: mcpStub(home.dir) } });
  const r = await runProbe("buzz-mcp", ks.dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, `probe: ${ks.path} answered (server stub-buzz-mcp)\n`);
  await waitFor(() => ks.children.size === 0, { what: "buzz-mcp to end with the probe's connection" });
  assert.ok(keyAbsent(agent, [r.stdout, r.stderr, ks.stderr()]));
});

test("probe: the real channel answers, and a probed channel never connects to the relay or keeps its lock", async () => {
  const home = keyHome("probe-channel");
  const stateDir = join(home.dir, "state");
  const ks = await keyService({
    target: "channel",
    home,
    maxConnections: 1,
    env: {
      BUZZ_RELAY_URL: relay.url,
      BUZZ_CHANNELS: randomUUID(),
      BUZZ_STATE_DIR: stateDir,
      BUZZ_LOG_FILE: join(home.dir, "channel.log"),
      BUZZ_CHANNEL_LOCK: "on",
    },
  });
  const connectionsBefore = relay.stats.connections;
  const reqsBefore = relay.stats.reqs.length;
  const r = await runProbe("channel", ks.dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, `probe: ${ks.path} answered (server buzz-channel)\n`);
  await waitFor(() => ks.children.size === 0, { what: "the probed channel to stop" });
  // It never finished the handshake, so the channel never went to the relay:
  // no mention could reach the probe, and the cursor never moved past one.
  assert.equal(relay.stats.connections, connectionsBefore, "the probed channel connected to the relay");
  assert.equal(relay.stats.reqs.length, reqsBefore);
  assert.doesNotMatch(readFileSync(join(home.dir, "channel.log"), "utf8"), /connecting to the relay/);
  // Its lock went with it, so the session's channel gets in at once.
  assert.deepEqual(readdirSync(stateDir).filter((f) => f.endsWith(".lock")), []);
  assert.ok(keyAbsent(agent, [r.stdout, r.stderr, ks.stderr()]));
});

test("probe: a key service that closes unanswered, no socket, a server that never answers and one that is no channel all fail (exit 1)", async () => {
  // The way the first run on real systemd failed: serve refused, and systemd closed the connection.
  const home = keyHome("probe-refused");
  const ks = await keyService({ target: "channel", home, env: { LISTEN_FDNAMES: "connection" } });
  let r = await runProbe("channel", ks.dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^probe: \S+\/channel\.sock did not answer: the key service closed the connection before answering( \(ECONNRESET\))?\n$/);
  r = await runProbe("buzz-mcp", tempDir("probe-none"));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /did not answer: could not connect \(ENOENT\)\n$/);
  const es = await echoServer(); // answers, but never with MCP
  r = await runProbe("buzz-mcp", es.dir, { BUZZ_KEY_PROBE_WAIT_MS: "700" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /did not answer: it sent no answer within 700 ms\n$/);
  // A server at the channel's socket that is not a channel.
  const home2 = keyHome("probe-notchannel");
  const mcp = await keyService({ target: "buzz-mcp", home: home2, env: { BUZZ_MCP_PATH: mcpStub(home2.dir) } });
  const notChannel = tempDir("probe-notchannel");
  symlinkSync(mcp.path, join(notChannel, "channel.sock"));
  r = await runProbe("channel", notChannel);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /answered \(server stub-buzz-mcp\), but not as a channel/);
  // A server that answers initialize with an error.
  const home3 = keyHome("probe-error");
  const failing = await keyService({ target: "buzz-mcp", home: home3, env: { BUZZ_MCP_PATH: mcpStub(home3.dir, { error: true }) } });
  r = await runProbe("buzz-mcp", failing.dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /did not answer: it answered initialize with an error\n$/);
  // Usage.
  for (const [args, env] of [
    [["send"], { BUZZ_KEY_SOCKET: es.dir }],
    [["channel"], { BUZZ_KEY_SOCKET: "relative" }],
    [["channel"], { BUZZ_KEY_SOCKET: undefined }],
  ]) {
    const u = spawnSync(process.execPath, [LAUNCH, "probe", ...args], { env: envOf(BASE_ENV, env), encoding: "utf8", timeout: 10_000 });
    assert.equal(u.status, 2, JSON.stringify(args));
  }
});

// ---------------------------------------------------------------- end to end

test("end to end: a session reaches the real channel through the pipe, which logs in with the credential's tag", async () => {
  relay.hooks.requireAuthTag = true;
  try {
    const home = keyHome("e2e-channel");
    const chan = randomUUID();
    const ks = await keyService({
      target: "channel",
      home,
      maxConnections: 1,
      env: {
        BUZZ_RELAY_URL: relay.url,
        BUZZ_CHANNELS: chan,
        BUZZ_STATE_DIR: join(home.dir, "state"),
        BUZZ_LOG_FILE: join(home.dir, "channel.log"),
        BUZZ_BACKOFF_MS: "50",
        BUZZ_BACKOFF_MAX_MS: "200",
        BUZZ_HEARTBEAT_MS: "200",
      },
    });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [LAUNCH, "channel"],
      env: { BUZZ_KEY_SOCKET: ks.dir },
      stderr: "pipe",
    });
    const errChunks = [];
    transport.stderr.on("data", (c) => errChunks.push(c));
    const client = new Client({ name: "test-session", version: "0.0.0" });
    const received = [];
    client.fallbackNotificationHandler = async (n) => {
      if (n.method === "notifications/claude/channel") received.push(n.params);
    };
    const reqsBefore = relay.stats.reqs.length;
    const tagsBefore = relay.stats.authTags.length;
    await client.connect(transport);
    // The pipe hands Claude Code the channel's own handshake.
    assert.deepEqual(client.getServerCapabilities()?.experimental?.["claude/channel"], {});
    assert.match(client.getInstructions() ?? "", /Buzz chat messages that mention you/);
    await waitFor(() => relay.stats.reqs.slice(reqsBefore).some((r) => r.subId.startsWith("buzz-channel-sub-")), {
      what: "the channel to subscribe",
    });
    assert.deepEqual(relay.stats.authTags.slice(tagsBefore).at(-1), [TAG], "the login carried the credential's tag");
    const e = message(sender.secret, { channel: chan, mention: agent.pubkey, content: "through the pipe" });
    relay.publish(e);
    await waitFor(() => received.length === 1, { what: "the mention" });
    assert.equal(received[0].content, "through the pipe");
    assert.equal(received[0].meta.event_id, e.id);
    await client.close();
    await waitFor(() => ks.children.size === 0, { what: "the channel to stop with the session" });
    leakTexts.push(Buffer.concat(errChunks).toString("utf8"));
  } finally {
    relay.hooks.requireAuthTag = false;
  }
});

test("end to end: the one-shot send runs as `serve send`, with the key from the file descriptor and the tag", async () => {
  relay.hooks.requireAuthTag = true;
  try {
    const home = keyHome("e2e-send");
    const chan = randomUUID();
    const before = relay.stats.events.length;
    // Not spawnSync: the fake relay runs in this process and must keep answering.
    const keyFd = openSync(home.keyFile, "r");
    const child = spawn("/bin/sh", ["-c", SD_WRAP, SERVE_NODE, SERVE_LAUNCH, "serve", "send", "--channel", chan, "--mention", owner.pubkey], {
      stdio: ["pipe", "pipe", "pipe", keyFd],
      env: { ...SERVE_ENV, LISTEN_FDS: "1", LISTEN_FDNAMES: "buzz-key", CREDENTIALS_DIRECTORY: home.creds, BUZZ_RELAY_URL: relay.url },
    });
    closeSync(keyFd);
    const out = [];
    const err = [];
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.stdin.end("sent by the key service");
    const status = await new Promise((resolve) => child.on("exit", resolve));
    const r = { status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") };
    leakTexts.push(r.stdout, r.stderr);
    assert.equal(r.status, 0, r.stderr);
    const [line] = r.stdout.trim().split("\n");
    const sent = relay.stats.events.slice(before).find((ev) => `sent ${ev.id}` === line);
    assert.ok(sent, "the relay has the message");
    assert.equal(sent.pubkey, agent.pubkey);
    assert.equal(sent.content, "sent by the key service");
    assert.deepEqual(sent.tags.filter((t) => t[0] === "h"), [["h", chan]]);
    assert.ok(keyAbsent(agent, [r.stdout, r.stderr]));
  } finally {
    relay.hooks.requireAuthTag = false;
  }
});

// ---------------------------------------------------------------- the git sign-in

test("serve git: one sign-in for one repository on the relay, signed by the key service's key, with the owner's tag", async () => {
  const { verifyEvent } = await import("nostr-tools/pure");
  const home = keyHome("serve-git");
  const repo = `git/${owner.pubkey}/ops-notes`;
  const ask = (request, env = {}) =>
    serveOnce("git", { home, input: `${JSON.stringify(request)}\n`, env: { BUZZ_RELAY_URL: "wss://relay.example.com", ...env } });
  for (const path of [repo, `${repo}/info/refs`, `${repo}/git-upload-pack`, `${repo}/git-receive-pack`]) {
    const r = ask({ op: "sign", protocol: "https", host: "relay.example.com", path });
    leakTexts.push(r.stdout, r.stderr);
    assert.equal(r.status, 0, r.stderr);
    const answer = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(answer).sort(), ["credential", "ok"]);
    const event = JSON.parse(Buffer.from(answer.credential, "base64").toString("utf8"));
    assert.ok(verifyEvent(event));
    assert.equal(event.kind, 27235);
    assert.equal(event.pubkey, agent.pubkey);
    assert.equal(event.content, "");
    assert.deepEqual(event.tags, [["u", `https://relay.example.com/${repo}`], ["method", "GET"], TAG]);
    assert.ok(Math.abs(event.created_at - Date.now() / 1000) < 30);
    assert.match(r.stderr, new RegExp(`signed a git sign-in for ${owner.pubkey}/ops-notes`));
  }
  const ping = ask({ op: "ping" });
  assert.equal(ping.status, 0, ping.stderr);
  assert.deepEqual(JSON.parse(ping.stdout), { ok: true, pubkey: agent.pubkey });
  // Never another host, scheme, endpoint or shape: the socket is no general signer.
  for (const [request, why] of [
    [{ op: "sign", protocol: "https", host: "other.example.com", path: repo }, /only the instance's own relay/],
    [{ op: "sign", protocol: "http", host: "relay.example.com", path: repo }, /only https/],
    [{ op: "sign", protocol: "https", host: "relay.example.com", path: "events" }, /one repository/],
    [{ op: "sign", protocol: "https", host: "relay.example.com", path: "query" }, /one repository/],
    [{ op: "sign", protocol: "https", host: "relay.example.com", path: `git/${owner.pubkey}/a/b` }, /one repository/],
    [{ op: "sign", protocol: "https", host: "relay.example.com", path: `git/${owner.pubkey}/..` }, /name must be/],
    [{ op: "sign", protocol: "https", host: "relay.example.com", path: `git/${owner.pubkey}/.hidden` }, /name must be/],
    [{ op: "sign", protocol: "https", host: "relay.example.com", path: "git/NOTHEX/repo" }, /owner must be/],
    [{ op: "event", kind: 1, content: "hi" }, /op must be sign or ping/],
  ]) {
    const r = ask(request);
    leakTexts.push(r.stdout, r.stderr);
    assert.equal(r.status, 1, JSON.stringify(request));
    const answer = JSON.parse(r.stdout);
    assert.equal(answer.ok, false);
    assert.equal(answer.credential, undefined);
    assert.match(answer.error, why);
  }
  const junk = serveOnce("git", { home, input: "not json\n", env: { BUZZ_RELAY_URL: "wss://relay.example.com" } });
  assert.equal(junk.status, 1);
  assert.match(JSON.parse(junk.stdout).error, /one line of JSON/);
  const long = serveOnce("git", { home, input: `${"x".repeat(5000)}\n`, env: { BUZZ_RELAY_URL: "wss://relay.example.com" } });
  assert.equal(long.status, 1);
  assert.match(JSON.parse(long.stdout).error, /at most 4096 bytes/);
});

test("launch.mjs git: the sign-in runs only on the key service's side", () => {
  const r = spawnSync(process.execPath, [LAUNCH, "git"], { env: { ...BASE_ENV, BUZZ_PRIVATE_KEY: agent.hex }, encoding: "utf8", input: "" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage/);
  assert.equal(r.stdout, "");
});
