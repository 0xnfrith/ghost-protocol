// The one-shot status read: each agent's status line, name and presence, one
// JSON line per agent, then exit. Started by the launcher (`node launch.mjs
// status read …`), which runs BUZZ_KEY_COMMAND and hands the key over in
// BUZZ_PRIVATE_KEY, in this process's environment only: the read logs in
// with it, and signs the presence read (NIP-98) with it.
//
//   node launch.mjs status read [--agent <pubkey>]...
//
// With no --agent, it reads the agents in BUZZ_STATUS_AGENTS and the key's
// own. The rows' fields are README.md's "Status line", the same as the
// channel's agent_status tool.
//
// Exit 0: read. Exit 1: the relay refused the login, closed the connection,
// could not be reached, or did not answer within BUZZ_SEND_TIMEOUT_MS
// (default 30000). Exit 2: usage, or a bad setting, key or argument. Exit 3:
// the relay refused the read (its reason on stderr). A presence read that
// fails gives presence "unknown" and exit 0. stderr says why in fixed words
// or the relay's own reason, never with the key.
import { finalizeEvent } from "nostr-tools/pure";
import { RelayClient, RelayError } from "./client.mjs";
import { ConfigError, parseAuthTag, parsePublicKey, parseSecretKey, publicKeyOf, relayHttpUrl, relaySocketUrl, setting } from "./config.mjs";
import { presenceSnapshot, readStatuses, statusSettings } from "./status.mjs";

const say = (message) => process.stderr.write(`buzz status: ${message}\n`);
const USAGE = "usage: status read [--agent <pubkey>]...";

function quit(code, message) {
  if (message) say(message);
  process.exit(code);
}

const [action, ...rest] = process.argv.slice(2);
if (action !== "read") quit(2, USAGE);
const asked = [];
for (let i = 0; i < rest.length; i += 2) {
  if (rest[i] !== "--agent") quit(2, USAGE);
  if (rest[i + 1] === undefined) quit(2, "--agent needs a value");
  try {
    asked.push(parsePublicKey(rest[i + 1], "--agent"));
  } catch (err) {
    quit(2, err instanceof ConfigError ? err.message : "--agent is not a public key");
  }
}

let secret;
try {
  secret = parseSecretKey(process.env.BUZZ_PRIVATE_KEY);
} catch (err) {
  quit(2, err instanceof ConfigError ? err.message : "could not read the private key");
}
delete process.env.BUZZ_PRIVATE_KEY;
let url;
let authTag;
let agents;
const self = publicKeyOf(secret);
try {
  const raw = setting(process.env, "BUZZ_RELAY_URL");
  if (!raw) throw new ConfigError("set BUZZ_RELAY_URL");
  url = relaySocketUrl(raw);
  authTag = parseAuthTag(process.env, self);
  const conf = statusSettings(process.env, parsePublicKey);
  for (const problem of conf.problems.filter((p) => p.startsWith("BUZZ_STATUS_AGENTS"))) say(problem);
  agents = [...new Set(asked.length ? asked : [...conf.agents, self])].slice(0, 50);
} catch (err) {
  quit(2, err instanceof ConfigError ? err.message : "a setting is not usable");
}
const timeoutMs = Number.parseInt(setting(process.env, "BUZZ_SEND_TIMEOUT_MS") ?? "30000", 10);
const client = new RelayClient({ url, secret, authTag, timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000 });

/** The relay's own key, from its NIP-11 document: the presence snapshot is signed with it. */
async function relayKey(httpUrl) {
  try {
    const response = await fetch(httpUrl, { headers: { Accept: "application/nostr+json" }, signal: AbortSignal.timeout(10_000) });
    const doc = await response.json();
    return typeof doc?.self === "string" && /^[0-9a-f]{64}$/.test(doc.self) ? doc.self : null;
  } catch {
    return null;
  }
}

try {
  await client.open();
  const httpUrl = relayHttpUrl(url);
  const key = await relayKey(httpUrl);
  const rows = await readStatuses({
    query: (filters) => client.query(filters),
    presence: (who) =>
      presenceSnapshot({ httpUrl, secret, authTag, relayKey: key, agents: who, sign: finalizeEvent }).catch((err) => {
        say(`presence unknown: ${String(err?.message ?? "the read failed").slice(0, 200)}`);
        throw err;
      }),
    agents,
    now: Math.floor(Date.now() / 1000),
  });
  client.close();
  process.stdout.write(`${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  process.exit(0);
} catch (err) {
  client.close();
  if (err instanceof RelayError) quit(err.message.startsWith("the relay refused the read") ? 3 : 1, err.message);
  quit(1, "could not reach the relay");
}
