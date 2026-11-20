import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { bytesToHex } from "nostr-tools/utils";

export const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LAUNCH = join(ADAPTER, "src", "launch.mjs");

export function identity() {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  return { secret, hex: bytesToHex(secret), nsec: nsecEncode(secret), pubkey, npub: npubEncode(pubkey) };
}

export function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `buzz-adapter-${label}-`));
}

export async function waitFor(check, { timeout = 5000, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Channels still running; closeAll() stops them even after a failed assertion. */
const running = new Set();

export async function closeAll() {
  await Promise.all([...running].map((ch) => ch.close()));
}

/**
 * Starts the channel through the real launcher, as Claude Code would, and
 * records every channel notification it pushes.
 */
export async function startChannel({ relayUrl, key, env = {} }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [LAUNCH, "channel"],
    env: {
      BUZZ_RELAY_URL: relayUrl,
      BUZZ_KEY_COMMAND: `printf %s ${key.hex}`,
      BUZZ_BACKOFF_MS: "50",
      BUZZ_BACKOFF_MAX_MS: "200",
      BUZZ_HEARTBEAT_MS: "200",
      ...env,
    },
    stderr: "pipe",
  });
  const errChunks = [];
  transport.stderr.on("data", (chunk) => errChunks.push(chunk));
  const client = new Client({ name: "test-session", version: "0.0.0" });
  const received = [];
  client.fallbackNotificationHandler = async (notification) => {
    if (notification.method === "notifications/claude/channel") received.push(notification.params);
  };
  await client.connect(transport);
  const ch = {
    client,
    received,
    pid: transport.pid,
    stderr: () => Buffer.concat(errChunks).toString("utf8"),
    close: async () => {
      running.delete(ch);
      await client.close();
    },
  };
  running.add(ch);
  return ch;
}

/** Every file under a directory, as text. */
export function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push({ path, text: readFileSync(path, "utf8") });
  }
  return out;
}

/** True when none of the texts contains the key, in hex or nsec form. */
export function keyAbsent(key, texts) {
  return texts.every((t) => !t.includes(key.hex) && !t.toLowerCase().includes(key.hex) && !t.includes(key.nsec));
}
