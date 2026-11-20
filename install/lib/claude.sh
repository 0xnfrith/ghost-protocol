# shellcheck shell=bash
# claude.sh: step 7. The pinned Claude Code (install-claude-code.sh), then the
# Claude sign-in, which must be the manifest's claude.email. On a mismatch it
# signs out a sign-in this run made (never an older one) and stops (5).
# Only the email is ever printed, never the raw status output.
#
# On an update (--update) only the pinned Claude Code is installed: the
# sign-in is not checked. The instance is already set up and running, and its
# sign-in may live where the operator's shell cannot see it, such as a token
# in the instance's service environment.
# Sourced by install/install only.

CLAUDE_BIN=""
CLAUDE_SIGNED_IN_NOW=0

claude_find() {
    if [ -x "$HOME/.local/bin/claude" ]; then
        CLAUDE_BIN="$HOME/.local/bin/claude"
    else
        CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
    fi
}

# Sets CLAUDE_LOGGED_IN (0|1) and CLAUDE_EMAIL from `claude auth status --json`.
claude_status() {
    local json
    CLAUDE_LOGGED_IN=0
    CLAUDE_EMAIL=""
    json="$("$CLAUDE_BIN" auth status --json 2>/dev/null | tr -d '\n\r')"
    if printf '%s' "$json" | grep -qE '"loggedIn"[[:space:]]*:[[:space:]]*true'; then
        CLAUDE_LOGGED_IN=1
        CLAUDE_EMAIL="$(printf '%s' "$json" | sed -n 's/.*"email"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
    fi
    return 0
}

step_claude() {
    local args want
    heading "7. Claude Code"
    args="--profile $PROFILE"
    [ "$DRY_RUN" = "1" ] && args="$args --dry-run"
    # shellcheck disable=SC2086
    if ! "$GP_DIR/install/install-claude-code.sh" $args; then
        record FAIL claude "the pinned Claude Code install failed"
        return 1
    fi
    claude_find
    if [ -z "$CLAUDE_BIN" ]; then
        if [ "$DRY_RUN" = "1" ]; then
            record PLAN claude "would install Claude Code $CLAUDE_CODE_VERSION, then sign in"
            return 0
        fi
        record FAIL claude "no claude after the install"
        return 1
    fi
    if [ "$UPDATE_MODE" = "1" ]; then
        say "update: the Claude sign-in is not checked (the instance is already set up)"
        record OK claude "Claude Code at $CLAUDE_BIN (pin $CLAUDE_CODE_VERSION); sign-in not checked (update)"
        return 0
    fi
    want="$M_CLAUDE_EMAIL"
    claude_status
    if [ "$CLAUDE_LOGGED_IN" != "1" ]; then
        if [ "$DRY_RUN" = "1" ]; then
            show_cmd claude auth login --claudeai --email "${want:-<claude.email>}"
            record PLAN claude "would sign in to Claude${want:+ as $want}"
            return 0
        fi
        if [ "$HAVE_TTY" != "1" ]; then
            EXIT_CODE=4
            record FAIL claude "the Claude sign-in needs a terminal"
            return 1
        fi
        say "Claude sign-in: open the address shown, sign in as $want, and paste the code back."
        if ! "$CLAUDE_BIN" auth login --claudeai --email "$want" <&3; then
            record FAIL claude "the Claude sign-in did not finish"
            return 1
        fi
        CLAUDE_SIGNED_IN_NOW=1
        claude_status
        if [ "$CLAUDE_LOGGED_IN" != "1" ]; then
            record FAIL claude "Claude still reports no sign-in"
            return 1
        fi
    fi
    if [ -z "$want" ]; then
        # Dry run before the manifest could be read.
        record PLAN claude "signed in as $CLAUDE_EMAIL; would compare it with the manifest's claude.email"
        return 0
    fi
    if [ "$(lower "$CLAUDE_EMAIL")" = "$(lower "$want")" ]; then
        say "Signed in to Claude as $CLAUDE_EMAIL."
        if [ "$CLAUDE_SIGNED_IN_NOW" = "1" ]; then
            record DONE claude "signed in as $CLAUDE_EMAIL"
        else
            record OK claude "signed in as $CLAUDE_EMAIL"
        fi
        return 0
    fi
    EXIT_CODE=5
    echo "install: Claude is signed in as ${CLAUDE_EMAIL:-an unknown account}, but this instance expects $want." >&2
    if [ "$DRY_RUN" = "1" ]; then
        record FAIL claude "signed in as ${CLAUDE_EMAIL:-unknown}, not $want (a real run stops here)"
        return 1
    fi
    if [ "$CLAUDE_SIGNED_IN_NOW" = "1" ]; then
        if "$CLAUDE_BIN" auth logout >/dev/null 2>&1; then
            say "signed ${CLAUDE_EMAIL:-that account} out of Claude"
        else
            warn "could not sign out; run: claude auth logout"
        fi
    else
        say "left ${CLAUDE_EMAIL:-that account} signed in: that sign-in was there before this run."
        say "Sign it out with: claude auth logout"
    fi
    record FAIL claude "signed in as ${CLAUDE_EMAIL:-unknown}, not $want: wrong account"
    return 1
}
