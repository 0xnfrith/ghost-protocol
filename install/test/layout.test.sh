#!/usr/bin/env bash
# layout.test.sh: the root layout (docs/layout.md) through the installer:
# where the instance goes (<root>/<name> first, an old ~/<repo> only while
# there is no root layout), the layout's folders, the worktree hook in the
# user's Claude Code settings, and schema v0 read as v1.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

I=(--instance example/instance --yes)
W="work"   # the root in good-v1.toml and good-v0-under-root.toml: ~/work
folders_made() {
    local f
    for f in repos worktrees media desk scratch; do [ -d "$T/home/$W/$f" ] || return 1; done
}
hook_wired() { grep -q "install/layout/worktree-hook create --root $T/home/$W" "$T/home/.claude/settings.json" 2>/dev/null; }

# 1. Schema v1, nothing there yet: a fresh clone at <root>/<name>, the folders
#    and the hook.
t_new; t_std_env; t_make_instance "$FIX/manifests/good-v1.toml"
t_install "${I[@]}"
check "v1, fresh: exit 0" rc_is 0
check "v1, fresh: cloned into ~/work/instance" [ -d "$T/home/$W/instance/.git" ]
check "v1, fresh: nothing at ~/instance" [ ! -e "$T/home/instance" ]
check "v1, fresh: the five folders are made" folders_made
check "v1, fresh: the manifest line names the root" out_has 'OK +manifest +instance instance, schema v1, root ~/work'
check "v1, fresh: the layout step says what it made" out_has 'DONE +layout .*made 5 folders; worktree hook wired'
check "v1, fresh: the worktree hook is in ~/.claude/settings.json" hook_wired
check "v1, fresh: the remove hook too" grep -q "install/layout/worktree-hook remove --root $T/home/$W" "$T/home/.claude/settings.json"
check "v1, fresh: the setup hook ran in the new home" grep -qx 'setup 3' "$T/state/calls"

# 2. A second run changes nothing.
cp "$T/home/.claude/settings.json" "$T/settings.before"
t_install "${I[@]}"
check "v1, again: exit 0" rc_is 0
check "v1, again: the clone is left as it is" out_has "$T/home/$W/instance is already a clone"
check "v1, again: layout OK, hook already wired" out_has 'OK +layout .*every folder there; worktree hook already wired'
check "v1, again: settings.json unchanged" cmp -s "$T/settings.before" "$T/home/.claude/settings.json"

# 3. A dry run of v1 changes nothing and plans the layout.
t_new; t_std_env; t_make_instance "$FIX/manifests/good-v1.toml"
t_snapshot >"$T/before"
t_install "${I[@]}" --dry-run
t_snapshot >"$T/after"
check "v1, dry run: exit 0" rc_is 0
check "v1, dry run: HOME is unchanged" cmp -s "$T/before" "$T/after"
check "v1, dry run: the layout is planned" out_has 'PLAN +layout .*would make 6 folders; would wire the worktree hook'
check "v1, dry run: it prints the clone into ~/work/instance" out_has "would run: git clone --branch main https://github.com/example/instance.git $T/home/$W/instance"

# 4. An old single-folder clone at ~/instance, no ~/work/instance: the old
#    one is used, it says how to move it, and no layout is built.
t_new; t_std_env; t_make_instance "$FIX/manifests/good-v1.toml"; t_clone_into_home
t_install "${I[@]}"
check "old folder only: exit 0" rc_is 0
check "old folder only: ~/instance is used" out_has "OK +instance +$T/home/instance already a clone.*an old single folder, not moved"
check "old folder only: it names the move script" out_has 'install/layout/move --from .*/instance --root ~/work'
check "old folder only: no layout" out_has 'SKIP +layout +the instance is not at'
check "old folder only: nothing made under ~/work" [ ! -e "$T/home/$W" ]
check "old folder only: no hook wired" [ ! -e "$T/home/.claude/settings.json" ]

# 5. A hand-moved instance: ~/instance is a link to ~/work/instance. The root
#    layout wins, by its real path.
t_new; t_std_env; t_make_instance "$FIX/manifests/good-v1.toml"; t_clone_into_home
mkdir -p "$T/home/$W"; mv "$T/home/instance" "$T/home/$W/instance"; ln -s "$W/instance" "$T/home/instance"
t_install "${I[@]}"
check "linked old path: exit 0" rc_is 0
check "linked old path: ~/work/instance is used" out_has "OK +instance +$T/home/$W/instance already a clone"
check "linked old path: the layout is built around it" folders_made
check "linked old path: the hook is wired" hook_wired
check "linked old path: the setup hook ran" grep -qx 'setup 3' "$T/state/calls"

# 6. Both: a real old clone at ~/instance and a clone at ~/work/instance. The
#    root layout wins; the old one is left alone.
t_new; t_std_env; t_make_instance "$FIX/manifests/good-v1.toml"; t_clone_into_home
git clone -q "https://github.com/example/instance.git" "$T/home/$W/instance"
echo keep >"$T/home/instance/marker"
t_install "${I[@]}"
check "both: exit 0" rc_is 0
check "both: ~/work/instance is used" out_has "OK +instance +$T/home/$W/instance already a clone"
check "both: the old clone is untouched" [ "$(cat "$T/home/instance/marker")" = keep ]

# 7. Schema v0 with dir ~/work/instance is read as v1 for the home: the clone
#    goes to ~/work/instance, a note gives the lines to write, and the layout
#    waits for schema v1.
t_new; t_std_env; t_make_instance "$FIX/manifests/good-v0-under-root.toml"
t_install "${I[@]}"
check "v0 read as v1: exit 0" rc_is 0
check "v0 read as v1: cloned into ~/work/instance" [ -d "$T/home/$W/instance/.git" ]
check "v0 read as v1: the summary says so" out_has 'OK +manifest +instance instance, schema v0, read as v1 with root ~/work'
check "v0 read as v1: it prints the schema line" out_has 'write schema = "ghost-protocol/instance/v1" and$'
check "v0 read as v1: it prints the root line" out_has 'root = "~/work" in the manifest, and drop dir'
check "v0 read as v1: the layout waits for v1" out_has 'SKIP +layout +schema v0: write schema v1 with root = "~/work"'
check "v0 read as v1: no layout folders" [ ! -e "$T/home/$W/repos" ]
check "v0 read as v1: no hook wired" [ ! -e "$T/home/.claude/settings.json" ]

# 8. A v0 single-folder manifest: exactly the old behaviour, and a note.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
t_install "${I[@]}"
check "v0 single folder: exit 0" rc_is 0
check "v0 single folder: cloned into ~/instance" [ -d "$T/home/instance/.git" ]
check "v0 single folder: layout SKIP" out_has 'SKIP +layout +single-folder instance'
check "v0 single folder: the note names the move script" out_has 'move it with install/layout/move'

# 9. A wrong GitHub login on a fresh v1 clone: the clone and the root made for
#    it are deleted.
t_new; t_std_env; rm -f "$T/state/gh.authed"; t_make_instance "$FIX/manifests/good-v1.toml"
echo "someone-else" >"$T/state/gh.login"
t_tty ""
t_install --instance example/instance --yes
check "v1, wrong login: exit 5" rc_is 5
check "v1, wrong login: no ~/work left" [ ! -e "$T/home/$W" ]

# 10. A file where a layout folder goes: the step fails and leaves it alone.
t_new; t_std_env; t_make_instance "$FIX/manifests/good-v1.toml"
mkdir -p "$T/home/$W"; echo keep >"$T/home/$W/media"
t_install "${I[@]}"
check "file in the way: exit 1" rc_is 1
check "file in the way: FAIL layout" out_has 'FAIL +layout'
check "file in the way: the file is untouched" [ "$(cat "$T/home/$W/media")" = keep ]
check "file in the way: the setup hook never ran" not_called setup

# 11. An existing settings.json with other hooks: merged with jq, the others kept.
t_new; t_std_env; t_make_instance "$FIX/manifests/good-v1.toml"
mkdir -p "$T/home/.claude"
printf '{"theme": "dark", "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "true"}]}]}}\n' \
    >"$T/home/.claude/settings.json"
if t_tool jq; then
    t_install "${I[@]}"
    check "existing settings: exit 0" rc_is 0
    check "existing settings: the hook is wired" hook_wired
    check "existing settings: the other hook and key are kept" \
        sh -c "jq -e '.theme == \"dark\" and (.hooks.PreToolUse | length) == 1' '$T/home/.claude/settings.json' >/dev/null"
    check "existing settings: a backup is kept" sh -c "ls '$T/home/.claude/' | grep -q '^settings.json.bak-'"
else
    echo "SKIP  existing settings merge (no jq on this machine)"
fi

# 12. The same without jq: the run goes on, says the hook is not wired, and
#     the file is untouched.
t_new; t_std_env; t_make_instance "$FIX/manifests/good-v1.toml"
mkdir -p "$T/home/.claude"; printf '{"theme": "dark"}\n' >"$T/home/.claude/settings.json"
cp "$T/home/.claude/settings.json" "$T/settings.before"
t_install "${I[@]}"
check "no jq: exit 0" rc_is 0
check "no jq: the layout says the hook is not wired" out_has 'layout .*worktree hook NOT wired'
check "no jq: it says why" out_has 'adding to it needs jq'
check "no jq: settings.json untouched" cmp -s "$T/settings.before" "$T/home/.claude/settings.json"

finish_tests
