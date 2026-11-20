// The validator's tests: the real command line, run on every record of fixtures/store.mjs (a made-up store in a
// git repository under an isolated git setup), with the settings that store needs (prefix ALPHA, the fixture
// profile). Exit codes are 0 clean, 1 non-blocking warning, 2 block (INVARIANTS.md I-5).
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_ENV, RECORDS, buildStore } from "./fixtures/store.mjs";

const BACKLOG = join(dirname(fileURLToPath(import.meta.url)), "..");
const VALIDATE = join(BACKLOG, "schema", "validate");
const RENDER = join(BACKLOG, "schema", "render-subitems");
const PROFILE = join(BACKLOG, "test", "fixtures", "profile.json");

const root = mkdtempSync(join(tmpdir(), "backlog-validate-"));
after(() => rmSync(root, { recursive: true, force: true }));
const paths = buildStore(join(root, "store"));
const pathOf = (file) => paths[RECORDS.findIndex((r) => r.file === file)];

/** Runs the validator on one file. `env` overrides the settings the store needs. */
const validate = (file, env = {}) => {
  const r = spawnSync(process.execPath, [VALIDATE, file], { env: { ...GIT_ENV, BACKLOG_PREFIX: "ALPHA", BACKLOG_PROFILE: PROFILE, ...env }, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

const results = new Map();
const resultOf = (i) => {
  if (!results.has(i)) results.set(i, validate(paths[i]));
  return results.get(i);
};

// ── One test per record ───────────────────────────────────────────────────────
for (const [i, record] of RECORDS.entries()) {
  test(record.note, () => {
    const r = resultOf(i);
    assert.equal(r.code, record.expect.code, `${record.file}: want exit ${record.expect.code}, got ${r.code}\n${r.stderr}`);
    assert.equal(r.stdout, "", "the validator writes only to stderr");
    for (const phrase of record.expect.has) assert.ok(r.stderr.includes(phrase), `${record.file}: stderr should mention ${JSON.stringify(phrase)}; got:\n${r.stderr}`);
    for (const phrase of record.expect.hasNot) assert.ok(!r.stderr.includes(phrase), `${record.file}: stderr should not mention ${JSON.stringify(phrase)}; got:\n${r.stderr}`);
    if (record.expect.code === 0) assert.equal(r.stderr, "", "a clean record is silent");
  });
}

test("the only exit codes are 0, 1 and 2, and every record of each kind is among the store", () => {
  const codes = new Set(RECORDS.map((_, i) => resultOf(i).code));
  assert.deepEqual([...codes].sort(), [0, 1, 2]);
});

// ── Byte-exact output ─────────────────────────────────────────────────────────
test("the warning line for one warning is byte-exact", () => {
  const r = resultOf(RECORDS.findIndex((x) => x.file === "backlog/items/ALPHA-1001.md"));
  assert.equal(
    r.stderr,
    "⚠ ALPHA-1001.md is valid, with a non-blocking warning:\n" +
      "  - `status: completed` is finished, but the record still carries `next_action` — a finished record has no next action and waits on no one, so set it to null (backlog-record: `--clear-next-action`)\n",
  );
});

test("the warning line for several warnings is byte-exact", () => {
  const r = resultOf(RECORDS.findIndex((x) => x.file === "backlog/items/ALPHA-1070.md"));
  assert.equal(
    r.stderr,
    "⚠ ALPHA-1070.md is valid, with non-blocking warnings:\n" +
      "  - `status: completed` is finished, but the record still carries `next_action` — a finished record has no next action and waits on no one, so set it to null (backlog-record: `--clear-next-action`)\n" +
      "  - `status: completed` is finished, but the record still carries `waiting_on` — a finished record has no next action and waits on no one, so set it to null (backlog-record: `--clear-waiting`)\n",
  );
});

test("a block is byte-exact: the header, one line per error, a blank line, the fix line", () => {
  const r = resultOf(RECORDS.findIndex((x) => x.file === "backlog/items/ALPHA-941.md"));
  assert.equal(
    r.stderr,
    "✗ ALPHA-941.md does not match the backlog schema:\n" +
      "  - `status: moved` requires `tracker_ref` — the tracker identifier the record was handed off to\n" +
      "\n" +
      "Fix the record to match the plugin's schema/schema.md, then re-save.\n",
  );
});

test("a record outside the data folder says how it was judged and where it is", () => {
  const r = resultOf(RECORDS.findIndex((x) => x.file === "scratch/ARC-950-copy.md"));
  assert.ok(r.stderr.startsWith("✗ ARC-950-copy.md does not match the backlog schema (judged as an arc from its id — the file is outside backlog/):\n"), r.stderr);
});

// ── Settings and the profile ──────────────────────────────────────────────────
test("without a profile, a vendor record is an unknown type, and the list is the generic types", () => {
  const r = validate(pathOf("backlog/items/ALPHA-1052.md"), { BACKLOG_PROFILE: "" });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("unknown item type `vendor` (expected one of: app, infra, plugin, personal-ops, research, decision, chore)"), r.stderr);
});

test("without a profile, `moved` is not a status of a generic type", () => {
  const r = validate(pathOf("backlog/items/ALPHA-940.md"), { BACKLOG_PROFILE: "" });
  assert.equal(r.code, 2);
  assert.ok(r.stderr.includes("status `moved` is not valid here (allowed: idea, draft, scoped, active, blocked, completed, deferred, cancelled)"), r.stderr);
});

test("a bad prefix setting still judges the record, with the default, and adds one non-blocking line", () => {
  const clean = validate(pathOf("backlog/items/ALPHA-921.md"), { BACKLOG_PREFIX: "zz" });
  assert.equal(clean.code, 1);
  assert.equal(clean.stderr, '⚠ ALPHA-921.md is valid, with a non-blocking warning:\n  - backlog_prefix: "zz" is not used (must be 2 to 12 capital letters)\n');
  const blocked = validate(pathOf("backlog/items/ALPHA-941.md"), { BACKLOG_PREFIX: "zz" });
  assert.equal(blocked.code, 2, "a bad setting never turns a block into a pass");
  assert.ok(blocked.stderr.includes('  - (warning) backlog_prefix: "zz" is not used'), blocked.stderr);
});

test("a bad setting is not mentioned on a file that is not a record", () => {
  const r = validate(pathOf("scratch/notes.md"), { BACKLOG_PREFIX: "zz" });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
});

test("a profile that cannot be read: exit 1, the warning header, and the record is not judged", () => {
  const r = validate(pathOf("backlog/items/ALPHA-941.md"), { BACKLOG_PROFILE: "/nonexistent/profile.json" });
  assert.equal(r.code, 1, "the record is not judged, so it is not blocked either");
  const [header, detail, ...rest] = r.stderr.split("\n");
  assert.equal(header, "⚠ ALPHA-941.md is valid, with a non-blocking warning:");
  assert.ok(detail.includes("backlog_profile: cannot read /nonexistent/profile.json"), detail);
  assert.ok(detail.endsWith("; this record was not judged"), detail);
  assert.deepEqual(rest, [""]);
});

test("a profile that is not valid JSON, and one with an unknown key, are both unusable", () => {
  const dir = join(root, "profiles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "broken.json"), "{ not json");
  writeFileSync(join(dir, "extra.json"), JSON.stringify({ version: 1, surprise: true }));
  const broken = validate(pathOf("backlog/items/ALPHA-921.md"), { BACKLOG_PROFILE: join(dir, "broken.json") });
  assert.equal(broken.code, 1);
  assert.ok(broken.stderr.includes("is not valid JSON"), broken.stderr);
  const extra = validate(pathOf("backlog/items/ALPHA-921.md"), { BACKLOG_PROFILE: join(dir, "extra.json") });
  assert.equal(extra.code, 1);
  assert.ok(extra.stderr.includes("the profile has an unknown key \"surprise\""), extra.stderr);
});

test("a profile that cannot be read leaves a file that is not a record alone", () => {
  const r = validate(pathOf("backlog/inbox.md"), { BACKLOG_PROFILE: "/nonexistent/profile.json" });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
});

test("the data folder is a setting, matched as whole path segments", () => {
  // A record-shaped file in a folder that is not a record folder: inside the data folder it is not ours (silent);
  // outside it, it is judged by its id.
  const body = "---\nid: ALPHA-2000\ntitle: x\nstatus: concluded\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n# ALPHA-2000\n";
  const inside = join(root, "setting", "docs", "notes", "searches", "ALPHA-2000.md");
  const lookalike = join(root, "setting", "docs", "notes-old", "searches", "ALPHA-2000.md");
  for (const file of [inside, lookalike]) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body);
  }
  assert.equal(validate(inside, { BACKLOG_DIR: "docs/notes" }).code, 0, "inside the data folder, a folder that holds no records is not judged");
  const outside = validate(inside);
  assert.equal(outside.code, 2, "under the default folder name the same file is outside it, so it is judged by its id");
  assert.ok(outside.stderr.includes("judged as an item from its id"), outside.stderr);
  const near = validate(lookalike, { BACKLOG_DIR: "docs/notes" });
  assert.equal(near.code, 2, "docs/notes-old is not docs/notes: the match is by whole segments, not by substring");
});

// ── Names every object inherits ───────────────────────────────────────────────
// A record's text indexes the validator's tables; `constructor`, `__proto__` and `toString` must find nothing there.
const writeAt = (file, body) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
  return file;
};
const item = (id, type) =>
  `---\nid: ${id}\ntitle: x\ntype: ${type}\nstatus: active\nnext_action: x\ncreated: 2026-01-01\nupdated: 2026-01-01\n---\n## DESCRIPTION\nx\n`;

for (const [n, type] of ["constructor", "__proto__", "toString"].entries()) {
  test(`a record of type \`${type}\` is an unknown type: a block with the usual message, with or without a profile`, () => {
    const file = writeAt(join(root, "inherited", "backlog", "items", `ALPHA-${3000 + n}.md`), item(`ALPHA-${3000 + n}`, type));
    for (const env of [{}, { BACKLOG_PROFILE: "" }]) {
      const r = validate(file, env);
      assert.equal(r.code, 2, r.stderr);
      assert.ok(r.stderr.includes(`  - unknown item type \`${type}\` (expected one of: app, infra, plugin, `), r.stderr);
      assert.ok(!r.stderr.includes("TypeError"), r.stderr);
    }
  });
}

test("a frontmatter key named like an inherited one counts only when the record sets it", () => {
  const profile = writeAt(join(root, "inherited", "widget.json"), JSON.stringify({ version: 1, types: { widget: { family: "work", statuses: ["idea", "active"], fields: ["constructor"] } } }));
  const file = writeAt(join(root, "inherited", "backlog", "items", "ALPHA-3010.md"), item("ALPHA-3010", "widget"));
  const missing = validate(file, { BACKLOG_PROFILE: profile });
  assert.equal(missing.code, 2, missing.stderr);
  assert.ok(missing.stderr.includes("missing required field `constructor`"), missing.stderr);
  writeAt(file, item("ALPHA-3010", "widget").replace("status: active", "constructor: set\nstatus: active"));
  assert.equal(validate(file, { BACKLOG_PROFILE: profile }).code, 0);
});

// ── A sessions/ folder outside the data folder ────────────────────────────────
test("a session record in a sessions/ folder outside the data folder is judged by its folder, not its frontmatter", () => {
  const noStart = writeAt(join(root, "elsewhere", "sessions", "2026-01-01-no-start.md"), "---\ndate: 2026-01-01\ncwd: /x\n---\n## Notes\nx\n");
  const r = validate(noStart);
  assert.equal(r.code, 2, r.stderr);
  assert.ok(r.stderr.startsWith("✗ 2026-01-01-no-start.md does not match the backlog schema:\n  - missing required field `start_ts`\n"), r.stderr);
  // With neither start_ts nor cwd, only the folder says it is a session record.
  const bare = writeAt(join(root, "elsewhere", "sessions", "2026-01-02-bare.md"), "---\ndate: 2026-01-02\n---\n## Notes\nx\n");
  const b = validate(bare);
  assert.equal(b.code, 2, b.stderr);
  assert.ok(b.stderr.includes("missing required field `cwd`") && b.stderr.includes("missing required field `start_ts`"), b.stderr);
  // The same record in any other folder outside the data folder is judged from its frontmatter, and says so.
  const loose = writeAt(join(root, "elsewhere", "notes", "2026-01-01-no-start.md"), "---\ndate: 2026-01-01\ncwd: /x\n---\n## Notes\nx\n");
  const l = validate(loose);
  assert.equal(l.code, 2, l.stderr);
  assert.ok(l.stderr.includes("(judged as a session from its frontmatter — the file is outside backlog/)"), l.stderr);
});

// ── The sub-item renderer, with the same settings ─────────────────────────────
test("render-subitems ticks a moved sub-item and leaves an open sibling open", () => {
  const items = dirname(pathOf("backlog/items/ALPHA-960.md"));
  const r = spawnSync(process.execPath, [RENDER, "ALPHA-960", items], { env: { ...GIT_ENV, BACKLOG_PREFIX: "ALPHA", BACKLOG_PROFILE: PROFILE }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const moved = r.stdout.indexOf("- [x] ALPHA-961");
  const open = r.stdout.indexOf("- [ ] ALPHA-962");
  assert.ok(moved >= 0 && open > moved, r.stdout);
});
