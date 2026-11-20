// The golden outputs: the exit code and stderr of an original validator over the fixture store, byte for byte
// (golden/expected.json; golden/recipe.mjs says how they were made). This folder's validator, run with the fixture's
// settings and profile, must produce every one of them. It needs no bun.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RECORDS, buildStore } from "./fixtures/store.mjs";
import { runNew, toJson } from "./golden/shared.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "golden", "expected.json"), "utf8");
const golden = JSON.parse(raw).records;

const temp = (name) => mkdtempSync(join(tmpdir(), name));
const root = temp("backlog-golden-");
const paths = buildStore(root);
test.after(() => rmSync(root, { recursive: true, force: true }));

test("the goldens are the fixture store's records, all of them, and nothing else", () => {
  assert.deepEqual(Object.keys(golden).sort(), RECORDS.map((r) => r.file).sort());
});

test("the goldens hold every kind of verdict, and are plain ASCII, written the way make-golden writes them", () => {
  const codes = new Set(Object.values(golden).map((g) => g.code));
  assert.deepEqual([...codes].sort(), [0, 1, 2]);
  assert.equal(/[^\n -~]/.test(raw), false, "expected.json holds only ASCII");
  assert.equal(raw, toJson({ records: golden }));
  assert.ok(Object.values(golden).some((g) => g.stderr.includes("→")), "a move warning is pinned");
  assert.ok(Object.values(golden).some((g) => g.stderr.startsWith("⚠ ")), "a warning header is pinned");
  assert.ok(Object.values(golden).some((g) => g.stderr.startsWith("✗ ")), "a block header is pinned");
});

RECORDS.forEach((rec, i) => {
  test(`golden: ${rec.file} (${rec.note})`, () => {
    const got = runNew(paths[i]);
    const want = golden[rec.file];
    assert.equal(got.code, want.code, `exit code\n${got.stderr}`);
    assert.equal(got.stderr, want.stderr);
  });
});

test("the same store under another prefix and another data folder gives the same verdicts, word for word", () => {
  const renamed = RECORDS.map((r) => ({
    ...r,
    file: r.file.replaceAll("ALPHA", "OMEGA").replace(/^backlog\//, "docs/records/"),
    content: r.content.replaceAll("ALPHA", "OMEGA"),
    ...(typeof r.head === "string" ? { head: r.head.replaceAll("ALPHA", "OMEGA") } : {}),
  }));
  const root2 = temp("backlog-golden-renamed-");
  try {
    const paths2 = buildStore(root2, renamed);
    renamed.forEach((rec, i) => {
      const got = runNew(paths2[i], { BACKLOG_PREFIX: "OMEGA", BACKLOG_DIR: "docs/records" });
      const want = golden[RECORDS[i].file];
      assert.equal(got.code, want.code, rec.file);
      assert.equal(got.stderr.replaceAll("OMEGA", "ALPHA").replaceAll("docs/records/", "backlog/"), want.stderr, rec.file);
    });
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
});
