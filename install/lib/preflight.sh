# shellcheck shell=bash
# preflight.sh: step 1. OS and arch (already checked at start), sudo, free disk,
# git 2.46 or newer (GIT_MIN_VERSION in pins.env). Read-only: on Ubuntu, boot.sh
# is what upgrades git. Sourced by install/install only.

# The pinned Claude Code build alone is about 300 MB; the instance and its
# tools need more.
MIN_FREE_KB=2097152   # 2 GB

step_preflight() {
    heading "1. preflight"
    local sudo_note free_kb free_gb
    if [ "$(id -u)" = "0" ]; then
        sudo_note="running as root"
    elif command -v sudo >/dev/null 2>&1; then
        sudo_note="sudo present"
    elif [ "$PROFILE" = "vm" ]; then
        record FAIL preflight "sudo is missing; the vm profile needs it for system files (later steps)"
        return 1
    else
        sudo_note="no sudo (fine on the laptop profile)"
    fi
    free_kb="$(df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }')"
    case "$free_kb" in
        ''|*[!0-9]*)
            record FAIL preflight "could not read the free disk space of $HOME"
            return 1 ;;
    esac
    free_gb=$((free_kb / 1048576))
    if [ "$free_kb" -lt "$MIN_FREE_KB" ]; then
        record FAIL preflight "only ${free_gb} GB free in $HOME; at least 2 GB is needed"
        return 1
    fi
    preflight_git || return 1
    say "$GP_OS/$GP_ARCH, profile $PROFILE, $sudo_note, ${free_gb} GB free, $GIT_NOTE"
    if [ "$GIT_PLAN" = "1" ]; then
        record PLAN preflight "$GP_OS/$GP_ARCH, profile $PROFILE, $sudo_note, ${free_gb} GB free, $GIT_NOTE"
    else
        record OK preflight "$GP_OS/$GP_ARCH, profile $PROFILE, $sudo_note, ${free_gb} GB free, $GIT_NOTE"
    fi
    return 0
}

# Clones of git-over-nostr repos (a Buzz relay's) need git GIT_MIN_VERSION or
# newer: their credential helper answers only when git sends
# capability[]=authtype.
#   Linux: an older git stops a real run. On Ubuntu, boot.sh replaces it before
#     it runs the installer; a dry run, which changes nothing, plans that
#     instead (a PLAN line) and goes on.
#   macOS: a warning, since git comes with Apple's Command Line Tools there.
# Sets GIT_NOTE for the preflight line, and GIT_PLAN=1 for a PLAN line.
GIT_NOTE=""
GIT_PLAN=0
preflight_git() {
    local have min="${GIT_MIN_VERSION:-}"
    if [ -z "$min" ]; then
        record FAIL preflight "install/pins.env has no GIT_MIN_VERSION"
        return 1
    fi
    have="$(git_version)"
    if version_at_least "$have" "$min"; then
        GIT_NOTE="git $have"
        return 0
    fi
    if [ "$GP_OS" = "macos" ]; then
        warn "git ${have:-missing} is older than $min, which clones of relay repos need."
        warn "On macOS git comes with Apple's Command Line Tools: update them from Software"
        warn "Update. If their git is still older, install git $min or newer another way"
        warn "(https://git-scm.com/downloads/mac lists them) and put it first on PATH."
        GIT_NOTE="git ${have:-missing}, older than $min (see the warning)"
        return 0
    fi
    say "git ${have:-missing} is older than $min, which clones of relay repos need."
    say "On Ubuntu, boot.sh replaces it from the Git stable PPA (its signing key pinned in"
    say "install/pins.env) before it runs this installer: run the install through boot.sh."
    say "On any other Linux, install git $min or newer from your distribution."
    if [ "$DRY_RUN" = "1" ]; then
        GIT_PLAN=1
        GIT_NOTE="git ${have:-missing}, older than $min: a real run stops here unless boot.sh replaces it first (Ubuntu only)"
        return 0
    fi
    record FAIL preflight "git ${have:-missing} is older than $min (clones of relay repos need it)"
    return 1
}
