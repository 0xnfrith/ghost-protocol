// gp status [--json]: the agent's state, read from the volume alone.
//
// --json prints one JSON object and nothing else (no GP_INTERFACE line; its
// interface field carries the number):
//   interface, version, state, agent_pubkey, relay_url, relay, claude,
//   update, previous_version, error ({code, message} or null)
// update is {available: false, version: null}, or with a newer version on
// offer {available: true, version, image, digest}: image is that version
// pinned by its release manifest's digest, <repo>:<version>@sha256:<64 hex>,
// never a bare tag, and digest is its sha256:<64 hex> (both null only for a
// version a test put on offer without one).
// state is needs-claude, needs-auth-tag, connecting, running, updating or error;
// relay is connected, refused-not-member or unreachable; claude is active or
// not-active. Without --json it prints the same as GP_<KEY> lines.
//
// The relay result is the channel's own, from its log since the agent's last
// start. When the channel has not said yet (no sign-in, or it is starting), it
// is a login of its own with the agent's key and tag, at most once a minute
// for the same relay and tag (kept in .gp/relay-check.json).
//
// A new agent is needs-auth-tag first and needs-claude after it, whichever is
// done first; then connecting, then running. With a tag, a relay that refuses
// or cannot be reached keeps it connecting; the relay field says why. A refusal
// also sets error, {code: "relay-refused"}, whose message says what the relay
// needs (owner attestations on, and the owner a relay member): the login will
// not get in by waiting until then.
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { INTERFACE, GpError } from "./out.mjs";
import { L } from "./layout.mjs";
import { readJson, writeJson } from "./setup.mjs";
import { adapter } from "./paths.mjs";
import { finish, updateState, FAILED_SHOWN_MS } from "./update.mjs";
import { updateField } from "./releases.mjs";

/** A failed update or way back in the last FAILED_SHOWN_MS: gp status says so, as state error. */
function failedSwap(now) {
  const h = readJson(L.handoff, null);
  return h && h.result === "failed" && now - Date.parse(h.at) < FAILED_SHOWN_MS ? h : null;
}

const read = (p) => {
  try {
    return readFileSync(p, "utf8").trim();
  } catch {
    return "";
  }
};

export function imageVersion() {
  // The image sets both to its tag; the environment first, so a test can set it.
  return process.env.GP_IMAGE_VERSION || read("/etc/gp-image-version") || "unknown";
}

/** The channel's last word on the relay since `since` (ISO time), or null. */
export function relayFromLog(text, since = "") {
  let last = null;
  for (const line of text.split("\n")) {
    if (since && line.slice(0, 19) < since.slice(0, 19)) continue;
    if (/ buzz-channel: relay accepted AUTH$/.test(line)) last = "connected";
    else if (/ buzz-channel: relay refused AUTH/.test(line)) last = "refused-not-member";
    else if (/ buzz-channel: (could not open a connection|the connection did not open within)/.test(line)) last = "unreachable";
  }
  return last;
}

export function claudeActive(env = process.env) {
  if (read(L.token)) return true;
  try {
    const out = execFileSync(process.env.GP_CLAUDE || "claude", ["auth", "status", "--json"], {
      env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    });
    return JSON.parse(out.toString("utf8")).loggedIn === true;
  } catch {
    return false;
  }
}

async function relayProbe(cfg, now) {
  const cached = readJson(L.relayCheck, null);
  const tagText = read(L.tag);
  // Kept for a minute for the same relay and the same tag: a new tag is tried at once.
  if (cached && cached.url === cfg.relay_url && cached.tag === tagText && now - cached.at < 60000) return cached.relay;
  const { parseSecretKey, relaySocketUrl } = await import(adapter("src/config.mjs"));
  const { relayCheck } = await import("./relaycheck.mjs");
  let relay = "unreachable";
  try {
    const secret = parseSecretKey(read(L.key));
    let tag;
    try {
      tag = tagText ? JSON.parse(tagText) : undefined;
    } catch {
      tag = undefined;
    }
    relay = (await relayCheck({ url: relaySocketUrl(cfg.relay_url), secret, tag, timeoutMs: 5000 })).relay;
    secret.fill(0);
  } catch {
    relay = "unreachable";
  }
  try {
    writeJson(L.relayCheck, { url: cfg.relay_url, tag: tagText, at: now, relay });
  } catch {
    // a read-only volume still gets an answer
  }
  return relay;
}

/** Why a refused login does not get in by waiting, and what the relay needs. */
export const refusedMessage = (agentPubkey) =>
  `the relay refused the agent's login with the owner's attestation: the relay must have owner attestations on (BUZZ_ALLOW_NIP_OA_AUTH=true), and the owner must be a relay member there; then the agent (${agentPubkey}) gets in at its next try, within about a minute`;

export async function collect({ now = Date.now(), probe = relayProbe, claude = claudeActive } = {}) {
  // A swap to this version is done once this container answers (the plugin
  // waits for a status with the new version).
  try {
    finish({ version: imageVersion(), now });
  } catch {
    // a read-only volume still gets an answer
  }
  const cfg = readJson(L.config);
  const [phase, since = ""] = read(L.agentState).split(/\s+/);
  let agentPubkey = null;
  try {
    const { parseSecretKey, publicKeyOf } = await import(adapter("src/config.mjs"));
    agentPubkey = existsSync(L.key) ? publicKeyOf(parseSecretKey(read(L.key))) : null;
  } catch {
    agentPubkey = null;
  }
  const s = {
    interface: INTERFACE,
    version: imageVersion(),
    state: "connecting",
    agent_pubkey: agentPubkey,
    relay_url: cfg.relay_url ?? null,
    relay: "unreachable",
    claude: claude() ? "active" : "not-active",
    update: { available: false, version: null },
    previous_version: read(L.previousVersion) || null,
    error: null,
  };
  s.update = updateField(s.version);

  if (!cfg.relay_url || !agentPubkey) {
    s.state = "error";
    s.error = { code: "not-set-up", message: "the agent is not set up: run init" };
    return s;
  }
  const fromLog = phase === "running" ? relayFromLog(read(L.channelLog) + "\n" + read(L.channelLog + ".1"), since) : null;
  s.relay = fromLog ?? (await probe(cfg, now));
  if (phase === "error") {
    s.state = "error";
    s.error = { code: "agent-failed", message: "the agent could not start; see docker logs" };
  } else if (updateState()?.state === "updating") s.state = "updating";
  else if (failedSwap(now)) {
    const h = failedSwap(now);
    s.state = "error";
    s.error = {
      code: h.action === "rollback" ? "rollback-failed" : "update-failed",
      message: `${h.action === "rollback" ? "the way back" : "the update"} to ${h.to} failed (${h.reason || "see the helper's docker logs"}); the agent runs ${s.version}`,
    };
  }
  // A new agent: needs-auth-tag first, needs-claude after it, whichever of the
  // two is done first; then connecting, then running. An agent that the relay
  // takes without a tag (a relay member) needs none.
  else if (!read(L.tag) && s.relay !== "connected") s.state = "needs-auth-tag";
  else if (s.claude === "not-active") s.state = "needs-claude";
  else if (s.relay === "connected" && phase === "running") s.state = "running";
  else {
    s.state = "connecting";
    if (s.relay === "refused-not-member") s.error = { code: "relay-refused", message: refusedMessage(s.agent_pubkey) };
  }
  return s;
}

export async function status(argv, out) {
  const json = argv.includes("--json");
  const bad = argv.find((a) => a !== "--json");
  if (bad !== undefined) throw new GpError("usage", "usage: gp status [--json]", 2);
  const s = await collect();
  if (json) {
    out.raw(JSON.stringify(s) + "\n");
    return 0;
  }
  out.header();
  out.kv("VERSION", s.version);
  out.kv("STATE", s.state);
  out.kv("AGENT_PUBKEY", s.agent_pubkey ?? "");
  out.kv("RELAY_URL", s.relay_url ?? "");
  out.kv("RELAY", s.relay);
  out.kv("CLAUDE", s.claude);
  out.kv("UPDATE_AVAILABLE", s.update.available ? "yes" : "no");
  if (s.update.version) out.kv("UPDATE_VERSION", s.update.version);
  if (s.update.image) out.kv("UPDATE_IMAGE", s.update.image);
  if (s.update.digest) out.kv("UPDATE_DIGEST", s.update.digest);
  if (s.previous_version) out.kv("PREVIOUS_VERSION", s.previous_version);
  if (s.error) out.error(s.error.code, s.error.message);
  return 0;
}
