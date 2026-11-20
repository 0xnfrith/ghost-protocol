// The load-proof hook's mutation check: runs its unit test
// (install/test/hook-load-proof.test.sh) and, for the breaks marked "e2e", its
// end-to-end test (load-proof.test.mjs, against the fake relay) against broken
// copies of the hook, one break each. Every copy must fail every suite it is
// run against; a break whose text is no longer in the hook (not applied) fails
// this check too, so the list stays in step with the code.
//
// Run: node test/load-proof-mutants.mjs [name filter]   (a few minutes; not part of npm test)
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { ADAPTER } from "./helpers.mjs";

const REPO = join(ADAPTER, "..", "..");
const UNIT = join(REPO, "install", "test", "hook-load-proof.test.sh");
const E2E = join(ADAPTER, "test", "load-proof.test.mjs");
const hookSrc = readFileSync(join(REPO, "hooks", "load-proof"), "utf8");
const libSrc = readFileSync(join(REPO, "hooks", "lib", "own-claude.sh"), "utf8");

// The breaks are texts of the hook, in String.raw. The exec( in one of them is perl's, in the hook's own source; nothing here runs a shell:
// every process is started with spawn or spawnSync and an argument array.
const R = String.raw;
// [name, [[exact text, replacement, "all"?], ...], suites, "lib"?]. suites: ["unit"] (the default) or ["unit", "e2e"]: both must fail.
const BOTH = ["unit", "e2e"];
const MUTANTS = [
  ["any source is a start", [[R`case "$source" in startup | resume | clear) ;; *) exit 0 ;; esac`, "true"]]],
  ["a compaction is a start", [["startup | resume | clear) ;;", "startup | resume | clear | compact) ;;"]]],
  ["a resume is not a start", [["startup | resume | clear) ;;", "startup | clear) ;;"]]],
  ["subagents too", [[R`[ -z "$agent" ] || exit 0`, "true"]]],
  ["any session id", [[R`[[ $sid =~ $re ]] || exit 0`, "true"]]],
  ["any instance name", [[R`case "$name" in '' | -* | *[!a-z0-9-]*) exit 0 ;; esac`, R`case "$name" in '') exit 0 ;; esac`]]],
  ["the state folder is made", [[R`[ -d "$state" ] || exit 0`, R`mkdir -p "$state"`]]],
  ["any claude (no pane check)", [[R`own_claude "$state" || exit 0`, "true"]], BOTH],
  ["the earlier proof is kept", [['rm -f "$proof"\nhook_on_explicit load_proof || exit 0', "hook_on_explicit load_proof || exit 0"]]],
  ["the switch is ignored", [["hook_on_explicit load_proof || exit 0", "true"]]],
  ["the switch is read before the earlier proof is removed", [['rm -f "$proof"\nhook_on_explicit load_proof || exit 0', 'hook_on_explicit load_proof || exit 0\nrm -f "$proof"']]],
  ["a folder named proof.json is moved into", [[R`[ ! -d "$proof" ] || exit 0`, "true"]]],
  ["mode 0644", [['chmod 600 "$tmp"', 'chmod 644 "$tmp"']]],
  ["not replaced in one step", [['mv -f "$tmp" "$proof"', 'cp "$tmp" "$proof"']]],
  ["the sha256 of the first bytes only", [['R_SHA=$(sha256_of "$copy")', 'R_SHA=$(head -c 10 "$copy" >"$work/h"; sha256_of "$work/h")']]],
  ["a first line of 121 characters", [["--argjson n 120", "--argjson n 121"]]],
  ["the first line is not cut", [[" | .[0:$n]'", "'"]]],
  ["the cut counts bytes", [['jq -Rrs --argjson n 120 "$FIRST_LINE" 2>/dev/null)', 'jq -Rrs --argjson n 9999 "$FIRST_LINE" 2>/dev/null | cut -b 1-120)']]],
  ["control characters kept", [[R`\\p{Cc}\\p{Cf}`, R`\\p{Cf}`]], BOTH],
  ["format characters (direction, zero-width) kept", [[R`\\p{Cf}\\p{Zl}`, R`\\p{Zl}`]], BOTH],
  ["line and paragraph separators kept", [[R`\\p{Zl}\\p{Zp}`, ""]]],
  ["backticks kept", [[R`\\p{Zp}` + "`]", R`\\p{Zp}]`]], BOTH],
  ["double quotes kept", [[R` | gsub("\""; ([39] | implode))`, ""]], BOTH],
  ["tabs deleted, not turned into spaces", [[R` | gsub("\t"; " ")`, ""]]],
  ["the whole file's text, not its first line", [[R`split("\n")[0] // ""`, R`gsub("\n"; " ")`]]],
  ["another instance's manifest accepted", [[' && [ "$HOOK_NAME" = "$name" ]', ""]]],
  ["a FIFO or a folder is read", [[R`if [ ! -f "$1" ]; then R_WHY=not-a-file; return 1; fi`, ""]]],
  ["several imports: the first is taken", [['elif [ "$n" -gt 1 ]; then A_WHY=several-imports', 'elif [ "$n" -gt 9 ]; then A_WHY=several-imports']]],
  [
    "no import: the home's AGENTS.md is guessed",
    [['if [ "$n" -eq 0 ]; then A_WHY=no-import', 'if [ "$n" -eq 0 ]; then A_PATH="$home/AGENTS.md"; if file_record "$A_PATH"; then A_ST=ok; A_SHA="$R_SHA"; A_FIRST="$R_FIRST"; A_WHY=""; else A_WHY=no-import; fi']],
  ],
  ["code fences are not honoured", [["line ~ /^(```|~~~)/ { fence = !fence; next }", "line ~ /^(```|~~~)/ { next }"]]],
  [
    "an @ path anywhere in a line is an import",
    [[R`line ~ /^@[^ \t]/ { t = line; gsub(/\\ /, "", t); if (t !~ /[ \t]/) print substr(line, 2) }`, R`line ~ /@[^ \t]/ { print substr(line, index(line, "@") + 1) }`]],
  ],
  ["a relative import is read from the working folder", [['*) p="$(dirname "$rules")/$p" ;;', '*) p="$PWD/$p" ;;']]],
  ["@~user/ is read as a relative path", [[R`\~*) A_WHY=unsupported-path ;;`, R`\~*) ;;`]]],
  ["a carriage return stays in the rulebook's lines", [[R`sub(/\r$/, "", line); `, ""]]],
  ["an escaped space stays escaped", [['p="${imports//\\\\ / }"', 'p="$imports"']]],
  ["CLAUDE_CONFIG_DIR ignored", [['rules="${CLAUDE_CONFIG_DIR:-$home/.claude}/rules/team-repo.md"', 'rules="$home/.claude/rules/team-repo.md"']]],
  ["the installed list is ignored", [['if [ -f "$installed" ]; then', "if false; then"]]],
  ["any commit text is a commit", [["if ! [[ $P_COMMIT =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]]; then\n    P_COMMIT=\"\"", 'if false; then\n    P_COMMIT=""']]],
  ["every entry of the installed list is this plugin's", [["select(.installPath == $a or .installPath == $b)", "select(true)"]]],
  ["the owner and repo are not checked for odd characters", [["*/ | /* | *[!A-Za-z0-9._/-]*) printf 'unknown' ;;", "*/ | /*) printf 'unknown' ;;"]]],
  ["the claude pid is not recorded", [['claude_pid: ($cpid | if . == "" then null else tonumber end), ', "claude_pid: null, "]], BOTH],
  ["another pid is recorded", [['--arg cpid "$claude_pid"', '--arg cpid "1"']]],
  ["any enclosing repo is the plugin's checkout", [[R`[ "$(phys "$top")" = "$GP_DIR" ]`, "true"]]],
  ["a key service is ignored", [['if [ -n "$sock" ]; then SEND_ERR=key-service; return 1; fi', ""]], BOTH],
  ["no relay URL is enough", [['if [ -z "$relay" ] || [ -z "$keycmd" ]; then', 'if [ -z "$relay" ] && [ -z "$keycmd" ]; then']]],
  ["the session's private key is passed on", [["unset BUZZ_KEY_SOCKET BUZZ_PRIVATE_KEY", "unset BUZZ_KEY_SOCKET", "all"]]],
  ["the session's key socket is passed on", [["unset BUZZ_KEY_SOCKET BUZZ_PRIVATE_KEY", "unset BUZZ_PRIVATE_KEY", "all"]]],
  ["the send is not bounded (timeout)", [['"$2" timeout "$secs"', '"$2" env']]],
  ["the send is not bounded (perl)", [[R`"$2" perl -e 'alarm(shift); exec(@ARGV) || exit(127)' "$secs"`, '"$2" env']]],
  ["the send has no time limit of its own", [['BUZZ_SEND_TIMEOUT_MS="$ms"', "BUZZ_SEND_TIMEOUT_MS=", "all"]]],
  ["the relay URL is not given to the send", [['export BUZZ_RELAY_URL="$relay" ', "export ", "all"]]],
  ["the key command is not given to the send", [[' BUZZ_KEY_COMMAND="$keycmd"', "", "all"]]],
  ["the launcher runs without its dependencies", [[R`if [ ! -f "$adapter/node_modules/nostr-tools/package.json" ] || [ ! -f "$adapter/node_modules/@modelcontextprotocol/sdk/package.json" ]; then`, "if false; then"]]],
  ["only one dependency checked", [[R` || [ ! -f "$adapter/node_modules/@modelcontextprotocol/sdk/package.json" ]`, ""]]],
  ["exit 3 read as the relay", [["3) SEND_ERR=refused ;;", "3) SEND_ERR=relay ;;"]]],
  ["exit 1 read as a failed send", [["1) SEND_ERR=relay ;;", "1) SEND_ERR=send-failed ;;"]]],
  ["exit 2 read as the relay", [["2) SEND_ERR=config ;;", "2) SEND_ERR=relay ;;"]]],
  ["the alarm's exit is not a timeout", [["124 | 137 | 142) SEND_ERR=timeout ;;", "124 | 137) SEND_ERR=timeout ;;"]]],
  ["no event id still counts as sent", [[R`0) if grep -Eq '^sent [0-9a-f]{64}$' "$work/out"; then return 0; fi; SEND_ERR=no-event-id ;;`, "0) return 0 ;;"]]],
  ["a failed post is recorded as posted", [['write_proof false "$SEND_ERR"', 'write_proof true ""']], BOTH],
  ["a post that went through is recorded as not posted", [['write_proof true ""\n    exit 0', 'write_proof false ""\n    exit 0']]],
  ["a failure prints nothing", [["printf 'load proof written; not posted: %s\\n' \"$why\"", ":"]]],
  ["a success prints a line", [['write_proof true ""\n    exit 0', 'write_proof true ""\n    echo posted\n    exit 0']]],
  ["any channel text", [["if ! [[ $channel =~ ^[A-Za-z0-9-]{1,64}$ ]]; then", "if false; then"]]],
  ["an empty channel posts", [['if [ -z "$channel" ]; then', "if false; then"]]],
  ["the file is not written before the send", [["write_proof false pending || exit 0", "true"]]],
  ["the whole session id in the line", [["${sid:0:8}", "${sid}"]]],
  ["the whole sha256 in the line", [['"${5:0:12}"', '"${5}"', "all"]]],
  ["a path in the line", [['line="load-proof $name session ', 'line="load-proof $name session ${C_PATH} ']]],
  ["no reason in a none", [["printf '%s none (%s)' \"$1\" \"$3\"", "printf '%s none' \"$1\""]]],
  ["no repo in the line", [['if [ -n "$4" ]; then printf', 'if false; then printf']]],
  ["lib: the first ancestor is the pane", [['        [ "$p" = "$pane" ] && return 0', "        return 0"]], ["unit"], "lib"],
  ["lib: a nearer claude passed over", [['            return 1\n        fi\n        p="$(own_proc_ppid "$p")"', '            :\n        fi\n        p="$(own_proc_ppid "$p")"']], ["unit"], "lib"],
  ["lib: the pane's own name not a claude", [[' || { [ -n "$pane_name" ] && [ "$name" = "$pane_name" ]; }', ""]], ["unit"], "lib"],
  ["lib: a symlinked pane-pid followed", [[R` && [ ! -L "$1/pane-pid" ]`, ""]], ["unit"], "lib"],
];

const filter = process.argv[2];
const work = mkdtempSync(join(tmpdir(), "load-proof-mutants-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

/** A copy of the plugin for the unit test (its adapter a marker) and one for the e2e test (the real adapter, linked). */
function copies(name, id) {
  const unit = join(work, `${id}-unit`);
  const made = spawnSync("bash", [UNIT, "--make-plugin", unit], { encoding: "utf8" });
  if (made.status !== 0) throw new Error(`could not make the plugin copy: ${made.stderr}`);
  const e2e = join(work, `${id}-e2e`);
  mkdirSync(e2e);
  for (const d of ["adapters", "install", ".claude-plugin"]) symlinkSync(join(REPO, d), join(e2e, d));
  cpSync(join(REPO, "hooks"), join(e2e, "hooks"), { recursive: true });
  return { unit, e2e };
}

function apply(dirs, edits, lib) {
  for (const dir of [dirs.unit, dirs.e2e]) {
    const file = join(dir, "hooks", lib ? join("lib", "own-claude.sh") : "load-proof");
    let text = lib ? libSrc : hookSrc;
    for (const [from, to, all] of edits) {
      if (!text.includes(from)) return `not applied: ${JSON.stringify(from.slice(0, 70))}`;
      text = all ? text.split(from).join(to) : text.replace(from, () => to);
    }
    if (text === (lib ? libSrc : hookSrc)) return "not applied: the break changed nothing";
    writeFileSync(file, text);
  }
  return null;
}

function run(cmd, args, env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, out });
    });
  });
}

const suites = {
  unit: (dirs, id) =>
    run("bash", [UNIT], {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: join(work, `${id}-home`),
      TMPDIR: join(work, `${id}-tmp`),
      LANG: "C",
      LC_ALL: "C",
      LOAD_PROOF_HOOK: join(dirs.unit, "hooks", "load-proof"),
    }),
  e2e: (dirs) => run(process.execPath, ["--test", E2E], { ...process.env, LOAD_PROOF_PLUGIN: dirs.e2e }),
};

async function one([name, edits, wanted = ["unit"], lib], index) {
  const id = `m${index}`;
  for (const d of ["home", "tmp"]) mkdirSync(join(work, `${id}-${d}`), { recursive: true });
  const dirs = copies(name, id);
  const problem = edits === null ? null : apply(dirs, edits, lib === "lib");
  if (problem) return { name, ok: false, why: problem };
  const results = [];
  for (const suite of wanted) {
    const r = await suites[suite](dirs, id);
    const fails = suite === "unit" ? (r.out.match(/^FAIL/gm) ?? []).length : (r.out.match(/^ℹ fail [1-9]/gm) ?? []).length;
    results.push({ suite, killed: r.status !== 0 || fails > 0, fails });
  }
  const survived = results.filter((r) => !r.killed);
  return { name, ok: survived.length === 0, why: survived.length ? `survived the ${survived.map((r) => r.suite).join(" and ")} suite` : results.map((r) => `${r.suite}: ${r.fails || "ran with errors"}`).join(", ") };
}

// The unbroken copy passes both suites first: a check that fails already proves nothing about a break.
{
  const dirs = copies("base", "base");
  for (const d of ["home", "tmp"]) mkdirSync(join(work, `base-${d}`), { recursive: true });
  for (const suite of ["unit", "e2e"]) {
    const r = await suites[suite](dirs, "base");
    if (r.status !== 0) {
      console.error(`the unbroken hook fails the ${suite} suite:\n${r.out.split("\n").slice(-30).join("\n")}`);
      process.exit(2);
    }
  }
  console.log("the unbroken hook passes both suites");
}

const list = MUTANTS.map((m, i) => [m, i]).filter(([m]) => !filter || m[0].includes(filter));
const workers = Math.max(1, Math.min(4, cpus().length));
const results = [];
let next = 0;
await Promise.all(
  Array.from({ length: workers }, async () => {
    while (next < list.length) {
      const [m, i] = list[next++];
      const r = await one(m, i);
      results.push(r);
      console.log(`${r.ok ? "killed" : "NOT KILLED"}: ${r.name} (${r.why})`);
    }
  }),
);
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length} breaks, ${results.length - bad.length} killed, ${bad.length} not`);
process.exit(bad.length ? 1 : 0);
