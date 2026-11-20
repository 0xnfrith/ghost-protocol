/**
 * schema/record-rules.mjs, the one copy of the record rules, and the readers that share it.
 *
 *   - the finished set and the status sets, as every reader sees them;
 *   - the move table: every rule the prose states, and every status move a real store's records have made in git
 *     history (101 distinct moves), legal except the four the prose forbids;
 *   - who holds the ball: owner, waiting_on, blocked_on, waiting_since;
 *   - render-subitems ticks a `decided` or `retired` sub-item;
 *   - what a profile adds to the generic rules, and what the generic rules hold without one.
 *
 * The record types of the old host store are named here by the neutral types of fixtures/profile.json:
 * vendor, ops-desk, agent-ops and desk-ops. Run with `node --test backlog/test/`.
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { CORE_TYPES, HANDOFF_NULL_FIELDS, TERMINAL_CLEARS, createRules } from "../schema/record-rules.mjs";
import { renderBody } from "../schema/render-subitems.mjs";
import { checkProfile, loadProfileFile } from "../schema/profile.mjs";

const PROFILE_FILE = fileURLToPath(new URL("./fixtures/profile.json", import.meta.url));
const VALIDATE = fileURLToPath(new URL("../schema/validate", import.meta.url));

const { profile, problem } = loadProfileFile(PROFILE_FILE);
assert.equal(problem, null, "the fixture profile loads");
const full = createRules({ operatorNames: ["alex"], profile });
const generic = createRules();

const { TERMINAL, FAMILY_STATUSES, WORK_TYPES } = { TERMINAL: full.terminal, FAMILY_STATUSES: full.familyStatuses, WORK_TYPES: full.workTypes };
const { itemStatuses: ITEM_STATUSES, moves: MOVES } = full;
const { checkMove, familyOf, finishedClears, isOperator, isWaiting, legalMoves, namesOperator, onOperatorsDesk, ownerOf, terminalLeftovers, waitProblems, waitingParty, waitsOnOperator } = full;

// Runs the real validator on `file` with the fixture profile (or none), in an environment that reads no settings
// of the machine it runs on: the prefix is ALPHA, and the settings file and git config are empty.
let scratch = "";
const validate = (file, { withProfile = true } = {}) => {
  const env = { ...process.env, BACKLOG_PREFIX: "ALPHA", CLAUDE_CONFIG_DIR: join(scratch, "claude-config"), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  delete env.BACKLOG_PROFILE;
  delete env.CLAUDE_PLUGIN_OPTION_BACKLOG_PROFILE;
  if (withProfile) env.BACKLOG_PROFILE = PROFILE_FILE;
  const r = spawnSync(process.execPath, [VALIDATE, file], { env, encoding: "utf8" });
  return { code: r.status, err: r.stderr };
};

// ── the finished set and the status sets ─────────────────────────────────────

describe("the finished set", () => {
  test("is exactly the seven values with the profile's handoff status, the six without", () => {
    assert.deepEqual([...TERMINAL].sort(), ["cancelled", "completed", "concluded", "decided", "delivered", "moved", "retired"]);
    assert.deepEqual([...generic.terminal].sort(), ["cancelled", "completed", "concluded", "decided", "delivered", "retired"]);
  });

  test("every type can be finished, and every finished status belongs to some type", () => {
    for (const [type, statuses] of Object.entries(ITEM_STATUSES)) {
      assert.ok(statuses.some((s) => TERMINAL.has(s)), type);
      assert.equal(new Set(statuses).size, statuses.length, type);
      assert.ok(type.length > 0);
    }
    const all = new Set(Object.values(ITEM_STATUSES).flat());
    for (const s of TERMINAL) assert.ok(all.has(s), s);
    // the generic types alone: each can still be finished, none repeats a status
    for (const [type, statuses] of Object.entries(generic.itemStatuses)) {
      assert.ok(statuses.some((s) => generic.terminal.has(s)), type);
      assert.equal(new Set(statuses).size, statuses.length, type);
    }
  });

  test("a finished record must clear next_action and waiting_on", () => {
    assert.deepEqual([...TERMINAL_CLEARS], ["next_action", "waiting_on"]);
    assert.deepEqual(terminalLeftovers({ status: "completed", next_action: "x", waiting_on: "operator" }), ["next_action", "waiting_on"]);
    assert.deepEqual(terminalLeftovers({ status: "decided", next_action: "x" }), ["next_action"]);
    assert.deepEqual(terminalLeftovers({ status: "retired", waiting_on: "Sam" }), ["waiting_on"]);
    assert.deepEqual(terminalLeftovers({ status: "moved", next_action: "null", waiting_on: "~" }), []);
    assert.deepEqual(terminalLeftovers({ status: "completed", next_action: '""', waiting_on: "''" }), []); // quoted empty is empty
    assert.deepEqual(terminalLeftovers({ status: "active", next_action: "x" }), []);
  });

  test("one finished-record rule: a handed-off record clears every live field, the others the pair", () => {
    assert.deepEqual([...HANDOFF_NULL_FIELDS], ["next_action", "waiting_on", "blocked_on", "waiting_since"]);
    assert.deepEqual([...finishedClears("moved")], ["next_action", "waiting_on", "blocked_on", "waiting_since"]);
    for (const s of ["completed", "concluded", "delivered", "cancelled", "decided", "retired"]) assert.deepEqual([...finishedClears(s)], ["next_action", "waiting_on"]);
    for (const s of ["active", "blocked", "open", "paused", null]) assert.deepEqual([...finishedClears(s)], []);
    assert.deepEqual(terminalLeftovers({ status: "moved", blocked_on: "Sam", waiting_since: "2026-10-01" }), ["blocked_on", "waiting_since"]);
    assert.deepEqual(terminalLeftovers({ status: "completed", blocked_on: "Sam" }), []);
    // the pointer's pattern is the profile's
    assert.equal(full.handoff.pattern.test("ABC-12"), true);
    assert.equal(full.handoff.pattern.test("https://tracker.example.com/issue/ABC-12"), false);
    assert.equal(full.handoff.field, "tracker_ref");
  });

  test("without a profile there is no handoff: `moved` is not finished and clears nothing", () => {
    assert.equal(generic.handoff, null);
    assert.equal(generic.isTerminal("moved"), false);
    assert.deepEqual([...generic.finishedClears("moved")], []);
    assert.deepEqual(generic.terminalLeftovers({ status: "moved", next_action: "x", blocked_on: "Sam" }), []);
    assert.deepEqual([...generic.finishedClears("completed")], ["next_action", "waiting_on"]);
  });

  test("moved is only on the types the profile extends or adds it to", () => {
    for (const t of ["personal-ops", "agent-ops", "desk-ops", "chore"]) assert.ok(!ITEM_STATUSES[t].includes("moved"), t);
    for (const t of ["app", "infra", "plugin", "vendor", "ops-desk", "research", "decision"]) assert.ok(ITEM_STATUSES[t].includes("moved"), t);
  });

  test("the families, and the statuses a reader knows for each", () => {
    assert.equal(familyOf("desk-ops", "open"), "decision");
    assert.equal(familyOf("desk-ops", "decided"), "decision");
    assert.equal(familyOf("desk-ops", "active"), "work");
    assert.equal(familyOf("decision", "open"), "decision");
    assert.equal(familyOf("chore", "active"), "chore");
    assert.equal(familyOf("nonsense", "active"), "work");
    assert.deepEqual([...FAMILY_STATUSES.work].sort(), ["active", "blocked", "cancelled", "completed", "concluded", "deferred", "delivered", "draft", "idea", "moved", "scoped"]);
    assert.deepEqual([...FAMILY_STATUSES.decision].sort(), ["cancelled", "decided", "moved", "open"]);
    assert.deepEqual([...FAMILY_STATUSES.chore].sort(), ["active", "paused", "retired"]);
    assert.equal(WORK_TYPES.has("decision"), false);
    assert.equal(WORK_TYPES.has("chore"), false);
  });
});

// ── what the generic rules hold, and what a profile adds ─────────────────────

describe("the generic rules, and a profile", () => {
  test("generic: the seven types in their order, no host type, no `moved` anywhere", () => {
    assert.deepEqual(generic.typeNames, ["app", "infra", "plugin", "personal-ops", "research", "decision", "chore"]);
    assert.deepEqual(generic.typeNames, Object.keys(CORE_TYPES));
    for (const [type, statuses] of Object.entries(generic.itemStatuses)) assert.ok(!statuses.includes("moved"), type);
    for (const host of ["vendor", "ops-desk", "agent-ops", "desk-ops"]) assert.equal(generic.types[host], undefined, host);
    for (const family of Object.values(generic.moves)) {
      assert.ok(!("moved" in family));
      for (const to of Object.values(family)) assert.ok(!to.includes("moved"));
    }
    assert.deepEqual(generic.knownKeys, []);
    assert.deepEqual(generic.requireWhen, []);
    assert.equal(generic.workTypes.has("agent-ops"), false);
    assert.equal(generic.familyOf("desk-ops", "open"), "work"); // an unknown type is read as work
    assert.equal(generic.legalMoves("desk-ops", "open").length, 0);
  });

  test("generic: `moved` is no status, so a move to it can't be judged and is never called illegal", () => {
    assert.equal(generic.checkMove("app", "active", "moved"), null);
    assert.deepEqual(generic.legalMoves("app", "idea"), ["draft", "scoped", "active", "cancelled"]);
    assert.deepEqual(generic.legalMoves("decision", "open"), ["decided", "cancelled"]);
  });

  test("profile: the profile's own types follow in the profile's typeOrder", () => {
    assert.deepEqual(full.typeNames, ["app", "infra", "plugin", "vendor", "ops-desk", "personal-ops", "agent-ops", "desk-ops", "research", "decision", "chore"]);
    assert.deepEqual(Object.keys(full.types), full.typeNames);
    assert.deepEqual(Object.keys(full.itemStatuses), full.typeNames);
  });

  test("profile without typeOrder: the generic types, then the profile's in file order; a partial typeOrder lists first", () => {
    const body = { family: "work", statuses: ["idea", "active", "completed"], sections: ["REFERENCES"] };
    const noOrder = checkProfile({ version: 1, types: { zeta: body, alpha: body } });
    assert.deepEqual(noOrder.problems, []);
    assert.deepEqual(createRules({ profile: noOrder.profile }).typeNames, [...Object.keys(CORE_TYPES), "zeta", "alpha"]);
    const partial = checkProfile({ version: 1, typeOrder: ["alpha", "chore"], types: { zeta: body, alpha: body } });
    assert.deepEqual(partial.problems, []);
    assert.deepEqual(createRules({ profile: partial.profile }).typeNames, ["alpha", "chore", "app", "infra", "plugin", "personal-ops", "research", "decision", "zeta"]);
  });

  test("profile: `moved` is appended last to the status lists of the types it extends, after the generic statuses", () => {
    for (const t of ["app", "infra", "plugin", "research", "decision"]) {
      assert.deepEqual(ITEM_STATUSES[t], [...CORE_TYPES[t].statuses, "moved"], t);
      assert.equal(ITEM_STATUSES[t].at(-1), "moved", t);
    }
    // the generic lists are not changed by building rules with a profile
    assert.ok(!CORE_TYPES.app.statuses.includes("moved"));
    assert.ok(!generic.itemStatuses.app.includes("moved"));
  });

  test("profile: `moved` is appended last to every live work status's moves and to decision `open`, and moves nowhere", () => {
    for (const from of ["idea", "draft", "scoped", "active", "blocked", "deferred"]) assert.equal(MOVES.work[from].at(-1), "moved", from);
    assert.equal(MOVES.decision.open.at(-1), "moved");
    assert.deepEqual(MOVES.work.moved, []);
    assert.deepEqual(MOVES.decision.moved, []);
    for (const from of ["completed", "concluded", "delivered", "cancelled"]) assert.ok(!MOVES.work[from].includes("moved"), from);
    for (const from of ["decided", "cancelled"]) assert.ok(!MOVES.decision[from].includes("moved"), from);
    assert.deepEqual(MOVES.chore, generic.moves.chore);
    assert.deepEqual(legalMoves("app", "idea"), ["draft", "scoped", "active", "cancelled", "moved"]);
    // the profile's moves are built on a copy: the generic tables are unchanged by it
    assert.ok(!generic.moves.work.idea.includes("moved"));
    assert.ok(!("moved" in generic.moves.work));
  });

  test("profile: extraMoves come after the family's list and are filtered by the type's own statuses", () => {
    assert.deepEqual(legalMoves("desk-ops", "open"), ["decided", "cancelled", "active"]); // not `moved`: desk-ops has no such status
    assert.deepEqual(MOVES.decision.open, ["decided", "cancelled", "moved"]); // the family table itself has no `active`
    assert.deepEqual(legalMoves("decision", "open"), ["decided", "cancelled", "moved"]); // no extra move on another type
    const extra = checkProfile({
      version: 1,
      types: { wish: { family: "work", statuses: ["idea", "draft", "active", "parked", "completed"], sections: ["REFERENCES"], extraMoves: { idea: ["parked", "completed"] } } },
    });
    assert.deepEqual(extra.problems, []);
    const r = createRules({ profile: extra.profile });
    assert.deepEqual(r.legalMoves("wish", "idea"), ["draft", "active", "parked", "completed"]); // family list (draft, active), then the extras
  });

  test("profile: decisionStatuses make a work type a decision at those statuses, and only for that type", () => {
    assert.deepEqual([...full.decisionStatusesOf("desk-ops")].sort(), ["decided", "open"]);
    assert.equal(full.decisionStatusesOf("app").size, 0);
    assert.equal(full.decisionStatusesOf("nonsense").size, 0);
    assert.equal(familyOf("desk-ops", "open"), "decision");
    assert.equal(familyOf("desk-ops", "blocked"), "work");
    assert.equal(familyOf("vendor", "decided"), "work");
    assert.equal(familyOf("app", "open"), "work");
    assert.equal(familyOf("desk-ops", null), "work");
    assert.equal(generic.familyOf("desk-ops", "open"), "work");
  });

  test("profile: the profile's knownKeys and the handoff field are the extra keys the record tool may set; requireWhen is carried", () => {
    assert.deepEqual(full.knownKeys, ["vendor", "vendor_ref", "vendor_emails", "meeting_codes", "engagement_mode", "tracker_ref"]);
    assert.deepEqual(full.requireWhen, [{ type: "vendor", field: "vendor", exceptStatuses: ["idea", "draft"] }]);
  });
});

// ── the move table ───────────────────────────────────────────────────────────

const WORK_TYPE_LIST = [...WORK_TYPES];
const ok = (type, from, to) => checkMove(type, from, to) === null;

describe("the move table: every rule the prose states", () => {
  test("every table entry names a status of its family, and no status moves to itself", () => {
    for (const [fam, table] of Object.entries(MOVES)) {
      const known = FAMILY_STATUSES[fam];
      for (const [from, tos] of Object.entries(table)) {
        assert.ok(known.has(from), `${fam} ${from}`);
        for (const to of tos) {
          assert.ok(known.has(to), `${fam} ${from} ${to}`);
          assert.notEqual(to, from);
        }
      }
      for (const s of known) assert.notEqual(table[s], undefined, `${fam} ${s}`);
    }
  });

  test("only draft demotes to idea", () => {
    for (const t of WORK_TYPE_LIST)
      for (const from of ITEM_STATUSES[t])
        if (from !== "idea" && familyOf(t, from) === "work") assert.equal(ok(t, from, "idea"), from === "draft", `${t} ${from}`);
  });

  test("an idea never parks, waits, or finishes as done; it is committed, cancelled or moved", () => {
    assert.equal(ok("app", "idea", "draft"), true);
    assert.equal(ok("app", "idea", "scoped"), true);
    assert.equal(ok("app", "idea", "active"), true);
    assert.equal(ok("app", "idea", "cancelled"), true);
    assert.equal(ok("app", "idea", "moved"), true);
    for (const to of ["deferred", "blocked", "completed"]) assert.equal(ok("app", "idea", to), false, to);
    assert.equal(ok("research", "idea", "concluded"), false);
    assert.equal(ok("vendor", "idea", "delivered"), false);
  });

  test("a finished record reopens only through draft, or corrects how it closed", () => {
    for (const t of WORK_TYPE_LIST) {
      for (const from of ITEM_STATUSES[t].filter((s) => TERMINAL.has(s) && s !== "moved" && familyOf(t, s) === "work")) {
        for (const to of ITEM_STATUSES[t].filter((s) => s !== from && familyOf(t, s) === "work")) {
          const legal = to === "draft" || (TERMINAL.has(to) && to !== "moved");
          assert.deepEqual([t, from, to, ok(t, from, to)], [t, from, to, legal]);
        }
      }
    }
    assert.equal(checkMove("agent-ops", "completed", "active"), "`completed` → `active` is not a legal move — from `completed`, a record of type `agent-ops` may go to: draft, cancelled");
    assert.ok(checkMove("infra", "idea", "blocked").includes("a record of type `infra` may go to"));
  });

  test("moved is frozen, and nothing finished moves to the tracker", () => {
    for (const t of ["app", "ops-desk", "research", "decision"])
      for (const to of ITEM_STATUSES[t].filter((s) => s !== "moved")) assert.equal(ok(t, "moved", to), false, `${t} ${to}`);
    assert.ok(checkMove("app", "moved", "active").includes("frozen"));
    assert.equal(ok("app", "completed", "moved"), false);
    assert.equal(ok("decision", "decided", "moved"), false);
    for (const from of ["idea", "draft", "scoped", "active", "blocked", "deferred"]) assert.equal(ok("app", from, "moved"), true, from);
    assert.deepEqual(legalMoves("app", "moved"), []);
    assert.equal(generic.checkMove("app", "moved", "active"), null); // without a profile `moved` is no status of app: nothing to judge
  });

  test("live work moves freely among draft, scoped, active, blocked and deferred, and closes from any of them", () => {
    const live = ["draft", "scoped", "active", "blocked", "deferred"];
    for (const from of live) {
      for (const to of live) if (to !== from) assert.deepEqual([from, to, ok("app", from, to)], [from, to, true]);
      for (const to of ["completed", "cancelled"]) assert.equal(ok("app", from, to), true);
    }
  });

  test("decisions: open → decided | cancelled | moved; a closed decision reopens to open", () => {
    assert.deepEqual(legalMoves("decision", "open"), ["decided", "cancelled", "moved"]);
    assert.equal(ok("decision", "decided", "open"), true);
    assert.equal(ok("decision", "cancelled", "open"), true);
    assert.deepEqual(legalMoves("decision", "moved"), []);
  });

  test("desk-ops: open → active is the one move across families; it never moves to the tracker", () => {
    assert.equal(ok("desk-ops", "open", "active"), true);
    assert.equal(ok("desk-ops", "open", "decided"), true);
    assert.equal(ok("desk-ops", "open", "deferred"), false);
    assert.deepEqual(legalMoves("desk-ops", "open"), ["decided", "cancelled", "active"]);
    assert.ok(!legalMoves("agent-ops", "active").includes("moved"));
    assert.ok(!legalMoves("desk-ops", "active").includes("moved"));
  });

  test("chores: active ⇄ paused, either → retired, retired reopens", () => {
    assert.deepEqual(legalMoves("chore", "active"), ["paused", "retired"]);
    assert.deepEqual(legalMoves("chore", "paused"), ["active", "retired"]);
    assert.deepEqual(legalMoves("chore", "retired"), ["active", "paused"]);
  });

  test("what cannot be judged is never called illegal", () => {
    assert.equal(checkMove("app", "active", "active"), null); // no move
    assert.equal(checkMove("app", null, "active"), null); // a new record
    assert.equal(checkMove("nonsense", "idea", "blocked"), null); // unknown type
    assert.equal(checkMove("agent-ops", "open", "scoped"), null); // retyped in the same write: `open` is not an agent-ops status
    assert.equal(checkMove("app", "uat-test", "completed"), null); // a pre-v2 status
  });
});

// Every status move a real store's records made in git history, as [type, from, to, times], mined from
// `git log -p -- <data>/items` (moves between pre-v2 statuses, and retypes, left out). All are legal except the
// four marked: each is one the prose forbids.
const HISTORY = [
  ["agent-ops", "completed", "active", 1], // forbidden by the prose
  ["infra", "idea", "completed", 1], // forbidden by the prose
  ["desk-ops", "open", "deferred", 1], // forbidden by the prose
  ["ops-desk", "completed", "active", 1], // forbidden by the prose
  ["app", "active", "blocked", 1],
  ["app", "active", "completed", 16],
  ["app", "active", "deferred", 1],
  ["app", "active", "moved", 2],
  ["app", "blocked", "active", 1],
  ["app", "blocked", "cancelled", 1],
  ["app", "draft", "active", 2],
  ["app", "draft", "cancelled", 15],
  ["app", "draft", "completed", 3],
  ["app", "scoped", "moved", 1],
  ["chore", "active", "retired", 2],
  ["vendor", "active", "cancelled", 3],
  ["vendor", "active", "completed", 1],
  ["vendor", "active", "deferred", 4],
  ["vendor", "active", "moved", 4],
  ["vendor", "deferred", "active", 4],
  ["vendor", "draft", "active", 1],
  ["vendor", "draft", "cancelled", 3],
  ["vendor", "draft", "deferred", 2],
  ["vendor", "draft", "scoped", 2],
  ["vendor", "scoped", "active", 1],
  ["vendor", "scoped", "cancelled", 1],
  ["decision", "open", "cancelled", 3],
  ["decision", "open", "decided", 21],
  ["decision", "open", "moved", 5],
  ["agent-ops", "active", "completed", 9],
  ["agent-ops", "blocked", "active", 1],
  ["agent-ops", "draft", "completed", 3],
  ["agent-ops", "draft", "deferred", 1],
  ["agent-ops", "draft", "idea", 2],
  ["agent-ops", "scoped", "active", 5],
  ["agent-ops", "scoped", "completed", 1],
  ["agent-ops", "scoped", "deferred", 2],
  ["infra", "active", "cancelled", 12],
  ["infra", "active", "completed", 69],
  ["infra", "active", "deferred", 5],
  ["infra", "active", "moved", 11],
  ["infra", "blocked", "cancelled", 1],
  ["infra", "blocked", "completed", 1],
  ["infra", "completed", "cancelled", 2],
  ["infra", "deferred", "active", 1],
  ["infra", "deferred", "cancelled", 4],
  ["infra", "deferred", "moved", 3],
  ["infra", "draft", "active", 13],
  ["infra", "draft", "blocked", 1],
  ["infra", "draft", "cancelled", 33],
  ["infra", "draft", "completed", 5],
  ["infra", "draft", "deferred", 6],
  ["infra", "draft", "idea", 6],
  ["infra", "draft", "scoped", 7],
  ["infra", "idea", "cancelled", 3],
  ["infra", "scoped", "active", 10],
  ["infra", "scoped", "cancelled", 2],
  ["infra", "scoped", "completed", 2],
  ["infra", "scoped", "deferred", 3],
  ["personal-ops", "active", "completed", 2],
  ["personal-ops", "blocked", "active", 1],
  ["personal-ops", "draft", "deferred", 1],
  ["plugin", "active", "cancelled", 2],
  ["plugin", "active", "completed", 13],
  ["plugin", "blocked", "active", 1],
  ["plugin", "blocked", "draft", 1],
  ["plugin", "deferred", "cancelled", 1],
  ["plugin", "draft", "active", 1],
  ["plugin", "draft", "cancelled", 2],
  ["plugin", "draft", "deferred", 3],
  ["plugin", "draft", "idea", 3],
  ["plugin", "draft", "scoped", 2],
  ["plugin", "idea", "cancelled", 4],
  ["plugin", "scoped", "active", 7],
  ["plugin", "scoped", "deferred", 1],
  ["research", "active", "cancelled", 2],
  ["research", "active", "concluded", 13],
  ["research", "active", "moved", 3],
  ["research", "deferred", "cancelled", 2],
  ["research", "draft", "active", 1],
  ["research", "draft", "cancelled", 19],
  ["research", "draft", "concluded", 5],
  ["research", "draft", "deferred", 2],
  ["research", "draft", "idea", 2],
  ["ops-desk", "active", "blocked", 5],
  ["ops-desk", "active", "cancelled", 9],
  ["ops-desk", "active", "completed", 16],
  ["ops-desk", "active", "deferred", 7],
  ["ops-desk", "active", "moved", 3],
  ["ops-desk", "blocked", "active", 2],
  ["ops-desk", "blocked", "cancelled", 1],
  ["ops-desk", "blocked", "completed", 2],
  ["ops-desk", "deferred", "active", 1],
  ["ops-desk", "deferred", "completed", 1],
  ["ops-desk", "deferred", "moved", 4],
  ["ops-desk", "draft", "active", 4],
  ["ops-desk", "draft", "cancelled", 12],
  ["ops-desk", "draft", "completed", 6],
  ["ops-desk", "draft", "deferred", 4],
  ["ops-desk", "draft", "idea", 2],
  ["ops-desk", "draft", "moved", 6],
];
const FORBIDDEN = new Set(["agent-ops completed active", "infra idea completed", "desk-ops open deferred", "ops-desk completed active"]);

describe("the move table against the history", () => {
  test("every move the records made is legal, except the four the prose forbids", () => {
    const illegal = HISTORY.filter(([t, f, to]) => !ok(t, f, to)).map(([t, f, to]) => `${t} ${f} ${to}`);
    assert.deepEqual(illegal.sort(), [...FORBIDDEN].sort());
    const moves = HISTORY.reduce((n, [, , , k]) => n + k, 0);
    assert.equal(moves, 507);
    assert.equal(HISTORY.length, 101);
  });
});

// ── who holds the ball ────────────────────────────────────────────────────────

describe("who holds the ball", () => {
  test("owner: absent means the operator; matched exactly, never an agent", () => {
    assert.equal(ownerOf({}), "operator");
    assert.equal(ownerOf({ owner: "null" }), "operator");
    assert.equal(ownerOf({ owner: "ghost" }), "ghost");
    // `alex` is the operator name this suite gives the rules
    for (const o of ["operator", "Operator", "alex", "ALEX", " operator "]) assert.equal(isOperator(o), true, o);
    for (const o of ["Operator #1", "ghost", "Alex Doe", "", null]) assert.equal(isOperator(o), false, String(o));
  });

  test("a waiting party names the operator when it starts with the word, never an agent", () => {
    for (const w of ["operator", "Alex", "Alex — verdict on the lap-1 cut", "Alex: approve the plan", "Alex's design rulings", "Operator — PR 1 merge"])
      assert.deepEqual([w, namesOperator(w)], [w, true]);
    for (const w of ["Operator #3 — the merge", "Operator#3", "Sam", "ALPHA-901 (auth) — Alex's call", "Alexandria vendor", null])
      assert.deepEqual([w, namesOperator(w)], [w, false]);
  });

  test("the operator's names are a setting: `operator` always counts, a name counts as a whole word in any case, an agent never does", () => {
    const none = createRules({ operatorNames: [] });
    for (const o of ["operator", "OPERATOR"]) assert.equal(none.isOperator(o), true, o);
    assert.equal(none.isOperator("alex"), false);
    assert.equal(none.namesOperator("alex — the go"), false);
    assert.equal(none.namesOperator("Operator — the go"), true);
    assert.equal(createRules().isOperator("alex"), false); // no names given at all
    const sam = createRules({ operatorNames: ["Sam", "Pat Lee"] });
    for (const o of ["sam", "SAM", "pat lee", "Operator"]) assert.equal(sam.isOperator(o), true, o);
    for (const o of ["Samuel", "Sam Lee", "Pat", "Operator #1"]) assert.equal(sam.isOperator(o), false, o);
    for (const w of ["Sam — verdict", "sam: yes", "Sam's call", "Pat Lee, please decide", "PAT LEE"]) assert.equal(sam.namesOperator(w), true, w);
    for (const w of ["Samuel's call", "Pat", "Sam #2 — the merge", "Sam#2", "Patrick Lee", "The Sam call"]) assert.equal(sam.namesOperator(w), false, w); // the agent guard holds for every name
    assert.equal(sam.waitsOnOperator({ waiting_on: "Sam — verdict" }), true);
    assert.equal(sam.onOperatorsDesk({ owner: "sam" }), true);
    assert.equal(sam.onOperatorsDesk({ owner: "ghost", waiting_on: "Samuel" }), false);
  });

  test("a name with a regex metacharacter matches only itself", () => {
    const dotted = createRules({ operatorNames: ["a.b", "R.J. Sam"] });
    assert.equal(dotted.isOperator("a.b"), true);
    assert.equal(dotted.isOperator("axb"), false);
    assert.equal(dotted.namesOperator("a.b — please"), true);
    assert.equal(dotted.namesOperator("axb — please"), false);
    assert.equal(dotted.isOperator("R.J. Sam"), true);
    assert.equal(dotted.isOperator("RxJx Sam"), false);
  });

  test("waiting_on is read first; blocked_on is the party only when waiting_on is null", () => {
    assert.equal(waitingParty({ waiting_on: "Sam", blocked_on: "Alex — x" }), "Sam");
    assert.equal(waitingParty({ waiting_on: "null", blocked_on: "Alex — x" }), "Alex — x");
    assert.equal(waitingParty({}), null);
    assert.equal(waitsOnOperator({ waiting_on: "Sam", blocked_on: "Alex — x" }), false);
    assert.equal(waitsOnOperator({ waiting_on: null, blocked_on: "Alex — x" }), true);
    assert.equal(waitsOnOperator({ waiting_on: "operator" }), true);
  });

  test("on the operator's desk: they own it, or it waits on them", () => {
    assert.equal(onOperatorsDesk({ owner: "ghost", waiting_on: "operator" }), true);
    assert.equal(onOperatorsDesk({ owner: "ghost", waiting_on: "Alex — verdict" }), true);
    assert.equal(onOperatorsDesk({ owner: "operator", waiting_on: "Sam" }), true);
    assert.equal(onOperatorsDesk({ waiting_on: "Sam" }), true);
    assert.equal(onOperatorsDesk({ owner: "ghost", waiting_on: "Sam" }), false);
    assert.equal(onOperatorsDesk({ owner: "ghost", waiting_on: "Operator #3" }), false);
    assert.equal(onOperatorsDesk({ owner: "ghost" }), false);
  });

  test("waiting_since dates a wait: blocked, or waiting_on set", () => {
    assert.equal(isWaiting({ status: "blocked" }), true);
    assert.equal(isWaiting({ status: "active", waiting_on: "Sam" }), true);
    assert.equal(isWaiting({ status: "active" }), false);
    assert.equal(waitProblems({ status: "active", waiting_since: "2026-11-01" }).length, 1);
    assert.equal(waitProblems({ status: "completed", waiting_since: "2026-11-01" }).length, 1);
    assert.deepEqual(waitProblems({ status: "moved", waiting_since: "2026-11-01" }), []); // the finished-record rule reports it
    assert.deepEqual(waitProblems({ status: "active", waiting_on: "operator", waiting_since: "2026-11-01" }), []);
    assert.deepEqual(waitProblems({ status: "blocked", blocked_on: "Sam", waiting_since: "2026-11-01" }), []);
    assert.deepEqual(waitProblems({ status: "active", waiting_since: "null" }), []);
    // without a profile `moved` is not finished: its leftover date is this rule's to report
    assert.equal(generic.waitProblems({ status: "moved", waiting_since: "2026-11-01" }).length, 1);
  });
});

// ── the readers: render-subitems, and the validator ───────────────────────────

let data = "";

const record = (id, fields) => {
  const fm = Object.entries({ id, title: `Title ${id}`, type: "agent-ops", priority: "medium", created: "2026-01-01", updated: "2026-01-01", ...fields })
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  writeFileSync(join(data, "items", `${id}.md`), `---\n${fm}\n---\n# ${id}: x\n## DESCRIPTION\nx\n## REFERENCES\nx\n## ACTIVITY_LOG\nx\n`);
};

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "record-rules-"));
  mkdirSync(join(scratch, "claude-config"));
  data = join(scratch, "backlog");
  mkdirSync(join(data, "items"), { recursive: true });
  const na = { next_action: "the operator answers the four questions" };
  // a parent and its sub-items, one in every finished status a sub-item can take here
  record("ALPHA-130", { status: "active", owner: "ghost", ...na });
  record("ALPHA-131", { type: "decision", status: "decided", parent: "ALPHA-130", question: "Which?", decided: "a", decided_on: "2026-10-01" });
  record("ALPHA-132", { type: "chore", status: "retired", parent: "ALPHA-130" });
  record("ALPHA-133", { status: "completed", parent: "ALPHA-130" });
  record("ALPHA-134", { status: "active", parent: "ALPHA-130", ...na });
  record("ALPHA-135", { type: "decision", status: "open", parent: "ALPHA-130", question: "Which?" });
  // a second parent whose only sub-item was handed off
  record("ALPHA-160", { type: "app", status: "active", ...na });
  record("ALPHA-161", { type: "app", status: "moved", parent: "ALPHA-160", tracker_ref: "ABC-12" });
});

after(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("render-subitems ticks every finished sub-item", () => {
  test("decided and retired are ticked like completed; open ones are not", () => {
    const body = renderBody("ALPHA-130", join(data, "items"), full.terminal);
    assert.deepEqual(body.split("\n"), [
      "- [x] ALPHA-131 — Title ALPHA-131 · decision · decided",
      "- [x] ALPHA-132 — Title ALPHA-132 · chore · retired",
      "- [x] ALPHA-133 — Title ALPHA-133 · agent-ops · completed",
      "- [ ] ALPHA-134 — Title ALPHA-134 · agent-ops · active",
      "- [ ] ALPHA-135 — Title ALPHA-135 · decision · open",
    ]);
  });

  test("a handed-off sub-item is ticked only when the rules know the handoff status", () => {
    assert.deepEqual(renderBody("ALPHA-160", join(data, "items"), full.terminal).split("\n"), ["- [x] ALPHA-161 — Title ALPHA-161 · app · moved"]);
    assert.deepEqual(renderBody("ALPHA-160", join(data, "items"), generic.terminal).split("\n"), ["- [ ] ALPHA-161 — Title ALPHA-161 · app · moved"]);
    assert.equal(renderBody("ALPHA-999", join(data, "items"), full.terminal), "_No sub-items._");
  });
});

describe("one empty value everywhere", () => {
  test("an active record with next_action: \"\" lacks a next action for the validator", () => {
    const file = join(data, "items", "ALPHA-140.md");
    writeFileSync(file, `---\nid: ALPHA-140\ntitle: "Empty next action"\ntype: agent-ops\nstatus: active\npriority: medium\ncreated: 2026-01-01\nupdated: 2026-01-01\nnext_action: ""\n---\n# ALPHA-140: x\n## DESCRIPTION\nx\n## REFERENCES\nx\n## ACTIVITY_LOG\nx\n`);
    try {
      const v = validate(file);
      assert.equal(v.code, 2);
      assert.ok(v.err.includes("`status: active` requires a non-null `next_action`"), v.err);
    } finally {
      rmSync(file, { force: true });
    }
  });

  test("a quoted empty value is empty for every reader of the module", () => {
    for (const v of ["", '""', "''", "null", "~", undefined, null]) assert.deepEqual([v, terminalLeftovers({ status: "completed", next_action: v })], [v, []]);
    assert.equal(waitsOnOperator({ waiting_on: '""', blocked_on: "Alex — the go" }), true);
  });
});

describe("a handed-off record gets one finding per live field, never an error plus a warning", () => {
  const moved = (extra) =>
    `---\nid: ALPHA-150\ntitle: "Moved"\ntype: infra\nstatus: moved\npriority: medium\ncreated: 2026-01-01\nupdated: 2026-01-01\ntracker_ref: ABC-12\n${extra}---\n# ALPHA-150: x\n## DESCRIPTION\nx\n## CURRENT_STATE\nx\n## REQUIREMENTS\nx\n## ARCHITECTURE\nx\n## IMPLEMENTATION\nx\n## REFERENCES\nx\n## ACTIVITY_LOG\n- 2026-11-07: moved to the tracker as ABC-12: https://tracker.example.com/issue/ABC-12/x\n`;
  const run = (text, opts) => {
    const file = join(data, "items", "ALPHA-150.md");
    writeFileSync(file, text);
    try {
      return validate(file, opts);
    } finally {
      rmSync(file, { force: true });
    }
  };

  test("the frozen shape is clean", () => {
    assert.deepEqual(run(moved("")), { code: 0, err: "" });
  });

  for (const [field, value] of [["next_action", '"Ship it"'], ["waiting_on", "operator"], ["blocked_on", "Sam"], ["waiting_since", "2026-10-01"]]) {
    test(`moved with ${field} set: one block, nothing else`, () => {
      const r = run(moved(`${field}: ${value}\n`));
      assert.equal(r.code, 2);
      const findings = r.err.split("\n").filter((l) => l.startsWith("  - "));
      assert.deepEqual(findings, [`  - \`status: moved\` requires a null \`${field}\` — the record is frozen and its work lives in the tracker; null it`]);
    });
  }

  test("all four live fields set: four blocks, once each, in the rule's order", () => {
    const r = run(moved('next_action: "Ship it"\nwaiting_on: operator\nblocked_on: Sam\nwaiting_since: 2026-10-01\n'));
    assert.equal(r.code, 2);
    const findings = r.err.split("\n").filter((l) => l.startsWith("  - "));
    assert.equal(findings.length, 4);
    assert.deepEqual(findings.map((f) => /null `(\w+)`/.exec(f)[1]), [...HANDOFF_NULL_FIELDS]);
    assert.ok(!r.err.includes("(warning)"));
  });

  test("the other finished statuses only warn, and on two fields", () => {
    const done = moved('next_action: "Ship it"\nblocked_on: Sam\n').replace("status: moved", "status: completed").replace("tracker_ref: ABC-12\n", "");
    const r = run(done);
    assert.equal(r.code, 1);
    assert.ok(r.err.startsWith("⚠ ALPHA-150.md is valid, with a non-blocking warning:"), r.err);
    const findings = r.err.split("\n").filter((l) => l.startsWith("  - "));
    assert.equal(findings.length, 1);
    assert.ok(findings[0].includes("`next_action`"));
  });

  test("without the profile `moved` is no status at all: the record is refused as an invalid status, and the pointer key is unknown and ignored", () => {
    const r = run(moved(""), { withProfile: false });
    assert.equal(r.code, 2);
    const findings = r.err.split("\n").filter((l) => l.startsWith("  - "));
    assert.equal(findings.length, 1);
    assert.ok(findings[0].startsWith("  - status `moved` is not valid here (allowed: idea, draft, scoped, active, blocked, completed, deferred, cancelled)"), findings[0]);
  });
});

describe("names every object inherits find nothing in the tables", () => {
  const INHERITED = ["constructor", "__proto__", "toString", "hasOwnProperty"];

  test("an inherited name is an unknown type to every reader, with or without a profile", () => {
    for (const rules of [generic, full])
      for (const t of INHERITED) {
        assert.equal(rules.types[t], undefined, t);
        assert.equal(rules.itemStatuses[t], undefined, t);
        assert.equal(rules.familyOf(t), "work", t);
        assert.equal(rules.familyOf(t, "active"), "work", t);
        assert.equal(rules.decisionStatusesOf(t).size, 0, t);
        assert.deepEqual(rules.legalMoves(t, "idea"), [], t);
        assert.equal(rules.checkMove(t, "active", "idea"), null, t);
        assert.equal(rules.checkMove("app", t, "active"), null, `${t} as the old status`);
        assert.equal(rules.checkMove("app", "active", t), null, `${t} as the new status`);
        assert.deepEqual(rules.legalMoves("app", t), [], t);
      }
  });

  test("a profile type may have a status named like an inherited key; its moves come from the table alone", () => {
    const { profile: p, problems } = checkProfile({ version: 1, types: { widget: { family: "work", statuses: ["idea", "constructor", "active", "completed"] } } });
    assert.deepEqual(problems, []);
    const rules = createRules({ profile: p });
    assert.deepEqual(rules.legalMoves("widget", "constructor"), []);
    assert.equal(rules.checkMove("widget", "constructor", "active"), "`constructor` → `active` is not a legal move — `constructor` is final for a record of type `widget`");
    assert.ok(rules.checkMove("widget", "idea", "constructor").startsWith("`idea` → `constructor` is not a legal move"));
    assert.equal(rules.checkMove("widget", "idea", "active"), null);
  });

  test("a profile type named `constructor` is the profile's own type, and without the profile it is unknown", () => {
    const { profile: p, problems } = checkProfile({ version: 1, types: { constructor: { family: "chore", statuses: ["active", "retired"] } } });
    assert.deepEqual(problems, []);
    const rules = createRules({ profile: p });
    assert.equal(rules.familyOf("constructor", "active"), "chore");
    assert.deepEqual(rules.legalMoves("constructor", "active"), ["retired"]);
    assert.ok(rules.typeNames.includes("constructor"));
    assert.ok(!generic.typeNames.includes("constructor"));
  });
});
