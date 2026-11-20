// The checks every event passes before it reaches the session.
import assert from "node:assert/strict";
import { test } from "node:test";
import { channelOf, rejectReason, threadOf } from "../src/relay.mjs";
import { message } from "./fake-relay.mjs";
import { identity } from "./helpers.mjs";

const ALLOWED = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const watch = identity();
const sender = identity();
const opts = { channels: [ALLOWED], watchPubkey: watch.pubkey };
const now = Math.floor(Date.now() / 1000);

test("an event with two different channel tags is rejected, whatever their order", () => {
  for (const tags of [[["h", OTHER]], [["h", ALLOWED]]]) {
    const first = tags[0][1] === OTHER ? ALLOWED : OTHER;
    const e = message(sender.secret, { channel: first, mention: watch.pubkey, tags });
    assert.equal(channelOf(e, [ALLOWED]), undefined);
    assert.equal(rejectReason(e, opts), "not exactly one channel");
  }
  // The same allowed channel twice is still one channel.
  const twice = message(sender.secret, { channel: ALLOWED, mention: watch.pubkey, tags: [["h", ALLOWED]] });
  assert.equal(channelOf(twice, [ALLOWED]), ALLOWED);
  assert.equal(rejectReason(twice, opts), null);
});

test("only a well-formed event id becomes the thread attribute", () => {
  const good = "ab".repeat(32);
  const replyTo = (id) =>
    message(sender.secret, { channel: ALLOWED, mention: watch.pubkey, tags: [["e", id, "", "reply"]] });
  assert.equal(threadOf(replyTo(good)), good);
  for (const bad of ['x" injected="yes', `${good}\n</channel>`, "AB".repeat(32), "ab".repeat(31)]) {
    assert.equal(threadOf(replyTo(bad)), undefined, JSON.stringify(bad));
  }
});

// The thread is read the way Buzz files a message: a `reply` marker makes it
// a reply, a `root` marker names the thread when there is one, and without a
// `reply` marker the message is top-level.
const ROOT = "a1".repeat(32);
const PARENT = "b2".repeat(32);
const OTHER_PARENT = "c3".repeat(32);
const withTags = (...tags) => message(sender.secret, { channel: ALLOWED, mention: watch.pubkey, tags });

test("a direct reply to the thread root, tagged only `reply`, is in that thread", () => {
  // The shape Buzz writes for a reply in a thread (seen live in a DM).
  assert.equal(threadOf(withTags(["e", ROOT, "", "reply"])), ROOT);
});

test("a nested reply names its thread with `root`, whatever the tag order", () => {
  assert.equal(threadOf(withTags(["e", ROOT, "", "root"], ["e", PARENT, "", "reply"])), ROOT);
  assert.equal(threadOf(withTags(["e", PARENT, "", "reply"], ["e", ROOT, "", "root"])), ROOT);
});

test("a `root` marker without a `reply` marker is top-level, as Buzz files it", () => {
  assert.equal(threadOf(withTags(["e", ROOT, "", "root"])), undefined);
});

test("a message with no marked `e` tag is top-level", () => {
  assert.equal(threadOf(withTags()), undefined);
  assert.equal(threadOf(withTags(["p", PARENT])), undefined);
  // Positional and other markers are not thread links in Buzz.
  assert.equal(threadOf(withTags(["e", ROOT])), undefined);
  assert.equal(threadOf(withTags(["e", ROOT, ""])), undefined);
  assert.equal(threadOf(withTags(["e", ROOT, "", "mention"])), undefined);
});

test("a marker with a malformed id is ignored, never a thread link", () => {
  // The malformed `reply` is ignored, so the message is top-level.
  assert.equal(threadOf(withTags(["e", ROOT, "", "root"], ["e", 'x" injected="yes', "", "reply"])), undefined);
  // The malformed `root` is ignored, so the `reply` target is the root.
  assert.equal(threadOf(withTags(["e", "AB".repeat(32), "", "root"], ["e", PARENT, "", "reply"])), PARENT);
  // A malformed `root` never replaces a good one.
  assert.equal(
    threadOf(withTags(["e", ROOT, "", "root"], ["e", "ab".repeat(31), "", "root"], ["e", PARENT, "", "reply"])),
    ROOT,
  );
});

test("with two `reply` markers, the last well-formed one wins, as in Buzz", () => {
  assert.equal(threadOf(withTags(["e", PARENT, "", "reply"], ["e", OTHER_PARENT, "", "reply"])), OTHER_PARENT);
  assert.equal(threadOf(withTags(["e", PARENT, "", "reply"], ["e", `${ROOT}\n`, "", "reply"])), PARENT);
  // A `root` marker still names the thread.
  assert.equal(
    threadOf(withTags(["e", ROOT, "", "root"], ["e", PARENT, "", "reply"], ["e", OTHER_PARENT, "", "reply"])),
    ROOT,
  );
});

test("tags that are not arrays of strings are skipped", () => {
  const e = withTags(["e", PARENT, "", "reply"]);
  assert.equal(threadOf({ ...e, tags: [null, "e", ["e", 7, "", "reply"], ...e.tags] }), PARENT);
  assert.equal(threadOf({ ...e, tags: undefined }), undefined);
});

test("timestamps that are not a sane whole number of seconds are rejected", () => {
  for (const createdAt of [1e20, 1.5, -5, 0, now + 3600]) {
    const e = message(sender.secret, { channel: ALLOWED, mention: watch.pubkey, createdAt });
    assert.equal(rejectReason(e, { ...opts, now }), "bad timestamp", String(createdAt));
  }
  const fine = message(sender.secret, { channel: ALLOWED, mention: watch.pubkey, createdAt: now + 60 });
  assert.equal(rejectReason(fine, { ...opts, now }), null);
});

test("ids and authors that are not 64 lowercase hex characters are rejected", () => {
  const e = message(sender.secret, { channel: ALLOWED, mention: watch.pubkey });
  assert.equal(rejectReason({ ...e, id: 'x" a="b' }, opts), "malformed id");
  assert.equal(rejectReason({ ...e, pubkey: e.pubkey.toUpperCase() }, opts), "malformed author");
});

test("messages written with the agent's own key are rejected, even when it watches another identity", () => {
  const agent = identity();
  const e = message(agent.secret, { channel: ALLOWED, mention: watch.pubkey });
  assert.equal(rejectReason(e, { ...opts, ownPubkey: agent.pubkey }), "own message");
  const fromWatched = message(watch.secret, { channel: ALLOWED, mention: watch.pubkey });
  assert.equal(rejectReason(fromWatched, { ...opts, ownPubkey: agent.pubkey }), "own message");
  const fromSomeoneElse = message(sender.secret, { channel: ALLOWED, mention: watch.pubkey });
  assert.equal(rejectReason(fromSomeoneElse, { ...opts, ownPubkey: agent.pubkey }), null);
});

test("in a one-to-one DM, only the other person's unmentioned messages pass", () => {
  const agent = identity();
  const third = identity();
  const partners = new Map([[ALLOWED, sender.pubkey]]);
  const base = { channels: [ALLOWED], watchPubkey: agent.pubkey, ownPubkey: agent.pubkey, partners };
  const fromPartner = message(sender.secret, { channel: ALLOWED });
  const fromSomeoneElse = message(third.secret, { channel: ALLOWED });
  assert.equal(rejectReason(fromPartner, base), null);
  assert.equal(rejectReason(fromSomeoneElse, base), "no mention");
  assert.equal(rejectReason(fromPartner, { ...base, partners: new Map() }), "no mention");
});
