#!/usr/bin/env bash
# The scan reads text normalised: a word split by an invisible character or written in full-width letters is still found, a commit
# in another encoding is refused, and text that cannot be read or normalised never passes.
#   1. the publish, end to end, with five commits written byte for byte (git hash-object --literally): a word split by a zero-width
#      space in the subject; a full-width number in brackets after a # in the subject; U+266F used as a # in the subject; a commit
#      with an `encoding UTF-7` header and the word encoded in UTF-7, in the subject and in the body. Each stops the publish, the
#      target does not move, the log holds no word;
#   2. the tree scan: the same normalisation in file text and in paths, for each kind of default-ignorable and for full-width text;
#      Then subjects with a # before a number at the start of a word, in the ways the scan reads as one: published with the #
#      taken out, through the real scan;
#   3. the commit scan: the encoding header, bytes that are not UTF-8, an internal pull request number in a public commit, and a
#      # before a number at the start of a word left in one (a # after a letter, "C#9", is neither);
#   4. fail closed: bad bytes do not crash the scan, and a normalisation that cannot be made is a hit, not a pass.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

LEAK=zzleakzz
HOST="zz-internal.""test"
printf '%s[a-z]*\n@%s\n' "$LEAK" "$HOST" >"$T/words"
pub() { "$PUB/publish" --words "$T/words" "$@"; }
scan() { "$PUB/scan" --words "$T/words" "$@"; }

R=$T/repo
mk_repo "$R"
commit "$R" "Start"
cd "$R" || exit 1
git init -q -b main --bare "$T/target.git"
TARGET=$T/target.git
state() { git -C "$TARGET" for-each-ref --format='%(refname) %(objectname)'; }
pub --apply "$TARGET" >/dev/null 2>&1
check_eq "a clean first publish goes through" "$?" "0"

# A commit written byte for byte on top of HEAD, with one public file changed: MSG is a printf format (the message), HDR_EXTRA an
# optional header line after the committer.
n=0
rawcommit() { # repo
  local r=$1 tree parent obj
  n=$((n + 1))
  printf 'raw change %s\n' "$n" >"$r/src/a.txt"
  git -C "$r" add -A
  tree=$(git -C "$r" write-tree)
  parent=$(git -C "$r" rev-parse HEAD)
  # shellcheck disable=SC2059 # MSG is the format by design: it carries the payload's escapes.
  obj=$({
    printf 'tree %s\nparent %s\n' "$tree" "$parent"
    printf 'author Internal Dev <dev@example.com> 1700000000 +0000\ncommitter Internal Dev <dev@example.com> 1700000000 +0000\n'
    [ -z "${HDR_EXTRA:-}" ] || printf '%s\n' "$HDR_EXTRA"
    printf '\n'
    printf "$MSG"
  } | git -C "$r" hash-object -t commit --literally -w --stdin)
  git -C "$r" update-ref HEAD "$obj"
}
p_zwsp() { MSG="Change zz\xe2\x80\x8bleakzz\n" rawcommit "$1"; }
p_fullwidth() { MSG="Change (#\xef\xbc\x91\xef\xbc\x92)\n" rawcommit "$1"; }
p_sharp() { MSG="A \xe2\x99\xaf12 tune\n" rawcommit "$1"; }
p_enc_utf7() { HDR_EXTRA="encoding UTF-7" MSG="Subj +AHoAeg-leakzz\n" rawcommit "$1"; }
p_enc_utf7body() { HDR_EXTRA="encoding UTF-7" MSG="Subj\n\n+AHoAeg-leakzz\n" rawcommit "$1"; }

# 1. Each payload stops the publish.
stops() { # payload why-pattern. Each payload on its own: should one get through, the target is put back after it.
  local out rc base was
  base=$(state)
  was=$(git -C "$TARGET" rev-parse main)
  "$1" "$R"
  out=$(pub --apply "$TARGET" 2>&1)
  rc=$?
  check_eq "1. $1: the publish stops (exit 2)" "$rc" "2"
  check_eq "1. $1: the target did not move" "$(state)" "$base"
  check_eq "1. $1: stopped for the right reason" "$(grep -c -e "$2" <<<"$out" || true)" "1"
  check_eq "1. $1: the log does not hold the text" "$(grep -c -a -e "$LEAK" -e 'AHoAeg' -e $'\xef\xbc' <<<"$out" || true)" "0"
  git -C "$R" reset -q --hard HEAD~1
  git -C "$TARGET" update-ref refs/heads/main "$was"
}
stops p_zwsp 'the scan stopped the publish (a public commit)'
stops p_fullwidth 'still holds an internal pull request number'
stops p_sharp 'still holds an internal pull request number'
stops p_enc_utf7 'has an encoding other than UTF-8: not decoded, not published'
stops p_enc_utf7body 'has an encoding other than UTF-8: not decoded, not published'
# The same shapes without the payload still go through: the checks do not refuse a clean commit or a UTF-8 encoding header.
for enc in "" "encoding UTF-8" "encoding utf8"; do
  HDR_EXTRA=$enc MSG="Change a clean thing\n" rawcommit "$R"
  pub --apply "$TARGET" >/dev/null 2>&1
  check_eq "1. a clean raw commit (header '${enc:-none}') goes through" "$?" "0"
done
# A # before a number at the start of a word, written in any of the ways the scan reads as one, is published with the # taken
# out, and the real scan passes it, in square brackets and in a list too; a # after a letter stays, as does U+266F after one.
for w in 'follow-up to #149|follow-up to 149' 'Fix the thing from #77 (#80)|Fix the thing from 77' \
  'issue \uff03\uff11\uff12 again|issue \uff11\uff12 again' 'issue #\u200b12|issue \u200b12' 'see ##12|see 12' \
  'notes on C#9|notes on C#9' 'Change [#12]|Change [12]' 'Change (#12, #13)|Change (12, 13)' \
  'Change \uff3b\uff03\uff11\uff12\uff3d|Change \uff3b\uff11\uff12\uff3d' 'Change [ #12 ; 13 ] (#14)|Change [ 12 ; 13 ]' \
  'a C\u266f9 chord|a C\u266f9 chord'; do
  IFS='|' read -r m want <<<"$w"
  MSG="$(uni "$m" | sed 's/%/%%/g')\n" rawcommit "$R"
  out=$(pub --apply "$TARGET" 2>&1)
  check_eq "1. '$m': published (exit 0)" "$?" "0"
  check_eq "1. '$m': with the subject '$want'" "$(git -C "$TARGET" log -1 --format=%B main)" "$(uni "$want")"
done
check_eq "1. the public history holds no internal word" \
  "$(git -C "$TARGET" cat-file --batch-all-objects --batch | grep -c -a -e "$LEAK" -e 'AHoAeg' || true)" "0"

# 2. The tree scan, file text and paths. Each invisible character splits the word; full-width letters spell it.
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
in_file() { # label word(uni) [rule, default the word rule]
  local tree out rule=${3:-internal-word:words:1}
  tree=$(tree_with seed.txt "ok\nsee $2 here\n")
  out=$(GIT_DIR=$S/.git scan tree "$tree" 2>&1)
  check_eq "2. $1 in a file: exit 1" "$?" "1"
  check "2. $1 in a file: named at its line, by the rule ($rule)" grep -qxF "src/seed.txt:2: $rule" <<<"$out"
}
in_path() { # label word(uni)
  local tree out
  tree=$(tree_with "seed-$(uni "$2").txt" "nothing\n")
  out=$(GIT_DIR=$S/.git scan tree "$tree" 2>&1)
  check_eq "2. $1 in a path: exit 1" "$?" "1"
  check "2. $1 in a path: named by the file's id" grep -q '^path of the file [0-9a-f]\{12\}: internal-word:words:1$' <<<"$out"
  check_eq "2. $1 in a path: the output does not hold the path" "$(grep -c 'seed-' <<<"$out" || true)" "0"
}
for c in "zero-width space:\u200b" "zero-width non-joiner:\u200c" "zero-width joiner:\u200d" "word joiner:\u2060" \
  "byte order mark:\ufeff" "soft hyphen:\u00ad" "left-to-right mark:\u200e" "right-to-left override:\u202e" \
  "left-to-right isolate:\u2066" "arabic letter mark:\u061c" "combining grapheme joiner:\u034f" "variation selector:\ufe0f" \
  "mongolian vowel separator:\u180e" "invisible separator:\u2063" "tag letter:\U000e0061" "half-width hangul filler:\uffa0"; do
  label=${c%%:*} ch=${c#*:}
  in_file "a word split by a $label" "zz${ch}leak${ch}zz"
  in_path "a word split by a $label" "zz${ch}leakzz"
done
# Full-width letters (U+FF5A z, U+FF4C l ...) and a mix of full-width and plain.
FW='\uff5a\uff5a\uff4c\uff45\uff41\uff4b\uff5a\uff5a'
in_file "a word in full-width letters" "$FW"
in_path "a word in full-width letters" "$FW"
in_file "a word half in full-width letters" 'zz\uff4c\uff45akzz'
in_file "a full-width mail domain" 'a\uff20zz-internal\uff0etest' "internal-word:words:2"
in_file "a stray key in full-width digits" "$(printf '\\uff11\\uff12%.0s' $(seq 32))" "hex64 (a stray key)"
# The plain readings still work, and nothing is found in clean text with such characters.
tree=$(tree_with seed.txt 'caf\u00e9 \u200b na\u00efve \uff08ok\uff09 \u202ehello\u202c\n')
GIT_DIR=$S/.git scan tree "$tree" >/dev/null 2>&1
check_eq "2. clean text with invisible and full-width characters: exit 0" "$?" "0"

# 3. The commit scan.
craw() { # header-extra message(uni): a commit object in the scan repo; prints its id
  local tree
  tree=$(git -C "$S" rev-parse 'HEAD^{tree}')
  {
    printf 'tree %s\nauthor A <a@example.com> 1700000000 +0000\ncommitter A <a@example.com> 1700000000 +0000\n' "$tree"
    [ -z "$1" ] || printf '%s\n' "$1"
    printf '\n'
    uni "$2"
  } | git -C "$S" hash-object -t commit --literally -w --stdin
}
cscan() { GIT_DIR=$S/.git scan commit "$@"; }
c=$(craw "" 'Subj zz\u200bleakzz\n')
out=$(cscan "$c" 2>&1)
check_eq "3. a word split by a zero-width space in a commit: exit 1" "$?" "1"
check "3. ...named at the message line" grep -q ' message:1: internal-word:words:1$' <<<"$out"
for enc in UTF-7 ISO-8859-1 UTF-16 "utf-8 x" "UTF-8 " ""; do
  c=$(craw "encoding${enc:+ $enc}" 'Subj\n')
  out=$(cscan "$c" 2>&1)
  check_eq "3. a commit with encoding '${enc}': exit 1" "$?" "1"
  check "3. ...for its encoding" grep -q ' encoding: an encoding other than UTF-8' <<<"$out"
done
for enc in UTF-8 utf-8 utf8 UTF8; do
  c=$(craw "encoding $enc" 'Subj\n')
  cscan "$c" >/dev/null 2>&1
  check_eq "3. a commit with encoding $enc: exit 0" "$?" "0"
done
c=$(craw "" 'Subj \xff\xfe zz\n')
out=$(cscan "$c" 2>&1)
check_eq "3. a commit whose bytes are not UTF-8: exit 1" "$?" "1"
check "3. ...said so" grep -q ': a commit that is not UTF-8$' <<<"$out"
check_eq "3. ...and no crash" "$(grep -c Traceback <<<"$out" || true)" "0"
c=$(craw "" 'Subj zz\xffleakzz\n')
check_eq "3. a word split by a bad byte in a commit: refused" "$(cscan "$c" >/dev/null 2>&1; echo $?)" "1"
pscan() { cscan "$1" --public --allow-email a@example.com; }
# An internal pull request number, in the merge's own forms: a number after a # alone in brackets and a merge subject, however
# it is written (full-width, split by an invisible character, with digits other than ASCII ones, U+266F for the #).
for m in 'Change (#\uff11\uff12)' 'Change (\uff03\uff11)' 'Change (#\u200b12)' 'Change \uff08#12\uff09' 'Change (#\u0663)' \
  'Revert "Change (#12)"' 'Change ( #12 ) more' 'Merge pull request #\uff11 from a/b' 'Merge pull\u00a0request #12 from a/b' \
  'merge PULL request #\u0663' 'Merge pull-request #3' 'Merge PR #3' 'merge pr #3' 'MERGE Pr #3 from a/b' \
  'Change (\u266f12)' 'Merge PR \u266f3'; do
  c=$(craw "" "$m\n")
  out=$(pscan "$c" 2>&1)
  check_eq "3. a public commit '$m': exit 1" "$?" "1"
  check "3. ...for its internal pull request number" grep -q ' message:1: an internal pull request number in a public commit$' <<<"$out"
done
# A # before a number at the start of a word, left in a public commit (publish takes it out, so this is the backstop), in square
# brackets and in a list too.
for m in 'fix issue #12 in docs' 'Change #3' 'Change #\u0663' 'issue #\uff11\uff12 again' 'remerge pull request #3' \
  'issue \uff0312' 'issue #\u200b12' 'a \u266f12 tune' '#12 first' 'C\u200b#9' 'see ##12' 'Change [#12]' \
  'Change (#12, #13)' 'Change [ #12 ; 13 ]' 'Change \uff3b#12\uff3d'; do
  c=$(craw "" "$m\n")
  out=$(pscan "$c" 2>&1)
  check_eq "3. a public commit '$m': exit 1" "$?" "1"
  check "3. ...for its # before a number" grep -q ' message:1: a # before a number in a public commit (it would link)$' <<<"$out"
  check_eq "3. ...not as a pull request number" "$(grep -c 'an internal pull request number' <<<"$out" || true)" "0"
done
# A # after a letter, digit or _, a # with no number, a number in brackets with no #: none of them. Such a public commit passes.
for m in 'Change the C# notes' 'notes on C#9' 'Change C\uff039' 'a C\u266f9 chord' 'Change (#a) and (12)' 'x_#12 and 3#4' 'Change # 12' \
  'remerge pull request 3' 'Merge pull request 3'; do
  c=$(craw "" "$m\n")
  pscan "$c" >/dev/null 2>&1
  check_eq "3. a public commit '$m': exit 0" "$?" "0"
done

# 4. Fail closed. Bytes that are not UTF-8 (in a file and in a path) do not crash the tree scan, and a word split by them is found.
tree=$(tree_with seed.bin 'ok \xff\xfe\xc3 \xed\xa0\x80 \xf4\x90\x80\x80 \xc0\xaf end\n')
out=$(GIT_DIR=$S/.git scan tree "$tree" 2>&1)
check_eq "4. a file of bad bytes: scanned, exit 0" "$?" "0"
check_eq "4. ...no crash" "$(grep -c Traceback <<<"$out" || true)" "0"
tree=$(tree_with "seed-$(uni 'zz\xffx\xed\xa0\x80').txt" 'ok\n')
out=$(GIT_DIR=$S/.git scan tree "$tree" 2>&1)
check_eq "4. a path of bad bytes: scanned, exit 0" "$?" "0"
check_eq "4. ...no crash" "$(grep -c Traceback <<<"$out" || true)" "0"
# A normalisation that fails: a copy of the scan whose NFKC raises. A clean tree and a clean commit must then be hits, not passes.
if grep -q 'unicodedata.normalize("NFKC", t)' "$PUB/scan"; then
  rm -rf "$T/broken" && cp -R "$PUB" "$T/broken"
  sed 's/unicodedata.normalize("NFKC", t)/unicodedata.normalize("NFKC-broken", t)/' "$PUB/scan" >"$T/broken/scan"
  chmod +x "$T/broken/scan"
  tree=$(git -C "$S" rev-parse 'HEAD^{tree}')
  out=$(GIT_DIR=$S/.git "$T/broken/scan" --words "$T/words" tree "$tree" 2>&1)
  check_eq "4. a normalisation that fails, on a clean tree: exit 1" "$?" "1"
  check "4. ...said so" grep -q ': text the scan cannot normalise$' <<<"$out"
  check_eq "4. ...no crash" "$(grep -c Traceback <<<"$out" || true)" "0"
  c=$(craw "" 'Subj\n')
  GIT_DIR=$S/.git "$T/broken/scan" --words "$T/words" commit "$c" >/dev/null 2>&1
  check_eq "4. a normalisation that fails, on a clean commit: exit 1" "$?" "1"
else
  check "4. the scan normalises with NFKC" false
fi

done_tests
