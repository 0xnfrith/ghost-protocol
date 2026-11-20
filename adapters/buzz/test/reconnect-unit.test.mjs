// Every way a connection can die, one at a time, against a scripted socket.
// Each test isolates one guard: without it, that test's listener would never
// connect again. The sockets behave the way Node's WebSocket does: a failed
// handshake fires `error` only and stays CONNECTING, close() fires nothing
// once the handlers are cleared, and a closing socket may never fire `close`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayListener } from "../src/relay.mjs";
import { identity, waitFor } from "./helpers.mjs";

const CHAN = "11111111-1111-4111-8111-111111111111";
const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;

/** A WebSocket stand-in whose every move the test makes. */
function scriptedSockets({ answerReqs = true, answerAuth = true } = {}) {
  const sockets = [];
  class Socket {
    constructor(url) {
      this.url = url;
      this.readyState = CONNECTING;
      this.sent = [];
      this.closedByClient = false;
      sockets.push(this);
    }

    send(data) {
      const message = JSON.parse(data);
      this.sent.push(message);
      const [type, a] = message;
      if (type === "AUTH" && answerAuth) queueMicrotask(() => this.frame(["OK", a.id, true, ""]));
      // A relay that never accepts the login still answers every REQ: CLOSED.
      if (type === "REQ" && !answerAuth) queueMicrotask(() => this.frame(["CLOSED", a, "auth-required: not authenticated"]));
      else if (type === "REQ" && answerReqs) queueMicrotask(() => this.frame(["EOSE", a]));
    }

    close() {
      this.closedByClient = true;
      if (this.readyState !== 3) this.readyState = CLOSING;
    }

    // What the relay or the network does.
    open() {
      this.readyState = OPEN;
      this.onopen?.();
      this.frame(["AUTH", "challenge"]);
    }

    fail() {
      this.onerror?.({ type: "error" });
    }

    frame(message) {
      if (this.readyState === OPEN) this.onmessage?.({ data: JSON.stringify(message) });
    }
  }
  return { Socket, sockets };
}

function listen(Socket, overrides = {}) {
  const agent = identity();
  const lines = [];
  const now = Math.floor(Date.now() / 1000);
  const listener = new RelayListener({
    relayUrl: "ws://relay.example.com",
    secret: agent.secret,
    channels: [CHAN],
    watchPubkey: agent.pubkey,
    ownPubkey: agent.pubkey,
    state: { since: () => now, has: () => false, record() {} },
    format: () => ({}),
    deliver: async () => {},
    onDeliveryError: () => {},
    log: (line) => lines.push(line),
    catchupMaxAge: 3600,
    backoffMs: 10,
    backoffMaxMs: 40,
    heartbeatMs: 50,
    connectTimeoutMs: 150,
    liveTimeoutMs: 300,
    random: () => 0.5, // no jitter
    WebSocketImpl: Socket,
    ...overrides,
  });
  listener.start();
  return { listener, lines };
}

const subscribed = (socket) => socket.sent.some(([type, id]) => type === "REQ" && id.startsWith("buzz-channel-sub-"));

test("a handshake that fails with an error event only is retried", async (t) => {
  const { Socket, sockets } = scriptedSockets();
  const { listener, lines } = listen(Socket, { connectTimeoutMs: 10_000 }); // only the error event can help
  t.after(() => listener.stop());
  sockets[0].fail(); // a 503 from the relay's proxy, a refused connection, a DNS failure
  await waitFor(() => sockets.length >= 2, { what: "a second attempt after the failed handshake" });
  assert.ok(sockets[0].closedByClient, "the failed socket is let go");
  assert.ok(lines.includes("could not connect to the relay"));
  sockets[1].open();
  await waitFor(() => subscribed(sockets[1]), { what: "the subscription on the new connection" });
});

test("a connection that never opens is given up after the connect timeout", async (t) => {
  const { Socket, sockets } = scriptedSockets();
  const { listener, lines } = listen(Socket);
  t.after(() => listener.stop());
  // sockets[0] neither opens nor fails.
  await waitFor(() => sockets.length >= 2, { what: "a second attempt after the connect timeout" });
  assert.ok(sockets[0].closedByClient);
  assert.ok(lines.includes("the connection did not open within 150 ms"));
});

test("an open connection left closing without a close event is replaced", async (t) => {
  const { Socket, sockets } = scriptedSockets();
  const { listener, lines } = listen(Socket);
  t.after(() => listener.stop());
  sockets[0].open();
  await waitFor(() => subscribed(sockets[0]), { what: "the first subscription" });
  // The peer sent a close frame but never closes the TCP connection.
  sockets[0].readyState = CLOSING;
  await waitFor(() => sockets.length >= 2, { what: "a new connection" });
  assert.ok(lines.includes("the connection is no longer open"));
});

test("an open connection whose login never completes is replaced", async (t) => {
  // The relay answers the probe (so the heartbeat is satisfied) but never accepts AUTH.
  const { Socket, sockets } = scriptedSockets({ answerAuth: false });
  const { listener, lines } = listen(Socket);
  t.after(() => listener.stop());
  sockets[0].open();
  await waitFor(() => sockets.length >= 2, { what: "a new connection after the stalled login" });
  assert.ok(lines.includes("login and catch-up did not finish within 300 ms"));
  assert.ok(!lines.some((l) => l.startsWith("relay stopped answering")), "the heartbeat alone was satisfied");
});

test("an open connection that stops answering is replaced", async (t) => {
  const { Socket, sockets } = scriptedSockets();
  const { listener, lines } = listen(Socket);
  t.after(() => listener.stop());
  sockets[0].open();
  await waitFor(() => subscribed(sockets[0]), { what: "the first subscription" });
  sockets[0].frame = () => {}; // silent from now on, still OPEN
  await waitFor(() => sockets.length >= 2, { what: "a new connection" });
  assert.ok(lines.some((l) => l.startsWith("relay stopped answering")));
});

test("with no connection and no reconnect pending, the watchdog reconnects", async (t) => {
  const { Socket, sockets } = scriptedSockets();
  const { listener, lines } = listen(Socket);
  t.after(() => listener.stop());
  // The connection in use comes from a reconnect timer that has already
  // fired, so a timer left behind cannot pass for a pending reconnect.
  sockets[0].fail();
  await waitFor(() => sockets.length >= 2, { what: "the reconnect" });
  sockets[1].open();
  await waitFor(() => subscribed(sockets[1]), { what: "the subscription" });
  // A path that lets the socket go and forgets to schedule the next one.
  listener.abandonSocket();
  await waitFor(() => sockets.length >= 3, { what: "the watchdog's reconnect" });
  assert.ok(lines.includes("no connection and no reconnect pending"));
});

test("the reconnect delay doubles up to the cap and starts over after a catch-up", async (t) => {
  const { Socket, sockets } = scriptedSockets();
  const { listener, lines } = listen(Socket, { connectTimeoutMs: 10_000 });
  t.after(() => listener.stop());
  for (let n = 1; n <= 5; n++) {
    sockets[n - 1].fail();
    await waitFor(() => sockets.length > n, { what: `attempt ${n + 1}` });
  }
  const delays = () => lines.filter((l) => l.startsWith("reconnecting in ")).map((l) => Number(l.split(" ")[2]));
  assert.deepEqual(delays(), [10, 20, 40, 40, 40]);
  sockets[5].open();
  await waitFor(() => lines.some((l) => l.startsWith("caught up:")), { what: "the catch-up" });
  sockets[5].fail();
  await waitFor(() => sockets.length >= 7, { what: "the reconnect after a healthy connection" });
  assert.equal(delays().at(-1), 10);
});

test("stop() leaves nothing running", async () => {
  const { Socket, sockets } = scriptedSockets();
  const { listener } = listen(Socket);
  sockets[0].fail();
  listener.stop();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sockets.length, 1);
});
