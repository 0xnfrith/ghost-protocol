#!/usr/bin/env bash
# boot.sh: the Ghost Protocol bootstrap. The first thing run on a fresh machine.
#
# Usage: bash boot.sh --instance <owner/repo> [--dir <path>] [--commit <id>]
#                     [--update | --rollback] [--dev-source <path>] [--dry-run]
#                     [installer options]
#
#   --instance <owner/repo>  the instance repo (required; passed on to the installer)
#   --dir <path>             where Ghost Protocol is cloned (default ~/ghost-protocol)
#   --commit <id>            the commit to pin, a full 40-character id, instead of
#                            GP_COMMIT below; for moving an instance to a commit
#                            the operator chose
#   --update                 move an existing --dir to the pinned commit, then run
#                            the installer's update steps (install/install --update)
#   --rollback               --update back to the commit --dir was at before its
#                            last update (recorded in <dir>/.git/gp-previous-commit)
#   --dev-source <path>      run from a local checkout instead (development only)
#   --dry-run                change nothing; the installer runs as a dry run too
#   -h, --help               this help
# Every other option is passed on to install/install.
#
# What it does:
#   1. Checks the platform: Linux x86_64 or aarch64, or macOS arm64 (else exit 3).
#   2. Base tools. Linux: apt-installs whichever of git, curl, ca-certificates,
#      tar and gzip are missing. macOS: asks for the Command Line Tools if git
#      is missing.
#   3. Clones github.com/0xnfrith/ghost-protocol at exactly GP_COMMIT (below,
#      or --commit), and stops unless `git rev-parse HEAD` equals it. An
#      existing --dir at another commit is refused unless --update. An
#      update records the commit it moves from, prints the command that goes
#      back to it, and never follows a branch: the checkout stays detached at
#      the pin until the operator moves it again.
#   4. git 2.46 or newer (Linux). On Ubuntu an older git is replaced from the
#      Git stable PPA. Its signing key (install/apt/) is checked against the
#      fingerprint in install/pins.env before apt is told to trust it, and an
#      apt source for the PPA that is already there is left as it is. Any other
#      Linux is told, and nothing changes. On macOS the installer's preflight
#      says how to get a newer git.
#   5. Runs <dir>/install/install with GP_DIR and GP_COMMIT set. On --update
#      (and --rollback) it adds --update, and sets GP_PREVIOUS_COMMIT when the
#      checkout moved, so the installer refreshes the plugin and restarts the
#      instance's service. A dry run sets both as a real run would, and
#      GP_TARGET_DIR, so its plan names <dir> and not the temporary clone.
# It runs under macOS /bin/bash 3.2. It may run from inside <dir> itself
# (<dir>/install/boot.sh): git replaces a changed file with a new one rather
# than writing over it, so the running copy is read to its end unchanged.
set -euo pipefail

# The Ghost Protocol commit this bootstrap runs. The release script writes it;
# empty means unreleased, and then only --dev-source works.
GP_COMMIT=""
GP_REPO_URL_DEFAULT="https://github.com/0xnfrith/ghost-protocol.git"

INSTANCE=""
DIR="$HOME/ghost-protocol"
DEV_SOURCE=""
PIN_OPT=""
UPDATE=0
ROLLBACK=0
PREVIOUS=""
DRY_RUN=0
PASS=()
PREVIOUS_FILE_NAME="gp-previous-commit"

die() { local code="$1"; shift; echo "boot: $*" >&2; exit "$code"; }
say() { printf '  %s\n' "$*"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --instance)   [ $# -ge 2 ] || die 2 "--instance needs a value"; INSTANCE="$2"; shift 2 ;;
        --dir)        [ $# -ge 2 ] || die 2 "--dir needs a value"; DIR="$2"; shift 2 ;;
        --dev-source) [ $# -ge 2 ] || die 2 "--dev-source needs a value"; DEV_SOURCE="$2"; shift 2 ;;
        --commit)     [ $# -ge 2 ] || die 2 "--commit needs a value"; PIN_OPT="$2"; shift 2 ;;
        --update)     UPDATE=1; shift ;;
        --rollback)   ROLLBACK=1; UPDATE=1; shift ;;
        --dry-run|-n) DRY_RUN=1; shift ;;
        -h|--help)    sed -n '2,46p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)            PASS+=("$1"); shift ;;
    esac
done
[ -n "$INSTANCE" ] || die 2 "--instance <owner/repo> is required"
[ -n "$DIR" ] || die 2 "--dir must not be empty"
case "$DIR" in \~/*) DIR="$HOME/${DIR#\~/}" ;; esac
if [ -n "$PIN_OPT" ] && [ "$ROLLBACK" = "1" ]; then die 2 "--commit and --rollback do not go together"; fi
if [ -n "$DEV_SOURCE" ] && { [ -n "$PIN_OPT" ] || [ "$UPDATE" = "1" ]; }; then
    die 2 "--dev-source runs a local checkout as it is; it takes no --commit, --update or --rollback"
fi
# --rollback: the commit the last update moved from.
if [ "$ROLLBACK" = "1" ]; then
    [ -f "$DIR/.git/$PREVIOUS_FILE_NAME" ] \
        || die 1 "nothing to roll back to: $DIR has no $PREVIOUS_FILE_NAME (an update records the commit it moves from)"
    PIN_OPT="$(tr -d '[:space:]' <"$DIR/.git/$PREVIOUS_FILE_NAME")"
    say "rollback: back to $PIN_OPT, the commit $DIR was at before its last update"
fi
# --commit (or the rollback's commit) is the pin, checked like GP_COMMIT.
if [ -n "$PIN_OPT" ]; then
    case "$PIN_OPT" in
        *[!0-9a-f]*) die 2 "--commit must be a full 40-character commit id (lower-case hex)" ;;
    esac
    [ "${#PIN_OPT}" -eq 40 ] || die 2 "--commit must be a full 40-character commit id (lower-case hex)"
    if [ "$PIN_OPT" != "$GP_COMMIT" ]; then
        GP_COMMIT="$PIN_OPT"
        say "pinned by the command line: $GP_COMMIT"
    fi
fi


# The clone address. Tests point it at a local repo; nothing else can.
REPO_URL="$GP_REPO_URL_DEFAULT"
if [ "${GP_TEST:-}" = "1" ] && [ -n "${GP_REPO_URL:-}" ]; then
    REPO_URL="$GP_REPO_URL"
    echo "boot: TEST MODE (GP_TEST=1): cloning from $REPO_URL, not GitHub" >&2
fi
# Where os-release and the apt sources are read. Tests point it at a folder of
# their own; nothing else can, and nothing is ever written there in a test.
ETC=/etc
if [ "${GP_TEST:-}" = "1" ] && [ -n "${GP_ETC:-}" ]; then
    ETC="$GP_ETC"
    echo "boot: TEST MODE (GP_TEST=1): reading os-release and apt sources from $ETC, not /etc" >&2
fi

# ---------------------------------------------------------------- 1. platform

case "$(uname -s)-$(uname -m)" in
    Linux-x86_64|Linux-amd64|Linux-aarch64|Linux-arm64) OS=linux ;;
    Darwin-arm64) OS=macos ;;
    *) die 3 "unsupported platform $(uname -s)/$(uname -m) (Linux x86_64 or aarch64, macOS arm64)" ;;
esac
printf 'Ghost Protocol bootstrap (%s/%s, commit %s)%s\n' "$OS" "$(uname -m)" "${GP_COMMIT:-unreleased}" \
    "$([ "$DRY_RUN" = "1" ] && echo ', DRY RUN: nothing is changed')"

# ---------------------------------------------------------------- 2. base tools

as_root() {
    # A test never runs anything as root, whoever runs the tests.
    if [ "${GP_TEST:-}" = "1" ]; then die 1 "TEST MODE: refusing to run as root: $1"; fi
    if [ "$(id -u)" = "0" ]; then "$@"
    elif command -v sudo >/dev/null 2>&1; then sudo "$@"
    else die 1 "needs root and sudo is not installed: $*"; fi
}

if [ "$OS" = "macos" ]; then
    if ! xcode-select -p >/dev/null 2>&1; then
        echo "boot: git is missing. Install the Command Line Tools, then run this again:" >&2
        echo "  xcode-select --install" >&2
        exit 1
    fi
else
    missing=""
    if command -v dpkg-query >/dev/null 2>&1; then
        for p in git curl ca-certificates tar gzip; do
            dpkg-query -W -f='${Status}' "$p" 2>/dev/null | grep -q "install ok installed" || missing="$missing $p"
        done
    else
        for p in git curl tar gzip; do
            command -v "$p" >/dev/null 2>&1 || missing="$missing $p"
        done
        [ -z "$missing" ] || die 1 "missing:$missing (no apt here; install them and run this again)"
    fi
    if [ -z "$missing" ]; then
        say "git, curl, certificates, tar and gzip present"
    elif [ "$DRY_RUN" = "1" ]; then
        say "would apt-get install:$missing"
    elif [ "${GP_TEST:-}" = "1" ]; then
        die 1 "missing:$missing (the test suite never installs packages)"
    else
        say "installing:$missing"
        # shellcheck disable=SC2086
        as_root env DEBIAN_FRONTEND=noninteractive apt-get update -qq
        # shellcheck disable=SC2086
        as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $missing
    fi
fi

# ---------------------------------------------------------------- 3. the pinned clone

# Temporary files go in a private folder under $HOME, removed on exit (and
# before the exec below, which skips the exit trap).
WORK=""
make_work() {
    [ -n "$WORK" ] && return 0
    WORK="$(mktemp -d "$HOME/.gp-boot.XXXXXX")"
    chmod 700 "$WORK"
}
cleanup() { if [ -n "$WORK" ] && [ -d "$WORK" ]; then rm -rf "$WORK"; fi; WORK=""; return 0; }
trap cleanup EXIT

# ---------------------------------------------------------------- 4. git 2.46 or newer

# Run once the pinned clone is there, since the minimum version, the key's
# fingerprint and the key itself come from it.
GIT_PPA_URI="https://ppa.launchpadcontent.net/git-core/ppa/ubuntu/"
GIT_PPA_KEYRING="/etc/apt/keyrings/git-core-ppa.asc"

git_version() { git --version 2>/dev/null | awk '{ print $3 }' || true; }

# version_at_least <have> <want>: major and minor compared as numbers. The
# same rule as install/lib/common.sh, which this script cannot source.
version_at_least() {
    local hm hn wm wn
    hm="${1%%.*}"; hn="${1#*.}"; hn="${hn%%.*}"
    wm="${2%%.*}"; wn="${2#*.}"; wn="${wn%%.*}"
    case "$hm.$hn.$wm.$wn" in *[!0-9.]*|.*|*..*|*.) return 1 ;; esac
    [ "$hm" -gt "$wm" ] || { [ "$hm" -eq "$wm" ] && [ "$hn" -ge "$wn" ]; }
}

# A value from the clone's install/pins.env, read with sed, never sourced.
pin_of() {   # dir key
    sed -n "s/^$2=\"\\([0-9A-Za-z.]*\\)\"\$/\\1/p" "$1/install/pins.env" 2>/dev/null | head -n 1 || true
}

os_release_value() {   # key
    sed -n "s/^$1=//p" "$ETC/os-release" 2>/dev/null | head -n 1 | tr -d "\"'" || true
}

# An apt source for the PPA and this release already there, under either host
# name: a deb line in a .list file (not a comment, not deb-src), or a .sources
# file that is not disabled (a release upgrade leaves the old one with
# Enabled: no). A .sources file is read as a whole, not entry by entry; a
# source that counts by mistake ends in the version check after the install.
git_ppa_listed() {   # codename
    local f
    for f in "$ETC/apt/sources.list" "$ETC"/apt/sources.list.d/*.list; do
        [ -f "$f" ] || continue
        if grep -qE "^[[:space:]]*deb[[:space:]][^#]*ppa\.launchpad(content)?\.net/git-core/ppa[^[:space:]]*[[:space:]]+$1([[:space:]]|\$)" "$f"; then
            return 0
        fi
    done
    for f in "$ETC"/apt/sources.list.d/*.sources; do
        [ -f "$f" ] || continue
        grep -qE '^[^#]*ppa\.launchpad(content)?\.net/git-core/ppa' "$f" || continue
        grep -qE "^Suites:[[:space:]]*(.*[[:space:]])?$1([[:space:]]|\$)" "$f" || continue
        if grep -qiE '^Enabled:[[:space:]]*(no|false|off)[[:space:]]*$' "$f"; then continue; fi
        return 0
    done
    return 1
}

# The apt source boot.sh writes (deb822), its key named in Signed-By.
git_ppa_source() {   # codename
    printf 'Types: deb\nURIs: %s\nSuites: %s\nComponents: main\nSigned-By: %s\n' \
        "$GIT_PPA_URI" "$1" "$GIT_PPA_KEYRING"
}

# The key file's fingerprint must be exactly the pinned one (one key, no more).
# The check runs on a copy in the private temp folder, and that copy is what
# gets installed, so a change to the clone after the check does not reach apt.
GIT_PPA_KEY_CHECKED=""
check_ppa_key() {   # key-file fingerprint
    local fprs
    make_work
    rm -rf "$WORK/gnupg"
    mkdir -m 700 "$WORK/gnupg"
    cp "$1" "$WORK/git-core-ppa.asc"
    fprs="$(GNUPGHOME="$WORK/gnupg" gpg --batch --show-keys --with-colons "$WORK/git-core-ppa.asc" 2>/dev/null \
        | awk -F: '$1 == "pub" { p = 1; next } p && $1 == "fpr" { print $10; p = 0 }' || true)"
    rm -rf "$WORK/gnupg"
    if [ "$fprs" != "$2" ]; then
        die 1 "ABORT: $1 is not the Git stable PPA key pinned in install/pins.env ($2); no apt source was added"
    fi
    GIT_PPA_KEY_CHECKED="$WORK/git-core-ppa.asc"
    say "the Git stable PPA's signing key matches the pinned fingerprint $2"
}

apt_get() { as_root env DEBIAN_FRONTEND=noninteractive apt-get "$@"; }

ensure_git() {   # dir
    local min fpr have id codename key sources present=0 wrote=0 keyring_new=0
    [ "$OS" = "linux" ] || return 0
    min="$(pin_of "$1" GIT_MIN_VERSION)"
    fpr="$(pin_of "$1" GIT_PPA_FINGERPRINT)"
    printf '%s' "$min" | grep -qE '^[0-9]+\.[0-9]+$' || die 1 "$1/install/pins.env has no GIT_MIN_VERSION"
    printf '%s' "$fpr" | grep -qE '^[0-9A-F]{40}$' || die 1 "$1/install/pins.env has no GIT_PPA_FINGERPRINT"
    have="$(git_version)"
    if version_at_least "$have" "$min"; then
        say "git $have (clones of relay repos need $min or newer)"
        return 0
    fi
    say "git ${have:-missing} is older than $min, which clones of relay repos need"
    id="$(os_release_value ID)"
    codename="$(os_release_value VERSION_CODENAME)"
    case "$codename" in ''|*[!a-z]*) codename="" ;; esac
    if [ "$id" != "ubuntu" ] || [ -z "$codename" ]; then
        say "the Git stable PPA is for Ubuntu only (this is ${id:-an unknown Linux}); nothing was changed."
        say "Install git $min or newer from your distribution: the installer's preflight stops until then."
        return 0
    fi
    key="$1/install/apt/git-core-ppa.asc"
    sources="/etc/apt/sources.list.d/git-core-ubuntu-ppa-$codename.sources"
    if git_ppa_listed "$codename"; then present=1; fi
    if [ "$present" != "1" ] && [ -e "$ETC/apt/sources.list.d/git-core-ubuntu-ppa-$codename.sources" ]; then
        # The file boot.sh would write is there, but names no enabled source
        # for this release: it is someone's, so it is left as it is.
        die 1 "$sources is there but is not an enabled Git stable PPA source for $codename; left as it is. Fix or remove it, then run this again."
    fi
    if [ "$DRY_RUN" = "1" ]; then
        if [ "$present" = "1" ]; then
            say "an apt source for the Git stable PPA is already there; it would be left as it is"
        else
            say "would add the Git stable PPA (ppa:git-core/ppa, $codename), after checking its"
            say "signing key against the pinned fingerprint $fpr. $sources would read:"
            git_ppa_source "$codename" | sed 's/^/    /'
        fi
        say "would apt-get install git from it"
        return 0
    fi
    if [ "$present" = "1" ]; then
        say "an apt source for the Git stable PPA is already there; left as it is"
    else
        [ -f "$key" ] || die 1 "$key is missing"
        if ! command -v gpg >/dev/null 2>&1; then
            if [ "${GP_TEST:-}" = "1" ]; then
                die 1 "no gpg to check the key with (the test suite never installs packages)"
            fi
            say "installing gnupg, to check the PPA's signing key"
            apt_get update -qq
            apt_get install -y -qq --no-install-recommends gnupg
        fi
        check_ppa_key "$key" "$fpr"
    fi
    if [ "${GP_TEST:-}" = "1" ]; then
        die 1 "TEST MODE: stopping before apt (the test suite never writes apt sources or installs packages)"
    fi
    if [ "$present" != "1" ]; then
        [ -e "$GIT_PPA_KEYRING" ] || keyring_new=1
        as_root install -d -m 0755 /etc/apt/keyrings
        as_root install -m 0644 "$GIT_PPA_KEY_CHECKED" "$GIT_PPA_KEYRING"
        git_ppa_source "$codename" | as_root tee "$sources" >/dev/null
        wrote=1
        say "added the Git stable PPA for $codename ($sources)"
    fi
    if ! apt_get update -qq; then
        if [ "$wrote" = "1" ]; then
            as_root rm -f "$sources" || true
            if [ "$keyring_new" = "1" ]; then as_root rm -f "$GIT_PPA_KEYRING" || true; fi
            die 1 "apt-get update failed; the Git stable PPA source this run added was removed again"
        fi
        die 1 "apt-get update failed"
    fi
    apt_get install -y -qq --no-install-recommends git || die 1 "apt-get install git (Git stable PPA) failed"
    have="$(git_version)"
    version_at_least "$have" "$min" || die 1 "git is ${have:-missing} after the Git stable PPA install, not $min or newer"
    say "git $have installed from the Git stable PPA"
}

# ---------------------------------------------------------------- 5. the installer

run_installer() {   # dir commit
    local args=(--instance "$INSTANCE")
    [ "$DRY_RUN" = "1" ] && args+=(--dry-run)
    [ "$UPDATE" = "1" ] && args+=(--update)
    if [ "${#PASS[@]}" -gt 0 ]; then args+=("${PASS[@]}"); fi
    [ -x "$1/install/install" ] || die 1 "$1/install/install is missing"
    ensure_git "$1"
    if [ "$DRY_RUN" = "1" ] && [ -n "$WORK" ]; then
        # A dry run from a temporary clone: run it, then clean up. It names
        # the real checkout, and the commit it would move from.
        GP_DIR="$1" GP_COMMIT="$2" GP_PREVIOUS_COMMIT="$PREVIOUS" GP_TARGET_DIR="$DIR" \
            "$1/install/install" "${args[@]}"
        exit $?
    fi
    cleanup
    GP_DIR="$1" GP_COMMIT="$2" GP_PREVIOUS_COMMIT="$PREVIOUS" exec "$1/install/install" "${args[@]}"
}

if [ -n "$DEV_SOURCE" ]; then
    case "$DEV_SOURCE" in \~/*) DEV_SOURCE="$HOME/${DEV_SOURCE#\~/}" ;; esac
    [ -x "$DEV_SOURCE/install/install" ] || die 1 "--dev-source $DEV_SOURCE has no install/install"
    DEV_SOURCE="$(cd "$DEV_SOURCE" && pwd -P)"
    dev_commit="$(git -C "$DEV_SOURCE" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "boot: WARNING: --dev-source is for development only. It runs $DEV_SOURCE as it is" >&2
    echo "  (commit $dev_commit, plus any local changes); nothing is pinned or checked." >&2
    run_installer "$DEV_SOURCE" "$dev_commit"
fi

if [ -z "$GP_COMMIT" ]; then
    die 1 "this bootstrap is unreleased (GP_COMMIT is empty); pass --commit <id>, use a released boot.sh, or --dev-source <checkout> for development"
fi
case "$GP_COMMIT" in
    *[!0-9a-f]*) die 1 "GP_COMMIT is not a 40-character commit id" ;;
esac
[ "${#GP_COMMIT}" -eq 40 ] || die 1 "GP_COMMIT is not a 40-character commit id"

same_repo() {   # dir
    local url
    url="$(git -C "$1" config --get remote.origin.url 2>/dev/null || true)"
    [ "${url%.git}" = "${REPO_URL%.git}" ]
}

# The commit to go back to, and the command that does it.
compare_line() {   # from to
    if [ "${REPO_URL%.git}" = "${GP_REPO_URL_DEFAULT%.git}" ]; then
        say "what changes: ${GP_REPO_URL_DEFAULT%.git}/compare/$1...$2"
    fi
}
way_back() {   # commit
    local extra=""
    if [ "${#PASS[@]}" -gt 0 ]; then extra="$(printf ' %q' "${PASS[@]}")"; fi
    say "to go back to $1:"
    say "  bash $(printf '%q' "$DIR")/install/boot.sh --instance $INSTANCE --dir $(printf '%q' "$DIR") --commit $1 --update$extra"
}

verify_head() {   # dir
    local head
    head="$(git -C "$1" rev-parse HEAD 2>/dev/null || true)"
    if [ "$head" != "$GP_COMMIT" ]; then
        echo "boot: REFUSED: $1 is at ${head:-nothing}, not the pinned commit $GP_COMMIT" >&2
        return 1
    fi
    return 0
}

fetch_pinned() {   # dir
    git -C "$1" fetch -q --depth 1 origin "$GP_COMMIT" && git -C "$1" checkout -q --detach FETCH_HEAD
}

clone_pinned() {   # dir
    mkdir -p "$1"
    git -C "$1" init -q
    git -C "$1" remote add origin "$REPO_URL"
    fetch_pinned "$1"
}

if [ -e "$DIR" ]; then
    [ -d "$DIR/.git" ] || die 1 "$DIR exists and is not a Ghost Protocol clone; move it or pass --dir"
    same_repo "$DIR" || die 1 "$DIR is a clone of something else; move it or pass --dir"
    if [ -n "$(git -C "$DIR" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
        die 1 "$DIR has local changes; refusing to run unpinned code"
    fi
    head="$(git -C "$DIR" rev-parse HEAD 2>/dev/null || true)"
    if [ "$head" = "$GP_COMMIT" ]; then
        say "$DIR is at the pinned commit $GP_COMMIT"
        run_installer "$DIR" "$GP_COMMIT"
    fi
    [ "$UPDATE" = "1" ] || die 1 "$DIR is at ${head:-nothing}, not the pinned commit $GP_COMMIT; pass --update to move it"
    PREVIOUS="$head"
    if [ "$DRY_RUN" = "1" ]; then
        say "would move $DIR from $head to $GP_COMMIT (fetch, then switch to it)"
        compare_line "$head" "$GP_COMMIT"
        way_back "$head"
    else
        say "updating $DIR from $head to $GP_COMMIT"
        compare_line "$head" "$GP_COMMIT"
        way_back "$head"
        fetch_pinned "$DIR" || die 1 "could not fetch $GP_COMMIT into $DIR; it is still at $head"
        verify_head "$DIR" || exit 1
        printf '%s\n' "$head" >"$DIR/.git/$PREVIOUS_FILE_NAME" \
            || die 1 "could not record $head in $DIR/.git/$PREVIOUS_FILE_NAME"
        say "$DIR is at $GP_COMMIT; $head is recorded for --rollback"
        run_installer "$DIR" "$GP_COMMIT"
    fi
else
    if [ "$UPDATE" = "1" ]; then
        die 1 "nothing to update: $DIR does not exist. A first install runs without --update or --rollback."
    fi
    if [ "$DRY_RUN" = "1" ]; then
        say "would clone $REPO_URL at $GP_COMMIT into $DIR"
    else
        say "cloning Ghost Protocol at $GP_COMMIT into $DIR"
        if ! clone_pinned "$DIR"; then
            rm -rf "$DIR"
            die 1 "could not fetch $GP_COMMIT from $REPO_URL"
        fi
        if ! verify_head "$DIR"; then
            rm -rf "$DIR"
            exit 1
        fi
        run_installer "$DIR" "$GP_COMMIT"
    fi
fi

# Dry run: run the installer's dry run from a temporary clone at the pin.
make_work
say "dry run: using a temporary clone at the pinned commit"
clone_pinned "$WORK/gp" || die 1 "could not fetch $GP_COMMIT from $REPO_URL"
verify_head "$WORK/gp" || exit 1
run_installer "$WORK/gp" "$GP_COMMIT"
