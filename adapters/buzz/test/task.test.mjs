// Task roots (src/task.mjs): the settings, the moves, and the one-shot
// `node launch.mjs task` against the fake relay: the reaction it writes, that
// a new state replaces the old one, that a done root is never reopened without
// --reopen, the list of open roots, and that the key never reaches its output.
// The channel's own `task` and `task_list` tools are in task-tools.test.mjs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { ConfigError } from "../src/config.mjs";
import { listText, moveProblem, stateOf, taskForms, taskRootsOn } from "../src/task.mjs";
import { message, startFakeRelay } from "./fake-relay.mjs";
import { identity, LAUNCH } from "./helpers.mjs";

const IMAGE = "https://media.example.com/open-loop.gif";
const relays = [];
after(async () => {
  for (const r of relays) await r.close?.();
});

async function relay(options) {
  const r = await startFakeRelay(options);
  relays.push(r);
  return r;
}

/** Runs the launcher's task tool, the way the alert senders do. */
function task({ relayUrl, key, args, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCH, "task", ...args], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, BUZZ_RELAY_URL: relayUrl, BUZZ_KEY_COMMAND: `printf %s ${key.hex}`, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => {
      for (const s of [stdout, stderr]) {
        assert.ok(!s.includes(key.hex) && !s.includes(key.nsec), "the key is never printed");
      }
      resolve({ status, stdout, stderr });
    });
  });
}

const set = (r, key, chan, id, state, extra = [], env = {}) =>
  task({ relayUrl: r.url, key, args: ["set", "--channel", chan, "--id", id, "--state", state, ...extra], env });

/** A root message, stored on the relay. */
function root(r, author, chan, content = "a root") {
  const m = message(author.secret, { channel: chan, content });
  r.publish(m);
  return m;
}

/** The agent's reactions on a message, as the relay holds them now. */
const reactions = (r, key, id) =>
  r.stored().filter((e) => e.kind === 7 && e.pubkey === key.pubkey && e.tags.some((t) => t[0] === "e" && t[1] === id));

// --- the settings, the states and the moves -------------------------------------------------

test("the default reactions: ⭕ open, ✅ done, 🚨 emergency", () => {
  const f = taskForms({});
  assert.deepEqual([f.open.content, f.done.content, f.emergency.content], ["⭕", "✅", "🚨"]);
  assert.equal(f.open.url, undefined);
  for (const v of [undefined, "", "${user_config.task_roots}", "off", "OFF"]) assert.equal(taskRootsOn({ BUZZ_TASK_ROOTS: v }), false);
  assert.equal(taskRootsOn({ BUZZ_TASK_ROOTS: "on" }), true);
  assert.throws(() => taskRootsOn({ BUZZ_TASK_ROOTS: "yes" }), ConfigError);
});

test("a custom emoji: a name and its image's https URL; content :name:", () => {
  const f = taskForms({ BUZZ_TASK_OPEN_EMOJI: ":Open-Loop:", BUZZ_TASK_OPEN_EMOJI_URL: IMAGE, BUZZ_TASK_DONE_EMOJI: "🎯" });
  assert.deepEqual(f.open, { content: ":open-loop:", name: "open-loop", url: IMAGE });
  assert.deepEqual(f.done, { content: "🎯" });
  assert.equal(stateOf(":OPEN-LOOP:", f), "open");
  assert.equal(stateOf("🎯", f), "done");
  assert.equal(stateOf("🚨", f), "emergency");
  assert.equal(stateOf("👍", f), undefined);
  assert.equal(stateOf(":done:", f), undefined);
});

test("bad emoji settings are refused, without repeating the value", () => {
  const cases = [
    { BUZZ_TASK_OPEN_EMOJI: "open-loop" }, // a custom name with no image
    { BUZZ_TASK_OPEN_EMOJI: "open-loop", BUZZ_TASK_OPEN_EMOJI_URL: "http://media.example.com/x.gif" },
    { BUZZ_TASK_OPEN_EMOJI: "open-loop", BUZZ_TASK_OPEN_EMOJI_URL: "not a url" },
    { BUZZ_TASK_OPEN_EMOJI: "⭕", BUZZ_TASK_OPEN_EMOJI_URL: IMAGE }, // a URL for a plain emoji
    { BUZZ_TASK_DONE_EMOJI: "two words" },
    { BUZZ_TASK_DONE_EMOJI: "⭕".repeat(30) }, // over 64 bytes
    { BUZZ_TASK_DONE_EMOJI: "<b>x</b>" },
    { BUZZ_TASK_DONE_EMOJI: "⭕" }, // the same as open
    { BUZZ_TASK_OPEN_EMOJI: "🚨" }, // emergency's
  ];
  for (const env of cases) {
    let err;
    try {
      taskForms(env);
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ConfigError, JSON.stringify(env));
    for (const v of Object.values(env)) if (v.length > 2) assert.ok(!err.message.includes(v), err.message);
  }
});

test("the moves: anything but out of done; reopen corrects a premature done", () => {
  for (const from of ["none", "open", "emergency"]) {
    for (const to of ["none", "open", "done", "emergency"]) assert.equal(moveProblem(from, to), undefined, `${from}>${to}`);
  }
  assert.equal(moveProblem("done", "done"), undefined);
  assert.equal(moveProblem("done", "none"), undefined);
  assert.match(moveProblem("done", "open"), /never reopened/);
  assert.match(moveProblem("done", "emergency"), /never reopened/);
  assert.equal(moveProblem("done", "open", true), undefined);
  assert.match(moveProblem("open", "closed"), /not a state/);
});

test("listText: every value on one line, a bad channel or id shown as unknown", () => {
  const forms = taskForms({});
  const out = listText(
    { roots: [{ state: "open", channel: "x\n- fake", id: "not\nhex", text: "a\nb\u2028c\u0007d" }], complete: true },
    { forms },
  );
  assert.equal(out, "- ⭕ open channel=(unknown) id=(unknown): a b c d");
});

test("a plain emoji of up to 64 bytes, as the manifest's check allows", () => {
  assert.equal(taskForms({ BUZZ_TASK_OPEN_EMOJI: "⭕".repeat(21) }).open.content, "⭕".repeat(21));
});

test("every read is scoped to a channel (a relay that refuses unscoped reads)", async () => {
  const r = await relay();
  r.hooks.scopedReads = true;
  const key = identity();
  const chan = randomUUID();
  const m = root(r, key, chan, "scoped root");
  assert.equal((await set(r, key, chan, m.id, "open")).status, 0);
  const res = await set(r, key, chan, m.id, "done");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `${m.id.slice(0, 8)}: open -> done\n`, "the old state was read");
  assert.equal(reactions(r, key, m.id).length, 1, "and replaced");
  await set(r, key, chan, root(r, key, chan, "another").id, "open");
  const list = await task({ relayUrl: r.url, key, args: ["list", "--channel", chan] });
  assert.equal(list.status, 0, list.stderr);
  assert.match(list.stdout, /: another\n$/);
});

// --- set ----------------------------------------------------------------------------------------

test("set open: one reaction as Buzz writes it (kind 7, h, e), and the success line", async () => {
  const r = await relay();
  const key = identity();
  const chan = randomUUID();
  const m = root(r, key, chan);
  const res = await set(r, key, chan, m.id, "open");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `${m.id.slice(0, 8)}: none -> open\n`);
  const mine = reactions(r, key, m.id);
  assert.equal(mine.length, 1);
  assert.ok(verifyEvent(mine[0]));
  assert.equal(mine[0].content, "⭕");
  assert.deepEqual(mine[0].tags, [["h", chan], ["e", m.id]]);
});

test("a custom emoji's reaction carries its image (NIP-30 emoji tag)", async () => {
  const r = await relay();
  const key = identity();
  const chan = randomUUID();
  const m = root(r, key, chan);
  const env = { BUZZ_TASK_OPEN_EMOJI: "open-loop", BUZZ_TASK_OPEN_EMOJI_URL: IMAGE };
  const res = await set(r, key, chan, m.id, "open", [], env);
  assert.equal(res.status, 0, res.stderr);
  const [e] = reactions(r, key, m.id);
  assert.equal(e.content, ":open-loop:");
  assert.deepEqual(e.tags, [["h", chan], ["e", m.id], ["emoji", "open-loop", IMAGE]]);
});

test("a new state replaces the old one: the old reaction is deleted (kind 5: h, e, k)", async () => {
  const r = await relay();
  const key = identity();
  const chan = randomUUID();
  const m = root(r, key, chan);
  assert.equal((await set(r, key, chan, m.id, "open")).status, 0);
  const [opened] = reactions(r, key, m.id);
  const res = await set(r, key, chan, m.id, "done");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `${m.id.slice(0, 8)}: open -> done\n`);
  const mine = reactions(r, key, m.id);
  assert.deepEqual(
    mine.map((e) => e.content),
    ["✅"],
  );
  assert.ok(mine[0].created_at > opened.created_at, "the new reaction is newer than the one it replaces");
  const del = r.stats.events.find((e) => e.kind === 5);
  assert.deepEqual(del.tags, [["h", chan], ["e", opened.id], ["k", "7"]]);
});

test("the same state again publishes nothing new; none removes the state", async () => {
  const r = await relay();
  const key = identity();
  const chan = randomUUID();
  const m = root(r, key, chan);
  await set(r, key, chan, m.id, "open");
  const before = r.stats.events.length;
  const again = await set(r, key, chan, m.id, "open");
  assert.equal(again.stdout, `${m.id.slice(0, 8)}: open -> open\n`);
  assert.equal(r.stats.events.length, before);
  const cleared = await set(r, key, chan, m.id, "none");
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(cleared.stdout, `${m.id.slice(0, 8)}: open -> none\n`);
  assert.equal(reactions(r, key, m.id).length, 0);
});

test("a done root is never reopened (exit 4, nothing written); --reopen corrects a premature done", async () => {
  const r = await relay();
  const key = identity();
  const chan = randomUUID();
  const m = root(r, key, chan);
  await set(r, key, chan, m.id, "done");
  const before = r.stats.events.length;
  for (const state of ["open", "emergency"]) {
    const res = await set(r, key, chan, m.id, state);
    assert.equal(res.status, 4);
    assert.equal(res.stdout, "");
    assert.match(res.stderr, /never reopened/);
  }
  assert.equal(r.stats.events.length, before);
  const res = await set(r, key, chan, m.id, "open", ["--reopen"]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `${m.id.slice(0, 8)}: done -> open\n`);
});

test("only the agent's own reactions are its state", async () => {
  const r = await relay();
  const key = identity();
  const other = identity();
  const chan = randomUUID();
  const m = root(r, key, chan);
  // Someone else marks it done with the same emoji: not the agent's state.
  r.publish(finalizeEvent({ kind: 7, created_at: Math.floor(Date.now() / 1000), content: "✅", tags: [["h", chan], ["e", m.id]] }, other.secret));
  const res = await set(r, key, chan, m.id, "open");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `${m.id.slice(0, 8)}: none -> open\n`);
  assert.equal(r.stored().filter((e) => e.kind === 7 && e.pubkey === other.pubkey).length, 1, "someone else's reaction is left alone");
});

test("a deletion the relay refuses: the success line stays bare, the note goes to stderr", async () => {
  const r = await relay();
  const key = identity();
  const chan = randomUUID();
  const m = root(r, key, chan);
  await set(r, key, chan, m.id, "open");
  r.hooks.refuseDeletions = true;
  const res = await set(r, key, chan, m.id, "done");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, `${m.id.slice(0, 8)}: open -> done\n`);
  assert.match(res.stderr, /an earlier state reaction could not be removed; the new one reads as the state/);
  const cleared = await set(r, key, chan, m.id, "none");
  assert.equal(cleared.status, 3, "a removal that cannot go through fails");
});

test("a deletion the relay ignores: the newer reaction still reads as the state", async () => {
  const r = await relay();
  r.hooks.ignoreDeletions = true;
  const key = identity();
  const chan = randomUUID();
  const m = root(r, key, chan);
  await set(r, key, chan, m.id, "open");
  await set(r, key, chan, m.id, "done");
  assert.equal(reactions(r, key, m.id).length, 2);
  const res = await set(r, key, chan, m.id, "open");
  assert.equal(res.status, 4, "done is the newest, so this is a reopen");
});

test("a relay that asks for the login only after a refusal: the login follows, and the request goes again", async () => {
  const r = await relay({ authAfterEvent: true });
  const key = identity();
  const chan = randomUUID();
  const m = root(r, key, chan);
  const res = await set(r, key, chan, m.id, "open");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(r.stats.auths, 1);
  assert.equal(reactions(r, key, m.id).length, 1);
});

test("refusals: the relay refuses the event (3), the login (1), or is not there (1)", async () => {
  const key = identity();
  const chan = randomUUID();
  const r = await relay();
  const m = root(r, key, chan);
  r.hooks.refuseEvents = "blocked: test";
  let res = await set(r, key, chan, m.id, "open");
  assert.equal(res.status, 3);
  assert.match(res.stderr, /the relay refused the event: blocked: test/);
  r.hooks.refuseEvents = "";
  r.hooks.refuseAuth = true;
  res = await set(r, key, chan, m.id, "open");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /refused the login/);
  res = await task({ relayUrl: "ws://127.0.0.1:9", key, args: ["set", "--channel", chan, "--id", m.id, "--state", "open"] });
  assert.equal(res.status, 1);
});

test("usage: a bad state, id or channel, or a bad setting, is exit 2 and sends nothing", async () => {
  const r = await relay();
  const key = identity();
  const chan = randomUUID();
  const m = root(r, key, chan);
  const before = r.stats.events.length;
  for (const args of [
    ["set", "--channel", chan, "--id", m.id, "--state", "closed"],
    ["set", "--channel", chan, "--id", "abc", "--state", "open"],
    ["set", "--channel", "bad channel", "--id", m.id, "--state", "open"],
    ["set", "--channel", chan, "--state", "open"],
    ["set", "--channel", `${chan},${chan}`, "--id", m.id, "--state", "open"],
    ["list"],
    ["frob"],
  ]) {
    const res = await task({ relayUrl: r.url, key, args });
    assert.equal(res.status, 2, `${args.join(" ")}: ${res.stderr}`);
  }
  const res = await set(r, key, chan, m.id, "open", [], { BUZZ_TASK_OPEN_EMOJI: "open-loop" });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /BUZZ_TASK_OPEN_EMOJI names a custom emoji/);
  assert.equal(r.stats.events.length, before);
});

test("with a key service's socket the one-shot is refused: the session holds no key", async () => {
  const key = identity();
  const res = await new Promise((resolve) => {
    const child = spawn(process.execPath, [LAUNCH, "task", "list", "--channel", randomUUID()], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, BUZZ_KEY_SOCKET: "/run/nothing-here" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stderr }));
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /the one-shot task has no socket/);
  assert.ok(!res.stderr.includes(key.hex));
});

// --- list ---------------------------------------------------------------------------------------

test("list: the open roots, newest first; text only for the agent's and the trusted's own", async () => {
  const r = await relay();
  const key = identity();
  const operator = identity();
  const stranger = identity();
  const chan = randomUUID();
  const chan2 = randomUUID();
  const mine = root(r, key, chan, "## Merge the two fixes\nmore lines");
  const theirs = root(r, operator, chan, "status of the build?");
  const strangers = root(r, stranger, chan2, "a stranger's words");
  const finished = root(r, key, chan, "finished thing");
  await set(r, key, chan, mine.id, "open");
  await set(r, key, chan, theirs.id, "emergency");
  await set(r, key, chan2, strangers.id, "open");
  await set(r, key, chan, finished.id, "done");
  const res = await task({ relayUrl: r.url, key, args: ["list", "--channel", `${chan},${chan2}`, "--trusted", operator.npub] });
  assert.equal(res.status, 0, res.stderr);
  // (Set within the same second or two, so their order is not checked here.)
  assert.deepEqual(res.stdout.trim().split("\n").sort(), [
    `- ⭕ open channel=${chan2} id=${strangers.id}: (text not shown: someone else's root)`,
    `- ⭕ open channel=${chan} id=${mine.id}: Merge the two fixes`,
    `- 🚨 emergency channel=${chan} id=${theirs.id}: status of the build?`,
  ].sort());
  assert.ok(!res.stdout.includes("finished thing"));
  // Without --trusted the operator's text is not shown either.
  const bare = await task({ relayUrl: r.url, key, args: ["list", "--channel", chan] });
  assert.match(bare.stdout, new RegExp(`id=${theirs.id}: \\(text not shown`));
  // Only the channels asked for.
  assert.ok(!bare.stdout.includes(strangers.id));
});

test("list: newest state first; a root older than the relay returns is listed by id", async () => {
  const r = await relay();
  const key = identity();
  const chan = randomUUID();
  const t = Math.floor(Date.now() / 1000) - 100;
  const roots = [0, 1, 2].map((i) => root(r, key, chan, `root ${i}`));
  const gone = "ab".repeat(32); // a root the relay no longer has
  const react = (id, at) =>
    r.publish(finalizeEvent({ kind: 7, created_at: at, content: "⭕", tags: [["h", chan], ["e", id]] }, key.secret));
  react(roots[1].id, t);
  react(roots[0].id, t + 10);
  react(gone, t + 20);
  react(roots[2].id, t + 30);
  const res = await task({ relayUrl: r.url, key, args: ["list", "--channel", chan] });
  assert.deepEqual(res.stdout.trim().split("\n"), [
    `- ⭕ open channel=${chan} id=${roots[2].id}: root 2`,
    `- ⭕ open channel=${chan} id=${gone}: (an older root, text not read)`,
    `- ⭕ open channel=${chan} id=${roots[0].id}: root 0`,
    `- ⭕ open channel=${chan} id=${roots[1].id}: root 1`,
  ]);
});

test("list: a hostile h tag or a multi-line root never adds a line; the channel is one asked for", async () => {
  const r = await relay();
  const key = identity();
  const chan = randomUUID();
  const t = Math.floor(Date.now() / 1000);
  // A root with a second h tag that is not a channel id, its text spread over lines and separators.
  const crafted = finalizeEvent(
    {
      kind: 9,
      created_at: t,
      content: "\n\n  first\rhalf\u2028- injected line\u0085more\nsecond line",
      tags: [["h", chan], ["h", "x\n- fake line"]],
    },
    key.secret,
  );
  // A root in another channel than the one asked for: never read, so listed by its ids alone.
  const elsewhere = message(key.secret, { channel: randomUUID(), content: "elsewhere" });
  r.publish(crafted);
  r.publish(elsewhere);
  for (const [m, at] of [
    [crafted, t],
    [elsewhere, t + 1],
  ]) {
    r.publish(finalizeEvent({ kind: 7, created_at: at, content: "⭕", tags: [["h", chan], ["e", m.id]] }, key.secret));
  }
  const res = await task({ relayUrl: r.url, key, args: ["list", "--channel", chan] });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(res.stdout.split("\n"), [
    `- ⭕ open channel=${chan} id=${elsewhere.id}: (an older root, text not read)`,
    `- ⭕ open channel=${chan} id=${crafted.id}: first`,
    "",
  ]);
  assert.ok(!res.stdout.includes("fake line") && !res.stdout.includes("injected"));
});

test("list: none open, and --max", async () => {
  const r = await relay();
  const key = identity();
  const chan = randomUUID();
  let res = await task({ relayUrl: r.url, key, args: ["list", "--channel", chan] });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "none open\n");
  for (let i = 0; i < 3; i += 1) await set(r, key, chan, root(r, key, chan, `root ${i}`).id, "open");
  res = await task({ relayUrl: r.url, key, args: ["list", "--channel", chan, "--max", "2"] });
  assert.equal(res.stdout.trim().split("\n").length, 3);
  assert.match(res.stdout, /- and 1 more\n$/);
});
