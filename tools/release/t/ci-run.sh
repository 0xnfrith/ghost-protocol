#!/usr/bin/env bash
# The tests of tools/release/ci/run, in a temporary repository, with stand-in docker, gh and uname (no network, no secret, no build).
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0
fail=0
check_eq() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1"; printf '      got:  %s\n      want: %s\n' "${2//$'\n'/ | }" "${3//$'\n'/ | }"; fi; }
check_has() { if grep -qF -e "$2" <<<"$3"; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1"; printf '      wanted: %s\n      in:     %s\n' "$2" "${3//$'\n'/ | }"; fi; }
check_not() { if grep -qF -e "$2" <<<"$3"; then fail=$((fail + 1)); echo "FAIL  $1"; printf '      did not want: %s\n' "$2"; else pass=$((pass + 1)); echo "ok    $1"; fi; }
for tool in git jq sha256sum; do command -v "$tool" >/dev/null || { echo "SKIP  $tool is not installed"; exit 0; }; done
export GIT_AUTHOR_NAME="Dev" GIT_AUTHOR_EMAIL="dev@example.com" GIT_COMMITTER_NAME="Dev" GIT_COMMITTER_EMAIL="dev@example.com"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

DIGEST=sha256:$(printf 'c%.0s' $(seq 64))
export S=$T/stub CALLS=$T/stub/calls STDIN_LOG=$T/stub/stdin
mkdir -p "$T/bin"
# The stand-in docker. State (the tags the registry has) is the file $S/pushed, one reference a line (a reference by digest is
# there once any tag is); what the image holds is set by STUB_* variables.
cat >"$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$CALLS"
case "$1 $2" in
  "buildx imagetools")
    [ -s "$S/pushed" ] || exit 1
    case $4 in *@sha256:*) ;; *) grep -qxF -e "$4" "$S/pushed" || exit 1 ;; esac
    case " $* " in
      *" --raw "*) printf '%s\n' "$STUB_INDEX" ;;
      *--format*) printf '{"digest":"%s"}\n' "$STUB_DIGEST" ;;
    esac ;;
  "buildx inspect") [ -f "$S/builder" ] ;;
  "buildx create") touch "$S/builder" ;;
  "buildx rm") rm -f "$S/builder" ;;
  "buildx build") printf '%s\n' "$@" | sed -n '/^--tag$/{n;p;}' >>"$S/pushed" ;;
  "image inspect") printf '{"Labels":{"org.opencontainers.image.version":"%s"},"Env":["GP_IMAGE_VERSION=%s"%s]}\n' "${STUB_LABEL:-$STUB_VERSION}" "$STUB_VERSION" "${STUB_REPO_ENV-,\"GP_IMAGE_REPO=localhost:5000/acme/ghost-protocol\"}" ;;
  "login "*) cat >"$STDIN_LOG" ;;
  "image rm") [ -f "$S/local" ] && rm -f "$S/local" ;;
  "pull "*) # like the classic image store: one platform per digest, and no pull of another one over it
    plat=$(printf '%s\n' "$@" | sed -n '/^--platform$/{n;p;}')
    if [ -f "$S/local" ] && [ "$(cat "$S/local")" != "$plat" ]; then echo "cannot overwrite digest" >&2; exit 1; fi
    echo "$plat" >"$S/local" ;;
  "run --privileged") mkdir -p "$GP_BINFMT_DIR"; printf 'enabled\ninterpreter /usr/bin/qemu-aarch64\nflags: F\n' >"$GP_BINFMT_DIR/qemu-aarch64" ;;
  "run --rm")
    plat=$(printf '%s\n' "$@" | sed -n '/^--platform$/{n;p;}')
    [ "$(cat "$S/local" 2>/dev/null)" = "$plat" ] || { echo "stub docker: no local $plat image" >&2; exit 125; }
    case " $* " in
      *" slug "*) echo "GP_SLUG=release-probe" ;;
      *" claude "*) echo "2.1.0 (Claude Code)" ;;
    esac ;;
  *) echo "stub docker: unexpected $*" >&2; exit 1 ;;
esac
STUB
cat >"$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
echo "gh $*" >>"$CALLS"
if [ "$1 $2" = "release view" ] && [ -f "$S/release" ]; then
  printf '{"isPrerelease":%s}\n' "$([ "$(cat "$S/release")" = full ] && echo false || echo true)"
  exit 0
fi
[ "$1 $2" = "release view" ] && exit 1
exit 0
STUB
printf '#!/bin/sh\necho "${STUB_UNAME:-x86_64}"\n' >"$T/bin/uname"
chmod +x "$T/bin/docker" "$T/bin/gh" "$T/bin/uname"
export PATH="$T/bin:$PATH"

# world <version>: a clone of a repository at version <version>, tagged v<version>, with the tool and the installers.
world() {
  rm -rf "$T/w" "$S"
  mkdir -p "$S" "$T/w/.claude-plugin" "$T/w/docker" "$T/w/tools/release/ci"
  cd "$T/w" || exit 1
  git init -q -b main
  printf '{"name":"x","version":"%s"}\n' "$1" >.claude-plugin/plugin.json
  cp "$ROOT/docker/get.sh" "$ROOT/docker/get.ps1" docker/
  printf 'FROM scratch\n' >docker/Dockerfile
  cp "$ROOT/tools/release/agree" tools/release/
  cp "$ROOT/tools/release/ci/run" tools/release/ci/
  git add -A
  git commit -q -m "Start at $1"
  git commit -q --allow-empty -m "A later change"
  git tag -a "v$1" -m "Release v$1"
  export STUB_VERSION=$1 STUB_DIGEST=$DIGEST GP_BINFMT_DIR=$T/binfmt
  rm -rf "$T/binfmt" "$T/out"
  unset STUB_LABEL STUB_UNAME STUB_REPO_ENV
  export STUB_INDEX='{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}},{"platform":{"os":"linux","architecture":"arm64"}}]}'
}
run() { # env assignments... are in the caller's environment
  out=$(GP_RELEASE_TAG=${GP_RELEASE_TAG:-v$STUB_VERSION} GP_RELEASE_REPO=Acme/Ghost-Protocol GP_RELEASE_REGISTRY=localhost:5000 GP_RELEASE_OUT=$T/out GH_TOKEN=tok-not-a-secret-123 \
    "$T/w/tools/release/ci/run" 2>&1)
  rc=$?
  calls=$(cat "$CALLS" 2>/dev/null || true)
}

# A full run, to a registry without sign-in and without a GitHub release.
world 1.2.3
GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 run
check_eq "a full run: exit 0" "$rc" "0"
check_has "arm64 emulation is registered when it is not" "run --privileged --rm tonistiigi/binfmt@sha256:" "$calls"
check_has "the emulation image is named by digest, with --install arm64" "--install arm64" "$calls"
check_has "one build for both platforms, pushed" "--platform linux/amd64,linux/arm64" "$calls"
check_has "the build carries the version" "--build-arg GP_IMAGE_VERSION=1.2.3" "$calls"
check_has "the build carries the repository it is pushed to, for the release check" "--build-arg GP_IMAGE_REPO=localhost:5000/acme/ghost-protocol " "$calls"
check_has "the image's GP_IMAGE_REPO is checked after the build" "the image checks localhost:5000/acme/ghost-protocol for newer releases" "$out"
check_has "the image name is in lower case, pushed as pre-<version>" "--tag localhost:5000/acme/ghost-protocol:pre-1.2.3 --push" "$calls"
check_not "not pushed as the plain version, which every install's release check offers" "--tag localhost:5000/acme/ghost-protocol:1.2.3 " "$calls"
check_eq "the registry has the pre- tag alone" "$(cat "$S/pushed")" "localhost:5000/acme/ghost-protocol:pre-1.2.3"
check_has "the plan says where it goes, and the version once promoted" "image localhost:5000/acme/ghost-protocol:pre-1.2.3 (linux/amd64,linux/arm64; localhost:5000/acme/ghost-protocol:1.2.3 once promoted)" "$out"
check_has "the platforms are read by digest" "buildx imagetools inspect localhost:5000/acme/ghost-protocol@$DIGEST --raw" "$calls"
check_has "the arm64 image is started" "run --rm --pull never --platform linux/arm64 localhost:5000/acme/ghost-protocol@$DIGEST gp slug release-probe" "$calls"
check_has "the arm64 image is pulled anew, after the amd64 one is dropped (the classic store holds one platform per digest)" "pull --quiet --platform linux/arm64 localhost:5000/acme/ghost-protocol@$DIGEST" "$calls"
check_eq "the local copy is dropped before each of the three pulls" "$(grep -c "^docker image rm localhost:5000/acme/ghost-protocol@$DIGEST" "$CALLS")" "3"
check_has "claude is started in the arm64 image" "--platform linux/arm64 --entrypoint claude" "$calls"
check_has "get.sh has the image and digest" "IMAGE=\"\${GP_IMAGE:-localhost:5000/acme/ghost-protocol:1.2.3@$DIGEST}\"" "$(cat "$T/out/get.sh")"
check_has "get.ps1 has the image and digest" "'localhost:5000/acme/ghost-protocol:1.2.3@$DIGEST'" "$(cat "$T/out/get.ps1")"
check_eq "no placeholder is left in the files" "$(grep -c '@GP_IMAGE@' "$T/out/get.sh" "$T/out/get.ps1" | tr '\n' ' ')" "$T/out/get.sh:0 $T/out/get.ps1:0 "
check_eq "get.sh keeps its execute bit" "$([ -x "$T/out/get.sh" ] && echo yes)" "yes"
check_eq "SHA256SUMS checks out" "$(cd "$T/out" && sha256sum -c SHA256SUMS >/dev/null 2>&1 && echo yes)" "yes"
check_has "the notes name the image and its digest" "localhost:5000/acme/ghost-protocol:1.2.3@$DIGEST" "$(cat "$T/out/release-notes.md")"
check_has "the notes list what changed" "- A later change" "$(cat "$T/out/release-notes.md")"
check_has "agree ran at the end and passed" "all that was given agree" "$out"
check_not "no GitHub release was made" "gh release" "$calls"

# Sign-in and the GitHub release: the token goes by stdin and never into a command line; the release is a pre-release.
world 1.2.3
run
check_eq "with sign-in and release: exit 0" "$rc" "0"
check_eq "the token went to docker login by stdin" "$(cat "$STDIN_LOG")" "tok-not-a-secret-123"
check_not "the token is in no command line" "tok-not-a-secret" "$calls"
check_not "the token is not in the output" "tok-not-a-secret" "$out"
check_has "the release is created as a pre-release, on the tag" "gh release create v1.2.3 --repo Acme/Ghost-Protocol --verify-tag --prerelease" "$calls"
check_has "the three files are attached" "$T/out/get.sh $T/out/get.ps1 $T/out/SHA256SUMS" "$calls"

# A release that exists is updated, not made again; one that was promoted is left as it is.
world 1.2.3
echo pre >"$S/release"
GP_RELEASE_LOGIN=0 run
check_has "an existing release: notes edited" "gh release edit v1.2.3" "$calls"
check_has "an existing release: files replaced" "gh release upload v1.2.3 --repo Acme/Ghost-Protocol --clobber" "$calls"
check_not "an existing release: not created again" "gh release create" "$calls"
world 1.2.3
echo full >"$S/release"
GP_RELEASE_LOGIN=0 run
check_eq "a promoted release: exit 0" "$rc" "0"
check_has "a promoted release: said so" "exists and was promoted: left as it is" "$out"
check_not "a promoted release: its notes are not edited" "gh release edit" "$calls"
check_not "a promoted release: its files are not replaced" "gh release upload" "$calls"

# Emulation already there (an aarch64 entry, enabled, with the F flag): not registered again. On an arm64 machine: not needed.
world 1.2.3
mkdir -p "$GP_BINFMT_DIR"
printf 'enabled\ninterpreter /usr/bin/qemu-aarch64\nflags: F\n' >"$GP_BINFMT_DIR/qemu-aarch64"
GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 run
check_eq "emulation registered already: exit 0" "$rc" "0"
check_not "emulation registered already: not registered again" "run --privileged" "$calls"
world 1.2.3
mkdir -p "$GP_BINFMT_DIR"
printf 'enabled\ninterpreter /usr/bin/qemu-aarch64\nflags: OC\n' >"$GP_BINFMT_DIR/qemu-aarch64"
GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 run
check_has "an entry without the F flag does not count" "run --privileged" "$calls"
world 1.2.3
STUB_UNAME=aarch64 GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 run
check_not "an arm64 machine registers nothing" "run --privileged" "$calls"

# An image already at the pre- tag, or at the plain one (promoted, or released before the pre- tag), is kept.
for at in pre-1.2.3 1.2.3; do
  world 1.2.3
  echo "localhost:5000/acme/ghost-protocol:$at" >"$S/pushed"
  GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 run
  check_eq "an image at $at: exit 0" "$rc" "0"
  check_not "an image at $at: not rebuilt" "buildx build" "$calls"
  check_has "an image at $at: said so" "localhost:5000/acme/ghost-protocol:$at is already in the registry" "$out"
  check_has "an image at $at: the files still pin the version" "localhost:5000/acme/ghost-protocol:1.2.3@$DIGEST" "$(cat "$T/out/get.sh")"
done
world 1.2.3
echo "localhost:5000/acme/ghost-protocol:1.2.4" >"$S/pushed"
GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 run
check_has "an image at another version's tag: built" "buildx build" "$calls"

# A dry run builds and pushes nothing.
world 1.2.3
GP_RELEASE_DRY=1 run
check_eq "a dry run: exit 0" "$rc" "0"
check_has "a dry run: prints the plan" "dry run: nothing built, pushed or published" "$out"
check_eq "a dry run: calls nothing" "$calls" ""
check_eq "a dry run: writes nothing" "$([ -e "$T/out" ] && echo yes || echo no)" "no"

# Refusals.
world 1.2.3
GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 STUB_LABEL=9.9.9 run
check_eq "the image label differs: refused" "$rc" "1"
check_has "the image label differs: named" "DIFFERS  image label" "$out"
world 1.2.3
GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 STUB_REPO_ENV="" run
check_eq "the image has no GP_IMAGE_REPO: refused" "$rc" "2"
check_has "no GP_IMAGE_REPO: named" "GP_IMAGE_REPO is '', not localhost:5000/acme/ghost-protocol" "$out"
world 1.2.3
GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 STUB_REPO_ENV=',"GP_IMAGE_REPO=ghcr.io/other/ghost-protocol"' run
check_eq "the image checks another repository: refused" "$rc" "2"
world 1.2.3
GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 STUB_INDEX='{"manifests":[{"platform":{"os":"linux","architecture":"amd64"}}]}' run
check_eq "only one platform in the image: refused" "$rc" "2"
check_has "only one platform: named" "not linux/amd64 and linux/arm64" "$out"
world 1.2.3
git -C "$T/w" commit -q --allow-empty -m "after the tag"
GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 run
check_eq "HEAD is not the tag: refused" "$rc" "2"
check_eq "refused before docker is called" "$calls" ""
world 1.2.3
printf '{"name":"x","version":"1.2.4"}\n' >"$T/w/.claude-plugin/plugin.json"
git -C "$T/w" commit -q -am "bump" && git -C "$T/w" tag -a v1.2.3-x -m x
GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 GP_RELEASE_TAG=v1.2.3-x run
check_eq "the tag differs from plugin.json: refused" "$rc" "1"
world 1.2.3
mkdir -p "$T/out" && touch "$T/out/old"
GP_RELEASE_LOGIN=0 GP_RELEASE_GITHUB=0 run
check_eq "an output folder with files in it: refused" "$rc" "2"
world 1.2.3
GP_RELEASE_TAG=1.2.3 run
check_eq "a tag without the v: refused" "$rc" "2"

# What it carries: the pin of the emulation image is a digest, and holds no 64-hex string for the scan to take for a key.
pin=$(grep '^BINFMT_IMAGE=' "$ROOT/tools/release/ci/run")
check_eq "the emulation pin has no 64-hex run" "$(grep -cE '[0-9a-f]{64}' <<<"$pin")" "0"
joined=$(bash -c "$pin; echo \"\$BINFMT_IMAGE\"")
check_eq "the emulation pin joins to a sha256 digest" "$(grep -cE '^tonistiigi/binfmt@sha256:[0-9a-f]{64}$' <<<"$joined")" "1"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
