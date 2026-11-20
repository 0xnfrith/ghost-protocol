#!/usr/bin/env bash
# keyservice-systemd.sh: the key service end to end on a real systemd, the
# one test that makes real socket-activated connections. The suites under
# install/test/ use stand-ins for systemd; this one installs the real units.
#
# FOR A THROWAWAY MACHINE ONLY. It makes two users, installs the key service
# for a test instance with a new key made on the machine, changes units, and
# takes all of it away again at the end (unless --keep). It never reads a
# key that is already there, never prints one, and needs no relay login: a
# probe never finishes the MCP handshake, so the channel never connects to
# the relay.
#
# Usage, as the machine's admin (the user with sudo), from a clone of GHOST
# Protocol that the agent user cannot change (umask 022), with node 22 or
# later on PATH and buzz-mcp built from the pin
# (adapters/buzz/scripts/build-buzz-mcp.sh):
#   install/test/live/keyservice-systemd.sh --throwaway [--keep] [--commit <id>]
#   install/test/live/keyservice-systemd.sh --throwaway --teardown
#
#   --throwaway   required: says this machine may be changed
#   --keep        leave the test instance installed at the end
#   --commit <id> the commit the key service runs (default: HEAD of this clone)
#   --teardown    only take away what an earlier run left
#
# The steps, each judged by its exit code; only exit codes, counts and names
# are printed:
#   1. The agent user gp-live-agent (its own group, no sudo), and settings
#      with an unreachable relay, one channel and one allowed sender.
#   2. The descriptors systemd hands a unit like the key's units
#      (Accept=yes, StandardInput=socket, OpenFile=): a throwaway unit pair
#      that opens /etc/hostname, never the key, reports LISTEN_FDS and
#      LISTEN_FDNAMES. A note, for the record of this systemd.
#   3. install/keyservice/setup --apply --key-generate for instance gplive:
#      exit 0. Its last check is one real connection to each socket.
#   4. No drop-in on any of the units (systemctl show DropInPaths).
#   5. As the agent user, one real connection to each socket again
#      (launch.mjs probe, from the installed copy): exit 0 each.
#   6. The units' journal holds no refusal from serve.
#   7. The setup again, unchanged: exit 0.
#  7b. The channel held by a session-like connection (a process of the agent
#      user's that keeps one open): the setup again exits 0 and says it is
#      held. Then a channel slowed down by an allowed drop-in (CPUQuota=), so
#      the probe times out while systemd still counts its connection: the
#      setup exits 1, and never calls that held.
#   8. Drop-ins that systemd applies, each checked first with systemctl
#      show: User=root on the channel's unit, plainly, then written the ways
#      a check that reads lines too simply misses (a header with a trailing
#      space or tab, CR LF line ends, a byte-order mark, a header after
#      another, a line ending in two backslashes, a lone CR, a NUL), and
#      ListenStream= on the channel's socket with CR LF. Each time the setup
#      again exits 1 and names it, and the listeners go off. Then a drop-in
#      with only a limit, written with a byte-order mark, CR LF and a
#      continued line: exit 0.
#   9. The drop-ins gone: the setup again exits 0, and the channel answers.
#  10. A stand-in for the instance's own unit (<name>.service, never
#      started): alone, the setup exits 0; with a drop-in whose continued
#      line goes on in a line starting with byte 2 and sets
#      BUZZ_PRIVATE_KEY= (checked with systemctl show), it exits 1.
#  11. The GitHub App slot, added to the running instance with a throwaway
#      RSA key made here (openssl, piped straight into the setup) and
#      --skip-github-check, so GitHub is never asked: exit 0, the GitHub
#      socket started and nothing else; the key file root's 0400, which the
#      agent user cannot read; the GitHub unit runs as the App key's own user
#      (gp-gh-<name>, never the key's user that runs buzz-mcp), which
#      reads neither key file itself; no drop-in on its units; as the agent user, the
#      socket answers with the key's fingerprint (proof that systemd hands the
#      key's descriptor over), and refuses, with no request to GitHub, a repo
#      off the allowlist and a short head id; a user outside the agent's group
#      cannot connect; the journal holds no refusal from serve and a ledger
#      line for each request; a second key is refused, and a swap on purpose
#      prints the old key's fingerprint.
#  12. Unless --keep: the units, files and users taken away, the key files
#      shredded first.
# Exit 0 when every step passed, 1 when one failed, 2 on bad usage.
set -uo pipefail

GP_DIR="$(CDPATH='' cd -- "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
SETUP="$GP_DIR/install/keyservice/setup"
NAME=gplive
AGENT=gp-live-agent
KEYUSER="gp-key-$NAME"
GHUSER="gp-gh-$NAME"
ETC="/etc/ghost-protocol/$NAME"
RUN="/run/ghost-protocol-key/$NAME"
UNITDIR=/etc/systemd/system
WORK=""

THROWAWAY=0 KEEP=0 TEARDOWN=0 COMMIT=""
usage() { echo "keyservice-systemd: $*" >&2; echo "usage: $0 --throwaway [--keep] [--commit <id>] | --throwaway --teardown" >&2; exit 2; }
while [ $# -gt 0 ]; do
    case "$1" in
        --throwaway) THROWAWAY=1; shift ;;
        --keep) KEEP=1; shift ;;
        --teardown) TEARDOWN=1; shift ;;
        --commit) [ $# -ge 2 ] || usage "--commit needs a value"; COMMIT="$2"; shift 2 ;;
        *) usage "unknown option: $1" ;;
    esac
done
[ "$THROWAWAY" = 1 ] || usage "this changes the machine (users, units, a key): run it only on a throwaway one, with --throwaway"
[ "$(id -u)" != 0 ] || usage "run it as the admin user, not as root (the setup refuses root)"
sudo -n true 2>/dev/null || usage "the admin user needs sudo without a prompt here"
if ! command -v systemctl >/dev/null || [ ! -d /run/systemd/system ]; then usage "systemd is not running here"; fi

PASSED=0 FAILED=0
pass() { PASSED=$((PASSED + 1)); printf 'ok    %s\n' "$*"; }
fail() { FAILED=$((FAILED + 1)); printf 'FAIL  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
# check <what> <expected exit> <command...>: runs it, output kept in $WORK/out.
check() {
    local what="$1" want="$2" rc; shift 2
    "$@" >"$WORK/out" 2>&1; rc=$?
    if [ "$rc" = "$want" ]; then pass "$what (exit $rc)"; else fail "$what (exit $rc, wanted $want)"; fi
    return 0
}
out_has() { grep -qE -- "$1" "$WORK/out"; }
# expect <what> <pattern>: passes when the last command's output matches.
expect() { if out_has "$2"; then pass "$1"; else fail "$1"; fi; }

listeners() { printf '%s ' "gp-key-$NAME-channel.socket" "gp-key-$NAME-buzz-mcp.socket" "gp-key-$NAME-outbox.path"; }

teardown() {
    local c keep
    step "teardown: the test instance $NAME and the user $AGENT"
    # shellcheck disable=SC2046  # three unit names
    sudo systemctl disable --now $(listeners) >/dev/null 2>&1
    sudo systemctl stop "gp-key-$NAME-channel@*.service" "gp-key-$NAME-buzz-mcp@*.service" "gp-key-$NAME-outbox.service" >/dev/null 2>&1
    sudo systemctl stop gp-live-fds.socket >/dev/null 2>&1
    sudo systemctl stop "gp-key-$NAME-github@*.service" >/dev/null 2>&1
    [ -e "$ETC/buzz-key" ] && sudo shred -u "$ETC/buzz-key"
    sudo test -e "$ETC/github-app.pem" && sudo shred -u "$ETC/github-app.pem"
    c="$(cat "$ETC/commit" 2>/dev/null)"
    sudo rm -rf "$ETC" "/srv/ghost-protocol/$NAME" "/var/lib/ghost-protocol-key/$NAME" "$RUN"
    sudo pkill -u "$AGENT" -f gp-live-hold >/dev/null 2>&1
    sudo rm -rf "$UNITDIR/gp-key-$NAME-"* "$UNITDIR"/gp-live-fds* /run/gp-live-extra.sock "$UNITDIR/$NAME.service" "$UNITDIR/$NAME.service.d"
    sudo systemctl daemon-reload
    # The copy in /opt, unless another instance runs it or rolls back to it.
    if [ -n "$c" ]; then
        keep="$(cat /etc/ghost-protocol/*/commit /etc/ghost-protocol/*/previous-commit 2>/dev/null)"
        case "$keep" in *"$c"*) ;; *) sudo rm -rf "/opt/ghost-protocol/$c" ;; esac
    fi
    for d in /etc/ghost-protocol /srv/ghost-protocol /opt/ghost-protocol; do sudo rmdir "$d" 2>/dev/null; done
    id "$KEYUSER" >/dev/null 2>&1 && sudo userdel "$KEYUSER"
    id "$GHUSER" >/dev/null 2>&1 && sudo userdel "$GHUSER"
    id "$AGENT" >/dev/null 2>&1 && sudo userdel -r "$AGENT" >/dev/null 2>&1
    getent group "$AGENT" >/dev/null && sudo groupdel "$AGENT"
    getent group "$KEYUSER" >/dev/null && sudo groupdel "$KEYUSER"
    getent group "$GHUSER" >/dev/null && sudo groupdel "$GHUSER"
    if id "$KEYUSER" >/dev/null 2>&1 || id "$GHUSER" >/dev/null 2>&1 || id "$AGENT" >/dev/null 2>&1 || [ -e "$ETC" ] || [ -e "$UNITDIR/$NAME.service" ] || ls "$UNITDIR/gp-key-$NAME-"* >/dev/null 2>&1; then
        echo "FAIL  something of the test instance is still there"; return 1
    fi
    echo "ok    nothing of the test instance is left"
}

if [ "$TEARDOWN" = 1 ]; then teardown; exit $?; fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
[ -n "$COMMIT" ] || COMMIT="$(git -C "$GP_DIR" rev-parse HEAD)"
echo "key service on a real systemd: $(systemctl --version | head -n 1), commit $COMMIT"
# What an earlier run left goes first.
if id "$KEYUSER" >/dev/null 2>&1 || id "$GHUSER" >/dev/null 2>&1 || id "$AGENT" >/dev/null 2>&1 || [ -e "$ETC" ]; then teardown >/dev/null; fi
SINCE="$(date '+%Y-%m-%d %H:%M:%S')"

step "1. the agent user and the settings"
if sudo useradd --create-home --user-group --shell /bin/bash "$AGENT"; then pass "made $AGENT"; else fail "could not make $AGENT"; fi
SETTINGS="$WORK/settings.env"
cat >"$SETTINGS" <<EOF
# The live test's settings: a relay that is never reached.
BUZZ_RELAY_URL=wss://relay.invalid
BUZZ_CHANNELS=0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b
BUZZ_ALLOWED_PUBKEYS=$(printf '%064d' 0 | tr 0 b)
EOF

step "2. the descriptors this systemd hands a unit like the key's (no key: /etc/hostname)"
sudo tee "$UNITDIR/gp-live-fds.socket" >/dev/null <<EOF
[Socket]
ListenStream=/run/gp-live-fds.sock
Accept=yes
EOF
sudo tee "$UNITDIR/gp-live-fds@.service" >/dev/null <<'EOF'
[Service]
ExecStart=/bin/sh -c 'if [ -S /dev/stdin ]; then s=socket; else s=other; fi; echo "LISTEN_FDS=$LISTEN_FDS LISTEN_FDNAMES=$LISTEN_FDNAMES stdin=$s"'
StandardInput=socket
StandardOutput=socket
OpenFile=/etc/hostname:buzz-key:read-only
EOF
sudo systemctl daemon-reload && sudo systemctl start gp-live-fds.socket
fds="$(python3 -I -c 'import socket
s = socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect("/run/gp-live-fds.sock")
print(s.recv(200).decode().strip())' 2>&1)"
echo "note  $fds"
sudo systemctl stop gp-live-fds.socket; sudo rm -f "$UNITDIR"/gp-live-fds*; sudo systemctl daemon-reload

step "3. the setup, --apply --key-generate (a new key made here)"
check "setup --apply" 0 "$SETUP" --name "$NAME" --agent-user "$AGENT" --settings "$SETTINGS" --key-generate --commit "$COMMIT" --apply --yes
grep -E '^ *(OK|DONE|FAIL|SKIP|WARN)|answered|did not answer|held by' "$WORK/out" | sed 's/^/      /'
expect "the setup's probe: the channel answered" 'channel\.sock answered \(server buzz-channel\)'
expect "the setup's probe: buzz-mcp answered" 'buzz-mcp\.sock answered'
cp "$WORK/out" "$WORK/install.out"

step "4. no drop-in on any unit"
I=verify   # a template is shown by an instance's name
for u in "gp-key-$NAME-channel.socket" "gp-key-$NAME-channel@$I.service" "gp-key-$NAME-buzz-mcp.socket" \
         "gp-key-$NAME-buzz-mcp@$I.service" "gp-key-$NAME-outbox.path" "gp-key-$NAME-outbox.service"; do
    d="$(systemctl show -p DropInPaths --value "$u")"
    if [ -z "$d" ]; then pass "$u: no drop-in"; else fail "$u: drop-ins $d"; fi
done

step "5. as $AGENT, one real connection to each socket"
NODE="$(sed -n 's/^ExecStart=\([^ ]*\) .*/\1/p' "$UNITDIR/gp-key-$NAME-channel@.service")"
for t in channel buzz-mcp; do
    check "$t.sock answers $AGENT" 0 sudo runuser -u "$AGENT" -- env -i PATH=/usr/bin:/bin BUZZ_KEY_SOCKET="$RUN" \
        "$NODE" --disable-sigusr1 "/opt/ghost-protocol/$COMMIT/adapters/buzz/src/launch.mjs" probe "$t"
    sed 's/^/      /' "$WORK/out"
done
check "a user outside the agent's group cannot connect" 1 sudo runuser -u nobody -- env -i PATH=/usr/bin:/bin BUZZ_KEY_SOCKET="$RUN" \
    "$NODE" --disable-sigusr1 "/opt/ghost-protocol/$COMMIT/adapters/buzz/src/launch.mjs" probe buzz-mcp
expect "  refused (EACCES)" 'EACCES'

step "6. the units' journal: no refusal from serve"
n="$(sudo journalctl --no-pager -q --since "$SINCE" -u "gp-key-$NAME-channel@*" -u "gp-key-$NAME-buzz-mcp@*" | grep -c 'launch: serve:')"
if [ "$n" = 0 ]; then pass "no 'serve:' refusal in the journal"; else fail "$n 'serve:' refusal line(s) in the journal"; fi

step "7. the setup again, unchanged"
check "setup --apply, nothing changed" 0 "$SETUP" --name "$NAME" --agent-user "$AGENT" --commit "$COMMIT" --apply --yes
expect "  verify passed" 'OK +verify'
expect "  the sockets answered" 'OK +answers'

step "7b. the channel held by a session, and a channel that hangs"
running() { systemctl list-units --plain --no-legend --state=running "gp-key-$NAME-channel@*.service" 2>/dev/null | grep -c .; }
until_n() {   # <count>: waits up to 15 s until that many channel instances run
    local _
    for _ in $(seq 1 30); do [ "$(running)" = "$1" ] && return 0; sleep 0.5; done
    return 1
}
# A connection kept open by a process of the agent user's, as a session's is.
sudo runuser -u "$AGENT" -- python3 -I -c 'import socket, sys, time
s = socket.socket(socket.AF_UNIX); s.connect(sys.argv[1]); time.sleep(120)' "$RUN/channel.sock" gp-live-hold &
HOLD=$!
if until_n 1; then pass "a session-like connection holds the channel (one running instance)"; else fail "no channel instance runs for the held connection"; fi
check "setup --apply, the channel held" 0 "$SETUP" --name "$NAME" --agent-user "$AGENT" --commit "$COMMIT" --apply --yes
expect "  says it is held, and does not probe it" "channel\\.sock is held by the session's connection"
expect "  buzz-mcp answered" 'buzz-mcp\.sock answered'
sudo pkill -u "$AGENT" -f gp-live-hold; wait "$HOLD" 2>/dev/null
if until_n 0; then pass "  the held connection gone, its instance stopped"; else fail "  its instance still runs"; fi
# A channel that hangs: an allowed drop-in leaves it 5 ms of CPU a second,
# so it cannot answer within the probe's 30 s, and systemd counts the
# probe's connection while the instance runs.
DIN="$UNITDIR/gp-key-$NAME-channel@.service.d"
sudo mkdir -p "$DIN"
printf '[Service]\nCPUQuota=0.5%%\nCPUQuotaPeriodSec=1s\n' | sudo tee "$DIN/50-live-slow.conf" >/dev/null
sudo systemctl daemon-reload
q="$(systemctl show -p CPUQuotaPerSecUSec --value "gp-key-$NAME-channel@$I.service")"
if [ "$q" = 5ms ]; then pass "a slow channel: systemd applies CPUQuota=0.5% ($q a second)"; else fail "a slow channel: systemd shows CPUQuotaPerSecUSec=$q"; fi
check "setup --apply, a channel that hangs" 1 "$SETUP" --name "$NAME" --agent-user "$AGENT" --commit "$COMMIT" --apply --yes
expect "  the probe timed out" 'channel\.sock did not answer: it sent no answer within'
expect "  FAIL answers, on the channel" 'FAIL +answers +no answer on channel '
if out_has 'is held now by'; then fail "  called held"; else pass "  never called held"; fi
echo "note  after it: NConnections=$(systemctl show -p NConnections --value "gp-key-$NAME-channel.socket"), running channel instances=$(running)"
sudo rm -rf "$DIN"; sudo systemctl daemon-reload
sudo systemctl stop "gp-key-$NAME-channel@*.service"
check "setup --apply, the slow drop-in gone" 0 "$SETUP" --name "$NAME" --agent-user "$AGENT" --commit "$COMMIT" --apply --yes
expect "  the channel answers again" 'channel\.sock answered \(server buzz-channel\)'

step "8. drop-ins systemd applies, however they are written"
DIN="$UNITDIR/gp-key-$NAME-channel@.service.d"
SIN="$UNITDIR/gp-key-$NAME-channel.socket.d"
user_now() { systemctl show -p User --value "gp-key-$NAME-channel@$I.service"; }
listen_now() { systemctl show -p Listen --value "gp-key-$NAME-channel.socket"; }
# live_dropin <what> <folder> <text, a printf format> <sure|maybe>: writes it,
# daemon-reloads, asks systemd whether it applies it (sure: it must; maybe: a
# note), then runs the setup, which must exit 1 and name it.
live_dropin() {
    local what="$1" dir="$2" text="$3" sure="$4" f applied
    f="$dir/50-live-test.conf"
    sudo rm -rf "$DIN" "$SIN"; sudo mkdir -p "$dir"
    # shellcheck disable=SC2059  # the text is the format
    printf "$text" | sudo tee "$f" >/dev/null
    sudo systemctl daemon-reload
    case "$dir" in
        "$SIN") case "$(listen_now)" in *gp-live-extra.sock*) applied=1 ;; *) applied=0 ;; esac ;;
        *) [ "$(user_now)" = root ] && applied=1 || applied=0 ;;
    esac
    if [ "$applied" = 1 ]; then pass "$what: systemd applies it"
    elif [ "$sure" = sure ]; then fail "$what: systemd does not apply it"
    else echo "note  $what: this systemd does not apply it"; fi
    if [ "$what" = "CR LF" ]; then
        echo "note  systemctl cat prints $(sudo systemctl cat "gp-key-$NAME-channel@$I.service" | tr -cd '\r' | wc -c) CR(s) of this drop-in's 2"
    fi
    check "$what: setup --apply" 1 "$SETUP" --name "$NAME" --agent-user "$AGENT" --commit "$COMMIT" --apply --yes
    case "$dir" in
        "$SIN") expect "  names it: ListenStream= in [Socket]" "the drop-in $SIN/50-live-test\\.conf sets ListenStream= in \\[Socket\\]" ;;
        *) expect "  names it: User= in [Service], or a line it cannot read" "the drop-in $DIN/50-live-test\\.conf (sets User= in \\[Service\\]|of .* holds a control character)" ;;
    esac
    expect "  verify failed" 'FAIL +verify'
    if systemctl is-active --quiet "gp-key-$NAME-channel.socket"; then fail "  the channel's listener is still on"; else pass "  the listeners are off"; fi
}
live_dropin "plain" "$DIN" '[Service]\nUser=root\n' sure
live_dropin "a header with a trailing space" "$DIN" '[Service] \nUser=root\n' sure
live_dropin "a header with a trailing tab" "$DIN" '[Service]\t\nUser=root\n' sure
live_dropin "CR LF" "$DIN" '[Service]\r\nUser=root\r\n' sure
live_dropin "a byte-order mark" "$DIN" '\357\273\277[Service]\nUser=root\n' sure
live_dropin "a header after [Unit], with trailing spaces" "$DIN" '[Unit]\nDescription=x\n[Service]  \nUser=root\n' sure
live_dropin "a line ending in two backslashes, then a header" "$DIN" '[Install]\nWantedBy=x\\\\\n[Service]\nUser=root\n' sure
live_dropin "a lone CR" "$DIN" '[Service]\rUser=root\r' maybe
live_dropin "a NUL" "$DIN" '[Install]\000[Service]\000User=root\n' maybe
live_dropin "ListenStream= with CR LF" "$SIN" '[Socket]\r\nListenStream=/run/gp-live-extra.sock\r\n' sure
sudo rm -rf "$DIN" "$SIN"; sudo mkdir -p "$DIN"
printf '\357\273\277[Unit]\r\nDescription=a \\\r\n  long name\r\n[Service]\t\r\nNice=5\r\n' | sudo tee "$DIN/50-live-test.conf" >/dev/null
sudo systemctl daemon-reload
if [ "$(systemctl show -p Nice --value "gp-key-$NAME-channel@$I.service")" = 5 ]; then pass "a limit, with a byte-order mark and CR LF: systemd applies it"; else fail "a limit, with a byte-order mark and CR LF: systemd does not apply it"; fi
check "a limit, with a byte-order mark and CR LF: setup --apply" 0 "$SETUP" --name "$NAME" --agent-user "$AGENT" --commit "$COMMIT" --apply --yes
expect "  verify passed" 'OK +verify'

step "9. the drop-ins gone"
sudo rm -rf "$DIN" "$SIN"
sudo systemctl daemon-reload
check "setup --apply without it" 0 "$SETUP" --name "$NAME" --agent-user "$AGENT" --commit "$COMMIT" --apply --yes
expect "  the channel answers again" 'channel\.sock answered \(server buzz-channel\)'

step "10. the instance's own unit (a stand-in, never started)"
sudo tee "$UNITDIR/$NAME.service" >/dev/null <<EOF
[Unit]
Description=live test stand-in for instance $NAME (never started)
[Service]
User=$AGENT
ExecStart=/bin/true
EOF
sudo systemctl daemon-reload
check "the stand-in alone: setup --apply" 0 "$SETUP" --name "$NAME" --agent-user "$AGENT" --commit "$COMMIT" --apply --yes
sudo mkdir -p "$UNITDIR/$NAME.service.d"
printf '[Service]\nEnvironment=\\\n\002 BUZZ_PRIVATE_KEY=x\n' | sudo tee "$UNITDIR/$NAME.service.d/50-live-test.conf" >/dev/null
sudo systemctl daemon-reload
case " $(systemctl show -p Environment --value "$NAME.service") " in
    *" BUZZ_PRIVATE_KEY=x "*) pass "a continued line on a line starting with byte 2: systemd sets BUZZ_PRIVATE_KEY" ;;
    *) echo "note  a continued line on a line starting with byte 2: this systemd does not set BUZZ_PRIVATE_KEY" ;;
esac
check "with that drop-in: setup --apply" 1 "$SETUP" --name "$NAME" --agent-user "$AGENT" --commit "$COMMIT" --apply --yes
expect "  says it cannot read that line" "$NAME\\.service or one of its drop-ins holds a line with a control character"
sudo rm -rf "$UNITDIR/$NAME.service" "$UNITDIR/$NAME.service.d"; sudo systemctl daemon-reload

# The limits that need a pull request's facts (HOLD, draft, own pull request or
# commit, public text) are proved against a stand-in for GitHub by
# adapters/buzz/test/github-review.test.mjs: under systemd the stand-in's switch is refused
# by design, so they cannot be pointed at one here. The real proof of those is a run
# against the real App on a throwaway pull request.
step "11. the GitHub App slot (a throwaway key made here; GitHub is never asked)"
GHS="$WORK/github.env"
printf 'GITHUB_APP_CLIENT_ID=Iv23liLiveTest0001\nGITHUB_REVIEW_REPOS=1:example-org/review-target\nGITHUB_REVIEW_OWN_LOGINS=live-test-bot[bot]\nGITHUB_REVIEW_OWN_EMAILS=1+live-test-bot[bot]@users.noreply.github.com\n' >"$GHS"
RULES="$WORK/public-text.json"
printf '[{"name":"live-test-rule","pattern":"internal\\\\.example\\\\.test"}]\n' >"$RULES"
CODE="/opt/ghost-protocol/$COMMIT/adapters/buzz/src/github-review.mjs"
newkey() { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null; }
gh_setup() { newkey | "$SETUP" --name "$NAME" --agent-user "$AGENT" --commit "$COMMIT" --github-settings "$GHS" --github-public-text "$RULES" --skip-github-check --apply --yes "$@"; }
# as_agent <args>: the session's client, from the root-owned copy, as the agent user.
as_agent() { sudo runuser -u "$AGENT" -- env -i PATH=/usr/bin:/bin "$NODE" --disable-sigusr1 "$CODE" --socket "$RUN" "$@"; }
if ! command -v openssl >/dev/null; then fail "openssl is missing: no throwaway App key can be made"; else
    check "setup --apply, the slot added with a new key on stdin" 0 gh_setup --github-app-key-from-stdin
    grep -E '^ *(OK|DONE|FAIL|SKIP|WARN)|github.sock|fingerprint' "$WORK/out" | sed 's/^/      /'
    expect "  only the GitHub socket started" 'DONE +restart +the GitHub socket started again .*the session runs on'
    expect "  the socket answered with the key's fingerprint" 'OK +github +the GitHub socket answered as .* with the key.s fingerprint'
    expect "  GitHub not asked" 'SKIP +github +GitHub was not asked'
    FP="$(sed -n "s/.*the GitHub App key's fingerprint: \(SHA256:[A-Za-z0-9+\/]*=\).*/\1/p" "$WORK/out" | head -n 1)"
    if [ "$(sudo stat -c '%a %U' "$ETC/github-app.pem")" = "400 root" ]; then pass "  the key file: 0400, root's"; else fail "  the key file: $(sudo stat -c '%a %U' "$ETC/github-app.pem")"; fi
    check "  the agent user cannot read the key file" 1 sudo runuser -u "$AGENT" -- test -r "$ETC/github-app.pem"
    if [ "$(sudo stat -c '%a %U' "$ETC/public-text.json")" = "644 root" ]; then pass "  the public-text rules: 0644, root's"; else fail "  the public-text rules: $(sudo stat -c '%a %U' "$ETC/public-text.json")"; fi
    check "  the agent user cannot write the public-text rules" 1 sudo runuser -u "$AGENT" -- test -w "$ETC/public-text.json"
    check "  the agent user cannot write github.conf" 1 sudo runuser -u "$AGENT" -- test -w "$ETC/github.conf"
    u="$(systemctl show -p User --value "gp-key-$NAME-github@$I.service")"
    if [ "$u" = "$GHUSER" ]; then pass "  the GitHub unit runs as $GHUSER, not as $KEYUSER"; else fail "  the GitHub unit runs as ${u:-root}"; fi
    if [ "$(systemctl show -p User --value "gp-key-$NAME-buzz-mcp@$I.service")" = "$KEYUSER" ]; then pass "  buzz-mcp runs as $KEYUSER"; else fail "  buzz-mcp does not run as $KEYUSER"; fi
    check "  $GHUSER cannot read the App key file itself" 1 sudo runuser -u "$GHUSER" -- test -r "$ETC/github-app.pem"
    check "  $GHUSER cannot read the relay key file" 1 sudo runuser -u "$GHUSER" -- test -r "$ETC/buzz-key"
    check "  $KEYUSER cannot read the App key file" 1 sudo runuser -u "$KEYUSER" -- test -r "$ETC/github-app.pem"
    for u in "gp-key-$NAME-github.socket" "gp-key-$NAME-github@$I.service"; do
        d="$(systemctl show -p DropInPaths --value "$u")"
        if [ -z "$d" ]; then pass "  $u: no drop-in"; else fail "  $u: drop-ins $d"; fi
    done
    check "as $AGENT: the key's fingerprint" 0 as_agent fingerprint
    if [ -n "$FP" ] && grep -qx "fingerprint $FP" "$WORK/out"; then pass "  the one the setup printed"; else fail "  not the one the setup printed"; fi
    check "as $AGENT: a repo off the allowlist" 1 as_agent review example-org/not-listed 1 "$(printf '%040d' 0)" APPROVE
    expect "  refused in one line, naming the check, before the key or GitHub" 'refused: repo: example-org/not-listed is not on this key service.s list'
    # A limit that needs no GitHub fact is refused over the real socket too: COMMENT is not allowed unless the settings say so.
    check "as $AGENT: COMMENT, which the settings do not allow" 1 as_agent review example-org/review-target 1 "$(printf '%040d' 0)" COMMENT "a note"
    expect "  refused in one line, naming the check, before the key or GitHub" 'refused: event: COMMENT is not allowed here: post APPROVE or REQUEST_CHANGES'
    check "as $AGENT: a short head id" 1 as_agent review example-org/review-target 1 abc1234 APPROVE
    expect "  refused" 'head_sha must be'
    check "a user outside the agent's group cannot connect" 1 sudo runuser -u nobody -- env -i PATH=/usr/bin:/bin "$NODE" --disable-sigusr1 "$CODE" --socket "$RUN" fingerprint
    expect "  refused (EACCES)" 'EACCES'
    j="$(sudo journalctl --no-pager -q --since "$SINCE" -u "gp-key-$NAME-github@*")"
    if printf '%s\n' "$j" | grep -q 'github-review: serve:'; then fail "  a 'serve:' refusal in the GitHub unit's journal"; else pass "  no 'serve:' refusal in the GitHub unit's journal"; fi
    if printf '%s\n' "$j" | grep -q 'github-review: ledger {"action":"review","repo":"example-org/not-listed"'; then pass "  a ledger line for the refused review"; else fail "  no ledger line for the refused review"; fi
    check "setup --apply again, unchanged" 0 "$SETUP" --name "$NAME" --agent-user "$AGENT" --commit "$COMMIT" --skip-github-check --apply --yes
    check "a second key, not on purpose" 1 gh_setup --github-app-key-from-stdin
    expect "  says how to swap it" 'add --replace-github-app-key'
    check "a swap on purpose" 0 gh_setup --github-app-key-from-stdin --replace-github-app-key
    expect "  says to delete the old key on GitHub" "delete it on GitHub now .*fingerprint $FP"
fi

if [ "$KEEP" = 1 ]; then
    echo; echo "kept: instance $NAME (take it away with: $0 --throwaway --teardown)"
else
    teardown || FAILED=$((FAILED + 1))
fi
echo
echo "$PASSED passed, $FAILED failed"
[ "$FAILED" = 0 ]
