#!/usr/bin/env bash
# shellcheck disable=SC2016  # jq filters name jq's own $variables in single quotes
# layout-dirs.test.sh: the layout's shared folders in Claude Code's
# permissions.additionalDirectories (docs/layout.md), written by the installer
# and by install/layout/move: a fresh write, a merge that keeps other keys and
# entries, no duplicates on a second run, a move to a new root that
# replaces the old root's entries, a large settings file and an empty one.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

I=(--instance example/instance --yes)
MOVE="$SRC/install/layout/move"
jqf() { jq -e "$@" >/dev/null 2>&1; }
# The five entries for a root, as a JSON list.
five() { printf '["%s/repos","%s/worktrees","%s/media","%s/desk","%s/scratch"]' "$1" "$1" "$1" "$1" "$1"; }
# Each of the root's five folders is in the list exactly once.
once_each() {   # settings root
    jqf --argjson w "$(five "$2")" \
        'all($w[] as $x | [.permissions.additionalDirectories[] | select(. == $x)] | length == 1; .)' "$1"
}
# No entry of the list is under the given root.
none_under() {   # settings root
    jqf --arg r "$2/" '[.permissions.additionalDirectories[] | select(startswith($r))] | length == 0' "$1"
}

t_new
if ! t_tool jq; then
    echo "SKIP  additionalDirectories tests (no jq on this machine; the write needs it)"
    finish_tests
    exit $?
fi

# 1. The installer, nothing there yet: the five folders, as absolute paths
#    under the manifest's root (~/work in good-v1.toml).
t_std_env; t_tool jq; t_make_instance "$FIX/manifests/good-v1.toml"
S="$T/home/.claude/settings.json"; R="$T/home/work"
t_install "${I[@]}"
check "fresh: exit 0" rc_is 0
check "fresh: the five shared folders are in additionalDirectories" \
    jqf --argjson w "$(five "$R")" '.permissions.additionalDirectories == $w' "$S"
check "fresh: the instance's own home is not" \
    jqf --arg h "$R/instance" 'all(.permissions.additionalDirectories[]; . != $h)' "$S"
check "fresh: the worktree hook is still wired" grep -qF "install/layout/worktree-hook create --root $R" "$S"
check "fresh: the layout step says so" out_has 'DONE +layout .*shared folders added to additionalDirectories'

# 2. A second run: no duplicates, and the file is not written again.
cp "$S" "$T/settings.before"
t_install "${I[@]}"
check "again: exit 0" rc_is 0
check "again: each folder once" once_each "$S" "$R"
check "again: five entries, no more" jqf '.permissions.additionalDirectories | length == 5' "$S"
check "again: settings.json unchanged" cmp -s "$T/settings.before" "$S"
check "again: the layout step says they are there" out_has 'OK +layout .*shared folders already in additionalDirectories'

# 3. A settings file with other keys, other permissions and entries of its
#    own, one of them a shared folder already: merged, everything kept, no
#    copy of that folder added.
t_new; t_std_env; t_tool jq; t_make_instance "$FIX/manifests/good-v1.toml"
S="$T/home/.claude/settings.json"; R="$T/home/work"
mkdir -p "$T/home/.claude"
printf '{"theme":"dark","model":"m","permissions":{"allow":["Bash(ls:*)"],"defaultMode":"default","additionalDirectories":["/data/shared","%s/media"]}}\n' "$R" >"$S"
t_install "${I[@]}"
check "merge: exit 0" rc_is 0
check "merge: other keys kept" jqf '.theme == "dark" and .model == "m"' "$S"
check "merge: other permissions kept" jqf '.permissions.allow == ["Bash(ls:*)"] and .permissions.defaultMode == "default"' "$S"
check "merge: the existing entries kept, in their place" \
    jqf --arg m "$R/media" '.permissions.additionalDirectories[0:2] == ["/data/shared", $m]' "$S"
check "merge: each shared folder once" once_each "$S" "$R"
check "merge: six entries in all" jqf '.permissions.additionalDirectories | length == 6' "$S"
check "merge: a backup is kept" sh -c "ls '$T/home/.claude/' | grep -q '^settings.json.bak-'"
cp "$S" "$T/settings.before"
t_install "${I[@]}"
check "merge, again: settings.json unchanged" cmp -s "$T/settings.before" "$S"

# 4. A dry run says what it would add and changes nothing.
t_new; t_std_env; t_tool jq; t_make_instance "$FIX/manifests/good-v1.toml"
mkdir -p "$T/home/.claude"; printf '{"theme":"dark"}\n' >"$T/home/.claude/settings.json"
cp "$T/home/.claude/settings.json" "$T/settings.before"
t_install "${I[@]}" --dry-run
check "dry run: exit 0" rc_is 0
check "dry run: it would add them" out_has 'would add: 5 shared folder'
check "dry run: settings.json unchanged" cmp -s "$T/settings.before" "$T/home/.claude/settings.json"

# 5. install/layout/move to a new root: the old root's five entries give way
#    to the new root's, unrelated entries and keys stay; a second --apply
#    changes nothing; --rollback puts the list back as it was.
t_new; t_std_env; t_stub pgrep; t_tool jq
H="$T/home"; S="$H/.claude/settings.json"; OLDROOT="$H/old"; R="$H/work"
t_make_instance "$FIX/manifests/good.toml"
t_clone_into_home
mkdir -p "$H/.claude"
jq -n --argjson o "$(five "$OLDROOT")" \
    '{theme: "dark", permissions: {allow: ["Read"], additionalDirectories: (["/data/shared"] + $o + ["/srv/media"])}}' >"$S"
cp "$S" "$T/settings.orig"
mv_run() { t_env "$MOVE" --from \~/instance --root \~/work "$@" >"$OUT" 2>&1; RC=$?; }
mv_run
check "move, dry run: exit 0" rc_is 0
check "move, dry run: it would replace the old root's entries" out_has 'would add: 5 shared folder.*in place of 5 entries of an old root'
check "move, dry run: settings.json unchanged" cmp -s "$T/settings.orig" "$S"
mv_run --apply
check "move: exit 0" rc_is 0
check "move: the new root's five folders, once each" once_each "$S" "$R"
check "move: no entry of the old root left" none_under "$S" "$OLDROOT"
check "move: unrelated entries kept, in order" \
    jqf '.permissions.additionalDirectories[0:2] == ["/data/shared", "/srv/media"]' "$S"
check "move: seven entries in all" jqf '.permissions.additionalDirectories | length == 7' "$S"
check "move: other keys and permissions kept" jqf '.theme == "dark" and .permissions.allow == ["Read"]' "$S"
check "move: the worktree hook is wired for the new root" grep -qF "install/layout/worktree-hook create --root $R" "$S"
cp "$S" "$T/settings.moved"
mv_run --apply
check "move again: exit 0" rc_is 0
check "move again: settings.json unchanged" cmp -s "$T/settings.moved" "$S"
mv_run --rollback
check "move rollback: exit 0" rc_is 0
check "move rollback: the list is as it was" \
    jqf --slurpfile o "$T/settings.orig" '.permissions.additionalDirectories == $o[0].permissions.additionalDirectories' "$S"
check "move rollback: the file is as it was" jqf --slurpfile o "$T/settings.orig" '. == $o[0]' "$S"

# 6. A move with no settings file before it: the rollback leaves none.
t_new; t_std_env; t_stub pgrep; t_tool jq
t_make_instance "$FIX/manifests/good.toml"
t_clone_into_home
rm -f "$T/home/.claude/settings.json"
mv_run --apply
check "move, no settings before: exit 0" rc_is 0
check "move, no settings before: the five folders are there" \
    jqf --argjson w "$(five "$T/home/work")" '.permissions.additionalDirectories == $w' "$T/home/.claude/settings.json"
mv_run --rollback
check "move, no settings before, rollback: exit 0" rc_is 0
check "move, no settings before, rollback: no settings.json left" [ ! -e "$T/home/.claude/settings.json" ]

# 7. A large settings file (over 200KB, more than one argument may carry):
#    the folders are written, the step counts them, other keys are kept.
t_new; t_std_env; t_tool jq; t_make_instance "$FIX/manifests/good-v1.toml"
S="$T/home/.claude/settings.json"; R="$T/home/work"
mkdir -p "$T/home/.claude"
jq -n '{theme: "dark", big: [range(0; 12000) | "entry-\(.)-padding-padding"],
        permissions: {allow: ["Read"], additionalDirectories: ["/data/shared"]}}' >"$S"
check "large: the file is over 200KB" [ "$(wc -c <"$S")" -gt 204800 ]
t_install "${I[@]}"
check "large: exit 0" rc_is 0
check "large: the five shared folders are in additionalDirectories" \
    jqf --argjson w "$(five "$R")" '.permissions.additionalDirectories == ["/data/shared"] + $w' "$S"
check "large: the step counts the five it added" out_has 'added: 5 shared folder'
check "large: other keys kept" jqf '.theme == "dark" and (.big | length == 12000) and .big[11999] == "entry-11999-padding-padding"' "$S"
check "large: other permissions kept" jqf '.permissions.allow == ["Read"]' "$S"

# 8. An empty (0-byte) settings file is taken as {}: the folders are written.
t_new; t_std_env; t_tool jq; t_make_instance "$FIX/manifests/good-v1.toml"
S="$T/home/.claude/settings.json"; R="$T/home/work"
mkdir -p "$T/home/.claude"; : >"$S"
t_install "${I[@]}"
check "empty: exit 0" rc_is 0
check "empty: the five shared folders are in additionalDirectories" \
    jqf --argjson w "$(five "$R")" '.permissions.additionalDirectories == $w' "$S"
check "empty: the step says it added them" out_has 'added: 5 shared folder'
check "empty: not called 'not a JSON object'" out_lacks 'is not a JSON object'

finish_tests
