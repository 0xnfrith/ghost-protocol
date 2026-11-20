#!/usr/bin/env bash
# shellcheck disable=SC2016  # jq filters name jq's own $variables in single quotes
# move.test.sh: install/layout/move on a sandbox home: an old single-folder
# instance at ~/instance, with Claude Code's project folder, trust entry,
# plugin and marketplace paths, settings and a worktree, moves to
# ~/work/instance; a dry run changes nothing; it refuses while Claude Code
# runs; --apply twice; --rollback puts everything back.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MOVE="$SRC/install/layout/move"
key() { printf '%s' "$1" | sed 's/[^A-Za-z0-9]/-/g'; }

# The sandbox: an old instance with everything Claude Code keeps about it.
setup_old() {
    t_new
    t_stub pgrep
    H="$T/home"; OLD="$H/instance"; NEW="$H/work/instance"
    P_OLD="$H/.claude/projects/$(key "$OLD")"; P_NEW="$H/.claude/projects/$(key "$NEW")"
    t_make_instance "$FIX/manifests/good.toml"
    t_clone_into_home
    git -C "$OLD" worktree add -q "$OLD/.claude/worktrees/wt" -b wt 2>/dev/null
    mkdir -p "$P_OLD" "$H/.claude/plugins"
    echo '{"type":"user"}' >"$P_OLD/session.jsonl"
    mkdir -p "$P_OLD/memory"; echo "remember" >"$P_OLD/memory/MEMORY.md"
    printf '{"projects":{"%s":{"hasTrustDialogAccepted":true,"allowedTools":[]},"/other":{"x":1}},"numStartups":3}\n' "$OLD" >"$H/.claude.json"
    printf '{"version":2,"plugins":{"p@m":[{"scope":"local","projectPath":"%s","installPath":"/cache/p"}],"q@m":[{"scope":"user","installPath":"/cache/q"}]}}\n' "$OLD" \
        >"$H/.claude/plugins/installed_plugins.json"
    printf '{"m":{"source":{"source":"directory","path":"%s"},"installLocation":"%s"},"n":{"source":{"source":"github","repo":"a/b"},"installLocation":"/cache/n"}}\n' "$OLD" "$OLD" \
        >"$H/.claude/plugins/known_marketplaces.json"
    # The status line is already wired, so the installer run in step 5 leaves
    # settings.json as the move left it.
    printf '{"extraKnownMarketplaces":{"m":{"source":{"source":"directory","path":"%s/plugins"}}},"theme":"dark","statusLine":{"type":"command","command":"%s/statusline/statusline.sh","refreshInterval":1}}\n' "$OLD" "$SRC" \
        >"$H/.claude/settings.json"
}
mv_run() { t_env "$MOVE" --from \~/instance --root \~/work "$@" >"$OUT" 2>&1; RC=$?; }
jqf() { jq -e "$@" >/dev/null 2>&1; }
# The home folder's listing without the files a run leaves on purpose (the
# .bak copies and the state file), git's own bookkeeping, and ~/.local (the
# installer run in step 5 puts its claude stand-in there).
listing() { t_snapshot | grep -vE '\.bak-|/\.local(/|$)|/\.git/' ; }

setup_old
if ! t_tool jq; then
    echo "SKIP  move tests (no jq on this machine; the move script needs it)"
    finish_tests
    exit $?
fi

# 1. A dry run changes nothing and passes every check.
t_snapshot >"$T/before"
mv_run
t_snapshot >"$T/after"
check "dry run: exit 0" rc_is 0
check "dry run: HOME is unchanged" cmp -s "$T/before" "$T/after"
check "dry run: it would move the repo" out_has "would mv $OLD $NEW"
check "dry run: it would move the project folder" out_has "would mv $P_OLD $P_NEW"
check "dry run: it would edit .claude.json" out_has 'would claude.json: edit'
check "dry run: it would wire the hook" out_has 'would wire'
check "dry run: it read the name from the manifest" out_has '\(instance instance\)'

# 2. Refusals: Claude Code running; then a target that already exists.
touch "$T/state/claude.running"
mv_run --apply
check "Claude Code running: exit 1" rc_is 1
check "Claude Code running: it says so" out_has 'Claude Code is running'
check "Claude Code running: nothing moved" [ -d "$OLD/.git" ] && [ ! -e "$NEW" ]
rm -f "$T/state/claude.running"
mkdir -p "$NEW"
mv_run --apply
check "target exists: exit 1" rc_is 1
check "target exists: nothing moved" [ -d "$OLD/.git" ] && [ ! -L "$OLD" ]
rmdir "$NEW" "$H/work"

# 3. --apply.
listing >"$T/listing.before"
mv_run --apply
check "apply: exit 0" rc_is 0
check "apply: the repo is at ~/work/instance" [ -d "$NEW/.git" ]
check "apply: ~/instance links to it" sh -c "[ -L '$OLD' ] && [ \"\$(cd '$OLD' && pwd -P)\" = '$NEW' ]"
check "apply: the layout's folders are made" sh -c "for f in repos worktrees media desk scratch; do [ -d '$H/work/'\$f ] || exit 1; done"
check "apply: the project folder moved, memory and all" [ "$(cat "$P_NEW/memory/MEMORY.md")" = remember ]
check "apply: the old project name links to the new one" sh -c "[ -L '$P_OLD' ] && [ \"\$(readlink '$P_OLD')\" = '$(basename "$P_NEW")' ]"
check "apply: trust copied to the new path" jqf --arg n "$NEW" '.projects[$n].hasTrustDialogAccepted == true' "$H/.claude.json"
check "apply: the old trust entry is kept" jqf --arg o "$OLD" '.projects[$o].hasTrustDialogAccepted == true' "$H/.claude.json"
check "apply: other keys of .claude.json kept" jqf '.numStartups == 3 and .projects["/other"].x == 1' "$H/.claude.json"
check "apply: the local plugin's projectPath moved" jqf --arg n "$NEW" '.plugins["p@m"][0].projectPath == $n' "$H/.claude/plugins/installed_plugins.json"
check "apply: the user plugin has no projectPath added" jqf '.plugins["q@m"][0] | has("projectPath") | not' "$H/.claude/plugins/installed_plugins.json"
check "apply: the directory marketplace moved" \
    jqf --arg n "$NEW" '.m.source.path == $n and .m.installLocation == $n and .n.installLocation == "/cache/n"' "$H/.claude/plugins/known_marketplaces.json"
check "apply: settings' marketplace path moved (a path under the folder)" \
    jqf --arg n "$NEW/plugins" '.extraKnownMarketplaces.m.source.path == $n and .theme == "dark"' "$H/.claude/settings.json"
check "apply: the worktree hook is wired" grep -qF "install/layout/worktree-hook create --root $H/work" "$H/.claude/settings.json"
check "apply: the worktree's .git names the new place" grep -q "^gitdir: $NEW/.git/worktrees/" "$NEW/.claude/worktrees/wt/.git"
check "apply: git lists the worktree at its new place" sh -c "git -C '$NEW' worktree list | grep -q '^$NEW/.claude/worktrees/wt '"
check "apply: a state file" [ -f "$H/.local/state/ghost-protocol/move-instance.state" ]
check "apply: .bak-move copies kept" sh -c "ls -a '$H' | grep -q '^.claude.json.bak-move-'"
check "apply: it prints the v1 lines" out_has 'schema = "ghost-protocol/instance/v1" and root = "~/work"'

# 4. --apply again changes nothing.
t_snapshot >"$T/applied"
mv_run --apply
t_snapshot >"$T/applied2"
check "apply again: exit 0" rc_is 0
check "apply again: nothing is done" out_lacks 'doing '
check "apply again: HOME is the same, but for the state file" \
    sh -c "diff '$T/applied' '$T/applied2' | grep '^[<>]' | grep -v 'move-instance.state' | grep -q . && exit 1 || exit 0"

# 5. The installer, after the move, takes ~/work/instance.
t_std_env
cp "$FIX/manifests/good-v1.toml" "$T/src-instance/.ghost-protocol/instance.toml"
git -C "$T/src-instance" commit -q -am v1
git -C "$T/src-instance" push -q "$T/remote/github/example/instance.git" HEAD:main
t_install --instance example/instance --yes
check "installer after the move: exit 0" rc_is 0
check "installer after the move: it uses ~/work/instance" out_has "OK +instance +$NEW already a clone"
check "installer after the move: the status line was already wired" out_has 'OK +statusline +already wired'

# 6. --rollback --dry-run changes nothing; --rollback puts it all back.
t_snapshot >"$T/pre-rollback"
mv_run --rollback --dry-run
t_snapshot >"$T/post-rollback-dry"
check "rollback dry run: exit 0" rc_is 0
check "rollback dry run: HOME is unchanged" cmp -s "$T/pre-rollback" "$T/post-rollback-dry"
mv_run --rollback
check "rollback: exit 0" rc_is 0
check "rollback: the repo is back at ~/instance" sh -c "[ -d '$OLD/.git' ] && [ ! -L '$OLD' ]"
check "rollback: ~/work is gone (it was made by the move, and is empty)" [ ! -e "$H/work" ]
check "rollback: the project folder is back" sh -c "[ -d '$P_OLD' ] && [ ! -L '$P_OLD' ] && [ ! -e '$P_NEW' ]"
check "rollback: the worktree's .git names the old place again" grep -q "^gitdir: $OLD/.git/worktrees/" "$OLD/.claude/worktrees/wt/.git"
listing >"$T/listing.after"
check "rollback: the home folder is as it was (but for .bak copies and the state file)" \
    cmp -s "$T/listing.before" "$T/listing.after"
check "rollback: the state file is set aside" sh -c "ls '$H/.local/state/ghost-protocol/' | grep -q '^move-instance.state.rolled-back-'"

# 7. A rollback after Claude Code changed .claude.json: the reverse edit, not
#    the old copy, so the change survives.
mv_run --apply
jq '.numStartups = 4' "$H/.claude.json" >"$T/cj" && cp "$T/cj" "$H/.claude.json"
mv_run --rollback
check "rollback after a change: exit 0" rc_is 0
check "rollback after a change: the new entry is gone, the change kept" \
    jqf --arg n "$NEW" '(.projects | has($n) | not) and .numStartups == 4' "$H/.claude.json"

# 8. Linked files (a dotfiles setup): ~/.claude.json and settings.json are
#    links to private files. They stay links, their files are edited with
#    their modes kept, and the rollback puts the text back through the links.
setup_old
t_tool jq
mkdir -p "$H/dotfiles"
mv "$H/.claude.json" "$H/dotfiles/claude.json"; ln -s dotfiles/claude.json "$H/.claude.json"
mv "$H/.claude/settings.json" "$H/dotfiles/settings.json"; ln -s ../dotfiles/settings.json "$H/.claude/settings.json"
chmod 600 "$H/dotfiles/claude.json" "$H/dotfiles/settings.json"
cp "$H/dotfiles/claude.json" "$T/cj.before"
mv_run --apply
check "linked files: exit 0" rc_is 0
check "linked files: ~/.claude.json is still a link" [ -L "$H/.claude.json" ]
check "linked files: settings.json is still a link" [ -L "$H/.claude/settings.json" ]
check "linked files: the trust edit is in the linked file" jqf --arg n "$NEW" '.projects[$n].hasTrustDialogAccepted == true' "$H/dotfiles/claude.json"
check "linked files: modes kept (0600)" \
    sh -c "[ \"\$(ls -l '$H/dotfiles/claude.json' | cut -c1-10)\" = -rw------- ] && [ \"\$(ls -l '$H/dotfiles/settings.json' | cut -c1-10)\" = -rw------- ]"
mv_run --rollback
check "linked files: no backup inside dotfiles/ (they sit beside the links)" sh -c "! ls -a '$H/dotfiles' | grep -q bak"
check "linked files, rollback: exit 0" rc_is 0
check "linked files, rollback: still a link" [ -L "$H/.claude.json" ]
check "linked files, rollback: the text is back" cmp -s "$T/cj.before" "$H/dotfiles/claude.json"

# 9. Usage.
t_env "$MOVE" --from \~/instance >"$OUT" 2>&1; RC=$?
check "no --root: exit 2" rc_is 2
t_env "$MOVE" --from \~/instance --root \~ >"$OUT" 2>&1; RC=$?
check "--root ~: exit 2" rc_is 2
t_env "$MOVE" --from \~/instance --root \~/instance/inner >"$OUT" 2>&1; RC=$?
check "a root inside the old folder: exit 2" rc_is 2

finish_tests
