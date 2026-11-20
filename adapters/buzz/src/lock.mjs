// The channel's optional lock (BUZZ_CHANNEL_LOCK=on): one listener per
// cursor. Without it, two sessions with the same settings both listen and
// share one cursor, as before.
//
// The lock is a file beside the cursor, `<cursor file>.lock`, created only
// if it does not exist yet, holding a random token. Its holder touches it
// every second. A newcomer waits for the holder to remove it on exit; a lock
// nobody has touched for STALE_MS (its holder was killed) is taken over. A
// newcomer that still finds a live lock after WAIT_MS gives up.
//
// Two newcomers that take over the same stale lock at the same moment can
// both believe they hold it. The holder checks its token on every touch, so
// the one that lost stops within a second.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const WAIT_MS = 8000;
export const STALE_MS = 5000;
const BEAT_MS = 1000;
const POLL_MS = 100;

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Takes the lock at `file`. Resolves with a release function, or with null
 * when another live process still holds it after `waitMs`. `onLost` runs if
 * the lock is later found to belong to someone else.
 */
export async function acquireLock(file, { onLost, log = () => {}, waitMs = WAIT_MS, staleMs = STALE_MS } = {}) {
  const token = `${randomBytes(16).toString("hex")} ${process.pid}\n`;
  const deadline = Date.now() + waitMs;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      writeFileSync(file, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    let age;
    try {
      age = Date.now() - statSync(file).mtimeMs;
    } catch {
      continue; // released meanwhile: try again at once
    }
    if (age > staleMs) {
      log(`taking over a channel lock nobody has touched for ${Math.round(age / 1000)} s`);
      try {
        unlinkSync(file);
      } catch {
        // someone else took it over first
      }
      continue;
    }
    if (Date.now() > deadline) return null;
    await pause(POLL_MS);
  }

  const holds = () => {
    try {
      return readFileSync(file, "utf8") === token;
    } catch {
      return false;
    }
  };
  const beat = setInterval(() => {
    if (!holds()) {
      clearInterval(beat);
      onLost?.();
      return;
    }
    try {
      const now = new Date();
      utimesSync(file, now, now);
    } catch {
      // the next beat tries again
    }
  }, BEAT_MS);
  beat.unref();
  const release = () => {
    clearInterval(beat);
    if (holds()) {
      try {
        unlinkSync(file);
      } catch {
        // gone already
      }
    }
  };
  process.on("exit", release);
  return release;
}
