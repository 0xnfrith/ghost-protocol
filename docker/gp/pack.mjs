// The skills pack of a hosted agent: a .tar.gz of skill folders, named and checksummed by the config's `pack` {name, sha256, url} (docs/hosted.md).
//   fetch    the url must be on the order service's origin, with no redirect, under a size cap; the bytes are hashed as they arrive, and on a wrong hash nothing is read or written
//   read     readTar: plain files and folders only. Anything else, a path that is not plain, a wrong header checksum, a cut archive or more than the limits refuses the whole pack
//   install  each top-level folder (a skill with a SKILL.md) goes to ~/.claude/skills/<name> as real files; one already there that the previous pack did not put is the owner's, and
//            refuses the pack; the previous pack's skills that this one lacks are removed. `.gp/pack.json` records it. The url is never logged or printed.
// The reader is our own because the image's tar would make links and devices and write before it counted, and so needs a listing parsed first; this one writes nothing until it is satisfied.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { GpError } from "./out.mjs";
import { L } from "./layout.mjs";
import { readJson, writeJson } from "./files.mjs";

export const LIMITS = { download: 64 * 2 ** 20, unpacked: 128 * 2 ** 20, file: 16 * 2 ** 20, files: 2000, depth: 8 };
const refused = (m) => new GpError("pack-refused", `the skills pack is refused: ${m}`);
const SKILL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PART = /^[^\u0000-\u001f\u007f\\/]{1,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;

const text = (b, at, len) => {
  const raw = b.subarray(at, at + len);
  const end = raw.indexOf(0);
  return Buffer.from(end < 0 ? raw : raw.subarray(0, end)).toString("utf8");
};
const octal = (b, at, len) => (/^[0-7]*$/.test(text(b, at, len).trim()) && text(b, at, len).trim() !== "" ? parseInt(text(b, at, len).trim(), 8) : NaN);

/** The entries of a gzip'd tar as [{path, dir, data}], or a refusal. The unpacked size is capped while it is inflated. */
export function readTar(gz) {
  let tar;
  try {
    tar = gunzipSync(gz, { maxOutputLength: LIMITS.unpacked + 1024 * 1024 });
  } catch {
    throw refused("it is not a gzip file, or it unpacks to more than the limit");
  }
  const entries = [];
  const seen = new Set();
  let total = 0;
  let ended = false;
  for (let at = 0; at + 512 <= tar.length; ) {
    const h = tar.subarray(at, at + 512);
    if (h.every((x) => x === 0)) {
      ended = true;
      break;
    }
    const sum = h.reduce((n, x, i) => n + (i >= 148 && i < 156 ? 32 : x), 0);
    if (octal(h, 148, 8) !== sum) throw refused("a header's checksum is wrong");
    const type = String.fromCharCode(h[156]);
    const size = octal(h, 124, 12);
    if (!["0", "\0", "5"].includes(type)) throw refused("it holds an entry that is not a file or a folder (a link, a device or an extended header)");
    if (!Number.isInteger(size) || (type === "5" && size !== 0) || size > LIMITS.file) throw refused("an entry's size is not allowed");
    // The prefix field is POSIX ustar's ("ustar" and a NUL); in GNU's header those bytes are other things.
    const prefix = text(h, 257, 5) === "ustar" && h[262] === 0 ? text(h, 345, 155) : "";
    let path = (prefix ? `${prefix}/` : "") + text(h, 0, 100);
    if (path.startsWith("./")) path = path.slice(2);
    const dir = type === "5";
    if (dir) path = path.replace(/\/$/, "");
    at += 512;
    if (path === "" || path === ".") continue;
    const parts = path.split("/");
    if (parts.length > LIMITS.depth || !parts.every((p) => PART.test(p) && p !== "." && p !== "..")) throw refused("a path is absolute, climbs, or is not plain characters");
    if (seen.has(path)) throw refused("a path is there twice");
    seen.add(path);
    total += size;
    if (entries.length >= LIMITS.files || total > LIMITS.unpacked) throw refused("it holds more than the limits");
    if (at + size > tar.length) throw refused("it ends inside a file");
    entries.push({ path, dir, data: dir ? null : Buffer.from(tar.subarray(at, at + size)) });
    at += Math.ceil(size / 512) * 512;
  }
  // An archive that was cut short, at a block's end or inside one, has no end marker.
  if (!ended) throw refused("it ends without its end marker: it is cut short");
  const folder = new Map(entries.map((x) => [x.path, x.dir]));
  for (const x of entries) {
    const up = x.path.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"));
    if (up.some((p) => folder.get(p) === false)) throw refused("a path is a file and also a folder");
  }
  return entries;
}

// The skills in a pack: its top-level folders, each with a SKILL.md and nothing at the top that is a file.
function skillsOf(entries) {
  const names = new Set();
  for (const e of entries) {
    const [top, ...below] = e.path.split("/");
    if (below.length === 0 && !e.dir) throw refused("a file is at the top: a pack is folders, one for each skill");
    if (!SKILL.test(top)) throw refused("a skill's folder name is not lower case letters, digits, dots, dashes and underscores");
    names.add(top);
  }
  if (names.size === 0) throw refused("it holds no skill");
  for (const n of names) if (!entries.some((e) => e.path === `${n}/SKILL.md` && !e.dir)) throw refused("a skill has no SKILL.md");
  return [...names].sort();
}

async function download(pack, origin, fetchImpl) {
  let url;
  try {
    url = new URL(pack.url);
  } catch {
    throw refused("its address is not an address");
  }
  if (url.origin !== origin || url.username || url.password) throw refused("its address is not on the order service");
  let res;
  try {
    res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  } catch {
    throw new GpError("pack-unreachable", "the skills pack could not be fetched: no answer from the order service");
  }
  if (res.status !== 200) throw new GpError("pack-unreachable", `the skills pack could not be fetched: the order service answered ${res.status}`);
  const header = res.headers.get("x-content-sha256");
  if (header !== null && header !== pack.sha256) throw refused("the order service's own SHA-256 for it is not the config's");
  if (Number(res.headers.get("content-length") ?? "0") > LIMITS.download) throw refused("it is larger than the limit");
  const chunks = [];
  const hash = createHash("sha256");
  let n = 0;
  try {
    for await (const c of res.body) {
      n += c.length;
      if (n > LIMITS.download) throw refused("it is larger than the limit");
      hash.update(c);
      chunks.push(c);
    }
  } catch (err) {
    throw err instanceof GpError ? err : new GpError("pack-unreachable", "the skills pack could not be fetched: the connection broke");
  }
  if (hash.digest("hex") !== pack.sha256) throw new GpError("pack-checksum", "the skills pack is refused: its SHA-256 is not the one the config names");
  return Buffer.concat(chunks);
}

/** Installs `pack` ({name, sha256, url}), returning "current" (already there), "installed" or throws. `origin` is the order service's. */
export async function installPack(pack, origin, { fetchImpl = fetch } = {}) {
  if (typeof pack?.name !== "string" || !HEX64.test(pack?.sha256 ?? "") || typeof pack?.url !== "string") throw refused("the config's description of it is not complete");
  const before = readJson(L.pack);
  const have = Array.isArray(before.skills) ? before.skills : [];
  if (before.sha256 === pack.sha256 && have.every((s) => existsSync(join(L.skills, s, "SKILL.md")))) return "current";
  const entries = readTar(await download(pack, origin, fetchImpl));
  const skills = skillsOf(entries);
  for (const s of skills) if (!have.includes(s) && lstatSync(join(L.skills, s), { throwIfNoEntry: false })) throw refused(`a skill named ${s} is already there and is not from a pack`);
  mkdirSync(L.skills, { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(dirname(L.skills), "pack-"));
  try {
    for (const e of entries) {
      const to = join(stage, e.path);
      if (e.dir) mkdirSync(to, { recursive: true, mode: 0o755 });
      else (mkdirSync(dirname(to), { recursive: true, mode: 0o755 }), writeFileSync(to, e.data, { mode: 0o644 }));
    }
    for (const s of skills) {
      const into = join(L.skills, s);
      if (lstatSync(into, { throwIfNoEntry: false })) rmSync(into, { recursive: true, force: true });
      renameSync(join(stage, s), into);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  for (const s of have) if (!skills.includes(s)) rmSync(join(L.skills, s), { recursive: true, force: true });
  writeJson(L.pack, { name: pack.name, sha256: pack.sha256, skills, installed_at: new Date().toISOString() });
  return "installed";
}
