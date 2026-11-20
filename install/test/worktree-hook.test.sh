#!/usr/bin/env bash
# worktree-hook.test.sh: install/layout/worktree-hook, Claude Code's
# WorktreeCreate and WorktreeRemove hooks for the root layout, fed hook JSON
# on stdin as Claude Code sends it; then wire and unwire.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

HOOK="$SRC/install/layout/worktree-hook"
t_new
R="$T/home/work"          # the root
mkdir -p "$R/worktrees" "$R/repos/example"

# A bare remote with main (holding a manifest, as an instance's home does),
# and clones of it: the home, two repos in repos/ with one folder name, and a
# repo outside the root.
src="$T/src"
git init -q "$src"; mkdir -p "$src/.ghost-protocol"; echo '# manifest' >"$src/.ghost-protocol/instance.toml"
git -C "$src" add -A; git -C "$src" commit -q -m one
git clone -q --bare "$src" "$T/remote.git"
git clone -q "$T/remote.git" "$R/inst"
git clone -q "$T/remote.git" "$R/repos/example/tools"
git clone -q "$T/remote.git" "$R/repos/other/tools"
git clone -q "$T/remote.git" "$T/home/elsewhere"

hook() {   # subcommand root json -> $OUT (stdout) and $T/err (stderr), $RC
    printf '%s' "$3" | t_env "$HOOK" "$1" --root "$2" >"$OUT" 2>"$T/err"
    RC=$?
}
create_json() { printf '{"session_id":"s1","transcript_path":"/x.jsonl","cwd":"%s","hook_event_name":"WorktreeCreate","name":"%s"}' "$1" "$2"; }
remove_json() { printf '{"session_id":"s1","cwd":"%s","hook_event_name":"WorktreeRemove","worktree_path":"%s"}' "$1" "$2"; }
lines() { wc -l <"$OUT" | tr -d ' '; }

# 1. A new worktree of the home goes to <root>/worktrees/<repo>/<name>, on a
#    branch called <name>, with no upstream; stdout is only the path.
hook create "$R" "$(create_json "$R/inst" feat-a)"
check "create: exit 0" rc_is 0
check "create: stdout is one line, the path" sh -c "[ '$(lines)' = 1 ] && [ \"\$(cat '$OUT')\" = '$R/worktrees/inst/feat-a' ]"
check "create: the worktree is there" [ -f "$R/worktrees/inst/feat-a/.git" ]
check "create: on branch feat-a" [ "$(git -C "$R/worktrees/inst/feat-a" symbolic-ref --short HEAD)" = feat-a ]
check "create: no upstream" sh -c "! git -C '$R/inst' config --get branch.feat-a.merge"
check "create: started from origin/main" \
    [ "$(git -C "$R/worktrees/inst/feat-a" rev-parse HEAD)" = "$(git -C "$R/inst" rev-parse origin/main)" ]

# 2. The same name again: the worktree is reused.
hook create "$R" "$(create_json "$R/inst" feat-a)"
check "create again: exit 0, the same path" sh -c "[ $RC = 0 ] && [ \"\$(cat '$OUT')\" = '$R/worktrees/inst/feat-a' ]"
check "create again: it says it reuses it" grep -q 'reusing the worktree' "$T/err"

# 3. From inside a worktree, a new one still belongs to the main checkout.
hook create "$R" "$(create_json "$R/worktrees/inst/feat-a" feat-b)"
check "from a worktree: the path is under worktrees/inst" [ "$(cat "$OUT")" = "$R/worktrees/inst/feat-b" ]

# 4. A repo in repos/<owner>/<repo>: worktrees/<repo>/<name>.
hook create "$R" "$(create_json "$R/repos/example/tools" fix/x)"
check "repos/: exit 0" rc_is 0
check "repos/: worktrees/tools/fix/x" [ "$(cat "$OUT")" = "$R/worktrees/tools/fix/x" ]

# 5. A repo outside the root: Claude Code's own default place and branch.
hook create "$R" "$(create_json "$T/home/elsewhere" side)"
check "outside the root: exit 0" rc_is 0
check "outside the root: .claude/worktrees/<name>" [ "$(cat "$OUT")" = "$T/home/elsewhere/.claude/worktrees/side" ]
check "outside the root: branch worktree-<name>" \
    [ "$(git -C "$T/home/elsewhere/.claude/worktrees/side" symbolic-ref --short HEAD)" = worktree-side ]

# 6. A root with no worktrees/ folder: the default too.
mkdir -p "$T/home/bare-root"; git clone -q "$T/remote.git" "$T/home/bare-root/inst2"
hook create "$T/home/bare-root" "$(create_json "$T/home/bare-root/inst2" other)"
check "no worktrees/ folder: the default place" [ "$(cat "$OUT")" = "$T/home/bare-root/inst2/.claude/worktrees/other" ]

# 7. Refusals: exit 1, nothing on stdout.
refused() {   # json what
    hook create "$R" "$1"
    if [ "$RC" = 1 ] && [ ! -s "$OUT" ]; then ok "$2"; else bad "$2 (exit $RC)"; fi
}
refused "$(create_json "$R/inst" main)" "the name main is refused"
refused "$(create_json "$R/inst" '../escape')" "a name with .. is refused"
refused "$(create_json "$R/inst" '-x')" "a name starting with a dash is refused"
refused '{"cwd":"'"$R/inst"'","name":"a\"b"}' "input with an escape is refused"
refused "$(create_json "$T/home/not-there" ok-name)" "a cwd that does not exist is refused"

# 7b. A folder directly in the root with no manifest is not the home: the default.
git init -q "$R/plain"; git -C "$R/plain" commit -q --allow-empty -m one
hook create "$R" "$(create_json "$R/plain" p1)"
check "a repo in the root with no manifest: the default place" [ "$(cat "$OUT")" = "$R/plain/.claude/worktrees/p1" ]

# 7c. A name already taken in worktrees/<repo>/: by a folder that is not a
#     worktree, or by another repo of the same folder name. The default place,
#     and nothing in the way is touched.
mkdir -p "$R/worktrees/inst/taken"; echo x >"$R/worktrees/inst/taken/file"
hook create "$R" "$(create_json "$R/inst" taken)"
check "a folder in the way: exit 0, the default place" sh -c "[ $RC = 0 ] && [ \"\$(cat '$OUT')\" = '$R/inst/.claude/worktrees/taken' ]"
check "a folder in the way: left alone" [ "$(cat "$R/worktrees/inst/taken/file")" = x ]
hook create "$R" "$(create_json "$R/repos/example/tools" same)"
hook create "$R" "$(create_json "$R/repos/other/tools" same)"
check "two repos named tools: the second goes to its default place" \
    sh -c "[ $RC = 0 ] && [ \"\$(cat '$OUT')\" = '$R/repos/other/tools/.claude/worktrees/same' ]"

# 7d. A .claude link that leads out of the repo is refused, and nothing is made.
git clone -q "$T/remote.git" "$T/home/linked"; mkdir -p "$T/home/outside"
ln -s ../outside "$T/home/linked/.claude"
hook create "$R" "$(create_json "$T/home/linked" lk)"
check "a .claude link: exit 1" rc_is 1
check "a .claude link: nothing made where it leads" [ -z "$(ls -A "$T/home/outside")" ]

# 7e. A submodule's worktree: its own main checkout, the default place.
git -C "$T/home/elsewhere" submodule add -q "$T/remote.git" sub >/dev/null 2>&1
hook create "$R" "$(create_json "$T/home/elsewhere/sub" subwt)"
check "a submodule: exit 0" rc_is 0
check "a submodule: under the submodule's .claude/worktrees" [ "$(cat "$OUT")" = "$T/home/elsewhere/sub/.claude/worktrees/subwt" ]
hook create "$R" "$(create_json "$T/home/elsewhere/sub/.claude/worktrees/subwt" subwt2)"
check "a submodule, from its worktree: the same main checkout" [ "$(cat "$OUT")" = "$T/home/elsewhere/sub/.claude/worktrees/subwt2" ]

# 7f. The ignored files .worktreeinclude names are copied into a new worktree.
printf '.env\n' >"$R/repos/example/tools/.gitignore"
printf '.env\n' >"$R/repos/example/tools/.worktreeinclude"
printf 'LOCAL=1\n' >"$R/repos/example/tools/.env"
hook create "$R" "$(create_json "$R/repos/example/tools" inc)"
check ".worktreeinclude: .env is copied" [ "$(cat "$R/worktrees/tools/inc/.env" 2>/dev/null)" = "LOCAL=1" ]

# 7g. .worktreeinclude never follows a link. A branch carries a dangling link
#     where an ignored file would land, and a linked folder where another one
#     would; and the source of a third is itself a link. None is copied, and
#     nothing appears where the links point.
TL="$R/repos/example/tools"
git clone -q "$T/remote.git" "$T/linky-src"
git -C "$T/linky-src" checkout -q -b linky
mkdir -p "$T/outside-dir"
ln -s "$T/outside-target" "$T/linky-src/secret.txt"
ln -s "$T/outside-dir" "$T/linky-src/conf"
git -C "$T/linky-src" add -A; git -C "$T/linky-src" commit -q -m links
git -C "$T/linky-src" push -q origin linky
git -C "$TL" fetch -q origin linky:linky
printf '.env\nsecret.txt\nconf/\nlinked.txt\n' >"$TL/.gitignore"
cp "$TL/.gitignore" "$TL/.worktreeinclude"
printf 'top secret\n' >"$TL/secret.txt"
mkdir -p "$TL/conf"; printf 'k=v\n' >"$TL/conf/app.ini"
printf 'real\n' >"$T/real-file"; ln -s "$T/real-file" "$TL/linked.txt"
hook create "$R" "$(create_json "$TL" linky)"
WL="$R/worktrees/tools/linky"
check "links: exit 0 (the worktree is still made)" rc_is 0
check "links: the branch's links are there" sh -c "[ -L '$WL/secret.txt' ] && [ -L '$WL/conf' ]"
check "links: a dangling link at the destination is not written through" [ ! -e "$T/outside-target" ]
check "links: a linked folder at the destination is not written into" [ ! -e "$T/outside-dir/app.ini" ]
check "links: a source that is a link is not copied" sh -c "[ ! -e '$WL/linked.txt' ] && [ ! -L '$WL/linked.txt' ]"
check "links: the plain file is still copied" [ "$(cat "$WL/.env" 2>/dev/null)" = "LOCAL=1" ]
check "links: it says what it skipped" grep -q 'skipped 3 file' "$T/err"

# 8. Remove: a merged branch is deleted with the worktree; empty parent
#    folders go up to worktrees/.
hook remove "$R" "$(remove_json "$R/repos/example/tools" "$R/worktrees/tools/fix/x")"
check "remove: exit 0" rc_is 0
check "remove: the worktree is gone" [ ! -e "$R/worktrees/tools/fix/x" ]
check "remove: the empty parent fix/ is gone" [ ! -e "$R/worktrees/tools/fix" ]
check "remove: worktrees/ stays" [ -d "$R/worktrees" ]
check "remove: the merged branch is deleted" sh -c "! git -C '$R/repos/example/tools' show-ref --verify --quiet refs/heads/fix/x"

# 9. Remove keeps a branch with work on it.
git -C "$R/worktrees/inst/feat-b" commit -q --allow-empty -m work
hook remove "$R" "$(remove_json "$R/inst" "$R/worktrees/inst/feat-b")"
check "remove, unmerged: exit 0" rc_is 0
check "remove, unmerged: the worktree is gone" [ ! -e "$R/worktrees/inst/feat-b" ]
check "remove, unmerged: the branch is kept" git -C "$R/inst" show-ref --verify --quiet refs/heads/feat-b
check "remove, unmerged: it says so" grep -q 'kept branch feat-b' "$T/err"

# 10. Remove never touches a main checkout or a folder it did not place.
hook remove "$R" "$(remove_json "$R/inst" "$R/inst")"
check "remove a main checkout: exit 1" rc_is 1
check "remove a main checkout: still there" [ -d "$R/inst/.git" ]
git -C "$R/inst" worktree add -q "$T/home/hand-made" -b hand 2>/dev/null
hook remove "$R" "$(remove_json "$R/inst" "$T/home/hand-made")"
check "remove a worktree outside the hook's places: exit 1" rc_is 1
check "remove a worktree outside the hook's places: still there" [ -d "$T/home/hand-made" ]
hook remove "$R" "$(remove_json "$R/inst" "$R/worktrees/inst/gone-already")"
check "remove a path that is already gone: exit 0" rc_is 0

# 11. wire with no settings file: it writes one; again: already wired; unwire.
ST="$T/home/.claude/settings.json"
t_env "$HOOK" wire --root "$R" --dry-run >"$OUT" 2>&1
check "wire --dry-run: writes nothing" [ ! -e "$ST" ]
t_env "$HOOK" wire --root "$R" >"$OUT" 2>&1; RC=$?
check "wire: exit 0" rc_is 0
check "wire: it says wired" out_has '^wired: wrote'
check "wire: the create command" grep -qF "\"$HOOK create --root $R\"" "$ST"
check "wire: the remove command" grep -qF "\"$HOOK remove --root $R\"" "$ST"
t_env "$HOOK" wire --root "$R" >"$OUT" 2>&1; RC=$?
check "wire again (no jq): already wired" sh -c "[ $RC = 0 ] && grep -q '^already wired' '$OUT'"
if t_tool jq; then
    check "wire: the file is valid JSON" jq -e '.hooks.WorktreeCreate | length == 1' "$ST"
    # A settings file with another WorktreeCreate hook: refused (exit 3), untouched.
    printf '{"hooks":{"WorktreeCreate":[{"hooks":[{"type":"command","command":"other-tool"}]}]}}\n' >"$T/other.json"
    cp "$T/other.json" "$T/other.before"
    t_env "$HOOK" wire --root "$R" --settings "$T/other.json" >"$OUT" 2>&1; RC=$?
    check "another WorktreeCreate hook: exit 3" rc_is 3
    check "another WorktreeCreate hook: file untouched" cmp -s "$T/other.json" "$T/other.before"
    # Other events' hooks are kept by wire and by unwire.
    printf '{"model":"x","hooks":{"Stop":[{"hooks":[{"type":"command","command":"true"}]}]}}\n' >"$T/mixed.json"
    t_env "$HOOK" wire --root "$R" --settings "$T/mixed.json" >"$OUT" 2>&1; RC=$?
    check "wire into a file with other hooks: exit 0" rc_is 0
    check "wire into a file with other hooks: both there" \
        jq -e '.model == "x" and (.hooks.Stop | length) == 1 and (.hooks.WorktreeCreate | length) == 1' "$T/mixed.json"
    t_env "$HOOK" unwire --settings "$T/mixed.json" >"$OUT" 2>&1; RC=$?
    check "unwire: exit 0" rc_is 0
    check "unwire: only this hook's entries go" \
        jq -e '.model == "x" and (.hooks.Stop | length) == 1 and (.hooks | has("WorktreeCreate") | not) and (.hooks | has("WorktreeRemove") | not)' "$T/mixed.json"
    # A settings file that is a link to a private file: the link stays, the
    # file it names is edited, and its mode is kept.
    mkdir -p "$T/dotfiles"; printf '{"theme":"dark"}\n' >"$T/dotfiles/settings.json"; chmod 600 "$T/dotfiles/settings.json"
    ln -s "$T/dotfiles/settings.json" "$T/linked.json"
    t_env "$HOOK" wire --root "$R" --settings "$T/linked.json" >"$OUT" 2>&1; RC=$?
    check "a linked settings file: exit 0" rc_is 0
    check "a linked settings file: still a link" [ -L "$T/linked.json" ]
    check "a linked settings file: the file it names has the hook" jq -e '.theme == "dark" and (.hooks.WorktreeCreate | length) == 1' "$T/dotfiles/settings.json"
    mode_of() { if stat -c %a "$1" >/dev/null 2>&1; then stat -c %a "$1"; else stat -f %Lp "$1"; fi; }
    check "a linked settings file: its mode is kept (0600)" [ "$(mode_of "$T/dotfiles/settings.json")" = 600 ]
    check "a linked settings file: the backup sits beside the link, not in dotfiles/" \
        sh -c "ls -a '$T' | grep -q '^linked.json.bak-' && ! ls -a '$T/dotfiles' | grep -q bak"
else
    echo "SKIP  wire and unwire with jq (no jq on this machine)"
fi

# 12. Usage errors.
t_env "$HOOK" create >"$OUT" 2>&1 </dev/null; RC=$?
check "create without --root: exit 2" rc_is 2
t_env "$HOOK" frobnicate --root "$R" >"$OUT" 2>&1 </dev/null; RC=$?
check "an unknown subcommand: exit 2" rc_is 2

finish_tests
