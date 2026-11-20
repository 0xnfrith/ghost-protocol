# shellcheck shell=bash
# plugins.sh: step 11, plugins.
#
# GHOST Protocol's own plugin (ghost-protocol@ghost-protocol), from the pinned
# checkout this installer runs from (GP_DIR), added as a directory marketplace
# and installed at user scope. Claude Code reads a directory marketplace's
# plugin straight from that folder, so the instance runs exactly the commit the
# checkout is at: moving the checkout (boot.sh --update) and restarting the
# instance is what updates it. When the plugin is already there, the step
# refreshes Claude Code's record of it (marketplace update, then plugin
# update; both are no-ops when nothing changed). It never repoints a
# marketplace named ghost-protocol that comes from anywhere else, since
# `claude plugin marketplace add` would do that without asking and move every
# instance on the machine that runs from it: that is a FAIL, with the command
# to run by hand. Any failure here stops the run before the service step, so
# the update itself does not restart the instance. The checkout has moved
# already, though, and the instance's next start of any kind would load it:
# the summary says to go back at once (install/install, finish).
#
# On an update whose commits differ in the Buzz adapter's lockfile, the
# adapter's dependencies are installed again from the new lockfile, before
# step 14: the auto-mode guard copies them into its root-owned folder there,
# so it runs the new commit at once, not only after the next full run. When
# that install cannot run or fails, the adapter's node_modules folder is
# removed instead, so the channel installs them (npm ci from the lockfile)
# when the instance starts again. A changed buzz-mcp pin is a warning with the
# build command: buzz-mcp is built by hand for now.
#
# Anthropic's security-guidance plugin, installed at user scope when it is
# missing there. GHOST Protocol recommends security-guidance but never needs
# it. plugin.json declares no dependency on it, because Claude Code does not
# load a plugin whose dependency is missing, and GHOST Protocol must load (and
# with it the Buzz channel) whether or not security-guidance is there. So a
# failure there is a warning and a SKIP line, and the run goes on.
#
# Only the user scope counts. A copy installed for one project (project or
# local scope) does not cover the instance, and every claude call runs from /,
# where no project's settings can turn a plugin on or off.
#
# The instance's own plugins come in a later PR.
# Sourced by install/install only.

SECURITY_PLUGIN="security-guidance@claude-plugins-official"
GP_PLUGIN="ghost-protocol@ghost-protocol"
GP_MARKETPLACE="ghost-protocol"
OFFICIAL_MARKETPLACE="claude-plugins-official"
OFFICIAL_MARKETPLACE_SOURCE="anthropics/claude-plugins-official"

# claude, run from / so no project's settings apply; it never prompts.
plugin_claude() { (cd / && GIT_TERMINAL_PROMPT=0 "$CLAUDE_BIN" "$@" </dev/null); }

# The objects of a JSON array of objects, one line each: id, scope, enabled,
# name, source and path, tab-separated (empty when the object lacks the key). The scanner
# minds strings and nesting, so key order, compact or pretty printing, and
# nested objects or arrays inside an entry change nothing. Anything that is
# not such an array prints nothing.
json_entries() {
    awk '
        { buf = buf $0 "\n" }
        END {
            n = length(buf); depth = 0; ins = 0; esc = 0; want = 0; bare = ""
            split("", v)
            for (i = 1; i <= n; i++) {
                c = substr(buf, i, 1)
                if (ins) {
                    if (esc) { tok = tok c; esc = 0 }
                    else if (c == "\\") { esc = 1 }
                    else if (c == "\"") {
                        ins = 0
                        if (depth == 2) {
                            if (want) { v[key] = tok; want = 0 } else { key = tok }
                        }
                    } else { tok = tok c }
                    continue
                }
                if (c == "\"") { ins = 1; tok = ""; continue }
                if (c == "{" || c == "[") {
                    if (depth == 2 && want) want = 0
                    depth++
                    if (depth == 2) { split("", v); key = ""; want = 0; bare = "" }
                    continue
                }
                if (c == "}" || c == "]") {
                    if (depth == 2) {
                        if (want && bare != "") v[key] = bare
                        printf "%s\t%s\t%s\t%s\t%s\t%s\n", v["id"], v["scope"], v["enabled"], v["name"], v["source"], v["path"]
                    }
                    depth--; want = 0; bare = ""
                    continue
                }
                if (depth != 2) continue
                if (c == ":") { want = 1; bare = ""; continue }
                if (c == ",") { if (want && bare != "") v[key] = bare; want = 0; bare = ""; continue }
                if (want && c ~ /[A-Za-z0-9.+-]/) bare = bare c
            }
        }'
}

# The state of the plugin at user scope: "enabled", "disabled", or nothing
# when it is not installed there (or the list cannot be read).
plugin_state() {   # plugin id
    local out
    out="$(plugin_claude plugin list --json 2>/dev/null)" || true
    awk -F '\t' -v want="$1" '
        $1 == want && $2 == "user" { print ($3 == "true" ? "enabled" : "disabled"); exit }
    ' <<EOF
$(printf '%s\n' "$out" | json_entries)
EOF
}

marketplace_added() {   # name
    local out names
    out="$(plugin_claude plugin marketplace list --json 2>/dev/null)" || true
    names="$(printf '%s\n' "$out" | json_entries | cut -f 4)"
    case "
$names
" in
        *"
$1
"*) return 0 ;;
    esac
    return 1
}

# Where the marketplace of that name comes from: "<source>\t<path>" (path
# only for a directory), or nothing when it is not added.
marketplace_source() {   # name
    local out
    out="$(plugin_claude plugin marketplace list --json 2>/dev/null)" || true
    printf '%s\n' "$out" | json_entries | awk -F '\t' -v want="$1" '
        $4 == want { printf "%s\t%s\n", ($5 == "" ? "unknown" : $5), $6; exit }'
}

# Run one claude command; on failure print its last lines, indented.
plugin_run() {   # args for claude
    local out
    if out="$(plugin_claude "$@" 2>&1)"; then return 0; fi
    printf '%s\n' "$out" | tail -n 5 | sed 's/^/    /' >&2
    return 1
}

plugins_skip() {   # why
    warn "$SECURITY_PLUGIN was not installed: $1."
    warn "GHOST Protocol runs without it. To add it later: claude plugin install $SECURITY_PLUGIN"
    record SKIP security "$SECURITY_PLUGIN not installed ($1); GHOST Protocol runs without it"
}

plugins_security_guidance() {
    local state
    claude_find
    if [ -z "$CLAUDE_BIN" ]; then
        if [ "$DRY_RUN" = "1" ]; then
            record PLAN security "would install $SECURITY_PLUGIN once Claude Code is there"
        else
            plugins_skip "no claude to install it with"
        fi
        return 0
    fi
    state="$(plugin_state "$SECURITY_PLUGIN")"
    case "$state" in
        enabled)
            say "$SECURITY_PLUGIN is installed and enabled (user scope)"
            record OK security "$SECURITY_PLUGIN installed and enabled (user scope)"
            return 0 ;;
        disabled)
            say "$SECURITY_PLUGIN is installed but disabled (user scope); left as it is"
            record OK security "$SECURITY_PLUGIN installed, disabled by choice (user scope); left as it is"
            return 0 ;;
    esac
    if [ "$DRY_RUN" = "1" ]; then
        marketplace_added "$OFFICIAL_MARKETPLACE" || show_cmd claude plugin marketplace add "$OFFICIAL_MARKETPLACE_SOURCE"
        show_cmd claude plugin install "$SECURITY_PLUGIN" --scope user
        record PLAN security "would install $SECURITY_PLUGIN (recommended; a failure would be a warning)"
        return 0
    fi
    if ! marketplace_added "$OFFICIAL_MARKETPLACE"; then
        say "adding Anthropic's official marketplace ($OFFICIAL_MARKETPLACE_SOURCE)"
        if ! plugin_run plugin marketplace add "$OFFICIAL_MARKETPLACE_SOURCE"; then
            plugins_skip "could not add the official marketplace"
            return 0
        fi
    fi
    say "installing $SECURITY_PLUGIN (user scope)"
    if ! plugin_run plugin install "$SECURITY_PLUGIN" --scope user; then
        plugins_skip "claude plugin install failed"
        return 0
    fi
    if [ "$(plugin_state "$SECURITY_PLUGIN")" != "enabled" ]; then
        plugins_skip "it is not listed as enabled at user scope after the install"
        return 0
    fi
    say "$SECURITY_PLUGIN installed"
    record DONE security "$SECURITY_PLUGIN installed (recommended, not required)"
    return 0
}

# The folder GHOST Protocol's plugin is installed from: this checkout. A dry
# run that boot.sh started from a temporary clone names the real checkout
# (GP_TARGET_DIR), so the plan shows the path a real run would use.
gp_plugin_dir() {
    if [ "$DRY_RUN" = "1" ] && [ -n "${GP_TARGET_DIR:-}" ]; then
        phys "$GP_TARGET_DIR"
    else
        phys "$GP_DIR"
    fi
}

gp_fail() {   # why
    record FAIL gp-plugin "$1"
    return 1
}

# The adapter's dependencies from its lockfile, with the command launch.mjs
# runs (npm ci, no dev dependencies, no install scripts), under the lock
# launch.mjs takes, so a channel starting meanwhile never installs at the same
# time. Sets GP_DEPS_WHY and returns 1 when it did not install them.
GP_DEPS_WHY=""
gp_install_dependencies() {   # adapter dir
    local d="$1" rc
    GP_DEPS_WHY=""
    if ! command -v npm >/dev/null 2>&1; then GP_DEPS_WHY="npm is not on PATH"; return 1; fi
    if ! mkdir "$d/.install-lock" 2>/dev/null; then
        GP_DEPS_WHY="another install holds $d/.install-lock"; return 1
    fi
    (cd "$d" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error </dev/null)
    rc=$?
    rm -rf "$d/.install-lock"
    if [ "$rc" -ne 0 ]; then GP_DEPS_WHY="npm ci failed (exit $rc)"; return 1; fi
}

# On an update, the Buzz adapter's dependencies follow its lockfile: when it
# changed, they are installed again now (above), so step 14's auto-mode guard
# copies the new ones. If that cannot run, the folder is removed, since
# launch.mjs installs them only when they are missing, and the next start
# installs the new ones. buzz-mcp is built by hand
# (adapters/buzz/scripts/build-buzz-mcp.sh); a changed pin is a warning. A real
# run only: a dry run's temporary clone holds one commit.
gp_update_dependencies() {   # dir
    local prev="${GP_PREVIOUS_COMMIT:-}" lock="adapters/buzz/package-lock.json" pin="adapters/buzz/buzz-mcp.pin"
    local adapter="$1/adapters/buzz"
    [ "$UPDATE_MODE" = "1" ] && [ -n "$prev" ] && [ "$prev" != "$GP_COMMIT" ] || return 0
    if [ "$DRY_RUN" = "1" ]; then
        say "would compare the Buzz adapter's lockfile and buzz-mcp pin at $prev and $GP_COMMIT;"
        say "  if the lockfile changed, it would install the adapter's dependencies again (npm ci, before step 14)"
        return 0
    fi
    if ! git -C "$1" diff --quiet "$prev" "$GP_COMMIT" -- "$lock" 2>/dev/null; then
        say "the Buzz adapter's lockfile changed (or could not be compared): installing its dependencies again"
        if gp_install_dependencies "$adapter"; then
            say "  installed from the new lockfile (npm ci, no install scripts)"
        elif [ -d "$adapter/.install-lock" ]; then
            warn "the Buzz adapter's dependencies were not installed: $GP_DEPS_WHY (a channel starting now"
            warn "  installs them from the new lockfile). If none is starting, the lock is stale: remove it, then run the update again."
        else
            rm -rf "$adapter/node_modules"
            warn "the Buzz adapter's dependencies were not installed: $GP_DEPS_WHY. Removed its node_modules,"
            warn "  so the channel installs the new ones when the instance starts. Until a run without --update"
            warn "  (or install/automode-guard/setup --apply), an auto-mode guard already set up keeps its old copy."
        fi
    fi
    if ! git -C "$1" diff --quiet "$prev" "$GP_COMMIT" -- "$pin" 2>/dev/null; then
        warn "buzz-mcp's pin changed (or could not be compared). Rebuild it, then restart the instance:"
        warn "  $1/adapters/buzz/scripts/build-buzz-mcp.sh"
    fi
    return 0
}

plugins_gp() {
    local dir src path state where
    dir="$(gp_plugin_dir)"
    if [ ! -f "$GP_DIR/.claude-plugin/marketplace.json" ]; then
        gp_fail "$GP_DIR has no .claude-plugin/marketplace.json"
        return 1
    fi
    claude_find
    if [ -z "$CLAUDE_BIN" ]; then
        if [ "$DRY_RUN" = "1" ]; then
            record PLAN gp-plugin "would install $GP_PLUGIN from $dir (a directory marketplace, user scope) once Claude Code is there"
            return 0
        fi
        gp_fail "no claude to install $GP_PLUGIN with"
        return 1
    fi
    where="$(marketplace_source "$GP_MARKETPLACE")"
    src="$(printf '%s' "$where" | cut -f 1)"
    path="$(printf '%s' "$where" | cut -f 2)"
    if [ -n "$src" ] && { [ "$src" != "directory" ] || [ "$(phys "$path")" != "$dir" ]; }; then
        warn "a marketplace named $GP_MARKETPLACE is already added from ${path:-$src}, not from $dir."
        warn "Adding $dir would repoint it, and every instance on this machine that runs from it, so it is left as it is."
        warn "To run from this checkout, repoint it yourself, then run this again:"
        warn "  claude plugin marketplace add $dir"
        gp_fail "the $GP_MARKETPLACE marketplace comes from ${path:-$src}, not $dir; left as it is"
        return 1
    fi
    state="$(plugin_state "$GP_PLUGIN")"
    if [ -n "$src" ] && [ -n "$state" ]; then
        # There, from this checkout: refresh Claude Code's record of it.
        if [ "$DRY_RUN" = "1" ]; then
            show_cmd claude plugin marketplace update "$GP_MARKETPLACE"
            show_cmd claude plugin update "$GP_PLUGIN" --scope user
            gp_update_dependencies "$dir"
            record PLAN gp-plugin "would refresh $GP_PLUGIN ($state, user scope), read from $dir"
            return 0
        fi
        gp_update_dependencies "$dir"
        if ! plugin_run plugin marketplace update "$GP_MARKETPLACE"; then
            gp_fail "claude plugin marketplace update $GP_MARKETPLACE failed (the output above says why)"
            return 1
        fi
        if ! plugin_run plugin update "$GP_PLUGIN" --scope user; then
            gp_fail "claude plugin update $GP_PLUGIN failed (the output above says why)"
            return 1
        fi
        if [ "$state" = "disabled" ]; then
            warn "$GP_PLUGIN is installed but disabled at user scope; left as it is. The instance hears nothing until it is enabled:"
            warn "  claude plugin enable $GP_PLUGIN --scope user"
            record OK gp-plugin "$GP_PLUGIN refreshed, read from $dir; disabled by choice (user scope), left as it is"
            return 0
        fi
        say "$GP_PLUGIN is installed and enabled (user scope), read from $dir at $GP_COMMIT"
        record OK gp-plugin "$GP_PLUGIN installed and enabled (user scope), read from $dir; refreshed"
        return 0
    fi
    gp_update_dependencies "$dir"
    if [ "$DRY_RUN" = "1" ]; then
        [ -n "$src" ] || show_cmd claude plugin marketplace add "$dir"
        show_cmd claude plugin install "$GP_PLUGIN" --scope user
        record PLAN gp-plugin "would install $GP_PLUGIN from $dir (a directory marketplace, user scope)"
        return 0
    fi
    if [ -z "$src" ]; then
        say "adding $dir as the $GP_MARKETPLACE marketplace (a directory: Claude Code reads the plugin from it)"
        if ! plugin_run plugin marketplace add "$dir"; then
            gp_fail "claude plugin marketplace add $dir failed (the output above says why)"
            return 1
        fi
    fi
    say "installing $GP_PLUGIN (user scope)"
    if ! plugin_run plugin install "$GP_PLUGIN" --scope user; then
        gp_fail "claude plugin install $GP_PLUGIN failed (the output above says why)"
        return 1
    fi
    if [ "$(plugin_state "$GP_PLUGIN")" != "enabled" ]; then
        gp_fail "$GP_PLUGIN is not listed as enabled at user scope after the install"
        return 1
    fi
    say "$GP_PLUGIN installed from $dir at $GP_COMMIT. Its settings come from the instance's settings file."
    record DONE gp-plugin "$GP_PLUGIN installed from $dir (a directory marketplace, user scope)"
    return 0
}

step_plugins() {
    heading "11. plugins"
    plugins_security_guidance
    plugins_gp || return 1
    if [ "$DRY_RUN" = "1" ]; then
        say "would: the instance's own plugins (built in $KIT_PR)"
        record PLAN plugins "the instance's own plugins: built in $KIT_PR"
    else
        say "skipped: the instance's own plugins (built in $KIT_PR)"
        record SKIP plugins "the instance's own plugins: built in $KIT_PR"
    fi
    return 0
}
