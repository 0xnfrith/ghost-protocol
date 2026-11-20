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
// After a new sign-in the agent's claude restarts to use it.
import { spawn, execFile } from "node:child_process";
import { unlinkSync } from "node:fs";
import { GpError } from "./out.mjs";
import { L, PLUGIN_ID } from "./layout.mjs";
import { writeFileAtomic } from "./setup.mjs";
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

export async function claude(argv, out) {
  const [sub, ...rest] = argv;
  if (!["status", "login", "token"].includes(sub) || rest.length) throw new GpError("usage", "usage: gp claude status | login | token", 2);
  out.header();
  if (sub === "status") {
    out.kv("CLAUDE", claudeActive() ? "active" : "not-active");
    return 0;
  }
  if (sub === "token") return await token(out);
  return await login(out);
}
