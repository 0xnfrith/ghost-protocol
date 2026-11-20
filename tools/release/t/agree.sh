#!/usr/bin/env bash
# The tests of tools/release/agree: a version that differs in one place fails, each place on its own. No network, no secret.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
AGREE=$ROOT/tools/release/agree
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0
fail=0
check_eq() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1"; printf '      got:  %s\n      want: %s\n' "$2" "$3"; fi; }
check_has() { if grep -qF -e "$2" <<<"$3"; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1"; printf '      wanted: %s\n      in:     %s\n' "$2" "${3//$'\n'/ | }"; fi; }
command -v jq >/dev/null || { echo "SKIP  jq is not installed"; exit 0; }

D1=sha256:$(printf 'a%.0s' $(seq 64))
D2=sha256:$(printf 'b%.0s' $(seq 64))
# tree <version>: a checkout of a tag's tree, and the two installers filled in for <version> with digest D1.
tree() {
  rm -rf "$T/tree"
  mkdir -p "$T/tree/.claude-plugin"
  printf '{"name":"x","version":"%s"}\n' "$1" >"$T/tree/.claude-plugin/plugin.json"
  installers "$1" "$D1"
}
installers() { # version digest
  printf '#!/bin/sh\nset -eu\n\nIMAGE="${GP_IMAGE:-localhost:5000/acme/ghost-protocol:%s@%s}"\n' "$1" "$2" >"$T/get.sh"
  printf '$Image = if ($env:GP_IMAGE) { $env:GP_IMAGE } else { '"'"'ghcr.io/acme/ghost-protocol:%s@%s'"'"' }\n' "$1" "$2" >"$T/get.ps1"
}
run() { out=$("$AGREE" "$@" 2>&1); rc=$?; }
full=(--tree "$T/tree" --image-version 1.2.3 --image-digest "$D1" --get-sh "$T/get.sh" --get-ps1 "$T/get.ps1")

tree 1.2.3
run --tag v1.2.3 "${full[@]}"
check_eq "everything agrees: exit 0" "$rc" "0"
check_has "everything agrees: says so" "all that was given agree" "$out"

run --tag v1.2.3 --tree "$T/tree"
check_eq "only the tag and plugin.json given: exit 0" "$rc" "0"
check_has "what is not given is said so" "skipped  the image label (not given)" "$out"

run --tag v1.2.4 "${full[@]}"
check_eq "the tag differs from plugin.json: exit 1" "$rc" "1"
check_has "the tag differs: plugin.json is named" "DIFFERS  plugin.json version is '1.2.3', the tag says 1.2.4" "$out"

run --tag v1.2.3 "${full[@]/1.2.3/1.2.2}"
check_eq "the label differs: exit 1" "$rc" "1"
check_has "the label differs: named" "DIFFERS  image label org.opencontainers.image.version is '1.2.2'" "$out"

tree 1.2.3
installers 1.2.2 "$D1"
run --tag v1.2.3 "${full[@]}"
check_eq "the installers' pin differs in version: exit 1" "$rc" "1"
check_has "get.sh named" "DIFFERS  get.sh pins the image version is '1.2.2'" "$out"
check_has "get.ps1 named" "DIFFERS  get.ps1 pins the image version is '1.2.2'" "$out"

installers 1.2.3 "$D2"
run --tag v1.2.3 "${full[@]}"
check_eq "the installers' pin differs in digest: exit 1" "$rc" "1"
check_has "digest named" "DIFFERS  get.sh pins a digest that is not the pushed image's" "$out"

# An installer that was not filled in.
cp "$ROOT/docker/get.sh" "$T/get.sh"
run --tag v1.2.3 "${full[@]}"
check_eq "an installer with its placeholder: exit 1" "$rc" "1"
check_has "placeholder named" "DIFFERS  get.sh: the image is not filled in" "$out"

# A pre-release tag, and a tag that is not a version.
tree 1.3.0-rc.1
run --tag v1.3.0-rc.1 --tree "$T/tree" --get-sh "$T/get.sh" --get-ps1 "$T/get.ps1" --image-version 1.3.0-rc.1
check_has "a pre-release tag: the installers (still on 1.3.0-rc.1 files) agree" "plugin.json version is 1.3.0-rc.1" "$out"
check_eq "a pre-release: exit 0" "$rc" "0"
run --tag 1.2.3 --tree "$T/tree"
check_eq "a tag without the v: exit 2" "$rc" "2"
run --tree "$T/tree"
check_eq "no tag: exit 2" "$rc" "2"
run --tag v1.3.0-rc.1 --tree "$T/nowhere"
check_eq "no plugin.json: exit 2" "$rc" "2"
run --tag v1.3.0-rc.1 --tree "$T/tree" --image-digest sha256:short
check_eq "a bad digest: exit 2" "$rc" "2"

# The image read with docker: a stand-in that answers `docker image inspect`.
mkdir "$T/bin"
cat >"$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
[ "$1 $2" = "image inspect" ] || exit 1
printf '%s\n' "$STUB_CONFIG"
STUB
chmod +x "$T/bin/docker"
tree 1.3.0-rc.1
cfg() { printf '{"Labels":{"org.opencontainers.image.version":"%s"},"Env":["PATH=/x","GP_IMAGE_VERSION=%s"]}' "$1" "$2"; }
STUB_CONFIG=$(cfg 1.3.0-rc.1 1.3.0-rc.1) PATH="$T/bin:$PATH" run --tag v1.3.0-rc.1 --tree "$T/tree" --image ghost-protocol:test
check_eq "--image: label and environment agree: exit 0" "$rc" "0"
STUB_CONFIG=$(cfg 1.3.0-rc.1 dev) PATH="$T/bin:$PATH" run --tag v1.3.0-rc.1 --tree "$T/tree" --image ghost-protocol:test
check_eq "--image: the environment differs: exit 1" "$rc" "1"
check_has "--image: the environment is named" "DIFFERS  image environment GP_IMAGE_VERSION is 'dev'" "$out"
STUB_CONFIG=$(cfg dev 1.3.0-rc.1) PATH="$T/bin:$PATH" run --tag v1.3.0-rc.1 --tree "$T/tree" --image ghost-protocol:test
check_eq "--image: the label differs: exit 1" "$rc" "1"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
