// The current session and the claude process: rollout-check reads them from the files the plugin's own hooks keep (session-id and
// pane-pid in the instance's state folder), and a proof counts only when it names that session and that process (its session_id
// and its claude_pid). If the hooks and this tool disagreed on where either lives, or on what a valid one is, the reading rule
// would break silently. So these tests run the real hooks (hooks/session-id, and hooks/load-proof once it is in the tree) in a
// throwaway home, under a stand-in for the instance's claude that lives as long as a session does, and hold the tool to what they
// leave behind.
//
// ROLLOUT_CHECK_PLUGIN=<a plugin folder> runs the hooks of that folder instead of this checkout's (the mutants run, and a check
// against another checkout of the plugin). ROLLOUT_CHECK_TEST_REQUIRE=1 turns a skip into a failure, as CI sets it.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { REMOTE_SCRIPT, SESSION_ID_RE, STATES, judge, parseRemote, validateConfig } from "../lib.mjs";
import { REPO, cleanUp, entry, sha256, tempDir } from "./helpers.mjs";

const PLUGIN = process.env.ROLLOUT_CHECK_PLUGIN || REPO;
const SESSION_HOOK = join(PLUGIN, "hooks", "session-id");
const PROOF_HOOK = join(PLUGIN, "hooks", "load-proof");
const TURN_HOOK = join(PLUGIN, "hooks", "turn-state");
const OLD = "0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b";
const NEW = "1c2d3e4f-5061-4723-9b8c-0d1e2f3a4b5c";
const NEXT = "2d3e4f50-6172-4834-8c9d-1e2f3a4b5c6d";

const have = (tool) => spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0;
const missing = ["bash", "jq", "git"].find((t) => !have(t));
if (missing && process.env.ROLLOUT_CHECK_TEST_REQUIRE) throw new Error(`ROLLOUT_CHECK_TEST_REQUIRE is set, and ${missing} is not on this machine`);
const needs = missing ? { skip: `no ${missing} on this machine` } : {};

const claudes = [];
after(() => {
  for (const c of claudes.splice(0)) stopClaude(c);
  cleanUp();
});

test("the session id is a UUID in the form the hook requires of it", () => {
  const line = readFileSync(SESSION_HOOK, "utf8").split("\n").find((l) => l.startsWith("re='"));
  assert.ok(line, "hooks/session-id sets re='...'");
  assert.equal(line.slice(4, -1), SESSION_ID_RE.source);
  if (existsSync(PROOF_HOOK)) {
    const own = readFileSync(PROOF_HOOK, "utf8").split("\n").find((l) => l.startsWith("re='"));
    assert.equal(own?.slice(4, -1), SESSION_ID_RE.source, "and so does hooks/load-proof");
  }
});

test("the hooks say the id is in session-id, the pid in pane-pid, and the proof in the same state folder", () => {
  const sessionHook = readFileSync(SESSION_HOOK, "utf8");
  assert.match(sessionHook, /state="\$\{XDG_STATE_HOME:-\$HOME\/\.local\/state\}\/ghost-protocol\/\$name"/);
  assert.match(sessionHook, /file="\$state\/session-id"/);
  if (existsSync(PROOF_HOOK)) {
    const proofHook = readFileSync(PROOF_HOOK, "utf8");
    assert.match(proofHook, /state="\$\{XDG_STATE_HOME:-\$home\/\.local\/state\}\/ghost-protocol\/\$name"/);
    assert.match(proofHook, /proof="\$state\/proof\.json"/);
    assert.match(proofHook, /claude_pid=\$\(tr -d '\[:space:\]' <"\$state\/pane-pid"/, "the pid is recorded as the script reads it: pane-pid, all white space removed");
  }
});

// A stand-in for the instance's claude that lives as long as a session: a script named claude (so that it is one to the hooks'
// process walk) that writes its pid where start writes the pane's, then runs, one at a time and as its children, the commands it is
// given. A hook run twice is run by the same claude, as in a session that is resumed or cleared.
const CLAUDE = `#!/bin/bash
trap ': >"$CTL/exited"' EXIT
printf '%s\\n' "$$" >"$PANE_FILE"
while [ ! -f "$CTL/stop" ]; do
  for c in "$CTL"/run.*; do
    [ -f "$c" ] || continue
    id=\${c##*run.}
    bash "$c" >"$CTL/out.$id" 2>&1 </dev/null
    echo $? >"$CTL/rc.$id"
    rm -f "$c"
    : >"$CTL/done.$id"
  done
  sleep 0.05
done
`;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitFor(path, what) {
  for (let i = 0; i < 1500; i++) {
    if (existsSync(path)) return;
    sleep(20);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function startClaude(sb) {
  const ctl = join(sb.root, `ctl${sb.claudes++}`);
  mkdirSync(ctl, { recursive: true });
  const bin = join(ctl, "claude");
  writeFileSync(bin, CLAUDE);
  chmodSync(bin, 0o755);
  rmSync(join(sb.state, "pane-pid"), { force: true });
  const child = spawn(bin, [], { detached: true, stdio: "ignore", env: { PATH: process.env.PATH, PANE_FILE: join(sb.state, "pane-pid"), CTL: ctl, HOME: sb.home } });
  child.unref();
  const claude = { child, ctl, runs: 0 };
  claudes.push(claude);
  waitFor(join(sb.state, "pane-pid"), "the stand-in claude to write its pid");
  sb.claude = claude;
  return claude;
}

function stopClaude(claude) {
  writeFileSync(join(claude.ctl, "stop"), "");
  // It says when it has gone (a process we started stays in the table until the event loop reaps it, so kill(pid, 0) would not).
  for (let i = 0; i < 200 && !existsSync(join(claude.ctl, "exited")); i++) sleep(20);
  if (existsSync(join(claude.ctl, "exited"))) return;
  try {
    process.kill(-claude.child.pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

/** A throwaway home with the instance, its team repo, the rulebook, the state folder and the instance's claude running. */
function sandbox() {
  const root = realpathSync(tempDir("hooks"));
  const home = join(root, "home");
  const inst = join(home, "work", "instance");
  const team = join(home, "work", "repos", "example", "team");
  const state = join(home, ".local", "state", "ghost-protocol", "instance");
  const projects = join(home, ".claude", "projects", "-work-instance");
  for (const d of [join(inst, ".ghost-protocol"), team, state, projects, join(home, ".claude", "rules"), join(root, "bin")]) mkdirSync(d, { recursive: true });
  copyFileSync(join(REPO, "install", "test", "fixtures", "manifests", "good-v1.toml"), join(inst, ".ghost-protocol", "instance.toml"));
  for (const d of [inst, team]) spawnSync("git", ["init", "-q", d]);
  spawnSync("git", ["-C", team, "remote", "add", "origin", "https://github.com/example/team.git"]);
  writeFileSync(join(inst, "CLAUDE.md"), "# Class file for the test\nsecond line\n");
  writeFileSync(join(team, "AGENTS.md"), "# AGENTS.md\nthe team rules\n");
  writeFileSync(join(home, ".claude", "rules", "team-repo.md"), "Intro.\n\n@~/work/repos/example/team/AGENTS.md\n");
  // What start writes: the session it launches.
  writeFileSync(join(state, "session-id"), `${OLD}\n`);
  writeFileSync(join(projects, `${OLD}.jsonl`), "{}\n");
  // A claude that is not the instance's: it writes no pane-pid, and is the first one a hook meets when it starts a hook.
  const stranger = join(root, "bin", "claude");
  writeFileSync(stranger, '#!/bin/bash\n"$@"\nexit $?\n');
  chmodSync(stranger, 0o755);
  const sb = { root, home, inst, team, state, projects, stranger, claudes: 0, claude: null };
  startClaude(sb);
  return sb;
}

/** A hook as Claude Code runs it at SessionStart, run by the instance's claude. */
function runHook(sb, hook, { source, session, env = {} }) {
  // The conversation's transcript is in the project folder by the time its hooks run.
  writeFileSync(join(sb.projects, `${session}.jsonl`), "{}\n");
  const claude = sb.claude;
  const id = ++claude.runs;
  writeFileSync(join(claude.ctl, `input.${id}`), JSON.stringify({ hook_event_name: "SessionStart", source, session_id: session, transcript_path: join(sb.projects, `${session}.jsonl`), cwd: sb.inst }));
  const exports = Object.entries({
    PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
    HOME: sb.home,
    LANG: "C",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_PROJECT_DIR: sb.inst,
    GP_INSTANCE_NAME: "instance",
    CLAUDE_PLUGIN_OPTION_LOAD_PROOF: "on",
    ...env,
  }).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`);
  writeFileSync(join(claude.ctl, `tmp.${id}`), `${exports.join("\n")}\nexec ${JSON.stringify(hook)} <${JSON.stringify(join(claude.ctl, `input.${id}`))}\n`);
  renameSync(join(claude.ctl, `tmp.${id}`), join(claude.ctl, `run.${id}`));
  waitFor(join(claude.ctl, `done.${id}`), `${hook} to finish`);
  assert.equal(readFileSync(join(claude.ctl, `rc.${id}`), "utf8").trim(), "0", readFileSync(join(claude.ctl, `out.${id}`), "utf8"));
  return readFileSync(join(claude.ctl, `out.${id}`), "utf8");
}

/** What this tool makes of the sandbox: the script run for real, then the judgement against `main`'s two files. */
function toolSees(sb, main) {
  const run = spawnSync("sh", ["-s", "--", sb.inst, sb.team, sb.state], { input: REMOTE_SCRIPT, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const remote = parseRemote(run.stdout);
  assert.notEqual(remote, null, run.stdout);
  const agent = validateConfig([entry("instance", { home: sb.inst, team_repo: "example/team", clone: sb.team, state_dir: sb.state })])[0];
  return { remote, verdict: judge(agent, main, remote) };
}
const mainOf = (sb) => ({ class: sha256(readFileSync(join(sb.inst, "CLAUDE.md"))), agents: sha256(readFileSync(join(sb.team, "AGENTS.md"))) });
const panePid = (sb) => Number(readFileSync(join(sb.state, "pane-pid"), "utf8").trim());

test("the id the tool reads is the one hooks/session-id keeps current, after a resume and a clear", needs, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  assert.equal(toolSees(sb, main).remote.sessionId, OLD, "what start wrote");
  runHook(sb, SESSION_HOOK, { source: "resume", session: NEW });
  assert.equal(readFileSync(join(sb.state, "session-id"), "utf8").trim(), NEW, "the hook moved it");
  assert.equal(toolSees(sb, main).remote.sessionId, NEW, "and the tool follows");
  runHook(sb, SESSION_HOOK, { source: "clear", session: NEXT });
  assert.equal(toolSees(sb, main).remote.sessionId, NEXT);
});

test("the pid the tool reads is the one start wrote to pane-pid, which the stand-in claude wrote as start does", needs, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  assert.equal(toolSees(sb, main).remote.panePid, sb.claude.child.pid);
  const old = sb.claude.child.pid;
  stopClaude(sb.claude);
  startClaude(sb);
  assert.notEqual(sb.claude.child.pid, old);
  assert.equal(toolSees(sb, main).remote.panePid, sb.claude.child.pid, "start rewrites it at every start of claude");
});

test("a start, a compaction or a stranger does not move the id, for the hook or the tool", needs, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  runHook(sb, SESSION_HOOK, { source: "startup", session: NEW });
  runHook(sb, SESSION_HOOK, { source: "compact", session: NEW });
  assert.equal(toolSees(sb, main).remote.sessionId, OLD);
  const stranger = spawnSync(sb.stranger, [SESSION_HOOK], {
    input: JSON.stringify({ source: "resume", session_id: NEW, transcript_path: join(sb.projects, `${NEW}.jsonl`) }),
    env: { PATH: process.env.PATH, HOME: sb.home, GP_INSTANCE_NAME: "instance" },
    encoding: "utf8",
  });
  assert.equal(stranger.status, 0);
  assert.equal(toolSees(sb, main).remote.sessionId, OLD, "a claude that is not the pane's moves nothing");
});

const proofHook = existsSync(PROOF_HOOK) ? needs : { skip: "hooks/load-proof is not in this tree yet" };
if (!existsSync(PROOF_HOOK) && process.env.ROLLOUT_CHECK_TEST_REQUIRE && process.env.ROLLOUT_CHECK_PLUGIN) throw new Error("ROLLOUT_CHECK_PLUGIN names a plugin with no hooks/load-proof");

test("hooks/load-proof's own proof.json, read by the tool: current, then not proved when only the id moved", proofHook, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  runHook(sb, PROOF_HOOK, { source: "startup", session: OLD });
  const proof = JSON.parse(readFileSync(join(sb.state, "proof.json"), "utf8"));
  assert.equal(proof.schema, "ghost-protocol/load-proof/v1");
  assert.equal(proof.session_id, OLD);
  assert.equal(proof.claude_pid, panePid(sb), "the proof names the pid in pane-pid");
  let seen = toolSees(sb, main);
  assert.equal(seen.verdict.state, STATES.CURRENT, seen.verdict.reason ?? "");
  assert.equal(seen.verdict.proof.current_session, true);
  assert.equal(seen.verdict.proof.claude_pid, panePid(sb));
  assert.equal(seen.verdict.pane_pid, panePid(sb));
  assert.equal(seen.verdict.proof.class_sha, main.class);
  assert.equal(seen.verdict.proof.agents_sha, main.agents);
  assert.equal(seen.verdict.proof.version, proof.plugin.version);
  assert.equal(seen.verdict.proof.commit, proof.plugin.commit);

  // A resume in which the id moved but no new proof was written: the old proof is of another session.
  runHook(sb, SESSION_HOOK, { source: "resume", session: NEW });
  seen = toolSees(sb, main);
  assert.equal(seen.verdict.state, STATES.NOT_PROVED);
  assert.equal(seen.verdict.reason, "proof is from another session");

  // The same resume with the proof hook run too: the proof is of the new session, and still of the same claude.
  runHook(sb, PROOF_HOOK, { source: "resume", session: NEW });
  seen = toolSees(sb, main);
  assert.equal(seen.verdict.state, STATES.CURRENT, seen.verdict.reason ?? "");
});

test("hooks/load-proof: a resume keeps the session id, and a new claude is told from the old by its pid", proofHook, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  runHook(sb, PROOF_HOOK, { source: "startup", session: OLD });
  assert.equal(toolSees(sb, main).verdict.state, STATES.CURRENT);
  // Start restarts claude with --resume <the same id>: a new pid in pane-pid, the same session id, and the last start's proof
  // still on disk until the new claude's hook has run (or for good, if it never does).
  stopClaude(sb.claude);
  startClaude(sb);
  let seen = toolSees(sb, main);
  assert.equal(readFileSync(join(sb.state, "session-id"), "utf8").trim(), OLD, "the session id did not move");
  assert.equal(seen.verdict.state, STATES.NOT_PROVED);
  assert.equal(seen.verdict.reason, "proof is of another claude process");
  runHook(sb, PROOF_HOOK, { source: "resume", session: OLD });
  seen = toolSees(sb, main);
  assert.equal(seen.verdict.state, STATES.CURRENT, seen.verdict.reason ?? "");
  assert.equal(JSON.parse(readFileSync(join(sb.state, "proof.json"), "utf8")).claude_pid, sb.claude.child.pid);
});

test("hooks/load-proof: a proof beside no pane-pid is not proved", proofHook, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  runHook(sb, PROOF_HOOK, { source: "startup", session: OLD });
  rmSync(join(sb.state, "pane-pid"));
  const seen = toolSees(sb, main);
  assert.equal(seen.verdict.state, STATES.NOT_PROVED);
  assert.equal(seen.verdict.reason, "no pane-pid beside the proof");
});

test("hooks/load-proof: a file changed after the proof is behind on disk; a start with the hook off leaves no proof", proofHook, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  runHook(sb, PROOF_HOOK, { source: "startup", session: OLD });
  writeFileSync(join(sb.team, "AGENTS.md"), "# AGENTS.md\nchanged on main later\n");
  let seen = toolSees(sb, main);
  assert.equal(seen.verdict.state, STATES.BEHIND, "main's file is the old one; the disk has moved on");
  // Main moves on too, and the disk has it, but the proof is of the older file.
  const later = mainOf(sb);
  seen = toolSees(sb, later);
  assert.equal(seen.verdict.state, STATES.NOT_PROVED);
  assert.equal(seen.verdict.reason, "proof shows another agents file");
  runHook(sb, PROOF_HOOK, { source: "startup", session: OLD, env: { CLAUDE_PLUGIN_OPTION_LOAD_PROOF: "off" } });
  assert.equal(existsSync(join(sb.state, "proof.json")), false);
  seen = toolSees(sb, later);
  assert.equal(seen.verdict.state, STATES.NOT_PROVED);
  assert.equal(seen.verdict.reason, "no proof file");
});

test("hooks/load-proof: with no rulebook the proof says agents: none, and a team repo makes that not proved", proofHook, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  writeFileSync(join(sb.home, ".claude", "rules", "team-repo.md"), "No import here.\n");
  runHook(sb, PROOF_HOOK, { source: "startup", session: OLD });
  assert.equal(JSON.parse(readFileSync(join(sb.state, "proof.json"), "utf8")).agents.status, "none");
  const seen = toolSees(sb, main);
  assert.equal(seen.verdict.state, STATES.NOT_PROVED);
  assert.equal(seen.verdict.reason, "proof shows no agents file");
  // The same proof proves an agent that has no team repo.
  const solo = validateConfig([entry("instance", { home: sb.inst, team_repo: null, clone: null, state_dir: sb.state })])[0];
  const run = spawnSync("sh", ["-s", "--", sb.inst, "", sb.state], { input: REMOTE_SCRIPT, encoding: "utf8" });
  assert.equal(judge(solo, { class: main.class, agents: null }, parseRemote(run.stdout)).state, STATES.CURRENT);
});

test("hooks/load-proof: a proof of a start that could not read the class file shows none for it", proofHook, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  rmSync(join(sb.inst, "CLAUDE.md"));
  runHook(sb, PROOF_HOOK, { source: "startup", session: OLD });
  const seen = toolSees(sb, main);
  assert.equal(seen.verdict.state, STATES.BEHIND);
  assert.deepEqual(seen.verdict.behind, ["class"]);
});

// ---- the turn marker: hooks/turn-state writes it, and the tool reads what that hook leaves ----

/** The turn hook as Claude Code runs it, run by the instance's claude: `payload` is the event's JSON beyond its name and session. */
function runTurnHook(sb, event, { session = OLD, payload = {}, env = {} } = {}) {
  const claude = sb.claude;
  const id = ++claude.runs;
  writeFileSync(join(claude.ctl, `input.${id}`), JSON.stringify({ hook_event_name: event, session_id: session, ...payload }));
  const exports = Object.entries({ PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: sb.home, LANG: "C", GP_INSTANCE_NAME: "instance", ...env }).map(([k, v]) => `export ${k}=${JSON.stringify(v)}`);
  writeFileSync(join(claude.ctl, `tmp.${id}`), `${exports.join("\n")}\nexec ${JSON.stringify(TURN_HOOK)} <${JSON.stringify(join(claude.ctl, `input.${id}`))}\n`);
  renameSync(join(claude.ctl, `tmp.${id}`), join(claude.ctl, `run.${id}`));
  waitFor(join(claude.ctl, `done.${id}`), "the turn hook to finish");
  assert.equal(readFileSync(join(claude.ctl, `rc.${id}`), "utf8").trim(), "0", readFileSync(join(claude.ctl, `out.${id}`), "utf8"));
  return readFileSync(join(claude.ctl, `out.${id}`), "utf8");
}
const turnOf = (sb, main) => toolSees(sb, main).remote.turn;

test("the turn the tool reads is the one hooks/turn-state keeps: busy at a prompt, idle at its Stop, and a new prompt id at the next", needs, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  assert.equal(turnOf(sb, main).state, "missing", "before any turn");
  runTurnHook(sb, "UserPromptSubmit", { payload: { prompt_id: "prompt-1" } });
  let turn = turnOf(sb, main);
  assert.deepEqual([turn.state, turn.promptId], ["busy", "prompt-1"]);
  assert.ok(turn.ageSeconds >= 0 && turn.ageSeconds < 30, `age ${turn.ageSeconds}`);
  runTurnHook(sb, "Stop", { payload: { prompt_id: "prompt-1" } });
  turn = turnOf(sb, main);
  assert.deepEqual([turn.state, turn.promptId], ["idle", "prompt-1"]);
  runTurnHook(sb, "UserPromptSubmit", { payload: { prompt_id: "prompt-2" } });
  runTurnHook(sb, "Stop", { payload: { prompt_id: "prompt-2" } });
  turn = turnOf(sb, main);
  assert.deepEqual([turn.state, turn.promptId], ["idle", "prompt-2"], "idle again, but not the idle of before: a later prompt is a different id");
});

test("a Stop of another prompt leaves the marker alone, StopFailure ends a turn, and a prompt with no id is -", needs, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  runTurnHook(sb, "UserPromptSubmit", { payload: { prompt_id: "p1" } });
  runTurnHook(sb, "Stop", { payload: { prompt_id: "p-other" } });
  assert.deepEqual([turnOf(sb, main).state, turnOf(sb, main).promptId], ["busy", "p1"]);
  runTurnHook(sb, "StopFailure", { payload: { prompt_id: "p1" } });
  assert.deepEqual([turnOf(sb, main).state, turnOf(sb, main).promptId], ["idle", "p1"]);
  runTurnHook(sb, "UserPromptSubmit", { payload: {} });
  assert.deepEqual([turnOf(sb, main).state, turnOf(sb, main).promptId], ["busy", "-"], "the hook writes - when Claude Code gave no id");
});

test("a subagent, a stranger and another conversation do not move the marker, and a /clear removes it", needs, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  runTurnHook(sb, "UserPromptSubmit", { payload: { prompt_id: "p1" } });
  runTurnHook(sb, "Stop", { payload: { prompt_id: "p1", agent_id: "sub-1" } });
  runTurnHook(sb, "UserPromptSubmit", { session: NEW, payload: { prompt_id: "p9" } });
  assert.deepEqual([turnOf(sb, main).state, turnOf(sb, main).promptId], ["busy", "p1"]);
  const stranger = spawnSync(sb.stranger, [TURN_HOOK], {
    input: JSON.stringify({ hook_event_name: "Stop", session_id: OLD, prompt_id: "p1" }),
    env: { PATH: `${dirname(process.execPath)}:${process.env.PATH}`, HOME: sb.home, GP_INSTANCE_NAME: "instance" },
    encoding: "utf8",
  });
  assert.equal(stranger.status, 0);
  assert.equal(turnOf(sb, main).state, "busy", "a claude that is not the pane's moves nothing");
  runHook(sb, SESSION_HOOK, { source: "clear", session: NEW });
  assert.equal(turnOf(sb, main).state, "missing", "the session hook removes the old conversation's marker");
});

test("the marker survives the tool's read: reading it changes nothing, and the verdict carries it", needs, () => {
  const sb = sandbox();
  const main = mainOf(sb);
  runTurnHook(sb, "UserPromptSubmit", { payload: { prompt_id: "p1" } });
  const file = join(sb.state, "turn");
  const before = readFileSync(file, "utf8");
  const verdict = toolSees(sb, main).verdict;
  assert.equal(readFileSync(file, "utf8"), before);
  assert.deepEqual([verdict.turn.state, verdict.turn.prompt_id], ["busy", "p1"]);
});
