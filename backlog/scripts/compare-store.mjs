#!/usr/bin/env node
/**
 * scripts/compare-store.mjs: runs an OLD validator and this folder's validator over every record of a real store,
 * and reports where they disagree. It is how a store that was validated by another tool is shown to validate the
 * same here, with its own settings and profile.
 *
 *   compare-store [settings flags] --store <repository root> --old <validator> [--old-via <interpreter>] [--strict]
 *
 *   settings flags   --prefix, --dir, --operator-names, --profile: the settings for the NEW validator (./config.mjs)
 *   --store          the folder that holds the data folder (<store>/<dir>/items, arcs, initiatives, sessions)
 *   --old            the old validator, an executable that takes one record path (its exit codes: 0 clean, 2 block,
 *                    anything else a warning). Run directly, so its shebang decides what runs it.
 *   --old-via        an interpreter to run it with instead, as `<interpreter> <validator> <record>` (for example bun)
 *   --strict         a text-only difference also fails the run
 *
 * Two kinds of difference:
 *   VERDICT  a fail. The exit codes differ, or the number of error lines or of warning lines differs: the record
 *            would block, warn or pass differently.
 *   TEXT     listed, not a fail (unless --strict). The same exit code and the same counts, but other words: a
 *            message names the old tool's tracker or scripts, a list is in another order, and the like.
 * The old validator is a black box: this cannot see which rule one of its lines came from, so it compares the
 * exit code and the two counts, and prints the changed lines for a person to read.
 *
 * Exit codes: 0 no verdict difference (and no text difference under --strict), 1 differences, 2 the run itself failed.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setup } from "../schema/setup.mjs";
import { validateFile } from "../schema/validate.mjs";

const RECORD_FOLDERS = ["items", "arcs", "initiatives", "sessions"];

/** What a validator's output says: the exit code, and how many error and warning lines. */
export function verdictOf(code, text) {
  const lines = text.split("\n");
  const block = lines[0]?.startsWith("✗");
  let errors = 0;
  let warnings = 0;
  for (const line of lines) {
    const m = /^ {2}- (\(warning\) )?/.exec(line);
    if (!m) continue;
    if (block && !m[1]) errors++;
    else warnings++;
  }
  return { code, errors, warnings };
}

const sameVerdict = (a, b) => a.code === b.code && a.errors === b.errors && a.warnings === b.warnings;
const describe = (v) => `exit ${v.code} (${v.errors} error${v.errors === 1 ? "" : "s"}, ${v.warnings} warning${v.warnings === 1 ? "" : "s"})`;

/** The record files of a store, sorted, relative paths. */
export function recordFiles(store, dirSegments) {
  const files = [];
  for (const folder of RECORD_FOLDERS) {
    const dir = join(store, ...dirSegments, folder);
    let names;
    try {
      names = readdirSync(dir).sort();
    } catch {
      continue;
    }
    for (const n of names) if (n.endsWith(".md")) files.push(join(dir, n));
  }
  return files;
}

/** Returns the exit code. Writes the report to `out` (default stdout) and problems to `err` (default stderr). */
export function main(argv, env = process.env, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s)) {
  const rest = [];
  let store = null;
  let old = null;
  let via = null;
  let strict = false;
  const settingsFlags = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--store") store = argv[++i];
    else if (a === "--old") old = argv[++i];
    else if (a === "--old-via") via = argv[++i];
    else if (a === "--strict") strict = true;
    else if (["--prefix", "--dir", "--operator-names", "--profile"].includes(a)) settingsFlags.push(a, argv[++i]);
    else rest.push(a);
  }
  if (!store || !old || rest.length) {
    err("usage: compare-store [--prefix P] [--dir D] [--operator-names N] [--profile FILE] --store <repository root> --old <validator> [--old-via <interpreter>] [--strict]\n");
    return 2;
  }
  const { config, problems, profileProblem, rules } = setup(settingsFlags, env);
  for (const p of problems) err(`${p}\n`);
  if (profileProblem) {
    err(`${profileProblem}\n`);
    return 2;
  }
  const root = resolve(store);
  const files = recordFiles(root, config.dirSegments);
  if (files.length === 0) {
    err(`no records found under ${join(root, config.dir)} (items, arcs, initiatives, sessions)\n`);
    return 2;
  }

  let verdictDiffs = 0;
  let textDiffs = 0;
  for (const file of files) {
    const shown = relative(root, file);
    const command = via ?? old;
    const run = spawnSync(command, via ? [old, file] : [file], { encoding: "utf8", timeout: 30000 });
    if (run.error || run.signal) {
      err(`the old validator could not be run on ${shown}: ${run.error ? run.error.message : `ended by ${run.signal}`}\n`);
      return 2;
    }
    const oldText = run.stderr ?? "";
    const neu = validateFile(file, { rules, config, problems: [], profileProblem: null });
    const newText = neu.lines.map((l) => `${l}\n`).join("");
    const a = verdictOf(run.status, oldText);
    const b = verdictOf(neu.code, newText);
    if (!sameVerdict(a, b)) {
      verdictDiffs++;
      out(`VERDICT ${shown}: old ${describe(a)}, new ${describe(b)}\n`);
      for (const l of oldText.split("\n").filter(Boolean)) out(`  old| ${l}\n`);
      for (const l of newText.split("\n").filter(Boolean)) out(`  new| ${l}\n`);
    } else if (oldText !== newText) {
      textDiffs++;
      out(`TEXT ${shown}: both ${describe(a)}; the words differ\n`);
      const oldLines = oldText.split("\n").filter(Boolean);
      const newLines = newText.split("\n").filter(Boolean);
      for (const l of oldLines) if (!newLines.includes(l)) out(`  old| ${l}\n`);
      for (const l of newLines) if (!oldLines.includes(l)) out(`  new| ${l}\n`);
    }
  }
  out(`compared ${files.length} records: ${verdictDiffs} verdict difference${verdictDiffs === 1 ? "" : "s"}, ${textDiffs} text-only difference${textDiffs === 1 ? "" : "s"}${strict ? " (strict: both fail)" : ""}\n`);
  return verdictDiffs > 0 || (strict && textDiffs > 0) ? 1 : 0;
}

// Run as a command (not when a test imports it).
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
