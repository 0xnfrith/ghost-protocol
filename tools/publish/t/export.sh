#!/usr/bin/env bash
# export: exactly the allowlisted files, nothing else, and never the never-public paths.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

R=$T/repo
mk_repo "$R"
commit "$R" "first"
cd "$R" || exit 1

want="LICENSE
README.md
src/a.txt
src/run
tools/publish/allowlist"
check_eq "--list is exactly the allowlist's files" "$("$PUB/export" --list)" "$want"
check_eq "--list names no file of evals/, docs/plans/ or the internal folder" \
  "$("$PUB/export" --list | grep -cE '^(evals/|docs/plans/|tools/publish/internal/)' || true)" "0"
check_eq "--list leaves out a file the allowlist excepts" "$("$PUB/export" --list | grep -c private-note || true)" "0"

mkdir "$T/out"
"$PUB/export" --dir HEAD "$T/out"
check_eq "--dir writes exactly those files" "$(cd "$T/out" && find . -type f | sed 's#^\./##' | sort)" "$want"
check "--dir keeps the executable bit" test -x "$T/out/src/run"
check_not "--dir keeps no executable bit on a plain file" test -x "$T/out/src/a.txt"

# --tree is the tree of those files, byte for byte: the same id as git makes from the --dir copy.
tree=$("$PUB/export" --tree)
git init -q "$T/copy"
(cd "$T/out" && git --git-dir="$T/copy/.git" --work-tree=. add -A)
check_eq "--tree equals the tree git makes from the exported files" "$tree" "$(git --git-dir="$T/copy/.git" write-tree)"

# The allowlist is the one in the commit being exported.
git -C "$R" show HEAD:tools/publish/allowlist >/dev/null
printf 'README.md\n' >"$T/small"
check_eq "--allowlist replaces the allowlist" "$("$PUB/export" --list --allowlist "$T/small")" "README.md"
check_eq "a commit's own allowlist is used" "$("$PUB/export" --list HEAD | head -1)" "LICENSE"

# What is never public is refused when named, and left out when only a folder above it is listed.
for entry in evals/ evals/case.txt docs/plans/ docs/plans/plan.md tools/publish/internal/ tools/publish/internal/words.txt .git/config; do
  printf '%s\n' "$entry" >"$T/bad"
  "$PUB/export" --list --allowlist "$T/bad" >/dev/null 2>&1
  check_eq "naming $entry is refused (exit 2)" "$?" "2"
done
printf 'docs/\ntools/\nevals\n' >"$T/broad"
"$PUB/export" --list --allowlist "$T/broad" >/dev/null 2>&1
check_eq "naming evals without its slash is refused" "$?" "2"
printf 'docs/\ntools/\nsrc/\n' >"$T/broad"
check_eq "a folder above a never-public path leaves that path out" \
  "$("$PUB/export" --list --allowlist "$T/broad" | grep -cE '^(evals/|docs/plans/|tools/publish/internal/)' || true)" "0"

# A bad entry is refused.
for entry in '/abs' '../up' 'a//b' 'src/*' 'a b' '"q"' './x'; do
  printf '%s\nREADME.md\n' "$entry" >"$T/bad"
  "$PUB/export" --list --allowlist "$T/bad" >/dev/null 2>&1
  check_eq "the entry $entry is refused" "$?" "2"
done
: >"$T/empty"
"$PUB/export" --list --allowlist "$T/empty" >/dev/null 2>&1
check_eq "an allowlist that lists nothing is refused" "$?" "2"
"$PUB/export" --list nonexistent-ref >/dev/null 2>&1
check_eq "an unknown commit is refused" "$?" "2"

# A submodule is never exported.
git update-index --add --cacheinfo 160000,"$(git rev-parse HEAD)",src/sub
git commit -q -m "a submodule entry"
"$PUB/export" --tree >/dev/null 2>&1
check_eq "a submodule on the allowlist stops the export" "$?" "2"

# This repository's own export, with the allowlist beside this test: its operating scripts (docs/ops/) are left out, and the scan,
# with the full word list, passes the exported tree. Read through a scratch repository that borrows this one's objects, so nothing
# is written into it. Skipped (and said so) where this is not a clone with the word list.
if objs=$(git -C "$ROOT" rev-parse --path-format=absolute --git-path objects 2>/dev/null) && [ -f "$ROOT/tools/publish/internal/words.txt" ]; then
  git init -q --bare "$T/self.git"
  printf '%s\n' "$objs" >"$T/self.git/objects/info/alternates"
  self=$(git -C "$ROOT" rev-parse HEAD)
  list=$(GIT_DIR=$T/self.git "$PUB/export" --list --allowlist "$PUB/allowlist" "$self")
  check "this repository's export lists files" test -n "$list"
  check_eq "this repository's export holds nothing under docs/ops/" "$(grep -c '^docs/ops/' <<<"$list" || true)" "0"
  check "...though the rest of docs/ is in it" grep -q '^docs/' <<<"$list"
  tree=$(GIT_DIR=$T/self.git "$PUB/export" --tree --allowlist "$PUB/allowlist" "$self")
  out=$(GIT_DIR=$T/self.git "$PUB/scan" --words "$ROOT/tools/publish/internal/words.txt" tree "$tree" 2>&1)
  check_eq "the scan of this repository's export: exit 0" "$?" "0"
  [ -z "$out" ] || printf '      %s\n' "$out" | head -20
else
  echo "skip  this repository's export (not a clone with tools/publish/internal/words.txt)"
fi

done_tests
