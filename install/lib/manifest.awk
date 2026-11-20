# manifest.awk: the syntax half of the instance manifest check
# (install/schema/instance-v1.md; schema v0 is still read). POSIX awk only: it runs under macOS awk and
# Ubuntu's mawk, so no gawk extensions and no {n} intervals.
#
# Accepts blank lines, whole-line # comments, [section] headers,
# key = "string" and key = ["a", "b"]. Anything else is an error.
# Output, one per line, tab-separated:
#   <key>\t<value>            a string (key is name or section.name)
#   <key>#\t<count>           an array's length
#   <key>[]\t<element>        each array element, in order
#   ERR\t<line>\t<message>    an error; the exit status is then 1

BEGIN {
    sec = ""
    nerr = 0
    known_sec["github"] = 1; known_sec["claude"] = 1; known_sec["setup"] = 1; known_sec["memory_guard"] = 1
    known_sec["automode_guard"] = 1; known_sec["memory_backup"] = 1
    type["", "schema"] = "s"; type["", "name"] = "s"; type["", "dir"] = "s"; type["", "root"] = "s"
    type["github", "login"] = "s"; type["github", "also_login"] = "s"; type["github", "host_config"] = "s"; type["github", "repos"] = "a"
    type["claude", "email"] = "s"
    type["setup", "command"] = "s"
    type["memory_guard", "enabled"] = "s"; type["memory_guard", "term_percent"] = "s"; type["memory_guard", "kill_percent"] = "s"
    type["automode_guard", "enabled"] = "s"; type["automode_guard", "snapshot"] = "s"; type["automode_guard", "read_paths"] = "a"
    type["automode_guard", "buzz_relay_url"] = "s"; type["automode_guard", "buzz_key_command"] = "s"
    type["automode_guard", "buzz_channel"] = "s"; type["automode_guard", "buzz_mentions"] = "a"
    type["automode_guard", "buzz_task_open_emoji"] = "s"; type["automode_guard", "buzz_task_open_emoji_url"] = "s"
    type["automode_guard", "owner"] = "s"; type["automode_guard", "ledger"] = "s"
    type["memory_backup", "enabled"] = "s"; type["memory_backup", "folder"] = "s"; type["memory_backup", "remote"] = "s"
    type["memory_backup", "branch"] = "s"; type["memory_backup", "read_paths"] = "a"
    type["memory_backup", "buzz_relay_url"] = "s"; type["memory_backup", "buzz_key_command"] = "s"
    type["memory_backup", "buzz_channel"] = "s"; type["memory_backup", "buzz_mentions"] = "a"
    type["memory_backup", "max_file_kb"] = "s"; type["memory_backup", "max_removed_percent"] = "s"
    type["memory_backup", "buzz_task_open_emoji"] = "s"; type["memory_backup", "buzz_task_open_emoji_url"] = "s"
}

function err(msg) {
    printf "ERR\t%d\t%s\n", NR, msg
    nerr++
}

{
    line = $0
    sub(/\r$/, "", line)
    sub(/^[ \t]+/, "", line)
    sub(/[ \t]+$/, "", line)
    if (line == "" || substr(line, 1, 1) == "#") next

    if (substr(line, 1, 1) == "[" && line ~ /^\[[a-z_]+\]$/) {
        name = substr(line, 2, length(line) - 2)
        if (!(name in known_sec)) { err("unknown section [" name "]"); sec = "?"; next }
        if (name in seen_sec) err("section [" name "] appears twice")
        seen_sec[name] = 1
        sec = name
        next
    }

    if (line !~ /^[a-z_]+[ \t]*=/) { err("not a [section] header or a key = value line"); next }
    key = line; sub(/[ \t]*=.*$/, "", key)
    val = line; sub(/^[a-z_]+[ \t]*=[ \t]*/, "", val)
    if (sec == "?") next
    full = (sec == "") ? key : sec "." key
    if (!((sec, key) in type)) { err("unknown key " full); next }
    if (full in seen) { err("key " full " appears twice"); next }
    seen[full] = 1

    if (type[sec, key] == "s") {
        if (val !~ /^"[^"\\\t]*"$/) {
            err(full " must be one string in double quotes, with no backslash or quote inside")
            next
        }
        printf "%s\t%s\n", full, substr(val, 2, length(val) - 2)
        next
    }

    # An array of strings on one line: ["a", "b"] or [].
    if (val !~ /^\[.*\]$/) { err(full " must be an array of strings, like [\"a\", \"b\"]"); next }
    inner = substr(val, 2, length(val) - 2)
    sub(/^[ \t]+/, "", inner)
    sub(/[ \t]+$/, "", inner)
    n = 0
    ok = 1
    while (inner != "") {
        if (!match(inner, /^"[^"\\\t]*"/)) { ok = 0; break }
        n++
        elem[n] = substr(inner, 2, RLENGTH - 2)
        inner = substr(inner, RLENGTH + 1)
        sub(/^[ \t]+/, "", inner)
        if (inner == "") break
        if (substr(inner, 1, 1) != ",") { ok = 0; break }
        inner = substr(inner, 2)
        sub(/^[ \t]+/, "", inner)
        if (inner == "") { ok = 0; break }
    }
    if (!ok) { err(full " must be an array of strings, like [\"a\", \"b\"]"); next }
    printf "%s#\t%d\n", full, n
    for (i = 1; i <= n; i++) printf "%s[]\t%s\n", full, elem[i]
}

END { exit (nerr > 0) ? 1 : 0 }
