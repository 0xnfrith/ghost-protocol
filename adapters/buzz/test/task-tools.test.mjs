// The channel's task tools and its DM instructions, end to end: the real
// launcher and channel server as a child process, over MCP stdio, against the
// fake relay. The states and the one-shot are in task.test.mjs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { message, startFakeRelay } from "./fake-relay.mjs";
import { closeAll, identity, LAUNCH, startChannel, tempDir, waitFor } from "./helpers.mjs";

const agent = identity();
const operator = identity();
const stranger = identity();
let relay;
before(async () => {
  relay = await startFakeRelay();
});
after(async () => {
  await closeAll();
  await relay.close();
});

async function open(extra = {}) {
  const dir = tempDir("task-tools");
  const chan = randomUUID();
  const log = join(dir, "channel.log");
  const reqs = relay.stats.reqs.length;
  const ch = await startChannel({
    relayUrl: relay.url,
    key: agent,
    env: { BUZZ_CHANNELS: chan, BUZZ_STATE_DIR: join(dir, "state"), BUZZ_LOG_FILE: log, ...extra },
  });
  await waitFor(() => relay.stats.reqs.slice(reqs).some((r) => r.subId.startsWith("buzz-channel-sub-")), { what: "the subscription" });
  return { ch, chan, log: () => readFileSync(log, "utf8") };
}

const call = (ch, name, args) => ch.client.callTool({ name, arguments: args });
const text = (result) => result.content.map((c) => c.text).join("\n");

test("the tools are listed, and a DM is answered in its own thread (task roots off)", async () => {
  const { ch } = await open();
  const { tools } = await ch.client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name),
    ["task", "task_list"],
  );
  assert.deepEqual(tools[0].inputSchema.properties.state.enum, ["open", "done", "emergency", "none"]);
  const instructions = ch.client.getInstructions();
  assert.match(instructions, /That holds in a direct message \(dm="true"\) too: answer in its thread, never at the top level of the DM\./);
  assert.ok(!instructions.includes("leave out reply"), "no top-level DM answers any more");
  assert.ok(!instructions.includes("DM task roots are on"));
  await ch.close();
});

test("task roots on: the rules are in the instructions; the log says what is on, and warns without trusted DMs", async () => {
  const warned = await open({ BUZZ_TASK_ROOTS: "on" });
  const instructions = warned.ch.client.getInstructions();
  assert.match(instructions, /DM task roots are on\./);
  for (const n of [1, 2, 3, 4, 5, 6]) assert.ok(instructions.includes(`(${n}) `), `rule ${n}`);
  assert.match(instructions, /A done root is never reopened/);
  assert.match(instructions, /A short request \(a status, a count, a command\) is a task like any other: answer it in its thread\./);
  await waitFor(() => /BUZZ_TASK_ROOTS=on, but a top-level DM without a mention reaches the session only with/.test(warned.log()), {
    what: "the warning",
  });
  assert.match(warned.log(), /task roots on; task reactions: open ⭕, done ✅, emergency 🚨/);
  await warned.ch.close();
  const quiet = await open({ BUZZ_TASK_ROOTS: "on", BUZZ_DM_MESSAGES: "all", BUZZ_TRUSTED_PUBKEYS: operator.npub });
  assert.ok(!quiet.log().includes("BUZZ_TASK_ROOTS=on, but"), quiet.log());
  // The rules name the operator by key, and leave everyone else's DMs without states.
  const named = quiet.ch.client.getInstructions();
  assert.ok(named.includes(`from your operator (author ${operator.pubkey}), every top-level message`), named);
  assert.match(named, /In a DM with anyone else, answer in the message's thread as always, with no task states\./);
  await quiet.ch.close();
  // The operator (as the reply guard reads it) not among the trusted: warned, by key prefix.
  const other = await open({
    BUZZ_TASK_ROOTS: "on",
    BUZZ_DM_MESSAGES: "all",
    BUZZ_TRUSTED_PUBKEYS: stranger.pubkey,
    BUZZ_OPERATOR_PUBKEYS: operator.npub,
  });
  await waitFor(() => other.log().includes(`(not trusted: ${operator.pubkey.slice(0, 12)})`), { what: "the operator warning" });
  await other.ch.close();
});

test("task: sets, replaces, and refuses to reopen a done root (a tool error)", async () => {
  const { ch, chan } = await open();
  const root = message(operator.secret, { channel: chan, content: "merge the two fixes" });
  relay.publish(root);
  let r = await call(ch, "task", { channel: chan, id: root.id, state: "open" });
  assert.equal(r.isError, undefined, text(r));
  assert.equal(text(r), `${root.id.slice(0, 8)}: none -> open`);
  r = await call(ch, "task", { channel: chan, id: root.id, state: "done" });
  assert.equal(text(r), `${root.id.slice(0, 8)}: open -> done`);
  const mine = relay.stored().filter((e) => e.kind === 7 && e.pubkey === agent.pubkey && e.tags.some((t) => t[1] === root.id));
  assert.deepEqual(
    mine.map((e) => e.content),
    ["✅"],
  );
  r = await call(ch, "task", { channel: chan, id: root.id, state: "open" });
  assert.equal(r.isError, true);
  assert.match(text(r), /never reopened: post a new root/);
  r = await call(ch, "task", { channel: chan, id: "not-an-id", state: "open" });
  assert.equal(r.isError, true);
  assert.match(text(r), /id must be a message's event id/);
  await ch.close();
});

test("task_list: the channels it listens in by default; text only for its own and trusted roots", async () => {
  const { ch, chan } = await open({ BUZZ_TRUSTED_PUBKEYS: operator.pubkey });
  const theirs = message(operator.secret, { channel: chan, content: "status of the build?" });
  const odd = message(stranger.secret, { channel: chan, content: "a stranger's words" });
  relay.publish(theirs);
  relay.publish(odd);
  await call(ch, "task", { channel: chan, id: theirs.id, state: "open" });
  await call(ch, "task", { channel: chan, id: odd.id, state: "open" });
  const r = await call(ch, "task_list", {});
  assert.equal(r.isError, undefined, text(r));
  const lines = text(r).split("\n").sort();
  assert.deepEqual(lines, [
    `- ⭕ open channel=${chan} id=${odd.id}: (text not shown: someone else's root)`,
    `- ⭕ open channel=${chan} id=${theirs.id}: status of the build?`,
  ].sort());
  const other = await call(ch, "task_list", { channel: randomUUID() });
  assert.equal(text(other), "none open");
  await ch.close();
});

test("a bad emoji setting never stops the channel: the tools say why, and so does the log", async () => {
  const { ch, chan, log } = await open({ BUZZ_TASK_OPEN_EMOJI: "open-loop" });
  const r = await call(ch, "task", { channel: chan, id: "ab".repeat(32), state: "open" });
  assert.equal(r.isError, true);
  assert.match(text(r), /the task tools are off: BUZZ_TASK_OPEN_EMOJI names a custom emoji/);
  assert.match(log(), /task roots off; the task tools are off: BUZZ_TASK_OPEN_EMOJI names a custom emoji/);
  await ch.close();
});

test("a bad task roots switch stops the channel at start, with a fixed message", () => {
  const dir = tempDir("task-tools-bad");
  for (const [env, why] of [[{ BUZZ_TASK_ROOTS: "yes" }, /BUZZ_TASK_ROOTS must be on or off/]]) {
    const r = spawnSync(process.execPath, [LAUNCH, "channel"], {
      input: "",
      encoding: "utf8",
      timeout: 30_000,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        BUZZ_RELAY_URL: relay.url,
        BUZZ_KEY_COMMAND: `printf %s ${agent.hex}`,
        BUZZ_CHANNELS: randomUUID(),
        BUZZ_STATE_DIR: join(dir, "state"),
        BUZZ_LOG_FILE: join(dir, "channel.log"),
        ...env,
      },
    });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, why);
    assert.ok(!r.stderr.includes(agent.hex));
  }
});
