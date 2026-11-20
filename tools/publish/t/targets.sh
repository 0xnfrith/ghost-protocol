#!/usr/bin/env bash
# Two targets from one clone, as the publish workflow runs them: a staging copy that already has history, and a public repository
# that starts empty. Each is published on its own: one that fails is left as it was, does not stop the other, and is brought up to
# date by the next run. The first publish into the empty one is a single commit with no history that holds LICENSE.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# A stand-in scan that passes (the real scan has its own tests).
printf '#!/bin/sh\nexit 0\n' >"$T/scan"
chmod +x "$T/scan"
pub() { "$PUB/publish" --scan "$T/scan" --apply "$@" >>"$T/out" 2>&1; }
count() { git -C "$1" rev-list --count main; }
head_of() { git -C "$1" rev-parse --verify --quiet main || echo none; }
refuse_pushes() { printf '#!/bin/sh\nexit 1\n' >"$1/hooks/pre-receive"; chmod +x "$1/hooks/pre-receive"; }
take_pushes() { rm -f "$1/hooks/pre-receive"; }

R=$T/repo
mk_repo "$R"
commit "$R" "Start"
cd "$R" || exit 1
STAGING=$T/staging.git
PUBLIC=$T/public.git
git init -q -b main --bare "$STAGING"
git init -q -b main --bare "$PUBLIC"

# The staging copy has had two publishes before the public repository exists.
pub "$STAGING"
printf 'a2\n' >src/a.txt && commit "$R" "Change src (#1)"
pub "$STAGING"
check_eq "staging: two commits before the public one starts" "$(count "$STAGING")" "2"

# One more internal merge, then a run with both targets: staging gets one commit on top of its own; the empty public repository
# gets the one first commit, with no history, holding LICENSE, the same tree as staging's new head.
printf 'readme 2\n' >README.md && commit "$R" "Change the README (#2)"
pub "$STAGING"
check_eq "both: staging, exit 0" "$?" "0"
pub "$PUBLIC"
check_eq "both: public, exit 0" "$?" "0"
check_eq "staging: one commit more" "$(count "$STAGING")" "3"
check_eq "public: one commit" "$(count "$PUBLIC")" "1"
check_eq "public: no parent" "$(git -C "$PUBLIC" rev-list --parents -n1 main | wc -w | tr -d ' ')" "1"
check "public: the first commit holds LICENSE" git -C "$PUBLIC" cat-file -e main:LICENSE
check_eq "public: the first commit's message" "$(git -C "$PUBLIC" log -1 --format=%B main)" "First public commit"
check_eq "public and staging: the same tree" "$(git -C "$PUBLIC" rev-parse 'main^{tree}')" "$(git -C "$STAGING" rev-parse 'main^{tree}')"
check_eq "public: the tree is the export of the internal head" "$(git -C "$PUBLIC" rev-parse 'main^{tree}')" "$("$PUB/export" --tree HEAD)"

# The public push fails (its credential expired, say): the public repository is left as it was, staging still goes on.
printf 'a3\n' >src/a.txt && commit "$R" "Change src again (#3)"
refuse_pushes "$PUBLIC"
before=$(head_of "$PUBLIC")
pub "$STAGING"
check_eq "public refuses: staging still published, exit 0" "$?" "0"
pub "$PUBLIC"
check_eq "public refuses: public fails (exit 2)" "$?" "2"
check_eq "public refuses: public head unchanged" "$(head_of "$PUBLIC")" "$before"
check_eq "public refuses: staging has the new commit" "$(count "$STAGING")" "4"

# The next run, with the public push working again: public catches up from its own head; staging has nothing to do.
take_pushes "$PUBLIC"
pub "$STAGING"
check_eq "next run: staging, exit 0" "$?" "0"
check_eq "next run: staging unchanged" "$(count "$STAGING")" "4"
pub "$PUBLIC"
check_eq "next run: public, exit 0" "$?" "0"
check_eq "next run: public has its second commit" "$(count "$PUBLIC")" "2"
check_eq "next run: on top of its own first commit" "$(git -C "$PUBLIC" rev-parse main^)" "$before"
check_eq "next run: its subject" "$(git -C "$PUBLIC" log -1 --format=%s main)" "Change src again"

# The other way round: staging refuses for two merges, public goes on; the run after brings staging up, one commit per merge.
refuse_pushes "$STAGING"
sbefore=$(head_of "$STAGING")
for i in 4 5; do
  printf 'a%s\n' "$i" >src/a.txt && commit "$R" "Merge $i (#$i)"
  pub "$STAGING"
  check_eq "staging refuses ($i): staging fails (exit 2)" "$?" "2"
  pub "$PUBLIC"
  check_eq "staging refuses ($i): public still published" "$?" "0"
done
check_eq "staging refuses: staging head unchanged" "$(head_of "$STAGING")" "$sbefore"
check_eq "staging refuses: public has both merges" "$(count "$PUBLIC")" "4"
take_pushes "$STAGING"
pub "$STAGING"
check_eq "staging back: exit 0" "$?" "0"
check_eq "staging back: one commit per merge it missed" "$(count "$STAGING")" "6"
check_eq "staging back: same tree as public" "$(git -C "$STAGING" rev-parse 'main^{tree}')" "$(git -C "$PUBLIC" rev-parse 'main^{tree}')"

# A public repository that was not created empty (a README, a licence or a .gitignore from the host) is not an export: it is
# refused and left untouched, never forced. It has to be created empty.
NOTEMPTY=$T/not-empty.git
git init -q -b main --bare "$NOTEMPTY"
w=$T/w && git init -q -b main "$w" && printf 'hello\n' >"$w/README.md" && git -C "$w" add -A && git -C "$w" commit -q -m "Initial commit" &&
  git -C "$w" push -q "$NOTEMPTY" main
nbefore=$(head_of "$NOTEMPTY")
pub "$NOTEMPTY"
check_eq "a target created with a file: refused (exit 2)" "$?" "2"
check_eq "a target created with a file: untouched" "$(head_of "$NOTEMPTY")" "$nbefore"
check "a target created with a file: says why" grep -q "is not an export of any commit" "$T/out"

done_tests
