#!/bin/bash
# gp-entrypoint: run a GHOST Protocol agent inside the container.
#
#   agent    (default) set up the data volume, publish the agent's profile
#            (its name), wait for a Claude sign-in, then
#            hand over to install/service/start: one resumed conversation, the
#            persona, unattended mode with auto permissions, and the plugin's
#            session-id and turn-state hooks. start runs again if it ends.
#   version  print the image version.
#   claude … run claude directly (for checks such as: claude -p "say ok").
#   shell    a bash shell.
#   gp …     one of the image's commands (docker/gp/gp.mjs).
#   init …   set up the agent in the volume: gp init (docker/gp/init.mjs).
#   updater --target <container>   the update helper (docker/gp/updater.mjs),
#            in a container of its own with the Docker socket. It alone runs as
#            root; everything else drops to the user node first.
#
# The agent's settings live in the data volume (/data, see docker/gp/layout.mjs).
# A start with an env file still works: GP_RELAY_KEY, BUZZ_RELAY_URL,
# BUZZ_ALLOWED_PUBKEYS, BUZZ_AUTH_TAG, CLAUDE_CODE_OAUTH_TOKEN and GP_NAME seed
# the volume (docker/gp/setup.mjs).
set -euo pipefail

GP_ROOT=${GP_ROOT:-/opt/ghost-protocol}
VERSION=$(cat /etc/gp-image-version 2>/dev/null || echo unknown)
GPDIR=/data/.gp
NAME=agent
ROOT=/data/work
PLUGIN=ghost-protocol@ghost-protocol

log() { printf '%s gp-entrypoint[%s]: %s\n' "$(date -u +%FT%TZ)" "$VERSION" "$*"; }
state() { mkdir -p "$GPDIR" && printf '%s %s\n' "$1" "$(date -u +%FT%TZ)" >"$GPDIR/agent-state.tmp" && mv "$GPDIR/agent-state.tmp" "$GPDIR/agent-state"; }

if [ "$(id -u)" = 0 ] && [ "${1:-agent}" != updater ]; then
    exec setpriv --reuid=node --regid=node --init-groups -- "$0" "$@"
fi

case "${1:-agent}" in
    version) echo "ghost-protocol image $VERSION"; exit 0 ;;
    claude) shift; exec claude "$@" ;;
    shell) shift; exec bash "$@" ;;
    gp) shift; exec gp "$@" ;;
    init) shift; exec gp init "$@" ;;
    updater) shift; exec node /opt/gp/gp.mjs updater "$@" ;;
    agent) ;;
    *) exec "$@" ;;
esac

umask 077
log "starting (claude $(claude --version 2>/dev/null | head -1))"
state starting
r=$(node /opt/gp/setup.mjs) || true
if [ "$r" != ok ]; then
    state "error"
    log "setup: $r"
    # Slowly, so a container that restarts on exit does not spin.
    sleep 30
    exit 2
fi
unset GP_RELAY_KEY

# The agent's own Buzz profile, its name from init (docker/gp/profile.mjs):
# sent once the relay takes it, again only after a new name. It runs from
# here, before the Claude sign-in, so the name shows while that waits.
gp profile publish --retry 2>>"$GPDIR/profile.log" >/dev/null &
profile_pid=$!

# The plugin, from the image's own checkout (a directory marketplace). A new
# image tag brings a new checkout; the refresh picks it up.
if ! claude plugin marketplace list 2>/dev/null | grep -q ghost-protocol; then
    claude plugin marketplace add "$GP_ROOT" >/dev/null
fi
if claude plugin list 2>/dev/null | grep -q "$PLUGIN"; then
    claude plugin marketplace update ghost-protocol >/dev/null 2>&1 || true
    claude plugin update "$PLUGIN" >/dev/null 2>&1 || true
else
    claude plugin install "$PLUGIN" >/dev/null
fi

# A Claude sign-in: a setup token (gp claude token) or Claude Code's own
# sign-in (gp claude login). Until one is there the agent waits.
signed_in() {
    [ -s "$GPDIR/claude-token" ] && return 0
    [ -n "$(jq -r '.claudeAiOauth.accessToken // empty' /data/.claude/.credentials.json 2>/dev/null)" ]
}
if ! signed_in; then
    state needs-claude
    log "waiting for a Claude sign-in (gp claude login, or gp claude token)"
    until signed_in; do sleep 3; done
fi

# The release check and the agent's notes (docker/gp/watch.mjs): a newer
# version to ask the operator about, and the confirm after an update.
gp update watch 2>>"$GPDIR/update-watch.log" >/dev/null &
watch_pid=$!

stopping=0
pid=""
# shellcheck disable=SC2317,SC2329 # run by the trap
stop() {
    stopping=1
    log "stopping"
    [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null || true
    kill -TERM "$watch_pid" "$profile_pid" 2>/dev/null || true
    tmux -L "$NAME" kill-server 2>/dev/null || true
}
trap stop TERM INT

quick=0
while [ "$stopping" = 0 ]; do
    # Read at each start, so a new tag or sign-in reaches the next claude.
    unset CLAUDE_CODE_OAUTH_TOKEN BUZZ_AUTH_TAG
    if [ -s "$GPDIR/claude-token" ]; then CLAUDE_CODE_OAUTH_TOKEN=$(cat "$GPDIR/claude-token"); export CLAUDE_CODE_OAUTH_TOKEN; fi
    if [ -s "$GPDIR/auth-tag" ]; then BUZZ_AUTH_TAG=$(cat "$GPDIR/auth-tag"); export BUZZ_AUTH_TAG; fi
    state running
    began=$(date +%s)
    "$GP_ROOT/install/service/start" --root "$ROOT" --name "$NAME" &
    pid=$!
    rc=0
    wait "$pid" || rc=$?
    # A signal ends the first wait early; wait again for start itself.
    while kill -0 "$pid" 2>/dev/null; do wait "$pid" || rc=$?; done
    pid=""
    [ "$stopping" = 0 ] || break
    if [ $(($(date +%s) - began)) -lt 60 ]; then quick=$((quick + 1)); else quick=0; fi
    if [ "$quick" -ge 3 ]; then
        state error
        log "start ended quickly three times in a row (last exit $rc); giving up, so the container restarts"
        exit 1
    fi
    log "start ended (exit $rc); starting it again"
    state starting
    sleep 2
done
state stopped
exit 0
