// The channel's log. Every line goes to stderr and to a small log file.
//
// Claude Code shows a server's stderr only while the server starts, so the
// file is where connects, drops, reconnects and skipped messages can be read
// later. It holds what stderr holds: ids, public keys, times and reasons,
// never message text and never key material. It is written owner-only and
// rotated: past maxBytes the file moves to `<file>.1`, replacing the one
// before, and a new file starts.
//
// Logging never throws. A full disk or an unwritable folder must not stop the
// channel, least of all on the way to a reconnect.
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

export const LOG_MAX_BYTES = 1_000_000;
// When nothing reads stderr, Node queues the writes in memory; past this
// many queued bytes, lines go to the file only.
const STDERR_MAX_QUEUED = 256 * 1024;

/**
 * @param {object} [o]
 * @param {string} [o.file] the log file; stderr only when absent
 * @param {number} [o.maxBytes] the size at which the file is rotated
 * @param {{write: (s: string) => unknown, writableLength?: number}} [o.stderr]
 * @returns {(message: string) => void}
 */
export function createLog({ file, maxBytes = LOG_MAX_BYTES, stderr = process.stderr } = {}) {
  let size = null; // the file's size, read again after a failed write
  let failing = false;

  const toStderr = (line) => {
    try {
      if (!(stderr.writableLength > STDERR_MAX_QUEUED)) stderr.write(line);
    } catch {
      // stderr is gone; the file may still work
    }
  };

  const toFile = (line) => {
    if (size === null) {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      try {
        size = statSync(file).size;
      } catch {
        size = 0;
      }
    }
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) {
      renameSync(file, `${file}.1`);
      size = 0;
    }
    appendFileSync(file, line, { mode: 0o600 });
    size += bytes;
  };

  return (message) => {
    const line = `${new Date().toISOString()} buzz-channel: ${message}\n`;
    toStderr(line);
    if (!file) return;
    try {
      toFile(line);
      failing = false;
    } catch {
      size = null;
      if (!failing) toStderr(`${new Date().toISOString()} buzz-channel: could not write the log file\n`);
      failing = true;
    }
  };
}
