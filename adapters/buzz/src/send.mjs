// Sends one message to one Buzz channel, then exits. Started by the launcher
// (`node launch.mjs send …`), which runs BUZZ_KEY_COMMAND and hands the key
// over in BUZZ_PRIVATE_KEY, in this process's environment only.
//
//   printf '%s' "text" | node launch.mjs send --channel <channel-id> [--mention <pubkey>]... [--reply <event id>]
//
// The text comes on stdin (at most 32 KB). Each --mention (hex or npub1) adds
// a `p` tag, which is what notifies that person; "@Name" text alone does not.
// The message is a channel message the way Buzz's own tools write one: kind
// 9, an `h` tag naming the channel, a `p` tag per mention, and an `ms` tag
// (the sub-second send order). With --reply (a thread root's event id, 64
// hex characters) it goes into that thread: one `e` tag with the `reply`
// marker, as Buzz files a reply to a root.
//
// It logs in (NIP-42) whenever the relay sends a challenge. A relay that
// sends one at once gets the message only after it accepts the login. A
// relay that sends none within a few seconds gets the message without one;
// if it then refuses it with "auth-required:", the login follows its
// challenge (whenever that comes), and the same message goes once more.
// When BUZZ_AUTH_TAG holds the owner's NIP-OA attestation, the login (the
// AUTH event) carries it as its one `auth` tag, as the channel's does, so a
// key that is on the relay only through its owner can send. It is read and
// checked by the channel's own code (parseAuthTag in config.mjs); unset, the
// login is exactly as before.
//
// Exit 0: the relay accepted the message (`["OK", <id>, true, …]`); stdout
// then says `sent <event id>`. Exit 1: the relay refused the login, closed
// the connection, could not be reached, or did not answer within
// BUZZ_SEND_TIMEOUT_MS (default 30000). Exit 2: usage, or a bad setting, key
// or text (the send refused it). Exit 3: the relay refused the message (its
// reason on stderr). stderr says why in fixed words or the relay's own
// reason, never with the key or the text.
import { finalizeEvent } from "nostr-tools/pure";
import {
  ConfigError,
  parseAuthTag,
  parsePublicKey,
  parseSecretKey,
  publicKeyOf,
  relaySocketUrl,
  setting,
} from "./config.mjs";

const KIND_MESSAGE = 9;
const KIND_AUTH = 22242;
const MAX_TEXT = 32 * 1024;
const AUTH_WAIT_MS = 3000;
const CHANNEL = /^[A-Za-z0-9-]{1,64}$/;
const EVENT_ID = /^[0-9a-f]{64}$/;

const say = (message) => process.stderr.write(`buzz send: ${message}\n`);
const text = (value) => (typeof value === "string" ? value.slice(0, 200) : "");

function quit(code, message) {
  if (message) say(message);
  process.exit(code);
}

function args(argv) {
  let channel;
  let reply;
  const mentions = [];
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if ((flag === "--channel" || flag === "--mention" || flag === "--reply") && value === undefined) {
      quit(2, `${flag} needs a value`);
    }
    if (flag === "--channel") channel = value;
    else if (flag === "--mention") mentions.push(value);
    else if (flag === "--reply" && reply === undefined) reply = value;
    else quit(2, "usage: send --channel <channel-id> [--mention <pubkey>]... [--reply <event id>] (the text on stdin)");
    i += 1;
  }
  if (!channel || !CHANNEL.test(channel)) quit(2, "--channel must be a channel id");
  if (reply !== undefined && !EVENT_ID.test(reply)) quit(2, "--reply must be an event id (64 lower-case hex characters)");
  const pubkeys = [];
  for (const m of mentions) {
    try {
      pubkeys.push(parsePublicKey(m, "--mention"));
    } catch (err) {
      quit(2, err instanceof ConfigError ? err.message : "--mention is not a public key");
    }
  }
  return { channel, reply, mentions: [...new Set(pubkeys)] };
}

async function readText() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_TEXT) quit(2, `the text is longer than ${MAX_TEXT} bytes`);
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) quit(2, "no text on stdin");
  return body;
}

const { channel, reply, mentions } = args(process.argv.slice(2));
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
let authTag; // the owner's NIP-OA `auth` tag, or undefined
try {
  authTag = parseAuthTag(process.env, publicKeyOf(secret));
} catch (err) {
  quit(2, err instanceof ConfigError ? err.message : "BUZZ_AUTH_TAG is not usable");
}
const timeoutMs = Number.parseInt(setting(process.env, "BUZZ_SEND_TIMEOUT_MS") ?? "30000", 10);
const content = await readText();

const now = Date.now();
const message = finalizeEvent(
  {
    kind: KIND_MESSAGE,
    created_at: Math.floor(now / 1000),
    content,
    tags: [
      ["h", channel],
      ...(reply ? [["e", reply, "", "reply"]] : []),
      ...mentions.map((p) => ["p", p]),
      ["ms", String(now % 1000)],
    ],
  },
  secret,
);

const ws = new WebSocket(url);
let authId = null; // the login, once one is signed
let authed = false; // the relay accepted it
let published = false; // the message went out at least once
let resent = false; // ... and once more, after an auth-required refusal
let waitingForLogin = false; // refused with auth-required; resend after the login
const limitMs = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
const deadline = setTimeout(() => {
  if (waitingForLogin && authId === null) quit(1, `the relay wants a login but sent no challenge within ${limitMs} ms`);
  quit(1, `no answer from the relay within ${limitMs} ms`);
}, limitMs);
let authTimer = null;

function publish() {
  clearTimeout(authTimer);
  ws.send(JSON.stringify(["EVENT", message]));
}

function publishFirst() {
  if (published) return;
  published = true;
  publish();
}

function login(challenge) {
  const auth = finalizeEvent(
    {
      kind: KIND_AUTH,
      created_at: Math.floor(Date.now() / 1000),
      content: "",
      tags: [
        ["relay", url],
        ["challenge", challenge],
        // At most one `auth` tag: NIP-OA reads two or more as none.
        ...(authTag ? [[...authTag]] : []),
      ],
    },
    secret,
  );
  authId = auth.id;
  ws.send(JSON.stringify(["AUTH", auth]));
}

ws.onopen = () => {
  // A relay that wants a login usually sends its challenge at once; one that
  // sends none in time gets the message without it.
  authTimer = setTimeout(publishFirst, AUTH_WAIT_MS);
};
ws.onmessage = (frame) => {
  let data;
  try {
    data = JSON.parse(typeof frame.data === "string" ? frame.data : String(frame.data));
  } catch {
    return;
  }
  if (!Array.isArray(data)) return;
  const [type, a, b, c] = data;
  if (type === "AUTH" && typeof a === "string" && authId === null) {
    // A challenge, whenever it comes: before the message or after it.
    clearTimeout(authTimer);
    login(a);
  } else if (type === "OK" && authId !== null && a === authId && !authed) {
    if (b !== true) quit(1, `the relay refused the login: ${text(c)}`);
    authed = true;
    if (!published) publishFirst();
    else if (waitingForLogin && !resent) {
      resent = true;
      publish();
    }
  } else if (type === "OK" && a === message.id) {
    if (b === true) {
      clearTimeout(deadline);
      process.stdout.write(`sent ${message.id}\n`);
      ws.close();
      process.exit(0);
    }
    const reason = text(c);
    if (reason.startsWith("auth-required:") && !resent) {
      // This relay asks for the login only now: answer its challenge (which
      // came, or will come) and send the same message once more.
      if (authed) {
        resent = true;
        publish();
      } else waitingForLogin = true;
      return;
    }
    clearTimeout(deadline);
    quit(3, `the relay refused the message: ${reason}`);
  }
};
ws.onerror = () => quit(1, "could not reach the relay");
ws.onclose = (event) => quit(1, `the relay closed the connection (code ${event?.code ?? "unknown"})`);
