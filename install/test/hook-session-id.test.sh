#!/usr/bin/env bash
# hook-session-id.test.sh: hooks/session-id, the SessionStart hook that keeps
# install/service/start's session id current after a /clear or a /resume. It
# writes the new id only in the instance's own claude (GP_INSTANCE_NAME, and
# the first claude above the hook is the pane's, whose pid start wrote to
# pane-pid; start's file there, the transcript beside the current one), never
# for a start, a compaction, a subagent, a claude the instance's claude
# started, or a claude in another window of the same tmux server (also in a
# real tmux server, when this machine has tmux); it removes the old
# conversation's turn marker, and prints nothing.
# Then the mutation check: the hook, or its helper hooks/lib/own-claude.sh, is
# copied with one guard broken at a time, and this test is run against each
# copy; every copy must fail it.
#
# SESSION_ID_HOOK=<a copy of the hook, with its lib/ beside it> runs it once
# against that copy, without the mutation check.
# The mutants are sed programs, with a literal $ in single quotes (SC2016).
# shellcheck disable=SC2016
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REAL="$SRC/hooks/session-id"
LIB="$SRC/hooks/lib/own-claude.sh"
HOOK="${SESSION_ID_HOOK:-$REAL}"
t_new
if ! t_tool jq; then
    echo "SKIP  every case (no jq on this machine; the hook needs it)"
    finish_tests
    exit $?
fi

OLD=0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b
NEW=1c2d3e4f-5061-4723-9b8c-0d1e2f3a4b5c
NEW2=2d3e4f50-6172-4834-8c9d-1e2f3a4b5c6d
NEW3=3e4f5061-7283-4945-9dae-2f3a4b5c6d7e
H="$T/home"
ST="$H/.local/state/ghost-protocol/inst"
PROJ="$H/.claude/projects/-work-inst"
CB="$T/claude-bin"
t_claude_standin "$CB"
t_claude_standin "$CB" 2.1.314

world() {
    rm -rf "$H/.local" "$H/.claude" "$T/xdg"
    mkdir -p "$ST" "$PROJ"
    echo "$OLD" >"$ST/session-id"
    echo '{}' >"$PROJ/$OLD.jsonl"
    echo "idle p1" >"$ST/turn"
}
# input SOURCE [SESSION] [AGENT] [TRANSCRIPT]: SessionStart's input.
input() {
    local agent=""
    [ -n "${3:-}" ] && agent=",\"agent_id\":\"$3\""
    printf '{"hook_event_name":"SessionStart","source":"%s","session_id":"%s","transcript_path":"%s","cwd":"/work/inst"%s}' \
        "$1" "${2:-$NEW}" "${4:-$PROJ/${2:-$NEW}.jsonl}" "$agent"
}
# run INPUT [VAR=value ...]: the hook with those variables only (and jq on
# PATH), run by WHO:
#   pane     (the default) the instance's claude: a stand-in that writes its
#            pid to PANE (default $ST/pane-pid), as start does, then runs it
#   between  the same, with a shell that is not claude between them
#   renamed  the same, its process named as Claude Code's version files are
#   nested   a claude the instance's claude started (claude -p from a Bash
#            call): a second stand-in, under the pane's
#   twin     the same, both stand-ins named as the version files are
#   other    a claude in another window of the same tmux server: a stand-in
#            that is not the pane's, the pane's being another, alive
#   bare     no claude at all, and no pane-pid written
run() {
    local in="$1" pane="${PANE:-$ST/pane-pid}" bg="" i=0; shift
    local base=(env -i PATH="$T/sysbin" HOME="$H" LANG=C "$@")
    case "${WHO:-pane}" in
        pane)    printf '%s' "$in" | "${base[@]}" PANE_FILE="$pane" "$CB/claude" "$HOOK" >"$OUT" 2>&1 ;;
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
saved() { tr -d '[:space:]' <"$ST/session-id"; }
quiet_ok() { rc_is 0 && [ ! -s "$OUT" ]; }
unchanged() { [ "$(saved)" = "$OLD" ] && [ -e "$ST/turn" ]; }

# 1. A /clear in the instance's own claude: the new id is saved, the old
#    conversation's turn marker goes, nothing printed.
world
run "$(input clear)" GP_INSTANCE_NAME=inst
check "clear: exit 0, nothing printed" quiet_ok
check "clear: the new id is saved" [ "$(saved)" = "$NEW" ]
check "clear: the old conversation's turn marker is removed" [ ! -e "$ST/turn" ]
check "clear: no temporary file left" [ "$(find "$ST" -name '.session-id.*' | wc -l | tr -d ' ')" = 0 ]

# 2. A /resume of another conversation moves it too; a start, a compaction, or
#    start's own --resume of the saved id, keeps start's own id.
world
run "$(input resume)" GP_INSTANCE_NAME=inst
check "resume of another conversation: its id is saved, the marker removed" sh -c "[ \"\$(tr -d '[:space:]' <'$ST/session-id')\" = '$NEW' ] && [ ! -e '$ST/turn' ]"
for src in startup compact; do
    world
    run "$(input "$src")" GP_INSTANCE_NAME=inst
    check "$src: start's id stays" sh -c "[ \"\$(tr -d '[:space:]' <'$ST/session-id')\" = '$OLD' ] && [ -e '$ST/turn' ] && [ $RC = 0 ] && [ ! -s '$OUT' ]"
done
world
run "$(input resume "$OLD")" GP_INSTANCE_NAME=inst
check "resume of the saved id (start's own --resume): unchanged, the marker kept" unchanged

# 3. Only the instance's own claude.
world
run "$(input clear)"
check "no GP_INSTANCE_NAME (a session not started by start, or --test): unchanged" unchanged
world
WHO=nested run "$(input clear)" GP_INSTANCE_NAME=inst
check "a claude the instance's claude started (it inherits the name): unchanged" unchanged
world
WHO=nested run "$(input resume)" GP_INSTANCE_NAME=inst
check "a resume in a claude the instance's claude started (claude --resume from a Bash call): unchanged" unchanged
world
WHO=other run "$(input clear)" GP_INSTANCE_NAME=inst
check "a claude in another window of the same tmux server, given the name: unchanged" unchanged
world
WHO=bare run "$(input clear)" GP_INSTANCE_NAME=inst
check "no claude above the hook, no pane-pid: unchanged" unchanged
world
WHO=between run "$(input clear)" GP_INSTANCE_NAME=inst
check "the instance's claude, with a shell between it and the hook: the new id" [ "$(saved)" = "$NEW" ]
world
WHO=renamed run "$(input clear)" GP_INSTANCE_NAME=inst
check "the instance's claude under another process name (found by its pid): the new id" [ "$(saved)" = "$NEW" ]
world
WHO=twin run "$(input clear)" GP_INSTANCE_NAME=inst
check "a nearer claude with the pane's own process name, not claude: unchanged" unchanged
world
PANE="$T/pane-elsewhere" run "$(input clear)" GP_INSTANCE_NAME=inst
check "no pane-pid file (start could not read the pane's pid): unchanged" unchanged
for bad in "abc" "" "1" "12 34"; do
    world; printf '%s\n' "$bad" >"$ST/pane-pid"
    WHO=bare run "$(input clear)" GP_INSTANCE_NAME=inst
    check "pane-pid '$bad' (not the pane's pid): unchanged" unchanged
done
world; ln -s "$T/pid-target" "$ST/pane-pid"
run "$(input clear)" GP_INSTANCE_NAME=inst
check "a pane-pid that is a symlink (to the right pid): unchanged" unchanged
world
run "$(input clear "$NEW" agent-1)" GP_INSTANCE_NAME=inst
check "a subagent: unchanged" unchanged
world
run "$(input clear "$NEW" "" "$T/elsewhere/$NEW.jsonl")" GP_INSTANCE_NAME=inst
check "a clear outside the instance's project folder: unchanged" unchanged
world
run "$(input clear not-a-uuid)" GP_INSTANCE_NAME=inst
check "a session id that is not a UUID: unchanged" unchanged
world
run "$(input clear)" GP_INSTANCE_NAME=other
check "another instance's name: its own file is not there, nothing made" sh -c "[ ! -e '$H/.local/state/ghost-protocol/other' ] && [ \"\$(tr -d '[:space:]' <'$ST/session-id')\" = '$OLD' ]"
for bad in x/../inst ../inst '-inst' 'In st' ''; do
    world; mkdir -p "$H/.local/state/ghost-protocol/x"
    run "$(input clear)" GP_INSTANCE_NAME="$bad"
    check "GP_INSTANCE_NAME '$bad' is not a plain name: unchanged" unchanged
done
world; rm "$ST/session-id"
run "$(input clear)" GP_INSTANCE_NAME=inst
check "no session-id file (start never ran here): none made" [ ! -e "$ST/session-id" ]
world; echo "$OLD" >"$T/target"; rm "$ST/session-id"; ln -s "$T/target" "$ST/session-id"
run "$(input clear)" GP_INSTANCE_NAME=inst
check "a session-id that is a symlink: left alone" sh -c "[ -L '$ST/session-id' ] && [ \"\$(cat '$T/target')\" = '$OLD' ]"

# 4. XDG_STATE_HOME, as start reads it.
world; mkdir -p "$T/xdg/ghost-protocol/inst"; echo "$OLD" >"$T/xdg/ghost-protocol/inst/session-id"
PANE="$T/xdg/ghost-protocol/inst/pane-pid" run "$(input clear)" GP_INSTANCE_NAME=inst XDG_STATE_HOME="$T/xdg"
check "XDG_STATE_HOME: the file there is the one written" sh -c "[ \"\$(cat '$T/xdg/ghost-protocol/inst/session-id')\" = '$NEW' ] && [ \"\$(tr -d '[:space:]' <'$ST/session-id')\" = '$OLD' ]"

# 5. Bad input and no jq: nothing, exit 0.
world
run "" GP_INSTANCE_NAME=inst
check "empty input: exit 0, unchanged" sh -c "[ $RC = 0 ] && [ \"\$(tr -d '[:space:]' <'$ST/session-id')\" = '$OLD' ]"
run "not json" GP_INSTANCE_NAME=inst
check "not JSON: exit 0, unchanged" sh -c "[ $RC = 0 ] && [ \"\$(tr -d '[:space:]' <'$ST/session-id')\" = '$OLD' ]"
mkdir -p "$T/nojq"; for t in bash env cat tr dirname mktemp mv rm; do ln -sf "$T/sysbin/$t" "$T/nojq/$t"; done
printf '%s' "$(input clear)" | env -i PATH="$T/nojq" HOME="$H" GP_INSTANCE_NAME=inst PANE_FILE="$ST/pane-pid" "$CB/claude" "$T/nojq/bash" "$HOOK" >"$OUT" 2>&1; RC=$?
check "no jq: exit 0, unchanged" sh -c "[ $RC = 0 ] && [ \"\$(tr -d '[:space:]' <'$ST/session-id')\" = '$OLD' ]"

# 6. In a real tmux server, as start runs the instance: claude in the pane,
#    given the name by env on its own command line, its pid in pane-pid. A
#    clear in a second window of the same server, with or without the name,
#    leaves the id alone; a clear in the pane's claude moves it.
if [ -n "${SESSION_ID_HOOK:-}" ]; then :
elif ! t_tool tmux; then
    echo "SKIP  the real tmux server (no tmux on this machine)"
elif ! TX="$(mktemp -d /tmp/gpt.XXXXXX 2>/dev/null)"; then
    echo "SKIP  the real tmux server (no short folder for its socket in /tmp)"
else
    # The socket in a short folder of its own: a socket path holds at most
    # about 100 bytes, and $T can be deep.
    SANDBOXES="$SANDBOXES $TX"
    world
    cat >"$T/runhook" <<'EOF'
#!/bin/bash
# runhook PREFIX HOOK: waits for PREFIX.go, runs HOOK with PREFIX.in, writes
# its exit status to PREFIX.done, then stays (a pane that ends would close).
i=0
while [ ! -e "$1.go" ] && [ "$i" -lt 400 ]; do sleep 0.05; i=$((i + 1)); done
"$2" <"$1.in"
echo "$?" >"$1.done"
sleep 30
EOF
    chmod +x "$T/runhook"
    tx() { env -i PATH="$T/sysbin" HOME="$H" LANG=C TMUX_TMPDIR="$TX" tmux -L gpt "$@"; }
    fire() {   # prefix input: run that window's hook, and wait for it to report
        local i=0
        printf '%s' "$2" >"$1.in"; touch "$1.go"
        while [ ! -s "$1.done" ] && [ "$i" -lt 200 ]; do sleep 0.05; i=$((i + 1)); done
        [ "$(cat "$1.done" 2>/dev/null)" = 0 ]
    }
    check "real tmux: the server starts, the instance's claude in its pane" \
        tx new-session -d -s inst -x 80 -y 20 env GP_INSTANCE_NAME=inst "$CB/claude" "$T/runhook" "$T/pane" "$HOOK"
    tx display-message -p -t '=inst:' '#{pane_pid}' >"$ST/pane-pid"
    check "real tmux: the pane's pid read" grep -qE '^[0-9]+$' "$ST/pane-pid"
    check "real tmux: a second window, given the name" \
        tx new-window -t '=inst:' env GP_INSTANCE_NAME=inst "$CB/claude" "$T/runhook" "$T/second" "$HOOK"
    check "real tmux: a third window, as the server starts one" \
        tx new-window -t '=inst:' "$CB/claude" "$T/runhook" "$T/third" "$HOOK"
    check "real tmux: the second window's hook ran" fire "$T/second" "$(input clear "$NEW2" "" "$PROJ/$NEW2.jsonl")"
    check "real tmux: a claude in a second window, given the name: unchanged" [ "$(saved)" = "$OLD" ]
    check "real tmux: the third window's hook ran" fire "$T/third" "$(input clear "$NEW3" "" "$PROJ/$NEW3.jsonl")"
    check "real tmux: a claude in a second window, as the server starts it: unchanged" [ "$(saved)" = "$OLD" ]
    check "real tmux: the pane's hook ran" fire "$T/pane" "$(input clear)"
    check "real tmux: a clear in the pane's claude: the new id" [ "$(saved)" = "$NEW" ]
    tx kill-server 2>/dev/null
fi

if [ -n "${SESSION_ID_HOOK:-}" ]; then finish_tests; exit $?; fi

check "the hook is executable" [ -x "$REAL" ]

# --- mutation check: each broken guard must fail this test
M="$T/mutants"; mkdir -p "$M"
mutant() {   # name, sed program, [hook (default) or lib: the file it breaks]
    local name="$1" prog="$2" d f src fails
    d="$M/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"
    mkdir -p "$d/lib"
    cp "$REAL" "$d/session-id"; cp "$LIB" "$d/lib/own-claude.sh"
    if [ "${3:-hook}" = lib ]; then f="$d/lib/own-claude.sh" src="$LIB"; else f="$d/session-id" src="$REAL"; fi
    sed -e "$prog" "$src" >"$f"; chmod +x "$d/session-id"
    if cmp -s "$f" "$src"; then bad "mutant $name: the sed changed nothing"; return; fi
    SESSION_ID_HOOK="$d/session-id" bash "${BASH_SOURCE[0]}" >"$d.out" 2>&1
    fails="$(grep -c '^FAIL' "$d.out")"
    if [ "$fails" -gt 0 ]; then ok "mutant caught: $name ($fails checks fail)"; else bad "mutant NOT caught: $name"; fi
}
mutant "any source"                's/^case "\$source" in clear | resume) ;; \*) exit 0 ;; esac$/true/'
mutant "a resume ignored"          's/clear | resume) ;;/clear) ;;/'
mutant "subagents too"             's/^\[ -z "\$agent" \] || exit 0$/true/'
mutant "no instance name needed"   's/^case "\$name" in .*$/name="${name:-inst}"/'
mutant "any name"                  's/ | -\* | \*\[!a-z0-9-\]\*) exit 0/) exit 0/'
mutant "any session id"            's/^\[\[ \$sid =~ \$re \]\] || exit 0$/true/'
mutant "a clear anywhere"          's#^\[ -n "\$transcript" \] && \[ -f .*$#true#'
mutant "makes the file"            's/^\[ -f "\$file" \] && \[ ! -L "\$file" \] || exit 0$/mkdir -p "$state"/'
mutant "follows a symlink"         's/ && \[ ! -L "\$file" \]//'
mutant "any claude (no pane check)" 's/^own_claude "\$state" || exit 0$/true/'
mutant "the old turn marker kept"  's/^    rm -f "\$state\/turn"$/    true/'
mutant "lib: the first ancestor is the pane"  's/^        \[ "\$p" = "\$pane" \] && return 0$/        return 0/' lib
mutant "lib: a nearer claude passed over"     's/^            return 1$/            :/' lib
mutant "lib: the pane's own name not a claude" 's/ || { \[ -n "\$pane_name" \] && \[ "\$name" = "\$pane_name" \]; }//' lib
mutant "lib: a symlinked pane-pid followed"   's/ && \[ ! -L "\$1\/pane-pid" \]//' lib

finish_tests
