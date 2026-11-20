#!/usr/bin/env node
/**
 * backlog/test/golden/make-golden.mjs: makes expected.json, the golden outputs, from an ORIGINAL validator.
 *
 *   node make-golden.mjs --original <folder with validate, render-subitems and record-rules.ts> [--out expected.json] [--diff]
 *
 * Needs bun, and is never run in CI. It copies the original's three files to a temp folder, rewrites them by
 * recipe.mjs, builds the fixture store as a git repository exactly as golden.test.mjs does, runs the rewritten
 * validator (bun) on every record, and writes each record's exit code and stderr. With --diff it writes nothing and
 * instead runs this folder's validator beside it and prints every record where they differ: how the recipe is
 * checked and extended.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RECORDS, buildStore, GIT_ENV } from "../fixtures/store.mjs";
import { FILES, applyRecipe } from "./recipe.mjs";
import { runNew, toJson } from "./shared.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? "";
};
const original = flag("--original");
if (!original) {
  console.error("usage: make-golden.mjs --original <folder> [--out expected.json] [--diff]");
  process.exit(2);
}
const outFile = resolve(flag("--out") ?? join(here, "expected.json"));
const diff = args.includes("--diff");

const work = mkdtempSync(join(tmpdir(), "backlog-golden-"));
try {
  const schema = join(work, "schema");
  mkdirSync(schema);
  const texts = Object.fromEntries(FILES.map((f) => [f, readFileSync(join(resolve(original), f), "utf8")]));
  const changed = applyRecipe(texts);
  for (const f of FILES) {
    writeFileSync(join(schema, f), changed[f]);
  }
  const store = join(work, "store");
  mkdirSync(store);
  const paths = buildStore(store);
  const records = {};
  const differences = [];
  RECORDS.forEach((rec, i) => {
    const r = spawnSync("bun", [join(schema, "validate"), paths[i]], { env: GIT_ENV, encoding: "utf8" });
    if (r.error) throw new Error(`bun could not be run: ${r.error.message}`);
    records[rec.file] = { code: r.status, stderr: r.stderr };
    if (diff) {
      const n = runNew(paths[i]);
      if (n.code !== r.status || n.stderr !== r.stderr) differences.push({ file: rec.file, old: records[rec.file], new: n });
    }
  });
  if (diff) {
    for (const d of differences) console.log(`DIFFERENT ${d.file}\n  original: ${JSON.stringify(d.old)}\n  new:      ${JSON.stringify(d.new)}`);
    console.log(`${RECORDS.length} records, ${differences.length} differ`);
    process.exitCode = differences.length ? 1 : 0;
  } else {
    writeFileSync(outFile, toJson({ records }));
    console.log(`wrote ${RECORDS.length} records to ${outFile}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
