// The status line in the real channel, against the fake relay: off by
// default; on only for the instance's own session; the line and presence it
// publishes; that no message text ever reaches them (a DM's, a private
// channel's); the `status` and `agent_status` tools; the one-shot
// `launch.mjs status read`; and the unattended-deny wait. The parts alone
// are test/status-unit.test.mjs.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { message, startFakeRelay } from "./fake-relay.mjs";
import { ADAPTER, closeAll, identity, LAUNCH, startChannel, tempDir, waitFor } from "./helpers.mjs";

const agent = identity();
const partner = identity(); // the operator: trusted, in a one-to-one DM with the agent
const reader = identity(); // another member, who reads the line
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const relays = [];
after(async () => {
  await closeAll();
  for (const r of relays) await r.close();
});

async function relayWith(options) {
  const relay = await startFakeRelay(options);
  relays.push(relay);
  return relay;
}

const FAST = {
  BUZZ_STATUS_SETTLE_MS: "100",
  BUZZ_STATUS_GAP_MS: "300",
  BUZZ_STATUS_PRESENCE_MS: "200",
  BUZZ_STATUS_POLL_MS: "50",
  BUZZ_ROOMS_REFRESH_MS: "300",
};

/** The agent's channel as an instance's session: GP_INSTANCE_NAME, its state folder, and (own) start's pane-pid naming its launcher. */
async function agentChannel(relay, { channels = "*", env = {}, own = true, status = "on", instance = true } = {}) {
  const dir = tempDir("status");
  const xdg = join(dir, "xdg");
  const inst = join(xdg, "ghost-protocol", "t-agent");
  mkdirSync(inst, { recursive: true });
  const full = {
    BUZZ_CHANNELS: channels,
    BUZZ_STATE_DIR: join(dir, "state"),
    BUZZ_LOG_FILE: join(dir, "channel.log"),
    XDG_STATE_HOME: xdg,
    ...(status ? { BUZZ_STATUS: status } : {}),
    ...(instance ? { GP_INSTANCE_NAME: "t-agent" } : {}),
    ...FAST,
    ...env,
  };
  const ch = await startChannel({ relayUrl: relay.url, key: agent, env: full });
  if (own) writeFileSync(join(inst, "pane-pid"), `${ch.pid}\n`);
  return { ch, inst, env: full, log: () => readFileSync(full.BUZZ_LOG_FILE, "utf8"), turn: (word) => writeFileSync(join(inst, "turn"), `${word} p-${randomUUID()}\n`) };
}

const ofAgent = (relay, kind) => relay.stats.events.filter((e) => e.pubkey === agent.pubkey && e.kind === kind);
const lines = (relay) => ofAgent(relay, 30315).map((e) => e.content);
const lastLine = (relay) => lines(relay).at(-1);
const waitLine = (relay, want, what = want) => waitFor(() => lastLine(relay) === want, { timeout: 8000, what: `the line ${what}` });
const toolNames = async (ch) => (await ch.client.listTools()).tools.map((t) => t.name);
const callTool = (ch, name, args = {}) => ch.client.callTool({ name, arguments: args });

/** A command run without blocking this process (which serves the fake relay). */
function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("exit", (status) => resolve({ status, stdout, stderr }));
  });
}

/** A room the agent is in: an open channel, a private one, or a one-to-one DM with the partner. As Buzz does, an open channel's metadata says ["public"], any other ["private"]. */
function room(relay, { type = "stream", visibility = type === "dm" ? "private" : "public" } = {}) {
  const id = randomUUID();
  const members = [agent.pubkey, partner.pubkey];
  relay.metadata(id, { type, visibility, members: type === "dm" ? members : [] });
  relay.roster(id, members);
  return id;
}

test("off by default: no line, no presence, and only the task tools", async () => {
  const relay = await relayWith();
  const D = room(relay, { type: "dm" });
  const a = await agentChannel(relay, { status: null, env: { BUZZ_DM_MESSAGES: "all", BUZZ_TRUSTED_PUBKEYS: partner.npub } });
  await waitFor(() => relay.latestSubscription()?.direct.length === 1, { what: "the DM filter" });
  relay.publish(message(partner.secret, { channel: D, content: "a DM" }));
  await waitFor(() => a.ch.received.length === 1, { what: "the DM" });
  a.turn("busy");
  await pause(800);
  assert.deepEqual([ofAgent(relay, 30315).length, ofAgent(relay, 20001).length], [0, 0]);
  assert.deepEqual(await toolNames(a.ch), ["task", "task_list"]);
  assert.doesNotMatch(a.log(), /status line on/);
});

test("on, but not an instance's session (no GP_INSTANCE_NAME): nothing published, and the log says why", async () => {
  const relay = await relayWith();
  const a = await agentChannel(relay, { instance: false });
  await waitFor(() => relay.stats.auths > 0, { what: "the login" });
  await pause(800);
  assert.deepEqual([ofAgent(relay, 30315).length, ofAgent(relay, 20001).length], [0, 0]);
  assert.match(a.log(), /not an instance that install\/service\/start runs/);
  assert.deepEqual(await toolNames(a.ch), ["task", "task_list", "agent_status"], "the read still works");
});

test("on, in a session that is not the instance's own claude: nothing published, and said once", async () => {
  const relay = await relayWith();
  const a = await agentChannel(relay, { own: false });
  // start's pane-pid names the claude above it, but a claude (here: a process
  // named as that one is) comes first: as for a `claude -p` the agent runs.
  writeFileSync(join(a.inst, "pane-pid"), `${process.pid}\n`);
  await waitFor(() => relay.stats.auths > 0, { what: "the login" });
  a.turn("busy");
  await pause(1000);
  assert.deepEqual([ofAgent(relay, 30315).length, ofAgent(relay, 20001).length], [0, 0]);
  assert.equal(a.log().split("not the instance's own claude").length - 1, 1);
});

test("on: idle at login with presence online; working on a delivery; idle when the turn ends", async () => {
  const relay = await relayWith();
  const C = room(relay);
  const a = await agentChannel(relay);
  await waitLine(relay, "idle");
  await waitFor(() => relay.presence().get(agent.pubkey) === "online", { what: "presence online" });
  const p = ofAgent(relay, 20001)[0];
  assert.deepEqual([p.content, p.tags], ["online", []], "Buzz's app's shape: the status in the content");
  const first = ofAgent(relay, 30315)[0];
  assert.deepEqual(first.tags, [["d", "general"]]);
  await waitFor(() => relay.latestSubscription()?.mentions.includes(C), { what: "the room" });
  const m = message(partner.secret, { channel: C, mention: agent.pubkey, content: "please look" });
  relay.publish(m);
  a.turn("busy");
  await waitLine(relay, `working | task: task ${m.id.slice(0, 8)}`);
  const working = ofAgent(relay, 30315).at(-1);
  assert.equal(Number(working.tags.find((t) => t[0] === "expiration")[1]), working.created_at + 1800);
  a.turn("idle");
  await waitLine(relay, "idle");
  assert.ok(a.log().includes("status line on"));
});

test("no message text reaches the line: a DM's or a private channel's, whatever it says", async () => {
  const relay = await relayWith();
  const D = room(relay, { type: "dm" });
  const P = room(relay, { visibility: "private" });
  const a = await agentChannel(relay, { env: { BUZZ_DM_MESSAGES: "all", BUZZ_TRUSTED_PUBKEYS: partner.npub } });
  await waitLine(relay, "idle");
  await waitFor(() => relay.latestSubscription()?.direct.includes(D) && relay.latestSubscription()?.mentions.includes(P), { what: "the rooms" });
  const words = {
    dm: "status: working | task: Example Customer Ltd at 12 Harbour Road, token TOKEN-DMSECRET",
    private: "working | task: tenant acme /srv/tenants/acme/secrets PRIVSECRET | waits on: the client",
  };
  const dm = message(partner.secret, { channel: D, content: words.dm });
  relay.publish(dm);
  a.turn("busy");
  await waitLine(relay, "working", "for the DM");
  const reply = message(partner.secret, { channel: D, content: `${words.dm} (again, in its thread)`, tags: [["e", dm.id, "", "root"], ["e", dm.id, "", "reply"]] });
  relay.publish(reply);
  const priv = message(partner.secret, { channel: P, mention: agent.pubkey, content: words.private });
  relay.publish(priv);
  await waitFor(() => a.ch.received.length === 3, { what: "the three messages" });
  await pause(800);
  a.turn("idle");
  await waitLine(relay, "idle");
  await pause(400);
  const out = [...ofAgent(relay, 30315), ...ofAgent(relay, 20001)].map((e) => JSON.stringify([e.content, e.tags]));
  for (const secret of ["Customer", "Harbour", "DMSECRET", "TOKEN", "acme", "/srv", "PRIVSECRET", "client"]) {
    assert.ok(out.every((t) => !t.includes(secret)), `${secret} in ${out.join("\n")}`);
  }
  assert.deepEqual(
    [...new Set(lines(relay))].sort(),
    ["idle", "working"],
    "only fixed words: a DM's or a private channel's work shows no root id either",
  );
});

test("with no task named: a DM's and a private channel's work is plain working; a public channel's thread shows its root id", async () => {
  const relay = await relayWith();
  // A DM is never counted public, even when its metadata says ["public"].
  const D = room(relay, { type: "dm", visibility: "public" });
  const P = room(relay, { visibility: "private" });
  const O = room(relay);
  const a = await agentChannel(relay, { env: { BUZZ_DM_MESSAGES: "all", BUZZ_TRUSTED_PUBKEYS: partner.npub } });
  await waitLine(relay, "idle");
  await waitFor(() => relay.latestSubscription()?.direct.includes(D) && relay.latestSubscription()?.mentions.includes(P), { what: "the rooms" });
  const seen = () => a.ch.received.length;
  const turnOn = async (event, what) => {
    const n = seen();
    relay.publish(event);
    await waitFor(() => seen() === n + 1, { what });
    a.turn("busy");
  };
  const turnOff = async () => {
    a.turn("idle");
    await waitLine(relay, "idle");
  };
  const dm = message(partner.secret, { channel: D, content: "a DM" });
  await turnOn(dm, "the DM");
  await waitLine(relay, "working", "for the DM");
  await pause(500);
  await turnOff();
  const priv = message(partner.secret, { channel: P, mention: agent.pubkey, content: "in a private channel" });
  await turnOn(priv, "the private channel's message");
  await waitLine(relay, "working", "for the private channel");
  await pause(500);
  await turnOff();
  const root = message(partner.secret, { channel: O, content: "a public root" });
  relay.publish(root);
  const inThread = message(partner.secret, { channel: O, mention: agent.pubkey, content: "in its thread", tags: [["e", root.id, "", "root"], ["e", root.id, "", "reply"]] });
  await turnOn(inThread, "the public thread's reply");
  await waitLine(relay, `working | task: task ${root.id.slice(0, 8)}`, "for the public channel's thread");
  await turnOff();
  assert.ok(
    lines(relay).every((l) => !l.includes(dm.id.slice(0, 8)) && !l.includes(priv.id.slice(0, 8))),
    `no DM or private root id in ${lines(relay).join(" ; ")}`,
  );
});

test("the status tool names the task and the wait; agent_status and `launch.mjs status read` read them back", async () => {
  const relay = await relayWith();
  const a = await agentChannel(relay, { env: { BUZZ_STATUS_AGENTS: reader.npub } });
  await waitLine(relay, "idle");
  assert.deepEqual(await toolNames(a.ch), ["task", "task_list", "status", "agent_status"]);
  const tool = (await a.ch.client.listTools()).tools.find((t) => t.name === "status");
  for (const rule of ["issue id", "customer's name", "an address", "a secret", "a path under a customer's tenant", "every member of the relay"]) {
    assert.ok(tool.description.includes(rule), `the description says: ${rule}`);
  }
  a.turn("busy");
  await waitLine(relay, "working");
  const r = await callTool(a.ch, "status", { task: "#42 fix the\nlogin | timeout" });
  assert.match(r.content[0].text, /^working \| task: #42 fix the login \/ timeout\n/);
  await waitLine(relay, "working | task: #42 fix the login / timeout");
  await callTool(a.ch, "status", { waits_on: "the operator's yes" });
  a.turn("idle");
  const want = "waiting | task: #42 fix the login / timeout | waits on: the operator's yes";
  await waitLine(relay, want);
  assert.equal((await callTool(a.ch, "status", {})).isError, true, "nothing to set");
  for (const [args, want] of [
    [{ task: `#1 ${"9f".repeat(32)}` }, /^task refused: it looks like a key; .*Nothing was changed\.$/],
    [{ task: "#1 see /home/agent/notes" }, /^task refused: it looks like a path/],
    [{ waits_on: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, /^waits_on refused: it looks like a token/],
  ]) {
    const no = await callTool(a.ch, "status", args);
    assert.equal(no.isError, true, JSON.stringify(args));
    assert.match(no.content[0].text, want);
    assert.equal(no.content[0].text.split("\n").length, 1, "a one-line refusal");
  }
  await pause(600);
  assert.equal(lastLine(relay), want, "a refused call changes nothing");

  const read = await callTool(a.ch, "agent_status");
  const rows = read.content[0].text.split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(
    rows.map((x) => x.pubkey),
    [reader.pubkey, agent.pubkey],
    "BUZZ_STATUS_AGENTS, then the agent itself",
  );
  const own = rows[1];
  assert.deepEqual(
    { line: own.line, state: own.state, task: own.task, waits_on: own.waits_on, expired: own.expired, presence: own.presence },
    { line: want, state: "waiting", task: "#42 fix the login / timeout", waits_on: "the operator's yes", expired: false, presence: "online" },
  );
  assert.equal(own.expires_at, own.set_at + 1800);
  assert.deepEqual([rows[0].state, rows[0].presence], ["none", "offline"]);
  const proof = relay.stats.httpQueries.at(-1);
  assert.match(String(proof.headers.authorization), /^Nostr /, "the presence read is NIP-98 signed");

  const readerEnv = { PATH: process.env.PATH, HOME: process.env.HOME, BUZZ_RELAY_URL: relay.url, BUZZ_KEY_COMMAND: `printf %s ${reader.hex}` };
  const cli = await run(process.execPath, [LAUNCH, "status", "read", "--agent", agent.npub], readerEnv);
  assert.equal(cli.status, 0, cli.stderr);
  const row = JSON.parse(cli.stdout.trim());
  assert.deepEqual(row, { ...own, name: null }, "the same row from another member's key");
  const usage = await run(process.execPath, [LAUNCH, "status", "nope"], readerEnv);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /usage: status read/);
});

test("a task set done clears the task and its wait; a clean stop sends presence offline", async () => {
  const relay = await relayWith();
  const C = room(relay);
  const a = await agentChannel(relay);
  await waitLine(relay, "idle");
  await waitFor(() => relay.latestSubscription()?.mentions.includes(C), { what: "the room" });
  const m = message(partner.secret, { channel: C, mention: agent.pubkey, content: "a task" });
  relay.publish(m);
  a.turn("busy");
  await waitLine(relay, `working | task: task ${m.id.slice(0, 8)}`);
  await callTool(a.ch, "status", { task: "#9 tidy", waits_on: "a review" });
  a.turn("idle");
  await waitLine(relay, "waiting | task: #9 tidy | waits on: a review");
  const done = await callTool(a.ch, "task", { channel: C, id: m.id, state: "done" });
  assert.equal(done.isError, undefined, JSON.stringify(done));
  await waitLine(relay, "idle", "idle after done");
  await a.ch.close();
  await waitFor(() => ofAgent(relay, 20001).some((e) => e.content === "offline"), { what: "presence offline" });
  await waitFor(() => !relay.presence().has(agent.pubkey), { what: "no presence held" });
});

test("the unattended-deny hook's refusal: waiting for a person, until the next turn; only from the instance's own claude", async () => {
  const relay = await relayWith();
  const a = await agentChannel(relay);
  await waitLine(relay, "idle");
  a.turn("busy");
  await waitLine(relay, "working");
  const denyHook = () =>
    spawnSync(join(ADAPTER, "hooks", "unattended-deny"), [], {
      input: "{}",
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GP_UNATTENDED: "1", GP_INSTANCE_NAME: "t-agent", XDG_STATE_HOME: a.env.XDG_STATE_HOME },
      encoding: "utf8",
    });
  // Not the instance's own claude: pane-pid names the channel's launcher, and
  // the hook's parent (this process, a node as that one is) comes first, as a
  // `claude -p` the agent runs would. It still denies, but leaves no wait.
  const other = denyHook();
  assert.equal(other.status, 0);
  assert.equal(JSON.parse(other.stdout).hookSpecificOutput.decision.behavior, "deny", "a claude -p's dialog is denied too");
  assert.equal(other.stderr, "");
  assert.ok(!existsSync(join(a.inst, "status-wait")), "no wait from a claude that is not the instance's own");
  // The instance's own claude: the hook's parent is the pid in pane-pid. (The
  // channel's own check runs at its next flush, after pane-pid is put back.)
  const panePid = readFileSync(join(a.inst, "pane-pid"), "utf8");
  writeFileSync(join(a.inst, "pane-pid"), `${process.pid}\n`);
  const hook = denyHook();
  writeFileSync(join(a.inst, "pane-pid"), panePid);
  assert.equal(hook.status, 0);
  assert.equal(JSON.parse(hook.stdout).hookSpecificOutput.decision.behavior, "deny", "its answer is unchanged");
  assert.equal(hook.stderr, "");
  assert.match(readFileSync(join(a.inst, "status-wait"), "utf8"), /^deny [0-9]+\n$/);
  a.turn("idle");
  await waitLine(relay, "waiting | waits on: a person to allow a step");
  a.turn("busy");
  await waitLine(relay, "working");
  a.turn("idle");
  await waitLine(relay, "idle");
  const noInstance = spawnSync(join(ADAPTER, "hooks", "unattended-deny"), [], {
    input: "{}",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, GP_UNATTENDED: "1", GP_INSTANCE_NAME: "../x", XDG_STATE_HOME: a.env.XDG_STATE_HOME },
    encoding: "utf8",
  });
  assert.equal(noInstance.status, 0);
  assert.equal(noInstance.stderr, "");
});

test("a key service: the pipe says the setting has no effect; the served channel keeps it off and says why", async () => {
  const relay = await relayWith();
  const pipe = spawnSync(process.execPath, [LAUNCH, "channel"], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, BUZZ_KEY_SOCKET: tempDir("sock"), BUZZ_KEY_SOCKET_WAIT_MS: "100", BUZZ_STATUS: "on" },
    input: "",
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.match(pipe.stderr, /BUZZ_STATUS=on has no effect with a key service/);

  const dir = tempDir("served");
  const xdg = join(dir, "xdg");
  mkdirSync(join(xdg, "ghost-protocol", "t-agent"), { recursive: true });
  // As `launch.mjs serve channel` runs it: in-process, with the key service's mark.
  const code = `globalThis[Symbol.for("ghost-protocol.buzz.key-service")] = true; await import(${JSON.stringify(join(ADAPTER, "src", "channel.mjs"))});`;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "-e", code],
    env: { BUZZ_PRIVATE_KEY: agent.hex, BUZZ_RELAY_URL: relay.url, BUZZ_CHANNELS: "*", BUZZ_STATUS: "on", GP_INSTANCE_NAME: "t-agent", XDG_STATE_HOME: xdg, BUZZ_STATE_DIR: join(dir, "state"), BUZZ_LOG_FILE: join(dir, "channel.log"), ...FAST },
    stderr: "pipe",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  writeFileSync(join(xdg, "ghost-protocol", "t-agent", "pane-pid"), `${transport.pid}\n`);
  await waitFor(() => relay.stats.auths > 0, { what: "the login" });
  await pause(800);
  assert.deepEqual([ofAgent(relay, 30315).length, ofAgent(relay, 20001).length], [0, 0]);
  assert.match(readFileSync(join(dir, "channel.log"), "utf8"), /runs in a key service/);
  await client.close();
});
