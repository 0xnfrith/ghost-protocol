#!/usr/bin/env bash
# publish: against local bare repositories, with a stand-in scan (the real scan has its own tests). One public commit per internal
# commit that changes something public, by the bot, with the subject only, and never a force.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# A stand-in scan: logs its arguments and fails when $T/scan-fails exists, or when it is given a commit that holds the planted word;
# when $T/race-into names a repository, it pushes a commit there on its first call (a target that moves while the publish runs).
PLANTED=zzplant""edzz
cat >"$T/scan" <<STUB
#!/usr/bin/env bash
echo "\$*" >>"$T/scan-calls"
if [ "\$1" = commit ] && git cat-file commit "\$2" | grep -q "$PLANTED"; then exit 1; fi
if [ -f "$T/race-into" ] && [ ! -f "$T/raced" ]; then
  touch "$T/raced"
  unset GIT_DIR
  w=\$(mktemp -d) && git clone -q "\$(cat "$T/race-into")" "\$w" && git -C "\$w" commit -q --allow-empty -m "someone else" && git -C "\$w" push -q origin HEAD:main
fi
[ ! -f "$T/scan-fails" ]
STUB
chmod +x "$T/scan"
pub() { "$PUB/publish" --scan "$T/scan" "$@"; }

R=$T/repo
mk_repo "$R"
commit "$R" "Start"
cd "$R" || exit 1
git init -q -b main --bare "$T/target.git"
TARGET=$T/target.git

# A dry run changes nothing.
out=$(pub "$TARGET" 2>&1)
check_eq "dry run: says it is a dry run" "$(grep -c 'dry run' <<<"$out")" "1"
check_eq "dry run: the target stays empty" "$(git -C "$TARGET" for-each-ref | wc -l | tr -d ' ')" "0"

# Without a scan, nothing is published.
"$PUB/publish" --scan "$T/no-such-scan" "$TARGET" >/dev/null 2>&1
check_eq "no scan: refused (exit 2)" "$?" "2"

# The first publish: one commit, no history, the export, the bot.
pub --apply "$TARGET" >"$T/out" 2>&1
check_eq "first publish: exit 0" "$?" "0"
check_eq "first publish: one commit" "$(git -C "$TARGET" rev-list --count main)" "1"
check_eq "first publish: its tree is the export" "$(git -C "$TARGET" rev-parse 'main^{tree}')" "$("$PUB/export" --tree HEAD)"
check_eq "first publish: no parent" "$(git -C "$TARGET" rev-list --parents -n1 main | wc -w | tr -d ' ')" "1"
check_eq "first publish: author and committer are the bot" \
  "$(git -C "$TARGET" log -1 --format='%an <%ae> | %cn <%ce>' main)" "GP Publisher <$BOT_EMAIL> | GP Publisher <$BOT_EMAIL>"
check_eq "first publish: the message is neutral" "$(git -C "$TARGET" log -1 --format=%B main)" "First public commit"
check_eq "first publish: nothing of the internal-only paths" \
  "$(git -C "$TARGET" ls-tree -r --name-only main | grep -cE '^(evals/|docs/plans/|notes.txt|tools/private-note|tools/publish/internal/)' || true)" "0"
check "the scan saw the first tree" grep -q '^tree ' "$T/scan-calls"
check "the scan saw the public commit, strict" grep -q "^commit .* --public --allow-email $BOT_EMAIL" "$T/scan-calls"

# Internal merges: a change to src (with a body and trailers, and a PR number in the subject), a change to a file that is not
# public, a change to the README, and one that touches both.
printf 'a2\n' >"$R/src/a.txt"
git -C "$R" add -A
git -C "$R" commit -q -m "Change src (#34)" -m "A longer explanation.

Co-Authored-By: Someone <someone@example.com>
Signed-off-by: Other <other@example.com>
Internal-Note: $PLANTED"
printf 'n2\n' >"$R/notes.txt"
commit "$R" "Only notes (#35)"
printf 'r2\n' >"$R/README.md"
commit "$R" "Readme again (#36)"
printf 'r3\n' >"$R/README.md"
printf 'n3\n' >"$R/notes.txt"
commit "$R" "Both"
before=$(git -C "$TARGET" rev-parse main)
out=$(pub --apply "$TARGET" 2>&1)
check_eq "later publish: exit 0 (a trailer with a word the scan stops is never scanned)" "$?" "0"
check_eq "later publish: the scan reads no commit but the public ones" "$(grep '^commit ' "$T/scan-calls" | grep -cv -- "--public --allow-email $BOT_EMAIL" || true)" "0"
check_eq "later publish: three new commits (the notes-only one is skipped)" "$(git -C "$TARGET" rev-list --count main)" "4"
check_eq "later publish: it says one was skipped" "$(grep -c '1 internal commit(s) skipped' <<<"$out")" "1"
check_eq "later publish: it builds on the old head" "$(git -C "$TARGET" rev-parse "main~3")" "$before"
check_eq "later publish: the subjects, without the PR numbers" "$(git -C "$TARGET" log --format=%s -n3 main)" "Both
Readme again
Change src"
check_eq "later publish: the whole message is the subject (no body, no trailer)" "$(git -C "$TARGET" log --format=%B main~2 -n1)" "Change src"
check_eq "later publish: nobody but the bot, in any commit" "$(git -C "$TARGET" log --format='%an %ae %cn %ce' | sort -u)" "GP Publisher $BOT_EMAIL GP Publisher $BOT_EMAIL"
check_eq "later publish: the head's tree is the export of the head" "$(git -C "$TARGET" rev-parse 'main^{tree}')" "$("$PUB/export" --tree HEAD)"
check_eq "later publish: author date is the internal commit's" "$(git -C "$TARGET" log -1 --format=%aI main~2)" "$(git log -1 --format=%aI HEAD~2)"
check_eq "later publish: no ref but main" "$(git -C "$TARGET" for-each-ref --format='%(refname)')" "refs/heads/main"

# Run again: nothing to do.
out=$(pub --apply "$TARGET" 2>&1)
check_eq "again: nothing to publish" "$(grep -c 'nothing to publish' <<<"$out")" "1"
check_eq "again: the target is unchanged" "$(git -C "$TARGET" rev-list --count main)" "4"

# Only non-public changes: nothing new, no empty commit.
printf 'n4\n' >"$R/notes.txt"
printf 'e\n' >"$R/evals/case.txt"
commit "$R" "Not public"
out=$(pub --apply "$TARGET" 2>&1)
check_eq "non-public change: nothing to publish" "$(grep -c 'nothing to publish' <<<"$out")" "1"

# A scan that fails stops everything: the target does not move.
printf 'a3\n' >"$R/src/a.txt"
commit "$R" "More src (#40)"
touch "$T/scan-fails"
head_before=$(git -C "$TARGET" rev-parse main)
pub --apply "$TARGET" >/dev/null 2>&1
check_eq "a failing scan: exit 2" "$?" "2"
check_eq "a failing scan: nothing is pushed" "$(git -C "$TARGET" rev-parse main)" "$head_before"
rm "$T/scan-fails"

# An internal pull request number left in the subject after the cut, in the merge's own forms, is refused: a number after a #
# alone in brackets anywhere else (as in a revert's subject), and a merge subject, in any case, with U+266F for the # too; so is
# U+266F used as a # before a number. Each on its own, on top of the commit above (not yet published), so nothing is pushed.
for s in 'Revert "Fix the thing (#77)"' 'Revert "Fix the thing (#77)" (#78)' 'Fix (#77) and more' 'Two numbers (#77) (#78)' \
  'Spaced ( # 77 ) number' 'Merge pull request #77 from someone/branch' 'merge Pull  Request #77' \
  'Merge pull-request #3' 'MERGE PULL-REQUEST #3' 'Merge PR #3' 'merge pr #3 from a/b' 'MERGE PR #3' \
  "Fix ($(uni '\u266f')77) more" "Merge PR $(uni '\u266f')3" "a $(uni '\u266f')12 tune" "Fix [$(uni '\u266f')12] now" \
  "issue $(uni '\u200b\u266f')12" "issue $(uni '\u266f')#12"; do
  printf 'a4\n' >"$R/src/a.txt"
  commit "$R" "$s"
  out=$(pub --apply "$TARGET" 2>&1)
  check_eq "an internal pull request number, '$s': refused" "$?" "2"
  check_eq "...for that reason" "$(grep -c 'still holds an internal pull request number' <<<"$out")" "1"
  check_eq "...nothing is pushed" "$(git -C "$TARGET" rev-parse main)" "$head_before"
  git -C "$R" reset -q --hard HEAD~1
  git -C "$TARGET" update-ref refs/heads/main "$head_before" # should one get through, the target is put back after it
done
# The stop names the way past it, and the way works: a line with the commit's full id and a public subject in
# tools/publish/internal/subjects, merged after it, gives it that subject (made as any other: its # before a number taken out);
# the commit that adds the line changes nothing public and is skipped.
printf 'a4\n' >"$R/src/a.txt"
commit "$R" 'Revert "Fix the thing (#77)" (#78)'
stuck=$(git -C "$R" rev-parse HEAD)
out=$(pub --apply "$TARGET" 2>&1)
check_eq "a revert's subject: refused (exit 2)" "$?" "2"
check "...the stop names the way past it" grep -qF "The way past: give that commit a public subject, a line \"$stuck <the public subject>\" in tools/publish/internal/subjects, merged to main" <<<"$out"
printf '# given by hand\n\n%s Revert the fix of #77\n' "$stuck" >"$R/tools/publish/internal/subjects"
commit "$R" "Give the revert a public subject (#79)"
out=$(pub "$TARGET" 2>&1)
check_eq "the way past: published (exit 0)" "$?" "0"
check_eq "...the stuck commit with the given subject, the line's own commit skipped" \
  "$(sed -n 's/^  [0-9a-f]\{4,\} //p' <<<"$out")" "More src
Revert the fix of 77"
check_eq "...it says one was skipped" "$(grep -c '1 internal commit(s) skipped' <<<"$out")" "1"
printf 'not a line\n' >"$R/tools/publish/internal/subjects"
commit "$R" "A bad line"
out=$(pub "$TARGET" 2>&1)
check_eq "a subjects file with a bad line: refused (exit 2)" "$?" "2"
check "...said so" grep -qF 'line 1 of tools/publish/internal/subjects is not' <<<"$out"
git -C "$R" reset -q --hard HEAD~3
# A # before a number at the start of a word would link in the public repository: the # is taken out, in the ways the scan reads
# one (full-width, after an invisible character), in square brackets and in a list too. A # after a letter stays, as does
# U+266F after one. A dry run, so the target stays as it is for the
# tests below.
for w in 'follow-up to #149|follow-up to 149' 'Fix the thing from #77|Fix the thing from 77' 'fix issue #12 in docs|fix issue 12 in docs' \
  'issue #12 (#40)|issue 12' '#12 first|12 first' 'notes on C#9|notes on C#9' 'see ##12|see 12' 'C#9 and #10|C#9 and 10' \
  "issue $(uni '\uff03\uff11\uff12')|issue $(uni '\uff11\uff12')" "issue $(uni '\u200b')#12|issue $(uni '\u200b')12" \
  'Change (#a) and (12)|Change (#a) and (12)' 'Fix [#12] now|Fix [12] now' 'Fix both (#12, #13)|Fix both (12, 13)' \
  'Fix both (#12, #13) (#14)|Fix both (12, 13)' "Fix $(uni '\uff3b#12\uff3d')|Fix $(uni '\uff3b12\uff3d')" \
  "a C$(uni '\u266f')9 chord|a C$(uni '\u266f')9 chord"; do
  s=${w%%|*} want=${w#*|}
  printf 'a4\n' >"$R/src/a.txt"
  commit "$R" "$s"
  out=$(pub "$TARGET" 2>&1)
  check_eq "a # before a number, '$s': published (exit 0)" "$?" "0"
  check_eq "...as '$want'" "$(sed -n 's/^  [0-9a-f]\{4,\} //p' <<<"$out" | tail -n 1)" "$want"
  git -C "$R" reset -q --hard HEAD~1
done
# A subject of two lines (git joins them): the # is taken out the same way in the joined subject and in its lines.
printf 'a4\n' >"$R/src/a.txt"
commit "$R" "Change a
see #12 here (#19)"
out=$(pub "$TARGET" 2>&1)
check_eq "a # before a number on a subject's second line: published (exit 0)" "$?" "0"
check_eq "...as 'Change a see 12 here'" "$(sed -n 's/^  [0-9a-f]\{4,\} //p' <<<"$out" | tail -n 1)" "Change a see 12 here"
git -C "$R" reset -q --hard HEAD~1

# The target is not a copy of this history: refused, and not touched.
git init -q -b main --bare "$T/other.git"
w=$T/w1
git init -q -b main "$w"
printf 'x\n' >"$w/x"
git -C "$w" add -A
git -C "$w" commit -q -m "unrelated"
git -C "$w" push -q "$T/other.git" HEAD:main
other_before=$(git -C "$T/other.git" rev-parse main)
pub --apply "$T/other.git" >/dev/null 2>&1
check_eq "a target that is not a copy: refused (exit 2)" "$?" "2"
check_eq "a target that is not a copy: not touched" "$(git -C "$T/other.git" rev-parse main)" "$other_before"

# The first commit must hold LICENSE.
mk_repo "$T/nolicence"
rm "$T/nolicence/LICENSE"
commit "$T/nolicence" "No licence"
git init -q -b main --bare "$T/t3.git"
(cd "$T/nolicence" && pub --apply "$T/t3.git" >/dev/null 2>&1)
check_eq "no LICENSE in the first commit: refused" "$?" "2"
check_eq "no LICENSE: nothing is pushed" "$(git -C "$T/t3.git" for-each-ref | wc -l | tr -d ' ')" "0"

# The bot must be a noreply address.
GP_PUBLISH_EMAIL=bot@example.com pub --apply "$T/t3.git" >/dev/null 2>&1
check_eq "a bot with a real address: refused" "$?" "2"
GP_PUBLISH_NAME="Bot Two" GP_PUBLISH_EMAIL="bot2@users.""noreply.github.com" pub --apply "$TARGET" >/dev/null 2>&1
check_eq "another noreply bot is accepted (nothing new to publish)" "$?" "0"

# A target that moves while the publish runs: the plain push is refused, and the other commit stays.
printf 'a5\n' >"$R/src/a.txt"
commit "$R" "Racing (#41)"
git init -q -b main --bare "$T/race.git"
pub --apply "$T/race.git" >/dev/null 2>&1
printf '%s\n' "$T/race.git" >"$T/race-into"
printf 'a6\n' >"$R/src/a.txt"
commit "$R" "Racing two (#42)"
pub --apply "$T/race.git" >/dev/null 2>&1
check_eq "a target that moved meanwhile: the push is refused (exit 2)" "$?" "2"
check_eq "a target that moved meanwhile: the other commit stays" "$(git -C "$T/race.git" log -1 --format=%s main)" "someone else"

done_tests
