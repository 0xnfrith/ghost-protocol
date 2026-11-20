// gp profile: the agent's own Buzz profile, a kind-0 event signed by the
// agent's key, with the name given to init (--name). The plugin publishes no
// profile; the agent does, on its first start.
//
//   gp profile publish [--retry]
//       Publishes the profile when the name, the relay or the key differ from
//       the last one the relay accepted (.gp/profile.json), so a new name from
//       a second init goes out, and an unchanged one is not sent again. It
//       logs in as the channel does (with the owner's tag when there is one).
//       Prints GP_PROFILE=published or GP_PROFILE=unchanged. A failure is
//       GP_ERROR=profile-failed. With --retry it tries again until the relay
//       takes it: after 15 seconds, then twice as long each time, at most
//       5 minutes apart (the tag may not be there yet). The entrypoint runs it
//       so, beside the agent.
//
// The profile's content is {"name", "display_name"}, both the agent's name.
// No picture: init is given none.
import { existsSync, readFileSync } from "node:fs";
import { GpError } from "./out.mjs";
import { L } from "./layout.mjs";
import { readJson, writeJson } from "./files.mjs";
import { adapter } from "./paths.mjs";

export const KIND_PROFILE = 0;
export const RETRY_FIRST_MS = 15 * 1000;
export const RETRY_MAX_MS = 5 * 60 * 1000;
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8").trim() : "");
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** The kind-0 content for a name. */
export const profileContent = (name) => JSON.stringify({ name, display_name: name });

/**
 * One try. Returns "published" or "unchanged"; throws GpError("profile-failed").
 * check is relayCheck's shape (for the tests).
 */
export async function publishOnce({ now = Date.now(), check } = {}) {
  const cfg = readJson(L.config);
  if (!cfg.name || !cfg.relay_url) throw new GpError("profile-failed", "the agent is not set up yet (run init first)");
  const { parseSecretKey, publicKeyOf, relaySocketUrl } = await import(adapter("src/config.mjs"));
  let secret;
  try {
    secret = parseSecretKey(read(L.key));
  } catch {
    throw new GpError("profile-failed", "the agent's key is missing from the data volume (run init first)");
  }
  try {
    const pubkey = publicKeyOf(secret);
    const last = readJson(L.profile, {});
    if (last.pubkey === pubkey && last.name === cfg.name && last.relay_url === cfg.relay_url) return "unchanged";
    const { finalizeEvent } = await import("nostr-tools/pure");
    // A kind-0 replaces the older one by created_at: never go back in time.
    const created_at = Math.max(Math.floor(now / 1000), (last.created_at ?? 0) + 1);
    const event = finalizeEvent({ kind: KIND_PROFILE, created_at, tags: [], content: profileContent(cfg.name) }, secret);
    let tag;
    try {
      const t = read(L.tag);
      tag = t ? JSON.parse(t) : undefined;
    } catch {
      tag = undefined;
    }
    const run = check ?? (await import("./relaycheck.mjs")).relayCheck;
    const r = await run({ url: relaySocketUrl(cfg.relay_url), secret, tag, event, timeoutMs: 15000 });
    if (r.relay !== "connected") throw new GpError("profile-failed", `the relay did not take the login: ${r.relay}${r.detail ? ` (${r.detail})` : ""}`);
    if (!r.sent) throw new GpError("profile-failed", `the relay refused the profile${r.detail ? `: ${r.detail}` : ""}`);
    writeJson(L.profile, { pubkey, name: cfg.name, relay_url: cfg.relay_url, event_id: event.id, created_at, at: new Date(now).toISOString() });
    return "published";
  } finally {
    secret.fill(0);
  }
}

export async function profile(argv, out, { check, sleep = sleepMs } = {}) {
  const [sub, ...rest] = argv;
  const retry = rest.length === 1 && rest[0] === "--retry";
  if (sub !== "publish" || (rest.length > 0 && !retry)) throw new GpError("usage", "usage: gp profile publish [--retry]", 2);
  out.header();
  let wait = RETRY_FIRST_MS;
  for (;;) {
    try {
      out.kv("PROFILE", await publishOnce({ check }));
      return 0;
    } catch (err) {
      if (!retry || !(err instanceof GpError)) throw err;
      out.log(`gp profile: ${err.message}; trying again in ${Math.round(wait / 1000)} s`);
      await sleep(wait);
      wait = Math.min(wait * 2, RETRY_MAX_MS);
    }
  }
}
