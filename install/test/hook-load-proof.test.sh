#!/usr/bin/env bash
# hook-load-proof.test.sh: hooks/load-proof, the SessionStart hook that records,
# in the instance's state folder (proof.json) and on Buzz, which rule files a
# start of the instance's own claude found: the class file (CLAUDE.md in the
# instance's home) and the team repo's AGENTS.md (the @ import in the user's
# rules/team-repo.md), each by sha256, first line and path, with the plugin's
# version and commit.
#
# Hermetic: a throwaway HOME holds the instance (a git checkout with a schema v1
# manifest), the team repo, the rulebook and a stand-in for the instance's own
# claude (hooks/lib/own-claude.sh); node is a stub that records its call and
# stands in for the adapter's one-shot send. The real send, against the fake
# relay, is adapters/buzz/test/load-proof.test.mjs.
#
# LOAD_PROOF_HOOK=<hooks/load-proof of a plugin copy> runs this test once
# against that copy (adapters/buzz/test/load-proof-mutants.mjs breaks copies
# one guard at a time and runs it against each; every copy must fail).
# `hook-load-proof.test.sh --make-plugin DIR` makes such a copy of the tree.
# The checks read `cond && ok "..." || bad "..."`: ok never fails, so bad runs
# only when cond does (SC2015). Some commands under test hold a literal ~ or $.
# shellcheck disable=SC2015,SC2016,SC2059,SC2088
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# make_plugin DIR: the files the hook runs from, as a plugin copy; the adapter
# is a marker, since the send is a stub here.
make_plugin() {
    local d="$1"
    mkdir -p "$d/hooks/lib" "$d/install/lib" "$d/.claude-plugin" "$d/adapters/buzz/src" \
        "$d/adapters/buzz/node_modules/nostr-tools" "$d/adapters/buzz/node_modules/@modelcontextprotocol/sdk"
    cp "$SRC/hooks/load-proof" "$d/hooks/load-proof"
    cp "$SRC/hooks/lib/hook.sh" "$SRC/hooks/lib/own-claude.sh" "$d/hooks/lib/"
    cp "$SRC/install/lib/common.sh" "$SRC/install/lib/instance.sh" "$SRC/install/lib/manifest.awk" "$d/install/lib/"
    echo '{"name":"ghost-protocol","version":"9.8.7"}' >"$d/.claude-plugin/plugin.json"
    : >"$d/adapters/buzz/src/launch.mjs"
    echo '{}' >"$d/adapters/buzz/node_modules/nostr-tools/package.json"
    echo '{}' >"$d/adapters/buzz/node_modules/@modelcontextprotocol/sdk/package.json"
    chmod +x "$d/hooks/load-proof"
}
if [ "${1:-}" = "--make-plugin" ]; then make_plugin "$2"; exit $?; fi

t_new
if ! t_tool jq; then
    echo "SKIP  every case (no jq on this machine; the hook needs it)"
    finish_tests
    exit $?
fi
if [ -n "${LOAD_PROOF_HOOK:-}" ]; then
    HOOK="$LOAD_PROOF_HOOK"
    PL="$(cd "$(dirname "$HOOK")/.." && pwd -P)"
else
    PL="$T/plugin"
    make_plugin "$PL"
    HOOK="$PL/hooks/load-proof"
fi

H="$T/home"; R="$H/work"; I="$R/instance"; TEAM="$R/repos/example/team"
ST="$H/.local/state/ghost-protocol/instance"
RULES="$H/.claude/rules/team-repo.md"
CB="$T/claude-bin"
t_claude_standin "$CB"
t_claude_standin "$CB" 2.1.314
SID=0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b
SID2=1c2d3e4f-5061-4723-9b8c-0d1e2f3a4b5c
CH=0000aaaa-1111-2222-3333-444455556666
RELAY=wss://relay.example.test
KEYCMD="op read op://vault/item/field"
SQ="'"
EVENT="$(printf '%064d' 7 | tr 0 a)"

# The instance: ~/work/instance (schema v1, name instance), a checkout; the team
# repo under ~/work/repos/example/team, a checkout whose origin names example/team.
mkdir -p "$I/.ghost-protocol" "$TEAM"
cp "$FIX/manifests/good-v1.toml" "$I/.ghost-protocol/instance.toml"
git init -q "$I" && git -C "$I" add -A && git -C "$I" commit -q -m one
git init -q "$TEAM" && git -C "$TEAM" remote add origin https://github.com/example/team.git

# The stub node: records what it was called with, then exits as told.
mkdir -p "$T/nodebin"
cat >"$T/nodebin/node" <<STUB
#!/bin/bash
S="$T/state"
echo x >>"\$S/node.calls"
printf '%s\n' "\$@" >"\$S/node.args"
cat >"\$S/node.stdin"
{
    printf 'RELAY=%s\n' "\${BUZZ_RELAY_URL-<unset>}"
    printf 'KEYCMD=%s\n' "\${BUZZ_KEY_COMMAND-<unset>}"
    printf 'SOCKET=%s\n' "\${BUZZ_KEY_SOCKET-<unset>}"
    printf 'PRIVATE=%s\n' "\${BUZZ_PRIVATE_KEY-<unset>}"
    printf 'TIMEOUT_MS=%s\n' "\${BUZZ_SEND_TIMEOUT_MS-<unset>}"
    printf 'CANARY=%s\n' "\${GP_CANARY-<unset>}"
} >"\$S/node.env"
if [ -f "\$S/node.sleep" ]; then sleep "\$(cat "\$S/node.sleep")"; fi
rc=0
if [ -f "\$S/node.exit" ]; then rc=\$(cat "\$S/node.exit"); fi
if [ "\$rc" = 0 ] && [ ! -f "\$S/node.silent" ]; then echo "sent $EVENT"; fi
exit "\$rc"
STUB
chmod +x "$T/nodebin/node"
# timeout in a folder of its own, so a run can have it or leave it out; a PATH without perl too.
mkdir -p "$T/tobin" "$T/noperl"
if command -v timeout >/dev/null 2>&1; then ln -sf "$(command -v timeout)" "$T/tobin/timeout"; fi
for f in "$T"/sysbin/*; do [ "$(basename "$f")" = perl ] || ln -sf "$(readlink "$f")" "$T/noperl/$(basename "$f")"; done
HAVE_TIMEOUT=0; [ -x "$T/tobin/timeout" ] && HAVE_TIMEOUT=1
NODEPATH="$T/sysbin:$T/nodebin"
HOST_TIMEOUT=()
if command -v timeout >/dev/null 2>&1; then HOST_TIMEOUT=(timeout 30); fi

world() {
    rm -rf "$H/.local" "$H/.claude" "$T/xdg" "$I/CLAUDE.md" "$TEAM/AGENTS.md" "$H/loose"
    rm -f "$T"/state/node.*
    mkdir -p "$ST" "$H/.claude/rules"
    printf '# Class file for the test\nsecond line\n' >"$I/CLAUDE.md"
    printf '# AGENTS.md\nthe team rules\n' >"$TEAM/AGENTS.md"
    printf 'Intro line.\n\n@~/work/repos/example/team/AGENTS.md\n' >"$RULES"
    git -C "$TEAM" remote remove origin 2>/dev/null
    git -C "$TEAM" remote add origin https://github.com/example/team.git
}
# input SOURCE [SESSION] [AGENT]: SessionStart's input.
input() {
    local agent=""
    [ -n "${3:-}" ] && agent=",\"agent_id\":\"$3\""
    printf '{"hook_event_name":"SessionStart","source":"%s","session_id":"%s","cwd":"%s"%s}' "$1" "${2:-$SID}" "${CWD:-$I}" "$agent"
}
# run INPUT [VAR=value ...]: the hook with those variables only, run by WHO as
# in hook-session-id.test.sh (pane, between, renamed, nested, twin, other, bare).
# HPATH is its PATH; INST its GP_INSTANCE_NAME.
run() {
    local in="$1" pane="${PANE:-$ST/pane-pid}" bg="" i=0; shift
    # The switch is off unless it is explicitly on: every run turns it on, except with LP_ABSENT=1 (no such option at all), and a
    # later CLAUDE_PLUGIN_OPTION_LOAD_PROOF=<value> in "$@" overrides it.
    local lp=(CLAUDE_PLUGIN_OPTION_LOAD_PROOF=on)
    [ -z "${LP_ABSENT:-}" ] || lp=()
    local base=(env -i PATH="${HPATH:-$T/sysbin}" HOME="$H" LANG=C GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1
        CLAUDE_PROJECT_DIR="${PROJ:-$I}" GP_INSTANCE_NAME="${INST-instance}" ${lp[@]+"${lp[@]}"} "$@")
    case "${WHO:-pane}" in
        pane)    printf '%s' "$in" | "${HOST_TIMEOUT[@]+"${HOST_TIMEOUT[@]}"}" "${base[@]}" PANE_FILE="$pane" "$CB/claude" "$HOOK" >"$OUT" 2>&1 ;;
        between) printf '%s' "$in" | "${base[@]}" PANE_FILE="$pane" "$CB/claude" bash -c '"$@"; exit $?' sh "$HOOK" >"$OUT" 2>&1 ;;
        renamed) printf '%s' "$in" | "${base[@]}" PANE_FILE="$pane" "$CB/2.1.314" "$HOOK" >"$OUT" 2>&1 ;;
        nested)  printf '%s' "$in" | "${base[@]}" PANE_FILE="$pane" "$CB/claude" "$CB/claude" "$HOOK" >"$OUT" 2>&1 ;;
        twin)    printf '%s' "$in" | "${base[@]}" PANE_FILE="$pane" "$CB/2.1.314" "$CB/2.1.314" "$HOOK" >"$OUT" 2>&1 ;;
        other)
            rm -f "$pane"
            env -i PATH="$T/sysbin" PANE_FILE="$pane" "$CB/claude" sleep 30 </dev/null >/dev/null 2>&1 &
            bg=$!
            while [ ! -s "$pane" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
            printf '%s' "$in" | "${base[@]}" "$CB/claude" "$HOOK" >"$OUT" 2>&1 ;;
        bare)    printf '%s' "$in" | "${base[@]}" "$HOOK" >"$OUT" 2>&1 ;;
    esac
    RC=$?
    if [ -n "$bg" ]; then pkill -P "$bg" 2>/dev/null; kill "$bg" 2>/dev/null; wait "$bg" 2>/dev/null; fi
}
# post_opts: the plugin options of a posting instance, one per line.
post_opts() {
    printf '%s\n' "CLAUDE_PLUGIN_OPTION_LOAD_PROOF_CHANNEL=$CH" "CLAUDE_PLUGIN_OPTION_BUZZ_RELAY_URL=$RELAY" \
        "CLAUDE_PLUGIN_OPTION_BUZZ_KEY_COMMAND=$KEYCMD"
}
# prun INPUT [VAR=value ...]: run, with the stub node and the options of a
# posting instance (a later VAR=value overrides an option).
prun() {
    local in="$1" l; shift
    local o=(); while IFS= read -r l; do o+=("$l"); done < <(post_opts)
    HPATH="${HPATH:-$NODEPATH:$T/tobin}" run "$in" "${o[@]}" "$@"
}
pj() { jq -r "$1" "$ST/proof.json"; }
perm() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
calls() { if [ -f "$T/state/node.calls" ]; then wc -l <"$T/state/node.calls" | tr -d ' '; else echo 0; fi; }
nenv() { sed -n "s/^$1=//p" "$T/state/node.env"; }
quiet_ok() { rc_is 0 && [ ! -s "$OUT" ]; }
no_temp() { [ "$(find "$ST" -name '.proof.*' | wc -l | tr -d ' ')" = 0 ]; }
# An earlier start's proof, to see whether a run leaves it alone.
inode() { stat -c %i "$1" 2>/dev/null || stat -f %i "$1"; }
old_proof() { printf '{"old":"proof"}\n' >"$ST/proof.json"; OLD_SUM="$(sha_of "$ST/proof.json")"; OLD_INO="$(inode "$ST/proof.json")"; }
old_untouched() { [ "$(sha_of "$ST/proof.json")" = "$OLD_SUM" ] && [ "$(inode "$ST/proof.json")" = "$OLD_INO" ]; }
nothing_done() { rc_is 0 && [ ! -s "$OUT" ] && old_untouched && no_temp && [ "$(calls)" = 0 ]; }
first_of() {   # a printf format for CLAUDE.md's bytes: the first_line recorded for it
    printf "$1" >"$I/CLAUDE.md"; run "$(input startup)"; pj '.class.first_line'
}

# 1. A start in the instance's own claude, file only: the whole record.
world
run "$(input startup)"
{ quiet_ok; } && ok "startup: exit 0, nothing printed" || bad "startup: exit 0, nothing printed"
{ [ -f "$ST/proof.json" ] && [ "$(perm "$ST/proof.json")" = 600 ] && no_temp; } && ok "startup: proof.json is there, mode 0600, no temporary file left" || bad "startup: proof.json is there, mode 0600, no temporary file left"
{ [ "$(pj '[.schema,.instance,.session_id,.source]|join(" ")')" = "ghost-protocol/load-proof/v1 instance $SID startup" ]; } && ok "the schema, the instance, the session id and the source" || bad "the schema, the instance, the session id and the source"
{ sh -c "jq -r .time '$ST/proof.json' | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\$'"; } && ok "the time is UTC, to the second" || bad "the time is UTC, to the second"
{ [ "$(pj '[.class.status,.class.sha256,.class.first_line,.class.path]|join("|")')" = "ok|$(sha_of "$I/CLAUDE.md")|# Class file for the test|$I/CLAUDE.md" ]; } && ok "class: ok, the sha256 of CLAUDE.md in the home, its first line, its path" || bad "class: ok, the sha256 of CLAUDE.md in the home, its first line, its path"
{ [ "$(pj '[.agents.status,.agents.sha256,.agents.first_line,.agents.path,.agents.repo]|join("|")')" = "ok|$(sha_of "$TEAM/AGENTS.md")|# AGENTS.md|$TEAM/AGENTS.md|example/team" ]; } && ok "agents: ok, the sha256 of the imported AGENTS.md, its first line, its path, its repo" || bad "agents: ok, the sha256 of the imported AGENTS.md, its first line, its path, its repo"
{ [ "$(pj '[.plugin.version,.plugin.commit]|map(tostring)|join(" ")')" = "9.8.7 null" ]; } && ok "the plugin's version is the copy's, its commit unknown (no git, no installed list)" || bad "the plugin's version is the copy's, its commit unknown (no git, no installed list)"
{ [ "$(pj .claude_pid)" = "$(tr -d '[:space:]' <"$ST/pane-pid")" ] && [ "$(pj '.claude_pid|type')" = number ]; } && ok "claude_pid is the pid start wrote to pane-pid, as a number" || bad "claude_pid is the pid start wrote to pane-pid, as a number"
{ [ "$(pj '[.posted,.error]|map(tostring)|join(" ")')" = "false no-channel" ] && [ "$(calls)" = 0 ]; } && ok "no channel: not posted, with the error class no-channel, and nothing called" || bad "no channel: not posted, with the error class no-channel, and nothing called"

# 2. The hash is of the exact bytes: no newline, CRLF, a changed byte.
world; printf 'abc' >"$I/CLAUDE.md"; run "$(input startup)"
{ [ "$(pj .class.sha256)" = "$(sha_of "$I/CLAUDE.md")" ]; } && ok "sha256 of a file with no newline at the end" || bad "sha256 of a file with no newline at the end"
world; printf '# Title\r\nbody\r\n' >"$I/CLAUDE.md"; run "$(input startup)"
{ [ "$(pj .class.sha256)" = "$(sha_of "$I/CLAUDE.md")" ] && [ "$(pj .class.first_line)" = "# Title" ]; } && ok "sha256 of a CRLF file, and no carriage return in its first line" || bad "sha256 of a CRLF file, and no carriage return in its first line"
world; run "$(input startup)"; A="$(pj .class.sha256)"
printf '# Class file for the test\nsecond line!\n' >"$I/CLAUDE.md"; run "$(input startup)"
{ [ "$(pj .class.sha256)" != "$A" ] && [ "$(pj .class.sha256)" = "$(sha_of "$I/CLAUDE.md")" ]; } && ok "one changed byte, another sha256" || bad "one changed byte, another sha256"
world; : >"$I/CLAUDE.md"; run "$(input startup)"
{ [ "$(pj .class.status)" = ok ] && [ "$(pj .class.first_line)" = "" ] && [ "$(pj .class.sha256)" = "$(sha_of "$I/CLAUDE.md")" ]; } && ok "an empty file: its sha256, an empty first line" || bad "an empty file: its sha256, an empty first line"
world; printf '\n# not the first line\n' >"$I/CLAUDE.md"; run "$(input startup)"
{ [ "$(pj .class.first_line)" = "" ]; } && ok "a blank first line is the first line" || bad "a blank first line is the first line"
world; printf 'binary \377\376 line\n' >"$I/CLAUDE.md"; run "$(input startup)"
{ [ "$(pj .class.status)" = ok ] && [ "$(pj .class.sha256)" = "$(sha_of "$I/CLAUDE.md")" ]; } && ok "bytes that are not UTF-8: still recorded, the sha256 of the bytes" || bad "bytes that are not UTF-8: still recorded, the sha256 of the bytes"

# 3. The first line: cut at 120 characters (not bytes), and cleaned.
world; X200="$(printf '%0200d' 0 | tr 0 x)"; first_of "$X200\n" >/dev/null
{ [ "$(pj '.class.first_line|length')" = 120 ] && [ "$(pj .class.first_line)" = "$(printf '%0120d' 0 | tr 0 x)" ]; } && ok "a first line of 200 characters is cut to the first 120" || bad "a first line of 200 characters is cut to the first 120"
world; printf '%0119d\n' 0 | tr 0 y >"$I/CLAUDE.md"; run "$(input startup)"
{ [ "$(pj '.class.first_line|length')" = 119 ]; } && ok "119 characters stay whole" || bad "119 characters stay whole"
world; E130="$(for _ in $(seq 1 130); do printf '\303\251'; done)"; printf '%s\n' "$E130" >"$I/CLAUDE.md"; run "$(input startup)"
{ [ "$(pj '.class.first_line|length')" = 120 ] && [ "$(jq -j .class.first_line "$ST/proof.json" | LC_ALL=C wc -c | tr -d ' ')" = 240 ]; } && ok "130 two-byte characters are cut to 120 characters, not 120 bytes" || bad "130 two-byte characters are cut to 120 characters, not 120 bytes"
world
{ [ "$(first_of 'a\033[1mb `c` "d" \342\200\256e\342\200\213f\tg\007h\302\205i\342\200\250j\n')" = "a[1mb c ${SQ}d${SQ} ef ghij" ]; } && ok "control characters, backticks, direction and zero-width characters go; a double quote becomes a single one; a tab a space" || bad "control characters, backticks, direction and zero-width characters go; a double quote becomes a single one; a tab a space"
world
{ [ "$(first_of '```sh\n')" = "sh" ]; } && ok "a fence of backticks in a heading: gone" || bad "a fence of backticks in a heading: gone"
world
{ [ "$(first_of '# A\007B\033C\000D\n')" = "# ABCD" ]; } && ok "a bell, an escape and a NUL byte in the heading" || bad "a bell, an escape and a NUL byte in the heading"
world
{ [ "$(first_of '# @someone nostr:npub1abc\n')" = "# @someone nostr:npub1abc" ]; } && ok "an @ and a nostr: link stay as text (only a p tag mentions anyone)" || bad "an @ and a nostr: link stay as text (only a p tag mentions anyone)"
world; printf '# Heading\nsecond line has `ticks`\n' >"$I/CLAUDE.md"; run "$(input startup)"
{ [ "$(pj .class.first_line)" = "# Heading" ]; } && ok "only the first line is kept" || bad "only the first line is kept"

# 4. Sources: a start, a resume and a clear record; a compaction and the rest do not.
for src in startup resume clear; do
    world; run "$(input "$src")"
    { [ "$(pj .source)" = "$src" ] && quiet_ok; } && ok "$src: recorded, with that source" || bad "$src: recorded, with that source"
done
for src in compact other ""; do
    world; old_proof; run "$(input "$src")"
    { nothing_done; } && ok "source '$src': nothing done, the earlier proof untouched" || bad "source '$src': nothing done, the earlier proof untouched"
done
world; old_proof; run "$(input startup "$SID" agent-1)"
{ nothing_done; } && ok "a subagent: nothing done" || bad "a subagent: nothing done"
world; old_proof; run "$(input startup not-a-uuid)"
{ nothing_done; } && ok "a session id that is not a UUID: nothing done" || bad "a session id that is not a UUID: nothing done"
world; run "$(input startup)"; run "$(input clear "$SID2")"
{ [ "$(pj '[.session_id,.source]|join(" ")')" = "$SID2 clear" ]; } && ok "a clear gives the proof the new session id" || bad "a clear gives the proof the new session id"

# 5. Only the instance's own claude: nothing written, nothing removed, nothing posted.
world; old_proof
INST="" run "$(input startup)"
{ nothing_done; } && ok "no GP_INSTANCE_NAME (a session not started by start, or --test): nothing done" || bad "no GP_INSTANCE_NAME (a session not started by start, or --test): nothing done"
for bad in x/../instance ../instance -instance 'In stance' 'Instance'; do
    world; old_proof; mkdir -p "$H/.local/state/ghost-protocol/x"
    INST="$bad" run "$(input startup)"
    { nothing_done; } && ok "GP_INSTANCE_NAME '$bad' is not a plain name: nothing done" || bad "GP_INSTANCE_NAME '$bad' is not a plain name: nothing done"
done
for who in nested other bare twin; do
    world; old_proof
    WHO=$who prun "$(input startup)"
    { nothing_done; } && ok "WHO=$who (a claude the instance's claude started, a claude in another tmux window, no claude): nothing done, even posting" || bad "WHO=$who (a claude the instance's claude started, a claude in another tmux window, no claude): nothing done, even posting"
done
world; old_proof; PANE="$T/pane-elsewhere" prun "$(input startup)"
{ nothing_done; } && ok "no pane-pid file: nothing done" || bad "no pane-pid file: nothing done"
for bad in "abc" "" "1" "12 34"; do
    world; old_proof; printf '%s\n' "$bad" >"$ST/pane-pid"
    WHO=bare prun "$(input startup)"
    { nothing_done; } && ok "pane-pid '$bad' (not the pane's pid): nothing done" || bad "pane-pid '$bad' (not the pane's pid): nothing done"
done
world; old_proof; ln -s "$T/pid-target" "$ST/pane-pid"
prun "$(input startup)"
{ nothing_done; } && ok "a pane-pid that is a symlink: nothing done" || bad "a pane-pid that is a symlink: nothing done"
world; rm -rf "$ST"
prun "$(input startup)" 2>/dev/null
{ [ ! -e "$H/.local/state/ghost-protocol/instance" ] && [ "$(calls)" = 0 ]; } && ok "no state folder (start never ran here): none made, nothing posted" || bad "no state folder (start never ran here): none made, nothing posted"
world; WHO=between run "$(input startup)"
{ [ "$(pj .claude_pid)" = "$(tr -d '[:space:]' <"$ST/pane-pid")" ]; } && ok "the instance's claude, with a shell between it and the hook: its pid recorded" || bad "the instance's claude, with a shell between it and the hook: its pid recorded"
{ [ "$(pj .session_id)" = "$SID" ]; } && ok "the instance's claude, with a shell between it and the hook: recorded" || bad "the instance's claude, with a shell between it and the hook: recorded"
world; WHO=renamed run "$(input startup)"
{ [ "$(pj .session_id)" = "$SID" ]; } && ok "the instance's claude under another process name (found by its pid): recorded" || bad "the instance's claude under another process name (found by its pid): recorded"
world; mkdir -p "$T/xdg/ghost-protocol/instance"
PANE="$T/xdg/ghost-protocol/instance/pane-pid" run "$(input startup)" XDG_STATE_HOME="$T/xdg"
{ [ -f "$T/xdg/ghost-protocol/instance/proof.json" ] && [ ! -e "$ST/proof.json" ]; } && ok "XDG_STATE_HOME: the file goes to start's folder there" || bad "XDG_STATE_HOME: the file goes to start's folder there"

# 6. An earlier start's proof never stands for this one.
world; old_proof; run "$(input resume)"
{ [ "$(pj .session_id)" = "$SID" ] && [ "$(pj .source)" = resume ] && no_temp; } && ok "an own start replaces the earlier proof in one step" || bad "an own start replaces the earlier proof in one step"
world; old_proof; run "$(input startup)" CLAUDE_PLUGIN_OPTION_LOAD_PROOF=off
{ rc_is 0 && [ ! -s "$OUT" ] && [ ! -e "$ST/proof.json" ]; } && ok "switch off, in the instance's own claude: the earlier proof is removed, nothing written" || bad "switch off, in the instance's own claude: the earlier proof is removed, nothing written"
world; old_proof; INST="" run "$(input startup)" CLAUDE_PLUGIN_OPTION_LOAD_PROOF=off
{ nothing_done; } && ok "switch off, not the instance's claude: the earlier proof untouched" || bad "switch off, not the instance's claude: the earlier proof untouched"
for v in OFF False no 0; do
    world; old_proof; run "$(input startup)" CLAUDE_PLUGIN_OPTION_LOAD_PROOF=$v
    { [ ! -e "$ST/proof.json" ]; } && ok "switch '$v' is off" || bad "switch '$v' is off"
done
for v in on ON True yes 1; do
    world; run "$(input startup)" CLAUDE_PLUGIN_OPTION_LOAD_PROOF=$v
    { [ -f "$ST/proof.json" ]; } && ok "switch '$v' is on" || bad "switch '$v' is on"
done
# Off by default: only an explicit on acts. Unset, empty and anything else count as off, and remove the earlier proof.
world; old_proof; LP_ABSENT=1 run "$(input startup)"
{ rc_is 0 && [ ! -s "$OUT" ] && [ ! -e "$ST/proof.json" ]; } && ok "switch unset: nothing written, the earlier proof is removed" || bad "switch unset: nothing written, the earlier proof is removed"
world; LP_ABSENT=1 prun "$(input startup)"
{ [ ! -e "$ST/proof.json" ] && [ "$(calls)" = 0 ]; } && ok "switch unset, with a channel set: no file and no post" || bad "switch unset, with a channel set: no file and no post"
world; old_proof; run "$(input startup)" CLAUDE_PLUGIN_OPTION_LOAD_PROOF=
{ [ ! -e "$ST/proof.json" ]; } && ok "switch empty: off" || bad "switch empty: off"
for v in maybe enabled 2 onn; do
    world; old_proof; run "$(input startup)" CLAUDE_PLUGIN_OPTION_LOAD_PROOF=$v
    { [ ! -e "$ST/proof.json" ]; } && ok "switch '$v' is not an explicit on: off" || bad "switch '$v' is not an explicit on: off"
done
world; old_proof; LP_ABSENT=1 INST="" run "$(input startup)"
{ nothing_done; } && ok "switch unset, not the instance's claude: the earlier proof untouched" || bad "switch unset, not the instance's claude: the earlier proof untouched"
world; mkdir "$ST/proof.json"; run "$(input startup)"
{ rc_is 0 && [ -d "$ST/proof.json" ] && [ "$(find "$ST/proof.json" -mindepth 1 | wc -l | tr -d ' ')" = 0 ]; } && ok "a folder named proof.json is left alone" || bad "a folder named proof.json is left alone"
world; echo "$T/elsewhere" >"$T/proof-target"; ln -s "$T/proof-target" "$ST/proof.json"; run "$(input startup)"
{ [ ! -L "$ST/proof.json" ] && [ "$(cat "$T/proof-target")" = "$T/elsewhere" ] && [ "$(pj .session_id)" = "$SID" ]; } && ok "a symlink named proof.json is replaced, its target untouched" || bad "a symlink named proof.json is replaced, its target untouched"
world; (umask 000; run "$(input startup)")
{ [ "$(perm "$ST/proof.json")" = 600 ]; } && ok "mode 0600 whatever the umask" || bad "mode 0600 whatever the umask"

# 7. The class file: the home through the manifest.
world; rm "$I/CLAUDE.md"; run "$(input startup)"
{ [ "$(pj '[.class.status,.class.reason,.class.path]|join("|")')" = "none|missing|$I/CLAUDE.md" ] && [ "$(pj .agents.status)" = ok ]; } && ok "no CLAUDE.md: none, missing, and the path that was looked at" || bad "no CLAUDE.md: none, missing, and the path that was looked at"
world; rm "$I/CLAUDE.md"; mkdir "$I/CLAUDE.md"; run "$(input startup)"
{ [ "$(pj '[.class.status,.class.reason]|join("|")')" = "none|not-a-file" ]; } && ok "CLAUDE.md a folder: none, not-a-file" || bad "CLAUDE.md a folder: none, not-a-file"
world; rm "$I/CLAUDE.md"; echo "# via a link" >"$T/real-class.md"; ln -s "$T/real-class.md" "$I/CLAUDE.md"; run "$(input startup)"
{ [ "$(pj .class.sha256)" = "$(sha_of "$T/real-class.md")" ] && [ "$(pj .class.first_line)" = "# via a link" ]; } && ok "CLAUDE.md a link to a file: the bytes it reaches, as Claude Code loads it" || bad "CLAUDE.md a link to a file: the bytes it reaches, as Claude Code loads it"
if command -v mkfifo >/dev/null 2>&1; then
    world; rm "$I/CLAUDE.md"; mkfifo "$I/CLAUDE.md"; run "$(input startup)"
    { [ "$(pj '[.class.status,.class.reason]|join("|")')" = "none|not-a-file" ]; } && ok "CLAUDE.md a FIFO: none, not-a-file, and the hook does not wait on it" || bad "CLAUDE.md a FIFO: none, not-a-file, and the hook does not wait on it"
fi
world; mkdir -p "$T/nomanifest" && git init -q "$T/nomanifest"; PROJ="$T/nomanifest" CWD="$T/nomanifest" run "$(input startup)"
{ [ "$(pj '[.class.status,.class.reason,(.class.path|tostring)]|join("|")')" = "none|no-home|null" ] && [ "$(pj .agents.status)" = ok ]; } && ok "a project with no manifest: class none, no-home, no path" || bad "a project with no manifest: class none, no-home, no path"
world; mkdir -p "$H/.local/state/ghost-protocol/other"
PANE="$H/.local/state/ghost-protocol/other/pane-pid" INST=other run "$(input startup)"
{ [ "$(jq -r '[.class.status,.class.reason]|join("|")' "$H/.local/state/ghost-protocol/other/proof.json")" = "none|no-home" ]; } && ok "a manifest naming another instance than GP_INSTANCE_NAME: class none, no-home" || bad "a manifest naming another instance than GP_INSTANCE_NAME: class none, no-home"
world; git -C "$I" worktree add -q "$T/wt" -b wt 2>/dev/null; PROJ="$T/wt" CWD="$T/wt" run "$(input startup)"
{ [ "$(pj .class.path)" = "$I/CLAUDE.md" ]; } && ok "a project that is a worktree of the home: the home's CLAUDE.md" || bad "a project that is a worktree of the home: the home's CLAUDE.md"
git -C "$I" worktree remove --force "$T/wt" 2>/dev/null; git -C "$I" branch -D wt >/dev/null 2>&1

# 8. The team file: the @ import of the rulebook, never another path.
world; rm "$RULES"; run "$(input startup)"
{ [ "$(pj '[.agents.status,.agents.reason,(.agents.path|tostring)]|join("|")')" = "none|no-rulebook|null" ] && [ "$(pj .class.status)" = ok ]; } && ok "no rulebook: agents none, no-rulebook, no path" || bad "no rulebook: agents none, no-rulebook, no path"
world; printf 'Just words, @mention in a line and an e-mail a@example.com\n' >"$RULES"; printf '# loose\n' >"$H/AGENTS.md"; printf '# loose\n' >"$R/repos/AGENTS.md"; run "$(input startup)"
{ [ "$(pj '[.agents.status,.agents.reason,(.agents.path|tostring)]|join("|")')" = "none|no-import|null" ]; } && ok "a rulebook with no whole-line import: none, no-import (an AGENTS.md at the home or in repos/ is not looked at)" || bad "a rulebook with no whole-line import: none, no-import (an AGENTS.md at the home or in repos/ is not looked at)"
rm -f "$H/AGENTS.md" "$R/repos/AGENTS.md"
world; printf 'Intro\n@~/work/repos/example/team/MISSING.md\n' >"$RULES"; run "$(input startup)"
{ [ "$(pj '[.agents.status,.agents.reason,.agents.path]|join("|")')" = "none|import-missing|$H/work/repos/example/team/MISSING.md" ]; } && ok "an import of a file that is not there: none, import-missing, the path it names" || bad "an import of a file that is not there: none, import-missing, the path it names"
world; printf '@~/work/repos/example/team\n' >"$RULES"; run "$(input startup)"
{ [ "$(pj '[.agents.status,.agents.reason]|join("|")')" = "none|import-unreadable" ]; } && ok "an import of a folder: none, import-unreadable" || bad "an import of a folder: none, import-unreadable"
world; printf '@~/work/repos/example/team/AGENTS.md\n@~/work/instance/CLAUDE.md\n' >"$RULES"; run "$(input startup)"
{ [ "$(pj '[.agents.status,.agents.reason,(.agents.path|tostring)]|join("|")')" = "none|several-imports|null" ]; } && ok "two imports: none, several-imports (it does not pick one)" || bad "two imports: none, several-imports (it does not pick one)"
world; printf 'Words\n```\n@~/work/repos/example/team/AGENTS.md\n```\n' >"$RULES"; run "$(input startup)"
{ [ "$(pj .agents.reason)" = no-import ]; } && ok "an import inside a code fence is not an import" || bad "an import inside a code fence is not an import"
world; printf 'See @~/work/repos/example/team/AGENTS.md for the rules\n' >"$RULES"; run "$(input startup)"
{ [ "$(pj .agents.reason)" = no-import ]; } && ok "an @ path in the middle of a sentence is not the whole-line import" || bad "an @ path in the middle of a sentence is not the whole-line import"
world; printf '@~/work/repos/example/team/AGENTS.md\n```\n@~/work/instance/CLAUDE.md\n```\n' >"$RULES"; run "$(input startup)"
{ [ "$(pj .agents.status)" = ok ]; } && ok "a fence after the import hides what is inside it only" || bad "a fence after the import hides what is inside it only"
world; printf 'x\r\n   @~/work/repos/example/team/AGENTS.md  \r\n' >"$RULES"; run "$(input startup)"
{ [ "$(pj .agents.path)" = "$TEAM/AGENTS.md" ]; } && ok "CRLF and spaces around the import line" || bad "CRLF and spaces around the import line"
world; printf '@%s\n' "$TEAM/AGENTS.md" >"$RULES"; run "$(input startup)"
{ [ "$(pj .agents.path)" = "$TEAM/AGENTS.md" ]; } && ok "an absolute import" || bad "an absolute import"
world; printf '@../../work/repos/example/team/AGENTS.md\n' >"$RULES"; run "$(input startup)"
{ [ "$(pj .agents.sha256)" = "$(sha_of "$TEAM/AGENTS.md")" ]; } && ok "a relative import is read from the rulebook's own folder" || bad "a relative import is read from the rulebook's own folder"
world; printf '@~someone/AGENTS.md\n' >"$RULES"; run "$(input startup)"
{ [ "$(pj .agents.reason)" = unsupported-path ]; } && ok "@~user/ is not supported: none, unsupported-path" || bad "@~user/ is not supported: none, unsupported-path"
world; mkdir -p "$R/repos/example/my team"; printf '# spaced\n' >"$R/repos/example/my team/AGENTS.md"; printf '@~/work/repos/example/my\\ team/AGENTS.md\n' >"$RULES"; run "$(input startup)"
{ [ "$(pj .agents.first_line)" = "# spaced" ]; } && ok "an escaped space in the import's path" || bad "an escaped space in the import's path"
world; rm "$RULES"; mkdir -p "$T/cfg/rules"; printf '@%s\n' "$TEAM/AGENTS.md" >"$T/cfg/rules/team-repo.md"; run "$(input startup)" CLAUDE_CONFIG_DIR="$T/cfg"
{ [ "$(pj .agents.status)" = ok ]; } && ok "CLAUDE_CONFIG_DIR: the rulebook there" || bad "CLAUDE_CONFIG_DIR: the rulebook there"
world; mkdir -p "$H/loose"; printf '# loose\n' >"$H/loose/AGENTS.md"; printf '@~/loose/AGENTS.md\n' >"$RULES"; run "$(input startup)"
{ [ "$(pj .agents.repo)" = unknown ] && [ "$(pj .agents.status)" = ok ]; } && ok "a file in no repo and no repos/ layout: repo unknown" || bad "a file in no repo and no repos/ layout: repo unknown"
world; git -C "$TEAM" remote set-url origin git@github.com:other-owner/other.repo.git; run "$(input startup)"
{ [ "$(pj .agents.repo)" = other-owner/other.repo ]; } && ok "the repo from an ssh origin" || bad "the repo from an ssh origin"
world; git -C "$TEAM" remote set-url origin https://x-access-token:SECRETTOKEN@example.com/team-owner/team-repo; run "$(input startup)"
{ [ "$(pj .agents.repo)" = team-owner/team-repo ] && ! grep -q SECRETTOKEN "$ST/proof.json"; } && ok "the repo from an origin with credentials, none of them kept" || bad "the repo from an origin with credentials, none of them kept"
world; git -C "$TEAM" remote set-url origin https://x-access-token:SECRETTOKEN@example.com/repo; prun "$(input startup)"
{ [ "$(pj .agents.repo)" = unknown ] && ! grep -q SECRETTOKEN "$ST/proof.json" && ! grep -q SECRETTOKEN "$T/state/node.stdin" && grep -q ' agents unknown ' "$T/state/node.stdin"; } && ok "an origin with a credential where the owner would be: repo unknown, the token in neither proof.json nor the line" || bad "an origin with a credential where the owner would be: repo unknown, the token in neither proof.json nor the line"
world; git -C "$TEAM" remote remove origin; run "$(input startup)"
{ [ "$(pj .agents.repo)" = example/team ]; } && ok "no origin: the repo from the repos/<owner>/<repo>/ layout" || bad "no origin: the repo from the repos/<owner>/<repo>/ layout"

# 9. The plugin's version and commit.
world; run "$(input startup)"
{ [ "$(pj '[.plugin.version,(.plugin.commit|tostring)]|join(" ")')" = "9.8.7 null" ]; } && ok "no installed list and not a checkout: version, commit null" || bad "no installed list and not a checkout: version, commit null"
COMMIT=0123456789abcdef0123456789abcdef01234567
world; mkdir -p "$H/.claude/plugins"
jq -n --arg p "$PL" --arg c "$COMMIT" '{version:2,plugins:{"ghost-protocol@ghost-protocol":[{scope:"user",installPath:$p,version:"9.8.7",gitCommitSha:$c}],"other@x":[{installPath:"/nowhere",gitCommitSha:"ffffffffffffffffffffffffffffffffffffffff"}]}}' >"$H/.claude/plugins/installed_plugins.json"
run "$(input startup)"
{ [ "$(pj .plugin.commit)" = "$COMMIT" ]; } && ok "the commit from the installed list's entry for this plugin's folder" || bad "the commit from the installed list's entry for this plugin's folder"
jq '.plugins["ghost-protocol@ghost-protocol"][0].gitCommitSha = "not-a-commit"' "$H/.claude/plugins/installed_plugins.json" >"$T/ip.json" && mv "$T/ip.json" "$H/.claude/plugins/installed_plugins.json"
run "$(input startup)"
{ [ "$(pj '.plugin.commit|tostring')" = null ]; } && ok "a commit that is not 40 hex characters is not used" || bad "a commit that is not 40 hex characters is not used"
jq '.plugins["ghost-protocol@ghost-protocol"][0] = {installPath:"/nowhere",gitCommitSha:"0123456789abcdef0123456789abcdef01234567"}' "$H/.claude/plugins/installed_plugins.json" >"$T/ip.json" && mv "$T/ip.json" "$H/.claude/plugins/installed_plugins.json"
run "$(input startup)"
{ [ "$(pj '.plugin.commit|tostring')" = null ]; } && ok "an entry for another folder is not this plugin's" || bad "an entry for another folder is not this plugin's"
run "$(input startup)" CLAUDE_PLUGIN_ROOT="/nowhere"
{ [ "$(pj .plugin.commit)" = "$COMMIT" ]; } && ok "CLAUDE_PLUGIN_ROOT also matches an installPath" || bad "CLAUDE_PLUGIN_ROOT also matches an installPath"
world
git init -q "$PL" 2>/dev/null; git -C "$PL" add -A >/dev/null 2>&1; git -C "$PL" commit -q -m plugin 2>/dev/null
run "$(input startup)"
{ [ "$(pj .plugin.commit)" = "$(git -C "$PL" rev-parse HEAD)" ]; } && ok "a checkout of the plugin: its HEAD" || bad "a checkout of the plugin: its HEAD"
rm -rf "$PL/.git"
world; PLP="$(dirname "$PL")"; git init -q "$PLP" 2>/dev/null; git -C "$PLP" commit -q --allow-empty -m outer 2>/dev/null
run "$(input startup)"
check_commit_null() { [ "$(pj '.plugin.commit|tostring')" = null ]; }
{ check_commit_null; } && ok "a plugin folder inside some other repo is not a checkout of the plugin: commit null" || bad "a plugin folder inside some other repo is not a checkout of the plugin: commit null"
rm -rf "$PLP/.git"

# 10. The Buzz line, through the stub node.
world; prun "$(input startup)"
SHA_C="$(sha_of "$I/CLAUDE.md")"; SHA_A="$(sha_of "$TEAM/AGENTS.md")"
LINE="load-proof instance session 0b1c2d3e: class ${SHA_C:0:12} \"# Class file for the test\"; agents example/team ${SHA_A:0:12} \"# AGENTS.md\""
{ quiet_ok && [ "$(calls)" = 1 ]; } && ok "posted: one send, nothing printed into the session" || bad "posted: one send, nothing printed into the session"
{ [ "$(tr '\n' ' ' <"$T/state/node.args")" = "$PL/adapters/buzz/src/launch.mjs send --channel $CH " ]; } && ok "the send is launch.mjs send --channel <the option's channel>, from the plugin's adapter" || bad "the send is launch.mjs send --channel <the option's channel>, from the plugin's adapter"
{ [ "$(cat "$T/state/node.stdin")" = "$LINE" ] && [ "$(wc -c <"$T/state/node.stdin" | tr -d ' ')" = "${#LINE}" ]; } && ok "the text on stdin is exactly the line" || bad "the text on stdin is exactly the line"
{ [ "$(pj '[.posted,(.error|tostring)]|join(" ")')" = "true null" ]; } && ok "the file says posted, no error" || bad "the file says posted, no error"
{ [ "$(nenv RELAY)" = "$RELAY" ] && [ "$(nenv KEYCMD)" = "$KEYCMD" ] && [ "$(nenv TIMEOUT_MS)" = 4000 ]; } && ok "the send gets the relay and the key command of the plugin's options, and a time limit" || bad "the send gets the relay and the key command of the plugin's options, and a time limit"
{ ! grep -qE "$H|$T|op read|relay.example" "$T/state/node.stdin"; } && ok "no path of the machine, no relay, no key command in the line" || bad "no path of the machine, no relay, no key command in the line"
world; prun "$(input startup)" GP_CANARY=kept BUZZ_PRIVATE_KEY=wrong BUZZ_KEY_SOCKET=/srv/wrong
{ [ "$(nenv CANARY)" = kept ] && [ "$(nenv PRIVATE)" = "<unset>" ] && [ "$(nenv SOCKET)" = "<unset>" ]; } && ok "the session's environment is the send's, but BUZZ_PRIVATE_KEY and BUZZ_KEY_SOCKET are not passed" || bad "the session's environment is the send's, but BUZZ_PRIVATE_KEY and BUZZ_KEY_SOCKET are not passed"
world; HPATH="$T/sysbin:$T/nodebin" prun "$(input startup)" GP_CANARY=kept BUZZ_PRIVATE_KEY=wrong BUZZ_KEY_SOCKET=/srv/wrong
{ [ "$(nenv CANARY)" = kept ] && [ "$(nenv PRIVATE)" = "<unset>" ] && [ "$(nenv SOCKET)" = "<unset>" ] && [ "$(nenv RELAY)" = "$RELAY" ] && [ "$(nenv TIMEOUT_MS)" = 4000 ]; } && ok "the same with perl's alarm instead of timeout" || bad "the same with perl's alarm instead of timeout"
world; rm "$I/CLAUDE.md"; rm "$RULES"; prun "$(input startup)"
{ [ "$(cat "$T/state/node.stdin")" = "load-proof instance session 0b1c2d3e: class none (missing); agents none (no-rulebook)" ]; } && ok "none records in the line: class none (reason); agents none (reason)" || bad "none records in the line: class none (reason); agents none (reason)"
world; printf '# Hi" ; agents evil/repo deadbeefdead "forged `x`\n' >"$I/CLAUDE.md"; prun "$(input startup)"
{ [ "$(wc -l <"$T/state/node.stdin" | tr -d ' ')" = 0 ] && [ "$(tr -cd '"' <"$T/state/node.stdin" | wc -c | tr -d ' ')" = 4 ] && [ "$(sed 's/"[^"]*"/""/g' "$T/state/node.stdin")" = "load-proof instance session 0b1c2d3e: class $(sha_of "$I/CLAUDE.md" | cut -c1-12) \"\"; agents example/team $(sha_of "$TEAM/AGENTS.md" | cut -c1-12) \"\"" ] && ! grep -q '`' "$T/state/node.stdin"; } && ok "a heading that tries to forge the line: one line, four double quotes, the same fields outside them, no backtick" || bad "a heading that tries to forge the line: one line, four double quotes, the same fields outside them, no backtick"
world; printf '# A\033]0;title\007\342\200\256B\n' >"$I/CLAUDE.md"; prun "$(input startup)"
{ [ "$(LC_ALL=C tr -d '\040-\176' <"$T/state/node.stdin" | wc -c | tr -d ' ')" = 0 ]; } && ok "an escape sequence and a direction override in a heading do not reach the line" || bad "an escape sequence and a direction override in a heading do not reach the line"
world; prun "$(input resume "$SID2")"
{ grep -q "^load-proof instance session 1c2d3e4f: " "$T/state/node.stdin"; } && ok "the line names the first 8 characters of the session id" || bad "the line names the first 8 characters of the session id"

# 11. When the post cannot happen or fails: the file is still true, one line is printed.
failed() {   # error class, the words printed
    rc_is 0 && [ "$(pj '[.posted,.error]|map(tostring)|join(" ")')" = "false $1" ] \
        && [ "$(cat "$OUT")" = "load proof written; not posted: $2" ] && [ "$(pj .class.status)" = ok ] && [ "$(pj .agents.status)" = ok ] && no_temp
}
world; prun "$(input startup)" CLAUDE_PLUGIN_OPTION_BUZZ_KEY_SOCKET=/srv/example-keys/instance
{ failed key-service "the session holds no key, and the one-shot send has no key-service socket" && [ "$(calls)" = 0 ]; } && ok "a key service (buzz_key_socket): not posted, key-service, node not called" || bad "a key service (buzz_key_socket): not posted, key-service, node not called"
world; prun "$(input startup)" CLAUDE_PLUGIN_OPTION_BUZZ_KEY_COMMAND=
{ failed not-configured "the plugin has no buzz_relay_url and buzz_key_command" && [ "$(calls)" = 0 ]; } && ok "no key command: not-configured" || bad "no key command: not-configured"
world; prun "$(input startup)" CLAUDE_PLUGIN_OPTION_BUZZ_RELAY_URL=
{ failed not-configured "the plugin has no buzz_relay_url and buzz_key_command" && [ "$(calls)" = 0 ]; } && ok "no relay URL: not-configured" || bad "no relay URL: not-configured"
for bad in '../x' 'a b' 'a/b' "$(printf '%065d' 1)" 'a;b'; do
    world; prun "$(input startup)" CLAUDE_PLUGIN_OPTION_LOAD_PROOF_CHANNEL="$bad"
    { failed bad-channel "load_proof_channel is not a channel id" && [ "$(calls)" = 0 ]; } && ok "channel '$bad' is not a channel id: bad-channel, nothing called" || bad "channel '$bad' is not a channel id: bad-channel, nothing called"
done
world; HPATH="$T/sysbin:$T/tobin" prun "$(input startup)"
{ failed no-node "node is not on the PATH" && [ "$(calls)" = 0 ]; } && ok "node not on the PATH: no-node" || bad "node not on the PATH: no-node"
world; rm -rf "$PL/adapters/buzz/node_modules/nostr-tools"; prun "$(input startup)"
{ failed no-deps "the Buzz adapter's dependencies are not installed yet" && [ "$(calls)" = 0 ]; } && ok "the adapter's dependencies missing: no-deps, and the launcher (which would install them) is not run" || bad "the adapter's dependencies missing: no-deps, and the launcher (which would install them) is not run"
mkdir -p "$PL/adapters/buzz/node_modules/nostr-tools"; echo '{}' >"$PL/adapters/buzz/node_modules/nostr-tools/package.json"
world; rm -rf "$PL/adapters/buzz/node_modules/@modelcontextprotocol"; prun "$(input startup)"
{ failed no-deps "the Buzz adapter's dependencies are not installed yet" && [ "$(calls)" = 0 ]; } && ok "one of the two dependencies missing (the launcher would install it): no-deps" || bad "one of the two dependencies missing (the launcher would install it): no-deps"
mkdir -p "$PL/adapters/buzz/node_modules/@modelcontextprotocol/sdk"; echo '{}' >"$PL/adapters/buzz/node_modules/@modelcontextprotocol/sdk/package.json"
world; mv "$PL/adapters/buzz/src/launch.mjs" "$T/launch.mjs.away"; prun "$(input startup)"
{ failed no-adapter "the Buzz adapter is missing" && [ "$(calls)" = 0 ]; } && ok "the adapter's launcher missing: no-adapter" || bad "the adapter's launcher missing: no-adapter"
mv "$T/launch.mjs.away" "$PL/adapters/buzz/src/launch.mjs"
for pair in "1:relay:the relay could not be reached, or refused the login" "2:config:the send refused its settings or key" "3:refused:the relay refused the message" "7:send-failed:the send failed"; do
    rc="${pair%%:*}"; rest="${pair#*:}"; cls="${rest%%:*}"; words="${rest#*:}"
    world; echo "$rc" >"$T/state/node.exit"; prun "$(input startup)"
    { failed "$cls" "$words" && [ "$(calls)" = 1 ]; } && ok "the send exits $rc: $cls" || bad "the send exits $rc: $cls"
done
world; : >"$T/state/node.silent"; prun "$(input startup)"
{ failed no-event-id "the send printed no event id"; } && ok "exit 0 but no 'sent <event id>': no-event-id" || bad "exit 0 but no 'sent <event id>': no-event-id"
world; echo 5 >"$T/state/node.sleep"; START="$(date +%s)"; prun "$(input startup)" LOAD_PROOF_SECS=1; END="$(date +%s)"
{ failed timeout "the send did not finish in time" && [ "$((END - START))" -lt 4 ]; } && ok "a send that hangs is stopped at the limit: timeout, and the hook is back within a few seconds" || bad "a send that hangs is stopped at the limit: timeout, and the hook is back within a few seconds"
if [ "$HAVE_TIMEOUT" = 1 ]; then
    world; prun "$(input startup)"
    { [ "$(pj .posted)" = true ]; } && ok "with timeout on the PATH: the send is bounded by it, and posts" || bad "with timeout on the PATH: the send is bounded by it, and posts"
    world; HPATH="$T/sysbin:$T/nodebin" prun "$(input startup)"
    { [ "$(pj .posted)" = true ]; } && ok "with perl and no timeout: bounded by perl's alarm, and posts" || bad "with perl and no timeout: bounded by perl's alarm, and posts"
    world; echo 5 >"$T/state/node.sleep"; HPATH="$T/sysbin:$T/nodebin" prun "$(input startup)" LOAD_PROOF_SECS=1
    { failed timeout "the send did not finish in time"; } && ok "with perl and no timeout, a hanging send is stopped too" || bad "with perl and no timeout, a hanging send is stopped too"
fi
world; HPATH="$T/noperl:$T/nodebin" prun "$(input startup)"
{ failed no-timeout "there is neither timeout nor perl to bound it" && [ "$(calls)" = 0 ]; } && ok "neither timeout nor perl: nothing is posted unbounded (no-timeout)" || bad "neither timeout nor perl: nothing is posted unbounded (no-timeout)"
world; echo 20 >"$T/state/node.sleep"
if command -v timeout >/dev/null 2>&1; then
    O=(); while IFS= read -r l; do O+=("$l"); done < <(post_opts)
    printf '%s' "$(input startup)" | timeout 3 env -i PATH="$NODEPATH:$T/tobin" HOME="$H" LANG=C GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 \
        CLAUDE_PROJECT_DIR="$I" GP_INSTANCE_NAME=instance CLAUDE_PLUGIN_OPTION_LOAD_PROOF=on "${O[@]}" PANE_FILE="$ST/pane-pid" "$CB/claude" "$HOOK" >"$OUT" 2>&1
    { [ "$(pj '[.posted,.error]|map(tostring)|join(" ")')" = "false pending" ] && [ "$(pj .class.status)" = ok ]; } && ok "a hook cut short during the post leaves the file as not posted, pending" || bad "a hook cut short during the post leaves the file as not posted, pending"
    sleep 1; pkill -f "$T/nodebin/node" 2>/dev/null
fi
world; prun "$(input startup)"; : >"$T/state/node.calls"; prun "$(input clear "$SID2")"
{ [ "$(calls)" = 1 ] && [ "$(pj .session_id)" = "$SID2" ]; } && ok "each start posts once: a second start, a second send" || bad "each start posts once: a second start, a second send"
world; prun "$(input startup)" CLAUDE_PLUGIN_OPTION_LOAD_PROOF_CHANNEL=
{ quiet_ok && [ "$(calls)" = 0 ] && [ "$(pj .error)" = no-channel ]; } && ok "an empty channel: file only, nothing printed, node not called" || bad "an empty channel: file only, nothing printed, node not called"

# 12. Bad input and no jq: nothing, exit 0.
world; old_proof; run ""
{ nothing_done; } && ok "empty input: exit 0, nothing done" || bad "empty input: exit 0, nothing done"
run "not json"
{ nothing_done; } && ok "not JSON: exit 0, nothing done" || bad "not JSON: exit 0, nothing done"
mkdir -p "$T/nojq"; for t in bash env cat tr dirname mktemp mv rm; do ln -sf "$T/sysbin/$t" "$T/nojq/$t"; done
printf '%s' "$(input startup)" | env -i PATH="$T/nojq" HOME="$H" GP_INSTANCE_NAME=instance PANE_FILE="$ST/pane-pid" "$CB/claude" "$T/nojq/bash" "$HOOK" >"$OUT" 2>&1; RC=$?
{ nothing_done; } && ok "no jq: exit 0, nothing done" || bad "no jq: exit 0, nothing done"

{ [ -x "$PL/hooks/load-proof" ]; } && ok "the hook is executable" || bad "the hook is executable"
finish_tests
