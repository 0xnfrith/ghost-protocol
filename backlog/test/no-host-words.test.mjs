// The backlog is generic: nothing in this folder may name the plugin it was ported from, that plugin's host, or its
// tools. The ported-from names, the host's own words, the porting markers and the words the repository's clean-tree
// scan bans are searched for in every file here. The host's words and the scan's words are built from pieces (as
// install/test/clean-tree.test.sh builds the scan's), so this file and the recipe hold neither in plain text.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const files = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" ? [] : files(join(dir, e.name))) : [join(dir, e.name)]));

// The recipe has to name the original's words to rewrite them; this file holds the list. Neither is searched for the
// first group; both are searched for the other two, which is why those are built from pieces.
const NAMES_THE_ORIGINAL = new Set(["test/golden/recipe.mjs", "test/no-host-words.test.mjs"]);

const PORTED_FROM = [
  [/checkpoint/i, "the source's checkpoint skill"],
  [/dispatch/i, "the source's dispatch skill"],
  [/\bboard\b/i, "the source's board"],
  [/\bAttio\b/i, "the source's CRM"],
  [/legacy-home/, "the source's old backlog folder"],
  [/crm_record_id/, "the source's CRM key"],
  [/nf-backlog-system/, "the source plugin's name"],
  [/render-board/, "the source's board renderer"],
  [/BUZZ_WRAPPER|check-links/, "the source's relay checks"],
  [/PORT:/, "a porting marker"],
];
const TRACKER = "Lin" + "ear";
const HOST_WORDS = [
  [`\\b${TRACKER}\\b`, "i", "the tracker the source split its records with"],
  ["gho" + "st_items", "", "the source's session key"],
  [`move-to-${TRACKER}`, "i", "the source's mover"],
  ["Gho" + "st-PR", "", "the source's relay trailer"],
  ["own" + "er-ops", "", "the source's owner type"],
  ["gho" + "st-ops", "", "the source's agent type"],
  ["\\b" + "cli" + "ent" + "\\b", "", "the source's customer type"],
  ["\\b" + "GHO" + "ST" + "\\b", "", "the source's item prefix"],
].map(([word, flags, why]) => [new RegExp(word, flags), why]);
const BANNED_BY_THE_SCAN = [
  ["s9" + "-", "i"],
  ["GHO" + "ST-", ""],
  ["sect" + "ion-9", "i"],
  ["s9" + "t", "i"],
  ["mega" + "tech", "i"],
  ["bu" + "zz:" + "//", "i"],
].map(([word, flags]) => [new RegExp(word, flags), `the banned word ${word.length} characters long`]);

const all = files(root).map((f) => [relative(root, f), readFileSync(f, "utf8")]);

test("this folder has files to search", () => {
  assert.ok(all.length > 20, `${all.length} files`);
});

for (const [pattern, why] of PORTED_FROM) {
  test(`no file names ${why}`, () => {
    const hits = all.filter(([name, text]) => !NAMES_THE_ORIGINAL.has(name) && pattern.test(text)).map(([name]) => name);
    assert.deepEqual(hits, []);
  });
}

for (const [pattern, why] of HOST_WORDS) {
  test(`no file, the recipe and this test included, names ${why}`, () => {
    assert.deepEqual(all.filter(([, text]) => pattern.test(text)).map(([name]) => name), []);
  });
}

for (const [pattern, why] of BANNED_BY_THE_SCAN) {
  test(`no file, the recipe and this test included, holds ${why}`, () => {
    assert.deepEqual(all.filter(([, text]) => pattern.test(text)).map(([name]) => name), []);
  });
}

test("no porting marker is left anywhere, the recipe and this test included", () => {
  assert.deepEqual(all.filter(([name, text]) => name !== "test/no-host-words.test.mjs" && /PORT:/.test(text)).map(([name]) => name), []);
});
