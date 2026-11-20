#!/bin/sh
# get.sh: install a GHOST Protocol agent on this machine (Linux or macOS), with Docker.
#
#   curl -fsSL <release>/get.sh | sh -s -- --name "<agent name>" --relay <relay url> --owner <owner public key> [--updater yes|no]
#
# A thin wrapper: every step is a docker command, and all the logic is in the
# image. It pulls the image, runs its init in a new data volume (the agent's
# key is made there and never leaves it), starts the agent's container, and
# prints the agent's public key as one line, GP_AGENT_PUBKEY=<64 hex>.
# Then: give the agent its owner's tag (gp auth-tag set) and a Claude sign-in
# (gp claude login, or gp claude token); see the quick start.
# --updater yes also starts the update helper, gp-<slug>.updater: a second
# container from the same image that holds the Docker socket and swaps in new
# versions when the agent's owner says yes. Without --updater it asks, when
# there is a terminal to ask on; with none it keeps what an earlier install
# chose (a helper there is moved onto this image), else starts none.
#   GP_IMAGE    the image (the release fills it in)
#   GP_NO_PULL  1: use the image already on this machine
set -eu

IMAGE="${GP_IMAGE:-@GP_IMAGE@}"
case "$IMAGE" in @*@) echo "get.sh: set GP_IMAGE to the image to install (the release's get.sh has it filled in)" >&2; exit 2 ;; esac

name="" relay="" owner="" updater=""
while [ $# -gt 0 ]; do
    case "$1" in
        --name) name="${2:-}"; shift 2 || exit 2 ;;
        --relay) relay="${2:-}"; shift 2 || exit 2 ;;
        --owner) owner="${2:-}"; shift 2 || exit 2 ;;
        --updater) updater="${2:-}"; shift 2 || exit 2 ;;
        *) echo "get.sh: unknown argument $1" >&2; echo "usage: get.sh --name <agent name> --relay <relay url> --owner <owner public key> [--updater yes|no]" >&2; exit 2 ;;
    esac
done
if [ -z "$name" ] || [ -z "$relay" ] || [ -z "$owner" ]; then echo "usage: get.sh --name <agent name> --relay <relay url> --owner <owner public key> [--updater yes|no]" >&2; exit 2; fi
case "$updater" in ""|yes|no) ;; *) echo "get.sh: --updater is yes or no" >&2; exit 2 ;; esac

command -v docker >/dev/null 2>&1 || { echo "get.sh: docker is not installed; install Docker (Docker Desktop on macOS) first" >&2; exit 1; }
docker version --format '{{.Server.Version}}' >/dev/null 2>&1 || { echo "get.sh: Docker is not running; start it (Docker Desktop on macOS) and try again" >&2; exit 1; }

[ "${GP_NO_PULL:-}" = 1 ] || docker pull "$IMAGE" >&2
slug="$(docker run --rm "$IMAGE" gp slug "$name" | sed -n 's/^GP_SLUG=//p')"
[ -n "$slug" ] || { echo "get.sh: the name was refused" >&2; exit 1; }
out="$(docker run --rm -v "gp-$slug-data:/data" "$IMAGE" init --name "$name" --relay "$relay" --owner "$owner")" || { printf '%s\n' "$out" >&2; exit 1; }
docker rm -f "gp-$slug" >/dev/null 2>&1 || true
docker run -d --name "gp-$slug" --restart unless-stopped -v "gp-$slug-data:/data" "$IMAGE" >/dev/null
echo "get.sh: the agent runs in container gp-$slug, its data in volume gp-$slug-data" >&2
if [ -z "$updater" ]; then
    if docker inspect "gp-$slug.updater" >/dev/null 2>&1; then
        updater=yes
    elif (: </dev/tty) 2>/dev/null; then
        printf '%s' "Let GHOST Protocol update itself? It needs control of Docker to swap in new versions. You can say no and update by hand. [y/N] " >/dev/tty
        read -r answer </dev/tty || answer=""
        case "$answer" in [Yy]*) updater=yes ;; *) updater=no ;; esac
    else
        updater=no
    fi
fi
docker rm -f "gp-$slug.updater" >/dev/null 2>&1 || true
if [ "$updater" = yes ]; then
    docker run -d --name "gp-$slug.updater" --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock "$IMAGE" updater --target "gp-$slug" >/dev/null
    echo "get.sh: the update helper runs in container gp-$slug.updater" >&2
else
    echo "get.sh: no update helper; the agent says when a new version is out, and the quick start says how to update by hand" >&2
fi
printf '%s\n' "$out" | grep '^GP_AGENT_PUBKEY='
