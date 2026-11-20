// gp update watch: the agent's own side of updates, run by the entrypoint
// beside the agent, as the agent's user. Every hour it looks for a newer
// release; every few seconds it hands the agent's claude its notes:
//
//   - a newer release (U1): once per version, a note asks the agent to ask
//     its operator on Buzz whether to update, and on a yes to run
//     `gp update request`. With no update helper, the note asks it to tell
//     the operator instead, who updates by hand.
//   - after an update, a way back or a failed one (U5): a note asks the agent
//     to confirm it to its operator, in the thread where they said yes.
//
// A note is typed into the agent's claude (its tmux pane, the one start
// recorded) only while start's idle test says it is idle, so it never cuts
// into a turn. Each note starts with "[GHOST Protocol]".
//
// Releases are the image repository's tags (GP_IMAGE_REPO, which the release
// build sets), read with the registry's own anonymous pull token. Only
// ghcr.io/0xnfrith/ghost-protocol and ghcr.io/0xnfrith/ghost-protocol-staging
// are checked (releases.mjs, RELEASE_REPOS); any other repository fails the
// check. Only plain x.y.z tags count. With no GP_IMAGE_REPO (a build of one's
// own) there is no check. A newer version is
// put on offer only with its image pinned by its release manifest's digest
// (<repo>:<version>@sha256:<64 hex>), which gp status --json carries.
//   gp update check   one check now: GP_UPDATE_AVAILABLE=yes|no, GP_UPDATE_VERSION,
//                     GP_UPDATE_IMAGE, GP_UPDATE_DIGEST
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { L, NAME } from "./layout.mjs";
import { readJson, writeJson } from "./files.mjs";
import { agentIdle, updaterSeen } from "./update.mjs";
import { DIGEST_RE, pinned, offer, isReleaseRepo, RELEASE_REPOS } from "./releases.mjs";

export const CHECK_EVERY_MS = 60 * 60 * 1000;
export const NOTE_EVERY_MS = 15 * 1000;
const STABLE = /^(\d+)\.(\d+)\.(\d+)$/;
const PRE = /^(\d+)\.(\d+)\.(\d+)-/;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
const currentVersion = () => process.env.GP_IMAGE_VERSION || (() => { try { return readFileSync("/etc/gp-image-version", "utf8").trim(); } catch { return "unknown"; } })();

/** Compares x.y.z versions; a pre-release (x.y.z-…) sorts just before its x.y.z. */
export function cmp(a, b) {
  const pa = a.match(STABLE) || a.match(PRE);
  const pb = b.match(STABLE) || b.match(PRE);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 1; i <= 3; i++) if (+pa[i] !== +pb[i]) return +pa[i] - +pb[i];
  return (STABLE.test(a) ? 1 : 0) - (STABLE.test(b) ? 1 : 0);
}

/** The newest plain x.y.z tag newer than current, or null. */
export function newest(tags, current) {
  const ok = tags.filter((t) => STABLE.test(t) && cmp(t, current) > 0).sort(cmp);
  return ok.length ? ok[ok.length - 1] : null;
}

/** registry host and path of a repository reference (docker.io's own names included). */
export function registryOf(repo) {
  const parts = repo.split("/");
  if (parts.length > 1 && (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost")) {
    return { host: parts[0], path: parts.slice(1).join("/") };
  }
  return { host: "registry-1.docker.io", path: parts.length === 1 ? `library/${repo}` : repo };
}

/** A GET on the repository's registry API (/v2/<path>/<rest>), with the registry's anonymous pull token when it asks for one. */
async function registryGet(repo, rest, { fetchFn = fetch, headers = {} } = {}) {
  const { host, path } = registryOf(repo);
  const scheme = /^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https";
  const url = `${scheme}://${host}/v2/${path}/${rest}`;
  let r = await fetchFn(url, { headers });
  if (r.status === 401) {
    const h = r.headers.get("www-authenticate") || "";
    const realm = h.match(/realm="([^"]+)"/)?.[1];
    if (!realm || !/^Bearer /i.test(h)) throw new Error("the registry asked for a login of a kind not known here");
    const q = new URLSearchParams();
    const service = h.match(/service="([^"]+)"/)?.[1];
    if (service) q.set("service", service);
    q.set("scope", h.match(/scope="([^"]+)"/)?.[1] || `repository:${path}:pull`);
    const t = await fetchFn(`${realm}?${q}`);
    if (t.status !== 200) throw new Error(`the registry's token service answered ${t.status}`);
    const j = await t.json();
    r = await fetchFn(url, { headers: { ...headers, Authorization: `Bearer ${j.token || j.access_token}` } });
  }
  if (r.status !== 200) throw new Error(`the registry answered ${r.status} for ${repo} (${rest})`);
  return r;
}

/** The repository's tags. */
export async function listTags(repo, { fetchFn = fetch } = {}) {
  return (await (await registryGet(repo, "tags/list", { fetchFn })).json()).tags || [];
}

// The release's manifest is the tag's top manifest: the multi-architecture
// index the release pushes (single-image manifests are accepted too). Its
// digest is the sha256 of the bytes the registry serves, the same digest the
// release notes and get.sh carry.
const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

/** The digest (sha256:<64 hex>) of the release manifest of repo:tag, computed from its bytes. */
export async function manifestDigest(repo, tag, { fetchFn = fetch } = {}) {
  const r = await registryGet(repo, `manifests/${tag}`, { fetchFn, headers: { Accept: MANIFEST_TYPES } });
  const body = Buffer.from(await r.arrayBuffer());
  const digest = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  const said = r.headers.get("docker-content-digest");
  if (said && said.toLowerCase() !== digest) throw new Error(`the registry's digest for ${repo}:${tag} does not match its manifest`);
  return digest;
}

/**
 * One check: notes the newest release when it is newer, with its image pinned
 * by the digest of its release manifest (never a bare tag: no digest, no
 * offer). Returns {version, image, digest} or null.
 */
export async function check({ repo = process.env.GP_IMAGE_REPO || "", current = currentVersion(), list = listTags, digestOf = manifestDigest } = {}) {
  if (!repo) return null;
  if (!isReleaseRepo(repo)) throw new Error(`${repo} is not a release repository (only ${RELEASE_REPOS.join(" or ")})`);
  const version = newest(await list(repo), current);
  if (!version) return null;
  const digest = await digestOf(repo, version);
  if (!DIGEST_RE.test(digest ?? "")) throw new Error(`no digest for ${repo}:${version}`);
  const image = pinned(repo, version, digest);
  offer(version, { image });
  return { version, image, digest };
}

/** The note for the agent now, and what to mark once it is given; or null. */
export function nextNote({ current = currentVersion(), helper = updaterSeen() } = {}) {
  const h = readJson(L.handoff, null);
  if (h && h.told === false) {
    let text;
    if (h.result === "done" && h.action === "rollback") text = `[GHOST Protocol] You were moved back from version ${h.from} to ${h.to}, as asked. Tell your operator on Buzz, in the thread where they asked for it, that you now run ${h.to}.`;
    else if (h.result === "done") text = `[GHOST Protocol] You were updated from version ${h.from} to ${h.to}, as your operator asked. Confirm it to them on Buzz, in the thread where they said yes: you now run ${h.to}.`;
    else text = `[GHOST Protocol] The ${h.action === "rollback" ? "way back" : "update"} to version ${h.to} did not work (${h.reason || "see the helper's docker logs"}); you still run ${current}. Tell your operator on Buzz, in the thread where they asked for it.`;
    return { text, mark: () => writeJson(L.handoff, { ...h, told: true }, 0o644) };
  }
  const avail = readJson(L.updateAvailable, null)?.version;
  const asked = readJson(L.updateAsked, { versions: [] });
  if (avail && avail !== current && !asked.versions.includes(avail)) {
    const text = helper
      ? `[GHOST Protocol] Version ${avail} of GHOST Protocol is out; you run ${current}. Ask your operator once, in your DM with them on Buzz, whether to update now. If they say yes, run \`gp update request\`: the update waits until your turn has ended, then you come back on ${avail} with this conversation and your memory. If they say no, do nothing; you will not be asked about ${avail} again.`
      : `[GHOST Protocol] Version ${avail} of GHOST Protocol is out; you run ${current}. Tell your operator once, in your DM with them on Buzz. This install has no update helper, so they update by hand, as the quick start says; your key, memory and sign-ins are kept.`;
    return { text, mark: () => writeJson(L.updateAsked, { versions: [...asked.versions, avail].slice(-50) }, 0o644) };
  }
  return null;
}

/** Types text into the agent's claude, in the pane start recorded; true when it was sent. */
export function typeIntoClaude(text) {
  let pane;
  try {
    pane = readFileSync(`${L.startState}/pane-id`, "utf8").trim();
  } catch {
    return false;
  }
  if (!/^%\d+$/.test(pane)) return false;
  try {
    execFileSync("tmux", ["-L", NAME, "send-keys", "-t", pane, "-l", text.replace(/[\r\n]+/g, " ")], { stdio: "ignore", timeout: 10000 });
    execFileSync("tmux", ["-L", NAME, "send-keys", "-t", pane, "Enter"], { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

/** One round of notes: gives the next one when claude runs and is idle. */
export function deliver({ idle = agentIdle, type = typeIntoClaude } = {}) {
  const n = nextNote();
  if (!n) return false;
  let phase = "";
  try {
    phase = readFileSync(L.agentState, "utf8").split(/\s+/)[0];
  } catch {
    return false;
  }
  if (phase !== "running" || !idle().idle) return false;
  if (!type(n.text)) return false;
  n.mark();
  return true;
}

export async function watch({ log = (l) => process.stderr.write(`${new Date().toISOString()} gp-update-watch: ${l}\n`), sleep = sleepMs } = {}) {
  let lastCheck = 0;
  for (;;) {
    if (Date.now() - lastCheck >= CHECK_EVERY_MS) {
      lastCheck = Date.now();
      try {
        const v = await check();
        if (v) log(`version ${v.version} is out (${v.image})`);
      } catch (e) {
        log(`the release check did not work: ${e.message}`);
      }
    }
    try {
      if (deliver()) log("a note went to the agent");
    } catch (e) {
      log(`could not give the agent its note: ${e.message}`);
    }
    await sleep(NOTE_EVERY_MS);
  }
}
