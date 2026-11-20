// rollout-check's logic (README.md here). The CLI beside it is a few lines; everything it decides is in this module, with its
// processes, its clock and its state file passed in, so the tests can fake each.
//
// It only reads. The one thing it runs on a VM is REMOTE_SCRIPT, a constant, through the ssh command it is given, and config
// values reach that script only as quoted arguments, after a strict pattern check. Nothing here copies, writes or deletes on a
// VM, and nothing here handles a key: the ssh command and the sha commands are the operator's.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { formatPlan, planAll } from "./plan.mjs";
import { AT_DONE_QUIET_MS, ROLES, STATES, restartsAtDone } from "./states.mjs";

export { AT_DONE_QUIET_MS, ROLES, STATES };

export const PROOF_SCHEMA = "ghost-protocol/load-proof/v1";
export const STATE_SCHEMA = "ghost-protocol/rollout-check-state/v2";
// The state file of the first version had no actions and no drain; it is read as one that has none, and written as v2.
const STATE_SCHEMA_V1 = "ghost-protocol/rollout-check-state/v1";

// The session id, in the form hooks/session-id requires of the id it writes and of the one it reads back. A test holds this to
// that line of the hook.
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
// A pid as start writes it to pane-pid: decimal, no leading zero, more than 1 (own-claude.sh refuses 0 and 1).
const PANE_PID_RE = /^[1-9][0-9]{0,9}$/;
const COMMIT_RE = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,64}$/;
const TIME_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

export const DEFAULT_SSH = "ssh -o BatchMode=yes -o ConnectTimeout=10";
export const DEFAULT_SSH_TIMEOUT_SECS = 30;
const SHA_CMD_TIMEOUT_MS = 120_000;
const CONCURRENCY = 6;
const MAX_AGENTS = 200;
const MAX_REMOTE_BYTES = 262_144;
const MAX_PROOF_BYTES = 65_536;

// A reminder is due 24 hours after the last printed line, less ten minutes so that an hourly timer's jitter does not push it a
// whole hour later.
export const REMIND_MS = 24 * 3600 * 1000;
export const REMIND_SLACK_MS = 10 * 60 * 1000;

export class Failure extends Error {}

// ---------------------------------------------------------------------------------------------------------------------------
// The config.

const KEYS = ["name", "ssh", "class", "home", "team_repo", "clone", "state_dir"];
// Optional: an agent without them is `other`, has no lead, and cannot be acted on until root and plugin_dir are set.
const OPTIONAL_KEYS = ["role", "lead", "root", "plugin_dir", "class_apply"];
const RE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RE_SSH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RE_CLASS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RE_REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const RE_PATH = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

// A value as it is shown in an error: JSON text, cut, so no control character of a hostile value reaches a terminal.
const shown = (v) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
};

const pathProblem = (v) => {
  if (typeof v !== "string") return "must be an absolute path";
  if (v.length > 255 || !RE_PATH.test(v)) return "must be an absolute path of letters, digits, . _ - and /, with no empty segment or trailing /";
  if (v.split("/").some((s) => s === "." || s === "..")) return "must not hold a . or .. segment";
  return null;
};

/** Checks the config, strictly, before anything is run. Returns the agents; throws a Failure naming the first problem. */
export function validateConfig(config) {
  if (!Array.isArray(config)) throw new Failure("config: must be a JSON array with one entry per agent");
  if (config.length === 0) throw new Failure("config: no agents");
  if (config.length > MAX_AGENTS) throw new Failure(`config: more than ${MAX_AGENTS} agents`);
  const names = new Set();
  const aliases = new Set();
  const agents = [];
  config.forEach((entry, i) => {
    const at = (why) => new Failure(`config: agent ${i + 1}${typeof entry?.name === "string" ? ` (${shown(entry.name)})` : ""}: ${why}`);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw at("must be an object");
    for (const key of Object.keys(entry)) if (!KEYS.includes(key) && !OPTIONAL_KEYS.includes(key)) throw at(`unknown key ${shown(key)}`);
    for (const key of KEYS) if (!Object.hasOwn(entry, key)) throw at(`missing key "${key}"`);
    const text = (key, re, what) => {
      if (typeof entry[key] !== "string" || !re.test(entry[key])) throw at(`"${key}" ${what}, not ${shown(entry[key])}`);
    };
    text("name", RE_NAME, "must be an instance name (lowercase letters, digits and -)");
    text("ssh", RE_SSH, "must be a host alias (letters, digits, . _ -; not starting with -)");
    text("class", RE_CLASS, "must be a class name (letters, digits, . _ -)");
    for (const key of ["home", "state_dir"]) {
      const why = pathProblem(entry[key]);
      if (why) throw at(`"${key}" ${why}, not ${shown(entry[key])}`);
    }
    if (entry.team_repo === null) {
      const why = entry.clone === null ? null : pathProblem(entry.clone);
      if (why) throw at(`"clone" ${why} (or null), not ${shown(entry.clone)}`);
    } else {
      text("team_repo", RE_REPO, "must be owner/repo or null");
      const why = pathProblem(entry.clone);
      if (why) throw at(`"clone" ${why}, not ${shown(entry.clone)}`);
    }
    const role = Object.hasOwn(entry, "role") ? entry.role : "other";
    if (!ROLES.includes(role)) throw at(`"role" must be one of ${ROLES.join(", ")}, not ${shown(entry.role)}`);
    const lead = Object.hasOwn(entry, "lead") ? entry.lead : null;
    if (lead !== null && (typeof lead !== "string" || !RE_NAME.test(lead))) throw at(`"lead" must be an instance name or null, not ${shown(lead)}`);
    for (const key of ["root", "plugin_dir"]) {
      if (!Object.hasOwn(entry, key) || entry[key] === null) continue;
      const why = pathProblem(entry[key]);
      if (why) throw at(`"${key}" ${why} (or null), not ${shown(entry[key])}`);
    }
    const classApply = Object.hasOwn(entry, "class_apply") ? entry.class_apply : true;
    if (typeof classApply !== "boolean") throw at(`"class_apply" must be true or false, not ${shown(classApply)}`);
    if (names.has(entry.name)) throw at(`the name ${shown(entry.name)} is used by another agent`);
    names.add(entry.name);
    const alias = entry.ssh.toLowerCase();
    if (aliases.has(alias)) throw at(`the ssh alias ${shown(entry.ssh)} is used by another agent`);
    aliases.add(alias);
    agents.push({
      name: entry.name,
      ssh: entry.ssh,
      class: entry.class,
      home: entry.home,
      team_repo: entry.team_repo,
      clone: entry.clone,
      state_dir: entry.state_dir,
      role,
      lead,
      root: entry.root ?? null,
      plugin_dir: entry.plugin_dir ?? null,
      class_apply: classApply,
    });
  });
  // The leads: a pair names a lead that is in this config, and a lead has none of its own.
  const byName = new Map(agents.map((a) => [a.name, a]));
  agents.forEach((a, i) => {
    const at = (why) => new Failure(`config: agent ${i + 1} (${shown(a.name)}): ${why}`);
    if (a.role === "lead" && a.lead !== null) throw at(`a lead has no lead of its own, not ${shown(a.lead)}`);
    if (a.lead === null) return;
    const named = byName.get(a.lead);
    if (!named) throw at(`"lead" names ${shown(a.lead)}, which is not an agent in this config`);
    if (named.role !== "lead") throw at(`"lead" names ${shown(a.lead)}, whose role is not "lead"`);
  });
  return agents;
}

/** A command given as one string, as words. No shell reads it: quotes are not special, so wrap anything complex in a script. */
export function parseCommand(text, what) {
  const words = String(text).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) throw new Failure(`${what}: empty command`);
  return words;
}

// ---------------------------------------------------------------------------------------------------------------------------
// What runs on a VM.

/** `value` as one word for a POSIX shell. */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// The only thing run on a VM, sent to `sh -s` on its standard input: a constant. $1 is the home folder, $2 the team repo's clone
// (empty for none) and $3 the instance's state folder. It reads: it tests, hashes and prints, and writes no file.
//   class     the sha256 of <home>/CLAUDE.md
//   agents    the sha256 of <clone>/AGENTS.md
//   session   the instance's current session id: the file session-id in the state folder, the one install/service/start
//             resumes and hooks/session-id keeps current. Read as the hook reads it (a regular file that is not a link, with
//             all white space removed).
//   pane-pid  the pid of the instance's claude, the file pane-pid in the same folder, which start rewrites at every start of
//             claude and which hooks/load-proof records in the proof as claude_pid. Read the same way: a regular file that is
//             not a link, all white space removed, digits only.
//   turn      the instance's turn marker, the file turn in the state folder that hooks/turn-state writes: `busy <prompt id>` while a turn
//             is on, `idle <prompt id>` once it has ended. Read as the hook writes it (a regular file that is not a link, its first
//             line, the prompt id of letters, digits and - only, at most 64). Anything else is `invalid`.
//   turn-mtime and now   when the marker was last written, and the VM's own clock, both in seconds, so an age is the VM's own
//             difference and no clock of ours is trusted for it
//   proof-hex the first 64 KiB of proof.json in that folder, in hex, so that nothing in it can break the framing
// A file that is not there is `missing`; one that is not a regular file `not-a-file`; one that cannot be read `unreadable`.
export const REMOTE_SCRIPT = `LC_ALL=C
export LC_ALL
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then d=$({ sha256sum <"$1"; } 2>/dev/null)
  elif command -v shasum >/dev/null 2>&1; then d=$({ shasum -a 256 <"$1"; } 2>/dev/null)
  elif command -v openssl >/dev/null 2>&1; then d=$({ openssl dgst -sha256 -r <"$1"; } 2>/dev/null)
  else printf 'no-sha256'; return 0
  fi
  d=\${d%% *}
  case "$d" in
    '' | *[!0-9a-f]*) printf 'unreadable' ;;
    *) if [ "\${#d}" -eq 64 ]; then printf '%s' "$d"; else printf 'unreadable'; fi ;;
  esac
}
file_sha() {
  if [ ! -e "$1" ]; then printf 'missing'
  elif [ ! -f "$1" ]; then printf 'not-a-file'
  else sha256_of "$1"
  fi
}
printf 'rollout-check v2\\n'
printf 'class %s\\n' "$(file_sha "$1/CLAUDE.md")"
if [ -n "$2" ]; then printf 'agents %s\\n' "$(file_sha "$2/AGENTS.md")"; else printf 'agents skipped\\n'; fi
f="$3/session-id"
if [ -f "$f" ] && [ ! -L "$f" ]; then
  s=$({ tr -d '[:space:]' <"$f" | head -c 128; } 2>/dev/null)
  case "$s" in
    '' | *[!0-9a-f-]*) printf 'session invalid\\n' ;;
    *) printf 'session %s\\n' "$s" ;;
  esac
else
  printf 'session missing\\n'
fi
f="$3/pane-pid"
if [ -f "$f" ] && [ ! -L "$f" ]; then
  p=$({ tr -d '[:space:]' <"$f" | head -c 32; } 2>/dev/null)
  case "$p" in
    '' | *[!0-9]*) printf 'pane-pid invalid\\n' ;;
    *) printf 'pane-pid %s\\n' "$p" ;;
  esac
else
  printf 'pane-pid missing\\n'
fi
f="$3/turn"
if [ ! -e "$f" ]; then printf 'turn missing\\n'
elif [ ! -f "$f" ] || [ -L "$f" ]; then printf 'turn not-a-file\\n'
else
  t=$({ head -n 1 <"$f" | head -c 100; } 2>/dev/null)
  case "$t" in
    "busy "* | "idle "*)
      k=\${t%% *}
      id=\${t#* }
      case "$id" in
        '' | *[!A-Za-z0-9-]*) printf 'turn invalid\\n' ;;
        *) if [ "\${#id}" -le 64 ]; then printf 'turn %s %s\\n' "$k" "$id"; else printf 'turn invalid\\n'; fi ;;
      esac ;;
    *) printf 'turn invalid\\n' ;;
  esac
fi
m=
if [ -f "$f" ] && [ ! -L "$f" ]; then m=$({ stat -c %Y "$f" || stat -f %m "$f"; } 2>/dev/null); fi
case "$m" in
  '' | *[!0-9]*) printf 'turn-mtime none\\n' ;;
  *) printf 'turn-mtime %s\\n' "$m" ;;
esac
n=$({ date +%s; } 2>/dev/null)
case "$n" in
  '' | *[!0-9]*) printf 'now none\\n' ;;
  *) printf 'now %s\\n' "$n" ;;
esac
f="$3/proof.json"
if [ ! -e "$f" ]; then printf 'proof missing\\n'
elif [ ! -f "$f" ] || [ -L "$f" ]; then printf 'proof not-a-file\\n'
else printf 'proof-hex %s\\n' "$({ od -An -v -tx1 -N ${MAX_PROOF_BYTES + 1} <"$f"; } 2>/dev/null | tr -d ' \\n')"
fi
printf 'end\\n'
`;

/** The command line ssh gets after its options and the alias: the login shell reads this, and the script comes on stdin. */
export function remoteCommand(agent) {
  const clone = agent.team_repo === null ? "" : agent.clone;
  return ["sh", "-s", "--", shellQuote(agent.home), shellQuote(clone), shellQuote(agent.state_dir)].join(" ");
}

const DISK_WORDS = new Set(["missing", "not-a-file", "unreadable", "no-sha256"]);
// What a read of a file can come to without saying whether the file is main's.
const INCONCLUSIVE = new Set(["unreadable", "no-sha256"]);

/** Reads REMOTE_SCRIPT's output. Returns null unless it is exactly that output, whole. */
export function parseRemote(stdout) {
  const lines = String(stdout).split("\n");
  if (lines.length !== 11 || lines[10] !== "") return null;
  if (lines[0] !== "rollout-check v2" || lines[9] !== "end") return null;
  const value = (line, key) => (line.startsWith(`${key} `) ? line.slice(key.length + 1) : null);
  const disk = (v, extra) => (v !== null && (SHA_RE.test(v) || DISK_WORDS.has(v) || v === extra) ? v : null);
  const classDisk = disk(value(lines[1], "class"));
  const agentsDisk = disk(value(lines[2], "agents"), "skipped");
  const session = value(lines[3], "session");
  const pane = value(lines[4], "pane-pid");
  if (classDisk === null || agentsDisk === null || session === null || pane === null) return null;
  // Whatever else the file held is an invalid id (the script prints it as one token), not a broken output.
  if (!(/^[0-9a-f-]{1,128}$/.test(session) || session === "missing" || session === "invalid")) return null;
  if (!(/^[0-9]{1,32}$/.test(pane) || pane === "missing" || pane === "invalid")) return null;
  const turn = parseTurn(value(lines[5], "turn"), value(lines[6], "turn-mtime"), value(lines[7], "now"));
  if (turn === null) return null;
  let proof;
  if (lines[8] === "proof missing") proof = { kind: "missing" };
  else if (lines[8] === "proof not-a-file") proof = { kind: "not-a-file" };
  else {
    const hex = value(lines[8], "proof-hex");
    if (hex === null || !/^([0-9a-f]{2})*$/.test(hex)) return null;
    proof = { kind: "text", bytes: Buffer.from(hex, "hex") };
  }
  return { classDisk, agentsDisk, sessionId: SESSION_ID_RE.test(session) ? session : null, panePid: PANE_PID_RE.test(pane) && Number(pane) > 1 ? Number(pane) : null, turn, proof };
}

const PROMPT_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
const SECONDS_RE = /^[0-9]{1,12}$/;
const TURN_WORDS = new Set(["missing", "not-a-file", "invalid"]);

// The turn marker's three lines, or null when one is not in the form the script prints. `state` is busy, idle, missing, not-a-file or
// invalid; the prompt id is only there for busy and idle; the age is the VM's own difference, and null when either time is not there
// or the marker is dated after the VM's clock.
function parseTurn(word, mtime, now) {
  if (word === null || mtime === null || now === null) return null;
  if (!(mtime === "none" || SECONDS_RE.test(mtime)) || !(now === "none" || SECONDS_RE.test(now))) return null;
  let state;
  let promptId = null;
  if (TURN_WORDS.has(word)) state = word;
  else {
    const m = word.match(/^(busy|idle) (.+)$/);
    if (m === null || !PROMPT_ID_RE.test(m[2])) return null;
    state = m[1];
    promptId = m[2];
  }
  const t = mtime === "none" ? null : Number(mtime);
  const n = now === "none" ? null : Number(now);
  return { state, promptId, mtime: t, now: n, ageSeconds: t !== null && n !== null && n >= t ? n - t : null };
}

// What the table shows of the turn marker: a plain form, no free text.
const summarizeTurn = (turn) => (turn ? { state: turn.state, prompt_id: turn.promptId, mtime: turn.mtime, age_seconds: turn.ageSeconds } : null);

// ---------------------------------------------------------------------------------------------------------------------------
// Judging one agent.

// The proof, as far as it is trusted: a plain object of the schema, or a reason it is not one.
function readProof(proof) {
  if (proof.kind === "missing") return { problem: "no proof file" };
  if (proof.kind === "not-a-file") return { problem: "proof file is not a regular file" };
  if (proof.bytes.length === 0 || proof.bytes.length > MAX_PROOF_BYTES) return { problem: "proof file is unreadable" };
  let parsed;
  try {
    parsed = JSON.parse(proof.bytes.toString("utf8"));
  } catch {
    return { problem: "proof file is unreadable" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { problem: "proof file is unreadable" };
  if (parsed.schema !== PROOF_SCHEMA) return { problem: "proof has another schema" };
  return { value: parsed };
}

const textOf = (v, re) => (typeof v === "string" && re.test(v) ? v : null);

// What the table shows of a proof: only fields that match a strict form, never free text from the VM.
function summarizeProof(proof, sessionId) {
  const status = (side) => (proof[side]?.status === "ok" || proof[side]?.status === "none" ? proof[side].status : null);
  return {
    session_id: textOf(proof.session_id, SESSION_ID_RE),
    current_session: sessionId !== null && proof.session_id === sessionId,
    claude_pid: Number.isSafeInteger(proof.claude_pid) && proof.claude_pid > 1 ? proof.claude_pid : null,
    time: textOf(proof.time, TIME_RE),
    class_status: status("class"),
    class_sha: status("class") === "ok" ? textOf(proof.class.sha256, SHA_RE) : null,
    agents_status: status("agents"),
    agents_sha: status("agents") === "ok" ? textOf(proof.agents.sha256, SHA_RE) : null,
    version: textOf(proof.plugin?.version, VERSION_RE),
    commit: textOf(proof.plugin?.commit, COMMIT_RE),
  };
}

/** Why a proof does not prove the agent current, or null when it does. `summary` is summarizeProof's. */
function proofProblem(agent, expected, remote, summary) {
  if (remote.sessionId === null) return "no current session id";
  if (!summary.current_session) return "proof is from another session";
  if (remote.panePid === null) return "no pane-pid beside the proof";
  if (summary.claude_pid === null) return "proof has no claude_pid";
  if (summary.claude_pid !== remote.panePid) return "proof is of another claude process";
  if (summary.class_status !== "ok") return "proof shows no class file";
  if (summary.class_sha !== expected.class) return "proof shows another class file";
  if (agent.team_repo !== null) {
    if (summary.agents_status !== "ok") return "proof shows no agents file";
    if (summary.agents_sha !== expected.agents) return "proof shows another agents file";
  }
  return null;
}

/**
 * Judges one agent from what its VM printed (parseRemote's) and main's shas. `expected` is {class, agents}, agents null with no
 * team repo. An agent with no team repo is judged on its class file alone.
 */
export function judge(agent, expected, remote) {
  const behind = [];
  if (remote.classDisk !== expected.class && !INCONCLUSIVE.has(remote.classDisk)) behind.push("class");
  if (agent.team_repo !== null && remote.agentsDisk !== expected.agents && !INCONCLUSIVE.has(remote.agentsDisk)) behind.push("agents");
  const proof = readProof(remote.proof);
  const summary = proof.value ? summarizeProof(proof.value, remote.sessionId) : null;
  const base = {
    disk: { class: remote.classDisk, agents: agent.team_repo === null ? null : remote.agentsDisk },
    session_id: remote.sessionId,
    pane_pid: remote.panePid,
    turn: summarizeTurn(remote.turn),
    proof: summary,
  };
  // A file that is there but cannot be read, or a VM with no sha256 tool, says nothing about the file: not behind (an apply would
  // not fix it) and not current. A file that is certainly behind is still said.
  if (behind.length > 0) return { ...base, state: STATES.BEHIND, behind, reason: `${behind.join(" and ")} on disk differs from main` };
  const unread = [remote.classDisk, agent.team_repo === null ? null : remote.agentsDisk];
  if (unread.includes("no-sha256")) return { ...base, state: STATES.UNKNOWN, behind: [], reason: "no sha256 tool" };
  if (remote.classDisk === "unreadable") return { ...base, state: STATES.UNKNOWN, behind: [], reason: "class file unreadable" };
  if (unread[1] === "unreadable") return { ...base, state: STATES.UNKNOWN, behind: [], reason: "agents file unreadable" };
  const problem = proof.problem ?? proofProblem(agent, expected, remote, summary);
  // An agent that restarts itself when its task is done is not wrong for not having restarted yet.
  if (problem) return { ...base, state: restartsAtDone(agent.role) ? STATES.AT_DONE : STATES.NOT_PROVED, behind: [], reason: problem };
  return { ...base, state: STATES.CURRENT, behind: [], reason: null };
}

const unknownResult = (reason) => ({ state: STATES.UNKNOWN, behind: [], reason, disk: { class: null, agents: null }, session_id: null, pane_pid: null, turn: null, proof: null });

// ---------------------------------------------------------------------------------------------------------------------------
// Processes.

/**
 * Runs argv (no shell) with `input` on its stdin. Resolves, never rejects, to {status, code, stdout, stderr}; status is "ok" (it
 * exited, with `code`), "timeout" (killed, with its whole process group), "too-large" (more than maxBytes on stdout; killed) or
 * "failed" (could not be started).
 */
export function runProcess(argv, { input = "", timeoutMs = 30_000, maxBytes = MAX_REMOTE_BYTES } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], detached: true });
    } catch {
      resolve({ status: "failed", code: null, stdout: "", stderr: "" });
      return;
    }
    const out = [];
    let size = 0;
    let err = "";
    let done = false;
    const kill = () => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone already */
        }
      }
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: err, ...result });
    };
    const timer = setTimeout(() => {
      kill();
      finish({ status: "timeout", code: null });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        kill();
        finish({ status: "too-large", code: null });
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      if (err.length < 2048) err += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {});
    child.on("error", () => finish({ status: "failed", code: null }));
    child.on("close", (code) => finish({ status: "ok", code }));
    child.stdin.end(input);
  });
}

// A line of a process's stderr, for an error message: first line, printable only, cut.
const firstLine = (text) => String(text).split("\n")[0].replace(/[^\x20-\x7e]/g, "?").slice(0, 120);

async function expectedSha(run, tokens, arg, what) {
  const res = await run([...tokens, arg], { timeoutMs: SHA_CMD_TIMEOUT_MS });
  const label = `${what} sha command for ${shown(arg)}`;
  if (res.status === "timeout") throw new Failure(`${label} timed out`);
  if (res.status !== "ok") throw new Failure(`${label} did not run`);
  if (res.code !== 0) throw new Failure(`${label} failed (exit ${res.code})${firstLine(res.stderr) ? `: ${firstLine(res.stderr)}` : ""}`);
  const sha = res.stdout.trim().toLowerCase();
  if (!SHA_RE.test(sha)) throw new Failure(`${label} did not print a sha256 (64 hex characters)`);
  return sha;
}

async function inspect(run, sshTokens, agent, timeoutMs) {
  const res = await run([...sshTokens, agent.ssh, remoteCommand(agent)], { input: REMOTE_SCRIPT, timeoutMs, maxBytes: MAX_REMOTE_BYTES });
  if (res.status === "timeout") return unknownResult("ssh timeout");
  if (res.status === "too-large") return unknownResult("output too large");
  if (res.status !== "ok" || res.code !== 0) return unknownResult("ssh failed");
  return { remote: parseRemote(res.stdout) };
}

// ---------------------------------------------------------------------------------------------------------------------------
// The state file, and what is printed.

const validTime = (v) => typeof v === "string" && TIME_RE.test(v) && Number.isFinite(Date.parse(v));
const iso = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

/** The state file, or null: a missing, empty, unreadable or malformed file is no state, and never hides a line. */
export function readState(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || (parsed.schema !== STATE_SCHEMA && parsed.schema !== STATE_SCHEMA_V1)) return null;
  const signature = Array.isArray(parsed.signature) && parsed.signature.every((s) => typeof s === "string") ? parsed.signature : null;
  const agents = Object.create(null);
  if (parsed.agents !== null && typeof parsed.agents === "object" && !Array.isArray(parsed.agents)) {
    for (const [name, a] of Object.entries(parsed.agents)) {
      if (a !== null && typeof a === "object" && Object.values(STATES).includes(a.state) && validTime(a.since)) agents[name] = a;
    }
  }
  // What acting runs will keep here (the journal of their actions, and the drain records): this version only carries them along.
  const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
  const drain = parsed.drain !== null && typeof parsed.drain === "object" && !Array.isArray(parsed.drain) ? parsed.drain : {};
  return { signature, last_printed: validTime(parsed.last_printed) ? parsed.last_printed : null, agents, actions, drain };
}

/** Writes the state in one step: a temporary file beside it, then a rename. */
export function writeState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Whether the row is `applied, restarts at Done` and young: it is shown by --json and --plan from the first hour, and left out of the
 * printed line until it has lasted AT_DONE_QUIET_MS. A row with no usable `since`, or no clock to compare, is not quiet.
 */
export function isQuiet(row, nowMs = Number.POSITIVE_INFINITY) {
  if (row.state !== STATES.AT_DONE) return false;
  const age = nowMs - Date.parse(row.since);
  return Number.isFinite(age) && age < AT_DONE_QUIET_MS;
}

/** One word per non-current agent that says what is wrong with it, sorted: the set the line is printed for. */
export function signatureOf(rows, nowMs = Number.POSITIVE_INFINITY) {
  return rows
    .filter((r) => r.state !== STATES.CURRENT && !isQuiet(r, nowMs))
    .map((r) => {
      if (r.state === STATES.BEHIND) return `${r.name}:behind:${r.behind.join("+")}`;
      if (r.state === STATES.AT_DONE) return `${r.name}:at-done`;
      return `${r.name}:${r.state === STATES.UNKNOWN ? "unknown" : "not-proved"}`;
    })
    .sort();
}

/** Whether the line is printed: it is when the set changed, when there is no usable record of the last run or of the last line, and once a day. */
export function shouldPrint(signature, previous, nowMs) {
  if (signature.length === 0) return false;
  if (previous === null || previous.signature === null) return true;
  if (previous.signature.length !== signature.length || previous.signature.some((s, i) => s !== signature[i])) return true;
  if (previous.last_printed === null) return true;
  const last = Date.parse(previous.last_printed);
  if (last > nowMs) return true;
  return nowMs - last >= REMIND_MS - REMIND_SLACK_MS;
}

/** The line: behind, then not proved, then waiting for Done, then unknown, each only when it has someone. */
export function formatLine(rows, nowMs = Number.POSITIVE_INFINITY) {
  const of = (state) => rows.filter((r) => r.state === state && !isQuiet(r, nowMs));
  const parts = [];
  const behind = of(STATES.BEHIND);
  if (behind.length) parts.push(`behind: ${behind.map((r) => `${r.name} (${r.behind.join(" and ")})`).join(", ")}`);
  const unproved = of(STATES.NOT_PROVED);
  if (unproved.length) parts.push(`not proved: ${unproved.map((r) => r.name).join(", ")}`);
  const atDone = of(STATES.AT_DONE);
  if (atDone.length) parts.push(`waiting for Done: ${atDone.map((r) => r.name).join(", ")}`);
  const unknown = of(STATES.UNKNOWN);
  if (unknown.length) parts.push(`unknown: ${unknown.map((r) => `${r.name} (${r.reason})`).join(", ")}`);
  return parts.join("; ");
}

// ---------------------------------------------------------------------------------------------------------------------------
// A run.

/**
 * One run. options: {agents, statePath, classShaCmd, agentsShaCmd, sshCmd, sshTimeoutSecs, json}; deps (all optional): {run, now,
 * readState, writeState, stdout, stderr}. Returns the exit code: 0 with the report made (or nothing to report), 2 when the run
 * failed (the reason on stderr; nothing on stdout, no state written, and no ssh when the sha commands are what failed).
 */
export async function runCheck(options, deps = {}) {
  const run = deps.run ?? runProcess;
  const clock = deps.now ?? (() => new Date());
  const load = deps.readState ?? readState;
  const save = deps.writeState ?? writeState;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const agents = options.agents;
    const classCmd = parseCommand(options.classShaCmd, "--class-sha-cmd");
    const agentsCmd = parseCommand(options.agentsShaCmd, "--agents-sha-cmd");
    const sshTokens = parseCommand(options.sshCmd ?? DEFAULT_SSH, "--ssh");
    const sshTimeoutMs = (options.sshTimeoutSecs ?? DEFAULT_SSH_TIMEOUT_SECS) * 1000;
    const started = clock();
    const nowIso = iso(started);

    // Main's shas, once per distinct class and repo, before any ssh.
    const mainClass = new Map();
    const mainAgents = new Map();
    for (const a of agents) {
      if (!mainClass.has(a.class)) mainClass.set(a.class, await expectedSha(run, classCmd, a.class, "class"));
      if (a.team_repo !== null && !mainAgents.has(a.team_repo)) mainAgents.set(a.team_repo, await expectedSha(run, agentsCmd, a.team_repo, "agents"));
    }

    // One ssh call per agent, a few at a time; the rows keep the config's order.
    const rows = new Array(agents.length);
    let next = 0;
    const worker = async () => {
      while (next < agents.length) {
        const i = next++;
        const a = agents[i];
        const expected = { class: mainClass.get(a.class), agents: a.team_repo === null ? null : mainAgents.get(a.team_repo) };
        const seen = await inspect(run, sshTokens, a, sshTimeoutMs);
        let result;
        if (seen.state) result = seen;
        else if (seen.remote === null) result = unknownResult("unparseable output");
        else result = judge(a, expected, seen.remote);
        rows[i] = { name: a.name, ssh: a.ssh, class: a.class, team_repo: a.team_repo, role: a.role, lead: a.lead, expected, ...result };
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, agents.length) }, worker));

    const previous = load(options.statePath);
    // `applied, not proved` and `applied, restarts at Done` are one condition that the agent's role words differently: a role added to
    // the config does not start the 3 days over.
    const sameCondition = (a, b) => a === b || (a === STATES.NOT_PROVED && b === STATES.AT_DONE) || (a === STATES.AT_DONE && b === STATES.NOT_PROVED);
    for (const r of rows) {
      const before = previous?.agents[r.name];
      r.since = before && sameCondition(before.state, r.state) ? before.since : nowIso;
    }

    const nowMs = started.getTime();
    for (const r of rows) r.quiet = isQuiet(r, nowMs);
    const plans = planAll(rows, agents);
    for (const r of rows) r.plan = plans[r.name];
    const signature = signatureOf(rows, nowMs);
    const print = shouldPrint(signature, previous, nowMs);
    if (options.plan) {
      // For a person to read: what an acting run would do, and what stops it. It prints no line and writes no state.
      stdout.write(formatPlan(rows, agents, plans));
      return 0;
    }
    if (options.json) {
      // For a person to read: what a run would say now, and whether it would. It prints no line and writes no state.
      const line = signature.length > 0 ? formatLine(rows, nowMs) : null;
      stdout.write(`${JSON.stringify({ generated: nowIso, all_current: rows.every((r) => r.state === STATES.CURRENT), would_print: print, line, agents: rows }, null, 2)}\n`);
      return 0;
    }
    if (print) stdout.write(`${formatLine(rows, nowMs)}\n`);
    const state = {
      schema: STATE_SCHEMA,
      updated: nowIso,
      last_printed: print ? nowIso : previous?.last_printed ?? null,
      signature,
      actions: previous?.actions ?? [],
      drain: previous?.drain ?? {},
      agents: Object.fromEntries(
        rows.map((r) => [r.name, { state: r.state, behind: r.behind, since: r.since, checked: nowIso, disk: r.disk, proof: r.proof && { current_session: r.proof.current_session, class_sha: r.proof.class_sha, agents_sha: r.proof.agents_sha } }]),
      ),
    };
    try {
      save(options.statePath, state);
    } catch (error) {
      stderr.write(`rollout-check: could not write the state file: ${error.code ?? "error"}\n`);
    }
    return 0;
  } catch (error) {
    stderr.write(`rollout-check: ${error instanceof Failure ? error.message : `internal error: ${error?.message ?? error}`}\n`);
    return 2;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// The command line.

const USAGE = `usage: rollout-check run --config <file> --state <file> --class-sha-cmd <cmd> --agents-sha-cmd <cmd> [--ssh <cmd>] [--ssh-timeout <secs>] [--json | --plan]
exit codes: 0 done (a line on stdout when something changed), 2 the run failed or the usage is wrong`;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") return { help: true };
  if (command !== "run") throw new Failure(`unknown command ${shown(command)}\n${USAGE}`);
  const values = {};
  const valued = new Set(["--config", "--state", "--class-sha-cmd", "--agents-sha-cmd", "--ssh", "--ssh-timeout"]);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--json") {
      if (values.json) throw new Failure("--json given twice");
      values.json = true;
    } else if (arg === "--plan") {
      if (values.plan) throw new Failure("--plan given twice");
      values.plan = true;
    } else if (valued.has(arg)) {
      if (Object.hasOwn(values, arg)) throw new Failure(`${arg} given twice`);
      if (i + 1 >= rest.length) throw new Failure(`${arg} needs a value`);
      values[arg] = rest[++i];
    } else {
      throw new Failure(`unknown option ${shown(arg)}\n${USAGE}`);
    }
  }
  if (values.json && values.plan) throw new Failure("--json and --plan cannot be given together");
  for (const need of ["--config", "--state", "--class-sha-cmd", "--agents-sha-cmd"]) {
    if (!Object.hasOwn(values, need)) throw new Failure(`${need} is required\n${USAGE}`);
  }
  let sshTimeoutSecs;
  if (Object.hasOwn(values, "--ssh-timeout")) {
    sshTimeoutSecs = Number(values["--ssh-timeout"]);
    if (!/^\d{1,3}$/.test(values["--ssh-timeout"]) || sshTimeoutSecs < 1 || sshTimeoutSecs > 300) throw new Failure("--ssh-timeout must be 1 to 300 seconds");
  }
  return { configPath: values["--config"], statePath: values["--state"], classShaCmd: values["--class-sha-cmd"], agentsShaCmd: values["--agents-sha-cmd"], sshCmd: values["--ssh"], sshTimeoutSecs, json: values.json === true, plan: values.plan === true };
}

/** The CLI: argv without node and the script. Returns the exit code. */
export async function main(argv, deps = {}) {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const args = parseArgs(argv);
    if (args.help) {
      stdout.write(`${USAGE}\n`);
      return 0;
    }
    let config;
    try {
      config = JSON.parse(readFileSync(args.configPath, "utf8"));
    } catch (error) {
      throw new Failure(`config: cannot read ${shown(args.configPath)} as JSON (${error.code ?? "not JSON"})`);
    }
    const agents = validateConfig(config);
    return await runCheck({ ...args, agents }, deps);
  } catch (error) {
    stderr.write(`rollout-check: ${error instanceof Failure ? error.message : `internal error: ${error?.message ?? error}`}\n`);
    return 2;
  }
}
