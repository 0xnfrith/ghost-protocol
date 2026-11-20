// The plan (plan.mjs): what an acting run would do for each agent and what would stop it, from the state, the role, the turn marker
// and the config. A pure function; nothing is done. Run: node --test test/*.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { STATES, judge, parseRemote, validateConfig } from "../lib.mjs";
import { describeTurn, formatPlan, planAgent, planAll } from "../plan.mjs";
import { SHA, entry, proofFor, renderRemote } from "./helpers.mjs";

const MAIN = { class: SHA("a"), agents: SHA("b") };
const wired = { root: "/home/boss/work", plugin_dir: "/home/boss/ghost-protocol" };

// A config of one lead, two pairs and an agent with no role, and a judged row for each from `remotes[name]`.
function world(remotes = {}, extra = {}) {
  const agents = validateConfig([
    entry("boss", { role: "lead", ...wired, ...(extra.boss ?? {}) }),
    entry("build", { role: "builder", lead: "boss", ...wired, ...(extra.build ?? {}) }),
    entry("review", { role: "reviewer", lead: "boss", ...wired, ...(extra.review ?? {}) }),
    entry("free", { role: "other", ...(extra.free ?? {}) }),
  ]);
  const current = (a) => ({ classDisk: MAIN.class, agentsDisk: MAIN.agents, proof: proofFor({ classSha: MAIN.class, agentsSha: MAIN.agents }), turn: "idle p1", turnMtime: "100", now: "200" });
  const rows = agents.map((a) => ({ name: a.name, ...judge(a, MAIN, parseRemote(renderRemote({ ...current(a), ...(remotes[a.name] ?? {}) }))) }));
  return { agents, rows, plans: planAll(rows, agents) };
}
const behindClass = { classDisk: SHA("c") };
const behindAgents = { agentsDisk: SHA("d") };
const noProof = { proof: null };

test("current: nothing to do", () => {
  const { plans, rows } = world();
  for (const r of rows) assert.equal(r.state, STATES.CURRENT);
  assert.deepEqual(plans.boss, { steps: [], blocked: [], notes: ["nothing to do"] });
  assert.deepEqual(plans.free, plans.boss);
});

test("unknown: never acted on, with the reason", () => {
  const { plans, rows } = world({ boss: { classDisk: "unreadable" } });
  assert.equal(rows[0].state, STATES.UNKNOWN);
  assert.deepEqual(plans.boss, { steps: [], blocked: ["unknown (class file unreadable): never acted on"], notes: [] });
});

test("behind on disk, a builder: the class file is written at once, the clone is fast-forwarded, and it restarts itself later", () => {
  const { plans } = world({ build: { ...behindClass, ...behindAgents } });
  assert.deepEqual(plans.build.steps, ["write the class file", "fast-forward the team clone through sync-mains"]);
  assert.deepEqual(plans.build.blocked, []);
  assert.deepEqual(plans.build.notes, ["its session restarts when its task is done"]);
  assert.deepEqual(world({ review: behindClass }).plans.review.steps, ["write the class file"]);
  assert.deepEqual(world({ free: behindAgents }, { free: { plugin_dir: "/home/free/ghost-protocol" } }).plans.free.steps, ["fast-forward the team clone through sync-mains"]);
});

test("behind on disk, an agent with no role: its steps, and this tool does not restart it", () => {
  const free = world({ free: behindClass }).plans.free;
  assert.deepEqual(free, { steps: ["write the class file"], blocked: [], notes: ["this tool restarts leads only"] });
});

test("behind on disk: class_apply off leaves the class file alone, and no plugin_dir means no clone to fast-forward", () => {
  const off = world({ build: behindClass }, { build: { class_apply: false } }).plans.build;
  assert.deepEqual(off.steps, []);
  assert.deepEqual(off.blocked, ["class_apply is off for this agent, so its class file is left alone"]);
  const none = world({ build: behindAgents }, { build: { plugin_dir: null } }).plans.build;
  assert.deepEqual(none.steps, []);
  assert.deepEqual(none.blocked, ["plugin_dir is not set, so sync-mains cannot be called to fast-forward the team clone"]);
});

test("behind on disk, a lead: its class file is written in the same step as its restart, which needs a drain ack and a quiet room", () => {
  const { plans } = world({ boss: behindClass });
  assert.deepEqual(plans.boss.steps, ["write the class file in the same step as its restart", "restart it with start --fresh"]);
  assert.ok(plans.boss.blocked.includes("it needs a valid drain ack first (a request, then the lead's answer)"));
  assert.equal(plans.boss.blocked.length, 1, "its turn and both pairs are idle");
});

test("applied, not proved, a lead: the restart, and what stops it", () => {
  const idle = world({ boss: noProof }).plans.boss;
  assert.deepEqual(idle.steps, ["restart it with start --fresh"]);
  assert.deepEqual(idle.blocked, ["it needs a valid drain ack first (a request, then the lead's answer)"]);
  const busy = world({ boss: { ...noProof, turn: "busy p2", turnMtime: "190", now: "200" } }).plans.boss;
  assert.ok(busy.blocked.includes("the lead: its turn is busy (busy for 10 s)"), busy.blocked.join(" | "));
  const noId = world({ boss: { ...noProof, turn: "idle -" } }).plans.boss;
  assert.ok(noId.blocked.includes("the lead: its turn marker has no prompt id, so its idle cannot be tied to a turn"), noId.blocked.join(" | "));
  for (const [turn, words] of [["missing", "the lead: no turn marker"], ["invalid", "the lead: the turn marker is unreadable"], ["not-a-file", "the lead: the turn marker is not a regular file"]]) {
    assert.ok(world({ boss: { ...noProof, turn } }).plans.boss.blocked.includes(words), turn);
  }
});

test("a lead's pairs: a busy one, or one with no usable marker, blocks it, named", () => {
  const { plans } = world({ boss: noProof, build: { turn: "busy p3", turnMtime: "150", now: "200" }, review: { turn: "invalid" } });
  assert.ok(plans.boss.blocked.includes("pair build: its turn is busy (busy for 50 s)"));
  assert.ok(plans.boss.blocked.includes("pair review: the turn marker is unreadable"));
  const noId = world({ boss: noProof, build: { turn: "idle -" } }).plans.boss;
  assert.deepEqual(noId.blocked.filter((b) => b.startsWith("pair")), ["pair build: its turn marker has no prompt id, so its idle cannot be tied to a turn"]);
});

test("a lead with no pair in the config says so", () => {
  const agents = validateConfig([entry("solo", { role: "lead", ...wired })]);
  const rows = [{ name: "solo", ...judge(agents[0], MAIN, parseRemote(renderRemote({ classDisk: MAIN.class, agentsDisk: MAIN.agents, proof: null, turn: "idle p1" }))) }];
  assert.deepEqual(planAll(rows, agents).solo.notes, ["no agent names it as its lead in the config, so no pair is checked"]);
});

test("a lead needs root and plugin_dir to be restarted", () => {
  for (const missing of ["root", "plugin_dir"]) {
    const p = world({ boss: noProof }, { boss: { [missing]: null } }).plans.boss;
    assert.deepEqual(p.steps, []);
    assert.ok(p.blocked.includes("root and plugin_dir are not both set, so it cannot be restarted"), missing);
  }
});

test("a builder or reviewer that is not proved is not restarted by this tool, and an agent with no role is not either", () => {
  for (const name of ["build", "review"]) {
    const { plans, rows } = world({ [name]: noProof });
    assert.equal(rows.find((r) => r.name === name).state, STATES.AT_DONE);
    assert.deepEqual(plans[name], { steps: [], blocked: [], notes: ["it restarts itself when its task is done; this tool does not restart it"] });
  }
  assert.deepEqual(world({ free: noProof }).plans.free, { steps: [], blocked: [], notes: ["this tool restarts leads only"] });
});

test("the plan never lists a restart for anything but a lead", () => {
  const everything = { ...behindClass, ...behindAgents };
  const { plans } = world({ boss: everything, build: everything, review: everything, free: everything });
  for (const name of ["build", "review", "free"]) assert.ok(!plans[name].steps.some((s) => /restart/.test(s)), name);
  assert.ok(plans.boss.steps.some((s) => /restart/.test(s)));
});

test("planAgent takes the pairs it is given and nothing else", () => {
  const { agents, rows } = world({ boss: noProof });
  assert.deepEqual(planAgent(rows[0], agents[0], []).notes, ["no agent names it as its lead in the config, so no pair is checked"]);
  assert.deepEqual(planAgent({ ...rows[0], state: "something new" }, agents[0], []).blocked, ["unexpected state something new"]);
});

test("describeTurn", () => {
  assert.equal(describeTurn(null), "no reading");
  assert.equal(describeTurn(undefined), "no reading");
  assert.equal(describeTurn({ state: "idle", age_seconds: 125 }), "idle for 125 s");
  assert.equal(describeTurn({ state: "busy", age_seconds: null }), "busy");
  assert.equal(describeTurn({ state: "busy" }), "busy");
  assert.equal(describeTurn({ state: "missing" }), "no turn marker");
  assert.equal(describeTurn({ state: "not-a-file" }), "the turn marker is not a regular file");
  assert.equal(describeTurn({ state: "invalid" }), "the turn marker is unreadable");
});

test("formatPlan: one block for each agent that is not current, a count, and the words that nothing is done", () => {
  const { agents, rows, plans } = world({ boss: noProof, build: { ...behindClass, turn: "busy p1", turnMtime: "190", now: "200" } });
  const text = formatPlan(rows, agents, plans);
  assert.equal(
    text,
    [
      "rollout-check plan (nothing is done: this version only reads)",
      "boss (lead): applied, not proved [no proof file]",
      "  turn: idle for 100 s",
      "  would: restart it with start --fresh",
      "  blocked: it needs a valid drain ack first (a request, then the lead's answer)",
      "  blocked: pair build: its turn is busy (busy for 10 s)",
      "build (builder): behind on disk [class on disk differs from main]",
      "  turn: busy for 10 s",
      "  would: write the class file",
      "  note: its session restarts when its task is done",
      "4 agents, 2 current",
      "",
    ].join("\n"),
  );
  assert.equal(formatPlan([], [], {}), "rollout-check plan (nothing is done: this version only reads)\n0 agents, 0 current\n");
});

test("formatPlan marks a quiet row, and leaves a current agent out", () => {
  const { agents, rows, plans } = world({ build: noProof });
  rows[1].quiet = true;
  const text = formatPlan(rows, agents, plans);
  assert.match(text, /build \(builder\): applied, restarts at Done \[no proof file\] \(not in the printed line yet\)/);
  assert.doesNotMatch(text, /boss \(lead\)/);
});

test("a pair whose turn was never read blocks its lead, and an agent that does not name the lead is not its pair", () => {
  const { agents, rows } = world({ boss: noProof, free: { turn: "busy p9", turnMtime: "190", now: "200" } });
  // The pair's VM could not be reached: an unknown row has no turn reading at all.
  const lost = rows.map((r) => (r.name === "build" ? { name: "build", state: STATES.UNKNOWN, reason: "ssh failed", behind: [], turn: null } : r));
  const plans = planAll(lost, agents);
  assert.ok(plans.boss.blocked.includes("pair build: its turn could not be read"), plans.boss.blocked.join(" | "));
  assert.ok(!plans.boss.blocked.some((b) => b.startsWith("pair free")), "free names no lead, so its busy turn is not the lead's concern");
  assert.ok(!plans.boss.blocked.some((b) => b.startsWith("pair boss")), "and a lead is not its own pair");
  assert.deepEqual(plans.boss.blocked.filter((b) => b.startsWith("pair")), ["pair build: its turn could not be read"]);
});
