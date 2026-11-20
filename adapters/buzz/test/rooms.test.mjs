// "All my rooms" mode, direct messages, and a subscription the relay drops,
// against the fake relay. Each test runs the real launcher and channel.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { message, startFakeRelay } from "./fake-relay.mjs";
import { closeAll, identity, startChannel, tempDir, waitFor } from "./helpers.mjs";

const agent = identity(); // runs the channel; watches its own key (the default)
const partner = identity(); // a person in the agent's rooms and its DM partner
const third = identity(); // someone else
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const relays = [];

after(async () => {
  await closeAll();
  for (const r of relays) await r.close();
});

async function relayWith(options) {
  const relay = await startFakeRelay(options);
  relays.push(relay);
  return relay;
}

function envFor(label, channels, extra = {}) {
  const dir = tempDir(label);
  return {
    BUZZ_CHANNELS: channels,
    BUZZ_STATE_DIR: join(dir, "state"),
    BUZZ_LOG_FILE: join(dir, "channel.log"),
    BUZZ_ROOMS_REFRESH_MS: "300",
    ...extra,
  };
}

const logOf = (env) => readFileSync(env.BUZZ_LOG_FILE, "utf8");
const mention = (from, channel, content = "hi") => message(from.secret, { channel, mention: agent.pubkey, content });
const plain = (from, channel, content = "hello") => message(from.secret, { channel, content });

async function subscribedTo(relay, rooms, what) {
  const want = [...rooms].sort();
  return waitFor(
    () => {
      const sub = relay.latestSubscription();
      return sub && sub.mentions.length === want.length && sub.mentions.every((id, i) => id === want[i]) && sub;
    },
    { what },
  );
}

test("with *, it listens in every room the agent is in, and a join arrives live", async () => {
  const relay = await relayWith();
  const [A, B, Z] = [randomUUID(), randomUUID(), randomUUID()];
  relay.metadata(A);
  relay.roster(A, [agent.pubkey, partner.pubkey]);
  relay.metadata(Z);
  relay.roster(Z, [partner.pubkey]); // the agent is not in Z
  // A long timer: only the relay's live notice can make the join show up in time.
  const env = envFor("all", "*", { BUZZ_ROOMS_REFRESH_MS: "60000" });
  const ch = await startChannel({ relayUrl: relay.url, key: agent, env });
  await subscribedTo(relay, [A], "a subscription to A only");

  const inA = mention(partner, A, "in A");
  relay.publish(mention(partner, Z, "in Z"));
  relay.publish(inA);
  await waitFor(() => ch.received.length === 1, { what: "the mention in A" });
  assert.equal(ch.received[0].meta.event_id, inA.id);
  assert.equal(ch.received[0].meta.channel_id, A);
  await pause(1000); // let any start-up re-read finish, so only the notice can explain the join

  // Someone adds the agent to B: the roster changes, and the relay notifies the agent.
  relay.metadata(B);
  relay.roster(B, [agent.pubkey, partner.pubkey]);
  relay.notify(44100, B, agent.pubkey);
  await subscribedTo(relay, [A, B], "a subscription to A and B");
  const inB = mention(partner, B, "in B");
  relay.publish(inB);
  await waitFor(() => ch.received.some((r) => r.meta.event_id === inB.id), { what: "the mention in B" });
  assert.equal(ch.received.find((r) => r.meta.event_id === inB.id).meta.channel_id, B);
  assert.ok(logOf(env).includes(`joined ${B}`));
});

test("with *, removals and archives are picked up without a restart", async () => {
  const relay = await relayWith();
  const [A, B] = [randomUUID(), randomUUID()];
  for (const id of [A, B]) {
    relay.metadata(id);
    relay.roster(id, [agent.pubkey, partner.pubkey]);
  }
  const env = envFor("leave", "*");
  await startChannel({ relayUrl: relay.url, key: agent, env });
  await subscribedTo(relay, [A, B], "a subscription to A and B");
  relay.roster(A, [partner.pubkey]);
  relay.notify(44101, A, agent.pubkey);
  await subscribedTo(relay, [B], "a subscription to B only");
  relay.metadata(B, { archived: true }); // no notice: the periodic re-read finds it
  await waitFor(() => logOf(env).includes("not in any channel yet"), { what: "no rooms left" });
  assert.ok(logOf(env).includes(`left ${A}`));
  assert.ok(logOf(env).includes(`left ${B}`));
});

test("rosters not signed by the relay are ignored", async () => {
  const relay = await relayWith();
  const [A, F] = [randomUUID(), randomUUID()];
  relay.metadata(A);
  relay.roster(A, [agent.pubkey]);
  // A member forges a roster that puts the agent in F.
  relay.metadata(F, { signer: partner.secret });
  relay.roster(F, [agent.pubkey], { signer: partner.secret });
  const env = envFor("forged", "*");
  const ch = await startChannel({ relayUrl: relay.url, key: agent, env });
  await subscribedTo(relay, [A], "a subscription to A only");
  relay.publish(mention(partner, F, "in F"));
  await pause(800); // two refresh periods
  assert.deepEqual(relay.latestSubscription().mentions, [A]);
  assert.equal(ch.received.length, 0);
});

test("when the room list cannot be read, the last known rooms are kept", async () => {
  const relay = await relayWith();
  const A = randomUUID();
  relay.metadata(A);
  relay.roster(A, [agent.pubkey]);
  const env = envFor("keep", "*");
  const ch = await startChannel({ relayUrl: relay.url, key: agent, env });
  const first = await subscribedTo(relay, [A], "a subscription to A");
  relay.hooks.failRoomQueries = true;
  await waitFor(() => logOf(env).includes("keeping the current rooms"), { what: "a failed refresh" });
  assert.equal(relay.latestSubscription().subId, first.subId, "the subscription was not renewed or emptied");
  const inA = mention(partner, A);
  relay.publish(inA);
  await waitFor(() => ch.received.length === 1, { what: "delivery in the kept room" });
});

test("a relay without a published key gets no room list, and nothing breaks", async () => {
  const relay = await relayWith({ publishKey: false });
  const A = randomUUID();
  relay.metadata(A);
  relay.roster(A, [agent.pubkey]);
  const env = envFor("nokey", "*");
  await startChannel({ relayUrl: relay.url, key: agent, env });
  await waitFor(() => logOf(env).includes("not in any channel yet"), { what: "the empty start" });
  assert.ok(logOf(env).includes("does not publish its key"));
  assert.equal(relay.latestSubscription(), null);
});

const trustPartner = { BUZZ_DM_MESSAGES: "all", BUZZ_TRUSTED_PUBKEYS: partner.npub };

test("in a one-to-one DM with a trusted person every message arrives; group DMs need a mention", async () => {
  const relay = await relayWith();
  const [D, G] = [randomUUID(), randomUUID()];
  relay.metadata(D, { type: "dm", members: [agent.pubkey, partner.pubkey] });
  relay.roster(D, [agent.pubkey, partner.pubkey]);
  relay.metadata(G, { type: "dm", members: [agent.pubkey, partner.pubkey, third.pubkey] });
  relay.roster(G, [agent.pubkey, partner.pubkey, third.pubkey]);
  const env = envFor("dm", "*", trustPartner);
  const ch = await startChannel({ relayUrl: relay.url, key: agent, env });
  await waitFor(() => relay.latestSubscription()?.direct.length === 1, { what: "the DM filter" });
  assert.deepEqual(relay.latestSubscription().direct, [D]);

  const fromPartner = plain(partner, D, "no mention, just a DM");
  const fromThird = plain(third, D, "not a member of this DM");
  const groupPlain = plain(partner, G, "group DM without mention");
  const groupMention = mention(partner, G, "group DM with mention");
  for (const e of [fromThird, groupPlain, fromPartner, groupMention]) relay.publish(e);
  await waitFor(() => ch.received.length >= 2, { what: "the DM and the group mention" });
  await pause(200);
  assert.deepEqual(
    ch.received.map((r) => r.meta.event_id),
    [fromPartner.id, groupMention.id],
  );
  assert.equal(ch.received[0].meta.dm, "true");
  assert.equal(ch.received[1].meta.dm, "true");
});

test("a DM listed by id works the same, and BUZZ_DM_MESSAGES=mentions turns it off", async () => {
  const relay = await relayWith();
  const D = randomUUID();
  relay.metadata(D, { type: "dm", members: [agent.pubkey, partner.pubkey] });
  relay.roster(D, [agent.pubkey, partner.pubkey]);

  const listed = await startChannel({ relayUrl: relay.url, key: agent, env: envFor("dm-list", D, trustPartner) });
  await waitFor(() => relay.latestSubscription()?.direct.length === 1, { what: "the DM filter in list mode" });
  const first = plain(partner, D, "listed DM");
  relay.publish(first);
  await waitFor(() => listed.received.length === 1, { what: "the listed DM" });
  await listed.close();

  const reqs = relay.stats.reqs.length;
  const quiet = await startChannel({
    relayUrl: relay.url,
    key: agent,
    env: envFor("dm-mentions", D, { ...trustPartner, BUZZ_DM_MESSAGES: "mentions" }),
  });
  await waitFor(() => relay.stats.reqs.slice(reqs).some((r) => r.subId.startsWith("buzz-channel-sub-")), {
    what: "the mentions-only subscription",
  });
  assert.deepEqual(relay.latestSubscription().direct, []);
  const unmentioned = plain(partner, D, "should not arrive");
  const mentioned = mention(partner, D, "should arrive");
  relay.publish(unmentioned);
  relay.publish(mentioned);
  await waitFor(() => quiet.received.length === 1, { what: "the mentioned DM" });
  await pause(200);
  assert.deepEqual(
    quiet.received.map((r) => r.meta.event_id),
    [mentioned.id],
  );
});

test("a subscription the relay closes after login forces a reconnect", async () => {
  const relay = await relayWith();
  const A = randomUUID();
  const env = envFor("closed", A);
  const ch = await startChannel({ relayUrl: relay.url, key: agent, env });
  const sub = await subscribedTo(relay, [A], "the first subscription");
  const connections = relay.stats.connections;
  relay.inject(JSON.stringify(["CLOSED", sub.subId, "auth-required: session expired"]));
  await waitFor(() => relay.stats.connections > connections, { what: "a reconnect" });
  await waitFor(() => relay.latestSubscription().subId !== sub.subId, { what: "a new subscription" });
  const e = mention(partner, A, "after the reconnect");
  relay.publish(e);
  await waitFor(() => ch.received.length === 1, { what: "delivery after the reconnect" });
});

test("an untrusted DM partner needs a mention, by default and when another person is trusted", async () => {
  const relay = await relayWith();
  const [D, E] = [randomUUID(), randomUUID()];
  relay.metadata(D, { type: "dm", members: [agent.pubkey, partner.pubkey] });
  relay.roster(D, [agent.pubkey, partner.pubkey]);
  relay.metadata(E, { type: "dm", members: [agent.pubkey, third.pubkey] });
  relay.roster(E, [agent.pubkey, third.pubkey]);

  // Default settings: every DM is mentions-only, the trusted person's included.
  const plainDefault = await startChannel({ relayUrl: relay.url, key: agent, env: envFor("dm-default", "*") });
  await subscribedTo(relay, [D, E], "the default subscription");
  assert.deepEqual(relay.latestSubscription().direct, []);
  const quietPartner = plain(partner, D, "default: no mention");
  relay.publish(quietPartner);
  const loudPartner = mention(partner, D, "default: mention");
  relay.publish(loudPartner);
  await waitFor(() => plainDefault.received.length === 1, { what: "the mention" });
  await pause(200);
  assert.deepEqual(plainDefault.received.map((r) => r.meta.event_id), [loudPartner.id]);
  await plainDefault.close();

  // Only partner is trusted: partner's DM delivers everything, the other DM does not.
  const reqs = relay.stats.reqs.length;
  const ch = await startChannel({ relayUrl: relay.url, key: agent, env: envFor("dm-trust", "*", trustPartner) });
  await waitFor(
    () => relay.stats.reqs.slice(reqs).some((r) => r.subId.startsWith("buzz-channel-sub-") && r.filters[1]),
    { what: "the trusted DM filter" },
  );
  assert.deepEqual(relay.latestSubscription().direct, [D]);
  const untrusted = plain(third, E, "untrusted, no mention");
  const trusted = plain(partner, D, "trusted, no mention");
  relay.publish(untrusted);
  relay.publish(trusted);
  await waitFor(() => ch.received.some((r) => r.meta.event_id === trusted.id), { what: "the trusted DM" });
  await pause(200);
  // (Earlier messages from the same second may be caught up too; only these two matter here.)
  const got = ch.received.map((r) => r.meta.event_id);
  assert.ok(got.includes(trusted.id));
  assert.ok(!got.includes(untrusted.id), "the untrusted partner's unmentioned DM was delivered");
});

test("with a list, the one-to-one DMs with a trusted person are heard too, a new one live", async () => {
  const relay = await relayWith();
  const [A, D, E, F] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  relay.metadata(A);
  relay.roster(A, [agent.pubkey, partner.pubkey]);
  relay.metadata(E, { type: "dm", members: [agent.pubkey, third.pubkey] });
  relay.roster(E, [agent.pubkey, third.pubkey]);
  relay.metadata(F);
  relay.roster(F, [agent.pubkey, partner.pubkey]); // a channel the agent is in, but not on its list
  // A long timer: only the relay's live notice can make the new DM show up in time.
  const env = envFor("dm-beside-list", A, { ...trustPartner, BUZZ_ROOMS_REFRESH_MS: "60000" });
  const ch = await startChannel({ relayUrl: relay.url, key: agent, env });
  await subscribedTo(relay, [A], "a subscription to the listed channel only");
  assert.deepEqual(relay.latestSubscription().direct, []);
  await pause(1000);

  // The trusted person opens a DM with the agent (as the agent's own ask would): the relay notifies the agent.
  relay.metadata(D, { type: "dm", members: [agent.pubkey, partner.pubkey] });
  relay.roster(D, [agent.pubkey, partner.pubkey]);
  relay.notify(44100, D, agent.pubkey);
  await subscribedTo(relay, [A, D], "the listed channel and the trusted DM");
  assert.deepEqual(relay.latestSubscription().direct, [D]);

  const yes = plain(partner, D, "yes, update");
  const untrusted = plain(third, E, "an untrusted DM, not listed");
  const unlisted = mention(partner, F, "a channel not on the list");
  for (const e of [untrusted, unlisted, yes]) relay.publish(e);
  await waitFor(() => ch.received.some((r) => r.meta.event_id === yes.id), { what: "the trusted DM" });
  await pause(300);
  assert.deepEqual(
    ch.received.map((r) => r.meta.event_id),
    [yes.id],
  );
  assert.equal(ch.received[0].meta.dm, "true");
  assert.match(logOf(env), /rooms: 2, of which 1 one-to-one DM\(s\) with a trusted person; joined /);
});
