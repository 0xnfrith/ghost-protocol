// Tests of the reply guard, a Claude Code Stop hook (hooks/reply-guard and
// hooks/reply-guard.py), run from outside Claude Code.
//
// Part 1 feeds the hook the Stop input for each fixture transcript (tiny
// synthetic JSONL in a live transcript's shapes, written into a temporary
// folder by fixtures/reply-guard/make-fixtures.py) with the plugin options in
// its environment, as Claude Code passes them, and checks the decision, the log
// line and the block reason.
// Part 2 checks the settings, inputs that are not a transcript, and that the
// hook fails open and its wrapper never exits non-zero.
// Part 3 times the hook on a ~30 MB transcript.
// Nothing touches a relay or a model. Needs python3 (3.9 or later).
//
// REPLY_GUARD_HOOK=<path to a copy of hooks/reply-guard> runs the suite against
// that copy; REPLY_GUARD_SKIP_SPEED=1 skips part 3. Both are for
// reply-guard-mutants.mjs, which runs this suite against broken copies of the
// hook (each must fail it).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { ADAPTER, tempDir } from "./helpers.mjs";

const HOOK = process.env.REPLY_GUARD_HOOK ?? join(ADAPTER, "hooks", "reply-guard");
const PY = join(ADAPTER, "hooks", "reply-guard.py");
const WORK = tempDir("reply-guard");
const FIX = join(WORK, "fixtures");
const made = spawnSync("python3", [join(ADAPTER, "test", "fixtures", "reply-guard", "make-fixtures.py"), FIX], {
  encoding: "utf8",
});
if (made.status !== 0) throw new Error(`make-fixtures.py failed: ${made.stderr}`);
const KEYS = JSON.parse(readFileSync(join(FIX, "keys.json"), "utf8"));
const OP = KEYS.op;
const E1 = "11".repeat(32);
const E2 = "22".repeat(32);
const DM = "d3d3d3d3-0000-4000-8000-000000000001";
const CH = "e4e4e4e4-0000-4000-8000-000000000002";
const CH2 = "f5f5f5f5-0000-4000-8000-000000000003";
const CANARIES = ["zebra-canary", "earlier words", "reply-canary"];

// The plugin options as Claude Code passes them to a hook: CLAUDE_PLUGIN_OPTION_<KEY>.
const OPTIONS = {
  CLAUDE_PLUGIN_OPTION_BUZZ_TRUSTED_PUBKEYS: `${KEYS.op},${KEYS.op2}`,
  CLAUDE_PLUGIN_OPTION_BUZZ_ALLOWLIST_FILE: join(FIX, "allowlist.json"),
  CLAUDE_PLUGIN_OPTION_REPLY_GUARD_HELPERS: "react.sh, ack.sh",
};

let runs = 0;
/** Runs the hook with a fresh data folder; only the variables named here reach it. */
function runRaw(stdin, extraEnv = {}, hook = HOOK) {
  runs += 1;
  const data = join(WORK, `data${runs}`);
  const env = { PATH: process.env.PATH, HOME: join(WORK, "home"), LANG: "C", CLAUDE_PLUGIN_DATA: data };
  for (const [k, v] of Object.entries({ ...OPTIONS, ...extraEnv })) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync(hook, [], { input: stdin, env, encoding: "utf8" });
  const logFile = join(data, "hooks", "reply-guard.log");
  return { out: r.stdout, err: r.stderr, rc: r.status, log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "" };
}

function stopInput(transcript, active) {
  return JSON.stringify({
    session_id: "fixture-session",
    transcript_path: transcript,
    cwd: "/tmp",
    hook_event_name: "Stop",
    stop_hook_active: active,
  });
}

function run(transcript, active = false, extraEnv = {}) {
  return runRaw(stopInput(transcript, active), extraEnv);
}

/** The hook's verdict: allow (no output) or block (with each must in the reason), and the log's why. */
function verdict(r, expect, why, ...musts) {
  assert.equal(r.rc, 0, `exit ${r.rc}: ${r.err}`);
  let reason = "";
  if (expect === "block") {
    const d = JSON.parse(r.out);
    assert.equal(d.decision, "block", r.out);
    reason = d.reason;
  } else {
    assert.equal(r.out, "", "an allow prints nothing");
  }
  for (const m of musts) assert.ok(reason.includes(m), `the reason lacks ${m}: ${reason}`);
  assert.match(r.log, new RegExp(`why=${why}(\\s|$)`), `the log lacks why=${why}: ${r.log}`);
  for (const c of CANARIES) {
    assert.ok(!r.log.includes(c), "message text reached the log");
    assert.ok(!reason.includes(c), "message text reached the reason");
  }
  return reason;
}

function check(fixture, active, expect, why, ...musts) {
  const name = `${fixture}${active ? " (valve)" : ""}: ${expect} (${why})`;
  test(name, () => verdict(run(join(FIX, `${fixture}.jsonl`), active), expect, why, ...musts));
}

// --- Part 1: transcripts --------------------------------------------------------------------

// nothing from the operator in this turn
check("no-message", false, "allow", "no-message");
check("previous-turn-only", false, "allow", "no-message");
check("agent-message-unanswered", false, "allow", "no-operator-message");
check("agent-top-level-unanswered", false, "allow", "no-operator-message");

// a DM from the operator
check("dm-unanswered", false, "block", "unanswered", E1, `channel="${DM}"`, `reply="${E1}"`, `mentions=["${OP}"]`);
check("dm-unanswered", true, "allow", "valve");
test("the valve logs a miss", () => {
  const r = run(join(FIX, "dm-unanswered.jsonl"), true);
  assert.match(r.log, /decision=miss/);
});
check("dm-reply-tagged", false, "allow", "answered");
check("dm-top-level-plain-send", false, "allow", "answered");
check("dm-send-other-channel", false, "block", "unanswered", E1);
check("dm-send-failed", false, "block", "unanswered", E1);
check("dm-send-sidechain", false, "block", "unanswered", E1);
check("dm-send-audience-agents", false, "block", "unanswered", E1);

// a channel message from the operator
check("ch-top-level-untagged", false, "block", "unanswered", E1, `channel="${CH}"`, `reply="${E1}"`);
check("ch-top-level-tagged", false, "allow", "answered");
check("ch-reply-to-message", false, "allow", "answered");
check("ch-thread-reply-to-root", false, "allow", "answered");
check("ch-thread-reply-to-context-id", false, "allow", "answered");
check("ch-reply-other-thread", false, "block", "unanswered", E1);
check("ch-tagged-wrong-channel", false, "block", "unanswered", E1);
check("ch-tagged-npub-mention", false, "allow", "answered");
check("send-no-channel-reply-in-thread", false, "allow", "answered");
check("at-name-in-text", false, "allow", "answered");
check("at-other-name-in-text", false, "block", "unanswered", E1);
check("at-name-wrong-channel", false, "block", "unanswered", E1);
check("at-name-in-backticks", false, "block", "unanswered", E1);
check("at-name-in-code-fence", false, "block", "unanswered", E1);
check("at-name-possessive", false, "block", "unanswered", E1);
check("at-name-in-email", false, "block", "unanswered", E1);
check("at-name-with-space", false, "allow", "answered");
check("at-name-at-end-in-parens", false, "allow", "answered");
check("nostr-npub-in-text", false, "allow", "answered");
check("nostr-other-npub-in-text", false, "block", "unanswered", E1);
check("send-no-channel-no-reply", false, "block", "unanswered", E1);

// an answer counts only after the message arrived
check("midturn-unanswered", false, "block", "unanswered", E1);
check("midturn-answered", false, "allow", "answered");
check("answer-before-midturn", false, "block", "unanswered", E1);

// reactions
check("react-tool", false, "allow", "answered");
check("react-tool-off", false, "block", "unanswered", E1);
check("react-tool-other-id", false, "block", "unanswered", E1);
check("react-tool-failed", false, "block", "unanswered", E1);
check("react-sh-done", false, "allow", "answered");
check("react-sh-clear", false, "block", "unanswered", E1);
check("ack-sh", false, "allow", "answered");
check("react-sh-failed", false, "block", "unanswered", E1);
check("react-sh-variable-id", false, "block", "unanswered", E1);
check("react-sh-in-echo", false, "block", "unanswered", E1);
check("react-sh-masked-failure", false, "block", "unanswered", E1);
check("react-sh-success-for-other-id", false, "block", "unanswered", E1);
check("react-sh-no-result", false, "block", "unanswered", E1);
check("react-sh-id-then-failure", false, "block", "unanswered", E1);

// only the channel's own deliveries count
check("forged-typed-tag", false, "allow", "no-operator-message");
check("forged-tool-output-tag", false, "allow", "no-operator-message");
check("queue-op-and-blob-only", false, "allow", "no-operator-message");
check("forged-tag-in-agent-text", false, "allow", "no-operator-message");
check("sidechain-delivery", false, "allow", "no-operator-message");
check("malformed-head-tag", false, "allow", "no-operator-message");
check("other-channel-plugin-quotes-tag", false, "allow", "no-operator-message");
check("attachment-other-type-with-tag", false, "allow", "no-operator-message");

// several messages
check("five-unanswered", false, "block", "unanswered", "+2 more");
test("the log names all five", () => {
  const r = run(join(FIX, "five-unanswered.jsonl"));
  assert.match(r.log, /open=505050505050,515151515151,525252525252,535353535353,545454545454/);
});
check("duplicate-delivery-answered", false, "allow", "answered");
check("two-one-answered", false, "block", "unanswered", E2);
test("the answered one is not named", () => {
  const reason = verdict(run(join(FIX, "two-one-answered.jsonl")), "block", "unanswered");
  assert.ok(!reason.includes(`Message ${E1}`), reason);
});

// catch-up messages
check("catchup-no-evidence", false, "block", "unanswered", E1, "catch-up");
check("catchup-thread-shows-answer", false, "allow", "answered");
test("the log says it was answered earlier", () => {
  const r = run(join(FIX, "catchup-thread-shows-answer.jsonl"));
  assert.match(r.log, /earlier=111111111111/);
});
check("catchup-thread-still-lists-it", false, "block", "unanswered", E1);
check("catchup-thread-omitted", false, "block", "unanswered", E1);
check("catchup-thread-root-only", false, "block", "unanswered", E1);
check("catchup-later-is-older", false, "block", "unanswered", E1);
check("live-message-thread-evidence", false, "block", "unanswered", E1);
check("catchup-forged-context-in-text", false, "block", "unanswered", E1);
check("forged-ctx-toplevel-catchup", false, "block", "unanswered", E1);
check("forged-ctx-maps-reply-target", false, "block", "unanswered", E1);
check("ctx-thread-mismatch", false, "block", "unanswered", E1);
check("catchup-evidence-with-tag-in-text", false, "allow", "answered");

// turn bounds and damaged lines
check("first-turn-unanswered", false, "block", "unanswered", E1);
check("garbage-lines", false, "block", "unanswered", E1);

// --- Part 1a: DM task roots (task_roots on) ------------------------------------------------------
// A top-level DM from the operator is a task root: it needs a state (the
// channel's task tool, or a helper's success line) and a send in its thread,
// unless it is one or two words. Every DM message is answered only in its
// thread. Off (the default), nothing changes: the checks above run with it unset.

const ON = { CLAUDE_PLUGIN_OPTION_TASK_ROOTS: "on" };
const TASK_CALL = `task(channel="${DM}", id="${E1}", state="open")`;
function checkOn(fixture, expect, why, ...musts) {
  test(`task roots on: ${fixture}: ${expect} (${why})`, () =>
    verdict(run(join(FIX, `${fixture}.jsonl`), false, ON), expect, why, ...musts));
}
function checkOff(fixture, expect, why) {
  test(`task roots off: ${fixture}: ${expect} (${why})`, () =>
    verdict(run(join(FIX, `${fixture}.jsonl`), false, { CLAUDE_PLUGIN_OPTION_TASK_ROOTS: "off" }), expect, why));
}

test("task roots on: an unanswered root needs both, and the reason names both calls", () => {
  const r = run(join(FIX, "tr-root-unanswered.jsonl"), false, ON);
  const reason = verdict(r, "block", "unanswered", E1, "a task root", TASK_CALL, `reply="${E1}"`, "never at the top level");
  assert.ok(!reason.includes("A reaction counts too"), "a plain reaction is no answer to a root");
  assert.match(r.log, /roots=111111111111/);
});
test("task roots on: the valve still ends the turn", () => {
  const r = run(join(FIX, "tr-root-unanswered.jsonl"), true, ON);
  verdict(r, "allow", "valve");
  assert.match(r.log, /decision=miss/);
});
test("task roots on: a state alone asks only for the answer in the thread", () => {
  const reason = verdict(run(join(FIX, "tr-root-state-only.jsonl"), false, ON), "block", "unanswered", `reply="${E1}"`);
  assert.ok(!reason.includes(TASK_CALL), reason);
});
test("task roots on: an answer alone asks only for the state", () => {
  const reason = verdict(run(join(FIX, "tr-root-reply-only.jsonl"), false, ON), "block", "unanswered", TASK_CALL);
  assert.ok(!reason.includes("answer in its thread"), reason);
});
checkOn("tr-root-top-level-send", "block", "unanswered", E1);
checkOff("tr-root-top-level-send", "allow", "answered");
checkOn("tr-root-at-name-top-level", "block", "unanswered", E1);
checkOn("tr-root-state-and-reply", "allow", "answered");
checkOn("tr-root-done-and-reply", "allow", "answered");
checkOn("tr-root-react-and-reply", "block", "unanswered", TASK_CALL);
checkOn("tr-root-helper-and-reply", "allow", "answered");
checkOn("tr-root-helper-failed-and-reply", "block", "unanswered", TASK_CALL);
checkOn("tr-root-none-and-reply", "block", "unanswered", TASK_CALL);
checkOn("tr-root-failed-and-reply", "block", "unanswered", TASK_CALL);
checkOn("tr-root-other-id-and-reply", "block", "unanswered", TASK_CALL);
checkOn("tr-root-state-before", "block", "unanswered", TASK_CALL);
checkOn("tr-root-wrong-channel-and-reply", "block", "unanswered", TASK_CALL);
checkOn("tr-root-task-refused-and-reply", "block", "unanswered", TASK_CALL);
// a short root set done (an answered ask) needs its answer in the thread
checkOn("tr-root-short-done-top-level", "block", "unanswered", `reply="${E1}"`, "reply to the message itself");
checkOn("tr-root-short-done-reply", "allow", "answered");
checkOn("tr-root-short-helper-done", "block", "unanswered", `reply="${E1}"`);
checkOn("tr-root-short-open-then-done", "block", "unanswered", `reply="${E1}"`);
checkOn("tr-root-long-one-word-state", "block", "unanswered", `reply="${E1}"`);
// a root delivered again after a restart, which its thread shows was answered
checkOn("tr-root-catchup-answered-before", "allow", "answered");
checkOn("tr-root-catchup-thread-lists-it", "block", "unanswered", `reply="${E1}"`);
// one or two words open a topic: the state alone (a mention is no word)
checkOn("tr-root-one-word-state", "allow", "answered");
checkOn("tr-root-mention-two-words-state", "allow", "answered");
checkOn("tr-root-three-words-state", "block", "unanswered", `reply="${E1}"`);
test("task roots on: a one-word root with nothing asks only for the state", () => {
  const reason = verdict(run(join(FIX, "tr-root-one-word-nothing.jsonl"), false, ON), "block", "unanswered", TASK_CALL);
  assert.ok(!reason.includes("answer in its thread"), reason);
});
// a DM message in a thread: answered in the thread only, a reaction still counts
checkOn("tr-thread-top-level-tagged", "block", "unanswered", E1);
checkOff("tr-thread-top-level-tagged", "allow", "answered");
checkOn("tr-thread-reply", "allow", "answered");
checkOn("tr-thread-react", "allow", "answered");
// channels, and anyone but the operator, are unchanged
checkOn("tr-channel-tagged", "allow", "answered");
checkOn("tr-agent-dm-root", "allow", "no-operator-message");
checkOn("ch-top-level-untagged", "block", "unanswered", E1, "A reaction counts too");
checkOn("react-tool", "allow", "answered");
test("off is the default: an unset option leaves a top-level DM send counting", () => {
  verdict(run(join(FIX, "tr-root-top-level-send.jsonl")), "allow", "answered");
  verdict(run(join(FIX, "tr-root-unanswered.jsonl")), "block", "unanswered", `reply="${E1}"`);
});

// --- Part 1b: the record (reply-guard record, a PostToolUse hook) ------------------------------
// Claude Code can write a turn's last tool calls to the transcript only after
// its Stop hooks ran. dm-unanswered is the file as it is then: the delivery is
// there, the send that answered it is not yet. The PostToolUse record fills in.

const SEND = "mcp__plugin_ghost-protocol_buzz__send";
const REACT = "mcp__plugin_ghost-protocol_buzz__react";
let records = 0;
/** A fresh data folder, shared by the record calls and the Stop that follows. */
function dataDir() {
  records += 1;
  return join(WORK, `rec${records}`);
}
function hookIn(data, stdin, args = [], extraEnv = {}) {
  const env = { PATH: process.env.PATH, HOME: join(WORK, "home"), LANG: "C", CLAUDE_PLUGIN_DATA: data };
  for (const [k, v] of Object.entries({ ...OPTIONS, ...extraEnv })) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  const r = spawnSync(HOOK, args, { input: stdin, env, encoding: "utf8" });
  const logFile = join(data, "hooks", "reply-guard.log");
  return { out: r.stdout, err: r.stderr, rc: r.status, log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "" };
}
/** The PostToolUse input Claude Code gives a hook after a tool call that succeeded. */
function postToolUse(tool, input, id, extra = {}) {
  return JSON.stringify({
    session_id: "fixture-session",
    transcript_path: join(WORK, "unused.jsonl"),
    cwd: "/tmp",
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: input,
    tool_response: [{ type: "text", text: "ok" }],
    tool_use_id: id,
    ...extra,
  });
}
function recordCall(data, tool, input, id, extra = {}, extraEnv = {}) {
  const r = hookIn(data, postToolUse(tool, input, id, extra), ["record"], extraEnv);
  assert.equal(r.rc, 0, r.err);
  assert.equal(r.out, "", "the record hook prints nothing");
  return r;
}
const recordFile = (data, session = "fixture-session") => join(data, "hooks", "reply-guard", `${session}.jsonl`);
const stopIn = (data, fixture, active = false) => hookIn(data, stopInput(join(FIX, `${fixture}.jsonl`), active));

test("record: a send the transcript does not show yet answers (the file at Stop time)", () => {
  const data = dataDir();
  verdict(stopIn(data, "dm-unanswered"), "block", "unanswered", E1);
  recordCall(data, SEND, { channel: DM, reply: E1, audience: "everyone", text: "reply-canary", final: true }, "toolu_late01");
  const r = stopIn(data, "dm-unanswered");
  verdict(r, "allow", "answered");
  assert.match(r.log, /decision=allow why=answered msgs=111111111111 late=111111111111/);
});
test("record: a reaction on the message answers too", () => {
  const data = dataDir();
  recordCall(data, REACT, { id: E1, emoji: "+1" }, "toolu_late02");
  verdict(stopIn(data, "ch-top-level-untagged"), "allow", "answered");
});
test("record: what is kept is ids and tags, never the text", () => {
  const data = dataDir();
  const r = recordCall(
    data,
    SEND,
    { channel: CH, audience: "everyone", text: "zebra-canary for @OpName and nostr:" + KEYS.op_npub },
    "toolu_late03",
  );
  assert.match(r.log, /decision=record why=send/);
  const kept = readFileSync(recordFile(data), "utf8");
  for (const c of CANARIES) assert.ok(!kept.includes(c), `the record holds message text: ${kept}`);
  const rec = JSON.parse(kept.trim());
  assert.deepEqual(Object.keys(rec).sort(), ["audience", "channel", "id", "kind", "mentions", "names", "reply", "ts"]);
  assert.deepEqual(rec.mentions, [OP]);
  assert.equal(rec.names, "@opname");
  assert.match(rec.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  // The tags still answer: @Name (the allowlist label) and the nostr: key, outside a thread.
  verdict(stopIn(data, "ch-top-level-untagged"), "allow", "answered");
});
test("record: a send elsewhere does not answer", () => {
  const data = dataDir();
  recordCall(data, SEND, { channel: CH2, reply: E1, audience: "everyone", text: "x" }, "toolu_late04");
  recordCall(data, SEND, { channel: DM, reply: E1, audience: "agents", text: "x" }, "toolu_late05");
  verdict(stopIn(data, "dm-unanswered"), "block", "unanswered", E1);
});
test("record: a call recorded before the message arrived does not answer", () => {
  const data = dataDir();
  mkdirSync(join(data, "hooks", "reply-guard"), { recursive: true });
  const old = { ts: "2026-11-03T00:30:00.000Z", id: "toolu_old01", kind: "react", event: E1 };
  writeFileSync(recordFile(data), `${JSON.stringify(old)}\n`);
  verdict(stopIn(data, "dm-unanswered"), "block", "unanswered", E1);
  writeFileSync(recordFile(data), `${JSON.stringify({ ...old, ts: "2026-11-03T02:00:00.000Z" })}\n`);
  verdict(stopIn(data, "dm-unanswered"), "allow", "answered");
});
test("record: another session's calls do not answer", () => {
  const data = dataDir();
  recordCall(data, REACT, { id: E1, emoji: "+1" }, "toolu_late06", { session_id: "other-session" });
  assert.ok(existsSync(recordFile(data, "other-session")));
  verdict(stopIn(data, "dm-unanswered"), "block", "unanswered", E1);
});
test("record: a subagent's call is not kept (the main thread only, as in the transcript)", () => {
  const data = dataDir();
  const r = recordCall(data, REACT, { id: E1, emoji: "+1" }, "toolu_late07", { agent_id: "agent-1" });
  assert.match(r.log, /why=subagent/);
  assert.ok(!existsSync(recordFile(data)));
  verdict(stopIn(data, "dm-unanswered"), "block", "unanswered", E1);
});
test("record: the transcript's copy of a call wins (a failed send stays failed)", () => {
  const data = dataDir();
  const lines = readFileSync(join(FIX, "dm-send-failed.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const failedId = lines.flatMap((d) => (d.type === "assistant" ? d.message.content : [])).find((b) => b.name === SEND).id;
  recordCall(data, SEND, { channel: DM, reply: E1, audience: "everyone", text: "x" }, failedId);
  verdict(stopIn(data, "dm-send-failed"), "block", "unanswered", E1);
});
test("record: the transcript's order wins over the record's time (a send made before the message)", () => {
  // The send is in the transcript before the operator's message arrived mid-turn;
  // its record says later (the hook ran after the message was taken in).
  const data = dataDir();
  const lines = readFileSync(join(FIX, "answer-before-midturn.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const sendId = lines.flatMap((d) => (d.type === "assistant" ? d.message.content : [])).find((b) => b.name === SEND).id;
  mkdirSync(join(data, "hooks", "reply-guard"), { recursive: true });
  const rec = { ts: "2026-11-03T02:00:00.000Z", id: sendId, kind: "send", channel: DM, reply: E1, mentions: [OP], names: "", audience: "everyone" };
  writeFileSync(recordFile(data), `${JSON.stringify(rec)}\n`);
  verdict(stopIn(data, "answer-before-midturn"), "block", "unanswered", E1);
  // The same record under an id the transcript does not hold answers.
  writeFileSync(recordFile(data), `${JSON.stringify({ ...rec, id: "toolu_notyet" })}\n`);
  verdict(stopIn(data, "answer-before-midturn"), "allow", "answered");
});
test("record: the transcript's size at the call decides, not the time (a message written after it)", () => {
  // A mid-turn delivery is stamped when it arrives, but the agent sees it only
  // once its entry is written. Here the call was recorded while the transcript
  // still ended before the message's entry: the record's time is later than the
  // message's stamp, yet the call cannot have answered it.
  const data = dataDir();
  const full = readFileSync(join(FIX, "dm-unanswered.jsonl"), "utf8");
  // This turn's delivery (an earlier turn's is in the file too).
  const at = full.lastIndexOf('"kind":"channel"');
  const before = join(data, "before.jsonl");
  mkdirSync(data, { recursive: true });
  writeFileSync(before, full.slice(0, full.lastIndexOf("\n", at) + 1));
  recordCall(data, SEND, { channel: DM, reply: E1, audience: "everyone", text: "x" }, "toolu_size01", { transcript_path: before });
  const rec = JSON.parse(readFileSync(recordFile(data), "utf8").trim());
  assert.equal(rec.off, statSync(before).size, "the record holds the transcript's size");
  assert.ok(rec.off > 0, "the transcript held the earlier turn");
  assert.ok(rec.ts > "2026-11-04", "the record's time alone would count it");
  verdict(stopIn(data, "dm-unanswered"), "block", "unanswered", E1);
});
test("record: a call recorded with the message in the transcript counts", () => {
  const data = dataDir();
  const copy = join(data, "now.jsonl");
  mkdirSync(data, { recursive: true });
  copyFileSync(join(FIX, "dm-unanswered.jsonl"), copy);
  recordCall(data, SEND, { channel: DM, reply: E1, audience: "everyone", text: "x" }, "toolu_size02", { transcript_path: copy });
  const r = stopIn(data, "dm-unanswered");
  verdict(r, "allow", "answered");
  assert.match(r.log, /late=111111111111/);
});
test("record: a record without the size goes by time (a message stamped after it does not count)", () => {
  const data = dataDir();
  mkdirSync(join(data, "hooks", "reply-guard"), { recursive: true });
  const rec = { ts: "2026-11-03T00:30:00.000Z", id: "toolu_nosize", kind: "send", channel: DM, reply: E1, mentions: [], names: "", audience: "everyone" };
  writeFileSync(recordFile(data), `${JSON.stringify(rec)}\n`);
  verdict(stopIn(data, "dm-unanswered"), "block", "unanswered", E1);
  // A size that is not a number is no size.
  writeFileSync(recordFile(data), `${JSON.stringify({ ...rec, ts: "2026-11-03T02:00:00.000Z", off: "9" })}\n`);
  verdict(stopIn(data, "dm-unanswered"), "allow", "answered");
});
test("record: other tools, bad ids and bad input keep nothing", () => {
  const data = dataDir();
  assert.match(recordCall(data, "Bash", { command: `react.sh ${E1} done` }, "toolu_bash01").log, /why=not-buzz/);
  assert.match(recordCall(data, REACT, { id: E1, emoji: "+1" }, "../escape").log, /why=bad-input/);
  assert.match(recordCall(data, REACT, { id: E1, emoji: "+1" }, "toolu_x", { session_id: "../up" }).log, /why=bad-input/);
  assert.match(recordCall(data, REACT, { id: E1, emoji: "+1", off: true }, "toolu_off01").log, /why=not-buzz/);
  const bad = hookIn(data, "not json", ["record"]);
  assert.equal(bad.rc, 0);
  assert.equal(bad.out, "");
  assert.ok(!existsSync(recordFile(data)));
});
test("record: switched off with the guard, nothing is kept", () => {
  const data = dataDir();
  recordCall(data, REACT, { id: E1, emoji: "+1" }, "toolu_late08", {}, { CLAUDE_PLUGIN_OPTION_REPLY_GUARD: "off" });
  assert.ok(!existsSync(recordFile(data)));
});
test("record: a big record file keeps its newest calls, and old session files go", () => {
  const data = dataDir();
  const dir = join(data, "hooks", "reply-guard");
  mkdirSync(dir, { recursive: true });
  const pad = `${JSON.stringify({ ts: "2026-11-03T00:00:00.000Z", id: "toolu_pad", kind: "react", event: E2 })}\n`;
  writeFileSync(recordFile(data), pad.repeat(Math.ceil((1100 * 1024) / pad.length)));
  writeFileSync(join(dir, "stale-session.jsonl"), pad);
  utimesSync(join(dir, "stale-session.jsonl"), new Date(0), new Date(0));
  recordCall(data, REACT, { id: E1, emoji: "+1" }, "toolu_late09");
  const size = statSync(recordFile(data)).size;
  assert.ok(size <= 257 * 1024, `the record file is ${size} bytes`);
  assert.ok(readFileSync(recordFile(data), "utf8").endsWith(`"id":"toolu_late09","kind":"react","event":"${E1}"}\n`));
  verdict(stopIn(data, "dm-unanswered"), "allow", "answered");
  // A new session's first record clears files untouched for a week.
  recordCall(data, REACT, { id: E1, emoji: "+1" }, "toolu_late10", { session_id: "new-session" });
  assert.ok(!existsSync(join(dir, "stale-session.jsonl")));
  assert.ok(existsSync(recordFile(data)));
});

test("record: a task call the transcript does not show yet gives a root its state", () => {
  const data = dataDir();
  const TASK = "mcp__plugin_ghost-protocol_buzz-channel__task";
  verdict(hookIn(data, stopInput(join(FIX, "tr-root-reply-only.jsonl"), false), [], ON), "block", "unanswered", TASK_CALL);
  const line = { tool_response: [{ type: "text", text: `${E1.slice(0, 8)}: none -> open` }] };
  const r = recordCall(data, TASK, { channel: DM, id: E1, state: "open" }, "toolu_late20", line, ON);
  assert.match(r.log, /decision=record why=task/);
  const rec = JSON.parse(readFileSync(recordFile(data), "utf8").trim());
  assert.deepEqual(Object.keys(rec).sort(), ["channel", "event", "id", "kind", "state", "ts"]);
  assert.equal(rec.kind, "task");
  const after = hookIn(data, stopInput(join(FIX, "tr-root-reply-only.jsonl"), false), [], ON);
  verdict(after, "allow", "answered");
  assert.match(after.log, /late=111111111111/);
});
test("record: a task call whose result is a refusal (no success line) is not kept", () => {
  const data = dataDir();
  const TASK = "mcp__plugin_ghost-protocol_buzz-channel__task";
  for (const response of [[{ type: "text", text: "the task tools are off: a bad setting" }], { content: [{ type: "text", text: "x" }] }, "x"]) {
    const r = recordCall(data, TASK, { channel: DM, id: E1, state: "open" }, "toolu_late24", { tool_response: response }, ON);
    assert.match(r.log, /why=task-no-line/);
  }
  assert.ok(!existsSync(recordFile(data)));
  // The success line in an object's content, or as a plain string, is read.
  recordCall(data, TASK, { channel: DM, id: E1, state: "open" }, "toolu_late25", { tool_response: { content: [{ type: "text", text: `${E1.slice(0, 8)}: none -> open` }] } }, ON);
  recordCall(data, TASK, { channel: DM, id: E1, state: "open" }, "toolu_late26", { tool_response: `${E1.slice(0, 8)}: open -> open\n(a note)` }, ON);
  assert.equal(readFileSync(recordFile(data), "utf8").trim().split("\n").length, 2);
});
test("record: in a DM thread with task roots on, a recorded top-level send that tags the operator is no answer", () => {
  const data = dataDir();
  recordCall(data, SEND, { channel: DM, mentions: [OP], audience: "everyone", text: "x" }, "toolu_late27", {}, ON);
  verdict(hookIn(data, stopInput(join(FIX, "dm-unanswered.jsonl"), false), [], ON), "block", "unanswered", E1);
  verdict(hookIn(data, stopInput(join(FIX, "dm-unanswered.jsonl"), false), []), "allow", "answered");
});
test("record: a task call that removes the state (none) is not kept", () => {
  const data = dataDir();
  const r = recordCall(data, "mcp__plugin_ghost-protocol_buzz-channel__task", { channel: DM, id: E1, state: "none" }, "toolu_late21", {}, ON);
  assert.match(r.log, /why=not-buzz/);
});
test("record: a send the transcript does not show yet answers a root in its thread", () => {
  const data = dataDir();
  recordCall(data, SEND, { channel: DM, reply: E1, audience: "everyone", text: "x" }, "toolu_late22", {}, ON);
  verdict(hookIn(data, stopInput(join(FIX, "tr-root-state-only.jsonl"), false), [], ON), "allow", "answered");
  const top = dataDir();
  recordCall(top, SEND, { channel: DM, mentions: [OP], audience: "everyone", text: "x" }, "toolu_late23", {}, ON);
  verdict(hookIn(top, stopInput(join(FIX, "tr-root-state-only.jsonl"), false), [], ON), "block", "unanswered", `reply="${E1}"`);
});

// --- Part 2: settings, inputs and failing open ------------------------------------------------

const dmUnanswered = join(FIX, "dm-unanswered.jsonl");

test("switched off (off, OFF, false, no, 0): no output, nothing logged", () => {
  for (const v of ["off", "OFF", " off ", "false", "no", "0"]) {
    const r = run(dmUnanswered, false, { CLAUDE_PLUGIN_OPTION_REPLY_GUARD: v });
    assert.equal(r.rc, 0);
    assert.equal(r.out, "", `reply_guard=${JSON.stringify(v)} still blocked`);
    assert.equal(r.log, "");
  }
});
test("switched on explicitly, or any other value: the default (on)", () => {
  for (const v of ["on", "ON", "yes", "maybe", ""]) {
    verdict(run(dmUnanswered, false, { CLAUDE_PLUGIN_OPTION_REPLY_GUARD: v }), "block", "unanswered", E1);
  }
});
test("no reaction helpers (the default): a helper's success line is no answer, and the reason offers none", () => {
  const off = { CLAUDE_PLUGIN_OPTION_REPLY_GUARD_HELPERS: undefined };
  const reason = verdict(run(join(FIX, "react-sh-done.jsonl"), false, off), "block", "unanswered", E1);
  assert.ok(!reason.includes("react.sh"), reason);
  verdict(run(join(FIX, "ack-sh.jsonl"), false, off), "block", "unanswered", E1);
  verdict(run(join(FIX, "react-tool.jsonl"), false, off), "allow", "answered");
});
test("reaction helpers named: the reason offers them", () => {
  verdict(run(dmUnanswered), "block", "unanswered", "reaction helpers (react.sh, ack.sh)");
});
test("a helper call beside a send in one message: counted only when helpers are named", () => {
  const f = join(FIX, "send-and-helper-in-one-message.jsonl");
  verdict(run(f), "allow", "answered");
  verdict(run(f, false, { CLAUDE_PLUGIN_OPTION_REPLY_GUARD_HELPERS: undefined }), "block", "unanswered", E1);
});
test("only the helpers named count", () => {
  const onlyAck = { CLAUDE_PLUGIN_OPTION_REPLY_GUARD_HELPERS: "ack.sh" };
  verdict(run(join(FIX, "react-sh-done.jsonl"), false, onlyAck), "block", "unanswered", E1);
  verdict(run(join(FIX, "ack-sh.jsonl"), false, onlyAck), "allow", "answered");
});
test("helper names that are not plain script names are ignored", () => {
  const bad = { CLAUDE_PLUGIN_OPTION_REPLY_GUARD_HELPERS: "../react.sh, react sh, .*, |" };
  const reason = verdict(run(join(FIX, "react-sh-done.jsonl"), false, bad), "block", "unanswered", E1);
  assert.ok(!reason.includes("reaction helpers"), reason);
});
test("buzz_operator_pubkeys wins over buzz_trusted_pubkeys", () => {
  // The operator option names someone else: the trusted key's message is not checked.
  const r = run(dmUnanswered, false, { CLAUDE_PLUGIN_OPTION_BUZZ_OPERATOR_PUBKEYS: KEYS.agent });
  verdict(r, "allow", "no-operator-message");
  const r2 = run(dmUnanswered, false, {
    CLAUDE_PLUGIN_OPTION_BUZZ_OPERATOR_PUBKEYS: KEYS.op,
    CLAUDE_PLUGIN_OPTION_BUZZ_TRUSTED_PUBKEYS: "",
  });
  verdict(r2, "block", "unanswered", E1);
});
test("an npub operator key in a comma list", () => {
  const r = run(dmUnanswered, false, { CLAUDE_PLUGIN_OPTION_BUZZ_TRUSTED_PUBKEYS: `${KEYS.self}, ${KEYS.op_npub}` });
  verdict(r, "block", "unanswered", E1);
});
test("no operator key: fail open", () => {
  verdict(run(dmUnanswered, false, { CLAUDE_PLUGIN_OPTION_BUZZ_TRUSTED_PUBKEYS: "" }), "allow", "no-operator-key");
  verdict(run(dmUnanswered, false, { CLAUDE_PLUGIN_OPTION_BUZZ_TRUSTED_PUBKEYS: undefined }), "allow", "no-operator-key");
});
test("only malformed keys: fail open", () => {
  verdict(run(dmUnanswered, false, { CLAUDE_PLUGIN_OPTION_BUZZ_TRUSTED_PUBKEYS: KEYS.bad_keys }), "allow", "no-operator-key");
});
test("@Name needs a name: from buzz_operator_names, or the allowlist label", () => {
  const atName = join(FIX, "at-name-in-text.jsonl");
  const noFile = { CLAUDE_PLUGIN_OPTION_BUZZ_ALLOWLIST_FILE: join(WORK, "no-such-allowlist.json") };
  verdict(run(atName, false, noFile), "block", "unanswered", E1);
  verdict(run(atName, false, { ...noFile, CLAUDE_PLUGIN_OPTION_BUZZ_OPERATOR_NAMES: "Someone, OpName" }), "allow", "answered");
  verdict(run(atName, false, { CLAUDE_PLUGIN_OPTION_BUZZ_ALLOWLIST_FILE: undefined }), "block", "unanswered", E1);
});
test("the allowlist file path may start with ~/", () => {
  const home = join(WORK, "home");
  mkdirSync(home, { recursive: true });
  copyFileSync(join(FIX, "allowlist.json"), join(home, "allowlist.json"));
  const r = run(join(FIX, "at-name-in-text.jsonl"), false, { CLAUDE_PLUGIN_OPTION_BUZZ_ALLOWLIST_FILE: "~/allowlist.json" });
  verdict(r, "allow", "answered");
});
test("an allowlist file that is not JSON: no names from it, still no crash", () => {
  const bad = join(WORK, "bad-allowlist.json");
  writeFileSync(bad, "{not json");
  verdict(run(join(FIX, "at-name-in-text.jsonl"), false, { CLAUDE_PLUGIN_OPTION_BUZZ_ALLOWLIST_FILE: bad }), "block", "unanswered", E1);
});
test("stdin is not JSON", () => verdict(runRaw("not json"), "allow", "bad-input"));
test("stdin is a JSON list", () => verdict(runRaw("[1]"), "allow", "bad-input"));
test("the transcript is missing", () => verdict(run(join(WORK, "no-such.jsonl")), "allow", "no-transcript"));
test("an unreadable transcript: fail open", { skip: process.getuid?.() === 0 && "root reads any file" }, () => {
  const locked = join(WORK, "locked.jsonl");
  copyFileSync(dmUnanswered, locked);
  chmodSync(locked, 0o000);
  verdict(run(locked), "allow", "error-PermissionError");
});
test("a turn past the tail cap: fail open", () => {
  verdict(run(dmUnanswered, false, { REPLY_GUARD_TAIL_CAP: "200" }), "allow", "no-turn-marker");
});
test("the log goes to ~/.local/state/ghost-protocol/hooks without the plugin's data folder", () => {
  const home = join(WORK, "home-nodata");
  const r = spawnSync(HOOK, [], {
    input: stopInput(dmUnanswered, false),
    env: { PATH: process.env.PATH, HOME: home, LANG: "C", ...OPTIONS },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).decision, "block");
  assert.match(readFileSync(join(home, ".local", "state", "ghost-protocol", "hooks", "reply-guard.log"), "utf8"), /why=unanswered/);
});

// The wrapper never exits non-zero: exit 2 would mean "block", with no valve.
function wrapperCase(name, setup) {
  test(`the wrapper ${name}: exit 0, no output`, () => {
    const dir = tempDir("reply-guard-wrapper");
    copyFileSync(HOOK, join(dir, "reply-guard"));
    chmodSync(join(dir, "reply-guard"), 0o755);
    setup(dir);
    const r = runRaw(stopInput(dmUnanswered, false), {}, join(dir, "reply-guard"));
    assert.equal(r.rc, 0);
    assert.equal(r.out, "");
  });
}
wrapperCase("alone (no .py)", () => {});
test("the wrapper with no python3 on PATH: exit 0, no output", () => {
  const bin = tempDir("reply-guard-nopython");
  for (const t of ["bash", "dirname", "tr"]) {
    const found = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
    symlinkSync(found, join(bin, t));
  }
  const r = spawnSync(join(bin, "bash"), [HOOK], {
    input: stopInput(dmUnanswered, false),
    env: { PATH: bin, HOME: join(WORK, "home"), ...OPTIONS },
    encoding: "utf8",
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
wrapperCase("with a .py that exits 2", (d) => writeFileSync(join(d, "reply-guard.py"), "import sys\nsys.exit(2)\n"));
wrapperCase("with a .py that does not parse", (d) => writeFileSync(join(d, "reply-guard.py"), "this is not python(\n"));
if (process.getuid?.() !== 0) {
  wrapperCase("with an unreadable .py", (d) => {
    writeFileSync(join(d, "reply-guard.py"), "import sys\nsys.exit(2)\n");
    chmodSync(join(d, "reply-guard.py"), 0o000);
  });
}
test("the hook is executable", () => {
  const r = spawnSync("test", ["-x", join(ADAPTER, "hooks", "reply-guard")]);
  assert.equal(r.status, 0);
});
test("no key is written into the hook: the operator comes from the settings", () => {
  assert.doesNotMatch(readFileSync(PY, "utf8"), /[0-9a-f]{64}/);
});

// --- Part 3: speed on a ~30 MB transcript -----------------------------------------------------

test("a ~30 MB transcript is checked quickly", { skip: process.env.REPLY_GUARD_SKIP_SPEED === "1" }, () => {
  const lines = readFileSync(dmUnanswered, "utf8").split(/(?<=\n)/);
  const pad = `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_pad", content: [{ type: "text", text: "x".repeat(20000) }] }] },
  })}\n`;
  const i = lines.findIndex((l) => l.includes('"subtype":"turn_duration"'));
  const big = join(WORK, "big.jsonl");
  const parts = [pad.repeat(700), ...lines.slice(0, i + 1), lines[i + 1], pad.repeat(800), ...lines.slice(i + 2)];
  writeFileSync(big, parts.join(""));
  let t0 = performance.now();
  verdict(run(big), "block", "unanswered", E1);
  let ms = performance.now() - t0;
  assert.ok(ms < 5000, `an unanswered message in a big transcript took ${Math.round(ms)} ms`);
  writeFileSync(big, readFileSync(big, "utf8").replaceAll('"kind":"channel"', '"kind":"human"'));
  t0 = performance.now();
  verdict(run(big), "allow", "no-message");
  ms = performance.now() - t0;
  assert.ok(ms < 3000, `the no-message path took ${Math.round(ms)} ms`);
});
