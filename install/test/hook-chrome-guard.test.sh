#!/usr/bin/env bash
# hook-chrome-guard.test.sh: hooks/chrome-guard, the PreToolUse hook that keeps
# the instance's main thread off Claude in Chrome. Fed hook JSON on stdin as
# Claude Code sends it, with the instance's home from a manifest, as the plugin
# runs it.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

HOOK="$SRC/hooks/chrome-guard"
t_new
SYSPATH="/usr/bin:/bin:/usr/sbin:/sbin"
if ! command -v jq >/dev/null 2>&1; then
    echo "SKIP  chrome-guard tests (no jq on this machine; the guard needs it)"
    finish_tests
    exit $?
fi
# The project folder Claude Code names after a launch path: every character
# but A-Z, a-z and 0-9 turned to -; over 200 characters, cut to 200 with -
# and a hash added (this hash is a stand-in).
cc_project() {
    local s
    s="$(printf '%s' "$1" | LC_ALL=C sed 's/[^A-Za-z0-9]/-/g')"
    if [ "${#s}" -gt 200 ]; then s="$(printf '%s' "$s" | cut -c1-200)-1a2b3c"; fi
    printf '%s' "$s"
}

# The instance: home ~/work/instance (schema v1), with a worktree under the
# root's worktrees/ and one under .claude/worktrees; another repo beside it.
R="$T/home/work"; HOMEDIR="$R/instance"; DATA="$T/data"
mkdir -p "$R/worktrees/instance" "$T/home/elsewhere"
git init -q "$HOMEDIR"
mkdir -p "$HOMEDIR/.ghost-protocol" "$HOMEDIR/sub"
cp "$FIX/manifests/good-v1.toml" "$HOMEDIR/.ghost-protocol/instance.toml"
git -C "$HOMEDIR" add -A && git -C "$HOMEDIR" commit -q -m one
git -C "$HOMEDIR" worktree add -q "$R/worktrees/instance/feat" -b feat
git -C "$HOMEDIR" worktree add -q "$HOMEDIR/.claude/worktrees/wt" -b wt
git init -q "$T/home/elsewhere"
IN_HOME="$T/projects/$(cc_project "$HOMEDIR")/s.jsonl"   # a transcript of a session launched in the home
ELSEWHERE_T="$T/projects/-elsewhere/s.jsonl"   # one launched anywhere else

# guard PROJECT_DIR JSON [VAR=value ...]: runs the hook as the plugin does.
guard() {
    local proj="$1" json="$2"; shift 2
    printf '%s' "$json" | env -i PATH="$SYSPATH" HOME="$T/home" LANG=C \
        GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 \
        CLAUDE_PLUGIN_DATA="$DATA" CLAUDE_PROJECT_DIR="$proj" "$@" "$HOOK" >"$OUT" 2>"$T/err"
    RC=$?
}
input() {   # input cwd transcript [agent_type] [agent_id]
    jq -cn --arg cwd "$1" --arg t "$2" --arg at "${3:-}" --arg ai "${4:-}" \
        '{session_id:"s1", transcript_path:$t, cwd:$cwd, hook_event_name:"PreToolUse",
          tool_name:"mcp__claude-in-chrome__navigate", tool_input:{url:"https://example.com"}}
         + (if $at != "" then {agent_type:$at} else {} end) + (if $ai != "" then {agent_id:$ai} else {} end)'
}
denied() {
    rc_is 0 && [ "$(jq -r '.hookSpecificOutput.permissionDecision' "$OUT" 2>/dev/null)" = deny ] \
        && [ "$(jq -r '.hookSpecificOutput.hookEventName' "$OUT" 2>/dev/null)" = PreToolUse ]
}
allowed() { rc_is 0 && [ ! -s "$OUT" ] && [ ! -s "$T/err" ]; }
expect() {   # expect deny|allow name proj json [VAR=value ...]
    local want="$1" name="$2"; shift 2
    guard "$@"
    if [ "$want" = deny ]; then check "$name: denied" denied; else check "$name: allowed" allowed; fi
}

# 1. The main thread, in the home: denied, with the guidance and the pass path.
expect deny "main thread launched in the home" "$HOMEDIR" "$(input "$HOMEDIR" "$IN_HOME")"
reason="$(jq -r '.hookSpecificOutput.permissionDecisionReason' "$OUT")"
check "the reason says to hand the job to a subagent" sh -c "printf '%s' \"\$1\" | grep -q 'Hand the job to a subagent'" _ "$reason"
check "the reason names the pass file" sh -c "printf '%s' \"\$1\" | grep -qF \"touch '$DATA/hooks/chrome-pass'\"" _ "$reason"
check "the pass file's folder is made, so one touch opens it" [ -d "$DATA/hooks" ]
expect deny "main thread in a subfolder of the home" "$HOMEDIR" "$(input "$HOMEDIR/sub" "$ELSEWHERE_T")"
expect deny "labelled with the instance's name" "$HOMEDIR" "$(input "$HOMEDIR" "$IN_HOME" instance)"
expect deny "launched in the home, now working in a worktree" "$HOMEDIR" "$(input "$R/worktrees/instance/feat" "$IN_HOME")"
expect deny "launched in the home, now in another repo" "$HOMEDIR" "$(input "$T/home/elsewhere" "$IN_HOME")"

# 2. Not the instance's main thread: allowed.
expect allow "a subagent (agent_id)" "$HOMEDIR" "$(input "$HOMEDIR" "$IN_HOME" "" agent-123)"
expect allow "a subagent labelled with the instance's name" "$HOMEDIR" "$(input "$HOMEDIR" "$IN_HOME" instance agent-123)"
expect allow "another agent label" "$HOMEDIR" "$(input "$HOMEDIR" "$IN_HOME" reviewer)"
expect allow "a session launched in a worktree of the root" "$R/worktrees/instance/feat" "$(input "$R/worktrees/instance/feat" "$ELSEWHERE_T")"
expect allow "a session in the home's .claude/worktrees" "$HOMEDIR/.claude/worktrees/wt" "$(input "$HOMEDIR/.claude/worktrees/wt" "$ELSEWHERE_T")"
expect allow "a session in another repo (no manifest)" "$T/home/elsewhere" "$(input "$T/home/elsewhere" "$ELSEWHERE_T")"
expect allow "a project folder that is not a repo" "$T/home" "$(input "$T/home" "$ELSEWHERE_T")"

# 3. A v0 manifest whose dir is ~/<root>/<name> names the same home.
cp "$FIX/manifests/good-v0-under-root.toml" "$HOMEDIR/.ghost-protocol/instance.toml"
expect deny "v0 manifest under a root" "$HOMEDIR" "$(input "$HOMEDIR" "$IN_HOME")"
# A home the manifest names but that does not exist: the checkout holding it.
sed 's#^dir = .*#dir = "~/not-moved-yet/instance"#' "$FIX/manifests/good-v0-under-root.toml" >"$HOMEDIR/.ghost-protocol/instance.toml"
expect deny "a manifest home that is not there yet: the checkout itself" "$HOMEDIR" "$(input "$HOMEDIR" "$ELSEWHERE_T")"
# A manifest that does not pass the installer's checks: no instance.
printf 'schema = "ghost-protocol/instance/v1"\nname = "instance"\n' >"$HOMEDIR/.ghost-protocol/instance.toml"
expect allow "an invalid manifest" "$HOMEDIR" "$(input "$HOMEDIR" "$IN_HOME")"
cp "$FIX/manifests/good-v1.toml" "$HOMEDIR/.ghost-protocol/instance.toml"

# 3b. Homes whose path holds characters Claude Code also turns to -, and one
#     whose path is over 200 characters long.
for rootname in my_work "$(printf 'r%.0s' $(seq 1 190))_deep"; do
    R2="$T/home/$rootname"; H2="$R2/instance"
    git init -q "$H2"; mkdir -p "$H2/.ghost-protocol" "$T/home/elsewhere2"
    sed "s#^root = .*#root = \"~/$rootname\"#" "$FIX/manifests/good-v1.toml" >"$H2/.ghost-protocol/instance.toml"
    git -C "$H2" add -A && git -C "$H2" commit -q -m one
    T2="$T/projects/$(cc_project "$H2")/s.jsonl"
    expect deny "home ${#H2} characters long, with _: launched there" "$H2" "$(input "$H2" "$T2")"
    expect deny "home ${#H2} characters long, with _: launched there, now in another repo" "$H2" "$(input "$T/home/elsewhere" "$T2")"
    expect allow "home ${#H2} characters long, with _: launched elsewhere, in another repo" "$H2" "$(input "$T/home/elsewhere" "$ELSEWHERE_T")"
done
# The old rule (only / and . turned to -) is not the name Claude Code uses.
OLD_RULE="$T/projects/$(printf '%s' "$T/home/my_work/instance" | tr '/.' '--')/s.jsonl"
expect allow "a folder named by the old rule does not count as the home" "$T/home/my_work/instance" "$(input "$T/home/elsewhere" "$OLD_RULE")"

# 4. The pass: fresh for 15 minutes from its mtime.
mkdir -p "$DATA/hooks"; touch "$DATA/hooks/chrome-pass"
expect allow "a fresh pass" "$HOMEDIR" "$(input "$HOMEDIR" "$IN_HOME")"
touch -t "$(date -r "$(( $(date +%s) - 1000 ))" +%Y%m%d%H%M.%S 2>/dev/null || date -d "@$(( $(date +%s) - 1000 ))" +%Y%m%d%H%M.%S)" "$DATA/hooks/chrome-pass"
expect deny "a pass older than 15 minutes" "$HOMEDIR" "$(input "$HOMEDIR" "$IN_HOME")"
rm -f "$DATA/hooks/chrome-pass"

# 5. The switch, and bad input.
for v in off OFF false no 0; do
    expect allow "chrome_guard=$v" "$HOMEDIR" "$(input "$HOMEDIR" "$IN_HOME")" CLAUDE_PLUGIN_OPTION_CHROME_GUARD="$v"
done
expect deny "chrome_guard=on" "$HOMEDIR" "$(input "$HOMEDIR" "$IN_HOME")" CLAUDE_PLUGIN_OPTION_CHROME_GUARD=on
expect allow "empty input" "$HOMEDIR" ""
expect allow "input that is not JSON" "$HOMEDIR" "not json"
# Without CLAUDE_PROJECT_DIR the hook's cwd names the project.
printf '%s' "$(input "$HOMEDIR" "$IN_HOME")" | env -i PATH="$SYSPATH" HOME="$T/home" LANG=C \
    GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 CLAUDE_PLUGIN_DATA="$DATA" "$HOOK" >"$OUT" 2>"$T/err"
RC=$?
check "no CLAUDE_PROJECT_DIR: the cwd's manifest" denied
# Without the plugin's data folder the pass lives under ~/.local/state.
printf '%s' "$(input "$HOMEDIR" "$IN_HOME")" | env -i PATH="$SYSPATH" HOME="$T/home" LANG=C \
    GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 CLAUDE_PROJECT_DIR="$HOMEDIR" "$HOOK" >"$OUT" 2>"$T/err"
RC=$?
check "no plugin data folder: the pass is in ~/.local/state/ghost-protocol/hooks" \
    sh -c "jq -r .hookSpecificOutput.permissionDecisionReason '$OUT' | grep -qF '$T/home/.local/state/ghost-protocol/hooks/chrome-pass'"

finish_tests
