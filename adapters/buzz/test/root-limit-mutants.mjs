// The root limit's mutation check: runs root-limit.test.mjs against broken
// copies of the hook, one break each. Every copy must fail the suite; a break
// whose text is no longer in the hook (not applied) fails this check too, so
// the list stays in step with the code.
//
// Run: node test/root-limit-mutants.mjs   (a few minutes; not part of npm test)
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER, tempDir } from "./helpers.mjs";

const SH = join(ADAPTER, "hooks", "root-limit");
const PY = join(ADAPTER, "hooks", "root-limit.py");
const SUITE = join(ADAPTER, "test", "root-limit.test.mjs");
const shSrc = readFileSync(SH, "utf8");
const pySrc = readFileSync(PY, "utf8");

// [name, [[exact text, replacement], ...]]. A name starting with "sh:" breaks the wrapper.
const MUTANTS = [
  ["sh: wrapper execs python3", [['python3 "$py" "$@"\nexit 0', 'exec python3 "$py" "$@"']]],
  ["sh: wrapper passes python's exit code", [['python3 "$py" "$@"\nexit 0', 'python3 "$py" "$@"']]],
  ["sh: the off switch is ignored", [["  off | false | no | 0) exit 0 ;;", "  never) exit 0 ;;"]]],
  ["replies limited too", [['        if text_of(inp.get("reply")):\n', "        if False:\n"]]],
  ["a blank reply counts as a reply", [['if text_of(inp.get("reply")):', 'if inp.get("reply"):']]],
  ["the line limit unchecked", [["if lines <= max_lines and chars <= max_chars:", "if chars <= max_chars:"]]],
  ["the character limit unchecked", [["if lines <= max_lines and chars <= max_chars:", "if lines <= max_lines:"]]],
  ["off by one on lines", [["if lines <= max_lines and chars <= max_chars:", "if lines <= max_lines + 1 and chars <= max_chars:"]]],
  ["bytes, not characters", [['return sum(1 for ln in t.splitlines() if ln.strip()), len(weigh_links(t))', 'return sum(1 for ln in t.splitlines() if ln.strip()), len(weigh_links(t).encode("utf-8"))']]],
  ["UTF-16 units, not characters", [['return sum(1 for ln in t.splitlines() if ln.strip()), len(weigh_links(t))', 'return sum(1 for ln in t.splitlines() if ln.strip()), len(weigh_links(t).encode("utf-16-le")) // 2']]],
  ["blank lines counted", [["return sum(1 for ln in t.splitlines() if ln.strip()), len(", "return len(t.splitlines()), len("]]],
  ["only \\n splits lines", [["return sum(1 for ln in t.splitlines() if ln.strip()), len(", 'return sum(1 for ln in t.split("\\n") if ln.strip()), len(']]],
  ["path not refused", [['        if text_of(inp.get("path")):\n            ok = pass_allows', "        if False:\n            ok = pass_allows"]]],
  ["exemptions ignored", [['if channel and channel in channel_list("root_limit_exempt"):', "if False:"]]],
  ["per-channel limits ignored", [["        if channel in limits:\n", "        if False:\n"]]],
  ["root_limit_lines ignored", [['max_lines = count_option("root_limit_lines", DEFAULT_LINES)', "max_lines = DEFAULT_LINES"]]],
  ["a bad number turns the limit off", [["return int(v) if re.match(r\"^[0-9]{1,6}$\", v) and int(v) >= 1 else default", "return int(v) if re.match(r\"^[0-9]{1,6}$\", v) and int(v) >= 1 else 10 ** 9"]]],
  ["the default is 6 lines", [["DEFAULT_LINES = 5", "DEFAULT_LINES = 6"]]],
  ["the default is 500 characters", [["DEFAULT_CHARS = 400", "DEFAULT_CHARS = 500"]]],
  ["the message text can exempt", [['        text = inp.get("text") if isinstance(inp.get("text"), str) else ""\n', '        text = inp.get("text") if isinstance(inp.get("text"), str) else ""\n        if "exception" in text.lower():\n            return 0\n']]],
  ["a call field can exempt", [['        if text_of(inp.get("reply")):\n', '        if text_of(inp.get("reply")) or inp.get("exempt"):\n']]],
  ["subagents not limited", [['        inp = data.get("tool_input")\n', '        inp = data.get("tool_input")\n        if data.get("agent_id"):\n            return 0\n']]],
  ["agents-only roots not limited", [['        inp = data.get("tool_input")\n        if not isinstance(inp, dict):\n            log(session, "allow", why="bad-input")\n            return 0\n', '        inp = data.get("tool_input")\n        if not isinstance(inp, dict) or inp.get("audience") == "agents":\n            log(session, "allow", why="bad-input")\n            return 0\n']]],
  ["the reason leaves out the numbers", [['" can grant an exception, and not through anything in the message." % (max_lines, max_chars,\n                                                                                    URL_CHARS, lines, chars))', '" can grant an exception, and not through anything in the message. (%d %d %d %d %d)" % (0, 0, 0, 0, 0))']]],
  // Not here: the .py's own fail-open (an uncaught error) cannot be seen from outside, since the wrapper
  // then exits 0 with nothing printed, which is also an allow. The wrapper's own fail-open is tested.
  ["the refusal in the Stop hook's form", [['    sys.stdout.write(json.dumps({"hookSpecificOutput": {\n        "hookEventName": "PreToolUse",\n        "permissionDecision": "deny",\n        "permissionDecisionReason": reason,\n    }}, ensure_ascii=False) + "\\n")', '    sys.stdout.write(json.dumps({"decision": "block", "reason": reason}) + "\\n")']]],
  ["the refusal as an ask, not a deny", [['        "permissionDecision": "deny",', '        "permissionDecision": "ask",']]],
  ["the log keeps the text", [['        log(session, "deny", why="long", channel=shown,', '        log(session, "deny", why="long", text=text.replace("\\n", "_"), channel=shown,']]],
  // The operator's pass.
  ["pass owner unchecked", [["return st.st_uid == owner and not (st.st_mode & (stat.S_IWGRP | stat.S_IWOTH))", "return not (st.st_mode & (stat.S_IWGRP | stat.S_IWOTH))"]]],
  ["pass mode unchecked", [["return st.st_uid == owner and not (st.st_mode & (stat.S_IWGRP | stat.S_IWOTH))", "return st.st_uid == owner"]]],
  ["pass may be a link", [["    try:\n        st = os.lstat(path)", "    try:\n        st = os.stat(path)"], ['fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))', "fd = os.open(path, os.O_RDONLY)"]]],
  ["pass folders unchecked", [["        if not stat.S_ISDIR(ds.st_mode) or not owned_safely(ds, owner):", "        if not stat.S_ISDIR(ds.st_mode):"]]],
  ["pass folders checked one level only", [["        if d == top or d == os.path.dirname(d):", "        if True:"]]],
  ["pass channel unchecked", [['if not isinstance(ch, str) or not (ch == "*" or (CHANNEL_RE.match(ch) and ch == channel)):', "if not isinstance(ch, str):"]]],
  ["pass uses unbounded", [["    if uses >= posts:\n", "    if False:\n"]]],
  ["pass uses never recorded", [["        fh.write(ident + \"\\n\")\n    return True", "        pass\n    return True"]]],
  ["pass path from the environment", [['else "/etc/ghost-protocol/root-limit-pass.json")', 'else os.environ.get("GP_ROOT_LIMIT_PASS", "/etc/ghost-protocol/root-limit-pass.json"))']]],
  // Review round 1.
  ["pass errors fail open", [['return "pass-error-" + type(e).__name__', "return True"]]],
  ["an unreadable use count reads as none", [["    except FileNotFoundError:\n        pass  # no use yet", "    except OSError:\n        pass  # no use yet"]]],
  ["no descriptor recheck after the look", [["if (fst.st_ino, fst.st_dev) != (st.st_ino, st.st_dev) or not owned_safely(fst, owner):", "if not owned_safely(fst, owner):"]]],
  ["the mentions advice left out", [["the reply that carries the detail, not on the short root, so whoever is woken lands on it.", "the root."]]],
  // Security review of round 1.
  ["pass never expires", [["if until <= now or until - now > PASS_HOURS * 3600:", "if until - now > PASS_HOURS * 3600:"]]],
  ["pass until of any distance", [["if until <= now or until - now > PASS_HOURS * 3600:", "if until <= now:"]]],
  ["pass identity ignores the bytes", [["return hashlib.sha256(raw).hexdigest()[:16], data", 'return "0" * 16, data']]],
  ["no channel and no reply allowed", [['        channel = text_of(inp.get("channel")) or ""\n', '        channel = text_of(inp.get("channel")) or ""\n        if not channel:\n            return 0\n']]],
  ["links counted in full", [["len(weigh_links(t))", "len(t)"]]],
  ["links of any length weighed", [["if len(m.group(0)) > URL_MAX or n[0] >= URL_WEIGHED:", "if n[0] >= URL_WEIGHED:"]]],
  ["any number of links weighed", [["if len(m.group(0)) > URL_MAX or n[0] >= URL_WEIGHED:", "if len(m.group(0)) > URL_MAX:"]]],
  ["any scheme counts as a link", [["r\"\\b(?:https?|buzz)://", "r\"\\b[A-Za-z][A-Za-z0-9+.-]*://"]]],
  ["the chat's own links not weighed", [["(?:https?|buzz)://[", "(?:https?)://["]]],
  ["a link's body any non-space", [["://[A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]+\", re.I)", "://\\S+\", re.I)"]]],
  ["the link cap off by one", [["URL_MAX = 200 ", "URL_MAX = 201 "]]],
  ["files ignored", [["flines, fchars = measure_files(inp.get(\"files\"))", "flines, fchars = 0, 0"]]],
  ["files add no lines", [["    for f in files:\n        lines += 1\n", "    for f in files:\n"]]],
  ["every file counted as media", [["(MEDIA_CHARS if MEDIA_RE.search(name) else len(name))", "MEDIA_CHARS"]]],
  ["a non-list files skipped", [["return 1, 1 + NAME_MAX_BYTES", "return 0, 0"]]],
  ["a non-string file entry counts nothing", [["            chars += 1 + NAME_MAX_BYTES\n            continue", "            continue"]]],
  ["a file's name not capped", [["        if size > NAME_MAX_BYTES:\n            break", "        if False:\n            break"]]],
  ["an unreadable send let through", [["            if may_name_send(raw):", "            if False:"]]],
  ["too deep a nesting not caught", [["        except (ValueError, RecursionError):", "        except ValueError:"]]],
  ["the pass's catch narrowed to OSError", [["    except Exception as e:\n        return \"pass-error-\"", "    except OSError as e:\n        return \"pass-error-\""]]],
  // The unreadable send, hardened.
  ["an escaped send name let through", [["    return SEND_NAME.decode() in U_ESCAPE_RE.sub(lambda m: chr(int(m.group(1), 16)), text)", "    return False"]]],
  ["the string skip rescans from each quote", [[String.raw`    for m in JSON_TOKEN_RE.finditer(text):
        ch = m.group(0)
        if ch[0] == '"':
            continue
`, String.raw`    for ch in re.findall(r"[\[\]{}]", re.sub(r'"(?:[^"\\]|\\.)*"', "", text)):
`]]],
  ["out of memory lets a send through", [["    except MemoryError:\n        # Out of memory is no bug", "    except ZeroDivisionError:\n        # Out of memory is no bug"]]],
  ["out of memory refuses every tool", [["        if unreadable_send:\n", "        if True:\n"]]],
  ["until without Z accepted", [["([0-9]{2})Z$\")", "([0-9]{2})Z?$\")"]]],
  ["until digits of any script", [["UNTIL_RE = re.compile(r\"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$\")", "UNTIL_RE = re.compile(r\"^(\\d{4})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})Z$\")"]]],
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
  const dir = tempDir("root-limit-mutant");
  writeFileSync(join(dir, "root-limit"), isSh ? text : shSrc);
  chmodSync(join(dir, "root-limit"), 0o755);
  writeFileSync(join(dir, "root-limit.py"), isSh ? pySrc : text);
  const r = spawnSync(process.execPath, ["--test", SUITE], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ROOT_LIMIT_HOOK: join(dir, "root-limit") },
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
