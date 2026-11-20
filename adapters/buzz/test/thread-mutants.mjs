// The one-shot thread read's mutation check: runs its tests against broken
// copies of src/thread.mjs, one break each. Every copy must fail the suite; a
// break whose text is no longer in the code (not applied) fails this check
// too, so the list stays in step with the code. It covers what the auto-mode
// guard leans on when it acts on its owner's answer: the signature, the
// author, the thread, the channel, and that a root is never a reply. (The
// guard's own check of the author has its mutant in
// install/test/automode-guard.test.sh.)
//
// The adapter is copied once into a temporary folder (its node_modules
// too); each break is written into that copy and taken out again, so the
// working tree is never changed.
//
// Run: node test/thread-mutants.mjs   (about a minute; not part of npm test)
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER, tempDir } from "./helpers.mjs";

const THREAD = "src/thread.mjs";
const SUITE = "test/thread.test.mjs";

// [name, file, suite, [[exact text, replacement], ...]]
const MUTANTS = [
  ["the signature is never checked", THREAD, SUITE, [["    return verifyEvent(event);\n", "    return true;\n"]]],
  ["--author is never checked here", THREAD, SUITE, [["  if (author !== undefined && event.pubkey !== author) return false;\n", ""]]],
  ["--author is never sent to the relay", THREAD, SUITE, [["  if (author !== undefined) filter.authors = [author];\n", ""]]],
  ["a reply in any thread counts", THREAD, SUITE, [["  if (!root || !roots.includes(root)) return false;\n", "  if (!root) return false;\n"]]],
  ["any channel counts", THREAD, SUITE, [["  if (hs.size !== 1 || !hs.has(channel)) return false;\n", ""]]],
  ["two channels count", THREAD, SUITE, [["  if (hs.size !== 1 || !hs.has(channel)) return false;\n", "  if (!hs.has(channel)) return false;\n"]]],
  ["--since is never checked", THREAD, SUITE, [["  if (since !== undefined && at < since) return false;\n", ""], ["  if (since !== undefined) filter.since = since;\n", ""]]],
  ["any kind counts", THREAD, SUITE, [["event.kind !== KIND_MESSAGE) return false;", "false) return false;"]]],
  ["the content is never cut", THREAD, SUITE, [["          content: e.content.slice(0, MAX_CONTENT),\n", "          content: e.content,\n"]]],
];

const COPY = tempDir("thread-mutants");
for (const part of ["src", "test", "package.json", "package-lock.json", "buzz-mcp.pin", "node_modules"]) {
  cpSync(join(ADAPTER, part), join(COPY, part), { recursive: true, verbatimSymlinks: true });
}

const count = (s, sub) => s.split(sub).length - 1;
let killed = 0;
const rows = [];
try {
  for (const [name, file, suite, pairs] of MUTANTS) {
    const path = join(COPY, file);
    const original = readFileSync(path, "utf8");
    const counts = pairs.map(([old]) => count(original, old));
    if (counts.some((n) => n !== 1)) {
      rows.push([name, `NOT APPLIED (${counts.join(",")} matches)`]);
      continue;
    }
    let text = original;
    for (const [old, now] of pairs) text = text.replace(old, () => now);
    writeFileSync(path, text);
    const r = spawnSync(process.execPath, ["--test", join(COPY, suite)], {
      cwd: COPY,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
      timeout: 600_000,
    });
    writeFileSync(path, original);
    const fails = (r.stdout.match(/^# fail (\d+)/m) || [])[1];
    if (r.status !== 0) {
      killed += 1;
      rows.push([name, `killed (${fails ?? "?"} failing)`]);
    } else {
      rows.push([name, "SURVIVED"]);
    }
  }
} finally {
  rmSync(COPY, { recursive: true, force: true });
}
for (const [name, res] of rows) console.log(`  ${name.padEnd(56)} ${res}`);
console.log(`mutants: ${killed}/${MUTANTS.length} killed`);
process.exit(killed === MUTANTS.length ? 0 : 1);
