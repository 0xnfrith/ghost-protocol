// Configuration for the Buzz channel, read from environment variables.
//
// Every error message here is fixed text. A message never repeats the value
// it rejects, because a misplaced secret must not reach a log.
import { homedir } from "node:os";
import { join } from "node:path";
import { getPublicKey } from "nostr-tools/pure";
import { bytesToHex, hexToBytes } from "nostr-tools/utils";
import { decode } from "nostr-tools/nip19";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export class ConfigError extends Error {}

/** A value that is empty, or a `${...}` placeholder nobody filled in, is unset. */
export function setting(env, name) {
  const value = env[name]?.trim();
  if (!value || /^\$\{[^}]*\}$/.test(value)) return undefined;
  return value;
}

/** Parses a secret key given as 64 hex characters or as nsec1. */
export function parseSecretKey(raw) {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (HEX64.test(value.toLowerCase())) return hexToBytes(value.toLowerCase());
  if (value.startsWith("nsec1")) {
    let decoded;
    try {
      decoded = decode(value);
    } catch {
      throw new ConfigError("the private key is not a valid nsec1 key");
    }
    if (decoded.type !== "nsec") throw new ConfigError("the private key is not a valid nsec1 key");
    return decoded.data;
  }
  throw new ConfigError("the private key must be 64 hex characters or an nsec1 key");
}

/** Parses a public key given as 64 hex characters or as npub1. */
export function parsePublicKey(raw, label) {
  const value = raw.trim();
  if (HEX64.test(value.toLowerCase())) return value.toLowerCase();
  if (value.startsWith("npub1")) {
    try {
      const decoded = decode(value);
      if (decoded.type === "npub") return decoded.data;
    } catch {
      // fall through to the fixed message
    }
  }
  throw new ConfigError(`${label} must be 64 hex characters or an npub1 key`);
}

export function publicKeyOf(secret) {
  const pk = getPublicKey(secret);
  return typeof pk === "string" ? pk : bytesToHex(pk);
}

const AUTH_TAG_SHAPE =
  'BUZZ_AUTH_TAG must be the owner\'s NIP-OA auth tag as JSON: ["auth", "<owner public key, 64 hex>", "<conditions>", "<signature, 128 hex>"]';

/**
 * The owner's NIP-OA `auth` tag from BUZZ_AUTH_TAG, or undefined when it is
 * unset. The value is the tag itself as one JSON array, the same as Block's
 * buzz-mcp reads from the same variable:
 *   ["auth", <owner public key, 64 lowercase hex>, <conditions>, <signature, 128 lowercase hex>]
 * Only the shape is checked here; the relay checks the signature and the
 * conditions. The tag is public (it rides on every event the agent signs),
 * but like every other setting it is never repeated in an error.
 */
export function parseAuthTag(env, ownPubkey) {
  const raw = setting(env, "BUZZ_AUTH_TAG");
  if (raw === undefined) return undefined;
  let tag;
  try {
    tag = JSON.parse(raw);
  } catch {
    throw new ConfigError(AUTH_TAG_SHAPE);
  }
  const wellFormed =
    Array.isArray(tag) &&
    tag.length === 4 &&
    tag.every((part) => typeof part === "string") &&
    tag[0] === "auth" &&
    HEX64.test(tag[1]) &&
    HEX128.test(tag[3]);
  if (!wellFormed) throw new ConfigError(AUTH_TAG_SHAPE);
  if (tag[1] === ownPubkey) {
    throw new ConfigError("BUZZ_AUTH_TAG names the agent's own key as its owner; NIP-OA needs the owner to be another key");
  }
  return tag;
}

/** The relay's http(s) address, where it serves its NIP-11 document. */
export function relayHttpUrl(socketUrl) {
  return socketUrl.replace(/^ws/, "http");
}

/** Turns an http(s) or ws(s) relay address into the websocket URL. */
export function relaySocketUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("BUZZ_RELAY_URL is not a valid URL");
  }
  const scheme = { "http:": "ws:", "https:": "wss:", "ws:": "ws:", "wss:": "wss:" }[url.protocol];
  if (!scheme) throw new ConfigError("BUZZ_RELAY_URL must start with https://, http://, wss:// or ws://");
  url.protocol = scheme;
  return url.toString().replace(/\/$/, "");
}

function positiveInt(env, name, fallback) {
  const value = setting(env, name);
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new ConfigError(`${name} must be a positive whole number`);
  return n;
}

/**
 * A comma-separated list of public keys, or undefined when the setting is
 * unset. An entry that is not a public key is skipped and counted, never
 * repeated: the list then allows less, never more.
 */
function lenientPublicKeys(env, name) {
  const value = setting(env, name);
  if (value === undefined) return undefined;
  const keys = new Set();
  let skipped = 0;
  for (const entry of value.split(/[\s,]+/).filter(Boolean)) {
    try {
      keys.add(parsePublicKey(entry, name));
    } catch {
      skipped++;
    }
  }
  return { keys: [...keys], skipped };
}

/** A path from the settings, with a leading ~/ taken as the home folder. */
function pathSetting(env, name) {
  const value = setting(env, name);
  return value?.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function defaultStateDir(env) {
  const pluginData = setting(env, "CLAUDE_PLUGIN_DATA");
  if (pluginData) return join(pluginData, "buzz", "state");
  const xdg = setting(env, "XDG_STATE_HOME") ?? join(homedir(), ".local", "state");
  return join(xdg, "ghost-protocol", "buzz");
}

/**
 * Reads the channel's settings. `secret` is the already-parsed private key;
 * it is used only to derive the default watched public key.
 */
export function loadConfig(env, secret) {
  const relay = setting(env, "BUZZ_RELAY_URL");
  if (!relay) throw new ConfigError("BUZZ_RELAY_URL is required");

  const channelList = setting(env, "BUZZ_CHANNELS");
  const required = "BUZZ_CHANNELS is required: a comma-separated list of channel ids, or * for every channel the agent is in";
  if (!channelList) throw new ConfigError(required);
  const entries = [...new Set(channelList.split(/[\s,]+/).filter(Boolean))];
  if (entries.length === 0) throw new ConfigError(required);
  const allRooms = entries.includes("*");
  if (allRooms && entries.length > 1) throw new ConfigError("BUZZ_CHANNELS: use * on its own, or list channel ids");
  const channels = allRooms ? [] : entries;

  const dmMode = (setting(env, "BUZZ_DM_MESSAGES") ?? "mentions").toLowerCase();
  if (dmMode !== "all" && dmMode !== "mentions") throw new ConfigError("BUZZ_DM_MESSAGES must be all or mentions");
  // Only these people's one-to-one DMs deliver every message. Nobody is
  // trusted implicitly: not the agent's owner, not anyone else.
  const trustedList = setting(env, "BUZZ_TRUSTED_PUBKEYS");
  const trusted = trustedList
    ? [...new Set(trustedList.split(/[\s,]+/).filter(Boolean).map((k) => parsePublicKey(k, "BUZZ_TRUSTED_PUBKEYS")))]
    : [];

  // The sender allowlist is on when either of these is set; see allowlist.mjs.
  const allowedPubkeys = lenientPublicKeys(env, "BUZZ_ALLOWED_PUBKEYS");
  const allowlistFile = pathSetting(env, "BUZZ_ALLOWLIST_FILE");

  const ownPubkey = publicKeyOf(secret);
  const watchSetting = setting(env, "BUZZ_WATCH_PUBKEY");
  const watchPubkey = watchSetting ? parsePublicKey(watchSetting, "BUZZ_WATCH_PUBKEY") : ownPubkey;

  const stateDir = setting(env, "BUZZ_STATE_DIR") ?? defaultStateDir(env);

  return {
    relayUrl: relaySocketUrl(relay),
    allRooms,
    channels,
    dmAll: dmMode === "all",
    trusted,
    allowedPubkeys,
    allowlistFile,
    ownPubkey,
    watchPubkey,
    authTag: parseAuthTag(env, ownPubkey),
    stateDir,
    logFile: pathSetting(env, "BUZZ_LOG_FILE") ?? join(stateDir, "channel.log"),
    catchupMaxAge: positiveInt(env, "BUZZ_CATCHUP_MAX_AGE", 24 * 60 * 60),
    backoffMs: positiveInt(env, "BUZZ_BACKOFF_MS", 1000),
    backoffMaxMs: positiveInt(env, "BUZZ_BACKOFF_MAX_MS", 60_000),
    heartbeatMs: positiveInt(env, "BUZZ_HEARTBEAT_MS", 30_000),
    connectTimeoutMs: positiveInt(env, "BUZZ_CONNECT_TIMEOUT_MS", 15_000),
    roomsRefreshMs: positiveInt(env, "BUZZ_ROOMS_REFRESH_MS", 60_000),
  };
}
