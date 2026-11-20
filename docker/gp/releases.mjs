// The releases the agent knows of, each with its image pinned by digest:
// <repo>:<version>@sha256:<64 hex>, the digest of the release manifest (the
// multi-architecture index the release pushes). The release check (watch.mjs)
// fills them in; gp status --json carries the one on offer, so that an update
// by hand can pull exactly that image. Nothing here is ever a bare tag.
//
//   update-available.json   {version, image, digest}: the version on offer
//                           ({version} alone only for a test's offer)
//   release-images.json     {<version>: {image, digest}}: the last 20 seen, so
//                           that a way back can offer the version it left, pinned
import { L } from "./layout.mjs";
import { readJson, writeJson } from "./files.mjs";

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const KEEP = 20;

/** The pinned reference of a release. */
export const pinned = (repo, version, digest) => `${repo}:${version}@${digest}`;

/**
 * The only image repositories an agent takes a release from: the public image and its staging copy,
 * matched exactly (case too). A repository under another owner, name, path or registry is never put
 * on offer, so neither the plugin nor the helper is ever pointed at one.
 */
export const RELEASE_REPOS = Object.freeze(["ghcr.io/0xnfrith/ghost-protocol", "ghcr.io/0xnfrith/ghost-protocol-staging"]);
export const isReleaseRepo = (repo) => RELEASE_REPOS.includes(repo);

/** Whether image is <one of RELEASE_REPOS>:<version>@sha256:<64 hex>, exactly. */
export const isPinned = (image, version) =>
  typeof image === "string" &&
  typeof version === "string" &&
  version !== "" &&
  RELEASE_REPOS.some((repo) => image.startsWith(`${repo}:${version}@`) && DIGEST_RE.test(image.slice(repo.length + version.length + 2)));

/** The pinned image of version, if a release check or an offer saw it: {image, digest} or null. */
export function knownImage(version) {
  const k = readJson(L.releaseImages, {})?.[version];
  return k && isPinned(k.image, version) && k.image.endsWith(`@${k.digest}`) ? { image: k.image, digest: k.digest } : null;
}

/** Puts version on offer, with its pinned image when given or known, and remembers that image. */
export function offer(version, { image = null } = {}) {
  if (image && !isPinned(image, version)) throw new Error(`${image} is not ${version} pinned by digest`);
  const pin = image ? { image, digest: image.slice(image.lastIndexOf("@") + 1) } : knownImage(version);
  writeJson(L.updateAvailable, pin ? { version, ...pin } : { version }, 0o644);
  if (image) {
    const known = readJson(L.releaseImages, {}) || {};
    delete known[version];
    known[version] = pin;
    writeJson(L.releaseImages, Object.fromEntries(Object.entries(known).slice(-KEEP)), 0o644);
  }
}

/** The update object of gp status --json for the version on offer (not the running one). */
export function updateField(current) {
  const upd = readJson(L.updateAvailable, null);
  if (!upd || typeof upd.version !== "string" || upd.version === current) return { available: false, version: null };
  const pin = isPinned(upd.image, upd.version) && upd.image.endsWith(`@${upd.digest}`) ? { image: upd.image, digest: upd.digest } : knownImage(upd.version);
  return { available: true, version: upd.version, image: pin?.image ?? null, digest: pin?.digest ?? null };
}
