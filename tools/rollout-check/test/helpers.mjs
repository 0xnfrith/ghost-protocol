// Fakes and builders for the rollout-check tests. No sha256 is written out in full anywhere in the repo's tests: shas are made
// here, from a letter or from bytes.
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PROOF_SCHEMA, validateConfig } from "../lib.mjs";

export const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO = join(TOOL, "..", "..");
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export const SHA = (letter) => letter.repeat(64);
export const SESSION = "0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b";
export const SESSION2 = "1c2d3e4f-5061-4723-9b8c-0d1e2f3a4b5c";
/** The pid of the instance's claude in the tests that do not run a real one: in pane-pid, and as claude_pid in the proof. */
export const PANE_PID = 4242;

const folders = [];
export const tempDir = (label) => {
  const dir = mkdtempSync(join(tmpdir(), `rollout-check-${label}-`));
  folders.push(dir);
  return dir;
};
export const cleanUp = () => {
  for (const f of folders.splice(0)) rmSync(f, { recursive: true, force: true });
};

/** One config entry; `extra` overrides any field. */
export const entry = (name, extra = {}) => ({
  name,
  ssh: `${name}-vm`,
  class: "gp-builder",
  home: `/home/${name}`,
  team_repo: "o/team",
  clone: `/home/${name}/s9/repos/o/team`,
  state_dir: `/home/${name}/.local/state/ghost-protocol/${name}`,
  ...extra,
});

/** A proof.json as hooks/load-proof writes it (schema v1). */
export const proofFor = ({ session = SESSION, pid = PANE_PID, classSha, agentsSha, classStatus = "ok", agentsStatus = "ok", version = "0.9.1", commit = "c".repeat(40), schema = PROOF_SCHEMA, extra = {} } = {}) => ({
  schema,
  instance: "inst",
  session_id: session,
  claude_pid: pid,
  source: "startup",
  time: "2026-11-12T10:00:00Z",
  plugin: { version, commit },
  class: classStatus === "ok" ? { status: "ok", sha256: classSha, first_line: "# Class", path: "/x/CLAUDE.md" } : { status: "none", reason: "missing", path: null },
  agents: agentsStatus === "ok" ? { status: "ok", sha256: agentsSha, first_line: "# AGENTS.md", path: "/x/AGENTS.md", repo: "o/team" } : { status: "none", reason: "no-rulebook", path: null },
  posted: false,
  error: "no-channel",
  ...extra,
});

export const NOT_A_FILE = Symbol("not-a-file");

/** What REMOTE_SCRIPT prints. `turn` is the word after `turn` ("missing", "idle p1", ...); `proof`: null (no file), NOT_A_FILE, {raw: text or Buffer}, or an object (as JSON). */
export function renderRemote({ classDisk = SHA("a"), agentsDisk = SHA("b"), session = SESSION, panePid = String(PANE_PID), turn = "missing", turnMtime = "none", now = "none", proof = null } = {}) {
  let line;
  if (proof === null) line = "proof missing";
  else if (proof === NOT_A_FILE) line = "proof not-a-file";
  else line = `proof-hex ${Buffer.from(proof.raw ?? JSON.stringify(proof)).toString("hex")}`;
  return ["rollout-check v2", `class ${classDisk}`, `agents ${agentsDisk}`, `session ${session}`, `pane-pid ${panePid}`, `turn ${turn}`, `turn-mtime ${turnMtime}`, `now ${now}`, line, "end", ""].join("\n");
}

/** What a VM that is fully current prints, for `agent` against main's shas. */
export const currentRemote = (agent, main, extra = {}) =>
  renderRemote({
    classDisk: main.class,
    agentsDisk: agent.team_repo === null ? "skipped" : main.agents,
    proof: proofFor({ classSha: main.class, agentsSha: main.agents }),
    ...extra,
  });

export const ok = (stdout) => ({ status: "ok", code: 0, stdout, stderr: "" });

/**
 * The fake processes of an in-process run: `class-sha <class>`, `agents-sha <owner/repo>` and `fake-ssh <options> <alias> <command>`.
 * `vms[alias]` is the VM's stdout, or a {status, code, stdout} result, or a function of the call returning either.
 */
export function makeWorld({ classes = { "gp-builder": SHA("a") }, repos = { "o/team": SHA("b") }, vms = {} } = {}) {
  const world = { classes, repos, vms, calls: [], ssh: [], sha: [] };
  world.run = async (argv, opts = {}) => {
    world.calls.push({ argv, opts });
    if (argv[0] === "class-sha" || argv[0] === "agents-sha") {
      world.sha.push(argv);
      const table = argv[0] === "class-sha" ? world.classes : world.repos;
      if (world.shaResult) return world.shaResult(argv);
      const value = table[argv[1]];
      return value === undefined ? { status: "ok", code: 1, stdout: "", stderr: "no such thing\n" } : ok(`${value}\n`);
    }
    if (argv[0] === "fake-ssh") {
      const alias = argv[argv.length - 2];
      world.ssh.push({ argv, alias, command: argv[argv.length - 1], input: opts.input, timeoutMs: opts.timeoutMs });
      let vm = world.vms[alias];
      if (typeof vm === "function") vm = await vm(argv, opts);
      if (vm === undefined) return { status: "ok", code: 255, stdout: "", stderr: "ssh: Could not resolve hostname\n" };
      return typeof vm === "string" ? ok(vm) : { stderr: "", ...vm };
    }
    throw new Error(`unexpected process ${argv[0]}`);
  };
  return world;
}

export function makeClock(start = "2026-11-12T10:00:00Z") {
  const clock = { t: Date.parse(start) };
  clock.now = () => new Date(clock.t);
  clock.advance = (ms) => {
    clock.t += ms;
  };
  return clock;
}

export const HOUR = 3600 * 1000;

export function capture() {
  const c = { out: "", err: "" };
  c.stdout = { write: (s) => void (c.out += s) };
  c.stderr = { write: (s) => void (c.err += s) };
  return c;
}

/** Options for runCheck over the validated config. */
export const options = (config, statePath, extra = {}) => ({
  agents: validateConfig(config),
  statePath,
  classShaCmd: "class-sha",
  agentsShaCmd: "agents-sha",
  sshCmd: "fake-ssh -o BatchMode=yes",
  ...extra,
});

/** Every file, link and folder under root, with what a write would change: path, mode, size, mtime and a hash of the bytes. */
export function snapshot(root) {
  const rows = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path, { bigint: true });
      rows.push([path, st.mode, st.size, st.mtimeNs, st.isFile() ? sha256(readFileSync(path)) : ""].join(" "));
      if (st.isDirectory()) walk(path);
    }
  };
  walk(root);
  return rows;
}
