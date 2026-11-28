// gp hosted: a container that an order service made, started with a boot token and the service's address and nothing else (docs/hosted.md).
//   gp hosted start            what the entrypoint runs first: spends the token once (POST /v1/machine/boot) on a volume never booted, then pulls the config as on every start
//   gp hosted sync             one pull of the config (GET /v1/machine/config, a NIP-98 event of the agent's key), applied
//   gp hosted heartbeat        what the entrypoint repeats: a pull, then `error` if it failed, or `online` if the agent runs
//   gp hosted report <status>  online, error or stopping (POST /v1/machine/status)
// The agent's key is kept in the volume the moment it arrives, before anything is checked, because it is given once. The token is read from the environment, sent once and never
// written. Nothing here prints the key, the token, a body the service sent or the pack's address.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { GpError } from "./out.mjs";
import { L } from "./layout.mjs";
import { readJson, writeFileAtomic, writeJson } from "./files.mjs";
import { slugOf } from "./setup.mjs";
import { verifyAuthTag } from "./nipoa.mjs";
import { adapter } from "./paths.mjs";
import { ensureAllowlist, setOrderSenders } from "./allow.mjs";
import { refusePrivateRelay } from "./relayaddr.mjs";
import { installPack } from "./pack.mjs";

const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const STATUSES = ["online", "error", "stopping"];
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/;
const MAX_ANSWER = 64 * 1024;
const bad = (m) => new GpError("bad-config", `the order service's config is refused: ${m}`);

/** The origin of the order service's address: https, or http on the machine itself; no credentials, path, query or fragment. */
export function orderOrigin(raw) {
  let u;
  try {
    u = new URL(String(raw ?? "").trim());
  } catch {
    throw new GpError("bad-order-url", "GP_ORDER_URL is not an address");
  }
  const ok = (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK.test(u.hostname))) && !u.username && !u.password && !u.search && !u.hash && u.pathname === "/";
  if (!ok) throw new GpError("bad-order-url", "GP_ORDER_URL must be an https address of the order service alone (http only for this machine's own loopback)");
  return u.origin;
}

// One request to the order service. Returns { status, body } where body is the parsed JSON or null; the answer is read under a cap, and a redirect is an error.
async function request(origin, method, path, { body, authorization, fetchImpl }) {
  const headers = { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(authorization ? { authorization } : {}) };
  let res;
  try {
    res = await fetchImpl(new URL(path, origin), { method, headers, body, redirect: "error", signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new GpError("order-unreachable", "the order service did not answer");
  }
  const chunks = [];
  let n = 0;
  for await (const c of res.body ?? []) {
    n += c.length;
    if (n > MAX_ANSWER) throw new GpError("order-unreachable", "the order service's answer is too large");
    chunks.push(c);
  }
  try {
    return { status: res.status, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { status: res.status, body: null };
  }
}

// The NIP-98 `Authorization` of a request: kind 27235, the request's own URL and method, and the sha256 of the body when there is one.
async function nip98(secretHex, origin, method, path, body) {
  const { finalizeEvent } = await import("nostr-tools/pure");
  // The nonce keeps two requests of one second from being one event, which the service takes once only.
  const tags = [["u", new URL(path, origin).href], ["method", method], ["nonce", randomBytes(8).toString("hex")], ...(body === undefined ? [] : [["payload", createHash("sha256").update(body).digest("hex")]])];
  const event = finalizeEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags, content: "" }, Buffer.from(secretHex, "hex"));
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
}

/** The config's own checks. `owner` is the owner the first boot set, or null at the first boot. Returns the config as it is used. */
export function checkConfig(c, { owner = null } = {}) {
  if (!c || typeof c !== "object") throw bad("it is not an object");
  const { agentPubkey, ownerPubkey, relayUrl, attestation, senders, claudeToken, pack } = c;
  if (!HEX64.test(agentPubkey ?? "") || !HEX64.test(ownerPubkey ?? "")) throw bad("a key is not 64 lower-case hex characters");
  if (owner !== null && ownerPubkey !== owner) throw bad("the owner is not the one this agent was made for, and an owner never changes");
  if (!Array.isArray(senders) || senders.length < 1 || senders.length > 8 || !senders.every((k) => HEX64.test(k ?? "")) || new Set(senders).size !== senders.length) throw bad("the senders are not one to eight different keys");
  if (senders[0] !== ownerPubkey) throw bad("the first sender is not the owner");
  if (!Array.isArray(attestation) || attestation.length !== 4 || !attestation.every((x) => typeof x === "string") || attestation[0] !== "auth" || attestation[1] !== ownerPubkey) throw bad("the attestation is not the owner's");
  if (!verifyAuthTag(attestation, agentPubkey)) throw bad("the attestation is not a valid one for this agent's key");
  if (typeof relayUrl !== "string" || relayUrl.length > 200) throw bad("the relay is not an address");
  if (claudeToken !== undefined && claudeToken !== null && (typeof claudeToken !== "string" || !claudeToken.trim())) throw bad("the Claude token is not a token or null");
  if (pack !== undefined && pack !== null && (typeof pack !== "object" || typeof pack.name !== "string" || !HEX64.test(pack.sha256 ?? "") || typeof pack.url !== "string")) throw bad("the pack is not described");
  return { agentPubkey, ownerPubkey, relayUrl, attestation, senders, claudeToken: claudeToken ?? null, pack: pack ?? null, name: typeof c.name === "string" && c.name.trim() && !/[\u0000-\u001f\u007f]/.test(c.name) ? c.name.trim() : null };
}

// What a checked config puts in the volume. The relay is checked first, and a refused one is not written. Nothing here writes the key.
async function apply(cfg, { lookup }) {
  const { relaySocketUrl } = await import(adapter("src/config.mjs"));
  let socket;
  try {
    socket = relaySocketUrl(cfg.relayUrl);
  } catch {
    throw bad("the relay's address must start with https://, http://, wss:// or ws://");
  }
  // The relay's name is resolved once here and again by each program that connects to it (the adapter, buzz-mcp), so a name that changes its answer in between is not stopped by
  // the check below alone. TLS stops it: a relay on another address than the checked one is reached only if it holds a certificate for the relay's own name, and a plain ws://
  // connection, which would send its request to whatever answers, is not taken.
  if (new URL(socket).protocol !== "wss:") throw new GpError("relay-not-tls", "the relay must be reached over TLS (wss:// or https://): a hosted agent does not connect to a plain ws:// relay");
  await refusePrivateRelay(cfg.relayUrl, { lookup });
  const had = readJson(L.config);
  const name = cfg.name ?? had.name ?? "GHOST";
  writeJson(L.config, { ...had, name, slug: slugOf(name), relay_url: cfg.relayUrl, owner: cfg.ownerPubkey });
  writeFileAtomic(L.tag, JSON.stringify(cfg.attestation) + "\n", 0o644);
  if (cfg.claudeToken) writeFileAtomic(L.token, cfg.claudeToken + "\n");
  ensureAllowlist();
  setOrderSenders(cfg.ownerPubkey, cfg.senders);
}

function booted() {
  const h = readJson(L.hosted);
  return HEX64.test(h.agent_pubkey ?? "") && typeof h.order_url === "string" ? h : null;
}
const agentSecret = () => readFileSync(L.key, "utf8").trim();

async function boot(env, { fetchImpl, lookup }) {
  const token = (env.GP_BOOT_TOKEN ?? "").trim();
  const origin = orderOrigin(env.GP_ORDER_URL);
  if (!TOKEN.test(token)) throw new GpError("bad-boot-token", "GP_BOOT_TOKEN must be the boot token: 32 lower-case hex characters");
  const res = await request(origin, "POST", "/v1/machine/boot", { body: JSON.stringify({ token }), fetchImpl });
  if (res.status === 401) throw new GpError("boot-refused", "the order service refused the boot token: it is spent, expired or unknown, and a spent one is not given again");
  const c = res.body?.config;
  if (res.status !== 200 || res.body?.ok !== true || !c) throw new GpError("boot-failed", `the order service did not boot the agent (it answered ${res.status})`);
  const { getPublicKey } = await import("nostr-tools/pure");
  const secret = c.agentSecretKey;
  if (!HEX64.test(secret ?? "") || getPublicKey(Buffer.from(secret, "hex")) !== c.agentPubkey) throw bad("the agent's key is not the key of the agent's public key");
  // The key first: the service gives it once, and everything after this can be asked again.
  writeFileAtomic(L.key, secret + "\n", 0o600);
  writeJson(L.hosted, { order_url: origin, agent_pubkey: c.agentPubkey, booted_at: new Date().toISOString() });
  await apply(checkConfig(c), { lookup });
}

/** One pull of the config, applied. */
export async function sync({ fetchImpl = fetch, lookup } = {}) {
  const h = booted();
  if (!h || !existsSync(L.key)) throw new GpError("not-booted", "this volume was not booted from an order service");
  const secret = agentSecret();
  const res = await request(h.order_url, "GET", "/v1/machine/config", { authorization: await nip98(secret, h.order_url, "GET", "/v1/machine/config"), fetchImpl });
  // A 5xx is the service being down (its database failing, or the edge with no Worker behind it): no answer. A 4xx, a 401 included, is an answer.
  if (res.status >= 500) throw new GpError("order-unreachable", `the order service is down (it answered ${res.status})`);
  if (res.status !== 200 || res.body?.ok !== true) throw new GpError("config-failed", `the order service did not give the config (it answered ${res.status})`);
  const cfg = checkConfig(res.body.config, { owner: readJson(L.config).owner ?? null });
  if (cfg.agentPubkey !== h.agent_pubkey) throw bad("the agent's key is not this agent's");
  await apply(cfg, { lookup });
  const pack = cfg.pack ? await installPack(cfg.pack, h.order_url, { fetchImpl }) : "none";
  return { pack };
}

/** Tells the order service how the agent is. */
export async function reportStatus(status, { fetchImpl = fetch } = {}) {
  if (!STATUSES.includes(status)) throw new GpError("usage", `usage: gp hosted report <${STATUSES.join("|")}>`, 2);
  const h = booted();
  if (!h || !existsSync(L.key)) throw new GpError("not-booted", "this volume was not booted from an order service");
  const body = JSON.stringify({ status });
  const res = await request(h.order_url, "POST", "/v1/machine/status", { body, authorization: await nip98(agentSecret(), h.order_url, "POST", "/v1/machine/status", body), fetchImpl });
  if (res.status !== 200) throw new GpError("report-failed", `the order service did not take the status (it answered ${res.status})`);
}

export async function hosted(argv, out, { env = process.env, fetchImpl = fetch, lookup } = {}) {
  const [sub, arg, ...rest] = argv;
  if (!["start", "sync", "heartbeat", "report"].includes(sub) || rest.length || (sub === "report") !== (arg !== undefined)) throw new GpError("usage", "usage: gp hosted start | gp hosted sync | gp hosted heartbeat | gp hosted report <online|error|stopping>", 2);
  out.header();
  if (sub === "report") {
    await reportStatus(arg, { fetchImpl });
    out.kv("REPORTED", arg);
    return 0;
  }
  if (sub === "sync") {
    const r = await sync({ fetchImpl, lookup });
    out.kv("PACK", r.pack);
    return 0;
  }
  if (sub === "heartbeat") {
    // What the entrypoint repeats: a pull, then the agent's state as the status. A failed pull is `error`; a good one after it is `online` again, once the agent runs.
    try {
      await sync({ fetchImpl, lookup });
    } catch (err) {
      await reportStatus("error", { fetchImpl }).catch(() => {});
      throw err;
    }
    const running = /^running\b/.test(existsSync(L.agentState) ? readFileSync(L.agentState, "utf8") : "");
    if (running) await reportStatus("online", { fetchImpl });
    out.kv("REPORTED", running ? "online" : "none");
    return 0;
  }
  const token = (env.GP_BOOT_TOKEN ?? "").trim();
  const asked = token !== "" || (env.GP_ORDER_URL ?? "").trim() !== "";
  const before = booted();
  if (before) {
    out.kv("HOSTED", "ready");
  } else if (!asked) {
    out.kv("HOSTED", "none");
    return 0;
  } else if (existsSync(L.key)) {
    out.log("the boot token is ignored: this volume already has an agent key, and was not made by an order service");
    out.kv("HOSTED", "none");
    return 0;
  } else {
    await boot(env, { fetchImpl, lookup });
    out.kv("HOSTED", "booted");
  }
  try {
    const r = await sync({ fetchImpl, lookup });
    out.kv("PACK", r.pack);
  } catch (err) {
    // A volume that was booted has its config, senders and pack: an order service that does not answer must not stop it from starting. Any other refusal, a 401 included, still does.
    if (!before || !["order-unreachable", "pack-unreachable"].includes(err?.code)) throw err;
    out.log(`${err.message}: the agent starts with what it has`);
    out.kv("PACK", "unchecked");
  }
  return 0;
}
