// The channel's optional lock (BUZZ_CHANNEL_LOCK=on): one listener per
// cursor. A second channel waits briefly for the first to stop, then refuses;
// a lock whose holder was killed goes stale and is taken over; off (the
// default), nothing changes: no lock file, and two channels may share a
// cursor as before.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { acquireLock } from "../src/lock.mjs";
import { message, startFakeRelay } from "./fake-relay.mjs";
import { closeAll, identity, keyAbsent, LAUNCH, startChannel, tempDir, waitFor } from "./helpers.mjs";

const agent = identity();
const sender = identity();
let relay;
const outputs = [];
before(async () => {
  relay = await startFakeRelay();
});
after(async () => {
  await closeAll();
  await relay.close();
  assert.ok(keyAbsent(agent, outputs), "the private key leaked into output");
});

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the lock itself

test("a second taker waits, then gets nothing while the first holds the lock; after release it gets it", async () => {
  const file = join(tempDir("lock"), "cursor.json.lock");
  const release = await acquireLock(file, { waitMs: 300 });
  assert.equal(typeof release, "function");
  const started = Date.now();
  assert.equal(await acquireLock(file, { waitMs: 300 }), null);
  assert.ok(Date.now() - started >= 250, "it waited before giving up");
  release();
  const again = await acquireLock(file, { waitMs: 300 });
  assert.equal(typeof again, "function");
  again();
});

test("a live holder keeps its lock fresh, so it is never taken as stale", async () => {
  const file = join(tempDir("lock-fresh"), "cursor.json.lock");
  const release = await acquireLock(file);
  // Stale after 1.5 s here; the holder touches it every second.
  assert.equal(await acquireLock(file, { waitMs: 3000, staleMs: 1500 }), null);
  release();
});

test("a lock nobody has touched for a while is taken over", async () => {
  const file = join(tempDir("lock-stale"), "cursor.json.lock");
  writeFileSync(file, "someone-else 1\n", { mode: 0o600 });
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  const lines = [];
  const release = await acquireLock(file, { waitMs: 300, log: (l) => lines.push(l) });
  assert.equal(typeof release, "function");
  assert.ok(lines.some((l) => l.startsWith("taking over a channel lock nobody has touched")));
  release();
});

test("a holder whose lock was taken over notices within a second or two", async () => {
  const file = join(tempDir("lock-lost"), "cursor.json.lock");
  let lost = 0;
  const release = await acquireLock(file, { onLost: () => (lost += 1) });
  writeFileSync(file, "another-holder 2\n");
  await waitFor(() => lost === 1, { timeout: 3000, what: "the holder to notice" });
  release(); // not its lock any more: left alone
  assert.equal(readFileSync(file, "utf8"), "another-holder 2\n");
});

// ---------------------------------------------------------------- in the channel

function setup(label, lock) {
  const dir = tempDir(label);
  const chan = randomUUID();
  return {
    chan,
    stateDir: join(dir, "state"),
    env: {
      BUZZ_CHANNELS: chan,
      BUZZ_STATE_DIR: join(dir, "state"),
      BUZZ_LOG_FILE: join(dir, "channel.log"),
      ...(lock === undefined ? {} : { BUZZ_CHANNEL_LOCK: lock }),
    },
  };
}

const lockFiles = (stateDir) => {
  try {
    return readdirSync(stateDir).filter((n) => n.endsWith(".lock"));
  } catch {
    return [];
  }
};

async function open(env) {
  const before = relay.stats.reqs.length;
  const ch = await startChannel({ relayUrl: relay.url, key: agent, env });
  await waitFor(() => relay.stats.reqs.slice(before).some((r) => r.subId.startsWith("buzz-channel-sub-")), {
    what: "the channel to subscribe",
  });
  return ch;
}

/** The channel through the launcher, without a session: to see it refuse. */
function startBare(env) {
  const child = spawn(process.execPath, [LAUNCH, "channel"], {
    env: { PATH: process.env.PATH, BUZZ_RELAY_URL: relay.url, BUZZ_KEY_COMMAND: `printf %s ${agent.hex}`, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const err = [];
  child.stderr.on("data", (c) => err.push(c));
  const exited = new Promise((resolve) => child.on("exit", resolve));
  return { child, exited, err: () => Buffer.concat(err).toString("utf8") };
}

test("off by default: no lock file, and two channels share one cursor as before", async () => {
  const s = setup("lock-off");
  const one = await open(s.env);
  const two = await open(s.env);
  assert.deepEqual(lockFiles(s.stateDir), []);
  outputs.push(one.stderr(), two.stderr());
  await one.close();
  await two.close();
});

test("BUZZ_CHANNEL_LOCK=on: a second channel on the same cursor refuses while the first listens", async () => {
  const s = setup("lock-on", "on");
  const one = await open(s.env);
  assert.equal(lockFiles(s.stateDir).length, 1);
  const two = startBare(s.env);
  assert.equal(await two.exited, 1);
  assert.match(two.err(), /another channel is listening with this cursor/);
  // The first one still delivers.
  const e = message(sender.secret, { channel: s.chan, mention: agent.pubkey, content: "still here" });
  relay.publish(e);
  await waitFor(() => one.received.some((r) => r.meta.event_id === e.id), { what: "the mention" });
  outputs.push(one.stderr(), two.err());
  await one.close();
  await waitFor(() => lockFiles(s.stateDir).length === 0, { what: "the lock to be removed on exit" });
});

test("BUZZ_CHANNEL_LOCK=on: a newcomer that is waiting gets the lock once the old channel stops", async () => {
  const s = setup("lock-handover", "on");
  const one = await open(s.env);
  const twoStarting = open(s.env);
  await pause(1000);
  await one.close();
  const two = await twoStarting;
  const e = message(sender.secret, { channel: s.chan, mention: agent.pubkey, content: "handed over" });
  relay.publish(e);
  await waitFor(() => two.received.some((r) => r.meta.event_id === e.id), { what: "the mention" });
  outputs.push(one.stderr(), two.stderr());
  await two.close();
});

test("BUZZ_CHANNEL_LOCK=on: after the holder is killed, its lock goes stale and the next channel takes over", async () => {
  const s = setup("lock-kill", "on");
  const one = await open(s.env);
  const [lockName] = lockFiles(s.stateDir);
  const holder = Number(readFileSync(join(s.stateDir, lockName), "utf8").trim().split(" ")[1]);
  assert.ok(Number.isInteger(holder) && holder > 1);
  process.kill(holder, "SIGKILL"); // the channel itself, not its launcher
  const started = Date.now();
  const two = await open(s.env);
  assert.ok(Date.now() - started >= 3000, "it waited for the lock to go stale");
  assert.match(two.stderr(), /taking over a channel lock nobody has touched/);
  outputs.push(one.stderr(), two.stderr());
  await two.close();
  await one.close();
});

test("a BUZZ_CHANNEL_LOCK that is neither on nor off stops the channel", async () => {
  const s = setup("lock-bad", "maybe");
  const ch = startBare(s.env);
  assert.equal(await ch.exited, 2);
  assert.match(ch.err(), /BUZZ_CHANNEL_LOCK must be on or off/);
  outputs.push(ch.err());
});
