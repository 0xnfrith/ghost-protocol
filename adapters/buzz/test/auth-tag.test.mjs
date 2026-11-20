// The owner's NIP-OA attestation (BUZZ_AUTH_TAG) on the relay login.
//
// A relay such as Buzz admits a key that is not a member itself when the
// key's owner has attested it, and on a WebSocket login it reads that
// attestation from the NIP-42 AUTH event. These tests hold the channel to:
//   - BUZZ_AUTH_TAG is read the way Block's buzz-mcp reads it: the `auth` tag
//     itself, as one JSON array. A malformed value stops the channel with a
//     fixed message that never repeats the value.
//   - Set, the AUTH event carries that one tag, unchanged. Unset (or a
//     `${...}` placeholder nobody filled in), the AUTH event carries only the
//     relay and challenge tags, exactly as before.
//   - End to end, through the real launcher: a relay that admits the agent
//     only through its owner refuses the login without the tag and accepts
//     it with the tag, and the mention then arrives.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { verifyEvent } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";
import { ConfigError, loadConfig, parseAuthTag } from "../src/config.mjs";
import { RelayListener } from "../src/relay.mjs";
import { message, startFakeRelay } from "./fake-relay.mjs";
import { closeAll, identity, LAUNCH, startChannel, tempDir, waitFor } from "./helpers.mjs";

const CHAN = "11111111-1111-4111-8111-111111111111";
const agent = identity();
const owner = identity();

/** A tag of the right shape. The fake relay never checks the signature. */
function authTag({ from = owner, conditions = "created_at<4294967295" } = {}) {
  return ["auth", from.pubkey, conditions, bytesToHex(randomBytes(64))];
}

// ---------------------------------------------------------------- the setting

test("BUZZ_AUTH_TAG unset, empty or a placeholder: no tag", () => {
  for (const env of [{}, { BUZZ_AUTH_TAG: "" }, { BUZZ_AUTH_TAG: "  " }, { BUZZ_AUTH_TAG: "${user_config.buzz_auth_tag}" }]) {
    assert.equal(parseAuthTag(env, agent.pubkey), undefined, JSON.stringify(env));
  }
});

test("BUZZ_AUTH_TAG is read as the tag's JSON, the way buzz-mcp reads it", () => {
  const tag = authTag();
  assert.deepEqual(parseAuthTag({ BUZZ_AUTH_TAG: JSON.stringify(tag) }, agent.pubkey), tag);
  // Surrounding white space, as a file or an environment line may leave.
  assert.deepEqual(parseAuthTag({ BUZZ_AUTH_TAG: ` ${JSON.stringify(tag)}\n` }, agent.pubkey), tag);
  // Empty conditions are allowed (NIP-OA: no extra constraints).
  const open = authTag({ conditions: "" });
  assert.deepEqual(parseAuthTag({ BUZZ_AUTH_TAG: JSON.stringify(open) }, agent.pubkey), open);
});

test("a malformed BUZZ_AUTH_TAG is refused with a fixed message that never repeats it", () => {
  const good = authTag();
  const bad = [
    "not json",
    JSON.stringify({ auth: good }),
    JSON.stringify(good.slice(0, 3)), // three elements
    JSON.stringify([...good, "extra"]), // five elements
    JSON.stringify(["p", ...good.slice(1)]), // not an auth tag
    JSON.stringify(["auth", good[1].toUpperCase(), good[2], good[3]]), // upper-case owner
    JSON.stringify(["auth", good[1].slice(2), good[2], good[3]]), // short owner
    JSON.stringify(["auth", good[1], good[2], good[3].slice(2)]), // short signature
    JSON.stringify(["auth", good[1], 7, good[3]]), // conditions not a string
  ];
  for (const value of bad) {
    assert.throws(
      () => parseAuthTag({ BUZZ_AUTH_TAG: value }, agent.pubkey),
      (err) => err instanceof ConfigError && err.message.startsWith("BUZZ_AUTH_TAG must be") && !err.message.includes(good[3]),
      value,
    );
  }
});

test("a tag that names the agent itself as its owner is refused", () => {
  const self = authTag({ from: agent });
  assert.throws(
    () => parseAuthTag({ BUZZ_AUTH_TAG: JSON.stringify(self) }, agent.pubkey),
    (err) => err instanceof ConfigError && /own key/.test(err.message),
  );
});

test("loadConfig hands the tag on as authTag", () => {
  const tag = authTag();
  const base = { BUZZ_RELAY_URL: "https://relay.example.com", BUZZ_CHANNELS: CHAN };
  assert.deepEqual(loadConfig({ ...base, BUZZ_AUTH_TAG: JSON.stringify(tag) }, agent.secret).authTag, tag);
  assert.equal(loadConfig(base, agent.secret).authTag, undefined);
});

// ---------------------------------------------------------------- the AUTH event

/** A WebSocket stand-in that opens, sends the challenge and accepts AUTH. */
function scriptedSockets() {
  const sockets = [];
  class Socket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      sockets.push(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.onopen?.();
        this.frame(["AUTH", "the-challenge"]);
      });
    }
    send(data) {
      const msg = JSON.parse(data);
      this.sent.push(msg);
      if (msg[0] === "AUTH") queueMicrotask(() => this.frame(["OK", msg[1].id, true, ""]));
      if (msg[0] === "REQ") queueMicrotask(() => this.frame(["EOSE", msg[1]]));
    }
    close() {
      this.readyState = 2;
    }
    frame(msg) {
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(msg) });
    }
  }
  return { Socket, sockets };
}

async function authEventSent(authTagOption) {
  const { Socket, sockets } = scriptedSockets();
  const now = Math.floor(Date.now() / 1000);
  const listener = new RelayListener({
    relayUrl: "ws://relay.example.com",
    secret: agent.secret,
    channels: [CHAN],
    watchPubkey: agent.pubkey,
    ownPubkey: agent.pubkey,
    ...(authTagOption ? { authTag: authTagOption } : {}),
    state: { since: () => now, has: () => false, record() {}, hasRefused: () => false, refuse() {} },
    format: () => ({}),
    deliver: async () => {},
    onDeliveryError: () => {},
    log: () => {},
    catchupMaxAge: 3600,
    backoffMs: 10,
    backoffMaxMs: 40,
    heartbeatMs: 1000,
    fetchImpl: async () => ({ json: async () => ({}) }),
    WebSocketImpl: Socket,
  });
  listener.start();
  try {
    const auth = await waitFor(() => sockets[0]?.sent.find((m) => m[0] === "AUTH"), { what: "the AUTH answer" });
    return auth[1];
  } finally {
    listener.stop();
  }
}

test("with the tag set, the AUTH event carries exactly that one auth tag, and is validly signed", async () => {
  const tag = authTag();
  const event = await authEventSent(tag);
  assert.equal(event.kind, 22242);
  assert.equal(event.pubkey, agent.pubkey);
  assert.ok(verifyEvent(event));
  assert.deepEqual(event.tags, [["relay", "ws://relay.example.com"], ["challenge", "the-challenge"], tag]);
});

test("without the tag, the AUTH event is exactly the relay and challenge tags, as before", async () => {
  const event = await authEventSent(undefined);
  assert.ok(verifyEvent(event));
  assert.deepEqual(event.tags, [["relay", "ws://relay.example.com"], ["challenge", "the-challenge"]]);
});

// ---------------------------------------------------------------- end to end

let relay;
before(async () => {
  relay = await startFakeRelay();
  relay.hooks.requireAuthTag = true; // the agent is on this relay only through its owner
});
after(async () => {
  await closeAll();
  await relay.close();
});

function setup(label) {
  const dir = tempDir(label);
  const chan = randomUUID();
  const logFile = join(dir, "channel.log");
  return {
    chan,
    logFile,
    env: { BUZZ_CHANNELS: chan, BUZZ_STATE_DIR: join(dir, "state"), BUZZ_LOG_FILE: logFile },
  };
}
const logText = (file) => (existsSync(file) ? readFileSync(file, "utf8") : "");

test("end to end: without the tag the relay refuses the login, and nothing subscribes", async () => {
  const { env, logFile } = setup("no-tag");
  const reqsBefore = relay.stats.reqs.length;
  const ch = await startChannel({ relayUrl: relay.url, key: agent, env });
  await waitFor(() => logText(logFile).includes("relay refused AUTH: restricted: not a relay member"), {
    what: "the refused login in the log",
  });
  assert.ok(!logText(logFile).includes("owner attestation"), "the start line says no attestation is used");
  assert.ok(!relay.stats.reqs.slice(reqsBefore).some((r) => r.subId.startsWith("buzz-channel-sub-")));
  await ch.close();
});

test("end to end: with the tag the relay accepts the login, and a mention arrives", async () => {
  const { env, chan, logFile } = setup("tag");
  const tag = authTag();
  const tagsBefore = relay.stats.authTags.length;
  const reqsBefore = relay.stats.reqs.length;
  const ch = await startChannel({ relayUrl: relay.url, key: agent, env: { ...env, BUZZ_AUTH_TAG: JSON.stringify(tag) } });
  await waitFor(() => relay.stats.reqs.slice(reqsBefore).some((r) => r.subId.startsWith("buzz-channel-sub-")), {
    what: "the channel to subscribe after its login",
  });
  // Every AUTH this channel sent carried the one tag, unchanged.
  const sent = relay.stats.authTags.slice(tagsBefore);
  assert.ok(sent.length >= 1);
  for (const tags of sent) assert.deepEqual(tags, [tag]);
  assert.match(logText(logFile), new RegExp(`owner attestation \\(NIP-OA\\) of ${owner.pubkey.slice(0, 12)}`));
  const sender = identity();
  const e = message(sender.secret, { channel: chan, mention: agent.pubkey, content: "through the owner" });
  relay.publish(e);
  await waitFor(() => ch.received.length === 1, { what: "the mention" });
  assert.equal(ch.received[0].meta.event_id, e.id);
  await ch.close();
});

test("end to end: a malformed tag stops the channel at start, with the fixed message", () => {
  const { env } = setup("bad-tag");
  const value = `["auth","${bytesToHex(randomBytes(64))}"]`;
  const result = spawnSync(process.execPath, [LAUNCH, "channel"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      BUZZ_RELAY_URL: relay.url,
      BUZZ_KEY_COMMAND: `printf %s ${agent.hex}`,
      BUZZ_AUTH_TAG: value,
      ...env,
    },
    encoding: "utf8",
    input: "",
    timeout: 30_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /BUZZ_AUTH_TAG must be the owner's NIP-OA auth tag as JSON/);
  assert.ok(!result.stderr.includes(value) && !result.stdout.includes(value), "the value is never repeated");
});
