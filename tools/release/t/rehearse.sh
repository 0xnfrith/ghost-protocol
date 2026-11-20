#!/usr/bin/env bash
# The tests of tools/release/rehearse: this tree, exported, scanned, tagged and taken through the release step as a dry run, in a
# scratch clone; and the same with a leak seeded, which must stop it. No network, no secret, no build.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
pass=0
fail=0
check_eq() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1"; printf '      got:  %s\n      want: %s\n' "${2//$'\n'/ | }" "${3//$'\n'/ | }"; fi; }
check_has() { if grep -qF -e "$2" <<<"$3"; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1"; printf '      wanted: %s\n      in:     %s\n' "$2" "${3//$'\n'/ | }"; fi; }
for tool in git jq python3; do command -v "$tool" >/dev/null || { echo "SKIP  $tool is not installed"; exit 0; }; done
[ -x "$ROOT/tools/release/rehearse" ] || { echo "FAIL  tools/release/rehearse is not executable"; exit 1; }
git -C "$ROOT" rev-parse --verify --quiet HEAD >/dev/null || { echo "SKIP  no commit to rehearse"; exit 0; }
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
git clone -q "file://$ROOT" "$T/clone" 2>/dev/null || git clone -q "$ROOT" "$T/clone"
cd "$T/clone" || exit 1
# The scan's internal word list is internal-only and never exported, so a public copy of this tree has none, and the scan refuses
# to run without one. There the rehearsal is given a stand-in list (one word that is in no file), kept out of git; the public
# words, which the seeded leak below uses, are built into the scan either way.
if [ ! -e tools/publish/internal/words.txt ]; then
  mkdir -p tools/publish/internal
  printf 'zz-stand-in-word-%s\n' "$$" >tools/publish/internal/words.txt
  printf '/tools/publish/internal/\n' >>.git/info/exclude
  echo "note  no internal word list in this tree: the rehearsal scans with a stand-in list"
fi
# What is committed in this tree is what is rehearsed: the working tree's changes are not (a test run in CI has none).
out=$(./tools/release/rehearse 2>&1)
rc=$?
check_eq "this tree, as a dry run: exit 0" "$rc" "0"
check_has "it published one public commit" "First public commit" "$out"
check_has "the published tree equals the export" "the published tree equals the export" "$out"
check_has "it tagged the version in plugin.json" "tagged v$(jq -r .version .claude-plugin/plugin.json) on the public commit" "$out"
check_has "the release step ran as a dry run" "dry run: nothing built, pushed or published" "$out"
check_has "it passed" "passed: export, scan and the release step (dry run)" "$out"

# A leak seeded in an allowlisted file stops it before anything is tagged.
leak="sect""ion-9"
printf 'a note that says %s\n' "$leak" >docs/seeded-note.md
git add -A
git -c user.name=t -c user.email=t@example.com commit -q -m "seed a leak"
out=$(./tools/release/rehearse 2>&1)
rc=$?
check_eq "a seeded public word: stops" "$rc" "2"
check_has "a seeded public word: the publish stopped" "the publish stopped" "$out"
check_eq "a seeded public word: the text is not in the output" "$(grep -c -F "$leak" <<<"$out" || true)" "0"
check_eq "a seeded public word: nothing was tagged" "$(grep -c 'tagged v' <<<"$out" || true)" "0"

# A seeded file under evals/ is never exported, so it does not stop a rehearsal.
git rm -q docs/seeded-note.md
mkdir -p evals
printf 'x\n' >evals/seeded-case.txt
git add -A
git -c user.name=t -c user.email=t@example.com commit -q -m "seed an evals file"
out=$(./tools/release/rehearse 2>&1)
rc=$?
check_eq "a file under evals/: not exported, the rehearsal passes" "$rc" "0"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
