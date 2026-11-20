#!/usr/bin/env bash
# hook-auto-pull.test.sh: hooks/auto-pull fast-forwards the instance's checkout
# of the merged repo after a `gh pr merge` (its home, or a checkout under
# <root>/repos/), on any GitHub host, and nothing else. The pull itself is
# hooks/sync-mains (its own test: hook-sync-mains.test.sh).
#
# Hermetic: a throwaway HOME holds the instance (~/work/instance, with a schema
# v1 manifest) as a clone of a local bare repo whose configured origin URL
# reads as a GitHub URL; an insteadOf rule in the clone redirects the fetch to
# the bare repo. No network.
# The checks read `cond && ok "..." || bad "..."`: ok never fails, so bad runs
# only when cond does (SC2015). Expected output names paths with a literal ~
# (SC2088), and some commands under test hold a literal $HOME (SC2016).
# shellcheck disable=SC2015,SC2088,SC2016
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

HOOK="$SRC/hooks/auto-pull"
t_new
SYSPATH="/usr/bin:/bin:/usr/sbin:/sbin"
if ! command -v jq >/dev/null 2>&1; then
    echo "SKIP  auto-pull tests (no jq on this machine; the hook needs it)"
    finish_tests
    exit $?
fi
printf '[user]\n\tname = Test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n' >"$GIT_CONFIG_GLOBAL"
H="$T/home"; R="$H/work"; I="$R/instance"; DATA="$T/data"; LOG="$DATA/hooks/auto-pull.log"
URL="https://github.com/example/instance.git"

git init -q --bare "$T/origin.git"
git init -q "$T/seed"
mkdir -p "$T/seed/.ghost-protocol"
cp "$FIX/manifests/good-v1.toml" "$T/seed/.ghost-protocol/instance.toml"
git -C "$T/seed" add -A && git -C "$T/seed" commit -q -m one
git -C "$T/seed" push -q "$T/origin.git" main
mkdir -p "$R/repos/example"
git clone -q "$T/origin.git" "$I"
git -C "$I" remote set-url origin "$URL"
git -C "$I" config "url.file://$T/origin.git.insteadOf" "$URL"
# another repo, with a different origin
git clone -q "$T/origin.git" "$T/other"
git -C "$T/other" remote set-url origin "https://github.com/example/instance-foo.git"
# a worktree of the home (shares its config)
mkdir -p "$R/worktrees/instance"
git -C "$I" worktree add -q "$R/worktrees/instance/wt" -b wt

advance() { git -C "$T/seed" commit -q --allow-empty -m "n$RANDOM" && git -C "$T/seed" push -q "$T/origin.git" main; }
head_of() { git -C "$1" rev-parse HEAD; }
origin_head() { git -C "$T/origin.git" rev-parse main; }
payload() { jq -cn --arg tool "$1" --arg cmd "$2" --arg cwd "$3" '{tool_name:$tool, tool_input:{command:$cmd}, cwd:$cwd, tool_response:{stdout:"ok"}}'; }
# hook JSON [PROJECT_DIR] [VAR=value ...]: the hook as the plugin runs it.
hook() {
    local json="$1" proj="${2:-$I}"
    shift; [ $# -gt 0 ] && shift
    printf '%s' "$json" | env -i PATH="$SYSPATH" HOME="$H" LANG=C \
        GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 \
        CLAUDE_PLUGIN_DATA="$DATA" CLAUDE_PROJECT_DIR="$proj" "$@" "$HOOK" >"$T/out" 2>"$T/err"
    echo $? >"$T/rc"
}
quiet_rc0() { [ "$(cat "$T/rc")" = 0 ] && [ ! -s "$T/err" ]; }

# want: pull | nopull. Advances origin first, runs the hook, checks HEAD.
case_() {
    local name="$1" want="$2" tool="$3" cmd="$4" cwd="$5" before after
    advance
    before=$(head_of "$I")
    hook "$(payload "$tool" "$cmd" "$cwd")"
    after=$(head_of "$I")
    if ! quiet_rc0; then bad "$name (exit $(cat "$T/rc"), stderr: $(head -c 200 "$T/err"))"; return; fi
    if [ "$want" = pull ]; then
        if [ "$after" = "$(origin_head)" ] && grep -q 'fast-forwarded' "$T/out"; then ok "$name"; else bad "$name (not pulled)"; fi
    else
        if [ "$after" = "$before" ] && [ ! -s "$T/out" ]; then ok "$name"; else bad "$name (pulled or printed)"; fi
    fi
    git -C "$I" pull -q --ff-only >/dev/null 2>&1   # level the clone for the next case
}

# --- merges that target the instance's repo
case_ "bare number, cwd is the home" pull Bash "gh pr merge 12 --squash" "$I"
case_ "bare number, cwd is a worktree of the home" pull Bash "gh pr merge 12 --squash --delete-branch" "$R/worktrees/instance/wt"
case_ "-R example/instance from a non-repo folder" pull Bash "gh pr merge 12 --squash -R example/instance" "$T"
case_ "--repo=example/instance" pull Bash "gh pr merge 12 --repo=example/instance --squash" "$T"
case_ "a full PR URL" pull Bash "gh pr merge https://github.com/example/instance/pull/12 --squash" "$T"
case_ "cd ~/work/instance && gh pr merge" pull Bash "cd ~/work/instance && gh pr merge 12 --squash" "$T"
case_ "cd \$HOME/work/instance && gh pr merge" pull Bash 'cd $HOME/work/instance && gh pr merge 12' "$T"
case_ "inside a compound command" pull Bash "git push -q && gh pr merge 12 --squash && echo done" "$I"
case_ "gh called by its path" pull Bash "/usr/local/bin/gh pr merge 12 -R example/instance" "$T"
case_ "more than one space between the words" pull Bash "gh  pr   merge 12 -R example/instance" "$T"
case_ "GH_REPO=example/instance before it" pull Bash "GH_REPO=example/instance gh pr merge 12 --squash" "$T"
case_ "-R wins over GH_REPO" nopull Bash "GH_REPO=example/instance gh pr merge 12 -R someone/else" "$T"
mkdir -p "$R/worktrees/instance/wt/sub"
case_ "a relative cd, from the folder before it" pull Bash "cd wt && gh pr merge 12" "$R/worktrees/instance"
case_ "a relative cd, the hook's cwd already the folder after it" pull Bash "cd sub && gh pr merge 12" "$R/worktrees/instance/wt/sub"

# --- not a merge of the instance's repo
case_ "a plain Bash command" nopull Bash "git status" "$I"
case_ "gh pr view is not a merge" nopull Bash "gh pr view 12 -R example/instance" "$T"
case_ "-R example/instance-foo (look-alike)" nopull Bash "gh pr merge 3 -R example/instance-foo" "$I"
case_ "-R another/repo from the home" nopull Bash "gh pr merge 3 -R someone/else --squash" "$I"
case_ "bare number from another repo" nopull Bash "gh pr merge 3 --squash" "$T/other"
case_ "the words in a commit message" nopull Bash "git commit -m 'after we ran ghgh pr merge'" "$I"
case_ "not the Bash tool" nopull Write "gh pr merge 12" "$I"

# --- the switch
advance
before=$(head_of "$I")
for v in off OFF false no 0; do
    hook "$(payload Bash "gh pr merge 12" "$I")" "$I" CLAUDE_PLUGIN_OPTION_AUTO_PULL="$v"
    if quiet_rc0 && [ "$(head_of "$I")" = "$before" ] && [ ! -s "$T/out" ]; then ok "auto_pull=$v: no pull"; else bad "auto_pull=$v pulled"; fi
done
hook "$(payload Bash "gh pr merge 12" "$I")" "$I" CLAUDE_PLUGIN_OPTION_AUTO_PULL=on
if quiet_rc0 && [ "$(head_of "$I")" = "$(origin_head)" ]; then ok "auto_pull=on: pulled"; else bad "auto_pull=on did not pull"; fi

# --- no instance: the session's project has no manifest
git init -q "$T/plain"
advance
before=$(head_of "$I")
hook "$(payload Bash "gh pr merge 12 -R example/instance" "$T/plain")" "$T/plain"
if quiet_rc0 && [ "$(head_of "$I")" = "$before" ] && [ ! -s "$T/out" ]; then ok "a project with no manifest: nothing pulled"; else bad "no manifest: pulled"; fi
# without CLAUDE_PROJECT_DIR, the hook's cwd names the project
printf '%s' "$(payload Bash "gh pr merge 12" "$I")" | env -i PATH="$SYSPATH" HOME="$H" LANG=C \
    GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 CLAUDE_PLUGIN_DATA="$DATA" "$HOOK" >"$T/out" 2>"$T/err"
echo $? >"$T/rc"
if quiet_rc0 && [ "$(head_of "$I")" = "$(origin_head)" ]; then ok "no CLAUDE_PROJECT_DIR: the cwd's manifest"; else bad "no CLAUDE_PROJECT_DIR"; fi

# --- the checkout is not on main: skipped, branch untouched
git -C "$I" checkout -q -b side
case_ "the home off main is left alone" nopull Bash "gh pr merge 12" "$I"
[ "$(git -C "$I" symbolic-ref --short HEAD)" = side ] && ok "still on its branch" || bad "branch was changed"
git -C "$I" checkout -q main

# --- a pull that cannot fast-forward fails quietly
git -C "$I" commit -q --allow-empty -m local-only
advance
before=$(head_of "$I")
hook "$(payload Bash "gh pr merge 12" "$I")"
if quiet_rc0 && [ "$(head_of "$I")" = "$before" ] && [ ! -s "$T/out" ]; then ok "diverged main: no pull, exit 0, silent"; else bad "diverged main"; fi
grep -q 'held: diverged from origin/main' "$LOG" && ok "the held pull is logged" || bad "held pull not logged"
git -C "$I" reset -q --hard origin/main

# --- up to date: nothing printed
git -C "$I" pull -q --ff-only >/dev/null 2>&1
hook "$(payload Bash "gh pr merge 12" "$I")"
if quiet_rc0 && [ ! -s "$T/out" ]; then ok "already up to date: silent"; else bad "up to date printed something"; fi

# --- garbage in, exit 0
hook ""
quiet_rc0 && [ ! -s "$T/out" ] && ok "empty input: silent exit 0" || bad "empty input"
hook "not json gh pr merge"
quiet_rc0 && [ ! -s "$T/out" ] && ok "invalid JSON: silent exit 0" || bad "invalid JSON"

# --- the printed line is valid hook JSON
advance
hook "$(payload Bash "gh pr merge 12" "$I")"
jq -e '.hookSpecificOutput.hookEventName == "PostToolUse" and (.hookSpecificOutput.additionalContext | test("^auto-pull: ~/work/instance main fast-forwarded [0-9a-f]+\\.\\.[0-9a-f]+"))' "$T/out" >/dev/null \
    && ok "output is PostToolUse additionalContext JSON" || bad "output JSON: $(head -c 200 "$T/out")"
# without the plugin's data folder the log is under ~/.local/state
advance
printf '%s' "$(payload Bash "gh pr merge 12" "$I")" | env -i PATH="$SYSPATH" HOME="$H" LANG=C \
    GIT_CONFIG_GLOBAL="$GIT_CONFIG_GLOBAL" GIT_CONFIG_NOSYSTEM=1 CLAUDE_PROJECT_DIR="$I" "$HOOK" >/dev/null 2>&1
grep -q 'fast-forwarded' "$H/.local/state/ghost-protocol/hooks/auto-pull.log" \
    && ok "no plugin data folder: the log is ~/.local/state/ghost-protocol/hooks/auto-pull.log" || bad "log without the data folder"

# --- any host and any URL form: the integration host, git@host:, ssh://
for form in "https://github.int.exe.xyz/example/instance.git" \
            "git@github.com:example/instance.git" \
            "ssh://git@github.com/example/instance.git"; do
    git -C "$I" remote set-url origin "$form"
    git -C "$I" config --add "url.file://$T/origin.git.insteadOf" "$form"
    case_ "origin $form: bare number from the home" pull Bash "gh pr merge 12 --squash" "$I"
done
git -C "$I" remote set-url origin "https://github.int.exe.xyz/example/instance.git"
case_ "int host: -R owner/name" pull Bash "gh pr merge 12 -R example/instance" "$T"
case_ "int host: -R host/owner/name" pull Bash "gh pr merge 12 -R github.int.exe.xyz/example/instance" "$T"
case_ "int host: a github.com PR URL" pull Bash "gh pr merge https://github.com/example/instance/pull/12" "$T"
case_ "int host: a PR URL on the int host" pull Bash "gh pr merge https://github.int.exe.xyz/example/instance/pull/12 --squash" "$T"
case_ "int host: owner/name in another case" pull Bash "gh pr merge 12 -R Example/Instance" "$T"
case_ "int host: a worktree of the home" pull Bash "gh pr merge 12 --squash" "$R/worktrees/instance/wt"
case_ "int host: -R example/instance-foo (look-alike)" nopull Bash "gh pr merge 3 -R example/instance-foo" "$I"
case_ "int host: -R someone/instance (same name, other owner)" nopull Bash "gh pr merge 3 -R someone/instance" "$T"

# --- a dirty home is left alone (the change is kept, the skip is logged)
echo base >"$T/seed/f" && git -C "$T/seed" add f && git -C "$T/seed" commit -q -m f && git -C "$T/seed" push -q "$T/origin.git" main
git -C "$I" pull -q --ff-only >/dev/null 2>&1
echo local >>"$I/f"
case_ "home with a changed tracked file: left alone" nopull Bash "gh pr merge 12" "$I"
grep -q local "$I/f" && ok "  the change is kept" || bad "  the change was lost"
grep -q 'skipped: tracked files are changed' "$LOG" && ok "  the skip is logged" || bad "  the skip is not logged"
git -C "$I" checkout -q -- f

# --- a checkout under <root>/repos/<owner>/<repo>
GP="$R/repos/example/tools"
GP_URL="https://github.int.exe.xyz/example/tools.git"
git init -q --bare "$T/gp.git"
git init -q "$T/gpseed"
git -C "$T/gpseed" commit -q --allow-empty -m one
git -C "$T/gpseed" push -q "$T/gp.git" main
git clone -q "$T/gp.git" "$GP"
git -C "$GP" remote set-url origin "$GP_URL"
git -C "$GP" config "url.file://$T/gp.git.insteadOf" "$GP_URL"
mkdir -p "$R/worktrees/tools"
git -C "$GP" worktree add -q "$R/worktrees/tools/wt" -b wt
advance_gp() { git -C "$T/gpseed" commit -q --allow-empty -m "n$RANDOM" && git -C "$T/gpseed" push -q "$T/gp.git" main; }
# want: pull | nopull; the repos/ checkout is checked, and the home must never move.
gp_case() {
    local name="$1" want="$2" cmd="$3" cwd="$4" before home_before after
    advance_gp; advance
    before=$(head_of "$GP"); home_before=$(head_of "$I")
    hook "$(payload Bash "$cmd" "$cwd")"
    after=$(head_of "$GP")
    if ! quiet_rc0; then bad "$name (exit $(cat "$T/rc"))"; return; fi
    if [ "$(head_of "$I")" != "$home_before" ]; then bad "$name (the home moved)"; return; fi
    if [ "$want" = pull ]; then
        if [ "$after" = "$(git -C "$T/gp.git" rev-parse main)" ] && grep -q '^{.*~/work/repos/example/tools main fast-forwarded' "$T/out"; then ok "$name"; else bad "$name (not pulled)"; fi
    else
        if [ "$after" = "$before" ] && [ ! -s "$T/out" ]; then ok "$name"; else bad "$name (pulled or printed)"; fi
    fi
}
gp_case "repos/: -R example/tools pulls that checkout, not the home" pull "gh pr merge 3 -R example/tools --squash" "$T"
gp_case "repos/: bare number from its worktree" pull "gh pr merge 3 --squash --delete-branch" "$R/worktrees/tools/wt"
gp_case "repos/: cd into it, then merge" pull "cd ~/work/repos/example/tools && gh pr merge 3" "$T"
gp_case "repos/: its PR URL" pull "gh pr merge https://github.com/example/tools/pull/3" "$I"
gp_case "repos/: another repo's merge leaves it alone" nopull "gh pr merge 3 -R example/statusline" "$T"
git -C "$GP" checkout -q -b side
gp_case "repos/: a checkout off its default branch is left alone" nopull "gh pr merge 3 -R example/tools" "$T"
[ "$(git -C "$GP" symbolic-ref --short HEAD)" = side ] && ok "  still on its branch" || bad "  branch was changed"
git -C "$GP" checkout -q main
# A single-folder (v0, no root) instance has no repos/ to pull.
sed 's#^dir = .*#dir = "~/single"#' "$FIX/manifests/good-v0-under-root.toml" >"$I/.ghost-protocol/instance.toml"
gp_case "repos/: a single-folder instance (no root) leaves repos/ alone" nopull "gh pr merge 3 -R example/tools" "$T"
git -C "$I" checkout -q -- .ghost-protocol/instance.toml

# --- a fast-forward that stops PART-WAY is told to the agent (a required
# smudge filter fails after a.txt is already written, like a failed Git LFS download)
printf '*.bin filter=bad\n' >"$T/gpseed/.gitattributes"; echo a >"$T/gpseed/a.txt"
git -C "$T/gpseed" add -A && git -C "$T/gpseed" commit -q -m attrs && git -C "$T/gpseed" push -q "$T/gp.git" main
git -C "$GP" pull -q --ff-only >/dev/null 2>&1
git -C "$GP" config filter.bad.smudge false
git -C "$GP" config filter.bad.clean cat
git -C "$GP" config filter.bad.required true
echo a2 >"$T/gpseed/a.txt"; echo bin >"$T/gpseed/m.bin"
git -C "$T/gpseed" add -A && git -C "$T/gpseed" commit -q -m two && git -C "$T/gpseed" push -q "$T/gp.git" main
gp_before=$(head_of "$GP")
hook "$(payload Bash "gh pr merge 3 -R example/tools" "$T")"
if quiet_rc0 && [ "$(head_of "$GP")" = "$gp_before" ] \
    && jq -e '.hookSpecificOutput.additionalContext | test("^auto-pull NEEDS A HAND after gh pr merge: ~/work/repos/example/tools main fast-forward to [0-9a-f]+ failed PART-WAY")' "$T/out" >/dev/null; then
    ok "a PART-WAY fast-forward is told to the agent (NEEDS A HAND)"; else bad "PART-WAY not told: $(head -c 300 "$T/out")"; fi
grep -q 'tools main fast-forward to [0-9a-f]* failed PART-WAY.*external filter' "$LOG" \
    && ok "  and logged, with git's error line" || bad "  PART-WAY not logged"

finish_tests
