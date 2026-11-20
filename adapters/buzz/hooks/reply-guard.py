#!/usr/bin/env python3
"""The reply guard's logic. The rule and why: see reply-guard next to this file.

Stop hook. Reads the hook input JSON on stdin and the current turn of the
session transcript (its tail), and prints {"decision": "block", ...} or nothing.
It reads nothing else: no ledger, no relay, no model. Its settings come from
the plugin options Claude Code puts in a hook's environment
(CLAUDE_PLUGIN_OPTION_<KEY>).

Transcript shapes this relies on (Claude Code 2.1.x with this adapter's buzz
channel, structure only):
  - A turn ends with a {"type":"system","subtype":"turn_duration"} entry,
    written after the Stop hooks run, so the current turn is everything after
    the last one (the whole file when there is none yet).
  - A message that starts a turn: {"type":"user","isMeta":true,
    "origin":{"kind":"channel","server":"plugin:ghost-protocol:buzz-channel"},
    "message":{"role":"user","content":"<channel source=... channel_id=...
    event_id=... author=... sent_at=... [dm=] [thread_id=] [catch_up=]>..."}}.
  - A message delivered while a turn runs (absorbed mid-turn):
    {"type":"attachment","attachment":{"type":"queued_command",
    "commandMode":"prompt","origin":{"kind":"channel",...},"prompt":"<channel ...>..."}}.
  - `queue-operation` entries repeat a queued message's text; they are ignored
    (an enqueued message that is not absorbed mid-turn starts the next turn and
    is checked there). `api-request-blob` entries, `rendered` copies, tool
    results, typed prompts and subagent (sidechain) entries are never read as
    deliveries either.
  - The agent's answers are assistant tool_use blocks: the Buzz MCP `send`
    (channel, reply, mentions, audience, text) and `react` (id, emoji, off),
    the buzz channel's `task` (channel, id, state), or a Bash command running
    one of the reaction helpers named in reply_guard_helpers, as <helper> <id>
    [<state>]. Each is paired with its tool_result; an is_error result is not
    an answer, and a helper call counts only when its result holds a success
    line for that id: the id's first 8 hex, ": ", and "<old> -> <new>" (not to
    "none") or "+ <reaction>".

DM task roots (the plugin option task_roots, off by default): when on, a
message from the operator in a DM is answered only by a send in its thread
(a tag, @Name or a top-level send in the DM no longer counts), or, in a
thread, a reaction on it. A top-level DM from the operator is a task root
and needs two things: a state on it (the `task` tool with a state other than
none, or a reaction helper's success line; the Buzz react tool alone is no
state; a `task` call must name the root's own channel, and counts, like a
helper call, only when its result holds the success line for that id) and a
send in its thread. A short root (one or two words and at most 40
characters; a mention like @Name or nostr:npub1... is not a word) only opens
a topic and needs the state alone, unless it was set done: an answered ask
needs its answer in the thread. A catch-up root whose thread shows the agent
spoke there after it (as for a catch-up message below) has its answer.

The transcript can lag the session: Claude Code may write the last tool calls
of a turn to the file only after its Stop hooks have run, so a send that went
through can be missing from the file when the guard reads it. So the guard
also keeps its own record: run as `reply-guard.py record` from a PostToolUse
hook on the Buzz send and react tools (which fires only when the call
succeeded, before the next model call), it appends each call of the main
thread to <data>/hooks/reply-guard/<session>.jsonl, with the time, the tool
call's id and what the check needs (channel, reply, the keys tagged, the
operator names tagged, audience; the reaction's event id), and the
transcript's size in bytes then. Never the message text. At Stop, a recorded
call that this turn's transcript does not show counts as an answer to a message
whose entry was in the transcript before it was recorded: the entry ends within
the size the record holds. A record without that size goes by time instead
(the message's entry is older than the record; the same clock wrote both),
which a mid-turn delivery can mislead: its entry is stamped with its arrival,
though the agent sees it only once it is written. One the transcript shows is
read from the transcript, as before.

Python 3.9 compatible (macOS /usr/bin/python3). Prints nothing on allow.
"""
import json
import os
import re
import sys
import time

TAIL_CAP = int(os.environ.get("REPLY_GUARD_TAIL_CAP", str(32 * 1024 * 1024)))
OPT = "CLAUDE_PLUGIN_OPTION_"


def state_dir():
    """The plugin's data folder, else ~/.local/state/ghost-protocol (as the channel's)."""
    data = os.environ.get("CLAUDE_PLUGIN_DATA")
    if data:
        return os.path.join(data, "hooks")
    xdg = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(xdg, "ghost-protocol", "hooks")


LOG_PATH = os.path.join(state_dir(), "reply-guard.log")
RECORD_DIR = os.path.join(state_dir(), "reply-guard")
RECORD_TAIL = 256 * 1024       # bytes of a record file read at Stop (its newest calls)
RECORD_MAX = 1024 * 1024       # past this, a record file keeps only its newest RECORD_TAIL bytes
RECORD_DAYS = 7                # record files untouched this long are removed


def option(name):
    """A plugin option from the hook's environment, trimmed; "" when unset."""
    v = os.environ.get(OPT + name.upper())
    return v.strip() if isinstance(v, str) else ""


def helper_names():
    """The reaction helpers in reply_guard_helpers: a comma list of script
    names, such as react.sh. Empty (the default): none."""
    names = []
    for n in option("reply_guard_helpers").split(","):
        n = n.strip()
        if re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", n) and n not in names:
            names.append(n)
    return names


HELPERS = helper_names()


def task_roots_on():
    """The plugin option task_roots: on, or off (the default)."""
    return option("task_roots").lower() == "on"

HEX64_RE = re.compile(r"^[0-9a-f]{64}$")
# The channel's own tag, matched only at the very start of the delivered text
# (re.match). A tag written inside a message (or quoted in a thread) never is.
HEAD_RE = re.compile(r'<channel source="([^"]*buzz-channel)"((?: [a-z_]+="[^"<>]*")*)>')
ATTR_RE = re.compile(r' ([a-z_]+)="([^"<>]*)"')
# The channel's thread context: the LAST block, closing right before </channel>.
CTX_RE = re.compile(r'<thread_context thread_id="([0-9a-f]{64})"((?: [a-z_]+="[^"<>]*")*)>([^<]*(?:<(?!/?thread_context)[^<]*)*)</thread_context>\s*</channel>\s*\Z')
CTX_MSG_RE = re.compile(r'<thread_message event_id="([0-9a-f]{64})"')
SEND_RE = re.compile(r"^mcp__.*buzz__send$")
REACT_RE = re.compile(r"^mcp__.*buzz__react$")
# The buzz channel's own tool that sets a task root's state (src/task.mjs).
TASK_RE = re.compile(r"^mcp__.*buzz-channel__task$")
TASK_STATES = ("open", "done", "emergency")
# A top-level DM root of at most this many words, and characters (mentions
# left out), only opens a topic: it needs a state only, no reply, unless it
# was set done.
ROOT_WORDS = 2
ROOT_CHARS = 40
# A reaction helper's call (reply_guard_helpers): <helper> <64hex> [<state>], by its
# name or a path ending in it.
HELPER_RE = re.compile(r"""(?:^|[\s/;&|(`'"])(%s)['"]?\s+['"]?([0-9a-fA-F]{64})['"]?(?:\s+['"]?([A-Za-z]+))?"""
                       % "|".join(re.escape(n) for n in HELPERS)) if HELPERS else None
# Its success line, printed once the relay accepted the reaction: the id's first 8 hex,
# ": ", and "<old> -> <new>" or "+ <reaction>". A change to none (a removal) is no answer.
HELPER_OK = r"^%s: (?:\S+ -> (?!none\s*$)\S+|\+ \S+)\s*$"
# Inline tags in a send's text: nostr:npub1... and @Name (the send tool makes a mention of it).
NOSTR_RE = re.compile(r"nostr:(npub1[02-9ac-hj-np-z]{20,})", re.I)
# @Name counts as the send tool reads it: outside code spans, after whitespace or
# at the start, and followed by whitespace, , ; . ! ? : ) ] } or the end.
CODE_RE = re.compile(r"```.*?(?:```|\Z)|`[^`\n]*`", re.S)
AT_TAIL = r"(?=\s|[,;.!?:)\]}]|\Z)"
NAME_RE = re.compile(r"^[^\s@][^\n@]{0,63}$")


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def now_ms():
    """The time as Claude Code stamps transcript entries: UTC, milliseconds, Z."""
    t = time.time()
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(t)) + ".%03dZ" % (int(t * 1000) % 1000)


def log(session, decision, **kv):
    """One line per decision, ids only, never message text."""
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        parts = [now_iso(), "session=" + (session or "-")[:8], "decision=" + decision]
        for k, v in kv.items():
            if v is None or v == "" or v == []:
                continue
            if isinstance(v, (list, tuple)):
                v = ",".join(str(x) for x in v)
            parts.append("%s=%s" % (k, str(v).replace(" ", "_")))
        fd = os.open(LOG_PATH, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a") as f:
            f.write(" ".join(parts) + "\n")
    except Exception:
        pass


# --- The operator: from the plugin options, never hard-coded -------------------
BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"


def _polymod(values):
    gen = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    chk = 1
    for v in values:
        top = chk >> 25
        chk = (chk & 0x1FFFFFF) << 5 ^ v
        for i in range(5):
            chk ^= gen[i] if ((top >> i) & 1) else 0
    return chk


def npub_to_hex(s):
    """The 64-hex key of an npub1... string, or None (bad checksum or length)."""
    s = s.lower()
    if not s.startswith("npub1") or len(s) < 12:
        return None
    hrp, data = "npub", s[5:]
    if any(c not in BECH32 for c in data):
        return None
    vals = [BECH32.index(c) for c in data]
    if _polymod([ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp] + vals) != 1:
        return None
    acc, bits, out = 0, 0, []
    for v in vals[:-6]:
        acc = (acc << 5) | v
        bits += 5
        while bits >= 8:
            bits -= 8
            out.append((acc >> bits) & 0xFF)
    return bytes(out).hex() if len(out) == 32 else None


def parse_key(k):
    k = (k or "").strip().lower()
    if HEX64_RE.match(k):
        return k
    return npub_to_hex(k) if k.startswith("npub1") else None


def home_path(p):
    """A path from the settings, with a leading ~/ taken as the home folder (as the channel reads it)."""
    return os.path.join(os.path.expanduser("~"), p[2:]) if p.startswith("~/") else p


def operator_names(keys):
    """The operator's display names, for @Name tags: buzz_operator_names (a
    comma list), and the labels of the operator's keys in the sender allowlist
    file (buzz_allowlist_file), lower-cased."""
    names = set()
    for n in option("buzz_operator_names").split(","):
        n = n.strip()
        if NAME_RE.match(n):  # spaces allowed: matched literally after "@"
            names.add(n.lower())
    f = option("buzz_allowlist_file")
    if not f:
        return names
    try:
        with open(home_path(f), "r") as fh:
            entries = json.load(fh).get("entries")
    except Exception:
        return names
    if not isinstance(entries, list):
        return names
    for e in entries:
        if not isinstance(e, dict) or parse_key(str(e.get("pubkey") or "")) not in keys:
            continue
        label = str(e.get("label") or "").strip()
        if NAME_RE.match(label):
            names.add(label.lower())
    return names


def operator_keys():
    """(keys, names, source): the operator's keys from buzz_operator_pubkeys,
    else from buzz_trusted_pubkeys (comma lists, hex or npub1). (set(), set(),
    None) when neither names a valid key."""
    for src in ("buzz_operator_pubkeys", "buzz_trusted_pubkeys"):
        raw = option(src)
        keys = set(k for k in (parse_key(x) for x in re.split(r"[\s,]+", raw)) if k)
        if keys:
            return keys, operator_names(keys), src
    return set(), set(), None


# --- The current turn ---------------------------------------------------------------
TURN_MARK = b'"subtype":"turn_duration"'


def read_turn(path):
    """Raw lines of the current turn: after the last turn_duration entry.

    Reads backwards from the end, at most TAIL_CAP bytes. Returns (lines, found,
    base): found is True at a turn marker, "whole" when the whole file was read
    without one (a first turn), and False when the cap was reached without a
    marker; base is the file offset where lines[0] begins."""
    size = os.path.getsize(path)
    chunk = min(1024 * 1024, max(TAIL_CAP, 1))
    buf = b""
    pos = size
    with open(path, "rb") as f:
        while pos > 0 and (size - pos) < TAIL_CAP:
            step = min(chunk, pos)
            pos -= step
            f.seek(pos)
            buf = f.read(step) + buf
            body = buf if pos == 0 else (buf.split(b"\n", 1)[1] if b"\n" in buf else b"")
            idx = body.rfind(TURN_MARK)
            while idx != -1:
                start = body.rfind(b"\n", 0, idx) + 1
                end = body.find(b"\n", idx)
                end = len(body) if end == -1 else end
                try:
                    d = json.loads(body[start:end])
                    if isinstance(d, dict) and d.get("type") == "system" and d.get("subtype") == "turn_duration":
                        return body[end:].split(b"\n"), True, pos + len(buf) - len(body) + end
                except Exception:
                    pass
                idx = body.rfind(TURN_MARK, 0, start)
    if pos == 0:
        return buf.split(b"\n"), "whole", 0
    return [], False, 0


# --- Deliveries (untrusted relay content lives here) -----------------------------
def delivered_text(d):
    """The channel text if this entry is a buzz-channel delivery, else None."""
    if d.get("isSidechain") is True:
        return None
    t = d.get("type")
    if t == "user":
        o = d.get("origin")
        if not isinstance(o, dict) or o.get("kind") != "channel":
            return None
        c = (d.get("message") or {}).get("content")
        return c if isinstance(c, str) else None
    if t == "attachment":
        a = d.get("attachment") or {}
        o = a.get("origin")
        if a.get("type") != "queued_command" or not isinstance(o, dict) or o.get("kind") != "channel":
            return None
        p = a.get("prompt")
        return p if isinstance(p, str) else None
    return None


def parse_delivery(text):
    """The message's attributes from the channel's head tag, plus its thread
    context, or None when the tag is missing or malformed."""
    m = HEAD_RE.match(text)
    if not m:
        return None
    a = dict(ATTR_RE.findall(m.group(2)))
    ev, ch, au = a.get("event_id", "").lower(), a.get("channel_id", "").lower(), a.get("author", "").lower()
    if not HEX64_RE.match(ev) or not HEX64_RE.match(au) or not ch:
        return None
    th = a.get("thread_id", "").lower()
    msg = {"event_id": ev, "channel_id": ch, "author": au, "sent_at": a.get("sent_at", ""),
           "dm": a.get("dm") == "true", "thread_id": th if HEX64_RE.match(th) else "",
           "catch_up": a.get("catch_up") == "true", "ctx": None, "words": None, "chars": None}
    if not msg["thread_id"]:
        # A top-level message: its words, for a DM task root (a mention is no word).
        body = text[m.end():]
        body = body[:body.rfind("</channel>")] if "</channel>" in body else body
        words = [w for w in body.split() if not w.startswith("@") and not w.lower().startswith("nostr:")]
        msg["words"], msg["chars"] = len(words), sum(len(w) for w in words)
    # The channel adds its block only to a message in a thread, as the last one;
    # text inside it is escaped, so the last "<thread_context " is never one
    # written into the message. On a top-level message any block is sender text.
    i = text.rfind("<thread_context ") if msg["thread_id"] else -1
    c = CTX_RE.match(text, i) if i >= 0 else None
    if c and c.group(1) != msg["thread_id"]:
        c = None  # not this message's thread: not the channel's block
    if c:
        ca = dict(ATTR_RE.findall(c.group(2)))
        msg["ctx"] = {"thread_id": c.group(1), "since": ca.get("since", ""), "omitted": ca.get("omitted", ""),
                      "unavailable": ca.get("unavailable") == "true", "ids": set(CTX_MSG_RE.findall(c.group(3)))}
    return msg


# --- Ghost's answers -------------------------------------------------------------
def answers_in(d):
    """Buzz sends and reactions in one assistant entry, as action dicts."""
    out = []
    if d.get("type") != "assistant" or d.get("isSidechain") is True:
        return out
    content = (d.get("message") or {}).get("content")
    if not isinstance(content, list):
        return out
    for b in content:
        if not isinstance(b, dict) or b.get("type") != "tool_use":
            continue
        name, inp, tid = b.get("name") or "", b.get("input") or {}, b.get("id") or ""
        if not isinstance(inp, dict):
            continue
        if SEND_RE.match(name):
            ments = inp.get("mentions") if isinstance(inp.get("mentions"), list) else []
            text = inp.get("text") if isinstance(inp.get("text"), str) else ""
            tagged = set(k for k in (parse_key(str(x)) for x in ments) if k)
            tagged |= set(k for k in (npub_to_hex(x) for x in NOSTR_RE.findall(text)) if k)
            out.append({"kind": "send", "id": tid,
                        "channel": str(inp.get("channel") or "").lower(),
                        "reply": str(inp.get("reply") or "").lower(),
                        "mentions": tagged,
                        "text": CODE_RE.sub(" ", text),
                        "audience": inp.get("audience")})
        elif REACT_RE.match(name):
            if inp.get("off") is True:
                continue
            out.append({"kind": "react", "id": tid, "event": str(inp.get("id") or "").lower(), "helper": None})
        elif TASK_RE.match(name):
            if inp.get("state") not in TASK_STATES:
                continue  # none is a removal, not a state
            # It counts only with its success line in the result (line), as a helper's does.
            out.append({"kind": "task", "id": tid, "event": str(inp.get("id") or "").lower(), "helper": None,
                        "channel": str(inp.get("channel") or "").lower(), "state": inp.get("state"), "line": True})
        elif name == "Bash" and HELPERS:
            cmd = inp.get("command")
            if not isinstance(cmd, str):
                continue
            for hm in HELPER_RE.finditer(cmd):
                if (hm.group(3) or "").lower() == "clear":
                    continue
                out.append({"kind": "react", "id": tid, "event": hm.group(2).lower(), "helper": hm.group(1)})
    return out


def results_in(d, want):
    """(ids whose result here is an error, {id: result text} for ids in want)."""
    failed, texts = set(), {}
    if d.get("type") != "user":
        return failed, texts
    content = (d.get("message") or {}).get("content")
    if not isinstance(content, list):
        return failed, texts
    for b in content:
        if not isinstance(b, dict) or b.get("type") != "tool_result":
            continue
        tid = b.get("tool_use_id")
        if b.get("is_error") is True:
            failed.add(tid)
        if tid in want:
            c = b.get("content")
            if isinstance(c, list):
                c = "\n".join(x.get("text", "") for x in c if isinstance(x, dict) and isinstance(x.get("text"), str))
            texts[tid] = c if isinstance(c, str) else ""
    return failed, texts


# --- The check --------------------------------------------------------------------
NEEDLES = (b'"kind":"channel"', b"buzz__send", b"buzz__react", b"buzz-channel__task",
           b'"is_error":true') + tuple(n.encode() for n in HELPERS)


def scan(lines, base=0):
    """(messages, actions, failed ids, helper result texts) of the turn, each
    message and action with its position in the turn; each message also with
    the file offset where its entry ends (lines[0] begins at base)."""
    msgs, acts, failed, texts = [], [], set(), {}
    want, want_b = set(), []   # helper calls whose result text is needed
    off = base
    for i, raw in enumerate(lines):
        start, off = off, off + len(raw) + 1
        if not raw or b'"type":"api-request' in raw[:300]:
            continue
        if not any(n in raw for n in NEEDLES) and not (
                want_b and b'"tool_result"' in raw and any(w in raw for w in want_b)):
            continue
        try:
            d = json.loads(raw)
        except Exception:
            continue
        if not isinstance(d, dict):
            continue
        txt = delivered_text(d)
        if txt is not None:
            m = parse_delivery(txt)
            if m:
                m["idx"] = i
                m["end"] = start + len(raw)
                ts = d.get("timestamp")
                m["ts"] = ts if isinstance(ts, str) else ""
                msgs.append(m)
            continue
        for a in answers_in(d):
            a["idx"] = i
            acts.append(a)
            if (a.get("helper") or a.get("line")) and a["id"] not in want:
                want.add(a["id"])
                want_b.append(a["id"].encode())
        f, t = results_in(d, want)
        failed |= f
        texts.update(t)
    return msgs, acts, failed, texts


def thread_roots(msgs):
    """event id -> its thread root, for every event this turn shows."""
    roots = {}
    for m in msgs:
        roots[m["event_id"]] = m["thread_id"] or m["event_id"]
        if m["ctx"]:
            t = m["ctx"]["thread_id"]
            roots.setdefault(t, t)
            for e in m["ctx"]["ids"]:
                roots.setdefault(e, t)
    return roots


def helper_ok(a, texts):
    """A helper call counts only when its result holds a success line for the
    event (not just the command text: an echo, or a failure hidden by
    `; true`, prints none)."""
    pat = HELPER_OK % re.escape(a["event"][:8])
    return re.search(pat, texts.get(a["id"], ""), re.M | re.I) is not None


def after(a, m, failed):
    """Whether action a was made after message m arrived, and did not fail."""
    if a["idx"] is None:
        # Recorded at PostToolUse, not in the transcript yet: it counts only
        # for a message whose entry was written before it was recorded (it
        # ends within the transcript's size then), or, for a record without
        # that size, one stamped before it (the same clock).
        if a.get("off") is not None:
            if m["end"] > a["off"]:
                return False
        elif not m["ts"] or a["ts"] <= m["ts"]:
            return False
    elif a["idx"] <= m["idx"]:
        return False  # made before the message arrived
    return a["id"] not in failed  # the tool said it failed: it never reached him


def answered(m, acts, failed, texts, roots, ops, names, strict=False):
    """Whether an action answers m. strict (a DM with task roots on): only a
    send in m's thread, or a reaction on m in a thread, counts."""
    root = m["thread_id"] or m["event_id"]
    for a in acts:
        if not after(a, m, failed):
            continue
        if a["kind"] in ("react", "task"):
            if strict and not m["thread_id"]:
                continue  # a top-level task root's state is checked apart
            if a["event"] == m["event_id"] and (not (a["helper"] or a.get("line")) or helper_ok(a, texts)):
                return True
            continue
        if sends_answer(a, m, root, roots, ops, names, strict):
            return True
    return False


def stated(m, acts, failed, texts):
    """The states m, a DM task root, was given: the `task` tool on it, in its
    channel, with its success line (a call recorded at PostToolUse was checked
    then), or a reaction helper's success line for it. The Buzz react tool is
    no state. Each is "done" or "open" (any other state); empty when none."""
    out = set()
    for a in acts:
        if a["kind"] == "send" or a["event"] != m["event_id"] or not after(a, m, failed):
            continue
        if a["kind"] == "task" and a.get("channel") == m["channel_id"] and (not a.get("line") or helper_ok(a, texts)):
            out.add("done" if a.get("state") == "done" else "open")
        elif a["kind"] == "react" and a["helper"] and helper_ok(a, texts):
            out.add("done" if helper_done(a, texts) else "open")
    return out


def helper_done(a, texts):
    """Whether a helper's success line sets a done state (its new reaction
    names done, or is the adapter's default ✅)."""
    hm = re.search(r"^%s: (?:\S+ -> (\S+)|\+ (\S+))" % re.escape(a["event"][:8]), texts.get(a["id"], ""), re.M | re.I)
    new = (hm.group(1) or hm.group(2) or "") if hm else ""
    return "done" in new.lower() or new == "\u2705"


def sends_answer(a, m, root, roots, ops, names, strict=False):
    """A send answers m when it lands in m's channel and tags the operator (in
    mentions, or inline as nostr:npub or @Name), replies in m's thread, or is in
    his DM. strict (a DM with task roots on): only a reply in m's thread."""
    if a.get("audience") == "agents":
        return False  # marked for agents only
    in_thread = bool(a["reply"]) and roots.get(a["reply"], a["reply"]) == root
    if a["channel"] and a["channel"] != m["channel_id"]:
        return False
    if not a["channel"] or strict:
        return in_thread  # no channel: the reply says where it lands
    return in_thread or bool(a["mentions"] & ops) or at_names(a["text"], names) or m["dm"]


def at_names(text, names):
    """True when the text tags one of the operator's names as @Name."""
    for n in names:
        if re.search(r"(?:^|(?<=\s))@" + re.escape(n) + AT_TAIL, text, re.I):
            return True
    return False


def answered_before(m, msgs):
    """A catch-up message (sent while the session was away) that the thread
    shows the agent already spoke after: a later message in the same thread whose
    full thread context starts after the agent's own last post (since=agent_reply,
    nothing omitted) and no longer lists this one. A message's own context
    never shows it: the channel lists only older messages."""
    if not m["catch_up"]:
        return False
    root = m["thread_id"] or m["event_id"]
    for o in msgs:
        c = o["ctx"]
        if o["event_id"] == m["event_id"] or not c or c["unavailable"]:
            continue
        if c["thread_id"] != root or c["since"] != "agent_reply" or c["omitted"] != "0":
            continue
        if o["sent_at"] > m["sent_at"] and m["event_id"] not in c["ids"]:
            return True
    return False


# --- The record: Buzz calls kept at PostToolUse ---------------------------------------
SESSION_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,63}$")
TOOL_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def record_path(session):
    """The record file of one session, or None for an id that is not a plain name."""
    return os.path.join(RECORD_DIR, session + ".jsonl") if SESSION_RE.match(session or "") else None


def record(data):
    """PostToolUse on a Buzz send or react, or the channel's task tool: append the call to the session's
    record. Claude Code runs PostToolUse only for a call that succeeded (a
    failed one runs PostToolUseFailure), before the next model call. Only the
    main thread's calls, as in the transcript check. Returns why, for the log."""
    if data.get("agent_id"):
        return "subagent"
    path = record_path(str(data.get("session_id") or ""))
    tid, name = data.get("tool_use_id"), data.get("tool_name")
    if not path or not isinstance(tid, str) or not TOOL_ID_RE.match(tid) or not isinstance(name, str):
        return "bad-input"
    call = {"type": "assistant", "message": {"content": [
        {"type": "tool_use", "id": tid, "name": name, "input": data.get("tool_input")}]}}
    acts = [a for a in answers_in(call) if not a.get("helper")]
    if not acts:
        return "not-buzz"
    a = acts[0]
    if a["kind"] == "task" and not re.search(HELPER_OK % re.escape(a["event"][:8]),
                                             response_text(data.get("tool_response")), re.M | re.I):
        return "task-no-line"  # a refusal: no state was set
    rec = {"ts": now_ms(), "id": tid, "kind": a["kind"]}
    tp = data.get("transcript_path")
    if isinstance(tp, str) and tp and os.path.isfile(tp):
        # What the transcript held when the call was recorded: the messages the
        # agent had seen by then are in it, a message delivered later is not.
        rec["off"] = os.path.getsize(tp)
    if a["kind"] in ("react", "task"):
        rec["event"] = a["event"]
        if a["kind"] == "task":
            rec["channel"], rec["state"] = a["channel"], a["state"]
    else:
        # The operator names the text tags, as @Name: the names, never the text.
        names = operator_keys()[1]
        rec.update({"channel": a["channel"], "reply": a["reply"], "mentions": sorted(a["mentions"]),
                    "names": " ".join("@" + n for n in sorted(names) if at_names(a["text"], {n})),
                    "audience": a["audience"] if isinstance(a["audience"], str) else None})
    os.makedirs(RECORD_DIR, mode=0o700, exist_ok=True)
    if not os.path.exists(path):
        cutoff = time.time() - RECORD_DAYS * 86400
        for f in os.listdir(RECORD_DIR):
            p = os.path.join(RECORD_DIR, f)
            try:
                if f.endswith(".jsonl") and os.path.getmtime(p) < cutoff:
                    os.remove(p)
            except OSError:
                pass
    elif os.path.getsize(path) > RECORD_MAX:
        with open(path, "rb") as fh:
            fh.seek(-RECORD_TAIL, 2)
            keep = fh.read().split(b"\n", 1)[-1]
        tmp = path + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as fh:
            fh.write(keep)
        os.replace(tmp, path)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a") as fh:
        fh.write(json.dumps(rec, separators=(",", ":")) + "\n")
    return a["kind"]


def response_text(r):
    """A PostToolUse tool_response as text: a string, a list of text blocks,
    or an object holding either as content."""
    if isinstance(r, dict):
        r = r.get("content", r.get("text", ""))
    if isinstance(r, list):
        r = "\n".join(x.get("text", "") for x in r if isinstance(x, dict) and isinstance(x.get("text"), str))
    return r if isinstance(r, str) else ""


def recorded(session, shown):
    """The session's recorded Buzz calls as actions (idx None, with their time),
    leaving out the ones in `shown`, the tool call ids this turn's transcript
    holds: those are read from the transcript."""
    path = record_path(session)
    if not path or not os.path.isfile(path):
        return []
    with open(path, "rb") as fh:
        size = fh.seek(0, 2)
        fh.seek(max(0, size - RECORD_TAIL))
        raw = fh.read()
    if size > RECORD_TAIL:
        raw = raw.split(b"\n", 1)[-1]
    out = []
    for ln in raw.split(b"\n"):
        try:
            r = json.loads(ln)
        except Exception:
            continue
        if not isinstance(r, dict) or not isinstance(r.get("ts"), str) or not isinstance(r.get("id"), str):
            continue
        if r["id"] in shown:
            continue  # the transcript has it: its own copy decides
        off = r.get("off")
        a = {"id": r["id"], "ts": r["ts"], "idx": None,
             "off": off if isinstance(off, int) and not isinstance(off, bool) and off >= 0 else None}
        if r.get("kind") in ("react", "task"):
            # A task call's success line was checked when it was recorded.
            a.update({"kind": r["kind"], "event": str(r.get("event") or "").lower(), "helper": None,
                      "channel": str(r.get("channel") or "").lower(), "state": r.get("state"), "line": False})
        elif r.get("kind") == "send":
            ments = r.get("mentions") if isinstance(r.get("mentions"), list) else []
            a.update({"kind": "send", "channel": str(r.get("channel") or "").lower(),
                      "reply": str(r.get("reply") or "").lower(),
                      "mentions": set(k for k in (parse_key(str(x)) for x in ments) if k),
                      "text": str(r.get("names") or ""), "audience": r.get("audience")})
        else:
            continue
        out.append(a)
    return out


MAX_NAMED = 3


def describe(m, need=None):
    """One message and the ready call that answers it. need, for a DM task
    root: (it needs a state, it needs a send in its thread)."""
    where = "DM" if m["dm"] else "channel"
    if m["thread_id"] and m["thread_id"] != m["event_id"]:
        where += ", thread " + m["thread_id"][:12]
    if m["catch_up"]:
        where += ", catch-up"
    send = ('send(channel="%s", reply="%s", mentions=["%s"], audience="everyone", text=...)'
            % (m["channel_id"], m["event_id"], m["author"]))
    if need is None:
        return "Message %s (%s): %s, or react on %s." % (m["event_id"], where, send, m["event_id"])
    task = 'task(channel="%s", id="%s", state="open")' % (m["channel_id"], m["event_id"])
    if need[0] and need[1]:
        what = "set its state with the buzz channel's %s, and answer in its thread: %s." % (task, send)
    elif need[0]:
        what = "set its state with the buzz channel's %s." % task
    else:
        what = "answer in its thread: %s." % send
    return "Message %s (%s, a task root): %s" % (m["event_id"], where, what)


def block(reason):
    sys.stdout.write(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False) + "\n")


def main(mode="stop"):
    t0 = time.time()
    ms = lambda: int((time.time() - t0) * 1000)
    session = ""
    try:
        try:
            data = json.loads(sys.stdin.read() or "{}")
        except ValueError:
            data = None
        if not isinstance(data, dict):
            log("", "allow", why="bad-input", ms=ms())
            return 0
        session = str(data.get("session_id") or "")
        if mode == "record":
            log(session, "record", why=record(data), ms=ms())
            return 0
        valve = data.get("stop_hook_active") is True
        path = data.get("transcript_path") or ""
        if not isinstance(path, str) or not path or not os.path.isfile(path):
            log(session, "allow", why="no-transcript", ms=ms())
            return 0
        lines, found, base = read_turn(path)
        if found is False:
            log(session, "allow", why="no-turn-marker", ms=ms())
            return 0
        if not any(b'"kind":"channel"' in ln for ln in lines):
            log(session, "allow", why="no-message", ms=ms())
            return 0
        ops, names, src = operator_keys()
        if not ops:
            log(session, "allow", why="no-operator-key", ms=ms())
            return 0
        msgs, acts, failed, texts = scan(lines, base)
        roots = thread_roots(msgs)
        mine, seen = [], set()
        for m in msgs:
            if m["author"] not in ops:
                continue  # only the operator's messages need an answer
            if m["event_id"] in seen:
                continue
            seen.add(m["event_id"])
            mine.append(m)
        # Calls the transcript does not show yet (see the top): the record's.
        recs = recorded(session, set(a["id"] for a in acts)) if mine else []
        task_roots = task_roots_on()
        open_msgs, earlier, late, need = [], [], [], {}
        for m in mine:
            strict = task_roots and m["dm"]
            if strict and not m["thread_id"]:
                # A DM task root: a state, and a send in its thread unless it is
                # one or two words.
                states = stated(m, acts, failed, texts)
                rec_states = stated(m, recs, failed, texts) if recs else set()
                has_state = bool(states)
                used_recs = False
                if not has_state and rec_states:
                    has_state = used_recs = True
                # A short root only opens a topic: no reply, unless it was set
                # done (an answered ask needs its answer in the thread).
                short = m["words"] is not None and m["words"] <= ROOT_WORDS and m["chars"] <= ROOT_CHARS
                has_reply = short and "done" not in (states | rec_states)
                has_reply = has_reply or answered(m, acts, failed, texts, roots, ops, names, True)
                # A root delivered again after the session was away, which its
                # thread shows the agent already answered (answered_before).
                has_reply = has_reply or answered_before(m, msgs)
                if recs and not has_reply and answered(m, recs, failed, texts, roots, ops, names, True):
                    has_reply = used_recs = True
                if has_state and has_reply:
                    if used_recs:
                        late.append(m)
                    continue
                need[m["event_id"]] = (not has_state, not has_reply)
                open_msgs.append(m)
                continue
            if answered(m, acts, failed, texts, roots, ops, names, strict):
                continue
            if recs and answered(m, recs, failed, texts, roots, ops, names, strict):
                late.append(m)
                continue
            if answered_before(m, msgs):
                earlier.append(m)
                continue
            open_msgs.append(m)
        ids = lambda ws: [w["event_id"][:12] for w in ws]
        if not mine:
            log(session, "allow", why="no-operator-message", ms=ms())
            return 0
        if not open_msgs:
            log(session, "allow", why="answered", msgs=ids(mine), earlier=ids(earlier), late=ids(late), ms=ms())
            return 0
        if valve:
            # The turn after a block always ends: blocks at most once per stop.
            log(session, "miss", why="valve", open=ids(open_msgs), ms=ms())
            return 0
        shown, more = open_msgs[:MAX_NAMED], len(open_msgs) - MAX_NAMED
        parts = ["Reply guard: your operator messaged you on Buzz and has no answer there yet; terminal text"
                 " does not reach them.", " ".join(describe(m, need.get(m["event_id"])) for m in shown)]
        if more > 0:
            parts.append("+%d more." % more)
        if any(m["event_id"] not in need for m in open_msgs):
            parts.append("A reaction counts too: the Buzz react tool"
                         + (", or one of your reaction helpers (%s) as <helper> <id> <state>" % ", ".join(HELPERS)
                            if HELPERS else "") + ".")
        if task_roots and any(m["dm"] for m in open_msgs):
            parts.append("In a DM (task_roots on), reply to the message itself or to its thread's root, never"
                         " to a message of your own and never at the top level.")
        if need:
            parts.append("A task root (a top-level DM from your operator, with task_roots on) is answered in its"
                         " thread, never at the top level"
                         + ("; one of your reaction helpers (%s) as <helper> <id> <state> also sets its state"
                            % ", ".join(HELPERS) if HELPERS else "") + ".")
        parts.append("Then stop.")
        reason = " ".join(parts)
        log(session, "block", why="unanswered", open=ids(open_msgs),
            roots=[i[:12] for i in need], ms=ms())
        block(reason)
        return 0
    except Exception as e:
        # Fail open: a bug in the guard never holds a turn.
        log(session, "record" if mode == "record" else "allow", why="error-" + type(e).__name__, ms=ms())
        return 0


if __name__ == "__main__":
    sys.exit(main("record" if sys.argv[1:2] == ["record"] else "stop"))
