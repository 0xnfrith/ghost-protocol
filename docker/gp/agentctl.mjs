// Small things the commands share: reading stdin, and restarting the agent's
// claude so that a new tag or sign-in reaches it.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { L, NAME } from "./layout.mjs";

/** The first line of s (the commands that read stdin read one line). */
export const firstLine = (s) => String(s).split(/\r?\n/)[0];

export function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** Ends the agent's tmux session; the entrypoint then starts start again, which reads the volume anew. */
export function restartAgent() {
  let phase = "";
  try {
    phase = readFileSync(L.agentState, "utf8").split(/\s+/)[0];
  } catch {
    return false;
  }
  if (phase !== "running") return false;
  try {
    execFileSync("tmux", ["-L", NAME, "kill-server"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
