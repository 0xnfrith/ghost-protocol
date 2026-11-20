// The reply guard's mutation check: runs reply-guard.test.mjs against broken
// copies of the hook, one break each. Every copy must fail the suite; a break
// whose text is no longer in the hook (not applied) fails this check too, so
// the list stays in step with the code.
//
// Run: node test/reply-guard-mutants.mjs   (a few minutes; not part of npm test)
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER, tempDir } from "./helpers.mjs";

const SH = join(ADAPTER, "hooks", "reply-guard");
const PY = join(ADAPTER, "hooks", "reply-guard.py");
const SUITE = join(ADAPTER, "test", "reply-guard.test.mjs");
const shSrc = readFileSync(SH, "utf8");
const pySrc = readFileSync(PY, "utf8");

// [name, [[exact text, replacement], ...]]. A name starting with "sh:" breaks the wrapper.
const MUTANTS = [
  ["sh: wrapper execs python3", [['python3 "$py" "$@"\nexit 0', 'exec python3 "$py" "$@"']]],
  ["sh: wrapper passes python's exit code", [['python3 "$py" "$@"\nexit 0', 'python3 "$py" "$@"']]],
  ["sh: the off switch is ignored", [["  off | false | no | 0) exit 0 ;;", "  never) exit 0 ;;"]]],
  // Each of the two thread-context checks alone stops a block on a top-level
  // message (the second sees thread "" there), so this mutant turns both off.
  ["ctx on top-level messages (both checks off)", [
    ['i = text.rfind("<thread_context ") if msg["thread_id"] else -1', 'i = text.rfind("<thread_context ")'],
    ['if c and c.group(1) != msg["thread_id"]:', "if False:"],
  ]],
  ["ctx thread id unchecked", [['if c and c.group(1) != msg["thread_id"]:', "if False:"]]],
  ["npub checksum unchecked", [["!= 1:\n        return None\n    acc", "!= 1 and False:\n        return None\n    acc"]]],
  ["HEX64_RE any length", [['HEX64_RE = re.compile(r"^[0-9a-f]{64}$")', 'HEX64_RE = re.compile(r"^[0-9a-f]+$")']]],
  ["queued-attachment type unchecked", [['if a.get("type") != "queued_command" or not isinstance(o, dict)', "if not isinstance(o, dict)"]]],
  ["helper success line not required", [[' and (not (a["helper"] or a.get("line")) or helper_ok(a, texts))', ""]]],
  ["helper success line for any id", [['pat = HELPER_OK % re.escape(a["event"][:8])', 'pat = HELPER_OK % "[0-9a-f]{8}"']]],
  ["helper names unchecked", [['if re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", n) and n not in names:', "if n and n not in names:"]]],
  ["helpers counted while switched off", [['elif name == "Bash" and HELPERS:', 'elif name == "Bash":']]],
  ["@Name tags ignored", [[' or at_names(a["text"], names)', ""]]],
  ["any @ counts as a tag", [['if re.search(r"(?:^|(?<=\\s))@" + re.escape(n) + AT_TAIL, text, re.I):', 'if "@" in text:']]],
  ["code spans not stripped", [['"text": CODE_RE.sub(" ", text),', '"text": text,']]],
  ["@ boundary before the name off", [['r"(?:^|(?<=\\s))@"', 'r"@"']]],
  ["@ boundary after the name off", [['AT_TAIL = r"(?=\\s|[,;.!?:)\\]}]|\\Z)"', 'AT_TAIL = r""']]],
  ["nostr: tags ignored", [["tagged |= set(k for k in (npub_to_hex(x) for x in NOSTR_RE.findall(text)) if k)", "pass"]]],
  ["buzz_operator_pubkeys ignored", [['for src in ("buzz_operator_pubkeys", "buzz_trusted_pubkeys"):', 'for src in ("buzz_trusted_pubkeys",):']]],
  ["buzz_operator_names ignored", [['for n in option("buzz_operator_names").split(","):', "for n in []:"]]],
  ["allowlist labels ignored", [['    f = option("buzz_allowlist_file")\n    if not f:', '    f = ""\n    if not f:']]],
  ["~/ not expanded in the allowlist path", [['return os.path.join(os.path.expanduser("~"), p[2:]) if p.startswith("~/") else p', "return p"]]],
  ["no error check", [['return a["id"] not in failed', "return True"]]],
  ["no channel match", [['if a["channel"] and a["channel"] != m["channel_id"]:', "if False:"]]],
  ["no position check", [['if a["idx"] <= m["idx"]:', "if False:"]]],
  ["no author check", [['if m["author"] not in ops:', "if False:"]]],
  ["no valve", [["if valve:", "if False:"]]],
  ["no sidechain skip (deliveries)", [['if d.get("isSidechain") is True:\n        return None', "if False:\n        return None"]]],
  ["no sidechain skip (answers)", [['if d.get("type") != "assistant" or d.get("isSidechain") is True:', 'if d.get("type") != "assistant":']]],
  ["agents audience counts", [['if a.get("audience") == "agents":', "if False:"]]],
  ["react off counts", [['if inp.get("off") is True:', "if False:"]]],
  // A clear prints "-> none", which the success line also refuses: both off.
  ["a clear counts (both checks off)", [['(hm.group(3) or "").lower() == "clear"', "False"], ["(?!none\\s*$)", ""]]],
  ["any reaction counts", [['if a["event"] == m["event_id"] and (not (a["helper"] or a.get("line")) or helper_ok(a, texts)):', "if True:"]]],
  ["any send counts", [['return in_thread or bool(a["mentions"] & ops) or at_names(a["text"], names) or m["dm"]', "return True"]]],
  ["DM rule off", [['at_names(a["text"], names) or m["dm"]', 'at_names(a["text"], names)']]],
  ["mention rule off", [['return in_thread or bool(a["mentions"] & ops) or', "return in_thread or"]]],
  ["thread rule off", [['in_thread = bool(a["reply"]) and roots.get(a["reply"], a["reply"]) == root', "in_thread = False"]]],
  ["catch-up rule for every message", [['if not m["catch_up"]:\n        return False', "if False:\n        return False"]]],
  ["catch-up ignores omitted", [[' or c["omitted"] != "0"', ""]]],
  ["catch-up ignores since", [[' or c["since"] != "agent_reply"', ""]]],
  ["catch-up ignores the listing", [[' and m["event_id"] not in c["ids"]', ""]]],
  ["catch-up ignores order", [['o["sent_at"] > m["sent_at"] and ', ""]]],
  ["first thread_context wins", [['i = text.rfind("<thread_context ")', 'i = text.find("<thread_context ")']]],
  ["head tag searched, not matched at the start", [["m = HEAD_RE.match(text)", "m = HEAD_RE.search(text)"]]],
  ["typed prompts count", [['if not isinstance(o, dict) or o.get("kind") != "channel":\n            return None\n        c =', "if False:\n            return None\n        c ="]]],
  ["no turn bound", [['return body[end:].split(b"\\n"), True', 'return body.split(b"\\n"), True']]],
  ["no dedupe", [['if m["event_id"] in seen:', "if False:"]]],
  ["no fail-open", [["        # Fail open: a bug in the guard never holds a turn.\n", "        raise\n"]]],
  // The record (reply-guard record, PostToolUse).
  ["records never read", [['recs = recorded(session, set(a["id"] for a in acts)) if mine else []', "recs = []"]]],
  ["records never written", [['if mode == "record":\n            log(session, "record", why=record(data), ms=ms())', 'if mode == "record":\n            log(session, "record", why="x", ms=ms())']]],
  ["a record counts whatever its time", [['if not m["ts"] or a["ts"] <= m["ts"]:', "if False:"]]],
  ["the transcript copy does not win", [['if r["id"] in shown:', "if False:"]]],
  ["subagent calls recorded", [['if data.get("agent_id"):\n        return "subagent"', 'if False:\n        return "subagent"']]],
  ["one record file for every session", [['os.path.join(RECORD_DIR, session + ".jsonl")', 'os.path.join(RECORD_DIR, "all.jsonl")']]],
  ["a record's size ignored (time only)", [['if a.get("off") is not None:\n            if m["end"] > a["off"]:', 'if False:\n            if m["end"] > a["off"]:']]],
  ["the record keeps no size", [['rec["off"] = os.path.getsize(tp)', "pass"]]],
  ["a message's end read as the turn's start", [['m["end"] = start + len(raw)', 'm["end"] = base']]],
  ["the record keeps the text", [['"names": " ".join("@" + n for n in sorted(names) if at_names(a["text"], {n})),', '"names": a["text"],']]],
  ["a big record file is never cut", [["elif os.path.getsize(path) > RECORD_MAX:", "elif False:"]]],
  ["old record files stay", [["if f.endswith(\".jsonl\") and os.path.getmtime(p) < cutoff:", "if False:"]]],
  // DM task roots (task_roots on): one break per rule.
  ["task roots never on", [['return option("task_roots").lower() == "on"', "return False"]]],
  ["a task root needs no state", [["has_state = bool(states)", "has_state = True"]]],
  ["a task root needs no answer", [["has_reply = has_reply or answered(m, acts, failed, texts, roots, ops, names, True)", "has_reply = True"]]],
  ["a short root still needs an answer", [['has_reply = short and "done" not in (states | rec_states)', "has_reply = False"]]],
  ["a short root set done needs no answer", [['has_reply = short and "done" not in (states | rec_states)', "has_reply = short"]]],
  ["a helper's done read as open", [['out.add("done" if helper_done(a, texts) else "open")', 'out.add("open")']]],
  ["a short root of any length", [[' and m["chars"] <= ROOT_CHARS', ""]]],
  ["a task call counts without its success line", [['and (not a.get("line") or helper_ok(a, texts)):\n            out.add', "and True:\n            out.add"], ['(not (a["helper"] or a.get("line")) or helper_ok(a, texts))', '(not a["helper"] or helper_ok(a, texts))']]],
  ["the record keeps a refused task call", [['        return "task-no-line"  # a refusal: no state was set', "        pass"]]],
  ["strict off for recorded answers", [["if recs and answered(m, recs, failed, texts, roots, ops, names, strict):", "if recs and answered(m, recs, failed, texts, roots, ops, names):"]]],
  ["a root of any length needs only a state", [["ROOT_WORDS = 2", "ROOT_WORDS = 99"]]],
  ["mentions counted as words", [['if not w.startswith("@") and not w.lower().startswith("nostr:")', "if True"]]],
  ["a tag or top-level send answers a DM", [['if not a["channel"] or strict:', 'if not a["channel"]:']]],
  ["the react tool is a state", [['if a["kind"] == "react" and a["helper"] and helper_ok(a, texts):', 'if a["kind"] == "react":']]],
  ["a helper's state needs no success line", [['if a["kind"] == "react" and a["helper"] and helper_ok(a, texts):', 'if a["kind"] == "react" and a["helper"]:']]],
  ["a state of none counts", [["if inp.get(\"state\") not in TASK_STATES:", "if False:"]]],
  ["a state on any message counts", [['if a["kind"] == "send" or a["event"] != m["event_id"] or not after(a, m, failed):', 'if a["kind"] == "send" or not after(a, m, failed):']]],
  ["a state made before, or failed, counts", [['if a["kind"] == "send" or a["event"] != m["event_id"] or not after(a, m, failed):', 'if a["kind"] == "send" or a["event"] != m["event_id"]:']]],
  ["a root's own state answers it", [['if strict and not m["thread_id"]:\n                continue', 'if False:\n                continue']]],
  ["task roots on for channels too", [['strict = task_roots and m["dm"]', "strict = task_roots"]]],
  ["a state in another channel counts", [['if a["kind"] == "task" and a.get("channel") == m["channel_id"] and', 'if a["kind"] == "task" and']]],
  ["a catch-up root's thread evidence ignored", [["has_reply = has_reply or answered_before(m, msgs)", "pass"]]],
  ["recorded task calls never read", [['if r.get("kind") in ("react", "task"):', 'if r.get("kind") == "react":']]],
  ["the record misses the task tool", [['if a["kind"] in ("react", "task"):\n        rec["event"]', 'if a["kind"] == "react":\n        rec["event"]']]],
];

const count = (s, sub) => s.split(sub).length - 1;
let killed = 0;
const rows = [];
for (const [name, pairs] of MUTANTS) {
  const isSh = name.startsWith("sh:");
  let text = isSh ? shSrc : pySrc;
  const counts = pairs.map(([old]) => count(text, old));
  if (counts.some((n) => n !== 1)) {
    rows.push([name, `NOT APPLIED (${counts.join(",")} matches)`]);
    continue;
  }
  for (const [old, now] of pairs) text = text.replace(old, () => now);
  const dir = tempDir("reply-guard-mutant");
  writeFileSync(join(dir, "reply-guard"), isSh ? text : shSrc);
  chmodSync(join(dir, "reply-guard"), 0o755);
  writeFileSync(join(dir, "reply-guard.py"), isSh ? pySrc : text);
  const r = spawnSync(process.execPath, ["--test", SUITE], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, REPLY_GUARD_HOOK: join(dir, "reply-guard"), REPLY_GUARD_SKIP_SPEED: "1" },
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  const fails = (r.stdout.match(/^# fail (\d+)/m) || [])[1];
  if (r.status !== 0) {
    killed += 1;
    rows.push([name, `killed (${fails ?? "?"} failing)`]);
  } else {
    rows.push([name, "SURVIVED"]);
  }
}
for (const [name, res] of rows) console.log(`  ${name.padEnd(46)} ${res}`);
console.log(`mutants: ${killed}/${MUTANTS.length} killed`);
process.exit(killed === MUTANTS.length ? 0 : 1);
