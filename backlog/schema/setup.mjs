/**
 * schema/setup.mjs: what every command line in this folder does first: take the settings flags off the
 * arguments, read the settings, load the profile, and build the rules.
 *
 * Flags, always before the other arguments: --prefix X, --dir D, --operator-names a,b, --profile FILE (a relative
 * FILE is resolved from the working folder). Everything else is left in `rest`, in order.
 *
 * Returns { config, problems, profileProblem, sources, rules, rest }:
 *   problems        one line per bad setting (not blocking)
 *   profileProblem  why the profile could not be used, or null. The rules are then the generic ones, and a
 *                   caller that judges records must say so rather than judge them wrongly.
 */
import { resolve } from "node:path";
import { loadConfig } from "./config.mjs";
import { loadProfileFile } from "./profile.mjs";
import { createRules } from "./record-rules.mjs";

export function setup(argv, env = process.env) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--prefix") flags.prefix = argv[++i];
    else if (a === "--dir") flags.dir = argv[++i];
    else if (a === "--operator-names") flags.operator_names = argv[++i];
    else if (a === "--profile") flags.profile = argv[++i] === undefined ? undefined : resolve(argv[i]);
    else rest.push(a);
  }
  const { config, problems, sources } = loadConfig({ flags, env });
  let profile = null;
  let profileProblem = null;
  if (config.profile) ({ profile, problem: profileProblem } = loadProfileFile(config.profile));
  const rules = createRules({ operatorNames: config.operatorNames, profile });
  return { config, problems, profileProblem, sources, rules, rest };
}
