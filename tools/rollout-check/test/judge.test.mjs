// Judging one agent: the four states, and what moves an agent between them. Run: node --test test/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { PROOF_SCHEMA, STATES, judge, parseRemote, validateConfig } from "../lib.mjs";
import { NOT_A_FILE, SESSION, SESSION2, SHA, entry, proofFor, renderRemote } from "./helpers.mjs";

const [team, solo] = validateConfig([entry("a"), entry("b", { team_repo: null, clone: null })]);
const MAIN = { class: SHA("a"), agents: SHA("b") };
const MAIN_SOLO = { class: SHA("a"), agents: null };

// judge(agent, main's shas, what the VM printed), the printed text built from `remote`.
const verdict = (agent, remote) => judge(agent, agent.team_repo === null ? MAIN_SOLO : MAIN, parseRemote(renderRemote(remote)));
const good = (extra = {}) => proofFor({ classSha: MAIN.class, agentsSha: MAIN.agents, ...extra });
const matches = (agent = team) => ({ classDisk: MAIN.class, agentsDisk: agent.team_repo === null ? "skipped" : MAIN.agents });

test("current: both files match main and a proof from the current session shows main's shas", () => {
  const r = verdict(team, { ...matches(), proof: good() });
  assert.equal(r.state, STATES.CURRENT);
  assert.deepEqual(r.behind, []);
  assert.equal(r.reason, null);
});

test("behind on disk: the class file, the agents file, or both, each named", () => {
  assert.deepEqual(verdict(team, { ...matches(), classDisk: SHA("c"), proof: good() }).behind, ["class"]);
  assert.deepEqual(verdict(team, { ...matches(), agentsDisk: SHA("c"), proof: good() }).behind, ["agents"]);
  const both = verdict(team, { classDisk: SHA("c"), agentsDisk: SHA("d"), proof: good() });
  assert.deepEqual(both.behind, ["class", "agents"]);
  assert.equal(both.state, STATES.BEHIND);
  assert.match(both.reason, /class and agents/);
});

test("behind on disk: a file that is missing or not a file is not main's", () => {
  for (const word of ["missing", "not-a-file"]) {
    assert.deepEqual(verdict(team, { ...matches(), classDisk: word, proof: good() }).behind, ["class"], word);
    assert.deepEqual(verdict(team, { ...matches(), agentsDisk: word, proof: good() }).behind, ["agents"], word);
  }
  assert.deepEqual(verdict(team, { ...matches(), agentsDisk: "skipped", proof: good() }).behind, ["agents"], "the VM skipped a file that the config says is there");
});

test("unknown, not behind: a file that cannot be read, or a VM with no sha256 tool, says nothing about the file", () => {
  const cases = [
    [{ classDisk: "unreadable" }, "class file unreadable"],
    [{ agentsDisk: "unreadable" }, "agents file unreadable"],
    [{ classDisk: "no-sha256", agentsDisk: "no-sha256" }, "no sha256 tool"],
    [{ classDisk: "no-sha256" }, "no sha256 tool"],
    [{ agentsDisk: "no-sha256" }, "no sha256 tool"],
    [{ classDisk: "unreadable", agentsDisk: "no-sha256" }, "no sha256 tool"],
    [{ classDisk: "unreadable", agentsDisk: "unreadable" }, "class file unreadable"],
  ];
  for (const [remote, reason] of cases) {
    // Even with a proof that is fine, and even with none: the files are not known to be main's.
    for (const proof of [good(), null]) {
      const r = verdict(team, { ...matches(), ...remote, proof });
      assert.equal(r.state, STATES.UNKNOWN, JSON.stringify(remote));
      assert.equal(r.reason, reason);
      assert.deepEqual(r.behind, []);
    }
  }
});

test("a file that is certainly behind is said even when the other cannot be read", () => {
  const r = verdict(team, { ...matches(), classDisk: SHA("c"), agentsDisk: "unreadable", proof: good() });
  assert.equal(r.state, STATES.BEHIND);
  assert.deepEqual(r.behind, ["class"]);
  const r2 = verdict(team, { ...matches(), classDisk: "unreadable", agentsDisk: SHA("d"), proof: good() });
  assert.equal(r2.state, STATES.BEHIND);
  assert.deepEqual(r2.behind, ["agents"]);
  assert.equal(verdict(team, { ...matches(), classDisk: "missing", agentsDisk: "no-sha256" }).state, STATES.BEHIND);
});

test("no team repo: an agents file that cannot be read is not looked at, and a class file that cannot be read is unknown", () => {
  const solo_ = (remote) => verdict(solo, { ...matches(solo), ...remote });
  assert.equal(solo_({ agentsDisk: "unreadable", proof: good() }).state, STATES.CURRENT);
  assert.equal(solo_({ agentsDisk: "no-sha256", proof: good() }).state, STATES.CURRENT);
  assert.equal(solo_({ classDisk: "unreadable", proof: good() }).state, STATES.UNKNOWN);
  assert.equal(solo_({ classDisk: "no-sha256", proof: good() }).reason, "no sha256 tool");
});

test("behind wins over a proof that is fine, and over one that is missing", () => {
  assert.equal(verdict(team, { ...matches(), classDisk: SHA("c"), proof: good() }).state, STATES.BEHIND);
  assert.equal(verdict(team, { ...matches(), classDisk: SHA("c"), proof: null }).state, STATES.BEHIND);
  assert.equal(verdict(team, { ...matches(), classDisk: SHA("c"), session: "missing" }).state, STATES.BEHIND);
});

test("applied, not proved: the files match, but there is no proof", () => {
  assert.equal(verdict(team, { ...matches(), proof: null }).state, STATES.NOT_PROVED);
  assert.equal(verdict(team, { ...matches(), proof: null }).reason, "no proof file");
  assert.equal(verdict(team, { ...matches(), proof: NOT_A_FILE }).state, STATES.NOT_PROVED);
});

test("applied, not proved: a proof that cannot be read, or is of another schema", () => {
  const cases = [
    ["", "unreadable"],
    ["not json", "unreadable"],
    ["[]", "unreadable"],
    ["null", "unreadable"],
    ["5", "unreadable"],
    ['"x"', "unreadable"],
    ["{", "unreadable"],
    [" ".repeat(70_000), "unreadable"],
    [`${JSON.stringify(good())}${" ".repeat(70_000)}`, "unreadable"],
    [JSON.stringify({ ...good(), schema: "other/v9" }), "another schema"],
    [JSON.stringify({ ...good(), schema: undefined }), "another schema"],
  ];
  for (const [raw, why] of cases) {
    const r = verdict(team, { ...matches(), proof: { raw } });
    assert.equal(r.state, STATES.NOT_PROVED, raw.slice(0, 30));
    assert.match(r.reason, new RegExp(why), raw.slice(0, 30));
  }
  assert.equal(verdict(team, { ...matches(), proof: { raw: JSON.stringify(good()) } }).state, STATES.CURRENT);
  assert.equal(verdict(team, { ...matches(), proof: { raw: Buffer.from([0xff, 0xfe, 0x00]) } }).state, STATES.NOT_PROVED);
});

test("applied, not proved: a proof from an earlier session (a resume or a clear that wrote none)", () => {
  const r = verdict(team, { ...matches(), session: SESSION2, proof: good({ session: SESSION }) });
  assert.equal(r.state, STATES.NOT_PROVED);
  assert.equal(r.reason, "proof is from another session");
  assert.equal(r.proof.current_session, false);
  assert.equal(r.proof.session_id, SESSION);
  assert.equal(verdict(team, { ...matches(), session: SESSION, proof: good({ session: SESSION }) }).state, STATES.CURRENT);
});

test("applied, not proved: no current session id, so no proof can be of it", () => {
  for (const session of ["missing", "invalid", "0b1c-2d"]) {
    const r = verdict(team, { ...matches(), session, proof: good() });
    assert.equal(r.state, STATES.NOT_PROVED, session);
    assert.equal(r.reason, "no current session id");
    assert.equal(r.proof.current_session, false, "a proof is never of a session that is not known");
  }
  // A proof that names no session, or a thing that is not one, proves nothing.
  for (const bad of [null, "", 5, {}, undefined]) {
    const none = verdict(team, { ...matches(), session: "missing", proof: good({ extra: { session_id: bad } }) });
    assert.equal(none.state, STATES.NOT_PROVED);
    assert.equal(none.proof.current_session, false, "null is not the same session as null");
    assert.equal(verdict(team, { ...matches(), proof: good({ extra: { session_id: bad } }) }).state, STATES.NOT_PROVED);
  }
});

test("applied, not proved: the proof is of another claude process than the one in pane-pid", () => {
  const r = verdict(team, { ...matches(), panePid: "5151", proof: good({ pid: 4242 }) });
  assert.equal(r.state, STATES.NOT_PROVED);
  assert.equal(r.reason, "proof is of another claude process");
  assert.equal(r.pane_pid, 5151);
  assert.equal(r.proof.claude_pid, 4242);
  assert.equal(verdict(team, { ...matches(), panePid: "4242", proof: good({ pid: 4242 }) }).state, STATES.CURRENT);
  // The same session, a different claude: a restart that wrote no new proof.
  assert.equal(verdict(team, { ...matches(), session: SESSION, panePid: "4243", proof: good({ session: SESSION, pid: 4242 }) }).state, STATES.NOT_PROVED);
});

test("applied, not proved: a proof beside no pane-pid, or one with no claude_pid", () => {
  for (const panePid of ["missing", "invalid", "0", "1", "0042"]) {
    const r = verdict(team, { ...matches(), panePid, proof: good() });
    assert.equal(r.state, STATES.NOT_PROVED, panePid);
    assert.equal(r.reason, "no pane-pid beside the proof", panePid);
    assert.equal(r.pane_pid, null);
  }
  for (const bad of [null, undefined, "4242", 4242.5, 0, 1, -4242, {}, [4242], true, 1e30]) {
    const r = verdict(team, { ...matches(), proof: good({ extra: { claude_pid: bad } }) });
    assert.equal(r.state, STATES.NOT_PROVED, JSON.stringify(bad));
    assert.equal(r.reason, "proof has no claude_pid", JSON.stringify(bad));
    assert.equal(r.proof.claude_pid, null);
  }
  assert.equal(verdict(team, { ...matches(), proof: good({ extra: { claude_pid: undefined } }) }).reason, "proof has no claude_pid", "a proof written before the hook recorded the pid");
});

test("the session is judged before the pid, and the pid before the shas", () => {
  assert.equal(verdict(team, { ...matches(), session: SESSION2, panePid: "5151", proof: good() }).reason, "proof is from another session");
  assert.equal(verdict(team, { ...matches(), panePid: "5151", proof: good({ classSha: SHA("c") }) }).reason, "proof is of another claude process");
});

test("no team repo: the pid rule holds for the class file alone", () => {
  const solo_ = (remote) => verdict(solo, { ...matches(solo), ...remote });
  assert.equal(solo_({ panePid: "5151", proof: good() }).state, STATES.NOT_PROVED);
  assert.equal(solo_({ panePid: "missing", proof: good() }).state, STATES.NOT_PROVED);
  assert.equal(solo_({ proof: good() }).state, STATES.CURRENT);
});

test("applied, not proved: the proof shows other shas, or none", () => {
  const other = (extra) => verdict(team, { ...matches(), proof: good(extra) });
  assert.equal(other({ classSha: SHA("c") }).reason, "proof shows another class file");
  assert.equal(other({ agentsSha: SHA("c") }).reason, "proof shows another agents file");
  assert.equal(other({ classStatus: "none" }).reason, "proof shows no class file");
  assert.equal(other({ agentsStatus: "none" }).reason, "proof shows no agents file");
  assert.equal(other({ agentsStatus: "none" }).state, STATES.NOT_PROVED);
  for (const state of [other({ classSha: SHA("c") }), other({ agentsSha: SHA("c") })]) assert.equal(state.state, STATES.NOT_PROVED);
  // Not a sha at all, or the right sha in the wrong place.
  assert.equal(other({ classSha: "x" }).state, STATES.NOT_PROVED);
  assert.equal(other({ classSha: undefined }).state, STATES.NOT_PROVED);
  assert.equal(other({ classSha: MAIN.class.toUpperCase() }).state, STATES.NOT_PROVED);
  assert.equal(other({ classSha: MAIN.agents, agentsSha: MAIN.class }).state, STATES.NOT_PROVED);
  assert.equal(other({ extra: { class: "ok" } }).state, STATES.NOT_PROVED);
  assert.equal(other({ extra: { agents: null } }).state, STATES.NOT_PROVED);
});

test("a team repo makes the agents file count; a proof's own claim of the right sha is checked against main, not the disk", () => {
  // The disk matches main but the proof is of an older agents file.
  assert.equal(verdict(team, { ...matches(), proof: good({ agentsSha: SHA("e") }) }).state, STATES.NOT_PROVED);
});

test("no team repo: judged on the class file alone", () => {
  const solo_ = (remote) => verdict(solo, { ...matches(solo), ...remote });
  assert.equal(solo_({ proof: good({ agentsStatus: "none" }) }).state, STATES.CURRENT, "a proof with agents: none is fine");
  assert.equal(solo_({ proof: good({ agentsSha: SHA("e") }) }).state, STATES.CURRENT, "and so is one with another agents sha");
  assert.equal(solo_({ agentsDisk: SHA("e"), proof: good() }).state, STATES.CURRENT, "an AGENTS.md on disk is not looked at");
  assert.equal(solo_({ classDisk: SHA("c"), proof: good() }).state, STATES.BEHIND);
  assert.deepEqual(solo_({ classDisk: SHA("c"), proof: good() }).behind, ["class"]);
  assert.equal(solo_({ proof: null }).state, STATES.NOT_PROVED);
  assert.equal(solo_({ proof: good({ classSha: SHA("c") }) }).state, STATES.NOT_PROVED);
  assert.equal(solo_({ session: SESSION2 }).state, STATES.NOT_PROVED);
  assert.equal(solo_({ proof: good() }).disk.agents, null);
});

test("the table's proof holds the version and the commit, and only forms that are checked", () => {
  const r = verdict(team, { ...matches(), proof: good({ version: "1.4.2", commit: "d".repeat(40) }) });
  assert.equal(r.proof.version, "1.4.2");
  assert.equal(r.proof.commit, "d".repeat(40));
  assert.equal(r.proof.session_id, SESSION);
  assert.equal(r.proof.current_session, true);
  assert.equal(r.proof.claude_pid, 4242);
  assert.equal(r.pane_pid, 4242);
  assert.equal(r.proof.class_sha, MAIN.class);
  assert.equal(r.proof.agents_sha, MAIN.agents);
  assert.equal(r.proof.time, "2026-11-12T10:00:00Z");
  const odd = verdict(team, { ...matches(), proof: good({ version: "1.0; rm -rf /", commit: "not-a-commit", extra: { time: "yesterday" } }) });
  assert.equal(odd.proof.version, null);
  assert.equal(odd.proof.commit, null);
  assert.equal(odd.proof.time, null);
  // Nothing free from the VM (the first lines, the paths) is carried.
  assert.doesNotMatch(JSON.stringify(r), /# Class|# AGENTS\.md|\/x\/CLAUDE\.md|first_line/);
  assert.equal(verdict(team, { ...matches(), proof: null }).proof, null);
});

test("the proof schema is the one hooks/load-proof writes", () => {
  assert.equal(PROOF_SCHEMA, "ghost-protocol/load-proof/v1");
});

test("an old proof stays not proved however many shas it shows right", () => {
  const old = good({ session: SESSION });
  for (const now of [SESSION2, "3e4f5061-7283-4945-9dae-2f3a4b5c6d7e"]) {
    assert.equal(verdict(team, { ...matches(), session: now, proof: old }).state, STATES.NOT_PROVED);
  }
});

// ---- the second version: the turn marker, and the agents that restart themselves ----
const [builder, reviewer, lead, other] = validateConfig([entry("b1", { role: "builder", lead: "boss" }), entry("r1", { role: "reviewer", lead: "boss" }), entry("boss", { role: "lead" }), entry("x1", { role: "other" })]);

test("applied, restarts at Done: a builder or a reviewer whose files are right and whose proof is not there yet", () => {
  for (const agent of [builder, reviewer]) {
    const r = verdict(agent, { ...matches(agent), proof: null });
    assert.equal(r.state, STATES.AT_DONE);
    assert.equal(r.reason, "no proof file");
    assert.deepEqual(r.behind, []);
  }
  for (const agent of [lead, other, team]) assert.equal(verdict(agent, { ...matches(agent), proof: null }).state, STATES.NOT_PROVED, agent.role);
});

test("the reasons that make others not proved make a builder or a reviewer restart at Done, with the same words", () => {
  const cases = {
    "a proof of another session": { proof: good({ session: SESSION2 }) },
    "a proof of another process": { proof: good({ pid: 77 }) },
    "a proof with other shas": { proof: proofFor({ classSha: SHA("e"), agentsSha: MAIN.agents }) },
    "a proof that cannot be read": { proof: { raw: "not json" } },
    "no session id": { session: "missing", proof: good() },
  };
  for (const [why, remote] of Object.entries(cases)) {
    const a = verdict(lead, { ...matches(lead), ...remote });
    const b = verdict(builder, { ...matches(builder), ...remote });
    assert.equal(a.state, STATES.NOT_PROVED, why);
    assert.equal(b.state, STATES.AT_DONE, why);
    assert.equal(b.reason, a.reason, why);
  }
});

test("a role changes nothing about behind on disk, unknown or current", () => {
  for (const agent of [builder, reviewer, lead, other]) {
    assert.equal(verdict(agent, { ...matches(agent), classDisk: SHA("c"), proof: good() }).state, STATES.BEHIND, agent.role);
    assert.equal(verdict(agent, { ...matches(agent), classDisk: "unreadable", proof: good() }).state, STATES.UNKNOWN, agent.role);
    assert.equal(verdict(agent, { ...matches(agent), proof: good() }).state, STATES.CURRENT, agent.role);
  }
});

test("the verdict carries the turn marker in a plain form, and none when there is no reading", () => {
  const idle = verdict(lead, { ...matches(lead), proof: good(), turn: "idle p-9", turnMtime: "100", now: "250" });
  assert.deepEqual(idle.turn, { state: "idle", prompt_id: "p-9", mtime: 100, age_seconds: 150 });
  const busy = verdict(lead, { ...matches(lead), proof: good(), turn: "busy -", turnMtime: "100", now: "100" });
  assert.deepEqual(busy.turn, { state: "busy", prompt_id: "-", mtime: 100, age_seconds: 0 });
  assert.deepEqual(verdict(lead, { ...matches(lead), proof: good() }).turn, { state: "missing", prompt_id: null, mtime: null, age_seconds: null });
  assert.equal(verdict(lead, { ...matches(lead), proof: good(), turn: "idle p1", turnMtime: "500", now: "100" }).turn.age_seconds, null, "dated after the VM's clock");
  assert.equal(verdict(lead, { ...matches(lead), proof: good(), turn: "invalid" }).turn.state, "invalid");
  assert.equal(verdict(lead, { ...matches(lead), proof: good(), turn: "not-a-file" }).turn.state, "not-a-file");
});
