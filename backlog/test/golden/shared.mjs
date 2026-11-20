// What the golden maker and the golden test share: how the new validator is run on a record, and how the goldens are
// written (ASCII only: every non-ASCII character is a \u escape, so the file is safe to carry as plain text).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GIT_ENV } from "../fixtures/store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const VALIDATE = join(here, "..", "..", "schema", "validate");
export const PROFILE = join(here, "..", "fixtures", "profile.json");

/** Runs this folder's validator on one record of the fixture store, with the fixture's settings. */
export const runNew = (path, env = {}) => {
  const r = spawnSync(process.execPath, [VALIDATE, path], { env: { ...GIT_ENV, BACKLOG_PREFIX: "ALPHA", BACKLOG_PROFILE: PROFILE, ...env }, encoding: "utf8" });
  return { code: r.status, stderr: r.stderr };
};

export const toJson = (value) => `${JSON.stringify(value, null, 1).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
