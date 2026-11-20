#!/usr/bin/env bash
# hook-unattended-deny.test.sh: adapters/buzz/hooks/unattended-deny, unattended
# mode's PermissionRequest hook. With GP_UNATTENDED=1 (install/service/start
# sets it when the unattended option is on) it denies every permission dialog
# with the fixed message, in Claude Code's PermissionRequest decision shape;
# with anything else it prints nothing, so the dialog shows as usual.
# Then the mutation check: the hook is copied with one part broken at a time,
# and this test is run against each copy; every copy must fail it.
#
# DENY_HOOK=<a copy of the hook> runs it once against that copy, without the
# mutation check.
# The mutants are sed programs, with a literal $ in single quotes (SC2016).
# shellcheck disable=SC2016
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REAL="$SRC/adapters/buzz/hooks/unattended-deny"
HOOK="${DENY_HOOK:-$REAL}"
t_new
MSG="Denied automatically: this agent runs unattended and nobody can answer a permission prompt. Do not retry this action or work around it. Report in the Buzz thread that this step needs a person, quoting this message."
REQ='{"hook_event_name":"PermissionRequest","tool_name":"Bash","tool_input":{"command":"git push --force"},"permission_mode":"auto"}'

run() {   # INPUT [VAR=value ...]
    local in="$1"; shift
    printf '%s' "$in" | env -i PATH="$T/sysbin" HOME="$T/home" LANG=C "$@" "$HOOK" >"$OUT" 2>"$T/err"
    RC=$?
}
# The decision's fields, read back with python3 (or jq), each on a line.
decision() {
    if [ -x "$T/sysbin/python3" ] || t_tool python3; then
        "$T/sysbin/python3" -I -c 'import json,sys
d = json.load(sys.stdin)
o = d["hookSpecificOutput"]
print(o["hookEventName"]); print(o["decision"]["behavior"]); print(o["decision"]["message"]); print(len(d), len(o), len(o["decision"]))' <"$OUT"
    else
        echo "no python3"
    fi
}

# 1. Unattended: deny, the fixed message, valid JSON, exit 0, nothing on stderr.
for tool_in in "$REQ" '{"hook_event_name":"PermissionRequest","tool_name":"Read","tool_input":{"file_path":"/elsewhere/notes.txt"}}' \
        '{"hook_event_name":"PermissionRequest","tool_name":"AskUserQuestion","tool_input":{"questions":[]}}' ''; do
    run "$tool_in" GP_UNATTENDED=1
    d="$(decision)"
    what="$(printf '%s' "$tool_in" | sed -n 's/.*"tool_name":"\([A-Za-z]*\)".*/\1/p')"
    check "unattended (${what:-no input}): exit 0, nothing on stderr" sh -c "[ $RC = 0 ] && [ ! -s '$T/err' ]"
    check "unattended (${what:-no input}): one decision, behavior deny, for PermissionRequest, with the message" \
        [ "$d" = "$(printf 'PermissionRequest\ndeny\n%s\n1 2 2' "$MSG")" ]
done
check "unattended: one line of output" [ "$(wc -l <"$OUT" | tr -d ' ')" = 1 ]

# 2. Anything else: nothing printed, so the dialog shows.
for v in "" 0 true yes on 2; do
    run "$REQ" GP_UNATTENDED="$v"
    check "GP_UNATTENDED='$v': nothing printed, exit 0" sh -c "[ $RC = 0 ] && [ ! -s '$OUT' ]"
done
run "$REQ"
check "GP_UNATTENDED unset (an attended instance, a person's session): nothing printed" sh -c "[ $RC = 0 ] && [ ! -s '$OUT' ]"
run "$REQ" CLAUDE_PLUGIN_OPTION_UNATTENDED=on
check "the plugin option alone is not enough (start sets GP_UNATTENDED for its session)" [ ! -s "$OUT" ]

if [ -n "${DENY_HOOK:-}" ]; then finish_tests; exit $?; fi

check "the hook is executable" [ -x "$REAL" ]
check "the message is the one in install/service/start's account of it" grep -q 'that the step needs a person' "$SRC/install/service/start"

# --- mutation check: each broken part must fail this test
M="$T/mutants"; mkdir -p "$M"
mutant() {   # name, sed program
    local name="$1" prog="$2" f fails
    f="$M/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"
    sed -e "$prog" "$REAL" >"$f"; chmod +x "$f"
    if cmp -s "$f" "$REAL"; then bad "mutant $name: the sed changed nothing"; return; fi
    DENY_HOOK="$f" bash "${BASH_SOURCE[0]}" >"$f.out" 2>&1
    fails="$(grep -c '^FAIL' "$f.out")"
    if [ "$fails" -gt 0 ]; then ok "mutant caught: $name ($fails checks fail)"; else bad "mutant NOT caught: $name"; fi
}
mutant "always denies"     's/^\[ "\${GP_UNATTENDED:-}" = 1 \] || exit 0$/true/'
mutant "any value turns it on" 's/^\[ "\${GP_UNATTENDED:-}" = 1 \]/[ -n "${GP_UNATTENDED:-}" ]/'
mutant "allows instead"    's/"behavior":"deny"/"behavior":"allow"/'
mutant "another message"   's/quoting this message/quoting it/'
mutant "the wrong event"   's/"hookEventName":"PermissionRequest"/"hookEventName":"PreToolUse"/'

finish_tests
