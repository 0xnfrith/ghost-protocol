// rollout-check's mutation check: runs the suite (test/*.test.mjs) against broken copies of lib.mjs, one break each. Every copy
// must fail the suite; a break whose text is no longer in the code (not applied) fails this check too, so the list stays in step
// with the code. Each break undoes one guard:
//   - the config check (every key and pattern, the duplicates, the quoting that keeps a value from a shell);
//   - what the VM's script reads (the files, the session id as the hook reads it, the proof's cap) and how its output is parsed;
//   - the judgement (behind on disk, the proof's session, schema and shas, the team repo that is not there);
//   - the pid rule (pane-pid read on the VM and in the output, claude_pid in the proof, the three ways a proof fails it);
//   - what a file that cannot be read says (unknown, never behind or current);
//   - what is printed (the change, the daily reminder, the lost state file, the order of the line);
//   - the state file (one step, private, since), --json (no state, no line), the sha commands (once each, strict, before ssh),
//     and the process runner (time limit, size cap, the whole group stopped);
//   - the second version: the optional config keys (role, lead, root, plugin_dir, class_apply), the turn marker the script reads and
//     the parser holds to its form, the roles that restart themselves at Done and the 3 quiet days, the state file of version 2 that
//     carries actions and drain, --plan, and the plan itself (plan.mjs: every rule of README.md, "What it would do").
// A break names its module when it is not lib.mjs. `--check` only looks that every break's text is still in its file.
// The hooks the session tests run are the real ones: the copy is laid out as in the repo, with links to hooks/ and install/.
//
// Run: node tools/rollout-check/test/rollout-check-mutants.mjs [part of a name | --check]   (about half an hour; not part of npm test). Run it with hooks/load-proof in the tree
// (ROLLOUT_CHECK_PLUGIN=<a plugin folder with it> until it is): the break of a hook rule is killed by the tests that run the hook.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(TOOL, "..", "..");
const SRC = "lib.mjs";

// [name, [[exact text, replacement], ...], file]: `file` is the module the edits are made in, lib.mjs when it is left out.
const MUTANTS = [
  // The config.
  ["an unknown key is allowed", [["    for (const key of Object.keys(entry)) if (!KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)) throw at(`unknown key ${shown(key)}`);\n", ""]]],
  ["a missing key is allowed", [['    for (const key of KEYS) if (!Object.hasOwn(entry, key)) throw at(`missing key "${key}"`);\n', ""]]],
  ["the config need not be an array", [['  if (!Array.isArray(config)) throw new Failure("config: must be a JSON array with one entry per agent");\n', ""]]],
  ["an empty config is allowed", [['  if (config.length === 0) throw new Failure("config: no agents");\n', ""]]],
  ["an entry need not be an object", [["    if (entry === null || typeof entry !== \"object\" || Array.isArray(entry)) throw at(\"must be an object\");\n", ""]]],
  ["a name can be anything", [["const RE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;", "const RE_NAME = /^.+$/s;"]]],
  ["a name can start with -", [["const RE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;", "const RE_NAME = /^[a-z0-9-][a-z0-9-]{0,62}$/;"]]],
  ["an ssh alias can start with -", [["const RE_SSH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;", "const RE_SSH = /^[A-Za-z0-9._-][A-Za-z0-9._-]{0,127}$/;"]]],
  ["an ssh alias can be anything", [["const RE_SSH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;", "const RE_SSH = /^.+$/s;"]]],
  ["a class can be anything", [["const RE_CLASS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;", "const RE_CLASS = /^.+$/s;"]]],
  ["a team repo can be anything", [["const RE_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;", "const RE_REPO = /^.+$/s;"]]],
  ["a path can be anything", [["const RE_PATH = /^\\/[A-Za-z0-9._-]+(\\/[A-Za-z0-9._-]+)*$/;", "const RE_PATH = /^\\/.*$/s;"]]],
  ["a path can have spaces", [["const RE_PATH = /^\\/[A-Za-z0-9._-]+(\\/[A-Za-z0-9._-]+)*$/;", "const RE_PATH = /^\\/[A-Za-z0-9._ -]+(\\/[A-Za-z0-9._ -]+)*$/;"]]],
  ["a path can be relative", [["const RE_PATH = /^\\/[A-Za-z0-9._-]+(\\/[A-Za-z0-9._-]+)*$/;", "const RE_PATH = /^\\/?[A-Za-z0-9._-]+(\\/[A-Za-z0-9._-]+)*$/;"]]],
  ["a path can have a .. segment", [['  if (v.split("/").some((s) => s === "." || s === "..")) return "must not hold a . or .. segment";\n', ""]]],
  ["a path can be 1000 characters", [["  if (v.length > 255 || !RE_PATH.test(v))", "  if (!RE_PATH.test(v))"]]],
  ["home is not checked", [['    for (const key of ["home", "state_dir"]) {', '    for (const key of ["state_dir"]) {']]],
  ["state_dir is not checked", [['    for (const key of ["home", "state_dir"]) {', '    for (const key of ["home"]) {']]],
  ["a clone is not checked with a team repo", [["      const why = pathProblem(entry.clone);\n      if (why) throw at(`\"clone\" ${why}, not ${shown(entry.clone)}`);\n    }\n    const role", "    }\n    const role"]]],
  ["a clone is not checked without a team repo", [["      const why = entry.clone === null ? null : pathProblem(entry.clone);", "      const why = null;"]]],
  ["two agents can share a name", [["    if (names.has(entry.name)) throw at(`the name ${shown(entry.name)} is used by another agent`);\n", ""]]],
  ["two agents can share an ssh alias", [["    if (aliases.has(alias)) throw at(`the ssh alias ${shown(entry.ssh)} is used by another agent`);\n", ""]]],
  ["ssh aliases that differ in case are different", [["    const alias = entry.ssh.toLowerCase();", "    const alias = entry.ssh;"]]],
  ["a value is shown as it is, control characters and all", [["  const s = JSON.stringify(v) ?? String(v);", "  const s = String(v);"]]],
  ["a long value is shown whole", [["  return s.length > 80 ? `${s.slice(0, 77)}...` : s;", "  return s;"]]],
  ["an empty command is allowed", [["  if (words.length === 0) throw new Failure(`${what}: empty command`);\n", ""]]],
  // What reaches the shell.
  ["a quote in a value is not escaped", [["  return `'${String(value).replace(/'/g, \"'\\\\''\")}'`;", "  return `'${String(value)}'`;"]]],
  ["the home folder is not quoted", [["shellQuote(agent.home), ", "agent.home, "]]],
  ["the state folder is not quoted", [["shellQuote(agent.state_dir)]", "agent.state_dir]"]]],
  ["a clone is given when there is no team repo", [['  const clone = agent.team_repo === null ? "" : agent.clone;', "  const clone = agent.clone ?? \"\";"]]],
  ["the script is not sent on stdin", [["{ input: REMOTE_SCRIPT, timeoutMs, maxBytes: MAX_REMOTE_BYTES }", "{ input: \"\", timeoutMs, maxBytes: MAX_REMOTE_BYTES }"]]],
  // What the VM's script reads.
  ["the class file is CLAUDE.txt", [['file_sha "$1/CLAUDE.md"', 'file_sha "$1/CLAUDE.txt"']]],
  ["the agents file is AGENTS.txt", [['file_sha "$2/AGENTS.md"', 'file_sha "$2/AGENTS.txt"']]],
  ["the agents file is read with no team repo", [["if [ -n \"$2\" ]; then printf 'agents %s\\\\n' \"$(file_sha \"$2/AGENTS.md\")\"; else printf 'agents skipped\\\\n'; fi", "printf 'agents %s\\\\n' \"$(file_sha \"$2/AGENTS.md\")\""]]],
  ["a folder is hashed as a file", [["  elif [ ! -f \"$1\" ]; then printf 'not-a-file'\n", ""]]],
  ["the session id is read from another file", [['f="$3/session-id"', 'f="$3/session"']]],
  ["a session-id that is a link is read", [["if [ -f \"$f\" ] && [ ! -L \"$f\" ]; then\n  s=$(", "if [ -f \"$f\" ]; then\n  s=$("]]],
  ["only new lines are removed from the session id", [["tr -d '[:space:]' <\"$f\"", "tr -d '\\\\n' <\"$f\""]]],
  ["a session id is read from the first line only", [["{ tr -d '[:space:]' <\"$f\" | head -c 128; }", "{ head -n 1 <\"$f\" | tr -d '[:space:]'; }"]]],
  ["the proof is read from another file", [['f="$3/proof.json"', 'f="$3/proof.txt"']]],
  ["a proof that is a link is read", [['elif [ ! -f "$f" ] || [ -L "$f" ]; then printf \'proof not-a-file\\\\n\'', 'elif [ ! -f "$f" ]; then printf \'proof not-a-file\\\\n\'']]],
  ["the proof is read whole, however big", [["-N ${MAX_PROOF_BYTES + 1}", "-N 99999999"]]],
  ["the proof is cut at 10 bytes", [["-N ${MAX_PROOF_BYTES + 1}", "-N 10"]]],
  ["a hash that is not 64 characters is taken", [['    *) if [ "\\${#d}" -eq 64 ]; then printf \'%s\' "$d"; else printf \'unreadable\'; fi ;;', "    *) printf '%s' \"$d\" ;;"]]],
  // How the output is read.
  ["the output need not begin with the marker", [['  if (lines[0] !== "rollout-check v2" || lines[9] !== "end") return null;\n', ""]]],
  ["the output need not end with end", [['lines[0] !== "rollout-check v2" || lines[9] !== "end"', 'lines[0] !== "rollout-check v2"']]],
  ["the output may have more lines", [["  if (lines.length !== 11 || lines[10] !== \"\") return null;\n", ""]]],
  ["the output may have fewer lines", [["lines.length !== 11 || lines[10] !== \"\"", "lines.length < 10"]]],
  ["a session token may be anything", [["/^[0-9a-f-]{1,128}$/.test(session)", "/^.*$/.test(session)"]]],
  ["a session token that is not an id is garbage", [["sessionId: SESSION_ID_RE.test(session) ? session : null,", "sessionId: session,"]]],
  ["odd hex is taken", [["!/^([0-9a-f]{2})*$/.test(hex)", "false"]]],
  ["a sha in capitals is taken", [["const SHA_RE = /^[0-9a-f]{64}$/;", "const SHA_RE = /^[0-9a-fA-F]{64}$/;"]]],
  ["a short sha is taken", [["const SHA_RE = /^[0-9a-f]{64}$/;", "const SHA_RE = /^[0-9a-f]{40,64}$/;"]]],
  ["the session id form is wider than the hook's", [["export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;", "export const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;"]]],
  // Judging.
  ["the class file's difference is not seen", [['  if (remote.classDisk !== expected.class && !INCONCLUSIVE.has(remote.classDisk)) behind.push("class");\n', ""]]],
  ["the agents file's difference is not seen", [['  if (agent.team_repo !== null && remote.agentsDisk !== expected.agents && !INCONCLUSIVE.has(remote.agentsDisk)) behind.push("agents");\n', ""]]],
  ["the agents file counts with no team repo", [['  if (agent.team_repo !== null && remote.agentsDisk !== expected.agents && !INCONCLUSIVE', '  if (remote.agentsDisk !== expected.agents && !INCONCLUSIVE']]],
  ["a class file that cannot be read is behind", [["remote.classDisk !== expected.class && !INCONCLUSIVE.has(remote.classDisk)", "remote.classDisk !== expected.class"]]],
  ["an agents file that cannot be read is behind", [["remote.agentsDisk !== expected.agents && !INCONCLUSIVE.has(remote.agentsDisk)", "remote.agentsDisk !== expected.agents"]]],
  ["a class file that cannot be read is current", [['  if (remote.classDisk === "unreadable") return { ...base, state: STATES.UNKNOWN, behind: [], reason: "class file unreadable" };\n', ""]]],
  ["an agents file that cannot be read is current", [['  if (unread[1] === "unreadable") return { ...base, state: STATES.UNKNOWN, behind: [], reason: "agents file unreadable" };\n', ""]]],
  ["a VM with no sha256 tool is current", [['  if (unread.includes("no-sha256")) return { ...base, state: STATES.UNKNOWN, behind: [], reason: "no sha256 tool" };\n', ""]]],
  ["a VM with no sha256 tool is not-proved", [['  if (unread.includes("no-sha256")) return { ...base, state: STATES.UNKNOWN,', '  if (unread.includes("no-sha256")) return { ...base, state: STATES.NOT_PROVED,']]],
  ["the agents file is wanted of an agent with no team repo, to be read", [['const unread = [remote.classDisk, agent.team_repo === null ? null : remote.agentsDisk];', 'const unread = [remote.classDisk, remote.agentsDisk];']]],
  ["a proof beside no pane-pid counts", [['  if (remote.panePid === null) return "no pane-pid beside the proof";\n', ""]]],
  ["a proof with no claude_pid counts", [['  if (summary.claude_pid === null) return "proof has no claude_pid";\n', ""]]],
  ["a proof of another claude process counts", [['  if (summary.claude_pid !== remote.panePid) return "proof is of another claude process";\n', ""]]],
  ["any claude_pid is a pid", [["claude_pid: Number.isSafeInteger(proof.claude_pid) && proof.claude_pid > 1 ? proof.claude_pid : null,", "claude_pid: proof.claude_pid ?? null,"]]],
  ["pid 1 is a claude_pid", [["Number.isSafeInteger(proof.claude_pid) && proof.claude_pid > 1 ?", "Number.isSafeInteger(proof.claude_pid) ?"]]],
  ["a pane pid is any digits", [["const PANE_PID_RE = /^[1-9][0-9]{0,9}$/;", "const PANE_PID_RE = /^[0-9]+$/;"]]],
  ["pid 1 is a pane pid", [["PANE_PID_RE.test(pane) && Number(pane) > 1 ?", "PANE_PID_RE.test(pane) ?"]]],
  ["a pane-pid token may be anything", [['  if (!(/^[0-9]{1,32}$/.test(pane) || pane === "missing" || pane === "invalid")) return null;\n', ""]]],
  // The pane-pid read on the VM.
  ["the pane pid is read from another file", [['f="$3/pane-pid"', 'f="$3/pane"']]],
  ["a pane-pid that is a link is read", [["if [ -f \"$f\" ] && [ ! -L \"$f\" ]; then\n  p=$(", "if [ -f \"$f\" ]; then\n  p=$("]]],
  ["only new lines are removed from the pane pid", [["{ tr -d '[:space:]' <\"$f\" | head -c 32; }", "{ tr -d '\\\\n' <\"$f\" | head -c 32; }"]]],
  ["a pane pid with letters is passed on", [["    '' | *[!0-9]*) printf 'pane-pid invalid\\\\n' ;;", "    '') printf 'pane-pid invalid\\\\n' ;;"]]],
  ["a proof that cannot be read is skipped", [['  if (proof.bytes.length === 0 || proof.bytes.length > MAX_PROOF_BYTES) return { problem: "proof file is unreadable" };\n', ""]]],
  ["a big proof is read", [["proof.bytes.length === 0 || proof.bytes.length > MAX_PROOF_BYTES", "proof.bytes.length === 0"]]],
  ["an array is a proof", [["  if (parsed === null || typeof parsed !== \"object\" || Array.isArray(parsed)) return { problem: \"proof file is unreadable\" };\n", ""]]],
  ["any schema is a proof", [["  if (parsed.schema !== PROOF_SCHEMA) return { problem: \"proof has another schema\" };\n", ""]]],
  ["a proof of an earlier session counts", [['  if (!summary.current_session) return "proof is from another session";\n', ""]]],
  ["a proof counts without a known session", [['  if (remote.sessionId === null) return "no current session id";\n', ""]]],
  ["no session matches no session", [["current_session: sessionId !== null && proof.session_id === sessionId,", "current_session: proof.session_id === sessionId,"]]],
  ["a proof without a class file counts", [['  if (summary.class_status !== "ok") return "proof shows no class file";\n', ""]]],
  ["a proof of another class file counts", [['  if (summary.class_sha !== expected.class) return "proof shows another class file";\n', ""]]],
  ["a proof with no agents file counts", [['    if (summary.agents_status !== "ok") return "proof shows no agents file";\n', ""]]],
  ["a proof of another agents file counts", [['    if (summary.agents_sha !== expected.agents) return "proof shows another agents file";\n', ""]]],
  ["the agents file is wanted of an agent with no team repo", [["  if (agent.team_repo !== null) {\n    if (summary.agents_status", "  if (true) {\n    if (summary.agents_status"]]],
  ["a proof is judged before the disk", [["  const problem = proof.problem ?? proofProblem(agent, expected, remote, summary);\n  // An agent that restarts itself when its task is done is not wrong for not having restarted yet.\n  if (problem) return { ...base, state: restartsAtDone(agent.role) ? STATES.AT_DONE : STATES.NOT_PROVED, behind: [], reason: problem };\n  return { ...base, state: STATES.CURRENT", "  return { ...base, state: STATES.CURRENT"], ["  if (behind.length > 0) return { ...base, state: STATES.BEHIND", "  const problem = proof.problem ?? proofProblem(agent, expected, remote, summary);\n  // An agent that restarts itself when its task is done is not wrong for not having restarted yet.\n  if (problem) return { ...base, state: restartsAtDone(agent.role) ? STATES.AT_DONE : STATES.NOT_PROVED, behind: [], reason: problem };\n  if (behind.length > 0) return { ...base, state: STATES.BEHIND"]]],
  ["a proof is not looked at", [["  const problem = proof.problem ?? proofProblem(agent, expected, remote, summary);", "  const problem = null;"]]],
  ["the table carries free text from the proof", [["    commit: textOf(proof.plugin?.commit, COMMIT_RE),\n", "    commit: textOf(proof.plugin?.commit, COMMIT_RE),\n    first_line: proof.class?.first_line,\n"]]],
  ["a version of any form is shown", [["const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;", "const VERSION_RE = /^.*$/s;"]]],
  ["ssh that exits non-zero is believed", [['  if (res.status !== "ok" || res.code !== 0) return unknownResult("ssh failed");', '  if (res.status !== "ok") return unknownResult("ssh failed");']]],
  ["ssh that timed out is believed", [['  if (res.status === "timeout") return unknownResult("ssh timeout");\n  if (res.status === "too-large") return unknownResult("output too large");\n  if (res.status !== "ok" || res.code !== 0) return unknownResult("ssh failed");', '  if (res.status === "too-large") return unknownResult("output too large");\n  if (res.status !== "ok" || res.code !== 0) return unknownResult("ssh failed");']]],
  ["output that does not parse is judged", [['        else if (seen.remote === null) result = unknownResult("unparseable output");\n', ""]]],
  // What is printed.
  ["the line is printed every run", [["  if (signature.length === 0) return false;\n  if (previous === null || previous.signature === null) return true;\n", "  return signature.length > 0;\n"]]],
  ["the line is printed when everyone is current and the state is lost", [["  if (signature.length === 0) return false;\n", ""]]],
  ["a changed set is not printed when nothing shrank", [["  if (previous.signature.length !== signature.length || previous.signature.some((s, i) => s !== signature[i])) return true;", "  if (previous.signature.some((s, i) => s !== signature[i])) return true;"]]],
  ["a changed set is not printed when it only shrank", [["  if (previous.signature.length !== signature.length || previous.signature.some((s, i) => s !== signature[i])) return true;", "  if (previous.signature.length < signature.length || signature.some((s, i) => s !== previous.signature[i])) return true;"]]],
  ["a set is compared in the config's order", [["    .sort();\n}", "    ;\n}"]]],
  ["no reminder", [["  return nowMs - last >= REMIND_MS - REMIND_SLACK_MS;", "  return false;"]]],
  ["a reminder only after the whole day", [["  return nowMs - last >= REMIND_MS - REMIND_SLACK_MS;", "  return nowMs - last >= REMIND_MS;"]]],
  ["a reminder an hour early", [["  return nowMs - last >= REMIND_MS - REMIND_SLACK_MS;", "  return nowMs - last >= REMIND_MS - 3600000;"]]],
  ["a last line in the future holds the line back", [["  if (last > nowMs) return true;\n", ""]]],
  ["a line never printed is not owed", [["  if (previous.last_printed === null) return true;\n", ""]]],
  ["a reason is part of the set", [['return `${r.name}:${r.state === STATES.UNKNOWN ? "unknown" : "not-proved"}`;', 'return `${r.name}:${r.state === STATES.UNKNOWN ? `unknown ${r.reason}` : "not-proved"}`;']]],
  ["what an agent is behind in is not part of the set", [["return `${r.name}:behind:${r.behind.join(\"+\")}`;", "return `${r.name}:behind`;"]]],
  ["a state file of another schema is read", [["  if (parsed === null || typeof parsed !== \"object\" || (parsed.schema !== STATE_SCHEMA && parsed.schema !== STATE_SCHEMA_V1)) return null;", "  if (parsed === null || typeof parsed !== \"object\") return null;"]]],
  ["a time that is not a time is believed", [["last_printed: validTime(parsed.last_printed) ? parsed.last_printed : null,", "last_printed: parsed.last_printed ?? null,"]]],
  ["a signature that is not a list is believed", [["Array.isArray(parsed.signature) && parsed.signature.every((s) => typeof s === \"string\") ? parsed.signature : null", "parsed.signature ?? null"]]],
  ["the last line's time is kept at every run", [["last_printed: print ? nowIso : previous?.last_printed ?? null,", "last_printed: nowIso,"]]],
  ["the last line's time is lost at a quiet run", [["last_printed: print ? nowIso : previous?.last_printed ?? null,", "last_printed: print ? nowIso : null,"]]],
  ["the line is written after the state", [["    if (print) stdout.write(`${formatLine(rows, nowMs)}\\n`);\n", ""], ["    return 0;\n  } catch (error) {\n    stderr.write(`rollout-check: ${error instanceof Failure ? error.message : `internal error: ${error?.message ?? error}`}\\n`);\n    return 2;\n  }\n}\n\n// ---------------------------------------------------------------------------------------------------------------------------\n// The command line.", "    if (print) stdout.write(`${formatLine(rows, nowMs)}\\n`);\n    return 0;\n  } catch (error) {\n    stderr.write(`rollout-check: ${error instanceof Failure ? error.message : `internal error: ${error?.message ?? error}`}\\n`);\n    return 2;\n  }\n}\n\n// ---------------------------------------------------------------------------------------------------------------------------\n// The command line."]]],
  ["a state file that cannot be written fails the run", [["      stderr.write(`rollout-check: could not write the state file: ${error.code ?? \"error\"}\\n`);", "      throw error;"]]],
  ["a state file is written in place", [["    renameSync(tmp, path);", "    writeFileSync(path, readFileSync(tmp));\n    rmSync(tmp, { force: true });"]]],
  ["a state file is world-readable", [["{ mode: 0o600 }", "{ mode: 0o644 }"]]],
  ["a temporary file is left when the rename fails", [["  } catch (error) {\n    rmSync(tmp, { force: true });\n    throw error;\n  }", "  } catch (error) {\n    throw error;\n  }"]]],
  ["the state folder is not made", [["  mkdirSync(dirname(path), { recursive: true });\n", ""]]],
  ["since is always now", [["      r.since = before && sameCondition(before.state, r.state) ? before.since : nowIso;", "      r.since = nowIso;"]]],
  ["since never moves", [["      r.since = before && sameCondition(before.state, r.state) ? before.since : nowIso;", "      r.since = before ? before.since : nowIso;"]]],
  ["a gone agent stays in the state", [["      agents: Object.fromEntries(\n        rows.map(", "      agents: Object.fromEntries(\n        [...Object.entries(previous?.agents ?? {}).map(([k, v]) => ({ name: k, ...v })), ...rows].map("]]],
  ["--json goes on to print the line and write the state", [["null, 2)}\\n`);\n      return 0;\n    }", "null, 2)}\\n`);\n    }"]]],
  ["--json says everyone is current", [["all_current: rows.every((r) => r.state === STATES.CURRENT),", "all_current: true,"]]],
  ["--json says a run would always print", [["would_print: print, line,", "would_print: true, line,"]]],
  ["--json says a run would never print", [["would_print: print, line,", "would_print: false, line,"]]],
  ["--json gives a line when there is none", [["const line = signature.length > 0 ? formatLine(rows, nowMs) : null;", "const line = formatLine(rows);"]]],
  ["--json gives no line", [["const line = signature.length > 0 ? formatLine(rows, nowMs) : null;", "const line = null;"]]],
  ["the line lists not proved before behind", [["  const behind = of(STATES.BEHIND);\n  if (behind.length) parts.push(`behind: ${behind.map((r) => `${r.name} (${r.behind.join(\" and \")})`).join(\", \")}`);\n  const unproved = of(STATES.NOT_PROVED);\n  if (unproved.length) parts.push(`not proved: ${unproved.map((r) => r.name).join(\", \")}`);", "  const unproved = of(STATES.NOT_PROVED);\n  if (unproved.length) parts.push(`not proved: ${unproved.map((r) => r.name).join(\", \")}`);\n  const behind = of(STATES.BEHIND);\n  if (behind.length) parts.push(`behind: ${behind.map((r) => `${r.name} (${r.behind.join(\" and \")})`).join(\", \")}`);"]]],
  ["the line names an unknown agent without its reason", [["unknown.map((r) => `${r.name} (${r.reason})`)", "unknown.map((r) => r.name)"]]],
  // The sha commands.
  ["a class sha command runs once per agent", [["      if (!mainClass.has(a.class)) mainClass.set(", "      if (true) mainClass.set("]]],
  ["an agents sha command runs once per agent", [["if (a.team_repo !== null && !mainAgents.has(a.team_repo)) mainAgents.set(", "if (a.team_repo !== null) mainAgents.set("]]],
  ["an agents sha command runs for an agent with no team repo", [["if (a.team_repo !== null && !mainAgents.has(a.team_repo)) mainAgents.set(", "if (!mainAgents.has(a.team_repo)) mainAgents.set("]]],
  ["a sha command that fails is believed", [["  if (res.code !== 0) throw new Failure(", "  if (false) throw new Failure("]]],
  ["a sha command that did not run is believed", [['  if (res.status !== "ok") throw new Failure(`${label} did not run`);\n', ""]]],
  ["a sha command's output is not checked", [["  if (!SHA_RE.test(sha)) throw new Failure(", "  if (false) throw new Failure("]]],
  ["a sha in capitals is not made lower case", [["  const sha = res.stdout.trim().toLowerCase();", "  const sha = res.stdout.trim();"]]],
  ["a sha with white space around it is refused", [["  const sha = res.stdout.trim().toLowerCase();", "  const sha = res.stdout.toLowerCase();"]]],
  ["ssh runs before the sha commands", [["    // Main's shas, once per distinct class and repo, before any ssh.\n", "    await inspect(run, sshTokens, agents[0], sshTimeoutMs);\n"]]],
  // Processes and the command line.
  ["ssh has no time limit of 30 seconds", [["export const DEFAULT_SSH_TIMEOUT_SECS = 30;", "export const DEFAULT_SSH_TIMEOUT_SECS = 3;"]]],
  ["the default ssh has no BatchMode", [['export const DEFAULT_SSH = "ssh -o BatchMode=yes -o ConnectTimeout=10";', 'export const DEFAULT_SSH = "ssh -o ConnectTimeout=10";']]],
  ["all ssh calls run at once", [["const CONCURRENCY = 6;", "const CONCURRENCY = 1000;"]]],
  ["ssh calls run one at a time", [["const CONCURRENCY = 6;", "const CONCURRENCY = 1;"]]],
  ["a timed-out process is not stopped", [["      kill();\n      finish({ status: \"timeout\", code: null });", "      finish({ status: \"timeout\", code: null });"]]],
  ["only the process, not its group, is stopped", [['        process.kill(-child.pid, "SIGKILL");', 'throw new Error("no group");']]],
  ["a process is not made a group of its own", [["stdio: [\"pipe\", \"pipe\", \"pipe\"], detached: true }", "stdio: [\"pipe\", \"pipe\", \"pipe\"] }"]]],
  ["output is not capped", [["      if (size > maxBytes) {", "      if (false) {"]]],
  ["the time limit is ignored", [['    const timer = setTimeout(() => {\n      kill();\n      finish({ status: "timeout", code: null });\n    }, timeoutMs);', "    const timer = null;"]]],
  ["a program that cannot be started is believed", [['    child.on("error", () => finish({ status: "failed", code: null }));\n', ""]]],
  ["an option given twice is allowed", [["      if (Object.hasOwn(values, arg)) throw new Failure(`${arg} given twice`);\n", ""]]],
  ["an unknown option is allowed", [["      throw new Failure(`unknown option ${shown(arg)}\\n${USAGE}`);", "      continue;"]]],
  ["a required option may be left out", [['    if (!Object.hasOwn(values, need)) throw new Failure(`${need} is required\\n${USAGE}`);', "    void need;"]]],
  ["any ssh timeout is taken", [['    if (!/^\\d{1,3}$/.test(values["--ssh-timeout"]) || sshTimeoutSecs < 1 || sshTimeoutSecs > 300) throw new Failure("--ssh-timeout must be 1 to 300 seconds");', ""]]],
  ["a config that cannot be read is an empty one", [["      throw new Failure(`config: cannot read ${shown(args.configPath)} as JSON (${error.code ?? \"not JSON\"})`);", "      config = [];"]]],
  ["a failed run exits 1", [["    return 2;\n  }\n}\n\n// ---------------------------------------------------------------------------------------------------------------------------\n// The command line.", "    return 1;\n  }\n}\n\n// ---------------------------------------------------------------------------------------------------------------------------\n// The command line."]]],
  // The second version: roles, the turn marker, the quiet state, the plan, and the state file that carries more.
  ["role is not checked", [["    if (!ROLES.includes(role)) throw at(", "    if (false) throw at("]]],
  ["role defaults to lead", [["const role = Object.hasOwn(entry, \"role\") ? entry.role : \"other\";", "const role = Object.hasOwn(entry, \"role\") ? entry.role : \"lead\";"]]],
  ["lead is not checked for form", [["    if (lead !== null && (typeof lead !== \"string\" || !RE_NAME.test(lead))) throw at(", "    if (false) throw at("]]],
  ["root is not checked", [["for (const key of [\"root\", \"plugin_dir\"]) {", "for (const key of [\"plugin_dir\"]) {"]]],
  ["plugin_dir is not checked", [["for (const key of [\"root\", \"plugin_dir\"]) {", "for (const key of [\"root\"]) {"]]],
  ["class_apply may be anything", [["    if (typeof classApply !== \"boolean\") throw at(", "    if (false) throw at("]]],
  ["class_apply defaults to off", [["Object.hasOwn(entry, \"class_apply\") ? entry.class_apply : true;", "Object.hasOwn(entry, \"class_apply\") ? entry.class_apply : false;"]]],
  ["a lead may have a lead", [["    if (a.role === \"lead\" && a.lead !== null) throw at(", "    if (false) throw at("]]],
  ["a lead may name an agent that is not in the config", [["    if (!named) throw at(", "    if (false) throw at("]]],
  ["a lead may name an agent that is not a lead", [["    if (named.role !== \"lead\") throw at(", "    if (false) throw at("]]],
  ["the optional keys are unknown", [["const OPTIONAL_KEYS = [\"role\", \"lead\", \"root\", \"plugin_dir\", \"class_apply\"];", "const OPTIONAL_KEYS = [];"]]],
  ["the new keys are left out of the agent", [["      role,\n      lead,\n      root: entry.root ?? null,\n      plugin_dir: entry.plugin_dir ?? null,\n      class_apply: classApply,\n", ""]]],
  ["the turn marker is read from another file", [["f=\"$3/turn\"\n", "f=\"$3/turn.txt\"\n"]]],
  ["a turn marker that is a link is read", [["elif [ ! -f \"$f\" ] || [ -L \"$f\" ]; then printf 'turn not-a-file\\\\n'", "elif [ ! -f \"$f\" ]; then printf 'turn not-a-file\\\\n'"]]],
  ["the turn marker is read whole, not its first line", [["t=$({ head -n 1 <\"$f\" | head -c 100; } 2>/dev/null)", "t=$({ head -c 100 <\"$f\"; } 2>/dev/null)"]]],
  ["the turn marker is cut at 10 characters", [["head -n 1 <\"$f\" | head -c 100", "head -n 1 <\"$f\" | head -c 10"]]],
  ["a prompt id may hold any character", [["        '' | *[!A-Za-z0-9-]*) printf 'turn invalid\\\\n' ;;", "        '') printf 'turn invalid\\\\n' ;;"]]],
  ["a prompt id may be any length", [["if [ \"\\${#id}\" -le 64 ]", "if [ \"\\${#id}\" -le 6400 ]"]]],
  ["a turn word is any word", [["    \"busy \"* | \"idle \"*)\n", "    *)\n"]]],
  ["the marker's time is read in another form", [["stat -c %Y \"$f\" ||", "stat -c %y \"$f\" ||"]]],
  ["the VM's clock is not asked", [["n=$({ date +%s; } 2>/dev/null)", "n="]]],
  ["a prompt id of any form is parsed", [["const PROMPT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;", "const PROMPT_ID_RE = /^.+$/;"]]],
  ["a prompt id of 65 characters is parsed", [["{1,64}$/;\nconst SECONDS_RE", "{1,65}$/;\nconst SECONDS_RE"]]],
  ["a time of any digits is parsed", [["const SECONDS_RE = /^[0-9]{1,12}$/;", "const SECONDS_RE = /^[0-9]+$/;"]]],
  ["a turn word with a bad id is parsed", [["    if (m === null || !PROMPT_ID_RE.test(m[2])) return null;", "    if (m === null) return null;"]]],
  ["an age is negative when the file is dated after the clock", [["ageSeconds: t !== null && n !== null && n >= t ? n - t : null", "ageSeconds: t !== null && n !== null ? n - t : null"]]],
  ["the turn lines need not be there", [["  if (word === null || mtime === null || now === null) return null;\n", ""]]],
  ["any turn word is a state", [["  if (TURN_WORDS.has(word)) state = word;", "  if (true) state = word;"]]],
  ["the turn is left out of the remote reading", [[", turn, proof };", ", turn: null, proof };"]]],
  ["the turn is not in the verdict", [["    turn: summarizeTurn(remote.turn),\n", ""]]],
  ["the turn summary has another key", [["age_seconds: turn.ageSeconds }", "age_seconds: turn.age }"]]],
  ["a row is quiet at exactly 3 days", [["return Number.isFinite(age) && age < AT_DONE_QUIET_MS;", "return Number.isFinite(age) && age <= AT_DONE_QUIET_MS;"]]],
  ["every state is quiet", [["  if (row.state !== STATES.AT_DONE) return false;\n", ""]]],
  ["a row with no usable time is quiet", [["return Number.isFinite(age) && age < AT_DONE_QUIET_MS;", "return !(age >= AT_DONE_QUIET_MS);"]]],
  ["a quiet row is in the signature", [["    .filter((r) => r.state !== STATES.CURRENT && !isQuiet(r, nowMs))", "    .filter((r) => r.state !== STATES.CURRENT)"]]],
  ["a quiet row is in the line", [["  const of = (state) => rows.filter((r) => r.state === state && !isQuiet(r, nowMs));", "  const of = (state) => rows.filter((r) => r.state === state);"]]],
  ["waiting for Done is left out of the line", [["  if (atDone.length) parts.push(`waiting for Done: ${atDone.map((r) => r.name).join(\", \")}`);\n", ""]]],
  ["waiting for Done is worded another way", [["`waiting for Done: ${", "`waiting: ${"]]],
  ["not proved and restarts at Done are two conditions", [["(a === STATES.NOT_PROVED && b === STATES.AT_DONE) || (a === STATES.AT_DONE && b === STATES.NOT_PROVED)", "false"]]],
  ["the rows are not marked quiet", [["    for (const r of rows) r.quiet = isQuiet(r, nowMs);\n", ""]]],
  ["the rows carry no plan", [["    for (const r of rows) r.plan = plans[r.name];\n", ""]]],
  ["--plan goes on to print the line and write the state", [["      stdout.write(formatPlan(rows, agents, plans));\n      return 0;\n", "      stdout.write(formatPlan(rows, agents, plans));\n"]]],
  ["--plan and --json together are allowed", [["  if (values.json && values.plan) throw new Failure(\"--json and --plan cannot be given together\");\n", ""]]],
  ["--plan twice is allowed", [["      if (values.plan) throw new Failure(\"--plan given twice\");\n", ""]]],
  ["--json counts only the printed set as not current", [["all_current: rows.every((r) => r.state === STATES.CURRENT)", "all_current: signature.length === 0"]]],
  ["the first version's state file is not read", [["(parsed.schema !== STATE_SCHEMA && parsed.schema !== STATE_SCHEMA_V1)", "parsed.schema !== STATE_SCHEMA"]]],
  ["the state file is still version 1", [["export const STATE_SCHEMA = \"ghost-protocol/rollout-check-state/v2\";", "export const STATE_SCHEMA = \"ghost-protocol/rollout-check-state/v1\";"]]],
  ["actions are not carried", [["      actions: previous?.actions ?? [],\n", "      actions: [],\n"]]],
  ["drain is not carried", [["      drain: previous?.drain ?? {},\n", "      drain: {},\n"]]],
  ["actions that are not a list are believed", [["const actions = Array.isArray(parsed.actions) ? parsed.actions : [];", "const actions = parsed.actions ?? [];"]]],
  ["a drain that is not an object is believed", [["  const drain = parsed.drain !== null && typeof parsed.drain === \"object\" && !Array.isArray(parsed.drain) ? parsed.drain : {};", "  const drain = parsed.drain ?? {};"]]],
  ["a lead restarts itself at Done", [["export const restartsAtDone = (role) => role === \"builder\" || role === \"reviewer\";", "export const restartsAtDone = (role) => role === \"builder\" || role === \"reviewer\" || role === \"lead\";"]], "states.mjs"],
  ["an agent with no role restarts itself at Done", [["export const restartsAtDone = (role) => role === \"builder\" || role === \"reviewer\";", "export const restartsAtDone = (role) => role !== \"lead\";"]], "states.mjs"],
  ["a reviewer does not restart itself at Done", [["role === \"builder\" || role === \"reviewer\";", "role === \"builder\";"]], "states.mjs"],
  ["a builder does not restart itself at Done", [["role === \"builder\" || role === \"reviewer\";", "role === \"reviewer\";"]], "states.mjs"],
  ["the quiet time is 7 days", [["export const AT_DONE_QUIET_MS = 3 * 24 * 3600 * 1000;", "export const AT_DONE_QUIET_MS = 7 * 24 * 3600 * 1000;"]], "states.mjs"],
  ["the quiet time is 1 day", [["export const AT_DONE_QUIET_MS = 3 * 24 * 3600 * 1000;", "export const AT_DONE_QUIET_MS = 1 * 24 * 3600 * 1000;"]], "states.mjs"],
  ["there is a fifth role", [["[\"lead\", \"builder\", \"reviewer\", \"other\"]", "[\"lead\", \"builder\", \"reviewer\", \"other\", \"boss\"]"]], "states.mjs"],
  ["a current agent has something to do", [["      notes.push(\"nothing to do\");", "      steps.push(\"restart it with start --fresh\");"]], "plan.mjs"],
  ["an unknown agent is acted on", [["      blocked.push(`unknown (${row.reason}): never acted on`);", "      steps.push(\"write the class file\");"]], "plan.mjs"],
  ["class_apply is ignored", [["        if (!agent.class_apply) blocked.push(", "        if (false) blocked.push("]], "plan.mjs"],
  ["a lead's class file is written at once", [["        else if (agent.role === \"lead\") steps.push(\"write the class file in the same step as its restart\");", "        else if (false) steps.push(\"x\");"]], "plan.mjs"],
  ["a clone is fast-forwarded with no plugin_dir", [["        if (agent.plugin_dir === null) blocked.push(\"plugin_dir is not set", "        if (false) blocked.push(\"plugin_dir is not set"]], "plan.mjs"],
  ["a builder that is behind is restarted", [["      if (agent.role === \"lead\") restartOfALead();\n      else if (agent.role === \"other\") notes.push(\"this tool restarts leads only\");\n      else notes.push(\"its session restarts when its task is done\");", "      restartOfALead();"]], "plan.mjs"],
  ["an agent with no role that is behind is told it restarts itself", [["      else if (agent.role === \"other\") notes.push(\"this tool restarts leads only\");\n      else notes.push(\"its session restarts when its task is done\");", "      else notes.push(\"its session restarts when its task is done\");"]], "plan.mjs"],
  ["an agent that is not a lead is restarted when not proved", [["      if (agent.role === \"lead\") restartOfALead();\n      else if (agent.role === \"other\")", "      if (true) restartOfALead();\n      else if (agent.role === \"other\")"]], "plan.mjs"],
  ["a restart needs no root", [["    if (agent.root === null || agent.plugin_dir === null) blocked.push(", "    if (agent.plugin_dir === null) blocked.push("]], "plan.mjs"],
  ["a restart needs no plugin_dir", [["    if (agent.root === null || agent.plugin_dir === null) blocked.push(", "    if (agent.root === null) blocked.push("]], "plan.mjs"],
  ["a restart needs no drain ack", [["    blocked.push(\"it needs a valid drain ack first (a request, then the lead's answer)\");\n", ""]], "plan.mjs"],
  ["a busy lead is restartable", [["    const own = turnBlock(\"the lead\", row.turn);\n    if (own) blocked.push(own);\n", ""]], "plan.mjs"],
  ["a busy pair does not block", [["      const why = turnBlock(`pair ${pair.name}`, pair.turn);\n      if (why) blocked.push(why);\n", ""]], "plan.mjs"],
  ["a turn that cannot be read is idle", [["  if (turn.state !== \"idle\") return `${who}: ${describeTurn(turn)}`;", "  if (false) return `${who}: ${describeTurn(turn)}`;"]], "plan.mjs"],
  ["an idle turn with no prompt id is idle", [["  if (turn.prompt_id === \"-\") return `${who}: its turn marker has no prompt id, so its idle cannot be tied to a turn`;\n", ""]], "plan.mjs"],
  ["a turn that was not read is idle", [["  if (turn === null || turn === undefined) return `${who}: its turn could not be read`;\n", "  if (turn === null || turn === undefined) return null;\n"]], "plan.mjs"],
  ["the pairs of a lead are every other agent", [["    const pairs = rows.filter((other, j) => agents[j].lead === agent.name);", "    const pairs = rows.filter((other, j) => other !== row);"]], "plan.mjs"],
  ["a lead with no pair says nothing", [["    if (pairs.length === 0) notes.push(\"no agent names it as its lead in the config, so no pair is checked\");\n", ""]], "plan.mjs"],
  ["the plan lists a current agent", [["    if (row.state === STATES.CURRENT) return;\n", ""]], "plan.mjs"],
  ["the plan counts every agent as current", [["  const current = rows.filter((r) => r.state === STATES.CURRENT).length;", "  const current = rows.length;"]], "plan.mjs"],
  ["a quiet row is not marked in the plan", [["${row.quiet ? \" (not in the printed line yet)\" : \"\"}", ""]], "plan.mjs"],
  ["the turn is not in the plan", [["    lines.push(`  turn: ${describeTurn(row.turn)}`);\n", ""]], "plan.mjs"],
  ["a turn's age is not in the plan", [["  const age = turn.age_seconds === null || turn.age_seconds === undefined ? \"\" : ` for ${turn.age_seconds} s`;", "  const age = \"\";"]], "plan.mjs"],
  ["busy and idle are swapped in the plan", [["    case \"busy\":\n      return `busy${age}`;\n    case \"idle\":\n      return `idle${age}`;", "    case \"busy\":\n      return `idle${age}`;\n    case \"idle\":\n      return `busy${age}`;"]], "plan.mjs"],
];

const run = (dir) =>
  new Promise((resolve) => {
    const suite = readdirSync(join(dir, "tools", "rollout-check", "test")).filter((f) => f.endsWith(".test.mjs")).map((f) => join("test", f));
    const child = spawn(process.execPath, ["--test", ...suite], { cwd: join(dir, "tools", "rollout-check"), env: { ...process.env, ROLLOUT_CHECK_TEST_REQUIRE: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });

// A copy of the tool laid out as in the repo, with links to the real hooks/ and install/ (the session tests run the real hooks).
function copy(root) {
  cpSync(TOOL, join(root, "tools", "rollout-check"), { recursive: true });
  symlinkSync(join(REPO, "hooks"), join(root, "hooks"));
  symlinkSync(join(REPO, "install"), join(root, "install"));
}

// `--check` only looks that every break's text is still in its file, and runs nothing: the quick way to keep the list in step.
if (process.argv[2] === "--check") {
  let missing = 0;
  MUTANTS.forEach(([name, edits, file = SRC]) => {
    const text = readFileSync(join(TOOL, file), "utf8");
    for (const [from] of edits) {
      if (!text.includes(from)) {
        console.log(`NOT APPLIED: ${name}`);
        missing++;
        break;
      }
    }
  });
  console.log(`${MUTANTS.length} mutants, ${missing} whose text is gone`);
  process.exit(missing ? 1 : 0);
}

const root = mkdtempSync(join(tmpdir(), "rollout-check-mutants-"));
let failed = false;
try {
  const only = process.argv[2];
  const base = join(root, "base");
  copy(base);
  const baseline = await run(base);
  if (baseline.code !== 0) {
    console.error(baseline.out);
    throw new Error("the suite fails on the unbroken copy");
  }
  console.log("the suite passes on the unbroken copy");

  const todo = MUTANTS.map((m, i) => [i, ...m]).filter(([, name]) => !only || name.includes(only));
  const results = [];
  const pool = 4;
  let next = 0;
  await Promise.all(
    Array.from({ length: pool }, async () => {
      while (next < todo.length) {
        const [i, name, edits, fileName = SRC] = todo[next++];
        const dir = join(root, `m${i}`);
        copy(dir);
        const file = join(dir, "tools", "rollout-check", fileName);
        let text = readFileSync(file, "utf8");
        let applied = true;
        for (const [from, to] of edits) {
          if (!text.includes(from)) applied = false;
          text = text.replace(from, () => to);
        }
        if (!applied) {
          results.push({ name, verdict: "NOT APPLIED" });
          continue;
        }
        writeFileSync(file, text);
        const r = await run(dir);
        results.push({ name, verdict: r.code === 0 ? "SURVIVED" : "killed" });
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
  const count = (v) => results.filter((r) => r.verdict === v).length;
  for (const r of results.filter((x) => x.verdict !== "killed")) console.log(`${r.verdict}: ${r.name}`);
  console.log(`${todo.length} mutants: ${count("killed")} killed, ${count("SURVIVED")} survived, ${count("NOT APPLIED")} not applied`);
  failed = count("killed") !== todo.length;
} finally {
  rmSync(root, { recursive: true, force: true });
}
if (failed) process.exitCode = 1;
