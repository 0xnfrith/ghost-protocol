// Unit tests of the workflow rule: a message the relay signs for a workflow is
// judged by the workflow's owner when its stamps name this agent, and by its
// author (the relay) otherwise. The rule is written once (senderOf) and read
// by rejectReason, the delivery path and the thread context; each is tested
// here against the same events. The tag shapes are the ones Block's relay
// writes (see fake-relay.mjs, workflowMessage).
import assert from "node:assert/strict";
import { test } from "node:test";
import { finalizeEvent } from "nostr-tools/pure";
import { rejectReason, senderOf, threadContext, workflowOwner } from "../src/relay.mjs";
import { message, workflowMessage } from "./fake-relay.mjs";
import { identity } from "./helpers.mjs";

const channel = "11111111-1111-4111-8111-111111111111";
const watch = identity(); // the identity whose mentions are delivered
const otherAgent = identity(); // another agent in the room
const owner = identity(); // owns the workflow, and is on the allowlist
const stranger = identity(); // owns a workflow, and is on no list
const forger = identity(); // writes the stamps itself
const relay = identity(); // the relay's own key, as its NIP-11 document gives it
const relayKey = relay.pubkey;
const flow = { relayKey, watchPubkey: watch.pubkey };
const opts = { channels: [channel], watchPubkey: watch.pubkey, relayKey };
const now = Math.floor(Date.now() / 1000);

/** A workflow message from the relay, owned by `owner`, mentioning this agent. */
const workflow = (o = {}) => workflowMessage(relay.secret, { channel, owner: owner.pubkey, mentions: [watch.pubkey], ...o });
/** The same, with its tags changed by `edit` and signed by the relay again. */
function withTags(edit) {
  const base = workflow();
  return finalizeEvent({ kind: 9, created_at: base.created_at, content: base.content, tags: edit(base.tags.map((t) => [...t])) }, relay.secret);
}
/** An allowlist that lists only the owner, and records whom it was asked about. */
const allowOwner = (asked = []) => (pk) => {
  asked.push(pk);
  return pk === owner.pubkey;
};
const stamps = (event) => event.tags.filter((t) => t[0].startsWith("buzz:"));
const JSON_COPY = (event) => JSON.parse(JSON.stringify(event)); // drops nostr-tools' cached "verified" mark, as the relay connection does

test("a workflow message that names this agent is judged by its owner, and its author stays the relay", () => {
  const e = workflow();
  assert.equal(e.pubkey, relayKey);
  assert.equal(workflowOwner(e, flow), owner.pubkey);
  assert.deepEqual(senderOf(e, flow), { key: owner.pubkey, owner: owner.pubkey });
  const asked = [];
  assert.equal(rejectReason(e, { ...opts, allows: allowOwner(asked) }), null);
  assert.deepEqual(asked, [owner.pubkey], "the allowlist is asked about the owner, and only the owner");
});

test("a workflow message whose owner is not on the allowlist is dropped, naming the author and the owner", () => {
  const e = workflow({ owner: stranger.pubkey });
  const asked = [];
  assert.equal(
    rejectReason(e, { ...opts, allows: allowOwner(asked) }),
    `not on the sender allowlist (author ${relayKey}, workflow owner ${stranger.pubkey})`,
  );
  assert.deepEqual(asked, [stranger.pubkey]);
});

test("the relay's own key on the allowlist does not stand in for an owner that is not on it", () => {
  const e = workflow({ owner: stranger.pubkey });
  assert.match(rejectReason(e, { ...opts, allows: (pk) => pk === relayKey }), /^not on the sender allowlist/);
});

test("stamps on an event the relay did not sign get no special treatment", () => {
  // The same tags, by a key that is in a room: the author is judged, as for any message.
  const forged = message(forger.secret, { channel, mention: watch.pubkey, tags: stamps(workflow()) });
  assert.equal(workflowOwner(forged, flow), undefined);
  assert.deepEqual(senderOf(forged, flow), { key: forger.pubkey, owner: undefined });
  const asked = [];
  assert.equal(rejectReason(forged, { ...opts, allows: allowOwner(asked) }), `not on the sender allowlist (author ${forger.pubkey})`);
  assert.deepEqual(asked, [forger.pubkey], "the claimed owner is never asked about");
  // The owner's own key signing stamps that name another owner is judged as itself.
  const byOwner = message(owner.secret, { channel, mention: watch.pubkey, tags: stamps(workflow({ owner: stranger.pubkey })) });
  assert.equal(workflowOwner(byOwner, flow), undefined);
  assert.equal(rejectReason(byOwner, { ...opts, allows: allowOwner() }), null);
});

test("stamps from a non-relay key are no mention either", () => {
  const forged = message(forger.secret, { channel, tags: stamps(workflow()) }); // no `p` tag of its own
  assert.equal(rejectReason(forged, { ...opts, allows: () => true }), "no mention");
});

test("without the relay's key, nothing is special", () => {
  const e = workflow();
  for (const unknown of [null, undefined, ""]) {
    assert.equal(workflowOwner(e, { relayKey: unknown, watchPubkey: watch.pubkey }), undefined);
    const asked = [];
    assert.equal(
      rejectReason(e, { ...opts, relayKey: unknown, allows: allowOwner(asked) }),
      `not on the sender allowlist (author ${relayKey})`,
    );
    assert.deepEqual(asked, [relayKey]);
  }
  // The option left out is the same as no key.
  const { relayKey: _, ...without } = opts;
  assert.equal(rejectReason(e, { ...without, allows: allowOwner() }), `not on the sender allowlist (author ${relayKey})`);
  // And a key that is not the relay's is no better.
  assert.equal(workflowOwner(e, { relayKey: forger.pubkey, watchPubkey: watch.pubkey }), undefined);
});

test("a workflow message that names another agent is not delivered to this one", () => {
  // The stamp names the other agent; the plain `p` tag still names this one (a rendered @name).
  const e = workflow({ mentions: [watch.pubkey, otherAgent.pubkey], stamped: [otherAgent.pubkey] });
  assert.equal(workflowOwner(e, flow), undefined);
  assert.equal(workflowOwner(e, { relayKey, watchPubkey: otherAgent.pubkey }), owner.pubkey);
  const asked = [];
  assert.match(rejectReason(e, { ...opts, allows: allowOwner(asked) }), /^not on the sender allowlist \(author /);
  assert.deepEqual(asked, [relayKey], "judged by the relay, which is on no list");
  // With no plain `p` tag for this agent either, it is no mention at all.
  assert.equal(rejectReason(workflow({ mentions: [otherAgent.pubkey] }), { ...opts, allows: () => true }), "no mention");
  // A workflow that names nobody does not either.
  assert.equal(rejectReason(workflow({ mentions: [] }), { ...opts, allows: () => true }), "no mention");
});

test("a plain `p` tag is no stamp: without one, the relay is judged", () => {
  const e = workflow({ stamped: [] });
  assert.equal(workflowOwner(e, flow), undefined);
  assert.match(rejectReason(e, { ...opts, allows: allowOwner() }), /^not on the sender allowlist \(author /);
});

test("a stamp naming this agent is a mention without a plain `p` tag", () => {
  const e = workflow({ mentions: [], stamped: [watch.pubkey] });
  assert.equal(rejectReason(e, { ...opts, allows: allowOwner() }), null);
});

test("a stamp naming this agent among others still counts", () => {
  const e = workflow({ mentions: [watch.pubkey, otherAgent.pubkey] });
  assert.equal(workflowOwner(e, flow), owner.pubkey);
  assert.equal(workflowOwner(e, { relayKey, watchPubkey: otherAgent.pubkey }), owner.pubkey);
});

test("stamps that are malformed or missing void the whole rule, and the relay is judged", () => {
  const withoutOwner = (tags) => tags.filter((t) => t[0] !== "buzz:workflow-owner");
  const withoutMention = (tags) => tags.filter((t) => t[0] !== "buzz:workflow-mention");
  const cases = {
    "no workflow marker": (tags) => tags.filter((t) => t[0] !== "buzz:workflow"),
    "a marker that is not true": (tags) => tags.map((t) => (t[0] === "buzz:workflow" ? ["buzz:workflow", "false"] : t)),
    "a marker with an extra field": (tags) => tags.map((t) => (t[0] === "buzz:workflow" ? [...t, "x"] : t)),
    "two markers": (tags) => [...tags, ["buzz:workflow", "true"]],
    "no owner tag": withoutOwner,
    "an owner tag without a key": (tags) => [...withoutOwner(tags), ["buzz:workflow-owner"]],
    "an owner tag with an extra field": (tags) => tags.map((t) => (t[0] === "buzz:workflow-owner" ? [...t, "x"] : t)),
    "an owner that is not hex": (tags) => [...withoutOwner(tags), ["buzz:workflow-owner", "not-a-key"]],
    "an owner key in capitals": (tags) => [...withoutOwner(tags), ["buzz:workflow-owner", owner.pubkey.toUpperCase()]],
    "an owner key that is too short": (tags) => [...withoutOwner(tags), ["buzz:workflow-owner", owner.pubkey.slice(1)]],
    "an empty owner": (tags) => [...withoutOwner(tags), ["buzz:workflow-owner", ""]],
    "two different owners": (tags) => [...tags, ["buzz:workflow-owner", stranger.pubkey]],
    "the same owner twice": (tags) => [...tags, ["buzz:workflow-owner", owner.pubkey]],
    "a mention that is not hex": (tags) => [...tags, ["buzz:workflow-mention", "nope"]],
    "a mention without a key": (tags) => [...tags, ["buzz:workflow-mention"]],
    "a mention with an extra field": (tags) => tags.map((t) => (t[0] === "buzz:workflow-mention" ? [...t, "x"] : t)),
    "a mention in capitals": (tags) => [...withoutMention(tags), ["buzz:workflow-mention", watch.pubkey.toUpperCase()]],
    "the same mention twice": (tags) => [...tags, ["buzz:workflow-mention", watch.pubkey]],
    "a good mention next to a bad one": (tags) => [...tags, ["buzz:workflow-mention", otherAgent.pubkey, "x"]],
  };
  for (const [what, edit] of Object.entries(cases)) {
    const e = withTags(edit);
    assert.equal(workflowOwner(e, flow), undefined, what);
    const asked = [];
    // The relay is the author and is on no list; the owner's standing is never used.
    assert.match(rejectReason(e, { ...opts, allows: allowOwner(asked) }), /^not on the sender allowlist \(author /, what);
    assert.deepEqual(asked, [relayKey], what);
  }
  // The control: the same event, unchanged, is delivered.
  const control = withTags((tags) => tags);
  assert.equal(workflowOwner(control, flow), owner.pubkey);
  assert.equal(rejectReason(control, { ...opts, allows: allowOwner() }), null);
});

test("tags that are not tags at all void the rule and break nothing", () => {
  // What a relay could send as JSON, though nostr-tools would not sign it: nothing here throws.
  const tagged = (tags) => ({ ...JSON_COPY(workflow()), tags });
  const real = workflow().tags;
  for (const tags of [null, "tags", { 0: ["buzz:workflow", "true"] }]) {
    assert.equal(workflowOwner(tagged(tags), flow), undefined);
  }
  assert.equal(workflowOwner(tagged([...real, null, 7, "buzz:workflow", [], [null], {}]), flow), undefined);
  assert.equal(
    workflowOwner(tagged(real.map((t) => (t[0] === "buzz:workflow-owner" ? ["buzz:workflow-owner", 7] : t))), flow),
    undefined,
  );
  assert.equal(workflowOwner(null, flow), undefined);
  assert.equal(workflowOwner(undefined, flow), undefined);
  // Tags that mean nothing here are ignored, and the real ones read.
  const extra = withTags((tags) => [...tags, [], ["x"], ["buzz:workflow-extra", "1"], ["e", "ab".repeat(32), "", "reply"]]);
  assert.equal(workflowOwner(extra, flow), owner.pubkey);
});

test("only a correctly signed kind 9 counts, whatever its stamps say", () => {
  const e = workflow();
  const altered = { ...JSON_COPY(e), content: "changed" };
  assert.equal(workflowOwner(altered, flow), undefined);
  const asked = [];
  assert.equal(rejectReason(altered, { ...opts, allows: allowOwner(asked) }), "bad signature");
  assert.deepEqual(asked, [], "a forged event never reaches the allowlist");
  // The signature is checked by workflowOwner itself, not left to its caller.
  assert.equal(workflowOwner({ ...JSON_COPY(e), sig: "0".repeat(128) }, flow), undefined);
  // Another kind, signed by the relay, with the same tags.
  const other = finalizeEvent({ kind: 1, created_at: now, content: "x", tags: e.tags }, relay.secret);
  assert.equal(workflowOwner(other, flow), undefined);
});

test("the thread context marks a workflow message by the same rule", () => {
  const root = message(owner.secret, { channel, createdAt: now - 60, content: "root" });
  const inThread = { tags: [["e", root.id, "", "reply"]] };
  const delivered = message(owner.secret, { channel, mention: watch.pubkey, createdAt: now, tags: inThread.tags });
  const events = [
    root,
    workflow({ createdAt: now - 50, content: "owned and allowed", ...inThread }),
    workflow({ owner: stranger.pubkey, createdAt: now - 49, content: "owned, not allowed", ...inThread }),
    workflow({ mentions: [otherAgent.pubkey], createdAt: now - 48, content: "names another agent", ...inThread }),
    message(forger.secret, { channel, createdAt: now - 47, content: "forged stamps", tags: [...stamps(workflow()), ...inThread.tags] }),
    message(owner.secret, { channel, createdAt: now - 46, content: "by the owner", tags: inThread.tags }),
  ];
  const base = { thread: root.id, channel, delivered, agents: [watch.pubkey], watchPubkey: watch.pubkey, allows: allowOwner(), now: now + 1 };
  const byText = (ctx) => Object.fromEntries(ctx.entries.map((e) => [e.text, e]));

  const ctx = byText(threadContext(events, { ...base, relayKey }));
  assert.equal(ctx["owned and allowed"].allowlisted, true);
  assert.equal(ctx["owned and allowed"].author, relayKey, "the author stays the relay");
  assert.equal(ctx["owned and allowed"].workflowOwner, owner.pubkey, "the owner is shown, so a reader sees whom it was judged by");
  assert.equal(ctx["owned, not allowed"].allowlisted, false);
  assert.equal(ctx["owned, not allowed"].workflowOwner, stranger.pubkey);
  assert.equal(ctx["names another agent"].allowlisted, false, "judged by the relay");
  assert.equal(ctx["names another agent"].workflowOwner, undefined);
  assert.equal(ctx["forged stamps"].allowlisted, false, "judged by its author");
  assert.equal(ctx["forged stamps"].workflowOwner, undefined);
  assert.equal(ctx["by the owner"].allowlisted, true);
  assert.equal(ctx["by the owner"].workflowOwner, undefined);

  // Without the relay's key, every workflow message is judged by the relay.
  const keyless = byText(threadContext(events, base));
  assert.equal(keyless["owned and allowed"].allowlisted, false);
  assert.ok(Object.values(keyless).every((e) => e.workflowOwner === undefined));
});

test("a workflow the agent owns is its own message, whether or not the allowlist would let it in", () => {
  const own = identity(); // the key the channel logs in with
  const withOwn = { ...opts, ownPubkey: own.pubkey };
  for (const who of [watch, own]) {
    const e = workflow({ owner: who.pubkey });
    assert.equal(workflowOwner(e, flow), who.pubkey, "the stamp itself is fine");
    assert.equal(rejectReason(e, { ...withOwn, allows: () => true }), "own message");
    assert.equal(rejectReason(e, withOwn), "own message", "with no allowlist at all");
  }
  // Another owner is judged as before.
  assert.equal(rejectReason(workflow(), { ...withOwn, allows: allowOwner() }), null);
  // Stamps that do not hold are not the agent's: the relay is judged, as for any message.
  const voided = withTags((tags) => tags.map((t) => (t[0] === "buzz:workflow-owner" ? ["buzz:workflow-owner", watch.pubkey] : t)).concat([["buzz:workflow", "true"]]));
  assert.match(rejectReason(voided, { ...withOwn, allows: allowOwner() }), /^not on the sender allowlist \(author /);
});

test("in a thread, a workflow the agent owns ends the context as the agent's own message does", () => {
  const root = message(owner.secret, { channel, createdAt: now - 60, content: "root" });
  const inThread = { tags: [["e", root.id, "", "reply"]] };
  const delivered = message(owner.secret, { channel, mention: watch.pubkey, createdAt: now, tags: inThread.tags });
  const events = [
    root,
    message(owner.secret, { channel, createdAt: now - 50, content: "before the agent's workflow", tags: inThread.tags }),
    workflow({ owner: watch.pubkey, createdAt: now - 49, content: "the agent's own workflow", ...inThread }),
    message(owner.secret, { channel, createdAt: now - 48, content: "after it", tags: inThread.tags }),
  ];
  const base = { thread: root.id, channel, delivered, agents: [watch.pubkey], watchPubkey: watch.pubkey, relayKey, allows: allowOwner(), now: now + 1 };
  const ctx = threadContext(events, base);
  assert.equal(ctx.since, "agent_reply");
  assert.deepEqual(ctx.entries.map((e) => e.text), ["after it"]);
  // Without the relay's key it is a message by the relay, and ends nothing.
  const keyless = threadContext(events, { ...base, relayKey: null });
  assert.equal(keyless.since, "thread_root");
  assert.equal(keyless.entries.length, 4);
});

test("an undefined key among the agent's keys makes no plain message the agent's own", () => {
  const root = message(owner.secret, { channel, createdAt: now - 60, content: "root" });
  const inThread = { tags: [["e", root.id, "", "reply"]] };
  const delivered = message(owner.secret, { channel, mention: watch.pubkey, createdAt: now, tags: inThread.tags });
  const events = [root, message(owner.secret, { channel, createdAt: now - 50, content: "a plain reply", tags: inThread.tags })];
  const ctx = threadContext(events, { thread: root.id, channel, delivered, agents: [watch.pubkey, undefined], watchPubkey: watch.pubkey, relayKey, now: now + 1 });
  assert.equal(ctx.since, "thread_root");
  assert.deepEqual(ctx.entries.map((e) => e.text), ["root", "a plain reply"]);
  // rejectReason has no key of its own to name either, and still judges as before.
  assert.equal(rejectReason(workflow(), { ...opts, allows: allowOwner() }), null);
});

