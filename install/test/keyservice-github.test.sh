#!/usr/bin/env bash
# keyservice-github.test.sh: the key service's GitHub App slot
# (install/keyservice/setup with --github-app-key-from-stdin and
# --github-settings; install/lib/keyservice.sh, "The GitHub App slot"; the
# units install/service/key-github.*). The action itself is
# adapters/buzz/test/github-review.test.mjs's.
#   - Usage: one key on stdin per run, never from a terminal, not with
#     --update or --rollback; --replace-github-app-key only with a new key.
#   - A dry run prints github.conf and the two GitHub units in full, the key
#     never, and changes nothing.
#   - An install makes the GitHub App key's own user (gp-gh-<name>: a
#     system user with no home and no shell, never the key's user, which runs
#     buzz-mcp), writes the key 0400 from stdin (never printed: its
#     fingerprint is), github.conf 0644, the two units (that user, the key by
#     OpenFile=, the sandbox, no buzz-key), asks as the agent user, the key's
#     user and that user whether any reads either key, and then asks the GitHub
#     socket, as the agent user, for the key's fingerprint and GitHub for the
#     App (--skip-github-check leaves the second out, with a SKIP line).
#   - Adding the slot to an instance that runs starts only the GitHub socket:
#     the session is not restarted. A key is never replaced but on purpose
#     (--replace-github-app-key), which prints both fingerprints.
#   - The checks refuse before anything changes: bad settings, a key given
#     when one is there, none to replace, none at all, a commit with no
#     GitHub review code (a rollback past the slot's start), and an instance
#     unit that has systemd read the App key.
#   - An update moves the GitHub units with the others, and ends their
#     connections too.
# The setup runs from $GPF, a copy of this repo with commits of its own.
# Users, sudo, systemctl, runuser and node are stand-ins: nothing here runs as
# root, touches the machine or reaches GitHub.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

t_new
if ! t_tool python3; then
    echo "SKIP  every case (no python3 on this machine; the setup's copy step needs it)"
    finish_tests
    exit $?
fi

GPF="$(mktemp -d "${TMPDIR:-/tmp}/gp-ksgh-repo.XXXXXX")"
GPF="$(cd "$GPF" && pwd -P)"
SANDBOXES="$SANDBOXES $GPF"
(cd "$SRC" && git ls-files -co --exclude-standard -z | xargs -0 tar cf -) | (cd "$GPF" && tar xf -)
git -C "$GPF" init -q && git -C "$GPF" add -A && git -C "$GPF" commit -q -m one
C1="$(git -C "$GPF" rev-parse HEAD)"
PIN="$(sed -n 's/^commit=//p' "$GPF/adapters/buzz/buzz-mcp.pin")"
next_commit() {   # a new commit on $GPF; prints its id
    echo "$1" >>"$GPF/VOCABULARY.md"
    git -C "$GPF" commit -q -am "$1"
    git -C "$GPF" rev-parse HEAD
}
SETUP="$GPF/install/keyservice/setup"
# Throwaway stand-ins for the two keys, made for this run (the node stand-in
# writes what it is given, and fingerprints it).
STANDIN="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
GHKEY="app-key-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
GHKEY2="app-key-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
ME="$(id -un)"
CLIENT=Iv23liExample0042
# The test App's bot, as the node stand-in's app answer names it (review-bot).
OWN_LOGIN='review-bot[bot]'
OWN_EMAIL='31337+review-bot[bot]@users.noreply.github.com'
# The builders' shared noreply author: never to be written down as the reviewer's own.
BUILDER_EMAIL='4100+example-builder'"@users.noreply.github.com"

# A machine where a key service can be installed (as keyservice.test.sh's).
setup() {
    t_new
    t_stub sudo; t_stub systemctl; t_stub node; t_stub npm; t_stub getent; t_stub id
    t_stub useradd; t_stub runuser; t_stub chown
    t_tool install; t_tool python3; t_tool flock
    touch "$T/state/sudo.allow"
    cat >"$T/state/passwd" <<EOF
root:x:0:0:root:/root:/bin/bash
$ME:x:$(id -u):$(id -g)::$T/home:/bin/bash
agent:x:4242:4242::$T/agent-home:/bin/bash
EOF
    cat >"$T/state/group" <<EOF
root:x:0:
sudo:x:27:$ME
systemd-journal:x:101:agent
agent:x:4242:
EOF
    mkdir -p "$T/procsys/fs" "$T/etc/systemd/system" "$T/agent-home"
    echo 1 >"$T/procsys/fs/protected_symlinks"; echo 1 >"$T/procsys/fs/protected_hardlinks"
    B="$T/home/.cache/ghost-protocol/buzz"
    mkdir -p "$B"
    printf 'stand-in buzz-mcp build\n' >"$B/buzz-mcp.mjs"; printf '%s\n' "$PIN" >"$B/buzz-mcp.commit"
    SETTINGS="$T/settings.env"
    cat >"$SETTINGS" <<EOF
BUZZ_RELAY_URL=https://relay.example.com
BUZZ_CHANNELS=0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b
BUZZ_ALLOWED_PUBKEYS=$(printf '%064d' 0 | tr 0 b)
EOF
    GHS="$T/github.env"
    cat >"$GHS" <<EOF
# The test App.
GITHUB_APP_CLIENT_ID=$CLIENT
GITHUB_REVIEW_REPOS=4242:example-org/review-target,77:Example-Org/Other.Repo
GITHUB_REVIEW_OWN_LOGINS=$OWN_LOGIN
GITHUB_REVIEW_OWN_EMAILS=$OWN_EMAIL
EOF
    RULES="$T/public-text.json"
    printf '[{"name":"example-host","pattern":"internal\\\\.example\\\\.test"}]\n' >"$RULES"
    ETC_GP="$T/etc/ghost-protocol/inst"; OPT="$T/opt/ghost-protocol"
    UNITS="$T/etc/systemd/system"
}
XENV=()
ks() {   # setup options...
    t_env GP_ETC="$T/etc" GP_OPT="$T/opt" GP_SRV="$T/srv" GP_RUN="$T/run" GP_VARLIB="$T/varlib" GP_PROC_SYS="$T/procsys" \
        ${XENV[@]+"${XENV[@]}"} "$SETUP" --name inst --agent-user agent --yes "$@" >"$OUT" 2>&1
    RC=$?
}
# The relay key on stdin (the first install, no slot).
install_ks() { printf '%s\n' "$STANDIN" >"$T/key-in"; ks --settings "$SETTINGS" --key-from-stdin --apply "$@" <"$T/key-in"; }
# The App key on stdin: $1 the key text, then setup options.
gh_ks() { printf '%s\n' "$1" >"$T/ghkey-in"; shift; ks --github-app-key-from-stdin "$@" <"$T/ghkey-in"; }
# The first install with both: a relay key made here, the App key from stdin.
install_both() { gh_ks "$GHKEY" --settings "$SETTINGS" --key-generate --github-settings "$GHS" --github-public-text "$RULES" --apply; }
mode_of() { stat -c '%a' "$1"; }
fp_of() { printf 'SHA256:%s=' "$(sha256sum <"$1" | cut -c1-43)"; }
units_n() { find "$UNITS" -maxdepth 1 -name 'gp-key-inst-*' ! -name '*.d' | grep -c .; }
unit_loaded() { touch "$T/state/unit-inst.service.loaded"; echo agent >"$T/state/unit-inst.service.user"; }
nothing_written() { [ ! -e "$T/opt" ] && [ ! -e "$T/etc/ghost-protocol" ] && [ -z "$(ls -A "$UNITS")" ]; }
gh_untouched() {   # nothing of the slot written on an installed instance
    [ ! -e "$ETC_GP/github-app.pem" ] && [ ! -e "$ETC_GP/github.conf" ] && [ ! -e "$UNITS/gp-key-inst-github.socket" ]
}

# 1. Usage.
setup
printf '%s\n' "$STANDIN" >"$T/key-in"
t_env "$SETUP" --name inst --agent-user agent --key-from-stdin --github-app-key-from-stdin <"$T/key-in" >"$OUT" 2>&1; RC=$?
check "usage: two keys on stdin (exit 2)" rc_is 2
check "usage: two keys on stdin: says one per run" out_has 'one key on stdin per run'
t_env "$SETUP" --name inst --agent-user agent --update --github-app-key-from-stdin <"$T/key-in" >"$OUT" 2>&1; RC=$?
check "usage: the App key with --update (exit 2)" rc_is 2
t_env "$SETUP" --name inst --agent-user agent --rollback --github-app-key-from-stdin <"$T/key-in" >"$OUT" 2>&1; RC=$?
check "usage: the App key with --rollback (exit 2)" rc_is 2
t_env "$SETUP" --name inst --agent-user agent --replace-github-app-key >"$OUT" 2>&1; RC=$?
check "usage: --replace-github-app-key with no new key (exit 2)" rc_is 2
t_env "$SETUP" --name inst --agent-user agent --github-settings relative.env >"$OUT" 2>&1; RC=$?
check "usage: --github-settings takes an absolute path (exit 2)" rc_is 2
t_env python3 -I -c 'import os, subprocess, sys
m, s = os.openpty()
sys.exit(subprocess.run(sys.argv[1:], stdin=s, timeout=120).returncode)' \
    "$SETUP" --name inst --agent-user agent --github-settings "$GHS" --github-public-text "$RULES" --github-app-key-from-stdin >"$OUT" 2>&1; RC=$?
check "usage: the App key from a terminal (exit 2)" rc_is 2
check "usage: the App key from a terminal: says why" out_has 'never from a terminal'
t_env "$SETUP" --help >"$OUT" 2>&1; RC=$?
check "--help lists the slot's options" sh -c "grep -q -- '--github-app-key-from-stdin' '$OUT' && grep -q -- '--replace-github-app-key' '$OUT' && grep -q -- '--github-settings <file>' '$OUT' && grep -q -- '--github-public-text <file>' '$OUT' && grep -q -- '--skip-github-check' '$OUT'"

# 2. A dry run with the slot: READY, github.conf and the ten units in full,
#    the key never, nothing written.
setup
gh_ks "$GHKEY" --settings "$SETTINGS" --key-generate --github-settings "$GHS" --github-public-text "$RULES"
check "dry run: exit 0" rc_is 0
check "dry run: READY" out_has '^READY$'
check "dry run: ten units in full" sh -c "[ \"\$(grep -c 'would write .*/gp-key-inst-' '$OUT')\" = 10 ]"
check "dry run: the GitHub socket and unit among them" sh -c "grep -q 'would write .*/gp-key-inst-github.socket' '$OUT' && grep -q 'would write .*/gp-key-inst-github@.service' '$OUT'"
check "dry run: github.conf in full" sh -c "grep -q '| GITHUB_APP_CLIENT_ID=$CLIENT' '$OUT' && grep -q '| GITHUB_REVIEW_REPOS=4242:example-org/review-target,77:Example-Org/Other.Repo' '$OUT'"
check "dry run: github.conf holds the reviewer's own identities, COMMENT off, and where the rules are" sh -c "grep -qF '| GITHUB_REVIEW_OWN_LOGINS=$OWN_LOGIN' '$OUT' && grep -qF '| GITHUB_REVIEW_OWN_EMAILS=$OWN_EMAIL' '$OUT' && grep -q '| GITHUB_REVIEW_ALLOW_COMMENT=0' '$OUT' && grep -q '| GITHUB_REVIEW_PUBLIC_TEXT_FILE=.*/etc/ghost-protocol/inst/public-text.json' '$OUT'"
check "dry run: says the rules would be checked by the root-owned copy's code, and does not print them" sh -c "grep -q 'public-text.json 0644 root: from .*public-text.json, checked by the root-owned copy' '$OUT' && ! grep -q 'internal' '$OUT'"
check "dry run: the key from stdin, never printed" sh -c "grep -q 'github-app.pem 0400 root: the GitHub App key, read from stdin' '$OUT' && ! grep -q '$GHKEY' '$OUT'"
check "dry run: says it would ask the GitHub socket and GitHub" out_has 'ask the GitHub socket, as agent, for the key.s fingerprint, then GitHub for the App'
check "dry run: nothing written" nothing_written
check "dry run: no key file asked for" sh -c "! grep -q '^node ghkey' '$T/state/calls'"
check "dry run: the GitHub App key's own user would be made" out_has 'would run: useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin --comment .*GitHub.*App.*key.* gp-gh-inst$'
check "dry run: no user made" not_called useradd

# 3. The first install with the slot.
setup
install_both
check "install: exit 0" rc_is 0
check "install: the App key file, 0400" [ "$(mode_of "$ETC_GP/github-app.pem")" = 400 ]
check "install: it holds the key from stdin" sh -c "[ \"\$(cat '$ETC_GP/github-app.pem')\" = '$GHKEY' ]"
check "install: written by the root-owned copy's code, as root" grep -qx 'node ghkey write' "$T/state/calls"
check "install: the key is never printed" out_lacks "$GHKEY"
check "install: its fingerprint is" out_has "the GitHub App key's fingerprint: $(fp_of "$ETC_GP/github-app.pem")"
check "install: the App key is never given to another user" sh -c "! grep -q 'chown .*github-app.pem' '$T/state/calls'"
check "install: github.conf, 0644, the settings and nothing else" sh -c "[ \"\$(stat -c %a '$ETC_GP/github.conf')\" = 644 ] && [ \"\$(grep -v '^#' '$ETC_GP/github.conf')\" = \"\$(printf 'GITHUB_APP_CLIENT_ID=$CLIENT\nGITHUB_REVIEW_REPOS=4242:example-org/review-target,77:Example-Org/Other.Repo\nGITHUB_REVIEW_OWN_LOGINS=$OWN_LOGIN\nGITHUB_REVIEW_OWN_EMAILS=$OWN_EMAIL\nGITHUB_REVIEW_ALLOW_COMMENT=0\nGITHUB_REVIEW_PUBLIC_TEXT_FILE=$ETC_GP/public-text.json')\" ]"
check "install: the public-text rules, 0644, the file given" sh -c "[ \"\$(stat -c %a '$ETC_GP/public-text.json')\" = 644 ] && cmp -s '$RULES' '$ETC_GP/public-text.json'"
check "install: the rules checked by the root-owned copy's code, before they were installed" sh -c "grep -qx 'node ghrules $T/work.*/in/.*public-text.json' '$T/state/calls' || grep -q '^node ghrules ' '$T/state/calls'"
check "install: ten units" [ "$(units_n)" = 10 ]
check "install: the GitHub socket enabled and started" sh -c "[ -f '$T/state/keyunit.gp-key-inst-github.socket.enabled' ] && [ -f '$T/state/keyunit.gp-key-inst-github.socket.active' ]"
check "install: asked as the agent user whether it reads the App key" grep -qx "runuser agent test -r $ETC_GP/github-app.pem" "$T/state/calls"
check "install: asked as the key's user too" grep -qx "runuser gp-key-inst test -r $ETC_GP/github-app.pem" "$T/state/calls"
check "install: the GitHub App key's own user made, a system user with no shell" sh -c "grep -q '^gp-gh-inst:x:9[0-9][0-9]:9[0-9][0-9]:Ghost Protocol GitHub App key for inst:/nonexistent:/usr/sbin/nologin\$' '$T/state/passwd' && [ \"\$(grep -c '^useradd [0-9]' '$T/state/calls')\" = 2 ]"
check "install: alone in its own group" sh -c "grep -q '^gp-gh-inst:x:9[0-9][0-9]:\$' '$T/state/group'"
check "install: asked as that user whether it reads either key" sh -c "grep -qx 'runuser gp-gh-inst test -r $ETC_GP/github-app.pem' '$T/state/calls' && grep -qx 'runuser gp-gh-inst test -r $ETC_GP/buzz-key' '$T/state/calls'"
check "install: asked whether the agent user writes github.conf and the code" sh -c "grep -qx 'runuser agent test -w $ETC_GP/github.conf' '$T/state/calls' && grep -qx 'runuser agent test -w $OPT/$C1/adapters/buzz/src/github-review.mjs' '$T/state/calls'"
I=verify   # the instance name a template is asked about by
check "install: the GitHub units read as systemd loads them" sh -c "grep -qx 'systemctl cat gp-key-inst-github@$I.service' '$T/state/calls' && grep -qx 'systemctl cat gp-key-inst-github.socket' '$T/state/calls'"
check "install: the socket asked, as the agent user, with the root-owned copy" grep -q "^runuser agent env -i PATH=/usr/bin:/bin .* $OPT/$C1/bin/node --disable-sigusr1 $OPT/$C1/adapters/buzz/src/github-review.mjs --socket $T/run/ghost-protocol-key/inst fingerprint\$" "$T/state/calls"
check "install: then GitHub, for the App" grep -qx 'node ghprobe app' "$T/state/calls"
check "install: only once the listeners are on" sh -c "awk '/^systemctl enable 6\$/ { on = NR } /^node ghprobe fingerprint\$/ { p = NR } END { exit !(on && p > on) }' '$T/state/calls'"
check "install: recorded" out_has 'OK +github +the GitHub socket answered as agent, and GitHub knows the key'
check "install: says how the session posts a review" out_has 'gp-github-review --socket .*/run/ghost-protocol-key/inst review <owner/repo>'
check "install: the relay side as before" sh -c "grep -qE 'OK +answers' '$OUT' && grep -qE 'DONE +keyservice +installed and listening' '$OUT'"

# 4. The units.
GU="$UNITS/gp-key-inst-github@.service"; GS="$UNITS/gp-key-inst-github.socket"
check "github@.service: runs as the GitHub App key's own user" sh -c "grep -qx 'User=gp-gh-inst' '$GU' && grep -qx 'Group=gp-gh-inst' '$GU'"
check "github@.service: never as the key's user, which runs buzz-mcp" sh -c "! grep -qxE '(User|Group)=gp-key-inst' '$GU' && grep -qx 'User=gp-key-inst' '$UNITS/gp-key-inst-buzz-mcp@.service'"
check "github@.service: runs only the root-owned copy" grep -qx "ExecStart=$OPT/$C1/bin/node --disable-sigusr1 $OPT/$C1/adapters/buzz/src/github-review.mjs serve" "$GU"
check "github@.service: the App key by OpenFile=, read-only" grep -qx "OpenFile=$ETC_GP/github-app.pem:github-app-key:read-only" "$GU"
check "github@.service: never the relay key, nor the Buzz settings" sh -c "! grep -v '^#' '$GU' | grep -qE 'buzz-key|buzz.env|BUZZ_'"
check "github@.service: the settings from github.conf" grep -qx "EnvironmentFile=$ETC_GP/github.conf" "$GU"
check "github@.service: node, loader and TLS settings unset" grep -qx 'UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE NODE_COMPILE_CACHE LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT OPENSSL_CONF OPENSSL_MODULES OPENSSL_ENGINES NODE_TLS_REJECT_UNAUTHORIZED NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR SSLKEYLOGFILE NODE_USE_ENV_PROXY NODE_DEBUG NODE_DEBUG_NATIVE' "$GU"
for line in NoNewPrivileges=yes CapabilityBoundingSet= AmbientCapabilities= RestrictSUIDSGID=yes ProtectSystem=strict \
            ProtectHome=yes PrivateTmp=yes PrivateDevices=yes ProtectProc=invisible ProcSubset=pid LimitCORE=0 \
            ProtectKernelTunables=yes ProtectKernelModules=yes ProtectControlGroups=yes RestrictNamespaces=yes \
            LockPersonality=yes SystemCallArchitectures=native SystemCallFilter=@system-service KeyringMode=private \
            'StandardInput=socket' 'StandardOutput=socket' 'RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6' 'RuntimeMaxSec=2min'; do
    check "github@.service: $line" grep -qxF "$line" "$GU"
done
check "github@.service: the shared folders are not there at all" grep -qx "InaccessiblePaths=-$T/srv/ghost-protocol/inst" "$GU"
check "github@.service: nothing it may write" sh -c "! grep -qE '^(ReadWritePaths|StateDirectory)=' '$GU'"
check "github socket: one process per connection, up to 4" sh -c "grep -qx 'Accept=yes' '$GS' && grep -qx 'MaxConnections=4' '$GS'"
check "github socket: root and the agent's group only" sh -c "grep -qx 'SocketUser=root' '$GS' && grep -qx 'SocketGroup=agent' '$GS' && grep -qx 'SocketMode=0660' '$GS'"
check "github socket: at the run folder" grep -qx "ListenStream=$T/run/ghost-protocol-key/inst/github.sock" "$GS"
check "units: no placeholder left" sh -c "! grep -q '@[A-Z_]*@' '$GU' '$GS'"
if command -v systemd-analyze >/dev/null 2>&1; then
    v="$(systemd-analyze --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
    if [ "${v:-0}" -ge 253 ] 2>/dev/null; then
        check "github@.service: systemd-analyze knows every line" sh -c "! systemd-analyze verify --man=no '$GU' 2>&1 | grep -E 'Unknown key|Unknown section|Failed to parse|Invalid'"
        check "github@.service: systemd-analyze security, exposure at most 2.0" \
            sh -c "systemd-analyze security --offline=yes --threshold=20 --no-pager '$GU' >/dev/null 2>&1"
    fi
fi

# 5. Again with nothing changed: no key asked for, nothing restarted.
: >"$T/state/calls"
ks --apply
check "again: exit 0" rc_is 0
check "again: the App key read back, not written" sh -c "grep -qx 'node ghkey fingerprint' '$T/state/calls' && ! grep -qE '^node ghkey (write|replace)' '$T/state/calls'"
check "again: nothing restarted" sh -c "! grep -q '^systemctl stop' '$T/state/calls'"
check "again: the socket asked again" grep -qx 'node ghprobe fingerprint' "$T/state/calls"
check "again: nothing changed" out_has 'OK +keyservice +nothing changed'
# A second key, not on purpose: refused, and the first one stays.
gh_ks "$GHKEY2" --apply
check "a second App key: refused (exit 1)" rc_is 1
check "a second App key: says how to swap it" out_has 'replaced only on purpose: add --replace-github-app-key'
check "a second App key: the first one stays" sh -c "[ \"\$(cat '$ETC_GP/github-app.pem')\" = '$GHKEY' ]"

# 6. Rotation: the key swapped on purpose; both fingerprints printed; only the
#    GitHub socket started again.
unit_loaded; touch "$T/state/unit-inst.service.active"
old_fp="$(fp_of "$ETC_GP/github-app.pem")"
: >"$T/state/calls"
gh_ks "$GHKEY2" --replace-github-app-key --apply
check "replace: exit 0" rc_is 0
check "replace: the new key in place, 0400" sh -c "[ \"\$(cat '$ETC_GP/github-app.pem')\" = '$GHKEY2' ] && [ \"\$(stat -c %a '$ETC_GP/github-app.pem')\" = 400 ]"
check "replace: swapped by the root-owned copy's code" grep -qx 'node ghkey replace' "$T/state/calls"
check "replace: says to delete the old key on GitHub, by its fingerprint" out_has "delete it on GitHub now .*the one with fingerprint $old_fp"
check "replace: neither key printed" sh -c "! grep -qE '$GHKEY|$GHKEY2' '$OUT'"
check "replace: only the GitHub socket started again" sh -c "grep -qxF 'systemctl stop-pattern gp-key-inst-github@*.service' '$T/state/calls' && ! grep -q 'stop-pattern gp-key-inst-channel@' '$T/state/calls'"
check "replace: the session not restarted" [ ! -e "$T/state/unit-inst.service.restarts" ]
check "replace: the socket answers with the new key's fingerprint" out_has "github.sock: fingerprint $(fp_of "$ETC_GP/github-app.pem")"
gh_ks "$GHKEY2" --replace-github-app-key --apply
check "replace with the same key: FAIL (exit 1)" rc_is 1
check "replace with the same key: the key stays" sh -c "[ \"\$(cat '$ETC_GP/github-app.pem')\" = '$GHKEY2' ]"

# 7. Adding the slot to an instance that runs (a reviewer's: the relay first,
#    the App key later): only the GitHub socket starts; the session runs on.
setup
install_ks
check "relay only: eight units, no GitHub socket" sh -c "[ \"\$(ls '$UNITS' | grep -c '^gp-key-inst-')\" = 8 ] && [ ! -e '$UNITS/gp-key-inst-github.socket' ]"
check "relay only: the socket not asked" sh -c "! grep -q '^node ghprobe' '$T/state/calls'"
unit_loaded; touch "$T/state/unit-inst.service.active"
: >"$T/state/calls"
gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --apply
check "slot added: exit 0" rc_is 0
check "slot added: ten units" [ "$(units_n)" = 10 ]
check "slot added: the GitHub socket enabled and started" sh -c "[ -f '$T/state/keyunit.gp-key-inst-github.socket.enabled' ] && [ -f '$T/state/keyunit.gp-key-inst-github.socket.active' ]"
check "slot added: the session not restarted" [ ! -e "$T/state/unit-inst.service.restarts" ]
check "slot added: the relay's connections left alone" sh -c "! grep -q 'stop-pattern gp-key-inst-channel@' '$T/state/calls' && ! grep -q '^systemctl stop: gp-key-inst-channel.socket' '$T/state/calls'"
check "slot added: says the session runs on" out_has 'DONE +restart +the GitHub socket started again at [0-9a-f]+; the session runs on'
check "slot added: the relay's sockets probed too" sh -c "grep -qx 'node probe channel' '$T/state/calls' && grep -qx 'node probe buzz-mcp' '$T/state/calls'"
check "slot added: the GitHub socket asked" grep -qx 'node ghprobe fingerprint' "$T/state/calls"
check "slot added: the relay key kept" sh -c "[ \"\$(cat '$ETC_GP/buzz-key')\" = '$STANDIN' ]"
check "slot added: the GitHub App key's user made then, and only it" sh -c "grep -q '^gp-gh-inst:' '$T/state/passwd' && [ \"\$(grep -c '^useradd [0-9]' '$T/state/calls')\" = 1 ]"

# 8. The checks: each refuses before anything of the slot is written.
gh_refused() {   # name pattern
    check "$1: refused (exit 1)" rc_is 1
    check "$1: says why" out_has "$2"
    check "$1: nothing of the slot written" gh_untouched
    check "$1: no key asked for" sh -c "! grep -qE '^node ghkey (write|replace)' '$T/state/calls'"
}
bad_settings() {   # name pattern line...
    local name="$1" pat="$2"; shift 2
    setup
    install_ks
    printf '%s\n' "$@" >"$GHS"
    gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --apply
    gh_refused "$name" "$pat"
}
bad_settings "an App id, not a client ID" "GITHUB_APP_CLIENT_ID must be the App's client ID" 'GITHUB_APP_CLIENT_ID=123456' 'GITHUB_REVIEW_REPOS=1:example-org/r'
bad_settings "a repo with no installation" "GITHUB_REVIEW_REPOS must be <installation id>:<owner>/<repo>" "GITHUB_APP_CLIENT_ID=$CLIENT" 'GITHUB_REVIEW_REPOS=example-org/r'
bad_settings "an installation 0" "GITHUB_REVIEW_REPOS must be" "GITHUB_APP_CLIENT_ID=$CLIENT" 'GITHUB_REVIEW_REPOS=0:example-org/r'
bad_settings "a repo .." "names a repo . or .." "GITHUB_APP_CLIENT_ID=$CLIENT" 'GITHUB_REVIEW_REPOS=1:example-org/..'
bad_settings "a repo twice, in another case" "names example-org/r twice" "GITHUB_APP_CLIENT_ID=$CLIENT" 'GITHUB_REVIEW_REPOS=1:example-org/r,2:Example-Org/R'
bad_settings "an empty entry" "has an empty entry" "GITHUB_APP_CLIENT_ID=$CLIENT" 'GITHUB_REVIEW_REPOS=1:example-org/r,'
bad_settings "no repos" "must set GITHUB_REVIEW_REPOS" "GITHUB_APP_CLIENT_ID=$CLIENT"
bad_settings "no client ID" "must set GITHUB_APP_CLIENT_ID" 'GITHUB_REVIEW_REPOS=1:example-org/r'
bad_settings "another setting" "GITHUB_TOKEN is not a GitHub App slot setting" "GITHUB_APP_CLIENT_ID=$CLIENT" 'GITHUB_REVIEW_REPOS=1:example-org/r' 'GITHUB_TOKEN=x'
bad_settings "a quoted value" "is not KEY=value" "GITHUB_APP_CLIENT_ID=\"$CLIENT\"" 'GITHUB_REVIEW_REPOS=1:example-org/r'
bad_settings "a setting twice" "GITHUB_APP_CLIENT_ID appears twice" "GITHUB_APP_CLIENT_ID=$CLIENT" "GITHUB_APP_CLIENT_ID=$CLIENT" 'GITHUB_REVIEW_REPOS=1:example-org/r'
setup
install_ks
gh_ks "$GHKEY" --apply
gh_refused "the App key with no settings, the first time" "the GitHub App slot needs --github-settings <file> the first time"
setup
install_ks
ks --github-settings "$GHS" --github-public-text "$RULES" --apply
gh_refused "settings with no App key" "no GitHub App key at .*/github-app.pem: give it with --github-app-key-from-stdin"
setup
install_ks
gh_ks "$GHKEY" --replace-github-app-key --github-settings "$GHS" --github-public-text "$RULES" --apply
gh_refused "a key to replace that is not there" "is not there: nothing to replace"
# The GitHub App key's user, when it is there already: a system user with no
# shell, alone in its own group, sharing none with the agent user or the
# key's user.
gh_user_world() {   # passwd line, group lines...
    local l
    setup
    install_ks
    printf '%s\n' "$1" >>"$T/state/passwd"; shift
    for l in "$@"; do printf '%s\n' "$l" >>"$T/state/group"; done
    : >"$T/state/calls"
}
gh_user_world 'gp-gh-inst:x:1500:1500:Ghost Protocol GitHub App key for inst:/nonexistent:/usr/sbin/nologin' 'gp-gh-inst:x:1500:'
gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --apply
gh_refused "a GitHub App key user that is not a system user" "the GitHub App key's user gp-gh-inst is there, but not a system user"
gh_user_world 'gp-gh-inst:x:950:950:Ghost Protocol GitHub App key for inst:/nonexistent:/bin/bash' 'gp-gh-inst:x:950:'
gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --apply
gh_refused "a GitHub App key user with a login shell" "the GitHub App key's user gp-gh-inst has a login shell"
gh_user_world 'gp-gh-inst:x:950:4242:Ghost Protocol GitHub App key for inst:/nonexistent:/usr/sbin/nologin'
gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --apply
gh_refused "a GitHub App key user in the agent's group" "the GitHub App key's user gp-gh-inst's group is not its own group"
gh_user_world 'gp-gh-inst:x:950:950:Ghost Protocol GitHub App key for inst:/nonexistent:/usr/sbin/nologin' 'gp-gh-inst:x:950:' 'shared:x:960:gp-gh-inst,gp-key-inst'
gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --apply
gh_refused "a GitHub App key user that shares a group with the key's user" "shares the group shared with the agent user or the key's user"
gh_user_world 'gp-gh-inst:x:950:950:Ghost Protocol GitHub App key for inst:/nonexistent:/usr/sbin/nologin' 'gp-gh-inst:x:950:'
gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --apply
check "a GitHub App key user that is there and right: installed" rc_is 0
check "a GitHub App key user that is there and right: not made again" not_called useradd
# A user of that name made for another role, or for another instance: never
# taken over. Its comment says what it was made for.
gh_user_world 'gp-gh-inst:x:950:950:Ghost Protocol key service for inst:/nonexistent:/usr/sbin/nologin' 'gp-gh-inst:x:950:'
gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --apply
gh_refused "a GitHub App key user made as a key's user" "gp-gh-inst is there, but it was not made by this setup for this role and this instance: its comment is \"Ghost Protocol key service for inst\", not \"Ghost Protocol GitHub App key for inst\""
gh_user_world 'gp-gh-inst:x:950:950:Ghost Protocol GitHub App key for other:/nonexistent:/usr/sbin/nologin' 'gp-gh-inst:x:950:'
gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --apply
gh_refused "a GitHub App key user made for another instance" "its comment is \"Ghost Protocol GitHub App key for other\""
gh_user_world 'gp-gh-inst:x:950:950::/nonexistent:/usr/sbin/nologin' 'gp-gh-inst:x:950:'
gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --apply
gh_refused "a GitHub App key user with no comment" "its comment is \"<none>\""
# Instances foo and foo-gh never share a user: foo's GitHub App key user is
# gp-gh-foo, and foo-gh's key's user is gp-key-foo-gh (no key's user can be
# named gp-gh-*). With inst installed with the slot, instance inst-gh would
# make users of its own.
setup
install_both
check "the pair: inst's users made" sh -c "grep -q '^gp-key-inst:' '$T/state/passwd' && grep -q '^gp-gh-inst:' '$T/state/passwd'"
printf '%s\n' "$GHKEY" >"$T/ghkey-in"
t_env GP_ETC="$T/etc2" GP_OPT="$T/opt" GP_SRV="$T/srv2" GP_RUN="$T/run2" GP_VARLIB="$T/varlib2" GP_PROC_SYS="$T/procsys" \
    "$SETUP" --name inst-gh --agent-user agent --yes --settings "$SETTINGS" --key-generate --github-settings "$GHS" --github-public-text "$RULES" \
    --github-app-key-from-stdin <"$T/ghkey-in" >"$OUT" 2>&1; RC=$?
check "the pair: inst-gh's dry run passes" rc_is 0
check "the pair: inst-gh's key's user is its own, to be made" out_has "the key's user: gp-key-inst-gh \\(to be made\\)"
check "the pair: inst-gh's GitHub App key user is its own, to be made" out_has "the GitHub App key's user: gp-gh-inst-gh \\(to be made\\)"
check "the pair: inst's GitHub App key user is not named for inst-gh" sh -c "! grep -q 'gp-gh-inst[^-]' '$OUT'"
# The user an earlier build gave instance foo's GitHub unit (gp-key-foo-gh) is
# refused as instance foo-gh's key's user: its comment names the other role.
setup
printf '%s\n' 'gp-key-inst-gh:x:950:950:Ghost Protocol GitHub App key for inst:/nonexistent:/usr/sbin/nologin' >>"$T/state/passwd"
printf '%s\n' 'gp-key-inst-gh:x:950:' >>"$T/state/group"
printf '%s\n' "$STANDIN" >"$T/key-in"
t_env GP_ETC="$T/etc" GP_OPT="$T/opt" GP_SRV="$T/srv" GP_RUN="$T/run" GP_VARLIB="$T/varlib" GP_PROC_SYS="$T/procsys" \
    "$SETUP" --name inst-gh --agent-user agent --yes --settings "$SETTINGS" --key-from-stdin --apply <"$T/key-in" >"$OUT" 2>&1; RC=$?
check "the pair: another instance's GitHub App key user as a key's user: refused (exit 1)" rc_is 1
check "the pair: says why" out_has "the key's user gp-key-inst-gh is there, but it was not made by this setup for this role and this instance: its comment is \"Ghost Protocol GitHub App key for inst\", not \"Ghost Protocol key service for inst-gh\""
check "the pair: nothing written" sh -c "[ ! -e '$T/opt' ] && [ ! -e '$T/etc/ghost-protocol' ]"
# The slot on (its settings there), its key gone: refused, not run keyless.
setup
install_both
rm -f "$ETC_GP/github-app.pem"
ks --apply
check "the slot's key gone: refused (exit 1)" rc_is 1
check "the slot's key gone: says so" out_has 'no GitHub App key at .*/github-app.pem'
# An instance unit that has systemd read the App key: refused (it is under
# the key service's settings folder).
setup
install_ks
unit_loaded
printf '# %s/systemd/system/inst.service\n[Service]\nExecStart=/bin/true\nLoadCredential=gh:%s/github-app.pem\n' "$T/etc" "$ETC_GP" >"$T/state/unit-inst.service.cat"
gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --apply
gh_refused "an instance unit that loads the App key" "has systemd read, as root, a file that could be the key: LoadCredential=gh:.*/github-app.pem"

# 9. The kernel's answer after writing: if the agent user (or the key's user)
#    can read the App key, it stops, and nothing listens.
for u in agent gp-key-inst gp-gh-inst; do
    setup
    echo "r $ETC_GP/github-app.pem" >"$T/state/runuser.$u.can"
    install_both
    check "$u can read the App key: FAIL (exit 1)" rc_is 1
    check "$u can read the App key: says so" out_has "$u can read the key file .*/github-app.pem"
    check "$u can read the App key: nothing listens" sh -c "[ ! -f '$T/state/keyunit.gp-key-inst-github.socket.active' ] && [ ! -f '$T/state/keyunit.gp-key-inst-channel.socket.active' ]"
done
setup
echo "r $ETC_GP/buzz-key" >"$T/state/runuser.gp-gh-inst.can"
install_both
check "the GitHub App key's user can read the relay key: FAIL (exit 1)" sh -c "[ $RC = 1 ] && grep -q 'gp-gh-inst can read the key file .*/buzz-key' '$OUT'"
setup
echo "w $ETC_GP/github.conf" >"$T/state/runuser.agent.can"
install_both
check "the agent user can write github.conf: FAIL (exit 1)" rc_is 1

# 10. The socket's answers, as the agent user.
setup
touch "$T/state/ghprobe.fingerprint.fails"
install_both
check "no answer on the GitHub socket: FAIL (exit 1)" rc_is 1
check "no answer: says where to look" out_has "FAIL +github +the GitHub socket did not answer as agent .*journalctl -u 'gp-key-inst-github@\\*'"
check "no answer: never says installed" out_lacks 'installed and listening'
check "no answer: the listeners stay on, for the next run" [ -f "$T/state/keyunit.gp-key-inst-github.socket.enabled" ]
rm -f "$T/state/ghprobe.fingerprint.fails"
ks --apply
check "the run after it: exit 0" rc_is 0
touch "$T/state/ghprobe.fingerprint.wrong"
ks --apply
check "another key's fingerprint: FAIL (exit 1)" sh -c "[ $RC = 1 ] && grep -qE 'FAIL +github +the GitHub socket did not answer' '$OUT'"
rm -f "$T/state/ghprobe.fingerprint.wrong"
touch "$T/state/ghprobe.app.fails"
ks --apply
check "GitHub does not know the App: FAIL (exit 1)" sh -c "[ $RC = 1 ] && grep -qE 'FAIL +github +GitHub did not answer for the App as configured' '$OUT'"
: >"$T/state/calls"
ks --skip-github-check --apply
check "--skip-github-check: exit 0" rc_is 0
check "--skip-github-check: GitHub not asked" sh -c "grep -qx 'node ghprobe fingerprint' '$T/state/calls' && ! grep -qx 'node ghprobe app' '$T/state/calls'"
check "--skip-github-check: a SKIP line says so" out_has 'SKIP +github +GitHub was not asked about the App \(--skip-github-check\)'
rm -f "$T/state/ghprobe.app.fails"

# 11. An update moves the GitHub units with the others; a rollback past the
#     slot's start, or an update to a commit without its code, is refused.
setup
install_both
unit_loaded; touch "$T/state/unit-inst.service.active"
C2="$(next_commit two)"
: >"$T/state/calls"
ks --update --apply
check "update: exit 0" rc_is 0
check "update: the GitHub unit runs the new copy" grep -qx "ExecStart=$OPT/$C2/bin/node --disable-sigusr1 $OPT/$C2/adapters/buzz/src/github-review.mjs serve" "$UNITS/gp-key-inst-github@.service"
check "update: the GitHub connections ended with the others" grep -qxF 'systemctl stop-pattern gp-key-inst-github@*.service' "$T/state/calls"
check "update: the GitHub socket started again" grep -qx 'systemctl start: gp-key-inst-github.socket in place' "$T/state/calls"
check "update: the App key kept, not written" sh -c "[ \"\$(cat '$ETC_GP/github-app.pem')\" = '$GHKEY' ] && ! grep -qE '^node ghkey (write|replace)' '$T/state/calls'"
check "update: the socket asked after" grep -qx 'node ghprobe fingerprint' "$T/state/calls"
git -C "$GPF" reset -q --hard "$C1"
# A commit without the GitHub code (here one that removes it): an instance at
# it, moved to C1, given the slot, cannot roll back to it.
git -C "$GPF" rm -q adapters/buzz/src/github-review.mjs && git -C "$GPF" commit -q -m "no github code"
C0="$(git -C "$GPF" rev-parse HEAD)"
setup
install_ks --commit "$C0"
check "an instance at a commit without the GitHub code: installed" rc_is 0
ks --update --commit "$C1" --apply
check "moved to a commit with it: exit 0" rc_is 0
gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --commit "$C1" --apply
check "the slot added there: exit 0" rc_is 0
ks --rollback --apply
check "a rollback past the slot's start: refused (exit 1)" rc_is 1
check "a rollback past the slot's start: says why" out_has "commit $C0 has no GitHub review code"
check "a rollback past the slot's start: still at C1" grep -qx "$C1" "$ETC_GP/commit"
ks --update --commit "$C0" --apply
check "an update to a commit without the code: refused (exit 1)" sh -c "[ $RC = 1 ] && grep -q 'has no GitHub review code' '$OUT'"
git -C "$GPF" reset -q --hard "$C1"

# 12. The limits' own settings (the reviewer's own bot identities, COMMENT),
#     and the public-text rules: required, checked by the root-owned copy's
#     code before they are installed, kept when not given again.
OWN="GITHUB_REVIEW_OWN_LOGINS=$OWN_LOGIN"
OWNE="GITHUB_REVIEW_OWN_EMAILS=$OWN_EMAIL"
BASE_S=("GITHUB_APP_CLIENT_ID=$CLIENT" 'GITHUB_REVIEW_REPOS=1:example-org/r')
bad_settings "no own logins" "the GitHub settings must set GITHUB_REVIEW_OWN_LOGINS" "${BASE_S[@]}" "$OWNE"
bad_settings "no own emails" "the GitHub settings must set GITHUB_REVIEW_OWN_EMAILS" "${BASE_S[@]}" "$OWN"
bad_settings "a person as the own login" "GITHUB_REVIEW_OWN_LOGINS must be the App's bot login, <name>.bot., comma-separated \\(not: example-builder\\)" "${BASE_S[@]}" "$OWNE" 'GITHUB_REVIEW_OWN_LOGINS=example-builder'
bad_settings "a bot and a person as own logins" "GITHUB_REVIEW_OWN_LOGINS must be" "${BASE_S[@]}" "$OWNE" "GITHUB_REVIEW_OWN_LOGINS=$OWN_LOGIN,example-builder"
bad_settings "the builders' shared noreply author as an own email" "GITHUB_REVIEW_OWN_EMAILS must be the App's bot noreply address, <id>.+<name>.bot..users.noreply.github.com, comma-separated \\(not: 4100.example-builder.users.noreply.github.com\\)" "${BASE_S[@]}" "$OWN" "GITHUB_REVIEW_OWN_EMAILS=$BUILDER_EMAIL"
bad_settings "a bot noreply with no id" "GITHUB_REVIEW_OWN_EMAILS must be" "${BASE_S[@]}" "$OWN" 'GITHUB_REVIEW_OWN_EMAILS=review-bot[bot]@users.noreply.github.com'
bad_settings "an own login twice, in another case" "GITHUB_REVIEW_OWN_LOGINS names review-bot.bot. twice" "${BASE_S[@]}" "$OWNE" "GITHUB_REVIEW_OWN_LOGINS=$OWN_LOGIN,Review-Bot[bot]"
bad_settings "an empty own-login entry" "GITHUB_REVIEW_OWN_LOGINS has an empty entry" "${BASE_S[@]}" "$OWNE" "GITHUB_REVIEW_OWN_LOGINS=$OWN_LOGIN,"
bad_settings "an empty own-login list" "GITHUB_REVIEW_OWN_LOGINS is empty" "${BASE_S[@]}" "$OWNE" 'GITHUB_REVIEW_OWN_LOGINS='
bad_settings "over 10 own logins" "GITHUB_REVIEW_OWN_LOGINS names more than 10 identities" "${BASE_S[@]}" "$OWNE" "GITHUB_REVIEW_OWN_LOGINS=$(for i in 1 2 3 4 5 6 7 8 9 10 11; do printf 'bot%s[bot],' "$i"; done | sed 's/,$//')"
bad_settings "COMMENT allowed with 2" "GITHUB_REVIEW_ALLOW_COMMENT must be 0 or 1" "${BASE_S[@]}" "$OWN" "$OWNE" 'GITHUB_REVIEW_ALLOW_COMMENT=2'
bad_settings "COMMENT allowed with true" "GITHUB_REVIEW_ALLOW_COMMENT must be 0 or 1" "${BASE_S[@]}" "$OWN" "$OWNE" 'GITHUB_REVIEW_ALLOW_COMMENT=true'
bad_settings "the rules file named by the admin" "GITHUB_REVIEW_PUBLIC_TEXT_FILE is the setup's own line" "${BASE_S[@]}" "$OWN" "$OWNE" 'GITHUB_REVIEW_PUBLIC_TEXT_FILE=/tmp/mine.json'
t_env "$SETUP" --name inst --agent-user agent --github-public-text relative.json >"$OUT" 2>&1; RC=$?
check "usage: --github-public-text takes an absolute path (exit 2)" rc_is 2

# An identity holds [bot], which the shell would read as a pattern: a file in the
# folder the setup runs in, named like a match, must not change what is checked.
setup
mkdir -p "$T/cwd" && : >"$T/cwd/review-bott"
(cd "$T/cwd" && install_both)
check "a file named like the own login's pattern: installed all the same" rc_is 0
check "a file named like the own login's pattern: the settings as given" grep -qxF "GITHUB_REVIEW_OWN_LOGINS=$OWN_LOGIN" "$ETC_GP/github.conf"

# COMMENT allowed, written as given; two own logins and two own emails.
setup
printf 'GITHUB_REVIEW_ALLOW_COMMENT=1\n' >>"$GHS"
sed -i "s/^GITHUB_REVIEW_OWN_LOGINS=.*/GITHUB_REVIEW_OWN_LOGINS=$OWN_LOGIN,other-bot[bot]/" "$GHS"
install_both
check "COMMENT allowed: installed" rc_is 0
check "COMMENT allowed: github.conf says so, with both own logins" sh -c "grep -qx 'GITHUB_REVIEW_ALLOW_COMMENT=1' '$ETC_GP/github.conf' && grep -qxF 'GITHUB_REVIEW_OWN_LOGINS=$OWN_LOGIN,other-bot[bot]' '$ETC_GP/github.conf'"

# The rules are needed the first time.
setup
install_ks
gh_ks "$GHKEY" --github-settings "$GHS" --apply
gh_refused "the slot with no public-text rules, the first time" "no public-text rules at .*/public-text.json: the GitHub App slot needs --github-public-text <file>"
check "no rules the first time: nothing of the rules written" [ ! -e "$ETC_GP/public-text.json" ]
# A file the root-owned copy's code refuses is never installed, and nothing after it is written.
setup
install_ks
touch "$T/state/ghrules.fail"
gh_ks "$GHKEY" --github-settings "$GHS" --github-public-text "$RULES" --apply
check "rules the code refuses: FAIL (exit 1)" rc_is 1
check "rules the code refuses: says so, with the code's reason" out_has "the public-text rules file was not installed \\(github-review rules: public-text rule example: the pattern does not compile\\)"
check "rules the code refuses: not installed, and github.conf and the key not written" sh -c "[ ! -e '$ETC_GP/public-text.json' ] && [ ! -e '$ETC_GP/github.conf' ] && [ ! -e '$ETC_GP/github-app.pem' ]"
rm -f "$T/state/ghrules.fail"
# The one that is there stays when a new one is refused; a new one that is accepted replaces it.
setup
install_both
printf '[{"name":"other-rule","pattern":"other"}]\n' >"$T/rules2.json"
touch "$T/state/ghrules.fail"
ks --github-public-text "$T/rules2.json" --apply
check "a new rules file the code refuses: FAIL (exit 1)" rc_is 1
check "a new rules file the code refuses: the one there stays" cmp -s "$RULES" "$ETC_GP/public-text.json"
rm -f "$T/state/ghrules.fail"
ks --github-public-text "$T/rules2.json" --apply
check "a new rules file: exit 0" rc_is 0
check "a new rules file: installed, 0644" sh -c "cmp -s '$T/rules2.json' '$ETC_GP/public-text.json' && [ \"\$(stat -c %a '$ETC_GP/public-text.json')\" = 644 ]"
# Not given again: kept, and read again by this commit's code.
: >"$T/state/calls"
ks --apply
check "rules not given again: exit 0" rc_is 0
check "rules not given again: kept" cmp -s "$T/rules2.json" "$ETC_GP/public-text.json"
check "rules not given again: the installed file checked by the root-owned copy's code" grep -qx "node ghrules $ETC_GP/public-text.json" "$T/state/calls"
check "rules not given again: says so" out_has 'the public-text rules: rules 1 \(the file there, kept\)'
# The agent user must not be able to write the rules.
setup
echo "w $ETC_GP/public-text.json" >"$T/state/runuser.agent.can"
install_both
check "the agent user can write the rules: FAIL (exit 1)" rc_is 1
check "the agent user can write the rules: says so" out_has "agent can write .*/public-text.json"

# An update of an instance set up before the limits: refused before anything
# changes, naming what is missing; given the settings and the rules, it goes.
setup
install_both
unit_loaded; touch "$T/state/unit-inst.service.active"
next_commit three >/dev/null
printf 'GITHUB_APP_CLIENT_ID=%s\nGITHUB_REVIEW_REPOS=4242:example-org/review-target\n' "$CLIENT" >"$ETC_GP/github.conf"
rm -f "$ETC_GP/public-text.json"
old_conf="$(cat "$ETC_GP/github.conf")"
: >"$T/state/calls"
ks --update --apply
check "update from before the limits: refused (exit 1)" rc_is 1
check "update from before the limits: says the own logins are missing" out_has 'the GitHub settings must set GITHUB_REVIEW_OWN_LOGINS'
check "update from before the limits: says the own emails are missing" out_has 'the GitHub settings must set GITHUB_REVIEW_OWN_EMAILS'
check "update from before the limits: says the rules are missing" out_has 'no public-text rules at .*/public-text.json'
check "update from before the limits: nothing changed" sh -c "[ \"\$(cat '$ETC_GP/github.conf')\" = '$old_conf' ] && ! grep -q '^systemctl stop' '$T/state/calls'"
ks --update --github-settings "$GHS" --github-public-text "$RULES" --apply
check "update with the settings and the rules: exit 0" rc_is 0
check "update with the settings and the rules: github.conf and the rules in place" sh -c "grep -qxF 'GITHUB_REVIEW_OWN_LOGINS=$OWN_LOGIN' '$ETC_GP/github.conf' && cmp -s '$RULES' '$ETC_GP/public-text.json'"
check "update with the settings and the rules: the rules read before the settings were written" sh -c "awk '/^node ghrules / { r = NR } END { exit !r }' '$T/state/calls'"

# The App GitHub knows must be one of the own logins: a typo would turn the
# own-pull-request and own-commit limits off.
setup
sed -i "s/^GITHUB_REVIEW_OWN_LOGINS=.*/GITHUB_REVIEW_OWN_LOGINS=other-bot[bot]/" "$GHS"
install_both
check "the App's slug is not an own login: FAIL (exit 1)" rc_is 1
check "the App's slug is not an own login: says why" out_has "GitHub knows this key as the App review-bot, whose bot login is review-bot.bot., and GITHUB_REVIEW_OWN_LOGINS does not name it"
check "the App's slug is not an own login: the listeners stay on, for the next run" [ -f "$T/state/keyunit.gp-key-inst-github.socket.enabled" ]
sed -i "s/^GITHUB_REVIEW_OWN_LOGINS=.*/GITHUB_REVIEW_OWN_LOGINS=other-bot[bot],Review-Bot[bot]/" "$GHS"
ks --github-settings "$GHS" --apply
check "the App's slug among the own logins, in another case: exit 0" rc_is 0
sed -i "s/^GITHUB_REVIEW_OWN_LOGINS=.*/GITHUB_REVIEW_OWN_LOGINS=other-bot[bot]/" "$GHS"
ks --github-settings "$GHS" --skip-github-check --apply
check "--skip-github-check leaves the slug check out too: exit 0" rc_is 0

finish_tests
