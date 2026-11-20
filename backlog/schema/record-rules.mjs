/**
 * schema/record-rules.mjs: the record rules of the backlog, defined once.
 *
 * Every reader of a record used to keep its own copy of these rules, and the copies drifted. This module is
 * the one copy:
 *
 *   1. the status values of every record type, arcs and initiatives;
 *   2. the families (work, decision, chore) a type and status fall in;
 *   3. the finished (terminal) set, and the fields a finished record must not carry;
 *   4. the legal moves between statuses (moves), and checkMove;
 *   5. what "waiting on the operator" means across `owner`, `waiting_on`, `blocked_on` and `waiting_since`.
 *
 * The generic types live here. A profile (schema/profile.mjs) adds types, appends statuses to these, and turns
 * on named rules; createRules({ operatorNames, profile }) puts the two together and returns the functions every
 * reader uses. Pure: no file, git or network access; values in, answers out.
 *
 * Imported by schema/validate.mjs, schema/render-subitems.mjs and scripts/record-edit.mjs. It sits in schema/
 * because the validator and everything it imports stay in that one folder: a records repository's CI checks
 * out only schema/.
 *
 * Mirrors schema/schema.md: change them together, in one commit (INVARIANTS.md I-4, I-20).
 */

// ── The generic types ─────────────────────────────────────────────────────────

/**
 * Each item type: its family, its statuses (in the order the validator lists them in its messages), the
 * sections a record must carry, and the fields it must set. `decision` is a question on someone's desk
 * (open to decided or cancelled); `chore` is recurring upkeep (active or paused, then retired); every other
 * type is work.
 */
export const CORE_TYPES = {
  app: {
    family: "work",
    statuses: ["idea", "draft", "scoped", "active", "blocked", "completed", "deferred", "cancelled"],
    sections: ["DESCRIPTION", "CURRENT_STATE", "REQUIREMENTS", "DOD", "UAT", "DEPLOYMENT", "REFERENCES", "ACTIVITY_LOG"],
    fields: [],
  },
  infra: {
    family: "work",
    statuses: ["idea", "draft", "scoped", "active", "blocked", "completed", "deferred", "cancelled"],
    sections: ["DESCRIPTION", "CURRENT_STATE", "REQUIREMENTS", "ARCHITECTURE", "IMPLEMENTATION", "REFERENCES", "ACTIVITY_LOG"],
    fields: [],
  },
  plugin: {
    family: "work",
    statuses: ["idea", "draft", "scoped", "active", "blocked", "completed", "deferred", "cancelled"],
    sections: ["DESCRIPTION", "CURRENT_STATE", "REQUIREMENTS", "PLUGIN_SURFACE", "ARCHITECTURE", "DISTRIBUTION", "CLIENT_CONTEXT", "DOD", "UAT", "REFERENCES", "ACTIVITY_LOG"],
    fields: [],
  },
  "personal-ops": {
    family: "work",
    statuses: ["idea", "draft", "active", "blocked", "completed", "deferred", "cancelled"],
    sections: ["DESCRIPTION", "REQUIREMENTS", "CONTACTS", "DELIVERABLES", "REFERENCES", "ACTIVITY_LOG"],
    fields: [],
  },
  research: {
    family: "work",
    statuses: ["idea", "draft", "active", "blocked", "concluded", "deferred", "cancelled"],
    sections: ["DESCRIPTION", "CURRENT_STATE", "HYPOTHESIS", "FINDINGS", "REFERENCES", "ACTIVITY_LOG"],
    fields: [],
  },
  decision: {
    family: "decision",
    statuses: ["open", "decided", "cancelled"],
    sections: ["CONTEXT", "OPTIONS", "RECOMMENDATION", "OUTCOME", "REFERENCES", "ACTIVITY_LOG"],
    fields: ["question"],
  },
  chore: {
    family: "chore",
    statuses: ["active", "paused", "retired"],
    sections: ["DESCRIPTION", "PROCEDURE", "REFERENCES", "ACTIVITY_LOG"],
    fields: [],
  },
};

/**
 * Whether `name` is a generic type. A record's or a profile's text names a type, so it is looked up as an own key:
 * `constructor`, `toString` or `__proto__` would otherwise find what every object inherits.
 */
export const isCoreType = (name) => typeof name === "string" && Object.hasOwn(CORE_TYPES, name);

/**
 * A lookup table with no prototype, filled from [key, value] pairs. A key from a record's or a profile's text then
 * finds only what the table holds, never an inherited `constructor` or `__proto__`.
 */
export const table = (entries = []) => {
  const t = Object.create(null);
  for (const [k, v] of entries) t[k] = v;
  return t;
};

/** Arc statuses (records under <data>/arcs/). */
export const ARC_STATUSES = ["active", "paused", "completed", "cancelled"];

/** Initiative statuses (records under <data>/initiatives/). */
export const INITIATIVE_STATUSES = ["draft", "active", "completed", "cancelled"];

/** Statuses that mean the record is finished. A profile's handoff status joins them. */
const CORE_TERMINAL = ["completed", "concluded", "delivered", "cancelled", "decided", "retired"];

/** Fields a finished record must not carry: finished work has no next action and waits on no one. */
export const TERMINAL_CLEARS = ["next_action", "waiting_on"];

/**
 * A handed-off record is frozen: beyond `status` and its pointer it carries nothing live, so it also clears
 * `blocked_on` and `waiting_since`. The validator BLOCKs on it; on the other finished statuses TERMINAL_CLEARS
 * only WARNs, so no record written before the rule is stopped.
 */
export const HANDOFF_NULL_FIELDS = ["next_action", "waiting_on", "blocked_on", "waiting_since"];

/** The live work statuses a record can be handed off from. */
const LIVE_WORK = ["idea", "draft", "scoped", "active", "blocked", "deferred"];

/**
 * The legal status moves, per family: moves[family][from] lists every `to`. A move is a change of `status` in
 * one write; creating a record may start it at any status of its type. A type that lacks a status simply never
 * reaches it: the validator refuses the status itself.
 *
 * Work:
 *   - `idea` is uncommitted: it goes to draft or scoped (the commitment act), to active (allowed,
 *     discouraged), or is cancelled. It never parks (`deferred`) or waits (`blocked`), and it is never
 *     finished as done.
 *   - Only `draft` demotes to `idea`; committed work being put down is `deferred`.
 *   - Live work moves freely between draft, scoped, active, blocked and deferred, and closes with any finished
 *     status.
 *   - A finished record reopens only through `draft`; it may also correct how it closed (completed to
 *     cancelled, and the like).
 * Decisions: `open` goes to decided or cancelled; a closed decision reopens to `open` (a decision has no
 *   draft) or corrects how it closed.
 * Chores: active and paused move both ways, either goes to retired; a retired chore reopens to active or paused.
 */
const BASE_MOVES = {
  work: {
    idea: ["draft", "scoped", "active", "cancelled"],
    draft: ["idea", "scoped", "active", "blocked", "deferred", "completed", "concluded", "delivered", "cancelled"],
    scoped: ["draft", "active", "blocked", "deferred", "completed", "concluded", "delivered", "cancelled"],
    active: ["draft", "scoped", "blocked", "deferred", "completed", "concluded", "delivered", "cancelled"],
    blocked: ["draft", "scoped", "active", "deferred", "completed", "concluded", "delivered", "cancelled"],
    deferred: ["draft", "scoped", "active", "blocked", "completed", "concluded", "delivered", "cancelled"],
    completed: ["draft", "concluded", "delivered", "cancelled"],
    concluded: ["draft", "completed", "delivered", "cancelled"],
    delivered: ["draft", "completed", "concluded", "cancelled"],
    cancelled: ["draft", "completed", "concluded", "delivered"],
  },
  decision: {
    open: ["decided", "cancelled"],
    decided: ["open", "cancelled"],
    cancelled: ["open", "decided"],
  },
  chore: {
    active: ["paused", "retired"],
    paused: ["active", "retired"],
    retired: ["active", "paused"],
  },
};

// ── Who holds the ball: owner, waiting_on, blocked_on, waiting_since ──────────
//
// Values are frontmatter values with their YAML quotes already stripped.
//
//   owner          who must act next. Absent or null means the operator: the backlog is theirs until a piece is
//                  delegated. Matched exactly: `operator` or one of the operator's names, never an agent such
//                  as `Operator #1`.
//   waiting_on     the party the record waits on: `operator` is the canonical value for the operator; a name, a
//                  PR or issue link, a vendor otherwise. Read first.
//   blocked_on     the human-readable reason while `blocked`; the waiting party only when `waiting_on` is null
//                  (the legacy rule, kept for records written before `waiting_on` existed).
//   waiting_since  the date a wait began. A record waits when it is `blocked` or carries `waiting_on`; outside a
//                  wait the date is a leftover. A block older than BLOCK_AGING_DAYS is for the operator to chase
//                  or release.
//
// A record WAITS ON THE OPERATOR when its waiting party names them: the party starts with the word `operator`
// or one of the operator's names (so "Sam, verdict on the cut" and "Sam's design rulings" count), but not when
// the word names an agent ("Operator #3 ...").

export const OPERATOR = "operator";
export const BLOCK_AGING_DAYS = 30;

/** Empty: absent, null, `null`, `~`, or an empty string, quoted (`""`, `''`) or not. */
export const isNull = (v) => v === undefined || v === null || v === "" || v === "null" || v === "~" || v === '""' || v === "''";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The rules of one backlog: the generic types, plus a profile's, plus the operator's names.
 *   operatorNames  the names the operator goes by, besides the word `operator` (already checked: schema/config.mjs)
 *   profile        a checked profile (schema/profile.mjs), or null
 */
export function createRules({ operatorNames = [], profile = null } = {}) {
  // ── 1. Types ──
  const specs = table();
  for (const [name, spec] of Object.entries(CORE_TYPES)) {
    specs[name] = { family: spec.family, statuses: [...spec.statuses], sections: [...spec.sections], sectionsAnyOf: [], fields: [...spec.fields], decisionStatuses: [], extraMoves: table() };
  }
  if (profile) {
    for (const [name, ext] of Object.entries(profile.extend)) specs[name].statuses.push(...ext.statuses);
    for (const [name, spec] of Object.entries(profile.types)) {
      specs[name] = {
        family: spec.family,
        statuses: [...spec.statuses],
        sections: [...spec.sections],
        sectionsAnyOf: spec.sectionsAnyOf.map((group) => [...group]),
        fields: [...spec.fields],
        decisionStatuses: [...spec.decisionStatuses],
        extraMoves: table(Object.entries(spec.extraMoves).map(([from, to]) => [from, [...to]])),
      };
    }
  }
  const listed = profile ? profile.typeOrder.filter((n) => specs[n]) : [];
  const typeNames = [...listed, ...Object.keys(specs).filter((n) => !listed.includes(n))];
  const types = table(typeNames.map((n) => [n, specs[n]]));
  const itemStatuses = table(typeNames.map((n) => [n, types[n].statuses]));
  const workTypes = new Set(typeNames.filter((n) => types[n].family === "work"));

  const handoff = profile && profile.handoff ? { status: profile.handoff.status, field: profile.handoff.field, pattern: new RegExp(profile.handoff.pattern) } : null;
  const knownKeys = profile ? [...profile.knownKeys, ...(handoff ? [handoff.field] : [])] : [];
  const requireWhen = profile ? profile.requireWhen : [];

  // ── 2. Families ──
  /**
   * Which rule family a record falls in: `decision` for a decision, or a work type at one of its decision
   * statuses; `chore` for a chore; `work` for everything else (an unknown type included, so a reader can still
   * print it).
   */
  const familyOf = (type, status) => {
    const spec = type ? types[type] : undefined;
    if (!spec) return "work";
    if (spec.family === "decision" || (!!status && spec.decisionStatuses.includes(status))) return "decision";
    return spec.family;
  };
  /** The statuses at which a type acts as a decision while it is work (none for most types). */
  const decisionStatusesOf = (type) => new Set(type && types[type] ? types[type].decisionStatuses : []);
  /** Every status a family can hold, across its types: a reader's "known status" check. */
  const union = (lists, drop = new Set()) => new Set(lists.flat().filter((s) => !drop.has(s)));
  const allDecisionStatuses = new Set(typeNames.flatMap((n) => types[n].decisionStatuses));
  const familyStatuses = {
    work: union([...workTypes].map((t) => types[t].statuses), allDecisionStatuses),
    decision: union([...typeNames.filter((n) => types[n].family === "decision").map((n) => types[n].statuses), [...allDecisionStatuses]]),
    chore: union(typeNames.filter((n) => types[n].family === "chore").map((n) => types[n].statuses)),
  };

  // ── 3. The finished set ──
  const terminal = new Set(CORE_TERMINAL);
  if (handoff) terminal.add(handoff.status);
  const isTerminal = (status) => !!status && terminal.has(status);
  /** The one finished-record rule: the fields a record at `status` must clear (none while it is live). */
  const finishedClears = (status) => {
    if (handoff && status === handoff.status) return HANDOFF_NULL_FIELDS;
    return isTerminal(status) ? TERMINAL_CLEARS : [];
  };
  /** The fields a finished record still carries that it must clear, each reported once, here. */
  const terminalLeftovers = (fm) => finishedClears(fm.status ?? null).filter((f) => !isNull(fm[f]));

  // ── 4. Legal moves ──
  const moves = table([["work", table()], ["decision", table()], ["chore", table()]]);
  for (const [family, table] of Object.entries(BASE_MOVES)) for (const [from, to] of Object.entries(table)) moves[family][from] = [...to];
  if (handoff) {
    for (const from of LIVE_WORK) moves.work[from].push(handoff.status);
    moves.decision.open.push(handoff.status);
    moves.work[handoff.status] = [];
    moves.decision[handoff.status] = [];
  }
  /** Every status a record of `type` may move to from `from` (empty when it can't be judged). */
  const legalMoves = (type, from) => {
    const spec = types[type];
    if (!spec || !spec.statuses.includes(from)) return [];
    const family = familyOf(type, from);
    const extra = spec.extraMoves[from] ?? [];
    return [...(moves[family][from] ?? []), ...extra].filter((to) => spec.statuses.includes(to));
  };
  /**
   * Judges one status move of an item of `type` (the type after the write). Returns null when the move is
   * legal, is no move, or can't be judged (an unknown type, or a `from` the type doesn't have: a retype in the
   * same write); otherwise the reason, naming the legal moves.
   */
  const checkMove = (type, from, to) => {
    if (!type || !from || !to || from === to) return null;
    const spec = types[type];
    if (!spec || !spec.statuses.includes(from) || !spec.statuses.includes(to)) return null;
    const legal = legalMoves(type, from);
    if (legal.includes(to)) return null;
    if (handoff && from === handoff.status) return `\`${from}\` → \`${to}\` is not a legal move — a ${from} record is frozen: its work goes on in the tracker, and its status never changes again`;
    const how = legal.length ? `from \`${from}\`, a record of type \`${type}\` may go to: ${legal.join(", ")}` : `\`${from}\` is final for a record of type \`${type}\``;
    return `\`${from}\` → \`${to}\` is not a legal move — ${how}`;
  };

  // ── 5. Who holds the ball ──
  const alternatives = [OPERATOR, ...operatorNames].map(escapeRegExp).join("|");
  const operatorExact = new RegExp(`^(${alternatives})$`, "i");
  const operatorLead = new RegExp(`^(${alternatives})\\b(?!\\s*#)`, "i");
  /** `owner` names the operator: exactly `operator` or one of their names, any case. */
  const isOperator = (s) => typeof s === "string" && operatorExact.test(s.trim());
  /** A waiting party (free text) names the operator: it starts with the word, not an agent's `#`. */
  const namesOperator = (s) => typeof s === "string" && operatorLead.test(s.trim());
  /** Who must act next; absent means the operator. */
  const ownerOf = (r) => (isNull(r.owner) ? OPERATOR : r.owner);
  const ownedByOperator = (r) => isOperator(ownerOf(r));
  /** The party the record waits on: `waiting_on`, else `blocked_on`, else null. */
  const waitingParty = (r) => (!isNull(r.waiting_on) ? r.waiting_on : !isNull(r.blocked_on) ? r.blocked_on : null);
  /** The record waits on the operator: its waiting party (`waiting_on`, else `blocked_on`) names them. */
  const waitsOnOperator = (r) => (!isNull(r.waiting_on) ? namesOperator(r.waiting_on) : namesOperator(r.blocked_on));
  /** The record is in a wait: it is `blocked`, or it carries `waiting_on`. */
  const isWaiting = (r) => r.status === "blocked" || !isNull(r.waiting_on);
  /** A live record is on the operator's desk: they own it, or it waits on them. */
  const onOperatorsDesk = (r) => ownedByOperator(r) || waitsOnOperator(r);
  /**
   * What is wrong with a record's wait fields, as advisory messages (the validator WARNs each). A
   * `waiting_since` the finished-record rule already reports (a handed-off record's) is left to it.
   */
  const waitProblems = (r) => {
    const out = [];
    if (!isNull(r.waiting_since) && !isWaiting(r) && !finishedClears(r.status).includes("waiting_since"))
      out.push("`waiting_since` dates a wait, but this record waits on nothing (it is not `blocked` and has no `waiting_on`) — clear it, or set `waiting_on` to the party");
    return out;
  };

  return {
    types, typeNames, itemStatuses, workTypes, handoff, knownKeys, requireWhen,
    familyOf, decisionStatusesOf, familyStatuses,
    terminal, isTerminal, finishedClears, terminalLeftovers,
    moves, legalMoves, checkMove,
    isOperator, namesOperator, ownerOf, ownedByOperator, waitingParty, waitsOnOperator, isWaiting, onOperatorsDesk, waitProblems,
  };
}
