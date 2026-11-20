#!/usr/bin/env bash
# install-claude-code.sh: the pinned Claude Code native build.
#
# Usage: install/install-claude-code.sh [--profile vm|laptop] [--dry-run]
#
# Downloads the build named in install/pins.env from the address Anthropic's
# own installer (https://claude.ai/install.sh) uses:
#   https://downloads.claude.ai/claude-code-releases/<version>/<platform>/claude
# checks its sha256 against the pin, refusing on a mismatch, and installs it the
# way the native installer lays it out: the binary in
# ~/.local/share/claude/versions/<version>, linked from ~/.local/bin/claude.
# It never runs the downloaded binary's own `install` step, and never pipes
# anything into a shell.
#
#   --profile vm      (default on Linux) an install at another version is replaced
#   --profile laptop  (default on macOS) an existing Claude Code is never
#                     replaced: it installs only when none is present, and warns
#                     when the installed version differs from the pin
#   --dry-run         print what it would do; change nothing
#
# An install already at the pinned version is left alone.
# Exit codes: 0 ok, 1 failed, 2 usage, 3 unsupported platform.
set -uo pipefail

GP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# shellcheck source=lib/common.sh
. "$GP_DIR/install/lib/common.sh"

DOWNLOAD_BASE="https://downloads.claude.ai/claude-code-releases"
PROFILE=""
DRY_RUN=0

while [ $# -gt 0 ]; do
    case "$1" in
        --profile) [ $# -ge 2 ] || { echo "install-claude-code: --profile needs a value" >&2; exit 2; }
                   PROFILE="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "install-claude-code: unknown option: $1" >&2; exit 2 ;;
    esac
done

detect_platform || { echo "install-claude-code: unsupported platform $GP_OS/$GP_ARCH" >&2; exit 3; }
if [ -z "$PROFILE" ]; then
    if [ "$GP_OS" = "macos" ]; then PROFILE=laptop; else PROFILE=vm; fi
fi
case "$PROFILE" in laptop|vm) ;; *) echo "install-claude-code: --profile must be vm or laptop" >&2; exit 2 ;; esac

load_pins || exit 1
VERSION="$CLAUDE_CODE_VERSION"

case "$GP_OS-$GP_ARCH" in
    macos-arm64)   PLATFORM=darwin-arm64; SUM="$CLAUDE_CODE_SHA256_DARWIN_ARM64" ;;
    linux-x86_64)  PLATFORM=linux-x64;    SUM="$CLAUDE_CODE_SHA256_LINUX_X64" ;;
    linux-aarch64) PLATFORM=linux-arm64;  SUM="$CLAUDE_CODE_SHA256_LINUX_ARM64" ;;
esac
if [ "$GP_OS" = "linux" ]; then
    if [ -f /lib/libc.musl-x86_64.so.1 ] || [ -f /lib/libc.musl-aarch64.so.1 ] \
        || { command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; }; then
        echo "install-claude-code: this is a musl Linux; there is no pinned build for it" >&2
        exit 3
    fi
fi

BIN_DIR="$HOME/.local/bin"
TARGET="$BIN_DIR/claude"
VERSIONS_DIR="$HOME/.local/share/claude/versions"
URL="$DOWNLOAD_BASE/$VERSION/$PLATFORM/claude"

version_of() { "$1" --version 2>/dev/null | head -n 1 | awk '{ print $1 }'; }

# What is installed now: ~/.local/bin/claude first, else whatever is on PATH.
EXISTING=""
if [ -x "$TARGET" ]; then
    EXISTING="$TARGET"
else
    EXISTING="$(command -v claude 2>/dev/null || true)"
fi
if [ -n "$EXISTING" ]; then
    HAVE="$(version_of "$EXISTING")"
    if [ "$HAVE" = "$VERSION" ]; then
        say "Claude Code $VERSION (the pin) is installed at $EXISTING; left alone"
        exit 0
    fi
    if [ "$PROFILE" = "laptop" ]; then
        warn "Claude Code ${HAVE:-of unknown version} at $EXISTING differs from the pin $VERSION;"
        warn "left alone: the laptop profile never replaces an existing Claude Code"
        exit 0
    fi
    say "Claude Code ${HAVE:-of unknown version} at $EXISTING differs from the pin $VERSION; installing the pin"
fi

if [ "$DRY_RUN" = "1" ]; then
    say "would download $URL"
    say "would check sha256 $SUM, then install it to $VERSIONS_DIR/$VERSION, linked from $TARGET"
    exit 0
fi

trap cleanup_work EXIT
make_work || { echo "install-claude-code: could not make a private temp folder" >&2; exit 1; }
say "downloading Claude Code $VERSION ($PLATFORM)"
download_verified "$URL" "$GP_WORK/claude" "$SUM" || exit 1
chmod 755 "$GP_WORK/claude"
mkdir -p "$VERSIONS_DIR" "$BIN_DIR" || exit 1
mv -f "$GP_WORK/claude" "$VERSIONS_DIR/$VERSION" || exit 1
# Replace the link in one rename, so ~/.local/bin/claude is never missing.
ln -s "$VERSIONS_DIR/$VERSION" "$GP_WORK/claude.link" || exit 1
mv -f "$GP_WORK/claude.link" "$TARGET" || exit 1

GOT="$(version_of "$TARGET")"
if [ "$GOT" != "$VERSION" ]; then
    echo "install-claude-code: $TARGET reports version '${GOT:-nothing}', not $VERSION" >&2
    exit 1
fi
say "Claude Code $VERSION installed at $TARGET (sha256 checked)"
exit 0
