// A stand-in for an order service on 127.0.0.1, for the tests of hosted.mjs: the three routes the agent asks (boot, config, status) and the pack's address. As the real one does,
// boot gives the key once and answers 401 to every later token; config and status take a NIP-98 event only if it is the agent's, fresh, for this URL and method, carries the
// body's sha256 where there is a body, and was not used before. Every field of the returned `s` can be changed by a test, and `calls` says what was asked.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { signAuthTag } from "../nipoa.mjs";

const hex = (u8) => Buffer.from(u8).toString("hex");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

export async function fakeOrder({ pack = null } = {}) {
  const agentSecret = generateSecretKey();
  const ownerSecret = generateSecretKey();
  const s = {
    token: "a1".repeat(16),
    spent: false,
    agentSecretKey: hex(agentSecret),
    agentPubkey: getPublicKey(agentSecret),
    ownerSecret,
    ownerPubkey: getPublicKey(ownerSecret),
    relayUrl: "wss://93.184.216.34",
    senders: null,
    attestation: null,
    pack: pack && { name: "test-pack-v1.tar.gz", bytes: pack, sha256: sha256(pack), headerSha256: undefined, query: "n=test-pack-v1.tar.gz&s=signature-of-the-test" },
    calls: [],
    statuses: [],
    seen: new Set(),
    origin: "",
  };
  s.senders = [s.ownerPubkey];
  s.attestation = signAuthTag(ownerSecret, s.agentPubkey);
  const config = () => ({
    agentPubkey: s.agentPubkey,
    ownerPubkey: s.ownerPubkey,
    relayUrl: s.relayUrl,
    attestation: s.attestation,
    senders: s.senders,
    claudeToken: null,
    ...(s.pack === null ? { pack: null } : { pack: { name: s.pack.name, sha256: s.pack.sha256, url: s.packUrl ?? `${s.origin}/v1/machine/pack?${s.pack.query}`, expiresAt: Date.now() + 300_000 } }),
  });
  // Whether the request carries the agent's own fresh, unused event for this URL and method (and this body).
  const agentEvent = (req, body) => {
    try {
      const m = /^Nostr ([A-Za-z0-9+/]+={0,2})$/.exec(req.headers.authorization ?? "");
      const e = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
      const tag = (n) => e.tags.filter((t) => t[0] === n).map((t) => t[1]);
      const payload = tag("payload");
      const ok = verifyEvent(e) && e.kind === 27235 && e.content === "" && e.pubkey === s.agentPubkey && Math.abs(Date.now() / 1000 - e.created_at) <= 60 && !s.seen.has(e.id) &&
        tag("u").length === 1 && tag("u")[0] === `${s.origin}${req.url}` && tag("method")[0] === req.method && (body.length ? payload[0] === sha256(body) : payload.length === 0);
      if (ok) s.seen.add(e.id);
      return ok;
    } catch {
      return false;
    }
  };
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const send = (code, obj, headers = {}) => {
      s.calls.push([req.method, req.url.split("?")[0], code]);
      res.writeHead(code, { "content-type": "application/json", ...headers });
      res.end(typeof obj === "string" || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
    };
    const refused = () => send(401, { ok: false, error: "unauthorized" });
    if (req.method === "POST" && req.url === "/v1/machine/boot") {
      let token;
      try {
        token = JSON.parse(body.toString("utf8")).token;
      } catch {
        return send(400, { ok: false, error: "bad_request" });
      }
      if (token !== s.token || s.spent) return refused();
      s.spent = true;
      const { pack: _pack, ...rest } = config();
      return send(200, { ok: true, config: { ...rest, agentSecretKey: s.agentSecretKey } });
    }
    if (req.method === "GET" && req.url === "/v1/machine/config") {
      if (s.configRedirect) return send(302, "", { location: "/v1/machine/other" });
      if (s.configStatus) return send(s.configStatus, { ok: false, error: "unavailable" });
      if (s.hugeAnswer) return send(200, Buffer.alloc(100_000, 32));
      return agentEvent(req, body) ? send(200, { ok: true, config: config() }) : refused();
    }
    if (req.method === "POST" && req.url === "/v1/machine/status") {
      if (!agentEvent(req, body)) return refused();
      s.statuses.push(JSON.parse(body.toString("utf8")).status);
      return send(200, { ok: true });
    }
    if (req.method === "GET" && req.url.startsWith("/v1/machine/pack?") && s.pack !== null) {
      if (s.packRedirect && !req.url.includes("elsewhere")) return send(302, "", { location: s.packRedirect });
      return send(200, s.pack.bytes, { "content-type": "application/octet-stream", "x-content-sha256": s.pack.headerSha256 ?? s.pack.sha256 });
    }
    return send(404, { ok: false, error: "not_found" });
  });
  server.unref();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  s.origin = `http://127.0.0.1:${server.address().port}`;
  s.close = () => new Promise((resolve) => (server.close(resolve), server.closeAllConnections()));
  return s;
}
