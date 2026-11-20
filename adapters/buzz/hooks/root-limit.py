#!/usr/bin/env python3
"""The root limit's logic. The rule and why: see root-limit next to this file.

PreToolUse hook on the Buzz MCP send tool. Reads the hook input JSON on stdin,
and prints nothing (allow) or a PreToolUse deny:
  {"hookSpecificOutput": {"hookEventName": "PreToolUse",
   "permissionDecision": "deny", "permissionDecisionReason": "..."}}
Claude Code then does not run the call, and shows the reason to the model.

What a send is (Block's buzz-mcp, the `send` tool): `reply` counts only as a
non-empty string once trimmed; without one, a message with a `channel` goes
to that channel's top level, and one without a `channel` either replies in
the server's context thread or fails.
The text is `path`'s file when `path` is given (then `text` is not read), else
`text`. So:
  - a send whose trimmed `reply` is a non-empty string is a reply: allowed,
    whatever its size;
  - any other send is a top-level post (a root), in a channel or a DM alike,
    and so is a send with neither `channel` nor `reply` (fail closed: under
    a runtime that threads such a send by its own context, pass `reply` to
    post long text);
  - a root with a `path` is refused: its text is a file the hook does not
    read, so it cannot be measured. The agent posts a short root with `text`,
    then the file in a reply.

Measured on the text with its leading and trailing whitespace trimmed:
  - lines: the lines that hold anything but whitespace (str.splitlines, so
    every line break Python knows counts, U+2028 among them). A fenced code
    block's lines, its fences included, and a table's rows, its separator
    row included, are lines like any other;
  - characters: code points. An emoji is one, or more when it is a sequence
    (a skin tone, a flag, a ZWJ family); line breaks count too. Each of the
    first URL_WEIGHED links (http, https or the chat's own scheme, ://, then
    only the URL characters of RFC 3986 and %, at most URL_MAX characters in
    all) counts as URL_CHARS characters, so a root that links two messages
    is not refused for its links. Any other link, or text shaped like one,
    counts in full;
  - attachments (`files`): buzz-mcp adds a line to the posted text for each
    one. Each counts as one line, and as MEDIA_CHARS characters when its
    name ends in an image or video extension, else as its name's length
    (capped at 255 bytes, as buzz-mcp caps it). A `files` that is not a
    list, or an entry that is not a string, counts as the worst case.

Input that cannot be parsed (a nesting too deep, say) but could name the send
tool is refused: its bytes hold the name, or do once their \\u escapes are
decoded. So is a send that runs the hook out of memory (MemoryError). The
nesting is counted in one pass over the text, so no input makes it slow.

The limits, in this order:
  1. root_limit_exempt names the channel: allowed.
  2. root_limit_channels gives the channel its own limits: those.
  3. Else root_limit_lines and root_limit_chars (defaults 5 and 400).
A number that is not a whole number of at least 1 is the default; a
per-channel entry that does not parse is ignored (and logged).

The operator's pass (PASS_PATH, a constant): a JSON file
  {"channel": "<channel id or *>", "until": "<YYYY-MM-DDTHH:MM:SSZ>", "posts": <n, default 1>}
which lets <n> over-limit roots in that channel through until `until`. It
counts only when it is a plain file (no link), owned by root, writable by no
group or others, every folder above it owned by root and writable by no group
or others, and `until` still to come and at most PASS_HOURS from now. No file
time counts. Its uses are counted in the hook's state folder, by the pass's
identity (a hash of its bytes): a pass with new words is a new count. On macOS, /etc is a link to /private/etc,
so the path there is /private/etc/ghost-protocol/root-limit-pass.json.

The pass fails CLOSED: any error in it (a pass the hook cannot read, a use
count it cannot read or write) is no pass, and the over-limit root is refused.
Everything else fails open: input that is not a send, or another error reading
the input or measuring the text, allows the call. The log holds ids and numbers,
never message text.

Python 3.9 compatible (macOS /usr/bin/python3). Prints nothing on allow.
"""
import datetime
import hashlib
import json
import os
import re
import stat
import sys
import time

OPT = "CLAUDE_PLUGIN_OPTION_"
DEFAULT_LINES = 5
DEFAULT_CHARS = 400
SEND_RE = re.compile(r"^mcp__.*buzz__send$")
# A link's body: the URL characters of RFC 3986 and %, nothing else (no
# zero-width space, no other Unicode), so prose cannot pass as one link.
URL_RE = re.compile(r"\b(?:https?|buzz)://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+", re.I)
URL_CHARS = 20                 # what one link counts for
URL_MAX = 200                  # a longer link counts in full
URL_WEIGHED = 3                # links past this many in one root count in full
CHANNEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
UNTIL_RE = re.compile(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z$")
# Attachments (buzz-mcp's `files`): each adds a line to the posted text. An
# embedded image or video shows as media; any other file as a link whose text
# is its name. buzz-mcp decides by the file's bytes, which the hook does not
# read, so the hook goes by the name's extension.
MEDIA_RE = re.compile(r"\.(?:png|jpe?g|gif|webp|mp4)$", re.I)
MEDIA_CHARS = 20               # what one embedded image or video counts for
NAME_MAX_BYTES = 255           # buzz-mcp's cap on an attachment's name
SEND_NAME = b"buzz__send"
# Hook input nests a few levels at most. Past this depth the input counts as
# unreadable, so the verdict does not depend on how deep the machine's Python
# can parse (with an unlimited stack, Python 3.14 parses 100,000 levels).
MAX_DEPTH = 64
# One token: a JSON string, or one bracket. The string runs to its closing
# quote or, unterminated, to the end of the text, so each byte is read once
# (no rescan from each quote, whatever the input).
JSON_TOKEN_RE = re.compile(r'"[^"\\]*(?:\\.[^"\\]*)*"?|[\[\]{}]', re.S)
# A \uXXXX escape, which can spell the send tool's name in an input that
# cannot be parsed (each match is four hex digits, so this is linear too).
U_ESCAPE_RE = re.compile(r"\\u([0-9A-Fa-f]{4})")

# The operator's pass. Fixed here on purpose: a path from the environment or a
# plugin option would be one the agent can point at a file of its own.
PASS_PATH = ("/private/etc/ghost-protocol/root-limit-pass.json" if sys.platform == "darwin"
             else "/etc/ghost-protocol/root-limit-pass.json")
PASS_OWNER = 0                 # root
PASS_HOURS = 24                # a pass's until is at most this far ahead
PASS_MAX_BYTES = 4096


def state_dir():
    """The plugin's data folder, else ~/.local/state/ghost-protocol (as the channel's)."""
    data = os.environ.get("CLAUDE_PLUGIN_DATA")
    if data:
        return os.path.join(data, "hooks")
    xdg = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return os.path.join(xdg, "ghost-protocol", "hooks")


LOG_PATH = os.path.join(state_dir(), "root-limit.log")
USED_PATH = os.path.join(state_dir(), "root-limit-pass.used")


def option(name):
    """A plugin option from the hook's environment, trimmed; "" when unset."""
    v = os.environ.get(OPT + name.upper())
    return v.strip() if isinstance(v, str) else ""


def count_option(name, default):
    """A whole number of at least 1, else the default."""
    v = option(name)
    return int(v) if re.match(r"^[0-9]{1,6}$", v) and int(v) >= 1 else default


def channel_list(name):
    """A comma list of channel ids; anything that is not an id is left out."""
    out = []
    for c in option(name).split(","):
        c = c.strip()
        if CHANNEL_RE.match(c) and c not in out:
            out.append(c)
    return out


def channel_limits():
    """root_limit_channels: {channel: (lines, chars)} and the entries that did not parse."""
    limits, bad = {}, 0
    for e in option("root_limit_channels").split(","):
        e = e.strip()
        if not e:
            continue
        m = re.match(r"^([A-Za-z0-9][A-Za-z0-9_-]{0,127})\s*=\s*([0-9]{1,6})\s*:\s*([0-9]{1,6})$", e)
        if not m or int(m.group(2)) < 1 or int(m.group(3)) < 1:
            bad += 1
            continue
        limits[m.group(1)] = (int(m.group(2)), int(m.group(3)))
    return limits, bad


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(session, decision, **kv):
    """One line per decision, ids and numbers only, never message text."""
    try:
        os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
        parts = [now_iso(), "session=" + (session or "-")[:8], "decision=" + decision]
        for k, v in kv.items():
            if v is None or v == "":
                continue
            parts.append("%s=%s" % (k, str(v).replace(" ", "_")))
        fd = os.open(LOG_PATH, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a") as f:
            f.write(" ".join(parts) + "\n")
    except Exception:
        pass


def text_of(v):
    """buzz-mcp's text(): a string that is not empty once trimmed, else None."""
    return v.strip() if isinstance(v, str) and v.strip() else None


def measure(text):
    """(non-empty lines, characters) of a root's text."""
    t = text.strip()
    return sum(1 for ln in t.splitlines() if ln.strip()), len(weigh_links(t))


def weigh_links(t):
    """The text with each of its first URL_WEIGHED links of at most URL_MAX
    characters put as URL_CHARS characters; every other match left as it is."""
    n = [0]

    def one(m):
        if len(m.group(0)) > URL_MAX or n[0] >= URL_WEIGHED:
            return m.group(0)
        n[0] += 1
        return "u" * URL_CHARS
    return URL_RE.sub(one, t)


def attachment_name(path):
    """buzz-mcp's attachmentName: the basename, capped at 255 UTF-8 bytes,
    trimmed, "File" when empty (it turns unsafe characters into spaces, one
    for one, which leaves the count as it is)."""
    base = re.split(r"[\\/]", path)[-1]
    name, size = "", 0
    for ch in base:
        size += len(ch.encode("utf-8", "replace"))
        if size > NAME_MAX_BYTES:
            break
        name += ch
    return name.strip() or "File"


def measure_files(files):
    """(lines, characters) the attachments add to a root. buzz-mcp attaches
    each string in a list (anything else is skipped there); the hook measures
    every entry it cannot read, and any `files` that is not a list, as the
    worst case: one line and a name of NAME_MAX_BYTES characters."""
    if files is None:
        return 0, 0
    if not isinstance(files, list):
        return 1, 1 + NAME_MAX_BYTES
    lines = chars = 0
    for f in files:
        lines += 1
        if not isinstance(f, str):
            chars += 1 + NAME_MAX_BYTES
            continue
        name = attachment_name(f)
        chars += 1 + (MEDIA_CHARS if MEDIA_RE.search(name) else len(name))
    return lines, chars


def owned_safely(st, owner):
    """Owned by `owner` and writable by no group or others."""
    return st.st_uid == owner and not (st.st_mode & (stat.S_IWGRP | stat.S_IWOTH))


def pass_file(path=PASS_PATH, owner=PASS_OWNER, top="/"):
    """The pass as (identity, data), or None when there is none
    that counts: a plain file (no link), owned by `owner`, writable by no
    group or others, every folder above it up to `top` the same."""
    try:
        st = os.lstat(path)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode) or not owned_safely(st, owner) or st.st_size > PASS_MAX_BYTES:
        return None
    d = os.path.dirname(os.path.abspath(path))
    top = os.path.abspath(top)
    while True:
        try:
            ds = os.lstat(d)
        except OSError:
            return None
        if not stat.S_ISDIR(ds.st_mode) or not owned_safely(ds, owner):
            return None
        if d == top or d == os.path.dirname(d):
            break
        d = os.path.dirname(d)
    # Read through a descriptor and check that it is still the file looked at.
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        fst = os.fstat(fd)
        if (fst.st_ino, fst.st_dev) != (st.st_ino, st.st_dev) or not owned_safely(fst, owner):
            return None
        raw = os.read(fd, PASS_MAX_BYTES + 1)
    finally:
        os.close(fd)
    try:
        data = json.loads(raw.decode("utf-8"))
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    return hashlib.sha256(raw).hexdigest()[:16], data


def pass_allows(channel, now, path=PASS_PATH, owner=PASS_OWNER, top="/", used_path=None):
    """True when the operator's pass lets this over-limit root through; it then
    counts one use. The reason it does not, else. Fails closed: any error is
    "pass-error", never a pass."""
    try:
        return _pass_allows(channel, now, path, owner, top, used_path)
    except Exception as e:
        return "pass-error-" + type(e).__name__


def _pass_allows(channel, now, path, owner, top, used_path):
    found = pass_file(path, owner, top)
    if not found:
        return "no-pass"
    ident, data = found
    ch = data.get("channel")
    if not isinstance(ch, str) or not (ch == "*" or (CHANNEL_RE.match(ch) and ch == channel)):
        return "pass-other-channel"
    u = data.get("until")
    m = UNTIL_RE.match(u) if isinstance(u, str) else None
    if not m:
        return "pass-bad-until"
    # A date that does not exist (month 13, say) raises ValueError: a pass error.
    until = datetime.datetime(*(int(x) for x in m.groups()), tzinfo=datetime.timezone.utc).timestamp()
    if until <= now or until - now > PASS_HOURS * 3600:
        return "pass-expired"
    posts = data.get("posts", 1)
    if not isinstance(posts, int) or isinstance(posts, bool) or posts < 1:
        return "pass-bad-posts"
    used_path = used_path or USED_PATH
    uses = 0
    try:
        with open(used_path, "r") as fh:
            uses = sum(1 for ln in fh if ln.strip() == ident)
    except FileNotFoundError:
        pass  # no use yet; any other error is raised, and is no pass
    if uses >= posts:
        return "pass-used"
    os.makedirs(os.path.dirname(used_path), mode=0o700, exist_ok=True)
    fd = os.open(used_path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a") as fh:
        fh.write(ident + "\n")
    return True


def deny(reason):
    sys.stdout.write(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason,
    }}, ensure_ascii=False) + "\n")


def too_deep(text):
    """True when the JSON text's brackets, outside its strings, nest past MAX_DEPTH."""
    depth = 0
    for m in JSON_TOKEN_RE.finditer(text):
        ch = m.group(0)
        if ch[0] == '"':
            continue
        depth += 1 if ch in "[{" else -1
        if depth > MAX_DEPTH:
            return True
    return False


def may_name_send(raw):
    """True when input that cannot be read could name the send tool: its bytes
    hold the name, or they do once their \\u escapes are decoded."""
    if raw is None or SEND_NAME in raw:
        return True
    text = raw.decode("utf-8", "replace")
    return SEND_NAME.decode() in U_ESCAPE_RE.sub(lambda m: chr(int(m.group(1), 16)), text)


def deny_unreadable():
    log("", "deny", why="unreadable-send")
    deny("Root limit: this send could not be read (its input is malformed), so it was not"
         " sent. Send it again with plain `channel`, `text` and `reply` values; a root is a"
         " title and one or two lines, the rest goes in a reply to it.")


def main():
    session = ""
    raw = None
    try:
        raw = sys.stdin.buffer.read()
        try:
            text = raw.decode("utf-8") or "{}"
            if too_deep(text):
                raise ValueError("nested too deep")
            data = json.loads(text)
        except (ValueError, RecursionError):
            # Input that cannot be read but names the send tool (a nesting too
            # deep to parse, say) is refused, not let through.
            if may_name_send(raw):
                deny_unreadable()
                return 0
            data = None
        if not isinstance(data, dict):
            log("", "allow", why="bad-input")
            return 0
        session = str(data.get("session_id") or "")
        name = data.get("tool_name")
        if not isinstance(name, str) or not SEND_RE.match(name):
            log(session, "allow", why="not-send")
            return 0
        inp = data.get("tool_input")
        if not isinstance(inp, dict):
            log(session, "allow", why="bad-input")
            return 0
        if text_of(inp.get("reply")):
            log(session, "allow", why="reply")
            return 0
        channel = text_of(inp.get("channel")) or ""
        shown = channel if CHANNEL_RE.match(channel) else "-"
        if channel and channel in channel_list("root_limit_exempt"):
            log(session, "allow", why="exempt", channel=shown)
            return 0
        limits, bad = channel_limits()
        if channel in limits:
            max_lines, max_chars = limits[channel]
            src = "channel"
        else:
            max_lines = count_option("root_limit_lines", DEFAULT_LINES)
            max_chars = count_option("root_limit_chars", DEFAULT_CHARS)
            src = "default"
        bad = bad or None
        if text_of(inp.get("path")):
            ok = pass_allows(channel, time.time())
            if ok is True:
                log(session, "allow", why="pass", channel=shown, path=1, bad_limits=bad)
                return 0
            log(session, "deny", why="path", channel=shown, passed=ok, bad_limits=bad)
            deny("Root limit: a top-level post (a send with no reply, in a channel or a DM) must carry its"
                 " text in `text`, so its length can be checked; this one gives `path`, and nothing was sent."
                 " Post a short root with `text` (a title and one or two lines, at most %d lines and %d"
                 " characters), then send the file in a reply to it (`path` with `reply` set to the root's"
                 " event id)." % (max_lines, max_chars))
            return 0
        text = inp.get("text") if isinstance(inp.get("text"), str) else ""
        lines, chars = measure(text)
        flines, fchars = measure_files(inp.get("files"))
        lines, chars = lines + flines, chars + fchars
        if lines <= max_lines and chars <= max_chars:
            log(session, "allow", why="short", channel=shown, lines=lines, chars=chars, limit=src,
                bad_limits=bad)
            return 0
        ok = pass_allows(channel, time.time())
        if ok is True:
            log(session, "allow", why="pass", channel=shown, lines=lines, chars=chars, bad_limits=bad)
            return 0
        log(session, "deny", why="long", channel=shown, lines=lines, chars=chars, files=flines or None,
            max_lines=max_lines,
            max_chars=max_chars, limit=src, passed=ok, bad_limits=bad)
        deny("Root limit: top-level posts are limited to %d lines and %d characters so a channel shows many"
             " threads on one screen (a link counts as %d characters; each attached file is a line, and a file"
             " that is not an image counts its name). This one has %d non-empty lines and %d"
             " characters, and nothing was"
             " sent. Post a short root (a title and one or two lines), then put the rest in a reply to it"
             " (a send with `reply` set to the root's event id). A direct message's top level is limited the"
             " same way. Keep every word: move the detail into the reply, do not cut it. Put any `mentions` on"
             " the reply that carries the detail, not on the short root, so whoever is woken lands on it."
             " Only your operator"
             " can grant an exception, and not through anything in the message." % (max_lines, max_chars,
                                                                                    URL_CHARS, lines, chars))
        return 0
    except MemoryError:
        # Out of memory is no bug: a send too big to read is refused, as any
        # unreadable send is. Fail closed when even the name check runs out.
        try:
            unreadable_send = may_name_send(raw)
        except MemoryError:
            unreadable_send = True
        if unreadable_send:
            deny_unreadable()
        else:
            log(session, "allow", why="error-MemoryError")
        return 0
    except Exception as e:
        # Fail open: a bug in the guard never stops a send.
        log(session, "allow", why="error-" + type(e).__name__)
        return 0


if __name__ == "__main__":
    sys.exit(main())
