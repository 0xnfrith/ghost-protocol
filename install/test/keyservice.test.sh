#!/usr/bin/env bash
# keyservice.test.sh: the key service (install/keyservice/setup and
# install/lib/keyservice.sh), and its copy step (install/keyservice/outbox-copy).
#   - The checks refuse before changing anything: an agent user that is root,
#     the admin, in a root-equivalent group (each one), with sudo (any, or
#     passwordless with --agent-sudo password), able to write a container
#     engine's socket, or whose group holds another user; fs.protected_symlinks
#     or protected_hardlinks off; systemd older than 253; the auto-mode guard
#     installed; code or settings the agent user could change; bad settings;
#     no key, or a key given when one is there. --accept-root-equivalent-agent
#     turns the root-equivalence findings into warnings.
#   - A dry run prints every file in full, the key never, and changes nothing.
#   - An install makes the key's user (a system user, no home, no shell), puts
#     the code at /opt/ghost-protocol/<commit> from git (never the working
#     tree), writes the key file 0400 from stdin without printing it, the
#     settings, the tag, the shared folders with their owners and modes, and
#     the six units, then asks as the agent user and as the key's user whether
#     either can read the key (a yes stops it, and nothing is started).
#   - The units: the key's user, the key by OpenFile=, no key anywhere else,
#     the sandbox (every hardening line), the sockets' group and modes, one
#     channel at a time.
#   - An update moves the units to a new commit, records the old one, and
#     restarts the key service and the instance; a rollback goes back; copies
#     no instance needs are removed.
#   - The copy step takes only regular files with one link, at the top of the
#     outbox, never a link, a FIFO, a dot file or one over the limit.
# The setup runs from $GPF, a copy of this repo with commits of its own, never
# from the source tree. Users, sudo, systemctl, runuser, chown and node are
# stand-ins: nothing here runs as root or touches the machine.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

t_new
if ! t_tool python3; then
    echo "SKIP  every case (no python3 on this machine; the copy step needs it)"
    finish_tests
    exit $?
fi

# A copy of the repo's files with a commit of its own: C1. Made once.
GPF="$(mktemp -d "${TMPDIR:-/tmp}/gp-ks-repo.XXXXXX")"
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
# A throwaway stand-in for the relay key, made for this run.
STANDIN="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
ME="$(id -un)"

# A machine where a key service can be installed: an agent user (uid 4242,
# alone in its group agent, also in systemd-journal, which is fine), the
# protections on, systemd 255, a buzz-mcp build of the pin, the settings.
setup() {
    t_new
    t_stub sudo; t_stub systemctl; t_stub node; t_stub npm; t_stub getent; t_stub id
    t_stub useradd; t_stub runuser; t_stub chown
    t_tool install; t_tool python3; t_tool flock
    touch "$T/state/sudo.allow"
    cat >"$T/state/passwd" <<EOF
root:x:0:0:root:/root:/bin/bash
$ME:x:$(id -u):$(id -g)::$T/home:/bin/bash
agent:x:4242:4242::/home/agent:/bin/bash
EOF
    cat >"$T/state/group" <<EOF
root:x:0:
sudo:x:27:$ME
docker:x:998:
lxd:x:997:
incus-admin:x:996:
incus:x:995:
microk8s:x:994:
disk:x:6:
staff:x:50:
systemd-journal:x:101:agent
agent:x:4242:
EOF
    mkdir -p "$T/procsys/fs" "$T/etc/systemd/system"
    echo 1 >"$T/procsys/fs/protected_symlinks"; echo 1 >"$T/procsys/fs/protected_hardlinks"
    B="$T/home/.cache/ghost-protocol/buzz"
    mkdir -p "$B"
    printf 'stand-in buzz-mcp build\n' >"$B/buzz-mcp.mjs"; printf '%s\n' "$PIN" >"$B/buzz-mcp.commit"
    SETTINGS="$T/settings.env"
    cat >"$SETTINGS" <<EOF
# The test instance's Buzz settings.
BUZZ_RELAY_URL=https://relay.example.com
BUZZ_CHANNELS=0b1c2d3e-4f50-4612-8a7b-9c0d1e2f3a4b
BUZZ_ALLOWED_PUBKEYS=$(printf '%064d' 0 | tr 0 b)
EOF
    ETC_GP="$T/etc/ghost-protocol/inst"; OPT="$T/opt/ghost-protocol"; SRV_GP="$T/srv/ghost-protocol/inst"
    UNITS="$T/etc/systemd/system"
}
# XENV: more environment for the next runs (NAME=value words); empty by default.
XENV=()
ks() {   # setup options...
    t_env GP_ETC="$T/etc" GP_OPT="$T/opt" GP_SRV="$T/srv" GP_RUN="$T/run" GP_VARLIB="$T/varlib" GP_PROC_SYS="$T/procsys" \
        ${XENV[@]+"${XENV[@]}"} "$SETUP" --name inst --agent-user agent --yes "$@" >"$OUT" 2>&1
    RC=$?
}
# The key on stdin, from a file: a pipe would run ks in a subshell, and lose RC.
install_ks() { printf '%s\n' "$STANDIN" >"$T/key-in"; ks --settings "$SETTINGS" --key-from-stdin --apply "$@" <"$T/key-in"; }
mode_of() { stat -c '%a' "$1"; }
nothing_written() { [ ! -e "$T/opt" ] && [ ! -e "$T/srv" ] && [ ! -e "$T/etc/ghost-protocol" ] && [ -z "$(ls -A "$UNITS")" ]; }
refused() {   # name pattern
    check "$1: refused (exit 1)" rc_is 1
    check "$1: says why" out_has "$2"
    check "$1: nothing written" nothing_written
    check "$1: no user made" not_called useradd
}

# 1. Usage.
setup
t_env "$SETUP" --agent-user agent >"$OUT" 2>&1; RC=$?
check "usage: --name is required (exit 2)" rc_is 2
t_env "$SETUP" --name inst >"$OUT" 2>&1; RC=$?
check "usage: --agent-user is required (exit 2)" rc_is 2
t_env "$SETUP" --name Bad_Name --agent-user agent >"$OUT" 2>&1; RC=$?
check "usage: a name that is not lower-case letters, digits and dashes (exit 2)" rc_is 2
t_env "$SETUP" --name inst --agent-user agent --key-generate --key-from-stdin >"$OUT" 2>&1; RC=$?
check "usage: one way to the key (exit 2)" rc_is 2
t_env "$SETUP" --name inst --agent-user agent --rollback --commit "$C1" >"$OUT" 2>&1; RC=$?
check "usage: --rollback takes no --commit (exit 2)" rc_is 2
t_env "$SETUP" --name "$(printf 'n%.0s' $(seq 30))" --agent-user agent >"$OUT" 2>&1; RC=$?
check "usage: a name whose key's user would be over 32 characters (exit 2)" rc_is 2
# --key-from-stdin with a terminal on stdin: refused before anything (a key
# typed there shows on the screen). The terminal is a pseudo-terminal.
setup
t_env python3 -I -c 'import os, subprocess, sys
m, s = os.openpty()
sys.exit(subprocess.run(sys.argv[1:], stdin=s, timeout=120).returncode)' \
    "$SETUP" --name inst --agent-user agent --settings "$SETTINGS" --key-from-stdin >"$OUT" 2>&1; RC=$?
check "usage: --key-from-stdin from a terminal (exit 2)" rc_is 2
check "usage: --key-from-stdin from a terminal: says why" out_has 'never from a terminal'
# Test mode (GP_TEST=1) never with the real folders, and an --apply in test
# mode with no folders of its own fails, never passes as a SKIP.
for v in GP_ETC=/etc GP_ETC=//etc/ GP_OPT=/opt GP_SRV=/srv/ GP_VARLIB=/var/lib GP_RUN=/run GP_PROC_SYS=/proc/sys; do
    setup
    XENV=("$v")
    printf '%s\n' "$STANDIN" >"$T/key-in"
    ks --settings "$SETTINGS" --key-from-stdin <"$T/key-in"
    XENV=()
    check "test mode with $v: refused (exit 1)" rc_is 1
    check "test mode with $v: says why" out_has "TEST MODE \\(GP_TEST=1\\) with the real /"
done
setup
t_env "$SETUP" --name inst --agent-user agent --settings "$SETTINGS" --key-generate --apply >"$OUT" 2>&1; RC=$?
check "test mode with no folders, --apply: FAIL (exit 1)" rc_is 1
check "test mode with no folders, --apply: says so" out_has 'FAIL +keyservice +test mode without GP_ETC, GP_OPT and GP_SRV'
t_env "$SETUP" --name inst --agent-user agent --settings "$SETTINGS" --key-generate >"$OUT" 2>&1; RC=$?
check "test mode with no folders, a dry run: SKIP (exit 0)" sh -c "[ $RC = 0 ] && grep -qE 'SKIP +keyservice +test mode without' '$OUT'"

# 2. A dry run on a ready machine: READY, every file in full, nothing written.
setup
printf '%s\n' "$STANDIN" >"$T/key-in"
ks --settings "$SETTINGS" --key-from-stdin <"$T/key-in"
check "dry run: exit 0" rc_is 0
check "dry run: READY" out_has '^READY$'
check "dry run: the key's user would be made, a system user with no shell" out_has 'would run: useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin'
check "dry run: buzz.env in full" out_has '\| BUZZ_RELAY_URL=https://relay.example.com'
check "dry run: each unit in full" sh -c "grep -c 'would write .*/gp-key-inst-' '$OUT' | grep -qx 6"
check "dry run: the key is never printed, nor read" out_lacks "$STANDIN"
check "dry run: nothing written" nothing_written
check "dry run: no user made" not_called useradd
check "dry run: nothing enabled" not_called "systemctl enable"
check "dry run: no key file asked for" sh -c "! grep -q '^node keyfile' '$T/state/calls'"
check "dry run: files/ holds the session's files, never an allowlist" sh -c "grep -q 'files/ .*the outbox.s copy step puts the session.s files here, so nothing in it is trusted (never an allowlist)' '$OUT' && ! grep -q \"the key's user's alone\" '$OUT'"

# 3. The checks: each refuses before anything changes.
for g in sudo docker lxd incus-admin incus microk8s disk staff; do
    setup
    sed -i.bak "s/^$g:x:\\([0-9]*\\):\\(.*\\)$/$g:x:\\1:agent/" "$T/state/group"
    install_ks
    refused "the agent user in group $g" "the agent user agent is in the group $g, which makes it root-equivalent"
done
setup
sed -i.bak 's/^agent:x:4242:4242:/agent:x:4242:27:/' "$T/state/passwd"
install_ks
refused "the agent user's primary group is sudo" "is in the group sudo"
setup
touch "$T/state/runuser.agent.sudo-n"
install_ks
refused "the agent user can run sudo -n" "can run sudo -n true: it is root without a password"
setup
printf 'User agent may run the following commands on stub:\n    (ALL : ALL) ALL\n' >"$T/state/sudo.list.agent"
install_ks
refused "the agent user may run sudo (with a password)" "may run sudo \\(sudo -l -U agent lists commands\\)"
# A long sudo -l listing is read in full: a pipe into grep -q, under
# pipefail, loses the match whenever grep stops reading first.
long_list() {   # first lines (the match), then 100000 more
    { printf '%s\n' "$@"; yes '    (ALL) /bin/true' | head -n 100000; } >"$T/state/sudo.list.agent"
}
setup
long_list 'User agent may run the following commands on stub:'
install_ks
refused "a long sudo -l listing: its sudo rights are found" "may run sudo \\(sudo -l -U agent lists commands\\)"
setup
long_list 'User agent may run the following commands on stub:' '    (ALL) NOPASSWD: /usr/bin/systemctl'
install_ks --agent-sudo password
refused "a long sudo -l listing with NOPASSWD: found, even with --agent-sudo password" "may run sudo with no password"
setup
printf 'User agent may run the following commands on stub:\n    (ALL : ALL) ALL\n' >"$T/state/sudo.list.agent"
# sudo -l in another language: the setup asks in the C locale, or it would
# read no rights at all.
XENV=(LC_ALL=de_DE.UTF-8)
install_ks
XENV=()
refused "sudo -l asked in the C locale (the caller's is German)" "may run sudo \\(sudo -l -U agent lists commands\\)"
# --agent-sudo password: allowed only when sudo caches no ticket for the agent
# user (timestamp_timeout=0, from sudo -l's Defaults), and always reported as
# root-equivalent.
sudo_list_with() {   # Defaults lines (indented, as sudo -l prints them), or none
    {
        if [ $# -gt 0 ]; then printf 'Matching Defaults entries for agent on stub:\n'; printf '%s\n' "$@"; printf '\n'; fi
        printf 'User agent may run the following commands on stub:\n    (ALL : ALL) ALL\n'
    } >"$T/state/sudo.list.agent"
}
install_ks --agent-sudo password
refused "--agent-sudo password, sudo caching tickets (no timestamp_timeout)" "needs sudo to cache no ticket for agent: sudo -l -U agent shows timestamp_timeout=<not set>, not 0"
sudo_list_with '    env_reset, mail_badpass, timestamp_timeout=15'
install_ks --agent-sudo password
refused "--agent-sudo password, timestamp_timeout=15" "shows timestamp_timeout=15, not 0"
sudo_list_with '    env_reset, timestamp_timeout=-1'
install_ks --agent-sudo password
refused "--agent-sudo password, tickets that never expire (timestamp_timeout=-1)" "shows timestamp_timeout=-1, not 0"
install_ks --agent-sudo password --accept-root-equivalent-agent
refused "--accept-root-equivalent-agent does not lift timestamp_timeout" "shows timestamp_timeout=-1, not 0"
sudo_list_with '    env_reset, mail_badpass, secure_path=/usr/sbin\:/usr/bin,' '    timestamp_timeout=0, use_pty'
install_ks --agent-sudo password
check "sudo with a password, timestamp_timeout=0 (on a wrapped line), --agent-sudo password: installed" rc_is 0
check "--agent-sudo password: a warning says it is root-equivalent" out_has 'WARNING: the agent user agent is root-equivalent: it may run sudo with its password'
check "--agent-sudo password: the password is never typed in the agent user's sessions" out_has 'must never be typed in any session of agent'
check "--agent-sudo password: never reported as unable to become root" sh -c "! grep -q 'cannot become root' '$OUT' && grep -q 'CAN become root with its password' '$OUT'"
setup
sed -i.bak 's/^sudo:x:27:\(.*\)$/sudo:x:27:\1,agent/' "$T/state/group"
install_ks --agent-sudo password
refused "in the sudo group, --agent-sudo password, no timestamp_timeout" "needs sudo to cache no ticket for agent"
sudo_list_with '    timestamp_timeout=0'
install_ks --agent-sudo password
check "in the sudo group, sudo with a password, timestamp_timeout=0, --agent-sudo password: installed" rc_is 0
check "in the sudo group, --agent-sudo password: the root-equivalent warning" out_has 'WARNING: the agent user agent is root-equivalent'
setup
sed -i.bak 's/^sudo:x:27:\(.*\)$/sudo:x:27:\1,agent/' "$T/state/group"
sed -i.bak 's/^docker:x:998:$/docker:x:998:agent/' "$T/state/group"
sudo_list_with '    timestamp_timeout=0'
install_ks --agent-sudo password
refused "--agent-sudo password still refuses docker" "the agent user agent is in the group docker"
setup
printf 'User agent may run the following commands on stub:\n    (ALL : ALL) NOPASSWD: ALL\n' >"$T/state/sudo.list.agent"
install_ks --agent-sudo password
refused "passwordless sudo, even with --agent-sudo password" "may run sudo with no password"
# Every timestamp_timeout in the listing that applies to the agent user, a
# Runas or command default too, must be 0; a Defaults>root one is not the
# user's own.
sudo_listing() {   # the whole listing
    printf '%s\n' "$@" >"$T/state/sudo.list.agent"
}
setup
sudo_listing 'Matching Defaults entries for agent on stub:' '    env_reset, timestamp_timeout=0' '' \
    'Runas and Command-specific defaults for agent:' '    Defaults>root timestamp_timeout=15' '' \
    'User agent may run the following commands on stub:' '    (ALL) ALL'
install_ks --agent-sudo password
refused "--agent-sudo password, timestamp_timeout=15 for running as root (Defaults>root)" "shows timestamp_timeout=15 in a Runas or command default"
setup
sudo_listing 'Matching Defaults entries for agent on stub:' '    env_reset, timestamp_timeout=0' '' \
    'Runas and Command-specific defaults for agent:' '    Defaults!/usr/bin/vi timestamp_timeout=-1, env_keep+=HOME' '' \
    'User agent may run the following commands on stub:' '    (ALL) ALL'
install_ks --agent-sudo password
refused "--agent-sudo password, a command default that never expires" "shows timestamp_timeout=-1 in a Runas or command default"
setup
sudo_listing 'Matching Defaults entries for agent on stub:' '    env_reset' '' \
    'Runas and Command-specific defaults for agent:' '    Defaults>root timestamp_timeout=0' '' \
    'User agent may run the following commands on stub:' '    (ALL) ALL'
install_ks --agent-sudo password
refused "--agent-sudo password, timestamp_timeout=0 only for running as root" "shows timestamp_timeout=<not set>, not 0"
setup
sudo_listing 'Matching Defaults entries for agent on stub:' '    env_reset, timestamp_timeout=0, timestamp_timeout=15' '' \
    'User agent may run the following commands on stub:' '    (ALL) ALL'
install_ks --agent-sudo password
refused "--agent-sudo password, timestamp_timeout=0 then 15" "shows timestamp_timeout=15, not 0"
setup
sudo_listing 'Matching Defaults entries for agent on stub:' '    env_reset, timestamp_timeout=0' '' \
    'Runas and Command-specific defaults for agent:' '    Defaults!/usr/bin/foo !authenticate' '' \
    'User agent may run the following commands on stub:' '    (ALL) ALL'
install_ks --agent-sudo password
refused "--agent-sudo password, !authenticate in a command default" "may run sudo with no password"
setup
sudo_listing 'User agent may run the following commands on stub:' '    (ALL) NOPASSWD:ALL'
install_ks --agent-sudo password
refused "--agent-sudo password, NOPASSWD:ALL with no space" "may run sudo with no password"
setup
sudo_listing 'Matching Defaults entries for agent on stub:' '    env_reset, timestamp_timeout=0' '' \
    'Runas and Command-specific defaults for agent:' '    Defaults>root timestamp_timeout=0' '' \
    'User agent may run the following commands on stub:' '    (ALL) ALL'
install_ks --agent-sudo password
check "--agent-sudo password, every timestamp_timeout 0: installed" rc_is 0
# sudo -l must answer one way or the other: anything else is no answer.
setup
sudo_listing 'sudo: parse error in /etc/sudoers near line 12' 'sudo: unable to initialize policy plugin'
install_ks
refused "sudo -l that answers neither way" "could not read what sudo allows the agent user agent"
setup
: >"$T/state/sudo.list.agent"
install_ks
refused "sudo -l that prints nothing" "could not read what sudo allows the agent user agent"
setup
touch "$T/state/sudo.none"
install_ks
check "no sudo on this machine at all: installed" rc_is 0
setup
mkdir -p "$T/etc/rootfs/var/run"; : >"$T/etc/rootfs/var/run/docker.sock"
echo "w $T/etc/rootfs/var/run/docker.sock" >"$T/state/runuser.agent.can"
install_ks
refused "the agent user can write docker's socket" "can write .*docker.sock, a container engine's socket"
setup
mkdir -p "$T/etc/rootfs/var/lib/incus"; : >"$T/etc/rootfs/var/lib/incus/unix.socket"
echo "w $T/etc/rootfs/var/lib/incus/unix.socket" >"$T/state/runuser.agent.can"
install_ks
refused "the agent user can write incus's socket" "can write .*incus/unix.socket, a container engine's socket"
# The real sockets are asked about too, in a test as in a real run: a
# test's stand-in root comes on top of them, never instead.
real_sock=""
for s in /var/run/docker.sock /run/docker.sock /run/containerd/containerd.sock /run/podman/podman.sock; do
    [ -e "$s" ] && { real_sock="$s"; break; }
done
if [ -n "$real_sock" ]; then
    setup
    echo "w $real_sock" >"$T/state/runuser.agent.can"
    install_ks
    refused "the agent user can write this machine's own $real_sock" "can write $real_sock, a container engine's socket"
else
    echo "SKIP  the real engine sockets (none on this machine)"
fi
# A group only id knows (a directory service's, which getent group does not
# list): the groups come from id -Gn.
setup
echo "docker:998" >"$T/state/id.extra.agent"
install_ks
refused "the agent user in docker through a directory service only" "the agent user agent is in the group docker"
# doas: a permit rule for the agent user, or a group it is in.
doas_world() {   # doas.conf lines...
    setup
    mkdir -p "$T/etc/rootfs/etc"; printf '%s\n' "$@" >"$T/etc/rootfs/etc/doas.conf"; chmod 0600 "$T/etc/rootfs/etc/doas.conf"
}
doas_world 'permit persist agent as root'
install_ks
refused "doas: permit agent" "may run doas \\(.*doas.conf: permit persist agent as root\\)"
doas_world 'permit nopass setenv { PATH } :agent'
install_ks
refused "doas: permit the agent's group, setenv { } skipped" "may run doas .*permit nopass setenv \\{ PATH \\} :agent"
doas_world "permit nopass \\" '    keepenv agent cmd /usr/bin/true'
install_ks
refused "doas: a rule continued on the next line" "may run doas"
doas_world '# permit agent' 'permit :wheel' 'permit nopass other as root'
install_ks
check "doas: rules for others only, and a comment: installed" rc_is 0
setup
echo "other:x:4243:4242::/home/other:/bin/bash" >>"$T/state/passwd"
install_ks
refused "another user in the agent user's group" "the agent user's group agent also holds other"
setup
sed -i.bak 's/^agent:x:4242:/agent:x:4242:other/' "$T/state/group"
install_ks
refused "a member listed in the agent user's group" "the agent user's group agent also holds other"
setup
t_env GP_ETC="$T/etc" GP_OPT="$T/opt" GP_SRV="$T/srv" GP_PROC_SYS="$T/procsys" "$SETUP" --name inst --agent-user "$ME" --yes \
    --settings "$SETTINGS" --key-generate --apply >"$OUT" 2>&1; RC=$?
refused "the agent user is the admin" "is the user running this"
setup
echo 0 >"$T/procsys/fs/protected_symlinks"
install_ks
refused "fs.protected_symlinks off" "fs.protected_symlinks is 0, not 1"
setup
echo 0 >"$T/procsys/fs/protected_hardlinks"
install_ks
refused "fs.protected_hardlinks off" "fs.protected_hardlinks is 0, not 1"
setup
echo 252 >"$T/state/systemd.version"
install_ks
refused "systemd 252" "systemd 252 is too old"
setup
: >"$UNITS/inst-automode-guard.service"
install_ks
check "the auto-mode guard installed: refused (exit 1)" rc_is 1
check "the auto-mode guard installed: says why" out_has 'the auto-mode guard is installed for inst'
setup
chmod 0757 "$T/home/.cache/ghost-protocol/buzz"
install_ks
refused "a buzz-mcp build anyone can change" "the buzz-mcp build('s commit file)? could be changed by the agent user .*can be written by everyone"
setup
chmod 0775 "$T/home/.cache/ghost-protocol/buzz"
install_ks
refused "a buzz-mcp build whose folder its group can change (a group the agent user is not in)" "the buzz-mcp build('s commit file)? could be changed by the agent user .*can be written by its group \\(gid [0-9]+\\), or through an ACL entry"
setup
echo "0000000000000000000000000000000000000000" >"$B/buzz-mcp.commit"
install_ks
refused "a buzz-mcp build of another pin" "not the pin of $C1"
setup
echo "BUZZ_PRIVATE_KEY=$STANDIN" >>"$SETTINGS"
install_ks
refused "a key in the settings" "BUZZ_PRIVATE_KEY never goes into the settings"
check "a key in the settings: it is not printed" out_lacks "$STANDIN"
setup
echo "BUZZ_RELAY_URL=http://plain.example.com" >"$SETTINGS"; echo "BUZZ_CHANNELS=abc" >>"$SETTINGS"
install_ks
refused "a relay that is not https or wss" "BUZZ_RELAY_URL must be https:// or wss://"
setup
echo "BUZZ_TASK_ROOTS=yes" >>"$SETTINGS"
install_ks
refused "a task roots setting that is not on or off" "BUZZ_TASK_ROOTS must be on or off"
setup
echo "BUZZ_TASK_OPEN_EMOJI=Open,Loop" >>"$SETTINGS"
install_ks
refused "a task emoji of the wrong form" "BUZZ_TASK_OPEN_EMOJI must be a custom emoji's name"
setup
echo "BUZZ_TASK_OPEN_EMOJI=open-loop" >>"$SETTINGS"
install_ks
refused "a custom task emoji without its image" "BUZZ_TASK_OPEN_EMOJI names a custom emoji: give its image as BUZZ_TASK_OPEN_EMOJI_URL"
setup
echo "BUZZ_TASK_DONE_EMOJI_URL=http://media.example.com/done.gif" >>"$SETTINGS"
install_ks
refused "a task emoji image that is not https" "BUZZ_TASK_DONE_EMOJI_URL must be an https:// URL"
setup
printf 'BUZZ_TASK_ROOTS=on\nBUZZ_TASK_OPEN_EMOJI=open-loop\nBUZZ_TASK_OPEN_EMOJI_URL=https://media.example.com/open.gif\nBUZZ_TASK_DONE_EMOJI=✅\n' >>"$SETTINGS"
printf '%s\n' "$STANDIN" >"$T/key-in"
ks --settings "$SETTINGS" --key-from-stdin <"$T/key-in"
check "the DM task roots settings: a dry run, READY" sh -c "[ $RC = 0 ] && grep -q '^READY\$' '$OUT'"
check "the DM task roots settings: accepted, and in buzz.env" sh -c "grep -q '| BUZZ_TASK_ROOTS=on' '$OUT' && grep -q '| BUZZ_TASK_OPEN_EMOJI_URL=https://media.example.com/open.gif' '$OUT' && grep -q '| BUZZ_TASK_DONE_EMOJI=✅' '$OUT'"
setup
echo "BUZZ_ALLOWLIST_FILE=/home/agent/allow.json" >>"$SETTINGS"
install_ks
refused "an allowlist in a home folder" "BUZZ_ALLOWLIST_FILE is under /home"
check "an allowlist in a home folder: points at a root-owned place" out_has "put it where only root writes, for example $ETC_GP/allowlist.json"
setup
ks --settings "$SETTINGS" --apply
refused "no key" "give the key with --key-from-stdin, or make one with --key-generate"
setup
sed -i.bak 's/^agent:x:4242:4242:/agent:x:0:0:/' "$T/state/passwd"
install_ks
refused "the agent user is root" "the agent user agent is root"
setup
for g in sudo docker; do sed -i.bak "s/^$g:x:\\([0-9]*\\):\\(.*\\)$/$g:x:\\1:agent/" "$T/state/group"; done
install_ks --accept-root-equivalent-agent
check "--accept-root-equivalent-agent: installed (exit 0)" rc_is 0
check "--accept-root-equivalent-agent: a warning names the group" out_has 'WARNING: the agent user agent is in the group docker'
check "--accept-root-equivalent-agent: a warning names the risk" out_has 'anything the agent user runs as root still reaches it'

# 3b. The allowlist decides who can instruct the agent: the agent user must not
#     be able to change it, and it is named by its real path.
allow_world() {   # where (a folder under $T/etc), file mode
    setup
    AL="$T/etc/$1/allow.json"
    mkdir -p "$T/etc/$1"
    printf '{"entries": []}\n' >"$AL"; chmod "$2" "$AL"
    echo "BUZZ_ALLOWLIST_FILE=$AL" >>"$SETTINGS"
}
allow_world open 0644; chmod 0777 "$T/etc/open"
install_ks
refused "an allowlist in a folder anyone can write" "the allowlist file decides who can instruct the agent, and the agent user could change it"
check "an allowlist the agent could change: points at a root-owned place" out_has "for example $ETC_GP/allowlist.json"
allow_world allow 0646
install_ks
refused "an allowlist anyone can write" "the agent user could change it \\(.*allow.json can be written by everyone\\)"
if t_tool setfacl && t_tool getfacl; then
    allow_world acl 0644
    if setfacl -m u:4242:rw "$AL" 2>/dev/null; then
        install_ks
        refused "an allowlist an ACL entry lets the agent user write" "the agent user could change it \\(.*allow.json can be written by its group \\(gid [0-9]+\\), or through an ACL entry\\)"
    else
        echo "SKIP  an allowlist an ACL entry lets the agent user write (this filesystem takes no ACLs)"
    fi
else
    echo "SKIP  an allowlist an ACL entry lets the agent user write (no setfacl here)"
fi
allow_world allow 0644; rm "$AL"
install_ks
refused "an allowlist that is not there" "the allowlist file .*allow.json is not there"
allow_world allow 0644; mv "$AL" "$T/etc/allow/real.json"; ln -s "$T/etc/allow/real.json" "$AL"
install_ks
refused "an allowlist reached through a link" "the allowlist file .*allow.json is reached through a link"
# Root's alone: the file and every folder above it (here, up to the test's
# stand-in for /etc). One outside them is owned by the test's user only up to
# its own folders: not root's.
setup
mkdir -p "$T/other"; printf '{"entries": []}\n' >"$T/other/allow.json"; chmod 0644 "$T/other/allow.json"
echo "BUZZ_ALLOWLIST_FILE=$T/other/allow.json" >>"$SETTINGS"
install_ks
refused "an allowlist that is not root's alone" "the allowlist file .*other/allow.json, or a folder above it, is not root's alone"
# Never in the key service's shared folders (the reviewer's route: the session
# puts allow.json in its outbox, and the copy step renames it over
# files/allow.json) or its state folders, whatever their owners.
setup
install_ks
printf '{"entries": []}\n' >"$SRV_GP/files/allow.json"; chmod 0644 "$SRV_GP/files/allow.json"
echo "BUZZ_ALLOWLIST_FILE=$SRV_GP/files/allow.json" >>"$SETTINGS"
ks --settings "$SETTINGS" --apply
check "an allowlist in files/: refused (exit 1)" rc_is 1
check "an allowlist in files/: says why" out_has "the allowlist file .*files/allow.json is in the key service's shared or state folders"
check "an allowlist in files/: the settings are not changed" sh -c "! grep -q BUZZ_ALLOWLIST_FILE '$ETC_GP/buzz.env'"
mkdir -p "$SRV_GP/outbox"; printf '{"entries": [{"pubkey": "%s"}]}\n' "$(printf '%064d' 0 | tr 0 e)" >"$SRV_GP/outbox/allow.json"
touch -d '-1 min' "$SRV_GP/outbox/allow.json"
python3 -I -B "$SRC/install/keyservice/outbox-copy" "$SRV_GP/outbox" "$SRV_GP/files" >/dev/null 2>&1
check "the route it closes: a file the session puts in the outbox replaces files/ of that name" grep -q eeeeee "$SRV_GP/files/allow.json"
for sub in /srv/ghost-protocol/other/files /varlib/ghost-protocol-key/inst; do
    setup
    d="$T$sub"
    mkdir -p "$d"; printf '{"entries": []}\n' >"$d/allow.json"; chmod 0644 "$d/allow.json"
    echo "BUZZ_ALLOWLIST_FILE=$d/allow.json" >>"$SETTINGS"
    install_ks
    # (Its folder is the test's own, so "nothing written" is: no code, no units, no user.)
    check "an allowlist in $sub: refused (exit 1)" rc_is 1
    check "an allowlist in $sub: says why" out_has "is in the key service's shared or state folders"
    check "an allowlist in $sub: nothing installed" sh -c "[ ! -e '$T/opt' ] && [ -z \"\$(ls -A '$UNITS')\" ]"
    check "an allowlist in $sub: no user made" not_called useradd
done
# A sender allowlist is required, unless --no-sender-allowlist says otherwise.
setup
sed -i.bak '/^BUZZ_ALLOWED_PUBKEYS=/d' "$SETTINGS"
install_ks
refused "no sender allowlist" "the settings set no sender allowlist"
echo "BUZZ_TRUSTED_PUBKEYS=$(printf '%064d' 0 | tr 0 b)" >>"$SETTINGS"
install_ks
refused "only trusted keys (which turn no allowlist on)" "the settings set no sender allowlist"
install_ks --no-sender-allowlist
check "--no-sender-allowlist: installed" rc_is 0
check "--no-sender-allowlist: a warning says anyone reaches the session" out_has 'WARNING: --no-sender-allowlist: no sender allowlist'
setup
allow_world allow 0644
sed -i.bak '/^BUZZ_ALLOWED_PUBKEYS=/d' "$SETTINGS"
echo "r $AL" >"$T/state/runuser.gp-key-inst.can"
install_ks
check "an allowlist file alone is a sender allowlist: installed" rc_is 0
check "an allowlist file alone: no warning about none" out_lacks 'no-sender-allowlist'
allow_world allow 0644
echo "r $AL" >"$T/state/runuser.gp-key-inst.can"
install_ks
check "a root-owned allowlist: installed" rc_is 0
check "a root-owned allowlist: in buzz.env" grep -qx "BUZZ_ALLOWLIST_FILE=$AL" "$ETC_GP/buzz.env"
check "a root-owned allowlist: the agent user is asked whether it writes it" grep -qx "runuser agent test -w $AL" "$T/state/calls"
check "a root-owned allowlist the key's user reads: no warning" out_lacks 'cannot read the allowlist'
allow_world allow 0644
install_ks
check "an allowlist the key's user cannot read: a warning" out_has "WARNING: gp-key-inst cannot read the allowlist $AL"
allow_world allow 0644
echo "w $AL" >"$T/state/runuser.agent.can"
install_ks
check "the agent user can write the allowlist: FAIL (exit 1)" rc_is 1
check "the agent user can write the allowlist: says so" out_has "agent can write $AL"
check "the agent user can write the allowlist: nothing listens" [ ! -f "$T/state/keyunit.gp-key-inst-channel.socket.active" ]

# 3c. Inputs are checked, then copied at once, and only the copy is used: a
#     link on the way in a folder the agent user could change is refused, and
#     a file changed after the check never reaches the install.
good_tag() { printf '["auth","%s","","%s"]\n' "$(printf '%064d' 0 | tr 0 "$1")" "$(printf '%0128d' 0 | tr 0 d)"; }
setup
mkdir -p "$T/open"; chmod 0777 "$T/open"
good_tag c >"$T/tag.json"; ln -s "$T/tag.json" "$T/open/tag.json"
install_ks --tag "$T/open/tag.json"
refused "a tag through a link in a folder anyone can write" "the tag file: .*open/tag.json is a link in .*open, a folder the agent user can change"
setup
mkdir -p "$T/grp"; chmod 0775 "$T/grp"
good_tag c >"$T/tag.json"; ln -s "$T/tag.json" "$T/grp/tag.json"
install_ks --tag "$T/grp/tag.json"
refused "a tag through a link in a folder its group can write (a group the agent user is not in)" "the tag file: .*grp/tag.json is a link in .*grp, a folder the agent user can change"
setup
mkdir -p "$T/open"; chmod 0777 "$T/open"; ln -s "$SETTINGS" "$T/open/settings.env"
printf '%s\n' "$STANDIN" >"$T/key-in"
ks --settings "$T/open/settings.env" --key-from-stdin --apply <"$T/key-in"
refused "settings through a link in a folder anyone can write" "the settings file: .*open/settings.env is a link in"
setup
mkdir -p "$T/open"; chmod 0777 "$T/open"; ln -s "$B" "$T/open/buzz"
install_ks --buzz-mcp "$T/open/buzz/buzz-mcp.mjs"
refused "a buzz-mcp build through a linked folder anyone can write" "is a link in .*open, a folder the agent user can change"
setup
good_tag c >"$T/tag.json"
# While npm ci runs (after every check), both files change where they were checked.
good_tag e >"$T/tag-e.json"; printf 'swapped build\n' >"$T/swapped-build"
printf 'cp "%s" "%s"\ncp "%s" "%s"\n' "$T/swapped-build" "$B/buzz-mcp.mjs" "$T/tag-e.json" "$T/tag.json" >"$T/state/npm.hook"
install_ks --tag "$T/tag.json"
check "a swap after the check: installed" rc_is 0
check "a swap after the check: the buzz-mcp build is the one checked" sh -c "grep -qx 'stand-in buzz-mcp build' '$OPT/$C1/buzz-mcp/buzz-mcp.mjs' && grep -qx 'swapped build' '$B/buzz-mcp.mjs'"
check "a swap after the check: the tag is the one checked" sh -c "grep -q '\"$(printf '%064d' 0 | tr 0 c)\"' '$ETC_GP/auth-tag.json' && ! grep -q eeee '$ETC_GP/auth-tag.json'"
setup
chmod 0777 "$T/home"
install_ks
check "a work folder the agent user could change: refused (exit 1)" rc_is 1
check "a work folder the agent user could change: says why" out_has "this run's work folder .* could be changed by the agent user"
chmod 0755 "$T/home"

# 3d. A key's user that is there already must be a system user with no shell,
#     sharing no group with the agent user.
setup
echo "gp-key-inst:x:901:901:Ghost Protocol key service for inst:/nonexistent:/bin/bash" >>"$T/state/passwd"; echo "gp-key-inst:x:901:" >>"$T/state/group"
install_ks
refused "a key's user with a login shell" "the key's user gp-key-inst has a login shell"
setup
echo "gp-key-inst:x:901:901:Ghost Protocol key service for inst:/nonexistent:/usr/sbin/nologin" >>"$T/state/passwd"; echo "gp-key-inst:x:901:" >>"$T/state/group"
sed -i.bak 's/^systemd-journal:x:101:agent$/systemd-journal:x:101:agent,gp-key-inst/' "$T/state/group"
install_ks
refused "a key's user sharing a group with the agent user" "the key's user and the agent user share the group systemd-journal"
setup
echo "gp-key-inst:x:1901:1901:Ghost Protocol key service for inst:/nonexistent:/usr/sbin/nologin" >>"$T/state/passwd"; echo "gp-key-inst:x:1901:" >>"$T/state/group"
install_ks
refused "a key's user that is not a system user" "is there, but not a system user"
# A key's user made for another role or another instance (its comment says
# which) is never taken over; one with this instance's comment is.
setup
echo "gp-key-inst:x:901:901:Ghost Protocol GitHub App key for inst:/nonexistent:/usr/sbin/nologin" >>"$T/state/passwd"; echo "gp-key-inst:x:901:" >>"$T/state/group"
install_ks
refused "a key's user made for the GitHub App role" 'gp-key-inst is there, but it was not made by this setup for this role and this instance: its comment is "Ghost Protocol GitHub App key for inst", not "Ghost Protocol key service for inst"'
setup
echo "gp-key-inst:x:901:901:Ghost Protocol key service for other:/nonexistent:/usr/sbin/nologin" >>"$T/state/passwd"; echo "gp-key-inst:x:901:" >>"$T/state/group"
install_ks
refused "a key's user made for another instance" 'its comment is "Ghost Protocol key service for other"'
setup
echo "gp-key-inst:x:901:901:Ghost Protocol key service for inst:/nonexistent:/usr/sbin/nologin" >>"$T/state/passwd"; echo "gp-key-inst:x:901:" >>"$T/state/group"
install_ks
check "a key's user with this instance's comment: installed" rc_is 0
check "a key's user with this instance's comment: not made again" not_called useradd

# 3e. The instance's own unit runs as the agent user, and loads no Buzz or
#     Nostr credential (any case): systemd puts its credentials where the
#     agent user reads them. Nor does it set a BUZZ_* or NOSTR_* variable, or
#     have systemd read, as root, a file that could be the key. Names only
#     are printed, never a value.
unit_loaded() { touch "$T/state/unit-inst.service.loaded"; echo agent >"$T/state/unit-inst.service.user"; }
cred_world() {   # unit lines... (@T@ in them: this world's $T)
    local l
    setup
    unit_loaded
    {
        printf '# %s/systemd/system/inst.service\n[Service]\nExecStart=/bin/true\n' "$T/etc"
        for l in "$@"; do printf '%s\n' "${l//@T@/$T}"; done
    } >"$T/state/unit-inst.service.cat"
}
cred_world 'LoadCredential=buzz-private-key:/etc/credstore/inst-key'
install_ks
refused "the instance loads buzz-private-key" "inst.service hands the session a Buzz or Nostr credential or setting \\(LoadCredential=buzz-private-key\\)"
cred_world 'LoadCredential=op-sa-example:/etc/credstore/op' '# /etc/systemd/system/inst.service.d/keys.conf' '[Service]' 'SetCredential=NOSTR_SECRET:plainly-not-a-secret'
install_ks
refused "a drop-in sets NOSTR_SECRET (upper case)" "SetCredential=NOSTR_SECRET"
check "a credential's value is never printed" out_lacks 'plainly-not-a-secret'
cred_world 'ImportCredential=*'
install_ks
refused "the instance imports every credential" "ImportCredential=\\*"
cred_world 'ImportCredential=b*'
install_ks
refused "the instance imports b*" "ImportCredential=b\\*"
cred_world 'LoadCredential=op-sa-example:/etc/credstore/op' 'ImportCredential=op-sa-*' 'LoadCredentialEncrypted=api-token:/etc/credstore/t'
install_ks
check "other credentials (op-sa-*, an API token): installed" rc_is 0
cred_world
touch "$T/state/systemctl.fail-cat"
install_ks
refused "an instance unit that cannot be read" "could not read inst.service with systemctl cat"
# systemd reads "Key = value", and a line ending in a backslash goes on into
# the next; a comment line is skipped, whatever it ends with.
cred_world 'LoadCredential = buzz-private-key:/etc/credstore/k'
install_ks
refused "spaces around = (LoadCredential = buzz-private-key)" "LoadCredential=buzz-private-key"
cred_world 'LoadCredential= buzz-private-key:/etc/credstore/k'
install_ks
refused "a space after = (LoadCredential= buzz-private-key)" "LoadCredential=buzz-private-key"
cred_world 'SetCredential =NOSTR_SECRET:plainly-not-a-secret'
install_ks
refused "a space before = (SetCredential =NOSTR_SECRET)" "SetCredential=NOSTR_SECRET"
check "a space before =: the value never printed" out_lacks 'plainly-not-a-secret'
cred_world 'ImportCredential = *'
install_ks
refused "spaces around = (ImportCredential = *)" "ImportCredential=\\*"
# A byte-order mark systemd drops (the first, at the start of a line) hides
# no key; a line this check cannot read as systemd does is refused.
cred_world '[Service]' $'\357\273\277LoadCredential=buzz-private-key:/etc/credstore/k'
install_ks
refused "a byte-order mark before LoadCredential=" "LoadCredential=buzz-private-key"
cred_world '[Service]' $'Description=x\033[0m'
install_ks
refused "a control character in the instance unit" "inst.service or one of its drop-ins holds a line with a control character"
# A \002 at the start of a line is a control character here too (only the
# drop-in check's own file names start with one): it must not end a
# continued line, or the variable on it goes past the check.
cred_world '[Service]' "Environment=\\" $'\002 BUZZ_PRIVATE_KEY=x'
install_ks
refused "a continued line that goes on in a line starting with \\002" "inst.service or one of its drop-ins holds a line with a control character"
cred_world "LoadCredential=\\" '  buzz-private-key:/etc/credstore/k'
install_ks
refused "a credential on a continued line" "LoadCredential=.*buzz-private-key"
cred_world "# an old note \\" 'LoadCredential=buzz-private-key:/etc/credstore/k'
install_ks
refused "a comment ending in a backslash does not hide the next line" "LoadCredential=buzz-private-key"
# A file systemd reads as root (a credential's path, an environment file,
# standard input) in or above the key's folder, or one the agent user could
# point at it.
cred_world "LoadCredential=relay:@T@/etc/ghost-protocol/inst/buzz-key"
install_ks
refused "a credential read from the key's folder" "LoadCredential=relay:$T/etc/ghost-protocol/inst/buzz-key: it is in $T/etc/ghost-protocol, where the key file is"
cred_world "LoadCredential=relay:@T@/etc//ghost-protocol/./inst/buzz-key"
install_ks
refused "a credential read from the key's folder, written with // and /./" "it is in $T/etc/ghost-protocol, where the key file is"
cred_world "LoadCredential=all:@T@/etc"
install_ks
refused "a credential folder above the key's folder (read in full)" "it is a folder above $T/etc/ghost-protocol"
cred_world 'LoadCredential=root:/'
install_ks
refused "the whole disk as a credential folder" "LoadCredential=root:/: it is a folder above"
cred_world 'LoadCredential=relay:%E/ghost-protocol/inst/buzz-key'
install_ks
refused "a credential path with a systemd specifier" "it holds a systemd specifier"
cred_world "LoadCredential=token:@T@/shared/token"
mkdir -p "$T/shared"; chmod 0777 "$T/shared"; ln -s "$T/etc/ghost-protocol/inst/buzz-key" "$T/shared/token"
install_ks
refused "a credential that is a link to the key file" "LoadCredential=token:.*/shared/token: it is in $T/etc/ghost-protocol, where the key file is"
cred_world "LoadCredential=token:@T@/shared/token"
mkdir -p "$T/shared"; chmod 0777 "$T/shared"; printf 'an API token\n' >"$T/api-token"; ln -s "$T/api-token" "$T/shared/token"
install_ks
refused "a credential that is a link in a folder anyone can write" "could point it at the key file \\(.*/shared/token is a link in"
cred_world "LoadCredential=token:@T@/shared/token"
mkdir -p "$T/shared"; chmod 0757 "$T/shared"; printf 'an API token\n' >"$T/shared/token"
install_ks
refused "a credential in a folder anyone can write (a link could replace it)" "could put a link to the key file there \\(.*/shared can be written by everyone"
cred_world "LoadCredential=token:@T@/shared/later/token"
mkdir -p "$T/shared"; chmod 0775 "$T/shared"
install_ks
refused "a credential not there yet, under a folder its group can write" "could put a link to the key file there \\(.*/shared can be written by its group"
cred_world "StandardInput=file:@T@/etc/ghost-protocol/inst/buzz-key"
install_ks
refused "standard input read from the key file" "StandardInput=file:.*: it is in $T/etc/ghost-protocol"
cred_world "EnvironmentFile=-@T@/etc/ghost-protocol/inst/buzz-key"
install_ks
refused "an environment file in the key's folder" "EnvironmentFile=$T/etc/ghost-protocol/inst/buzz-key: it is in"
# Variables: the names only, never a value.
cred_world 'Environment=BUZZ_PRIVATE_KEY=plainly-not-a-secret'
install_ks
refused "Environment=BUZZ_PRIVATE_KEY" "Environment=BUZZ_PRIVATE_KEY"
check "Environment=BUZZ_PRIVATE_KEY: the value never printed" out_lacks 'plainly-not-a-secret'
cred_world 'Environment="LABEL=a b" nostr_secret=plainly-not-a-secret'
install_ks
refused "a lower-case nostr_ variable after a quoted one" "Environment=nostr_secret"
check "after a quoted one: the value never printed" out_lacks 'plainly-not-a-secret'
cred_world 'Environment = "BUZZ_RELAY_URL=wss://relay.example.com"'
install_ks
refused "a quoted BUZZ_ setting, spaces around =" "Environment=BUZZ_RELAY_URL"
cred_world 'PassEnvironment=PATH BUZZ_PRIVATE_KEY'
install_ks
refused "PassEnvironment=BUZZ_PRIVATE_KEY" "PassEnvironment=BUZZ_PRIVATE_KEY"
cred_world "EnvironmentFile=-@T@/etc/inst.env"
printf 'OTHER=1\n  export NOSTR_SECRET = plainly-not-a-secret\n' >"$T/etc/inst.env"; chmod 0600 "$T/etc/inst.env"
install_ks
refused "an environment file setting NOSTR_SECRET" "EnvironmentFile=$T/etc/inst.env:NOSTR_SECRET"
check "an environment file: the value never printed" out_lacks 'plainly-not-a-secret'
# The instance's own: an API token from the credential store, its settings.
cred_world 'Environment=HOME=/home/agent PATH=/usr/bin:/bin "LABEL=a b"' 'LoadCredentialEncrypted=api-token:/etc/credstore.encrypted/api-token' \
    "EnvironmentFile=-@T@/etc/inst.env" 'PassEnvironment=LANG' 'StandardInput=null'
printf 'OTHER=1\n' >"$T/etc/inst.env"
install_ks
check "the instance's own settings and API token: installed" rc_is 0
# The unit runs as the agent user.
cred_world
echo root >"$T/state/unit-inst.service.user"
install_ks
refused "an instance unit run as root" "inst.service runs as root, not as the agent user agent"
cred_world
rm -f "$T/state/unit-inst.service.user"
install_ks
refused "an instance unit with no User= (root)" "inst.service runs as root \\(no User=\\), not as the agent user agent"
cred_world
echo someone >"$T/state/unit-inst.service.user"
install_ks
refused "an instance unit run as another user" "inst.service runs as someone, not as the agent user agent"
cred_world
echo 4242 >"$T/state/unit-inst.service.user"
install_ks
check "an instance unit whose User= is the agent's uid: installed" rc_is 0
# Not installed yet: said, so it is checked by a later run.
setup
install_ks
check "no instance unit yet: installed" rc_is 0
check "no instance unit yet: a SKIP line says it was not checked" out_has 'SKIP +instance +inst.service is not installed yet'

# 3f. git: the code comes from a fresh copy of the commit, fetched from the
#     checkout, every object checked against its hash; never from another
#     object store, nor a repository the environment names.
setup
GPA="$T/gpa"; cp -a "$GPF" "$GPA"
git init -q --bare "$T/store.git"
echo "$T/store.git/objects" >"$GPA/.git/objects/info/alternates"
SETUP_WAS="$SETUP"; SETUP="$GPA/install/keyservice/setup"
install_ks
refused "a checkout with git alternates" "this checkout borrows objects from another store"
SETUP="$SETUP_WAS"
setup
XENV=(GIT_ALTERNATE_OBJECT_DIRECTORIES="$T/store.git/objects")
install_ks
XENV=()
refused "GIT_ALTERNATE_OBJECT_DIRECTORIES set" "GIT_ALTERNATE_OBJECT_DIRECTORIES is set in this environment"
setup
git init -q --bare "$T/elsewhere.git"
XENV=(GIT_DIR="$T/elsewhere.git")
install_ks
XENV=()
check "GIT_DIR set elsewhere: ignored, installed" rc_is 0
check "GIT_DIR set elsewhere: the checkout's commit" grep -qx "$C1" "$ETC_GP/commit"
# An object in the checkout whose content is not what its name says: git
# archive on the checkout would ship it; the fetch refuses it.
setup
GPA="$T/gpa"; cp -a "$GPF" "$GPA"
blob="$(git -C "$GPA" rev-parse "$C1:adapters/buzz/src/launch.mjs")"
obj="$GPA/.git/objects/${blob:0:2}/${blob:2}"
chmod u+w "$obj"
python3 -I -c 'import sys, zlib; d = b"console.log(\"not the commit\")\n"; open(sys.argv[1], "wb").write(zlib.compress(b"blob %d\0" % len(d) + d))' "$obj"
SETUP_WAS="$SETUP"; SETUP="$GPA/install/keyservice/setup"
install_ks
SETUP="$SETUP_WAS"
refused "an object that is not what its name says" "could not be fetched from .* where every object is checked against its hash"
# Inside the checkout: HEAD, the refs, the objects, the config, the setup's
# own folder. Nothing there a link (hooks aside: they never run), nor
# writable by a group or by others; no core.sharedRepository.
from_copy() {   # what the copy gets (sh, run in it), name, pattern
    setup
    GPA="$T/gpa"; cp -a "$GPF" "$GPA"
    (cd "$GPA" && sh -c "$1")
    SETUP_WAS="$SETUP"; SETUP="$GPA/install/keyservice/setup"
    install_ks
    SETUP="$SETUP_WAS"
    refused "$2" "$3"
}
from_copy 'chmod 0666 .git/HEAD' "a checkout whose HEAD anyone can write" "this checkout could be changed by the agent user: .*/gpa/.git/HEAD is a link, the agent user's, or writable"
from_copy 'chmod 0777 .git/refs/heads' "a checkout whose refs/heads anyone can write" "/gpa/.git/refs/heads is a link"
from_copy 'chmod 0775 .git/objects' "a checkout whose objects its group can write" "/gpa/.git/objects is a link"
from_copy 'git pack-refs --all && chmod 0664 .git/packed-refs' "a checkout whose packed-refs its group can write" "/gpa/.git/packed-refs is a link"
from_copy 'chmod 0646 .git/config' "a checkout whose config anyone can write" "/gpa/.git/config is a link"
from_copy 'echo x >.git/shallow; chmod 0666 .git/shallow' "a checkout whose shallow file anyone can write" "/gpa/.git/shallow is a link"
from_copy 'chmod g+w install/service/key-channel@.service' "a checkout whose unit template its group can write" "/gpa/install/service/key-channel@.service is a link"
from_copy 'ln -s /nonexistent .git/info/elsewhere' "a link inside the git folder" "/gpa/.git/info/elsewhere is a link"
from_copy 'git config core.sharedRepository group' "a checkout with core.sharedRepository=group" "sets core.sharedRepository=group"
check "the reason says how to fix a group-writable clone" out_has "chmod -R go-w .*/gpa"
setup
GPA="$T/gpa"; cp -a "$GPF" "$GPA"
mkdir -p "$T/hooks"; rm -rf "$GPA/.git/hooks"; ln -s "$T/hooks" "$GPA/.git/hooks"
git -C "$GPA" config core.sharedRepository umask
SETUP_WAS="$SETUP"; SETUP="$GPA/install/keyservice/setup"
install_ks
SETUP="$SETUP_WAS"
check "hooks a link (they never run), core.sharedRepository=umask: installed" rc_is 0
# A worktree: its own git folder, the common one, and its .git file.
setup
GPA="$T/gpa"; cp -a "$GPF" "$GPA"
git -C "$GPA" worktree add -q --detach "$T/wt" HEAD 2>/dev/null
chmod 0666 "$T/wt/.git"
SETUP_WAS="$SETUP"; SETUP="$T/wt/install/keyservice/setup"
install_ks
refused "a worktree whose .git file anyone can write" "/wt/.git is a link, the agent user's, or writable"
chmod 0644 "$T/wt/.git"; chmod 0666 "$GPA/.git/worktrees/wt/HEAD"
install_ks
refused "a worktree whose own HEAD anyone can write" "/gpa/.git/worktrees/wt/HEAD is a link"
chmod 0644 "$GPA/.git/worktrees/wt/HEAD"; chmod 0646 "$GPA/.git/config"
install_ks
refused "a worktree whose common config anyone can write" "/gpa/.git/config is a link"
chmod 0644 "$GPA/.git/config"
install_ks
SETUP="$SETUP_WAS"
check "a worktree of the admin's clone: installed" rc_is 0

# 4. An install.
setup
install_ks
check "install: exit 0" rc_is 0
check "install: the key's user made" called useradd
check "install: as a system user" grep -qx 'useradd flag --system' "$T/state/calls"
check "install: with no shell" grep -qx 'useradd flag --shell /usr/sbin/nologin' "$T/state/calls"
check "install: with no home" sh -c "grep -qx 'useradd flag --no-create-home' '$T/state/calls' && grep -qx 'useradd flag --home-dir /nonexistent' '$T/state/calls'"
check "install: the key's user is gp-key-inst" grep -q '^gp-key-inst:x:9[0-9][0-9]:' "$T/state/passwd"
check "install: the code at /opt/ghost-protocol/<commit>" [ -f "$OPT/$C1/adapters/buzz/src/launch.mjs" ]
check "install: with the adapter's dependencies" [ -f "$OPT/$C1/adapters/buzz/node_modules/nostr-tools/package.json" ]
check "install: with the buzz-mcp build" cmp -s "$B/buzz-mcp.mjs" "$OPT/$C1/buzz-mcp/buzz-mcp.mjs"
check "install: with a copy of node (the one given is not root's)" [ -x "$OPT/$C1/bin/node" ]
check "install: with the copy step" [ -f "$OPT/$C1/install/keyservice/outbox-copy" ]
check "install: nothing in the copy is writable by group or others" sh -c "[ -z \"\$(find '$OPT/$C1' -perm /022 ! -type l -print)\" ]"
check "install: the copy is given to root" grep -qx "chown -R root:root $OPT/.new-$C1" "$T/state/calls"
check "install: the key file, 0400" [ "$(mode_of "$ETC_GP/buzz-key")" = 400 ]
check "install: the key file holds the key from stdin" sh -c "[ \"\$(cat '$ETC_GP/buzz-key')\" = '$STANDIN' ]"
check "install: the key is never printed" out_lacks "$STANDIN"
check "install: the key's file is never given to another user" sh -c "! grep -q 'chown .*buzz-key' '$T/state/calls'"
check "install: the public key is printed" out_has "the agent's public key: a{64}"
check "install: buzz.env, 0644, with the settings" sh -c "[ \"\$(stat -c %a '$ETC_GP/buzz.env')\" = 644 ] && grep -qx 'BUZZ_RELAY_URL=https://relay.example.com' '$ETC_GP/buzz.env'"
check "install: buzz.env holds no key" sh -c "! grep -qE 'BUZZ_PRIVATE_KEY|BUZZ_KEY_COMMAND|$STANDIN' '$ETC_GP/buzz.env'"
check "install: the commit recorded" grep -qx "$C1" "$ETC_GP/commit"
check "install: no tag file without --tag" [ ! -e "$ETC_GP/auth-tag.json" ]
check "install: the shared folder, 0711" [ "$(mode_of "$SRV_GP")" = 711 ]
check "install: outbox 2770, the agent user's, the key's group" sh -c "[ \"\$(stat -c %a '$SRV_GP/outbox')\" = 2770 ] && grep -qx 'chown agent:gp-key-inst $SRV_GP/outbox' '$T/state/calls'"
check "install: files 2750, the key's user's, the agent's group" sh -c "[ \"\$(stat -c %a '$SRV_GP/files')\" = 2750 ] && grep -qx 'chown gp-key-inst:agent $SRV_GP/files' '$T/state/calls'"
check "install: media 2750, the key's user's, the agent's group" sh -c "[ \"\$(stat -c %a '$SRV_GP/media')\" = 2750 ] && grep -qx 'chown gp-key-inst:agent $SRV_GP/media' '$T/state/calls'"
check "install: six units" sh -c "[ \"\$(ls '$UNITS' | grep -c '^gp-key-inst-')\" = 6 ]"
check "install: the listeners enabled and started" sh -c "[ -f '$T/state/keyunit.gp-key-inst-channel.socket.active' ] && [ -f '$T/state/keyunit.gp-key-inst-buzz-mcp.socket.active' ] && [ -f '$T/state/keyunit.gp-key-inst-outbox.path.enabled' ]"
check "install: asked as the agent user whether it reads the key" grep -qx "runuser agent test -r $ETC_GP/buzz-key" "$T/state/calls"
check "install: asked as the key's user too" grep -qx "runuser gp-key-inst test -r $ETC_GP/buzz-key" "$T/state/calls"
check "install: asked whether the agent user writes the code" grep -qx "runuser agent test -w $OPT/$C1/adapters/buzz/src/launch.mjs" "$T/state/calls"
check "install: the instance is not restarted (its side is not switched yet)" sh -c "! grep -q 'systemctl try-restart' '$T/state/calls'"
check "install: says what the instance's side does next" out_has '"buzz_key_socket": ".*/run/ghost-protocol-key/inst"'
check "install: no temporary folder left" no_temp_left

# The code comes from the commit, never the working tree.
setup
echo "// an edit nobody committed" >>"$GPF/adapters/buzz/src/launch.mjs"
install_ks
check "a working-tree edit: installed" rc_is 0
check "a working-tree edit: does not reach the copy" sh -c "! grep -q 'an edit nobody committed' '$OPT/$C1/adapters/buzz/src/launch.mjs'"
git -C "$GPF" checkout -q -- adapters/buzz/src/launch.mjs

# 5. The kernel's answer after writing: if the agent user (or the key's user)
#    can read the key, it stops, and nothing listens.
for u in agent gp-key-inst; do
    setup
    echo "r $ETC_GP/buzz-key" >"$T/state/runuser.$u.can"
    install_ks
    check "$u can read the key: FAIL (exit 1)" rc_is 1
    check "$u can read the key: says so" out_has "$u can read the key file"
    check "$u can read the key: nothing listens" sh -c "[ ! -f '$T/state/keyunit.gp-key-inst-channel.socket.active' ] && [ ! -f '$T/state/keyunit.gp-key-inst-buzz-mcp.socket.active' ]"
done
setup
echo "w $OPT/$C1/adapters/buzz/src/launch.mjs" >"$T/state/runuser.agent.can"
install_ks
check "the agent user can write the code: FAIL (exit 1)" rc_is 1

# 6. The units.
setup
TAG="$T/tag.json"
printf '["auth","%s","","%s"]\n' "$(printf '%064d' 0 | tr 0 c)" "$(printf '%0128d' 0 | tr 0 d)" >"$TAG"
install_ks --tag "$TAG"
check "units (with a tag): installed" rc_is 0
check "units: the tag file, 0644" [ "$(mode_of "$ETC_GP/auth-tag.json")" = 644 ]
CH="$UNITS/gp-key-inst-channel@.service"; MCP="$UNITS/gp-key-inst-buzz-mcp@.service"; OB="$UNITS/gp-key-inst-outbox.service"
check "units: no placeholder left" sh -c "! grep -q '@[A-Z_]*@' '$UNITS'/gp-key-inst-*"
for u in "$CH" "$MCP" "$OB"; do
    n="${u##*/}"
    check "$n: runs as the key's user" sh -c "grep -qx 'User=gp-key-inst' '$u' && grep -qx 'Group=gp-key-inst' '$u'"
    for line in NoNewPrivileges=yes CapabilityBoundingSet= AmbientCapabilities= RestrictSUIDSGID=yes ProtectSystem=strict \
                ProtectHome=yes PrivateTmp=yes PrivateDevices=yes ProtectProc=invisible ProcSubset=pid LimitCORE=0 \
                ProtectKernelTunables=yes ProtectKernelModules=yes ProtectControlGroups=yes RestrictNamespaces=yes \
                LockPersonality=yes SystemCallArchitectures=native SystemCallFilter=@system-service KeyringMode=private; do
        check "$n: $line" grep -qxF "$line" "$u"
    done
    check "$n: no key or key command in its environment" sh -c "! grep -E '^Environment.*(BUZZ_PRIVATE_KEY|BUZZ_KEY_COMMAND|NOSTR_)' '$u'"
    check "$n: runs only the root-owned copy" grep -qE "^ExecStart=($OPT/$C1/bin/node --disable-sigusr1 $OPT/$C1/adapters/buzz/src/launch.mjs serve |/usr/bin/python3 -I -B $OPT/$C1/install/keyservice/outbox-copy )" "$u"
done
for u in "$CH" "$MCP"; do
    n="${u##*/}"
    check "$n: the key by OpenFile=, read-only" grep -qx "OpenFile=$ETC_GP/buzz-key:buzz-key:read-only" "$u"
    check "$n: the tag as a credential" grep -qx "LoadCredential=buzz-auth-tag:$ETC_GP/auth-tag.json" "$u"
    check "$n: node, OpenSSL and loader settings unset" grep -qx 'UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE NODE_COMPILE_CACHE LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT OPENSSL_CONF OPENSSL_MODULES OPENSSL_ENGINES' "$u"
    check "$n: the connection is its stdin and stdout" sh -c "grep -qx 'StandardInput=socket' '$u' && grep -qx 'StandardOutput=socket' '$u'"
    check "$n: the settings from buzz.env" grep -qx "EnvironmentFile=$ETC_GP/buzz.env" "$u"
done
check "outbox service: never given the key" sh -c "! grep -v '^#' '$OB' | grep -qE 'OpenFile|LoadCredential|buzz-key'"
check "outbox service: no network" grep -qx 'PrivateNetwork=yes' "$OB"
check "buzz-mcp: its files only from the files folder" sh -c "grep -qx 'Environment=BUZZ_MCP_ROOT=$SRV_GP/files' '$MCP' && grep -qx 'Environment=BUZZ_MCP_PATH=$OPT/$C1/buzz-mcp/buzz-mcp.mjs' '$MCP'"
check "buzz-mcp: media saved in the media folder" grep -qx "Environment=TMPDIR=$SRV_GP/media" "$MCP"
check "channel: the shared folders are not there at all" grep -qx "InaccessiblePaths=-$SRV_GP" "$CH"
check "channel: the lock on, the state in the key's state folder" sh -c "grep -qx 'Environment=BUZZ_CHANNEL_LOCK=on' '$CH' && grep -qx 'StateDirectory=ghost-protocol-key/inst' '$CH'"
for s in channel buzz-mcp; do
    f="$UNITS/gp-key-inst-$s.socket"
    check "$s socket: one process per connection" grep -qx 'Accept=yes' "$f"
    check "$s socket: root and the agent's group only" sh -c "grep -qx 'SocketUser=root' '$f' && grep -qx 'SocketGroup=agent' '$f' && grep -qx 'SocketMode=0660' '$f'"
    check "$s socket: at the run folder" grep -qx "ListenStream=$T/run/ghost-protocol-key/inst/$s.sock" "$f"
done
check "channel socket: one connection at a time" grep -qx 'MaxConnections=1' "$UNITS/gp-key-inst-channel.socket"
check "buzz-mcp socket: up to 8" grep -qx 'MaxConnections=8' "$UNITS/gp-key-inst-buzz-mcp.socket"
if command -v systemd-analyze >/dev/null 2>&1; then
    v="$(systemd-analyze --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
    if [ "${v:-0}" -ge 253 ] 2>/dev/null; then
        for u in "$CH" "$MCP" "$OB"; do
            check "${u##*/}: systemd-analyze knows every line" sh -c "! systemd-analyze verify --man=no '$u' 2>&1 | grep -E 'Unknown key|Unknown section|Failed to parse|Invalid'"
            # Its exposure score, 0 (none) to 10: at most 2.0 (threshold 20 is 2.0).
            check "${u##*/}: systemd-analyze security, exposure at most 2.0" \
                sh -c "systemd-analyze security --offline=yes --threshold=20 --no-pager '$u' >/dev/null 2>&1"
        done
    fi
fi

# 7. Again with nothing changed: OK, nothing made again, nothing restarted.
: >"$T/state/calls"
ks --apply
check "again: exit 0" rc_is 0
check "again: no user made" not_called useradd
check "again: nothing restarted" sh -c "! grep -q 'systemctl stop' '$T/state/calls'"
check "again: the key is not asked for" sh -c "! grep -qE '^node keyfile (write|generate)' '$T/state/calls'"
printf 'another\n' >"$T/key-in"
ks --key-from-stdin --apply <"$T/key-in"
check "a second key: refused (exit 1)" rc_is 1
check "a second key: says a key file is never replaced" out_has 'a key file is never replaced'
check "a second key: the first one stays" sh -c "[ \"\$(cat '$ETC_GP/buzz-key')\" = '$STANDIN' ]"
ks --commit "$(next_commit move)" --apply
check "another commit without --update: refused" sh -c "[ $RC = 1 ] && grep -q 'is an update: add --update' '$OUT'"
git -C "$GPF" reset -q --hard "$C1"

# 8. An update, a rollback, and the copies kept.
setup
install_ks
unit_loaded; touch "$T/state/unit-inst.service.active"
C2="$(next_commit two)"
: >"$T/state/calls"
ks --update --apply
check "update: exit 0" rc_is 0
check "update: the new copy" [ -f "$OPT/$C2/adapters/buzz/src/launch.mjs" ]
check "update: the units run it" grep -q "^ExecStart=$OPT/$C2/bin/node --disable-sigusr1 $OPT/$C2/adapters/buzz/src/launch.mjs serve channel\$" "$UNITS/gp-key-inst-channel@.service"
check "update: the commit and the one before recorded" sh -c "grep -qx '$C2' '$ETC_GP/commit' && grep -qx '$C1' '$ETC_GP/previous-commit'"
check "update: the old copy kept, for a rollback" [ -f "$OPT/$C1/COMMIT" ]
check "update: the open connections ended" sh -c "grep -qxF 'systemctl stop-pattern gp-key-inst-channel@*.service' '$T/state/calls' && grep -qxF 'systemctl stop-pattern gp-key-inst-buzz-mcp@*.service' '$T/state/calls'"
check "update: the listeners started again" grep -qx 'systemctl start: gp-key-inst-channel.socket in place' "$T/state/calls"
check "update: the whole instance restarted" [ "$(cat "$T/state/unit-inst.service.restarts" 2>/dev/null)" = 1 ]
check "update: the key kept" sh -c "[ \"\$(cat '$ETC_GP/buzz-key')\" = '$STANDIN' ]"
check "update: prints how to go back" out_has 'to go back: install/keyservice/setup --name inst --agent-user agent --rollback --apply'
: >"$T/state/calls"
ks --rollback --apply
check "rollback: exit 0" rc_is 0
check "rollback: the intact copy run as it is (no npm ci)" sh -c "! grep -q '^npm ci' '$T/state/calls' && grep -q 'is intact: it is run as it is' '$OUT'"
check "rollback: the units run the old commit" grep -q "^ExecStart=$OPT/$C1/bin/node " "$UNITS/gp-key-inst-channel@.service"
check "rollback: the commits swapped" sh -c "grep -qx '$C1' '$ETC_GP/commit' && grep -qx '$C2' '$ETC_GP/previous-commit'"
check "rollback: the instance restarted again" [ "$(cat "$T/state/unit-inst.service.restarts")" = 2 ]
ks --update --commit "$C1" --apply
check "an update to the commit it runs: nothing moves" sh -c "[ $RC = 0 ] && grep -q 'already runs $C1' '$OUT' && grep -qx '$C2' '$ETC_GP/previous-commit'"
check "an update to the commit it runs: no restart" [ "$(cat "$T/state/unit-inst.service.restarts")" = 2 ]
C3="$(next_commit three)"
ks --update --apply
check "a third commit: exit 0" rc_is 0
check "a third commit: the copy no instance needs is gone" sh -c "[ ! -e '$OPT/$C2' ] && [ -f '$OPT/$C1/COMMIT' ] && [ -f '$OPT/$C3/COMMIT' ]"
rm -rf "${OPT:?}/${C1:?}"
ks --rollback --apply
check "a rollback whose copy is gone: refused" sh -c "[ $RC = 1 ] && grep -q 'go back with --update --commit $C1 instead' '$OUT'"
git -C "$GPF" reset -q --hard "$C1"
setup
ks --update --apply
check "update with nothing installed: refused" sh -c "[ $RC = 1 ] && grep -q 'has no key service yet' '$OUT'"
ks --rollback --apply
check "rollback with nothing installed: refused" rc_is 1
# A rollback whose copy was changed: put together again from the commit.
setup
install_ks
C2="$(next_commit two)"
ks --update --apply
printf '// changed\n' >>"$OPT/$C1/adapters/buzz/src/launch.mjs"
: >"$T/state/calls"
ks --rollback --apply
check "rollback, its copy changed: exit 0" rc_is 0
check "rollback, its copy changed: not reused" out_has "is not reused \\(adapters/buzz/src differs from the commit's\\)"
check "rollback, its copy changed: put together again (npm ci)" grep -q '^npm ci' "$T/state/calls"
check "rollback, its copy changed: the commit's file back" sh -c "git -C '$GPF' show '$C1:adapters/buzz/src/launch.mjs' | cmp -s - '$OPT/$C1/adapters/buzz/src/launch.mjs'"
git -C "$GPF" reset -q --hard "$C1"

# 8a. One run at a time: root takes a lock no other user can open, and a
#     run holding it stops another (a dry run takes none: it writes
#     nothing); a run that went first since the checks stops this one; a
#     lock file others could open and hold (an older, readable one) never
#     stops the setup.
hold() {   # file: holds a lock on it from the background, as the test's user; sets HELD
    : >"$T/held"; rm -f "$T/held"
    (exec 9<"$1"; flock 9 && : >"$T/held" && exec sleep 120) &
    HELD=$!
    for _ in $(seq 100); do [ -e "$T/held" ] && break; sleep 0.1; done
}
let_go() { kill "$HELD" 2>/dev/null; wait "$HELD" 2>/dev/null; }
LOCKDIR="$T/run/ghost-protocol-setup"
setup
LOCKDIR="$T/run/ghost-protocol-setup"
install_ks
check "the lock's folder: 0700" [ "$(mode_of "$LOCKDIR")" = 700 ]
check "the lock file: 0600" [ "$(mode_of "$LOCKDIR/setup.lock")" = 600 ]
check "the lock let go when the run ends" flock -n "$LOCKDIR/setup.lock" true
hold "$LOCKDIR/setup.lock"
ks --apply
check "a run while another holds the lock: FAIL (exit 1)" rc_is 1
check "a run while another holds the lock: says so" out_has 'another run of the setup holds it'
ks
check "a dry run while another holds the lock: READY (no lock)" sh -c "[ $RC = 0 ] && grep -q '^READY$' '$OUT'"
let_go
ks --apply
check "the run after the lock is let go: exit 0" rc_is 0
C2="$(next_commit two)"
printf 'printf "%%040d\\n" 7 >%s\n' "$ETC_GP/commit" >"$T/state/npm.hook"
ks --update --apply
check "another run moved the instance since the checks: FAIL (exit 1)" rc_is 1
check "another run moved the instance since the checks: says so" out_has 'another run changed instance inst.s key service since the checks'
check "another run moved the instance since the checks: its commit kept" grep -qx "$(printf '%040d' 7)" "$ETC_GP/commit"
git -C "$GPF" reset -q --hard "$C1"
# A lock file anyone can read, held by another user (here, by a process of
# its own): never in the setup's way. An older one in /etc/ghost-protocol is
# not the lock; one where the lock lives, but readable, is replaced.
setup
LOCKDIR="$T/run/ghost-protocol-setup"
mkdir -p "$T/etc/ghost-protocol"; : >"$T/etc/ghost-protocol/.lock"; chmod 0644 "$T/etc/ghost-protocol/.lock"
hold "$T/etc/ghost-protocol/.lock"
install_ks
check "an old readable lock in /etc/ghost-protocol, held: installed" rc_is 0
let_go
setup
LOCKDIR="$T/run/ghost-protocol-setup"
mkdir -p "$LOCKDIR"; chmod 0755 "$LOCKDIR"; : >"$LOCKDIR/setup.lock"; chmod 0644 "$LOCKDIR/setup.lock"
hold "$LOCKDIR/setup.lock"
install_ks
check "a readable lock file where the lock lives, held: installed" rc_is 0
check "a readable lock file where the lock lives: its folder made 0700" [ "$(mode_of "$LOCKDIR")" = 700 ]
check "a readable lock file where the lock lives: replaced by a 0600 one" [ "$(mode_of "$LOCKDIR/setup.lock")" = 600 ]
let_go
setup
mkdir -p "$T/run/ghost-protocol-setup"; chmod 0755 "$T/run/ghost-protocol-setup"; chmod 0777 "$T/run"
install_ks
check "a lock folder under a folder anyone can write: FAIL (exit 1)" rc_is 1
check "a lock folder under a folder anyone can write: says so" out_has "ghost-protocol-setup, or a folder above it, is not root's alone"
check "a lock folder under a folder anyone can write: left as it was (checked before any write)" \
    sh -c "[ \"\$(stat -c %a '$T/run/ghost-protocol-setup')\" = 755 ] && [ ! -e '$T/run/ghost-protocol-setup/setup.lock' ]"
setup
mkdir -p "$T/run" "$T/elsewhere"; chmod 0755 "$T/elsewhere"; ln -s "$T/elsewhere" "$T/run/ghost-protocol-setup"
install_ks
check "a lock folder that is a link: FAIL (exit 1)" rc_is 1
check "a lock folder that is a link: says so" out_has "ghost-protocol-setup, or a folder above it, is not root's alone \\(or is a link\\)"
check "a lock folder that is a link: nothing written through it" \
    sh -c "[ \"\$(stat -c %a '$T/elsewhere')\" = 755 ] && [ -z \"\$(ls -A '$T/elsewhere')\" ]"

# 8b. A run that stops at its last check records no commit, and leaves the
#     listeners off; the next run that passes turns them on, enabled.
setup
echo "r $ETC_GP/buzz-key" >"$T/state/runuser.agent.can"
install_ks
check "a failed check: FAIL (exit 1)" rc_is 1
check "a failed check: the commit is not recorded" [ ! -e "$ETC_GP/commit" ]
check "a failed check: says to run it again without the key option" out_has 'run this again \(without --key-from-stdin or --key-generate'
rm -f "$T/state/runuser.agent.can"
ks --apply
check "the run after it: exit 0" rc_is 0
check "the run after it: the commit recorded" grep -qx "$C1" "$ETC_GP/commit"
check "the run after it: listening, and enabled" sh -c "[ -f '$T/state/keyunit.gp-key-inst-channel.socket.enabled' ] && [ -f '$T/state/keyunit.gp-key-inst-channel.socket.active' ]"
C2="$(next_commit two)"
echo "r $ETC_GP/buzz-key" >"$T/state/runuser.agent.can"
ks --update --apply
check "a failed update: FAIL (exit 1)" rc_is 1
check "a failed update: the commit stays" sh -c "grep -qx '$C1' '$ETC_GP/commit' && [ ! -e '$ETC_GP/previous-commit' ]"
check "a failed update: the listeners off" [ ! -f "$T/state/keyunit.gp-key-inst-channel.socket.enabled" ]
rm -f "$T/state/runuser.agent.can"
ks --update --apply
check "the update after it: exit 0" rc_is 0
check "the update after it: the commits recorded" sh -c "grep -qx '$C2' '$ETC_GP/commit' && grep -qx '$C1' '$ETC_GP/previous-commit'"
check "the update after it: the listeners enabled again (not only started)" sh -c "[ -f '$T/state/keyunit.gp-key-inst-channel.socket.enabled' ] && [ -f '$T/state/keyunit.gp-key-inst-outbox.path.enabled' ]"
git -C "$GPF" reset -q --hard "$C1"

# 8c. Everything installed is root's alone, and the folders above it.
setup
# Made group-writable while the code is put together, after the checks: the
# last check finds it.
printf 'chmod g+w %s\n' "$UNITS" >"$T/state/npm.hook"
install_ks
check "a units folder its group can write: FAIL (exit 1)" rc_is 1
check "a units folder its group can write: says so" out_has "WARNING: $UNITS, or a folder above it, is not root's alone"
check "a units folder its group can write: nothing listens" [ ! -f "$T/state/keyunit.gp-key-inst-channel.socket.active" ]
setup
mkdir -p "$ETC_GP"; printf 'x\n' >"$ETC_GP/stray"; chmod 0666 "$ETC_GP/stray"
install_ks
check "a file in the settings folder anyone can write: FAIL (exit 1)" rc_is 1
check "a file in the settings folder anyone can write: says so" out_has "WARNING: $ETC_GP/stray is not root's alone"
setup
install_ks
chmod g+w "$OPT/$C1/adapters/buzz/src/launch.mjs"
ks --apply
check "a code file made group-writable since: FAIL (exit 1)" rc_is 1
check "a code file made group-writable since: says so" out_has "WARNING: $OPT/$C1/adapters/buzz/src/launch.mjs is not root's alone"

# 8d. Every write is checked: one that fails stops the setup, saying which.
for w in "../../COMMIT|could not write .*/COMMIT" "../../../buzz.env|could not write the settings to .*/buzz.env" "../../../commit|could not write .*/commit\$"; do
    setup
    printf 'mkdir %s\n' "${w%%|*}" >"$T/state/npm.hook"
    install_ks
    check "a write that fails (${w%%|*}): FAIL (exit 1)" rc_is 1
    check "a write that fails (${w%%|*}): says which" out_has "${w#*|}"
done
# The dry run too: it shows the settings from that file, so it must be there.
setup
printf 'mkdir ../../../buzz.env\n' >"$T/state/npm.hook"
printf '%s\n' "$STANDIN" >"$T/key-in"
ks --settings "$SETTINGS" --key-from-stdin <"$T/key-in"
check "a dry run whose settings file cannot be written: FAIL (exit 1), not READY" sh -c "[ $RC = 1 ] && ! grep -q '^READY$' '$OUT'"
check "a dry run whose settings file cannot be written: says which" out_has "could not write the settings to .*/buzz.env"
setup
install_ks
C2="$(next_commit two)"
printf 'mkdir ../../../previous-commit\n' >"$T/state/npm.hook"
ks --update --apply
check "a write that fails (previous-commit): FAIL (exit 1)" rc_is 1
check "a write that fails (previous-commit): says which" out_has "could not write .*/previous-commit"
git -C "$GPF" reset -q --hard "$C1"

# 8e. Before anything is written, the folders root writes into, or the
#     deepest part of each that is there, and every folder above, are root's
#     alone: install -d keeps an existing folder's owner, and root would write
#     the code, the key and the units into it, and run the code it put there.
untouched() {   # nothing installed, nothing put together
    [ -z "$(ls -A "$UNITS")" ] && [ ! -e "$ETC_GP/buzz-key" ] && [ ! -e "$ETC_GP/buzz.env" ] && [ ! -e "$OPT/$C1" ] \
        && [ ! -e "$SRV_GP/outbox" ] && ! grep -q '^npm ci' "$T/state/calls"
}
tops_refused() {   # name the folder named in the refusal
    check "$1: refused (exit 1)" rc_is 1
    check "$1: says which folder" out_has "$2, or a folder above it, is not root's alone"
    check "$1: nothing written, nothing put together" untouched
    check "$1: no user made" not_called useradd
}
for rel in opt/ghost-protocol etc/ghost-protocol srv/ghost-protocol etc/systemd/system etc/ghost-protocol/inst; do
    setup
    f="$T/$rel"; mkdir -p "$f"; chmod 0775 "$f"
    install_ks
    tops_refused "an install, $rel its group can write" "$f"
    setup
    f="$T/$rel"; mkdir -p "$f"; chmod 0757 "$f"
    printf '%s\n' "$STANDIN" >"$T/key-in"
    ks --settings "$SETTINGS" --key-from-stdin <"$T/key-in"
    tops_refused "a dry run, $rel anyone can write" "$f"
    check "a dry run, $rel anyone can write: not READY" out_lacks '^READY$'
done
setup
mkdir -p "$T/elsewhere" "$T/opt"; ln -s "$T/elsewhere" "$T/opt/ghost-protocol"
install_ks
tops_refused "/opt/ghost-protocol a link" "$T/opt/ghost-protocol"
check "/opt/ghost-protocol a link: nothing written through it" sh -c "[ -z \"\$(ls -A '$T/elsewhere')\" ]"
setup
mkdir -p "$T/opt"; ln -s "$T/nowhere" "$T/opt/ghost-protocol"
install_ks
tops_refused "/opt/ghost-protocol a link to nothing" "$T/opt/ghost-protocol"
check "/opt/ghost-protocol a link to nothing: nothing made there" [ ! -e "$T/nowhere" ]
setup
mkdir -p "$T/opt"; chmod 0775 "$T/opt"
install_ks
tops_refused "/opt itself its group can write" "$T/opt"
setup
mkdir -p "$T/opt/ghost-protocol"
install_ks
check "/opt/ghost-protocol there and root's alone: installed" rc_is 0

# 8f. The sockets answer: with the listeners on, one real connection to each
#     socket, made as the agent user with the root-owned node and code
#     (launch.mjs probe, played by the node stand-in). A socket that does not
#     answer is a FAIL, and nothing is reported as installed. The channel's,
#     while a session holds it (a running channel instance whose peer is
#     alive), is not probed, and one that a session takes while it is probed
#     (the probe's connection closed at once) is held, not failed. A count of
#     connections alone is not a session; any other failed probe fails.
setup
install_ks
check "answers: installed (exit 0)" rc_is 0
check "answers: each socket probed, as the agent user, in a clean environment" sh -c "grep -q '^runuser agent env -i PATH=/usr/bin:/bin .*BUZZ_KEY_SOCKET=$T/run/ghost-protocol-key/inst .*launch.mjs probe channel\$' '$T/state/calls' && grep -q '^runuser agent env -i .*launch.mjs probe buzz-mcp\$' '$T/state/calls'"
check "answers: with the root-owned copy's node and code" grep -qF " $OPT/$C1/bin/node --disable-sigusr1 $OPT/$C1/adapters/buzz/src/launch.mjs probe channel" "$T/state/calls"
check "answers: only once the listeners are on" sh -c "awk '/^systemctl enable 4\$/ { on = NR } /^node probe channel\$/ { p = NR } END { exit !(on && p > on) }' '$T/state/calls'"
check "answers: says each one answered" sh -c "grep -q 'channel.sock answered (server stub-channel)' '$OUT' && grep -q 'buzz-mcp.sock answered (server stub-buzz-mcp)' '$OUT'"
check "answers: recorded" out_has 'OK +answers +each socket answered a real connection, made as agent'
setup
touch "$T/state/probe.channel.fails"
install_ks
check "no answer on the channel: FAIL (exit 1)" rc_is 1
check "no answer: says which socket" out_has 'FAIL +answers +no answer on channel as agent'
check "no answer: says where to look" out_has "journalctl -u 'gp-key-inst-channel@\\*' -u 'gp-key-inst-buzz-mcp@\\*'"
check "no answer: never says installed" out_lacks 'installed and listening'
check "no answer: no next steps for the instance" out_lacks '"buzz_key_socket"'
check "no answer: the listeners stay on, for the next run" [ -f "$T/state/keyunit.gp-key-inst-channel.socket.enabled" ]
rm -f "$T/state/probe.channel.fails"
: >"$T/state/calls"
ks --apply
check "the run after it: exit 0" rc_is 0
check "the run after it: probes again" grep -qx 'node probe channel' "$T/state/calls"
# A channel instance as systemd names it, for a peer pid: a live one (this
# test's shell) is a session's; a dead one is a probe's that gave up, or a
# connection the channel dropped, which systemd still counts until its
# instance is dead.
LIVE=$$
sh -c ':' & DEAD=$!; wait "$DEAD"
inst() { printf 'gp-key-inst-channel@%s-%s-1000.service loaded active running stand-in\n' "$1" "$2"; }
clear_held() { rm -f "$T/state/keyunit.running" "$T/state/keyunit.gp-key-inst-channel.socket.connections" "$T/state/probe.channel."*; }
inst 0 "$LIVE" >"$T/state/keyunit.running"; echo 1 >"$T/state/keyunit.gp-key-inst-channel.socket.connections"
: >"$T/state/calls"
ks --apply
check "the channel held by a session: exit 0" rc_is 0
check "the channel held: not probed, buzz-mcp is" sh -c "! grep -q '^node probe channel' '$T/state/calls' && grep -qx 'node probe buzz-mcp' '$T/state/calls'"
check "the channel held: says so" out_has "channel.sock is held by the session's connection"
check "the channel held: asked systemd for its running instances" grep -qxF 'systemctl list-units gp-key-inst-channel@*.service' "$T/state/calls"
clear_held
# A connection still counted, its peer gone (a probe that gave up): the
# channel is probed all the same.
inst 3 "$DEAD" >"$T/state/keyunit.running"; echo 1 >"$T/state/keyunit.gp-key-inst-channel.socket.connections"
: >"$T/state/calls"
ks --apply
check "a counted connection whose peer is gone: the channel is probed" grep -qx 'node probe channel' "$T/state/calls"
check "a counted connection whose peer is gone: exit 0 (it answered)" rc_is 0
clear_held
# A session that connects between the look and the probe: the channel, at
# its one connection, closes the probe's at once, and is held after it.
inst 1 "$LIVE" >"$T/state/probe.channel.adds"; touch "$T/state/probe.channel.fails"
ks --apply
check "a session connects while the channel is probed: exit 0" rc_is 0
check "a session connects while the channel is probed: says it is held now" out_has "channel.sock is held now by the session's connection, which came in while it was probed"
check "a session connects while the channel is probed: no FAIL" out_lacks 'FAIL +answers'
clear_held
# Any other failed probe is a FAIL, whatever holds the socket after it: a
# probe that timed out on a channel that hangs (its own connection still
# counted), one that got an error, a channel that dropped the connection
# with no session about, and a server that is not a channel.
for c in \
    "a probe that timed out, its connection still counted:$DEAD:it sent no answer within 30000 ms" \
    "a probe that timed out, a session held after:$LIVE:it sent no answer within 30000 ms" \
    "an error answer, a session held after:$LIVE:it answered initialize with an error" \
    "the connection closed with no session about, still counted:$DEAD:the key service closed the connection before answering (ECONNRESET)" \
    "another server, a session held after:$LIVE:not-channel"; do
    what="${c%%:*}"; rest="${c#*:}"; pid="${rest%%:*}"; why="${rest#*:}"
    inst 2 "$pid" >"$T/state/probe.channel.adds"
    if [ "$why" = not-channel ]; then touch "$T/state/probe.channel.not-channel"; else printf '%s' "$why" >"$T/state/probe.channel.why"; fi
    ks --apply
    check "$what: FAIL" sh -c "[ $RC = 1 ] && grep -qE 'FAIL +answers +no answer on channel as agent' '$OUT'"
    check "$what: never called held" out_lacks 'is held now by'
    clear_held
done
ks --apply
check "and answered again: exit 0" rc_is 0
touch "$T/state/probe.buzz-mcp.fails"
ks --apply
check "no answer on buzz-mcp, a run again: FAIL (exit 1)" sh -c "[ $RC = 1 ] && grep -qE 'FAIL +answers +no answer on buzz-mcp as agent' '$OUT'"
rm -f "$T/state/probe.buzz-mcp.fails"
# An update probes once the listeners are on again, before the instance is
# back (its own connection would then hold the channel), and only then.
setup
install_ks
unit_loaded; touch "$T/state/unit-inst.service.active"
C2="$(next_commit two)"
: >"$T/state/calls"
ks --update --apply
check "update: exit 0" rc_is 0
check "update: probed after the listeners start, before the instance restarts" sh -c "awk '/^systemctl start: gp-key-inst-channel.socket/ { s = NR } /^node probe buzz-mcp\$/ { p = NR } /^systemctl try-restart/ { r = NR } END { exit !(s && p > s && r > p) }' '$T/state/calls'"
check "update: probed once" [ "$(grep -c '^node probe channel$' "$T/state/calls")" = 1 ]
touch "$T/state/probe.channel.fails"
C3="$(next_commit three)"
ks --update --apply
check "an update that does not answer: FAIL (exit 1)" rc_is 1
check "an update that does not answer: says how to go back" out_has 'To go back: install/keyservice/setup --name inst --agent-user agent --rollback --apply'
check "an update that does not answer: the instance restarted all the same (its connections were ended)" [ "$(cat "$T/state/unit-inst.service.restarts")" = 2 ]
rm -f "$T/state/probe.channel.fails"
git -C "$GPF" reset -q --hard "$C1"

# 8g. The units as systemd loads them (systemctl show and systemctl cat, for an
#     instance of each template): from the files written, read since they
#     changed, and with no drop-in, in any folder, that changes more than
#     limits, timeouts, restarts and logging. One that does is a FAIL: the
#     listeners go off. A drop-in is read as systemd reads it (headers with
#     spaces, tabs, a CR or a byte-order mark; continued lines), and one this
#     check cannot read so is a FAIL too.
setup
install_ks
check "drop-ins: installed (exit 0)" rc_is 0
I=verify   # the instance name a template is asked about by
check "drop-ins: a template asked about by an instance's name" sh -c "grep -qx 'systemctl show FragmentPath gp-key-inst-channel@$I.service' '$T/state/calls' && grep -qx 'systemctl cat gp-key-inst-buzz-mcp@$I.service' '$T/state/calls'"
check "drop-ins: each of the six units read with systemctl cat" [ "$(grep -c '^systemctl cat gp-key-inst-' "$T/state/calls")" = 6 ]
D="$UNITS/gp-key-inst-channel@.service.d"
dropin() {   # file text: one drop-in (printf format), daemon-reloaded, then a run
    rm -rf "$UNITS"/gp-key-inst-*.d
    mkdir -p "$(dirname "$1")"
    # shellcheck disable=SC2059  # the text is the format
    printf "$2" >"$1"
    ks --apply
}
for c in \
    "User=:$D/50-user.conf:[Service]\nUser=root\n" \
    "Environment=:$UNITS/gp-key-inst-buzz-mcp@.service.d/50-fdnames.conf:[Service]\nEnvironment=LISTEN_FDNAMES=buzz-key\n" \
    "OpenFile=:$D/50-key.conf:[Service]\nOpenFile=/etc/shadow:buzz-key:read-only\n" \
    "ProtectSystem=:$D/50-sandbox.conf:[Service]\nProtectSystem=no\n" \
    "ExecStartPre=:$D/50-pre.conf:[Service]\nExecStartPre=+/bin/true\n" \
    "BindReadOnlyPaths=:$D/50-bind.conf:[Service]\nBindReadOnlyPaths=/etc/ghost-protocol\n" \
    "ListenStream=:$UNITS/gp-key-inst-channel.socket.d/50-listen.conf:[Socket]\nListenStream=/tmp/elsewhere.sock\n" \
    "SocketMode=:$UNITS/gp-key-inst-buzz-mcp.socket.d/50-mode.conf:[Socket]\nSocketMode=0666\n" \
    "JoinsNamespaceOf=:$D/50-ns.conf:[Unit]\nJoinsNamespaceOf=other.service\n" \
    "User=:$UNITS/gp-key-inst-outbox.service.d/50-root.conf:[Service]\nUser=root\n" \
    "User=:$D/50-spaced.conf:[Service]\n  User = root\n" \
    "User=:$D/50-hdr-space.conf:[Service] \nUser=root\n" \
    "OpenFile=:$D/50-hdr-tab.conf:[Service]\t\nOpenFile=/etc/shadow:buzz-key:read-only\n" \
    "User=:$D/50-hdr-unit.conf:[Unit]\nDescription=x\n  [Service]  \nUser=root\n" \
    "User=:$D/50-crlf.conf:[Service]\r\nUser=root\r\n" \
    "User=:$D/50-cr.conf:[Service]\rUser=root\r" \
    "User=:$D/50-nul.conf:[Install]\000[Service]\000User=root\n" \
    "User=:$D/50-bom.conf:\357\273\277[Service]\nUser=root\n" \
    "User=:$D/50-bom-later.conf:# a comment first\n\357\273\277[Service]\nUser=root\n" \
    "ListenStream=:$UNITS/gp-key-inst-channel.socket.d/50-crlf.conf:[Socket]\r\nListenStream=/tmp/x.sock\r\n" \
    "User=:$D/50-even.conf:[Install]\nWantedBy=x\\\\\\\\\n[Service]\nUser=root\n" \
    "User=:$D/50-cont.conf:[Service]\nNice=1 \\\\\n# a comment inside\n  2\nUser=root\n"; do
    key="${c%%:*}"; rest="${c#*:}"; f="${rest%%:*}"; text="${rest#*:}"
    dropin "$f" "$text"
    n="$(basename "$(dirname "$f")")"; n="${n%.d}"
    check "a drop-in setting $key ($n): FAIL (exit 1)" rc_is 1
    check "a drop-in setting $key ($n): names it" out_has "the drop-in $f sets ${key} in \\[(Service|Socket|Unit)\\] of $n"
    check "a drop-in setting $key ($n): the listeners off" [ ! -f "$T/state/keyunit.gp-key-inst-channel.socket.enabled" ]
done
dropin "$D/50-fine.conf" '[Unit]\nDescription=renamed\n[Service]\n# User=root, a comment\nTimeoutStopSec=5\nMemoryMax=200M\nNice=5\n[Install]\nWantedBy=multi-user.target\n'
check "a drop-in with only limits, timeouts and [Unit]: exit 0" rc_is 0
check "a drop-in with only limits, timeouts and [Unit]: listening again" [ -f "$T/state/keyunit.gp-key-inst-channel.socket.enabled" ]
# Read as systemd reads it, the same drop-in passes with a byte-order mark,
# CR LF line ends, a tab after a header, a continued line and an odd one
# (two backslashes, not continued).
dropin "$D/50-fine.conf" '\357\273\277[Unit]\r\nDescription=a \\\r\n  long name\r\n[Service]\t\r\nTimeoutStopSec=5\r\nSyslogIdentifier=x\\\\\r\n[Install]\r\nWantedBy=multi-user.target\r\n'
check "the same, with a byte-order mark, CR LF and a continued line: exit 0" rc_is 0
# What this check cannot read as systemd does is a FAIL, with a reason.
for c in \
    "a section header it does not know:$D/50-xhdr.conf:[X-Mine]\nUser=root\n:has a section header this check does not know, \\[X-Mine\\]" \
    "a header with more after it:$D/50-hdr-more.conf:[Service] # note\nNice=1\n:has a section header this check does not know" \
    "a key before any header:$D/50-nohdr.conf:Nice=1\n[Service]\nNice=2\n:sets Nice= before any section header" \
    "a second byte-order mark:$D/50-bom2.conf:\357\273\277[Service]\nNice=1\n\357\273\277[Install]\nUser=root\n:holds a control character or a second byte-order mark" \
    "a control character:$D/50-ctl.conf:[Service]\nNice=1\033\n:holds a control character or a second byte-order mark"; do
    what="${c%%:*}"; rest="${c#*:}"; f="${rest%%:*}"; rest="${rest#*:}"; text="${rest%:*}"; why="${rest##*:}"
    dropin "$f" "$text"
    check "$what: FAIL (exit 1)" rc_is 1
    check "$what: says why" out_has "the drop-in $f of gp-key-inst-channel@\\.service $why"
done
# A systemctl that prints the bytes as they are: a CR before the LF is the
# line's end, any other CR, or a NUL, is a FAIL.
touch "$T/state/keyunit.cat-raw"
dropin "$D/50-crlf.conf" '[Service]\r\nUser=root\r\n'
check "bytes as they are, CR LF: User= found" sh -c "[ $RC = 1 ] && grep -qF 'the drop-in $D/50-crlf.conf sets User= in [Service] of gp-key-inst-channel@.service' '$OUT'"
dropin "$D/50-cr.conf" '[Install]\rUser=root\n'
check "bytes as they are, a CR inside a line: FAIL" sh -c "[ $RC = 1 ] && grep -qF 'the drop-in $D/50-cr.conf of gp-key-inst-channel@.service holds a control character' '$OUT'"
dropin "$D/50-nul.conf" '[Install]\nWantedBy=x\000[Service]\nUser=root\n'
check "bytes as they are, a NUL: FAIL" sh -c "[ $RC = 1 ] && grep -qF 'the drop-in $D/50-nul.conf of gp-key-inst-channel@.service holds a control character' '$OUT'"
dropin "$D/50-fine.conf" '[Service]\r\nNice=5\r\n'
check "bytes as they are, CR LF and only a limit: exit 0" rc_is 0
rm -f "$T/state/keyunit.cat-raw"
# Drop-ins come from systemd's own list, never split here: a path with a
# space in it is read whole; one that cannot be read is a FAIL.
rm -rf "$UNITS"/gp-key-inst-*.d
mkdir -p "$T/sp dir"
printf '[Service]\nUser=root\n' >"$T/sp dir/50.conf"
echo "$T/sp dir/50.conf" >"$T/state/keyunit-dropins.gp-key-inst-buzz-mcp@.service"
ks --apply
check "a drop-in path with a space: read whole, User= found" sh -c "[ $RC = 1 ] && grep -qF 'the drop-in $T/sp dir/50.conf sets User= in [Service] of gp-key-inst-buzz-mcp@.service' '$OUT'"
echo "$T/no/such/50.conf" >"$T/state/keyunit-dropins.gp-key-inst-buzz-mcp@.service"
ks --apply
check "a listed drop-in that cannot be read: FAIL" sh -c "[ $RC = 1 ] && grep -qF 'could not read gp-key-inst-buzz-mcp@.service and its drop-ins as systemd loads them' '$OUT'"
rm -f "$T/state/keyunit-dropins.gp-key-inst-buzz-mcp@.service"
touch "$T/state/keyunit.cat-fails"
ks --apply
check "systemctl cat fails: FAIL" sh -c "[ $RC = 1 ] && grep -q 'could not read gp-key-inst-.* and its drop-ins as systemd loads them' '$OUT'"
rm -f "$T/state/keyunit.cat-fails"
rm -rf "$UNITS"/gp-key-inst-*.d
mkdir -p "$T/run-dropin"
printf '[Service]\nUser=root\n' >"$T/run-dropin/50-run.conf"
echo "$T/run-dropin/50-run.conf" >"$T/state/keyunit-dropins.gp-key-inst-buzz-mcp@.service"
ks --apply
check "a drop-in outside the units folder (as in /run): FAIL" sh -c "[ $RC = 1 ] && grep -qF 'the drop-in $T/run-dropin/50-run.conf sets User= in [Service] of gp-key-inst-buzz-mcp@.service' '$OUT'"
rm -f "$T/state/keyunit-dropins.gp-key-inst-buzz-mcp@.service"
echo "$T/run/systemd/system/gp-key-inst-channel@.service" >"$T/state/keyunit-fragment.gp-key-inst-channel@.service"
ks --apply
check "a unit loaded from another file: FAIL" sh -c "[ $RC = 1 ] && grep -qF 'systemd loads gp-key-inst-channel@.service from $T/run/systemd/system/gp-key-inst-channel@.service, not from $UNITS/gp-key-inst-channel@.service' '$OUT'"
rm -f "$T/state/keyunit-fragment.gp-key-inst-channel@.service"
touch "$T/state/keyunit.need-reload"
ks --apply
check "units not read since they changed: FAIL" sh -c "[ $RC = 1 ] && grep -q 'systemd has not read gp-key-inst-' '$OUT'"
rm -f "$T/state/keyunit.need-reload"
ks --apply
check "drop-ins gone: exit 0, listening again" sh -c "[ $RC = 0 ] && [ -f '$T/state/keyunit.gp-key-inst-channel.socket.enabled' ]"

# 9. --key-generate: a new key file, its public key printed.
setup
ks --settings "$SETTINGS" --key-generate --apply
check "generate: exit 0" rc_is 0
check "generate: the key file, 0400" [ "$(mode_of "$ETC_GP/buzz-key")" = 400 ]
check "generate: the public key printed" out_has "the agent's public key: a{64}"

# 10. The copy step (outbox-copy), as the test's user.
OC="$SRC/install/keyservice/outbox-copy"
# A step that waits (on a FIFO, say) is cut off after 60 s and fails, never hangs the suite.
oc() { if command -v timeout >/dev/null 2>&1; then timeout 60 python3 -I -B "$OC" "$@"; else python3 -I -B "$OC" "$@"; fi; }
t_new
OBX="$T/outbox"; FL="$T/files"
mkdir -p "$OBX" "$FL"
old() { touch -d '@1000000000' "$@"; }
printf 'report\n' >"$OBX/report.txt"; old "$OBX/report.txt"
printf 'secret\n' >"$T/secret"; ln -s "$T/secret" "$OBX/link.txt"
printf 'half\n' >"$OBX/.half.txt"; old "$OBX/.half.txt"
mkfifo "$OBX/fifo" 2>/dev/null || true
printf 'linked\n' >"$T/other"; ln "$T/other" "$OBX/hard.txt"; old "$OBX/hard.txt"
mkdir "$OBX/sub"; printf 'x\n' >"$OBX/sub/in.txt"
head -c 2048 /dev/zero >"$OBX/big.bin"; old "$OBX/big.bin"
printf 'bad\n' >"$OBX/$(printf 'bad\nname')"; old "$OBX/$(printf 'bad\nname')"
oc "$OBX" "$FL" 1024 >"$OUT" 2>&1; RC=$?
check "copy: exit 0, at once (a FIFO is never waited on)" rc_is 0
check "copy: a regular file is moved across" sh -c "[ \"\$(cat '$FL/report.txt')\" = report ] && [ ! -e '$OBX/report.txt' ]"
check "copy: mode 0640" [ "$(mode_of "$FL/report.txt")" = 640 ]
check "copy: a link is never followed" sh -c "[ ! -e '$FL/link.txt' ] && grep -q 'left link.txt: a link' '$OUT'"
check "copy: a dot file is waiting, not taken" sh -c "[ ! -e '$FL/.half.txt' ] && [ -e '$OBX/.half.txt' ]"
# A dot file is an upload still being written: it waits quietly, and is not
# reported as left (the one line about a bad name is the newline's).
check "copy: a dot file waits quietly, with no line about it" [ "$(grep -c 'not a plain file name' "$OUT")" = 1 ]
if [ -p "$OBX/fifo" ]; then check "copy: a FIFO is left, at once" sh -c "[ ! -e '$FL/fifo' ] && grep -q 'left fifo: not a regular file' '$OUT'"; fi
check "copy: a file with another hard link is left" sh -c "[ ! -e '$FL/hard.txt' ] && grep -q 'left hard.txt: it has other hard links' '$OUT'"
check "copy: a folder is left, and nothing in it taken" sh -c "[ ! -e '$FL/sub' ] && [ ! -e '$FL/in.txt' ]"
check "copy: a file over the limit is left" sh -c "[ ! -e '$FL/big.bin' ] && grep -q 'left big.bin: 2048 bytes, over the limit of 1024' '$OUT'"
check "copy: a name with a newline is left, and not printed" sh -c "! grep -q 'bad\$' '$OUT' && grep -q 'not a plain file name' '$OUT'"
check "copy: a file's content is never printed" out_lacks 'report$|secret|linked'
mkdir -p "$T/oldfiles"; printf 'x\n' >"$T/oldfiles/stale.txt"; old "$T/oldfiles/stale.txt"
oc "$OBX" "$T/oldfiles" >"$OUT" 2>&1
check "copy: files older than seven days are removed" [ ! -e "$T/oldfiles/stale.txt" ]
# The quota: at most <max files> files, and <max total bytes> in all.
mkdir -p "$T/qo" "$T/qf"
for i in 1 2 3; do printf 'q%s\n' "$i" >"$T/qo/q$i.txt"; old "$T/qo/q$i.txt"; done
oc "$T/qo" "$T/qf" 1024 2 >"$OUT" 2>&1
check "quota: two files taken, the third left" sh -c "[ -f '$T/qf/q1.txt' ] && [ -f '$T/qf/q2.txt' ] && [ ! -e '$T/qf/q3.txt' ] && [ -f '$T/qo/q3.txt' ]"
check "quota: says why" out_has 'left q3.txt: the files folder holds 2 files, its limit'
rm -f "$T/qf"/*
head -c 600 /dev/zero >"$T/qo/q4.bin"; old "$T/qo/q4.bin"
head -c 600 /dev/zero >"$T/qo/q5.bin"; old "$T/qo/q5.bin"
oc "$T/qo" "$T/qf" 1024 100 1000 >"$OUT" 2>&1
check "quota: the total in bytes holds too" sh -c "[ -f '$T/qf/q3.txt' ] && [ -f '$T/qf/q4.bin' ] && [ ! -e '$T/qf/q5.bin' ]"
check "quota: says the total" out_has 'left q5.bin: the files folder would hold [0-9]+ bytes, over its limit of 1000'
rm -rf "$T/linkbox"; ln -s "$OBX" "$T/linkbox"
oc "$T/linkbox" "$FL" >"$OUT" 2>&1; RC=$?
check "copy: an outbox that is a link is refused" rc_is 1

finish_tests
