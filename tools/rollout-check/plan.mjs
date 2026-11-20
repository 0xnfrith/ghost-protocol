// plan.mjs: what a run that acts would do for each agent, and what stops it, as plain data. It is a pure function of what the read
// found and of the config, and it does nothing: this version has no way to act, so `--plan` only says what the rules (README.md,
// "What it would do") come to for the agents as they are now.
import { STATES } from "./states.mjs";

/** The turn marker as the plan words it. */
export function describeTurn(turn) {
  if (turn === null || turn === undefined) return "no reading";
  const age = turn.age_seconds === null || turn.age_seconds === undefined ? "" : ` for ${turn.age_seconds} s`;
  switch (turn.state) {
    case "busy":
      return `busy${age}`;
    case "idle":
      return `idle${age}`;
    case "missing":
      return "no turn marker";
    case "not-a-file":
      return "the turn marker is not a regular file";
    default:
      return "the turn marker is unreadable";
  }
}

// Why a lead cannot be restarted yet, from its own turn marker.
function turnBlock(who, turn) {
  if (turn === null || turn === undefined) return `${who}: its turn could not be read`;
  if (turn.state === "busy") return `${who}: its turn is busy (${describeTurn(turn)})`;
  if (turn.state !== "idle") return `${who}: ${describeTurn(turn)}`;
  if (turn.prompt_id === "-") return `${who}: its turn marker has no prompt id, so its idle cannot be tied to a turn`;
  return null;
}

/**
 * The plan for one agent. `row` is its judged row (state, behind, turn), `agent` its config entry, `pairs` the rows of the agents
 * whose `lead` is this agent. Returns {steps, blocked, notes}: what an acting run would do, what stops it, and anything else worth
 * saying. Nothing here is done.
 */
export function planAgent(row, agent, pairs) {
  const steps = [];
  const blocked = [];
  const notes = [];
  const restartOfALead = () => {
    if (agent.root === null || agent.plugin_dir === null) blocked.push("root and plugin_dir are not both set, so it cannot be restarted");
    else steps.push("restart it with start --fresh");
    blocked.push("it needs a valid drain ack first (a request, then the lead's answer)");
    const own = turnBlock("the lead", row.turn);
    if (own) blocked.push(own);
    for (const pair of pairs) {
      const why = turnBlock(`pair ${pair.name}`, pair.turn);
      if (why) blocked.push(why);
    }
    if (pairs.length === 0) notes.push("no agent names it as its lead in the config, so no pair is checked");
  };

  switch (row.state) {
    case STATES.CURRENT:
      notes.push("nothing to do");
      break;
    case STATES.UNKNOWN:
      blocked.push(`unknown (${row.reason}): never acted on`);
      break;
    case STATES.BEHIND: {
      if (row.behind.includes("class")) {
        if (!agent.class_apply) blocked.push("class_apply is off for this agent, so its class file is left alone");
        else if (agent.role === "lead") steps.push("write the class file in the same step as its restart");
        else steps.push("write the class file");
      }
      if (row.behind.includes("agents")) {
        if (agent.plugin_dir === null) blocked.push("plugin_dir is not set, so sync-mains cannot be called to fast-forward the team clone");
        else steps.push("fast-forward the team clone through sync-mains");
      }
      if (agent.role === "lead") restartOfALead();
      else if (agent.role === "other") notes.push("this tool restarts leads only");
      else notes.push("its session restarts when its task is done");
      break;
    }
    case STATES.NOT_PROVED:
    case STATES.AT_DONE:
      if (agent.role === "lead") restartOfALead();
      else if (agent.role === "other") notes.push("this tool restarts leads only");
      else notes.push("it restarts itself when its task is done; this tool does not restart it");
      break;
    default:
      blocked.push(`unexpected state ${row.state}`);
  }
  return { steps, blocked, notes };
}

/** The plans of every agent, by name. `agents` are the config entries, `rows` the judged rows, in the same order. */
export function planAll(rows, agents) {
  const plans = {};
  rows.forEach((row, i) => {
    const agent = agents[i];
    const pairs = rows.filter((other, j) => agents[j].lead === agent.name);
    plans[row.name] = planAgent(row, agent, pairs);
  });
  return plans;
}

/** The text `--plan` prints: one block for each agent that is not current, then a count. */
export function formatPlan(rows, agents, plans) {
  const lines = ["rollout-check plan (nothing is done: this version only reads)"];
  rows.forEach((row, i) => {
    if (row.state === STATES.CURRENT) return;
    const p = plans[row.name];
    lines.push(`${row.name} (${agents[i].role}): ${row.state}${row.reason ? ` [${row.reason}]` : ""}${row.quiet ? " (not in the printed line yet)" : ""}`);
    lines.push(`  turn: ${describeTurn(row.turn)}`);
    for (const s of p.steps) lines.push(`  would: ${s}`);
    for (const b of p.blocked) lines.push(`  blocked: ${b}`);
    for (const n of p.notes) lines.push(`  note: ${n}`);
  });
  const current = rows.filter((r) => r.state === STATES.CURRENT).length;
  lines.push(`${rows.length} agents, ${current} current`);
  return `${lines.join("\n")}\n`;
}
