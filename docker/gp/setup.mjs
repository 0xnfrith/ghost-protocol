// The agent's setup at each container start, run by the entrypoint before it
// hands over to install/service/start. It writes, in the data volume:
//   - Claude Code's own state: onboarding done, the instance's home trusted;
//   - the plugin's options, in ~/.claude/settings.json and in the instance's
//     settings file (start's GP_SETTINGS), with unattended on and load_proof off;
//   - the persona, from the image's persona/agent.md with the name filled in;
//   - the instance's home, a git checkout with a minimal instance manifest.
// The agent's settings come from .gp/config.json (init writes it). For a start
// with an env file instead, the older way, these seed the volume first:
//   GP_RELAY_KEY (the agent's secret key), BUZZ_RELAY_URL, BUZZ_ALLOWED_PUBKEYS
//   (its first key is the owner), BUZZ_AUTH_TAG, CLAUDE_CODE_OAUTH_TOKEN, GP_NAME.
// Prints one line, "ok", or "error <reason>", and never a secret.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { readJson, writeFileAtomic, writeJson } from "./files.mjs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { L, NAME, ROOT, PLUGIN_ID } from "./layout.mjs";
import { GP_ROOT } from "./paths.mjs";

export { readJson, writeFileAtomic, writeJson } from "./files.mjs";

export function slugOf(name) {
  const s = String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s.slice(0, 40).replace(/-+$/, "") || "agent";
}

/** Seeds the volume from the environment, for a start with an env file. */
export function seedFromEnv(env) {
  const v = (n) => (env[n] ?? "").trim();
  if (v("GP_RELAY_KEY")) writeFileAtomic(L.key, v("GP_RELAY_KEY") + "\n");
  if (v("BUZZ_AUTH_TAG")) writeFileAtomic(L.tag, v("BUZZ_AUTH_TAG") + "\n", 0o644);
  if (v("CLAUDE_CODE_OAUTH_TOKEN")) writeFileAtomic(L.token, v("CLAUDE_CODE_OAUTH_TOKEN") + "\n");
  const cfg = readJson(L.config);
  let changed = false;
  if (v("BUZZ_RELAY_URL")) (cfg.relay_url = v("BUZZ_RELAY_URL")), (changed = true);
  if (v("BUZZ_ALLOWED_PUBKEYS")) (cfg.owner = v("BUZZ_ALLOWED_PUBKEYS").split(",")[0].trim()), (changed = true);
  if (v("BUZZ_CHANNELS")) (cfg.channels = v("BUZZ_CHANNELS")), (changed = true);
  if (v("GP_NAME")) (cfg.name = v("GP_NAME")), (changed = true);
  if (changed) {
    cfg.name ??= "GHOST";
    cfg.slug = slugOf(cfg.name);
    writeJson(L.config, cfg);
  }
}

export function pluginOptions(cfg) {
  return {
    buzz_relay_url: cfg.relay_url,
    buzz_key_command: `cat ${L.key}`,
    buzz_key_socket: "",
    buzz_channels: cfg.channels || "*",
    buzz_dm_messages: "all",
    buzz_allowed_pubkeys: cfg.owner,
    buzz_trusted_pubkeys: cfg.owner,
    buzz_operator_pubkeys: cfg.owner,
    unattended: "on",
    load_proof: "off",
  };
}

export function manifestText() {
  // Schema v1, so the plugin's hooks know the instance. The installer's keys
  // ([github], [claude], [setup]) are required by the schema but never read in
  // the image: the image has no GitHub sign-in and no installer run.
  return [
    "# The instance manifest of a GHOST Protocol agent in its container.",
    "# Written by the image at each start; edits are replaced.",
    'schema = "ghost-protocol/instance/v1"',
    `name = "${NAME}"`,
    `root = "${ROOT}"`,
    "",
    "[github]",
    'login = "none"',
    "",
    "[claude]",
    'email = "agent@example.com"',
    "",
    "[setup]",
    'command = "none"',
    "",
    "[memory_guard]",
    'enabled = "false"',
    "",
    "[automode_guard]",
    'enabled = "false"',
    "",
    "[memory_backup]",
    'enabled = "false"',
    "",
  ].join("\n");
}

export function setup(env = process.env) {
  seedFromEnv(env);
  for (const d of [dirname(L.key), L.buzz, L.home, dirname(L.manifest), dirname(L.claudeSettings), L.startState]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const cfg = readJson(L.config);
  if (!cfg.relay_url || !cfg.owner) return "error not set up: run init first (no relay or owner)";
  if (!existsSync(L.key)) return "error not set up: run init first (no agent key)";

  const cj = readJson(L.claudeJson);
  cj.hasCompletedOnboarding = true;
  cj.projects ??= {};
  cj.projects[L.home] = { ...(cj.projects[L.home] ?? {}), hasTrustDialogAccepted: true };
  writeJson(L.claudeJson, cj);

  const opts = pluginOptions(cfg);
  const s = readJson(L.claudeSettings);
  s.pluginConfigs ??= {};
  s.pluginConfigs[PLUGIN_ID] = { ...(s.pluginConfigs[PLUGIN_ID] ?? {}), options: { ...(s.pluginConfigs[PLUGIN_ID]?.options ?? {}), ...opts } };
  s.permissions ??= {};
  s.permissions.allow = [...new Set([...(s.permissions.allow ?? []), "mcp__plugin_ghost-protocol_buzz", "mcp__plugin_ghost-protocol_buzz-channel"])].sort();
  writeJson(L.claudeSettings, s);
  writeJson(L.settings, { pluginConfigs: { [PLUGIN_ID]: { options: opts } } });

  const tpl = readFileSync(join(GP_ROOT, "persona", "agent.md"), "utf8");
  writeFileAtomic(L.persona, tpl.replaceAll("{{name}}", cfg.name || "GHOST"), 0o644);

  if (!existsSync(join(L.home, ".git"))) execFileSync("git", ["init", "-q", L.home]);
  writeFileAtomic(L.manifest, manifestText(), 0o644);
  return "ok";
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.umask(0o077);
  let r;
  try {
    r = setup();
    // An update to this image's version is done once it starts (update.mjs).
    if (r === "ok") (await import("./update.mjs")).finish();
  } catch (err) {
    r = `error ${String(err?.message ?? err).split("\n")[0]}`;
  }
  process.stdout.write(r + "\n");
  process.exitCode = r === "ok" ? 0 : 1;
}
