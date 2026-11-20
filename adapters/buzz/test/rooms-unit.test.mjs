// The pure room rules: whose rosters count, which rooms are listened in,
// and which DMs are one-to-one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { finalizeEvent } from "nostr-tools/pure";
import { channelInfo, directPartners, memberships, roomsFor } from "../src/rooms.mjs";
import { identity } from "./helpers.mjs";

const relay = identity();
const agent = identity();
const other = identity();
const sign = (secret, kind, tags, created_at = 100) => finalizeEvent({ kind, created_at, content: "", tags }, secret);

test("only the newest relay-signed roster counts", () => {
  const events = [
    sign(relay.secret, 39002, [["d", "room-a"], ["p", agent.pubkey]], 100),
    sign(relay.secret, 39002, [["d", "room-a"], ["p", other.pubkey]], 200), // the agent was removed later
    sign(relay.secret, 39002, [["d", "room-b"], ["p", agent.pubkey]]),
    sign(other.secret, 39002, [["d", "room-c"], ["p", agent.pubkey]]), // forged
    sign(relay.secret, 39002, [["d", "bad id with spaces"], ["p", agent.pubkey]]),
  ];
  assert.deepEqual([...memberships(events, relay.pubkey, agent.pubkey)], ["room-b"]);
});

test("archived and system channels are not listened in; rooms without metadata are", () => {
  const info = channelInfo(
    [
      sign(relay.secret, 39000, [["d", "live"], ["t", "stream"]]),
      sign(relay.secret, 39000, [["d", "old"], ["t", "stream"], ["archived"]]),
      sign(relay.secret, 39000, [["d", "sys"], ["t", "system"]]),
    ],
    relay.pubkey,
  );
  assert.deepEqual(roomsFor(["sys", "old", "live", "unknown"], info), ["live", "unknown"]);
});

test("a channel is public only when its metadata says [\"public\"] and not [\"private\"]", () => {
  const info = channelInfo(
    [
      sign(relay.secret, 39000, [["d", "open"], ["t", "stream"], ["public"]]),
      sign(relay.secret, 39000, [["d", "closed"], ["t", "stream"], ["private"]]),
      sign(relay.secret, 39000, [["d", "unsaid"], ["t", "stream"]]),
      sign(relay.secret, 39000, [["d", "both"], ["t", "stream"], ["public"], ["private"]]),
      sign(other.secret, 39000, [["d", "forged"], ["t", "stream"], ["public"]]),
    ],
    relay.pubkey,
  );
  const open = Object.fromEntries(["open", "closed", "unsaid", "both", "forged"].map((id) => [id, info.get(id)?.public === true]));
  assert.deepEqual(open, { open: true, closed: false, unsaid: false, both: false, forged: false });
});

test("a DM is one-to-one only with exactly two members, one of them the agent", () => {
  const third = identity();
  const info = channelInfo(
    [
      sign(relay.secret, 39000, [["d", "pair"], ["t", "dm"], ["p", agent.pubkey], ["p", other.pubkey]]),
      sign(relay.secret, 39000, [["d", "group"], ["t", "dm"], ["p", agent.pubkey], ["p", other.pubkey], ["p", third.pubkey]]),
      sign(relay.secret, 39000, [["d", "theirs"], ["t", "dm"], ["p", other.pubkey], ["p", third.pubkey]]),
      sign(relay.secret, 39000, [["d", "room"], ["t", "stream"], ["p", agent.pubkey], ["p", other.pubkey]]),
    ],
    relay.pubkey,
  );
  const partners = directPartners(["pair", "group", "theirs", "room", "missing"], info, agent.pubkey);
  assert.deepEqual([...partners], [["pair", other.pubkey]]);
});
