#!/usr/bin/env bash
# The tests of tools/release/mark, with a stand-in gh (no network, no secret): a dry run changes nothing; a withdrawal marks the
# release and moves "latest" back to the highest full release; a promotion needs the record of one of our agents running the
# release cleanly, and makes the highest one the latest; nothing is deleted.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
MARK=$ROOT/tools/release/mark
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0
fail=0
check_eq() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1"; printf '      got:  %s\n      want: %s\n' "${2//$'\n'/ | }" "${3//$'\n'/ | }"; fi; }
check_has() { if grep -qF -e "$2" <<<"$3"; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1"; printf '      wanted: %s\n      in:     %s\n' "$2" "${3//$'\n'/ | }"; fi; }
command -v jq >/dev/null || { echo "SKIP  jq is not installed"; exit 0; }

# The stand-in gh: `release view <tag> --json ...` and `release list --json ...` answer from $RELEASES (a JSON array of
# {tagName, isPrerelease, isDraft, body}); `release edit` is logged to $CALLS, with the notes file's text.
mkdir "$T/bin"
cat >"$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "release view") jq -e --arg t "$3" '.[] | select(.tagName == $t)' "$RELEASES" || exit 1 ;;
  "release list") cat "$RELEASES" ;;
  "release download") [ -f "$GETSH" ] && cat "$GETSH" || exit 1 ;;
  "api repos/acme/widget/commits/"*) [ -n "${TAG_COMMIT:-}" ] && echo "$TAG_COMMIT" || exit 1 ;;
  "release edit")
    echo "gh $*" >>"$CALLS"
    prev=""
    for a in "$@"; do
      if [ "$prev" = --notes-file ]; then echo "notes: $(tr '\n' '|' <"$a")" >>"$CALLS"; fi
      prev=$a
    done ;;
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
STUB
chmod +x "$T/bin/gh"
export PATH="$T/bin:$PATH" RELEASES=$T/releases.json CALLS=$T/calls GETSH=$T/get.sh

# releases <tag:pre|full[:body]>...
releases() {
  local items=() a tag kind body
  for a in "$@"; do
    IFS=: read -r tag kind body <<<"$a"
    items+=("{\"tagName\":\"$tag\",\"isPrerelease\":$([ "$kind" = pre ] && echo true || echo false),\"isDraft\":false,\"body\":\"${body:-notes}\"}")
  done
  printf '[%s]\n' "$(IFS=,; echo "${items[*]}")" >"$RELEASES"
  : >"$CALLS"
}
run() { out=$("$MARK" "$@" --repo acme/widget 2>&1); rc=$?; calls=$(cat "$CALLS"); }

# Withdraw: the newest is bad; the one before it becomes the latest.
releases v1.0.0:full v1.1.0:full v1.2.0:full
run withdraw v1.2.0 --reason "the agent does not start"
check_eq "a dry run: exit 0" "$rc" "0"
check_has "a dry run: says what it would do" "would: make v1.1.0 the latest release" "$out"
check_eq "a dry run: changes nothing" "$calls" ""
run withdraw v1.2.0 --reason "the agent does not start" --apply
check_eq "withdraw: exit 0" "$rc" "0"
check_has "withdraw: the release is marked as a pre-release, not the latest" "gh release edit v1.2.0 --repo acme/widget --prerelease --latest=false --notes-file" "$calls"
check_has "withdraw: the notes lead with the reason" "notes: WITHDRAWN: the agent does not start||notes|" "$calls"
check_has "withdraw: the one before is the latest" "gh release edit v1.1.0 --repo acme/widget --latest" "$calls"
check_eq "withdraw: nothing is deleted" "$(grep -c -E 'delete|rm|--force|push' <<<"$calls" || true)" "0"

# Withdraw an old one: the latest is still the highest full release.
releases v1.0.0:full v1.1.0:full
run withdraw v1.0.0 --reason "old" --apply
check_has "withdraw an old one: the highest stays the latest" "gh release edit v1.1.0 --repo acme/widget --latest" "$calls"

# A pre-release and a withdrawn one are not candidates for the latest.
releases v1.0.0:full v1.1.0:pre v1.2.0:full
run withdraw v1.2.0 --reason "bad" --apply
check_has "a pre-release is skipped: v1.0.0 is the latest" "gh release edit v1.0.0 --repo acme/widget --latest" "$calls"

# Withdraw twice: the reason is replaced, not stacked.
releases v1.0.0:full "v1.1.0:pre:WITHDRAWN: first\n\nnotes"
run withdraw v1.1.0 --reason "second" --apply
check_has "withdraw again: one reason line, the new one" "notes: WITHDRAWN: second||notes|" "$calls"

# Nothing to go back to.
releases v1.0.0:pre
run withdraw v1.0.0 --reason "bad"
check_has "no other full release: said so" "there is no other full release" "$out"

# Promote: only with the record of one of our agents running the release cleanly (tools/release/ran-clean's).
DIGEST=sha256:$(printf 'd%.0s' $(seq 64))
OTHER=sha256:$(printf 'e%.0s' $(seq 64))
COMMIT=$(printf 'a%.0s' $(seq 40))
export TAG_COMMIT=$COMMIT
getsh() { printf '#!/bin/sh\nIMAGE="${GP_IMAGE:-ghcr.io/acme/widget:%s@%s}"\n' "$1" "${2:-$DIGEST}" >"$GETSH"; }
# rec <image|checkout> [jq filter]: a clean record of version 1.1.0, up 90 minutes, changed by the filter.
rec() {
  local base
  if [ "$1" = image ]; then
    base='{"record":"gp-ran-clean/1","taken_at":"2026-11-19T12:30:00Z","install":"image","version":"1.1.0","up_since":"2026-11-19T11:00:00Z","running":true,"restarts":0,"image":{"reference":"ghcr.io/acme/widget:1.1.0@'$DIGEST'","id":"sha256:'$(printf 'f%.0s' $(seq 64))'","repo_digests":["ghcr.io/acme/widget@'$DIGEST'"]},"status":{"state":"running","relay":"connected","claude":"active","error":null},"commit":null,"changed":null,"unit":null}'
  else
    base='{"record":"gp-ran-clean/1","taken_at":"2026-11-19T12:30:00Z","install":"checkout","version":"1.1.0","up_since":"2026-11-19T11:00:00Z","running":true,"restarts":0,"image":null,"status":null,"commit":"'$COMMIT'","changed":false,"unit":{"active_state":"active","sub_state":"running"}}'
  fi
  jq "${2:-.}" <<<"$base" >"$T/rec.json"
}
PRE="GHOST Protocol v1.1.0. A pre-release until one of our own agents has run it cleanly.\n\n## The image"
getsh 1.1.0

releases v1.0.0:full "v1.1.0:pre:$PRE"
rec image
run promote v1.1.0
check_eq "promote without a record: refused" "$rc" "2"
check_has "promote without a record: says why" "promote needs --ran <record>" "$out"
check_eq "promote without a record: nothing changed" "$calls" ""
run promote v1.1.0 --apply
check_eq "promote --apply without a record: refused" "$rc" "2"
check_eq "promote --apply without a record: nothing changed" "$calls" ""
run promote v1.1.0 --ran "$T/rec.json"
check_eq "promote, dry run, a clean record: exit 0" "$rc" "0"
check_has "promote, dry run: the record ran cleanly" "ran cleanly: 1.1.0, up 90 minutes, no restarts" "$out"
check_has "promote, dry run: says it would make it the latest" "would: clear the pre-release mark of v1.1.0, and make it the latest release" "$out"
check_eq "promote, dry run: changes nothing" "$calls" ""
run promote v1.1.0 --ran "$T/rec.json" --apply
check_eq "promote: exit 0" "$rc" "0"
check_has "promote: clears the mark and sets the latest" "gh release edit v1.1.0 --repo acme/widget --prerelease=false --latest --notes-file" "$calls"
check_has "promote: the notes say when, in place of the pre-release line" "notes: GHOST Protocol v1.1.0. Promoted on $(date -u +%Y-%m-%d), after one of our own agents had run it cleanly for 90 minutes.||## The image|" "$calls"
check_has "promote: says the image's version tag comes next" "the release workflow now adds the image's version tag" "$out"
releases v1.0.0:full "v1.1.0:pre:Other notes"
rec image '.taken_at = "2026-11-19T14:00:00Z"'
run promote v1.1.0 --ran "$T/rec.json" --apply
check_has "promote: other notes keep their text, under the line" "notes: Promoted on $(date -u +%Y-%m-%d), after one of our own agents had run it cleanly for 3 hours.||Other notes|" "$calls"
releases v1.2.0:full v1.1.0:pre
rec image
run promote v1.1.0 --ran "$T/rec.json" --apply
check_has "promote an older one: the higher stays the latest" "--prerelease=false --latest=false" "$calls"
releases v1.0.0:full "v1.1.0:pre:WITHDRAWN: bad\n\nnotes"
run promote v1.1.0 --ran "$T/rec.json" --apply
check_eq "promote a withdrawn one: refused" "$rc" "2"
check_eq "promote a withdrawn one: nothing changed" "$calls" ""
releases v1.0.0:full v1.1.0:full
run promote v1.1.0 --ran "$T/rec.json" --apply
check_eq "promote a full release: nothing to do (exit 0)" "$rc" "0"
check_has "promote a full release: says so" "is a full release already: nothing to do" "$out"
check_eq "promote a full release: nothing changed" "$calls" ""

# What the record must show, each alone: the release refused and left as it is.
refused() { # name kind filter wanted [extra args]
  releases v1.0.0:full v1.1.0:pre
  rec "$2" "$3"
  run promote v1.1.0 --ran "$T/rec.json" --apply "${@:5}"
  check_eq "$1: refused" "$rc" "2"
  check_has "$1: says why" "$4" "$out"
  check_eq "$1: nothing changed" "$calls" ""
}
refused "another version" image '.version = "1.0.0"' "the agent runs 1.0.0, not 1.1.0"
refused "no version" image '.version = null' "the agent runs an unknown version, not 1.1.0"
refused "not running" image '.running = false' "it is not running"
refused "started again" image '.restarts = 1' "it was started again (1 restarts)"
refused "restarts unknown" checkout '.restarts = null' "it was started again (unknown restarts)"
refused "up too short" image '.up_since = "2026-11-19T12:00:00Z"' "it was up 30 minutes, under 60"
refused "no start time" image '.up_since = null' "the record has no time it was taken or started"
refused "no time taken" image '.taken_at = ""' "the record has no time it was taken or started"
refused "a longer --min-up" image '.' "it was up 90 minutes, under 120" --min-up 120
refused "state not running" image '.status.state = "connecting"' "gp status is not clean: state connecting"
refused "relay refused" image '.status.relay = "refused-not-member"' "relay refused-not-member"
refused "Claude not active" image '.status.claude = "not-active"' "claude not-active"
refused "an error" image '.status.error = "relay-refused"' "error relay-refused"
refused "no status" image '.status = {}' "gp status is not clean"
refused "another image" image '.image.reference = "ghcr.io/acme/widget:1.1.0" | .image.repo_digests = ["ghcr.io/acme/widget@'"$OTHER"'"]' "its image is not the release's ($DIGEST)"
refused "another commit" checkout ".commit = \"$(printf 'b%.0s' $(seq 40))\"" "the checkout is at bbbbbbbbbbbb, not v1.1.0's commit aaaaaaaaaaaa"
refused "changed files" checkout '.changed = true' "the checkout has changed files"
refused "the unit is not running" checkout '.unit = {"active_state":"activating","sub_state":"auto-restart"}' "its unit is activating/auto-restart"
refused "another kind of record" image '.record = "something-else"' "is not one ran-clean made"
refused "an unknown install" image '.install = "other"' "neither image nor checkout"
printf 'not json' >"$T/bad.json"
releases v1.0.0:full v1.1.0:pre
run promote v1.1.0 --ran "$T/bad.json" --apply
check_eq "a record that is not JSON: refused" "$rc" "2"
run promote v1.1.0 --ran "$T/nowhere.json" --apply
check_eq "a record that is not there: refused" "$rc" "2"
run promote v1.1.0 --ran "$T/rec.json" --min-up 1h
check_eq "--min-up that is not minutes: refused" "$rc" "2"
rec image '.up_since = "2026-11-19T12:00:00Z"'
run promote v1.1.0 --ran "$T/rec.json" --min-up 30
check_eq "--min-up 30 lets 30 minutes through" "$rc" "0"
# Every reason at once is listed.
rec image '.version = "1.0.0" | .restarts = 2 | .status.relay = "unreachable"'
run promote v1.1.0 --ran "$T/rec.json"
check_has "several reasons: the version" "not clean: the agent runs 1.0.0" "$out"
check_has "several reasons: the restarts" "not clean: it was started again (2 restarts)" "$out"
check_has "several reasons: the status" "relay unreachable" "$out"
# The image matched three ways: the reference, the id (the containerd store's), a registry digest.
for how in '.image.repo_digests = [] | .image.id = "sha256:0"' '.image.reference = "x" | .image.id = "sha256:0"' '.image.reference = "x" | .image.repo_digests = [] | .image.id = "'$DIGEST'"'; do
  rec image "$how"
  run promote v1.1.0 --ran "$T/rec.json"
  check_eq "the release's image found by one field alone ($how)" "$rc" "0"
done
rec checkout
run promote v1.1.0 --ran "$T/rec.json"
check_eq "a clean checkout at the tag's commit: ok" "$rc" "0"
rec image
getsh 1.1.0 "$OTHER"
run promote v1.1.0 --ran "$T/rec.json"
check_eq "the get.sh pins another digest: refused" "$rc" "2"
rm -f "$GETSH"
run promote v1.1.0 --ran "$T/rec.json"
check_eq "no get.sh in the release: refused" "$rc" "2"
check_has "no get.sh: says so" "cannot read the one image the get.sh of v1.1.0 pins" "$out"
getsh 1.1.0
TAG_COMMIT="" rec checkout
TAG_COMMIT="" run promote v1.1.0 --ran "$T/rec.json"
check_eq "the tag's commit cannot be read: refused" "$rc" "2"

# Refusals.
releases v1.0.0:full
run withdraw v1.0.0
check_eq "withdraw with no reason: refused" "$rc" "2"
run withdraw v9.9.9 --reason x
check_eq "an unknown release: refused" "$rc" "2"
run withdraw 1.0.0 --reason x
check_eq "a tag without the v: refused" "$rc" "2"
run frobnicate v1.0.0
check_eq "an unknown action: refused" "$rc" "2"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
