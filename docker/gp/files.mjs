// Reading and writing the volume's small files: JSON read with a fallback, and
// writes that are atomic (a temp file, then a rename) with a fixed mode.
import { mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export function readJson(p, fallback = {}) {
  try {
    const v = JSON.parse(readFileSync(p, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

export function writeFileAtomic(p, text, mode = 0o600) {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, p);
}

export const writeJson = (p, v, mode = 0o600) => writeFileAtomic(p, JSON.stringify(v, null, 2) + "\n", mode);
