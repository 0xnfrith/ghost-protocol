#!/usr/bin/env bash
# scan: what it finds, where it says so, and what it never says.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SCAN=$PUB/scan
LEAK=zzleakzz
HOST="zz-internal.""test"
printf '# test words\n%s[a-z]*\ncs:CaseSensitiveWord\n@%s\n' "$LEAK" "$HOST" >"$T/words"

R=$T/repo
git init -q -b main "$R"
cd "$R" || exit 1
mkdir src
printf 'nothing here\n' >src/clean.txt
printf 'a mail to someone@example.com and git@github.com\n' >src/ok.txt
printf '\000binary data\n' >src/blob.bin
git add -A && git commit -q -m clean
clean=$(git rev-parse 'HEAD^{tree}')
scan() { "$SCAN" --words "$T/words" "$@"; }

# A clean tree.
scan tree "$clean" >/dev/null 2>&1
check_eq "a clean tree: exit 0" "$?" "0"
check_eq "a clean binary file: nothing said" "$(scan tree "$clean" | wc -l | tr -d ' ')" "0"

# Seeded leaks in a file: each stops the scan (exit 1), names the file and line, and never shows the text.
seed() { # name content: a tree with one more file
  printf '%b' "$2" >"$R/src/seed.txt"
  git -C "$R" add -A
  git -C "$R" commit -q -m "seed $1"
  git -C "$R" rev-parse 'HEAD^{tree}'
}
try() { # label content expected-rule-fragment
  local tree out rc
  tree=$(seed "$1" "$2")
  out=$(scan tree "$tree" 2>&1)
  rc=$?
  check_eq "$1: exit 1" "$rc" "1"
  check "$1: names the file and line" grep -qE "^src/seed\.txt:2: .*$3" <<<"$out"
  check_eq "$1: the output does not hold the text" "$(grep -c -F -e "$4" <<<"$out" || true)" "0"
}
try "an internal word" "ok\nsee ${LEAK}abc here\n" "internal-word:words:2" "${LEAK}abc"
try "a case-sensitive word" "ok\nthe CaseSensitiveWord\n" "internal-word:words:3" "CaseSensitiveWord"
try "a public word, built from pieces" "ok\nhost sect""ion-9 here\n" "public-word-1" "sect""ion"
try "a tracker-style word, built from pieces" "ok\nGHO""ST-123\n" "public-word-6" "GHO""ST"
try "a 64-hex key" "ok\nkey $(printf 'ab%.0s' $(seq 32))\n" "hex64" "abababab"
try "an email address" "ok\nwrite to bob@elsewhere.""org\n" "email address" "bob@"
try "an internal mail domain" "ok\nwrite to a@$HOST\n" "internal-word:words:4" "a@"

# A file with a zero byte is read too: UTF-16 text and binary metadata carry words.
bin_tree() { # name: a tree with one more file, its bytes on stdin
  cat >"$R/src/$1"
  git -C "$R" add -A
  git -C "$R" commit -q -m "seed $1"
  git -C "$R" rev-parse 'HEAD^{tree}'
}
for enc in UTF-16LE UTF-16BE UTF-16; do
  tree=$(printf 'ok\nsee %sabc here\n' "$LEAK" | iconv -f UTF-8 -t "$enc" | bin_tree "u16.txt")
  out=$(scan tree "$tree" 2>&1)
  check_eq "$enc text with a word: exit 1" "$?" "1"
  check_eq "$enc text with a word: named by rule" "$(grep -c '^src/u16\.txt:[0-9]*: internal-word:words:2' <<<"$out" || true)" "1"
  check_eq "$enc text with a word: the output does not hold the text" "$(grep -c -F "$LEAK" <<<"$out" || true)" "0"
done
tree=$(printf '\000\001PNG\000meta\000see %s here\000\002' "$LEAK" | bin_tree "meta.bin")
out=$(scan tree "$tree" 2>&1)
check_eq "binary metadata with a word: exit 1" "$?" "1"
check_eq "binary metadata with a word: found" "$(grep -c '^src/meta\.bin:[0-9]*: internal-word:words:2' <<<"$out" || true)" "1"
rm -f "$R/src/u16.txt" "$R/src/meta.bin"

# A case-sensitive word is not matched in another case; a word is matched in any case otherwise.
tree=$(seed "case" "ok\ncasesensitiveword and ${LEAK^^}\n")
out=$(scan tree "$tree")
check_eq "case: the case-sensitive word needs its case" "$(grep -c 'words:3' <<<"$out" || true)" "0"
check_eq "case: the other words ignore case" "$(grep -c 'words:2' <<<"$out" || true)" "1"

# A path is scanned too, and a path that is never public is a hit.
rm -f "$R/src/seed.txt"
mkdir -p "$R/evals" "$R/docs/plans" "$R/tools/publish/internal"
printf 'x\n' >"$R/evals/case.txt"
printf 'x\n' >"$R/docs/plans/p.md"
printf 'x\n' >"$R/tools/publish/internal/w.txt"
printf 'x\n' >"$R/src/${LEAK}-name.txt"
printf 'text %s\n' "$LEAK" >"$R/src/${LEAK}-body.txt"
git -C "$R" add -A && git -C "$R" commit -q -m paths
tree=$(git -C "$R" rev-parse 'HEAD^{tree}')
out=$(scan tree "$tree" 2>&1)
check_eq "a path with a word: found, named by its file's id" \
  "$(grep -c "^path of the file $(git -C "$R" rev-parse --short=12 "HEAD:src/${LEAK}-name.txt"): internal-word" <<<"$out" || true)" "1"
check_eq "a path with a word: the name is not in the output" "$(grep -c -F "$LEAK" <<<"$out" || true)" "0"
# A file whose path holds a word and whose text holds one too: the log names neither the path nor the text.
check_eq "a path with a word and a hit in its text: named by its id" \
  "$(grep -c "^file $(git -C "$R" rev-parse --short=12 "HEAD:src/${LEAK}-body.txt"):1: internal-word" <<<"$out" || true)" "1"
check_eq "a path with a word and a hit in its text: the name is not in the output" "$(grep -c -F "$LEAK" <<<"$out" || true)" "0"
check_eq "evals/ is a hit" "$(grep -c '^evals/: never-public path' <<<"$out" || true)" "1"
check_eq "docs/plans/ is a hit" "$(grep -c '^docs/plans/: never-public path' <<<"$out" || true)" "1"
check_eq "the internal folder is a hit" "$(grep -c '^tools/publish/internal/: never-public path' <<<"$out" || true)" "1"

# --since looks only at what changed.
git -C "$R" rm -q -r evals docs tools "src/${LEAK}-name.txt" "src/${LEAK}-body.txt"
printf 'new ok\n' >"$R/src/new.txt"
git -C "$R" add -A && git -C "$R" commit -q -m "after"
printf 'old leak %s\n' "${LEAK}" >"$R/src/old.txt"
git -C "$R" add -A && git -C "$R" commit -q -m "old"
old_tree=$(git -C "$R" rev-parse 'HEAD^{tree}')
printf 'new ok again\n' >"$R/src/new.txt"
git -C "$R" add -A && git -C "$R" commit -q -m "newer"
new_tree=$(git -C "$R" rev-parse 'HEAD^{tree}')
scan tree "$new_tree" --since "$old_tree" >/dev/null 2>&1
check_eq "--since: an old leak that did not change is not looked at" "$?" "0"
scan tree "$new_tree" >/dev/null 2>&1
check_eq "without --since the whole tree is" "$?" "1"
printf 'now %s\n' "${LEAK}" >"$R/src/new.txt"
git -C "$R" add -A && git -C "$R" commit -q -m "leak in change"
leak_tree=$(git -C "$R" rev-parse 'HEAD^{tree}')
scan tree "$leak_tree" --since "$new_tree" >/dev/null 2>&1
check_eq "--since: a changed file with a leak is" "$?" "1"

# Commits: the raw object, headers and trailers included.
cmt() { # message... ; env: GIT_* may be set by the caller
  git -C "$R" commit -q --allow-empty "$@"
  git -C "$R" rev-parse HEAD
}
c=$(cmt -m "A clean subject" -m "Co-Authored-By: Claude <noreply@anthropic.""com>")
scan commit "$c" >/dev/null 2>&1
check_eq "a clean commit, with a co-author trailer: exit 0" "$?" "0"
c=$(cmt -m "Subject with ${LEAK}")
out=$(scan commit "$c" 2>&1)
check_eq "a word in the subject: exit 1" "$?" "1"
check_eq "a word in the subject: found at message line 1" "$(grep -c 'message:1: internal-word' <<<"$out" || true)" "1"
c=$(cmt -m "Subject" -m "Body

Co-Authored-By: Someone <someone@${HOST}>")
out=$(scan commit "$c" 2>&1)
check_eq "an internal domain in a trailer: exit 1" "$?" "1"
check_eq "a trailer leak: names a message line" "$(grep -cE 'message:[0-9]+: internal-word:words:4' <<<"$out" || true)" "1"
check_eq "a trailer leak: the output does not hold the address" "$(grep -c -F "someone@" <<<"$out" || true)" "0"
c=$(GIT_AUTHOR_EMAIL="dev@$HOST" cmt -m "Subject")
out=$(scan commit "$c" 2>&1)
check_eq "an internal domain in the author: exit 1" "$?" "1"
check_eq "an author leak: names the author header" "$(grep -c ' author: internal-word' <<<"$out" || true)" "1"
c=$(GIT_COMMITTER_NAME="${LEAK}" cmt -m "Subject")
scan commit "$c" >/dev/null 2>&1
check_eq "a word in the committer: exit 1" "$?" "1"
c=$(cmt -m "Subject" -m "key $(printf 'cd%.0s' $(seq 32))")
scan commit "$c" >/dev/null 2>&1
check_eq "a 64-hex key in a message: exit 1" "$?" "1"

# A commit that is about to be public.
BOT=$BOT_EMAIL
pubc() { GIT_AUTHOR_NAME="GP Publisher" GIT_AUTHOR_EMAIL="$BOT" GIT_COMMITTER_NAME="GP Publisher" GIT_COMMITTER_EMAIL="$BOT" cmt "$@"; }
c=$(pubc -m "A subject")
scan commit "$c" --public --allow-email "$BOT" >/dev/null 2>&1
check_eq "public: the bot and a subject only: exit 0" "$?" "0"
scan commit "$c" --public >/dev/null 2>&1
check_eq "public: the bot's address needs --allow-email" "$?" "1"
c=$(cmt -m "A subject")
scan commit "$c" --public --allow-email "$BOT" >/dev/null 2>&1
check_eq "public: another author's address: exit 1" "$?" "1"
c=$(pubc -m "A subject" -m "A body")
scan commit "$c" --public --allow-email "$BOT" >/dev/null 2>&1
check_eq "public: a body: exit 1" "$?" "1"
c=$(pubc -m "A subject" -m "Co-Authored-By: Claude <noreply@anthropic.""com>")
scan commit "$c" --public --allow-email "$BOT" >/dev/null 2>&1
check_eq "public: a trailer: exit 1" "$?" "1"
# A header that a public commit does not have (a signature, say): made by hand.
tree=$(git -C "$R" rev-parse 'HEAD^{tree}')
c=$(printf 'tree %s\nauthor GP Publisher <%s> 1700000000 +0000\ncommitter GP Publisher <%s> 1700000000 +0000\nencoding ISO-8859-1\n\nsubject\n' "$tree" "$BOT" "$BOT" | git -C "$R" hash-object -t commit -w --stdin)
scan commit "$c" --public --allow-email "$BOT" >/dev/null 2>&1
check_eq "public: an extra header: exit 1" "$?" "1"

# Usage.
(cd "$T" && mkdir noscan && cp "$SCAN" noscan/scan && cd "$R" && "$T/noscan/scan" tree "$clean" >/dev/null 2>&1)
check_eq "no word list: exit 2 (nothing is scanned without one)" "$?" "2"
"$SCAN" --public-only tree "$clean" >/dev/null 2>&1
check_eq "--public-only needs no list" "$?" "0"
"$SCAN" --public-only --words "$T/words" tree "$clean" >/dev/null 2>&1
check_eq "--public-only with --words: exit 2" "$?" "2"
printf '(unclosed\n' >"$T/badwords"
"$SCAN" --words "$T/badwords" tree "$clean" >/dev/null 2>&1
check_eq "a word line that is not a regular expression: exit 2" "$?" "2"
: >"$T/emptywords"
"$SCAN" --words "$T/emptywords" tree "$clean" >/dev/null 2>&1
check_eq "an empty word list: exit 2" "$?" "2"
scan tree no-such-tree >/dev/null 2>&1
check_eq "an unknown tree: exit 2" "$?" "2"

# The never-public paths are the same list as export's.
exp=$(sed -n 's/^NEVER=(\(.*\))$/\1/p' "$PUB/export" | tr ' ' '\n' | sort | tr '\n' ' ')
got=$(sed -n 's/^NEVER = (\(.*\))$/\1/p' "$SCAN" | tr -d '",' | tr ' ' '\n' | sort | tr '\n' ' ')
check_eq "the scan's never-public paths are export's" "$got" "$exp"

done_tests
