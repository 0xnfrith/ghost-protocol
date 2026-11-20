// gp update: updates and the way back, inside the agent's container. The swap
// itself is the update helper's (updater.mjs), a second container from the
// same image that holds the Docker socket; the agent's own container never
// does. The two talk only through these commands, which the helper runs with
// docker exec, and the files they keep in the data volume (layout.mjs).
//
// For the plugin, the agent and people:
//   gp update request    ask for the update to the version on offer: GP_UPDATE=requested.
//                        The agent finishes its task first; the helper swaps once
//                        it is idle (start's idle test).
//   gp update rollback   ask to go back to the previous version: GP_UPDATE=rollback-requested.
//   Both fail with GP_ERROR=no-updater when no helper has been seen in the last
//   minute, no-update-available or no-previous-version when there is nothing to
//   do, and update-in-progress while one is asked for or under way.
//   gp update offer <version> [--image <repo>:<version>@sha256:<64 hex>]
//                        note that <version> is out, pinned by digest (a test's;
//                        the release check pins it from the release manifest).
//   gp update check      look for a newer release now (watch.mjs)
//   gp update watch      the agent's release check and notes, run by the entrypoint (watch.mjs)
//
// For the helper (one call every few seconds):
//   gp update poll       marks the helper seen; prints GP_VERSION, GP_UPDATE_REQUEST
//                        (none, update or rollback) and GP_UPDATE_VERSION.
//   gp update begin      once the agent is idle: writes the handoff note and the
//                        update state (gp status says updating) and takes the
//                        request: GP_UPDATE=begun; or GP_UPDATE=busy, to try again.
//   gp update failed [--reason <words>]   after the helper went back to this
//                        version (the new one failed its check, or did not pull).
//
// The new container finishes the update itself (finish, below): at its start
// and at any gp status, an update state whose target is this version is done.
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { GpError } from "./out.mjs";
import { L, ROOT, NAME } from "./layout.mjs";
import { readJson, writeJson, writeFileAtomic } from "./files.mjs";
import { GP_ROOT } from "./paths.mjs";
import { offer } from "./releases.mjs";

export const SEEN_FRESH_MS = 60 * 1000;
export const STALE_MS = 15 * 60 * 1000;
/** How long gp status shows a failed update as state error (update-failed or rollback-failed). */
export const FAILED_SHOWN_MS = 10 * 60 * 1000;
const VERSION_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

const read = (p) => {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
};
const rm = (p) => {
  try {
    unlinkSync(p);
  } catch {
    // none
  }
};
const currentVersion = () => process.env.GP_IMAGE_VERSION || read("/etc/gp-image-version") || "unknown";

/** The update state ({state, action, from, to, at}) or null. */
export const updateState = () => readJson(L.updateState, null);
export const pendingRequest = () => readJson(L.updateRequest, null);
export const updaterSeen = (now = Date.now()) => {
  const t = Date.parse(read(L.updaterSeen));
  return Number.isFinite(t) && now - t < SEEN_FRESH_MS;
};

function handoff(note) {
  writeJson(L.handoff, { ...note, at: new Date().toISOString() }, 0o644);
}

/**
 * Settles an update state against the version this container runs. Its
 * target here: done (the swap worked). Not its target and older than
 * STALE_MS: the helper never finished, so it is dropped as failed. Returns
 * what it did: "done", "stale" or null.
 */
export function finish({ version = currentVersion(), now = Date.now() } = {}) {
  const u = updateState();
  if (!u) return null;
  if (u.to === version) {
    if (u.action === "rollback") {
      rm(L.previousVersion);
      offer(u.from); // pinned as the release check saw it

    } else {
      writeFileAtomic(L.previousVersion, u.from + "\n", 0o644);
      const avail = readJson(L.updateAvailable, null);
      if (!avail || avail.version === version) rm(L.updateAvailable);
    }
    handoff({ action: u.action, from: u.from, to: u.to, result: "done", told: false });
    rm(L.updateState);
    return "done";
  }
  if (now - Date.parse(u.at) > STALE_MS) {
    handoff({ action: u.action, from: u.from, to: u.to, result: "failed", reason: "the swap did not finish", told: false });
    rm(L.updateState);
    return "stale";
  }
  return null;
}

/** Whether the agent is idle, by start's own idle test; an agent whose claude is not running is idle. */
export function agentIdle() {
  const phase = read(L.agentState).split(/\s+/)[0];
  if (phase !== "running") return { idle: true };
  try {
    execFileSync(`${GP_ROOT}/install/service/start`, ["--root", ROOT, "--name", NAME, "--idle"], { stdio: ["ignore", "ignore", "pipe"], timeout: 60000 });
    return { idle: true };
  } catch (e) {
    return { idle: false, why: (e.stderr?.toString("utf8") || "").trim().split("\n").pop() || "busy" };
  }
}

function ask(action, out, now) {
  if (!updaterSeen(now)) throw new GpError("no-updater", "no update helper is running for this agent; update by hand (see the quick start)");
  finish({ now });
  if (pendingRequest() || updateState()) throw new GpError("update-in-progress", "an update or a way back is already asked for or under way");
  const from = currentVersion();
  let to;
  if (action === "update") {
    to = readJson(L.updateAvailable, null)?.version;
    if (!to || to === from) throw new GpError("no-update-available", "there is no newer version to update to");
  } else {
    to = read(L.previousVersion);
    if (!to) throw new GpError("no-previous-version", "there is no previous version to go back to");
  }
  writeJson(L.updateRequest, { action, from, to, at: new Date(now).toISOString() }, 0o644);
  out.kv("UPDATE", action === "update" ? "requested" : "rollback-requested");
  out.kv("UPDATE_VERSION", to);
  out.log(`the agent finishes its task first; then the helper swaps to ${to}`);
  return 0;
}

export async function update(argv, out, { now = Date.now(), idle = agentIdle } = {}) {
  const [sub, ...rest] = argv;
  const usage = () => new GpError("usage", "usage: gp update request | rollback | offer <version> [--image <pinned image>] | check | watch | poll | begin | failed [--reason <words>]", 2);
  out.header();
  switch (sub) {
    case "request":
    case "rollback":
      if (rest.length) throw usage();
      return ask(sub === "request" ? "update" : "rollback", out, now);
    case "check": {
      if (rest.length) throw usage();
      const { check } = await import("./watch.mjs");
      let v;
      try {
        v = await check();
      } catch (e) {
        throw new GpError("update-check-failed", `the release check did not work: ${e.message}`);
      }
      out.kv("UPDATE_AVAILABLE", v ? "yes" : "no");
      if (v) {
        out.kv("UPDATE_VERSION", v.version);
        out.kv("UPDATE_IMAGE", v.image);
        out.kv("UPDATE_DIGEST", v.digest);
      }
      return 0;
    }
    case "watch": {
      if (rest.length) throw usage();
      return (await import("./watch.mjs")).watch();
    }
    case "offer": {
      const [v, flag, image] = rest;
      if (!(rest.length === 1 || (rest.length === 3 && flag === "--image")) || !VERSION_RE.test(v)) throw usage();
      if (v !== currentVersion()) {
        try {
          offer(v, { image: image ?? null });
        } catch (e) {
          throw new GpError("usage", `--image: ${e.message}`, 2);
        }
      }
      out.kv("UPDATE_AVAILABLE", v !== currentVersion() ? "yes" : "no");
      return 0;
    }
    case "poll": {
      if (rest.length) throw usage();
      writeFileAtomic(L.updaterSeen, new Date(now).toISOString() + "\n", 0o644);
      finish({ now });
      const r = pendingRequest();
      out.kv("VERSION", currentVersion());
      out.kv("UPDATE_REQUEST", r ? r.action : "none");
      if (r) out.kv("UPDATE_VERSION", r.to);
      return 0;
    }
    case "begin": {
      if (rest.length) throw usage();
      const r = pendingRequest();
      if (!r) throw new GpError("no-update-requested", "no update or way back is asked for");
      const i = idle();
      if (!i.idle) {
        out.kv("UPDATE", "busy");
        out.log(`the agent is still at work (${i.why}); the helper tries again`);
        return 0;
      }
      writeJson(L.updateState, { state: "updating", action: r.action, from: r.from, to: r.to, at: new Date(now).toISOString() }, 0o644);
      rm(L.updateRequest);
      out.kv("UPDATE", "begun");
      out.kv("UPDATE_VERSION", r.to);
      return 0;
    }
    case "failed": {
      let reason = "the new version did not start";
      if (rest.length === 2 && rest[0] === "--reason") reason = rest[1];
      else if (rest.length) throw usage();
      const u = updateState();
      rm(L.updateState);
      rm(L.updateRequest);
      const last = readJson(L.handoff, null);
      const to = u?.to ?? (last?.result === "done" ? last.to : undefined);
      if (to) handoff({ action: u?.action ?? last.action, from: currentVersion(), to, result: "failed", reason, told: false });
      // A check that ran after the new container finished the update left its from as the way back.
      if (read(L.previousVersion) === currentVersion()) rm(L.previousVersion);
      out.kv("UPDATE", "failed");
      return 0;
    }
    default:
      throw usage();
  }
}

export const hasHandoff = () => existsSync(L.handoff);
