// The key service's mutation check: runs the key service's tests against
// broken copies of the code, one break each. Every copy must fail its suite;
// a break whose text is no longer in the code (not applied) fails this check
// too, so the list stays in step with the code. It covers what the tests
// hold the key service to on a real systemd: the file descriptor list
// systemd 255 to 258 hand over, the pipe's wait between tries, the empty key
// command left out of the pipe's environment (and a node that cannot run
// again, seen before execve), the probe, and a mention the sender allowlist
// refused, which is never delivered later, and is kept apart from the
// delivered ones, within bounds, written together, and only when the refusal
// was definite.
//
// The adapter is copied once into a temporary folder (its node_modules
// too); each break is written into that copy and taken out again, so the
// working tree is never changed.
//
// Run: node test/keyservice-mutants.mjs   (a few minutes; not part of npm test)
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER, tempDir } from "./helpers.mjs";

const KS = "src/keyservice.mjs";
const LAUNCH = "src/launch.mjs";
const RELAY = "src/relay.mjs";
const STATE = "src/state.mjs";
const ALLOW = "src/allowlist.mjs";
const CHANNEL = "src/channel.mjs";
const KS_SUITE = "test/keyservice.test.mjs";
const ALLOW_SUITE = "test/sender-allowlist.test.mjs";
const ALLOW_UNIT_SUITE = "test/allowlist-unit.test.mjs";
const STATE_SUITE = "test/state.test.mjs";

// [name, file, suite, [[exact text, replacement], ...]]
const MUTANTS = [
  // The file descriptors: systemd 255 to 258 under Accept=yes with
  // StandardInput=socket pass LISTEN_FDS=1 with LISTEN_FDNAMES=connection:buzz-key.
  ["namedFd reads the first LISTEN_FDS names (the merged version's bug)", KS, KS_SUITE, [
    ["  if (names.length === count + 1 && names[0] === CONNECTION_FD_NAME && stdinIsSocket) names = names.slice(1);\n", "  names = names.slice(0, count);\n"],
  ]],
  ["the connection's left-over name is never dropped", KS, KS_SUITE, [
    ["  if (names.length === count + 1 && names[0] === CONNECTION_FD_NAME && stdinIsSocket) names = names.slice(1);\n", ""],
  ]],
  ["any left-over first name is dropped", KS, KS_SUITE, [["names[0] === CONNECTION_FD_NAME && ", ""]]],
  ["the left-over name is dropped whatever stdin is", KS, KS_SUITE, [[" && stdinIsSocket) names = names.slice(1);", ") names = names.slice(1);"]]],
  ["names past LISTEN_FDS are ignored", KS, KS_SUITE, [["  if (names.length !== count) {\n", "  if (names.length < count) {\n"]]],
  ["serve never says stdin is a socket", LAUNCH, KS_SUITE, [["{ stdinIsSocket: stdinIsSocket() }", "{ stdinIsSocket: false }"]]],
  // The pipe's wait between tries.
  ["the pipe waits the same between every try", KS, KS_SUITE, [["        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);\n", ""]]],
  ["the pipe gives up before the deadline", KS, KS_SUITE, [["        if (left <= 0) {\n", "        if (left < retryDelay) {\n"]]],
  // The plugin's empty key command.
  ["the empty key command stays in the pipe's environment", LAUNCH, KS_SUITE, [["  dropEmptyKeyCommand();\n", ""]]],
  ["a node that cannot run again goes to execve (which aborts)", LAUNCH, KS_SUITE, [["    accessSync(process.execPath, constants.X_OK);\n", ""]]],
  // The probe.
  ["the probe finishes the handshake", KS, KS_SUITE, [
    [
      "      socket.write(`${JSON.stringify(request)}\\n`);\n",
      "      socket.write(`${JSON.stringify(request)}\\n`);\n      socket.write(`${JSON.stringify({ jsonrpc: \"2.0\", method: \"notifications/initialized\" })}\\n`);\n",
    ],
  ]],
  ["the channel's probe takes any server", LAUNCH, KS_SUITE, [["  if (r.answered && target === \"channel\" && !r.channel) {\n", "  if (false) {\n"]]],
  ["the probe takes an error for an answer", KS, KS_SUITE, [
    ["        if (!message.result || typeof message.result !== \"object\") return finish({ answered: false, why: \"it answered initialize with an error\" });\n", ""],
  ]],
  // A mention the sender allowlist refused: recorded apart, bounded, never
  // moving the cursor or pushing a delivered id out.
  ["a refused mention is not recorded", RELAY, ALLOW_SUITE, [["if (this.allowsSettled()) this.rememberRefused(event);", "if (this.allowsSettled()) {}"]]],
  ["a refused mention is recorded as delivered", RELAY, ALLOW_SUITE, [["if (this.allowsSettled()) this.rememberRefused(event);", "if (this.allowsSettled()) this.remember(event);"]]],
  ["a refusal is kept while the file cannot be read", RELAY, ALLOW_SUITE, [["if (this.allowsSettled()) this.rememberRefused(event);", "if (true) this.rememberRefused(event);"]]],
  ["every no is settled", ALLOW, ALLOW_UNIT_SUITE, [["    return this.readCleanly;\n", "    return true;\n"]]],
  ["a refused id is never looked up", RELAY, ALLOW_SUITE, [["          if (this.state.hasRefused(id)) {\n", "          if (false) {\n"]]],
  ["refused ids go in with the delivered ones", STATE, STATE_SUITE, [
    ["    this.refused.set(event.id, [event.created_at, sender]);\n    this.pruneRefused(sender);\n    this.unsaved = true;\n", "    this.record(event);\n"],
  ]],
  ["no bound for one author", STATE, STATE_SUITE, [["    if (author !== undefined) {\n", "    if (false) {\n"]]],
  ["no bound in all", STATE, STATE_SUITE, [["    if (this.refused.size > MAX_REFUSED) {\n", "    if (false) {\n"]]],
  ["each refusal writes the file at once", STATE, STATE_SUITE, [["    this.unsaved = true;\n    if (this.saveTimer) return;\n", "    this.unsaved = true;\n    this.save();\n    if (this.saveTimer) return;\n"]]],
  ["the waiting refused ids are never written by the wait", STATE, STATE_SUITE, [["    }, this.refusedSaveMs);\n", "    }, 3_600_000);\n"]]],
  ["a stop does not write the waiting refused ids", CHANNEL, ALLOW_SUITE, [["    state.flush();\n", ""]]],
  ["refused ids are not kept across a restart", STATE, STATE_SUITE, [["    const body = JSON.stringify({ version: 1, cursor: this.cursor, seen: [...this.seen], refused });", "    const body = JSON.stringify({ version: 1, cursor: this.cursor, seen: [...this.seen] });"]]],
];

const COPY = tempDir("keyservice-mutants");
for (const part of ["src", "test", "package.json", "package-lock.json", "buzz-mcp.pin", "node_modules"]) {
  cpSync(join(ADAPTER, part), join(COPY, part), { recursive: true, verbatimSymlinks: true });
}

const count = (s, sub) => s.split(sub).length - 1;
let killed = 0;
const rows = [];
try {
  for (const [name, file, suite, pairs] of MUTANTS) {
    const path = join(COPY, file);
    const original = readFileSync(path, "utf8");
    const counts = pairs.map(([old]) => count(original, old));
    if (counts.some((n) => n !== 1)) {
      rows.push([name, `NOT APPLIED (${counts.join(",")} matches)`]);
      continue;
    }
    let text = original;
    for (const [old, now] of pairs) text = text.replace(old, () => now);
    writeFileSync(path, text);
    const r = spawnSync(process.execPath, ["--test", join(COPY, suite)], {
      cwd: COPY,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
      timeout: 600_000,
    });
    writeFileSync(path, original);
    const fails = (r.stdout.match(/^# fail (\d+)/m) || [])[1];
    if (r.status !== 0) {
      killed += 1;
      rows.push([name, `killed (${fails ?? "?"} failing)`]);
    } else {
      rows.push([name, "SURVIVED"]);
    }
  }
} finally {
  rmSync(COPY, { recursive: true, force: true });
}
for (const [name, res] of rows) console.log(`  ${name.padEnd(56)} ${res}`);
console.log(`mutants: ${killed}/${MUTANTS.length} killed`);
process.exit(killed === MUTANTS.length ? 0 : 1);
