// gp auth-tag set: the owner's NIP-OA tag, on stdin, for the plugin's activate step.
//
//   docker exec -i gp-<slug> gp auth-tag set   <<< '["auth","<owner>","<conditions>","<sig>"]'
//
// The tag must be the four-string JSON array, signed by the agent's owner (the
// key init was given) for this agent's key. It is kept in the volume (it is
// public) and the agent's claude restarts to log in with it. Prints
// GP_AUTH_TAG=accepted, then GP_RELAY=<connected|refused-not-member|unreachable>
// from one login with it; or GP_ERROR=bad-auth-tag.
//   gp auth-tag show   prints GP_AUTH_TAG=<the tag> or GP_AUTH_TAG=none
import { readFileSync } from "node:fs";
import { GpError } from "./out.mjs";
import { L } from "./layout.mjs";
import { readJson, writeFileAtomic } from "./setup.mjs";
import { verifyAuthTag } from "./nipoa.mjs";
import { firstLine, readStdin, restartAgent } from "./agentctl.mjs";
import { relayCheck } from "./relaycheck.mjs";
import { adapter } from "./paths.mjs";

const bad = (m) => new GpError("bad-auth-tag", m);

export async function authTag(argv, out, { stdin = readStdin, check = relayCheck } = {}) {
  const [sub, ...rest] = argv;
  if (!["set", "show"].includes(sub) || rest.length) throw new GpError("usage", "usage: gp auth-tag set (the tag on stdin) | gp auth-tag show", 2);
  out.header();
  if (sub === "show") {
    let t = "";
    try {
      t = readFileSync(L.tag, "utf8").trim();
    } catch {
      t = "";
    }
    out.kv("AUTH_TAG", t || "none");
    return 0;
  }
  const { parseSecretKey, publicKeyOf, relaySocketUrl } = await import(adapter("src/config.mjs"));
  const cfg = readJson(L.config);
  let secret;
  try {
    secret = parseSecretKey(readFileSync(L.key, "utf8"));
  } catch {
    throw new GpError("not-set-up", "the agent is not set up: run init first");
  }
  const agent = publicKeyOf(secret);
  const line = firstLine(stdin()).trim();
  if (!line) {
    secret.fill(0);
    throw bad("no tag on stdin: write the tag and a newline to docker exec -i");
  }
  let tag;
  try {
    tag = JSON.parse(line);
  } catch {
    secret.fill(0);
    throw bad('the tag must be one JSON array: ["auth", "<owner public key>", "<conditions>", "<signature>"]');
  }
  if (!Array.isArray(tag) || tag.length !== 4 || !tag.every((x) => typeof x === "string") || tag[0] !== "auth") {
    secret.fill(0);
    throw bad('the tag must be a JSON array of four strings, the first "auth"');
  }
  if (cfg.owner && tag[1] !== cfg.owner) {
    secret.fill(0);
    throw bad("the tag is signed by another key than the agent's owner");
  }
  if (!verifyAuthTag(tag, agent)) {
    secret.fill(0);
    throw bad("the tag is not a valid NIP-OA tag for this agent's key");
  }
  writeFileAtomic(L.tag, JSON.stringify(tag) + "\n", 0o644);
  out.kv("AUTH_TAG", "accepted");
  if (restartAgent()) out.log("the agent restarts to log in with the tag");
  if (cfg.relay_url) {
    let r = { relay: "unreachable" };
    try {
      r = await check({ url: relaySocketUrl(cfg.relay_url), secret, tag, timeoutMs: 8000 });
    } catch {
      // unreachable
    }
    out.kv("RELAY", r.relay);
    if (r.relay === "refused-not-member") out.log("the relay refused the agent's login with this tag: it does not accept owner attestations, or the owner is not a relay member there");
  }
  secret.fill(0);
  return 0;
}
