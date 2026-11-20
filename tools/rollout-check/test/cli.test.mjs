// The real CLI as a process, with the real process runner, against folders that stand in for VMs: a stand-in ssh that runs the
// command it is given on this machine (what `ssh localhost` does), and stand-ins for the sha commands. Nothing leaves this machine.
// Run: node --test test/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { REMOTE_SCRIPT, remoteCommand } from "../lib.mjs";
import { PANE_PID, SESSION, TOOL, cleanUp, entry, proofFor, sha256, snapshot, tempDir } from "./helpers.mjs";

after(cleanUp);

const CLI = join(TOOL, "rollout-check");
const CLASS_MAIN = Buffer.from("# the class file on main\n");
const AGENTS_MAIN = Buffer.from("# AGENTS.md on main\n");

// The stand-in ssh: [options...] alias command, with the script on stdin. It records what it got, then acts as the alias's mode says.
const FAKE_SSH = `#!/bin/bash
args=("$@")
n=\${#args[@]}
alias=\${args[$((n-2))]}
cmd=\${args[$((n-1))]}
mkdir -p "$FAKE_DIR/log"
printf '%s\\n' "$@" >"$FAKE_DIR/log/$alias.argv"
cat >"$FAKE_DIR/log/$alias.stdin"
echo x >>"$FAKE_DIR/log/$alias.calls"
mode=$(cat "$FAKE_DIR/mode/$alias" 2>/dev/null || echo run)
case "$mode" in
  run) exec sh -c "$cmd" <"$FAKE_DIR/log/$alias.stdin" ;;
  fail) echo "ssh: connect to host $alias: Connection refused" >&2; exit 255 ;;
  hang) sleep 60 & echo $! >"$FAKE_DIR/log/$alias.sleep-pid"; wait ;;
  garbage) echo "<html>captive portal</html>"; exit 0 ;;
  flood) yes | head -c 3000000; exit 0 ;;
esac
`;

// The stand-in sha commands: the sha for <class> or <owner/repo> is the file main/class/<class> or main/agents/<owner_repo>.
const FAKE_SHA = (kind) => `#!/bin/bash
echo "$1" >>"$FAKE_DIR/log/${kind}-sha.calls"
cat "$FAKE_DIR/main/${kind === "class" ? "class" : "agents"}/\${1//\\//_}"
`;

const write = (path, content, mode) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content, mode ? { mode } : undefined);
};

/** A sandbox with the stand-ins and main's two files; vm(name, ...) adds an agent's VM and returns its config entry. */
function sandbox() {
  const dir = tempDir("cli");
  const s = { dir, bin: join(dir, "bin"), config: [], statePath: join(dir, "state.json") };
  write(join(s.bin, "fake-ssh"), FAKE_SSH, 0o755);
  write(join(s.bin, "class-sha"), FAKE_SHA("class"), 0o755);
  write(join(s.bin, "agents-sha"), FAKE_SHA("agents"), 0o755);
  mkdirSync(join(dir, "log"), { recursive: true });
  write(join(dir, "main", "class", "gp-builder"), `${sha256(CLASS_MAIN)}\n`);
  write(join(dir, "main", "agents", "o_team"), `${sha256(AGENTS_MAIN)}\n`);
  s.vm = (name, { mode = "run", class: cls = CLASS_MAIN, agents = AGENTS_MAIN, session = SESSION, panePid = String(PANE_PID), proof, team = true } = {}) => {
    const root = join(dir, "vms", name);
    const e = entry(name, { home: join(root, "home"), clone: join(root, "clone"), state_dir: join(root, "state"), ...(team ? {} : { team_repo: null, clone: null }) });
    for (const d of [e.home, join(root, "clone"), e.state_dir]) mkdirSync(d, { recursive: true });
    if (cls) writeFileSync(join(e.home, "CLAUDE.md"), cls);
    if (team && agents) writeFileSync(join(root, "clone", "AGENTS.md"), agents);
    if (session) writeFileSync(join(e.state_dir, "session-id"), `${session}\n`);
    if (panePid) writeFileSync(join(e.state_dir, "pane-pid"), `${panePid}\n`);
    const p = proof === undefined ? proofFor({ classSha: sha256(CLASS_MAIN), agentsSha: sha256(AGENTS_MAIN) }) : proof;
    if (p) writeFileSync(join(e.state_dir, "proof.json"), JSON.stringify(p));
    write(join(dir, "mode", e.ssh), mode);
    s.config.push(e);
    return e;
  };
  s.writeConfig = (config = s.config) => {
    s.configPath = join(dir, "config.json");
    writeFileSync(s.configPath, typeof config === "string" ? config : JSON.stringify(config));
    return s.configPath;
  };
  s.run = (extra = [], { env = {}, timeout = 60_000, config = true, replace = {} } = {}) => {
    if (config) s.writeConfig();
    const flags = { "--config": s.configPath, "--state": s.statePath, "--class-sha-cmd": join(s.bin, "class-sha"), "--agents-sha-cmd": join(s.bin, "agents-sha"), "--ssh": `${join(s.bin, "fake-ssh")} -o BatchMode=yes`, ...replace };
    const args = ["run", ...Object.entries(flags).flatMap(([k, v]) => [k, v]), ...extra];
    return s.exec(args, { env, timeout });
  };
  s.exec = (args, { env = {}, timeout = 60_000 } = {}) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout, env: { PATH: `${s.bin}:${process.env.PATH}`, FAKE_DIR: dir, HOME: dir, LANG: "C", ...env } });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  s.calls = (alias) => (existsSync(join(dir, "log", `${alias}.calls`)) ? readFileSync(join(dir, "log", `${alias}.calls`), "utf8").split("\n").filter(Boolean).length : 0);
  s.log = (name) => join(dir, "log", name);
  return s;
}

test("end to end: current, behind, not proved, unknown, and no team repo", () => {
  const s = sandbox();
  s.vm("a");
  s.vm("b", { class: "# an old class file\n" });
  s.vm("c", { proof: null });
  s.vm("d", { mode: "fail" });
  s.vm("e", { team: false, agents: null });
  const first = s.run();
  assert.equal(first.code, 0, first.err);
  assert.equal(first.out, "behind: b (class); not proved: c; unknown: d (ssh failed)\n");
  const second = s.run();
  assert.deepEqual(second, { code: 0, out: "", err: "" }, "the same set an hour later is silent");

  const table = JSON.parse(s.run(["--json"]).out);
  assert.deepEqual(table.agents.map((x) => [x.name, x.state]), [["a", "current"], ["b", "behind on disk"], ["c", "applied, not proved"], ["d", "unknown"], ["e", "current"]]);
  assert.equal(table.agents[0].proof.version, "0.9.1");
  assert.equal(table.agents[0].disk.class, sha256(CLASS_MAIN));
  assert.equal(table.agents[4].disk.agents, null);
  assert.equal(JSON.parse(readFileSync(s.statePath, "utf8")).agents.d.state, "unknown");
});

test("end to end: everyone current is silent, exit 0", () => {
  const s = sandbox();
  s.vm("a");
  s.vm("b", { team: false, agents: null });
  assert.deepEqual(s.run(), { code: 0, out: "", err: "" });
  assert.deepEqual(s.run(["--json"]).code, 0);
});

test("end to end: an old proof from a resume is not proved; a new one is current", () => {
  const s = sandbox();
  s.vm("a", { session: "1c2d3e4f-5061-4723-9b8c-0d1e2f3a4b5c" });
  assert.equal(s.run().out, "not proved: a\n");
  writeFileSync(join(s.config[0].state_dir, "session-id"), `${SESSION}\n`);
  assert.equal(s.run().out, "", "the file the session-id hook keeps current now names the proof's session");
});

test("end to end: a proof of another claude process, or beside no pane-pid, is not proved", () => {
  const s = sandbox();
  s.vm("a", { panePid: "5151" });
  s.vm("b", { panePid: null });
  s.vm("c", { proof: proofFor({ classSha: sha256(CLASS_MAIN), agentsSha: sha256(AGENTS_MAIN), extra: { claude_pid: undefined } }) });
  s.vm("d");
  const r = s.run();
  assert.equal(r.out, "not proved: a, b, c\n");
  const table = JSON.parse(s.run(["--json"]).out);
  assert.deepEqual(table.agents.map((x) => x.reason), ["proof is of another claude process", "no pane-pid beside the proof", "proof has no claude_pid", null]);
  assert.equal(table.agents[0].pane_pid, 5151);
  assert.equal(table.agents[0].proof.claude_pid, PANE_PID);
  writeFileSync(join(s.config[0].state_dir, "pane-pid"), `${PANE_PID}\n`);
  assert.equal(s.run().out, "not proved: b, c\n", "the pid the proof names is the pane's again");
});

test("end to end: a file that cannot be read is unknown, never behind or current", () => {
  if (process.getuid?.() === 0) return; // root reads it anyway
  const s = sandbox();
  s.vm("a");
  s.vm("b", { team: true });
  chmodSync(join(s.config[0].home, "CLAUDE.md"), 0o000);
  chmodSync(join(s.config[1].clone, "AGENTS.md"), 0o000);
  try {
    const r = s.run();
    assert.equal(r.out, "unknown: a (class file unreadable), b (agents file unreadable)\n");
    const table = JSON.parse(s.run(["--json"]).out);
    assert.deepEqual(table.agents.map((x) => [x.state, x.behind]), [["unknown", []], ["unknown", []]]);
    assert.equal(table.agents[0].disk.class, "unreadable");
  } finally {
    chmodSync(join(s.config[0].home, "CLAUDE.md"), 0o644);
    chmodSync(join(s.config[1].clone, "AGENTS.md"), 0o644);
  }
});

test("end to end: --json says what the line would be and whether a run would print it, and changes nothing", () => {
  const s = sandbox();
  s.vm("a", { proof: null });
  const before = JSON.parse(s.run(["--json"]).out);
  assert.equal(before.would_print, true);
  assert.equal(before.line, "not proved: a");
  assert.equal(existsSync(s.statePath), false);
  assert.equal(s.run().out, "not proved: a\n");
  const after = JSON.parse(s.run(["--json"]).out);
  assert.equal(after.would_print, false, "a run has said it");
  assert.equal(after.line, "not proved: a", "the line is there all the same");
  assert.equal(s.run().out, "");
});

test("end to end: a lost state file prints the line again", () => {
  const s = sandbox();
  s.vm("a", { proof: null });
  assert.equal(s.run().out, "not proved: a\n");
  assert.equal(s.run().out, "");
  writeFileSync(s.statePath, "");
  assert.equal(s.run().out, "not proved: a\n");
  writeFileSync(s.statePath, '{"schema":"ghost-protocol/rollout-check-state/v1"');
  assert.equal(s.run().out, "not proved: a\n");
});

test("the sha commands run once per distinct class and repo, as the last word", () => {
  const s = sandbox();
  s.vm("a");
  s.vm("b");
  s.vm("c", { team: false, agents: null });
  assert.equal(s.run().code, 0);
  assert.deepEqual(readFileSync(s.log("class-sha.calls"), "utf8").split("\n").filter(Boolean), ["gp-builder"]);
  assert.deepEqual(readFileSync(s.log("agents-sha.calls"), "utf8").split("\n").filter(Boolean), ["o/team"]);
});

test("a sha command that fails fails the run before any ssh", () => {
  const s = sandbox();
  s.vm("a");
  write(join(s.dir, "main", "class", "gp-builder"), "not a sha\n");
  const r = s.run();
  assert.equal(r.code, 2);
  assert.equal(r.out, "");
  assert.match(r.err, /class sha command for "gp-builder" did not print a sha256/);
  assert.equal(s.calls("a-vm"), 0);
  assert.equal(existsSync(s.statePath), false);
  const missing = s.run([], { replace: { "--class-sha-cmd": join(s.bin, "nope") } });
  assert.equal(missing.code, 2);
  assert.match(missing.err, /did not run/);
});

// ---------------------------------------------------------------------------------------------------------------------------
// It never writes to a VM.

test("it never writes to a VM: the stand-in ssh gets the fixed script once per agent, and nothing on the VMs changes", () => {
  const s = sandbox();
  s.vm("a");
  s.vm("b", { class: "# old\n" });
  s.vm("c", { proof: null, team: false, agents: null });
  const before = snapshot(join(s.dir, "vms"));
  const r = s.run();
  assert.equal(r.code, 0, r.err);
  s.run(["--json"]);
  assert.deepEqual(snapshot(join(s.dir, "vms")), before, "every file, folder and link on the VMs is as it was");
  for (const e of s.config) {
    assert.equal(s.calls(e.ssh), 2, `${e.name}: one call per run`);
    const argv = readFileSync(s.log(`${e.ssh}.argv`), "utf8").split("\n").slice(0, -1);
    assert.deepEqual(argv, ["-o", "BatchMode=yes", e.ssh, remoteCommand(e)], "options, the alias, and the one fixed command");
    assert.equal(readFileSync(s.log(`${e.ssh}.stdin`), "utf8"), REMOTE_SCRIPT, "the fixed script, and nothing else");
  }
});

test("the code has no way to copy, write or delete on a VM, to reach a network, or to read a key", () => {
  const code = readFileSync(join(TOOL, "lib.mjs"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /\b(scp|rsync|sftp)\b/);
  assert.doesNotMatch(code, /process\.env|SSH_AUTH_SOCK|id_rsa|id_ed25519|\.pem|BUZZ_|PRIVATE_KEY/, "no key and no environment is handled");
  assert.doesNotMatch(code, /node:(net|http|https|tls|dgram|dns)|fetch\(/, "no network of its own");
  assert.equal([...code.matchAll(/\bspawn\(/g)].length, 1, "one place starts a process");
  assert.doesNotMatch(code, /\b(exec|execFile|execSync|execFileSync|spawnSync|fork)\(/);
  assert.doesNotMatch(code, /shell:\s*true/);
  // The only reads are the config and the state file; the only writes are the state file and its temporary file.
  assert.equal([...code.matchAll(/readFileSync\(/g)].length, 2);
  assert.equal([...code.matchAll(/writeFileSync\(/g)].length, 1);
  assert.equal([...code.matchAll(/(?<![A-Za-z])(unlinkSync|appendFileSync|copyFileSync|chmodSync|symlinkSync|truncateSync)\(/g)].length, 0);
  assert.ok(readFileSync(join(TOOL, "rollout-check"), "utf8").split("\n").length < 12);
});

// ---------------------------------------------------------------------------------------------------------------------------
// A config value never reaches a shell.

test("a hostile config value stops the run before any ssh, and nothing it says runs", () => {
  const hostile = {
    name: "a; touch CANARY",
    ssh: "a-vm -oProxyCommand=touch CANARY",
    class: "gp-builder; touch CANARY",
    team_repo: "o/team$(touch CANARY)",
    home: "/tmp/x'; touch CANARY; '",
    clone: "/tmp/x`touch CANARY`",
    state_dir: "/tmp/x\ntouch CANARY",
  };
  for (const [key, value] of Object.entries(hostile)) {
    const s = sandbox();
    s.vm("a");
    s.config[0] = { ...s.config[0], [key]: value.replace("CANARY", join(s.dir, "CANARY")) };
    const r = s.run();
    assert.equal(r.code, 2, key);
    assert.match(r.err, new RegExp(`"${key}"`), key);
    assert.equal(r.out, "", key);
    assert.equal(s.calls("a-vm"), 0, `${key}: no ssh`);
    assert.equal(existsSync(join(s.dir, "CANARY")), false, `${key}: nothing ran`);
    assert.deepEqual(readdirSync(join(s.dir, "log")).filter((f) => f.endsWith("-sha.calls")), [], `${key}: not even a sha command`);
  }
});

test("a config that is not JSON, not there, or of the wrong shape fails the run before any ssh", () => {
  const s = sandbox();
  s.vm("a");
  for (const text of ["", "{", "null", "{}", "[]", '[{"name":"a"}]']) {
    s.writeConfig(text);
    const r = s.run([], { config: false });
    assert.equal(r.code, 2, text);
    assert.match(r.err, /^rollout-check: config/, text);
    assert.equal(r.out, "", text);
  }
  s.configPath = join(s.dir, "nope.json");
  assert.match(s.run([], { config: false }).err, /cannot read .* as JSON \(ENOENT\)/);
  assert.equal(s.calls("a-vm"), 0);
  writeFileSync(join(s.dir, "dup.json"), JSON.stringify([...s.config, ...s.config]));
  s.configPath = join(s.dir, "dup.json");
  assert.match(s.run([], { config: false }).err, /used by another agent/);
  assert.equal(s.calls("a-vm"), 0);
});

// ---------------------------------------------------------------------------------------------------------------------------
// ssh that goes wrong.

test("ssh that hangs is stopped after the timeout, with what it started, and the agent is unknown", () => {
  const s = sandbox();
  s.vm("a");
  s.vm("b", { mode: "hang" });
  const started = Date.now();
  const r = s.run(["--ssh-timeout", "1"], { timeout: 20_000 });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, "unknown: b (ssh timeout)\n");
  assert.ok(Date.now() - started < 15_000);
  const pid = Number(readFileSync(s.log("b-vm.sleep-pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the whole process group was stopped");
});

test("ssh that prints garbage, or far too much, is unknown", () => {
  const s = sandbox();
  s.vm("a", { mode: "garbage" });
  s.vm("b", { mode: "flood" });
  assert.equal(s.run().out, "unknown: a (unparseable output), b (output too large)\n");
});

test("a missing ssh program makes every agent unknown, never current", () => {
  const s = sandbox();
  s.vm("a");
  s.vm("b");
  const r = s.run([], { replace: { "--ssh": join(s.dir, "no-such-ssh") } });
  assert.equal(r.code, 0);
  assert.equal(r.out, "unknown: a (ssh failed), b (ssh failed)\n");
});

test("without --ssh, the default is ssh with BatchMode and a connect timeout", () => {
  const s = sandbox();
  s.vm("a");
  write(join(s.bin, "ssh"), '#!/bin/bash\nprintf \'%s\\n\' "$@" >"$FAKE_DIR/log/default-ssh.argv"\ncat >/dev/null\nexit 255\n', 0o755);
  s.writeConfig();
  const r = s.exec(["run", "--config", s.configPath, "--state", s.statePath, "--class-sha-cmd", join(s.bin, "class-sha"), "--agents-sha-cmd", join(s.bin, "agents-sha")]);
  assert.equal(r.out, "unknown: a (ssh failed)\n");
  assert.deepEqual(readFileSync(s.log("default-ssh.argv"), "utf8").split("\n").slice(0, 5), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "a-vm"]);
});

// ---------------------------------------------------------------------------------------------------------------------------
// The command line.

test("usage errors are exit 2 with the reason on stderr and nothing on stdout", () => {
  const s = sandbox();
  s.vm("a");
  s.writeConfig();
  const base = ["--config", s.configPath, "--state", s.statePath, "--class-sha-cmd", "x", "--agents-sha-cmd", "y"];
  const cases = {
    "an unknown command": [["go"], /unknown command "go"/],
    "no --config": [["run", ...base.slice(2)], /--config is required/],
    "no --state": [["run", ...base.slice(0, 2), ...base.slice(4)], /--state is required/],
    "no --class-sha-cmd": [["run", ...base.slice(0, 4), ...base.slice(6)], /--class-sha-cmd is required/],
    "no --agents-sha-cmd": [["run", ...base.slice(0, 6)], /--agents-sha-cmd is required/],
    "an unknown option": [["run", ...base, "--force"], /unknown option "--force"/],
    "a repeated option": [["run", ...base, "--state", "z"], /--state given twice/],
    "--json twice": [["run", ...base, "--json", "--json"], /--json given twice/],
    "a missing value": [["run", ...base, "--ssh"], /--ssh needs a value/],
    "a bad timeout": [["run", ...base, "--ssh-timeout", "0"], /--ssh-timeout must be 1 to 300/],
    "a timeout of words": [["run", ...base, "--ssh-timeout", "soon"], /--ssh-timeout must be 1 to 300/],
    "a timeout too long": [["run", ...base, "--ssh-timeout", "301"], /--ssh-timeout must be 1 to 300/],
    "an empty sha command": [["run", "--config", s.configPath, "--state", s.statePath, "--class-sha-cmd", " ", "--agents-sha-cmd", "y"], /--class-sha-cmd: empty command/],
  };
  for (const [why, [argv, pattern]] of Object.entries(cases)) {
    const r = s.exec(argv);
    assert.equal(r.code, 2, why);
    assert.match(r.err, pattern, why);
    assert.equal(r.out, "", why);
  }
  assert.equal(s.calls("a-vm"), 0);
});

test("--help prints the usage and exits 0; no arguments does too", () => {
  const s = sandbox();
  for (const argv of [["--help"], ["-h"], []]) {
    const r = s.exec(argv);
    assert.equal(r.code, 0);
    assert.match(r.out, /^usage: rollout-check run --config <file> --state <file> --class-sha-cmd <cmd> --agents-sha-cmd <cmd>/);
    assert.equal(r.err, "");
  }
});

test("the state file may be in a folder that is not there yet", () => {
  const s = sandbox();
  s.vm("a", { proof: null });
  s.statePath = join(s.dir, "deep", "er", "state.json");
  assert.equal(s.run().out, "not proved: a\n");
  assert.equal(existsSync(s.statePath), true);
});

// ---- the second version: a dry run writes nothing to any VM, --plan, and what this version cannot do ----

// Marks a sandbox's agents with roles: the config entries are changed in place, before the next run writes the config.
const withRoles = (s, roles) => {
  for (const e of s.config) Object.assign(e, roles[e.name] ?? {});
};

test("a dry run writes nothing to any VM, also when the state says an ack exists and an agent is behind, in every output mode", () => {
  const s = sandbox();
  s.vm("boss", { proof: null });
  s.vm("build", { class: "# old\n", agents: "# old\n" });
  s.vm("review", { proof: null });
  withRoles(s, { boss: { role: "lead", root: "/r", plugin_dir: "/p" }, build: { role: "builder", lead: "boss" }, review: { role: "reviewer", lead: "boss" } });
  // A drain ack that a later version would act on, and a journal with an action in it.
  const now = "2026-11-12T10:00:00Z";
  writeFileSync(s.statePath, JSON.stringify({ schema: "ghost-protocol/rollout-check-state/v2", updated: now, last_printed: now, signature: [], agents: {}, actions: [{ id: "a1", agent: "build", kind: "apply-class", intent_at: now }], drain: { boss: { request: "r1", ack: { at: now, vouched: ["boss", "build", "review"] } } } }));
  const before = snapshot(join(s.dir, "vms"));
  const runs = [s.run(), s.run(["--json"]), s.run(["--plan"])];
  for (const r of runs) assert.equal(r.code, 0, r.err);
  assert.deepEqual(snapshot(join(s.dir, "vms")), before, "every file, folder, link and time on the VMs is as it was");
  for (const e of s.config) {
    assert.equal(s.calls(e.ssh), 3, `${e.name}: one call per run`);
    assert.equal(readFileSync(s.log(`${e.ssh}.stdin`), "utf8"), REMOTE_SCRIPT, "the fixed script, and nothing else");
    assert.deepEqual(readFileSync(s.log(`${e.ssh}.argv`), "utf8").split("\n").slice(0, -1), ["-o", "BatchMode=yes", e.ssh, remoteCommand(e)]);
  }
  const state = JSON.parse(readFileSync(s.statePath, "utf8"));
  assert.equal(state.actions.length, 1, "the journal is carried, not changed");
  assert.equal(state.drain.boss.request, "r1", "and so is the drain record");
});

test("--plan through the real CLI: the plan on stdout, no state file, and the roles of the config at work", () => {
  const s = sandbox();
  s.vm("boss", { proof: null });
  s.vm("build", { proof: null });
  withRoles(s, { boss: { role: "lead", root: "/r", plugin_dir: "/p" }, build: { role: "builder", lead: "boss" } });
  const r = s.run(["--plan"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^rollout-check plan \(nothing is done: this version only reads\)\nboss \(lead\): applied, not proved \[no proof file\]\n {2}turn: no turn marker\n {2}would: restart it with start --fresh\n/);
  assert.match(r.out, /build \(builder\): applied, restarts at Done \[no proof file\] \(not in the printed line yet\)\n/);
  assert.match(r.out, /\n2 agents, 0 current\n$/);
  assert.equal(existsSync(s.statePath), false);
  assert.equal(s.run().out, "not proved: boss\n", "the line leaves out the builder");
});

test("--plan and --json are alternatives, and this version has no --act", () => {
  const s = sandbox();
  s.vm("a");
  const both = s.run(["--plan", "--json"]);
  assert.equal(both.code, 2);
  assert.match(both.err, /--json and --plan cannot be given together/);
  assert.equal(both.out, "");
  assert.equal(s.run(["--plan", "--plan"]).code, 2);
  for (const flag of ["--act", "--allow", "--max", "--init"]) {
    const r = s.run([flag, "1"]);
    assert.equal(r.code, 2, flag);
    assert.match(r.err, new RegExp(`unknown option "${flag}"`));
    assert.equal(r.out, "");
  }
  assert.equal(s.calls("a-vm"), 0, "none of them reached a VM");
});

test("the new modules are as pure as lib.mjs is careful: plan.mjs and states.mjs read nothing, write nothing and start nothing", () => {
  for (const file of ["plan.mjs", "states.mjs"]) {
    const code = readFileSync(join(TOOL, file), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /node:|process\.|require\(|\bspawn|readFileSync|writeFileSync|fetch\(|\bimport\(/, file);
    const imports = [...code.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]);
    assert.deepEqual(file === "plan.mjs" ? imports : [], file === "plan.mjs" ? ["./states.mjs"] : [], `${file} imports`);
  }
  const lib = readFileSync(join(TOOL, "lib.mjs"), "utf8");
  assert.deepEqual([...lib.matchAll(/^import .* from "(.*)";$/gm)].map((m) => m[1]), ["node:child_process", "node:fs", "node:path", "./plan.mjs", "./states.mjs"]);
});
