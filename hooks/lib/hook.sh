# shellcheck shell=bash
# hook.sh: what the core hooks share: their on/off switches and other plugin
# options, their state folder, and the instance they act for. Sourced, never
# run. bash 3.2 compatible. The caller sets HOOKS_DIR (the hooks/ folder).

GP_DIR="$(CDPATH='' cd -- "$HOOKS_DIR/.." && pwd -P)"
# shellcheck source=../../install/lib/common.sh
. "$GP_DIR/install/lib/common.sh"

# hook_option NAME: a plugin option, trimmed; empty when unset. Claude Code
# passes a plugin's saved options to its hooks as CLAUDE_PLUGIN_OPTION_<NAME>
# (upper case), and only the saved ones: an option nobody saved is absent,
# whatever default plugin.json gives it.
hook_option() {
    local var v=""
    var="CLAUDE_PLUGIN_OPTION_$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
    case "$var" in *[!A-Z0-9_]*) return 0 ;; esac
    eval "v=\${$var-}"
    v="${v#"${v%%[![:space:]]*}"}"
    v="${v%"${v##*[![:space:]]}"}"
    printf '%s' "$v"
}

# hook_on NAME: true unless the on/off option NAME is off (off, false, no or 0,
# in any case). Unset is on: the default plugin.json gives every switch.
hook_on() {
    case "$(hook_option "$1" | tr '[:upper:]' '[:lower:]')" in
        off | false | no | 0) return 1 ;;
    esac
    return 0
}

# hook_on_explicit NAME: true only when the on/off option NAME is on (on, true, yes or 1, in any case). Unset, empty or anything
# else is off: for a switch that is off by default, which plugin.json says but which Claude Code does not pass for an option nobody
# saved.
hook_on_explicit() {
    case "$(hook_option "$1" | tr '[:upper:]' '[:lower:]')" in
        on | true | yes | 1) return 0 ;;
    esac
    return 1
}

# hook_state_dir: where the hooks keep logs and state: the plugin's data
# folder, else ~/.local/state/ghost-protocol/hooks (as the Buzz channel's).
hook_state_dir() {
    if [ -n "${CLAUDE_PLUGIN_DATA:-}" ]; then
        printf '%s/hooks' "$CLAUDE_PLUGIN_DATA"
    else
        printf '%s/ghost-protocol/hooks' "${XDG_STATE_HOME:-$HOME/.local/state}"
    fi
}

# hook_instance DIR: the instance a session in DIR belongs to, from the
# manifest (.ghost-protocol/instance.toml) at the top of DIR's git checkout,
# read and checked as the installer reads it (install/lib/instance.sh).
# Sets HOOK_NAME, HOOK_HOME (the instance's home, a real path) and HOOK_ROOT
# (the workspace root, or empty for a single-folder instance). Returns 1, with
# nothing set, when there is no valid manifest.
#   - Schema v1, or v0 with dir = ~/<root>/<name>: the home is <root>/<name>.
#   - Any other v0 manifest: the home is its dir, else the main checkout that
#     holds the manifest; there is no root.
#   - A home folder that does not exist (an instance not moved into the layout
#     yet) is the main checkout that holds the manifest.
hook_instance() {
    local dir="$1" top common main
    HOOK_NAME="" HOOK_HOME="" HOOK_ROOT=""
    [ -n "$dir" ] && [ -d "$dir" ] || return 1
    command -v git >/dev/null 2>&1 || return 1
    top="$(GIT_OPTIONAL_LOCKS=0 git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || return 1
    [ -f "$top/.ghost-protocol/instance.toml" ] || return 1
    # The main checkout (a worktree holds the manifest too).
    common="$(GIT_OPTIONAL_LOCKS=0 git -C "$top" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
    main="$(phys "$(dirname "$common")")"
    # shellcheck source=../../install/lib/instance.sh
    . "$GP_DIR/install/lib/instance.sh"
    manifest_load "$top/.ghost-protocol/instance.toml" >/dev/null 2>&1 || return 1
    HOOK_NAME="$M_NAME"
    if [ -n "$M_ROOT_DIR" ]; then
        HOOK_ROOT="$(phys "$M_ROOT_DIR")"
        HOOK_HOME="$(phys "$HOOK_ROOT/$M_NAME")"
    elif [ -n "$M_DIR" ]; then
        HOOK_HOME="$(phys "$(expand_home "$M_DIR")")"
    else
        HOOK_HOME="$main"
    fi
    [ -d "$HOOK_HOME" ] || HOOK_HOME="$main"
    return 0
}
