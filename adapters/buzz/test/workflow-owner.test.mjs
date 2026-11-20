// End-to-end tests of the workflow rule: the real launcher and channel against
// the fake relay, which signs a workflow's message with its own key, as Buzz's
// relay does. A workflow message that names the agent is judged by its owner;
// anything else is judged by its author. These import nothing from the
// channel's modules, so each one shows what the channel itself does.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { message, startFakeRelay } from "./fake-relay.mjs";
import { closeAll, filesUnder, identity, keyAbsent, startChannel, tempDir, waitFor } from "./helpers.mjs";

const agent = identity(); // the key the channel runs as
const watch = identity(); // the identity whose mentions are delivered
const owner = identity(); // owns workflows, and is on the sender allowlist
const stranger = identity(); // owns workflows, and is on no list
const second = identity(); // another owner on no list
const forger = identity(); // writes the stamps itself, from its own key
const otherAgent = identity(); // another agent in the room
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

let relay;
const relays = [];
const dirs = [];
const leakTexts = [];
async function relayWith(options) {
  const r = await startFakeRelay(options);
  relays.push(r);
  return r;
}
before(async () => {
  relay = await relayWith();
});
after(async () => {
  await closeAll();
  for (const r of relays) await r.close();
  for (const dir of dirs) for (const f of filesUnder(dir)) leakTexts.push(f.text);
  assert.ok(keyAbsent(agent, leakTexts), "the private key leaked into output, a log or the state");
});

function setup(label, extra = {}, channels) {
  const dir = tempDir(label);
  dirs.push(dir);
  const chan = randomUUID();
  const env = {
    BUZZ_CHANNELS: channels ?? chan,
    BUZZ_WATCH_PUBKEY: watch.pubkey,
    BUZZ_STATE_DIR: join(dir, "state"),
    BUZZ_LOG_FILE: join(dir, "channel.log"),
    BUZZ_ALLOWED_PUBKEYS: owner.pubkey,
    ...extra,
  };
  const state = () => {
    const f = readdirSync(env.BUZZ_STATE_DIR).find((n) => /^cursor-.*\.json$/.test(n));
    return JSON.parse(readFileSync(join(env.BUZZ_STATE_DIR, f), "utf8"));
  };
  return { dir, chan, env, state, logText: () => readFileSync(env.BUZZ_LOG_FILE, "utf8") };
}

/** How many times the channel's log says it read the relay's key (the log is kept across restarts). */
function keyReads(env) {
  try {
    return (readFileSync(env.BUZZ_LOG_FILE, "utf8").match(/the relay's key is known \(NIP-11 self\)/g) ?? []).length;
  } catch {
    return 0;
  }
}

/**
 * Starts the channel and waits until it has subscribed and, unless `key` is
 * false (a test that holds the key back), read the relay's key. With a list of
 * channels the key is read in the background, so without that wait a test that
 * publishes at once could see its message judged before the key is known, and
 * delivered by the catch-up that follows instead of live.
 */
async function open(env, on = relay, { key = true } = {}) {
  const reqsBefore = on.stats.reqs.length;
  const readsBefore = keyReads(env);
  const ch = await startChannel({ relayUrl: on.url, key: agent, env });
  await waitFor(() => on.stats.reqs.slice(reqsBefore).some((r) => r.subId.startsWith("buzz-channel-sub-")), {
    what: "the channel to subscribe",
  });
  if (key) await waitFor(() => keyReads(env) > readsBefore, { what: "the relay's key to be read" });
  return ch;
}

async function shut(ch) {
  leakTexts.push(ch.stderr());
  await ch.close();
}

/** Replaces the file in one step, so the channel never reads half of it. */
function writeAtomically(path, text) {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
}

const ids = (received) => received.map((r) => r.meta.event_id);
const flow = (chan, o = {}, on = relay) => on.workflowMessage({ channel: chan, owner: owner.pubkey, mentions: [watch.pubkey], ...o });
const dropLine = (event, who, on = relay) =>
  `skipped ${event.id}: not on the sender allowlist (author ${on.relayPubkey}, workflow owner ${who.pubkey})`;
const stamps = (event) => event.tags.filter((t) => t[0].startsWith("buzz:"));
const fileOf = (...pubkeys) => JSON.stringify({ entries: pubkeys.map((pubkey) => ({ pubkey })) });

test("a workflow owned by an allowlisted key that names the agent is delivered, as the relay's message", async () => {
  const { chan, env, logText } = setup("wf-delivered");
  const reqsBefore = relay.stats.reqs.length;
  const ch = await open(env);
  const e = flow(chan, { content: "a message from a workflow" });
  relay.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the workflow's message" });
  // Live, and on the one subscription: nothing was held back, so nothing is asked for again.
  const subscriptions = relay.stats.reqs.slice(reqsBefore).filter((r) => r.subId.startsWith("buzz-channel-sub-"));
  assert.equal(subscriptions.length, 1);
  const [got] = ch.received;
  assert.equal(got.content, "a message from a workflow");
  assert.deepEqual(got.meta, {
    channel_id: chan,
    event_id: e.id,
    author: relay.relayPubkey, // the real signer, not the owner
    workflow_owner: owner.pubkey, // whom the allowlist judged
    sent_at: new Date(e.created_at * 1000).toISOString(),
  });
  assert.ok(logText().includes(`delivered ${e.id}`));
  await shut(ch);
});

test("a workflow owned by a key that is not on the allowlist is dropped, and the log names the owner", async () => {
  const { chan, env, logText } = setup("wf-owner-refused");
  const ch = await open(env);
  const refused = flow(chan, { owner: stranger.pubkey, content: "words from a stranger's workflow" });
  const ok = flow(chan, { content: "words from an allowed owner's workflow" });
  for (const e of [refused, ok]) relay.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the allowed owner's workflow" });
  await pause(150);
  assert.deepEqual(ids(ch.received), [ok.id]);
  assert.ok(logText().includes(dropLine(refused, stranger)));
  assert.ok(!logText().includes("words from a stranger"), "the log never holds message text");
  await shut(ch);
});

test("without a stamp for this agent, a workflow's message is judged by the relay and dropped", async () => {
  const { chan, env, logText } = setup("wf-no-stamp");
  const ch = await open(env);
  // Names this agent in its text (a plain `p` tag), but not in the owner's own step text: no stamp.
  const unstamped = flow(chan, { stamped: [] });
  // Stamped for another agent; this one is named only through the text.
  const another = flow(chan, { mentions: [watch.pubkey, otherAgent.pubkey], stamped: [otherAgent.pubkey] });
  // Names another agent alone: not this one at all.
  const elsewhere = flow(chan, { mentions: [otherAgent.pubkey] });
  const ok = flow(chan, { content: "the control" });
  for (const e of [unstamped, another, elsewhere, ok]) relay.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the control" });
  await pause(150);
  assert.deepEqual(ids(ch.received), [ok.id]);
  const log = logText();
  for (const e of [unstamped, another]) {
    assert.ok(log.includes(`skipped ${e.id}: not on the sender allowlist (author ${relay.relayPubkey})`), "judged by the relay");
  }
  await shut(ch);
});

test("stamps on a message the relay did not sign are judged by its author", async () => {
  const { chan, env, logText } = setup("wf-forged");
  const ch = await open(env);
  // A room member copies the stamps of a workflow owned by an allowlisted key.
  const forged = message(forger.secret, { channel: chan, mention: watch.pubkey, content: "forged stamps", tags: stamps(flow(chan)) });
  // The same, signed by an allowed key that names another owner: judged as itself.
  const byOwner = message(owner.secret, {
    channel: chan,
    mention: watch.pubkey,
    content: "by the owner",
    tags: stamps(flow(chan, { owner: stranger.pubkey })),
  });
  for (const e of [forged, byOwner]) relay.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the owner's own message" });
  await pause(150);
  assert.deepEqual(ids(ch.received), [byOwner.id]);
  assert.equal(ch.received[0].meta.author, owner.pubkey);
  assert.equal(ch.received[0].meta.workflow_owner, undefined, "no owner attribute without the relay's signature");
  assert.ok(logText().includes(`skipped ${forged.id}: not on the sender allowlist (author ${forger.pubkey})`));
  await shut(ch);
});

test("a missing or malformed stamp drops the message", async () => {
  const { chan, env, logText } = setup("wf-malformed");
  const ch = await open(env);
  const base = flow(chan);
  // Each is the control's tag list with one change, signed by the relay.
  const changed = (content, edit) => relay.sign({ kind: 9, created_at: base.created_at, content, tags: edit(base.tags) });
  const without = (name) => (tags) => tags.filter((t) => t[0] !== name);
  const bad = [
    changed("no owner tag", without("buzz:workflow-owner")),
    changed("no marker", without("buzz:workflow")),
    changed("owner is not a key", (tags) => [...without("buzz:workflow-owner")(tags), ["buzz:workflow-owner", "not-a-key"]]),
    changed("two owners", (tags) => [...tags, ["buzz:workflow-owner", stranger.pubkey]]),
    changed("a bad mention next to a good one", (tags) => [...tags, ["buzz:workflow-mention", "nope"]]),
  ];
  const ok = flow(chan, { content: "the control" });
  for (const e of [...bad, ok]) relay.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the control" });
  await pause(200);
  assert.deepEqual(ids(ch.received), [ok.id]);
  for (const e of bad) assert.ok(logText().includes(`skipped ${e.id}: not on the sender allowlist (author ${relay.relayPubkey})`));
  await shut(ch);
});

test("a relay that publishes no key gets no special treatment, and says so", async () => {
  const keyless = await relayWith({ publishKey: false });
  const { chan, env, logText } = setup("wf-no-key");
  const ch = await open(env, keyless, { key: false });
  const e = flow(chan, {}, keyless);
  const control = message(owner.secret, { channel: chan, mention: watch.pubkey, content: "the control" });
  for (const x of [e, control]) keyless.publish(x);
  await waitFor(() => ch.received.length >= 1, { what: "the control" });
  await pause(200);
  assert.deepEqual(ids(ch.received), [control.id]);
  assert.ok(logText().includes(`skipped ${e.id}: not on the sender allowlist (author ${keyless.relayPubkey})`));
  assert.ok(logText().includes("does not publish its key"));
  await shut(ch);
});

test("with *, the relay's key is read as well, and the same rule holds", async () => {
  const all = await relayWith();
  const room = randomUUID();
  all.metadata(room);
  all.roster(room, [agent.pubkey, owner.pubkey]);
  const { env } = setup("wf-all", { BUZZ_ROOMS_REFRESH_MS: "300" }, "*");
  const ch = await startChannel({ relayUrl: all.url, key: agent, env });
  await waitFor(() => all.latestSubscription()?.mentions.includes(room), { what: "a subscription to the room" });
  const refused = flow(room, { owner: stranger.pubkey }, all);
  const ok = flow(room, { content: "in all rooms" }, all);
  for (const e of [refused, ok]) all.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the allowed owner's workflow" });
  await pause(150);
  assert.deepEqual(ids(ch.received), [ok.id]);
  assert.equal(ch.received[0].meta.workflow_owner, owner.pubkey);
  await shut(ch);
});

test("a thread marks each workflow message by its own sender, and the owner is shown", async () => {
  const { chan, env } = setup("wf-thread");
  const t = Math.floor(Date.now() / 1000) - 60;
  const root = message(owner.secret, { channel: chan, content: "the question", createdAt: t });
  const inThread = [["e", root.id, "", "reply"]];
  const entries = [
    flow(chan, { owner: stranger.pubkey, content: "stranger's workflow", createdAt: t + 1, tags: inThread }),
    flow(chan, { content: "allowed owner's workflow", createdAt: t + 2, tags: inThread }),
    flow(chan, { mentions: [otherAgent.pubkey], content: "workflow for another agent", createdAt: t + 3, tags: inThread }),
    message(forger.secret, { channel: chan, content: "copied stamps", createdAt: t + 4, tags: [...stamps(flow(chan)), ...inThread] }),
  ];
  for (const e of [root, ...entries]) relay.publish(e);
  const ch = await open(env);
  const mention = flow(chan, { content: "please look", tags: inThread });
  relay.publish(mention);
  await waitFor(() => ch.received.length >= 1, { what: "the workflow's mention in the thread" });
  const [got] = ch.received;
  assert.equal(got.meta.thread_id, root.id);
  assert.equal(got.meta.workflow_owner, owner.pubkey);
  const block = got.content.match(/<thread_context [^>]*>([\s\S]*)<\/thread_context>$/);
  const rows = [...block[1].matchAll(/<thread_message ([^>]*)>\n([\s\S]*?)\n<\/thread_message>/g)].map((m) => ({
    ...Object.fromEntries([...m[1].matchAll(/(\w+)="([^"]*)"/g)].map((a) => [a[1], a[2]])),
    text: m[2],
  }));
  const row = (text) => rows.find((r) => r.text === text);
  assert.equal(row("the question").allowlisted, undefined);
  assert.equal(row("stranger's workflow").allowlisted, "false");
  assert.equal(row("stranger's workflow").workflow_owner, stranger.pubkey);
  assert.equal(row("stranger's workflow").author, relay.relayPubkey);
  assert.equal(row("allowed owner's workflow").allowlisted, undefined);
  assert.equal(row("allowed owner's workflow").workflow_owner, owner.pubkey);
  assert.equal(row("workflow for another agent").allowlisted, "false");
  assert.equal(row("workflow for another agent").workflow_owner, undefined);
  assert.equal(row("copied stamps").allowlisted, "false");
  assert.equal(row("copied stamps").workflow_owner, undefined);
  await shut(ch);
});

test("a refusal on the stamp path is recorded under the owner, and the message never comes back once its owner is allowed", async () => {
  const { dir, chan, env, state, logText } = setup("wf-refused-kept");
  const file = join(dir, "allowed.json");
  writeAtomically(file, fileOf(owner.pubkey));
  const { BUZZ_ALLOWED_PUBKEYS: _, ...withFile } = env;
  let ch = await open({ ...withFile, BUZZ_ALLOWLIST_FILE: file });
  const refused = flow(chan, { owner: stranger.pubkey, content: "stranger's workflow, refused" });
  const ok = flow(chan, { content: "allowed owner's workflow" });
  for (const e of [refused, ok]) relay.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the allowed owner's workflow" });
  await waitFor(() => logText().includes(dropLine(refused, stranger)), { what: "the refusal" });
  assert.deepEqual(ids(ch.received), [ok.id]);
  await shut(ch); // writes the refused ids
  await waitFor(() => state().refused.some(([id]) => id === refused.id), { what: "the refused id on disk" });
  assert.deepEqual(
    state().refused.find(([id]) => id === refused.id).slice(2),
    [stranger.pubkey],
    "kept under the key the allowlist refused: the owner, not the relay",
  );

  // The stranger is allowed now, and the channel starts again on the same cursor: its catch-up reads the workflow's
  // message again, and skips it. A new one from the stranger is delivered.
  writeAtomically(file, fileOf(owner.pubkey, stranger.pubkey));
  ch = await open({ ...withFile, BUZZ_ALLOWLIST_FILE: file });
  const later = flow(chan, { owner: stranger.pubkey, content: "stranger's workflow, now allowed" });
  relay.publish(later);
  await waitFor(() => ch.received.length >= 1, { what: "the newly allowed owner's new workflow" });
  await pause(300);
  assert.deepEqual(ids(ch.received), [later.id], "the refused message came back on the catch-up");
  assert.ok(logText().includes(`skipped ${refused.id}: refused before by the sender allowlist`));
  await shut(ch);
});

test("a refusal while the allowlist file cannot be read is not kept, as for an author", async () => {
  const { dir, chan, env, logText } = setup("wf-refused-unsettled");
  const file = join(dir, "allowed.json");
  const { BUZZ_ALLOWED_PUBKEYS: _, ...withFile } = env;
  writeAtomically(file, `{"entries": [{"pubkey": "${owner.pubkey}"`); // cut off
  let ch = await open({ ...withFile, BUZZ_ALLOWLIST_FILE: file });
  const e = flow(chan, { content: "waiting for a readable file" });
  relay.publish(e);
  await waitFor(() => logText().includes(`not keeping ${e.id} as refused`), { what: "the refusal that is not kept" });
  assert.deepEqual(ids(ch.received), []);
  await shut(ch);
  // With the file fixed, the catch-up asks again, and delivers it.
  writeAtomically(file, fileOf(owner.pubkey));
  ch = await open({ ...withFile, BUZZ_ALLOWLIST_FILE: file });
  await waitFor(() => ch.received.length >= 1, { what: "the catch-up of the message sent while the file was broken" });
  assert.deepEqual(ids(ch.received), [e.id]);
  await shut(ch);
});

test("a flood of workflows from one refused owner pushes out no other owner's refusal", async () => {
  const { chan, env, state } = setup("wf-flood");
  const ch = await open(env);
  const first = flow(chan, { owner: second.pubkey, content: "another owner's, refused first" });
  relay.publish(first);
  await waitFor(() => state().refused?.some(([id]) => id === first.id), { what: "the first refusal" });
  const flood = Array.from({ length: 30 }, (_, i) => flow(chan, { owner: stranger.pubkey, content: `flood ${i}` }));
  for (const e of flood) relay.publish(e);
  await waitFor(() => state().refused.filter(([, , who]) => who === stranger.pubkey).length >= 20, { what: "the flood to be refused" });
  await pause(300);
  const refused = state().refused;
  assert.equal(refused.filter(([, , who]) => who === stranger.pubkey).length, 20, "one owner keeps at most 20 refused ids");
  assert.ok(refused.some(([id]) => id === first.id), "the other owner's refusal was pushed out");
  const ok = flow(chan, { content: "an allowed owner, after the flood" });
  relay.publish(ok);
  await waitFor(() => ch.received.length >= 1, { what: "the allowed owner's workflow after the flood" });
  assert.deepEqual(ids(ch.received), [ok.id]);
  await shut(ch);
});

test("a NIP-11 document that does not answer holds up no login, and the key is used when it comes", async () => {
  const slow = await relayWith();
  slow.hooks.holdNip11 = true; // the relay's key cannot be read until it is released
  const { chan, env, logText } = setup("wf-key-late");
  const started = Date.now();
  const ch = await open(env, slow, { key: false }); // an explicit list of channels
  assert.ok(Date.now() - started < 3000, "the login waited for the relay's key");
  // Everything else goes on: a message by an allowed person is delivered at once.
  const control = message(owner.secret, { channel: chan, mention: watch.pubkey, content: "the control" });
  slow.publish(control);
  await waitFor(() => ch.received.length >= 1, { what: "the control, while the key is unknown" });
  // A workflow's message cannot be judged by its owner yet: it is not delivered, and the refusal is not kept.
  const wf = flow(chan, { content: "a workflow, before the key" }, slow);
  slow.publish(wf);
  await waitFor(() => logText().includes(`not keeping ${wf.id} as refused: the relay's key is not known yet`), {
    what: "the message that waits for the key",
  });
  assert.deepEqual(ids(ch.received), [control.id]);
  // The key arrives: the channel asks for the messages since its cursor again, and the workflow's message comes.
  slow.releaseNip11();
  await waitFor(() => ch.received.length >= 2, { what: "the workflow's message, once the key is known" });
  assert.deepEqual(ids(ch.received), [control.id, wf.id]);
  assert.equal(ch.received[1].meta.workflow_owner, owner.pubkey);
  assert.ok(logText().includes("the relay's key is known now"));
  await shut(ch);
});

test("a key that arrives after a reconnect starts the live connection's catch-up over", async () => {
  const slow = await relayWith();
  slow.hooks.holdNip11 = true;
  const { chan, env, logText } = setup("wf-key-reconnect");
  const ch = await open(env, slow, { key: false });
  const wf = flow(chan, { content: "a workflow, held back across a reconnect" }, slow);
  slow.publish(wf);
  const heldLine = `not keeping ${wf.id} as refused: the relay's key is not known yet`;
  await waitFor(() => logText().includes(heldLine), { what: "the message that waits for the key" });
  // The connection drops while the read is still held. The new one does not start a read of its own, and its
  // catch-up cannot judge the message by its owner either.
  const subscriptions = () => slow.stats.reqs.filter((r) => r.subId.startsWith("buzz-channel-sub-")).length;
  const before = subscriptions();
  slow.dropAll();
  await waitFor(() => subscriptions() > before, { what: "the channel to subscribe again" });
  await waitFor(() => logText().split(heldLine).length - 1 >= 2, { what: "the new connection's catch-up to see the message" });
  assert.deepEqual(ids(ch.received), []);
  slow.releaseNip11();
  await waitFor(() => ch.received.length >= 1, { what: "the message, once the key arrives on the new connection" });
  assert.deepEqual(ids(ch.received), [wf.id]);
  assert.equal(ch.received[0].meta.workflow_owner, owner.pubkey);
  await shut(ch);
});

test("a workflow message already on the relay when the agent connects is held back by the catch-up, and delivered once the key arrives", async () => {
  const slow = await relayWith();
  const { chan, env, logText } = setup("wf-key-catchup");
  // A first run leaves a cursor, then the agent is away while a workflow posts.
  await shut(await open(env, slow));
  slow.hooks.holdNip11 = true;
  const wf = flow(chan, { content: "a workflow, posted while the agent was away" }, slow);
  slow.publish(wf);
  const ch = await open(env, slow, { key: false });
  // Its catch-up reads the message and cannot judge it by its owner yet: not delivered, not kept as refused.
  await waitFor(() => logText().includes(`not keeping ${wf.id} as refused: the relay's key is not known yet`), {
    what: "the catch-up to hold the message back",
  });
  assert.deepEqual(ids(ch.received), []);
  slow.releaseNip11();
  await waitFor(() => ch.received.length >= 1, { what: "the message, once the key arrives" });
  assert.deepEqual(ids(ch.received), [wf.id]);
  assert.equal(ch.received[0].meta.catch_up, "true");
  assert.equal(ch.received[0].meta.workflow_owner, owner.pubkey);
  await shut(ch);
});

test("a read of the relay's key that fails is tried again at the heartbeat, without logging each time", async () => {
  const broken = await relayWith();
  broken.hooks.nip11 = "fail"; // an HTTP 500
  const { chan, env, logText } = setup("wf-key-retry");
  const ch = await open(env, broken, { key: false });
  const wf = flow(chan, { content: "a workflow, while the key cannot be read" }, broken);
  broken.publish(wf);
  await waitFor(() => logText().includes(`not keeping ${wf.id} as refused`), { what: "the message that waits for the key" });
  await pause(700); // several heartbeats (200 ms), all failing quietly
  assert.deepEqual(ids(ch.received), []);
  assert.equal(logText().match(/does not publish its key/g)?.length, 1, "one line, not one per try");
  broken.hooks.nip11 = "ok";
  await waitFor(() => ch.received.length >= 1, { what: "the workflow's message, once the key can be read" });
  assert.deepEqual(ids(ch.received), [wf.id]);
  await shut(ch);
});

test("a message whose stamp is its only mention is delivered", async () => {
  // A relay that sends the channel every message, whatever its filter, as the channel checks them all again.
  const everything = await relayWith({ filterOnRelay: false });
  const { chan, env } = setup("wf-stamp-only");
  const ch = await open(env, everything);
  const stampOnly = flow(chan, { mentions: [], stamped: [watch.pubkey], content: "named by its stamp alone" }, everything);
  const unnamed = flow(chan, { mentions: [], stamped: [otherAgent.pubkey], content: "named another agent" }, everything);
  for (const e of [unnamed, stampOnly]) everything.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the message named by its stamp" });
  await pause(150);
  assert.deepEqual(ids(ch.received), [stampOnly.id]);
  await shut(ch);
});

test("a workflow the agent itself owns does not wake it, allowlisted or not", async () => {
  // Both of the agent's keys are on the allowlist, so only the rule against its own messages can stop them.
  const { chan, env, logText } = setup("wf-own", { BUZZ_ALLOWED_PUBKEYS: [owner.pubkey, watch.pubkey, agent.pubkey].join(",") });
  const ch = await open(env);
  const byWatched = flow(chan, { owner: watch.pubkey, content: "owned by the watched identity" });
  const byLogin = flow(chan, { owner: agent.pubkey, content: "owned by the key it logs in with" });
  const ok = flow(chan, { content: "the control" });
  for (const e of [byWatched, byLogin, ok]) relay.publish(e);
  await waitFor(() => ch.received.length >= 1, { what: "the control" });
  await pause(150);
  assert.deepEqual(ids(ch.received), [ok.id]);
  for (const e of [byWatched, byLogin]) assert.ok(logText().includes(`skipped ${e.id}: own message`));
  await shut(ch);
});

