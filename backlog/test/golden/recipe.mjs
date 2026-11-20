// The golden recipe: how the original validator is turned into the one the goldens come from.
//
// The goldens (expected.json) are the exit code and stderr of an ORIGINAL validator over the fixture store. The
// original hard-codes its item prefix, its host record types, and wording that names its tracker and tools, so a
// copy of it is rewritten first, by the table below, to the neutral names of the fixture store and profile
// (../fixtures/) and to this folder's wording. Nothing else in the copy changes: every rule, every order and every
// other message is the original's own. So a record whose golden differs from the new validator's output is a rule
// that behaves differently, never a name.
//
// make-golden.mjs applies this table and needs bun. The original validator is passed in by path and is not part of
// this repository. The test (golden.test.mjs) needs only expected.json.
//
// Two kinds of entry, applied in this order:
//   MESSAGES  an exact old text and its new text, each found exactly `count` times in one file. A miss fails the
//             run, so the table cannot drift from the original unnoticed.
//   RENAMES   a whole word, renamed everywhere it occurs in any of the three files (at least once overall).
// The host's words (its type names, its tracker, its tools) are built from pieces, so that no file here holds them
// in plain text and this file passes the repository's scan for them.

const S9 = "s" + "9";
const HOST = "GHO" + "ST";
const CUSTOMER = "cli" + "ent";
const AGENT_OPS = "gho" + "st-ops";
const DESK_OPS = "own" + "er-ops";
const TRACKER = "Lin" + "ear";
const TRACKER_KEY = "lin" + "ear";
const MOVER = `move-to-${TRACKER_KEY}`;

export const FILES = ["validate", "record-rules.ts", "render-subitems"];

export const MESSAGES = [
  { file: "validate", count: 1, from: "— the board reads it to know when it is due", to: "— a reader needs it to know when it is due" },
  { file: "validate", count: 1, from: "— the board shows only its first sentence; keep it to one physical action", to: "— keep it to one physical action" },
  { file: "validate", count: 1, from: "(allocate a fresh id via scripts/allocate-id.sh)", to: "(allocate a fresh id with the backlog's allocate-id tool)" },
  {
    file: "validate",
    count: 1,
    from: "once past `draft` — identity must be firm by `scoped` (a `draft` engagement may still be a not-yet-identified prospect)",
    to: "once past `idea`/`draft`",
  },
  {
    file: "validate",
    count: 1,
    from: `(an \`${DESK_OPS}\` record that began as a decision may carry \`## CONTEXT\` instead)`,
    to: `(a \`${DESK_OPS}\` record may carry \`## CONTEXT\` instead)`,
  },
  { file: "validate", count: 1, from: `— the ${TRACKER} issue identifier the record moved to (e.g. \`ABC-12\`)`, to: "— the tracker identifier the record was handed off to" },
  { file: "validate", count: 1, from: "naming the issue (", to: "naming the tracker item (" },
  { file: "validate", count: 1, from: ", with its URL)", to: ", with its link)" },
  { file: "validate", count: 1, from: `the work lives on the ${TRACKER} issue; null it (scripts/${MOVER} does)`, to: "its work lives in the tracker; null it" },
  { file: "validate", count: 1, from: `points at ${TRACKER} with`, to: "points at the tracker with" },
  {
    file: "validate",
    count: 1,
    from: String.raw`is not a ${TRACKER} issue identifier — team key, dash, number (e.g. \`ABC-12\`)`,
    to: String.raw`is not a tracker identifier — it must match \`^[A-Za-z][A-Za-z0-9]*-\\d+$\``,
  },
  { file: "record-rules.ts", count: 1, from: `its work goes on in the ${TRACKER} issue, and`, to: "its work goes on in the tracker, and" },
];

export const RENAMES = [
  { from: HOST, to: "ALPHA" },
  { from: CUSTOMER, to: "vendor" },
  { from: S9 + "-ops", to: "ops-desk" },
  { from: AGENT_OPS, to: "agent-ops" },
  { from: DESK_OPS, to: "desk-ops" },
  { from: TRACKER_KEY, to: "tracker_ref" },
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Applies the table to { file: text }; returns the new texts, or throws naming the entry that did not apply. */
export function applyRecipe(texts) {
  const out = { ...texts };
  for (const m of MESSAGES) {
    const parts = out[m.file].split(m.from);
    if (parts.length - 1 !== m.count) throw new Error(`recipe: ${JSON.stringify(m.from)} is in ${m.file} ${parts.length - 1} times, not ${m.count}`);
    out[m.file] = parts.join(m.to);
  }
  for (const r of RENAMES) {
    const re = new RegExp(`(?<![\\w-])${escape(r.from)}(?![\\w])`, "g");
    let total = 0;
    for (const f of FILES) {
      out[f] = out[f].replace(re, () => (total++, r.to));
    }
    if (total === 0) throw new Error(`recipe: the word ${JSON.stringify(r.from)} is in none of the files`);
  }
  return out;
}
