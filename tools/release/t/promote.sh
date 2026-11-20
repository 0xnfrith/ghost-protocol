#!/usr/bin/env bash
# The tests of tools/release/ci/promote, with stand-in docker and gh (no network, no secret): the plain version tag is added
# only to a promoted release, to the digest its get.sh pins, never moved, and the token goes by stdin alone.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
PROMOTE=$ROOT/tools/release/ci/promote
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0
fail=0
check_eq() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1"; printf '      got:  %s\n      want: %s\n' "${2//$'\n'/ | }" "${3//$'\n'/ | }"; fi; }
check_has() { if grep -qF -e "$2" <<<"$3"; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1"; printf '      wanted: %s\n      in:     %s\n' "$2" "${3//$'\n'/ | }"; fi; }
check_not() { if grep -qF -e "$2" <<<"$3"; then fail=$((fail + 1)); echo "FAIL  $1"; printf '      did not want: %s\n' "$2"; else pass=$((pass + 1)); echo "ok    $1"; fi; }
command -v jq >/dev/null || { echo "SKIP  jq is not installed"; exit 0; }

DIGEST=sha256:$(printf 'c%.0s' $(seq 64))
OTHER=sha256:$(printf 'e%.0s' $(seq 64))
IMG=ghcr.io/acme/ghost-protocol
export S=$T/stub CALLS=$T/stub/calls
mkdir -p "$T/bin"
# The stand-in registry: $S/digests, the manifests it holds (one digest a line); $S/tags, "<reference> <digest>" a line.
cat >"$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$CALLS"
case "$1 $2 $3" in
  "login "*) cat >"$S/stdin" ;;
  "buildx imagetools inspect")
    case $4 in
      *@sha256:*) d=${4##*@}; grep -qxF -e "$d" "$S/digests" 2>/dev/null || exit 1 ;;
      *) d=$(awk -v r="$4" '$1 == r { print $2 }' "$S/tags" 2>/dev/null); [ -n "$d" ] || exit 1 ;;
    esac
    printf '{"digest":"%s"}\n' "$d" ;;
  "buildx imagetools create")
    [ "$4" = --tag ] || exit 1
    echo "$5 ${STUB_WRITES:-${6##*@}}" >>"$S/tags" ;;
  *) echo "stub docker: unexpected $*" >&2; exit 1 ;;
esac
STUB
cat >"$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >>"$CALLS"
case "$1 $2" in
  "release view") [ -f "$S/release.json" ] && cat "$S/release.json" || exit 1 ;;
  "release download") [ -f "$S/get.sh" ] && cat "$S/get.sh" || exit 1 ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$T/bin/docker" "$T/bin/gh"
export PATH="$T/bin:$PATH"

# world <pre|full|draft|withdrawn> [pinned reference]: a release of v1.2.3 whose get.sh pins the reference, and a registry
# that holds $DIGEST under pre-1.2.3.
world() {
  rm -rf "$S"
  mkdir -p "$S"
  case $1 in
    pre) printf '{"isPrerelease":true,"isDraft":false,"body":"notes"}\n' ;;
    full) printf '{"isPrerelease":false,"isDraft":false,"body":"notes"}\n' ;;
    draft) printf '{"isPrerelease":false,"isDraft":true,"body":"notes"}\n' ;;
    withdrawn) printf '{"isPrerelease":false,"isDraft":false,"body":"WITHDRAWN: bad\\n\\nnotes"}\n' ;;
  esac >"$S/release.json"
  printf '#!/bin/sh\nIMAGE="${GP_IMAGE:-%s}"\n' "${2:-$IMG:1.2.3@$DIGEST}" >"$S/get.sh"
  echo "$DIGEST" >"$S/digests"
  echo "$IMG:pre-1.2.3 $DIGEST" >"$S/tags"
}
run() {
  out=$(GP_RELEASE_TAG=${GP_RELEASE_TAG:-v1.2.3} GP_RELEASE_REPO=Acme/Ghost-Protocol GH_TOKEN=tok-not-a-secret-123 "$PROMOTE" 2>&1)
  rc=$?
  calls=$(cat "$CALLS" 2>/dev/null || true)
}
tagged() { awk -v r="$IMG:1.2.3" '$1 == r { print $2 }' "$S/tags"; }

# A promoted release: the plain tag is added to its digest.
world full
run
check_eq "promoted: exit 0" "$rc" "0"
check_has "promoted: says what it pins" "v1.2.3 pins $IMG:1.2.3@$DIGEST" "$out"
check_has "promoted: tags the digest as the version" "docker buildx imagetools create --tag $IMG:1.2.3 $IMG@$DIGEST" "$calls"
check_eq "promoted: the version tag names the release's digest" "$(tagged)" "$DIGEST"
check_has "promoted: read back" "$IMG:1.2.3 is $DIGEST" "$out"
check_eq "the token went to docker login by stdin" "$(cat "$S/stdin")" "tok-not-a-secret-123"
check_not "the token is in no command line" "tok-not-a-secret" "$calls"
check_not "the token is not in the output" "tok-not-a-secret" "$out"
check_has "the get.sh read is the release's" "gh release download v1.2.3 --repo Acme/Ghost-Protocol --pattern get.sh" "$calls"

# Again: the tag is there for this digest, nothing to do.
run
check_eq "again: exit 0" "$rc" "0"
check_has "again: nothing to do" "is already $DIGEST: nothing to do" "$out"
check_eq "again: one create in all" "$(grep -c 'imagetools create' "$CALLS")" "1"

# Never moved: the version tag is there for another digest.
world full
echo "$IMG:1.2.3 $OTHER" >>"$S/tags"
run
check_eq "a version tag for another digest: refused" "$rc" "2"
check_has "a version tag for another digest: says a tag is never moved" "a tag is never moved" "$out"
check_not "a version tag for another digest: nothing created" "imagetools create" "$calls"

# Not promoted, or not one to promote: refused, nothing tagged.
for kind in pre draft withdrawn; do
  world "$kind"
  run
  check_eq "a $kind release: refused" "$rc" "2"
  check_not "a $kind release: nothing tagged" "imagetools create" "$calls"
  check_eq "a $kind release: no version tag" "$(tagged)" ""
done
world pre
run
check_has "a pre-release: says it waits for the promotion" "is still a pre-release" "$out"
world full
rm "$S/release.json"
run
check_eq "no release: refused" "$rc" "2"

# What get.sh pins.
world full "$IMG:1.2.4@$DIGEST"
run
check_eq "get.sh pins another version: refused" "$rc" "2"
world full "ghcr.io/someone/ghost-protocol:1.2.3@$DIGEST"
run
check_eq "get.sh pins another image: refused" "$rc" "2"
world full "$IMG:1.2.3"
run
check_eq "get.sh pins no digest: refused" "$rc" "2"
world full "@GP_IMAGE@"
run
check_eq "get.sh not filled in: refused" "$rc" "2"
world full
rm "$S/get.sh"
run
check_eq "no get.sh: refused" "$rc" "2"
world full "$IMG:1.2.3@$OTHER"
run
check_eq "the pinned digest is not in the registry: refused" "$rc" "2"
check_has "the pinned digest is not in the registry: says so" "$IMG@$OTHER is not in the registry" "$out"
check_not "the pinned digest is not in the registry: nothing tagged" "imagetools create" "$calls"

# A tag that does not read back as the digest.
world full
STUB_WRITES=$OTHER run
check_eq "a tag that reads back as another digest: refused" "$rc" "2"

# A dry run tags nothing.
world full
GP_RELEASE_DRY=1 run
check_eq "a dry run: exit 0" "$rc" "0"
check_has "a dry run: says what it would do" "would: tag $IMG@$DIGEST as $IMG:1.2.3" "$out"
check_not "a dry run: nothing tagged" "imagetools create" "$calls"

# A local proof: no GitHub release, the digest given, no sign-in.
world pre
rm "$S/release.json" "$S/get.sh"
GP_RELEASE_GITHUB=0 GP_RELEASE_LOGIN=0 GP_RELEASE_DIGEST=$DIGEST run
check_eq "no GitHub: exit 0" "$rc" "0"
check_not "no GitHub: gh not used" "gh " "$calls"
check_not "no GitHub, no sign-in" "docker login" "$calls"
check_eq "no GitHub: tagged" "$(tagged)" "$DIGEST"
world pre
GP_RELEASE_GITHUB=0 GP_RELEASE_LOGIN=0 GP_RELEASE_DIGEST=sha256:short run
check_eq "no GitHub, a bad digest: refused" "$rc" "2"

# Usage.
world full
GP_RELEASE_TAG=1.2.3 run
check_eq "a tag without the v: refused" "$rc" "2"
out=$(GP_RELEASE_TAG=v1.2.3 GITHUB_REPOSITORY="" GP_RELEASE_REPO="" "$PROMOTE" 2>&1)
check_eq "no repository: refused" "$?" "2"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
