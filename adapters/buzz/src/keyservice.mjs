// The two halves of a key service, for launch.mjs. A key service runs the
// adapter's servers as another OS user, the one that holds the relay key, so
// the session's own processes never hold it (see README.md, "Key service"):
//
//   - pipe(): the session side. It holds no key and runs no key command: it
//     connects to the key service's Unix socket and copies bytes both ways.
//   - namedFd(), keyFdProblem(), readFd(), untrustedCode(): the key side
//     (`launch.mjs serve …`). The key arrives as a file descriptor systemd
//     opened (OpenFile=), never as a path or an environment variable this
//     process inherited.
//   - probe(): one real connection to a key service's socket, as the pipe
//     makes it, to check that it answers (`launch.mjs probe …`).
//
// Only Node.js built-ins here: the pipe must work before, and without, the
// adapter's dependencies.
import { closeSync, fstatSync, lstatSync, readdirSync, readSync, realpathSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";

/** How long the pipe keeps trying while the key service has not answered yet. */
export const PIPE_WAIT_MS = 10_000;
// Between tries the pipe waits RETRY_FIRST_MS, then twice as long each time,
// up to RETRY_MAX_MS: a restart race clears at the first or second try, and a
// key service that fails every connection is started a handful of times, not
// fifty, before the pipe gives up.
export const RETRY_FIRST_MS = 100;
export const RETRY_MAX_MS = 2000;
/** How long probe() waits for the key service's answer. */
export const PROBE_WAIT_MS = 30_000;
const MAX_BUFFERED = 4 * 1024 * 1024;
// Retrying cannot fix these: a socket this user may not open, or a bad path.
const PERMANENT = new Set(["EACCES", "EPERM", "EINVAL", "ENAMETOOLONG", "ENOTDIR"]);

/**
 * Copies `input` to the Unix socket at `path` and the socket to `output`,
 * until either side closes. Resolves with the exit code: 0 when the input
 * ended (the session closed the server), 1 when the key service closed first
 * or could not be reached.
 *
 * Until the key service sends its first byte, everything read from `input`
 * is kept (at most MAX_BUFFERED bytes). If the connection fails or closes
 * before that byte (the key service is restarting, or refuses a second
 * connection while the last one is still closing), the pipe connects again
 * and sends it all once more, for up to `waitMs`, waiting longer between tries
 * each time (RETRY_FIRST_MS, doubling up to RETRY_MAX_MS). After the first byte nothing
 * is kept and nothing is retried: the session's MCP state lives in that one
 * server process.
 *
 * Backpressure (pausing `input` while the socket is full) starts only after
 * the first byte. Before it, a full socket that is then dropped would never
 * drain, and `input` would stay paused on the next connection; the cap on
 * what is kept bounds the memory instead.
 */
export function pipe({ path, input, output, say, waitMs = PIPE_WAIT_MS }) {
  return new Promise((done) => {
    const started = Date.now();
    let buffered = []; // what the session sent before the first byte; null after it
    let bufferedBytes = 0;
    let inputEnded = false;
    let socket = null;
    let lastError;
    let finished = false;
    let graceTimer = null;
    let retryDelay = RETRY_FIRST_MS;

    const finish = (code, message) => {
      if (finished) return;
      finished = true;
      if (message) say(message);
      clearTimeout(graceTimer);
      input.off("data", onInput);
      input.off("end", onInputEnd);
      input.destroy();
      socket?.destroy();
      done(code);
    };

    const onInput = (chunk) => {
      if (buffered) {
        buffered.push(chunk);
        bufferedBytes += chunk.length;
        if (bufferedBytes > MAX_BUFFERED) return finish(1, "the key service has not answered, and the session sent too much meanwhile");
      }
      if (socket && !socket.write(chunk) && !buffered) {
        input.pause();
        socket.once("drain", () => input.resume());
      }
    };

    const onInputEnd = () => {
      inputEnded = true;
      socket?.end();
      // The session closed the server. Give the key service a moment to see
      // the end and close its side, then go anyway.
      graceTimer = setTimeout(() => finish(0), 2000);
      graceTimer.unref();
    };

    const connect = () => {
      const s = createConnection(path);
      socket = s;
      input.resume(); // never left paused by a connection that is gone
      for (const chunk of buffered ?? []) s.write(chunk);
      if (inputEnded) s.end();
      s.on("data", (chunk) => {
        buffered = null;
        bufferedBytes = 0;
        if (!output.write(chunk)) {
          s.pause();
          output.once("drain", () => s.resume());
        }
      });
      s.on("error", (err) => {
        lastError = err.code;
      });
      s.on("close", () => {
        if (finished || socket !== s) return;
        socket = null;
        if (inputEnded) return finish(0);
        if (!buffered) return finish(1, "the key service closed the connection");
        if (PERMANENT.has(lastError)) return finish(1, `cannot connect to the key service at ${path} (${lastError})`);
        const left = waitMs - (Date.now() - started);
        if (left <= 0) {
          return finish(
            1,
            `the key service at ${path} did not answer within ${waitMs} ms (${lastError ?? "it closed the connection before answering"})`,
          );
        }
        lastError = undefined;
        // The last wait ends at the deadline, so the last try is made there.
        setTimeout(connect, Math.min(retryDelay, left));
        retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      });
    };

    output.on("error", () => finish(1)); // the session is gone
    input.on("data", onInput);
    input.on("end", onInputEnd);
    connect();
  });
}

/**
 * One real connection to the key service's socket at `path`, as the pipe
 * makes it for a session: an MCP initialize request, then the server's
 * answer. Only initialize, never notifications/initialized: the channel
 * connects to the relay only after that one, so a probe never receives a
 * mention, and never moves the channel's cursor past one the session should
 * get. Resolves with { answered: true, server, channel } (the server's name,
 * and whether it declared itself a channel) or { answered: false, why } (a
 * fixed reason). Nothing else of what the server sends is passed on.
 */
export function probe({ path, timeoutMs = PROBE_WAIT_MS }) {
  return new Promise((done) => {
    let text = "";
    let settled = false;
    let timer = null;
    const socket = createConnection(path);
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      done(result);
    };
    timer = setTimeout(() => finish({ answered: false, why: `it sent no answer within ${timeoutMs} ms` }), timeoutMs);
    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ghost-protocol-probe", version: "1" } },
    };
    let connected = false;
    socket.on("connect", () => {
      connected = true;
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      text += chunk;
      if (text.length > MAX_BUFFERED) return finish({ answered: false, why: "its answer was too long" });
      for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n")) {
        const line = text.slice(0, i);
        text = text.slice(i + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // not a JSON-RPC line
        }
        if (message?.id !== 1) continue;
        if (!message.result || typeof message.result !== "object") return finish({ answered: false, why: "it answered initialize with an error" });
        const name = message.result.serverInfo?.name;
        return finish({
          answered: true,
          server: typeof name === "string" && /^[A-Za-z0-9._@/-]{1,64}$/.test(name) ? name : "(no name)",
          channel: Boolean(message.result.capabilities?.experimental?.["claude/channel"]),
        });
      }
    });
    // Once connected, an error is the far end going away (ECONNRESET when it
    // closes with the request unread), the same as a close.
    socket.on("error", (err) =>
      finish({
        answered: false,
        why: connected
          ? `the key service closed the connection before answering (${err.code ?? "error"})`
          : `could not connect (${err.code ?? "error"})`,
      }),
    );
    socket.on("close", () => finish({ answered: false, why: "the key service closed the connection before answering" }));
  });
}

/** The name systemd gives an Accept=yes connection in LISTEN_FDNAMES. */
const CONNECTION_FD_NAME = "connection";

/**
 * The file descriptor systemd handed over under `name`, or a fixed reason
 * string. As sd_listen_fds(3) says, the descriptors start at 3, LISTEN_FDS
 * counts them, and LISTEN_FDNAMES names each one, in order. Two lists are
 * taken:
 *
 *   - one name for each descriptor: the documented list, and what systemd
 *     259 and later hand over;
 *   - one name too many, "connection" first, while stdin is a socket
 *     (`stdinIsSocket`): what systemd 255 to 258 hand over under Accept=yes
 *     with StandardInput=socket. They put the connection on stdin and pass
 *     only the OpenFile= files, but keep the connection's name at the head
 *     of the list: LISTEN_FDS=1, LISTEN_FDNAMES=connection:buzz-key, and the
 *     key at descriptor 3. (systemd's own sd_listen_fds_with_names() refuses
 *     that list, since the counts differ; 259 drops the name.)
 *
 * Any other list is refused. keyFdProblem() then checks the descriptor this
 * names, whichever list it came from: a regular file, owned by root, that
 * only its owner can read.
 */
export function namedFd(env, name, pid, { stdinIsSocket = false } = {}) {
  const count = Number(env.LISTEN_FDS);
  if (!Number.isSafeInteger(count) || count < 1) return `no file descriptors were handed over (LISTEN_FDS); the key unit opens the key with OpenFile=<key file>:${name}:read-only`;
  if (env.LISTEN_PID !== String(pid)) return "LISTEN_PID does not name this process, so the handed-over file descriptors are not its own";
  let names = (env.LISTEN_FDNAMES ?? "").split(":");
  if (names.length === count + 1 && names[0] === CONNECTION_FD_NAME && stdinIsSocket) names = names.slice(1);
  if (names.length !== count) {
    return `LISTEN_FDNAMES names ${names.length} file descriptor(s), but LISTEN_FDS is ${count}; the key unit opens the key with OpenFile=<key file>:${name}:read-only`;
  }
  const at = names.flatMap((n, i) => (n === name ? [i] : []));
  if (at.length !== 1) return `LISTEN_FDNAMES must name exactly one file descriptor ${name}`;
  return 3 + at[0];
}

/**
 * Why the key's file descriptor must not be read, or null when it may be. It
 * must be a regular file, owned by a uid in `trusted`, with no permission
 * bits for its group or for others. Checked on the open descriptor itself
 * (fstat), so a renamed or replaced path cannot change what is checked.
 */
export function keyFdProblem(fd, trusted) {
  let st;
  try {
    st = fstatSync(fd);
  } catch {
    return `could not check file descriptor ${fd}`;
  }
  if (!st.isFile()) return "the key's file descriptor is not a regular file";
  if (!trusted.has(st.uid)) return `the key file is owned by uid ${st.uid}`;
  if (st.mode & 0o077) return "the key file has permissions for its group or for others; it must be readable by its owner only";
  return null;
}

/**
 * Reads an open file descriptor to its end (at most `max` bytes), then
 * closes it, whatever happened. Returns the bytes, or a fixed reason string;
 * neither the error nor the reason repeats what was read.
 */
export function readFd(fd, max = 4096) {
  const buf = Buffer.alloc(max + 1);
  let n = 0;
  try {
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > max) return `the key file is longer than ${max} bytes`;
    }
    return Buffer.from(buf.subarray(0, n));
  } catch {
    return `could not read file descriptor ${fd}`;
  } finally {
    buf.fill(0);
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
}

/** Why a file or folder is not trusted: its owner, or write bits for its group or others. */
function notTrusted(path, st, trusted) {
  if (!trusted.has(st.uid)) return `${path} is owned by uid ${st.uid}`;
  if (st.isSymbolicLink() || !(st.mode & 0o022)) return null;
  return `${path} can be written by its group or by others`;
}

/**
 * Why someone outside `trusted` could change what is in the folder `real`
 * (already resolved with realpath), or null: the folder and every folder
 * above it must be owned by a uid in `trusted` and not writable by its group
 * or by others, with no exception for sticky folders. What is inside the
 * folder is not walked.
 */
export function untrustedFolder(real, trusted) {
  for (let dir = real; ; dir = dirname(dir)) {
    const bad = notTrusted(dir, lstatSync(dir), trusted);
    if (bad) return bad;
    if (dir === dirname(dir)) return null;
  }
}

/**
 * The first reason that `paths` are code someone else could change, or null
 * when there is none. Each path, every file and folder under it, and every
 * folder above it must be owned by a uid in `trusted` and must not be
 * writable by its group or by others (POSIX ACLs that grant writing show as
 * group write). That holds for a sticky folder such as /tmp too: anyone can
 * add a node_modules folder to one, and Node.js looks for packages in every
 * folder above the code. A symbolic link is followed, and its target is
 * checked the same way.
 */
export function untrustedCode(paths, trusted) {
  const done = new Set(); // checked, with everything under it
  const above = new Set(); // checked, with every folder above it
  const why = (path, st) => notTrusted(path, st, trusted);

  // A path as given, or a link's target: resolved, then checked from / down.
  const enter = (path) => {
    let real;
    try {
      real = realpathSync.native(path);
    } catch {
      return `${path} is missing`;
    }
    for (let dir = dirname(real); !above.has(dir); dir = dirname(dir)) {
      above.add(dir);
      const bad = why(dir, lstatSync(dir));
      if (bad) return bad;
      if (dir === dirname(dir)) break;
    }
    return visit(real, lstatSync(real));
  };

  const visit = (path, st) => {
    if (done.has(path)) return null;
    done.add(path);
    const bad = why(path, st);
    if (bad) return bad;
    if (st.isSymbolicLink()) return enter(path);
    if (!st.isDirectory()) return null;
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      let cst;
      try {
        cst = lstatSync(child);
      } catch {
        continue; // removed meanwhile
      }
      const childBad = visit(child, cst);
      if (childBad) return childBad;
    }
    return null;
  };

  for (const p of paths) {
    const bad = enter(p);
    if (bad) return bad;
  }
  return null;
}
