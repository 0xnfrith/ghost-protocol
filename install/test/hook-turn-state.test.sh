#!/usr/bin/env bash
# hook-turn-state.test.sh: hooks/turn-state, the UserPromptSubmit, Stop and
# StopFailure hook that keeps install/service/start's busy/idle marker for
# --fresh: busy at UserPromptSubmit, idle at the Stop (or the StopFailure of a
# turn an API error ended) with the same prompt id, in the
# instance's own conversation only (GP_INSTANCE_NAME, the first claude above
# the hook is the pane's, whose pid start wrote to pane-pid, the session id in
# start's file), and never a word printed into the prompt.
# Then the mutation check: the hook is copied with one guard broken at a
# time, and this test is run against each copy; every copy must fail it.
#
# TURN_STATE_HOOK=<a copy of the hook, with its lib/ beside it> runs it once
# against that copy, without the mutation check.
# The mutants are sed programs, with a literal $ in single quotes (SC2016).
# shellcheck disable=SC2016
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REAL="$SRC/hooks/turn-state"
LIB="$SRC/hooks/lib/own-claude.sh"
HOOK="${TURN_STATE_HOOK:-$REAL}"
t_new
if ! t_tool jq; then
    echo "SKIP  every case (no jq on this machine; the hook needs it)"
    finish_tests
    exit $?
fi

SID=0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b
OTHER=1c2d3e4f-5061-4723-9b8c-0d1e2f3a4b5c
P1=2d3e4f50-6172-4834-8c9d-1e2f3a4b5c6d
P2=3e4f5061-7283-4945-9dae-2f3a4b5c6d7e
H="$T/home"
ST="$H/.local/state/ghost-protocol/inst"
CB="$T/claude-bin"
t_claude_standin "$CB"

world() { rm -rf "$H/.local"; mkdir -p "$ST"; echo "$SID" >"$ST/session-id"; }
# event NAME PROMPT [SESSION] [AGENT]: the hook's input.
event() {
    local agent=""
    [ -n "${4:-}" ] && agent=",\"agent_id\":\"$4\""
    printf '{"hook_event_name":"%s","session_id":"%s","prompt_id":"%s","transcript_path":"/x/%s.jsonl"%s}' \
        "$1" "${3:-$SID}" "$2" "${3:-$SID}" "$agent"
}
# run INPUT [VAR=value ...]: the hook with those variables only (and jq on
# PATH), run by WHO: pane (the default), the instance's claude, a stand-in
# that writes its pid to pane-pid as start does; nested, a claude the
# instance's claude started (a second stand-in under it); other, a claude in
# another window of the same tmux server (the pane's pid another stand-in's).
run() {
    local in="$1" bg="" i=0; shift
    local base=(env -i PATH="$T/sysbin" HOME="$H" LANG=C "$@")
    case "${WHO:-pane}" in
        pane)   printf '%s' "$in" | "${base[@]}" PANE_FILE="$ST/pane-pid" "$CB/claude" "$HOOK" >"$OUT" 2>&1 ;;
        nested) printf '%s' "$in" | "${base[@]}" PANE_FILE="$ST/pane-pid" "$CB/claude" "$CB/claude" "$HOOK" >"$OUT" 2>&1 ;;
        other)
            rm -f "$ST/pane-pid"
            env -i PATH="$T/sysbin" PANE_FILE="$ST/pane-pid" "$CB/claude" sleep 30 </dev/null >/dev/null 2>&1 &
            bg=$!
            while [ ! -s "$ST/pane-pid" ] && [ "$i" -lt 100 ]; do sleep 0.05; i=$((i + 1)); done
            printf '%s' "$in" | "${base[@]}" "$CB/claude" "$HOOK" >"$OUT" 2>&1 ;;
    esac
    RC=$?
    if [ -n "$bg" ]; then pkill -P "$bg" 2>/dev/null; kill "$bg" 2>/dev/null; wait "$bg" 2>/dev/null; fi
}
marker() { cat "$ST/turn" 2>/dev/null; }
quiet_ok() { rc_is 0 && [ ! -s "$OUT" ]; }

# 1. A turn: busy at UserPromptSubmit, idle at its Stop; nothing printed.
world
run "$(event UserPromptSubmit "$P1")" GP_INSTANCE_NAME=inst
check "UserPromptSubmit: exit 0, nothing printed (it would join the prompt)" quiet_ok
check "UserPromptSubmit: busy, with the prompt id" [ "$(marker)" = "busy $P1" ]
run "$(event Stop "$P1")" GP_INSTANCE_NAME=inst
check "Stop: exit 0, nothing printed" quiet_ok
check "Stop of that prompt: idle" [ "$(marker)" = "idle $P1" ]
check "no temporary file left" [ "$(find "$ST" -name '.turn.*' | wc -l | tr -d ' ')" = 0 ]

# 2. Paired by prompt id: an older prompt's Stop leaves a newer turn busy; a
#    second Stop of the same prompt (after a block) changes nothing.
world
run "$(event UserPromptSubmit "$P2")" GP_INSTANCE_NAME=inst
run "$(event Stop "$P1")" GP_INSTANCE_NAME=inst
check "another prompt's Stop: still busy" [ "$(marker)" = "busy $P2" ]
run "$(event Stop "$P2")" GP_INSTANCE_NAME=inst
run "$(event Stop "$P2")" GP_INSTANCE_NAME=inst
check "a second Stop of the same prompt: idle stays" [ "$(marker)" = "idle $P2" ]
world
run "$(event Stop "$P1")" GP_INSTANCE_NAME=inst
check "a Stop with no marker: none made" [ ! -e "$ST/turn" ]

# 2b. A turn an API error ends fires StopFailure instead of Stop (with the
#     same prompt id): idle too, or the marker would say busy for good.
world
run "$(event UserPromptSubmit "$P1")" GP_INSTANCE_NAME=inst
run "$(event StopFailure "$P1")" GP_INSTANCE_NAME=inst
check "StopFailure of that prompt (an API error ended the turn): idle" [ "$(marker)" = "idle $P1" ]
check "StopFailure: exit 0, nothing printed" quiet_ok
run "$(event UserPromptSubmit "$P2")" GP_INSTANCE_NAME=inst
run "$(event StopFailure "$P1")" GP_INSTANCE_NAME=inst
check "another prompt's StopFailure: still busy" [ "$(marker)" = "busy $P2" ]
WHO=nested run "$(event StopFailure "$P2")" GP_INSTANCE_NAME=inst
check "a StopFailure in a claude the instance's claude started: still busy" [ "$(marker)" = "busy $P2" ]

# 3. Only the instance's own conversation.
world
run "$(event UserPromptSubmit "$P1")"
check "no GP_INSTANCE_NAME (a session start did not launch, or --test): no marker" [ ! -e "$ST/turn" ]
run "$(event UserPromptSubmit "$P1" "$OTHER")" GP_INSTANCE_NAME=inst
check "another session id (a claude the agent ran itself): no marker" [ ! -e "$ST/turn" ]
run "$(event UserPromptSubmit "$P1" "$SID" agent-1)" GP_INSTANCE_NAME=inst
check "a subagent: no marker" [ ! -e "$ST/turn" ]
run "$(event UserPromptSubmit "$P1")" GP_INSTANCE_NAME=inst
run "$(event Stop "$P1" "$OTHER")" GP_INSTANCE_NAME=inst
check "another session's Stop of the same prompt id: still busy" [ "$(marker)" = "busy $P1" ]
world
WHO=nested run "$(event UserPromptSubmit "$P1")" GP_INSTANCE_NAME=inst
check "a claude the instance's claude started, with the instance's session id: no marker" [ ! -e "$ST/turn" ]
WHO=other run "$(event UserPromptSubmit "$P1")" GP_INSTANCE_NAME=inst
check "a claude in another window of the same tmux server, given the name and the session id: no marker" [ ! -e "$ST/turn" ]
run "$(event UserPromptSubmit "$P1")" GP_INSTANCE_NAME=inst
WHO=nested run "$(event Stop "$P1")" GP_INSTANCE_NAME=inst
check "a Stop in a claude the instance's claude started: still busy" [ "$(marker)" = "busy $P1" ]
world; mkdir -p "$H/.local/state/ghost-protocol/x"
run "$(event UserPromptSubmit "$P1")" GP_INSTANCE_NAME=x/../inst
check "GP_INSTANCE_NAME that is not a plain name: no marker" [ ! -e "$ST/turn" ]
world; rm "$ST/session-id"
run "$(event UserPromptSubmit "$P1")" GP_INSTANCE_NAME=inst
check "no session-id file: no marker" [ ! -e "$ST/turn" ]

# 4. Other events, odd prompt ids, bad input.
world
run "$(event SessionStart "$P1")" GP_INSTANCE_NAME=inst
check "another event: no marker" [ ! -e "$ST/turn" ]
run "$(event UserPromptSubmit 'a b;$(x)')" GP_INSTANCE_NAME=inst
check "a prompt id that is not plain: written as -" [ "$(marker)" = "busy -" ]
run "$(event Stop '')" GP_INSTANCE_NAME=inst
check "and its Stop (no id either): idle -" [ "$(marker)" = "idle -" ]
run "not json" GP_INSTANCE_NAME=inst
check "not JSON: exit 0, unchanged" sh -c "[ $RC = 0 ] && [ \"\$(cat '$ST/turn')\" = 'idle -' ]"

if [ -n "${TURN_STATE_HOOK:-}" ]; then finish_tests; exit $?; fi

check "the hook is executable" [ -x "$REAL" ]

# --- mutation check: each broken guard must fail this test
M="$T/mutants"; mkdir -p "$M"
mutant() {   # name, sed program
    local name="$1" prog="$2" d f fails
    d="$M/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"
    mkdir -p "$d/lib"; cp "$LIB" "$d/lib/own-claude.sh"
    f="$d/turn-state"
    sed -e "$prog" "$REAL" >"$f"; chmod +x "$f"
    if cmp -s "$f" "$REAL"; then bad "mutant $name: the sed changed nothing"; return; fi
    TURN_STATE_HOOK="$f" bash "${BASH_SOURCE[0]}" >"$d.out" 2>&1
    fails="$(grep -c '^FAIL' "$d.out")"
    if [ "$fails" -gt 0 ]; then ok "mutant caught: $name ($fails checks fail)"; else bad "mutant NOT caught: $name"; fi
}
mutant "StopFailure ignored"       's/^  Stop | StopFailure)$/  Stop)/'
mutant "not paired by prompt id"   's/ = "busy \$prompt" \] || exit 0/ != x ] || exit 0/'
mutant "any session"               's/^\[ "\$(tr -d .\[:space:\]. <"\$state\/session-id")" = "\$sid" \] || exit 0$/true/'
mutant "subagents too"             's/^\[ -z "\$agent" \] && //'
mutant "no instance name needed"   's/^case "\$name" in .*$/name="${name:-inst}"/'
mutant "any name"                  's/ | -\* | \*\[!a-z0-9-\]\*) exit 0/) exit 0/'
mutant "any prompt id kept"        's/^case "\$prompt" in .*$/true/'
mutant "any claude (no pane check)" 's/^own_claude "\$state" || exit 0$/true/'
mutant "prints the marker"         's/^if printf .%s\\n. "\$line" >"\$tmp"/printf "%s\\n" "$line"; if printf "%s\\n" "$line" >"$tmp"/'

finish_tests
