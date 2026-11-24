#!/usr/bin/env node
// Starts one of the Buzz adapter's two MCP servers with the relay key in that
// server's environment only:
//
//   node launch.mjs channel    the Buzz channel (src/channel.mjs)
//   node launch.mjs buzz-mcp   Block's buzz-mcp, for replies (built by scripts/build-buzz-mcp.sh)
//   node launch.mjs send …     one message, then exit (src/send.mjs; the
//                              arguments after `send` and stdin go to it)
//   node launch.mjs task …     one task root's state set, or the open ones
//                              listed, then exit (src/task-cli.mjs)
//   node launch.mjs status read [--agent <key>]…
//                              the agents' status lines and presence, one
//                              JSON line each, then exit (src/status-cli.mjs;
//                              README.md, "Status line")
//   node launch.mjs thread …   the replies in a thread, then exit
//                              (src/thread.mjs; the auto-mode guard reads
//                              its owner's answers with it)
//
// Dependencies are installed into this adapter's own folder on first run.
//
// The key comes from BUZZ_KEY_COMMAND, a command that prints it (for example
// `op read op://<vault>/<item>/<field>`). The command's output is captured in
// memory and its error output is discarded, so the key never reaches a log.
// The key is never written to disk. If BUZZ_KEY_COMMAND is unset, a key
// already in BUZZ_PRIVATE_KEY is passed through.
//
// With a key service (README.md, "Key service"), the key stays with another
// OS user, and the launcher has two more modes:
//
//   BUZZ_KEY_SOCKET=<folder> node launch.mjs channel|buzz-mcp
//       the pipe: the session's side. It reads no key, runs no key command
//       and installs nothing. It connects to <folder>/<server>.sock and
//       copies bytes both ways (src/keyservice.mjs). The plugin always
//       passes BUZZ_KEY_COMMAND, so an empty one is dropped: the pipe runs
//       itself again, in the same process, without it.
//   BUZZ_KEY_SOCKET=<folder> node launch.mjs probe channel|buzz-mcp
//       one real connection to <folder>/<server>.sock, as the pipe makes it:
//       an MCP initialize, and the server's answer. It prints the server's
//       name, or why there was no answer, and exits 0 only when it answered.
//       install/keyservice/setup runs it as the instance's user.
//   node launch.mjs serve channel|buzz-mcp|send|task|git …
//       the key service's side, run by systemd as the key's user, one
//       process per connection. It takes the key from the file descriptor
//       systemd opened for it (OpenFile=…:buzz-key), sets it from inside
//       this process, and runs the server in this same process.
//
// stdout belongs to the MCP stream, so everything this launcher says goes to
// stderr.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, fstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { keyFdProblem, namedFd, PIPE_WAIT_MS, pipe, probe, readFd, untrustedCode, untrustedFolder } from "./keyservice.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const say = (message) => process.stderr.write(`buzz-channel launch: ${message}\n`);

function fail(message) {
  say(message);
  process.exit(2);
}

function setting(name) {
  const value = process.env[name]?.trim();
  if (!value || /^\$\{[^}]*\}$/.test(value)) return undefined;
  return value;
}

function depsPresent() {
  return ["@modelcontextprotocol/sdk", "nostr-tools"].every((pkg) =>
    existsSync(join(ROOT, "node_modules", ...pkg.split("/"), "package.json")),
  );
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Installs the plugin's own dependencies on first run (`npm ci` from the
 * lockfile, no install scripts). Both servers start at once, so a lock
 * directory keeps two installs from running together.
 */
function ensureDeps() {
  if (depsPresent()) return;
  const lock = join(ROOT, ".install-lock");
  const deadline = Date.now() + 5 * 60_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== "EEXIST") fail("could not create the install lock in the plugin directory");
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > 10 * 60_000) rmSync(lock, { recursive: true, force: true });
    } catch {
      // the other launcher just released it
    }
    if (Date.now() > deadline) fail(`dependency install did not finish; remove ${lock} and retry`);
    sleep(500);
  }
  try {
    if (!depsPresent()) {
      say("installing dependencies (first run)");
      const result = spawnSync(
        "npm",
        ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
        { cwd: ROOT, stdio: ["ignore", 2, 2] },
      );
      if (result.status !== 0) fail("npm ci failed in the plugin directory");
    }
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

function readKey() {
  const command = setting("BUZZ_KEY_COMMAND");
  if (command) {
    const result = spawnSync("/bin/sh", ["-c", command], {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 64 * 1024,
    });
    if (result.error || result.status !== 0) {
      fail(
        `BUZZ_KEY_COMMAND failed (exit ${result.status ?? "none"}). Its output is not shown, so a key cannot leak into a log; run it by hand to see why.`,
      );
    }
    return result.stdout;
  }
  if (process.env.BUZZ_PRIVATE_KEY) return process.env.BUZZ_PRIVATE_KEY;
  return fail(
    "set BUZZ_KEY_COMMAND to a command that prints the relay private key, or BUZZ_KEY_SOCKET to the socket folder of a key service",
  );
}

/** Where scripts/build-buzz-mcp.sh puts its output. */
function buzzMcpCache() {
  return (
    setting("BUZZ_MCP_CACHE") ?? join(setting("XDG_CACHE_HOME") ?? join(homedir(), ".cache"), "ghost-protocol", "buzz")
  );
}

function pinnedCommit() {
  try {
    return readFileSync(join(ROOT, "buzz-mcp.pin"), "utf8").match(/^commit=([0-9a-f]{40})$/m)?.[1];
  } catch {
    return undefined;
  }
}

function buzzMcpScript() {
  const explicit = setting("BUZZ_MCP_PATH");
  if (explicit) {
    if (!existsSync(explicit)) fail("BUZZ_MCP_PATH does not point to a file");
    return explicit;
  }
  const cache = buzzMcpCache();
  const script = join(cache, "buzz-mcp.mjs");
  if (!existsSync(script)) fail("buzz-mcp is not built yet: run scripts/build-buzz-mcp.sh, or set BUZZ_MCP_PATH");
  let built;
  try {
    built = readFileSync(join(cache, "buzz-mcp.commit"), "utf8").trim();
  } catch {
    built = undefined;
  }
  const pin = pinnedCommit();
  if (pin && built !== pin) say("the built buzz-mcp does not match buzz-mcp.pin; run scripts/build-buzz-mcp.sh");
  return script;
}

const scripts = {
  channel: () => join(ROOT, "src", "channel.mjs"),
  "buzz-mcp": buzzMcpScript,
  send: () => join(ROOT, "src", "send.mjs"),
  task: () => join(ROOT, "src", "task-cli.mjs"),
  thread: () => join(ROOT, "src", "thread.mjs"),
  status: () => join(ROOT, "src", "status-cli.mjs"),
  git: () => join(ROOT, "src", "git-auth.mjs"),
};
// The key service runs only these; the one-shot thread read is the guard's,
// which never runs with a key service, and the status line is not served
// there (yet).
const SERVED = new Set(["channel", "buzz-mcp", "send", "task", "git"]);

/** Today's way: the key from BUZZ_KEY_COMMAND, handed to the server in its own environment. */
async function launch(target) {
  // The git sign-in runs only on the key service's side (serve git).
  if (!Object.hasOwn(scripts, target) || target === "git") {
    fail("usage: launch.mjs channel|buzz-mcp|send|task|thread|status, or launch.mjs serve channel|buzz-mcp|send|task|git");
  }

  ensureDeps();
  const { ConfigError, parseSecretKey } = await import("./config.mjs");
  const { bytesToHex } = await import("nostr-tools/utils");

  let keyHex;
  try {
    keyHex = bytesToHex(parseSecretKey(readKey()));
  } catch (err) {
    fail(err instanceof ConfigError ? err.message : "could not read the private key");
  }

  const script = scripts[target]();
  const env = { ...process.env, BUZZ_PRIVATE_KEY: keyHex };
  delete env.BUZZ_KEY_COMMAND;
  keyHex = undefined;

  const child = spawn(process.execPath, [script, ...process.argv.slice(3)], { stdio: "inherit", env });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  child.on("error", () => fail("could not start the server process"));
}

/**
 * The pipe: the session's side of a key service. No key, no key command, no
 * dependencies; only bytes between this process's stdio and the socket.
 */
async function pipeTo(target, folder) {
  if (target === "send") {
    fail("BUZZ_KEY_SOCKET is set, but the one-shot send has no socket: run it on the key service's side (launch.mjs serve send)");
  }
  if (target === "task") {
    fail("BUZZ_KEY_SOCKET is set, but the one-shot task has no socket: use the channel's task tools, or run it on the key service's side (launch.mjs serve task)");
  }
  if (target === "thread") fail("BUZZ_KEY_SOCKET is set, but the one-shot thread read has no socket and no key service side");
  if (target === "status") fail("BUZZ_KEY_SOCKET is set, but the one-shot status read has no socket and no key service side");
  if (target === "channel" && (setting("BUZZ_STATUS") ?? "").toLowerCase() === "on") {
    say("BUZZ_STATUS=on has no effect with a key service: the channel runs as the key's user, which cannot read the session's turn state, so the status line is off");
  }
  if (setting("BUZZ_KEY_COMMAND") || "BUZZ_PRIVATE_KEY" in process.env) {
    fail(
      "BUZZ_KEY_SOCKET is set, so this side must hold no key: leave BUZZ_KEY_COMMAND (the plugin's key command) empty and BUZZ_PRIVATE_KEY unset",
    );
  }
  if (!isAbsolute(folder)) fail("BUZZ_KEY_SOCKET must be the absolute path of the key service's socket folder");
  dropEmptyKeyCommand();
  const wait = setting("BUZZ_KEY_SOCKET_WAIT_MS");
  const waitMs = wait === undefined ? PIPE_WAIT_MS : Number(wait);
  if (!Number.isSafeInteger(waitMs) || waitMs <= 0) fail("BUZZ_KEY_SOCKET_WAIT_MS must be a positive whole number");
  process.exitCode = await pipe({
    path: join(folder, `${target}.sock`),
    input: process.stdin,
    output: process.stdout,
    say,
    waitMs,
  });
  setTimeout(() => process.exit(), 1000).unref();
}

/**
 * The plugin's .mcp.json passes BUZZ_KEY_COMMAND to every server, filled in
 * or not: a setting cannot leave a variable out. With a key service it is
 * empty (or still the unfilled ${...}), yet its name would sit in this
 * process's /proc/<pid>/environ for as long as the session runs, and the
 * session's side must hold no key command at all, not even an empty one. So
 * the pipe runs itself again with it removed: execve, the same process, the
 * same stdin and stdout, an environment without the name. Before that, the
 * name exists only between Claude Code starting this process and here. A
 * Node.js without process.execve (before 22.15) goes on with the empty
 * variable, and says so.
 *
 * A failed execve cannot be gone back from: Node.js has already reset its
 * state for the new program, so it aborts the process (SIGABRT) instead of
 * throwing, and the pipe ends there; Claude Code sees the server exit. So the
 * one failure that can be seen first, a node binary this process cannot run
 * (moved or replaced, say), is checked first, and the pipe goes on with the
 * empty variable, and says so. The catch is for what throws before the call
 * (a platform without execve, say).
 */
function dropEmptyKeyCommand() {
  if (!("BUZZ_KEY_COMMAND" in process.env)) return;
  if (typeof process.execve !== "function") {
    say("this Node.js has no process.execve, so the empty BUZZ_KEY_COMMAND stays in this process's environment (Node.js 22.15 or later drops it)");
    return;
  }
  try {
    accessSync(process.execPath, constants.X_OK);
  } catch (err) {
    say(`cannot run ${process.execPath} again (${err?.code ?? "not runnable"}), so the empty BUZZ_KEY_COMMAND stays in this process's environment`);
    return;
  }
  const env = { ...process.env };
  delete env.BUZZ_KEY_COMMAND;
  try {
    // On success this never returns; on a failure of the call itself Node.js aborts.
    process.execve(process.execPath, [process.execPath, ...process.execArgv, ...process.argv.slice(1)], env);
  } catch {
    say("could not run the pipe again without the empty BUZZ_KEY_COMMAND; going on with it");
  }
}

/**
 * The probe: one real connection to a key service's socket, which must
 * answer an MCP initialize (src/keyservice.mjs, probe()). The channel must
 * also declare itself one. It prints one line: the server's name, or why
 * there was no answer. Exit 0 when answered, 1 when not, 2 on bad usage.
 */
async function probeSocket(target, folder) {
  if (target !== "channel" && target !== "buzz-mcp") fail("usage: BUZZ_KEY_SOCKET=<folder> launch.mjs probe channel|buzz-mcp");
  if (!folder || !isAbsolute(folder)) fail("probe: set BUZZ_KEY_SOCKET to the absolute path of the key service's socket folder");
  const wait = setting("BUZZ_KEY_PROBE_WAIT_MS");
  const timeoutMs = wait === undefined ? undefined : Number(wait);
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) fail("BUZZ_KEY_PROBE_WAIT_MS must be a positive whole number");
  const path = join(folder, `${target}.sock`);
  const r = await probe({ path, timeoutMs });
  if (r.answered && target === "channel" && !r.channel) {
    process.stdout.write(`probe: ${path} answered (server ${r.server}), but not as a channel (no claude/channel capability)\n`);
    process.exit(1);
  }
  if (r.answered) {
    process.stdout.write(`probe: ${path} answered (server ${r.server})\n`);
    process.exit(0);
  }
  process.stdout.write(`probe: ${path} did not answer: ${r.why}\n`);
  process.exit(1);
}

/** Whether stdin is a socket: systemd's connection, under StandardInput=socket. */
function stdinIsSocket() {
  try {
    return fstatSync(0).isSocket();
  } catch {
    return false;
  }
}

const KEY_FD_NAME = "buzz-key";
const TAG_CREDENTIAL = "buzz-auth-tag";
// Settings that make node, OpenSSL or the dynamic loader run other code in
// this process before the server, where it would see the key once it is set
// (OPENSSL_CONF can name a provider module that node loads at startup).
const LOADER_VARIABLES = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_COMPILE_CACHE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "OPENSSL_CONF",
  "OPENSSL_MODULES",
  "OPENSSL_ENGINES",
];
// The one node option a key unit may pass: it closes the inspector's signal.
const ALLOWED_NODE_OPTIONS = new Set(["--disable-sigusr1"]);
// For the adapter's own tests only, which run without root: also trust files
// owned by the serving user. Ignored under systemd (INVOCATION_ID is set), so
// a unit can never turn it on.
const TEST_TRUST_SWITCH = "GP_TEST_SERVE_TRUST_OWN_UID";

/** The owner's tag from the unit's credential (LoadCredential=buzz-auth-tag:…), or undefined. */
function tagCredential() {
  const dir = setting("CREDENTIALS_DIRECTORY");
  if (!dir) return undefined;
  try {
    const raw = readFileSync(join(dir, TAG_CREDENTIAL), "utf8");
    if (raw.length > 8192) fail(`serve: the ${TAG_CREDENTIAL} credential is longer than 8192 bytes`);
    return raw.trim();
  } catch (err) {
    if (err.code === "ENOENT") return undefined;
    return fail(`serve: could not read the ${TAG_CREDENTIAL} credential`);
  }
}

/**
 * The names in the environment this process started with: process.env, and
 * on Linux /proc/self/environ too, which code that ran earlier in this
 * process cannot change. Names only; no value is read out.
 */
function startingVariableNames() {
  const names = new Set(Object.keys(process.env));
  try {
    for (const entry of readFileSync("/proc/self/environ", "latin1").split("\0")) {
      const at = entry.indexOf("=");
      if (at > 0) names.add(entry.slice(0, at));
    }
  } catch {
    // not Linux
  }
  return names;
}

/**
 * Why buzz-mcp's file root (BUZZ_MCP_ROOT) is unsafe, or null. On success it
 * replaces BUZZ_MCP_ROOT with the resolved path, which buzz-mcp then uses.
 *
 * buzz-mcp checks a `path` with realpath and then opens it, so whoever can
 * write in the root can swap a file for a link between the two steps. So the
 * root, and every folder above it, must be writable only by root or the
 * key's user: the session's user cannot put anything there itself.
 */
function mcpRootProblem() {
  const root = setting("BUZZ_MCP_ROOT");
  if (!root) return "set BUZZ_MCP_ROOT: buzz-mcp's path and files arguments read any file under it, and without it under its working folder";
  if (!isAbsolute(root)) return "BUZZ_MCP_ROOT must be an absolute path";
  let real;
  try {
    real = realpathSync(root);
  } catch {
    return "BUZZ_MCP_ROOT does not exist";
  }
  if (!statSync(real).isDirectory()) return "BUZZ_MCP_ROOT must be a folder";
  if (real === "/") return "BUZZ_MCP_ROOT must not be /";
  // The key's user owns it (the key side's copy step writes there): a folder
  // of root's such as /etc, /proc or /run is never buzz-mcp's to read.
  if (statSync(real).uid !== process.getuid()) return "BUZZ_MCP_ROOT must be a folder owned by the key's user";
  let writable;
  try {
    writable = untrustedFolder(real, new Set([0, process.getuid()]));
  } catch {
    writable = "the check could not read it";
  }
  if (writable) return `BUZZ_MCP_ROOT must be a folder only root or the key's user can change: ${writable}`;
  const kept = [
    setting("CREDENTIALS_DIRECTORY"),
    setting("BUZZ_STATE_DIR"),
    ...(setting("STATE_DIRECTORY") ?? "").split(":"),
  ].filter(Boolean);
  for (const dir of kept) {
    let r;
    try {
      r = realpathSync(dir);
    } catch {
      r = dir;
    }
    if (r === real || r.startsWith(`${real}/`)) return "BUZZ_MCP_ROOT must not hold the key service's state or credentials folders";
  }
  process.env.BUZZ_MCP_ROOT = real;
  return null;
}

/**
 * The key service's side: run by systemd as the key's user, with the
 * connection on stdin and stdout and the key file opened by systemd. The key
 * is set from inside this process, which then runs the server itself, so the
 * key is never in an environment the kernel shows in /proc/<pid>/environ.
 */
async function serve(target) {
  if (!SERVED.has(target)) fail("usage: launch.mjs serve channel|buzz-mcp|send|task|git");
  // 1. Nothing may run in this process before the server: no node options
  //    (but --disable-sigusr1) and no loader settings.
  if (process.execArgv.some((option) => !ALLOWED_NODE_OPTIONS.has(option))) {
    fail("serve: node was started with options; the key service runs node with none, except --disable-sigusr1");
  }
  const names = startingVariableNames();
  for (const name of LOADER_VARIABLES) {
    if (names.has(name)) fail(`serve: ${name} is set. It could run other code in this process; remove it (UnsetEnvironment=${name})`);
  }
  // 2. A key handed over any other way means the unit is set up wrong.
  for (const name of ["BUZZ_KEY_COMMAND", "BUZZ_PRIVATE_KEY"]) {
    if (name in process.env) {
      fail(`serve: ${name} is set. The key service takes the key only from the file systemd opens for it; remove ${name} from its environment`);
    }
  }
  // 3. Only code that nobody but root can change gets the key, and buzz-mcp
  //    reads files only under a root of their own.
  if (target === "buzz-mcp") {
    if (!setting("BUZZ_MCP_PATH")) fail("serve: set BUZZ_MCP_PATH to the buzz-mcp build the key service runs");
    const rootProblem = mcpRootProblem();
    if (rootProblem) fail(`serve: ${rootProblem}`);
  }
  const script = scripts[target]();
  const trusted = new Set([0]);
  if (process.env[TEST_TRUST_SWITCH] === "1") {
    if ("INVOCATION_ID" in process.env) {
      say(`serve: ${TEST_TRUST_SWITCH} is ignored under systemd (INVOCATION_ID is set)`);
    } else {
      trusted.add(process.getuid());
      say(`serve: test mode (${TEST_TRUST_SWITCH}=1): files owned by uid ${process.getuid()} are trusted too`);
    }
  }
  let problem;
  try {
    problem = untrustedCode([ROOT, process.execPath, script], trusted);
  } catch {
    problem = "the check could not read them";
  }
  if (problem) fail(`serve: refusing to run code that a user other than root can change: ${problem}`);
  if (!depsPresent()) fail("serve: the adapter's dependencies are missing (the key service never installs them)");
  // 4. The key, from the file descriptor systemd opened, checked, read, closed.
  const fd = namedFd(process.env, KEY_FD_NAME, process.pid, { stdinIsSocket: stdinIsSocket() });
  if (typeof fd === "string") fail(`serve: ${fd}`);
  const fdProblem = keyFdProblem(fd, trusted);
  if (fdProblem) fail(`serve: ${fdProblem}`);
  const raw = readFd(fd);
  if (typeof raw === "string") fail(`serve: ${raw}`);
  const { ConfigError, parseAuthTag, parseSecretKey, publicKeyOf } = await import("./config.mjs");
  const { bytesToHex } = await import("nostr-tools/utils");
  let keyHex;
  try {
    const secret = parseSecretKey(raw.toString("utf8"));
    // 5. The owner's tag, which is public: from the credential, else as set.
    const tag = tagCredential();
    if (tag !== undefined) process.env.BUZZ_AUTH_TAG = tag;
    parseAuthTag(process.env, publicKeyOf(secret));
    keyHex = bytesToHex(secret);
  } catch (err) {
    fail(err instanceof ConfigError ? err.message : "could not read the private key");
  } finally {
    raw.fill(0);
  }
  // 6. Set from inside: a variable set here never reaches /proc/self/environ.
  process.env.BUZZ_PRIVATE_KEY = keyHex;
  keyHex = undefined;
  for (const name of ["LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES"]) delete process.env[name];
  process.argv = [process.execPath, script, ...process.argv.slice(4)];
  // In this process only (never inherited): the channel is in a key service.
  globalThis[Symbol.for("ghost-protocol.buzz.key-service")] = true;
  if (target === "buzz-mcp") {
    // One process per connection: when the connection ends, so does buzz-mcp,
    // whatever it still has open. (The channel already stops at the end of
    // its input; the send reads its text from stdin; the task tool exits.)
    const quit = () => process.exit(0);
    process.stdin.once("end", quit);
    process.stdin.once("close", quit);
  }
  await import(pathToFileURL(script).href);
  // The servers read the key while they load (the channel and the send also
  // delete it themselves), so it leaves this process's environment now: a
  // child process started later would otherwise inherit it.
  delete process.env.BUZZ_PRIVATE_KEY;
}

const target = process.argv[2];
const socketFolder = setting("BUZZ_KEY_SOCKET");
if (target === "serve") await serve(process.argv[3]);
else if (target === "probe") await probeSocket(process.argv[3], socketFolder);
else if (socketFolder && Object.hasOwn(scripts, target) && target !== "git") await pipeTo(target, socketFolder);
else await launch(target);
