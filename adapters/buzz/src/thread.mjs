// Reads the replies in one or more threads of one Buzz channel, then exits.
// Started by the launcher (`node launch.mjs thread …`), which runs
// BUZZ_KEY_COMMAND and hands the key over in BUZZ_PRIVATE_KEY, in this
// process's environment only. The key is used for the relay login alone.
//
//   node launch.mjs thread --channel <channel-id> --root <event id>... [--author <pubkey>] [--since <unix time>]
//
// The auto-mode guard uses it to read its owner's answer to an alert. It
// prints one JSON line per reply, oldest first:
//   {"id", "pubkey", "created_at", "root", "content"}
// Only a reply that passes every check here is printed, whatever the relay's
// filter did:
//   - a well-formed, correctly signed channel message (kind 9), its
//     signature checked here (nostr-tools' verifyEvent), so "pubkey" is the
//     key that really wrote it;
//   - in exactly this channel (one `h` tag, this one);
//   - a reply in the thread of one of the --root events (threadOf, the way
//     the channel reads a thread), never a root itself;
//   - with --author, written by that key (hex or npub1), which must not be
//     the reading key itself (so an agent can't answer its own question);
//   - no older than --since, and not more than ten minutes in the future.
// "content" is cut to 1000 characters. The caller still checks the author
// itself: this tool narrows what it is shown, and never decides for it.
//
// It logs in (NIP-42) the way the one-shot send does: a relay that sends its
// challenge at once is answered before the request; one that sends none
// within a few seconds gets the request without a login, and if it then
// closes it with "auth-required:", the login follows its challenge and the
// same request goes once more. With BUZZ_AUTH_TAG (the owner's NIP-OA
// attestation), the login carries it as its one `auth` tag.
//
// Exit 0: the relay answered (EOSE), with or without replies. Exit 1: the
// relay refused the login or the request, closed the connection, could not
// be reached, or did not answer within BUZZ_SEND_TIMEOUT_MS (default 30000).
// Exit 2: usage, or a bad setting or key. stderr says why in fixed words or
// the relay's own reason, never with the key or a message's text.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import {
  ConfigError,
  parseAuthTag,
  parsePublicKey,
  parseSecretKey,
  publicKeyOf,
  relaySocketUrl,
  setting,
} from "./config.mjs";
import { KIND_MESSAGE, threadOf } from "./relay.mjs";

const KIND_AUTH = 22242;
const AUTH_WAIT_MS = 3000;
const LIMIT = 500;
const MAX_CONTENT = 1000;
const MAX_ROOTS = 20;
const MAX_FUTURE_SECONDS = 600;
const CHANNEL = /^[A-Za-z0-9-]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SINCE = /^(0|[1-9][0-9]{0,11})$/;

const say = (message) => process.stderr.write(`buzz thread: ${message}\n`);
const text = (value) => (typeof value === "string" ? value.slice(0, 200) : "");

function quit(code, message) {
  if (message) say(message);
  process.exit(code);
}

function args(argv) {
  let channel;
  let author;
  let since;
  const roots = [];
  const usage = "usage: thread --channel <channel-id> --root <event id>... [--author <pubkey>] [--since <unix time>]";
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--channel", "--root", "--author", "--since"].includes(flag)) quit(2, usage);
    if (value === undefined) quit(2, `${flag} needs a value`);
    if (flag === "--root") roots.push(value);
    else if (flag === "--channel" && channel === undefined) channel = value;
    else if (flag === "--author" && author === undefined) author = value;
    else if (flag === "--since" && since === undefined) since = value;
    else quit(2, usage);
  }
  if (!channel || !CHANNEL.test(channel)) quit(2, "--channel must be a channel id");
  if (roots.length === 0) quit(2, "at least one --root is needed");
  if (roots.length > MAX_ROOTS) quit(2, `at most ${MAX_ROOTS} --root values`);
  if (!roots.every((r) => HEX64.test(r))) quit(2, "--root must be an event id (64 lower-case hex characters)");
  let authorHex;
  if (author !== undefined) {
    try {
      authorHex = parsePublicKey(author, "--author");
    } catch (err) {
      quit(2, err instanceof ConfigError ? err.message : "--author is not a public key");
    }
  }
  if (since !== undefined && !SINCE.test(since)) quit(2, "--since must be a unix time in seconds");
  return { channel, roots: [...new Set(roots)], author: authorHex, since: since === undefined ? undefined : Number(since) };
}

/** True when `event` is a reply this tool may print (see the head of this file). */
export function acceptable(event, { channel, roots, author, since, now = Math.floor(Date.now() / 1000) }) {
  if (!event || typeof event !== "object" || event.kind !== KIND_MESSAGE) return false;
  if (typeof event.id !== "string" || !HEX64.test(event.id)) return false;
  if (typeof event.pubkey !== "string" || !HEX64.test(event.pubkey)) return false;
  if (typeof event.content !== "string" || !Array.isArray(event.tags)) return false;
  const at = event.created_at;
  if (!Number.isSafeInteger(at) || at <= 0 || at > now + MAX_FUTURE_SECONDS) return false;
  if (since !== undefined && at < since) return false;
  const hs = new Set(event.tags.filter((t) => Array.isArray(t) && t[0] === "h").map((t) => t[1]));
  if (hs.size !== 1 || !hs.has(channel)) return false;
  const root = threadOf(event);
  if (!root || !roots.includes(root)) return false;
  if (author !== undefined && event.pubkey !== author) return false;
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

// Run as a program (the launcher starts it as one); a test may import
// `acceptable` without starting a read.
if (isMain()) await main();

function isMain() {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

async function main() {
  const { channel, roots, author, since } = args(process.argv.slice(2));
  let secret;
  try {
    secret = parseSecretKey(process.env.BUZZ_PRIVATE_KEY);
  } catch (err) {
    quit(2, err instanceof ConfigError ? err.message : "could not read the private key");
  }
  delete process.env.BUZZ_PRIVATE_KEY;
  let url;
  try {
    const raw = setting(process.env, "BUZZ_RELAY_URL");
    if (!raw) throw new ConfigError("set BUZZ_RELAY_URL");
    url = relaySocketUrl(raw);
  } catch (err) {
    quit(2, err instanceof ConfigError ? err.message : "BUZZ_RELAY_URL is not usable");
  }
  if (author !== undefined && author === publicKeyOf(secret)) {
    quit(2, "--author is this key's own: an owner's answer must come from another key");
  }
  let authTag;
  try {
    authTag = parseAuthTag(process.env, publicKeyOf(secret));
  } catch (err) {
    quit(2, err instanceof ConfigError ? err.message : "BUZZ_AUTH_TAG is not usable");
  }
  const timeoutMs = Number.parseInt(setting(process.env, "BUZZ_SEND_TIMEOUT_MS") ?? "30000", 10);
  const limitMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;

  const filter = { kinds: [KIND_MESSAGE], "#h": [channel], "#e": roots, limit: LIMIT };
  if (author !== undefined) filter.authors = [author];
  if (since !== undefined) filter.since = since;
  const subId = `guard-thread-${Date.now()}`;
  const found = new Map();
  let authId = null;
  let authed = false;
  let requested = false;
  let retried = false;
  let waitingForLogin = false;

  const ws = new WebSocket(url);
  const deadline = setTimeout(() => quit(1, `no answer from the relay within ${limitMs} ms`), limitMs);
  let authTimer = null;

  const request = () => {
    clearTimeout(authTimer);
    requested = true;
    ws.send(JSON.stringify(["REQ", subId, filter]));
  };
  const login = (challenge) => {
    const auth = finalizeEvent(
      {
        kind: KIND_AUTH,
        created_at: Math.floor(Date.now() / 1000),
        content: "",
        tags: [["relay", url], ["challenge", challenge], ...(authTag ? [[...authTag]] : [])],
      },
      secret,
    );
    authId = auth.id;
    ws.send(JSON.stringify(["AUTH", auth]));
  };
  const finish = () => {
    clearTimeout(deadline);
    const replies = [...found.values()].sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));
    for (const e of replies) {
      process.stdout.write(
        `${JSON.stringify({
          id: e.id,
          pubkey: e.pubkey,
          created_at: e.created_at,
          root: threadOf(e),
          content: e.content.slice(0, MAX_CONTENT),
        })}\n`,
      );
    }
    ws.close();
    process.exit(0);
  };

  ws.onopen = () => {
    authTimer = setTimeout(() => {
      if (!requested) request();
    }, AUTH_WAIT_MS);
  };
  ws.onmessage = (frame) => {
    let data;
    try {
      data = JSON.parse(typeof frame.data === "string" ? frame.data : String(frame.data));
    } catch {
      return;
    }
    if (!Array.isArray(data)) return;
    const [type, a, b] = data;
    if (type === "AUTH" && typeof a === "string" && authId === null) {
      clearTimeout(authTimer);
      login(a);
    } else if (type === "OK" && authId !== null && a === authId && !authed) {
      if (b !== true) quit(1, `the relay refused the login: ${text(data[3])}`);
      authed = true;
      if (!requested) request();
      else if (waitingForLogin && !retried) {
        retried = true;
        found.clear();
        request();
      }
    } else if (type === "EVENT" && a === subId) {
      if (acceptable(b, { channel, roots, author, since })) found.set(b.id, b);
    } else if (type === "EOSE" && a === subId) {
      finish();
    } else if (type === "CLOSED" && a === subId) {
      const reason = text(b);
      if (reason.startsWith("auth-required:") && !retried) {
        if (authed) {
          retried = true;
          request();
        } else waitingForLogin = true;
        return;
      }
      clearTimeout(deadline);
      quit(1, `the relay refused the request: ${reason}`);
    }
  };
  ws.onerror = () => quit(1, "could not reach the relay");
  ws.onclose = (event) => quit(1, `the relay closed the connection (code ${event?.code ?? "unknown"})`);
}
