// A made-up record store, as data: the records the validator's tests run on, in the same format as a real
// store (frontmatter, UPPER_SNAKE sections, an ACTIVITY_LOG), under a neutral prefix (ALPHA) and the data
// folder `backlog`. Types that a profile adds are the neutral ones of fixtures/profile.json: vendor,
// ops-desk, agent-ops and desk-ops; the pointer key of its handoff is `tracker_ref`.
//
//   RECORDS      [{ file, content, head?, expect: { code, has, hasNot }, note }]
//                  file     relative to the store's root
//                  content  the text in the working tree
//                  head     undefined: committed as `content`; a string: committed as this text, and `content`
//                           is written over it afterwards (a changed record); null: not committed (new since HEAD)
//   buildStore   writes the store into a folder, as a git repository with one commit made under an isolated
//                git setup, and returns each record's absolute path, in RECORDS order
//   GIT_ENV      the environment every test runs with: git isolated from any user or system setup, no
//                BACKLOG settings inherited, no Claude settings read
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const IDENTITY = {
  GIT_AUTHOR_NAME: "fixture",
  GIT_COMMITTER_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

export const GIT_ENV = (() => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("BACKLOG_") || key.startsWith("CLAUDE_PLUGIN_OPTION_BACKLOG_")) delete env[key];
  return {
    ...env,
    ...IDENTITY,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    CLAUDE_CONFIG_DIR: "/nonexistent-claude-config",
  };
})();

// ── Builders ──────────────────────────────────────────────────────────────────

const SECTIONS = {
  app: ["DESCRIPTION", "CURRENT_STATE", "REQUIREMENTS", "DOD", "UAT", "DEPLOYMENT", "REFERENCES", "ACTIVITY_LOG"],
  decision: ["CONTEXT", "OPTIONS", "RECOMMENDATION", "OUTCOME", "REFERENCES", "ACTIVITY_LOG"],
  chore: ["DESCRIPTION", "PROCEDURE", "REFERENCES", "ACTIVITY_LOG"],
  "ops-desk": ["DESCRIPTION", "REQUIREMENTS", "CONTACTS", "DELIVERABLES", "REFERENCES", "ACTIVITY_LOG"],
  "personal-ops": ["DESCRIPTION", "REQUIREMENTS", "CONTACTS", "DELIVERABLES", "REFERENCES", "ACTIVITY_LOG"],
  research: ["DESCRIPTION", "CURRENT_STATE", "HYPOTHESIS", "FINDINGS", "REFERENCES", "ACTIVITY_LOG"],
  "agent-ops": ["DESCRIPTION", "REFERENCES", "ACTIVITY_LOG"],
  "desk-ops": ["DESCRIPTION", "REFERENCES", "ACTIVITY_LOG"],
  vendor: ["DESCRIPTION", "REQUIREMENTS", "DOD", "CLIENT_CONTEXT", "DELIVERABLES", "ARCHITECTURE", "REFERENCES", "ACTIVITY_LOG"],
};

/** An item: frontmatter (`extra` is more lines, each ending in \n), then each of the type's sections holding `x`. */
const item = (id, type, status, extra = "", { sections = SECTIONS[type] ?? ["DESCRIPTION"], title = "Test" } = {}) =>
  `---\nid: ${id}\ntitle: "${title}"\ntype: ${type}\nstatus: ${status}\ncreated: 2026-01-01\nupdated: 2026-01-01\n${extra}---\n# ${id}: ${title}\n${sections.map((s) => `## ${s}\nx\n`).join("")}`;

/** The log line a handed-off record carries: it names its tracker item with a link. */
const handedOff = (id) => `- 2026-11-07: handed off to the tracker as ${id}: https://tracker.example.com/issue/${id}/test\n`;

const LONG = "x".repeat(320);
const VERYLONG = "x".repeat(620);

const DECISION = `---
id: ALPHA-901
title: "Database hosting posture"
type: decision
status: open
priority: high
created: 2026-09-06
updated: 2026-09-06
question: "One shared database for every customer, or a dedicated database per customer?"
options: [shared-per-role, dedicated-per-tenant]
recommendation: shared-per-role for now, dedicated once a customer pays
source: https://chat.example.com/thread/1234
decided: null
decided_on: null
---
# ALPHA-901: Database hosting posture
## CONTEXT
x
## OPTIONS
x
## RECOMMENDATION
x
## OUTCOME
null
## REFERENCES
x
## ACTIVITY_LOG
- 2026-09-06: Created.
`;
const decisionAs = (id, edit) => edit(DECISION.replace("id: ALPHA-901", `id: ${id}`));

const CHORE = `---
id: ALPHA-910
title: "Test server kernel reboot"
type: chore
status: active
priority: medium
created: 2026-09-06
updated: 2026-09-06
owner: agent
cadence: monthly
last_done: null
next_due: 2026-09-20
---
# ALPHA-910: Test server kernel reboot
## DESCRIPTION
x
## PROCEDURE
x
## REFERENCES
x
## ACTIVITY_LOG
- 2026-09-06: Created.
`;
const choreAs = (id, edit) => edit(CHORE.replace("id: ALPHA-910", `id: ${id}`));

const ARC = (id, extra = "") =>
  `---\nid: ARC-${id}\ntitle: "Arc"\n${extra}created: 2026-01-01\nupdated: 2026-01-01\n---\n# ARC-${id}: Arc\n## OBJECTIVE\nx\n## SUCCESS_CRITERIA\nx\n## ACTIVITY_LOG\nx\n`;
const INITIATIVE = (id, extra = "") =>
  `---\nid: INIT-${id}\ntitle: "Initiative"\n${extra}created: 2026-01-01\nupdated: 2026-01-01\n---\n# INIT-${id}: Initiative\n## GOALS\nx\n## ACTIVITY_LOG\nx\n`;

const BEGIN = (id) => `<!-- nf-backlog:sub-items GENERATED — derived from items whose \`parent\` is ${id}; do not edit by hand. Refresh: backlog-manage \`regen-subitems\`. -->`;
const END = "<!-- /nf-backlog:sub-items -->";
/** A parent item whose `## SUB_ITEMS` block (before ACTIVITY_LOG) holds `body` between the sentinels. */
const parentWithBlock = (id, body) =>
  `---\nid: ${id}\ntitle: "Test"\ntype: app\nstatus: active\ncreated: 2026-01-01\nupdated: 2026-01-01\nnext_action: Ship it\n---\n# ${id}: Test\n${SECTIONS.app
    .slice(0, -1)
    .map((s) => `## ${s}\nx\n`)
    .join("")}## SUB_ITEMS\n\n${BEGIN(id)}\n${body}\n${END}\n\n## ACTIVITY_LOG\nx\n`;

// ── The records ───────────────────────────────────────────────────────────────

export const RECORDS = [];
const add = (file, content, expect, note, head) => RECORDS.push({ file, content, expect: { code: expect.code, has: expect.has ?? [], hasNot: expect.hasNot ?? [] }, note, ...(head === undefined ? {} : { head }) });
/** An item in backlog/items/. */
const addItem = (name, content, code, note, has = [], more = {}) => add(`backlog/items/${name}.md`, content, { code, has, ...more }, note, more.head);
const clean = (name, content, note) => addItem(name, content, 0, note);

// decision
addItem("ALPHA-901-decision-open", DECISION, 0, "decision open, minimal -> clean");
addItem("ALPHA-902-decision-bad", decisionAs("ALPHA-902", (t) => t.replace("decided: null", "decided: shared-per-role")), 2, "decision open with decided set -> block", ["decided"]);
addItem("ALPHA-903-decision-decided", decisionAs("ALPHA-903", (t) => t.replace("status: open", "status: decided").replace("decided: null", "decided: shared-per-role")), 2, "decision decided without decided_on -> block", ["decided_on"]);
addItem("ALPHA-908-decision-decided-ok", decisionAs("ALPHA-908", (t) => t.replace("status: open", "status: decided").replace("decided: null", "decided: shared-per-role").replace("decided_on: null", "decided_on: 2026-09-07")), 0, "decision decided with decided + decided_on -> clean");
addItem("ALPHA-904-decision-noq", decisionAs("ALPHA-904", (t) => t.replace(/^question:.*\n/m, "")), 2, "decision without question -> block", ["question"]);
addItem("ALPHA-905-decision-active", decisionAs("ALPHA-905", (t) => t.replace("status: open", "status: active")), 2, "decision with status active -> block (not in its set)", ["status `active` is not valid here (allowed: open, decided, cancelled, moved)"]);
addItem("ALPHA-906-wake-unpaired", decisionAs("ALPHA-906", (t) => t.replace("decided: null", "wake_when: first customer signs\ndecided: null")), 2, "wake_when without review_after -> block", ["review_after"]);
addItem("ALPHA-907-wake-paired", decisionAs("ALPHA-907", (t) => t.replace("decided: null", "wake_when: first customer signs\nreview_after: 2026-12-01\ndecided: null")), 0, "wake_when paired with review_after -> clean");
// (the rule must never bite a record that carries neither: ALPHA-901 above is that case)

// chore
addItem("ALPHA-910-chore", CHORE, 0, "chore active with cadence + next_due -> clean (no next_action needed)");
addItem("ALPHA-911-chore-nodue", choreAs("ALPHA-911", (t) => t.replace(/^next_due:.*\n/m, "")), 2, "chore active without next_due -> block", ["next_due"]);
addItem("ALPHA-912-chore-badcad", choreAs("ALPHA-912", (t) => t.replace("cadence: monthly", "cadence: whenever")), 2, "chore with unrecognised cadence -> block", ["cadence"]);
addItem("ALPHA-913-chore-paused", choreAs("ALPHA-913", (t) => t.replace("status: active", "status: paused").replace(/^cadence:.*\n/m, "").replace(/^next_due:.*\n/m, "")), 0, "chore paused without cadence/next_due -> clean");
addItem("ALPHA-914-chore-every", choreAs("ALPHA-914", (t) => t.replace("cadence: monthly", "cadence: every 14 days")), 0, "chore cadence 'every 14 days' -> clean");

// work item: owner + waiting_on are optional and free
addItem("ALPHA-920", item("ALPHA-920", "app", "active", "next_action: Ship it\nowner: Operator #1\nwaiting_on: https://github.com/example-org/example-repo/pull/1\n"), 0, "active item with owner + waiting_on -> clean");
addItem("ALPHA-921", item("ALPHA-921", "app", "active", "next_action: Ship it\n"), 0, "active item without owner/waiting_on (every legacy record) -> clean");
addItem("ALPHA-922", item("ALPHA-922", "app", "idea", "waiting_on: operator\n"), 2, "idea with waiting_on -> block", ["waiting_on"]);

// advisory: a long next_action warns, never blocks
addItem("ALPHA-923", item("ALPHA-923", "app", "active", `next_action: ${LONG}\n`), 0, "next_action 320 chars, no owner (legacy) -> clean (threshold 600)");
addItem("ALPHA-924", item("ALPHA-924", "app", "active", `next_action: ${LONG}\nowner: agent\n`), 1, "next_action 320 chars with owner -> warn (exit 1, threshold 300)", ["keep it to one physical action", "threshold 300"]);
addItem("ALPHA-925", item("ALPHA-925", "app", "active", `next_action: ${VERYLONG}\n`), 1, "next_action 620 chars, no owner -> warn (exit 1, threshold 600)", ["without `owner`"]);

// advisory: duplicate id across two files warns on both, never blocks (exactly one twin each)
addItem("ALPHA-930-first", item("ALPHA-930", "app", "draft"), 1, "duplicate id, first file -> warn (exit 1)", ["ALPHA-930-second.md"]);
addItem("ALPHA-930-second", item("ALPHA-930", "app", "draft"), 1, "duplicate id, second file -> warn (exit 1)", ["ALPHA-930-first.md"]);
addItem("ALPHA-93", item("ALPHA-93", "app", "draft"), 0, "ALPHA-93 beside ALPHA-930 -> clean (a prefix is not a duplicate)", [], { hasNot: ["is also carried by"] });

// `moved` + `tracker_ref`, the profile's handoff
addItem("ALPHA-940", item("ALPHA-940", "app", "moved", "tracker_ref: ABC-12\n") + handedOff("ABC-12"), 0, "moved app with tracker_ref -> clean");
addItem("ALPHA-941", item("ALPHA-941", "app", "moved"), 2, "moved without tracker_ref -> block", ["requires `tracker_ref`"]);
addItem("ALPHA-942", item("ALPHA-942", "app", "active", "next_action: Ship it\ntracker_ref: ABC-12\n"), 2, "tracker_ref on an active (not moved) record -> block", ["only valid on a moved record"]);
addItem("ALPHA-943", item("ALPHA-943", "app", "completed", "tracker_ref: ABC-12\n"), 2, "tracker_ref on a completed (finished, not moved) record -> block", ["only valid on a moved record"]);
addItem("ALPHA-944", item("ALPHA-944", "app", "moved", "tracker_ref: https://tracker.example.com/issue/ABC-12\n"), 2, "moved with a URL instead of an identifier -> block", ["is not a tracker identifier"]);
addItem("ALPHA-945", item("ALPHA-945", "app", "moved", 'tracker_ref: "XYZ-3"\n') + handedOff("XYZ-3"), 0, "moved with a quoted identifier -> clean");
addItem("ALPHA-946", item("ALPHA-946", "decision", "moved", 'question: "Which?"\ntracker_ref: XYZ-4\n') + handedOff("XYZ-4"), 0, "moved decision -> clean");
addItem("ALPHA-947", item("ALPHA-947", "ops-desk", "moved", "tracker_ref: XYZ-5\n") + handedOff("XYZ-5"), 0, "moved ops-desk -> clean");
addItem("ALPHA-948", item("ALPHA-948", "research", "moved", "tracker_ref: DEF-1\n") + handedOff("DEF-1"), 0, "moved research -> clean");
addItem("ALPHA-949", item("ALPHA-949", "personal-ops", "moved", "tracker_ref: XYZ-6\n"), 2, "moved personal-ops -> block (personal items never move)", ["status `moved` is not valid here"]);
addItem("ALPHA-950", item("ALPHA-950", "chore", "moved", "tracker_ref: XYZ-7\n"), 2, "moved chore -> block (not in its set)", ["status `moved` is not valid here"]);
// the frozen shape: every live field is null, and the log names the item
for (const [i, field] of ["next_action", "waiting_on", "blocked_on", "waiting_since"].entries()) {
  const id = `ALPHA-106${i}`;
  addItem(`${id}-${field}`, item(id, "app", "moved", `tracker_ref: ABC-12\n${field}: something\n`) + handedOff("ABC-12"), 2, `moved with ${field} set -> block`, [`requires a null \`${field}\``]);
}
addItem("ALPHA-952", item("ALPHA-952", "app", "moved", "tracker_ref: ABC-12\nnext_action: null\nwaiting_on: null\nblocked_on: null\nwaiting_since: null\n") + handedOff("ABC-12"), 0, "moved with every live field written as null -> clean");
addItem("ALPHA-953", item("ALPHA-953", "app", "moved", "tracker_ref: ABC-12\n"), 2, "moved whose log does not name its item -> block", ["line naming the tracker item"]);
addItem("ALPHA-954", item("ALPHA-954", "app", "moved", "tracker_ref: ABC-12\n") + handedOff("ABC-120"), 2, "moved whose log names ABC-120, not ABC-12 -> block (whole identifier)", ["line naming the tracker item"]);
addItem("ALPHA-955", item("ALPHA-955", "app", "moved", "tracker_ref: ABC-12\n") + "- 2026-11-07: handed off to the tracker ABC-12.\n", 0, "moved whose log names the bare identifier, no URL -> clean");
addItem(
  "ALPHA-956",
  `---\nid: ALPHA-956\ntitle: "Test"\ntype: app\nstatus: moved\ncreated: 2026-01-01\nupdated: 2026-01-01\ntracker_ref: ABC-12\n---\n# ALPHA-956: Test\n## DESCRIPTION\nhanded off to the tracker as ABC-12, said outside the log\n## CURRENT_STATE\nx\n## REQUIREMENTS\nx\n## DOD\nx\n## UAT\nx\n## DEPLOYMENT\nx\n## ACTIVITY_LOG\n- 2026-01-01: Created.\n## REFERENCES\nx\n`,
  2,
  "moved naming its item only outside ACTIVITY_LOG -> block",
  ["line naming the tracker item"],
);
add("backlog/arcs/ARC-901.md", ARC("901", "status: active\ntracker_ref: ABC-12\n"), { code: 2, has: ["only valid on a moved record"] }, "tracker_ref on an arc -> block (arcs never move)");
add("backlog/arcs/ARC-902.md", ARC("902", "status: active\n"), { code: 0 }, "the same arc without tracker_ref -> clean");
add("backlog/initiatives/INIT-901.md", INITIATIVE("901", "status: active\ntracker_ref: ABC-12\n"), { code: 2, has: ["only valid on a moved record"] }, "tracker_ref on an initiative -> block");

// a moved sub-item ticks its parent's generated `## SUB_ITEMS` box; an open one does not
addItem("ALPHA-960", item("ALPHA-960", "app", "active", "next_action: Ship it\n"), 0, "sub-item parent -> clean");
addItem("ALPHA-961", item("ALPHA-961", "app", "moved", "tracker_ref: ABC-20\nparent: ALPHA-960\n") + handedOff("ABC-20"), 0, "moved sub-item -> clean");
addItem("ALPHA-962", item("ALPHA-962", "app", "draft", "parent: ALPHA-960\n"), 0, "open sub-item -> clean");

// a record validated outside backlog/ is judged by its id, not passed silently
add("scratch/ARC-950-copy.md", ARC("950"), { code: 2, has: ["judged as an arc from its id"] }, "arc copy with status removed, outside backlog/ -> block");
add("backlog/arcs/ARC-950.md", ARC("950"), { code: 2 }, "the same arc inside backlog/arcs/ -> block (unchanged)");
add("scratch/ARC-951.md", ARC("951", "status: active\n"), { code: 0 }, "a valid arc copy outside backlog/ -> clean");
addItem("ALPHA-980", item("ALPHA-980", "app", "draft"), 0, "draft app -> clean");
add("scratch/ALPHA-980-staged.md", item("ALPHA-980", "app", "draft").replace(/^type:.*\n/m, ""), { code: 2, has: ["judged as an item from its id"] }, "item copy with type removed, outside backlog/ -> block");
addItem("ALPHA-981", item("ALPHA-981", "app", "draft", "parent: ALPHA-9999\n"), 1, "the same item in items/ warns on the dangling parent", ["parent: ALPHA-9999"]);
add("scratch/ALPHA-981.md", item("ALPHA-981", "app", "draft", "parent: ALPHA-9999\n"), { code: 0 }, "valid item copy with a parent, outside backlog/ -> clean (sibling checks skipped)");
add("scratch/ALPHA-tmp-1a2b3c4d.md", "---\nid: ALPHA-tmp-1a2b3c4d\ntitle: \"Provisional\"\ntype: app\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# x\n", { code: 2 }, "provisional-id item outside backlog/ with no status -> block");
add("scratch/ALPHA-982-no-id-field.md", item("ALPHA-980", "app", "draft").replace(/^id:.*\n/m, ""), { code: 2, has: ["missing required field `id`"] }, "no id field, ALPHA- file name, outside backlog/ -> judged, block on missing id");
add("scratch/INIT-950.md", "---\nid: INIT-950\ntitle: \"Init\"\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# INIT-950\n## GOALS\nx\n## ACTIVITY_LOG\nx\n", { code: 2 }, "initiative copy with no status, outside backlog/ -> block");
add("scratch/2026-11-01-session-copy.md", "---\ndate: 2026-11-01\ncwd: /x\ntitle: \"A session\"\n---\n## Notes\nx\n", { code: 2, has: ["judged as a session from its frontmatter"] }, "session copy with start_ts removed, outside backlog/ -> block");
add("scratch/2026-11-01-session-ok.md", "---\ndate: 2026-11-01\nstart_ts: 2026-11-01T06:45:00+07:00\ncwd: /x\n---\n## Notes\nx\n", { code: 0 }, "a valid session copy outside backlog/ -> clean");
add("scratch/2026-11-01-notes.md", "---\ndate: 2026-11-01\ntitle: \"Dated scratch note\"\n---\n# notes\n", { code: 0 }, "a dated scratch note without session keys -> silent");
add("scratch/inbox.md", "- 2026-01-01: a thought\n", { code: 0 }, "inbox.md outside backlog/ -> silent");
add("scratch/notes.md", "# notes\nALPHA-980 is mentioned here\n", { code: 0 }, "a plain markdown file outside backlog/ -> silent");
add("scratch/ABC-12.md", "---\nid: ABC-12\ntitle: x\n---\n", { code: 0 }, "an id with another prefix (ABC-12) outside backlog/ -> silent");
add("backlog/searches/ALPHA-983.md", "---\nid: ALPHA-983\ntitle: x\nstatus: concluded\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# ALPHA-983\n## QUERY\nx\n", { code: 0 }, "an ALPHA- file in backlog/searches/ (not a record folder) -> silent");

// agent-ops: the host agent's own machinery, a work type that never moves
addItem("ALPHA-970", item("ALPHA-970", "agent-ops", "draft"), 0, "agent-ops draft with only DESCRIPTION/REFERENCES/ACTIVITY_LOG -> clean");
addItem("ALPHA-971", item("ALPHA-971", "agent-ops", "scoped", "repo: .\n"), 0, "agent-ops scoped with repo -> clean");
addItem("ALPHA-972", item("ALPHA-972", "agent-ops", "moved", "tracker_ref: XYZ-8\n"), 2, "moved agent-ops -> block (it never moves)", ["status `moved` is not valid here"]);
addItem("ALPHA-973", item("ALPHA-973", "agent-ops", "active"), 2, "active agent-ops without next_action -> block (GTD rule applies)", ["requires a non-null `next_action`"]);
addItem("ALPHA-974", item("ALPHA-974", "agent-ops", "concluded"), 2, "agent-ops concluded -> block (closes as completed)", ["status `concluded` is not valid here"]);
addItem("ALPHA-975", "---\nid: ALPHA-975\ntitle: \"Test\"\ntype: agent-ops\nstatus: draft\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# ALPHA-975: Test\n## DESCRIPTION\nx\n## ACTIVITY_LOG\nx\n", 2, "agent-ops missing REFERENCES -> block", ["missing required section `## REFERENCES`"]);
// a retyped research record keeps its other sections as tolerated extras
addItem("ALPHA-976", item("ALPHA-976", "research", "draft").replace(/^type: research$/m, "type: agent-ops"), 0, "research record retyped to agent-ops (one line) -> clean");

// desk-ops: the owner's desk, work and decisions, never moves
addItem("ALPHA-985", item("ALPHA-985", "desk-ops", "draft"), 0, "desk-ops draft with only DESCRIPTION/REFERENCES/ACTIVITY_LOG -> clean");
addItem("ALPHA-986", item("ALPHA-986", "desk-ops", "moved", "tracker_ref: XYZ-9\n"), 2, "moved desk-ops -> block (the desk never moves)", ["status `moved` is not valid here"]);
addItem("ALPHA-987", item("ALPHA-987", "desk-ops", "active"), 2, "active desk-ops without next_action -> block (GTD rule applies)", ["requires a non-null `next_action`"]);
addItem("ALPHA-988", item("ALPHA-988", "desk-ops", "open", 'question: "Which?"\nowner: operator\n'), 0, "desk-ops open with a question -> clean (it holds decisions)");
addItem("ALPHA-989", item("ALPHA-989", "desk-ops", "open"), 2, "desk-ops open without question -> block", ["requires `question`"]);
addItem("ALPHA-990", item("ALPHA-990", "desk-ops", "decided", 'question: "Which?"\n'), 2, "desk-ops decided without decided/decided_on -> block (decision rule)", ["requires `decided`"]);
addItem("ALPHA-991", item("ALPHA-991", "desk-ops", "decided", 'question: "Which?"\ndecided: shared\ndecided_on: 2026-11-02\n'), 0, "desk-ops decided with decided + decided_on -> clean");
addItem("ALPHA-992", item("ALPHA-992", "desk-ops", "open", 'question: "Which?"\ndecided: shared\n'), 2, "desk-ops open carrying decided -> block (decision rule)", ["requires null `decided`/`decided_on`"]);
addItem("ALPHA-993", item("ALPHA-993", "desk-ops", "concluded"), 2, "desk-ops concluded -> block", ["status `concluded` is not valid here"]);
addItem("ALPHA-994", "---\nid: ALPHA-994\ntitle: \"Test\"\ntype: desk-ops\nstatus: draft\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# ALPHA-994: Test\n## REFERENCES\nx\n## ACTIVITY_LOG\nx\n", 2, "desk-ops with neither DESCRIPTION nor CONTEXT -> block", ["missing required section `## DESCRIPTION` (a `desk-ops` record may carry `## CONTEXT` instead)"]);
// an open decision retyped by its one `type:` line: CONTEXT stands in for DESCRIPTION
addItem("ALPHA-995", item("ALPHA-995", "decision", "open", 'question: "Which?"\noptions: [a, b]\nowner: operator\n').replace(/^type: decision$/m, "type: desk-ops"), 0, "open decision retyped to desk-ops (one line) -> clean");
// and a work record retyped by its one line keeps its other sections as tolerated extras
addItem("ALPHA-996", item("ALPHA-996", "ops-desk", "active", "next_action: Draft the letter\n").replace(/^type: ops-desk$/m, "type: desk-ops"), 0, "ops-desk record retyped to desk-ops (one line) -> clean");

// the finished set, the wait rules and the legal moves (record-rules.mjs): advisory, exit 1, never 2
addItem("ALPHA-1001", item("ALPHA-1001", "agent-ops", "completed", 'next_action: "Ship it"\n'), 1, "completed record still carrying next_action -> warn", ["is finished, but the record still carries `next_action`", "⚠ ALPHA-1001.md is valid, with a non-blocking warning:"]);
addItem("ALPHA-1002", item("ALPHA-1002", "decision", "decided", 'question: "Which?"\ndecided: a\ndecided_on: 2026-11-01\nwaiting_on: operator\n'), 1, "decided decision still carrying waiting_on -> warn", ["--clear-waiting"]);
addItem("ALPHA-1003", item("ALPHA-1003", "chore", "retired", 'next_action: "Run it"\n'), 1, "retired chore still carrying next_action -> warn (retired is finished)");
addItem("ALPHA-1004", item("ALPHA-1004", "desk-ops", "decided", 'question: "Which?"\ndecided: a\ndecided_on: 2026-11-01\nnext_action: "Tell Sam"\n'), 1, "decided desk-ops still carrying next_action -> warn (decided is finished)");
addItem("ALPHA-1005", item("ALPHA-1005", "agent-ops", "completed", "next_action: null\nwaiting_on: ~\n"), 0, "completed record with next_action and waiting_on null -> clean");
addItem("ALPHA-1006", item("ALPHA-1006", "agent-ops", "active", "next_action: Ship it\nwaiting_since: 2026-11-01\n"), 1, "waiting_since on a record that waits on nothing -> warn", ["waits on nothing"]);
addItem("ALPHA-1007", item("ALPHA-1007", "agent-ops", "active", "next_action: Ship it\nwaiting_on: operator\nwaiting_since: 2026-11-01\n"), 0, "waiting_since with waiting_on set (a wait) -> clean");
addItem("ALPHA-1008", item("ALPHA-1008", "agent-ops", "blocked", "blocked_on: Sam\nwaiting_since: 2026-11-01\n"), 0, "waiting_since on a blocked record -> clean");
addItem("ALPHA-1009", item("ALPHA-1009", "agent-ops", "completed", "waiting_since: 2026-10-01\n"), 1, "waiting_since left on a finished record -> warn");

// two finished-record warnings on one record: the plural form of the warning line
addItem("ALPHA-1070", item("ALPHA-1070", "agent-ops", "completed", 'next_action: "Ship it"\nwaiting_on: operator\n'), 1, "completed record carrying next_action and waiting_on -> two warnings", ["⚠ ALPHA-1070.md is valid, with non-blocking warnings:"]);

// the move check compares the record with its copy at git HEAD: an illegal move warns
addItem("ALPHA-1010", item("ALPHA-1010", "agent-ops", "completed"), 0, "move check: unchanged since HEAD -> clean");
addItem("ALPHA-1015", item("ALPHA-1015", "agent-ops", "active", "next_action: Ship it again\n"), 1, "move check: completed -> active (skips draft) -> warn", ["`completed` → `active` is not a legal move — from `completed`, a record of type `agent-ops` may go to: draft, cancelled", "a local check: it compares this file with its copy at the last commit"], { head: item("ALPHA-1015", "agent-ops", "completed") });
addItem("ALPHA-1016", item("ALPHA-1016", "agent-ops", "draft"), 0, "move check: completed -> draft (the reopen) -> clean", [], { head: item("ALPHA-1016", "agent-ops", "completed") });
addItem("ALPHA-1011", item("ALPHA-1011", "ops-desk", "active", "next_action: Ship it\n"), 1, "move check: moved -> active -> warn (a moved record is frozen)", ["a moved record is frozen"], { head: item("ALPHA-1011", "ops-desk", "moved", "tracker_ref: XYZ-1\n") });
addItem("ALPHA-1012", item("ALPHA-1012", "agent-ops", "deferred"), 1, "move check: idea -> deferred -> warn", ["`idea` → `deferred` is not a legal move"], { head: item("ALPHA-1012", "agent-ops", "idea") });
addItem("ALPHA-1013", item("ALPHA-1013", "agent-ops", "completed"), 0, "move check: active -> completed -> clean", [], { head: item("ALPHA-1013", "agent-ops", "active", "next_action: Ship it\n") });
addItem("ALPHA-1014", item("ALPHA-1014", "agent-ops", "active", "next_action: Ship it\n"), 0, "move check: a record new since HEAD -> clean (nothing to compare)", [], { head: null });
addItem("ALPHA-1017", item("ALPHA-1017", "agent-ops", "deferred"), 0, "move check: once committed, HEAD is the new status -> clean");
addItem("ALPHA-1018", item("ALPHA-1018", "desk-ops", "active", "next_action: Reply\n"), 0, "move check: desk-ops open -> active is legal (an extra move of the profile)", [], { head: item("ALPHA-1018", "desk-ops", "open", 'question: "Which?"\n') });
addItem("ALPHA-1019", item("ALPHA-1019", "desk-ops", "completed"), 1, "move check: desk-ops open -> completed -> warn, listing the extra move last", ["a record of type `desk-ops` may go to: decided, cancelled, active"], { head: item("ALPHA-1019", "desk-ops", "open", 'question: "Which?"\n') });

// numbers and names: three and four digits, with and without a slug, a provisional id
addItem("ALPHA-1000", item("ALPHA-1000", "app", "draft"), 0, "four-digit id, no slug -> clean");
addItem("ALPHA-1020-four-digit-slug", item("ALPHA-1020", "app", "draft"), 0, "four-digit id with a slug -> clean");
addItem("ALPHA-007-three-digits-padded", item("ALPHA-007", "app", "draft"), 0, "zero-padded three-digit id with a slug -> clean");
addItem("ALPHA-tmp-1a2b3c4d", item("ALPHA-tmp-1a2b3c4d", "app", "draft"), 0, "provisional id inside items/ -> clean");

// values: bare, quoted, null, ~, empty; inline and block lists; a CRLF record; a legacy record
addItem("ALPHA-1030", item("ALPHA-1030", "app", "completed", 'next_action: ""\nwaiting_on: \'\'\nblocked_on: ~\nwaiting_since: null\nowner: "agent"\n').replace('id: ALPHA-1030', 'id: "ALPHA-1030"').replace('title: "Test"', "title: 'Quoted title'"), 0, "finished record with empty, ~, null and quoted values -> clean");
addItem("ALPHA-1031", item("ALPHA-1031", "app", "draft", "recordings: [fathom:123456789, other:abc]\ntags: [a, b]\n"), 0, "inline lists, any recording scheme -> clean");
addItem("ALPHA-1032", item("ALPHA-1032", "app", "draft", "recordings:\n  - fathom:123456789\ntags:\n  - a\n  - b\n"), 0, "block-style lists are invisible to the line parser and pass untouched -> clean");
addItem("ALPHA-1033", item("ALPHA-1033", "app", "draft", "recordings: [nocolon]\n"), 2, "a recordings entry without a scheme -> block", ["recordings entry `nocolon` is not `<scheme>:<id>`"]);
addItem("ALPHA-1034", item("ALPHA-1034", "app", "draft", "recordings: fathom:1\n"), 2, "recordings that is not a list -> block", ["`recordings` must be a list"]);
addItem("ALPHA-1035", item("ALPHA-1035", "app", "active", "next_action: Ship it\nowner: Operator #1\n").replace(/\n/g, "\r\n"), 0, "a CRLF record -> clean");
addItem("ALPHA-1036", item("ALPHA-1036", "app", "draft", "").replace(/^id:.*\n/m, "").replace(/^title:.*\n/m, ""), 2, "missing id and title -> block", ["missing required field `id`", "missing required field `title`"]);
addItem("ALPHA-1037", item("ALPHA-1037", "app", "draft", "").replace(/^status:.*\n/m, ""), 2, "missing status -> block", ["missing `status`"]);
addItem("ALPHA-1038", item("ALPHA-1038", "gadget", "draft"), 2, "an unknown type -> block, listing the generic types and the profile's in its order", ["unknown item type `gadget` (expected one of: app, infra, plugin, vendor, ops-desk, personal-ops, agent-ops, desk-ops, research, decision, chore)"]);
addItem("ALPHA-1039", item("ALPHA-1039", "app", "bogus"), 2, "an unknown status -> block, listing the type's statuses with the profile's appended", ["status `bogus` is not valid here (allowed: idea, draft, scoped, active, blocked, completed, deferred, cancelled, moved)"]);
addItem("ALPHA-1040", item("ALPHA-1040", "app", "blocked"), 2, "blocked without blocked_on -> block", ["`status: blocked` requires `blocked_on`"]);
addItem("ALPHA-1041", item("ALPHA-1041", "app", "idea", "next_action: Ship it\n"), 2, "idea with a next_action -> block", ["`status: idea` requires a null `next_action`"]);

// the vendor type's identity gate (a profile's requireWhen)
addItem("ALPHA-1050", item("ALPHA-1050", "vendor", "draft"), 0, "vendor draft without its vendor field -> clean (a prospect)");
addItem("ALPHA-1051", item("ALPHA-1051", "vendor", "scoped"), 2, "vendor scoped without its vendor field -> block", ["`type: vendor` requires a non-null `vendor` once past `idea`/`draft`"]);
addItem("ALPHA-1052", item("ALPHA-1052", "vendor", "scoped", "vendor: Acme\n"), 0, "vendor scoped with its vendor field -> clean");
addItem("ALPHA-1053", item("ALPHA-1053", "vendor", "delivered", "vendor: Acme\n"), 0, "vendor delivered (finished) -> clean");

// sub-items: the generated `## SUB_ITEMS` block between the exact sentinels
addItem("ALPHA-1100", parentWithBlock("ALPHA-1100", "- [x] ALPHA-1101 — Test · app · completed\n- [ ] ALPHA-1102 — Test · app · draft"), 0, "a parent whose SUB_ITEMS block is current -> clean");
addItem("ALPHA-1101", item("ALPHA-1101", "app", "completed", "parent: ALPHA-1100\n"), 0, "a finished sub-item of a current parent -> clean");
addItem("ALPHA-1102", item("ALPHA-1102", "app", "draft", "parent: ALPHA-1100\n"), 0, "an open sub-item of a current parent -> clean");
addItem("ALPHA-1110", parentWithBlock("ALPHA-1110", "_No sub-items._"), 1, "a parent whose SUB_ITEMS block is stale -> warn", ["`## SUB_ITEMS` is a generated projection and is now stale", "regen-subitems ALPHA-1110"]);
addItem("ALPHA-1111", item("ALPHA-1111", "app", "draft", "parent: ALPHA-1110\n"), 1, "a sub-item whose parent's block is stale -> warn on the child too", ["parent `ALPHA-1110` carries a generated `## SUB_ITEMS` projection that is now stale"]);

// the other record kinds in the data folder
add("backlog/arcs/ARC-001-first-arc.md", ARC("001", "status: active\nrecordings: [fathom:42]\n"), { code: 0 }, "an arc in backlog/arcs/ -> clean");
add("backlog/arcs/ARC-002.md", ARC("002", "status: done\n"), { code: 2, has: ["status `done` is not valid here (allowed: active, paused, completed, cancelled)"] }, "an arc with a bad status -> block");
add("backlog/initiatives/INIT-001.md", INITIATIVE("001", "status: draft\n"), { code: 0 }, "an initiative in backlog/initiatives/ -> clean");
add("backlog/initiatives/INIT-002-slug.md", INITIATIVE("002", "status: active\n").replace("## GOALS\nx\n", ""), { code: 2, has: ["missing required section `## GOALS`"] }, "an initiative without GOALS -> block");
add("backlog/sessions/2026-11-01-first-session.md", "---\ndate: 2026-11-01\nstart_ts: 2026-11-01T06:45:00+07:00\ncwd: /x\n---\n## Notes\nx\n", { code: 0 }, "a session note in backlog/sessions/ -> clean");
add("backlog/sessions/2026-11-02-no-start.md", "---\ndate: 2026-11-02\ncwd: /x\n---\n## Notes\nx\n", { code: 2, has: ["missing required field `start_ts`"] }, "a session note without start_ts -> block");
add("backlog/sessions/README.md", "# Sessions\nNotes.\n", { code: 0 }, "a README in a record folder is never judged");
add("backlog/inbox.md", "- 2026-01-01: a thought\n- 2026-01-02: another\n", { code: 0 }, "the inbox is never judged");

// ── The store on disk ─────────────────────────────────────────────────────────

const git = (root, ...args) => {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, env: GIT_ENV, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
};

/** Writes the store (or `records`, another list in the same shape) under `root` (an empty folder), commits it, then puts the working-tree text over changed records. */
export function buildStore(root, records = RECORDS) {
  const path = (r) => join(root, r.file);
  const write = (r, text) => {
    mkdirSync(dirname(path(r)), { recursive: true });
    writeFileSync(path(r), text);
  };
  for (const r of records) if (r.head !== null) write(r, r.head ?? r.content);
  git(root, "init", "-q", "--initial-branch=main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
  for (const r of records) if (r.head !== undefined) write(r, r.content);
  return records.map(path);
}
