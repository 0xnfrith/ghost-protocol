# shellcheck shell=bash
# statusline.sh: step 7b. GHOST Protocol's status line (statusline/README.md)
# in the user's Claude Code settings. A plugin cannot set the main status line
# (Claude Code applies only the agent and subagentStatusLine keys of a plugin's
# settings), so the installer wires it with statusline/wire. It never stops the
# run: a status line that is not wired (no jq, or another status line already
# there) is a warning. Sourced by install/install only.

step_statusline() {
    local out rc
    heading "7b. status line"
    if [ "$DRY_RUN" = "1" ]; then
        out="$("$GP_DIR/statusline/wire" wire --dry-run 2>&1)"
    else
        out="$("$GP_DIR/statusline/wire" wire 2>&1)"
    fi
    rc=$?
    [ -z "$out" ] || printf '%s\n' "$out" | sed 's/^/  /'
    case "$rc:$out" in
        "0:wired"*)   record DONE statusline "wired: $GP_DIR/statusline/statusline.sh" ;;
        "0:already"*) record OK statusline "already wired" ;;
        "0:would"*)   record PLAN statusline "would wire $GP_DIR/statusline/statusline.sh" ;;
        *)
            warn "the status line is not wired (see above)"
            record SKIP statusline "$(printf '%s\n' "$out" | head -n 1)"
            ;;
    esac
    return 0
}
