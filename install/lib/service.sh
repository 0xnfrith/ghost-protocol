# shellcheck shell=bash
# service.sh: step 14, services. Built so far: the memory guard, which is
# earlyoom with GHOST Protocol's drop-in (install/memory-guard/earlyoom.conf),
# on Debian and Ubuntu; the auto-mode guard (install/automode-guard/), a
# systemd timer that reports drift in Claude Code's auto-mode rules on Buzz,
# when the manifest has [automode_guard]; the memory backup
# (install/lib/memory-backup.sh), when it has [memory_backup]; and, on an
# update, the restart of the instance's own service (below). Setting up the
# boot service comes in a later PR.
#
# The restart: an update (boot.sh --update, which runs this installer with
# --update and GP_PREVIOUS_COMMIT) that moved the checkout restarts the
# instance's unit, <name>.service, with systemctl try-restart, so the running
# instance loads the new commit. Only a unit that is installed and running is
# restarted: a stopped one stays stopped, since only the operator turns an
# instance on. No systemd, or no such unit: a SKIP line that says to restart it
# by hand. A restart that cannot get root or fails is a FAIL: the checkout is
# at the new commit, but the instance still runs the old one.
#
# An instance runs Claude Code with many subagents, and their test suites and
# builds, on a small Linux machine, often with no swap. When memory runs out,
# the kernel's own out-of-memory killer may never fire and the machine stops
# answering; earlyoom kills one process before that point. The drop-in's
# comments explain each setting.
#
# When it runs: on Linux, by default on the vm profile only. On the laptop
# profile it needs [memory_guard] enabled = "true" in the manifest (desktop
# Ubuntu already runs systemd-oomd). enabled = "false" turns it off anywhere,
# and an earlyoom already set up is then left as it is. On macOS it is
# skipped with an info line. The thresholds come from the manifest's
# [memory_guard] (default 15 and 8 %).
#
# It is recommended, never required. Any failure (no apt or systemd, no root,
# the package missing, earlyoom not staying up or not running with these
# settings) prints a warning with the commands to run by hand, records a SKIP
# line, and the run goes on. Root comes from root_prepare (common.sh): a run
# with --yes or without a terminal never waits for a sudo password. A dry run
# only reads and prints.
#
# Sourced by install/install only.

MG_UNIT="earlyoom"
MG_PACKAGE="earlyoom"
MG_DROPIN_NAME="ghost-protocol.conf"
MG_TERM_DEFAULT=15
MG_KILL_DEFAULT=8
# How long earlyoom must keep running after its restart: it exits at once on
# an option it does not know.
MG_SETTLE_SECONDS=2
MG_TEMPLATE="$GP_DIR/install/memory-guard/earlyoom.conf"
# apt-get waits up to 2 minutes for another apt (unattended upgrades on a new
# machine), keeps any config file already there, and never reads the terminal.
MG_APT_OPTS="-o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold"
MG_TERM=""; MG_KILL=""; MG_FROM=""
MG_DIR=""; MG_TARGET=""; MG_PROC=""; MG_EXPECTED=""

# Where the drop-in goes (/etc/systemd/system/earlyoom.service.d) and where
# the running earlyoom's command line is read (/proc). Tests point them at
# folders of their own (GP_ETC and GP_PROC, honoured only when GP_TEST=1); a
# test without GP_ETC gets no path, so nothing is written.
mg_paths() {
    local etc=/etc proc=/proc
    if [ "${GP_TEST:-}" = "1" ]; then
        etc="${GP_ETC:-}"
        proc="${GP_PROC:-$etc/proc}"
        if [ -n "$etc" ]; then
            echo "install: TEST MODE (GP_TEST=1): the memory guard uses $etc and $proc, not /etc and /proc" >&2
        fi
    fi
    MG_DIR=""; MG_TARGET=""; MG_PROC=""
    [ -n "$etc" ] || return 1
    MG_DIR="$etc/systemd/system/$MG_UNIT.service.d"
    MG_TARGET="$MG_DIR/$MG_DROPIN_NAME"
    MG_PROC="$proc"
}

# The thresholds: the manifest's, else the defaults. The manifest check has
# already made sure they are whole numbers with kill below term.
mg_thresholds() {
    if [ -n "$M_MEMORY_GUARD_TERM" ] && [ -n "$M_MEMORY_GUARD_KILL" ]; then
        MG_TERM="$M_MEMORY_GUARD_TERM"; MG_KILL="$M_MEMORY_GUARD_KILL"; MG_FROM="from the manifest"
    else
        MG_TERM="$MG_TERM_DEFAULT"; MG_KILL="$MG_KILL_DEFAULT"
        if [ -n "$M_NAME" ]; then MG_FROM="the defaults"
        else MG_FROM="the defaults; the manifest is not read yet"; fi
    fi
}

mg_line() { printf 'SIGTERM at %s %%, SIGKILL at %s %% available memory (%s)' "$MG_TERM" "$MG_KILL" "$MG_FROM"; }

# The drop-in with the thresholds filled in, and MG_EXPECTED, the command line
# earlyoom then runs with (systemd's "$$" read back as "$"). The thresholds are
# checked again here, since they go into the ExecStart line.
mg_render() {   # dest
    local re='^[1-9][0-9]?$'
    [[ $MG_TERM =~ $re ]] && [[ $MG_KILL =~ $re ]] || return 1
    sed -e "s/@TERM_PERCENT@/$MG_TERM/g" -e "s/@KILL_PERCENT@/$MG_KILL/g" "$MG_TEMPLATE" >"$1" || return 1
    ! grep -q '@[A-Z_]*@' "$1" || return 1
    MG_EXPECTED="$(grep -m 1 '^ExecStart=/' "$1" | sed -e 's/^ExecStart=//' -e 's/\$\$/$/g')"
    [ -n "$MG_EXPECTED" ]
}

# The installed earlyoom package's version, or nothing. A held package
# ("hold ok installed") is installed too.
mg_version() {
    dpkg-query -W -f='${Status} ${Version}\n' "$MG_PACKAGE" 2>/dev/null \
        | awk '$3 == "installed" { print $4; exit }'
}

mg_need_reload() { [ "$(systemctl show -p NeedDaemonReload --value "$MG_UNIT" 2>/dev/null)" = "yes" ]; }

# The running earlyoom has exactly this drop-in's command line. It reads
# /proc/<MainPID>/cmdline; where that cannot be read, it checks the command
# line systemd has loaded instead (systemctl show -p ExecStart, where "$" is
# written "$$" again).
mg_running_ok() {
    local pid got esc
    pid="$(systemctl show -p MainPID --value "$MG_UNIT" 2>/dev/null)"
    case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
    if [ -r "$MG_PROC/$pid/cmdline" ]; then
        got="$(tr '\0' ' ' <"$MG_PROC/$pid/cmdline" | sed 's/ $//')"
        [ "$got" = "$MG_EXPECTED" ]
        return
    fi
    esc="$(printf '%s' "$MG_EXPECTED" | sed 's/\$/$$/g')"
    systemctl show -p ExecStart --value "$MG_UNIT" 2>/dev/null | grep -qF "argv[]=$esc ;"
}

# The other drop-ins for the unit, by name.
mg_others() {
    local f others=""
    for f in "$MG_DIR"/*.conf; do
        [ -f "$f" ] || continue
        [ "$f" = "$MG_TARGET" ] && continue
        others="$others ${f##*/}"
    done
    printf '%s' "${others# }"
}

# >>> hand commands: text for a person to type (pins.test.sh allows sudo here, in printf lines only)
mg_hand_setup() {
    local d="/etc/systemd/system/$MG_UNIT.service.d"
    warn "To set it up by hand (Debian or Ubuntu; on Ubuntu earlyoom is in the universe component):"
    {
        printf '    sudo mkdir -p %s\n' "$d"
        printf "    sed -e 's/@TERM_PERCENT@/%s/g' -e 's/@KILL_PERCENT@/%s/g' %q | sudo tee %s >/dev/null\n" \
            "$MG_TERM" "$MG_KILL" "$MG_TEMPLATE" "$d/$MG_DROPIN_NAME"
        printf '    sudo systemctl daemon-reload\n'
        printf '    sudo apt-get update && sudo apt-get install -y %s\n' "$MG_PACKAGE"
        printf '    sudo systemctl enable %s && sudo systemctl restart %s\n' "$MG_UNIT" "$MG_UNIT"
    } >&2
}
mg_hand_undo() {
    say "If an earlier run set it up, this removes it:"
    printf '    sudo rm -f /etc/systemd/system/%s.service.d/%s\n' "$MG_UNIT" "$MG_DROPIN_NAME"
    printf '    sudo systemctl daemon-reload && sudo systemctl restart %s   (the package defaults)\n' "$MG_UNIT"
    printf '    sudo apt-get remove %s   (or remove earlyoom altogether)\n' "$MG_PACKAGE"
}
ag_hand_undo() {
    say "If an earlier run set it up, this removes it (or: install/automode-guard/setup --home <home> --uninstall --apply):"
    printf '    sudo systemctl disable --now %s.timer\n' "$AG_UNIT"
    printf '    sudo rm -f /etc/systemd/system/%s.service /etc/systemd/system/%s.timer\n' "$AG_UNIT" "$AG_UNIT"
    printf '    sudo rm -rf /usr/local/lib/ghost-protocol/%s/automode-guard /var/lib/ghost-protocol/%s\n' "$M_NAME" "$AG_UNIT"
    printf '    sudo systemctl daemon-reload\n'
}
restart_hand() {   # unit
    printf '    sudo systemctl restart %s\n' "$1" >&2
}
# <<< hand commands

mg_skip() {   # why
    warn "the memory guard (earlyoom) was not set up: $1."
    warn "The instance runs without it: if memory runs out, the machine may stop answering instead of losing one process."
    mg_hand_setup
    record SKIP memory "$1; the instance runs without it (the warning above has the commands)"
}

mg_apt() {   # apt-get arguments: as root, non-interactive, never reading the terminal
    # shellcheck disable=SC2086  # MG_APT_OPTS is a fixed list of words
    as_root env DEBIAN_FRONTEND=noninteractive apt-get $MG_APT_OPTS "$@" </dev/null
}

memory_guard() {
    local ver installed=0 same=0 enabled=0 active=0 reload=0 running=0 rendered others
    if [ "$GP_OS" != "linux" ]; then
        say "the memory guard (earlyoom) is for Linux; nothing to do on $GP_OS"
        record SKIP memory "earlyoom is for Linux; nothing to do on $GP_OS"
        return 0
    fi
    if [ "$M_MEMORY_GUARD_ENABLED" = "false" ]; then
        say "the memory guard is turned off in the manifest ([memory_guard] enabled = \"false\");"
        say "  an earlyoom already set up on this machine is left as it is."
        mg_hand_undo
        record SKIP memory "turned off in the manifest; an earlyoom already set up is left as it is"
        return 0
    fi
    if [ "$PROFILE" != "vm" ] && [ "$M_MEMORY_GUARD_ENABLED" != "true" ]; then
        say "the memory guard is on by default only on the vm profile. On this $PROFILE profile,"
        say "  [memory_guard] enabled = \"true\" in the manifest turns it on (desktop Ubuntu"
        say "  already runs systemd-oomd)."
        record SKIP memory "on by default only on the vm profile; enabled = \"true\" turns it on for $PROFILE"
        return 0
    fi
    mg_thresholds
    say "the memory guard: earlyoom, $(mg_line)"
    if [ ! -f "$MG_TEMPLATE" ]; then mg_skip "$MG_TEMPLATE is missing"; return 0; fi
    if ! command -v systemctl >/dev/null 2>&1; then
        mg_skip "no systemd here (systemctl is missing)"; return 0
    fi
    if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg-query >/dev/null 2>&1; then
        mg_skip "no apt here (the guard is set up on Debian and Ubuntu)"; return 0
    fi
    if ! mg_paths; then
        say "TEST MODE (GP_TEST=1) without GP_ETC: nothing is written"
        record SKIP memory "test mode without GP_ETC; nothing written"
        return 0
    fi
    if ! make_work; then mg_skip "could not make a private temporary folder"; return 0; fi
    rendered="$GP_WORK/earlyoom.conf"
    if ! mg_render "$rendered"; then mg_skip "could not fill in $MG_TEMPLATE"; return 0; fi

    # What is there now: read-only, so a dry run does it too.
    ver="$(mg_version)"
    [ -n "$ver" ] && installed=1
    cmp -s "$rendered" "$MG_TARGET" && same=1
    systemctl is-enabled --quiet "$MG_UNIT" 2>/dev/null && enabled=1
    systemctl is-active --quiet "$MG_UNIT" 2>/dev/null && active=1
    mg_need_reload && reload=1
    mg_running_ok && running=1
    others="$(mg_others)"
    if [ -n "$others" ]; then
        say "note: other drop-ins for $MG_UNIT are there: $others. One whose name sorts"
        say "  after $MG_DROPIN_NAME and that sets ExecStart replaces this guard's settings."
    fi
    if [ "$installed$same$enabled$active$reload$running" = "111101" ]; then
        say "earlyoom $ver is installed, enabled and running with this drop-in's settings"
        record OK memory "earlyoom $ver running: $(mg_line)"
        return 0
    fi

    if [ "$DRY_RUN" = "1" ]; then
        if [ "$same" = "1" ]; then
            say "$MG_TARGET is already this drop-in"
        else
            say "would write $MG_TARGET (as root); its settings, without the comments:"
            grep -vE '^[[:space:]]*(#|$)' "$rendered" | sed 's/^/    /'
        fi
        if [ "$same" != "1" ] || [ "$reload" = "1" ]; then show_cmd systemctl daemon-reload; fi
        if [ "$installed" != "1" ]; then
            # shellcheck disable=SC2086  # MG_APT_OPTS is a fixed list of words
            show_cmd apt-get $MG_APT_OPTS update -qq
            # shellcheck disable=SC2086
            show_cmd apt-get $MG_APT_OPTS install -y -qq --no-install-recommends "$MG_PACKAGE"
        fi
        show_cmd systemctl enable --quiet "$MG_UNIT"
        show_cmd systemctl restart "$MG_UNIT"
        say "(each as root; a failure would be a warning, not a stop)"
        record PLAN memory "would set up earlyoom: $(mg_line)"
        return 0
    fi

    if ! root_prepare "The memory guard (earlyoom)"; then mg_skip "$ROOT_PROBLEM"; return 0; fi
    # The drop-in first: installing the package starts earlyoom, and that
    # first start should already have these settings.
    if [ "$same" != "1" ]; then
        say "writing $MG_TARGET"
        if ! as_root install -d -m 0755 "$MG_DIR" || ! as_root install -m 0644 "$rendered" "$MG_TARGET"; then
            mg_skip "could not write $MG_TARGET as root"; return 0
        fi
        reload=1
    fi
    if [ "$reload" = "1" ] || mg_need_reload; then
        if ! as_root systemctl daemon-reload; then
            mg_skip "systemctl daemon-reload failed"; return 0
        fi
    fi
    if [ "$installed" != "1" ]; then
        say "installing the $MG_PACKAGE package"
        # A fresh machine may have no package lists yet.
        if ! mg_apt update -qq; then
            warn "apt-get update failed; trying the install anyway"
        fi
        if ! mg_apt install -y -qq --no-install-recommends "$MG_PACKAGE"; then
            say "the drop-in stays at $MG_TARGET, so earlyoom uses it once it is installed"
            mg_skip "apt-get install $MG_PACKAGE failed (on Ubuntu it is in the universe component)"; return 0
        fi
        ver="$(mg_version)"
        if [ -z "$ver" ]; then
            mg_skip "the $MG_PACKAGE package is not installed after apt-get install"; return 0
        fi
    fi
    if ! as_root systemctl enable --quiet "$MG_UNIT"; then
        mg_skip "systemctl enable $MG_UNIT failed"; return 0
    fi
    if ! as_root systemctl restart "$MG_UNIT"; then
        mg_skip "systemctl restart $MG_UNIT failed (see journalctl -u $MG_UNIT)"; return 0
    fi
    sleep "$MG_SETTLE_SECONDS"
    if ! systemctl is-active --quiet "$MG_UNIT" 2>/dev/null; then
        mg_skip "$MG_UNIT stopped again right after its restart (see journalctl -u $MG_UNIT)"; return 0
    fi
    if ! mg_running_ok; then
        if [ -n "$others" ]; then
            mg_skip "$MG_UNIT runs, but not with this drop-in's settings: another drop-in replaces them ($others)"
        else
            mg_skip "$MG_UNIT runs, but not with this drop-in's settings (see systemctl cat $MG_UNIT)"
        fi
        return 0
    fi
    say "earlyoom $ver is running with this drop-in's settings"
    record DONE memory "earlyoom $ver set up and running: $(mg_line)"
    return 0
}

# ---------------------------------------------------------------- the auto-mode guard
#
# Claude Code's auto mode reads three lists of rules from the user's settings
# file (autoMode.allow, soft_deny, hard_deny), and the instance keeps a copy,
# the snapshot, in its repo. A settings save from a stale copy can drop rules,
# and a rule added by hand may never reach the snapshot. The guard is a timer
# outside Claude Code that checks the two every 15 minutes and reports drift
# either way on Buzz, once per change (install/automode-guard/guard says how).
#
# This step installs it when the manifest has [automode_guard] (schema:
# install/schema/instance-v1.md), on Linux with systemd:
#   - a root-owned copy of the guard and the Buzz adapter (its src/,
#     package.json and node_modules/) in
#     /usr/local/lib/ghost-protocol/<name>/automode-guard/, so the instance's
#     user can't change what the timer runs;
#   - the ledger the manifest names, made empty (0600, as the instance's
#     user) when it is not there yet, since the unit binds that one file;
#   - <name>-automode-guard.service and .timer in /etc/systemd/system, made
#     from install/automode-guard/ with the manifest's values, then
#     daemon-reload, the timer enabled and started, and one run now.
# The unit runs as the instance home's owner, never as root: the step refuses
# to run as root (it asks sudo for each root step itself), a home owned by
# root, and a home or $HOME owned by someone other than who runs it. The
# snapshot is read as committed on main (automode_snapshot_blob,
# install/lib/instance.sh). A dry run prints both units in full.
# Credentials for the key command go in the instance's own drop-in,
# /etc/systemd/system/<name>-automode-guard.service.d/; this step never writes
# one. enabled = "false" turns the step off and prints how to remove an
# earlier one. Any failure is a warning, a SKIP line, and the run goes on.
# install/automode-guard/setup runs this same step on its own, and removes it.

AG_SRC="$GP_DIR/install/automode-guard"
AG_UNIT=""; AG_ETC=""; AG_LIB=""; AG_STATE=""; AG_SNAPSHOT=""; AG_NODE=""
AG_BUZZ=""; AG_USER=""; AG_GROUP=""; AG_HOME=""; AG_READ=""; AG_WHY=""; AG_REPO=""
AG_LEDGER=""; AG_LEDGER_LINE=""
AG_RE_PATH='^/[A-Za-z0-9._/+-]+$'

# Where the units, the root-owned copy and the state go. Tests point them at
# folders of their own (GP_ETC, GP_LIBDIR and GP_VARLIB, honoured only when
# GP_TEST=1); a test without GP_ETC and GP_LIBDIR gets no path, so nothing is
# written.
ag_paths() {
    local etc=/etc lib=/usr/local/lib var=/var/lib
    AG_UNIT="$M_NAME-automode-guard"
    if [ "${GP_TEST:-}" = "1" ]; then
        etc="${GP_ETC:-}"; lib="${GP_LIBDIR:-}"; var="${GP_VARLIB:-${GP_ETC:-}/var-lib}"
        if [ -n "$etc" ] && [ -n "$lib" ]; then
            echo "install: TEST MODE (GP_TEST=1): the auto-mode guard uses $etc, $lib and $var" >&2
        fi
    fi
    AG_ETC=""; AG_LIB=""; AG_STATE=""
    [ -n "$etc" ] && [ -n "$lib" ] || return 1
    AG_ETC="$etc/systemd/system"
    AG_LIB="$lib/ghost-protocol/$M_NAME/automode-guard"
    AG_STATE="$var/ghost-protocol/$AG_UNIT"
}

# node 22 or later, as a real path (the unit runs it by that path). Sets
# AG_NODE, or AG_WHY and returns 1.
ag_node() {
    local p v
    AG_NODE=""
    if ! command -v node >/dev/null 2>&1; then AG_WHY="node is not installed (the send needs node 22 or later)"; return 1; fi
    p="$(node -e 'process.stdout.write(process.execPath)' 2>/dev/null)"
    v="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
    case "$v" in ''|*[!0-9]*) AG_WHY="could not read node's version"; return 1 ;; esac
    if [ "$v" -lt 22 ]; then AG_WHY="node $v is too old (the send needs node 22 or later)"; return 1; fi
    if ! [[ $p =~ $AG_RE_PATH ]] || [ ! -f "$p" ]; then AG_WHY="node's path is not a plain file path: $p"; return 1; fi
    AG_NODE="$p"
}

# The owner of a path, as "uid user group" (GNU stat, else BSD stat).
ag_owner() {
    stat -c '%u %U %G' "$1" 2>/dev/null || stat -f '%u %Su %Sg' "$1" 2>/dev/null
}

# The values the unit is made from: each a plain path or word, so nothing in
# them can change what systemd or sh reads. Sets AG_* or AG_WHY.
ag_values() {
    local home p a lines="" re_name='^[a-z_][a-z0-9_-]*$' me o_uid o_user o_group h_uid h_rest oid b
    # Never a root unit: the user is the instance home's owner, and that is
    # who runs this step, not root.
    me="$(id -u)"
    if [ "$me" = "0" ]; then
        AG_WHY="this step runs as root; run the installer as the instance's user, which gets root for each root step itself, so the guard never runs as root"
        return 1
    fi
    AG_REPO="$(phys "$INSTANCE_DIR")"
    if ! [[ $AG_REPO =~ $AG_RE_PATH ]]; then AG_WHY="the instance repo is not a plain path: $AG_REPO"; return 1; fi
    read -r o_uid o_user o_group <<EOF
$(ag_owner "$AG_REPO")
EOF
    case "$o_uid" in ''|*[!0-9]*) AG_WHY="could not tell who owns $AG_REPO"; return 1 ;; esac
    if [ "$o_uid" = "0" ]; then AG_WHY="the instance repo $AG_REPO is owned by root; the guard runs as its owner, never as root"; return 1; fi
    if [ "$o_uid" != "$me" ]; then
        AG_WHY="the instance repo $AG_REPO is owned by $o_user (uid $o_uid), not by $(id -un) (uid $me), who runs this; run it as $o_user"
        return 1
    fi
    AG_USER="$o_user"; AG_GROUP="$o_group"
    if ! [[ $AG_USER =~ $re_name ]] || ! [[ $AG_GROUP =~ $re_name ]]; then
        AG_WHY="the user or group name is not a plain name ($AG_USER:$AG_GROUP)"; return 1
    fi
    home="$(phys "$HOME")"
    if ! [[ $home =~ $AG_RE_PATH ]]; then AG_WHY="the home folder is not a plain path: $home"; return 1; fi
    read -r h_uid h_rest <<EOF
$(ag_owner "$home")
EOF
    if [ "$h_uid" != "$me" ]; then AG_WHY="HOME ($home) is not $AG_USER's own folder"; return 1; fi
    AG_HOME="$home"
    for b in /bin/bash /usr/bin/python3 /usr/bin/git; do
        [ -x "$b" ] || { AG_WHY="the guard runs $b, and it is not there"; return 1; }
    done
    # As committed on main, a plain file: never the working tree, never a symlink.
    if ! oid="$(automode_snapshot_blob "$AG_REPO" "$M_AUTOMODE_GUARD_SNAPSHOT")"; then AG_WHY="$oid"; return 1; fi
    AG_SNAPSHOT="$M_AUTOMODE_GUARD_SNAPSHOT"
    while IFS= read -r p; do
        [ -n "$p" ] || continue
        a="$(expand_home "$p")"
        if ! [[ $a =~ $AG_RE_PATH ]]; then AG_WHY="read path $p is not a plain path"; return 1; fi
        [ -e "$a" ] || warn "the auto-mode guard: read path $a is not there; the key command may fail without it"
        lines="${lines}BindReadOnlyPaths=-$a
"
    done <<EOF
$M_AUTOMODE_GUARD_READ_PATHS
EOF
    AG_READ="${lines%
}"
    # The ledger: a plain file the unit binds read-write, never the settings
    # file and never a symlink (the bind would follow it). Left out, the
    # guard keeps its own in its state folder, and the unit binds nothing.
    AG_LEDGER=""; AG_LEDGER_LINE=""
    if [ -n "$M_AUTOMODE_GUARD_LEDGER" ]; then
        a="$(expand_home "$M_AUTOMODE_GUARD_LEDGER")"
        if ! [[ $a =~ $AG_RE_PATH ]]; then AG_WHY="the ledger $M_AUTOMODE_GUARD_LEDGER is not a plain path"; return 1; fi
        if [ "$a" = "$home/.claude/settings.json" ] || [ "$(phys "$a")" = "$(phys "$home/.claude/settings.json")" ]; then
            AG_WHY="the ledger can't be the settings file"; return 1
        fi
        if [ -L "$a" ]; then AG_WHY="the ledger $a is a symlink; name the file itself"; return 1; fi
        if [ -e "$a" ] && [ ! -f "$a" ]; then AG_WHY="the ledger $a is not a plain file"; return 1; fi
        if [ ! -e "$a" ] && [ ! -d "${a%/*}" ]; then AG_WHY="the ledger's folder ${a%/*} is not there"; return 1; fi
        AG_LEDGER="$a"; AG_LEDGER_LINE="BindPaths=-$a"
    fi
    return 0
}

# The Buzz adapter whose send the guard uses, with its dependencies installed.
ag_buzz() {
    AG_BUZZ="$GP_DIR/adapters/buzz"
    if [ "${GP_TEST:-}" = "1" ] && [ -n "${GP_GUARD_BUZZ_SRC:-}" ]; then AG_BUZZ="$GP_GUARD_BUZZ_SRC"; fi
    if [ ! -f "$AG_BUZZ/src/launch.mjs" ] || [ ! -f "$AG_BUZZ/src/send.mjs" ]; then
        AG_WHY="the Buzz adapter's send is missing in $AG_BUZZ"; return 1
    fi
    if [ ! -f "$AG_BUZZ/node_modules/nostr-tools/package.json" ] \
        || [ ! -f "$AG_BUZZ/node_modules/@modelcontextprotocol/sdk/package.json" ]; then
        AG_WHY="the Buzz adapter's dependencies are not installed in $AG_BUZZ (run: npm ci --omit=dev --ignore-scripts there, or start the Buzz channel once)"
        return 1
    fi
}

# A template with the values filled in. Values never hold & or \ (each was
# checked above), so awk's gsub passes them on as written.
ag_render() {   # template dest
    AGR_NAME="$M_NAME" AGR_USER="$AG_USER" AGR_GROUP="$AG_GROUP" AGR_HOME="$AG_HOME" \
    AGR_LIB="$AG_LIB" AGR_SNAPSHOT="$AG_SNAPSHOT" AGR_NODE="$AG_NODE" AGR_REPO="$AG_REPO" \
    AGR_CHANNEL="$M_AUTOMODE_GUARD_CHANNEL" AGR_RELAY="$M_AUTOMODE_GUARD_RELAY_URL" \
    AGR_KEY="$M_AUTOMODE_GUARD_KEY_COMMAND" AGR_READ="$AG_READ" \
    AGR_LEDGER="$AG_LEDGER" AGR_LEDGER_LINE="$AG_LEDGER_LINE" AGR_OWNER="$M_AUTOMODE_GUARD_OWNER" \
    AGR_TASK_EMOJI="$M_AUTOMODE_GUARD_TASK_EMOJI" AGR_TASK_EMOJI_URL="$M_AUTOMODE_GUARD_TASK_EMOJI_URL" \
    AGR_MENTIONS="$(printf '%s' "$M_AUTOMODE_GUARD_MENTIONS" | tr '\n' ' ' | sed 's/ $//')" \
    awk '
        $0 == "@READ_PATHS@" { if (ENVIRON["AGR_READ"] != "") print ENVIRON["AGR_READ"]; next }
        $0 == "@LEDGER_PATHS@" { if (ENVIRON["AGR_LEDGER_LINE"] != "") print ENVIRON["AGR_LEDGER_LINE"]; next }
        {
            line = $0
            gsub(/@NAME@/, ENVIRON["AGR_NAME"], line); gsub(/@USER@/, ENVIRON["AGR_USER"], line)
            gsub(/@GROUP@/, ENVIRON["AGR_GROUP"], line); gsub(/@HOME@/, ENVIRON["AGR_HOME"], line)
            gsub(/@LIB@/, ENVIRON["AGR_LIB"], line); gsub(/@SNAPSHOT@/, ENVIRON["AGR_SNAPSHOT"], line)
            gsub(/@NODE@/, ENVIRON["AGR_NODE"], line); gsub(/@CHANNEL@/, ENVIRON["AGR_CHANNEL"], line)
            gsub(/@RELAY_URL@/, ENVIRON["AGR_RELAY"], line); gsub(/@KEY_COMMAND@/, ENVIRON["AGR_KEY"], line)
            gsub(/@MENTIONS@/, ENVIRON["AGR_MENTIONS"], line); gsub(/@REPO@/, ENVIRON["AGR_REPO"], line)
            gsub(/@LEDGER@/, ENVIRON["AGR_LEDGER"], line); gsub(/@OWNER@/, ENVIRON["AGR_OWNER"], line)
            gsub(/@TASK_EMOJI_URL@/, ENVIRON["AGR_TASK_EMOJI_URL"], line); gsub(/@TASK_EMOJI@/, ENVIRON["AGR_TASK_EMOJI"], line)
            print line
        }' "$1" >"$2" || return 1
    ! grep -q '@[A-Z_]*@' "$2"
}

# What goes into the root-owned folder, put together as the user first.
ag_stage() {   # dest
    local d="$1"
    mkdir -p "$d/buzz" \
        && cp "$AG_SRC/guard" "$d/guard" \
        && cp -R "$AG_BUZZ/src" "$d/buzz/src" && cp "$AG_BUZZ/package.json" "$d/buzz/package.json" \
        && cp -R "$AG_BUZZ/node_modules" "$d/buzz/node_modules" \
        && chmod -R go-w "$d" && chmod 0755 "$d/guard"
}

ag_skip() {   # why
    warn "the auto-mode guard was not set up: $1."
    warn "The instance runs without it: a change to the auto-mode rules goes unreported."
    record SKIP automode "$1"
}

ag_line() {
    printf 'every 15 min, as %s, Buzz channel %s, snapshot %s on main, %s' "${AG_USER:-the instance owner}" \
        "$M_AUTOMODE_GUARD_CHANNEL" "$M_AUTOMODE_GUARD_SNAPSHOT" \
        "$([ -n "$M_AUTOMODE_GUARD_OWNER" ] && echo "answers from the owner's key" || echo "no owner: no answers read")"
}

automode_guard() {
    local stage unit timer same_lib=0 same_unit=0 same_timer=0 enabled=0 active=0 result
    if [ "$M_AUTOMODE_GUARD_SET" != "1" ]; then
        say "the auto-mode guard: not set up (the manifest has no [automode_guard])"
        record SKIP automode "not set up: the manifest has no [automode_guard]"
        return 0
    fi
    AG_UNIT="$M_NAME-automode-guard"
    if [ "$M_AUTOMODE_GUARD_ENABLED" = "false" ]; then
        say "the auto-mode guard is turned off in the manifest ([automode_guard] enabled = \"false\")."
        ag_hand_undo
        record SKIP automode "turned off in the manifest; one already set up is left as it is"
        return 0
    fi
    if [ "$GP_OS" != "linux" ]; then
        say "the auto-mode guard is a systemd timer, for Linux; nothing to do on $GP_OS"
        record SKIP automode "a systemd timer, for Linux; nothing to do on $GP_OS"
        return 0
    fi
    # Its send runs the relay key command as the instance's user, which a key
    # service exists to rule out.
    if keyservice_commit >/dev/null; then
        say "the auto-mode guard: not set up, since instance $M_NAME has a key service. The guard's send runs"
        say "  the relay key command as the instance's user, a way to the key for that user's processes;"
        say "  its send from the key's side comes in a later change."
        record SKIP automode "instance $M_NAME has a key service; the guard's send from the key's side comes later"
        return 0
    fi
    say "the auto-mode guard: $(ag_line)"
    if ! command -v systemctl >/dev/null 2>&1; then ag_skip "no systemd here (systemctl is missing)"; return 0; fi
    if ! ag_paths; then
        say "TEST MODE (GP_TEST=1) without GP_ETC and GP_LIBDIR: nothing is written"
        record SKIP automode "test mode without GP_ETC and GP_LIBDIR; nothing written"
        return 0
    fi
    if ! ag_values || ! ag_node || ! ag_buzz; then ag_skip "$AG_WHY"; return 0; fi
    if ! make_work; then ag_skip "could not make a private temporary folder"; return 0; fi
    stage="$GP_WORK/automode-guard"; unit="$GP_WORK/$AG_UNIT.service"; timer="$GP_WORK/$AG_UNIT.timer"
    rm -rf "$stage"
    if ! ag_stage "$stage"; then ag_skip "could not put the guard's files together"; return 0; fi
    if ! ag_render "$AG_SRC/automode-guard.service" "$unit" || ! ag_render "$AG_SRC/automode-guard.timer" "$timer"; then
        ag_skip "could not fill in the unit templates in $AG_SRC"; return 0
    fi
    say "node: $AG_NODE (rerun this step after node moves, for example after a version manager's upgrade)"

    # What is there now: read-only, so a dry run does it too.
    [ -d "$AG_LIB" ] && diff -rq "$stage" "$AG_LIB" >/dev/null 2>&1 && same_lib=1
    cmp -s "$unit" "$AG_ETC/$AG_UNIT.service" && same_unit=1
    cmp -s "$timer" "$AG_ETC/$AG_UNIT.timer" && same_timer=1
    systemctl is-enabled --quiet "$AG_UNIT.timer" 2>/dev/null && enabled=1
    systemctl is-active --quiet "$AG_UNIT.timer" 2>/dev/null && active=1
    [ -d "$AG_ETC/$AG_UNIT.service.d" ] \
        || say "note: no drop-in in $AG_ETC/$AG_UNIT.service.d/; if the key command needs a credential or a setting, put it there (see the unit's comments)"
    if [ "$same_lib$same_unit$same_timer$enabled$active" = "11111" ] && { [ -z "$AG_LEDGER" ] || [ -e "$AG_LEDGER" ]; }; then
        say "the auto-mode guard is installed and its timer is running, as this run would set it up"
        record OK automode "installed and running: $(ag_line)"
        return 0
    fi

    if [ "$DRY_RUN" = "1" ]; then
        if [ "$same_lib" = "1" ]; then say "$AG_LIB is already this copy"
        else say "would copy the guard and the Buzz adapter to $AG_LIB (root-owned)"; fi
        if [ -n "$AG_LEDGER" ] && [ ! -e "$AG_LEDGER" ]; then say "would make an empty ledger at $AG_LEDGER (0600, as $AG_USER)"; fi
        for f in "$unit" "$timer"; do
            if cmp -s "$f" "$AG_ETC/${f##*/}"; then say "$AG_ETC/${f##*/} is already this file"; continue; fi
            if [ -f "$AG_ETC/${f##*/}" ]; then
                say "would replace $AG_ETC/${f##*/} (as root); the differences:"
                diff -u "$AG_ETC/${f##*/}" "$f" | sed 's/^/    /' || true
                say "the new file in full:"
            else say "would write $AG_ETC/${f##*/} (as root), this file in full:"; fi
            sed 's/^/    | /' "$f"
        done
        show_cmd systemctl daemon-reload
        show_cmd systemctl enable --now "$AG_UNIT.timer"
        show_cmd systemctl start "$AG_UNIT.service"
        say "(each as root; a failure would be a warning, not a stop)"
        say "what that first run would do now (the guard's own --dry-run, read-only):"
        env -i PATH="/usr/bin:/bin" HOME="$HOME" LANG=C.UTF-8 GP_GUARD_NAME="$M_NAME" \
            GP_GUARD_REPO="$AG_REPO" GP_GUARD_SNAPSHOT="$AG_SNAPSHOT" GP_GUARD_CHANNEL="$M_AUTOMODE_GUARD_CHANNEL" \
            GP_GUARD_LEDGER="$AG_LEDGER" GP_GUARD_OWNER="$M_AUTOMODE_GUARD_OWNER" \
            GP_TEST="${GP_TEST:-}" GP_GUARD_STATE="${GP_GUARD_STATE:-}" \
            "$stage/guard" --dry-run 2>&1 | sed 's/^/    /' || true
        record PLAN automode "would install the auto-mode guard: $(ag_line)"
        return 0
    fi

    if ! root_prepare "The auto-mode guard"; then ag_skip "$ROOT_PROBLEM"; return 0; fi
    if [ -n "$AG_LEDGER" ] && [ ! -e "$AG_LEDGER" ]; then
        say "making an empty ledger at $AG_LEDGER"
        if ! ( umask 077 && : >>"$AG_LEDGER" ); then ag_skip "could not make the ledger $AG_LEDGER"; return 0; fi
    fi
    if [ "$same_lib" != "1" ]; then
        say "copying the guard to $AG_LIB"
        if ! as_root rm -rf "$AG_LIB.new" "$AG_LIB.old" \
            || ! as_root install -d -m 0755 "${AG_LIB%/*}" \
            || ! as_root cp -R "$stage" "$AG_LIB.new" \
            || ! as_root chmod -R go-w "$AG_LIB.new"; then
            ag_skip "could not copy the guard to $AG_LIB.new as root"; return 0
        fi
        if [ -d "$AG_LIB" ] && ! as_root mv "$AG_LIB" "$AG_LIB.old"; then
            ag_skip "could not move the old $AG_LIB aside"; return 0
        fi
        if ! as_root mv "$AG_LIB.new" "$AG_LIB"; then ag_skip "could not put $AG_LIB in place"; return 0; fi
        as_root rm -rf "$AG_LIB.old" || warn "could not remove $AG_LIB.old"
    fi
    for f in "$unit" "$timer"; do
        cmp -s "$f" "$AG_ETC/${f##*/}" && continue
        say "writing $AG_ETC/${f##*/}"
        if ! as_root install -m 0644 "$f" "$AG_ETC/${f##*/}"; then ag_skip "could not write $AG_ETC/${f##*/} as root"; return 0; fi
    done
    if ! as_root systemctl daemon-reload; then ag_skip "systemctl daemon-reload failed"; return 0; fi
    if ! as_root systemctl enable --now "$AG_UNIT.timer"; then ag_skip "systemctl enable --now $AG_UNIT.timer failed"; return 0; fi
    say "the first run now (systemctl start $AG_UNIT.service):"
    if as_root systemctl start "$AG_UNIT.service"; then result="its first run finished"
    else result="its first run exited non-zero (see journalctl -u $AG_UNIT)"; warn "the auto-mode guard: $result"; fi
    say "the auto-mode guard is installed; $result"
    record DONE automode "installed, the timer running; $result: $(ag_line)"
    return 0
}

# Removes the guard: install/automode-guard/setup --uninstall. The instance's
# drop-in (<unit>.service.d/) is the operator's, and stays.
automode_guard_uninstall() {
    AG_UNIT="$M_NAME-automode-guard"
    if ! ag_paths; then
        say "TEST MODE (GP_TEST=1) without GP_ETC and GP_LIBDIR: nothing is removed"
        record SKIP automode "test mode without GP_ETC and GP_LIBDIR; nothing removed"
        return 0
    fi
    if [ "$DRY_RUN" = "1" ]; then
        show_cmd systemctl disable --now "$AG_UNIT.timer"
        show_cmd systemctl stop "$AG_UNIT.service"
        show_cmd rm -f "$AG_ETC/$AG_UNIT.service" "$AG_ETC/$AG_UNIT.timer"
        show_cmd rm -rf "$AG_LIB" "$AG_LIB.new" "$AG_LIB.old" "$AG_STATE"
        show_cmd rmdir "${AG_LIB%/*}"
        show_cmd systemctl daemon-reload
        show_cmd systemctl reset-failed "$AG_UNIT.service"
        say "(each as root; rmdir only when the folder is empty; the drop-in $AG_ETC/$AG_UNIT.service.d/ is the instance's, and stays)"
        record PLAN automode "would remove the auto-mode guard"
        return 0
    fi
    if ! root_prepare "Removing the auto-mode guard"; then record FAIL automode "$ROOT_PROBLEM"; return 1; fi
    as_root systemctl disable --now "$AG_UNIT.timer" || warn "no timer to disable"
    as_root systemctl stop "$AG_UNIT.service" || warn "no service to stop"
    as_root rm -f "$AG_ETC/$AG_UNIT.service" "$AG_ETC/$AG_UNIT.timer" || { record FAIL automode "could not remove the units"; return 1; }
    as_root rm -rf "$AG_LIB" "$AG_LIB.new" "$AG_LIB.old" "$AG_STATE" \
        || { record FAIL automode "could not remove $AG_LIB (with its .new and .old) or $AG_STATE"; return 1; }
    as_root rmdir "${AG_LIB%/*}" 2>/dev/null || true
    as_root systemctl daemon-reload || warn "systemctl daemon-reload failed"
    as_root systemctl reset-failed "$AG_UNIT.service" 2>/dev/null || true
    say "removed; the drop-in $AG_ETC/$AG_UNIT.service.d/ is the instance's, and stays"
    record DONE automode "removed the auto-mode guard"
    return 0
}

# ---------------------------------------------------------------- a key service

# The commit an instance's key service runs, when it has one: the relay key
# then lives with a separate OS user, set up by the admin with
# install/keyservice/setup, and /etc/ghost-protocol/<name>/commit (readable by
# everyone) names the commit of its root-owned code. Status 1 when there is
# none. Tests point /etc at GP_ETC (GP_TEST=1).
keyservice_commit() {
    local etc=/etc f
    if [ "${GP_TEST:-}" = "1" ]; then etc="${GP_ETC:-/nonexistent}"; fi
    [ -n "$M_NAME" ] || return 1
    f="$etc/ghost-protocol/$M_NAME/commit"
    [ -f "$f" ] || return 1
    tr -d '[:space:]' <"$f"
}

# On an update: the key service's code is a root-owned copy of its own commit,
# which only the admin moves (this run is the instance's user's, and that user
# has no root on a machine with a key service). One line says what to run.
keyservice_note() {
    local c
    c="$(keyservice_commit)" || return 0
    if [ "$c" = "$GP_COMMIT" ]; then
        say "the key service of $M_NAME runs $c too"
        record OK keyservice "the key service runs $c too"
        return 0
    fi
    say "instance $M_NAME has a key service, at $c. Its code is root-owned, so the admin moves it to"
    say "  $GP_COMMIT, from the admin's own checkout at that commit; it restarts the instance once more:"
    say "  install/keyservice/setup --name $M_NAME --agent-user $(id -un) --update --commit $GP_COMMIT --apply"
    record SKIP keyservice "the key service runs $c; the admin moves it to $GP_COMMIT (install/keyservice/setup --update)"
}

# The instance's unit after an update; see the top of this file.
service_restart() {
    local unit prev="${GP_PREVIOUS_COMMIT:-}"
    [ "$UPDATE_MODE" = "1" ] || return 0
    if [ -z "$M_NAME" ]; then
        record SKIP restart "no instance name (the manifest was not read); restart the instance yourself"
        return 0
    fi
    unit="$M_NAME.service"
    if [ -z "$prev" ] || [ "$prev" = "$GP_COMMIT" ]; then
        say "the checkout did not move (it is at $GP_COMMIT); $unit is not restarted"
        record OK restart "the checkout did not move; $unit not restarted"
        return 0
    fi
    if [ "$GP_OS" != "linux" ] || ! command -v systemctl >/dev/null 2>&1; then
        say "no systemd here: restart instance $M_NAME yourself, so that it runs $GP_COMMIT"
        record SKIP restart "no systemd here; restart instance $M_NAME yourself"
        return 0
    fi
    if [ "$(systemctl show -p LoadState --value "$unit" 2>/dev/null)" != "loaded" ]; then
        say "$unit is not installed (install/service/start --print-unit prints it);"
        say "  restart instance $M_NAME yourself, so that it runs $GP_COMMIT"
        record SKIP restart "$unit is not installed; restart instance $M_NAME yourself"
        return 0
    fi
    if ! systemctl is-active --quiet "$unit" 2>/dev/null; then
        say "$unit is not running; left stopped. It runs $GP_COMMIT when it is started."
        record OK restart "$unit not running; left stopped (it runs $GP_COMMIT when started)"
        return 0
    fi
    if [ "$DRY_RUN" = "1" ]; then
        say "would restart $unit as root, so that it runs $GP_COMMIT (it runs $prev now):"
        show_cmd systemctl try-restart "$unit"
        record PLAN restart "would restart $unit, so that it runs $GP_COMMIT (now $prev)"
        return 0
    fi
    if ! root_prepare "restarting $unit"; then
        warn "$unit was not restarted: $ROOT_PROBLEM. It still runs $prev. Restart it by hand:"
        restart_hand "$unit"
        record FAIL restart "$unit not restarted ($ROOT_PROBLEM); it still runs $prev (the command is above)"
        return 1
    fi
    say "restarting $unit"
    if ! as_root systemctl try-restart "$unit" </dev/null; then
        warn "systemctl try-restart $unit failed. Restart it by hand, then check journalctl -u $unit:"
        restart_hand "$unit"
        record FAIL restart "systemctl try-restart $unit failed; it may still run $prev"
        return 1
    fi
    if ! systemctl is-active --quiet "$unit" 2>/dev/null; then
        warn "$unit is not running after the restart. Check: journalctl -u $unit"
        record FAIL restart "$unit is not running after the restart (journalctl -u $unit)"
        return 1
    fi
    say "restarted $unit: it runs $GP_COMMIT"
    record DONE restart "restarted $unit: it runs $GP_COMMIT (it ran $prev)"
    return 0
}

step_service() {
    heading "14. service"
    memory_guard
    automode_guard
    memory_backup
    service_restart || return 1
    [ "$UPDATE_MODE" = "1" ] && keyservice_note
    if [ "$DRY_RUN" = "1" ]; then
        say "would: the boot service (its unit: install/service/start --print-unit) (built in $BOOT_PR)"
        record PLAN service "the boot service (its unit: install/service/start --print-unit): built in $BOOT_PR"
    else
        say "skipped: the boot service (its unit: install/service/start --print-unit) (built in $BOOT_PR)"
        record SKIP service "the boot service (its unit: install/service/start --print-unit): built in $BOOT_PR"
    fi
    return 0
}
