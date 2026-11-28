// The agent's setup at each container start, run by the entrypoint before it
// hands over to install/service/start. It writes, in the data volume:
//   - Claude Code's own state: onboarding done, the instance's home trusted;
//   - the plugin's options, in ~/.claude/settings.json and in the instance's
//     settings file (start's GP_SETTINGS), with unattended on and load_proof off;
//   - the persona, from the image's persona/agent.md with the name filled in;
//   - the instance's home, a git checkout with a minimal instance manifest;
//   - Claude Code's model and its effort, once per volume, where the owner set
//     none (claudeDefaults);
//   - GHOST Protocol's workspace layout around the home, by the installer's own
//     layout step (install/lib/layout.sh): the shared folders, the worktree
//     hook and the folders in permissions.additionalDirectories (layout);
//   - a CLAUDE.md in the home that describes that layout, from the image's
//     persona/agent-workspace.md, never over one the owner wrote (claudeMd).
// The agent's settings come from .gp/config.json (init writes it). For a start
// with an env file instead, the older way, these seed the volume first:
//   GP_RELAY_KEY (the agent's secret key), BUZZ_RELAY_URL, BUZZ_ALLOWED_PUBKEYS
//   (its first key is the owner, the others go in the allowlist file), BUZZ_AUTH_TAG, CLAUDE_CODE_OAUTH_TOKEN, GP_NAME.
// Prints one line, "ok", or "error <reason>", and never a secret.
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readJson, writeFileAtomic, writeJson } from "./files.mjs";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { DATA, L, NAME, ROOT, PLUGIN_ID } from "./layout.mjs";
import { GP_ROOT } from "./paths.mjs";
import { addLocal, ensureAllowlist } from "./allow.mjs";

export { readJson, writeFileAtomic, writeJson } from "./files.mjs";

// A line for the container's log (stderr): stdout carries only the result.
const note = (line) => process.stderr.write(`setup: ${line}\n`);

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
  // The first key is the owner. The others are senders and go in the allowlist file (allow.mjs), never in the owner's place.
  const keys = v("BUZZ_ALLOWED_PUBKEYS").split(",").map((k) => k.trim()).filter(Boolean);
  if (keys.length) (cfg.owner = keys[0]), (changed = true);
  if (v("BUZZ_CHANNELS")) (cfg.channels = v("BUZZ_CHANNELS")), (changed = true);
  if (v("GP_NAME")) (cfg.name = v("GP_NAME")), (changed = true);
  if (changed) {
    cfg.name ??= "GHOST";
    cfg.slug = slugOf(cfg.name);
    writeJson(L.config, cfg);
  }
  if (keys.length > 1) {
    ensureAllowlist();
    for (const k of keys.slice(1)) if (!/^[0-9a-f]{64}$/.test(k)) note("BUZZ_ALLOWED_PUBKEYS: a key after the owner's is not 64 lower-case hex characters, and is left out");
    else addLocal(k, cfg.owner);
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
    buzz_allowlist_file: L.allowlist,
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

// The model and effort an agent runs at unless its owner picks others (gp claude
// model). Claude Code keeps an effort per model, in its settings'
// modelSettings.<model>.effortLevel: a top-level effortLevel in the user's
// settings is an older key that it no longer reads for current models.
export const CLAUDE_DEFAULTS = { model: "claude-opus-5-5", effort: "medium" };

export const effortOf = (s, m) => (s.modelSettings && typeof s.modelSettings === "object" ? s.modelSettings[m]?.effortLevel : undefined);
export function setEffort(s, m, level) {
  if (s.modelSettings === undefined || s.modelSettings === null) s.modelSettings = {};
  s.modelSettings[m] = { ...(s.modelSettings[m] ?? {}), effortLevel: level };
}
export function dropEffort(s, m) {
  const e = s.modelSettings?.[m];
  if (!e || typeof e !== "object") return;
  delete e.effortLevel;
  if (!Object.keys(e).length) delete s.modelSettings[m];
  if (!Object.keys(s.modelSettings).length) delete s.modelSettings;
}

/**
 * Puts CLAUDE_DEFAULTS into Claude Code's user settings s (model, and
 * modelSettings.<that model>.effortLevel), once per volume and key: a value the
 * settings already have is the owner's and stays as it is, and a key the image
 * has had its turn at (in .gp/claude-defaults.json) is never set again, so an
 * owner who takes one out gets Claude Code's own default. An older volume
 * upgrades the same way: nothing set, the defaults go in; a model or effort
 * set before stays. Returns the keys it set, and the record for
 * .gp/claude-defaults.json when that changed (else null).
 */
export function claudeDefaults(s, now = new Date()) {
  const seen = readJson(L.claudeDefaults);
  const m = CLAUDE_DEFAULTS.model;
  const keys = {
    model: { get: () => s.model, set: () => (s.model = m) },
    effort: {
      get: () => (s.modelSettings === undefined || s.modelSettings === null || (typeof s.modelSettings === "object" && !Array.isArray(s.modelSettings)) ? effortOf(s, m) : "not-an-object"),
      set: () => setEffort(s, m, CLAUDE_DEFAULTS.effort),
    },
  };
  const set = [];
  let changed = false;
  for (const [k, { get, set: put }] of Object.entries(keys)) {
    if (seen[k]) continue;
    changed = true;
    const had = get();
    if (had === undefined || had === null) {
      put();
      set.push(k);
      seen[k] = { set: CLAUDE_DEFAULTS[k], at: now.toISOString() };
    } else seen[k] = { kept: had, at: now.toISOString() };
  }
  return { set, seen: changed ? seen : null };
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

export function claudeMdText() {
  const tpl = readFileSync(join(GP_ROOT, "persona", "agent-workspace.md"), "utf8");
  return tpl.replaceAll("{{root}}", ROOT).replaceAll("{{home}}", L.home);
}

/**
 * The home's CLAUDE.md, the layout for the agent's first message. Written when
 * there is none; replaced only while it is the copy the image last wrote
 * (its sha256 in .gp/claude-md.json), so a newer image brings its newer text;
 * an edited file, or one the image never wrote (the owner's own), is kept.
 * Returns written, updated, current or kept.
 */
export function claudeMd() {
  const text = claudeMdText();
  const want = sha256(text);
  const st = readJson(L.claudeMdState);
  let cur = null;
  try {
    const l = lstatSync(L.claudeMd);
    cur = l.isFile() ? sha256(readFileSync(L.claudeMd)) : "not-a-file";
  } catch {
    // none
  }
  if (cur === want) {
    if (st.sha256 !== want) writeJson(L.claudeMdState, { sha256: want });
    return "current";
  }
  if (cur !== null && cur !== st.sha256) return "kept";
  writeFileAtomic(L.claudeMd, text, 0o644);
  writeJson(L.claudeMdState, { sha256: want });
  return cur === null ? "written" : "updated";
}

// The installer's layout step for <root>, sourced from the image's checkout.
// Its lines go to stderr (the container's log); the last line on stdout is
// "<1 when a folder's place held something else, else 0> <hook state> <dirs state>".
const LAYOUT_SH = `set -u
GP_DIR=$1
. "$GP_DIR/install/lib/common.sh"
. "$GP_DIR/install/lib/instance.sh"
. "$GP_DIR/install/lib/layout.sh"
bad=0
layout_make_dirs "$2" 0 >&2 || bad=1
layout_wire_hook "$2" 0 >&2
layout_add_dirs "$2" 0
[ "$DIRS_STATE" = already ] || say "$DIRS_LINE" >&2
printf '%s %s %s\n' "$bad" "$HOOK_STATE" "$DIRS_STATE"
`;

/**
 * GHOST Protocol's workspace layout around the home, as the installer builds
 * it for every instance (docs/layout.md): the shared folders beside the home,
 * the worktree hook and the shared folders in permissions.additionalDirectories
 * of ~/.claude/settings.json (a jq merge that keeps every other key and entry,
 * with no pruning of another root's entries). Each part
 * already there is left as it is; a part that cannot be done is said in the
 * log and the start goes on. Returns { bad, hook, dirs, log }.
 */
export function layout() {
  const r = spawnSync("bash", ["-c", LAYOUT_SH, "layout", GP_ROOT, ROOT], {
    encoding: "utf8",
    // LAYOUT_PRUNE=false, as the installer's update does: only add. Shared
    // folders the owner put in the list under another parent stay there.
    env: { ...process.env, HOME: DATA, LAYOUT_PRUNE: "false" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const last = String(r.stdout ?? "").trim().split("\n").pop() ?? "";
  const [bad, hook, dirs] = /^[01] \S+ \S+$/.test(last) ? last.split(" ") : ["1", "not", "not"];
  const log = String(r.stderr ?? "") + (r.error ? `${r.error.message}\n` : "") + (r.status ? `the layout step ended with ${r.status}\n` : "");
  return { bad: bad !== "0", hook, dirs, log };
}

export function setup(env = process.env) {
  seedFromEnv(env);
  for (const d of [dirname(L.key), L.buzz, L.home, dirname(L.manifest), dirname(L.claudeSettings), L.startState]) mkdirSync(d, { recursive: true, mode: 0o700 });
  const cfg = readJson(L.config);
  if (!cfg.relay_url || !cfg.owner) return "error not set up: run init first (no relay or owner)";
  ensureAllowlist();
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
  const defaults = claudeDefaults(s);
  writeJson(L.claudeSettings, s);
  if (defaults.seen) writeJson(L.claudeDefaults, defaults.seen);
  if (defaults.set.includes("model")) note(`Claude Code's model set to ${CLAUDE_DEFAULTS.model} (the owner had set none)`);
  if (defaults.set.includes("effort")) note(`Claude Code's effort for ${CLAUDE_DEFAULTS.model} set to ${CLAUDE_DEFAULTS.effort} (the owner had set none)`);
  writeJson(L.settings, { pluginConfigs: { [PLUGIN_ID]: { options: opts } } });

  const tpl = readFileSync(join(GP_ROOT, "persona", "agent.md"), "utf8");
  writeFileAtomic(L.persona, tpl.replaceAll("{{name}}", cfg.name || "GHOST"), 0o644);

  if (!existsSync(join(L.home, ".git"))) execFileSync("git", ["init", "-q", L.home]);
  writeFileAtomic(L.manifest, manifestText(), 0o644);

  const lay = layout();
  for (const line of lay.log.split("\n")) if (line.trim()) note(`layout: ${line.trim()}`);
  if (lay.bad || lay.hook === "not" || lay.dirs === "not") note(`layout: not all of it is in place (folders ${lay.bad ? "in the way" : "ok"}, worktree hook ${lay.hook}, shared folders ${lay.dirs}); the start goes on`);
  const md = claudeMd();
  if (md === "kept") note(`${L.claudeMd} is not the copy GHOST Protocol wrote: kept as it is`);
  else if (md !== "current") note(`${L.claudeMd} ${md}`);
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
