// scripts/compare-store.mjs: an old validator and the new one over a store, and what counts as a difference.
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { main, recordFiles, verdictOf } from "../scripts/compare-store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const VALIDATE = join(here, "..", "schema", "validate");
const COMPARE = join(here, "..", "scripts", "compare-store.mjs");

const SECTIONS = ["DESCRIPTION", "CURRENT_STATE", "REQUIREMENTS", "DOD", "UAT", "DEPLOYMENT", "REFERENCES", "ACTIVITY_LOG"];
const record = (id, { status = "completed", extra = "", sections = SECTIONS } = {}) =>
  `---\nid: ${id}\ntitle: "T ${id}"\ntype: app\nstatus: ${status}\ncreated: 2026-01-01\nupdated: 2026-01-01\n${extra}---\n# ${id}: T\n${sections.map((s) => `## ${s}\nx\n`).join("")}`;

// A store with a clean record, a blocked one (a missing section), and one that only warns (a dangling parent).
const store = () => {
  const root = mkdtempSync(join(tmpdir(), "backlog-compare-"));
  const items = join(root, "backlog", "items");
  mkdirSync(items, { recursive: true });
  writeFileSync(join(items, "ALPHA-001.md"), record("ALPHA-001"));
  writeFileSync(join(items, "ALPHA-002.md"), record("ALPHA-002", { sections: SECTIONS.slice(1) }));
  writeFileSync(join(items, "ALPHA-003.md"), record("ALPHA-003", { extra: "parent: ALPHA-999\n" }));
  writeFileSync(join(items, "notes.txt"), "not a record");
  return root;
};

// A stand-in for the old validator: the real one, then a change to what it printed, by MODE.
const standIn = (root, mode) => {
  const file = join(root, `old-${mode}`);
  writeFileSync(
    file,
    `#!${process.execPath}
import { spawnSync } from "node:child_process";
const r = spawnSync(${JSON.stringify(VALIDATE)}, ["--prefix", "ALPHA", process.argv[2]], { encoding: "utf8" });
let text = r.stderr;
let code = r.status;
const mode = ${JSON.stringify(mode)};
if (mode === "reworded") text = text.replaceAll("missing required", "lacks the required");
if (mode === "always-zero") { text = ""; code = 0; }
if (mode === "drop-last-bullet") { const l = text.split("\\n"); const i = l.findLastIndex((x) => x.startsWith("  - ")); if (i >= 0) l.splice(i, 1); text = l.join("\\n"); }
if (mode === "extra-warning" && text.startsWith("⚠")) text += text.trimEnd().split("\\n").at(-1) + "\\n";
if (mode === "exit-zero-same-text") code = 0;
if (mode === "crash") { process.kill(process.pid, "SIGKILL"); }
process.stderr.write(text);
process.exitCode = code;
`,
  );
  chmodSync(file, 0o755);
  return file;
};

const run = (args, root) => {
  const r = spawnSync(process.execPath, [COMPARE, "--prefix", "ALPHA", "--store", root, ...args], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, "no-settings") } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test("verdictOf counts the error and warning lines of a block and of a warning", () => {
  assert.deepEqual(verdictOf(2, "✗ a.md does not match the backlog schema:\n  - one\n  - two\n  - (warning) three\n\nFix it.\n"), { code: 2, errors: 2, warnings: 1 });
  assert.deepEqual(verdictOf(1, "⚠ a.md is valid, with non-blocking warnings:\n  - one\n  - two\n"), { code: 1, errors: 0, warnings: 2 });
  assert.deepEqual(verdictOf(0, ""), { code: 0, errors: 0, warnings: 0 });
});

test("recordFiles lists the records of the four folders, sorted, and only .md files", () => {
  const root = store();
  try {
    mkdirSync(join(root, "backlog", "arcs"));
    writeFileSync(join(root, "backlog", "arcs", "ARC-001.md"), "x");
    writeFileSync(join(root, "backlog", "inbox.md"), "x");
    assert.deepEqual(recordFiles(root, ["backlog"]).map((f) => f.slice(root.length + 1)), ["backlog/items/ALPHA-001.md", "backlog/items/ALPHA-002.md", "backlog/items/ALPHA-003.md", "backlog/arcs/ARC-001.md"].sort((a, b) => ["items", "arcs"].indexOf(a.split("/")[1]) - ["items", "arcs"].indexOf(b.split("/")[1]) || a.localeCompare(b)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an old validator that agrees: no difference, exit 0", () => {
  const root = store();
  try {
    const r = run(["--old", standIn(root, "same")], root);
    assert.equal(r.code, 0, r.out + r.err);
    assert.equal(r.out, "compared 3 records: 0 verdict differences, 0 text-only differences\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a different exit code is a VERDICT difference and fails", () => {
  const root = store();
  try {
    const r = run(["--old", standIn(root, "always-zero")], root);
    assert.equal(r.code, 1);
    assert.match(r.out, /^VERDICT backlog\/items\/ALPHA-002\.md: old exit 0 \(0 errors, 0 warnings\), new exit 2 \(/m);
    assert.match(r.out, /^VERDICT backlog\/items\/ALPHA-003\.md: old exit 0 .*new exit 1 \(0 errors, 1 warning\)$/m);
    assert.match(r.out, /^ {2}new\| {3}- missing required section `## DESCRIPTION`$/m);
    assert.match(r.out, /compared 3 records: 2 verdict differences, 0 text-only differences\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the same exit code with one line fewer is a VERDICT difference", () => {
  const root = store();
  try {
    const r = run(["--old", standIn(root, "drop-last-bullet")], root);
    assert.equal(r.code, 1);
    assert.match(r.out, /^VERDICT backlog\/items\/ALPHA-002\.md: old exit 2 \(0 errors, 0 warnings\), new exit 2 \(1 error, 0 warnings\)$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one more warning line alone, or another exit code alone, is a VERDICT difference", () => {
  const root = store();
  try {
    const more = run(["--old", standIn(root, "extra-warning")], root);
    assert.equal(more.code, 1, more.out);
    assert.match(more.out, /^VERDICT backlog\/items\/ALPHA-003\.md: old exit 1 \(0 errors, 2 warnings\), new exit 1 \(0 errors, 1 warning\)$/m);
    assert.match(more.out, /compared 3 records: 1 verdict difference, 0 text-only differences\n$/);
    const code = run(["--old", standIn(root, "exit-zero-same-text")], root);
    assert.equal(code.code, 1, code.out);
    assert.match(code.out, /^VERDICT backlog\/items\/ALPHA-002\.md: old exit 0 \(1 error, 0 warnings\), new exit 2 \(1 error, 0 warnings\)$/m);
    assert.match(code.out, /^VERDICT backlog\/items\/ALPHA-003\.md: old exit 0 \(0 errors, 1 warning\), new exit 1 \(0 errors, 1 warning\)$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("other words with the same exit code and counts are TEXT differences: listed, not a fail, unless --strict", () => {
  const root = store();
  try {
    const old = standIn(root, "reworded");
    const r = run(["--old", old], root);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^TEXT backlog\/items\/ALPHA-002\.md: both exit 2 \(1 error, 0 warnings\); the words differ$/m);
    assert.match(r.out, /^ {2}old\| {3}- lacks the required section `## DESCRIPTION`$/m);
    assert.match(r.out, /^ {2}new\| {3}- missing required section `## DESCRIPTION`$/m);
    assert.doesNotMatch(r.out, /ALPHA-001|ALPHA-003/, "records that match are not listed");
    assert.match(r.out, /compared 3 records: 0 verdict differences, 1 text-only difference\n$/);
    const strict = run(["--old", old, "--strict"], root);
    assert.equal(strict.code, 1);
    assert.match(strict.out, /\(strict: both fail\)\n$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--old-via runs the old validator under an interpreter", () => {
  const root = store();
  try {
    const script = join(root, "old.mjs");
    writeFileSync(script, `import { spawnSync } from "node:child_process";\nconst r = spawnSync(${JSON.stringify(VALIDATE)}, ["--prefix", "ALPHA", process.argv[2]], { encoding: "utf8" });\nprocess.stderr.write(r.stderr);\nprocess.exitCode = r.status;\n`);
    const r = run(["--old", script, "--old-via", process.execPath], root);
    assert.equal(r.code, 0, r.out + r.err);
    assert.match(r.out, /0 verdict differences/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run that cannot be made is exit 2: no old validator, no records, a validator that dies, bad arguments, a bad profile", () => {
  const root = store();
  const empty = mkdtempSync(join(tmpdir(), "backlog-compare-empty-"));
  try {
    const missing = run(["--old", join(root, "nope")], root);
    assert.equal(missing.code, 2);
    assert.match(missing.err, /the old validator could not be run on backlog\/items\/ALPHA-001\.md: spawnSync .* ENOENT/);
    const none = run(["--old", standIn(root, "same")], empty);
    assert.equal(none.code, 2);
    assert.match(none.err, /no records found under /);
    const died = run(["--old", standIn(root, "crash")], root);
    assert.equal(died.code, 2);
    assert.match(died.err, /ended by SIGKILL/);
    for (const args of [[], ["--old", "x"], ["--store", root], ["--old", "x", "--store", root, "extra"]]) {
      const r = spawnSync(process.execPath, [COMPARE, ...args], { encoding: "utf8" });
      assert.equal(r.status, 2, args.join(" "));
      assert.match(r.stderr, /^usage: compare-store/);
    }
    const profile = run(["--old", standIn(root, "same"), "--profile", join(root, "missing.json")], root);
    assert.equal(profile.code, 2);
    assert.match(profile.err, /backlog_profile: cannot read/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(empty, { recursive: true, force: true });
  }
});

test("main writes its report to the functions it is given", () => {
  const root = store();
  try {
    let out = "";
    let err = "";
    const code = main(["--prefix", "ALPHA", "--store", root, "--old", standIn(root, "same")], { HOME: root }, (s) => (out += s), (s) => (err += s));
    assert.equal(code, 0);
    assert.match(out, /^compared 3 records/);
    assert.equal(err, "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
