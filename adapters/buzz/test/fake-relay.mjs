// A small in-process Nostr relay for tests. It demands NIP-42 AUTH (checking
// the challenge, the relay tag and the signature), answers REQ with stored
// events newest first and then EOSE, and pushes new events to matching
// subscriptions. A client's EVENT is checked (logged in, a valid signature),
// stored and answered with OK; tests can make it refuse or never answer,
// start a relay that asks for no login at all (`requireAuth: false`, which
// answers a REQ without one too), or one that sends its challenge only after
// refusing a first EVENT or REQ with "auth-required:" (`authAfterEvent: true`). Like Buzz, it serves a NIP-11 document with its own signing
// key (`self`; a test can make it fail or hold it back) and signs channel
// rosters (39002), metadata (39000) and, for workflow tests, the messages a
// workflow posts (workflowMessage) with it.
// It records the `auth` tags (NIP-OA) of every AUTH event, and with
// hooks.requireAuthTag it refuses a login without exactly one, the way Buzz
// refuses a key that is on the relay only through its owner's attestation
// (it does not check the attestation's signature).
// Tests can drop every connection, refuse new ones, fail or stall the
// WebSocket handshake itself, make the current connections go silent without
// closing, or make room or thread queries fail. A deletion (kind 5) a client
// publishes removes the events its `e` tags name that the same key wrote, as
// a relay that honours NIP-09 does (hooks.ignoreDeletions keeps them).
// Presence (kind 20001) works as Buzz's does: the content is the status, an
// "offline" one or the key's last connection closing clears it, nothing is
// stored, and POST /query with {kinds:[20001], authors} (NIP-98 signed, its
// proof checked) answers with relay-signed events, one `p` tag each.
// hooks.presenceHttp: "ok", "fail" (an HTTP 500) or "forged" (signed by
// another key).
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { matchFilter } from "nostr-tools/filter";
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";
import { WebSocketServer } from "ws";

const tag = (event, name) => event.tags.find((t) => t[0] === name)?.[1];

// Replaceable events need strictly increasing timestamps to replace each other.
// They stay in the past, as on a real relay, so a `since: now` filter never
// replays them by accident.
let lastTime = Math.floor(Date.now() / 1000) - 100_000;
function nextTime() {
  lastTime += 1;
  return lastTime;
}

export async function startFakeRelay({
  filterOnRelay = true,
  publishKey = true,
  requireAuth = true,
  authAfterEvent = false,
} = {}) {
  const relaySecret = generateSecretKey();
  const relayPubkey = getPublicKey(relaySecret);
  const presence = new Map();
  const http = createServer((req, res) => {
    if (req.method === "POST" && req.url === "/query") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => queryHttp(req, res, Buffer.concat(chunks)));
      return;
    }
    if (!String(req.headers.accept ?? "").includes("application/nostr+json")) {
      res.writeHead(404).end();
      return;
    }
    // The NIP-11 document: answered, answered with an error, or held until releaseNip11().
    const answer = () => {
      if (hooks.nip11 === "fail") {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { "content-type": "application/nostr+json" });
      res.end(JSON.stringify({ name: "fake relay", ...(publishKey ? { self: relayPubkey } : {}) }));
    };
    if (hooks.holdNip11) held.push(answer);
    else answer();
  });
  const held = [];
  // The handshake: "accept", "reject" (an HTTP 503 instead of the upgrade, as
  // a restarting relay or its proxy answers) or "hang" (never answered).
  let handshake = "accept";
  const sockets = new Set();
  http.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const verifyClient = (info, done) => {
    stats.handshakes += 1;
    if (handshake === "reject") {
      stats.rejected += 1;
      done(false, 503, "Service Unavailable");
    } else if (handshake === "hang") {
      stats.hung += 1;
    } else {
      done(true);
    }
  };
  // POST /query: only the presence snapshot, after the NIP-98 proof's checks.
  const queryHttp = (req, res, body) => {
    stats.httpQueries.push({ headers: req.headers, body: body.toString("utf8") });
    let proof;
    try {
      const auth = String(req.headers.authorization ?? "");
      proof = JSON.parse(Buffer.from(auth.replace(/^Nostr /, ""), "base64").toString("utf8"));
    } catch {
      proof = null;
    }
    const want = (name) => proof?.tags?.find((t) => t[0] === name)?.[1];
    const fresh = proof && Math.abs(proof.created_at - Date.now() / 1000) < 60;
    const valid =
      proof && proof.kind === 27235 && verifyEvent(proof) && fresh && want("u") === `${httpBase}/query` && want("method") === "POST" &&
      want("payload") === createHash("sha256").update(body).digest("hex");
    if (!valid) {
      res.writeHead(401).end(JSON.stringify({ error: "bad proof" }));
      return;
    }
    if (hooks.presenceHttp === "fail") {
      res.writeHead(500).end();
      return;
    }
    const filters = JSON.parse(body.toString("utf8"));
    const authors = filters[0]?.kinds?.[0] === 20001 ? (filters[0].authors ?? []) : [];
    const signer = hooks.presenceHttp === "forged" ? generateSecretKey() : relaySecret;
    const now = Math.floor(Date.now() / 1000);
    const events = authors
      .filter((a) => presence.has(a))
      .map((a) => finalizeEvent({ kind: 20001, created_at: now, content: presence.get(a), tags: [["p", a]] }, signer));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(events));
  };
  const wss = new WebSocketServer({ server: http, verifyClient });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const url = `ws://127.0.0.1:${http.address().port}`;
  const httpBase = `http://127.0.0.1:${http.address().port}`;
  const stored = [];
  const conns = new Set();
  const stats = { connections: 0, auths: 0, reqs: [], handshakes: 0, rejected: 0, hung: 0, events: [], authTags: [], httpQueries: [] };
  let refuse = false;
  // refuseEvents: a reason to refuse every client EVENT with; silentEvents:
  // never answer one; refuseAuth: refuse every login.
  const hooks = {
    extraBeforeEose: () => [],
    failRoomQueries: false,
    failThreadQueries: false,
    refuseEvents: "",
    silentEvents: false,
    refuseAuth: false,
    requireAuthTag: false,
    ignoreDeletions: false,
    scopedReads: false,
    refuseDeletions: false,
    holdNip11: false, // the NIP-11 document is not answered until releaseNip11()
    nip11: "ok", // or "fail": an HTTP 500
    presenceHttp: "ok", // or "fail" (an HTTP 500), or "forged" (signed by another key)
  };

  const send = (conn, message) => {
    if (!conn.deaf && conn.socket.readyState === 1) conn.socket.send(JSON.stringify(message));
  };
  const matches = (filters, event) => !filterOnRelay || filters.some((f) => matchFilter(f, event));

  wss.on("connection", (socket) => {
    stats.connections += 1;
    if (refuse) {
      socket.terminate();
      return;
    }
    const conn = { socket, authed: null, subs: new Map(), deaf: false, challenge: randomBytes(8).toString("hex") };
    conns.add(conn);
    socket.on("close", () => {
      conns.delete(conn);
      // Like Buzz: the key's last connection closing clears its presence.
      if (conn.authed && ![...conns].some((c) => c.authed === conn.authed)) presence.delete(conn.authed);
    });
    if (requireAuth && !authAfterEvent) send(conn, ["AUTH", conn.challenge]);
    socket.on("message", (raw) => {
      if (conn.deaf) return;
      const message = JSON.parse(String(raw));
      if (message[0] === "AUTH") {
        const event = message[1];
        const ok =
          !hooks.refuseAuth &&
          event.kind === 22242 &&
          verifyEvent(event) &&
          tag(event, "challenge") === conn.challenge &&
          tag(event, "relay") === url;
        const authTags = (event.tags ?? []).filter((t) => t[0] === "auth");
        stats.authTags.push(authTags);
        const admitted = ok && (!hooks.requireAuthTag || authTags.length === 1);
        if (admitted) {
          conn.authed = event.pubkey;
          stats.auths += 1;
        }
        const reason = !ok ? "auth-required: bad auth event" : admitted ? "" : "restricted: not a relay member";
        send(conn, ["OK", event.id, admitted, reason]);
      } else if (message[0] === "REQ") {
        const [, subId, ...filters] = message;
        if (requireAuth && !conn.authed) {
          send(conn, ["CLOSED", subId, "auth-required: not authenticated"]);
          if (authAfterEvent && !conn.challenged) {
            conn.challenged = true;
            send(conn, ["AUTH", conn.challenge]);
          }
          return;
        }
        if (hooks.failRoomQueries && filters.some((f) => f.kinds?.includes(39002) || f.kinds?.includes(39000))) {
          send(conn, ["CLOSED", subId, "error: room query failed (test)"]);
          return;
        }
        // A relay that serves channel content (reactions, messages) only to a
        // read scoped to channels (#h in the filter).
        if (hooks.scopedReads && filters.some((f) => (f.kinds ?? []).some((k) => k === 7 || k === 9) && !Array.isArray(f["#h"]))) {
          send(conn, ["CLOSED", subId, "restricted: scope the read to a channel (test)"]);
          return;
        }
        if (hooks.failThreadQueries && filters.some((f) => f["#e"])) {
          send(conn, ["CLOSED", subId, "error: thread query failed (test)"]);
          return;
        }
        stats.reqs.push({ subId, filters });
        conn.subs.set(subId, filters);
        const limit = Math.min(...filters.map((f) => f.limit ?? Infinity));
        const hits = stored
          .filter((e) => matches(filters, e))
          .sort((a, b) => b.created_at - a.created_at)
          .slice(0, limit);
        for (const event of hits) send(conn, ["EVENT", subId, event]);
        for (const frame of hooks.extraBeforeEose(subId)) conn.socket.send(frame);
        send(conn, ["EOSE", subId]);
      } else if (message[0] === "CLOSE") {
        conn.subs.delete(message[1]);
      } else if (message[0] === "EVENT") {
        const event = message[1];
        const id = typeof event?.id === "string" ? event.id : "";
        if (requireAuth && !conn.authed) {
          send(conn, ["OK", id, false, "auth-required: not authenticated"]);
          if (authAfterEvent && !conn.challenged) {
            conn.challenged = true;
            send(conn, ["AUTH", conn.challenge]);
          }
        } else if (hooks.silentEvents) {
          // never answered
        } else if (hooks.refuseEvents) {
          send(conn, ["OK", id, false, hooks.refuseEvents]);
        } else if (hooks.refuseDeletions && event?.kind === 5) {
          send(conn, ["OK", id, false, "blocked: deletions refused (test)"]);
        } else if (!verifyEvent(event)) {
          send(conn, ["OK", id, false, "invalid: bad signature"]);
        } else {
          stats.events.push(event);
          if (event.kind === 20001) {
            if (event.content === "offline") presence.delete(event.pubkey);
            else presence.set(event.pubkey, event.content.slice(0, 128));
            send(conn, ["OK", id, true, ""]);
            return;
          }
          if (event.kind === 5 && !hooks.ignoreDeletions) {
            const gone = new Set(event.tags.filter((t) => t[0] === "e").map((t) => t[1]));
            for (let i = stored.length - 1; i >= 0; i--) {
              if (gone.has(stored[i].id) && stored[i].pubkey === event.pubkey) stored.splice(i, 1);
            }
          }
          stored.push(event);
          send(conn, ["OK", id, true, ""]);
        }
      }
    });
  });

  return {
    url,
    stats,
    hooks,
    /** Sends a raw text frame, well-formed or not, to every logged-in connection. */
    inject(frame) {
      for (const conn of conns) if (conn.authed && !conn.deaf) conn.socket.send(frame);
    },
    relayPubkey,
    httpBase,
    /** The presence the relay holds now: pubkey -> status. */
    presence: () => new Map(presence),
    /** The stored events, as a query would find them. */
    stored: () => [...stored],
    /** Stores an event and pushes it to every live matching subscription. */
    publish(event) {
      if (event.kind >= 30000 && event.kind < 40000) {
        const d = tag(event, "d");
        for (let i = stored.length - 1; i >= 0; i--) {
          const old = stored[i];
          if (old.kind === event.kind && old.pubkey === event.pubkey && tag(old, "d") === d) stored.splice(i, 1);
        }
      }
      stored.push(event);
      // Like Buzz, channel-scoped group state (39000-39003) goes live only to
      // subscriptions scoped to channels, that is, with `#h` in every filter.
      const channelScoped = event.kind >= 39000 && event.kind <= 39003;
      for (const conn of conns) {
        if (!conn.authed) continue;
        for (const [subId, filters] of conn.subs) {
          if (channelScoped && !filters.every((f) => Array.isArray(f["#h"]))) continue;
          if (matches(filters, event)) send(conn, ["EVENT", subId, event]);
        }
      }
    },
    dropAll() {
      for (const conn of conns) conn.socket.terminate();
    },
    setRefuse(value) {
      refuse = value;
    },
    /** How the WebSocket handshake is answered from now on: "accept", "reject" or "hang". */
    setHandshake(mode) {
      handshake = mode;
    },
    /** The current connections stay open but never answer again. */
    deafenAll() {
      for (const conn of conns) conn.deaf = true;
    },
    liveConnections() {
      return [...conns].filter((c) => !c.deaf && c.authed).length;
    },
    /** Answers the NIP-11 requests held by hooks.holdNip11, and holds no more. */
    releaseNip11() {
      hooks.holdNip11 = false;
      for (const answer of held.splice(0)) answer();
    },
    /** Signs an event template with this relay's key. */
    sign(template) {
      return finalizeEvent(template, relaySecret);
    },
    /** A message as the relay posts it for a workflow (see workflowMessage), signed by this relay. */
    workflowMessage(options) {
      return workflowMessage(relaySecret, options);
    },
    /** Publishes a channel's member roster (kind 39002), signed by the relay unless `signer` is given. */
    roster(channel, members, { signer = relaySecret } = {}) {
      const tags = [["d", channel], ...members.map((m) => ["p", m, "member"])];
      this.publish(finalizeEvent({ kind: 39002, created_at: nextTime(), content: "", tags }, signer));
    },
    /** Publishes a channel's metadata (kind 39000), signed by the relay unless `signer` is given. */
    metadata(channel, { type = "stream", members = [], archived = false, visibility, signer = relaySecret } = {}) {
      const tags = [
        ["d", channel],
        ["name", "test room"],
        ["t", type],
        ...(visibility ? [[visibility]] : []),
        ...(archived ? [["archived"]] : []),
        ...members.map((m) => ["p", m]),
      ];
      this.publish(finalizeEvent({ kind: 39000, created_at: nextTime(), content: "", tags }, signer));
    },
    /** The relay's notice that `member` was added to (44100) or removed from (44101) `channel`. */
    notify(kind, channel, member) {
      const tags = [["p", member], ["h", channel]];
      this.publish(finalizeEvent({ kind, created_at: Math.floor(Date.now() / 1000), content: "{}", tags }, relaySecret));
    },
    /** The channel ids the newest main subscription listens in, and the DM-only filter's ids. */
    latestSubscription() {
      const req = [...stats.reqs].reverse().find((r) => r.subId.startsWith("buzz-channel-sub-"));
      if (!req) return null;
      return {
        subId: req.subId,
        mentions: [...(req.filters[0]?.["#h"] ?? [])].sort(),
        direct: [...(req.filters[1]?.["#h"] ?? [])].sort(),
      };
    },
    async close() {
      for (const conn of conns) conn.socket.terminate();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => http.close(resolve));
    },
  };
}

/** A signed kind-9 channel message. */
export function message(secret, { channel, mention, content = "hello", createdAt, tags = [] }) {
  const t = [["h", channel], ...(mention ? [["p", mention]] : []), ...tags];
  return finalizeEvent(
    { kind: 9, created_at: createdAt ?? Math.floor(Date.now() / 1000), content, tags: t },
    secret,
  );
}

/**
 * A kind-9 message as the relay posts it for a workflow's send_message step,
 * signed by `secret` (the relay's, for a real one): the owner's `p` tag first
 * (marked `owner`, so it is no mention), the workflow and owner stamps, a
 * plain `p` tag for each of `mentions` and a `buzz:workflow-mention` stamp for
 * each of `stamped`, by default the mentions: the targets named in the
 * owner's own step text.
 */
export function workflowMessage(secret, { channel, owner, mentions = [], stamped = mentions, content = "from a workflow", createdAt, tags = [] }) {
  const t = [
    ["p", owner, "", "owner"],
    ["h", channel],
    ["buzz:workflow", "true"],
    ["buzz:workflow-owner", owner],
    ...mentions.map((m) => ["p", m]),
    ...stamped.map((m) => ["buzz:workflow-mention", m]),
    ...tags,
  ];
  return finalizeEvent({ kind: 9, created_at: createdAt ?? Math.floor(Date.now() / 1000), content, tags: t }, secret);
}
