#!/usr/bin/env bash
# service.test.sh: install/service/start and its unit template. The unit as
# --print-unit fills it in; the dry run's command (new session, resume, the
# quick-exit fallback, settings, channels); and a start with a stand-in tmux:
# credentials reach the session as variables (names checked, never values),
# reserved names are refused, and the watchdog exits 1 when the session ends.
# Then what start does for every instance:
#   - the checks: GHOST Protocol's plugin installed and enabled where the
#     instance runs, buzz-mcp built, the channel allowed in the managed
#     settings, the home trusted (an untrusted one is refused, and nothing
#     presses a key), and, in a dry run, each credential of the unit decrypts;
#   - the persona: appended as a string, the -file form over 12,000 bytes, a
#     log line when there is none;
#   - the start prompt: its file read on every start, its placeholders filled
#     in, sent after the session's flags and before --channels;
#   - --test: its own tmux socket each run, a clean environment, a test copy
#     of the settings, both notice wordings matched anywhere on a line, the
#     failures (a rejection, a dialog, an exit, a timeout), and nothing left
#     behind on any of them;
#   - a fresh start: the fresh file starts a new session (a dry run, a failed
#     tmux and --test leave it), and a session that ends with it set is
#     started again in place;
#   - claude's own window ends while another window keeps the session alive:
#     claude starts again in a new window of that session (resumed, with the
#     channel, pane-pid and pane-id its own), the server and the other windows
#     left alone; a pane remain-on-exit keeps is closed first; quick ends lead
#     to a new session, then to systemd; a fresh request is taken; the new
#     claude runs without update-environment's names; with real processes,
#     what is left of the old claude is ended (TERM, then KILL), a reused pid
#     is never signalled, and what cannot be ended goes to systemd; and, with
#     a real tmux on a socket of the test's own, the operator's window
#     survives and an attached operator's SSH_AUTH_SOCK never reaches claude;
#   - unattended mode: the plugin option, --permission-mode, the settings copy
#     with its two settings, GP_UNATTENDED, the modes refused, and --test in it;
#   - --fresh: idle restarts into a new session, busy waits and then refuses
#     with the fixed line, a turn the marker missed is still busy, not running
#     sets the file, no watchdog is refused; asked from the instance's own
#     session, it returns at once and waits in the background;
#   - the watchdog's process name is start (Linux);
#   - a key service (the plugin's buzz_key_socket): its two sockets and an
#     empty key command are checked instead of a buzz-mcp build, and --test's
#     copy empties the key socket, so it never touches the instance's own
#     channel; every BUZZ_* and NOSTR_* credential is refused, except the
#     owner's tag (BUZZ_AUTH_TAG) on an instance without a key service.
# Claude Code's JSON files here are fixtures; tmux, claude, sudo and
# systemd-run are stand-ins.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

START="$SRC/install/service/start"
PLUGIN="ghost-protocol@ghost-protocol"

t_new
if ! t_tool python3; then
    echo "SKIP  every case (no python3 on this machine; start's checks need it)"
    finish_tests
    exit $?
fi

# A machine where the instance is ready: the home a checkout, the plugin
# installed and enabled at user scope, buzz-mcp built, the channel allowed in
# the managed settings (a copy, GP_MANAGED_SETTINGS), the home trusted.
setup() {
    t_new
    t_stub tmux; t_stub sudo; t_stub systemd-run
    t_tool uuidgen || true
    t_tool python3
    H="$T/home"; R="$H/work"; HOMEDIR="$R/inst"
    mkdir -p "$HOMEDIR/.git" "$H/.local/bin"
    cp "$FIX/stubs/claude" "$H/.local/bin/claude"; chmod +x "$H/.local/bin/claude"
    STATE_DIR="$H/.local/state/ghost-protocol/inst"
    PROJ="$H/.claude/projects/$(printf '%s' "$HOMEDIR" | sed 's/[^A-Za-z0-9]/-/g')"
    mkdir -p "$H/.claude/plugins" "$H/.cache/ghost-protocol/buzz" "$H/.config/ghost-protocol"
    printf '{"version": 2, "plugins": {"%s": [{"scope": "user"}]}}\n' "$PLUGIN" >"$H/.claude/plugins/installed_plugins.json"
    printf '{"enabledPlugins": {"%s": true}}\n' "$PLUGIN" >"$H/.claude/settings.json"
    printf 'built\n' >"$H/.cache/ghost-protocol/buzz/buzz-mcp.mjs"
    MANAGED_F="$T/managed-settings.json"
    managed true '{"plugin": "ghost-protocol", "marketplace": "ghost-protocol"}'
    trust true
    mkdir -p "$T/tmux"
}
managed() {   # channelsEnabled entry...
    local list="" e
    for e in "${@:2}"; do list="$list${list:+, }$e"; done
    printf '{"channelsEnabled": %s, "allowedChannelPlugins": [%s]}\n' "$1" "$list" >"$MANAGED_F"
}
trust() {   # true|false
    printf '{"numStartups": 3, "projects": {"%s": {"hasTrustDialogAccepted": %s}}}\n' "$HOMEDIR" "$1" >"$H/.claude.json"
}
start_env() { t_env GP_MANAGED_SETTINGS="$MANAGED_F" TMUX_TMPDIR="$T/tmux" "$@"; }
run_start() { start_env "$START" --root \~/work --name inst "$@" >"$OUT" 2>&1; RC=$?; }
SID=0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b
# The arguments claude got in the last new-session, on one line.
args_line() { tr '\n' ' ' <"$T/state/tmux.args"; }
arg_after() { awk -v f="$1" 'p { print; exit } $0 == f { p = 1 }' "$T/state/tmux.args"; }
has_arg() { grep -qxF -- "$1" "$T/state/tmux.args"; }
lacks_arg() { ! grep -qF -- "$1" "$T/state/tmux.args"; }

# 1. --print-unit: every placeholder filled in, the paths absolute.
setup
run_start --print-unit
check "unit: exit 0" rc_is 0
check "unit: no placeholder left" out_lacks '@[A-Z]+@'
check "unit: ExecStart runs start with the root and the name" out_has "^ExecStart=$START --root $R --name inst\$"
check "unit: User is the user running it" out_has "^User=$(id -un)\$"
check "unit: HOME and the working folder" sh -c "grep -q '^WorkingDirectory=$H\$' '$OUT' && grep -q '^Environment=HOME=$H ' '$OUT'"
check "unit: restarts always" out_has '^Restart=always$'
check "unit: wanted by multi-user.target (enabled only by the operator)" out_has '^WantedBy=multi-user.target$'

# 2. A dry run, first start: a new session, the default channel, no settings.
run_start --dry-run
check "dry run: exit 0 (ready)" rc_is 0
check "dry run: READY" out_has '^READY$'
check "dry run: a new session, named" out_has "--session-id +[0-9a-f-]{36} +-n +inst"
check "dry run: the default channel" out_has '--channels +plugin:ghost-protocol@ghost-protocol'
check "dry run: no --settings without the file" out_lacks '  --settings'
check "dry run: it starts nothing" not_called "tmux new-session"
check "dry run: no session id is saved" [ ! -e "$STATE_DIR/session-id" ]
check "dry run: the plugin installed" out_has "^  ok +plugin $PLUGIN installed"
check "dry run: the plugin enabled for the home" out_has "^  ok +plugin $PLUGIN enabled for $HOMEDIR\$"
check "dry run: buzz-mcp built, in the build script's cache" out_has "^  ok +buzz-mcp built \\($H/.cache/ghost-protocol/buzz/buzz-mcp.mjs\\)"
check "dry run: the channel allowed in the managed settings" out_has "^  ok +channel plugin:$PLUGIN allowed in $MANAGED_F"
check "dry run: the home trusted" out_has "^  ok +$HOMEDIR trusted in ~/.claude.json"
check "dry run: no unit, so no credential check" not_called systemd-run

# 3. A saved session with its transcript is resumed; the settings file is used;
#    GP_CHANNELS empty means no channel.
mkdir -p "$STATE_DIR" "$PROJ"
echo "$SID" >"$STATE_DIR/session-id"; echo '{}' >"$PROJ/$SID.jsonl"
echo '{"deniedMcpServers": [{"serverName": "plugin:ghost-protocol:buzz"}, {"serverName": "plugin:ghost-protocol:buzz-channel"}]}' >"$H/.config/ghost-protocol/inst.json"
start_env GP_CHANNELS= "$START" --root \~/work --name inst --dry-run >"$OUT" 2>&1; RC=$?
check "resume: exit 0" rc_is 0
check "resume: --resume the saved id" out_has "--resume +$SID"
check "resume: --settings the instance's file" out_has "--settings +$H/.config/ghost-protocol/inst.json"
check "resume: GP_CHANNELS empty: no --channels" out_lacks '--channels'
check "resume: GP_CHANNELS empty: a note, no channel check" out_has '^  note +GP_CHANNELS is empty: no channel to check'

# 4. Two quick exits in a row: a new session instead.
echo 2 >"$STATE_DIR/quick-exits"
run_start --dry-run
check "two quick exits: a new session" out_has 'ended quickly twice; starting a new session'
check "two quick exits: not resumed" out_lacks '--resume'

# 5. Not ready: no home checkout.
setup; rm -rf "$HOMEDIR/.git"
run_start --dry-run
check "no home: exit 1" rc_is 1
check "no home: NOT READY" out_has '^NOT READY$'
run_start
check "no home: a real start refuses (exit 1)" rc_is 1
check "no home: tmux was never asked" not_called "tmux new-session"

# 6. A start: credentials become variables, a reserved name is refused, the
#    session ends at once (the stand-in has no live session), so start exits 1
#    and counts a quick exit.
setup
mkdir -p "$T/creds"
printf 'fake-one' >"$T/creds/api-token"
printf 'fake-two' >"$T/creds/other.key"
printf 'fake-path' >"$T/creds/path"
start_env CREDENTIALS_DIRECTORY="$T/creds" "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "start: exit 1 when the session ends" rc_is 1
check "start: tmux new-session ran" called "tmux new-session"
check "start: on the instance's own socket" grep -qx 'tmux on inst new-session' "$T/state/calls"
check "start: api-token reached the session as API_TOKEN" grep -qx 'env API_TOKEN set' "$T/state/calls"
check "start: other.key reached it as OTHER_KEY" grep -qx 'env OTHER_KEY set' "$T/state/calls"
check "start: CREDENTIALS_DIRECTORY itself did not" sh -c "! grep -q 'env CREDENTIALS_DIRECTORY' '$T/state/calls'"
check "start: the reserved name path is refused" out_has 'skipped credential PATH: that name is reserved'
check "start: two credentials exported" out_has 'exported 2 credential'
check "start: no credential value is printed" out_lacks 'fake-'
check "start: the session id is saved" sh -c "grep -qE '^[0-9a-f-]{36}\$' '$STATE_DIR/session-id'"
check "start: a quick exit is counted" [ "$(cat "$STATE_DIR/quick-exits")" = 1 ]
check "start: no settings file, so no GP_CLAUDE_SETTINGS" sh -c "! grep -q 'env GP_CLAUDE_SETTINGS' '$T/state/calls'"
check "start: the watch targets the session by its exact name" grep -qx 'tmux target has-session =inst' "$T/state/calls"
check "start: no persona file: one log line says so" out_has "^start: no persona file at $HOMEDIR/.claude/persona/inst.md; starting without the persona\$"
check "start: no persona file: no --append-system-prompt of either form" lacks_arg --append-system-prompt
check "start: GP_START_PROMPT unset: no start prompt (the session's flags, then --channels)" \
    [ "$(args_line)" = "--session-id $(cat "$STATE_DIR/session-id") -n inst --channels plugin:$PLUGIN " ]

# 6b. With the instance's settings file, the status line is told about it.
setup
echo '{}' >"$H/.config/ghost-protocol/inst.json"
run_start
check "start with settings: GP_CLAUDE_SETTINGS reached the session" grep -qx 'env GP_CLAUDE_SETTINGS set' "$T/state/calls"

# 7. tmux failing to start: exit 1, said plainly.
setup; touch "$T/state/tmux.fail"
run_start
check "tmux fails: exit 1" rc_is 1
check "tmux fails: it says so" out_has 'tmux new-session failed'

# 8. Usage.
setup
start_env "$START" --name inst >"$OUT" 2>&1; RC=$?
check "no --root: exit 2" rc_is 2
start_env "$START" --root \~/work --name Bad >"$OUT" 2>&1; RC=$?
check "a bad name: exit 2" rc_is 2
start_env "$START" --root \~/work --name media >"$OUT" 2>&1; RC=$?
check "a layout folder as the name: exit 2" rc_is 2
run_start --dry-run --test
check "--dry-run with --test: exit 2" rc_is 2
run_start --help
check "--help: exit 0" rc_is 0
check "--help: names the new settings" sh -c "grep -q 'GP_PERSONA' '$OUT' && grep -q 'GP_START_PROMPT' '$OUT' && grep -q -- '--test' '$OUT'"
check "--help: stops at the end of the comment block" out_lacks '^set -uo pipefail'

# ---------------------------------------------------------------- the checks

# 9. Each check in turn: NOT READY, the line that says what, and a real start
#    refuses without asking tmux for anything.
not_ready() {   # name pattern
    run_start --dry-run
    check "$1: dry run NOT READY" sh -c "[ $RC = 1 ] && grep -q '^NOT READY\$' '$OUT'"
    check "$1: the MISSING line" out_has "^  MISSING +$2"
    run_start
    check "$1: a start refuses" sh -c "[ $RC = 1 ] && grep -q 'a check above failed; not starting\$' '$OUT'"
    check "$1: tmux never asked" not_called "tmux new-session"
}
setup; rm "$H/.claude/plugins/installed_plugins.json"
not_ready "plugin not installed" "plugin $PLUGIN installed"
setup; printf '{"version": 2, "plugins": {"other@else": [{}]}}\n' >"$H/.claude/plugins/installed_plugins.json"
not_ready "another plugin installed" "plugin $PLUGIN installed"
setup; printf '{"enabledPlugins": {"%s": false}}\n' "$PLUGIN" >"$H/.claude/settings.json"
not_ready "plugin disabled at user scope" "plugin $PLUGIN enabled for"
setup; echo '{}' >"$H/.claude/settings.json"
not_ready "plugin enabled nowhere" "plugin $PLUGIN enabled for"
#    The first file that names it decides: local over user, both ways.
setup; mkdir -p "$HOMEDIR/.claude"; printf '{"enabledPlugins": {"%s": false}}\n' "$PLUGIN" >"$HOMEDIR/.claude/settings.local.json"
not_ready "plugin disabled in the home's local settings" "plugin $PLUGIN enabled for"
setup; mkdir -p "$HOMEDIR/.claude"
printf '{"enabledPlugins": {"%s": false}}\n' "$PLUGIN" >"$H/.claude/settings.json"
printf '{"enabledPlugins": {"%s": true}}\n' "$PLUGIN" >"$HOMEDIR/.claude/settings.local.json"
run_start --dry-run
check "enabled in the home's local settings, disabled for the user: ready" rc_is 0
setup; printf '{"enabledPlugins": {"%s": true}}\n' "$PLUGIN" >"$H/.config/ghost-protocol/inst.json"
printf '{"enabledPlugins": {"%s": false}}\n' "$PLUGIN" >"$H/.claude/settings.json"
run_start --dry-run
check "enabled in the --settings file: ready" rc_is 0
setup; rm "$H/.cache/ghost-protocol/buzz/buzz-mcp.mjs"
not_ready "buzz-mcp not built" "buzz-mcp built"
#    No channel (GP_CHANNELS empty): the plugin's two Buzz servers must be
#    denied in the managed settings or the --settings file; then buzz-mcp is
#    not needed, so not checked.
NO_CH_DENY='{"deniedMcpServers": [{"serverName": "plugin:ghost-protocol:buzz"}, {"serverName": "plugin:ghost-protocol:buzz-channel"}]}'
no_channel() { start_env GP_CHANNELS="$1" "$START" --root \~/work --name inst --dry-run >"$OUT" 2>&1; RC=$?; }
setup; rm "$H/.cache/ghost-protocol/buzz/buzz-mcp.mjs"
echo "$NO_CH_DENY" >"$H/.config/ghost-protocol/inst.json"
no_channel ""
check "no channel, both Buzz servers denied in the --settings file, buzz-mcp not built: ready" rc_is 0
check "no channel: no buzz-mcp check" out_lacks 'buzz-mcp built'
check "no channel: a note says the Buzz servers must be off" out_has '^  note +GP_CHANNELS is empty: no channel, so the plugin.s Buzz servers must be off'
check "no channel: buzz denied, checked" out_has '^  ok +MCP server plugin:ghost-protocol:buzz denied'
check "no channel: buzz-channel denied, checked" out_has '^  ok +MCP server plugin:ghost-protocol:buzz-channel denied'
setup; rm "$H/.cache/ghost-protocol/buzz/buzz-mcp.mjs"
printf '{"channelsEnabled": true, "deniedMcpServers": [{"serverName": "plugin:ghost-protocol:buzz"}, {"serverName": "plugin:ghost-protocol:buzz-channel"}]}\n' >"$MANAGED_F"
no_channel ""
check "no channel, both denied in the managed settings: ready" rc_is 0
setup; rm "$H/.cache/ghost-protocol/buzz/buzz-mcp.mjs"
no_channel ""
check "no channel, the Buzz servers not denied: NOT READY" sh -c "[ $RC = 1 ] && grep -q '^NOT READY\$' '$OUT'"
check "no channel, not denied: buzz MISSING" out_has '^  MISSING +MCP server plugin:ghost-protocol:buzz denied'
start_env GP_CHANNELS= "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "no channel, not denied: a start refuses" sh -c "[ $RC = 1 ] && grep -q 'a check above failed; not starting\$' '$OUT'"
check "no channel, not denied: tmux never asked" not_called "tmux new-session"
setup; rm "$H/.cache/ghost-protocol/buzz/buzz-mcp.mjs"
echo '{"deniedMcpServers": [{"serverName": "plugin:ghost-protocol:buzz"}]}' >"$H/.config/ghost-protocol/inst.json"
no_channel ""
check "no channel, only buzz denied: NOT READY on buzz-channel" sh -c "[ $RC = 1 ] && grep -q '^  MISSING  MCP server plugin:ghost-protocol:buzz-channel denied' '$OUT'"
#    GP_CHANNELS trimmed once: only blanks or only commas means no channel.
for v in "   " ",, ,"; do
    setup; rm "$H/.cache/ghost-protocol/buzz/buzz-mcp.mjs"
    echo "$NO_CH_DENY" >"$H/.config/ghost-protocol/inst.json"
    no_channel "$v"
    check "GP_CHANNELS '$v': no channel, ready" rc_is 0
    check "GP_CHANNELS '$v': no --channels" out_lacks '--channels'
done
#    A GP_CHANNELS with a newline is refused, not cut to its first line.
setup
no_channel "plugin:ghost-protocol@ghost-protocol
other:channel"
check "GP_CHANNELS with a newline: refused (exit 2)" rc_is 2
check "GP_CHANNELS with a newline: said" out_has 'GP_CHANNELS must be one line'
check "GP_CHANNELS with a newline: tmux never asked" not_called "tmux new-session"
setup
no_channel " plugin:ghost-protocol@ghost-protocol , ,"
check "GP_CHANNELS with blanks and empty names: trimmed to the one channel" out_has '--channels +plugin:ghost-protocol@ghost-protocol$'
setup; rm "$H/.cache/ghost-protocol/buzz/buzz-mcp.mjs"
printf 'built\n' >"$T/buzz-mcp.mjs"
printf '{"pluginConfigs": {"%s": {"options": {"buzz_mcp_path": "%s"}}}}\n' "$PLUGIN" "$T/buzz-mcp.mjs" >"$H/.config/ghost-protocol/inst.json"
run_start --dry-run
check "buzz-mcp at the plugin's buzz_mcp_path: ready" sh -c "[ $RC = 0 ] && grep -q '^  ok *buzz-mcp built ($T/buzz-mcp.mjs)' '$OUT'"
setup; managed false '{"plugin": "ghost-protocol", "marketplace": "ghost-protocol"}'
not_ready "channels not enabled in the managed settings" "channel plugin:$PLUGIN allowed"
setup; managed true '{"plugin": "other", "marketplace": "ghost-protocol"}'
not_ready "the plugin not on the managed allowlist" "channel plugin:$PLUGIN allowed"
setup; rm "$MANAGED_F"
not_ready "no managed settings" "channel plugin:$PLUGIN allowed"
setup; rm "$T/sysbin/python3"
not_ready "no python3" "python3"
#    An untrusted home: refused, with the reason, and never a key pressed.
setup; trust false
not_ready "untrusted home" "$HOMEDIR trusted in ~/.claude.json"
check "untrusted home: the log says why it is refused" out_has "the instance's home $HOMEDIR is not trusted in ~/.claude.json: claude would wait at the trust dialog and hear nothing"
check "untrusted home: and how to trust it, by hand" out_has 'start never answers a dialog. Trust the folder once by hand'
setup; printf '{"projects": {}}\n' >"$H/.claude.json"
not_ready "home not listed in ~/.claude.json" "$HOMEDIR trusted"
setup; rm "$H/.claude.json"
not_ready "no ~/.claude.json" "$HOMEDIR trusted"
check "start never presses a key: no send-keys in it" sh -c "! grep -q 'send-keys' '$START'"
check "every pane read targets =<session>: (exact name, its current pane)" \
    sh -c "[ \"\$(grep -c 'capture-pane' '$START')\" = \"\$(grep -c 'capture-pane .*-t \"=\$SESSION:\"' '$START')\" ]"

# 10. The credential check, in a dry run outside the service: each
#     LoadCredentialEncrypted= of the unit and its drop-ins, through sudo -n
#     and a throwaway systemd-run.
creds_world() {
    setup
    mkdir -p "$T/etc/systemd/system/inst.service.d"
    printf '[Service]\nLoadCredentialEncrypted=old-token:/etc/credstore.encrypted/old-token\n' >"$T/etc/systemd/system/inst.service"
    printf '[Service]\nLoadCredentialEncrypted=\nLoadCredentialEncrypted=api-token:/etc/credstore.encrypted/api-token\n  LoadCredentialEncrypted=relay.key\n' \
        >"$T/etc/systemd/system/inst.service.d/instance.conf"
    touch "$T/state/sudo.allow"
}
creds_world
start_env GP_ETC="$T/etc" "$START" --root \~/work --name inst --dry-run >"$OUT" 2>&1; RC=$?
check "credentials: ready" rc_is 0
check "credentials: api-token decrypts, exported as API_TOKEN" out_has '^  ok +credential api-token decrypts \(exported as API_TOKEN\)'
check "credentials: relay.key (no path) decrypts, exported as RELAY_KEY" out_has '^  ok +credential relay.key decrypts \(exported as RELAY_KEY\)'
check "credentials: an empty LoadCredentialEncrypted= drops the ones before it" sh -c "! grep -q 'old-token' '$OUT' && ! grep -q 'credential old-token' '$T/state/calls'"
check "credentials: through sudo -n" sh -c "grep -q '^sudo -n ' '$T/state/calls' && ! grep -qE '^sudo [0-9]' '$T/state/calls'"
check "credentials: the throwaway unit runs as the instance's user" grep -qx "systemd-run credential api-token user $(id -un)" "$T/state/calls"
creds_world; echo "relay.key" >"$T/state/systemd-run.bad"
start_env GP_ETC="$T/etc" "$START" --root \~/work --name inst --dry-run >"$OUT" 2>&1; RC=$?
check "a credential that does not decrypt: NOT READY" sh -c "[ $RC = 1 ] && grep -q '^  MISSING  credential relay.key decrypts' '$OUT'"
creds_world; rm "$T/state/sudo.allow"; touch "$T/state/sudo.needs-password"
start_env GP_ETC="$T/etc" "$START" --root \~/work --name inst --dry-run >"$OUT" 2>&1; RC=$?
check "no root without a password: a note, still ready" sh -c "[ $RC = 0 ] && grep -q '^  note *the unit.s credentials were not checked: it needs root' '$OUT'"
check "no root: systemd-run never ran" not_called systemd-run
creds_world
start_env GP_ETC="$T/etc" CREDENTIALS_DIRECTORY="$T/state" "$START" --root \~/work --name inst --dry-run >"$OUT" 2>&1; RC=$?
check "inside the service (CREDENTIALS_DIRECTORY set): not checked" not_called systemd-run
creds_world
start_env GP_ETC="$T/etc" "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "a real start leaves the credentials to systemd" not_called systemd-run

# ---------------------------------------------------------------- the persona

# 11. The persona file at its default place: appended as a string, whole,
#     right after --settings.
setup
mkdir -p "$HOMEDIR/.claude/persona"
printf 'You are the test instance.\nSay little.\n' >"$HOMEDIR/.claude/persona/inst.md"
echo '{}' >"$H/.config/ghost-protocol/inst.json"
run_start
check "persona: --append-system-prompt right after --settings" \
    sh -c "[ \"\$(sed -n '3p' '$T/state/tmux.args')\" = --append-system-prompt ] && [ \"\$(sed -n '1p' '$T/state/tmux.args')\" = --settings ]"
check "persona: its whole text (the last newline dropped), as one argument" \
    sh -c "[ \"\$(sed -n '4,5p' '$T/state/tmux.args')\" = \"\$(printf 'You are the test instance.\nSay little.')\" ]"
check "persona: never the -file form under 12,000 bytes" lacks_arg --append-system-prompt-file
check "persona: never --agent (it would replace the built-in prompt)" lacks_arg --agent
run_start --dry-run
check "persona: the dry run names it and its size" out_has 'the\\ persona:\\ 39\\ bytes\\ from'
check "persona: the dry run leaves its text out" out_lacks 'Say'

#     GP_PERSONA: a path of its own, relative to the home.
setup; mkdir -p "$HOMEDIR/notes"; printf 'Elsewhere.\n' >"$HOMEDIR/notes/me.md"
start_env GP_PERSONA=notes/me.md "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "GP_PERSONA relative to the home" sh -c "[ \"\$(sed -n '2p' '$T/state/tmux.args')\" = Elsewhere. ]"
start_env GP_PERSONA="$T/nowhere.md" "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "GP_PERSONA missing: one log line, no flag" sh -c "grep -qx 'start: no persona file at $T/nowhere.md; starting without the persona' '$OUT' && ! grep -q append-system-prompt '$T/state/tmux.args'"
#     Over 12,000 bytes: the -file form, by its path, with a log line.
setup; mkdir -p "$HOMEDIR/.claude/persona"
head -c 12001 /dev/zero | tr '\0' 'a' >"$HOMEDIR/.claude/persona/inst.md"
run_start
check "persona over 12,000 bytes: the -file form, by its path" \
    sh -c "[ \"\$(sed -n '1,2p' '$T/state/tmux.args' | tr '\n' ' ')\" = '--append-system-prompt-file $HOMEDIR/.claude/persona/inst.md ' ]"
check "persona over 12,000 bytes: the log says so" out_has 'is 12001 bytes, over 12000, too long for tmux as a string'
head -c 12000 /dev/zero | tr '\0' 'a' >"$HOMEDIR/.claude/persona/inst.md"
run_start
check "persona of exactly 12,000 bytes: still a string" sh -c "[ \"\$(sed -n '1,2p' '$T/state/tmux.args' | tr '\n' ' ')\" = '--append-system-prompt <long 12000> ' ]"
#     Unreadable: the same as none.
chmod 000 "$HOMEDIR/.claude/persona/inst.md"
if [ -r "$HOMEDIR/.claude/persona/inst.md" ]; then echo "SKIP  unreadable persona (this user reads a mode-000 file)"; else
    run_start
    check "unreadable persona: no flag" lacks_arg --append-system-prompt
    check "unreadable persona: the log says so" out_has 'is not a readable file; starting without the persona'
fi
chmod 600 "$HOMEDIR/.claude/persona/inst.md"

# ---------------------------------------------------------------- the start prompt

# 12. GP_START_PROMPT: read on every start, its placeholders filled in, after
#     the session's flags and before --channels.
setup
printf 'Back on {{host}} at {{time}}. {{session_note}} Again: {{host}}.\n' >"$T/prompt.txt"
HOST_SHORT="$(uname -n)"; HOST_SHORT="${HOST_SHORT%%.*}"
prompt_start() { start_env GP_START_PROMPT="$T/prompt.txt" "$START" --root \~/work --name inst "$@" >"$OUT" 2>&1; RC=$?; }
prompt_start
P="$(arg_after inst)"
check "start prompt: placed after -n <name>, before --channels" sh -c "[ \"\$(tail -n 3 '$T/state/tmux.args' | sed -n '2p')\" = --channels ]"
check "start prompt: host (short), time and a new session's note" \
    sh -c "printf '%s' \"\$1\" | grep -qE '^Back on $HOST_SHORT at [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} [+-][0-9]{4}\\. Started a new session\\. Again: $HOST_SHORT\\.\$'" _ "$P"
check "start prompt: no placeholder left" sh -c "! grep -q '{{' '$T/state/tmux.args'"
#     The next start resumes: its note names the session.
mkdir -p "$PROJ"; echo '{}' >"$PROJ/$(cat "$STATE_DIR/session-id").jsonl"
prompt_start
check "start prompt: a resumed session's note" sh -c "printf '%s' \"\$1\" | grep -q 'Resumed session $(cat "$STATE_DIR/session-id")\\. Again'" _ "$(arg_after "$(cat "$STATE_DIR/session-id")")"
#     Two quick exits: a new session, and the note says why.
echo 2 >"$STATE_DIR/quick-exits"
prompt_start
check "start prompt: after two quick exits" sh -c "printf '%s' \"\$1\" | grep -q 'Started a new session (the previous one exited twice quickly)\\. Again'" _ "$(arg_after inst)"
#     The dry run shows it filled in.
prompt_start --dry-run
check "start prompt: the dry run shows it" out_has 'Back\\ on\\ '
#     A missing file: no start prompt, one log line.
start_env GP_START_PROMPT="$T/none.txt" "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "start prompt file missing: the log says so" out_has "^start: no start prompt file at $T/none.txt; starting without a start prompt\$"
check "start prompt file missing: none sent" [ "$(arg_after inst)" = --channels ]
#     Over 3,000 bytes filled in: left out, with a log line.
head -c 3001 /dev/zero | tr '\0' 'a' >"$T/prompt.txt"
prompt_start
check "start prompt over 3,000 bytes: left out" [ "$(arg_after inst)" = --channels ]
check "start prompt over 3,000 bytes: the log says so" out_has 'is 3001 bytes filled in, over 3000'
#     GP_TIME_ZONE: {{time}} in that zone; nothing else gets TZ.
printf 'At {{time}}.\n' >"$T/prompt.txt"
if [ -f /usr/share/zoneinfo/Etc/GMT-3 ]; then
    start_env GP_START_PROMPT="$T/prompt.txt" GP_TIME_ZONE=Etc/GMT-3 "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
    check "GP_TIME_ZONE: {{time}} in that zone (+0300)" sh -c "printf '%s' \"\$1\" | grep -qE '^At [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} \\+0300\\.\$'" _ "$(arg_after inst)"
    check "GP_TIME_ZONE: claude gets no TZ" sh -c "! grep -qx 'env TZ set' '$T/state/calls'"
else
    echo "SKIP  GP_TIME_ZONE (no /usr/share/zoneinfo/Etc/GMT-3 here)"
fi
start_env GP_START_PROMPT="$T/prompt.txt" GP_TIME_ZONE=Nowhere/Land "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "GP_TIME_ZONE unknown: the local zone, said" sh -c "grep -q 'GP_TIME_ZONE Nowhere/Land is not a time zone this machine knows' '$OUT' && printf '%s' \"\$1\" | grep -q ' $(date +%z)\\.\$'" _ "$(arg_after inst)"
start_env GP_START_PROMPT="$T/prompt.txt" GP_TIME_ZONE='../../etc/passwd' "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "GP_TIME_ZONE not a zone name: refused, the local zone" out_has 'GP_TIME_ZONE \.\./\.\./etc/passwd is not a time zone'
#     A relative path is read from the home.
printf 'Hello from {{host}}.\n' >"$HOMEDIR/start-prompt.md"
start_env GP_START_PROMPT=start-prompt.md "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "start prompt: a relative path is read from the home" [ "$(arg_after inst)" = "Hello from $HOST_SHORT." ]

# ---------------------------------------------------------------- --test

NOTICE_NEW="Channels (experimental) messages from plugin:$PLUGIN inject directly in this session"
test_world() {
    setup
    touch "$T/state/tmux.alive"
    printf '{"pluginConfigs": {"%s": {"options": {"buzz_relay_url": "https://relay.example.com", "buzz_key_command": "secret-tool lookup key", "buzz_watch_pubkey": "abc", "buzz_channels": "*"}}}}\n' \
        "$PLUGIN" >"$H/.config/ghost-protocol/inst.json"
    cp "$H/.config/ghost-protocol/inst.json" "$T/settings.before"
    mkdir -p "$STATE_DIR" "$PROJ"
    echo "$SID" >"$STATE_DIR/session-id"; echo '{}' >"$PROJ/$SID.jsonl"
}
screen() { printf '%s\n' "$@" >"$T/state/tmux.screen"; }
run_test() { start_env GP_START_TEST_TIMEOUT="${TIMEOUT:-60}" "$START" --root \~/work --name inst --test >"$OUT" 2>&1; RC=$?; }
test_socket() { sed -n 's/^tmux on \(inst-test-[0-9]*-[0-9]*\) new-session$/\1/p' "$T/state/calls"; }
nothing_left() {   # no socket file, no temporary folder of start's (Claude Code's own claude-<uid> is checked below)
    [ -z "$(ls -A "$T/tmux/tmux-$(id -u)" 2>/dev/null)" ] && [ -z "$(find "$T/tmp" -mindepth 1 -maxdepth 1 ! -name 'claude-*' 2>/dev/null)" ]
}
killed_own() { grep -qx "tmux on $(test_socket) kill-server" "$T/state/calls"; }

# 13. Claude Code 2.1.314's notice, with a side panel on the same line.
test_world
printf 'Hi from {{host}}.\n' >"$T/prompt.txt"
#    claude stands in as a process that ends a second after it starts; the
#    stand-in tmux makes the files Claude Code keeps for a session.
touch "$T/state/tmux.claude-files"
sleep 1 & PANE=$!
echo "$PANE" >"$T/state/tmux.pane-pid"
screen "  ✻ Welcome" "│ $NOTICE_NEW   │ Tasks  0 open │" "> "
mkdir -p "$T/creds"; printf 'fake-one' >"$T/creds/api-token"
start_env CREDENTIALS_DIRECTORY="$T/creds" CANARY_TOKEN=canary CLAUDE_CODE_OAUTH_TOKEN=fake-sign-in \
    CLAUDE_CODE_SESSION_ID=caller-session CLAUDE_CODE_MESSAGING_SOCKET="$T/caller.sock" GP_START_PROMPT="$T/prompt.txt" \
    "$START" --root \~/work --name inst --test >"$OUT" 2>&1; RC=$?
check "test: exit 0" rc_is 0
check "test: the verdict quotes the notice alone" grep -qx "start: CHANNEL REGISTERED with no dialog: $NOTICE_NEW" "$OUT"
check "test: a socket of its own, named for this run" [ -n "$(test_socket)" ]
check "test: never a call on the instance's socket" sh -c "! grep -qE '^tmux on inst [a-z-]+$' '$T/state/calls'"
check "test: session inst-test" sh -c "grep -qx 'tmux target capture-pane =inst-test:' '$T/state/calls'"
check "test: every pane read targets =inst-test:" sh -c "! grep '^tmux target capture-pane ' '$T/state/calls' | grep -vqx 'tmux target capture-pane =inst-test:'"
check "test: read at once (one read was enough)" [ "$(grep -c '^tmux capture-pane ' "$T/state/calls")" = 1 ]
check "test: a new session id, named inst-test" [ "$(arg_after -n)" = inst-test ] && [ "$(arg_after --session-id)" != "$SID" ]
check "test: never the saved session" lacks_arg "$SID"
check "test: the saved session id is untouched" [ "$(cat "$STATE_DIR/session-id")" = "$SID" ]
check "test: no quick exit counted" [ ! -e "$STATE_DIR/quick-exits" ]
check "test: no start prompt, though one is set" [ "$(arg_after inst-test)" = --channels ]
check "test: no credential reaches the session" sh -c "! grep -qE 'env (API_TOKEN|CREDENTIALS_DIRECTORY) set' '$T/state/calls'"
check "test: nothing else of the caller's either" sh -c "! grep -q 'env CANARY_TOKEN set' '$T/state/calls'"
check "test: Claude Code's sign-in does (CLAUDE_CODE_OAUTH_TOKEN)" grep -qx 'env CLAUDE_CODE_OAUTH_TOKEN set' "$T/state/calls"
check "test: never the CLAUDE_CODE_ names of the session it runs from" sh -c "! grep -qE 'env CLAUDE_CODE_(SESSION_ID|MESSAGING_SOCKET) set' '$T/state/calls'"
check "test: the test copy is the status line's settings" grep -qx 'env GP_CLAUDE_SETTINGS set' "$T/state/calls"
check "test: --settings is a copy, not the instance's file" [ "$(arg_after --settings)" != "$H/.config/ghost-protocol/inst.json" ]
copy_opt() { t_env python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["pluginConfigs"][sys.argv[2]]["options"][sys.argv[3]])' "$T/state/tmux.settings" "$PLUGIN" "$1"; }
check "test copy: the relay is an unreachable local port" [ "$(copy_opt buzz_relay_url)" = "https://127.0.0.1:9" ]
check "test copy: the key command prints random bytes" [ "$(copy_opt buzz_key_command)" = 'od -An -N32 -tx1 /dev/urandom | tr -d " \n"' ]
check "test copy: the watched key is the random key's own" [ -z "$(copy_opt buzz_watch_pubkey)" ]
check "test copy: the other options are kept" [ "$(copy_opt buzz_channels)" = "*" ]
check "test: the instance's settings file is unchanged" cmp -s "$T/settings.before" "$H/.config/ghost-protocol/inst.json"
check "test: its tmux server is stopped" killed_own
check "test: nothing left behind (socket file, temporary folder)" nothing_left
TSID="$(arg_after --session-id)"
check "test: it waited for claude to end" sh -c "! kill -0 $PANE 2>/dev/null"
check "test: claude's pane found by its exact target" grep -qx 'tmux target display-message =inst-test:' "$T/state/calls"
check "test: the throwaway session's transcript, folders and temporary folder are removed" \
    sh -c "[ -n '$TSID' ] && [ -z \"\$(find '$H/.claude' '$T/tmp' -name '*$TSID*' 2>/dev/null)\" ]"
check "test: the instance's own session transcript stays" [ -f "$PROJ/$SID.jsonl" ]
wait "$PANE" 2>/dev/null
S1="$(test_socket)"

# 14. The older wording. And a second run gets another socket.
test_world
screen "Listening for messages from: plugin:$PLUGIN"
run_test
check "older notice: exit 0" rc_is 0
check "older notice: the verdict" out_has "^start: CHANNEL REGISTERED with no dialog: Listening for messages from: plugin:$PLUGIN\$"
check "a second run: another socket" sh -c "[ -n '$(test_socket)' ] && [ '$(test_socket)' != '$S1' ]"
check "older notice: nothing left behind" nothing_left

# 15. The failures, each one cleaned up after.
test_world
screen "  plugin:$PLUGIN is not on your org's approved channels list"
run_test
check "rejected: exit 1" rc_is 1
check "rejected: the verdict, with the line" out_has "^start: CHANNEL REJECTED: plugin:$PLUGIN is not on your org's approved channels list\$"
check "rejected: stopped, nothing left" sh -c "grep -qx 'tmux on $(test_socket) kill-server' '$T/state/calls'" && nothing_left
test_world
screen " Do you trust the files in this folder?" " 1. Yes, proceed"
run_test
check "a dialog: exit 1" rc_is 1
check "a dialog: said, and no key pressed" sh -c "grep -q '^start: A DIALOG IS WAITING for a key (start never presses one): Do you trust the files in this folder' '$OUT' && ! grep -q send-keys '$T/state/calls'"
check "a dialog: nothing left" nothing_left
#    A dialog and the notice on one screen: a real start would wait at the
#    dialog, so the test fails, whatever order they show in.
for order in notice-first dialog-first; do
    test_world
    if [ "$order" = notice-first ]; then
        screen "│ $NOTICE_NEW │" " Do you trust the files in this folder?" " 1. Yes, proceed"
    else
        screen " Do you trust the files in this folder?" "│ $NOTICE_NEW │"
    fi
    run_test
    check "a dialog and the notice ($order): exit 1" rc_is 1
    check "a dialog and the notice ($order): the dialog is the verdict" out_has '^start: A DIALOG IS WAITING for a key \(start never presses one\): Do you trust the files in this folder'
    check "a dialog and the notice ($order): never REGISTERED" out_lacks 'CHANNEL REGISTERED'
done
#    Claude Code 2.1.314's project MCP-server approval, one server or several.
test_world
screen "│ $NOTICE_NEW │" " New MCP server found in this project: example" " > 1. Use this MCP server" "   3. Continue without using this MCP server"
run_test
check "MCP-server dialog: exit 1" rc_is 1
check "MCP-server dialog: the verdict names it" out_has '^start: A DIALOG IS WAITING for a key \(start never presses one\): New MCP server found in this project: example$'
test_world
screen " 2 new MCP servers found in this project" " Select any you wish to enable."
run_test
check "MCP-servers dialog (several): exit 1, said" sh -c "[ $RC = 1 ] && grep -q '^start: A DIALOG IS WAITING .*: 2 new MCP servers found in this project' '$OUT'"
test_world
rm "$T/state/tmux.alive"
run_test
check "claude exits: exit 1" rc_is 1
check "claude exits: said" out_has '^start: claude exited during the test$'
check "claude exits: the exit check targets =inst-test" grep -qx 'tmux target has-session =inst-test' "$T/state/calls"
check "claude exits: nothing left" nothing_left
test_world
TIMEOUT=2 run_test
check "no notice: exit 1" rc_is 1
check "no notice: a timeout, said" out_has '^start: no channel notice within 2s$'
check "no notice: it kept reading" [ "$(grep -c '^tmux capture-pane ' "$T/state/calls")" -ge 2 ]
check "no notice: stopped, nothing left" sh -c "grep -qx 'tmux on $(test_socket) kill-server' '$T/state/calls'" && nothing_left
test_world; touch "$T/state/tmux.fail"
run_test
check "tmux fails: exit 1, said, nothing left" sh -c "[ $RC = 1 ] && grep -q 'tmux new-session failed' '$OUT'" && nothing_left

# 16. What a test refuses: no channel, an untrusted home, any failed check.
test_world
start_env GP_CHANNELS= "$START" --root \~/work --name inst --test >"$OUT" 2>&1; RC=$?
check "no channel: refused" sh -c "[ $RC = 1 ] && grep -q 'needs a channel to test' '$OUT'"
test_world; trust false
run_test
check "untrusted home: the test refuses" sh -c "[ $RC = 1 ] && grep -q 'not trusted in ~/.claude.json' '$OUT' && grep -q 'not starting the test' '$OUT'"
check "untrusted home: tmux never asked" not_called "tmux new-session"
check "untrusted home: nothing left" nothing_left
#     No settings file: the copy is made from nothing.
test_world; rm "$H/.config/ghost-protocol/inst.json"
screen "$NOTICE_NEW"
run_test
check "no settings file: the test still runs" rc_is 0
check "no settings file: the copy holds the test relay" [ "$(copy_opt buzz_relay_url)" = "https://127.0.0.1:9" ]
#     A settings file that is not JSON: refused, said.
test_world; echo 'not json' >"$H/.config/ghost-protocol/inst.json"
run_test
check "settings not JSON: refused, nothing left" sh -c "[ $RC = 1 ] && grep -q 'could not write the test copy' '$OUT'" && nothing_left

# ---------------------------------------------------------------- a fresh start

# 18. The fresh file: a new session instead of a resume, the file deleted once
#     claude runs; a dry run, a failed tmux and --test leave it.
fresh_world() {
    setup
    mkdir -p "$STATE_DIR" "$PROJ"
    echo "$SID" >"$STATE_DIR/session-id"; echo '{}' >"$PROJ/$SID.jsonl"
    : >"$STATE_DIR/fresh"
}
fresh_world
run_start --dry-run
check "fresh, dry run: said, with the session it does not resume" out_has "a fresh start was asked for \\($STATE_DIR/fresh\\); starting a new session instead of resuming $SID"
check "fresh, dry run: a new session, not --resume" sh -c "! grep -q -- '--resume' '$OUT' && grep -qE -- '--session-id +[0-9a-f-]{36} +-n +inst' '$OUT'"
check "fresh, dry run: the file stays" [ -e "$STATE_DIR/fresh" ]
printf 'Note: {{session_note}}\n' >"$T/prompt.txt"
start_env GP_START_PROMPT="$T/prompt.txt" "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
NEWSID="$(arg_after --session-id)"
check "fresh: a new session id, not the saved one" sh -c "[ -n '$NEWSID' ] && [ '$NEWSID' != '$SID' ] && ! grep -qx -- --resume '$T/state/tmux.args'"
check "fresh: the new id is saved" [ "$(cat "$STATE_DIR/session-id")" = "$NEWSID" ]
check "fresh: the file is deleted once claude runs" [ ! -e "$STATE_DIR/fresh" ]
check "fresh: the start prompt says why" [ "$(arg_after inst)" = "Note: Started a new session (a fresh start was asked for)." ]
fresh_world; touch "$T/state/tmux.fail"
run_start
check "fresh, tmux fails: the file stays for the next start" sh -c "[ $RC = 1 ] && [ -e '$STATE_DIR/fresh' ]"
#    A file that cannot be deleted would start a new session at every end: the
#    start goes on without the request (it resumes), says so, and the watchdog
#    leaves the next restart to systemd instead of starting again in place.
#    These starts are cut off after 60 seconds where timeout exists, so a
#    relaunch loop fails a check instead of hanging the suite.
run_start_bounded() {
    if t_tool timeout; then start_env timeout 60 "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
    else run_start; fi
}
fresh_world; chmod 555 "$STATE_DIR"
if [ -w "$STATE_DIR" ]; then echo "SKIP  an undeletable fresh file (this user writes a mode-555 folder)"; else
    run_start_bounded
    check "fresh, the file cannot be deleted: started without the request, resumed, said" \
        sh -c "grep -q 'cannot be deleted (it would start a new session at every end); starting without it' '$OUT' && grep -qx -- --resume '$T/state/tmux.args' && [ '$(arg_after --resume)' = '$SID' ]"
    check "fresh, the file cannot be deleted: one start, no relaunch in place, exit 1 for systemd" \
        sh -c "[ $RC = 1 ] && [ \"\$(grep -c '^tmux on inst new-session\$' '$T/state/calls')\" = 1 ] && ! grep -q 'ended with a fresh start asked for' '$OUT'"
fi
chmod 755 "$STATE_DIR"
#    A folder named fresh (the agent can make one) is no request: resumed, said,
#    and never started again in place.
fresh_world; rm -f "$STATE_DIR/fresh"; mkdir "$STATE_DIR/fresh"
run_start_bounded
check "fresh is a folder: not a request, said" out_has "^start: $STATE_DIR/fresh is not a regular file \\(a folder, a link or another kind\\); it is not read as a fresh start\$"
check "fresh is a folder: resumed, one start, exit 1 for systemd" \
    sh -c "[ $RC = 1 ] && [ '$(arg_after --resume)' = '$SID' ] && [ \"\$(grep -c '^tmux on inst new-session\$' '$T/state/calls')\" = 1 ]"
run_start --dry-run
check "fresh is a folder, dry run: resumes" out_has "--resume +$SID"
fresh_world; rm -f "$STATE_DIR/fresh"; ln -s "$T/nowhere" "$STATE_DIR/fresh"
run_start --dry-run
check "fresh is a dangling symlink: not a request" sh -c "grep -q 'is not a regular file' '$OUT' && grep -qE -- '--resume +$SID' '$OUT'"
#    A link to a regular file is no request either: never followed, never
#    deleted through, and the watchdog never starts again in place on it.
fresh_world; rm -f "$STATE_DIR/fresh"; echo important >"$T/link-target"; ln -s "$T/link-target" "$STATE_DIR/fresh"
run_start --dry-run
check "fresh is a link to a regular file, dry run: not a request, resumes" \
    sh -c "grep -q 'is not a regular file (a folder, a link or another kind)' '$OUT' && grep -qE -- '--resume +$SID' '$OUT' && ! grep -q 'a fresh start was asked for' '$OUT'"
run_start_bounded
check "fresh is a link to a regular file: resumed, one start, the link and its target left alone" \
    sh -c "[ '$(arg_after --resume)' = '$SID' ] && [ \"\$(grep -c '^tmux on inst new-session\$' '$T/state/calls')\" = 1 ] && [ -L '$STATE_DIR/fresh' ] && [ \"\$(cat '$T/link-target')\" = important ]"
chmod 755 "$STATE_DIR"
fresh_world
run_start
echo '{}' >"$PROJ/$(cat "$STATE_DIR/session-id").jsonl"
run_start --dry-run
check "after the fresh start, the next one resumes the new session" out_has "--resume +$(cat "$STATE_DIR/session-id")"

# 19. A session that ends with a fresh start asked for (start --fresh): the
#     watchdog starts the new session at once, not systemd.
setup
mkdir -p "$STATE_DIR" "$PROJ"
echo "$SID" >"$STATE_DIR/session-id"; echo '{}' >"$PROJ/$SID.jsonl"
echo "$STATE_DIR/fresh" >"$T/state/tmux.end-with-fresh"
run_start
check "ended with fresh: started again in place, one more new-session" [ "$(grep -c '^tmux on inst new-session$' "$T/state/calls")" = 2 ]
check "ended with fresh: the log says why" out_has '^start: the session ended with a fresh start asked for$'
check "ended with fresh: the second session is new" sh -c "[ '$(arg_after --session-id)' != '$SID' ] && [ -n '$(arg_after --session-id)' ]"
check "ended with fresh: its id is saved, the file deleted" sh -c "[ \"\$(cat '$STATE_DIR/session-id')\" = '$(arg_after --session-id)' ] && [ ! -e '$STATE_DIR/fresh' ]"
check "ended with fresh: then the watchdog exits 1 as before" rc_is 1
check "the watchdog writes its pid for --fresh" sh -c "grep -qE '^[0-9]+\$' '$STATE_DIR/watchdog.pid'"

# 19b. Claude's own window ends (/exit, a crash) while another window keeps the
#      session alive: the watchdog starts claude again in a new window of that
#      session, resumed and with the channel, and leaves the tmux server and
#      its other windows alone. When the whole session ends after that, it
#      exits 1 for systemd, as before. The watchdog looks every second here
#      (GP_WATCH_SECONDS), and these starts are cut off after 60 seconds where
#      timeout exists, so a relaunch loop fails a check instead of hanging.
watch_world() {
    setup
    mkdir -p "$STATE_DIR" "$PROJ"
    echo "$SID" >"$STATE_DIR/session-id"; echo '{}' >"$PROJ/$SID.jsonl"
    touch "$T/state/tmux.alive"
    echo 99999901 >"$T/state/tmux.pane-pid"
}
run_watch() {
    if t_tool timeout; then start_env GP_WATCH_SECONDS=1 timeout 60 "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
    else start_env GP_WATCH_SECONDS=1 "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?; fi
}
# on_list <n> <sh>: what happens just before the n-th list-panes answers.
on_list() { printf '%s\n' "$2" >"$T/state/tmux.on-list.$1"; }
# The sh that closes pane <id> (it leaves the stand-in's list of panes).
close_pane() { printf "awk '\$1 != \"%s\"' '%s' >'%s.new' && mv '%s.new' '%s'" "$1" "$T/state/tmux.panes" "$T/state/tmux.panes" "$T/state/tmux.panes" "$T/state/tmux.panes"; }
count_calls() { grep -c "^$1\$" "$T/state/calls"; }

watch_world
#    The operator's window (%9) opens beside claude's; claude's pane closes,
#    and the next claude gets another pid.
on_list 1 "echo '%9 0 4242' >>'$T/state/tmux.panes'; cp '$T/state/tmux.args' '$T/state/tmux.args.1'; echo 99999902 >'$T/state/tmux.pane-pid'; $(close_pane %0)"
on_list 2 "rm -f '$T/state/tmux.alive'"
run_watch
check "pane ends: claude starts again in a new window of the session" \
    sh -c "[ \"\$(grep -c '^tmux on inst new-session\$' '$T/state/calls')\" = 1 ] && [ \"\$(grep -c '^tmux on inst new-window\$' '$T/state/calls')\" = 1 ] && grep -qx 'tmux target new-window =inst:' '$T/state/calls'"
check "pane ends: the tmux server is stopped only before the first start" [ "$(count_calls 'tmux on inst kill-server')" = 1 ]
check "pane ends: the session is never ended" not_called "tmux kill-session"
check "pane ends: the other window is still there" grep -q '^%9 0 4242$' "$T/state/tmux.panes"
check "pane ends: watched by claude's pane, in the session by its exact name" grep -qx 'tmux target list-panes =inst' "$T/state/calls"
check "pane ends: the new claude resumes the session" [ "$(arg_after --resume)" = "$SID" ]
check "pane ends: the new claude has the channel" [ "$(arg_after --channels)" = "plugin:$PLUGIN" ]
check "pane ends: the new claude's arguments are the first one's" cmp -s "$T/state/tmux.args.1" "$T/state/tmux.args"
check "pane ends: GP_INSTANCE_NAME reaches the new claude alone" \
    sh -c "[ \"\$(cat '$T/state/tmux.pane-env')\" = 'GP_INSTANCE_NAME=inst' ] && ! grep -qx 'env GP_INSTANCE_NAME set' '$T/state/calls'"
check "pane ends: pane-pid is the new claude's, pane-id its pane" \
    sh -c "[ \"\$(cat '$STATE_DIR/pane-pid')\" = 99999902 ] && [ \"\$(cat '$STATE_DIR/pane-id')\" = '%1' ]"
check "pane ends: said" sh -c "grep -qE '^start: claude ended after [0-9]+s; tmux session inst goes on, so claude starts again in it\$' '$OUT' && grep -q '^start: starting claude in a new window of tmux -L inst session inst (resumed session $SID); its other windows stay\$' '$OUT'"
check "pane ends, then the session: exit 1 for systemd, as before" sh -c "[ $RC = 1 ] && grep -q '^start: claude ended after [0-9]*s; tmux session inst is gone\$' '$OUT'"
check "pane ends, then the session: each quick end counted" [ "$(cat "$STATE_DIR/quick-exits")" = 2 ]

#    tmux's remain-on-exit keeps claude's pane, dead: it is closed, and claude
#    starts again in a new window.
watch_world
on_list 1 "sed 's/^%0 0 /%0 1 /' '$T/state/tmux.panes' >'$T/state/p.new' && mv '$T/state/p.new' '$T/state/tmux.panes'"
on_list 2 "rm -f '$T/state/tmux.alive'"
run_watch
check "pane dead (remain-on-exit): closed, then claude in a new window" \
    sh -c "grep -qx 'tmux target kill-pane %0' '$T/state/calls' && [ \"\$(grep -c '^tmux on inst new-window\$' '$T/state/calls')\" = 1 ] && [ $RC = 1 ]"

#    Three quick ends in a row: the second restart starts a new session (the
#    quick-exit rule), and the third end goes to systemd.
watch_world
on_list 1 "$(close_pane %0)"
on_list 2 "cp '$T/state/tmux.args' '$T/state/tmux.args.2'; $(close_pane %1)"
on_list 3 "$(close_pane %2)"
run_watch
check "quick ends: the first restart resumes" grep -qx -- "$SID" "$T/state/tmux.args.2"
check "quick ends: the second restart starts a new session" \
    sh -c "! grep -qx -- --resume '$T/state/tmux.args' && [ -n '$(arg_after --session-id)' ] && [ '$(arg_after --session-id)' != '$SID' ]"
check "quick ends: the third goes to systemd (exit 1), said" \
    sh -c "[ $RC = 1 ] && [ \"\$(grep -c '^tmux on inst new-window\$' '$T/state/calls')\" = 2 ] && grep -qE '^start: claude ended after [0-9]+s, quickly for the third time in a row; leaving the restarts to systemd\$' '$OUT'"
check "quick ends: three counted" [ "$(cat "$STATE_DIR/quick-exits")" = 3 ]

#    Claude's window ends with a fresh start asked for: a new session in a new
#    window, at once, the file deleted, no quick end counted for it.
watch_world
on_list 1 ": >'$STATE_DIR/fresh'; $(close_pane %0)"
on_list 2 "rm -f '$T/state/tmux.alive'"
run_watch
check "pane ends with fresh: a new session in a new window" \
    sh -c "[ \"\$(grep -c '^tmux on inst new-window\$' '$T/state/calls')\" = 1 ] && ! grep -qx -- --resume '$T/state/tmux.args' && [ '$(arg_after --session-id)' != '$SID' ]"
check "pane ends with fresh: its id saved, the file deleted, said" \
    sh -c "[ \"\$(cat '$STATE_DIR/session-id')\" = '$(arg_after --session-id)' ] && [ ! -e '$STATE_DIR/fresh' ] && grep -q \"^start: claude's window ended with a fresh start asked for\$\" '$OUT'"
check "pane ends with fresh: only the session's end counted" [ "$(cat "$STATE_DIR/quick-exits")" = 1 ]

#    The whole session ends while claude's pane was alive: as before, no new
#    window, exit 1 for systemd.
watch_world
on_list 1 "rm -f '$T/state/tmux.alive'"
run_watch
check "session ends: no new window, exit 1, said" \
    sh -c "[ $RC = 1 ] && ! grep -q 'new-window' '$T/state/calls' && [ \"\$(grep -c '^tmux on inst new-session\$' '$T/state/calls')\" = 1 ] && grep -q 'tmux session inst is gone' '$OUT'"

#    The new window's claude gets none of the names tmux's update-environment
#    rewrites at each attach (the global list and the session's), so not an
#    attached operator's SSH_AUTH_SOCK; the first start needs none. The status
#    line's GP_CLAUDE_SETTINGS is set again in the server for the new window.
watch_world
printf 'SSH_AUTH_SOCK\nDISPLAY\nnot-a-name\n' >"$T/state/tmux.update-env-global"
printf 'EXTRA_ONE\nDISPLAY\n' >"$T/state/tmux.update-env-session"
on_list 1 "$(close_pane %0)"
on_list 2 "rm -f '$T/state/tmux.alive'"
run_watch
check "pane ends: the new claude runs without update-environment's names" \
    sh -c "grep -qx 'tmux pane-unset SSH_AUTH_SOCK' '$T/state/calls' && grep -qx 'tmux pane-unset DISPLAY' '$T/state/calls' && grep -qx 'tmux pane-unset EXTRA_ONE' '$T/state/calls'"
check "pane ends: each name once, a bad one never" \
    sh -c "[ \"\$(grep -c '^tmux pane-unset ' '$T/state/calls')\" = 3 ] && ! grep -q 'not-a-name' '$T/state/calls'"
check "pane ends: GP_INSTANCE_NAME still reaches the new claude alone" [ "$(cat "$T/state/tmux.pane-env")" = 'GP_INSTANCE_NAME=inst' ]
check "pane ends, no settings file: GP_CLAUDE_SETTINGS unset in the server" grep -qx 'tmux set-environment -gu GP_CLAUDE_SETTINGS' "$T/state/calls"
watch_world
echo '{}' >"$H/.config/ghost-protocol/inst.json"
on_list 1 "$(close_pane %0)"
on_list 2 "rm -f '$T/state/tmux.alive'"
run_watch
check "pane ends, with the settings file: GP_CLAUDE_SETTINGS set in the server" \
    grep -qx "tmux set-environment -g GP_CLAUDE_SETTINGS $H/.config/ghost-protocol/inst.json" "$T/state/calls"

# 19d. Remote Control (see Remote Control at the top of start). Up is a
#      bridgeSessionId in claude's session file (~/.claude/sessions/<pid>.json);
#      down is no bridge session after GP_RC_WAIT seconds while claude runs
#      with --remote-control (or GP_REMOTE_CONTROL=on). The pane is never
#      read for it: failure text on screen decides nothing. Down is retried
#      by restarting claude, resumed, once idle, never by a key; GP_RC_TRIES
#      starts in all, then failed. The state goes to <state>/remote-control,
#      and a dry run prints it while the session runs. world.sh runs before
#      every list-panes answer: it plays claude's side.
rc_world() {
    watch_world
    mkdir -p "$H/.claude/sessions"
    local n
    for ((n = 1; n <= 80; n++)); do echo "sh '$T/world.sh'" >"$T/state/tmux.on-list.$n"; done
}
rc_world_script() { printf '%s\n' "$1" >"$T/world.sh"; }
run_rc() {
    if t_tool timeout; then start_env GP_WATCH_SECONDS=1 GP_FRESH_QUIET=0 "$@" timeout 60 "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
    else start_env GP_WATCH_SECONDS=1 GP_FRESH_QUIET=0 "$@" "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?; fi
}
bridge() { printf '{"pid":%s,"sessionId":"%s","bridgeSessionId":"session_x"}\n' "$1" "$SID" >"$H/.claude/sessions/$1.json"; }
# Claude Code's failure line, as text on claude's screen: it must decide nothing.
RC_SCREEN='Remote Control /rc failed - Session creation failed - run /remote-control to reconnect'

#    Up at once: noted, no restart; the session's end goes to systemd as before.
#    The failure text on screen too: up still wins, nothing restarted.
rc_world
bridge 99999901
echo "$RC_SCREEN" >"$T/state/tmux.screen"
rc_world_script "grep -q '^up ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'"
run_rc GP_RC_WAIT=30 GP_REMOTE_CONTROL=on
check "rc up: state up, said, no restart, though the screen shows failure text" \
    sh -c "grep -q '^up 1/3 [0-9T:Z-]* bridge session seen\$' '$STATE_DIR/remote-control' && grep -q '^start: Remote Control is up (try 1 of 3)\$' '$OUT' && ! grep -q new-window '$T/state/calls' && ! grep -q 'kill-pane' '$T/state/calls' && [ $RC = 1 ]"
check "rc: the pane is never read for it" not_called "tmux capture-pane"

#    Failure text on screen, no flag and no bridge session: off, nothing
#    restarted (echoed text never starts a retry).
rc_world
echo "$RC_SCREEN" >"$T/state/tmux.screen"
rc_world_script "grep -q '^off ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'; exit 0"
run_rc GP_RC_WAIT=1 GP_RC_BACKOFF=0
check "rc: failure text on screen without the flag: off, no restart" \
    sh -c "grep -q '^off 1/3 [0-9T:Z-]* claude runs without --remote-control\$' '$STATE_DIR/remote-control' && ! grep -q new-window '$T/state/calls' && ! grep -q kill-pane '$T/state/calls'"

#    Asked for (GP_REMOTE_CONTROL=on), no bridge session after the wait:
#    retried once idle, resumed in a new window, not a quick exit; the new
#    claude comes up.
rc_world
rc_world_script "
if grep -q '^%1 ' '$T/state/tmux.panes'; then
  printf '{\"bridgeSessionId\":\"session_y\"}\n' >'$H/.claude/sessions/99999902.json'
else echo 99999902 >'$T/state/tmux.pane-pid'; fi
grep -q '^up ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'
exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_BACKOFF=0
check "rc down: said, try 1 of 3" grep -q "^start: Remote Control is down (no Remote Control session after 1s), try 1 of 3; claude restarts, resumed, in 0s, once the instance is idle\$" "$OUT"
check "rc down: claude's pane ended (no key typed), claude again in a new window" \
    sh -c "grep -qx 'tmux target kill-pane %0' '$T/state/calls' && [ \"\$(grep -c '^tmux on inst new-window\$' '$T/state/calls')\" = 1 ] && ! grep -q 'send-keys' '$T/state/calls'"
check "rc down: the new claude resumes the session" [ "$(arg_after --resume)" = "$SID" ]
check "rc down: the restart said, not counted as a quick exit" \
    sh -c "grep -q '^start: restarting claude for Remote Control, try 2 of 3\$' '$OUT' && ! grep -q 'tmux session inst goes on' '$OUT' && [ \"\$(cat '$STATE_DIR/quick-exits')\" = 1 ]"
check "rc down: then up, on the second try" \
    sh -c "grep -q '^up 2/3 ' '$STATE_DIR/remote-control' && grep -q '^start: Remote Control is up (try 2 of 3)\$' '$OUT'"

#    Claude's pane was the session's only window, so ending it ends the
#    session: the retry starts a new tmux session at once, resumed, not a
#    quick exit (systemd is not asked).
rc_world
rc_world_script "
if [ ! -s '$T/state/tmux.panes' ] && [ ! -e '$T/ended' ]; then rm -f '$T/state/tmux.alive'; : >'$T/ended'; fi
exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_BACKOFF=0
check "rc retry, claude's the only window: a new session at once, resumed, said" \
    sh -c "[ \"\$(grep -c '^tmux on inst new-session\$' '$T/state/calls')\" = 2 ] && ! grep -q new-window '$T/state/calls' && [ '$(arg_after --resume)' = '$SID' ] && grep -q '^start: restarting claude for Remote Control, try 2 of 3\$' '$OUT'"
check "rc retry, claude's the only window: only the last end counted" [ "$(cat "$STATE_DIR/quick-exits")" = 1 ]

#    Never up: the tries run out, failed, and claude keeps running.
rc_world
rc_world_script "
grep -q '^%1 ' '$T/state/tmux.panes' || echo 99999902 >'$T/state/tmux.pane-pid'
grep -q '^failed ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'
exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_BACKOFF=0 GP_RC_TRIES=2
check "rc never up: one retry, then failed, said" \
    sh -c "[ \"\$(grep -c '^tmux on inst new-window\$' '$T/state/calls')\" = 1 ] && grep -q '^failed 2/2 [0-9T:Z-]* no Remote Control session after 1s; gave up after 2 tries\$' '$STATE_DIR/remote-control' && grep -q '^start: FAIL: Remote Control is down (no Remote Control session after 1s) after 2 tries; claude keeps running without it' '$OUT'"
check "rc never up: claude was not ended after the last try" [ "$(grep -c '^tmux target kill-pane' "$T/state/calls")" = 1 ]

#    The flag on claude's own command line (a wrapper that execs claude puts
#    it there), no bridge session after GP_RC_WAIT: down. One try in all:
#    failed at once.
rc_world
mkdir -p "$T/proc/99999901"
printf '/usr/local/bin/claude\0--remote-control\0inst\0--resume\0x\0' >"$T/proc/99999901/cmdline"
rc_world_script "grep -q '^failed ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'; exit 0"
run_rc GP_RC_WAIT=1 GP_RC_TRIES=1 GP_PROC_DIR="$T/proc"
check "rc flag on claude's command line, no bridge session: failed after the wait, no restart" \
    sh -c "grep -q '^failed 1/1 [0-9T:Z-]* no Remote Control session after 1s; gave up after 1 tries\$' '$STATE_DIR/remote-control' && ! grep -q new-window '$T/state/calls'"

#    GP_REMOTE_CONTROL=off: not watched, even with the flag on the command line.
rc_world
mkdir -p "$T/proc/99999901"
printf '/usr/local/bin/claude\0--rc\0' >"$T/proc/99999901/cmdline"
rc_world_script "[ -f '$T/ticks' ] && rm -f '$T/state/tmux.alive'; : >'$T/ticks'"
run_rc GP_REMOTE_CONTROL=off GP_RC_WAIT=0 GP_RC_BACKOFF=0 GP_PROC_DIR="$T/proc"
check "rc off by setting: off, no restart" sh -c "grep -q '^off ' '$STATE_DIR/remote-control' && ! grep -q kill-pane '$T/state/calls'"

#    Busy (the turn marker): the retry waits, said once, and nothing is ended.
rc_world
echo busy >"$STATE_DIR/turn.keep"
rc_world_script "
cp '$STATE_DIR/turn.keep' '$STATE_DIR/turn'
n=\$(( \$(cat '$T/ticks' 2>/dev/null || echo 0) + 1 )); echo \$n >'$T/ticks'
[ \$n -ge 6 ] && rm -f '$T/state/tmux.alive'
exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_BACKOFF=0
check "rc retry while busy: waits, said once, nothing ended" \
    sh -c "[ \"\$(grep -c '^start: the Remote Control retry waits: the instance is busy (the turn marker says busy)\$' '$OUT')\" = 1 ] && ! grep -q kill-pane '$T/state/calls' && grep -q '^retrying 1/3 ' '$STATE_DIR/remote-control'"

#    The flag is a whole argument: --rc alone counts (auto mode); a line
#    "--rc" inside the persona's argument does not.
rc_world
mkdir -p "$T/proc/99999901"
printf '/usr/local/bin/claude\0--rc\0--resume\0x\0' >"$T/proc/99999901/cmdline"
rc_world_script "grep -q '^failed ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'; exit 0"
run_rc GP_RC_WAIT=1 GP_RC_TRIES=1 GP_PROC_DIR="$T/proc"
check "rc auto, --rc on claude's command line: wanted (failed after the wait)" \
    grep -q '^failed 1/1 [0-9T:Z-]* no Remote Control session after 1s' "$STATE_DIR/remote-control"
rc_world
mkdir -p "$T/proc/99999901"
printf '/usr/local/bin/claude\0--append-system-prompt\0You are an agent.\n--rc\n--remote-control\nMore.\0--resume\0x\0' >"$T/proc/99999901/cmdline"
rc_world_script "grep -q '^off ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'; exit 0"
run_rc GP_RC_WAIT=1 GP_RC_TRIES=1 GP_PROC_DIR="$T/proc"
check "rc auto, '--rc' only as a line inside the persona: off, not wanted" \
    sh -c "grep -q '^off ' '$STATE_DIR/remote-control' && ! grep -q kill-pane '$T/state/calls'"

#    Up, then the bridge session goes away: reported (checking, then down
#    after the wait, one log line), never retried; the try count is not
#    reset by up.
rc_world
bridge 99999901
rc_world_script "
if grep -q '^up ' '$STATE_DIR/remote-control' 2>/dev/null; then rm -f '$H/.claude/sessions/99999901.json'; fi
grep -q '^down ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'
exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_BACKOFF=0
check "rc up then dropped: down, said once, never restarted" \
    sh -c "grep -q '^down 1/3 [0-9T:Z-]* the bridge session went away and is not back after 1s' '$STATE_DIR/remote-control' && [ \"\$(grep -c '^start: Remote Control dropped and is not back after 1s' '$OUT')\" = 1 ] && ! grep -q kill-pane '$T/state/calls' && ! grep -q new-window '$T/state/calls'"
#    Down on the first start, up on the second, then dropped: still never
#    restarted, and the count stays at 2 (not reset to 1 by up).
rc_world
rc_world_script "
if grep -q '^%1 ' '$T/state/tmux.panes' && [ ! -e '$T/dropped' ]; then
  if grep -q '^up ' '$STATE_DIR/remote-control' 2>/dev/null; then rm -f '$H/.claude/sessions/99999902.json'; : >'$T/dropped'
  else printf '{\"bridgeSessionId\":\"session_y\"}\n' >'$H/.claude/sessions/99999902.json'; fi
elif ! grep -q '^%1 ' '$T/state/tmux.panes'; then echo 99999902 >'$T/state/tmux.pane-pid'; fi
grep -q '^down ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'
exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_BACKOFF=0
check "rc down, up on try 2, then dropped: down 2/3, one restart only" \
    sh -c "grep -q '^down 2/3 ' '$STATE_DIR/remote-control' && [ \"\$(grep -c '^tmux target kill-pane' '$T/state/calls')\" = 1 ]"

#    Settings with leading zeros are read in base 10, and the tries are at
#    most 16.
rc_world
bridge 99999901
rc_world_script "grep -q '^up ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'; exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=08 GP_RC_BACKOFF=09 GP_RC_TRIES=099
check "rc settings 08, 09, 099: no error, the watchdog runs on, tries capped at 16" \
    sh -c "grep -q '^up 1/16 ' '$STATE_DIR/remote-control' && ! grep -q 'value too great for base' '$OUT'"

#    The backoff doubles: 1s before try 2, 2s before try 3.
rc_world
rc_world_script "
grep -q '^%1 ' '$T/state/tmux.panes' || echo 99999902 >'$T/state/tmux.pane-pid'
grep -q '^failed ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'
exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_BACKOFF=1 GP_RC_TRIES=3
check "rc backoff doubles: 1s, then 2s, then failed after 3 tries" \
    sh -c "grep -q 'try 1 of 3; claude restarts, resumed, in 1s' '$OUT' && grep -q 'try 2 of 3; claude restarts, resumed, in 2s' '$OUT' && grep -q '^failed 3/3 ' '$STATE_DIR/remote-control'"

#    An empty bridgeSessionId is not up.
rc_world
printf '{"pid":99999901,"bridgeSessionId":""}\n' >"$H/.claude/sessions/99999901.json"
rc_world_script "grep -q '^failed ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'; exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_TRIES=1
check "rc empty bridgeSessionId: not up (failed)" sh -c "grep -q '^failed 1/1 ' '$STATE_DIR/remote-control' && ! grep -q 'Remote Control is up' '$OUT'"

#    With claude's start time known, the session file's procStart must match:
#    a file left by another process with the same pid is not up; the
#    matching one is.
rc_stat() { mkdir -p "$T/proc/$1"; echo "$1 (claude) S 1 $1 $1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 $2" >"$T/proc/$1/stat"; }
rc_world
rc_stat 99999901 111
printf '{"pid":99999901,"procStart":"222","bridgeSessionId":"session_old"}\n' >"$H/.claude/sessions/99999901.json"
rc_world_script "grep -q '^failed ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'; exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_TRIES=1 GP_PROC_DIR="$T/proc"
check "rc procStart of another process: not up" sh -c "grep -q '^failed 1/1 ' '$STATE_DIR/remote-control' && ! grep -q 'Remote Control is up' '$OUT'"
rc_world
rc_stat 99999901 111
printf '{"pid":99999901,"procStart":"111","bridgeSessionId":"session_x"}\n' >"$H/.claude/sessions/99999901.json"
rc_world_script "grep -q '^up ' '$STATE_DIR/remote-control' 2>/dev/null && rm -f '$T/state/tmux.alive'; exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=30 GP_PROC_DIR="$T/proc"
check "rc procStart matching claude's start time: up" grep -q '^up 1/3 ' "$STATE_DIR/remote-control"

#    Claude's pane still there after the restart (it did not take): back to
#    waiting, the try not counted; the next restart takes.
rc_world
rc_world_script "
if grep -q '^tmux target kill-pane %0' '$T/state/calls' && [ ! -e '$T/readded' ]; then echo '%0 0 99999901' >>'$T/state/tmux.panes'; : >'$T/readded'; fi
grep -q '^%1 ' '$T/state/tmux.panes' && rm -f '$T/state/tmux.alive'
exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_BACKOFF=0
check "rc restart that did not take: said, back to waiting, then restarted as try 2" \
    sh -c "grep -q \"^start: claude's pane was still there after the Remote Control restart; trying again in 0s\$\" '$OUT' && [ \"\$(grep -c '^start: restarting claude for Remote Control, try 2 of 3\$' '$OUT')\" = 2 ] && [ \"\$(grep -c '^tmux on inst new-window\$' '$T/state/calls')\" = 1 ]"

#    Claude's pane unknown (tmux gave no id): never restarted, failed at once.
#    (With no pane id the watchdog reads no panes, so world.sh never runs:
#    the run is cut off after 6 seconds; needs timeout.)
rc_world
: >"$T/state/tmux.no-pane-id"
if t_tool timeout; then
start_env GP_WATCH_SECONDS=1 GP_FRESH_QUIET=0 GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_BACKOFF=0 timeout 6 "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "rc with claude's pane unknown: failed at once, no restart, the session never ended by it" \
    sh -c "grep -q \"^failed 1/3 [0-9T:Z-]* no Remote Control session after 1s; claude's pane is unknown, so it is not restarted\$\" '$STATE_DIR/remote-control' && ! grep -q kill-pane '$T/state/calls' && ! grep -q kill-session '$T/state/calls'"
else echo "SKIP  rc with claude's pane unknown (no timeout here)"; fi

#    A tmux client attached: the retry waits, said once, nothing ended.
rc_world
echo '/dev/pts/3' >"$T/state/tmux.clients"
rc_world_script "
n=\$(( \$(cat '$T/ticks' 2>/dev/null || echo 0) + 1 )); echo \$n >'$T/ticks'
[ \$n -ge 6 ] && rm -f '$T/state/tmux.alive'
exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_BACKOFF=0
check "rc retry with a client attached: waits, said once, nothing ended" \
    sh -c "[ \"\$(grep -c '^start: the Remote Control retry waits: the instance is busy (a tmux client is attached to the session)\$' '$OUT')\" = 1 ] && ! grep -q kill-pane '$T/state/calls' && grep -qx 'tmux target list-clients =inst' '$T/state/calls'"

#    Not idle with no reason given (the activity check answers "busy" and
#    prints nothing): the retry still waits. A python3 stand-in answers the
#    activity check that way and runs the real one for everything else.
rc_world
REAL_PY="$(readlink -f "$T/sysbin/python3")"
# shellcheck disable=SC2016  # expanded by the stand-in, not here
printf '#!/bin/sh\n[ "${5:-}" = activity ] && exit 0\nexec %s "$@"\n' "$REAL_PY" >"$T/stubs/python3"
chmod +x "$T/stubs/python3"
rc_world_script "
n=\$(( \$(cat '$T/ticks' 2>/dev/null || echo 0) + 1 )); echo \$n >'$T/ticks'
[ \$n -ge 6 ] && rm -f '$T/state/tmux.alive'
exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_BACKOFF=0
check "rc retry, not idle with no reason given: waits, said once, nothing ended" \
    sh -c "[ \"\$(grep -c '^start: the Remote Control retry waits: the instance is busy (no reason given)\$' '$OUT')\" = 1 ] && ! grep -q kill-pane '$T/state/calls'"

#    Busy, then idle: the retry fires once the instance is idle.
rc_world
echo busy >"$STATE_DIR/turn.keep"
rc_world_script "
n=\$(( \$(cat '$T/ticks' 2>/dev/null || echo 0) + 1 )); echo \$n >'$T/ticks'
if [ \$n -le 5 ]; then cp '$STATE_DIR/turn.keep' '$STATE_DIR/turn'; else rm -f '$STATE_DIR/turn'; fi
grep -q '^%1 ' '$T/state/tmux.panes' && rm -f '$T/state/tmux.alive'
grep -q '^%1 ' '$T/state/tmux.panes' || echo 99999902 >'$T/state/tmux.pane-pid'
exit 0"
run_rc GP_REMOTE_CONTROL=on GP_RC_WAIT=1 GP_RC_BACKOFF=0
check "rc busy then idle: waited (said once), then restarted once idle" \
    sh -c "[ \"\$(grep -c '^start: the Remote Control retry waits: the instance is busy (the turn marker says busy)\$' '$OUT')\" = 1 ] && grep -q '^start: restarting claude for Remote Control, try 2 of 3\$' '$OUT' && [ \"\$(grep -c '^tmux on inst new-window\$' '$T/state/calls')\" = 1 ]"

#    down in the dry run is a FAIL too.
setup
mkdir -p "$STATE_DIR"
touch "$T/state/tmux.alive"
echo 'down 1/3 2026-11-13T10:20:00Z the bridge session went away and is not back after 60s' >"$STATE_DIR/remote-control"
run_start --dry-run
check "dry run, rc down: FAIL line, NOT READY" sh -c "[ $RC = 1 ] && grep -q '^  FAIL     Remote Control: down 1/3 ' '$OUT'"

#    The dry run, while the session runs: retrying and failed are a FAIL and
#    NOT READY (exit 1); up is ok and READY; not read when no session runs.
setup
mkdir -p "$STATE_DIR"
touch "$T/state/tmux.alive"
echo 'failed 3/3 2026-11-13T10:20:00Z no Remote Control session after 60s; gave up after 3 tries' >"$STATE_DIR/remote-control"
run_start --dry-run
check "dry run, rc failed: FAIL line, NOT READY, exit 1" \
    sh -c "[ $RC = 1 ] && grep -q '^  FAIL     Remote Control: failed 3/3 ' '$OUT' && grep -qx 'NOT READY' '$OUT' && ! grep -qx READY '$OUT'"
echo 'retrying 1/3 2026-11-13T10:20:00Z no Remote Control session after 60s; claude restarts in 120s, once idle' >"$STATE_DIR/remote-control"
run_start --dry-run
check "dry run, rc retrying: FAIL line, NOT READY" sh -c "[ $RC = 1 ] && grep -q '^  FAIL     Remote Control: retrying 1/3 ' '$OUT'"
echo 'up 1/3 2026-11-13T10:20:00Z bridge session seen' >"$STATE_DIR/remote-control"
run_start --dry-run
check "dry run, rc up: ok line, READY" sh -c "[ $RC = 0 ] && grep -q '^  ok       Remote Control: up 1/3 ' '$OUT' && grep -qx READY '$OUT'"
rm -f "$T/state/tmux.alive"
echo 'failed 3/3 2026-11-13T10:20:00Z old' >"$STATE_DIR/remote-control"
run_start --dry-run
check "dry run, no session running: the state is not read, READY" sh -c "[ $RC = 0 ] && ! grep -q 'Remote Control:' '$OUT'"

# 19c. What stops two claudes at once, with real processes (Linux, setsid):
#     what is left of the old claude (its session and process group) is
#     ended before the new one starts; a pid another process holds now is
#     never signalled; and when something may still run, start hands over to
#     systemd instead of starting a second claude. The waits are 1 second
#     here (GP_STOP_SECONDS).
gone() { [ ! -e "/proc/$1" ] || grep -q '^State:[[:space:]]*Z' "/proc/$1/status" 2>/dev/null; }
wait_pidfile() { local i=0; while [ ! -s "$1" ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done; [ -s "$1" ]; }
run_stop() {
    if t_tool timeout; then start_env GP_WATCH_SECONDS=1 GP_STOP_SECONDS=1 "${PROC_ENV[@]}" timeout 60 "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
    else start_env GP_WATCH_SECONDS=1 GP_STOP_SECONDS=1 "${PROC_ENV[@]}" "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?; fi
}
# A stat line for a fake process folder: pid, state, process group, session, start time.
fake_stat() { mkdir -p "$T/proc/$1"; echo "$1 (claude) $2 1 $3 $4 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 $5" >"$T/proc/$1/stat"; }
if [ ! -d /proc/self ] || ! command -v setsid >/dev/null 2>&1; then
    echo "SKIP  what stops two claudes (needs /proc and setsid)"
else
    PROC_ENV=()
    #    A claude that ignores TERM and outlives its pane: TERM, then KILL,
    #    then the new claude.
    watch_world
    # shellcheck disable=SC2016  # expanded by the inner sh
    setsid sh -c 'echo $$ >"$1"; trap "" TERM HUP; while :; do sleep 1; done' sh "$T/lead.pid" </dev/null >/dev/null 2>&1 &
    wait_pidfile "$T/lead.pid"; LEAD="$(cat "$T/lead.pid")"
    echo "$LEAD" >"$T/state/tmux.pane-pid"
    on_list 1 "echo 99999902 >'$T/state/tmux.pane-pid'; $(close_pane %0)"
    on_list 2 "rm -f '$T/state/tmux.alive'"
    run_stop
    check "ignores TERM: TERM, then KILL, said" \
        sh -c "grep -q '^start: claude ($LEAD) or what it started still runs after its pane closed ([0-9]* process(es)); sending TERM\$' '$OUT' && grep -q 'sending KILL\$' '$OUT'"
    check "ignores TERM: it is gone" gone "$LEAD"
    check "ignores TERM: then the new claude in a new window" [ "$(grep -c '^tmux on inst new-window$' "$T/state/calls")" = 1 ]
    kill -9 "$LEAD" 2>/dev/null; wait "$LEAD" 2>/dev/null

    #    A child the old claude left running in the background (the same session
    #    and process group) outlives it: it is ended too, then the new claude.
    watch_world
    rm -f "$T/stop"
    # shellcheck disable=SC2016  # expanded by the inner sh
    setsid sh -c 'echo $$ >"$1"; sh -c "trap \"\" HUP; exec sleep 300" & echo $! >"$2"; while [ ! -e "$3" ]; do sleep 0.1; done' \
        sh "$T/lead.pid" "$T/child.pid" "$T/stop" </dev/null >/dev/null 2>&1 &
    LEAD_JOB=$!
    wait_pidfile "$T/lead.pid"; wait_pidfile "$T/child.pid"
    LEAD="$(cat "$T/lead.pid")"; CHILD="$(cat "$T/child.pid")"
    echo "$LEAD" >"$T/state/tmux.pane-pid"
    on_list 1 "touch '$T/stop'; echo 99999902 >'$T/state/tmux.pane-pid'; $(close_pane %0)"
    on_list 2 "rm -f '$T/state/tmux.alive'"
    run_stop
    check "detached child: sent TERM" grep -q 'sending TERM$' "$OUT"
    check "detached child: gone" gone "$CHILD"
    check "detached child: then the new claude in a new window" [ "$(grep -c '^tmux on inst new-window$' "$T/state/calls")" = 1 ]
    kill -9 "$CHILD" 2>/dev/null; wait "$LEAD_JOB" 2>/dev/null

    #    The pid now belongs to another process (its start time is not the one
    #    noted at launch): nothing is signalled, and the new claude starts.
    #    A folder of stat files stands in for /proc here (GP_PROC_DIR).
    watch_world
    rm -rf "$T/proc"; mkdir -p "$T/proc"
    # shellcheck disable=SC2016  # expanded by the inner sh
    setsid sh -c 'echo $$ >"$1"; while :; do sleep 1; done' sh "$T/other.pid" </dev/null >/dev/null 2>&1 &
    wait_pidfile "$T/other.pid"; OTHER="$(cat "$T/other.pid")"
    fake_stat "$OTHER" S "$OTHER" "$OTHER" 111
    echo "$OTHER" >"$T/state/tmux.pane-pid"
    on_list 1 "echo '$OTHER (sh) S 1 $OTHER $OTHER 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 222' >'$T/proc/$OTHER/stat'; echo 99999902 >'$T/state/tmux.pane-pid'; $(close_pane %0)"
    on_list 2 "rm -f '$T/state/tmux.alive'"
    PROC_ENV=(GP_PROC_DIR="$T/proc")
    run_stop
    check "pid reused: nothing signalled, the process runs on" sh -c "! grep -q 'sending' '$OUT' && kill -0 $OTHER"
    check "pid reused: the new claude in a new window" [ "$(grep -c '^tmux on inst new-window$' "$T/state/calls")" = 1 ]
    kill -9 "$OTHER" 2>/dev/null; wait "$OTHER" 2>/dev/null

    #    Something of the old claude still listed after KILL (pids above
    #    pid_max, which no process holds): exit 1 for systemd, no new claude.
    watch_world
    rm -rf "$T/proc"; mkdir -p "$T/proc"
    BIG=$(( $(cat /proc/sys/kernel/pid_max 2>/dev/null || echo 4194304) + 5 ))
    fake_stat "$BIG" S "$BIG" "$BIG" 111
    fake_stat "$((BIG + 1))" S "$BIG" "$BIG" 112
    echo "$BIG" >"$T/state/tmux.pane-pid"
    on_list 1 "$(close_pane %0)"
    PROC_ENV=(GP_PROC_DIR="$T/proc")
    run_stop
    check "still running after KILL: handed to systemd (exit 1), no new claude, said" \
        sh -c "[ $RC = 1 ] && ! grep -q 'new-window' '$T/state/calls' && grep -q '^start: 2 process(es) of the ended claude still run after KILL\$' '$OUT' && grep -q '^start: leaving the restart to systemd' '$OUT'"

    #    No start time noted (no stat file for claude's pid) while the pid is
    #    in use: nothing is signalled, handed to systemd.
    watch_world
    rm -rf "$T/proc"; mkdir -p "$T/proc"
    # shellcheck disable=SC2016  # expanded by the inner sh
    setsid sh -c 'echo $$ >"$1"; while :; do sleep 1; done' sh "$T/other.pid" </dev/null >/dev/null 2>&1 &
    wait_pidfile "$T/other.pid"; OTHER="$(cat "$T/other.pid")"
    echo "$OTHER" >"$T/state/tmux.pane-pid"
    on_list 1 "$(close_pane %0)"
    PROC_ENV=(GP_PROC_DIR="$T/proc")
    run_stop
    check "no start time: nothing signalled, handed to systemd" \
        sh -c "[ $RC = 1 ] && kill -0 $OTHER && ! grep -q 'sending' '$OUT' && grep -q 'start time unknown; nothing is signalled' '$OUT' && ! grep -q 'new-window' '$T/state/calls'"
    kill -9 "$OTHER" 2>/dev/null; wait "$OTHER" 2>/dev/null
    #    The pid was given out again, to a process that made its own session
    #    and is now a zombie (a zombie keeps its start time): its group is not
    #    the old claude's, so nothing of it is signalled, and claude restarts.
    watch_world
    rm -rf "$T/proc"; mkdir -p "$T/proc"
    BIG=$(( $(cat /proc/sys/kernel/pid_max 2>/dev/null || echo 4194304) + 5 ))
    fake_stat "$BIG" S "$BIG" "$BIG" 111
    echo "$BIG" >"$T/state/tmux.pane-pid"
    on_list 1 "echo '$BIG (sh) Z 1 $BIG $BIG 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 222' >'$T/proc/$BIG/stat'; mkdir -p '$T/proc/$((BIG + 1))'; echo '$((BIG + 1)) (sh) S 1 $BIG $BIG 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 223' >'$T/proc/$((BIG + 1))/stat'; echo 99999902 >'$T/state/tmux.pane-pid'; $(close_pane %0)"
    on_list 2 "rm -f '$T/state/tmux.alive'"
    PROC_ENV=(GP_PROC_DIR="$T/proc")
    run_stop
    check "pid given out again, its holder a zombie: nothing signalled, claude restarts" \
        sh -c "! grep -q 'sending' '$OUT' && [ \"\$(grep -c '^tmux on inst new-window\$' '$T/state/calls')\" = 1 ]"

    #    No start time noted (no /proc) and the leader gone, but a process of
    #    its group runs on: seen through the group (kill -0 -- -pid), nothing
    #    signalled, handed to systemd.
    watch_world
    rm -rf "$T/proc"; mkdir -p "$T/proc"
    # shellcheck disable=SC2016  # expanded by the inner sh
    setsid sh -c 'echo $$ >"$1"; sleep 300 & echo $! >"$2"' sh "$T/lead.pid" "$T/child.pid" </dev/null >/dev/null 2>&1 &
    LEAD_JOB=$!
    wait "$LEAD_JOB" 2>/dev/null
    wait_pidfile "$T/child.pid"; LEAD="$(cat "$T/lead.pid")"; CHILD="$(cat "$T/child.pid")"
    echo "$LEAD" >"$T/state/tmux.pane-pid"
    on_list 1 "$(close_pane %0)"
    PROC_ENV=(GP_PROC_DIR="$T/proc")
    run_stop
    check "no start time, leader gone, its group alive: nothing signalled, handed to systemd" \
        sh -c "[ $RC = 1 ] && kill -0 $CHILD && ! grep -q 'sending' '$OUT' && ! grep -q 'new-window' '$T/state/calls' && grep -q 'start time unknown; nothing is signalled' '$OUT'"
    kill -9 "$CHILD" 2>/dev/null
    PROC_ENV=()
fi

#    tmux gave claude's pane but no pid: what is left of claude cannot be
#    checked, so start hands over to systemd instead of starting another.
watch_world
rm -f "$T/state/tmux.pane-pid"
on_list 1 "$(close_pane %0)"
run_watch
check "no pid from tmux, pane ends: handed to systemd, no new claude, said" \
    sh -c "[ $RC = 1 ] && ! grep -q 'new-window' '$T/state/calls' && grep -q \"^start: claude's pid was never read, so what is left of it cannot be checked\$\" '$OUT'"

#    update-environment never unsets a name start itself has: PATH and a
#    credential's name stay, SSH_AUTH_SOCK (start has none) goes.
watch_world
mkdir -p "$T/creds"; printf 'fake-one' >"$T/creds/api-token"
printf 'PATH\nAPI_TOKEN\nSSH_AUTH_SOCK\n' >"$T/state/tmux.update-env-global"
on_list 1 "$(close_pane %0)"
on_list 2 "rm -f '$T/state/tmux.alive'"
start_env CREDENTIALS_DIRECTORY="$T/creds" GP_WATCH_SECONDS=1 "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "update-environment names start has: PATH and the credential's name kept, SSH_AUTH_SOCK removed" \
    sh -c "grep -qx 'tmux pane-unset SSH_AUTH_SOCK' '$T/state/calls' && ! grep -qE '^tmux pane-unset (PATH|API_TOKEN)\$' '$T/state/calls' && [ \"\$(grep -c '^tmux on inst new-window\$' '$T/state/calls')\" = 1 ]"
check "update-environment names start has: no credential value printed" out_lacks 'fake-'

#    GP_PROC_DIR is a test hook: honoured only with GP_TEST=1, else ignored
#    and said.
setup
start_env GP_TEST= GP_PROC_DIR="$T/proc" "$START" --root \~/work --name inst --dry-run >"$OUT" 2>&1; RC=$?
check "GP_PROC_DIR without GP_TEST=1: ignored, said" out_has '^start: GP_PROC_DIR is honoured only in test mode \(GP_TEST=1\); processes are read from /proc$'
start_env GP_PROC_DIR="$T/proc" "$START" --root \~/work --name inst --dry-run >"$OUT" 2>&1; RC=$?
check "GP_PROC_DIR with GP_TEST=1: used, nothing said" out_lacks 'GP_PROC_DIR is honoured only'

# 20. The instance's own claude gets GP_INSTANCE_NAME, through env on the
#     pane's command line, never through the tmux server's environment (where
#     every window of the server would get it); start writes the pane's pid
#     (claude's) to pane-pid. The session-id and turn-state hooks act only
#     there. A start clears the turn marker.
setup; mkdir -p "$STATE_DIR"; echo "busy p1" >"$STATE_DIR/turn"; echo 999999 >"$STATE_DIR/pane-pid"
echo 99999901 >"$T/state/tmux.pane-pid"
run_start
check "start: GP_INSTANCE_NAME reaches claude alone, on the pane's command line" \
    sh -c "grep -qx 'tmux pane-env GP_INSTANCE_NAME set' '$T/state/calls' && [ \"\$(cat '$T/state/tmux.pane-env')\" = 'GP_INSTANCE_NAME=inst' ]"
check "start: GP_INSTANCE_NAME is not in the tmux server's environment" sh -c "! grep -qx 'env GP_INSTANCE_NAME set' '$T/state/calls'"
check "start: claude itself is still the program, its arguments unchanged" sh -c "[ \"\$(head -n 1 '$T/state/tmux.args')\" = '--session-id' ]"
check "start: the pane's pid is written to pane-pid" [ "$(cat "$STATE_DIR/pane-pid")" = 99999901 ]
check "start: read from tmux's answer to new-session, not from the active pane" \
    sh -c "grep -qx 'tmux target display-message =inst:' '$T/state/calls' && exit 1; [ \"\$(cat '$STATE_DIR/pane-id')\" = '%0' ]"
check "start: an attended instance gets no GP_UNATTENDED" sh -c "! grep -q 'GP_UNATTENDED' '$T/state/calls'"
check "start: an attended instance gets no --permission-mode" lacks_arg --permission-mode
check "start: the turn marker is cleared" [ ! -e "$STATE_DIR/turn" ]
#    No pid from tmux: no pane-pid (the old one is gone), said.
setup; mkdir -p "$STATE_DIR"; echo 999999 >"$STATE_DIR/pane-pid"
run_start
check "start, no pane pid from tmux: no pane-pid left, said" \
    sh -c "[ ! -e '$STATE_DIR/pane-pid' ] && grep -q 'could not read the pid of claude in tmux session inst; the session-id and turn-state hooks stay off until the next start' '$OUT'"
#    Names start itself inherited (run by hand from inside a session) do not
#    reach the server either.
setup; echo 99999901 >"$T/state/tmux.pane-pid"
start_env GP_INSTANCE_NAME=other GP_UNATTENDED=1 GP_FRESH_DETACHED=1 "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "start, run with the names already set: none in the server's environment" \
    sh -c "! grep -qxE 'env (GP_INSTANCE_NAME|GP_UNATTENDED) set' '$T/state/calls' && [ \"\$(cat '$T/state/tmux.pane-env')\" = 'GP_INSTANCE_NAME=inst' ]"

# ---------------------------------------------------------------- unattended mode

json_at() {   # file key...: the value there, as JSON
    t_env python3 -I -c 'import json,sys
v = json.load(open(sys.argv[1]))
for k in sys.argv[2:]:
    v = v[k]
print(json.dumps(v, sort_keys=True))' "$@"
}
managed_unattended() {   # value: the managed settings set the option unattended to it
    t_env python3 -I -c 'import json,sys
s = json.load(open(sys.argv[1]))
s["pluginConfigs"] = {sys.argv[2]: {"options": {"unattended": sys.argv[3]}}}
json.dump(s, open(sys.argv[1], "w"))' "$MANAGED_F" "$PLUGIN" "$1"
}
unattended_world() {   # [option value]
    setup
    printf '{"statusLine": {"padding": 1}, "skillOverrides": {"other-skill": "on"}, "switchModelsOnFlag": false, "pluginConfigs": {"%s": {"options": {"unattended": "%s"}}}}\n' \
        "$PLUGIN" "${1-on}" >"$H/.config/ghost-protocol/inst.json"
    cp "$H/.config/ghost-protocol/inst.json" "$T/settings.before"
}

# 21. On: --permission-mode auto, the settings copy with its two settings,
#     GP_UNATTENDED for the deny hook; the instance's own file untouched.
unattended_world on
run_start --dry-run
check "unattended, dry run: ready" rc_is 0
check "unattended, dry run: a note says so" out_has '^  note +unattended mode is on'
check "unattended, dry run: --permission-mode auto" out_has '--permission-mode +auto'
check "unattended, dry run: the settings copy" out_has "--settings +$STATE_DIR/settings.json"
check "unattended, dry run: the copy is not written" [ ! -e "$STATE_DIR/settings.json" ]
run_start
check "unattended: --settings is the copy in the state folder" [ "$(arg_after --settings)" = "$STATE_DIR/settings.json" ]
check "unattended: --permission-mode auto, before the session's flags" \
    sh -c "[ \"\$(sed -n '3,5p' '$T/state/tmux.args' | tr '\n' ' ')\" = '--permission-mode auto --session-id ' ]"
check "unattended: the copy turns off the auto-mode-setup offer, and keeps other overrides" \
    [ "$(json_at "$T/state/tmux.settings" skillOverrides)" = '{"auto-mode-setup": "off", "other-skill": "on"}' ]
check "unattended: the copy lets a safeguard flag switch the model (switchModelsOnFlag true)" [ "$(json_at "$T/state/tmux.settings" switchModelsOnFlag)" = true ]
check "unattended: the copy keeps the rest (status line, plugin options)" \
    sh -c "[ '$(json_at "$T/state/tmux.settings" statusLine padding)' = 1 ] && [ '$(json_at "$T/state/tmux.settings" pluginConfigs "$PLUGIN" options unattended)' = '\"on\"' ]"
check "unattended: the copy is readable by its owner only" [ "$(stat -c %a "$STATE_DIR/settings.json" 2>/dev/null || stat -f %Lp "$STATE_DIR/settings.json")" = 600 ]
check "unattended: GP_UNATTENDED reaches claude alone (the deny hook), not the server" \
    sh -c "grep -qx 'tmux pane-env GP_UNATTENDED set' '$T/state/calls' && grep -qx 'GP_UNATTENDED=1' '$T/state/tmux.pane-env' && ! grep -qx 'env GP_UNATTENDED set' '$T/state/calls'"
check "unattended: the status line is told the copy" grep -qx 'env GP_CLAUDE_SETTINGS set' "$T/state/calls"
check "unattended: the instance's settings file is unchanged" cmp -s "$T/settings.before" "$H/.config/ghost-protocol/inst.json"
#    A resume passes the mode too (a resumed session would restore its own).
mkdir -p "$PROJ"; echo '{}' >"$PROJ/$(cat "$STATE_DIR/session-id").jsonl"
run_start
check "unattended, resumed: --permission-mode auto still" sh -c "grep -qx -- --resume '$T/state/tmux.args' && [ '$(arg_after --permission-mode)' = auto ]"
#    Other spellings of on; off, or anything else, is attended.
for v in true ON yes 1; do
    unattended_world "$v"; run_start
    check "unattended '$v': on" [ "$(arg_after --permission-mode)" = auto ]
done
for v in off no maybe ""; do
    unattended_world "$v"; run_start
    check "unattended '$v': off, the instance's own file, no mode" \
        sh -c "[ '$(arg_after --settings)' = '$H/.config/ghost-protocol/inst.json' ] && ! grep -q -- --permission-mode '$T/state/tmux.args' && ! grep -q 'GP_UNATTENDED' '$T/state/calls'"
done
#    Read from the managed settings and the instance's settings file only, the
#    first that sets it deciding: a value in the home's .claude/ files or the
#    user's settings never turns it on (a session a person runs there).
unattended_world off
printf '{"enabledPlugins": {"%s": true}, "pluginConfigs": {"%s": {"options": {"unattended": "on"}}}}\n' "$PLUGIN" "$PLUGIN" >"$H/.claude/settings.json"
run_start
check "off in the instance's file, on in the user's: off" lacks_arg --permission-mode
ON_JSON="$(printf '{"pluginConfigs": {"%s": {"options": {"unattended": "on"}}}}' "$PLUGIN")"
for where in user home-local home; do
    # The path only after setup, whose sandbox is new.
    setup; mkdir -p "$HOMEDIR/.claude"
    case "$where" in
        user)       f="$H/.claude/settings.json"
                    printf '{"enabledPlugins": {"%s": true}, "pluginConfigs": {"%s": {"options": {"unattended": "on"}}}}\n' "$PLUGIN" "$PLUGIN" >"$f" ;;
        home-local) f="$HOMEDIR/.claude/settings.local.json"; printf '%s\n' "$ON_JSON" >"$f" ;;
        home)       f="$HOMEDIR/.claude/settings.json"; printf '%s\n' "$ON_JSON" >"$f" ;;
    esac
    run_start
    check "on in ${f#"$T"/} alone: off (no mode, no copy, no GP_UNATTENDED)" \
        sh -c "grep -q unattended '$f' && ! grep -q -- --permission-mode '$T/state/tmux.args' && [ ! -e '$STATE_DIR/settings.json' ] && ! grep -q 'GP_UNATTENDED' '$T/state/calls'"
done
setup
managed true '{"plugin": "ghost-protocol", "marketplace": "ghost-protocol"}'
managed_unattended on
run_start
check "on in the managed settings, no instance file: on, the copy made from nothing" \
    sh -c "[ '$(arg_after --permission-mode)' = auto ] && [ '$(json_at "$STATE_DIR/settings.json" skillOverrides auto-mode-setup)' = '\"off\"' ]"
unattended_world on
managed_unattended off
run_start
check "off in the managed settings, on in the instance's file: off (managed comes first)" lacks_arg --permission-mode
#    GP_PERMISSION_MODE names another mode; bypassPermissions and unknown
#    modes are refused.
unattended_world on
start_env GP_PERMISSION_MODE=dontAsk "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "GP_PERMISSION_MODE=dontAsk: that mode" [ "$(arg_after --permission-mode)" = dontAsk ]
setup
start_env GP_PERMISSION_MODE=plan "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "GP_PERMISSION_MODE on an attended instance: passed, nothing else changes" \
    sh -c "[ '$(arg_after --permission-mode)' = plan ] && ! grep -q 'env GP_UNATTENDED' '$T/state/calls'"
for bad in bypassPermissions default Auto "auto;x"; do
    unattended_world on
    start_env GP_PERMISSION_MODE="$bad" "$START" --root \~/work --name inst --dry-run >"$OUT" 2>&1; RC=$?
    check "GP_PERMISSION_MODE=$bad: NOT READY" sh -c "[ $RC = 1 ] && grep -q '^NOT READY\$' '$OUT' && grep -q '^  MISSING  permission mode' '$OUT'"
    start_env GP_PERMISSION_MODE="$bad" "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
    check "GP_PERMISSION_MODE=$bad: a start refuses, tmux never asked" sh -c "[ $RC = 1 ] && ! grep -q 'tmux new-session' '$T/state/calls'"
done
start_env GP_PERMISSION_MODE=bypassPermissions "$START" --root \~/work --name inst --dry-run >"$OUT" 2>&1; RC=$?
check "bypassPermissions: the reason is given" out_has 'start refuses it; it skips every check, and Claude Code asks at startup to confirm it'
#    A settings file that is not a JSON object cannot take the copy: refused.
unattended_world on
echo '["not", "an object"]' >"$H/.config/ghost-protocol/inst.json"
managed_unattended on
run_start
check "unattended, settings not an object: refused" sh -c "[ $RC = 1 ] && grep -q '^  MISSING  unattended mode.s settings go on top of' '$OUT' && ! grep -q 'tmux new-session' '$T/state/calls'"
#    The copy cannot be written after the fresh request was taken: the request
#    goes back, for the next start.
unattended_world on
mkdir -p "$STATE_DIR" "$PROJ"; echo "$SID" >"$STATE_DIR/session-id"; echo '{}' >"$PROJ/$SID.jsonl"
: >"$STATE_DIR/fresh"; mkdir "$STATE_DIR/settings.json"
run_start
check "unattended, the copy cannot be written: refused, the fresh request put back" \
    sh -c "[ $RC = 1 ] && grep -q 'could not write $STATE_DIR/settings.json' '$OUT' && [ -f '$STATE_DIR/fresh' ] && ! grep -q 'tmux new-session' '$T/state/calls'"

# 22. --test in unattended mode: the copy carries the two settings, the mode is
#     passed, GP_UNATTENDED is set, and GP_INSTANCE_NAME never is.
test_world
printf '{"pluginConfigs": {"%s": {"options": {"unattended": "on", "buzz_relay_url": "https://relay.example.com"}}}}\n' "$PLUGIN" >"$H/.config/ghost-protocol/inst.json"
screen "$NOTICE_NEW"
run_test
check "test, unattended: passes" rc_is 0
check "test, unattended: the test copy turns off the auto-mode-setup offer" [ "$(json_at "$T/state/tmux.settings" skillOverrides auto-mode-setup)" = '"off"' ]
check "test, unattended: and switchModelsOnFlag" [ "$(json_at "$T/state/tmux.settings" switchModelsOnFlag)" = true ]
check "test, unattended: --permission-mode auto" [ "$(arg_after --permission-mode)" = auto ]
check "test, unattended: GP_UNATTENDED set" grep -qx 'env GP_UNATTENDED set' "$T/state/calls"
check "test: never GP_INSTANCE_NAME (the hooks leave the instance's state alone)" sh -c "! grep -q 'GP_INSTANCE_NAME' '$T/state/calls' && [ ! -s '$T/state/tmux.pane-env' ]"
check "test: no pane-pid written" [ ! -e "$STATE_DIR/pane-pid" ]
check "test, unattended: no copy in the state folder" [ ! -e "$STATE_DIR/settings.json" ]

# ---------------------------------------------------------------- --fresh

# A running instance: its session alive, start's watchdog (a stand-in
# process) alive, a transcript, a turn marker.
WD=""
fresh_running() {   # marker transcript-shape
    setup
    touch "$T/state/tmux.alive"
    mkdir -p "$STATE_DIR" "$PROJ"
    echo "$SID" >"$STATE_DIR/session-id"
    if [ -n "$WD" ]; then kill "$WD" 2>/dev/null; wait "$WD" 2>/dev/null; fi
    sleep 300 & WD=$!
    echo "$WD" >"$STATE_DIR/watchdog.pid"
    if [ -n "$1" ]; then echo "$1" >"$STATE_DIR/turn"; fi
    transcript "$2"
}
# transcript ended|running|blocked|metadata-after|sidechain-after|none
transcript() {
    local f="$PROJ/$SID.jsonl"
    rm -f "$f"
    case "$1" in
        none) return ;;
    esac
    {
        echo '{"type":"user","message":{"role":"user","content":"hi"}}'
        echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"ok"}],"stop_reason":"end_turn"}}'
        case "$1" in
            ended) echo '{"type":"system","subtype":"stop_hook_summary"}'; echo '{"type":"system","subtype":"turn_duration","durationMs":5}' ;;
            # Claude Code 2.1.314 counts the background Agent runs and workflows a turn left going.
            pending-agent) echo '{"type":"system","subtype":"turn_duration","durationMs":5,"messageCount":4,"pendingBackgroundAgentCount":1}' ;;
            pending-flow) echo '{"type":"system","subtype":"turn_duration","durationMs":5,"pendingBackgroundAgentCount":0,"pendingWorkflowCount":2}' ;;
            pending-zero) echo '{"type":"system","subtype":"turn_duration","durationMs":5,"pendingBackgroundAgentCount":0,"pendingWorkflowCount":0}' ;;
            # An older turn left one going; the last turn, none.
            pending-old) echo '{"type":"system","subtype":"turn_duration","durationMs":5,"pendingBackgroundAgentCount":3}'
                         echo '{"type":"user","message":{"role":"user","content":"next"}}'
                         echo '{"type":"assistant","message":{"content":[{"type":"text","text":"x"}],"stop_reason":"end_turn"}}'
                         echo '{"type":"system","subtype":"turn_duration","durationMs":5,"pendingBackgroundAgentCount":0}' ;;
            # A subagent's own turn_duration (a sidechain) does not speak for the main thread.
            pending-sidechain) echo '{"type":"system","subtype":"turn_duration","durationMs":5}'; echo '{"type":"system","subtype":"turn_duration","isSidechain":true,"pendingBackgroundAgentCount":1}' ;;
            metadata-after) echo '{"type":"system","subtype":"turn_duration","durationMs":5}'; echo '{"type":"file-history-snapshot"}'; echo '{"type":"cost-state"}'; echo 'not json' ;;
            sidechain-after) echo '{"type":"system","subtype":"turn_duration","durationMs":5}'; echo '{"type":"assistant","isSidechain":true,"message":{"content":[]}}' ;;
            # A Stop a hook blocked: its feedback, then the turn goes on; no turn_duration yet.
            blocked) echo '{"type":"system","subtype":"turn_duration","durationMs":5}'
                     echo '{"type":"user","message":{"role":"user","content":"next"}}'
                     echo '{"type":"assistant","message":{"content":[{"type":"text","text":"x"}],"stop_reason":"end_turn"}}'
                     echo '{"type":"attachment","attachment":{"type":"hook_blocking_error"}}'
                     echo '{"type":"system","subtype":"stop_hook_summary"}' ;;
        esac
    } >"$f"
}
run_fresh() { start_env GP_FRESH_TIMEOUT="${FRESH_TIMEOUT:-5}" "$START" --root \~/work --name inst --fresh >"$OUT" 2>&1; RC=$?; }
killed_session() { grep -qx 'tmux target kill-session =inst' "$T/state/calls"; }
BUSY_LINE="^start: BUSY: instance inst was still working after [0-9]+s; it was not restarted, and no fresh start is set\$"

# 23. Idle: the marker says idle (or there is none) and the transcript's turn
#     is over: the file is set and the session ended, for the watchdog.
for shape in "idle p1|ended" "|ended" "idle p1|metadata-after" "idle p1|sidechain-after" "idle p1|none"; do
    fresh_running "${shape%%|*}" "${shape#*|}"
    run_fresh
    check "fresh, idle ($shape): exit 0" rc_is 0
    check "fresh, idle ($shape): the file is set" [ -e "$STATE_DIR/fresh" ]
    check "fresh, idle ($shape): the session is ended, by its exact name" killed_session
    check "fresh, idle ($shape): said" out_has '^start: instance inst was idle: its session is ended, and the watchdog starts a new one$'
done

# 24. Busy: it waits, then refuses with the fixed line; no file, nothing ended.
for shape in "busy p2|ended" "idle p1|running" "idle p1|blocked" "busy p2|none"; do
    fresh_running "${shape%%|*}" "${shape#*|}"
    t0="$(date +%s)"
    FRESH_TIMEOUT=2 run_fresh
    t1="$(date +%s)"
    check "fresh, busy ($shape): exit 1, the fixed line" sh -c "[ $RC = 1 ] && grep -qE '$BUSY_LINE' '$OUT'"
    check "fresh, busy ($shape): it waited the timeout" [ $((t1 - t0)) -ge 2 ]
    check "fresh, busy ($shape): no file is left" [ ! -e "$STATE_DIR/fresh" ]
    check "fresh, busy ($shape): the session runs on" sh -c "! grep -q 'kill-session' '$T/state/calls' && [ -e '$T/state/tmux.alive' ]"
done
# "running": the transcript ends in the turn's own entries.
fresh_running "" running
transcript running
FRESH_TIMEOUT=1 run_fresh
check "fresh, a turn the marker missed (transcript mid-turn): refused" sh -c "[ $RC = 1 ] && grep -qE '$BUSY_LINE' '$OUT'"

# 25. Busy, then idle within the wait: it restarts then.
fresh_running "busy p2" running
( sleep 2; transcript ended; echo "idle p2" >"$STATE_DIR/turn" ) &
t0="$(date +%s)"
FRESH_TIMEOUT=20 run_fresh
t1="$(date +%s)"
wait $!
check "fresh, busy then idle: exit 0, the session ended" sh -c "[ $RC = 0 ] && grep -qx 'tmux target kill-session =inst' '$T/state/calls'"
check "fresh, busy then idle: only once idle (it waited)" [ $((t1 - t0)) -ge 2 ]
check "fresh, busy then idle: the file is set" [ -e "$STATE_DIR/fresh" ]

# 26. Not running: the file, for its next start. Running without start's
#     watchdog: refused, since nothing would start it again.
fresh_running "busy p2" running; rm "$T/state/tmux.alive"
run_fresh
check "fresh, not running: exit 0, the file set, said" sh -c "[ $RC = 0 ] && [ -e '$STATE_DIR/fresh' ] && grep -q 'is not running; its next start begins a new session' '$OUT'"
check "fresh, not running: nothing ended" sh -c "! grep -q 'kill-session' '$T/state/calls'"
fresh_running "idle p1" ended; kill "$WD"; wait "$WD" 2>/dev/null; WD=""
run_fresh
check "fresh, no watchdog: refused, no file, nothing ended" \
    sh -c "[ $RC = 1 ] && grep -q 'runs without start.s watchdog' '$OUT' && [ ! -e '$STATE_DIR/fresh' ] && ! grep -q 'kill-session' '$T/state/calls'"
fresh_running "idle p1" ended; rm "$STATE_DIR/watchdog.pid"
run_fresh
check "fresh, no watchdog pid file: refused" sh -c "[ $RC = 1 ] && [ ! -e '$STATE_DIR/fresh' ]"
if [ -n "$WD" ]; then kill "$WD" 2>/dev/null; wait "$WD" 2>/dev/null; WD=""; fi
#    --fresh goes one at a time with the other modes.
run_start --fresh --dry-run
check "--fresh with --dry-run: exit 2" rc_is 2
#    A fresh file it cannot write (a folder of that name): refused before
#    anything is ended.
fresh_running "idle p1" ended; mkdir "$STATE_DIR/fresh"
run_fresh
check "fresh, a folder named fresh: refused, nothing ended" \
    sh -c "[ $RC = 1 ] && grep -q 'could not write $STATE_DIR/fresh; not restarting instance inst' '$OUT' && ! grep -q 'kill-session' '$T/state/calls'"
rmdir "$STATE_DIR/fresh"; rm "$T/state/tmux.alive"; mkdir "$STATE_DIR/fresh"
run_fresh
check "fresh, not running, a folder named fresh: refused" sh -c "[ $RC = 1 ] && grep -q 'could not write $STATE_DIR/fresh' '$OUT'"
rmdir "$STATE_DIR/fresh"

# 28. Work outside the session's own turn keeps it busy, its turn over: another
#     conversation's transcript in the project folder, or anything in the
#     session's own folder (a background subagent's transcript), written in
#     the last GP_FRESH_QUIET seconds; or a tool command claude runs: a child
#     of the pane's pid that runs Claude Code's shell snapshot, reads
#     /dev/null, or writes a task output file (as Claude Code runs a Bash or
#     Monitor command). Older writes, and children with none of these signs
#     (as its MCP servers), are not work. A refusal names the last sign.
age() {   # seconds file...: the files' times moved that far back
    t_env python3 -I -c 'import os, sys, time
t = time.time() - int(sys.argv[1])
for p in sys.argv[2:]:
    os.utime(p, (t, t))' "$@"
}
OTHER_SID=5e6f7081-92a3-4b4c-8d5e-6f708192a3b4
fresh_running "idle p1" ended
echo '{}' >"$PROJ/$OTHER_SID.jsonl"
FRESH_TIMEOUT=1 run_fresh
check "fresh, another conversation's transcript just written: busy, the sign named" \
    sh -c "[ $RC = 1 ] && grep -qE '$BUSY_LINE' '$OUT' && grep -q '^start: the last sign of work: another conversation in the project folder, $OTHER_SID.jsonl, was written in the last 60s\$' '$OUT' && ! grep -q kill-session '$T/state/calls'"
age 30 "$PROJ/$OTHER_SID.jsonl"
FRESH_TIMEOUT=1 run_fresh
check "fresh, that transcript 30s old: still busy (GP_FRESH_QUIET 60)" rc_is 1
start_env GP_FRESH_TIMEOUT=1 GP_FRESH_QUIET=20 "$START" --root \~/work --name inst --fresh >"$OUT" 2>&1; RC=$?
check "fresh, that transcript 30s old, GP_FRESH_QUIET=20: idle, restarted" sh -c "[ $RC = 0 ] && grep -qx 'tmux target kill-session =inst' '$T/state/calls'"
fresh_running "idle p1" ended
mkdir -p "$PROJ/$SID/subagents"; echo '{}' >"$PROJ/$SID/subagents/agent-a1.jsonl"
FRESH_TIMEOUT=1 run_fresh
check "fresh, a subagent's transcript in the session's folder just written: busy, the sign named" \
    sh -c "[ $RC = 1 ] && grep -q '^start: the last sign of work: the session folder $PROJ/$SID (its subagents) was written in the last 60s\$' '$OUT' && ! grep -q kill-session '$T/state/calls'"
age 120 "$PROJ/$SID/subagents/agent-a1.jsonl"
run_fresh
check "fresh, that subagent quiet for 120s: idle, restarted" sh -c "[ $RC = 0 ] && grep -qx 'tmux target kill-session =inst' '$T/state/calls'"
if [ ! -d /proc/self ]; then
    echo "SKIP  tool commands as claude's children (no /proc here)"
else
    # pane_standin null|task|snapshot|server: a stand-in for the pane's claude
    # with one child: one that reads /dev/null, writes a task output file, runs
    # a shell snapshot (in its command line), or none of these (as an MCP
    # server). Each redirection is explicit: bash gives a background command
    # /dev/null for input on its own.
    pane_standin() {
        : >"$T/stdin-file"; : >"$T/child-input"
        mkdir -p "$T/tmp/claude-x/proj/sid/tasks"
        case "$1" in
            null)     bash -c 'sleep 30 </dev/null & wait' <"$T/stdin-file" >/dev/null 2>&1 & ;;
            task)     bash -c 'sleep 30 <"$1" >"$2" & wait' sh "$T/child-input" "$T/tmp/claude-x/proj/sid/tasks/b1.output" <"$T/stdin-file" >/dev/null 2>&1 & ;;
            snapshot) bash -c 'bash -c "sleep 30; :" "$2" <"$1" & wait' sh "$T/child-input" "$H/.claude/shell-snapshots/snapshot-zsh-1.sh" <"$T/stdin-file" >/dev/null 2>&1 & ;;
            server)   bash -c 'sleep 30 <"$1" & wait' sh "$T/child-input" <"$T/stdin-file" >/dev/null 2>&1 & ;;
        esac
        PANE_BG=$!
        echo "$PANE_BG" >"$T/state/tmux.pane-pid"
        local i=0
        while [ -z "$(cat "/proc/$PANE_BG/task/$PANE_BG/children" 2>/dev/null)" ] && [ "$i" -lt 40 ]; do sleep 0.05; i=$((i + 1)); done
        sleep 0.2
    }
    pane_gone() { pkill -P "$PANE_BG" 2>/dev/null; kill "$PANE_BG" 2>/dev/null; wait "$PANE_BG" 2>/dev/null; rm -f "$T/state/tmux.pane-pid"; }
    for kind in null task snapshot; do
        fresh_running "idle p1" ended
        pane_standin "$kind"
        case "$kind" in
            null) sign="its input /dev/null" ;;
            task) sign="its output a task file" ;;
            snapshot) sign="it runs the shell snapshot" ;;
        esac
        FRESH_TIMEOUT=1 run_fresh
        check "fresh, claude runs a tool command ($sign): busy, the sign named" \
            sh -c "[ $RC = 1 ] && grep -qE '^start: the last sign of work: claude runs a tool command \\(process [0-9]+: $sign\\)\$' '$OUT' && ! grep -q kill-session '$T/state/calls'"
        pane_gone
    done
    fresh_running "idle p1" ended
    pane_standin server
    run_fresh
    check "fresh, claude's only child reads something else (as an MCP server): idle, restarted" sh -c "[ $RC = 0 ] && grep -qx 'tmux target kill-session =inst' '$T/state/calls'"
    pane_gone
fi

# 28b. Background Agent runs and workflows the last turn left going keep it
#     busy, however quiet their folder: the main thread's last turn_duration
#     counts them (pendingBackgroundAgentCount, pendingWorkflowCount). A
#     subagent 90 seconds into one model call wrote nothing in that time, has
#     no shell child, and is still at work.
fresh_running "idle p1" pending-agent
mkdir -p "$PROJ/$SID/subagents"
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}' >"$PROJ/$SID/subagents/agent-a1.jsonl"
echo '{"agentType":"general-purpose"}' >"$PROJ/$SID/subagents/agent-a1.meta.json"
age 90 "$PROJ/$SID/subagents/agent-a1.jsonl" "$PROJ/$SID/subagents/agent-a1.meta.json" "$PROJ/$SID.jsonl"
FRESH_TIMEOUT=2 run_fresh
check "fresh, a background Agent run going (its folder quiet 90s): busy, nothing ended, the sign named" \
    sh -c "[ $RC = 1 ] && ! grep -q kill-session '$T/state/calls' && [ ! -e '$STATE_DIR/fresh' ] && grep -q '^start: the last sign of work: the last turn left 1 background Agent run(s) and 0 workflow(s) going\$' '$OUT'"
fresh_running "idle p1" pending-flow
FRESH_TIMEOUT=1 run_fresh
check "fresh, a workflow going: busy" sh -c "[ $RC = 1 ] && ! grep -q kill-session '$T/state/calls' && grep -q 'left 0 background Agent run(s) and 2 workflow(s) going' '$OUT'"
for shape in pending-zero pending-old pending-sidechain; do
    fresh_running "idle p1" "$shape"
    run_fresh
    check "fresh, $shape (nothing going after the last main turn): idle, restarted" sh -c "[ $RC = 0 ] && grep -qx 'tmux target kill-session =inst' '$T/state/calls'"
done

# 28c. Two calls at once, replayed in order through the stand-in tmux, whose
#     display-message runs a script at a given call (here the third: the one
#     the activity check makes, after the loop's checks and before the kill).
#     Another call makes the fresh file there: this one, which makes it only
#     where none is (noclobber), ends nothing. Another restart changes the
#     pane there: this one reads the pane again just before the kill, ends
#     nothing and takes its own file back.
fresh_running "idle p1" ended
echo 99999901 >"$T/state/tmux.pane-pid"
printf ': >"%s"\n' "$STATE_DIR/fresh" >"$T/state/tmux.on-display.3"
run_fresh
check "fresh, another call made the file just before this one: nothing ended, said" \
    sh -c "[ $RC = 0 ] && ! grep -q kill-session '$T/state/calls' && grep -q 'was set by another call meanwhile' '$OUT' && [ \"\$(cat '$T/state/tmux.display-count')\" -ge 3 ]"
fresh_running "idle p1" ended
echo 99999901 >"$T/state/tmux.pane-pid"
printf 'echo 99999902 >"%s"\n' "$T/state/tmux.pane-pid" >"$T/state/tmux.on-display.3"
run_fresh
check "fresh, the pane changed just before the kill: nothing ended, its file taken back, said" \
    sh -c "[ $RC = 0 ] && ! grep -q kill-session '$T/state/calls' && [ ! -e '$STATE_DIR/fresh' ] && grep -q '^start: instance inst moved on while this call waited (pane 99999901, now 99999902)' '$OUT'"
fresh_running "idle p1" ended
echo 99999901 >"$T/state/tmux.pane-pid"
run_fresh
check "fresh, the same pane all along: ended (the pane read again before the kill)" \
    sh -c "[ $RC = 0 ] && grep -qx 'tmux target kill-session =inst' '$T/state/calls' && [ \"\$(cat '$T/state/tmux.display-count')\" = 4 ]"

# 28d. A link named fresh is never written through: --fresh removes it and
#     makes a regular file, running or not, and the link's target is untouched.
fresh_running "idle p1" ended; rm "$T/state/tmux.alive"
echo important >"$T/link-target"; ln -s "$T/link-target" "$STATE_DIR/fresh"
run_fresh
check "fresh, not running, fresh a link: a regular file now, the target untouched" \
    sh -c "[ $RC = 0 ] && [ -f '$STATE_DIR/fresh' ] && [ ! -L '$STATE_DIR/fresh' ] && [ \"\$(cat '$T/link-target')\" = important ]"
fresh_running "idle p1" ended
echo important >"$T/link-target"; ln -s "$T/link-target" "$STATE_DIR/fresh"
run_fresh
check "fresh, idle, fresh a link: ended, a regular file now, the target untouched" \
    sh -c "[ $RC = 0 ] && grep -qx 'tmux target kill-session =inst' '$T/state/calls' && [ -f '$STATE_DIR/fresh' ] && [ ! -L '$STATE_DIR/fresh' ] && [ \"\$(cat '$T/link-target')\" = important ]"

# 29. Two restarts never come of one wait: the session id and the pane's pid
#     are noted when --fresh begins. When either changes while it waits
#     (another --fresh restarted it, a crash, a /clear), or a fresh file
#     appears that it did not set, it ends nothing and exits 0. The new session
#     reads as idle (no marker, no transcript): without the check, it would be
#     ended as it boots.
NEW_SID=6f708192-a3b4-4c5d-9e6f-708192a3b4c5
fresh_running "busy p2" running
echo 99999901 >"$T/state/tmux.pane-pid"
( sleep 2; echo "$NEW_SID" >"$STATE_DIR/session-id"; echo 99999902 >"$T/state/tmux.pane-pid"; rm -f "$STATE_DIR/turn" ) &
FRESH_TIMEOUT=10 run_fresh
wait $!
check "fresh, restarted by another call meanwhile: exit 0, nothing ended, no file, said" \
    sh -c "[ $RC = 0 ] && ! grep -q kill-session '$T/state/calls' && [ ! -e '$STATE_DIR/fresh' ] && grep -q '^start: instance inst moved on while this call waited (session $SID in pane 99999901, now $NEW_SID in pane 99999902)' '$OUT'"
fresh_running "busy p2" running
( sleep 2; echo "$NEW_SID" >"$STATE_DIR/session-id"; rm -f "$STATE_DIR/turn" ) &
FRESH_TIMEOUT=10 run_fresh
wait $!
check "fresh, a /clear meanwhile (the session id alone changed): nothing ended" sh -c "[ $RC = 0 ] && ! grep -q kill-session '$T/state/calls' && grep -q 'moved on while this call waited' '$OUT'"
fresh_running "busy p2" running
echo 99999901 >"$T/state/tmux.pane-pid"
( sleep 2; echo 99999902 >"$T/state/tmux.pane-pid"; rm -f "$STATE_DIR/turn"; transcript ended ) &
FRESH_TIMEOUT=10 run_fresh
wait $!
check "fresh, a restart into the same session meanwhile (the pane alone changed): nothing ended" sh -c "[ $RC = 0 ] && ! grep -q kill-session '$T/state/calls' && grep -q 'moved on while this call waited' '$OUT'"
fresh_running "busy p2" running
( sleep 2; : >"$STATE_DIR/fresh"; rm -f "$STATE_DIR/turn"; transcript ended ) &
FRESH_TIMEOUT=10 run_fresh
wait $!
check "fresh, a fresh file set by another call meanwhile: nothing ended by this one" \
    sh -c "[ $RC = 0 ] && ! grep -q kill-session '$T/state/calls' && grep -q 'was set by another call meanwhile' '$OUT'"
rm -f "$T/state/tmux.pane-pid"
if [ -n "$WD" ]; then kill "$WD" 2>/dev/null; wait "$WD" 2>/dev/null; WD=""; fi

# 27. Asked from the instance's own session (GP_INSTANCE_NAME is its name, as
#     when the agent asks once its work is done): that turn is the busy one, so
#     the call returns at once and the wait goes on in the background, with
#     its result in fresh.log.
wait_for() {   # file pattern seconds
    local i=0
    while [ "$i" -lt $(( $3 * 2 )) ]; do
        grep -qE -- "$2" "$1" 2>/dev/null && return 0
        sleep 0.5; i=$((i + 1))
    done
    return 1
}
own_fresh() { start_env GP_INSTANCE_NAME="${OWN:-inst}" GP_FRESH_TIMEOUT="${FRESH_TIMEOUT:-20}" "$START" --root \~/work --name inst --fresh >"$OUT" 2>&1; RC=$?; }
fresh_running "busy p2" running
t_tool setsid || t_tool nohup
( sleep 3; transcript ended; echo "idle p2" >"$STATE_DIR/turn" ) &
t0="$(date +%s)"
own_fresh
t1="$(date +%s)"
check "own session: exit 0 at once (before the turn ends)" sh -c "[ $RC = 0 ] && [ $((t1 - t0)) -le 2 ]"
check "own session: it says the restart follows, and where the result goes" out_has "it waits in the background until this turn has ended, then restarts; the result goes to $STATE_DIR/fresh.log\$"
check "own session: nothing ended yet" sh -c "! grep -q 'kill-session' '$T/state/calls'"
wait $!
check "own session: once idle, the background run ends the session" wait_for "$STATE_DIR/fresh.log" 'was idle: its session is ended' 15
check "own session: the session ended and the file set" sh -c "grep -qx 'tmux target kill-session =inst' '$T/state/calls' && [ -e '$STATE_DIR/fresh' ]"
fresh_running "busy p2" running
t_tool setsid || t_tool nohup
FRESH_TIMEOUT=1 own_fresh
check "own session, still busy: exit 0 at once" rc_is 0
check "own session, still busy: the fixed line lands in fresh.log" wait_for "$STATE_DIR/fresh.log" 'BUSY: instance inst was still working after 1s' 10
check "own session, still busy: no file, nothing ended" sh -c "[ ! -e '$STATE_DIR/fresh' ] && ! grep -q 'kill-session' '$T/state/calls'"
fresh_running "idle p1" ended
OWN=other own_fresh
check "another instance's session: no background run, the answer at once" \
    sh -c "[ $RC = 0 ] && grep -q 'was idle: its session is ended' '$OUT' && [ ! -e '$STATE_DIR/fresh.log' ]"
if [ -n "$WD" ]; then kill "$WD" 2>/dev/null; wait "$WD" 2>/dev/null; WD=""; fi

# ---------------------------------------------------------------- the process name

# 17. /bin/bash, not env bash, so the watchdog runs as "start" (the memory
#     guard spares it by that name).
check "the first line is #!/bin/bash" [ "$(head -n 1 "$START")" = "#!/bin/bash" ]
setup
run_start
if grep -q '^tmux parent ' "$T/state/calls"; then
    check "the watchdog's process name is start" grep -qx 'tmux parent start' "$T/state/calls"
else
    echo "SKIP  the watchdog's process name (no /proc here)"
fi

# ---------------------------------------------------------------- a key service

# 18. The session's side of a key service: the plugin's buzz_key_socket names
#     the folder of its sockets (install/keyservice/setup), and the key command
#     is empty.
key_service_world() {   # key command
    setup
    KS="$T/run-ks"
    mkdir -p "$KS"
    t_env python3 -I -c 'import socket, sys
for n in ("channel", "buzz-mcp"):
    socket.socket(socket.AF_UNIX).bind(sys.argv[1] + "/" + n + ".sock")' "$KS"
    printf '{"pluginConfigs": {"%s": {"options": {"buzz_key_socket": "%s", "buzz_key_command": "%s", "buzz_channels": ""}}}}\n' \
        "$PLUGIN" "$KS" "$1" >"$H/.config/ghost-protocol/inst.json"
    rm -f "$H/.cache/ghost-protocol/buzz/buzz-mcp.mjs"
}
key_service_world ""
run_start --dry-run
check "key service: ready without a buzz-mcp build of its own" rc_is 0
check "key service: a note says the key service runs buzz-mcp" out_has "^  note +a key service holds the relay key \\(buzz_key_socket $KS\\)"
check "key service: its channel socket checked" out_has "^  ok +the key service's channel socket $KS/channel.sock"
check "key service: its buzz-mcp socket checked" out_has "^  ok +the key service's buzz-mcp socket $KS/buzz-mcp.sock"
check "key service: no key command checked" out_has "^  ok +no key command on the session's side"
check "key service: no buzz-mcp build checked" out_lacks 'buzz-mcp built'
rm "$KS/channel.sock"
run_start --dry-run
check "key service, its channel socket gone: NOT READY" sh -c "[ $RC = 1 ] && grep -q '^  MISSING  the key service.s channel socket' '$OUT'"
run_start
check "key service, its channel socket gone: a start refuses" sh -c "[ $RC = 1 ] && ! grep -q '^tmux new-session' '$T/state/calls'"
key_service_world "secret-tool lookup key"
run_start --dry-run
check "key service with a key command left: NOT READY" sh -c "[ $RC = 1 ] && grep -q '^  MISSING  no key command on the session.s side' '$OUT'"
#     No channel plus a key socket: the key command is still checked; the
#     sockets are not, since the Buzz servers are denied.
key_service_world "secret-tool lookup key"
printf '{"deniedMcpServers": [{"serverName": "plugin:ghost-protocol:buzz"}, {"serverName": "plugin:ghost-protocol:buzz-channel"}], "pluginConfigs": {"%s": {"options": {"buzz_key_socket": "%s", "buzz_key_command": "secret-tool lookup key"}}}}\n' "$PLUGIN" "$KS" >"$H/.config/ghost-protocol/inst.json"
start_env GP_CHANNELS= "$START" --root \~/work --name inst --dry-run >"$OUT" 2>&1; RC=$?
check "no channel, key service with a key command left: NOT READY" sh -c "[ $RC = 1 ] && grep -q '^  MISSING  no key command on the session.s side' '$OUT'"
key_service_world ""
printf '{"deniedMcpServers": [{"serverName": "plugin:ghost-protocol:buzz"}, {"serverName": "plugin:ghost-protocol:buzz-channel"}], "pluginConfigs": {"%s": {"options": {"buzz_key_socket": "%s", "buzz_key_command": ""}}}}\n' "$PLUGIN" "$KS" >"$H/.config/ghost-protocol/inst.json"
rm "$KS/channel.sock"
start_env GP_CHANNELS= "$START" --root \~/work --name inst --dry-run >"$OUT" 2>&1; RC=$?
check "no channel, key service, empty key command: ready" rc_is 0
check "no channel, key service: the key command checked" out_has "^  ok +no key command on the session's side"
check "no channel, key service: its sockets not checked" out_lacks "the key service's channel socket"

#     Credentials: a Buzz or Nostr one never reaches the session.
buzz_creds_world() {
    mkdir -p "$T/creds"
    printf 'fake-key' >"$T/creds/buzz-private-key"
    printf 'fake-command' >"$T/creds/buzz-key-command"
    printf 'fake-nostr' >"$T/creds/nostr-secret-key"
    printf 'fake-tag' >"$T/creds/buzz-auth-tag"
    printf 'fake-one' >"$T/creds/api-token"
}
setup
buzz_creds_world
start_env CREDENTIALS_DIRECTORY="$T/creds" "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "credentials: BUZZ_PRIVATE_KEY refused" sh -c "grep -q 'refused credential BUZZ_PRIVATE_KEY: a Buzz or Nostr credential never goes into Claude Code' '$OUT' && ! grep -qx 'env BUZZ_PRIVATE_KEY set' '$T/state/calls'"
check "credentials: BUZZ_KEY_COMMAND refused" sh -c "grep -q 'refused credential BUZZ_KEY_COMMAND' '$OUT' && ! grep -qx 'env BUZZ_KEY_COMMAND set' '$T/state/calls'"
check "credentials: NOSTR_SECRET_KEY refused" sh -c "grep -q 'refused credential NOSTR_SECRET_KEY' '$OUT' && ! grep -qx 'env NOSTR_SECRET_KEY set' '$T/state/calls'"
check "credentials: without a key service, the owner's tag goes through" grep -qx 'env BUZZ_AUTH_TAG set' "$T/state/calls"
check "credentials: the other credential goes through" grep -qx 'env API_TOKEN set' "$T/state/calls"
check "credentials: two exported" out_has 'exported 2 credential'
check "credentials: no value printed" out_lacks 'fake-'
key_service_world ""
buzz_creds_world
start_env CREDENTIALS_DIRECTORY="$T/creds" "$START" --root \~/work --name inst >"$OUT" 2>&1; RC=$?
check "credentials, key service: the owner's tag refused too" sh -c "grep -q 'refused credential BUZZ_AUTH_TAG: with a key service' '$OUT' && ! grep -qx 'env BUZZ_AUTH_TAG set' '$T/state/calls'"
check "credentials, key service: no key reaches the session" sh -c "! grep -qE 'env (BUZZ_PRIVATE_KEY|BUZZ_KEY_COMMAND|NOSTR_SECRET_KEY) set' '$T/state/calls'"
check "credentials, key service: one exported" out_has 'exported 1 credential'

#     --test on a key service instance: the copy empties the key socket, so the
#     test's channel is a throwaway one, never the instance's (one at a time).
key_service_world ""
touch "$T/state/tmux.alive"
mkdir -p "$STATE_DIR" "$PROJ"
screen "  ✻ Welcome" "$NOTICE_NEW" "> "
run_test
check "test, key service: passes" rc_is 0
check "test copy, key service: the instance's own settings name the key socket" grep -qF "\"buzz_key_socket\": \"$KS\"" "$H/.config/ghost-protocol/inst.json"
check "test copy, key service: the copy has the key socket option" grep -q '"buzz_key_socket"' "$T/state/tmux.settings"
check "test copy, key service: the key socket emptied" [ -z "$(copy_opt buzz_key_socket)" ]
check "test copy, key service: a throwaway key command" [ "$(copy_opt buzz_key_command)" = 'od -An -N32 -tx1 /dev/urandom | tr -d " \n"' ]

# 29b. --fresh reads the pid of claude's own pane (pane-id), not the session's
#     active pane: the operator may be on another window. A restart into a new
#     pane while it waits is still seen.
fresh_running "idle p1" ended
echo '%3' >"$STATE_DIR/pane-id"
printf '%%0 0 111\n%%3 0 222\n' >"$T/state/tmux.panes"
echo 111 >"$T/state/tmux.pane-pid"
run_fresh
check "fresh, claude's pane not the active one: read by its pane, ended" \
    sh -c "[ $RC = 0 ] && grep -qx 'tmux target list-panes =inst' '$T/state/calls' && ! grep -q 'tmux target display-message' '$T/state/calls' && grep -qx 'tmux target kill-session =inst' '$T/state/calls'"
fresh_running "busy p2" running
echo '%3' >"$STATE_DIR/pane-id"
printf '%%0 0 111\n%%3 0 222\n' >"$T/state/tmux.panes"
cat >"$T/state/tmux.on-list.2" <<EOS
printf '%%0 0 111\n%%4 0 333\n' >'$T/state/tmux.panes'; echo '%4' >'$STATE_DIR/pane-id'
EOS
FRESH_TIMEOUT=5 run_fresh
check "fresh, claude restarted in a new window meanwhile: nothing ended, said" \
    sh -c "[ $RC = 0 ] && ! grep -q kill-session '$T/state/calls' && grep -q 'moved on while this call waited (session $SID in pane 222, now $SID in pane ' '$OUT'"

# 30. Claude Code's needs-login list (~/.claude/mcp-needs-auth-cache.json):
#     before claude starts, the plugin's servers are taken off it, and every
#     other server's entry stays; a dry run says what a start would take off.
#     A link, or a file that is not a JSON object, is left alone.
NA="$T/no-such-file"
needs_auth_world() {
    NA="$H/.claude/mcp-needs-auth-cache.json"
    printf '{"plugin:ghost-protocol:buzz": {"id": "a", "timestamp": 1}, "plugin:ghost-protocol:buzz-channel": {"id": "b", "timestamp": 2}, "claude.ai Example": {"id": "c", "timestamp": 3}, "plugin:other:buzz": {"id": "d", "timestamp": 4}}\n' >"$NA"
    chmod 644 "$NA"
}
na_keys() { t_env python3 -I -c 'import json, sys; print(" ".join(sorted(json.load(open(sys.argv[1])))))' "$NA"; }
line_of() { grep -n -m 1 -E -- "$1" "$OUT" | cut -d: -f1; }
setup; needs_auth_world
run_start --dry-run
check "needs-login, dry run: says a start takes the plugin's 2 off" out_has "^  note +Claude Code's needs-login list \\(.*mcp-needs-auth-cache.json\\) holds 2 of the plugin's MCP servers"
check "needs-login, dry run: the file unchanged" [ "$(na_keys)" = "claude.ai Example plugin:ghost-protocol:buzz plugin:ghost-protocol:buzz-channel plugin:other:buzz" ]
run_start
check "needs-login, a start: says it took 2 off" out_has "took the plugin's 2 MCP server\\(s\\) off Claude Code's needs-login list"
check "needs-login, a start: only the plugin's entries gone" [ "$(na_keys)" = "claude.ai Example plugin:other:buzz" ]
check "needs-login, a start: before claude starts" sh -c "[ \"$(line_of "took the plugin's")\" -lt \"$(line_of 'starting claude in tmux')\" ]"
check "needs-login, a start: the others' fields kept" grep -qF '"claude.ai Example": {"id": "c", "timestamp": 3}' "$NA"
check "needs-login, a start: the file's mode kept" [ "$(stat -c %a "$NA")" = 644 ]
check "needs-login, a start: no temporary file left" sh -c "[ -z \"\$(ls '$H/.claude' | grep 'gp-start')\" ]"
run_start
check "needs-login, nothing of the plugin's left: nothing said" out_lacks 'needs-login list'
setup; needs_auth_world
touch "$T/state/tmux.alive"
mkdir -p "$STATE_DIR" "$PROJ"
screen "  ✻ Welcome" "$NOTICE_NEW" "> "
run_test
check "needs-login, --test: passes" rc_is 0
check "needs-login, --test: the plugin's entries taken off first" [ "$(na_keys)" = "claude.ai Example plugin:other:buzz" ]
setup
NA="$H/.claude/mcp-needs-auth-cache.json"
printf '[1, 2]\n' >"$NA"
run_start
check "needs-login, not a JSON object: left alone, and said" sh -c "grep -q 'mcp-needs-auth-cache.json is not a JSON object: left alone' '$OUT' && [ \"\$(cat '$NA')\" = '[1, 2]' ]"
check "needs-login, not a JSON object: claude starts all the same" called "tmux new-session"
setup; needs_auth_world
mv "$NA" "$T/real-cache.json"; ln -s "$T/real-cache.json" "$NA"
run_start
check "needs-login, a link: never written through" sh -c "grep -q 'is not a plain file (a link?): left alone' '$OUT' && grep -q 'plugin:ghost-protocol:buzz-channel' '$T/real-cache.json' && [ -L '$NA' ]"
setup
run_start
check "needs-login, no file: nothing said, nothing made" sh -c "! grep -q 'needs-login' '$OUT' && [ ! -e '$H/.claude/mcp-needs-auth-cache.json' ]"

# 31. With a real tmux, on a socket of the test's own (TMUX_TMPDIR in the
#     sandbox): claude's window ends while the operator's window keeps the
#     session alive, and claude comes back in a new window, resumed, with
#     pane-pid its pid, while the operator's window is still there. Then the
#     session ends and start exits 1. The claude here is a stand-in that waits
#     until the test tells it to end.
real_tmux() { start_env tmux -L inst "$@"; }
wait_file() {   # file: up to 20 seconds
    local i=0
    while [ ! -e "$1" ] && [ "$i" -lt 100 ]; do sleep 0.2; i=$((i + 1)); done
    [ -e "$1" ]
}
setup
rm -f "$T/stubs/tmux"
if ! t_tool tmux || ! t_tool timeout; then
    echo "SKIP  claude's window ends, with a real tmux (no tmux or no timeout on this machine)"
else
    cat >"$H/.local/bin/claude" <<'FAKE'
#!/bin/sh
# A stand-in claude for a real tmux: notes each start (its pid and its
# arguments, and whether SSH_AUTH_SOCK is set: the name only), then waits
# until the test asks it to end (real.exit.<n>).
d="$STUB_STATE"
n=$(( $(cat "$d/real.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" >"$d/real.count"
printf '%s\n' "$@" >"$d/real.args.$n"
echo "$$" >"$d/real.pid.$n"
if [ -n "${SSH_AUTH_SOCK+x}" ]; then echo set >"$d/real.sock.$n"; else echo unset >"$d/real.sock.$n"; fi
while [ ! -e "$d/real.exit.$n" ]; do sleep 0.2; done
FAKE
    chmod +x "$H/.local/bin/claude"
    mkdir -p "$STATE_DIR" "$PROJ"
    echo "$SID" >"$STATE_DIR/session-id"; echo '{}' >"$PROJ/$SID.jsonl"
    start_env GP_WATCH_SECONDS=1 timeout 90 "$START" --root \~/work --name inst >"$OUT" 2>&1 &
    REAL_START=$!
    if wait_file "$T/state/real.pid.1"; then
        real_tmux new-window -d -t "=inst:" sleep 300
        # An operator attaches with a forwarded agent (a made-up path): tmux
        # copies SSH_AUTH_SOCK into the session's environment.
        ATTACHED=0
        if t_tool script; then
            ( sleep 15 | start_env TERM=xterm SSH_AUTH_SOCK="$T/no-agent.sock" script -qefc "tmux -L inst attach -t =inst" /dev/null >/dev/null 2>&1 ) &
            i=0; while ! real_tmux show-environment -t =inst SSH_AUTH_SOCK 2>/dev/null | grep -q '^SSH_AUTH_SOCK=' && [ "$i" -lt 50 ]; do sleep 0.2; i=$((i + 1)); done
            if real_tmux show-environment -t =inst SSH_AUTH_SOCK 2>/dev/null | grep -q '^SSH_AUTH_SOCK='; then ATTACHED=1; fi
        fi
        touch "$T/state/real.exit.1"
        wait_file "$T/state/real.pid.2"
        sleep 0.5
        PANES="$(real_tmux list-panes -s -t =inst -F '#{pane_id} #{pane_pid} #{pane_current_command}' 2>/dev/null)"
        check "real tmux: claude came back after its window ended" [ -e "$T/state/real.pid.2" ]
        check "real tmux: the operator's window is still there" sh -c "printf '%s\n' '$PANES' | grep -q ' sleep\$'"
        check "real tmux: the new claude resumes the session, with the channel" \
            sh -c "grep -qx -- '$SID' '$T/state/real.args.2' && grep -qx -- 'plugin:$PLUGIN' '$T/state/real.args.2'"
        check "real tmux: pane-pid is the new claude's pid" [ "$(cat "$STATE_DIR/pane-pid" 2>/dev/null)" = "$(cat "$T/state/real.pid.2" 2>/dev/null)" ]
        check "real tmux: pane-id names the new claude's pane" \
            sh -c "printf '%s\n' '$PANES' | grep -q \"^\$(cat '$STATE_DIR/pane-id') \$(cat '$T/state/real.pid.2') \""
        check "real tmux: only two panes, the new claude's and the operator's" [ "$(printf '%s\n' "$PANES" | grep -c .)" = 2 ]
        if [ "$ATTACHED" = 1 ]; then
            check "real tmux, an operator attached with SSH_AUTH_SOCK: the new claude does not get it" [ "$(cat "$T/state/real.sock.2" 2>/dev/null)" = unset ]
            real_tmux detach-client -s =inst >/dev/null 2>&1
        else
            echo "SKIP  real tmux, an attached operator's SSH_AUTH_SOCK (no script, or the attach did not take)"
        fi
        real_tmux kill-server >/dev/null 2>&1
        touch "$T/state/real.exit.2"
    else
        bad "real tmux: the first claude never started"
    fi
    wait "$REAL_START"; RC=$?
    check "real tmux: the session ends, start exits 1" rc_is 1
    real_tmux kill-server >/dev/null 2>&1
    touch "$T/state/real.exit.1" "$T/state/real.exit.2" "$T/state/real.exit.3"
fi

finish_tests
