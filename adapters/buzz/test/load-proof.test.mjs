// The load-proof hook (hooks/load-proof) against the fake relay: the real hook,
// run the way the instance's own claude runs it (a stand-in claude whose pid is
// in the start script's pane-pid), sends its line with the real one-shot send.
// What arrives on the relay, what proof.json says when the relay refuses, is
// down, never answers or is not reachable at all (a key service), and that
// nothing is sent, and no earlier proof.json touched, when the hook is not run
// by the instance's own claude. The hook's own cases (the files, the hashes, the
// line, the switches, the error classes) are install/test/hook-load-proof.test.sh.
//
// LOAD_PROOF_PLUGIN=<a plugin folder> runs the hook of that folder instead of
// this checkout's (test/load-proof-mutants.mjs breaks copies of it).
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { verifyEvent } from "nostr-tools/pure";
import { startFakeRelay } from "./fake-relay.mjs";
import { ADAPTER, identity, tempDir } from "./helpers.mjs";

const REPO = join(ADAPTER, "..", "..");
const PLUGIN = process.env.LOAD_PROOF_PLUGIN || REPO;
const HOOK = join(PLUGIN, "hooks", "load-proof");
const CHANNEL = "0000aaaa-1111-2222-3333-444455556666";
const SESSION = "0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b";
const have = (tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0;
const skip = ["bash", "jq", "git", "timeout"].find((t) => !have(t));
const opts = skip ? { skip: `no ${skip} on this machine` } : {};

const relays = [];
const folders = [];
after(async () => {
  for (const r of relays) await r.close?.();
  for (const f of folders) rmSync(f, { recursive: true, force: true });
});

async function relay(options) {
  const r = await startFakeRelay(options);
  relays.push(r);
  return r;
}

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** A throwaway HOME with the instance, the team repo, the rulebook and the stand-in claude. */
function sandbox({ classFile = "# Class file for the test\nsecond line\n" } = {}) {
  const root = realpathSync(tempDir("load-proof"));
  folders.push(root);
  const home = join(root, "home");
  const inst = join(home, "work", "instance");
  const team = join(home, "work", "repos", "example", "team");
  const state = join(home, ".local", "state", "ghost-protocol", "instance");
  const rules = join(home, ".claude", "rules");
  for (const d of [join(inst, ".ghost-protocol"), team, state, rules, join(root, "bin")]) mkdirSync(d, { recursive: true });
  copyFileSync(join(REPO, "install", "test", "fixtures", "manifests", "good-v1.toml"), join(inst, ".ghost-protocol", "instance.toml"));
  for (const d of [inst, team]) spawnSync("git", ["init", "-q", d]);
  spawnSync("git", ["-C", team, "remote", "add", "origin", "https://github.com/example/team.git"]);
  writeFileSync(join(inst, "CLAUDE.md"), classFile);
  writeFileSync(join(team, "AGENTS.md"), "# AGENTS.md\nthe team rules\n");
  writeFileSync(join(rules, "team-repo.md"), "Intro.\n\n@~/work/repos/example/team/AGENTS.md\n");
  // The stand-in for the instance's claude: it writes its pid where start writes the pane's, and runs its arguments as a child.
  const claude = join(root, "bin", "claude");
  writeFileSync(claude, '#!/bin/bash\nif [ -n "${PANE_FILE:-}" ]; then printf \'%s\\n\' "$$" >"$PANE_FILE"; fi\nunset PANE_FILE\n"$@"\nexit $?\n');
  chmodSync(claude, 0o755);
  return { root, home, inst, team, state, claude, classPath: join(inst, "CLAUDE.md"), agentsPath: join(team, "AGENTS.md"), proof: join(state, "proof.json") };
}

/** The hook as Claude Code runs it at SessionStart; `by` is who runs it: the instance's own claude, a claude it started, or nobody. */
function runHook(sb, { by = "own", env = {}, source = "startup", session = SESSION } = {}) {
  const argv = by === "own" ? [sb.claude, HOOK] : by === "nested" ? [sb.claude, sb.claude, HOOK] : [HOOK];
  const input = JSON.stringify({ hook_event_name: "SessionStart", source, session_id: session, cwd: sb.inst });
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), {
      env: {
        PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
        HOME: sb.home,
        LANG: "C",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        CLAUDE_PROJECT_DIR: sb.inst,
        GP_INSTANCE_NAME: "instance",
        CLAUDE_PLUGIN_OPTION_LOAD_PROOF: "on",
        PANE_FILE: join(sb.state, "pane-pid"),
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr, seconds: (Date.now() - started) / 1000 }));
    child.stdin.end(input);
  });
}

/** The plugin options of an instance that posts to `r` with `key`. */
function posting(r, key, extra = {}) {
  return {
    CLAUDE_PLUGIN_OPTION_LOAD_PROOF_CHANNEL: CHANNEL,
    CLAUDE_PLUGIN_OPTION_BUZZ_RELAY_URL: r.url,
    CLAUDE_PLUGIN_OPTION_BUZZ_KEY_COMMAND: `printf %s ${key.hex}`,
    ...extra,
  };
}

const proofOf = (sb) => JSON.parse(readFileSync(sb.proof, "utf8"));
const lineFor = (sb, classFirst = "# Class file for the test") =>
  `load-proof instance session ${SESSION.slice(0, 8)}: class ${sha(sb.classPath).slice(0, 12)} "${classFirst}"; agents example/team ${sha(sb.agentsPath).slice(0, 12)} "# AGENTS.md"`;

test("the line arrives once on the relay, exactly, as a channel message signed by the agent's key; proof.json says posted", opts, async () => {
  const r = await relay();
  const key = identity();
  const sb = sandbox();
  const result = await runHook(sb, { env: posting(r, key) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "nothing printed into the session when the post went through");
  assert.equal(r.stats.events.length, 1);
  const event = r.stats.events[0];
  assert.ok(verifyEvent(event));
  assert.equal(event.kind, 9);
  assert.equal(event.pubkey, key.pubkey);
  assert.equal(event.content, lineFor(sb));
  assert.deepEqual(event.tags.filter((t) => t[0] === "h"), [["h", CHANNEL]]);
  assert.deepEqual(event.tags.filter((t) => t[0] === "p" || t[0] === "e"), [], "it mentions nobody and is a root");
  const proof = proofOf(sb);
  assert.equal(proof.posted, true);
  assert.equal(proof.error, null);
  assert.equal(proof.session_id, SESSION);
  assert.equal(proof.claude_pid, Number(readFileSync(join(sb.state, "pane-pid"), "utf8").trim()), "the pid start wrote to pane-pid");
  assert.equal(proof.class.sha256, sha(sb.classPath));
  assert.equal(proof.agents.sha256, sha(sb.agentsPath));
  assert.equal(proof.agents.repo, "example/team");
  assert.equal(proof.plugin.version, JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version);
  for (const text of [readFileSync(sb.proof, "utf8"), event.content, result.stdout, result.stderr]) {
    assert.ok(!text.includes(key.hex) && !text.includes(key.nsec), "the key is in no file, line or output");
  }
  assert.ok(!event.content.includes(sb.home), "no path of the machine in the line");
});

test("a heading that tries to forge the line or mention someone arrives cleaned", opts, async () => {
  const r = await relay();
  const key = identity();
  const other = identity();
  const heading = `# Hi" ; agents evil/repo deadbeefdead "forged \`x\` nostr:${other.npub} ‮​\u0007\u001b[31m`;
  const sb = sandbox({ classFile: `${heading}\nbody\n` });
  const result = await runHook(sb, { env: posting(r, key) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(r.stats.events.length, 1);
  const { content, tags } = r.stats.events[0];
  assert.ok(!/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩`]/.test(content), "no control, zero-width, direction or backtick character");
  assert.equal(content.split('"').length - 1, 4, "the quotes that hold the two first lines are the only ones");
  assert.equal(content.split("\n").length, 1);
  assert.deepEqual(tags.filter((t) => t[0] === "p"), [], "text mentions nobody: only a p tag does");
  assert.ok(content.startsWith(`load-proof instance session ${SESSION.slice(0, 8)}: class ${sha(sb.classPath).slice(0, 12)} "# Hi' ; agents evil/repo deadbeefdead 'forged x nostr:`));
});

test("a relay that refuses the message: the file is true, posted false (refused), one line printed", opts, async () => {
  const r = await relay();
  r.hooks.refuseEvents = "restricted: not a member of this channel";
  const key = identity();
  const sb = sandbox();
  const result = await runHook(sb, { env: posting(r, key) });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "load proof written; not posted: the relay refused the message\n");
  const proof = proofOf(sb);
  assert.equal(proof.posted, false);
  assert.equal(proof.error, "refused");
  assert.equal(proof.class.sha256, sha(sb.classPath));
  assert.equal(proof.agents.sha256, sha(sb.agentsPath));
  assert.ok(!result.stdout.includes("restricted"), "the relay's own words are not shown");
});

test("a relay that refuses the login: posted false (relay), nothing published", opts, async () => {
  const r = await relay();
  r.hooks.refuseAuth = true;
  const sb = sandbox();
  const result = await runHook(sb, { env: posting(r, identity()) });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "load proof written; not posted: the relay could not be reached, or refused the login\n");
  assert.equal(proofOf(sb).error, "relay");
  assert.equal(r.stats.events.length, 0);
});

test("no relay there: posted false (relay), the file still written", opts, async () => {
  const r = await relay();
  const url = r.url;
  r.setRefuse(true);
  const sb = sandbox();
  const result = await runHook(sb, { env: posting({ url }, identity()) });
  assert.equal(result.status, 0);
  assert.equal(proofOf(sb).error, "relay");
  assert.equal(proofOf(sb).posted, false);
  assert.equal(proofOf(sb).class.status, "ok");
});

test("a relay that never answers: the hook is back inside its timeout, the file says not posted", opts, async () => {
  const r = await relay();
  r.hooks.silentEvents = true;
  const sb = sandbox();
  const result = await runHook(sb, { env: posting(r, identity()) });
  assert.equal(result.status, 0);
  assert.ok(result.seconds < 9, `back after ${result.seconds} seconds`);
  const proof = proofOf(sb);
  assert.equal(proof.posted, false);
  assert.ok(["relay", "timeout"].includes(proof.error), proof.error);
  assert.match(result.stdout, /^load proof written; not posted: /);
});

test("a key service (buzz_key_socket): the relay is never contacted, the file says key-service", opts, async () => {
  const r = await relay();
  const sb = sandbox();
  const result = await runHook(sb, { env: posting(r, identity(), { CLAUDE_PLUGIN_OPTION_BUZZ_KEY_SOCKET: join(sb.root, "keys") }) });
  assert.equal(result.status, 0);
  assert.equal(r.stats.connections, 0);
  const proof = proofOf(sb);
  assert.equal(proof.posted, false);
  assert.equal(proof.error, "key-service");
  assert.equal(proof.class.sha256, sha(sb.classPath));
  assert.match(result.stdout, /^load proof written; not posted: the session holds no key/);
});

test("no channel: the file only, the relay is never contacted, nothing printed", opts, async () => {
  const r = await relay();
  const sb = sandbox();
  const result = await runHook(sb, { env: posting(r, identity(), { CLAUDE_PLUGIN_OPTION_LOAD_PROOF_CHANNEL: "" }) });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(r.stats.connections, 0);
  assert.equal(proofOf(sb).error, "no-channel");
});

for (const by of ["nested", "bare"]) {
  test(`run by ${by === "nested" ? "a claude the instance's claude started" : "no claude at all"}: nothing is sent, and an earlier proof.json stays as it was`, opts, async () => {
    const r = await relay();
    const sb = sandbox();
    const before = '{"old":"proof"}\n';
    writeFileSync(sb.proof, before);
    const result = await runHook(sb, { by, env: posting(r, identity()) });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(r.stats.connections, 0);
    assert.equal(readFileSync(sb.proof, "utf8"), before);
  });
}

test("an earlier start's proof is replaced by this start's, whatever it said", opts, async () => {
  const r = await relay();
  const key = identity();
  const sb = sandbox();
  writeFileSync(sb.proof, JSON.stringify({ session_id: SESSION, class: { sha256: "0".repeat(64) }, posted: true }));
  const result = await runHook(sb, { env: posting(r, key), source: "resume" });
  assert.equal(result.status, 0, result.stderr);
  const proof = proofOf(sb);
  assert.equal(proof.source, "resume");
  assert.equal(proof.class.sha256, sha(sb.classPath));
  assert.equal(r.stats.events.length, 1);
});
