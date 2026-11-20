// Cases the mutation check (schema-mutants.mjs) showed no other test pins: the rules' edges, which files the validator
// judges by id, the flags every command line takes, and the order of things.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRules } from "../schema/record-rules.mjs";
import { checkProfile } from "../schema/profile.mjs";
import { setup } from "../schema/setup.mjs";
import { validateFile } from "../schema/validate.mjs";
import { GIT_ENV } from "./fixtures/store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(here, "fixtures", "profile.json");
const VALIDATE = join(here, "..", "schema", "validate");

const SECTIONS = ["DESCRIPTION", "CURRENT_STATE", "REQUIREMENTS", "DOD", "UAT", "DEPLOYMENT", "REFERENCES", "ACTIVITY_LOG"];
const app = (id, status, extra = "") =>
  `---\nid: ${id}\ntitle: "T"\ntype: app\nstatus: ${status}\ncreated: 2026-01-01\nupdated: 2026-01-01\n${extra}---\n# ${id}: T\n${SECTIONS.map((s) => `## ${s}\nx\n`).join("")}`;
const config = { prefix: "ALPHA", dir: "backlog", dirSegments: ["backlog"] };
const rules = createRules();

const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "backlog-gaps-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
};
const put = (dir, file, text) => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
  return join(dir, file);
};
const judge = (file, c = config, r = rules) => validateFile(file, { rules: r, config: c });

// ── the rules ──
test("a status the type does not have has no legal moves, and a status without a row in the table is final", () => {
  const generic = createRules();
  assert.deepEqual(generic.legalMoves("app", "open"), [], "a decision status on a work type");
  assert.deepEqual(generic.legalMoves("nope", "idea"), []);
  assert.deepEqual(generic.legalMoves("personal-ops", "scoped"), [], "the table has a row for scoped; this type has no such status");
  const { profile } = checkProfile({ version: 1, types: { sealed: { family: "work", statuses: ["idea", "sealed"] } } });
  const r = createRules({ profile });
  assert.deepEqual(r.legalMoves("sealed", "sealed"), []);
  assert.equal(r.checkMove("sealed", "sealed", "idea"), "`sealed` → `idea` is not a legal move — `sealed` is final for a record of type `sealed`");
  // a move the table knows, from a status the type has: the legal ones are named
  assert.match(r.checkMove("app", "idea", "completed"), /^`idea` → `completed` is not a legal move — from `idea`, a record of type `app` may go to: draft, scoped, active, cancelled$/);
});

test("a waiting party is trimmed before it is read, as an owner is", () => {
  const r = createRules({ operatorNames: ["Sam"] });
  assert.equal(r.namesOperator("  operator, please"), true);
  assert.equal(r.namesOperator("\tSam's rulings\n"), true);
  assert.equal(r.isOperator("  OPERATOR "), true);
  assert.equal(r.namesOperator("an operator"), false, "only the start counts");
});

// ── which files are judged by their id ──
test("outside the data folder only the item prefix, ARC- and INIT- make a record: another prefix, or the prefix inside a longer word, does not", () => {
  const t = temp();
  try {
    const bad = (id) => app(id, "draft").replace("## DESCRIPTION\nx\n", "");
    assert.deepEqual(judge(put(t.dir, "scratch/OTHER-001.md", bad("OTHER-001"))), { code: 0, lines: [] }, "another prefix is not ours");
    assert.deepEqual(judge(put(t.dir, "scratch/XALPHA-001.md", bad("XALPHA-001"))), { code: 0, lines: [] }, "the prefix is anchored at the start");
    assert.deepEqual(judge(put(t.dir, "scratch/notes.md", bad("OTHER-002").replace("id: OTHER-002\n", ""))), { code: 0, lines: [] }, "no id, no record");
    const own = judge(put(t.dir, "scratch/ALPHA-001.md", bad("ALPHA-001")));
    assert.equal(own.code, 2);
    assert.equal(own.lines[0], "✗ ALPHA-001.md does not match the backlog schema (judged as an item from its id — the file is outside backlog/):");
    assert.equal(judge(put(t.dir, "scratch/ARC-001.md", "---\nid: ARC-001\n---\n")).code, 2, "ARC- is an arc");
    assert.equal(judge(put(t.dir, "scratch/INIT-001.md", "---\nid: INIT-001\n---\n")).code, 2, "INIT- is an initiative");
    assert.equal(judge(put(t.dir, "scratch/ALPHA-tmp-0a1b2c3d.md", bad("ALPHA-tmp-0a1b2c3d"))).code, 2, "a provisional id is an id");
    assert.deepEqual(judge(put(t.dir, "scratch/ALPHA-tmp-xyz.md", bad("ALPHA-tmp-xyz"))), { code: 0, lines: [] }, "a provisional id is hex");
    assert.equal(judge(put(t.dir, "scratch/x.md", "---\nstart_ts: 1\n---\n")).code, 2, "a start_ts makes a session");
  } finally {
    t.done();
  }
});

test("the inbox and the folder notes are never judged, even inside a record folder; any other file there is", () => {
  const t = temp();
  try {
    for (const name of ["inbox.md", "CLAUDE.md", "README.md"]) assert.deepEqual(judge(put(t.dir, `backlog/items/${name}`, "- a thought\n")), { code: 0, lines: [] }, name);
    assert.equal(judge(put(t.dir, "backlog/items/other.md", "- a thought\n")).code, 2);
    assert.deepEqual(judge(put(t.dir, "backlog/items/missing.md", "")), { code: 2, lines: judge(put(t.dir, "backlog/items/missing.md", "")).lines }, "an empty file is an item with every field missing");
    assert.deepEqual(judge(join(t.dir, "backlog/items/does-not-exist.md")), { code: 0, lines: [] }, "a deleted file is nothing to judge");
    assert.deepEqual(judge(undefined), { code: 0, lines: [] });
  } finally {
    t.done();
  }
});

test("a record outside the data folder is judged by itself: no status move, no sibling checks", () => {
  const t = temp();
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: t.dir, env: GIT_ENV, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  try {
    // completed -> active is not a legal move (a finished record reopens through draft)
    put(t.dir, "backlog/items/ALPHA-001.md", app("ALPHA-001", "completed"));
    put(t.dir, "scratch/ALPHA-002.md", app("ALPHA-002", "completed"));
    put(t.dir, "scratch/ALPHA-002-twin.md", app("ALPHA-002", "completed"));
    git("init", "-q", "--initial-branch=main");
    git("add", "-A");
    git("commit", "-q", "-m", "x");
    const active = (id) => app(id, "active", "next_action: Ship it\n");
    const inside = judge(put(t.dir, "backlog/items/ALPHA-001.md", active("ALPHA-001")));
    assert.equal(inside.code, 1);
    assert.match(inside.lines[1], /^ {2}- the status changed since the last commit: `completed` → `active` is not a legal move/);
    const outside = judge(put(t.dir, "scratch/ALPHA-002.md", active("ALPHA-002")));
    assert.deepEqual(outside, { code: 0, lines: [] }, "outside the data folder: no move check, and no duplicate-id check");
  } finally {
    t.done();
  }
});

// ── the order of things ──
test("records that share an id are listed in name order, whatever order they were made in", () => {
  for (const order of [["a", "b", "c", "d", "e"], ["e", "d", "c", "b", "a"]]) {
    const t = temp();
    try {
      for (const s of order) put(t.dir, `backlog/items/ALPHA-050-${s}.md`, app("ALPHA-050", "draft"));
      const r = judge(join(t.dir, "backlog/items/ALPHA-050-c.md"));
      assert.equal(r.code, 1);
      assert.match(r.lines[1], /`id: ALPHA-050` is also carried by ALPHA-050-a\.md, ALPHA-050-b\.md, ALPHA-050-d\.md, ALPHA-050-e\.md — /);
    } finally {
      t.done();
    }
  }
});

// ── the flags every command line takes ──
const env = { HOME: "/nonexistent", CLAUDE_CONFIG_DIR: "/nonexistent" };

test("setup: --prefix, --dir, --operator-names and --profile, and every other argument left in order", () => {
  const s = setup(["--prefix", "OMEGA", "x", "--dir", "docs/records", "--operator-names", "Sam, Ann", "y", "--profile", PROFILE, "--other"], env);
  assert.equal(s.config.prefix, "OMEGA");
  assert.equal(s.config.dir, "docs/records");
  assert.deepEqual(s.config.dirSegments, ["docs", "records"]);
  assert.deepEqual(s.config.operatorNames, ["Sam", "Ann"]);
  assert.equal(s.config.profile, PROFILE);
  assert.equal(s.profileProblem, null);
  assert.deepEqual(s.rest, ["x", "y", "--other"]);
  assert.equal(s.rules.isOperator("ann"), true, "the names reach the rules");
  assert.equal(s.rules.typeNames.includes("vendor"), true, "the profile reaches the rules");
  assert.deepEqual(s.problems, []);
});

test("setup: a flag without a value is ignored, and a relative --profile is resolved from the working folder", () => {
  const t = temp();
  const was = process.cwd();
  try {
    assert.equal(setup(["--prefix"], env).config.prefix, "BL");
    writeFileSync(join(t.dir, "p.json"), '{"version": 1}');
    process.chdir(t.dir);
    const s = setup(["--profile", "p.json"], env);
    assert.equal(s.config.profile, join(process.cwd(), "p.json"));
    assert.equal(s.profileProblem, null);
    assert.match(setup(["--profile", "missing.json"], env).profileProblem, /^backlog_profile: cannot read .*missing\.json \(ENOENT\)/);
  } finally {
    process.chdir(was);
    t.done();
  }
});

test("the validator's own flags judge by them, and a relative --profile works from the working folder", () => {
  const t = temp();
  try {
    put(t.dir, "profile.json", readFileSync(PROFILE, "utf8"));
    const file = put(t.dir, "scratch/OMEGA-001.md", app("OMEGA-001", "draft").replace("type: app", "type: vendor"));
    const run = (args, extra = {}) => spawnSync(process.execPath, [VALIDATE, ...args, file], { cwd: t.dir, env: { ...GIT_ENV, ...extra }, encoding: "utf8" });
    assert.equal(run([]).status, 0, "OMEGA is not the default prefix: not a record");
    assert.equal(run(["--prefix", "OMEGA"]).status, 2, "--prefix: judged, and the type is unknown without a profile");
    assert.match(run(["--prefix", "OMEGA"]).stderr, /unknown item type `vendor`/);
    const withProfile = run(["--prefix", "OMEGA", "--profile", "profile.json"]);
    assert.doesNotMatch(withProfile.stderr, /unknown item type/, "a relative --profile is read from the working folder");
    assert.equal(run(["--prefix", "OMEGA", "--profile", join(t.dir, "profile.json")]).stderr, withProfile.stderr);
  } finally {
    t.done();
  }
});
