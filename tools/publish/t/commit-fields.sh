#!/usr/bin/env bash
# The commit fields, with the real scan: what is scanned of a commit is exactly what goes public of it, the cut subject and the
# public commit's own author and committer (the bot).
#   1. the public commit carries no body and no trailer, only the cut subject, so the scan of it cannot drift from what is published;
#   2. a body or a trailer (any trailer) with an internal word, which is never published, does not stop a publish; nor does the
#      internal commit's own author or committer;
#   3. the same word in the subject, in the public author or in the public committer still stops it; and a rule tied to a line
#      (^, $, a line break) still sees a subject that git joined from several lines, each line as it was written;
#   4. the one-line check alone: a publish that would build a public message of more than one line is refused, even with a scan
#      that passes everything.
# Then the revert proofs: copies of tools/publish with one piece put back the way it would be without it, one at a time; these
# checks are run against each copy (PUBLISH_TREE) and must fail on every one.
# The revert proofs are sed programs and an eval, in single quotes by design (SC2016).
# shellcheck disable=SC2016
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${BASH_SOURCE[0]##*/}

LEAK=zzleakzz
HOST="zz-internal.""test"
# Rules tied to a line: the start of one, the end of one, and a line break.
ANC=zzanch""orzz
printf '%s[a-z]*\n@%s\n^%ss\n%se$\n%sx\\n%sy\n' "$LEAK" "$HOST" "$ANC" "$ANC" "$ANC" "$ANC" >"$T/words"
pub() { "$PUB/publish" --words "$T/words" "$@"; }

R=$T/repo
mk_repo "$R"
commit "$R" "Start"
cd "$R" || exit 1
git init -q -b main --bare "$T/target.git"
TARGET=$T/target.git
state() { git -C "$TARGET" for-each-ref --format='%(refname) %(objectname)'; }
pub --apply "$TARGET" >/dev/null 2>&1
check_eq "a clean first publish goes through" "$?" "0"
n=0
change() { n=$((n + 1)); printf 'change %s\n' "$n" >"$R/src/a.txt"; git -C "$R" add -A; }
leaks_in_target() { git -C "$TARGET" cat-file --batch-all-objects --batch | grep -c -a -e "$LEAK" -e "$HOST" || true; }

# 1. Only the cut subject goes public, however much the internal message holds.
change
git -C "$R" commit -q -m "Change src (#12)" -m "A body, with lines.
And another one." -m "Co-authored-by: Someone <someone@example.com>
Signed-off-by: Other <other@example.com>
Reviewed-by: Third <third@example.com>
Any-Trailer: a value"
pub --apply "$TARGET" >/dev/null 2>&1
check_eq "1. a commit with a body and trailers is published" "$?" "0"
raw=$(git -C "$TARGET" cat-file commit main)
check_eq "1. the public commit's message is the cut subject and nothing else" "$(sed '1,/^$/d' <<<"$raw")" "Change src"
check_eq "1. the public commit's headers are tree, parent, author and committer only" \
  "$(sed '/^$/,$d' <<<"$raw" | cut -d' ' -f1 | tr '\n' ' ')" "tree parent author committer "
check_eq "1. its author and committer are the bot" \
  "$(git -C "$TARGET" log -1 --format='%an <%ae> | %cn <%ce>' main)" "GP Publisher <$BOT_EMAIL> | GP Publisher <$BOT_EMAIL>"
check_eq "1. nothing of the body or the trailers is in the target" \
  "$(git -C "$TARGET" cat-file --batch-all-objects --batch | grep -c -a -e 'A body' -e 'another one' -e 'Co-authored' -e 'Signed-off' -e 'Reviewed-by' -e 'Any-Trailer' -e 'someone@' || true)" "0"

# 2. What is never published never stops a publish.
goes() { # label  (the caller stages a change and commits it): the publish goes through and the target holds no leak
  local before
  before=$(git -C "$TARGET" rev-list --count main)
  pub --apply "$TARGET" >/dev/null 2>&1
  check_eq "2. $1: the publish goes through" "$?" "0"
  check_eq "2. $1: as one more public commit" "$(git -C "$TARGET" rev-list --count main)" "$((before + 1))"
  check_eq "2. $1: the target holds no internal word" "$(leaks_in_target)" "0"
}
change
git -C "$R" commit -q -m "A body (#13)" -m "This was for ${LEAK}q."
goes "an internal word in the body"
for trailer in "Co-authored-by: Someone <someone@${HOST}>" "Co-authored-by: ${LEAK}-agent <noreply@example.com>" \
  "Signed-off-by: ${LEAK}x <a@example.com>" "Reviewed-by: R <r@${HOST}>" "Internal-Ref: ${LEAK}-77"; do
  change
  git -C "$R" commit -q -m "A trailer (#14)" -m "$trailer"
  goes "a trailer with an internal word (${trailer%%:*})"
done
change
GIT_AUTHOR_NAME="${LEAK}a" GIT_AUTHOR_EMAIL="dev@${HOST}" GIT_COMMITTER_NAME="${LEAK}c" GIT_COMMITTER_EMAIL="ci@${HOST}" \
  git -C "$R" commit -q -m "An internal author and committer (#15)"
goes "an internal word in the internal commit's author and committer"

# 3. What is published still stops it, and the log never holds the word.
stops() { # label: the publish of the staged-and-committed change stops; then the commit is taken back off
  local out rc base
  base=$(state)
  out=$(pub --apply "$TARGET" 2>&1)
  rc=$?
  check_eq "3. $1: the publish stops (exit 2)" "$rc" "2"
  check_eq "3. $1: the target did not move" "$(state)" "$base"
  check_eq "3. $1: the scan stopped it" "$(grep -c 'the scan stopped the publish' <<<"$out" || true)" "1"
  check_eq "3. $1: the log does not hold the word" "$(grep -c -e "$LEAK" -e "$HOST" -e "$ANC" <<<"$out" || true)" "0"
  git -C "$R" reset -q --hard HEAD~1
}
change
git -C "$R" commit -q -m "Change ${LEAK}q (#16)"
stops "an internal word in the subject"
change
git -C "$R" commit -q -m "Change a
Co-authored-by: X <x@${HOST}>"
stops "a trailer with no blank line before it (git makes it part of the subject)"
change
git -C "$R" commit -q -m "Change a (#17)"
GP_PUBLISH_NAME="${LEAK} Bot" stops "an internal word in the bot's name (the public author and committer)"
# A subject of several lines (no blank line between them): git joins them with spaces, and the rules tied to a line still see them.
change
git -C "$R" commit -q -m "Change a
${ANC}s more (#18)"
stops "a rule tied to the start of a line, on the subject's second line"
change
git -C "$R" commit -q -m "Change ${ANC}e
more"
stops "a rule tied to the end of a line, on the subject's first line"
change
git -C "$R" commit -q -m "Change ${ANC}x
${ANC}y"
stops "a rule across a line break in the subject"
change
git -C "$R" commit -q -m "Change a ${ANC}s ${ANC}e ${ANC}x ${ANC}y more"
goes "the same words not at a line's edge (the rules are tied to lines)"
change
git -C "$R" commit -q -m "Change a
  and more  (#19)"
goes "a clean subject of two lines"
check_eq "3. a subject of two lines: published joined, with the (#n) cut" "$(git -C "$TARGET" log -1 --format=%B main)" "Change a   and more"
# The public author and the public committer, each alone: a commit shaped as publish makes them, read by the scan publish runs.
pubc() { # author-name committer-name: a public-shaped commit; prints its id
  GIT_AUTHOR_NAME=$1 GIT_AUTHOR_EMAIL=$BOT_EMAIL GIT_COMMITTER_NAME=$2 GIT_COMMITTER_EMAIL=$BOT_EMAIL \
    git -C "$R" commit-tree -m "A subject" "HEAD^{tree}"
}
pscan() { "$PUB/scan" --words "$T/words" commit "$1" --public --allow-email "$BOT_EMAIL"; }
c=$(pubc "GP Publisher" "GP Publisher")
pscan "$c" >/dev/null 2>&1
check_eq "3. the public scan passes the bot's own commit" "$?" "0"
c=$(pubc "GP ${LEAK}" "GP Publisher")
out=$(pscan "$c" 2>&1)
check_eq "3. an internal word in the public author alone: the scan stops it" "$?" "1"
check_eq "3. ...named at the author" "$(grep -c ' author: internal-word' <<<"$out" || true)" "1"
c=$(pubc "GP Publisher" "GP ${LEAK}")
out=$(pscan "$c" 2>&1)
check_eq "3. an internal word in the public committer alone: the scan stops it" "$?" "1"
check_eq "3. ...named at the committer" "$(grep -c ' committer: internal-word' <<<"$out" || true)" "1"

# 4. The one-line check alone: a copy of publish that builds the public message from the whole internal message (and does not
# scan the subject line by line), with a scan that passes everything, must still be refused by the check on the made commit.
WHOLE='s/^    subject=\$(subject_of "\$c")$/    subject=$(G log -1 --format=%B "$c")/'
printf '#!/bin/sh\nexit 0\n' >"$T/pass-scan"
chmod +x "$T/pass-scan"
rm -rf "$T/wide" && cp -R "$PUB" "$T/wide"
sed -e "$WHOLE" -e '/^  \$first || subject_lines /d' "$PUB/publish" >"$T/wide/publish"
check "4. the copy builds the message from the whole internal message" grep -q 'format=%B' "$T/wide/publish"
check_not "4. the copy does not scan the subject line by line" grep -q '|| subject_lines ' "$T/wide/publish"
change
git -C "$R" commit -q -m "Wide (#20)" -m "A body with ${LEAK}q." -m "Co-authored-by: X <x@${HOST}>"
base=$(state)
out=$("$T/wide/publish" --scan "$T/pass-scan" --apply "$TARGET" 2>&1)
check_eq "4. a public message of more than one line, a scan that passes all: refused (exit 2)" "$?" "2"
check_eq "4. ...by the one-line check" "$(grep -c 'has a message of more than one line' <<<"$out" || true)" "1"
check_eq "4. ...and the target did not move" "$(state)" "$base"
check_eq "4. ...and holds no internal word" "$(leaks_in_target)" "0"
git -C "$R" reset -q --hard HEAD~1

# --- the revert proofs ---
if [ -z "${PUBLISH_TREE:-}" ]; then
  mutant() { # what file sed-program...: a copy of tools/publish with the programs applied to file (which must change it)
    local what=$1 f=$2 copy=$T/mutant
    shift 2
    rm -rf "$copy" && cp -R "$ROOT/tools/publish" "$copy"
    sed "${@/#/-e}" "$ROOT/tools/publish/$f" >"$copy/$f" && chmod +x "$copy/$f"
    if cmp -s "$ROOT/tools/publish/$f" "$copy/$f"; then check "revert proof ($what): the change applies" false; return; fi
    local rc=0
    PUBLISH_TREE=$copy "$SELF" >"$T/mutant.log" 2>&1 || rc=$?
    # It must fail on a check of its own, not by not running.
    check "revert proof: with $what, these checks fail" eval '[ "$rc" != 0 ] && grep -q "^FAIL  [0-9]\." "$T/mutant.log"'
    grep '^FAIL' "$T/mutant.log" | head -n 3 | sed 's/^FAIL  /        it fails: /'
  }
  body='s/^    subject=\$(subject_of "\$c")$/    subject=$(G log -1 --format=%B "$c")/'
  mutant "the whole internal message in the public commit" publish "$body"
  mutant "the whole message, and the public scan not strict" publish "$body" 's/ --public --allow-email "\$bot_email"//'
  mutant "the whole message, no strict scan and no one-line check" publish "$body" 's/ --public --allow-email "\$bot_email"//' \
    '/^  one_line "\$new" || die /d'
  mutant "no one-line check of the made commit" publish '/^  one_line "\$new" || die /d'
  mutant "the old check: the message against the subject it was built from" publish \
    's#^  one_line "\$new" || die #  [ "$(G cat-file commit "$new" | sed '"'"'1,/^$/d'"'"')" = "$subject" ] || die #'
  mutant "no scan of the subject line by line" publish '/^  \$first || subject_lines /d'
  mutant "the subject's lines scanned joined" publish 's/^  id=\$(make_commit "\$3" "" "\$lines" "\$4")$/  id=$(make_commit "$3" "" "$2" "$4")/'
  mutant "the subject's (#n) kept" scan 's/^    m = END_NUMBER.match(text)$/    m = None/'
  mutant "the old scan of the internal commit's fields" publish \
    's/^    subject=\$(subject_of "\$c")$/&\n    run_scan commit "$c" || die "the scan stopped the publish (the fields)"/'
  mutant "no scan of the public commit" publish 's/^  run_scan commit "\$new".*$/  :/'
  mutant "the public scan without the message" scan 's/^    scan_text(hits, lambda l: "commit %s message:%d".*$/    pass/'
  mutant "the public scan without the author" scan 's/^    for line in head.split("\\n"):$/    for line in [x for x in head.split("\\n") if not x.startswith("author ")]:/'
  mutant "the public scan without the committer" scan 's/^    for line in head.split("\\n"):$/    for line in [x for x in head.split("\\n") if not x.startswith("committer ")]:/'
fi

done_tests
