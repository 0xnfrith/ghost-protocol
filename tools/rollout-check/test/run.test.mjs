// A whole run in this process, with fakes for the processes (ssh and the sha commands), the clock and the VMs: the line, what
// moves it, the state file, --json, and what fails the run. Run: node --test test/*.test.mjs
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { AT_DONE_QUIET_MS, REMIND_MS, REMOTE_SCRIPT, STATES, STATE_SCHEMA, formatLine, isQuiet, readState, remoteCommand, runCheck, signatureOf, validateConfig } from "../lib.mjs";
import { HOUR, SESSION2, SHA, capture, cleanUp, currentRemote, entry, makeClock, makeWorld, options, ok, proofFor, renderRemote, tempDir } from "./helpers.mjs";

after(cleanUp);

const MAIN = { class: SHA("a"), agents: SHA("b") };

/** A world of agents a..: `vms` maps a name to what its VM prints (default: fully current). */
function setup(names, { vms = {}, config, run: extra = {} } = {}) {
  const dir = tempDir("run");
  const configured = config ?? names.map((n) => entry(n));
  const world = makeWorld({ vms: Object.fromEntries(configured.map((c) => [c.ssh, vms[c.name] ?? currentRemote(c, MAIN)])) });
  const clock = makeClock();
  const statePath = join(dir, "state", "rollout.json");
  const ctx = { dir, world, clock, statePath, config: configured, vms };
  ctx.go = async (extraOptions = {}) => {
    const out = capture();
    const code = await runCheck(options(ctx.config, statePath, { ...extra, ...extraOptions }), { run: world.run, now: clock.now, stdout: out.stdout, stderr: out.stderr });
    return { code, out: out.out, err: out.err };
  };
  ctx.state = () => JSON.parse(readFileSync(statePath, "utf8"));
  ctx.setVm = (name, value) => {
    world.vms[`${name}-vm`] = value;
  };
  return ctx;
}

const behindClass = () => renderRemote({ classDisk: SHA("c"), agentsDisk: MAIN.agents, proof: proofFor({ classSha: MAIN.class, agentsSha: MAIN.agents }) });
const behindBoth = () => renderRemote({ classDisk: SHA("c"), agentsDisk: SHA("d") });
const behindAgents = () => renderRemote({ classDisk: MAIN.class, agentsDisk: SHA("d"), proof: proofFor({ classSha: MAIN.class, agentsSha: MAIN.agents }) });
const notProved = () => renderRemote({ classDisk: MAIN.class, agentsDisk: MAIN.agents, proof: null });

test("everyone current: no output, exit 0, and the state records it", async () => {
  const c = setup(["a", "b", "c"]);
  const r = await c.go();
  assert.deepEqual(r, { code: 0, out: "", err: "" });
  const state = c.state();
  assert.equal(state.schema, STATE_SCHEMA);
  assert.deepEqual(state.signature, []);
  assert.equal(state.last_printed, null);
  assert.deepEqual(Object.keys(state.agents), ["a", "b", "c"]);
  for (const a of Object.values(state.agents)) {
    assert.equal(a.state, STATES.CURRENT);
    assert.equal(a.since, "2026-11-12T10:00:00Z");
    assert.equal(a.disk.class, MAIN.class);
  }
});

test("the line names who is behind, not proved or unknown, in that order", async () => {
  const c = setup(["a", "b", "c", "d", "e", "f", "g", "h"], {
    vms: { a: behindClass(), b: behindAgents(), c: behindBoth(), d: notProved(), e: { status: "timeout", code: null, stdout: "" }, f: { status: "ok", code: 255, stdout: "" }, h: "garbage" },
  });
  const r = await c.go();
  assert.equal(r.code, 0);
  assert.equal(r.out, "behind: a (class), b (agents), c (class and agents); not proved: d; unknown: e (ssh timeout), f (ssh failed), h (unparseable output)\n");
  assert.equal(r.err, "");
});

test("a line has only the sections that have someone", async () => {
  assert.equal((await setup(["a", "b"], { vms: { b: notProved() } }).go()).out, "not proved: b\n");
  assert.equal((await setup(["a", "b"], { vms: { a: behindClass() } }).go()).out, "behind: a (class)\n");
  assert.equal((await setup(["a", "b"], { vms: { b: "garbage" } }).go()).out, "unknown: b (unparseable output)\n");
});

test("unknown is never current: ssh fails, times out, prints garbage, too much, or is cut short", async () => {
  const cut = currentRemote(entry("a"), MAIN).split("\n").slice(0, 5).join("\n");
  const cases = {
    "ssh exit 255": { status: "ok", code: 255, stdout: "" },
    "ssh exit 1 with good output": { status: "ok", code: 1, stdout: currentRemote(entry("a"), MAIN) },
    "ssh killed by a signal": { status: "ok", code: null, stdout: currentRemote(entry("a"), MAIN) },
    "timed out": { status: "timeout", code: null, stdout: currentRemote(entry("a"), MAIN) },
    "too much output": { status: "too-large", code: null, stdout: currentRemote(entry("a"), MAIN) },
    "could not be started": { status: "failed", code: null, stdout: "" },
    "garbage with exit 0": { status: "ok", code: 0, stdout: "<html>captive portal</html>" },
    "cut short": { status: "ok", code: 0, stdout: cut },
    "nothing": { status: "ok", code: 0, stdout: "" },
  };
  for (const [why, vm] of Object.entries(cases)) {
    const c = setup(["a"], { vms: { a: vm } });
    const r = await c.go();
    assert.match(r.out, /^unknown: a \(/, why);
    assert.equal(c.state().agents.a.state, STATES.UNKNOWN, why);
    assert.deepEqual(c.state().signature, ["a:unknown"], why);
    const table = JSON.parse((await c.go({ json: true })).out);
    assert.equal(table.all_current, false, why);
    assert.equal(table.agents[0].state, STATES.UNKNOWN, why);
    assert.equal(table.agents[0].proof, null, why);
  }
  // The reasons.
  const reason = async (vm) => (await setup(["a"], { vms: { a: vm } }).go()).out.trim();
  assert.equal(await reason(cases["timed out"]), "unknown: a (ssh timeout)");
  assert.equal(await reason(cases["too much output"]), "unknown: a (output too large)");
  assert.equal(await reason(cases["ssh exit 255"]), "unknown: a (ssh failed)");
  assert.equal(await reason(cases["could not be started"]), "unknown: a (ssh failed)");
  assert.equal(await reason(cases["cut short"]), "unknown: a (unparseable output)");
});

test("a VM we cannot reach at all is unknown (no entry in the fake's table)", async () => {
  const c = setup(["a"]);
  c.world.vms = {};
  assert.equal((await c.go()).out, "unknown: a (ssh failed)\n");
});

test("one ssh call per agent, with the fixed script on stdin and the arguments quoted", async () => {
  const c = setup(["a", "b"], { config: [entry("a"), entry("b", { team_repo: null, clone: null })] });
  await c.go();
  assert.equal(c.world.ssh.length, 2);
  for (const call of c.world.ssh) {
    const agent = c.config.find((x) => x.ssh === call.alias);
    assert.deepEqual(call.argv, ["fake-ssh", "-o", "BatchMode=yes", agent.ssh, remoteCommand(agent)]);
    assert.equal(call.input, REMOTE_SCRIPT);
    assert.equal(call.timeoutMs, 30_000);
  }
  assert.match(c.world.ssh[1].command, /^sh -s -- '\/home\/b' '' '\//);
  const timed = setup(["a"]);
  await timed.go({ sshTimeoutSecs: 7 });
  assert.equal(timed.world.ssh[0].timeoutMs, 7000);
});

test("the default ssh command is used when none is given", async () => {
  const c = setup(["a"]);
  const out = capture();
  const seen = [];
  await runCheck({ ...options(c.config, c.statePath), sshCmd: undefined }, {
    run: async (argv, o) => (argv[0] === "ssh" ? (seen.push(argv), { status: "ok", code: 255, stdout: "", stderr: "" }) : c.world.run(argv, o)),
    now: c.clock.now,
    stdout: out.stdout,
    stderr: out.stderr,
  });
  assert.deepEqual(seen[0].slice(0, 5), ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
  assert.equal(seen[0][5], "a-vm");
});

test("each sha command runs once per distinct class and repo, before any ssh", async () => {
  const config = [
    entry("a"),
    entry("b"),
    entry("c", { class: "gp-lead", team_repo: "o/other" }),
    entry("d", { class: "gp-lead", team_repo: null, clone: null }),
    entry("e", { class: "gp-builder", team_repo: "o/other" }),
  ];
  const world = makeWorld({ classes: { "gp-builder": MAIN.class, "gp-lead": SHA("c") }, repos: { "o/team": MAIN.agents, "o/other": SHA("d") } });
  const c = setup([], { config });
  const mains = { "gp-builder": MAIN.class, "gp-lead": SHA("c") };
  const repos = { "o/team": MAIN.agents, "o/other": SHA("d") };
  for (const a of config) world.vms[a.ssh] = currentRemote(a, { class: mains[a.class], agents: a.team_repo === null ? null : repos[a.team_repo] });
  const out = capture();
  const code = await runCheck(options(config, c.statePath), { run: world.run, now: c.clock.now, stdout: out.stdout, stderr: out.stderr });
  assert.equal(code, 0);
  assert.equal(out.out, "");
  assert.deepEqual(world.sha, [["class-sha", "gp-builder"], ["agents-sha", "o/team"], ["class-sha", "gp-lead"], ["agents-sha", "o/other"]]);
  const firstSsh = world.calls.findIndex((x) => x.argv[0] === "fake-ssh");
  assert.equal(world.calls.slice(0, firstSsh).length, 4, "the sha commands all come before the first ssh");
  assert.equal(world.ssh.length, 5);
});

test("the agents sha command is not run when no agent has a team repo", async () => {
  const c = setup([], { config: [entry("a", { team_repo: null, clone: null })] });
  assert.equal((await c.go()).code, 0);
  assert.deepEqual(c.world.sha, [["class-sha", "gp-builder"]]);
});

test("the sha commands' words are split, with the class or repo as the last word", async () => {
  const c = setup(["a"]);
  c.world.shaResult = (argv) => ok(`${argv[0] === "class-sha" ? MAIN.class : MAIN.agents}\n`);
  await c.go({ classShaCmd: "class-sha --branch main", agentsShaCmd: "agents-sha  --branch main" });
  assert.deepEqual(c.world.sha, [["class-sha", "--branch", "main", "gp-builder"], ["agents-sha", "--branch", "main", "o/team"]]);
});

test("a failing sha command fails the run: exit 2, the reason on stderr, no line, no ssh, no state", async () => {
  const cases = {
    "exits non-zero": [{ status: "ok", code: 1, stdout: "", stderr: "fatal: no such file\nmore\n" }, 'failed \\(exit 1\\): fatal: no such file$'],
    "times out": [{ status: "timeout", code: null, stdout: "" }, "timed out$"],
    "does not run": [{ status: "failed", code: null, stdout: "" }, "did not run$"],
    "prints nothing": [ok(""), "did not print a sha256"],
    "prints a short sha": [ok(`${SHA("a").slice(1)}\n`), "did not print a sha256"],
    "prints a long sha": [ok(`${SHA("a")}a\n`), "did not print a sha256"],
    "prints a git blob id": [ok(`${"a".repeat(40)}\n`), "did not print a sha256"],
    "prints two lines": [ok(`${SHA("a")}\n${SHA("a")}\n`), "did not print a sha256"],
    "prints sha256sum's form": [ok(`${SHA("a")}  -\n`), "did not print a sha256"],
    "prints words": [ok("main\n"), "did not print a sha256"],
  };
  const what = { "class-sha": ["class", "gp-builder"], "agents-sha": ["agents", "o/team"] };
  for (const [why, [result, suffix]] of Object.entries(cases)) {
    for (const which of ["class-sha", "agents-sha"]) {
      const c = setup(["a", "b"]);
      c.world.shaResult = (argv) => (argv[0] === which ? result : ok(`${argv[0] === "class-sha" ? MAIN.class : MAIN.agents}\n`));
      const r = await c.go();
      const label = `${which}: ${why}`;
      assert.equal(r.code, 2, label);
      assert.equal(r.out, "", label);
      assert.match(r.err, new RegExp(`^rollout-check: ${what[which][0]} sha command for "${what[which][1]}" ${suffix}`, "m"), label);
      assert.equal(c.world.ssh.length, 0, `${label}: no ssh`);
      assert.equal(existsSync(c.statePath), false, `${label}: no state`);
    }
  }
});

test("a sha in upper case or with white space around it is taken, in lower case", async () => {
  const c = setup(["a"]);
  c.world.shaResult = (argv) => ok(`  ${(argv[0] === "class-sha" ? MAIN.class : MAIN.agents).toUpperCase()}\r\n\n`);
  assert.deepEqual(await c.go(), { code: 0, out: "", err: "" });
});

test("a failing run changes nothing: an existing state file is left as it was", async () => {
  const c = setup(["a"], { vms: { a: notProved() } });
  await c.go();
  const before = readFileSync(c.statePath, "utf8");
  c.world.shaResult = () => ({ status: "ok", code: 1, stdout: "", stderr: "" });
  assert.equal((await c.go()).code, 2);
  assert.equal(readFileSync(c.statePath, "utf8"), before);
});

test("agents are judged in the config's order however slowly their VMs answer", async () => {
  const names = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
  const vms = Object.fromEntries(names.map((n, i) => [n, async () => (await new Promise((r) => setTimeout(r, (names.length - i) * 4)), notProved())]));
  const c = setup(names, { vms });
  assert.equal((await c.go()).out, `not proved: ${names.join(", ")}\n`);
  assert.equal(c.world.ssh.length, names.length);
});

test("only a few ssh calls run at a time", async () => {
  const names = Array.from({ length: 20 }, (_, i) => `n${i}`);
  let active = 0;
  let most = 0;
  const vms = Object.fromEntries(names.map((n) => [n, async () => (active++, (most = Math.max(most, active)), await new Promise((r) => setTimeout(r, 5)), active--, notProved())]));
  const c = setup(names, { vms });
  await c.go();
  assert.ok(most > 1 && most <= 6, `at most 6 at a time, saw ${most}`);
});

// ---------------------------------------------------------------------------------------------------------------------------
// When the line is printed.

test("the line is printed when the set changes, and not while it stays the same", async () => {
  const c = setup(["a", "b", "c"], { vms: { a: behindClass() } });
  assert.equal((await c.go()).out, "behind: a (class)\n");
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "", "the same set an hour later");
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "");

  c.setVm("b", notProved());
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "behind: a (class); not proved: b\n", "someone else joins");
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "");

  c.setVm("a", behindBoth());
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "behind: a (class and agents); not proved: b\n", "the same agent, behind in more");
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "");

  c.setVm("a", notProved());
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "not proved: a, b\n", "behind becomes not proved");
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "");

  c.setVm("a", currentRemote(c.config[0], MAIN));
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "not proved: b\n", "one recovers: the set shrank, and that is a change");
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "");

  c.setVm("b", currentRemote(c.config[1], MAIN));
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "", "everyone current: silence");
  assert.deepEqual(c.state().signature, []);

  c.setVm("c", behindAgents());
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "behind: c (agents)\n", "behind again after a clean run");
});

test("a set that shrinks is a change, whichever agent leaves it", async () => {
  for (const leaver of ["a", "b", "c"]) {
    const names = ["a", "b", "c"];
    const c = setup(names, { vms: { a: notProved(), b: notProved(), c: notProved() } });
    await c.go();
    c.setVm(leaver, currentRemote(entry(leaver), MAIN));
    c.clock.advance(HOUR);
    const left = names.filter((n) => n !== leaver);
    assert.equal((await c.go()).out, `not proved: ${left.join(", ")}\n`, leaver);
  }
});

test("a different reason for the same state is not a change; a different state is", async () => {
  const c = setup(["a"], { vms: { a: { status: "timeout", code: null, stdout: "" } } });
  assert.equal((await c.go()).out, "unknown: a (ssh timeout)\n");
  c.setVm("a", { status: "ok", code: 255, stdout: "" });
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "");
  c.setVm("a", "garbage");
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "");
  c.setVm("a", notProved());
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "not proved: a\n");
});

test("the order of the config does not make a change", async () => {
  const names = ["a", "b"];
  const c = setup(names, { vms: { a: notProved(), b: behindClass() } });
  await c.go();
  c.config.reverse();
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "");
});

test("an agent added to the config, or removed, changes the set only if it is not current", async () => {
  const c = setup(["a", "b"], { vms: { a: notProved() } });
  await c.go();
  c.config.push(entry("z"));
  c.setVm("z", currentRemote(entry("z"), MAIN));
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "", "a current agent joins");
  assert.ok(c.state().agents.z);
  c.config.pop();
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "");
  assert.equal(c.state().agents.z, undefined, "and is dropped from the state when it leaves");
  c.config.shift();
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "", "the one that was not proved leaves: nothing is wrong, nothing is said");
});

test("a reminder comes once a day while the set stays the same", async () => {
  const c = setup(["a"], { vms: { a: notProved() } });
  assert.equal((await c.go()).out, "not proved: a\n");
  const minute = 60 * 1000;
  c.clock.advance(23 * HOUR);
  assert.equal((await c.go()).out, "", "23 hours");
  c.clock.advance(49 * minute);
  assert.equal((await c.go()).out, "", "23 hours 49 minutes");
  c.clock.advance(1 * minute);
  assert.equal((await c.go()).out, "not proved: a\n", "24 hours less ten minutes: the reminder");
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "", "and then silence again");
  c.clock.advance(22 * HOUR);
  assert.equal((await c.go()).out, "", "23 hours after the reminder: a day counts from the reminder");
  c.clock.advance(50 * minute);
  assert.equal((await c.go()).out, "not proved: a\n", "the next day's");
  assert.equal(REMIND_MS, 24 * HOUR);
});

test("a change that is printed starts the day again", async () => {
  const c = setup(["a", "b"], { vms: { a: notProved() } });
  await c.go();
  c.clock.advance(20 * HOUR);
  c.setVm("b", notProved());
  assert.equal((await c.go()).out, "not proved: a, b\n");
  c.clock.advance(20 * HOUR);
  assert.equal((await c.go()).out, "", "20 hours after the change, not 40 after the first line");
  c.clock.advance(4 * HOUR);
  assert.equal((await c.go()).out, "not proved: a, b\n");
});

test("a quiet stretch with everyone current does not owe a reminder, and does not hide the next line", async () => {
  const c = setup(["a"], { vms: { a: notProved() } });
  await c.go();
  c.setVm("a", currentRemote(entry("a"), MAIN));
  c.clock.advance(2 * HOUR);
  assert.equal((await c.go()).out, "");
  c.setVm("a", notProved());
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "not proved: a\n");
});

// ---------------------------------------------------------------------------------------------------------------------------
// A lost state file hides nothing.

const lost = {
  "no file": () => {},
  "an empty file": (p) => writeFileSync(p, ""),
  "not JSON": (p) => writeFileSync(p, "{not json"),
  "JSON of another shape": (p) => writeFileSync(p, "[1,2,3]"),
  null: (p) => writeFileSync(p, "null"),
  "another schema": (p) => writeFileSync(p, JSON.stringify({ schema: "other/v9", signature: ["a:not-proved"], last_printed: "2026-11-12T10:00:00Z", agents: {} })),
  "no signature": (p) => writeFileSync(p, JSON.stringify({ schema: STATE_SCHEMA, last_printed: "2026-11-12T10:00:00Z", agents: {} })),
  "a signature that is not a list of strings": (p) => writeFileSync(p, JSON.stringify({ schema: STATE_SCHEMA, signature: [1], last_printed: "2026-11-12T10:00:00Z", agents: {} })),
  "a signature that is a string": (p) => writeFileSync(p, JSON.stringify({ schema: STATE_SCHEMA, signature: "a:not-proved", last_printed: "2026-11-12T10:00:00Z", agents: {} })),
  "a signature that is a one-character string": (p) => writeFileSync(p, JSON.stringify({ schema: STATE_SCHEMA, signature: "x", last_printed: "2026-11-12T10:00:00Z", agents: {} })),
  "a signature that is an object with a length": (p) => writeFileSync(p, JSON.stringify({ schema: STATE_SCHEMA, signature: { length: 1 }, last_printed: "2026-11-12T10:00:00Z", agents: {} })),
  "a signature but no time of the last line": (p) => writeFileSync(p, JSON.stringify({ schema: STATE_SCHEMA, signature: ["a:not-proved"], last_printed: null, agents: {} })),
  "a time that is not a time": (p) => writeFileSync(p, JSON.stringify({ schema: STATE_SCHEMA, signature: ["a:not-proved"], last_printed: "yesterday", agents: {} })),
  "a time in the future": (p) => writeFileSync(p, JSON.stringify({ schema: STATE_SCHEMA, signature: ["a:not-proved"], last_printed: "2027-01-01T00:00:00Z", agents: {} })),
  "a folder": (p) => mkdirSync(p, { recursive: true }),
  "a file nobody can read": (p) => {
    writeFileSync(p, "{}");
    chmodSync(p, 0o000);
  },
};

for (const [why, damage] of Object.entries(lost)) {
  test(`the line is printed when the state file is lost: ${why}`, async () => {
    const c = setup(["a"], { vms: { a: notProved() } });
    mkdirSync(join(c.dir, "state"), { recursive: true });
    damage(c.statePath);
    if (why === "a file nobody can read" && process.getuid?.() === 0) return; // root reads it anyway
    const r = await c.go();
    assert.equal(r.out, "not proved: a\n");
    assert.equal(r.code, 0);
  });
}

test("a state file that was fine, then lost, prints the line again; it is not the same set to a missing record", async () => {
  const c = setup(["a"], { vms: { a: notProved() } });
  await c.go();
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "");
  writeFileSync(c.statePath, "");
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "not proved: a\n");
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "", "and the file is whole again");
});

test("a lost state file with everyone current is still silent", async () => {
  const c = setup(["a"]);
  mkdirSync(join(c.dir, "state"), { recursive: true });
  writeFileSync(c.statePath, "garbage");
  assert.equal((await c.go()).out, "");
});

test("readState: a good file is read, a bad one is no state", () => {
  const dir = tempDir("read");
  const path = join(dir, "s.json");
  assert.equal(readState(path), null);
  writeFileSync(path, JSON.stringify({ schema: STATE_SCHEMA, signature: ["a:unknown"], last_printed: "2026-11-12T10:00:00Z", agents: { a: { state: STATES.UNKNOWN, since: "2026-11-12T09:00:00Z" }, b: { state: "weird", since: "2026-11-12T09:00:00Z" }, c: { state: STATES.CURRENT, since: "x" }, constructor: 5 } }));
  const s = readState(path);
  assert.deepEqual(s.signature, ["a:unknown"]);
  assert.deepEqual(Object.keys(s.agents), ["a"]);
  assert.equal(s.agents.constructor, undefined);
});

// ---------------------------------------------------------------------------------------------------------------------------
// The state file.

test("the state file holds each agent's state, the shas seen, since, and when the line was last printed", async () => {
  const c = setup(["a", "b"], { vms: { a: behindClass() } });
  await c.go();
  const s = c.state();
  assert.equal(s.updated, "2026-11-12T10:00:00Z");
  assert.equal(s.last_printed, "2026-11-12T10:00:00Z");
  assert.deepEqual(s.signature, ["a:behind:class"]);
  assert.equal(s.agents.a.state, STATES.BEHIND);
  assert.deepEqual(s.agents.a.behind, ["class"]);
  assert.equal(s.agents.a.disk.class, SHA("c"));
  assert.equal(s.agents.a.disk.agents, MAIN.agents);
  assert.equal(s.agents.a.proof.class_sha, MAIN.class);
  assert.equal(s.agents.a.proof.current_session, true);
  assert.equal(s.agents.b.state, STATES.CURRENT);
  assert.equal(s.agents.b.checked, "2026-11-12T10:00:00Z");
});

test("since is when the agent's state last changed", async () => {
  const c = setup(["a", "b"], { vms: { a: notProved() } });
  await c.go();
  c.clock.advance(HOUR);
  await c.go();
  assert.equal(c.state().agents.a.since, "2026-11-12T10:00:00Z", "unchanged");
  assert.equal(c.state().agents.a.checked, "2026-11-12T11:00:00Z");
  c.setVm("a", behindClass());
  c.clock.advance(HOUR);
  await c.go();
  assert.equal(c.state().agents.a.since, "2026-11-12T12:00:00Z", "changed");
  assert.equal(c.state().agents.b.since, "2026-11-12T10:00:00Z", "the other did not");
  c.setVm("a", behindBoth());
  c.clock.advance(HOUR);
  await c.go();
  assert.equal(c.state().agents.a.since, "2026-11-12T12:00:00Z", "still behind: the state is the same");
});

test("the state file is replaced in one step: no temporary file is left, and it is private", async () => {
  const c = setup(["a"], { vms: { a: notProved() } });
  await c.go();
  const first = statSync(c.statePath).ino;
  await c.go();
  assert.notEqual(statSync(c.statePath).ino, first, "a new file takes the place of the old one, not a write into it");
  assert.deepEqual(readdirSync(join(c.dir, "state")), ["rollout.json"]);
  assert.equal(statSync(c.statePath).mode & 0o777, 0o600);
});

test("a state file that cannot be put in place leaves no temporary file, and the old one stays", async () => {
  const c = setup(["a"], { vms: { a: notProved() } });
  mkdirSync(join(c.statePath, "inside"), { recursive: true }); // a folder where the file goes
  const r = await c.go();
  assert.match(r.err, /could not write the state file/);
  assert.deepEqual(readdirSync(join(c.dir, "state")), ["rollout.json"]);
  assert.deepEqual(readdirSync(c.statePath), ["inside"]);
});

test("the state file's folder is made when it is not there", async () => {
  const c = setup(["a"]);
  assert.equal(existsSync(join(c.dir, "state")), false);
  await c.go();
  assert.equal(existsSync(c.statePath), true);
});

test("a state file that cannot be written does not hide the line, and is said on stderr", async () => {
  const c = setup(["a"], { vms: { a: notProved() } });
  writeFileSync(join(c.dir, "state"), "a file where the folder should be");
  const r = await c.go();
  assert.equal(r.code, 0);
  assert.equal(r.out, "not proved: a\n");
  assert.match(r.err, /^rollout-check: could not write the state file: \w+\n$/);
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "not proved: a\n", "with no state, it is printed every run");
});

test("the line is written before the state", async () => {
  const c = setup(["a"], { vms: { a: notProved() } });
  const order = [];
  const out = capture();
  await runCheck(options(c.config, c.statePath), {
    run: c.world.run,
    now: c.clock.now,
    stdout: { write: (s) => order.push(["line", s]) },
    stderr: out.stderr,
    readState: () => null,
    writeState: () => order.push(["state"]),
  });
  assert.deepEqual(order.map((o) => o[0]), ["line", "state"]);
});

// ---------------------------------------------------------------------------------------------------------------------------
// --json.

test("--json prints the full table, and no line", async () => {
  const c = setup(["a", "b", "c"], { vms: { a: behindClass(), b: notProved(), c: { status: "timeout", code: null, stdout: "" } } });
  c.clock.advance(5 * 60 * 1000);
  const r = await c.go({ json: true });
  assert.equal(r.code, 0);
  const table = JSON.parse(r.out);
  assert.equal(table.generated, "2026-11-12T10:05:00Z");
  assert.equal(table.all_current, false);
  assert.deepEqual(table.agents.map((a) => [a.name, a.state]), [["a", STATES.BEHIND], ["b", STATES.NOT_PROVED], ["c", STATES.UNKNOWN]]);
  const a = table.agents[0];
  assert.deepEqual(a.behind, ["class"]);
  assert.equal(a.ssh, "a-vm");
  assert.equal(a.class, "gp-builder");
  assert.equal(a.team_repo, "o/team");
  assert.equal(a.since, "2026-11-12T10:05:00Z");
  assert.deepEqual(a.expected, MAIN);
  assert.equal(a.disk.class, SHA("c"));
  assert.equal(a.proof.version, "0.9.1");
  assert.equal(a.proof.commit, "c".repeat(40));
  assert.equal(table.agents[1].reason, "no proof file");
  assert.equal(table.agents[2].reason, "ssh timeout");
});

test("--json says what the line would be and whether a run would print it", async () => {
  const c = setup(["a", "b"], { vms: { a: notProved() } });
  let table = JSON.parse((await c.go({ json: true })).out);
  assert.equal(table.would_print, true);
  assert.equal(table.line, "not proved: a");
  assert.equal(table.all_current, false);
  await c.go();
  c.clock.advance(HOUR);
  table = JSON.parse((await c.go({ json: true })).out);
  assert.equal(table.would_print, false, "the set is the same as the one a run said");
  assert.equal(table.line, "not proved: a", "and the line is still what it is");
  c.clock.advance(23 * HOUR);
  assert.equal(JSON.parse((await c.go({ json: true })).out).would_print, true, "a day on, the reminder is due");
  c.setVm("b", behindClass());
  c.clock.advance(HOUR);
  assert.equal(JSON.parse((await c.go({ json: true })).out).line, "behind: b (class); not proved: a");
  // Asking changes nothing: a real run now says it.
  assert.equal((await c.go()).out, "behind: b (class); not proved: a\n");
});

test("--json of a run where everyone is current: no line, nothing to print", async () => {
  const c = setup(["a"]);
  const table = JSON.parse((await c.go({ json: true })).out);
  assert.equal(table.line, null);
  assert.equal(table.would_print, false);
  assert.equal(table.all_current, true);
  assert.equal(existsSync(c.statePath), false, "and with no state file either");
});

test("--json carries the pid the pane has and the pid the proof names", async () => {
  const c = setup(["a"]);
  const a = JSON.parse((await c.go({ json: true })).out).agents[0];
  assert.equal(a.pane_pid, 4242);
  assert.equal(a.proof.claude_pid, 4242);
});

test("a file that cannot be read is unknown in the line, and a sha256 tool that is not there too", async () => {
  const c = setup(["a", "b", "c"], {
    vms: {
      a: renderRemote({ classDisk: "unreadable", agentsDisk: MAIN.agents, proof: proofFor({ classSha: MAIN.class, agentsSha: MAIN.agents }) }),
      b: renderRemote({ classDisk: "no-sha256", agentsDisk: "no-sha256", proof: proofFor({ classSha: MAIN.class, agentsSha: MAIN.agents }) }),
      c: renderRemote({ classDisk: MAIN.class, agentsDisk: "unreadable" }),
    },
  });
  const r = await c.go();
  assert.equal(r.out, "unknown: a (class file unreadable), b (no sha256 tool), c (agents file unreadable)\n");
  assert.deepEqual(c.state().signature, ["a:unknown", "b:unknown", "c:unknown"]);
  assert.equal(c.state().agents.a.state, STATES.UNKNOWN);
});

test("a proof of another claude process is not proved, in the line and in the state", async () => {
  const c = setup(["a", "b"], { vms: { a: renderRemote({ classDisk: MAIN.class, agentsDisk: MAIN.agents, panePid: "5151", proof: proofFor({ classSha: MAIN.class, agentsSha: MAIN.agents }) }) } });
  assert.equal((await c.go()).out, "not proved: a\n");
  assert.equal(c.state().agents.a.state, STATES.NOT_PROVED);
});

test("--json says all_current when they are", async () => {
  const c = setup(["a"]);
  assert.equal(JSON.parse((await c.go({ json: true })).out).all_current, true);
});

test("--json writes no state and uses up no line or reminder", async () => {
  const c = setup(["a"], { vms: { a: notProved() } });
  await c.go({ json: true });
  assert.equal(existsSync(c.statePath), false, "no file made");
  assert.equal((await c.go()).out, "not proved: a\n", "the first real run still prints");
  const before = readFileSync(c.statePath, "utf8");
  c.clock.advance(HOUR);
  c.setVm("a", behindClass());
  await c.go({ json: true });
  assert.equal(readFileSync(c.statePath, "utf8"), before, "the file is as it was");
  assert.equal((await c.go()).out, "behind: a (class)\n", "and the change is still to be said");
});

test("--json takes its since from the state file", async () => {
  const c = setup(["a"], { vms: { a: notProved() } });
  await c.go();
  c.clock.advance(3 * HOUR);
  assert.equal(JSON.parse((await c.go({ json: true })).out).agents[0].since, "2026-11-12T10:00:00Z");
});

test("--json of a run whose sha command fails is no table", async () => {
  const c = setup(["a"]);
  c.world.shaResult = () => ({ status: "ok", code: 1, stdout: "", stderr: "" });
  const r = await c.go({ json: true });
  assert.equal(r.code, 2);
  assert.equal(r.out, "");
});

test("a bug in a fake is a failed run, not a crash: exit 2 with the message", async () => {
  const c = setup(["a"]);
  const out = capture();
  const code = await runCheck(options(c.config, c.statePath), { run: () => Promise.reject(new Error("boom")), now: c.clock.now, stdout: out.stdout, stderr: out.stderr });
  assert.equal(code, 2);
  assert.match(out.err, /internal error: boom/);
  assert.equal(out.out, "");
});

test("validateConfig's agents are what a run takes, and a bad option is a failure", async () => {
  const c = setup(["a"]);
  const bad = async (extra) => {
    const out = capture();
    const code = await runCheck(options(c.config, c.statePath, extra), { run: c.world.run, now: c.clock.now, stdout: out.stdout, stderr: out.stderr });
    return { code, ...out };
  };
  assert.equal((await bad({ sshCmd: "  " })).code, 2);
  assert.equal((await bad({ classShaCmd: "" })).code, 2);
  assert.equal((await bad({ agentsShaCmd: "" })).code, 2);
  assert.equal(c.world.calls.length, 0);
  assert.equal(validateConfig([entry("a")]).length, 1);
  assert.equal(SESSION2.length, 36);
});

// ---- the second version: roles, the quiet state, --plan, and the state file that carries more ----
const DAY = 24 * HOUR;
const builderConfig = (names, extra = {}) => names.map((n) => entry(n, { role: "builder", ...extra }));

test("applied, restarts at Done: shown by --json from the first hour, and left out of the line until it has lasted 3 days", async () => {
  const c = setup(["a", "b"], { config: [entry("a"), entry("b", { role: "builder" })], vms: { b: notProved() } });
  const first = await c.go();
  assert.deepEqual(first, { code: 0, out: "", err: "" }, "nothing is printed the first hour");
  const table = JSON.parse((await c.go({ json: true })).out);
  const b = table.agents.find((x) => x.name === "b");
  assert.equal(b.state, STATES.AT_DONE);
  assert.equal(b.quiet, true);
  assert.equal(b.reason, "no proof file");
  assert.equal(table.all_current, false, "it is not current");
  assert.equal(table.line, null, "and says nothing in the line");
  assert.equal(table.would_print, false);
  // Every hour up to 71 hours: still silent.
  for (let h = 1; h <= 71; h++) {
    c.clock.advance(HOUR);
    assert.equal((await c.go()).out, "", `hour ${h}`);
  }
  c.clock.advance(HOUR - 60_000);
  assert.equal((await c.go()).out, "", "a minute before the 3 days are up");
  c.clock.advance(60_000);
  const day3 = await c.go();
  assert.equal(day3.out, "waiting for Done: b\n", "at 3 days, to the second");
  c.clock.advance(HOUR);
  assert.equal((await c.go()).out, "", "and it is not printed again the next hour");
  assert.equal(c.state().agents.b.state, STATES.AT_DONE);
  assert.equal(c.state().agents.b.since, "2026-11-12T10:00:00Z", "it has been in the state since the first run");
});

test("the quiet state is in the table's rows for every reader: --json says quiet, and the line says what is not quiet", async () => {
  const c = setup(["a", "b", "c"], { config: [entry("a", { role: "lead" }), entry("b", { role: "builder", lead: "a" }), entry("c", { role: "reviewer", lead: "a" })], vms: { a: notProved(), b: notProved(), c: behindClass() } });
  const r = await c.go();
  assert.equal(r.out, "behind: c (class); not proved: a\n", "b is quiet; a lead's not-proved is not");
  const table = JSON.parse((await c.go({ json: true })).out);
  assert.deepEqual(table.agents.map((x) => [x.name, x.state, x.quiet]), [["a", STATES.NOT_PROVED, false], ["b", STATES.AT_DONE, true], ["c", STATES.BEHIND, false]]);
  assert.equal(table.line, "behind: c (class); not proved: a");
});

test("after 3 days the line names it with the others, in its place: after not proved and before unknown", async () => {
  const c = setup(["a", "b", "c", "d"], { config: [entry("a", { role: "lead" }), entry("b", { role: "builder", lead: "a" }), entry("c", { role: "reviewer", lead: "a" }), entry("d")], vms: { a: notProved(), b: notProved(), c: notProved(), d: "garbage" } });
  await c.go();
  c.clock.advance(3 * DAY);
  assert.equal((await c.go()).out, "not proved: a; waiting for Done: b, c; unknown: d (unparseable output)\n");
});

test("a builder that was not proved before it had a role keeps its time: the 3 days count from when it first was not proved", async () => {
  const c = setup(["b"], { config: [entry("b", { role: "builder" })], vms: { b: notProved() } });
  mkdirSync(join(c.dir, "state"), { recursive: true });
  const old = new Date(Date.parse("2026-11-12T10:00:00Z") - 5 * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
  writeFileSync(c.statePath, JSON.stringify({ schema: "ghost-protocol/rollout-check-state/v1", updated: old, last_printed: old, signature: ["b:not-proved"], agents: { b: { state: STATES.NOT_PROVED, since: old } } }));
  const r = await c.go();
  assert.equal(r.out, "waiting for Done: b\n", "five days, not one hour");
  assert.equal(c.state().agents.b.since, old);
  // And the other way round: a role taken off keeps its time too.
  const d = setup(["b"], { vms: { b: notProved() } });
  await d.go();
  d.clock.advance(2 * DAY);
  d.ctx = d;
  const asBuilder = await runCheck(options([entry("b", { role: "builder" })], d.statePath), { run: d.world.run, now: d.clock.now, stdout: capture().stdout, stderr: capture().stderr });
  assert.equal(asBuilder, 0);
  assert.equal(JSON.parse(readFileSync(d.statePath, "utf8")).agents.b.since, "2026-11-12T10:00:00Z");
});

test("a change of state other than that resets the time", async () => {
  const c = setup(["b"], { config: [entry("b", { role: "builder" })], vms: { b: notProved() } });
  await c.go();
  c.clock.advance(2 * DAY);
  c.setVm("b", behindClass());
  await c.go();
  c.clock.advance(HOUR);
  c.setVm("b", notProved());
  await c.go();
  assert.equal(c.state().agents.b.since, "2026-11-14T11:00:00Z", "it was behind in between, so it starts over");
});

test("isQuiet, signatureOf and formatLine: the 3 days are to the millisecond, and only for applied, restarts at Done", () => {
  const row = (state, since) => ({ name: "x", state, behind: [], reason: null, since });
  const at = Date.parse("2026-11-12T10:00:00Z");
  const since = "2026-11-09T10:00:01Z";
  assert.equal(AT_DONE_QUIET_MS, 3 * DAY);
  assert.equal(isQuiet(row(STATES.AT_DONE, since), at), true, "one second short");
  assert.equal(isQuiet(row(STATES.AT_DONE, "2026-11-09T10:00:00Z"), at), false, "exactly 3 days");
  assert.equal(isQuiet(row(STATES.AT_DONE, "2026-11-09T09:59:59Z"), at), false);
  for (const state of [STATES.NOT_PROVED, STATES.BEHIND, STATES.UNKNOWN, STATES.CURRENT]) assert.equal(isQuiet(row(state, since), at), false, state);
  assert.equal(isQuiet(row(STATES.AT_DONE, since)), false, "no clock: not quiet");
  assert.equal(isQuiet(row(STATES.AT_DONE, undefined), at), false, "no time to count from: not quiet");
  assert.equal(isQuiet(row(STATES.AT_DONE, "not a time"), at), false);
  assert.deepEqual(signatureOf([row(STATES.AT_DONE, since)], at), []);
  assert.deepEqual(signatureOf([row(STATES.AT_DONE, "2026-11-09T10:00:00Z")], at), ["x:at-done"]);
  assert.equal(formatLine([row(STATES.AT_DONE, "2026-11-09T10:00:00Z")], at), "waiting for Done: x");
  assert.equal(formatLine([row(STATES.AT_DONE, since)], at), "");
});

test("--plan prints the plan and writes no state, and --json carries each agent's role, lead, turn and plan", async () => {
  const wired = { root: "/r", plugin_dir: "/p" };
  const c = setup(["a", "b"], {
    config: [entry("a", { role: "lead", ...wired }), entry("b", { role: "builder", lead: "a", ...wired })],
    vms: { a: renderRemote({ classDisk: MAIN.class, agentsDisk: MAIN.agents, proof: null, turn: "idle p1", turnMtime: "100", now: "160" }), b: behindClass() },
  });
  const r = await c.go({ plan: true });
  assert.equal(r.code, 0);
  assert.match(r.out, /^rollout-check plan \(nothing is done: this version only reads\)\n/);
  assert.match(r.out, /a \(lead\): applied, not proved \[no proof file\]\n {2}turn: idle for 60 s\n {2}would: restart it with start --fresh\n/);
  assert.match(r.out, /b \(builder\): behind on disk/);
  assert.equal(existsSync(c.statePath), false, "no state file");
  const table = JSON.parse((await c.go({ json: true })).out);
  const a = table.agents[0];
  assert.equal(a.role, "lead");
  assert.equal(a.lead, null);
  assert.deepEqual(a.turn, { state: "idle", prompt_id: "p1", mtime: 100, age_seconds: 60 });
  assert.deepEqual(a.plan.steps, ["restart it with start --fresh"]);
  assert.equal(table.agents[1].lead, "a");
  assert.equal(existsSync(c.statePath), false, "--json writes none either");
});

test("the state file is version 2, carries actions and drain, and reads one of the first version", async () => {
  const c = setup(["a"]);
  await c.go();
  const state = c.state();
  assert.equal(state.schema, "ghost-protocol/rollout-check-state/v2");
  assert.equal(state.schema, STATE_SCHEMA);
  assert.deepEqual(state.actions, []);
  assert.deepEqual(state.drain, {});
  // What a later version put there is carried along by this one, untouched.
  const kept = { ...state, actions: [{ id: "x", agent: "a", kind: "apply-class", intent_at: "2026-11-12T10:00:00Z" }], drain: { boss: { request: "r1" } } };
  writeFileSync(c.statePath, JSON.stringify(kept));
  c.clock.advance(HOUR);
  await c.go();
  assert.deepEqual(c.state().actions, kept.actions);
  assert.deepEqual(c.state().drain, kept.drain);
  // Odd shapes are read as none.
  for (const odd of [{ actions: "x", drain: [] }, { actions: {}, drain: "x" }, { actions: null, drain: null }]) {
    writeFileSync(c.statePath, JSON.stringify({ ...state, ...odd }));
    const read = readState(c.statePath);
    assert.deepEqual([read.actions, read.drain], [[], {}], JSON.stringify(odd));
  }
  // The first version's file has neither, and still counts as a state.
  writeFileSync(c.statePath, JSON.stringify({ schema: "ghost-protocol/rollout-check-state/v1", updated: "2026-11-12T10:00:00Z", last_printed: null, signature: [], agents: {} }));
  const v1 = readState(c.statePath);
  assert.notEqual(v1, null);
  assert.deepEqual([v1.actions, v1.drain], [[], {}]);
  writeFileSync(c.statePath, JSON.stringify({ schema: "ghost-protocol/rollout-check-state/v3", agents: {} }));
  assert.equal(readState(c.statePath), null, "another schema is no state");
});

test("a state file of the first version means no reprint at the upgrade: the same set an hour later is silent", async () => {
  const c = setup(["a", "b"], { vms: { b: behindClass() } });
  const now = "2026-11-12T10:00:00Z";
  mkdirSync(join(c.dir, "state"), { recursive: true });
  writeFileSync(c.statePath, JSON.stringify({ schema: "ghost-protocol/rollout-check-state/v1", updated: now, last_printed: now, signature: ["b:behind:class"], agents: { b: { state: STATES.BEHIND, since: now } } }));
  c.clock.advance(HOUR);
  assert.deepEqual(await c.go(), { code: 0, out: "", err: "" });
  assert.equal(c.state().schema, STATE_SCHEMA);
});
