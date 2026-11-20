#!/usr/bin/env bash
# The scan reads a dash that looks like `-` as `-`: a word-list host or hyphenated word written with one in place of its `-` is still
# found, in a file, in a path and in a public commit, and stops the publish. NFKC alone does not do it: it turns the non-breaking
# hyphen (U+2011) into the hyphen (U+2010), not into `-`, and leaves the others as they are.
#   1. the tree scan: each dash inside a host and inside a hyphenated word, in file text and in a path; and every dash punctuation
#      character (Unicode category Pd, as this Python knows it) but `-`, with the four look-alikes, in a file;
#   2. the commit scan: the same in a public commit's message;
#   3. the publish, end to end: each dash in a subject, in a public file and in a public path stops it, and the target does not move
#      (a path with any character that is not ASCII is refused by the export already, before the scan: section 1 tests the scan's
#      reading of paths);
#   4. clean text with such dashes (a range, a dash between words, a minus sign) still passes, and plain `-` is still found.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

HOST="zz-internal""\\.test"
WORD="zz-hyph""-word"
printf '%s\n%s\n' "$HOST" "$WORD" >"$T/words"
scan() { "$PUB/scan" --words "$T/words" "$@"; }
pub() { "$PUB/publish" --words "$T/words" "$@"; }
# The dashes, by name: dash punctuation (Unicode category Pd), four look-alikes of other categories, and four that NFKC makes into
# `-` or into one of the others. Section 1 also checks every Pd character this Python knows.
DASHES="hyphen:‐ non-breaking-hyphen:‑ figure-dash:‒ en-dash:– em-dash:— horizontal-bar:―
two-em-dash:⸺ three-em-dash:⸻ armenian-hyphen:֊ hebrew-maqaf:־ double-hyphen:⹀ wave-dash:〜
minus-sign:− modifier-letter-minus-sign:˗ hyphen-bullet:⁃ heavy-minus-sign:➖
small-em-dash:﹘ small-hyphen-minus:﹣ full-width-hyphen-minus:－ vertical-em-dash:︱"
# The host and the word, spelled with dash $1 (a \u escape for uni).
host_with() { printf 'zz%sinternal.test' "$1"; }
word_with() { printf 'zz%shyph%sword' "$1" "$1"; }

# 1. The tree scan.
S=$T/scanrepo
git init -q -b main "$S"
mkdir -p "$S/src"
printf 'clean\n' >"$S/src/clean.txt"
git -C "$S" add -A && git -C "$S" commit -q -m clean
tree_with() { # file content(uni): a tree with one more file
  rm -f "$S"/src/seed*
  uni "$2" >"$S/src/$1"
  git -C "$S" add -A && git -C "$S" commit -q -m seed
  git -C "$S" rev-parse 'HEAD^{tree}'
}
in_file() { # label text(uni) rule
  local tree out
  tree=$(tree_with seed.txt "ok\nsee $2 here\n")
  out=$(GIT_DIR=$S/.git scan tree "$tree" 2>&1)
  check_eq "1. $1 in a file: exit 1" "$?" "1"
  check "1. $1 in a file: named at its line, by the rule ($3)" grep -qxF "src/seed.txt:2: $3" <<<"$out"
}
in_path() { # label text(uni) rule
  local tree out
  tree=$(tree_with "seed-$(uni "$2").txt" "nothing\n")
  out=$(GIT_DIR=$S/.git scan tree "$tree" 2>&1)
  check_eq "1. $1 in a path: exit 1" "$?" "1"
  check "1. $1 in a path: named by the file's id, by the rule ($3)" grep -qx "path of the file [0-9a-f]\{12\}: $3" <<<"$out"
  check_eq "1. $1 in a path: the output does not hold the path" "$(grep -c 'seed-' <<<"$out" || true)" "0"
}
for d in $DASHES; do
  name=${d%%:*} ch=${d#*:}
  in_file "a host with a $name" "$(host_with "$ch")" internal-word:words:1
  in_file "a hyphenated word with a $name" "$(word_with "$ch")" internal-word:words:2
  in_path "a host with a $name" "$(host_with "$ch")" internal-word:words:1
  in_path "a hyphenated word with a $name" "$(word_with "$ch")" internal-word:words:2
done

# Every character of category Pd but `-`, and the four look-alikes, one per line in the host: each line is a hit.
uni "$(python3 -I -c 'import unicodedata
cs = [c for c in range(0x110000) if unicodedata.category(chr(c)) == "Pd" and c != 0x2D] + [0x2212, 0x2D7, 0x2043, 0x2796]
print("".join("zz\\U%08xinternal.test\\n" % c for c in cs), end="")')" >"$T/all-dashes"
rm -f "$S"/src/seed*
cp "$T/all-dashes" "$S/src/seed.txt"
git -C "$S" add -A && git -C "$S" commit -q -m seed
out=$(GIT_DIR=$S/.git scan tree "$(git -C "$S" rev-parse 'HEAD^{tree}')" 2>&1)
lines=$(wc -l <"$T/all-dashes" | tr -d ' ')
check "1. every Pd character and the four look-alikes: at least 25 lines" test "$lines" -ge 25
check_eq "1. ...each line is a hit" "$(grep -c '^src/seed.txt:[0-9]*: internal-word:words:1$' <<<"$out" || true)" "$lines"

# 2. The commit scan, of a public commit.
craw() { # message(uni): a commit object in the scan repo; prints its id
  local tree
  tree=$(git -C "$S" rev-parse 'HEAD^{tree}')
  {
    printf 'tree %s\nauthor A <a@example.com> 1700000000 +0000\ncommitter A <a@example.com> 1700000000 +0000\n\n' "$tree"
    uni "$1"
  } | git -C "$S" hash-object -t commit --literally -w --stdin
}
pscan() { GIT_DIR=$S/.git scan commit "$1" --public --allow-email a@example.com; }
for d in $DASHES; do
  name=${d%%:*} ch=${d#*:}
  for w in "host:$(host_with "$ch"):1" "hyphenated word:$(word_with "$ch"):2"; do
    IFS=: read -r what text line <<<"$w"
    c=$(craw "Change $text now\n")
    out=$(pscan "$c" 2>&1)
    check_eq "2. a public commit with a $what with a $name: exit 1" "$?" "1"
    check "2. ...named at the message line, by the rule" grep -q " message:1: internal-word:words:$line\$" <<<"$out"
  done
done

# 3. The publish, end to end, against a local bare target.
R=$T/repo
mk_repo "$R"
commit "$R" "Start"
cd "$R" || exit 1
git init -q -b main --bare "$T/target.git"
TARGET=$T/target.git
pub --apply "$TARGET" >/dev/null 2>&1
check_eq "3. a clean first publish goes through" "$?" "0"
state() { git -C "$TARGET" for-each-ref --format='%(refname) %(objectname)'; }
stops() { # label why-pattern [no-log-check]: the commit on HEAD stops the publish; then it is taken off again. The log is not
  # checked for a path the export refuses: its message names that path, in git's quoting (as on main, for any such path).
  local out rc base was
  base=$(state)
  was=$(git -C "$TARGET" rev-parse main)
  out=$(pub --apply "$TARGET" 2>&1)
  rc=$?
  check_eq "3. $1: the publish stops (exit 2)" "$rc" "2"
  check_eq "3. $1: the target did not move" "$(state)" "$base"
  check_eq "3. $1: stopped for the right reason" "$(grep -c -F -e "$2" <<<"$out" || true)" "1"
  [ -n "${3:-}" ] || check_eq "3. $1: the log does not hold the text" "$(grep -c -a -e 'zz' <<<"$out" || true)" "0"
  git -C "$R" reset -q --hard HEAD~1
  git clean -q -f -d
  git -C "$TARGET" update-ref refs/heads/main "$was" # should one get through, the target is put back after it
}
n=0
for d in $DASHES; do
  name=${d%%:*} ch=${d#*:}
  n=$((n + 1))
  printf 'change %s\n' "$n" >src/a.txt
  commit "$R" "Change $(uni "$(host_with "$ch")") (#$n)"
  stops "a host with a $name in the subject" 'the scan stopped the publish (a public commit)'
  printf 'see %s\n' "$(uni "$(word_with "$ch")")" >src/a.txt
  commit "$R" "Change a"
  stops "a hyphenated word with a $name in a public file" 'the scan stopped the publish (the files of'
  printf 'x\n' >"src/at-$(uni "$(host_with "$ch")")"
  commit "$R" "Add a file"
  stops "a host with a $name in a public path" 'publish: cannot export' no-log-check
done
check_eq "3. the public history holds no host or word" \
  "$(git -C "$TARGET" cat-file --batch-all-objects --batch | grep -c -a -e 'zz' || true)" "0"

# 4. Clean text with such dashes still passes; plain `-` is still found.
tree=$(tree_with seed.txt 'pages 2–3 — a pause −1 non‑breaking ― bar － zz‑other.test\n')
GIT_DIR=$S/.git scan tree "$tree" >/dev/null 2>&1
check_eq "4. clean text with look-alike dashes: exit 0" "$?" "0"
c=$(craw 'Change pages 2–3 — and a non‑breaking hyphen\n')
pscan "$c" >/dev/null 2>&1
check_eq "4. a clean public commit with look-alike dashes: exit 0" "$?" "0"
printf 'change plain\n' >src/a.txt
commit "$R" "Change a clean thing — with a dash"
pub --apply "$TARGET" >/dev/null 2>&1
check_eq "4. a clean commit with a look-alike dash is published" "$?" "0"
in_file "a host with plain -" "$(host_with -)" internal-word:words:1
in_file "a hyphenated word with plain -" "$(word_with -)" internal-word:words:2
c=$(craw "Change $(host_with -)\n")
check_eq "4. a public commit with the host with plain -: exit 1" "$(pscan "$c" >/dev/null 2>&1; echo $?)" "1"

done_tests
