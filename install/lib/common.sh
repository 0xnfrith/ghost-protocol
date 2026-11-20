# shellcheck shell=bash
# common.sh: helpers shared by the installer's steps and install-claude-code.sh.
# Sourced, never run. bash 3.2 compatible.

say()     { printf '  %s\n' "$*"; }
warn()    { printf '  WARNING: %s\n' "$*" >&2; }
heading() { printf '\n== %s\n' "$*"; }

# Print a command the way a dry run shows it.
show_cmd() {
    printf '  would run:'
    printf ' %q' "$@"
    printf '\n'
}

lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# >>> root helpers: the installer's only sudo (pins.test.sh holds it to this block)
ROOT_MODE=""      # direct, sudo-n or sudo: how as_root runs, once root_prepare said yes
ROOT_PROBLEM=""   # why root_prepare said no
# root_prepare <what>: make sure as_root can run without waiting forever.
#   - Running as root: commands run directly.
#   - A run with --yes, or with no terminal: sudo -n only, which never asks for
#     a password. One probe (sudo -n true); if sudo wants a password, the
#     answer is no.
#   - An interactive run: it says that <what> needs root, then asks for the
#     password once (sudo -v); later commands use that sudo session.
# Returns 1, with ROOT_PROBLEM set, when root is out of reach. A test never
# runs anything as root: under GP_TEST=1 it always goes through the sudo on
# PATH (a stub in the test sandbox), also when the tests run as root.
root_prepare() {
    ROOT_MODE=""; ROOT_PROBLEM=""
    if [ "${GP_TEST:-}" != "1" ] && [ "$(id -u)" = "0" ]; then
        ROOT_MODE=direct
        return 0
    fi
    if ! command -v sudo >/dev/null 2>&1; then
        ROOT_PROBLEM="it needs root, and there is no sudo here"
        return 1
    fi
    if [ "${YES:-0}" = "1" ] || [ "${HAVE_TTY:-0}" != "1" ]; then
        if ! sudo -n true 2>/dev/null; then
            ROOT_PROBLEM="it needs root, and sudo wants a password; a run with --yes or without a terminal never waits for one"
            return 1
        fi
        ROOT_MODE=sudo-n
        return 0
    fi
    say "$1 needs root: sudo may ask for your password now."
    if ! sudo -v; then
        ROOT_PROBLEM="it needs root, and sudo -v failed"
        return 1
    fi
    ROOT_MODE=sudo
}

# as_root <command...>: one command as root, the way root_prepare chose. It
# returns the command's status, or 126 when root_prepare has not said yes, and
# never exits.
as_root() {
    case "$ROOT_MODE" in
        direct) "$@" ;;
        sudo-n) sudo -n "$@" ;;
        sudo)   sudo "$@" ;;
        *)      return 126 ;;
    esac
}
# <<< root helpers

# "~/x" -> "$HOME/x"; anything else unchanged.
expand_home() {
    case "$1" in
        \~) printf '%s' "$HOME" ;;
        \~/*) printf '%s/%s' "$HOME" "${1#\~/}" ;;
        *) printf '%s' "$1" ;;
    esac
}

# An absolute path with every link resolved in the part of it that exists (a
# path still to be made keeps its new tail). A relative path is left as given.
phys() {
    local p="$1" rest="" r
    case "$p" in /*) ;; *) printf '%s' "$p"; return 0 ;; esac
    while [ ! -d "$p" ]; do
        rest="/${p##*/}$rest"
        p="${p%/*}"
        [ -n "$p" ] || p=/
    done
    r="$(CDPATH='' cd -- "$p" 2>/dev/null && pwd -P)" || r="$p"
    [ "$r" = / ] && r=""
    printf '%s%s' "$r" "$rest"
}

# The file a path names, with every link followed (at most 20 of them). A path
# that is not a link is printed as given.
real_file() {
    local f="$1" t i=0
    while [ -L "$f" ]; do
        i=$((i + 1))
        [ "$i" -le 20 ] || return 1
        t="$(readlink "$f")" || return 1
        case "$t" in /*) f="$t" ;; *) f="$(dirname "$f")/$t" ;; esac
    done
    printf '%s' "$f"
}

sha256_of() {
    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$1" | cut -d' ' -f1
    else
        sha256sum "$1" | cut -d' ' -f1
    fi
}

# The installed git's version ("2.43.0"), or nothing when there is no git.
git_version() { git --version 2>/dev/null | awk '{ print $3 }'; }

# version_at_least <have> <want>: true when <have> is at least <want>,
# comparing major and minor as numbers (2.100 is newer than 2.46). A <have>
# that is empty or not dotted digits is never enough.
version_at_least() {
    local hm hn wm wn
    hm="${1%%.*}"; hn="${1#*.}"; hn="${hn%%.*}"
    wm="${2%%.*}"; wn="${2#*.}"; wn="${wn%%.*}"
    case "$hm.$hn.$wm.$wn" in *[!0-9.]*|.*|*..*|*.) return 1 ;; esac
    [ "$hm" -gt "$wm" ] || { [ "$hm" -eq "$wm" ] && [ "$hn" -ge "$wn" ]; }
}

# The platform: sets GP_OS (linux|macos) and GP_ARCH (x86_64|aarch64|arm64).
# Returns 3 for anything else. Supported: Linux x86_64 and aarch64, macOS arm64.
detect_platform() {
    local s m
    s="$(uname -s 2>/dev/null)"
    m="$(uname -m 2>/dev/null)"
    case "$s-$m" in
        Linux-x86_64|Linux-amd64)   GP_OS=linux; GP_ARCH=x86_64 ;;
        Linux-aarch64|Linux-arm64)  GP_OS=linux; GP_ARCH=aarch64 ;;
        Darwin-arm64)               GP_OS=macos; GP_ARCH=arm64 ;;
        *) GP_OS="$s"; GP_ARCH="$m"; return 3 ;;
    esac
    return 0
}

# A private temporary folder: user-owned, mode 0700, under $HOME (never a
# shared /tmp), removed on exit. Nothing lasting ever points into it.
GP_WORK=""   # never taken from the environment: cleanup deletes it
make_work() {
    [ -n "$GP_WORK" ] && [ -d "$GP_WORK" ] && return 0
    GP_WORK="$(mktemp -d "$HOME/.gp-install.XXXXXX")" || return 1
    chmod 700 "$GP_WORK"
}
cleanup_work() {
    if [ -n "$GP_WORK" ] && [ -d "$GP_WORK" ]; then rm -rf "$GP_WORK"; fi
    GP_WORK=""
    return 0
}

# The pins file. A different one is accepted only in the test suite
# (GP_TEST=1), and then a loud line says so.
pins_file() {
    if [ "${GP_TEST:-}" = "1" ] && [ -n "${GP_PINS_FILE:-}" ]; then
        echo "install: TEST MODE (GP_TEST=1): pins come from $GP_PINS_FILE, not install/pins.env" >&2
        printf '%s' "$GP_PINS_FILE"
    else
        printf '%s' "$GP_DIR/install/pins.env"
    fi
}

# Load the pins after checking that every line is a comment, a blank line or
# KEY="value", so sourcing it can only set variables.
load_pins() {
    local f bad
    f="$(pins_file)"
    [ -f "$f" ] || { echo "install: no pins file at $f" >&2; return 1; }
    bad="$(grep -nvE '^[[:space:]]*(#.*)?$|^[A-Z0-9_]+="[^"$`\\]*"$' "$f" || true)"
    if [ -n "$bad" ]; then
        echo "install: $f has lines that are not KEY=\"value\":" >&2
        printf '%s\n' "$bad" | sed 's/^/    /' >&2
        return 1
    fi
    # Each value must look like what it is: versions are dotted digits, sha256
    # values are 64 hex characters. Nothing else can reach a URL or a path.
    bad="$(grep -E '^[A-Z0-9_]+_VERSION=' "$f" | grep -vE '^[A-Z0-9_]+_VERSION="[0-9]+(\.[0-9]+)*"$' || true)"
    bad="$bad$(grep -E '^[A-Z0-9_]+_SHA256_[A-Z0-9_]+=' "$f" | grep -vE '^[A-Z0-9_]+_SHA256_[A-Z0-9_]+="[0-9a-f]{64}"$' || true)"
    if [ -n "$bad" ]; then
        echo "install: $f has a version that is not dotted digits, or a sha256 that is not 64 hex characters:" >&2
        printf '%s\n' "$bad" | sed 's/^/    /' >&2
        return 1
    fi
    # shellcheck disable=SC1090
    . "$f"
}

# The one place the installer downloads anything: fetch over https, then check
# the sha256 against the pin. On a mismatch the file is deleted and nothing runs.
download_verified() {   # url dest sha256
    local url="$1" dest="$2" want="$3" got
    if ! curl -fsSL --proto '=https' --tlsv1.2 --retry 2 -o "$dest" "$url"; then
        rm -f "$dest"
        echo "install: download failed: $url" >&2
        return 1
    fi
    got="$(sha256_of "$dest")"
    if [ "$got" != "$want" ]; then
        rm -f "$dest"
        echo "install: ABORT: $(basename "$dest") does not match the pinned sha256. Nothing was run." >&2
        return 1
    fi
    return 0
}
