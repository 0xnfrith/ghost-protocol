// The status line's parts, alone (src/status.mjs): the grammar and its caps,
// the publisher's rules on a fake clock, whose claude it is, the instance's
// local inputs, the settings, and the read with every check. The channel
// with all of it wired in is test/status.test.mjs; status-mutants.mjs breaks
// each rule in turn and runs both against it.
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { parsePublicKey } from "../src/config.mjs";
import {
  clean,
  cut,
  DENY_WAIT,
  formatLine,
  instanceStateDir,
  LINE_MAX,
  ownClaude,
  parseLine,
  presenceSnapshot,
  readStatuses,
  statusSettings,
  refusedText,
  StatusPublisher,
  StatusTextRefused,
  watchInstance,
} from "../src/status.mjs";
import { tempDir } from "./helpers.mjs";

const ROOT_A = "a1".repeat(32);
const ROOT_B = "b2".repeat(32);
const ROOT_C = "c3".repeat(32);
/** A delivery from a public channel: only there may a root id name the task. */
const PUB = { public: true };
const settle = () => new Promise((r) => setImmediate(r));

/** A clock whose time moves only when advance() says so, timers and all. */
function fakeClock(start = 1_800_000_000_000) {
  let t = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => (timers.set(++seq, { at: t + ms, fn }), seq),
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => (timers.set(++seq, { at: t + ms, fn, every: ms }), seq),
    clearInterval: (id) => timers.delete(id),
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        let next = null;
        for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
        if (!next) break;
        const [id, x] = next;
        t = x.at;
        if (x.every) x.at += x.every;
        else timers.delete(id);
        x.fn();
        await settle();
      }
      t = end;
      await settle();
    },
  };
}

function harness({ own = true, ok = true } = {}) {
  const clock = fakeClock();
  const sent = [];
  const presence = [];
  const logs = [];
  const h = { clock, sent, presence, logs, own, ok };
  h.pub = new StatusPublisher({
    send: (template) => (sent.push({ ...template, at: clock.now() }), h.ok),
    presence: (value) => presence.push({ value, at: clock.now() }),
    own: () => h.own,
    log: (m) => logs.push(m),
    clock,
  });
  h.lines = () => sent.map((e) => e.content);
  return h;
}

/** A harness logged in, its first line (idle) sent, and the gap since it passed. */
async function live(options) {
  const h = harness(options);
  h.pub.connected();
  await settle();
  await h.clock.advance(20_000);
  return h;
}

// --- the line -------------------------------------------------------------------

test("the line: the three states, as README's examples", () => {
  assert.equal(formatLine({ state: "working", task: "review the release notes draft" }), "working | task: review the release notes draft");
  assert.equal(formatLine({ state: "idle" }), "idle");
  assert.equal(
    formatLine({ state: "waiting", task: "update to version 0.16.0", waitsOn: "the operator's yes" }),
    "waiting | task: update to version 0.16.0 | waits on: the operator's yes",
  );
  assert.equal(formatLine({ state: "working" }), "working");
  assert.equal(formatLine({ state: "waiting", waitsOn: "a review" }), "waiting | waits on: a review");
  assert.equal(formatLine({ state: "idle", task: "x", waitsOn: "y" }), "idle", "idle carries neither text");
  assert.equal(formatLine({ state: "waiting", task: "x" }), "idle", "waiting needs a wait");
});

test("the line: each text is one plain line, | becomes /, and it is cut to its cap with …", () => {
  assert.equal(clean(" a\nb\r\tc\u2028d\u0007e  f "), "a b c d e f");
  assert.equal(clean("x | y"), "x / y");
  const long = "x".repeat(80);
  const line = formatLine({ state: "working", task: long });
  assert.equal(line, `working | task: ${"x".repeat(49)}…`);
  assert.equal(cut("🙂".repeat(30), 10).length <= 10, true);
  assert.ok(!/[\ud800-\udbff]…$/.test(cut(`abcdefgh${"🙂".repeat(5)}`, 10)), "never half a pair");
});

test("the line: never longer than LINE_MAX (Buzz's app drops longer), the task cut first", () => {
  const line = formatLine({ state: "waiting", task: "t".repeat(60), waitsOn: "w".repeat(60) });
  assert.equal(LINE_MAX, 100, "Buzz's app's own limit");
  assert.equal(line.length, 100);
  assert.ok(line.endsWith(`waits on: ${"w".repeat(49)}…`), "the wait keeps its own cap");
  assert.ok(line.includes("| task: tttttttttttttttttttt"), "the task keeps at least 20");
  for (let i = 0; i < 300; i += 1) {
    const rand = (n) => Array.from({ length: n }, () => String.fromCharCode(Math.floor(Math.random() * 0x3000))).join("");
    for (const state of ["working", "idle", "waiting"]) {
      const l = formatLine({ state, task: rand(i % 90), waitsOn: rand((i * 7) % 90) || "w" });
      assert.ok(l.length <= LINE_MAX && !/[\r\n]/.test(l), JSON.stringify(l));
      assert.ok(parseLine(l), `parses: ${JSON.stringify(l)}`);
    }
  }
});

test("parse: format's own lines round-trip; anything else is null", () => {
  for (const x of [
    { state: "working", task: "#42 fix the login timeout", waits_on: null },
    { state: "idle", task: null, waits_on: null },
    { state: "waiting", task: "update", waits_on: "the operator's yes" },
    { state: "waiting", task: null, waits_on: "a person to allow a step" },
  ]) {
    assert.deepEqual(parseLine(formatLine({ state: x.state, task: x.task, waitsOn: x.waits_on })), x);
  }
  for (const bad of [
    "busy",
    "Working | task: x",
    "idle | task: x",
    "working | waits on: x",
    "waiting",
    "waiting | task: x",
    "working | task:  x",
    "working | task: x ",
    "working|task: x",
    `working | task: ${"x".repeat(LINE_MAX)}`,
    "working | task: a\nb",
    "",
  ]) {
    assert.equal(parseLine(bad), null, JSON.stringify(bad));
  }
});

// --- the publisher --------------------------------------------------------------

test("publisher: busy is working after the settle, with the root's id as the task and an expiry", async () => {
  const h = await live();
  h.pub.delivered(ROOT_A, PUB);
  await h.clock.advance(2900);
  assert.deepEqual(h.lines(), ["idle"], "nothing before the 3 s settle");
  await h.clock.advance(200);
  assert.deepEqual(h.lines(), ["idle", `working | task: task ${ROOT_A.slice(0, 8)}`]);
  const e = h.sent[1];
  assert.equal(e.kind, 30315);
  assert.deepEqual(e.tags, [["d", "general"], ["expiration", String(e.created_at + 1800)]]);
  assert.deepEqual(h.sent[0].tags, [["d", "general"]], "idle never expires");
});

test("publisher: a turn's end is idle, or waiting when a wait is set", async () => {
  const h = await live();
  h.pub.turn("busy");
  await h.clock.advance(20_000);
  h.pub.named({ waitsOn: "the operator's yes" });
  h.pub.turn("idle");
  await h.clock.advance(20_000);
  assert.deepEqual(h.lines(), ["idle", "working", "waiting | waits on: the operator's yes"]);
  h.pub.named({ waitsOn: "" });
  await h.clock.advance(20_000);
  assert.equal(h.lines().at(-1), "idle");
});

test("publisher: a quick turn sends only its result", async () => {
  const h = await live();
  h.pub.turn("busy");
  await h.clock.advance(1000);
  h.pub.turn("idle");
  await h.clock.advance(60_000);
  assert.deepEqual(h.lines(), ["idle"], "busy then idle within the settle: nothing new");
});

test("publisher: at most one line every 15 s, the newest when it goes", async () => {
  const h = await live();
  h.pub.turn("busy");
  await h.clock.advance(3000);
  h.pub.named({ task: "one" });
  await h.clock.advance(3000);
  h.pub.named({ task: "two" });
  await h.clock.advance(3000);
  assert.deepEqual(h.lines(), ["idle", "working"]);
  await h.clock.advance(8000);
  assert.deepEqual(h.lines(), ["idle", "working"], "still inside the gap");
  await h.clock.advance(1000);
  assert.deepEqual(h.lines(), ["idle", "working", "working | task: two"]);
  const [, a, b] = h.sent;
  assert.ok(b.at - a.at >= 15_000, `${b.at - a.at}`);
});

test("publisher: the same line is not sent again, but a working line is refreshed every 10 minutes", async () => {
  const h = await live();
  h.pub.turn("busy");
  await h.clock.advance(20_000);
  h.pub.named({ task: "" });
  h.pub.turn("busy");
  await h.clock.advance(5 * 60_000);
  assert.deepEqual(h.lines(), ["idle", "working"]);
  await h.clock.advance(6 * 60_000);
  assert.deepEqual(h.lines(), ["idle", "working", "working"], "refreshed before its 30 min expiry");
  const [, first, again] = h.sent;
  assert.ok(Number(again.tags[1][1]) > Number(first.tags[1][1]), "with a later expiry");
  h.pub.turn("idle");
  await h.clock.advance(60 * 60_000);
  assert.deepEqual(h.lines(), ["idle", "working", "working", "idle"], "idle is never refreshed");
});

test("publisher: the first login sends the current line at once; a later one sends only a change", async () => {
  const h = harness();
  h.pub.connected();
  await settle();
  assert.deepEqual(h.lines(), ["idle"]);
  h.pub.disconnected();
  await h.clock.advance(60_000);
  h.pub.connected();
  await h.clock.advance(60_000);
  assert.deepEqual(h.lines(), ["idle"], "nothing new to say");
  h.pub.disconnected();
  h.pub.turn("busy");
  await h.clock.advance(60_000);
  assert.deepEqual(h.lines(), ["idle"], "nothing while disconnected");
  h.pub.connected();
  await h.clock.advance(5000);
  assert.deepEqual(h.lines(), ["idle", "working"], "the change goes out after the login");
});

test("publisher: a session that is not the instance's own claude publishes nothing, and says so once", async () => {
  const h = harness({ own: false });
  h.pub.connected();
  h.pub.delivered(ROOT_A, PUB);
  h.pub.turn("busy");
  await h.clock.advance(30 * 60_000);
  h.pub.stop();
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.presence, []);
  assert.equal(h.logs.filter((m) => m.includes("not the instance's own claude")).length, 1);
});

test("publisher: a session known as the instance's own only after the login sends its first line at the next beat", async () => {
  const h = harness({ own: false });
  h.pub.connected();
  await h.clock.advance(30_000);
  assert.deepEqual([h.sent.length, h.presence.length], [0, 0]);
  h.own = true;
  await h.clock.advance(30_000);
  assert.deepEqual(h.lines(), ["idle"]);
  assert.equal(h.presence.length, 1);
});

test("publisher: presence online at login and every 60 s; none while disconnected; offline at stop", async () => {
  const h = harness();
  h.pub.connected();
  await settle();
  await h.clock.advance(150_000);
  assert.deepEqual(h.presence.map((p) => p.value), ["online", "online", "online"]);
  h.pub.disconnected();
  await h.clock.advance(300_000);
  assert.equal(h.presence.length, 3);
  h.pub.connected();
  await settle();
  h.pub.stop();
  assert.deepEqual(h.presence.map((p) => p.value), ["online", "online", "online", "online", "offline"]);
  await h.clock.advance(300_000);
  assert.equal(h.presence.length, 5, "nothing after stop");
});

test("publisher: no message text has a way in: a root must be an event id, and nothing else is taken", async () => {
  const h = await live();
  const dmText = "Meet Example Customer Ltd at 12 Harbour Road, key TOKEN-123";
  h.pub.delivered(dmText);
  h.pub.taskSet(dmText, "open");
  h.pub.delivered(`${ROOT_A} ${dmText}`);
  await h.clock.advance(60_000);
  assert.deepEqual(h.lines(), ["idle"], "not ids: dropped");
  h.pub.delivered(ROOT_A, PUB);
  await h.clock.advance(60_000);
  assert.deepEqual(h.lines(), ["idle", `working | task: task ${ROOT_A.slice(0, 8)}`]);
  for (const name of ["delivered", "taskSet", "turn", "denied", "connected"]) {
    assert.ok(StatusPublisher.prototype[name].length <= 2, name);
  }
});

test("publisher: names are kept per root; done or none clears the name and the wait", async () => {
  const h = await live();
  h.pub.delivered(ROOT_A, PUB);
  h.pub.named({ task: "#7 tidy the docs" });
  await h.clock.advance(20_000);
  h.pub.delivered(ROOT_B, PUB);
  await h.clock.advance(20_000);
  h.pub.delivered(ROOT_A, PUB);
  await h.clock.advance(20_000);
  assert.deepEqual(h.lines().slice(1), ["working | task: #7 tidy the docs", `working | task: task ${ROOT_B.slice(0, 8)}`, "working | task: #7 tidy the docs"]);
  h.pub.named({ waitsOn: "a review" });
  h.pub.turn("idle");
  await h.clock.advance(20_000);
  assert.equal(h.lines().at(-1), "waiting | task: #7 tidy the docs | waits on: a review");
  h.pub.taskSet(ROOT_A, "done");
  await h.clock.advance(20_000);
  assert.equal(h.lines().at(-1), "idle");
  h.pub.delivered(ROOT_A, PUB);
  await h.clock.advance(20_000);
  assert.equal(h.lines().at(-1), `working | task: task ${ROOT_A.slice(0, 8)}`, "the name went with done");
});

test("publisher: a denied dialog is waiting for a person until the next turn starts", async () => {
  const h = await live();
  h.pub.delivered(ROOT_A, PUB);
  await h.clock.advance(20_000);
  h.pub.denied();
  h.pub.turn("idle");
  await h.clock.advance(20_000);
  assert.equal(h.lines().at(-1), `waiting | task: task ${ROOT_A.slice(0, 8)} | waits on: ${DENY_WAIT}`);
  h.pub.turn("busy");
  h.pub.turn("idle");
  await h.clock.advance(20_000);
  assert.equal(h.lines().at(-1), "idle");
});

test("publisher: a line the relay did not take is sent again after the gap", async () => {
  const h = await live();
  h.ok = false;
  h.pub.turn("busy");
  await h.clock.advance(3000);
  assert.equal(h.sent.length, 2);
  h.ok = true;
  await h.clock.advance(20_000);
  assert.deepEqual(h.lines(), ["idle", "working", "working"]);
});

test("publisher: a refresh that falls due offline is sent at the next login, and the refresh is armed again", async () => {
  const h = await live();
  h.pub.turn("busy");
  await h.clock.advance(20_000);
  assert.deepEqual(h.lines(), ["idle", "working"]);
  h.pub.disconnected();
  await h.clock.advance(11 * 60_000);
  assert.deepEqual(h.lines(), ["idle", "working"], "nothing while disconnected: the 10-minute refresh fell due offline");
  h.pub.connected();
  await settle();
  assert.deepEqual(h.lines(), ["idle", "working", "working"], "the unchanged working line, again at the login");
  const [, first, again] = h.sent;
  assert.ok(Number(again.tags[1][1]) > Number(first.tags[1][1]), "with a later expiry");
  await h.clock.advance(10 * 60_000 + 1000);
  assert.deepEqual(h.lines(), ["idle", "working", "working", "working"], "and refreshed again 10 minutes on");
  h.pub.disconnected();
  h.pub.turn("idle");
  await h.clock.advance(60_000);
  h.pub.disconnected();
  h.pub.connected();
  await h.clock.advance(30 * 60_000);
  assert.deepEqual(h.lines(), ["idle", "working", "working", "working", "idle"], "an idle line is never sent again for this");
  h.pub.disconnected();
  await h.clock.advance(60 * 60_000);
  h.pub.connected();
  await h.clock.advance(60_000);
  assert.equal(h.lines().length, 5, "nor after a long time offline");
});

test("publisher: with no name, only a public channel's root names the task; a DM's or a private channel's work is plain working", async () => {
  const h = await live();
  h.pub.delivered(ROOT_A); // a DM, or a private channel: no `public`
  await h.clock.advance(20_000);
  assert.deepEqual(h.lines(), ["idle", "working"], "a DM's or a private channel's root: no id");
  h.pub.delivered(ROOT_B, { public: false });
  await h.clock.advance(20_000);
  assert.deepEqual(h.lines(), ["idle", "working"], "said as false: the same");
  h.pub.delivered(ROOT_C, PUB);
  await h.clock.advance(20_000);
  assert.deepEqual(h.lines(), ["idle", "working", `working | task: task ${ROOT_C.slice(0, 8)}`], "a public channel's thread: its id");
  h.pub.delivered(ROOT_A);
  await h.clock.advance(20_000);
  assert.equal(h.lines().at(-1), "working", "back on the DM's root: no id");
  h.pub.named({ task: "#5 check the backup" });
  await h.clock.advance(20_000);
  assert.equal(h.lines().at(-1), "working | task: #5 check the backup", "the agent's own name shows wherever the work came from");
  h.pub.named({ waitsOn: "a review" });
  h.pub.taskSet(ROOT_A, "none");
  h.pub.named({ waitsOn: "a review" });
  h.pub.turn("idle");
  await h.clock.advance(20_000);
  assert.equal(h.lines().at(-1), "waiting | waits on: a review", "a DM's wait: no id either");
  const t = harness();
  t.pub.connected();
  await settle();
  t.pub.taskSet(ROOT_B, "open"); // the task tool, with no delivery from a public channel
  t.pub.turn("busy");
  await t.clock.advance(20_000);
  assert.deepEqual(t.lines(), ["idle", "working"], "a root the task tool opened: no id");
});

test("publisher: the status tool's words that look like a key, a token or a path are refused, before any cut, and change nothing", async () => {
  const h = await live();
  h.pub.delivered(ROOT_A, PUB);
  h.pub.named({ task: "#3 rotate the backups" });
  await h.clock.advance(20_000);
  const before = h.lines().length;
  const npub = "npub1" + "q".repeat(58);
  const refused = [
    [{ task: `send ${"nsec1" + "x".repeat(58)}` }, /^task refused: it looks like a key;/],
    [{ task: `#9 ${npub}` }, /^task refused: it looks like a key;/],
    [{ waitsOn: `event ${"ab".repeat(32)}` }, /^waits_on refused: it looks like a key;/],
    // the 64-hex run starts past the 50-character cap: refused all the same, as the check comes before the cut
    [{ task: `${"x ".repeat(30)}${"0f".repeat(32)}` }, /^task refused: it looks like a key;/],
    [{ task: "#4 token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, /^task refused: it looks like a token;/],
    [{ task: "#4 fix /srv/tenants/acme/config" }, /^task refused: it looks like a path/],
    [{ waitsOn: "C:\\Users\\x" }, /^waits_on refused: it looks like a path/],
    [{ task: "#8 fine", waitsOn: "see a/b" }, /^waits_on refused/],
  ];
  for (const [args, want] of refused) {
    assert.throws(() => h.pub.named(args), (err) => err instanceof StatusTextRefused && want.test(err.message) && !err.message.includes("\n"), JSON.stringify(args));
  }
  await h.clock.advance(60_000);
  assert.equal(h.lines().length, before, "nothing was sent");
  assert.equal(h.pub.line(), "working | task: #3 rotate the backups", "and nothing changed, not even the field next to the refused one");
  for (const fine of ["#42 fix the login timeout", "the operator's yes", "update to version 0.16.0", "supercalifragilisticexpialidociousness", "npub", "x | y", ""]) {
    assert.equal(refusedText(fine), null, fine);
  }
});

test("the line: accented text counts in UTF-16 units, as Buzz's app does (one for é, two for e and its accent)", () => {
  const composed = "é".repeat(60); // U+00E9: one unit each
  const decomposed = "e\u0301".repeat(30); // e + U+0301: two units each, 60 in all
  assert.equal(composed.length, 60);
  assert.equal(decomposed.length, 60);
  const a = formatLine({ state: "working", task: composed });
  assert.equal(a, `working | task: ${"é".repeat(49)}…`, "50 units: 49 é and the …");
  const b = formatLine({ state: "working", task: decomposed });
  assert.equal(b.length, "working | task: ".length + 50);
  const w = formatLine({ state: "waiting", task: "ü".repeat(60), waitsOn: "à".repeat(60) });
  assert.equal(w.length, LINE_MAX, "the whole line at most 100 units");
  assert.ok(w.endsWith(`waits on: ${"à".repeat(49)}…`));
  assert.deepEqual(parseLine(w)?.state, "waiting", "and it parses");
  assert.equal(parseLine(`working | task: ${"é".repeat(LINE_MAX)}`), null, "a longer one does not");
});

// --- whose claude ---------------------------------------------------------------

function tree(nodes) {
  // nodes: { pid: [ppid, name] }
  return { ppid: (p) => nodes[p]?.[0] ?? "", name: (p) => nodes[p]?.[1] ?? "" };
}

test("own claude: the first claude above the channel must be start's pane-pid", () => {
  const dir = tempDir("own");
  writeFileSync(join(dir, "pane-pid"), "500\n");
  const nodes = { 700: ["600", "node"], 600: ["500", "node"], 500: ["400", "claude"], 400: ["1", "tmux"] };
  assert.equal(ownClaude(dir, { start: "600", proc: tree(nodes) }), true, "channel -> launcher -> the pane's claude");
  const other = { ...nodes, 650: ["640", "node"], 640: ["630", "claude"], 630: ["500", "bash"] };
  assert.equal(ownClaude(dir, { start: "650", proc: tree(other) }), false, "a claude -p the agent ran");
  const sameName = { 650: ["640", "node"], 640: ["500", "agentbin"], 500: ["1", "agentbin"] };
  assert.equal(ownClaude(dir, { start: "650", proc: tree(sameName) }), false, "named as the pane's process");
  assert.equal(ownClaude(dir, { start: "900", proc: tree({ 900: ["1", "node"] }) }), false, "no such ancestor");
  assert.equal(ownClaude(tempDir("own-none"), { start: "600", proc: tree(nodes) }), false, "no pane-pid");
  const one = tempDir("own-one");
  writeFileSync(join(one, "pane-pid"), "1\n");
  assert.equal(ownClaude(one, { start: "1", proc: tree({}) }), false, "pid 1 is never it");
  const link = tempDir("own-link");
  symlinkSync(join(dir, "pane-pid"), join(link, "pane-pid"));
  assert.equal(ownClaude(link, { start: "600", proc: tree(nodes) }), false, "a link is refused");
  const loop = { 10: ["11", "node"], 11: ["10", "node"] };
  assert.equal(ownClaude(dir, { start: "10", proc: tree(loop) }), false, "a loop ends");
  assert.equal(ownClaude(dir, { proc: tree({}) }), false, "this test's own parent is no pane");
});

test("instanceStateDir: from GP_INSTANCE_NAME, only a plain name", () => {
  assert.equal(instanceStateDir({ GP_INSTANCE_NAME: "agent-1", XDG_STATE_HOME: "/s" }), "/s/ghost-protocol/agent-1");
  for (const bad of ["", "-x", "A", "a/b", "../x", "a b"]) assert.equal(instanceStateDir({ GP_INSTANCE_NAME: bad }), null, bad);
  assert.equal(instanceStateDir({}), null);
});

// --- the local inputs -----------------------------------------------------------

test("watchInstance: the turn marker's word, never its id; a new deny counts, an old one does not", async () => {
  const dir = tempDir("watch");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status-wait"), "deny 100\n");
  writeFileSync(join(dir, "turn"), "idle p-1\n");
  const clock = fakeClock();
  const seen = [];
  const stop = watchInstance({ stateDir: dir, onTurn: (...a) => seen.push(["turn", ...a]), onDenied: (...a) => seen.push(["denied", ...a]), everyMs: 1000, clock });
  assert.deepEqual(seen, [["turn", "idle"]]);
  writeFileSync(join(dir, "turn"), "busy p-2 a customer's secret\n");
  await clock.advance(1000);
  writeFileSync(join(dir, "status-wait"), "deny 200\n");
  await clock.advance(1000);
  writeFileSync(join(dir, "turn"), "something else\n");
  writeFileSync(join(dir, "status-wait"), "deny soon\n");
  await clock.advance(1000);
  stop();
  writeFileSync(join(dir, "turn"), "busy p-3\n");
  await clock.advance(5000);
  assert.deepEqual(seen, [["turn", "idle"], ["turn", "busy"], ["denied"]]);
});

// --- settings -------------------------------------------------------------------

test("settings: off unless BUZZ_STATUS is on; an unfilled plugin value is off; a bad one is off and said", () => {
  const k = getPublicKey(generateSecretKey());
  assert.equal(statusSettings({}, parsePublicKey).on, false);
  assert.equal(statusSettings({ BUZZ_STATUS: "On" }, parsePublicKey).on, true);
  const unfilled = statusSettings({ BUZZ_STATUS: "${user_config.status_line}", BUZZ_STATUS_AGENTS: "${user_config.status_agents}" }, parsePublicKey);
  assert.deepEqual([unfilled.on, unfilled.agents, unfilled.problems], [false, [], []]);
  const bad = statusSettings({ BUZZ_STATUS: "yes", BUZZ_STATUS_AGENTS: `${k}, nope ${k}`, BUZZ_STATUS_GAP_MS: "0" }, parsePublicKey);
  assert.equal(bad.on, false);
  assert.deepEqual(bad.agents, [k]);
  assert.equal(bad.problems.length, 3);
  assert.equal(bad.timings.gapMs, 15_000);
  assert.deepEqual(statusSettings({}, parsePublicKey).timings, { settleMs: 3000, gapMs: 15_000, presenceMs: 60_000, pollMs: 1000 });
});

// --- the read -------------------------------------------------------------------

const agentA = generateSecretKey();
const agentB = generateSecretKey();
const relayKey = generateSecretKey();
const A = getPublicKey(agentA);
const B = getPublicKey(agentB);
const statusEvent = (secret, content, at, tags = []) => finalizeEvent({ kind: 30315, created_at: at, content, tags: [["d", "general"], ...tags] }, secret);

test("read: each agent's newest checked line, its name, expiry and presence", async () => {
  const now = 1_800_000_000;
  // As from the relay: JSON, so no signature check is remembered on the object.
  const forged = JSON.parse(JSON.stringify({ ...statusEvent(agentB, "idle", now), content: "working | task: forged" }));
  const events = [
    statusEvent(agentA, "idle", now - 100),
    statusEvent(agentA, "working | task: #42 fix the login timeout", now - 10, [["expiration", String(now - 1)]]),
    forged,
    statusEvent(agentB, "waiting | waits on: x", now - 5, [["h", "channel"]]),
    finalizeEvent({ kind: 30315, created_at: now, content: "idle", tags: [["d", "general"], ["d", "other"]] }, agentB),
    statusEvent(generateSecretKey(), "idle", now),
    finalizeEvent({ kind: 0, created_at: now, content: JSON.stringify({ name: "agent-a", display_name: "Agent\nA" }), tags: [] }, agentA),
    finalizeEvent({ kind: 0, created_at: now, content: "not json", tags: [] }, agentB),
  ];
  let filtersSeen;
  const rows = await readStatuses({
    query: async (f) => ((filtersSeen = f), events),
    presence: async () => new Map([[A, "online"]]),
    agents: [A, B],
    now,
  });
  assert.deepEqual(filtersSeen[0], { kinds: [30315], authors: [A, B], "#d": ["general"], limit: 8 });
  assert.deepEqual(rows[0], {
    pubkey: A,
    name: "Agent A",
    line: "working | task: #42 fix the login timeout",
    state: "working",
    task: "#42 fix the login timeout",
    waits_on: null,
    set_at: now - 10,
    expires_at: now - 1,
    expired: true,
    presence: "online",
  });
  assert.deepEqual(rows[1], {
    pubkey: B,
    name: null,
    line: null,
    state: "none",
    task: null,
    waits_on: null,
    set_at: null,
    expires_at: null,
    expired: false,
    presence: "offline",
  });
});

test("read: a line that does not parse is unknown, kept on one line; a failed presence read is unknown", async () => {
  const now = 1_800_000_000;
  const rows = await readStatuses({
    query: async () => [statusEvent(agentA, "In a meeting\nback at 3", now)],
    presence: async () => {
      throw new Error("down");
    },
    agents: [A],
    now,
  });
  assert.equal(rows[0].state, "unknown");
  assert.equal(rows[0].line, "In a meeting back at 3");
  assert.equal(rows[0].presence, "unknown");
  assert.equal(rows[0].expired, false);
});

test("presence: a NIP-98 signed POST /query, and only the relay's own answers count", async () => {
  const calls = [];
  const answer = (events, status = 200) => async (url, init) => {
    calls.push({ url, init });
    return { ok: status === 200, status, json: async () => events };
  };
  const snap = (content, subject = A, signer = relayKey) => finalizeEvent({ kind: 20001, created_at: 1, content, tags: [["p", subject]] }, signer);
  const authTag = ["auth", B, "", "00".repeat(64)];
  const base = { httpUrl: "https://relay.example/", secret: agentA, authTag, relayKey: getPublicKey(relayKey), agents: [A, B], sign: finalizeEvent };
  const seen = await presenceSnapshot({ ...base, fetchImpl: answer([snap("online"), snap('{"status":"away"}', B)]) });
  assert.deepEqual([...seen], [[A, "online"], [B, "away"]]);
  const { url, init } = calls[0];
  assert.equal(url, "https://relay.example/query");
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body), [{ kinds: [20001], authors: [A, B], limit: 2 }]);
  assert.equal(init.headers["x-auth-tag"], JSON.stringify(authTag));
  const proof = JSON.parse(Buffer.from(init.headers.authorization.replace(/^Nostr /, ""), "base64").toString("utf8"));
  const tag = (n) => proof.tags.find((t) => t[0] === n)?.[1];
  assert.deepEqual([proof.kind, proof.pubkey, tag("u"), tag("method")], [27235, A, "https://relay.example/query", "POST"]);
  assert.equal(tag("payload"), createHash("sha256").update(init.body).digest("hex"));
  assert.match(tag("nonce"), /^[0-9a-f]{32}$/);
  const { authTag: _, ...noTag } = base;
  await presenceSnapshot({ ...noTag, fetchImpl: answer([]) });
  assert.equal("x-auth-tag" in calls[1].init.headers, false);

  for (const [what, events] of [
    ["signed by another key", [snap("online", A, generateSecretKey())]],
    ["about someone not asked", [snap("online", getPublicKey(generateSecretKey()))]],
    ["two p tags", [finalizeEvent({ kind: 20001, created_at: 1, content: "online", tags: [["p", A], ["p", B]] }, relayKey)]],
    ["the same author twice", [snap("online"), snap("away")]],
    ["a bad signature", [JSON.parse(JSON.stringify({ ...snap("online"), content: "away" }))]],
  ]) {
    await assert.rejects(presenceSnapshot({ ...base, fetchImpl: answer(events) }), /untrusted/, what);
  }
  await assert.rejects(presenceSnapshot({ ...base, fetchImpl: answer([], 500) }), /500/);
  await assert.rejects(presenceSnapshot({ ...base, relayKey: null, fetchImpl: answer([]) }), /NIP-11/);
  const odd = await presenceSnapshot({ ...base, fetchImpl: answer([snap("dancing")]) });
  assert.equal(odd.get(A), "unknown");
});
