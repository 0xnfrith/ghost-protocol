// End-to-end tests of the channel against a local fake relay. Each test runs
// the real launcher and channel server as a child process and talks to it
// over MCP stdio, the way Claude Code does.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { message, startFakeRelay } from "./fake-relay.mjs";
import { closeAll, filesUnder, identity, keyAbsent, startChannel, tempDir, waitFor } from "./helpers.mjs";

const OTHER = "22222222-2222-4222-8222-222222222222";
const agent = identity(); // the key the channel runs as
const watch = identity(); // the identity whose mentions are delivered
const sender = identity(); // someone in the channel
const now = () => Math.floor(Date.now() / 1000);

let relay;
const leakTexts = [];
const dirs = [];
before(async () => {
  relay = await startFakeRelay();
});
after(async () => {
  await closeAll();
  await relay.close();
  // No output, log or state file from any test may contain the key.
  for (const dir of dirs) for (const f of filesUnder(dir)) leakTexts.push(f.text);
  assert.ok(leakTexts.length > 0);
  assert.ok(keyAbsent(agent, leakTexts), "the private key leaked into output, a log or the state");
});

// Each test gets its own channel, so no test sees another's messages.
function setup(label) {
  const dir = tempDir(label);
  dirs.push(dir);
  const chan = randomUUID();
  return {
    chan,
    env: {
      BUZZ_CHANNELS: `${chan}, 33333333-3333-4333-8333-333333333333`,
      BUZZ_WATCH_PUBKEY: watch.pubkey,
      BUZZ_STATE_DIR: join(dir, "state"),
      BUZZ_LOG_FILE: join(dir, "channel.log"),
    },
  };
}

async function open(env, relayOverride = relay) {
  const reqsBefore = relayOverride.stats.reqs.length;
  const ch = await startChannel({ relayUrl: relayOverride.url, key: agent, env });
  await waitFor(() => relayOverride.stats.reqs.slice(reqsBefore).some((r) => r.subId.startsWith("buzz-channel-sub-")), {
    what: "the channel to subscribe",
  });
  return ch;
}

async function shut(ch) {
  leakTexts.push(ch.stderr());
  await ch.close();
}

const ids = (received) => received.map((r) => r.meta.event_id);

test("delivers a live mention with its routing attributes, after AUTH", async () => {
  const { env, chan: CHAN } = setup("live");
  const stale = message(sender.secret, { channel: CHAN, mention: watch.pubkey, createdAt: now() - 3600 });
  relay.publish(stale); // older than the first start: never replayed
  const ch = await open(env);
  const e = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "ping one" });
  relay.publish(e);
  await waitFor(() => ch.received.length === 1, { what: "the live mention" });
  const [got] = ch.received;
  assert.equal(got.content, "ping one");
  assert.deepEqual(got.meta, {
    channel_id: CHAN,
    event_id: e.id,
    author: sender.pubkey,
    sent_at: new Date(e.created_at * 1000).toISOString(),
  });
  assert.ok(relay.stats.auths >= 1);
  await shut(ch);
});

test("drops what is not addressed to it, even when the relay sends it", async (t) => {
  const loose = await startFakeRelay({ filterOnRelay: false });
  t.after(() => loose.close());
  const { env, chan: CHAN } = setup("filter");
  const ch = await open(env, loose);
  const tampered = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "original" });
  const drops = [
    message(sender.secret, { channel: OTHER, mention: watch.pubkey }), // channel not allowlisted
    message(sender.secret, { channel: CHAN }), // no mention
    message(watch.secret, { channel: CHAN, mention: watch.pubkey }), // written as the watched identity
    message(agent.secret, { channel: CHAN, mention: watch.pubkey }), // written with the agent's own key
    { ...tampered, content: "changed after signing" }, // bad signature
    { ...message(sender.secret, { channel: CHAN, mention: watch.pubkey }), kind: 1 }, // wrong kind
    message(sender.secret, { channel: CHAN, mention: watch.pubkey, tags: [["h", OTHER]] }), // two channels
    // Poison timestamps: one of these used to crash the server, and the
    // replay after each restart crashed it again.
    message(sender.secret, { channel: CHAN, mention: watch.pubkey, createdAt: 1e20 }),
    message(sender.secret, { channel: CHAN, mention: watch.pubkey, createdAt: 1.5 }),
    message(sender.secret, { channel: CHAN, mention: watch.pubkey, createdAt: now() + 3600 }),
  ];
  for (const d of drops) loose.publish(d);
  // A thread id that is not an event id is left out of the attributes.
  const root = "ab".repeat(32);
  const injected = message(sender.secret, {
    channel: CHAN,
    mention: watch.pubkey,
    content: "injected",
    tags: [["e", 'x" injected="yes', "", "reply"]],
  });
  // A direct reply to the thread root carries only a `reply` marker.
  const threaded = message(sender.secret, {
    channel: CHAN,
    mention: watch.pubkey,
    content: "threaded",
    tags: [["e", root, "", "reply"]],
  });
  const ok = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "the last one" });
  for (const e of [injected, threaded, ok]) loose.publish(e);
  await waitFor(() => ch.received.length >= 3, { what: "the valid mentions" });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(ids(ch.received), [injected.id, threaded.id, ok.id]);
  assert.equal(ch.received[0].meta.thread_id, undefined);
  assert.ok(!JSON.stringify(ch.received[0].meta).includes("injected"));
  assert.equal(ch.received[1].meta.thread_id, root);
  const logText = readFileSync(env.BUZZ_LOG_FILE, "utf8");
  const reasons = ["channel not allowlisted", "no mention", "own message", "bad signature", "kind"];
  for (const reason of [...reasons, "not exactly one channel", "bad timestamp"]) {
    assert.ok(logText.includes(`: ${reason}`), `log names the reason "${reason}"`);
  }
  assert.equal(logText.match(/: bad timestamp/g).length, 3);
  assert.equal(logText.match(/: own message/g).length, 2);
  await shut(ch);
});

test("catches up after a dropped connection, oldest first, with no duplicates", async () => {
  const { env, chan: CHAN } = setup("drop");
  const ch = await open(env);
  const e1 = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "before the drop" });
  relay.publish(e1);
  await waitFor(() => ch.received.length === 1, { what: "the first mention" });

  relay.setRefuse(true);
  const tries = relay.stats.connections;
  relay.dropAll();
  await waitFor(() => relay.stats.connections >= tries + 2, { what: "reconnect attempts while refused" });
  // Sent during the gap, published newest first to check the ordering.
  const t = now();
  const e3 = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "gap two", createdAt: t });
  const e2 = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "gap one", createdAt: t - 1 });
  relay.publish(e3);
  relay.publish(e2);
  relay.setRefuse(false);

  await waitFor(() => ch.received.length === 3, { what: "the catch-up" });
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(ids(ch.received), [e1.id, e2.id, e3.id]);
  assert.equal(ch.received[0].meta.catch_up, undefined);
  assert.equal(ch.received[1].meta.catch_up, "true");
  assert.equal(ch.received[2].meta.catch_up, "true");
  assert.ok(readFileSync(env.BUZZ_LOG_FILE, "utf8").includes(`skipped ${e1.id}: already delivered`));
  await shut(ch);
});

test("replaces a connection that stops answering, and catches up", async () => {
  const { env, chan: CHAN } = setup("silent");
  const ch = await open(env);
  relay.deafenAll();
  const e = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "while silent" });
  relay.publish(e); // the silent connection never sees it
  await waitFor(() => ch.received.length === 1, { what: "delivery after the heartbeat reconnect" });
  assert.equal(ch.received[0].meta.catch_up, "true");
  assert.ok(readFileSync(env.BUZZ_LOG_FILE, "utf8").includes("relay stopped answering"));
  await shut(ch);
});

// The relay restarts: the connection drops, and for a while the relay (or the
// proxy in front of it) answers the WebSocket handshake with a 503. Node's
// WebSocket reports that with an error event only, never a close event.
test("keeps retrying while the relay rejects the handshake, then catches up; the log is in the state folder", async (t) => {
  const restarting = await startFakeRelay();
  t.after(() => restarting.close());
  const { env: withLogFile, chan: CHAN } = setup("handshake");
  const { BUZZ_LOG_FILE: _default, ...env } = withLogFile; // use the default log file
  const ch = await open(env, restarting);
  const e1 = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "before the restart" });
  restarting.publish(e1);
  await waitFor(() => ch.received.length === 1, { what: "the first mention" });

  restarting.setHandshake("reject");
  restarting.dropAll();
  await waitFor(() => restarting.stats.rejected >= 3, { what: "repeated attempts while the handshake fails" });
  const e2 = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "during the restart" });
  restarting.publish(e2);
  restarting.setHandshake("accept");
  await waitFor(() => ch.received.length === 2, { what: "the catch-up after the restart" });
  assert.equal(ch.received[1].meta.event_id, e2.id);
  assert.equal(ch.received[1].meta.catch_up, "true");

  const logFile = join(env.BUZZ_STATE_DIR, "channel.log");
  const logText = readFileSync(logFile, "utf8");
  for (const line of ["connection closed (code", "could not connect to the relay", "reconnecting in", "caught up:"]) {
    assert.ok(logText.includes(line), `the log says "${line}"`);
  }
  assert.equal(statSync(logFile).mode & 0o777, 0o600);
  assert.ok(ch.stderr().includes("could not connect to the relay"), "the log also goes to stderr");
  await shut(ch);
});

test("gives up on a handshake that is never answered, and connects once the relay answers", async (t) => {
  const stalled = await startFakeRelay();
  t.after(() => stalled.close());
  const { env, chan: CHAN } = setup("hang");
  stalled.setHandshake("hang");
  const ch = await startChannel({ relayUrl: stalled.url, key: agent, env: { ...env, BUZZ_CONNECT_TIMEOUT_MS: "300" } });
  await waitFor(() => stalled.stats.hung >= 2, { what: "a second attempt after the connect timeout" });
  stalled.setHandshake("accept");
  await waitFor(() => stalled.stats.reqs.some((r) => r.subId.startsWith("buzz-channel-sub-")), {
    what: "the subscription once the relay answers",
  });
  const e = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "after the stall" });
  stalled.publish(e);
  await waitFor(() => ch.received.length === 1, { what: "the mention" });
  assert.ok(readFileSync(env.BUZZ_LOG_FILE, "utf8").includes("the connection did not open within 300 ms"));
  await shut(ch);
});

test("a restart catches up from the saved cursor and re-delivers nothing", async () => {
  const { env, chan: CHAN } = setup("restart");
  const first = await open(env);
  const e1 = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "one" });
  const e2 = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "two" });
  relay.publish(e1);
  relay.publish(e2);
  await waitFor(() => first.received.length === 2, { what: "two live mentions" });
  await shut(first);

  const e3 = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "while stopped" });
  relay.publish(e3);

  const second = await open(env);
  await waitFor(() => second.received.length === 1, { what: "the missed mention" });
  const e4 = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "after restart" });
  relay.publish(e4);
  await waitFor(() => second.received.length === 2, { what: "the next live mention" });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(ids(second.received), [e3.id, e4.id]);
  assert.equal(second.received[0].meta.catch_up, "true");

  const stateFiles = filesUnder(env.BUZZ_STATE_DIR);
  assert.equal(stateFiles.length, 1);
  for (const f of stateFiles) assert.ok(!f.text.includes("while stopped") && !f.text.includes("one"));
  await shut(second);
});

test("refuses a wildcard mixed with ids, and a missing channel list", async () => {
  const { env, chan: CHAN } = setup("config");
  for (const channels of [`*, ${CHAN}`, ""]) {
    await assert.rejects(
      startChannel({ relayUrl: relay.url, key: agent, env: { ...env, BUZZ_CHANNELS: channels } }),
    );
  }
  assert.ok(!existsSync(env.BUZZ_STATE_DIR));
});

test("a malformed frame from the relay is skipped, and the channel keeps working", async (t) => {
  const broken = await startFakeRelay();
  t.after(() => broken.close());
  // Values whose String() conversion throws, as a hostile relay could send.
  const poison = { toString: 1 };
  broken.hooks.extraBeforeEose = (subId) =>
    subId.startsWith("buzz-channel-sub-")
      ? [
          JSON.stringify(["EVENT", subId, { id: poison, created_at: 1 }]),
          JSON.stringify(["EVENT", subId, { id: poison, created_at: 2 }]),
          JSON.stringify(["EVENT", subId, null]),
        ]
      : [];
  const { env, chan: CHAN } = setup("frames");
  const ch = await open(env, broken);
  broken.inject(JSON.stringify(["NOTICE", poison]));
  broken.inject(JSON.stringify(["CLOSED", "buzz-channel-sub-1", poison]));
  broken.inject("not json at all");
  const e = message(sender.secret, { channel: CHAN, mention: watch.pubkey, content: "still here" });
  broken.publish(e);
  await waitFor(() => ch.received.length === 1, { what: "delivery after the malformed frames" });
  assert.equal(ch.received[0].meta.event_id, e.id);
  const logText = readFileSync(env.BUZZ_LOG_FILE, "utf8");
  assert.ok(logText.includes("skipped a malformed event from the relay"));
  assert.ok(!logText.includes("stopped (pid"), "the channel did not stop");
  await shut(ch);
});
