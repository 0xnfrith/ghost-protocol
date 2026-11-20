#!/usr/bin/env bash
# The publish with the real scan: a leak seeded in a file, the subject, a path, a key or an evals/ file each stops it, and the
# target does not move. Everything is local. (A body or a trailer is never published, so it is not scanned: see commit-fields.sh.)
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

LEAK=zzleakzz
HOST="zz-internal.""test"
printf '%s[a-z]*\n@%s\n' "$LEAK" "$HOST" >"$T/words"
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
base=$(state)
check_eq "...as one commit" "$(git -C "$TARGET" rev-list --count main)" "1"

# stops: a change, committed on top of the last published state, that must stop the publish; then it is taken back off.
stops() { # label  (the change is made by the caller, then this commits it with message $2 and optional body $3)
  local label=$1 msg=$2 body=${3:-} out rc
  if [ -n "$body" ]; then git -C "$R" add -A && git -C "$R" commit -q -m "$msg" -m "$body"; else commit "$R" "$msg"; fi
  out=$(pub --apply "$TARGET" 2>&1)
  rc=$?
  check_eq "$label: the publish stops (exit 2)" "$rc" "2"
  check_eq "$label: the target did not move" "$(state)" "$base"
  check_eq "$label: the log says the scan stopped it" "$(grep -c 'the scan stopped the publish' <<<"$out" || true)" "1"
  check_eq "$label: the log does not hold the leaked text" "$(grep -c -e "$LEAK" -e "$HOST" <<<"$out" || true)" "0"
  git -C "$R" reset -q --hard HEAD~1
}

printf 'see %sxyz\n' "$LEAK" >"$R/src/a.txt"
stops "an internal word in a file" "Change a (#1)"

printf 'fine\n' >"$R/src/a.txt"
stops "an internal word in the subject" "Change a for ${LEAK}q"

printf 'k %s\n' "$(printf 'ef%.0s' $(seq 32))" >"$R/src/a.txt"
stops "a stray key in a file" "Change a"

printf 'x\n' >"$R/src/${LEAK}.txt"
stops "an internal word in a path" "Add a file"

printf 'a mail to bob@elsewhere.%s\n' org >"$R/src/a.txt"
stops "a stray email address in a file" "Change a"

# A leak in an intermediate commit that a later commit removes is still in the history: it stops the publish too.
printf '%s\n' "$LEAK" >"$R/src/a.txt"
commit "$R" "Add a leak"
printf 'clean\n' >"$R/src/a.txt"
commit "$R" "Remove it"
out=$(pub --apply "$TARGET" 2>&1)
check_eq "a leak a later commit removed: the publish stops" "$?" "2"
check_eq "a leak a later commit removed: the target did not move" "$(state)" "$base"
git -C "$R" reset -q --hard HEAD~2

# An evals/ file: never exported, so it is not published, and an allowlist that names it stops the publish.
printf 'secret\n' >"$R/evals/new.txt"
commit "$R" "Add an eval"
out=$(pub --apply "$TARGET" 2>&1)
check_eq "an evals/ file that is not on the allowlist: nothing to publish" "$(grep -c 'nothing to publish' <<<"$out" || true)" "1"
check_eq "an evals/ file: the target did not move" "$(state)" "$base"
printf 'evals/\n' >>"$R/tools/publish/allowlist"
commit "$R" "List the evals"
pub --apply "$TARGET" >/dev/null 2>&1
check_eq "an allowlist that names evals/: the publish stops (exit 2)" "$?" "2"
check_eq "an allowlist that names evals/: the target did not move" "$(state)" "$base"
git -C "$R" reset -q --hard HEAD~2

# A leak in a file that is not public is no leak: the export never reads it.
printf '%s\n' "$LEAK" >"$R/notes.txt"
printf '%s\n' "$LEAK" >"$R/tools/publish/internal/words.txt"
commit "$R" "Notes ${LEAK#zz}"
out=$(pub --apply "$TARGET" 2>&1)
check_eq "a word only in files that are not public: nothing to publish" "$(grep -c 'nothing to publish' <<<"$out" || true)" "1"

# A clean change goes through, with the scan on.
printf 'fine\n' >"$R/src/a.txt"
commit "$R" "Change a (#9)"
pub --apply "$TARGET" >/dev/null 2>&1
check_eq "a clean change goes through" "$?" "0"
check_eq "...as one more commit" "$(git -C "$TARGET" rev-list --count main)" "2"
check_eq "...with the PR number cut" "$(git -C "$TARGET" log -1 --format=%s main)" "Change a"
check_eq "the public history holds no internal word and no internal domain" \
  "$(git -C "$TARGET" log --format='%an %ae %cn %ce %B' | grep -c -e "$LEAK" -e "$HOST" || true)" "0"
# The scan is the real one, over the whole public tree and every commit.
check "the whole public tree is clean to the real scan" env GIT_DIR="$TARGET" "$PUB/scan" --words "$T/words" tree "$(git -C "$TARGET" rev-parse 'main^{tree}')"

done_tests
