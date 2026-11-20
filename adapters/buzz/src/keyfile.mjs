#!/usr/bin/env node
// The key file of a key service (README.md, "Key service"): the one file that
// holds an agent's relay private key, read only by root. GHOST Protocol's key
// service installer (install/keyservice/setup) runs this as root, from its
// root-owned copy of the adapter:
//
//   node keyfile.mjs write <path>      the key from stdin (64 hex or nsec1) into a new <path>;
//                                      stdin a pipe or a file, never a terminal (refused there)
//   node keyfile.mjs generate <path>   a new key, made here, into a new <path>
//   node keyfile.mjs pubkey <path>     the public key of the key in <path>
//
// Each prints the key's public key (64 hex) on stdout, and nothing else. The
// key itself is never printed, logged or put in an environment variable. A new
// file is written as 64 hex characters and a newline, mode 0400, under a
// temporary name in the same folder, and then linked to <path> in one step,
// which fails when <path> already exists: a key file is never replaced.
// Replacing an agent's key is a deliberate act; remove the old file first.
//
// Exit codes: 0 done; 1 the file or the key was refused (a fixed message on
// stderr, never with the key); 2 usage.
import { closeSync, constants, fstatSync, fsyncSync, linkSync, openSync, readSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isatty } from "node:tty";
import { generateSecretKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { ConfigError, parseSecretKey, publicKeyOf } from "./config.mjs";

const MAX = 4096;

function quit(code, message) {
  if (message) process.stderr.write(`keyfile: ${message}\n`);
  process.exit(code);
}

/** Reads a file descriptor to its end, at most MAX bytes; the buffer is zeroed after. */
function readAll(fd) {
  const buf = Buffer.alloc(MAX + 1);
  let n = 0;
  try {
    for (;;) {
      let r;
      try {
        r = readSync(fd, buf, n, buf.length - n, null);
      } catch (err) {
        if (err.code === "EAGAIN") continue;
        throw err;
      }
      if (r === 0) break;
      n += r;
      if (n > MAX) quit(1, `the key is longer than ${MAX} bytes`);
    }
    return buf.toString("utf8", 0, n);
  } catch {
    return quit(1, "could not read the key");
  } finally {
    buf.fill(0);
  }
}

function secretFrom(text) {
  try {
    return parseSecretKey(text);
  } catch (err) {
    return quit(1, err instanceof ConfigError ? err.message : "the key is not a valid private key");
  }
}

/** Writes the key as hex into a new file at `path`, mode 0400, never over one that is there. */
function writeNew(path, secret) {
  const tmp = join(dirname(path), `.${basename(path)}.new-${process.pid}`);
  let fd;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  } catch {
    quit(1, `could not create a file in ${dirname(path)}`);
  }
  const hex = Buffer.from(`${bytesToHex(secret)}\n`, "utf8");
  let problem = null;
  try {
    writeSync(fd, hex);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(tmp, path);
  } catch (err) {
    problem = err.code === "EEXIST" ? `${path} already exists; a key file is never replaced` : `could not put the key at ${path}`;
  } finally {
    hex.fill(0);
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
  }
  if (problem) quit(1, problem);
}

const [command, path, ...rest] = process.argv.slice(2);
if (!["write", "generate", "pubkey"].includes(command) || !path || rest.length > 0 || !path.startsWith("/")) {
  quit(2, "usage: keyfile.mjs write|generate|pubkey <absolute path>");
}

let secret;
if (command === "write") {
  // A key typed into a terminal shows on its screen and stays in its scrollback.
  if (isatty(0)) quit(2, "write reads the key from a pipe or a file, never from a terminal");
  secret = secretFrom(readAll(0));
  writeNew(path, secret);
} else if (command === "generate") {
  secret = generateSecretKey();
  writeNew(path, secret);
} else {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    quit(1, `could not open ${path}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) quit(1, `${path} is not a regular file`);
    if (st.mode & 0o077) quit(1, `${path} has permissions for its group or for others; it must be readable by its owner only`);
    secret = secretFrom(readAll(fd));
  } finally {
    closeSync(fd);
  }
}
process.stdout.write(`${publicKeyOf(secret)}\n`);
secret.fill(0);
