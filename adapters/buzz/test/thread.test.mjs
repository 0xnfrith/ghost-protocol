// The one-shot thread read (`node launch.mjs thread`, src/thread.mjs) against
// the fake relay: which replies it prints (only correctly signed ones, in
// this channel, in one of the asked threads, by --author when given), the
// login, every way it can fail, and that the key never reaches its output.
// The fake relay's publish() stores an event without checking its signature,
// so a forged event (the owner's key in "pubkey", someone else's signature)
// reaches the reader, as a misbehaving relay could hand it one.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { finalizeEvent } from "nostr-tools/pure";
import { message, startFakeRelay } from "./fake-relay.mjs";
import { identity, LAUNCH } from "./helpers.mjs";

const CHANNEL = "0000aaaa-1111-2222-3333-444455556666";
const OTHER_CHANNEL = "0000bbbb-1111-2222-3333-444455556666";
const relays = [];
after(async () => {
  for (const r of relays) await r.close?.();
});

async function relay(options) {
  const r = await startFakeRelay(options);
  relays.push(r);
  return r;
}

/** Runs the launcher's thread read, the way the auto-mode guard does. */
function read({ relayUrl, key, args, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCH, "thread", ...args], {
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        BUZZ_RELAY_URL: relayUrl,
        BUZZ_KEY_COMMAND: `printf %s ${key.hex}`,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr, lines: lines(stdout) }));
  });
}

function lines(stdout) {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function keyNeverShown(result, key) {
  for (const s of [result.stdout, result.stderr]) {
    assert.ok(!s.includes(key.hex), "the hex key is never printed");
    assert.ok(!s.includes(key.nsec), "the nsec key is never printed");
  }
}

const now = () => Math.floor(Date.now() / 1000);
const replyTo = (root) => [["e", root, "", "reply"]];

/** A world: an alert root by the agent, and replies around it. */
function world(r) {
  const agent = identity();
  const owner = identity();
  const stranger = identity();
  const t = now() - 100;
  const root = message(agent.secret, { channel: CHANNEL, content: "I found 2 rules you didn't make.", createdAt: t });
  const otherRoot = message(agent.secret, { channel: CHANNEL, content: "another alert", createdAt: t });
  r.publish(root);
  r.publish(otherRoot);
  const ev = {
    ownerShow: message(owner.secret, { channel: CHANNEL, content: "Show me them", createdAt: t + 1, tags: replyTo(root.id) }),
    ownerKeep: message(owner.secret, { channel: CHANNEL, content: "Keep them", createdAt: t + 2, tags: replyTo(root.id) }),
    strangerRemove: message(stranger.secret, {
      channel: CHANNEL,
      content: "Remove them",
      createdAt: t + 3,
      tags: replyTo(root.id),
    }),
    agentReply: message(agent.secret, { channel: CHANNEL, content: "Here they are.", createdAt: t + 4, tags: replyTo(root.id) }),
    ownerElsewhere: message(owner.secret, {
      channel: OTHER_CHANNEL,
      content: "Remove them",
      createdAt: t + 5,
      tags: replyTo(root.id),
    }),
    ownerOtherThread: message(owner.secret, {
      channel: CHANNEL,
      content: "Remove them",
      createdAt: t + 6,
      tags: replyTo(otherRoot.id),
    }),
    ownerTopLevel: message(owner.secret, {
      channel: CHANNEL,
      content: "Remove them",
      createdAt: t + 7,
      tags: [["e", root.id, "", "root"]],
    }),
    ownerTwoChannels: finalizeEvent(
      {
        kind: 9,
        created_at: t + 8,
        content: "Remove them",
        tags: [["h", CHANNEL], ["h", OTHER_CHANNEL], ...replyTo(root.id)],
      },
      owner.secret,
    ),
    ownerWrongKind: finalizeEvent(
      { kind: 1, created_at: t + 9, content: "Remove them", tags: [["h", CHANNEL], ...replyTo(root.id)] },
      owner.secret,
    ),
  };
  // A forgery: the owner's key in "pubkey", signed by the stranger.
  const signedByStranger = message(stranger.secret, {
    channel: CHANNEL,
    content: "Remove them",
    createdAt: t + 10,
    tags: replyTo(root.id),
  });
  ev.forgedOwner = { ...signedByStranger, pubkey: owner.pubkey };
  // The owner's real message with its text changed after signing.
  ev.tamperedOwner = { ...ev.ownerKeep, id: ev.ownerKeep.id, content: "Remove them" };
  for (const e of Object.values(ev)) r.publish(e);
  return { agent, owner, stranger, root, otherRoot, ev };
}

test("--author: only the owner's correctly signed replies in that thread, oldest first, with their root", async () => {
  const r = await relay();
  const w = world(r);
  const result = await read({
    relayUrl: r.url,
    key: w.agent,
    args: ["--channel", CHANNEL, "--root", w.root.id, "--author", w.owner.pubkey],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.lines.map((l) => l.id),
    [w.ev.ownerShow.id, w.ev.ownerKeep.id],
    "not the forgery, another thread, another channel, a root, two channels or another kind",
  );
  assert.deepEqual(result.lines[0], {
    id: w.ev.ownerShow.id,
    pubkey: w.owner.pubkey,
    created_at: w.ev.ownerShow.created_at,
    root: w.root.id,
    content: "Show me them",
  });
  const req = r.stats.reqs.at(-1);
  assert.deepEqual(req.filters[0].authors, [w.owner.pubkey], "the request asks for that author");
  assert.deepEqual(req.filters[0]["#e"], [w.root.id]);
  assert.deepEqual(req.filters[0]["#h"], [CHANNEL]);
  keyNeverShown(result, w.agent);
});

test("--author checked here too: a relay that ignores the filter still gets only the owner's replies printed", async () => {
  const r = await relay({ filterOnRelay: false });
  const w = world(r);
  const result = await read({
    relayUrl: r.url,
    key: w.agent,
    args: ["--channel", CHANNEL, "--root", w.root.id, "--author", w.owner.pubkey],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.lines.map((l) => l.id),
    [w.ev.ownerShow.id, w.ev.ownerKeep.id],
  );
});

test("a forged signature is dropped even when the relay hands it over unfiltered", async () => {
  const r = await relay({ filterOnRelay: false });
  const w = world(r);
  const result = await read({ relayUrl: r.url, key: w.agent, args: ["--channel", CHANNEL, "--root", w.root.id] });
  assert.equal(result.status, 0, result.stderr);
  const ids = result.lines.map((l) => l.id);
  assert.ok(!ids.includes(w.ev.forgedOwner.id), "the forgery (owner's key, stranger's signature) is never printed");
  assert.ok(
    !result.lines.some((l) => l.pubkey === w.owner.pubkey && l.content === "Remove them"),
    "nothing says the owner wrote Remove them",
  );
});

test("without --author: every correctly signed reply in the thread, with its real author, so the caller must check it", async () => {
  const r = await relay();
  const w = world(r);
  const result = await read({ relayUrl: r.url, key: w.agent, args: ["--channel", CHANNEL, "--root", w.root.id] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    result.lines.map((l) => [l.id, l.pubkey]),
    [
      [w.ev.ownerShow.id, w.owner.pubkey],
      [w.ev.ownerKeep.id, w.owner.pubkey],
      [w.ev.strangerRemove.id, w.stranger.pubkey],
      [w.ev.agentReply.id, w.agent.pubkey],
    ],
  );
});

test("several roots, and --since", async () => {
  const r = await relay();
  const w = world(r);
  const both = await read({
    relayUrl: r.url,
    key: w.agent,
    args: ["--channel", CHANNEL, "--root", w.root.id, "--root", w.otherRoot.id, "--author", w.owner.pubkey],
  });
  assert.equal(both.status, 0, both.stderr);
  assert.deepEqual(
    both.lines.map((l) => [l.id, l.root]),
    [
      [w.ev.ownerShow.id, w.root.id],
      [w.ev.ownerKeep.id, w.root.id],
      [w.ev.ownerOtherThread.id, w.otherRoot.id],
    ],
  );
  const since = await read({
    relayUrl: r.url,
    key: w.agent,
    args: ["--channel", CHANNEL, "--root", w.root.id, "--author", w.owner.pubkey, "--since", String(w.ev.ownerKeep.created_at)],
  });
  assert.deepEqual(
    since.lines.map((l) => l.id),
    [w.ev.ownerKeep.id],
  );
});

test("a thread with no replies: exit 0, nothing printed", async () => {
  const r = await relay();
  const agent = identity();
  const result = await read({ relayUrl: r.url, key: agent, args: ["--channel", CHANNEL, "--root", "d".repeat(64)] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});

test("long content is cut to 1000 characters", async () => {
  const r = await relay();
  const w = world(r);
  r.publish(
    message(w.owner.secret, { channel: CHANNEL, content: "x".repeat(5000), createdAt: now() - 1, tags: replyTo(w.root.id) }),
  );
  const result = await read({
    relayUrl: r.url,
    key: w.agent,
    args: ["--channel", CHANNEL, "--root", w.root.id, "--author", w.owner.pubkey],
  });
  assert.equal(result.lines.at(-1).content.length, 1000);
});

test("login: a relay that asks for none, and one that refuses it", async () => {
  const open = await relay({ requireAuth: false });
  const w = world(open);
  const result = await read({ relayUrl: open.url, key: w.agent, args: ["--channel", CHANNEL, "--root", w.root.id] });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(open.stats.auths, 0);
  assert.equal(result.lines.length, 4);

  const shut = await relay();
  shut.hooks.refuseAuth = true;
  const agent = identity();
  const refused = await read({ relayUrl: shut.url, key: agent, args: ["--channel", CHANNEL, "--root", "d".repeat(64)] });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the relay refused the login/);
  assert.equal(refused.stdout, "");
  keyNeverShown(refused, agent);
});

test("a relay that sends its challenge only after refusing the request: logs in, then asks once more", async () => {
  const r = await relay({ authAfterEvent: true });
  const w = world(r);
  const result = await read({
    relayUrl: r.url,
    key: w.agent,
    args: ["--channel", CHANNEL, "--root", w.root.id, "--author", w.owner.pubkey],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(r.stats.auths, 1);
  assert.deepEqual(
    result.lines.map((l) => l.id),
    [w.ev.ownerShow.id, w.ev.ownerKeep.id],
  );
});

test("BUZZ_AUTH_TAG: the login carries that one tag", async () => {
  const r = await relay();
  r.hooks.requireAuthTag = true;
  const agent = identity();
  const owner = identity();
  const tag = ["auth", owner.pubkey, "created_at<4294967295", "c".repeat(128)];
  const result = await read({
    relayUrl: r.url,
    key: agent,
    args: ["--channel", CHANNEL, "--root", "d".repeat(64)],
    env: { BUZZ_AUTH_TAG: JSON.stringify(tag) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(r.stats.authTags, [[tag]]);
});

test("the relay refuses the request, never answers, or is not there: exit 1, nothing printed", async () => {
  const failing = await relay();
  failing.hooks.failThreadQueries = true;
  const agent = identity();
  const refused = await read({ relayUrl: failing.url, key: agent, args: ["--channel", CHANNEL, "--root", "d".repeat(64)] });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /the relay refused the request: error: thread query failed/);
  assert.equal(refused.stdout, "");

  const silent = await relay();
  silent.deafenAll();
  silent.setHandshake("hang");
  const timedOut = await read({
    relayUrl: silent.url,
    key: agent,
    args: ["--channel", CHANNEL, "--root", "d".repeat(64)],
    env: { BUZZ_SEND_TIMEOUT_MS: "800" },
  });
  assert.equal(timedOut.status, 1);
  assert.match(timedOut.stderr, /no answer from the relay within 800 ms/);

  const gone = await relay();
  const url = gone.url;
  await gone.close();
  const unreachable = await read({ relayUrl: url, key: agent, args: ["--channel", CHANNEL, "--root", "d".repeat(64)] });
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stderr, /could not reach the relay|closed the connection/);
});

test("usage errors exit 2 before connecting", async () => {
  const r = await relay();
  const agent = identity();
  const root = "d".repeat(64);
  const cases = [
    [[], /--channel must be a channel id/],
    [["--channel", CHANNEL], /at least one --root is needed/],
    [["--channel", CHANNEL, "--root", "abc"], /--root must be an event id/],
    [["--channel", CHANNEL, "--root", "D".repeat(64)], /--root must be an event id/],
    [["--channel", "has spaces", "--root", root], /--channel must be a channel id/],
    [["--channel", CHANNEL, "--root", root, "--author", "abc"], /--author must be 64 hex characters or an npub1 key/],
    [["--channel", CHANNEL, "--root", root, "--since", "-1"], /--since must be a unix time/],
    [["--channel", CHANNEL, "--root", root, "--extra", "x"], /usage: thread/],
    [["--channel", CHANNEL, "--root"], /--root needs a value/],
    [["--channel", CHANNEL, "--channel", CHANNEL, "--root", root], /usage: thread/],
    [["--channel", CHANNEL, ...Array.from({ length: 21 }, (_, i) => ["--root", String(i).padStart(64, "0")]).flat()], /at most 20/],
  ];
  for (const [args, want] of cases) {
    const result = await read({ relayUrl: r.url, key: agent, args });
    assert.equal(result.status, 2, `${want}: ${result.stderr}`);
    assert.match(result.stderr, want);
    keyNeverShown(result, agent);
  }
  assert.equal(r.stats.connections, 0, "it never connected");
});

test("--author may not be the reading key itself: exit 2 before connecting", async () => {
  const r = await relay();
  const agent = identity();
  for (const author of [agent.pubkey, agent.npub]) {
    const result = await read({ relayUrl: r.url, key: agent, args: ["--channel", CHANNEL, "--root", "d".repeat(64), "--author", author] });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--author is this key's own/);
    keyNeverShown(result, agent);
  }
  assert.equal(r.stats.connections, 0);
});

test("the key service never runs it, and a socket session refuses it", async () => {
  const agent = identity();
  const run = (args, env) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [LAUNCH, ...args], {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (status) => resolve({ status, stderr }));
    });
  const served = await run(["serve", "thread", "--channel", CHANNEL], {});
  assert.equal(served.status, 2);
  assert.match(served.stderr, /usage: launch.mjs serve channel\|buzz-mcp\|send/);
  const piped = await run(["thread", "--channel", CHANNEL], { BUZZ_KEY_SOCKET: "/nonexistent" });
  assert.equal(piped.status, 2);
  assert.match(piped.stderr, /the one-shot thread read has no socket/);
  for (const s of [served.stderr, piped.stderr]) assert.ok(!s.includes(agent.hex));
});
