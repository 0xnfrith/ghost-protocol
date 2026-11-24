// gp claude: the agent's Claude sign-in, with no terminal.
//
//   gp claude status   GP_CLAUDE=active or GP_CLAUDE=not-active
//   gp claude login    Claude Code's own sign-in, way A: prints
//                      GP_CLAUDE_LOGIN_URL=<address>, then reads the code the
//                      user got there from stdin (one line; an empty line
//                      is no code, and fails), and ends with
//                      GP_CLAUDE=active, or GP_ERROR=claude-login-failed.
//                      Keep stdin open until the address is shown: the code
//                      goes to the same sign-in that printed it. With stdin
//                      closed before a code, or no code in 15 minutes, it fails.
//   gp claude token    a setup token (claude setup-token) on stdin, way B. It
//                      is tried once (one short claude -p) before it is kept
//                      in the volume (0600); GP_CLAUDE=active, or
//                      GP_ERROR=claude-token-invalid. Never printed.
//   gp claude model    the model and effort the agent's claude runs at:
//                      GP_CLAUDE_MODEL=<model> and GP_CLAUDE_EFFORT=<level>
//                      ("default" for Claude Code's own default). The image
//                      sets claude-opus-5-5 at medium once (setup.mjs).
//   gp claude model <model> [--effort <level>]
//   gp claude model --effort <level>
//                      picks others, in Claude Code's own settings
//                      (~/.claude/settings.json: model, and the effort per
//                      model, modelSettings.<model>.effortLevel), which the
//                      image then never changes. <model> is a full model id
//                      such as claude-sonnet-5-5 (or claude-opus-5-5[1m]); an
//                      alias such as opus is refused, since Claude Code reads
//                      the effort under the full id and a full-id entry beats
//                      an alias's. <level> is low, medium, high, xhigh or max;
//                      "default" for either takes the key out. An effort alone
//                      is for the model set now, which must be a full id. A
//                      settings file that is not a JSON object is refused, and
//                      nothing is written.
// After a new sign-in or model the agent's claude restarts to use it, and
// resumes its conversation.
import { spawn, execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { GpError } from "./out.mjs";
import { L, PLUGIN_ID } from "./layout.mjs";
import { CLAUDE_DEFAULTS, dropEffort, effortOf, readJson, setEffort, writeFileAtomic, writeJson } from "./setup.mjs";
import { claudeActive } from "./status.mjs";
import { firstLine, readStdin, restartAgent } from "./agentctl.mjs";

const CLAUDE = () => process.env.GP_CLAUDE || "claude";
const TOKEN_SHAPE = /^[A-Za-z0-9_\-.]{20,400}$/;

/**
 * The trial's claude arguments. It runs without the plugin and with no MCP
 * server: the plugin's channel would otherwise log in to the relay from the
 * trial, without the owner's tag (which only the agent's own start passes
 * on), and be refused, or hear messages meant for the agent.
 */
export const tokenTrialArgs = () => [
  "-p",
  "Reply with the single word OK.",
  "--max-turns",
  "1",
  "--output-format",
  "json",
  "--strict-mcp-config",
  "--settings",
  JSON.stringify({ enabledPlugins: { [PLUGIN_ID]: false } }),
];

/** One short request with the token; resolves true when it was accepted. */
export function tryToken(token, { timeoutMs = 90000 } = {}) {
  return new Promise((resolve) => {
    execFile(
      CLAUDE(),
      tokenTrialArgs(),
      { env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token }, timeout: timeoutMs, cwd: L.home },
      (err, stdout) => {
        if (err) return resolve(false);
        try {
          resolve(JSON.parse(stdout).is_error !== true);
        } catch {
          resolve(false);
        }
      },
    );
  });
}

export async function token(out, { stdin = readStdin, tryIt = tryToken } = {}) {
  const t = firstLine(stdin()).trim();
  if (!TOKEN_SHAPE.test(t)) throw new GpError("claude-token-invalid", "that is not a Claude setup token (make one with: claude setup-token)");
  out.log("trying the token once");
  if (!(await tryIt(t))) throw new GpError("claude-token-invalid", "Claude did not accept the token; make a new one with: claude setup-token");
  writeFileAtomic(L.token, t + "\n", 0o600);
  out.kv("CLAUDE", "active");
  if (restartAgent()) out.log("the agent restarts to use the new sign-in");
  return 0;
}

const URL_RE = /(https:\/\/\S+\/oauth\/authorize\?\S+)/;

export function login(out, { claude = CLAUDE(), stdin = process.stdin, active = claudeActive, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(claude, ["auth", "login", "--claudeai"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: "", BROWSER: "true" } });
    let shown = false;
    let buf = "";
    const onText = (d) => {
      buf += d.toString("utf8");
      let i;
      while ((i = buf.search(/[\r\n]/)) >= 0 || (!shown && URL_RE.test(buf))) {
        const line = i >= 0 ? buf.slice(0, i) : buf;
        buf = i >= 0 ? buf.slice(i + 1) : "";
        const m = line.match(URL_RE);
        if (m && !shown) {
          shown = true;
          out.kv("CLAUDE_LOGIN_URL", m[1]);
        } else if (line.trim() && !m) out.log(`claude: ${line.trim().replace(/Paste code here if prompted >\s*/, "")}`);
      }
    };
    child.stdout.on("data", onText);
    child.stderr.on("data", onText);
    // The code: the first line on our stdin goes to claude's, once the address is out.
    let sent = false;
    let pending = "";
    stdin.on("data", (d) => {
      if (sent) return;
      pending += d.toString("utf8");
      const nl = pending.indexOf("\n");
      if (nl < 0) return;
      const code = pending.slice(0, nl).trim();
      pending = "";
      // An empty line is no code: the sign-in ends, failed, at once.
      if (!code) {
        sent = true;
        return end();
      }
      const send = () => {
        if (sent) return;
        sent = true;
        child.stdin.write(code + "\n");
      };
      if (shown) send();
      else {
        const wait = setInterval(() => {
          if (shown || child.exitCode !== null) {
            clearInterval(wait);
            send();
          }
        }, 100);
      }
    });
    // No code (stdin closed first), or none in time: the sign-in ends, failed.
    const end = () => {
      child.stdin.end();
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref();
    };
    stdin.on("end", () => {
      if (!sent) end();
    });
    const limit = setTimeout(end, timeoutMs);
    child.on("error", () => reject(new GpError("claude-login-failed", "could not run claude auth login")));
    child.on("exit", (code) => {
      clearTimeout(limit);
      stdin.pause?.();
      if (code === 0 && active()) {
        try {
          unlinkSync(L.token);
        } catch {
          // none
        }
        out.kv("CLAUDE", "active");
        if (restartAgent()) out.log("the agent restarts to use the new sign-in");
        resolve(0);
      } else reject(new GpError("claude-login-failed", "the sign-in did not finish; the code may be wrong, incomplete or expired, so start again for a new address"));
    });
  });
}

// A full model id, with an optional date (-YYYYMMDD or @YYYYMMDD) and [1m].
// Claude Code reads the effort under the plain id (group 1): an entry under
// claude-opus-5-5[1m] loses to one under claude-opus-5-5, and so does an alias's.
const MODEL_ID = /^(claude-[a-z0-9]+(?:-[a-z0-9]+)*?)(?:-\d{8}|@\d{8})?(?:\[1m\])?$/;
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

/** The modelSettings key Claude Code reads a model's effort from, or null for what is not a full model id. */
export function effortKey(m) {
  const r = typeof m === "string" && m.length <= 100 ? MODEL_ID.exec(m) : null;
  return r ? r[1] : null;
}

/** ~/.claude/settings.json, strictly: {} when there is none, else a JSON object, or a bad-settings refusal. */
function readSettingsStrict() {
  if (!existsSync(L.claudeSettings)) return {};
  let v;
  try {
    const text = readFileSync(L.claudeSettings, "utf8");
    v = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new GpError("bad-settings", `${L.claudeSettings} is not valid JSON; fix it by hand first (nothing was written)`);
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new GpError("bad-settings", `${L.claudeSettings} is not a JSON object; fix it by hand first (nothing was written)`);
  return v;
}

/** gp claude model [<model>] [--effort <level>]: shows, or picks, the model and effort. */
export function model(argv, out, { restart = restartAgent, now = new Date() } = {}) {
  let want;
  let effort;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--effort") {
      if (effort !== undefined || i + 1 >= argv.length) throw new GpError("usage", "usage: gp claude model [<model>] [--effort <level>]", 2);
      effort = argv[++i];
    } else if (want === undefined && !a.startsWith("-")) want = a;
    else throw new GpError("usage", "usage: gp claude model [<model>] [--effort <level>]", 2);
  }
  if (want !== undefined && want !== "default" && !effortKey(want))
    throw new GpError("bad-model", `use a full model id such as claude-sonnet-5-5 or ${CLAUDE_DEFAULTS.model}, not ${want.slice(0, 100)} (an alias is not taken: Claude Code reads the effort under the full id)`);
  if (effort !== undefined && effort !== "default" && !EFFORTS.includes(effort)) throw new GpError("bad-effort", `the effort is one of ${EFFORTS.join(", ")}, or default`);
  const s = readSettingsStrict();
  if (s.modelSettings !== undefined && (typeof s.modelSettings !== "object" || s.modelSettings === null || Array.isArray(s.modelSettings)))
    throw new GpError("bad-settings", `modelSettings in ${L.claudeSettings} is not an object; fix it by hand first`);
  // Claude Code keeps an effort per model, under its plain id: the model named,
  // else the one set now.
  const target = effortKey(want !== undefined && want !== "default" ? want : want === undefined ? s.model : undefined);
  if (effort !== undefined && !target)
    throw new GpError("effort-needs-model", `Claude Code keeps an effort per model: name a full model id too, for example gp claude model ${CLAUDE_DEFAULTS.model} --effort ${effort}`);
  if (want !== undefined || effort !== undefined) {
    const seen = readJson(L.claudeDefaults);
    if (want !== undefined) {
      if (want === "default") delete s.model;
      else s.model = want;
      // The owner's pick: the image's setup never sets this again.
      seen.model = { owner: want, at: now.toISOString() };
    }
    if (effort !== undefined) {
      if (effort === "default") dropEffort(s, target);
      else setEffort(s, target, effort);
      if (target === CLAUDE_DEFAULTS.model) seen.effort = { owner: effort, at: now.toISOString() };
    }
    writeJson(L.claudeSettings, s);
    writeJson(L.claudeDefaults, seen);
  }
  out.kv("CLAUDE_MODEL", s.model ?? "default");
  // For a model set by hand as an alias, the effort Claude Code uses cannot be told from here.
  const shown = s.model === undefined ? "default" : effortKey(s.model) ? effortOf(s, effortKey(s.model)) || "default" : "unknown";
  out.kv("CLAUDE_EFFORT", shown);
  if ((want !== undefined || effort !== undefined) && restart()) out.log("the agent restarts to use it, and resumes its conversation");
  return 0;
}

export async function claude(argv, out) {
  const [sub, ...rest] = argv;
  if (sub === "model") {
    out.header();
    return model(rest, out);
  }
  if (!["status", "login", "token"].includes(sub) || rest.length) throw new GpError("usage", "usage: gp claude status | login | token | model [<model>] [--effort <level>]", 2);
  out.header();
  if (sub === "status") {
    out.kv("CLAUDE", claudeActive() ? "active" : "not-active");
    return 0;
  }
  if (sub === "token") return await token(out);
  return await login(out);
}
