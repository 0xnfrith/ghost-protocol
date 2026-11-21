#!/usr/bin/env bash
# The tests of the release workflow's promote job (.github/workflows/release.yml): its trigger, its token's permissions, its pins,
# and its step's own script, run here against a stand-in tools/release/ci/promote (no network, no secret). Then the script with
# one guard broken at a time: each broken copy must fail a check.
# The checks and the mutants hold literal $ and ${{ }} (SC2016).
# shellcheck disable=SC2016
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
WF=$ROOT/.github/workflows/release.yml
MARK=$ROOT/tools/release/mark
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0
fail=0
ok() { pass=$((pass + 1)); echo "ok    $1"; }
bad() { fail=$((fail + 1)); echo "FAIL  $1"; }
check_eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1"; printf '      got:  %s\n      want: %s\n' "${2//$'\n'/ | }" "${3//$'\n'/ | }"; fi; }
check_has() { if grep -qF -e "$2" <<<"$3"; then ok "$1"; else bad "$1"; printf '      wanted: %s\n      in:     %s\n' "$2" "${3//$'\n'/ | }"; fi; }
check_not() { if grep -qF -e "$2" <<<"$3"; then bad "$1"; printf '      did not want: %s\n' "$2"; else ok "$1"; fi; }

# block <file> <regex of the opening line> <indent of its siblings>: the lines under the opening line, up to its next sibling.
block() { awk -v open="$2" -v sib="^$3[^ #]" '$0 ~ open { f = 1; next } f && $0 ~ sib { f = 0 } f' "$1"; }
top_on=$(block "$WF" '^on:' '')
top_perm=$(block "$WF" '^permissions:' '')
release_job=$(block "$WF" '^  release:$' '  ')
promote_job=$(block "$WF" '^  promote:$' '  ')
# The promote step's script: the lines under its `run: |`, less their indent.
awk '/^        run: \|$/ { f = 1; next } f && /^ {0,9}[^ ]/ { f = 0 } f { sub(/^          /, ""); print }' <<<"$promote_job" >"$T/script.sh"
script=$(cat "$T/script.sh")

# 1. The trigger and the jobs' conditions.
check_has "on: a release marked released" $'  release:\n    types: [released]' "$top_on"
check_eq "on: release has the one type, released" "$(grep -A1 '^  release:$' <<<"$top_on" | tail -n1)" "    types: [released]"
check_not "on: no pull_request trigger (its jobs write releases and packages)" "pull_request" "$top_on"
check_has "on: version tags still release" "    tags: ['v*']" "$top_on"
check_has "the release job does not run on a release event" "    if: github.event_name != 'release'" "$release_job"
check_has "the promote job runs on a release event alone" "    if: github.event_name == 'release'" "$promote_job"
check_eq "the promote job has one if" "$(grep -c '^    if:' <<<"$promote_job")" "1"

# The concurrency group: one at a time per tag; a promotion in a group of its own, apart from the release runs of its tag.
check_eq "the concurrency group: per tag, a promotion apart" "$(grep -c "^  group: release-\${{ github.event_name == 'release' && 'promote-' || '' }}\${{ github.ref }}$" "$WF")" "1"
check_eq "the concurrency group: a run waits, never cancelled" "$(grep -c '^  cancel-in-progress: false$' "$WF")" "1"

# 2. The token: the workflow's default reads the repository; the promote job reads it and writes packages, nothing more.
check_eq "the workflow's default token reads the repository, nothing else" "$(grep -v '^ *#' <<<"$top_perm" | grep . | sed 's/ *#.*//')" "  contents: read"
promote_perm=$(block <(printf '%s\n' "$promote_job") '^    permissions:$' '    ' | sed 's/ *#.*//')
check_eq "the promote job's token: contents read, packages write, nothing else" "$promote_perm" $'      contents: read\n      packages: write'
check_eq "the promote job uses the run's own token" "$(grep -c '^          GH_TOKEN: \${{ github.token }}$' <<<"$promote_job")" "1"
check_not "no secret in the release workflow" 'secrets.' "$(cat "$WF")"
check_not "no job token for writes beyond the release job's" "write-all" "$(cat "$WF")"

# 3. Pins: the checkout is the release job's, by commit; it keeps no credential and takes the default branch.
pin_of() { grep -oE 'uses: actions/checkout@[0-9a-f]{40}( |$)' <<<"$1" | head -n1; }
check_has "the promote job's checkout is pinned to a commit" "uses: actions/checkout@" "$(pin_of "$promote_job")"
check_eq "the promote job's checkout pin is the release job's" "$(pin_of "$promote_job")" "$(pin_of "$release_job")"
check_has "the promote job's checkout keeps no credential" "          persist-credentials: false" "$promote_job"
check_has "the promote job checks out the default branch" '          ref: ${{ github.event.repository.default_branch }}' "$promote_job"
check_eq "the promote job uses only the checkout" "$(grep -c 'uses:' <<<"$promote_job")" "1"

# 4. The script: the event's values come in by the environment, never written into the script.
check_not "the script holds no \${{ }} (the event's text never becomes code)" '${{' "$script"
check_has "the release's tag reaches ci/promote" '          GP_RELEASE_TAG: ${{ github.event.release.tag_name }}' "$promote_job"
check_has "the script ends by running ci/promote" "exec ./tools/release/ci/promote" "$script"
# The line mark promote writes, as mark writes it, is what the script looks for.
check_has "mark promote still writes the line the script looks for" \
  'line="Promoted on $(date -u +%Y-%m-%d), after one of our own agents had run it cleanly for $for_how_long."' "$(cat "$MARK")"

# 5. The script, run. A stand-in ci/promote records its environment and exits $STUB_RC.
mkdir -p "$T/tree/tools/release/ci" "$T/empty"
cat >"$T/tree/tools/release/ci/promote" <<'STUB'
#!/usr/bin/env bash
printf 'tag=%s token=%s\n' "$GP_RELEASE_TAG" "${GH_TOKEN:+set}" >"$RAN"
exit "${STUB_RC:-0}"
STUB
chmod +x "$T/tree/tools/release/ci/promote"
export RAN=$T/ran
PROMOTED="Promoted on 2026-11-20, after one of our own agents had run it cleanly for 75 minutes."
# run_step <script> <dir> <pre-release> <draft> <notes>: rc, out and whether ci/promote ran.
run_step() {
  rm -f "$RAN"
  out=$(cd "$2" && GH_TOKEN=stub-token GP_RELEASE_TAG=v1.2.3 RELEASE_PRERELEASE=$3 RELEASE_DRAFT=$4 RELEASE_NOTES=$5 \
    bash "$1" 2>&1)
  rc=$?
  ran=no
  [ -f "$RAN" ] && ran=$(cat "$RAN")
}
# cases <script>: every case; prints one line per case, "<name>: <rc> <ran>".
cases() {
  local s=$1
  run_step "$s" "$T/tree" false false "$PROMOTED"$'\n\nnotes'; echo "promoted: $rc $ran"
  run_step "$s" "$T/tree" false false "Release 1.2.3. $PROMOTED"$'\r\n\r\nnotes'; echo "promoted, after other words, CRLF: $rc $ran"
  run_step "$s" "$T/tree" true false "$PROMOTED"; echo "pre-release: $rc $ran"
  run_step "$s" "$T/tree" false true "$PROMOTED"; echo "draft: $rc $ran"
  run_step "$s" "$T/tree" '' false "$PROMOTED"; echo "pre-release unknown: $rc $ran"
  run_step "$s" "$T/tree" false false "WITHDRAWN: bad"$'\n\n'"$PROMOTED"; echo "withdrawn: $rc $ran"
  run_step "$s" "$T/tree" false false "WITHDRAWN: bad, though $PROMOTED"; echo "withdrawn, the reason quoting mark's line: $rc $ran"
  run_step "$s" "$T/tree" false false $'Release 1.2.3.\n\nnotes'; echo "not through mark: $rc $ran"
  run_step "$s" "$T/tree" false false $'notes\n\n'"$PROMOTED"; echo "the line not first: $rc $ran"
  run_step "$s" "$T/tree" false false ""; echo "no notes: $rc $ran"
  STUB_RC=2 run_step "$s" "$T/tree" false false "$PROMOTED"; echo "ci/promote refuses: $rc $ran"
  run_step "$s" "$T/empty" false false "$PROMOTED"; echo "no ci/promote: $rc $ran"
}
want="promoted: 0 tag=v1.2.3 token=set
promoted, after other words, CRLF: 0 tag=v1.2.3 token=set
pre-release: 1 no
draft: 1 no
pre-release unknown: 1 no
withdrawn: 1 no
withdrawn, the reason quoting mark's line: 1 no
not through mark: 1 no
the line not first: 1 no
no notes: 1 no
ci/promote refuses: 2 tag=v1.2.3 token=set
no ci/promote: 0 no"
got=$(cases "$T/script.sh")
while IFS= read -r line; do
  name=${line%%:*}
  check_eq "run: $name" "$(grep -F -e "$name:" <<<"$got" | head -n1)" "$line"
done <<<"$want"
run_step "$T/script.sh" "$T/tree" true false "$PROMOTED"
check_has "run: a pre-release is refused, saying so" "is a pre-release or a draft" "$out"
run_step "$T/script.sh" "$T/tree" false false "WITHDRAWN: bad"
check_has "run: a withdrawn release is refused, saying so" "a withdrawn release is never promoted" "$out"
run_step "$T/script.sh" "$T/tree" false false "notes"
check_has "run: a release not promoted by mark is refused, saying so" "promote it with mark" "$out"
check_not "run: the token is never printed" "stub-token" "$out"
chmod -x "$T/tree/tools/release/ci/promote"
run_step "$T/script.sh" "$T/tree" false false "$PROMOTED"
check_eq "run: ci/promote not executable: refused" "$rc $ran" "1 no"
chmod +x "$T/tree/tools/release/ci/promote"

# 6. Mutants: the script with one guard broken; each must change a case's result.
mutant() { # name, sed program
  local f
  f="$T/mutant-$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"
  sed -e "$2" "$T/script.sh" >"$f"
  if cmp -s "$f" "$T/script.sh"; then bad "mutant $1: the sed changed nothing"; return; fi
  if [ "$(cases "$f")" != "$want" ]; then ok "mutant caught: $1"; else bad "mutant NOT caught: $1"; fi
}
mutant "pre-release not checked" 's/\[ "\$RELEASE_PRERELEASE" != false \] || //'
mutant "draft not checked" 's/ || \[ "\$RELEASE_DRAFT" != false \]//'
mutant "pre-release read as 'is it true'" 's/"\$RELEASE_PRERELEASE" != false/"$RELEASE_PRERELEASE" = true/'
mutant "withdrawn not checked" '/^  WITHDRAWN:\*)$/,/^    ;;$/d'
mutant "mark's line not checked" 's/^if ! \[\[ \$first =~ /if false \&\& [[ $first =~ /'
mutant "mark's line looked for anywhere" "s/^first=.*/first=\$RELEASE_NOTES/"
mutant "no exit on a refusal" '0,/^  exit 1$/s//  :/'

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
