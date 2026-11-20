// The states an agent can be in (README.md). Apart from lib.mjs so that plan.mjs can name them without importing lib.mjs back.
export const STATES = Object.freeze({
  CURRENT: "current",
  NOT_PROVED: "applied, not proved",
  // Both files match main and the proof is not there yet, for an agent that restarts itself when its task is done (a builder or a
  // reviewer): expected, so quiet for AT_DONE_QUIET_MS in the printed line.
  AT_DONE: "applied, restarts at Done",
  BEHIND: "behind on disk",
  UNKNOWN: "unknown",
});

/** The roles an agent can have in the config. Only a lead is ever restarted by this tool. */
export const ROLES = Object.freeze(["lead", "builder", "reviewer", "other"]);

/** An agent that restarts itself when its task is done. */
export const restartsAtDone = (role) => role === "builder" || role === "reviewer";

/** How long `applied, restarts at Done` stays out of the printed line. */
export const AT_DONE_QUIET_MS = 3 * 24 * 3600 * 1000;
