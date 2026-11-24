#!/usr/bin/env node
// git's credential helper for the relay's git repositories, on the session's
// side of a key service (README.md, "Git sign-in"). It holds no key: it asks
// the key service's git.sock for a sign-in and hands it to git.
//
// install/keyservice/setup names it in the instance user's git settings, for
// the relay's address only:
//   [credential "https://<relay host>"]
//       helper =
//       helper = !<node> <this file> --socket /run/ghost-protocol-key/<name>/git.sock
//       useHttpPath = true
//
//   git-credential.mjs --socket <path> get     git's call (stdin: its request)
//   git-credential.mjs --socket <path> store|erase   nothing to do
//   git-credential.mjs --socket <path> probe   asks the socket for its key's
//                                              public key: one line, exit 0
//                                              only when it answered
//
// For `get` it answers only a relay's own challenge (wwwauth[] "Nostr ..."),
// and only to a git that can take a whole Authorization header
// (capability[]=authtype, git 2.46 or newer). Otherwise it prints nothing git
// would use and exits 0, so git goes on as if it were not there. What it sends
// the key service is the protocol, host and path git named, nothing else; the
// key service builds and signs the event, and refuses any other address.
// The sign-in is printed to git only, never to stderr or a log.
//
// Only Node.js built-ins here: it runs from the key service's root-owned copy
// of this adapter, which the session's user can read but not change.
import { createConnection } from "node:net";

const WAIT_MS = 10_000;
const ANSWER_MAX = 64 * 1024;

const say = (message) => process.stderr.write(`gp git-credential: ${message}\n`);

function args(argv) {
  let socket;
  let action;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--socket") socket = argv[++i];
    else if (action === undefined) action = argv[i];
    else return {};
  }
  return { socket, action };
}

/** git's request on stdin: the lines up to a blank one, as a list of [key, value]. */
async function readRequest(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += chunk.length;
    if (size > 64 * 1024) break;
    chunks.push(chunk);
    if (Buffer.concat(chunks).includes("\n\n")) break;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const lines = [];
  for (const line of text.split("\n")) {
    if (line === "") break;
    const eq = line.indexOf("=");
    if (eq > 0) lines.push([line.slice(0, eq), line.slice(eq + 1)]);
  }
  return lines;
}

/** One request to the socket, one JSON answer back (or an Error). */
function ask(socket, request) {
  return new Promise((done) => {
    const conn = createConnection(socket);
    const chunks = [];
    let size = 0;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      conn.destroy();
      done(value);
    };
    const timer = setTimeout(() => finish(new Error("the key service did not answer in time")), WAIT_MS);
    conn.on("connect", () => conn.write(`${JSON.stringify(request)}\n`));
    conn.on("data", (chunk) => {
      size += chunk.length;
      if (size > ANSWER_MAX) return finish(new Error("the key service's answer is too long"));
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString("utf8");
      const nl = text.indexOf("\n");
      if (nl < 0) return;
      try {
        finish(JSON.parse(text.slice(0, nl)));
      } catch {
        finish(new Error("the key service's answer is not JSON"));
      }
    });
    conn.on("error", (err) => finish(new Error(`could not reach the key service (${err.code ?? "error"})`)));
    conn.on("close", () => finish(new Error("the key service closed the connection before answering")));
  });
}

async function main() {
  const { socket, action } = args(process.argv.slice(2));
  if (!socket || !action) {
    say("usage: git-credential.mjs --socket <path> get|store|erase|probe");
    return 2;
  }
  if (action === "probe") {
    const r = await ask(socket, { op: "ping" });
    if (r instanceof Error) {
      process.stdout.write(`probe: ${socket}: ${r.message}\n`);
      return 1;
    }
    if (r?.ok === true && typeof r.pubkey === "string" && /^[0-9a-f]{64}$/.test(r.pubkey)) {
      process.stdout.write(`probe: ${socket} answered (key ${r.pubkey})\n`);
      return 0;
    }
    process.stdout.write(`probe: ${socket} answered, but not with its key${r?.error ? ` (${r.error})` : ""}\n`);
    return 1;
  }
  if (action !== "get") return 0; // store, erase: the sign-in is never kept
  const lines = await readRequest(process.stdin);
  const get = (key) => lines.find(([k]) => k === key)?.[1];
  const authtype = lines.some(([k, v]) => k === "capability[]" && v === "authtype");
  const challenge = lines.some(([k, v]) => k === "wwwauth[]" && v.startsWith("Nostr "));
  // Not a relay's challenge, or a git too old to send the header: say nothing.
  if (!authtype || !challenge) {
    process.stdout.write("\n");
    return 0;
  }
  const protocol = get("protocol");
  const host = get("host");
  const path = get("path");
  if (!path) {
    say("git sent no path: set credential.useHttpPath to true for the relay's address");
    return 1;
  }
  const r = await ask(socket, { op: "sign", protocol, host, path });
  if (r instanceof Error) {
    say(r.message);
    return 1;
  }
  if (r?.ok !== true || typeof r.credential !== "string" || !/^[A-Za-z0-9+/=]+$/.test(r.credential)) {
    say(`the key service refused: ${typeof r?.error === "string" ? r.error : "no sign-in in its answer"}`);
    return 1;
  }
  process.stdout.write(
    ["capability[]=authtype", "authtype=Nostr", `credential=${r.credential}`, "ephemeral=true", "quit=true", "", ""].join("\n"),
  );
  return 0;
}

process.exitCode = await main();
