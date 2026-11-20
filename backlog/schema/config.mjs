// config.mjs: the backlog's settings, read the same way by every tool in this folder.
//
// Four settings (declared in .claude-plugin/plugin.json as backlog_<name>):
//   prefix          the item id prefix: 2 to 12 capital letters, not ARC or INIT. Default BL.
//   dir             the data folder, relative to the repository root. Default backlog.
//   operator_names  comma-separated names the operator goes by (the word `operator` always counts).
//   profile         absolute path of a profile file that adds record types (schema/profile.mjs).
//
// Where a setting comes from, first match wins:
//   1. a flag the tool was given (loadConfig's `flags`);
//   2. BACKLOG_<NAME> in the environment, for CI;
//   3. CLAUDE_PLUGIN_OPTION_BACKLOG_<NAME>, which Claude Code exports to a plugin's hooks;
//   4. the plugin's entry under pluginConfigs in the user's settings.json (CLAUDE_CONFIG_DIR, else
//      ~/.claude), the same entry install/service/start reads. Project and local settings are never read;
//   5. the default.
// Unset and empty both fall through to the next source.
//
// A bad value is never a reason to block a record write: it is dropped, the default is used, and the
// problem comes back in `problems`, for the caller to show as a non-blocking line.
//
// Reads only; no side effects. Depends on nothing outside node's own modules, so a records repository's CI can
// check out schema/ alone.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const PLUGIN_ID = "ghost-protocol@ghost-protocol";
export const RESERVED_PREFIXES = ["ARC", "INIT"];
export const MAX_OPERATOR_NAMES = 8;

const NAME_RE = /^[A-Za-z](?:[A-Za-z0-9 .'-]{0,38}[A-Za-z0-9])?$/;
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** Each setting: its plugin option, its default, and its check (a value in, the clean value or a throw out). */
const SETTINGS = {
  prefix: {
    option: "backlog_prefix",
    def: "BL",
    check(v) {
      if (!/^[A-Z]{2,12}$/.test(v)) throw new Error("must be 2 to 12 capital letters");
      if (RESERVED_PREFIXES.includes(v)) throw new Error(`${v} is reserved for arcs and initiatives`);
      return v;
    },
  },
  dir: {
    option: "backlog_dir",
    def: "backlog",
    check(v) {
      const segments = v.split("/");
      if (segments.length > 3) throw new Error("must be at most 3 path segments");
      for (const s of segments) {
        if (s === "." || s === "..") throw new Error("must not contain a . or .. segment");
        if (!SEGMENT_RE.test(s)) throw new Error("segments may hold only letters, digits, . _ -, and the path must be relative");
      }
      return v;
    },
  },
  operator_names: {
    option: "backlog_operator_names",
    def: "",
    check: (v) => v, // checked name by name in operatorNames()
  },
  profile: {
    option: "backlog_profile",
    def: "",
    check(v) {
      if (!isAbsolute(v)) throw new Error("must be an absolute path");
      return v;
    },
  },
};

/** The names in a comma-separated list that pass, and one problem for each that does not. */
export function operatorNames(text) {
  const names = [];
  const problems = [];
  for (const raw of String(text).split(",")) {
    const name = raw.trim();
    if (name === "") continue;
    if (!NAME_RE.test(name)) {
      problems.push(`backlog_operator_names: "${name}" is not used (an ASCII letter first, an ASCII letter or digit last, at most 40 characters, and only letters, digits, space, . ' - between)`);
    } else if (names.length >= MAX_OPERATOR_NAMES) {
      problems.push(`backlog_operator_names: "${name}" is not used (at most ${MAX_OPERATOR_NAMES} names)`);
    } else if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) {
      names.push(name);
    }
  }
  return { names, problems };
}

/** The plugin's saved options from the user's settings.json: { options, problem }. Never throws. */
export function readPluginOptions(env = process.env) {
  const base = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude");
  let data;
  try {
    data = JSON.parse(readFileSync(join(base, "settings.json"), "utf8"));
  } catch {
    return { options: {} };
  }
  const configs = data && typeof data.pluginConfigs === "object" && data.pluginConfigs ? data.pluginConfigs : null;
  if (!configs) return { options: {} };
  let entry = configs[PLUGIN_ID];
  if (entry === undefined) {
    const keys = Object.keys(configs).filter((k) => k.startsWith("ghost-protocol@"));
    if (keys.length > 1) return { options: {}, problem: `settings.json holds several ${"ghost-protocol@"} entries under pluginConfigs (${keys.join(", ")}): none is used` };
    if (keys.length === 1) entry = configs[keys[0]];
  }
  const options = entry && typeof entry.options === "object" && entry.options ? entry.options : {};
  return { options };
}

/**
 * loadConfig({ flags, env }) -> { config, problems, sources }
 *   config   { prefix, dir, dirSegments, operatorNames, profile }
 *   problems one line per bad value (not blocking), for the caller to show
 *   sources  where each setting came from: flag, env, hook, settings or default
 */
export function loadConfig({ flags = {}, env = process.env } = {}) {
  const problems = [];
  const sources = {};
  const values = {};
  let saved = null;
  const lazySaved = () => {
    if (!saved) {
      saved = readPluginOptions(env);
      if (saved.problem) problems.push(saved.problem);
    }
    return saved.options;
  };
  const nonEmpty = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

  for (const [name, setting] of Object.entries(SETTINGS)) {
    const upper = name.toUpperCase();
    const candidates = [
      ["flag", () => nonEmpty(flags[name])],
      ["env", () => nonEmpty(env[`BACKLOG_${upper}`])],
      ["hook", () => nonEmpty(env[`CLAUDE_PLUGIN_OPTION_BACKLOG_${upper}`])],
      ["settings", () => nonEmpty(lazySaved()[setting.option])],
    ];
    let chosen = { value: setting.def, source: "default" };
    for (const [source, get] of candidates) {
      const v = get();
      if (v === null) continue;
      try {
        chosen = { value: setting.check(v), source };
      } catch (e) {
        problems.push(`${setting.option}: "${v}" is not used (${e.message})`);
        continue;
      }
      break;
    }
    values[name] = chosen.value;
    sources[name] = chosen.source;
  }

  const names = operatorNames(values.operator_names);
  problems.push(...names.problems);
  return {
    config: {
      prefix: values.prefix,
      dir: values.dir,
      dirSegments: values.dir.split("/"),
      operatorNames: names.names,
      profile: values.profile,
    },
    problems,
    sources,
  };
}
