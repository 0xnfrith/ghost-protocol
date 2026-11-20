// The one-shot send (`node launch.mjs send`, src/send.mjs) against the fake
// relay: the message it writes, the login (with and without the owner's
// NIP-OA attestation, BUZZ_AUTH_TAG), every way it can fail, and that the key
// never reaches its output.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { after, test } from "node:test";
import { verifyEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { startFakeRelay } from "./fake-relay.mjs";
import { identity, LAUNCH } from "./helpers.mjs";

const CHANNEL = "0000aaaa-1111-2222-3333-444455556666";
const relays = [];
after(async () => {
  for (const r of relays) await r.close?.();
});

async function relay(options) {
  const r = await startFakeRelay(options);
  relays.push(r);
  return r;
}

/** Runs the launcher's send, the way the auto-mode guard does, and collects its output. */
function send({ relayUrl, key, args = ["--channel", CHANNEL], input = "hello from the test", env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCH, "send", ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        BUZZ_RELAY_URL: relayUrl,
        BUZZ_KEY_COMMAND: `printf %s ${key.hex}`,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

function keyNeverShown(result, key) {
  for (const s of [result.stdout, result.stderr]) {
    assert.ok(!s.includes(key.hex), "the hex key is never printed");
    assert.ok(!s.includes(key.nsec), "the nsec key is never printed");
  }
}

test("sends one channel message: kind 9, the h tag, a p tag per mention, an ms tag", async () => {
  const r = await relay();
  const key = identity();
  const other = identity();
  const third = identity();
  const result = await send({
    relayUrl: r.url,
    key,
    args: ["--channel", CHANNEL, "--mention", other.pubkey, "--mention", third.npub, "--mention", other.pubkey],
    input: "Auto-mode guard: a test message.\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(r.stats.events.length, 1);
  const event = r.stats.events[0];
  assert.match(result.stdout, new RegExp(`^sent ${event.id}\\n$`));
  assert.ok(verifyEvent(event));
  assert.equal(event.kind, 9);
  assert.equal(event.pubkey, key.pubkey);
  assert.equal(event.content, "Auto-mode guard: a test message.\n");
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "h"),
    [["h", CHANNEL]],
  );
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "p"),
    [
      ["p", other.pubkey],
      ["p", third.pubkey],
    ],
    "an npub becomes hex, and a repeated mention counts once",
  );
  const ms = event.tags.find((t) => t[0] === "ms");
  assert.ok(ms && /^(0|[1-9][0-9]{0,2})$/.test(ms[1]), "an ms tag of 0-999");
  assert.equal(r.stats.auths, 1, "it logged in first");
  assert.deepEqual(r.stats.authTags, [[]], "no BUZZ_AUTH_TAG: the login carries no auth tag");
  keyNeverShown(result, key);
});

test("--reply puts the message in that thread: one e tag with the reply marker, as Buzz files a reply to a root", async () => {
  const r = await relay();
  const key = identity();
  const owner = identity();
  const root = "c".repeat(64);
  const result = await send({
    relayUrl: r.url,
    key,
    args: ["--channel", CHANNEL, "--reply", root, "--mention", owner.pubkey],
    input: "Here they are.",
  });
  assert.equal(result.status, 0, result.stderr);
  const event = r.stats.events[0];
  assert.ok(verifyEvent(event));
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "e"),
    [["e", root, "", "reply"]],
  );
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "h"),
    [["h", CHANNEL]],
  );
  assert.deepEqual(
    event.tags.filter((t) => t[0] === "p"),
    [["p", owner.pubkey]],
  );
  keyNeverShown(result, key);
});

test("without --reply the message is a root: no e tag", async () => {
  const r = await relay();
  const key = identity();
  const result = await send({ relayUrl: r.url, key });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    r.stats.events[0].tags.filter((t) => t[0] === "e"),
    [],
  );
});

test("the relay refuses the message: exit 3 with the relay's reason", async () => {
  const r = await relay();
  r.hooks.refuseEvents = "restricted: not a member of this channel";
  const key = identity();
  const result = await send({ relayUrl: r.url, key });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /the relay refused the message: restricted: not a member of this channel/);
  assert.equal(result.stdout, "");
  keyNeverShown(result, key);
});

test("a relay that sends its challenge only after the message: logs in, then sends it once more", async () => {
  const r = await relay({ authAfterEvent: true });
  const key = identity();
  const result = await send({ relayUrl: r.url, key });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(r.stats.auths, 1, "it answered the late challenge");
  assert.equal(r.stats.events.length, 1, "the message is stored once");
  assert.match(result.stdout, new RegExp(`^sent ${r.stats.events[0].id}\\n$`));
  keyNeverShown(result, key);
});

test("the relay refuses the login: exit 1, nothing published", async () => {
  const r = await relay();
  r.hooks.refuseAuth = true;
  const key = identity();
  const result = await send({ relayUrl: r.url, key });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the relay refused the login/);
  assert.equal(r.stats.events.length, 0);
});

test("the relay never answers: exit 1 after the time limit", async () => {
  const r = await relay();
  r.hooks.silentEvents = true;
  const key = identity();
  const result = await send({ relayUrl: r.url, key, env: { BUZZ_SEND_TIMEOUT_MS: "800" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no answer from the relay within 800 ms/);
});

test("a relay that asks for no login gets the message without one", async () => {
  const r = await relay({ requireAuth: false });
  const key = identity();
  const result = await send({ relayUrl: r.url, key });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(r.stats.events.length, 1);
  assert.equal(r.stats.auths, 0);
});

test("no relay there: exit 1", async () => {
  const r = await relay();
  const url = r.url;
  r.setRefuse(true);
  const key = identity();
  const result = await send({ relayUrl: url, key, env: { BUZZ_SEND_TIMEOUT_MS: "3000" } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not reach the relay|closed the connection/);
});

test("usage and input errors exit 2 and send nothing", async () => {
  const r = await relay();
  const key = identity();
  const cases = [
    [{ args: [] }, /--channel must be a channel id/],
    [{ args: ["--channel"] }, /--channel needs a value/],
    [{ args: ["--channel", "has spaces"] }, /--channel must be a channel id/],
    [{ args: ["--channel", CHANNEL, "--mention", "abc"] }, /--mention must be 64 hex characters or an npub1 key/],
    [{ args: ["--channel", CHANNEL, "--extra"] }, /usage: send/],
    [{ args: ["--channel", CHANNEL, "--reply", "abc"] }, /--reply must be an event id/],
    [{ args: ["--channel", CHANNEL, "--reply", "A".repeat(64)] }, /--reply must be an event id/],
    [{ args: ["--channel", CHANNEL, "--reply"] }, /--reply needs a value/],
    [{ args: ["--channel", CHANNEL, "--reply", "a".repeat(64), "--reply", "b".repeat(64)] }, /usage: send/],
    [{ input: "  \n" }, /no text on stdin/],
    [{ input: "x".repeat(33 * 1024) }, /longer than 32768 bytes/],
  ];
  for (const [over, want] of cases) {
    const result = await send({ relayUrl: r.url, key, ...over });
    assert.equal(result.status, 2, `${want}: ${result.stderr}`);
    assert.match(result.stderr, want);
    keyNeverShown(result, key);
  }
  assert.equal(r.stats.events.length, 0);
});

test("a failing key command stops the launcher with a fixed message, its output hidden", async () => {
  const r = await relay();
  const key = identity();
  const result = await send({
    relayUrl: r.url,
    key,
    env: { BUZZ_KEY_COMMAND: `printf %s ${key.hex}; echo ${key.hex} >&2; exit 4` },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /BUZZ_KEY_COMMAND failed \(exit 4\)/);
  keyNeverShown(result, key);
  assert.equal(r.stats.events.length, 0);
});

test("an http relay address is turned into ws", async () => {
  const r = await relay();
  const key = identity();
  const result = await send({ relayUrl: r.url.replace(/^ws:/, "http:"), key });
  assert.equal(result.status, 0, result.stderr);
});

// ---------------------------------------------------------------- the owner's attestation (BUZZ_AUTH_TAG)
//
// A relay such as Buzz admits a key that is not a member itself when its
// owner has attested it (NIP-OA), and reads that attestation from the NIP-42
// AUTH event. The send reads BUZZ_AUTH_TAG with the channel's own code, so
// these hold the login itself; auth-tag.test.mjs holds the parse.

/** A tag of the right shape. The fake relay never checks its signature. */
function authTag(owner = identity()) {
  return ["auth", owner.pubkey, "created_at<4294967295", bytesToHex(randomBytes(64))];
}

/** A relay that admits the key only through its owner: a login without exactly one auth tag is refused. */
async function ownerOnlyRelay(options) {
  const r = await relay(options);
  r.hooks.requireAuthTag = true;
  return r;
}

test("BUZZ_AUTH_TAG set: the login carries that one tag, unchanged, and a relay that admits the key only through its owner takes the message", async () => {
  const r = await ownerOnlyRelay();
  const key = identity();
  const tag = authTag();
  const result = await send({ relayUrl: r.url, key, env: { BUZZ_AUTH_TAG: JSON.stringify(tag) } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(r.stats.authTags, [[tag]], "one login, with exactly the one tag");
  assert.equal(r.stats.auths, 1, "the relay accepted it");
  assert.equal(r.stats.events.length, 1);
  assert.match(result.stdout, new RegExp(`^sent ${r.stats.events[0].id}\\n$`));
  keyNeverShown(result, key);
});

test("BUZZ_AUTH_TAG set, and the challenge comes only after the message: the late login carries the tag too", async () => {
  const r = await ownerOnlyRelay({ authAfterEvent: true });
  const key = identity();
  const tag = authTag();
  const result = await send({ relayUrl: r.url, key, env: { BUZZ_AUTH_TAG: JSON.stringify(tag) } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(r.stats.authTags, [[tag]]);
  assert.equal(r.stats.events.length, 1, "the message is stored once");
  keyNeverShown(result, key);
});

test("BUZZ_AUTH_TAG unset, empty or a placeholder: the login is as before, and a relay that admits the key only through its owner refuses it", async () => {
  for (const env of [{}, { BUZZ_AUTH_TAG: "" }, { BUZZ_AUTH_TAG: "${user_config.buzz_auth_tag}" }]) {
    const r = await ownerOnlyRelay();
    const key = identity();
    const result = await send({ relayUrl: r.url, key, env });
    const what = JSON.stringify(env);
    assert.equal(result.status, 1, `${what}: ${result.stderr}`);
    assert.match(result.stderr, /the relay refused the login: restricted: not a relay member/, what);
    assert.deepEqual(r.stats.authTags, [[]], `${what}: the login carries no auth tag`);
    assert.equal(r.stats.events.length, 0, what);
    keyNeverShown(result, key);
  }
});

test("a malformed BUZZ_AUTH_TAG, or one that names the agent itself as owner: exit 2 before connecting, the value never repeated", async () => {
  const r = await relay();
  const key = identity();
  const owner = identity();
  const cases = [
    ["not json", /BUZZ_AUTH_TAG must be the owner's NIP-OA auth tag as JSON/],
    [JSON.stringify(["auth", owner.pubkey]), /BUZZ_AUTH_TAG must be the owner's NIP-OA auth tag as JSON/],
    [JSON.stringify(authTag(owner).slice(0, 3)), /BUZZ_AUTH_TAG must be the owner's NIP-OA auth tag as JSON/],
    [JSON.stringify(authTag(key)), /BUZZ_AUTH_TAG names the agent's own key as its owner/],
  ];
  for (const [value, want] of cases) {
    const result = await send({ relayUrl: r.url, key, env: { BUZZ_AUTH_TAG: value } });
    assert.equal(result.status, 2, `${want}: ${result.stderr}`);
    assert.match(result.stderr, want);
    for (const s of [result.stdout, result.stderr]) assert.ok(!s.includes(value), "the value is never repeated");
    keyNeverShown(result, key);
  }
  assert.equal(r.stats.connections, 0, "it never connected");
  assert.equal(r.stats.events.length, 0);
});
