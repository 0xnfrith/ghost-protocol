// Which rooms the agent is in, and which of them are one-to-one DMs.
//
// Buzz keeps both facts in relay-signed NIP-29 events:
//   kind 39002, the member roster: `d` = channel id, one `p` tag per member;
//   kind 39000, the channel metadata: `d` = channel id, `t` = its type
//     (stream, forum, dm, workflow, system), an `archived` tag once it is
//     archived, and for a DM one `p` tag per participant.
// Only events signed by the relay's own key (its NIP-11 `self`) are trusted,
// so no member can widen the room set with a forged roster.
import { verifyEvent } from "nostr-tools/pure";

export const KIND_GROUP_METADATA = 39000;
export const KIND_GROUP_MEMBERS = 39002;
const HEX64 = /^[0-9a-f]{64}$/;
const CHANNEL_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;

function signedByRelay(event, relayKey, kind) {
  if (!event || typeof event !== "object" || event.kind !== kind || event.pubkey !== relayKey) return false;
  if (!Array.isArray(event.tags)) return false;
  try {
    return verifyEvent(event);
  } catch {
    return false;
  }
}

function first(event, name) {
  const tag = event.tags.find((t) => Array.isArray(t) && t[0] === name && typeof t[1] === "string");
  return tag?.[1];
}

function people(event) {
  return [
    ...new Set(event.tags.filter((t) => Array.isArray(t) && t[0] === "p" && HEX64.test(t[1] ?? "")).map((t) => t[1])),
  ];
}

/** The newest relay-signed event of `kind` for each channel id. */
function latestByChannel(events, relayKey, kind) {
  const latest = new Map();
  for (const event of events) {
    if (!signedByRelay(event, relayKey, kind)) continue;
    const id = first(event, "d");
    if (!id || !CHANNEL_ID.test(id)) continue;
    const seen = latest.get(id);
    if (!seen || event.created_at > seen.created_at) latest.set(id, event);
  }
  return latest;
}

/** Channel ids whose newest relay-signed roster lists `member`. */
export function memberships(events, relayKey, member) {
  const ids = new Set();
  for (const [id, event] of latestByChannel(events, relayKey, KIND_GROUP_MEMBERS)) {
    if (people(event).includes(member)) ids.add(id);
  }
  return ids;
}

/** Channel id -> { type, members, archived }, from relay-signed metadata. */
export function channelInfo(events, relayKey) {
  const info = new Map();
  for (const [id, event] of latestByChannel(events, relayKey, KIND_GROUP_METADATA)) {
    info.set(id, {
      type: first(event, "t") ?? "stream",
      members: people(event),
      archived: event.tags.some((t) => Array.isArray(t) && t[0] === "archived"),
      // Open to every member: Buzz marks an open channel ["public"], any other
      // ["private"]; a channel that says neither, or both, is not counted open.
      public:
        event.tags.some((t) => Array.isArray(t) && t[0] === "public") &&
        !event.tags.some((t) => Array.isArray(t) && t[0] === "private"),
    });
  }
  return info;
}

/**
 * The rooms to listen in when BUZZ_CHANNELS is `*`: every channel the agent
 * belongs to, except archived and system channels. A membership whose
 * metadata could not be read is kept.
 */
export function roomsFor(memberIds, info) {
  return [...memberIds]
    .filter((id) => {
      const meta = info.get(id);
      return !meta || (!meta.archived && meta.type !== "system");
    })
    .sort();
}

/**
 * For each one-to-one DM among `channels`: channel id -> the other person.
 * A DM counts only with exactly two distinct members, one of them the agent.
 * Group DMs, and DMs whose metadata is missing, are left out (mentions only).
 */
export function directPartners(channels, info, ownPubkey) {
  const partners = new Map();
  for (const id of channels) {
    const meta = info.get(id);
    if (meta?.type !== "dm" || meta.members.length !== 2 || !meta.members.includes(ownPubkey)) continue;
    partners.set(id, meta.members.find((m) => m !== ownPubkey));
  }
  return partners;
}
