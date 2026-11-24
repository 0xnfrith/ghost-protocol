// The key side of the git sign-in (`launch.mjs serve git`, one process per
// connection on the key service's git.sock). It answers one request with one
// NIP-98 sign-in for git over HTTP to one repository on the instance's own
// relay, and nothing else (README.md, "Git sign-in").
//
// The relay's git endpoints take `Authorization: Nostr <base64 event>`: a
// kind 27235 event whose `u` tag is the repository's root URL,
// <scheme>://<relay host>/git/<owner>/<repo>, signed by a member's key, with
// the owner's NIP-OA tag inside it when the agent logs in through its owner
// (git's credential protocol cannot add a second header). The relay honours
// one for about a minute, for every request of one clone, fetch or push.
//
// The request is one line of JSON, at most REQUEST_MAX bytes:
//   {"op":"sign","protocol":"https","host":"<relay host>","path":"git/<owner>/<repo>[/info/refs|/git-upload-pack|/git-receive-pack]"}
//   {"op":"ping"}
// The answer is one line of JSON:
//   {"ok":true,"credential":"<base64 event>"}   for sign
//   {"ok":true,"pubkey":"<64 hex>"}             for ping (setup's check)
//   {"ok":false,"error":"<fixed text>"}
// The event's kind, content and tags are built here; the request names only
// the repository. Anything but the relay's own scheme and host, or a path
// that is not one repository's, is refused, so this socket is never a way to
// sign in to the relay's other endpoints (/events, /query, media).
//
// launch.mjs serve has set BUZZ_PRIVATE_KEY from inside this process (and
// BUZZ_AUTH_TAG, when there is one); it is read once here and deleted.
import { finalizeEvent } from "nostr-tools/pure";
import { ConfigError, parseAuthTag, parseSecretKey, publicKeyOf, setting } from "./config.mjs";

export const KIND_HTTP_AUTH = 27235;
export const REQUEST_MAX = 4096;
export const REQUEST_WAIT_MS = 10_000;
const HEX64 = /^[0-9a-f]{64}$/;
const REPO = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The relay's git origin from BUZZ_RELAY_URL: { scheme, host }, the scheme
 * git uses (https for wss/https, http for ws/http) and the host with its port
 * as git names it. Throws ConfigError.
 */
export function relayGitOrigin(raw) {
  if (!raw) throw new ConfigError("set BUZZ_RELAY_URL");
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("BUZZ_RELAY_URL is not a valid URL");
  }
  const scheme = { "https:": "https", "wss:": "https", "http:": "http", "ws:": "http" }[url.protocol];
  if (!scheme) throw new ConfigError("BUZZ_RELAY_URL must start with https://, http://, wss:// or ws://");
  return { scheme, host: url.host.toLowerCase() };
}

/**
 * The repository root a request names, or a fixed reason it is refused.
 * The path is git's (credential.useHttpPath): no leading slash, and the
 * smart-HTTP suffix stripped the way the relay strips it.
 */
export function repoRoot(origin, request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return { error: "the request must be a JSON object" };
  const { protocol, host } = request;
  let { path } = request;
  if (protocol !== origin.scheme) return { error: `only ${origin.scheme} to the instance's relay` };
  if (typeof host !== "string" || host.toLowerCase() !== origin.host) return { error: "only the instance's own relay" };
  if (typeof path !== "string" || path.length > 512) return { error: "the path must name one repository: git/<owner>/<repo>" };
  path = path.replace(/^\/+/, "");
  const cut = path.indexOf("/info/refs");
  if (cut >= 0) path = path.slice(0, cut);
  else if (path.endsWith("/git-upload-pack")) path = path.slice(0, -"/git-upload-pack".length);
  else if (path.endsWith("/git-receive-pack")) path = path.slice(0, -"/git-receive-pack".length);
  path = path.replace(/\/+$/, ""); // a remote written with a trailing slash; the relay drops it too
  const parts = path.split("/");
  if (parts.length !== 3 || parts[0] !== "git") return { error: "the path must name one repository: git/<owner>/<repo>" };
  const [, owner, repo] = parts;
  if (!HEX64.test(owner)) return { error: "the repository's owner must be a public key (64 lowercase hex)" };
  if (!REPO.test(repo) || repo.startsWith(".") || repo.includes("..")) {
    return { error: "the repository's name must be 1 to 64 letters, digits, '.', '_' or '-', not starting with '.'" };
  }
  return { owner, repo, url: `${origin.scheme}://${origin.host}/git/${owner}/${repo}` };
}

/** The base64 sign-in for `url`: kind 27235, `u` and `method` tags, the owner's tag when set. */
export function signIn(secret, url, authTag, now = Date.now()) {
  const tags = [
    ["u", url],
    ["method", "GET"],
  ];
  if (authTag) tags.push(authTag);
  const event = finalizeEvent({ kind: KIND_HTTP_AUTH, created_at: Math.floor(now / 1000), content: "", tags }, secret);
  return Buffer.from(JSON.stringify(event), "utf8").toString("base64");
}

/** One answer to one parsed request (or a fixed refusal). Never throws. */
export function answer(state, request) {
  if (request?.op === "ping") return { ok: true, pubkey: state.pubkey };
  if (request?.op !== "sign") return { ok: false, error: "op must be sign or ping" };
  const root = repoRoot(state.origin, request);
  if (root.error) return { ok: false, error: root.error };
  return { ok: true, credential: signIn(state.secret, root.url, state.authTag), owner: root.owner, repo: root.repo };
}

/** Reads one line (at most REQUEST_MAX bytes) from `input`: the text, or null. */
export function readRequest(input, waitMs = REQUEST_WAIT_MS) {
  return new Promise((done) => {
    const chunks = [];
    let size = 0;
    let finished = false;
    const finish = (value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onEnd);
      done(value);
    };
    const onData = (chunk) => {
      const nl = chunk.indexOf(0x0a);
      const part = nl >= 0 ? chunk.subarray(0, nl) : chunk;
      size += part.length;
      if (size > REQUEST_MAX) return finish(null);
      chunks.push(part);
      if (nl >= 0) finish(Buffer.concat(chunks).toString("utf8"));
    };
    const onEnd = () => finish(size > 0 ? Buffer.concat(chunks).toString("utf8") : null);
    const timer = setTimeout(() => finish(null), waitMs);
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onEnd);
  });
}

async function main() {
  const say = (message) => process.stderr.write(`git-auth: ${message}\n`);
  const reply = (body) =>
    new Promise((done) => {
      process.stdout.write(`${JSON.stringify(body)}\n`, () => done());
    });
  let state;
  try {
    const secret = parseSecretKey(process.env.BUZZ_PRIVATE_KEY);
    delete process.env.BUZZ_PRIVATE_KEY;
    const pubkey = publicKeyOf(secret);
    state = {
      secret,
      pubkey,
      authTag: parseAuthTag(process.env, pubkey),
      origin: relayGitOrigin(setting(process.env, "BUZZ_RELAY_URL")),
    };
  } catch (err) {
    delete process.env.BUZZ_PRIVATE_KEY;
    const message = err instanceof ConfigError ? err.message : "could not read the private key";
    say(message);
    await reply({ ok: false, error: message });
    process.exit(2);
  }
  const line = await readRequest(process.stdin);
  let request = null;
  try {
    request = line === null ? null : JSON.parse(line);
  } catch {
    request = null;
  }
  const result = request === null ? { ok: false, error: "the request must be one line of JSON, at most 4096 bytes" } : answer(state, request);
  if (result.ok && result.credential) say(`signed a git sign-in for ${result.owner}/${result.repo}`);
  else if (result.ok) say("answered a ping");
  else say(`refused: ${result.error}`);
  const { owner: _o, repo: _r, ...body } = result;
  await reply(body);
  process.exit(result.ok ? 0 : 1);
}

// Run only as the served script, never when a test imports this module.
if (globalThis[Symbol.for("ghost-protocol.buzz.key-service")] === true) await main();
