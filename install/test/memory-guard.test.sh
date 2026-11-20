#!/usr/bin/env bash
# memory-guard.test.sh: step 14's first part, the memory guard (earlyoom with
# GHOST Protocol's drop-in, install/memory-guard/earlyoom.conf).
#   - The drop-in: its two name patterns pick the right processes, checked
#     with grep -E against real process names (/proc/PID/comm) as earlyoom
#     compiles them (POSIX extended). MCP servers and channels (node, bun,
#     "npm exec ...", python) are never preferred. It clears the package's
#     ExecStart first, holds nothing systemd would change apart from "$$", and
#     uses only options every packaged earlyoom (1.6 and later) knows.
#   - On Linux, on the vm profile (the laptop profile only with enabled =
#     "true"), the installer writes the drop-in, reloads systemd, installs the
#     package (apt-get update first; no terminal, a lock timeout, the old
#     config files kept), then enables and restarts earlyoom. It checks that
#     earlyoom stays up and runs with exactly the drop-in's command line. A
#     second run with everything in place changes nothing. The thresholds
#     come from the manifest's [memory_guard] (default 15 and 8); enabled =
#     "false" turns the step off and prints how to undo an earlier one.
#   - Root: a run with --yes uses sudo -n only (one probe first) and never
#     waits for a password; an interactive run asks once with sudo -v.
#   - Any failure is a warning with the commands to run by hand, a SKIP line,
#     exit 0, and the run reaching its end.
#   - On macOS it is skipped with an info line. A dry run runs nothing as
#     root and writes nothing.
# uname is a stub, so the Linux cases run on macOS too. Root steps go through
# the stub sudo: with $T/state/sudo.allow it runs the command as the test's
# own user, against stub systemctl and apt-get. The drop-in lands under
# $T/etc and earlyoom's command line under $T/etc/proc (GP_ETC, honoured only
# when GP_TEST=1). The stub systemctl models how systemd loads drop-ins.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

CONF="$SRC/install/memory-guard/earlyoom.conf"
README="$SRC/README.md"
I=(--instance example/instance --yes)

stub_uname() {   # system machine
    # shellcheck disable=SC2016  # the stub's own $1, written as is
    printf '#!/bin/sh\ncase "$1" in -s) echo %s ;; -m) echo %s ;; *) echo %s ;; esac\n' "$1" "$2" "$1" >"$T/stubs/uname"
    chmod +x "$T/stubs/uname"
}
stub_id_root() {   # id -u answers 0; everything else goes to the real id
    # shellcheck disable=SC2016  # the stub's own $1 and $0, written as is
    printf '#!/bin/sh\n[ "$1" = "-u" ] && { echo 0; exit 0; }\nexec "$(dirname "$0")/../sysbin/id" "$@"\n' >"$T/stubs/id"
    chmod +x "$T/stubs/id"
}

# ---------------------------------------------------------------- the drop-in

t_new
line="$(grep -E '^ExecStart=/' "$CONF")"
cmd="${line#ExecStart=}"
check "one ExecStart command line" [ "$(grep -cE '^ExecStart=/' "$CONF")" = 1 ]
check "the package's ExecStart is cleared first" \
    sh -c "[ \"\$(grep -nxE 'ExecStart=' '$CONF' | cut -d: -f1)\" -lt \"\$(grep -nE '^ExecStart=/' '$CONF' | cut -d: -f1)\" ]"
check "the ExecStart line is earlyoom itself" sh -c "printf '%s' '$line' | grep -q '^ExecStart=/usr/bin/earlyoom '"
# systemd changes a command line through quotes, backslashes, ";", "%"
# specifiers and "$" variables. With none of them, and every "$" doubled, it
# passes the line on as written with "$$" read as "$", which is all the checks
# below model.
plain_chars()     { printf '%s\n' "$cmd" | grep -qxE '[][A-Za-z0-9 /._,|()^*?+@$-]+'; }
no_special()      { ! printf '%s' "$cmd" | grep -q '["\\;%]'; }
dollars_doubled() { ! printf '%s' "$cmd" | sed 's/[$][$]//g' | grep -q '[$]'; }
check "the ExecStart line holds only characters systemd passes on as they are" plain_chars
check "no quote, backslash, ; or % in the ExecStart line" no_special
check "every \$ in the ExecStart line is written \$\$" dollars_doubled
check "OOMScoreAdjust=-1000 (earlyoom outlives what it kills)" grep -qx 'OOMScoreAdjust=-1000' "$CONF"
check "Nice=-20" grep -qx 'Nice=-20' "$CONF"

# The word after a flag, with systemd's "$$" back to "$".
arg() { printf '%s\n' "$line" | awk -v f="$1" '{ for (i = 1; i < NF; i++) if ($i == f) print $(i + 1) }' | sed 's/\$\$/$/g'; }
AVOID="$(arg --avoid)"
PREFER="$(arg --prefer)"
check "--avoid pattern found" [ -n "$AVOID" ]
check "--prefer pattern found" [ -n "$PREFER" ]
check "-m takes the two thresholds" [ "$(arg -m)" = "@TERM_PERCENT@,@KILL_PERCENT@" ]
check "-s 100,100 (memory alone decides, for SIGTERM and SIGKILL)" [ "$(arg -s)" = "100,100" ]
check "-r 600 (a memory line every 10 minutes)" [ "$(arg -r)" = "600" ]
case " $line " in *" -g "*) bad "-g is set (would kill claude's whole process group)" ;; *) ok "-g is not set" ;; esac
# Only options earlyoom 1.6 (Ubuntu 22.04) already has: an unknown one makes it exit at once.
opts="$(printf '%s\n' "$line" | tr ' ' '\n' | grep -E '^-' | sort -u | tr '\n' ' ')"
check "only -r -m -s --avoid --prefer (known to earlyoom 1.6 and later)" [ "$opts" = "--avoid --prefer -m -r -s " ]

matches() { printf '%s' "$2" | grep -Eq -- "$1"; }

# Names as /proc/PID/comm shows them (15 characters at most).
# start is the instance's watchdog (install/service/start runs as /bin/bash,
# so its process name is its own).
KEEP=(claude start "tmux: server" "tmux: client" systemd systemd-journal systemd-logind systemd-timesyn
      "(sd-pam)" init sshd sshd-session dbus-daemon dbus-broker cron zsh)
RUNAWAY=(esbuild cargo rustc go pytest tesseract convert magick)
# MCP servers and channels (never preferred), and names a test runner never
# shows (it runs as node): ranked by size alone.
NEITHER=(node bun "npm exec @playw" npm npx "node (vitest 1)" vitest jest tsc python3 python python3.12
         uv uvx java git git-remote-http bash sh sleep starter restart gh jq curl rg zsh5 claude-code gopls)

for n in "${KEEP[@]}"; do
    if matches "$AVOID" "$n"; then ok "avoid: $n"; else bad "avoid does not match $n"; fi
    if matches "$PREFER" "$n"; then bad "prefer matches $n, which must be kept"; fi
done
for n in "${RUNAWAY[@]}"; do
    if matches "$PREFER" "$n"; then ok "prefer: $n"; else bad "prefer does not match $n"; fi
    if matches "$AVOID" "$n"; then bad "avoid matches $n, a usual runaway"; fi
done
for n in "${NEITHER[@]}"; do
    if matches "$AVOID" "$n" || matches "$PREFER" "$n"; then bad "$n matches a list (want neither)"; else ok "neither: $n"; fi
done

check "README: a memory guard section" grep -q '^## Memory guard' "$README"
check "README: how to undo it" grep -qx 'sudo rm /etc/systemd/system/earlyoom.service.d/ghost-protocol.conf' "$README"
check "README: how to turn it off for good" grep -q 'enabled = "false"' "$README"
check "README: MCP servers are ranked by size, not picked first" grep -q 'ranked by size alone' "$README"

# ---------------------------------------------------------------- the step

DROPIN_REL="systemd/system/earlyoom.service.d/ghost-protocol.conf"
# A Linux machine (vm profile) with apt and systemd (stubs), sudo that runs the
# command as the test user without a password, and the instance not cloned yet.
mg_world() {
    t_new; t_std_env
    stub_uname Linux x86_64
    t_stub systemctl; t_stub apt-get; t_stub dpkg-query
    t_tool install || echo "SKIP  no install(1) on this machine"
    touch "$T/state/sudo.allow"
    mkdir -p "$T/etc"
    t_make_instance "$FIX/manifests/good.toml"
}
# The installer, with a line waiting on stdin: apt-get must never read it.
mg_install() {   # installer args
    printf 'stdin-canary\n' | t_env GP_ETC="$T/etc" "$SRC/install/install" "$@" >"$OUT" 2>&1
    RC=$?
}
mg_systemctl() { t_env GP_ETC="$T/etc" "$T/stubs/systemctl" "$@" >/dev/null 2>&1; }
dropin()  { printf '%s' "$T/etc/$DROPIN_REL"; }
dropdir() { printf '%s' "$T/etc/systemd/system/earlyoom.service.d"; }
# earlyoom's command line now, as /proc shows it, arguments joined by spaces.
running() { tr '\0' ' ' <"$T/etc/proc/$(cat "$T/state/earlyoom.pid")/cmdline"; }
# A machine where everything is already set up as this run would, running.
mg_in_place() {   # term kill
    mkdir -p "$(dropdir)"
    sed -e "s/@TERM_PERCENT@/$1/g" -e "s/@KILL_PERCENT@/$2/g" "$CONF" >"$(dropin)"
    echo "1.7-2" >"$T/state/dpkg.earlyoom"
    mg_systemctl daemon-reload; mg_systemctl enable earlyoom; mg_systemctl restart earlyoom
    : >"$T/state/calls"
}
manifest_with() {   # lines for [memory_guard]
    { cat "$FIX/manifests/good.toml"; printf '\n[memory_guard]\n'; printf '%s\n' "$@"; } >"$T/m.toml"
    t_make_instance "$T/m.toml"
}
went_on()     { out_has '== 16\. status'; }
no_root_run() { not_called sudo && ! grep -qE '^(apt-get|systemctl (daemon-reload|enable|restart)) ' "$T/state/calls"; }
line_of()     { grep -n -m 1 -- "$1" "$T/state/calls" | cut -d: -f1; }
before()      { local a b; a="$(line_of "$1")"; b="$(line_of "$2")"; [ -n "$a" ] && [ -n "$b" ] && [ "$a" -lt "$b" ]; }
mode_of()     { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
calls_count() { grep -cE -- "$1" "$T/state/calls"; }

# 1. A fresh Linux machine, --yes: drop-in, reload, package, enable, restart;
#    DONE once earlyoom runs with the drop-in's command line.
mg_world
mg_install "${I[@]}"
check "fresh: exit 0" rc_is 0
check "fresh: DONE with the defaults" out_has 'DONE +memory +earlyoom 1\.7-2 set up and running: SIGTERM at 15 %, SIGKILL at 8 % available memory \(the defaults\)'
check "fresh: the drop-in is written" [ -f "$(dropin)" ]
check "fresh: the drop-in is mode 644" [ "$(mode_of "$(dropin)")" = "644" ]
check "fresh: the drop-in is the template with 15 and 8 filled in" \
    sh -c "sed -e 's/@TERM_PERCENT@/15/g' -e 's/@KILL_PERCENT@/8/g' '$CONF' | cmp -s - '$(dropin)'"
check "fresh: earlyoom runs with -m 15,8 -s 100,100" sh -c "printf '%s' \"\$1\" | grep -q -- ' -m 15,8 -s 100,100 '" _ "$(running)"
check "fresh: the drop-in is loaded before the package is installed" before 'systemctl daemon-reload' 'apt-get install'
check "fresh: apt-get update before apt-get install" before 'apt-get update' 'apt-get install'
check "fresh: apt-get runs non-interactively" grep -qx 'apt-get noninteractive' "$T/state/calls"
check "fresh: apt-get waits for another apt's lock" grep -qx 'apt-get lock-timeout' "$T/state/calls"
check "fresh: apt-get keeps existing config files (confdef, confold)" \
    sh -c "grep -qx 'apt-get confdef' '$T/state/calls' && grep -qx 'apt-get confold' '$T/state/calls'"
check "fresh: apt-get never reads the installer's stdin" sh -c "! grep -qx 'apt-get read stdin' '$T/state/calls'"
check "fresh: earlyoom is enabled" called 'systemctl enable'
check "fresh: earlyoom is restarted, with the drop-in in place" grep -qx 'systemctl restart: drop-in in place' "$T/state/calls"
check "fresh: exactly 8 sudo calls (the probe and 7 root steps)" [ "$(calls_count '^sudo ')" -eq 8 ]
check "fresh, --yes: every one is sudo -n" [ "$(calls_count '^sudo -n ')" -eq 8 ]
check "fresh, --yes: no password prompt (sudo -v)" not_called 'sudo -v'
check "fresh: the boot service is still a later step" out_has 'SKIP +service +the boot service'
check "fresh: the run went on to the end" went_on
check "fresh: no temp folder is left" no_temp_left

# 2. The same machine again: everything in place, nothing done.
: >"$T/state/calls"
mg_install "${I[@]}"
check "again: exit 0" rc_is 0
check "again: OK" out_has 'OK +memory +earlyoom 1\.7-2 running: SIGTERM at 15 %, SIGKILL at 8 %'
check "again: nothing run as root, no sudo at all" no_root_run

# 3. Thresholds from the manifest, on a machine set up with the defaults: the
#    drop-in is rewritten, reloaded and earlyoom restarted with the new values.
mg_world
manifest_with 'term_percent = "20"' 'kill_percent = "10"'
mg_in_place 15 8
mg_install "${I[@]}"
check "manifest 20/10: exit 0" rc_is 0
check "manifest 20/10: DONE with the manifest's values" out_has 'DONE +memory .*SIGTERM at 20 %, SIGKILL at 10 % available memory \(from the manifest\)'
check "manifest 20/10: the drop-in holds -m 20,10" grep -q -- ' -m 20,10 ' "$(dropin)"
check "manifest 20/10: earlyoom runs with -m 20,10" sh -c "printf '%s' \"\$1\" | grep -q -- ' -m 20,10 '" _ "$(running)"
check "manifest 20/10: no reinstall" not_called 'apt-get install'
check "manifest 20/10: daemon-reload, then restart" before 'systemctl daemon-reload' 'systemctl restart'

# 4. enabled = "false": nothing is touched, and it says how to undo it.
mg_world
manifest_with 'enabled = "false"'
mg_in_place 15 8
cp "$(dropin)" "$T/dropin.before"
mg_install "${I[@]}"
check "turned off: exit 0" rc_is 0
check "turned off: SKIP" out_has 'SKIP +memory +turned off in the manifest'
check "turned off: nothing run as root" no_root_run
check "turned off: the existing drop-in is left as it is" cmp -s "$T/dropin.before" "$(dropin)"
check "turned off: no systemctl call at all" not_called systemctl
check "turned off: the undo commands" out_has 'sudo rm -f /etc/systemd/system/earlyoom\.service\.d/ghost-protocol\.conf'

# 5. macOS: an info line and a SKIP, nothing called.
mg_world
stub_uname Darwin arm64
mg_install "${I[@]}"
check "macOS: exit 0" rc_is 0
check "macOS: the info line" out_has 'the memory guard \(earlyoom\) is for Linux; nothing to do on macos'
check "macOS: SKIP" out_has 'SKIP +memory +earlyoom is for Linux'
check "macOS: no warning about it" out_lacks 'WARNING: the memory guard'
check "macOS: nothing called" sh -c "! grep -qE '^(sudo|systemctl|apt-get|dpkg-query) ' '$T/state/calls'"

# 6. The laptop profile on Linux: off unless the manifest turns it on.
mg_world
mg_install "${I[@]}" --profile laptop
check "laptop: exit 0" rc_is 0
check "laptop: SKIP, on by default only on vm" out_has 'SKIP +memory +on by default only on the vm profile; enabled = "true" turns it on for laptop'
check "laptop: nothing called" sh -c "! grep -qE '^(sudo|systemctl|apt-get) ' '$T/state/calls'"
mg_world
manifest_with 'enabled = "true"'
mg_install "${I[@]}" --profile laptop
check "laptop, enabled = \"true\": DONE" out_has 'DONE +memory'

# 7. --yes, and sudo wants a password: one probe, then SKIP; no waiting.
mg_world
touch "$T/state/sudo.needs-password"
mg_install "${I[@]}"
check "--yes, password needed: exit 0" rc_is 0
check "--yes, password needed: SKIP says why" out_has 'SKIP +memory +it needs root, and sudo wants a password; a run with --yes or without a terminal never waits for one'
check "--yes, password needed: only the probe ran" sh -c "[ \"\$(grep -c '^sudo ' '$T/state/calls')\" -eq 1 ] && grep -qx 'sudo -n 2' '$T/state/calls'"
check "--yes, password needed: no prompt" not_called 'sudo -v'
check "--yes, password needed: the hand commands use sudo tee" out_has "sed -e 's/@TERM_PERCENT@/15/g' -e 's/@KILL_PERCENT@/8/g' .*earlyoom\.conf \| sudo tee /etc/systemd/system/earlyoom\.service\.d/ghost-protocol\.conf >/dev/null"
check "--yes, password needed: the hand commands install, enable and restart" \
    sh -c "grep -q 'sudo apt-get update && sudo apt-get install -y earlyoom' '$OUT' && grep -q 'sudo systemctl enable earlyoom && sudo systemctl restart earlyoom' '$OUT'"
check "--yes, password needed: no drop-in" [ ! -e "$(dropin)" ]
check "--yes, password needed: no FAIL" out_lacks '^  FAIL'
check "--yes, password needed: the run went on" went_on

# 8. An interactive run: it says root is needed, asks once (sudo -v), then
#    runs the root steps with that sudo session.
mg_world
t_tty "" ""
mg_install --instance example/instance
check "interactive: exit 0" rc_is 0
check "interactive: says root is needed first" out_has 'The memory guard \(earlyoom\) needs root: sudo may ask for your password now\.'
check "interactive: one sudo -v" [ "$(calls_count '^sudo -v ')" -eq 1 ]
check "interactive: then plain sudo, never -n" sh -c "[ \"\$(grep -c '^sudo [0-9]' '$T/state/calls')\" -eq 7 ] && ! grep -q '^sudo -n ' '$T/state/calls'"
check "interactive: the prompt comes before the first root step" before '^sudo -v' '^sudo [0-9]'
check "interactive: DONE" out_has 'DONE +memory'

# 9. An interactive run where the password prompt fails: SKIP, nothing else.
mg_world
touch "$T/state/sudo.v-fails"
t_tty "" ""
mg_install --instance example/instance
check "interactive, sudo -v fails: exit 0" rc_is 0
check "interactive, sudo -v fails: SKIP" out_has 'SKIP +memory +it needs root, and sudo -v failed'
check "interactive, sudo -v fails: no root step" [ "$(calls_count '^sudo ')" -eq 1 ]

# 10. Root works, but the drop-in cannot be written: SKIP.
mg_world
rm -f "$T/sysbin/install"
mg_install "${I[@]}"
check "cannot write: exit 0" rc_is 0
check "cannot write: SKIP" out_has 'SKIP +memory +could not write .*ghost-protocol\.conf as root'
check "cannot write: nothing installed" not_called 'apt-get install'

# 11. No sudo at all, not root (the laptop profile allows that; the vm profile
#     stops at preflight).
mg_world
manifest_with 'enabled = "true"'
rm -f "$T/stubs/sudo"
mg_install "${I[@]}" --profile laptop
check "no sudo: exit 0" rc_is 0
check "no sudo: SKIP" out_has 'SKIP +memory +it needs root, and there is no sudo here'
check "no sudo: the run went on" went_on

# 12. No apt (another Linux), no systemd: SKIP before any sudo.
mg_world
rm -f "$T/stubs/apt-get"
mg_install "${I[@]}"
check "no apt: SKIP" out_has 'SKIP +memory +no apt here'
check "no apt: no sudo" not_called sudo
mg_world
rm -f "$T/stubs/systemctl"
mg_install "${I[@]}"
check "no systemd: SKIP" out_has 'SKIP +memory +no systemd here'
check "no systemd: no sudo" not_called sudo

# 13. The package is not there (universe not enabled): SKIP; the drop-in stays.
mg_world
touch "$T/state/apt.no-earlyoom"
mg_install "${I[@]}"
check "no package: exit 0" rc_is 0
check "no package: a warning naming universe" out_has 'WARNING: .*apt-get install earlyoom failed \(on Ubuntu it is in the universe component\)'
check "no package: SKIP" out_has 'SKIP +memory +apt-get install earlyoom failed'
check "no package: it says the drop-in stays" out_has 'the drop-in stays at .*ghost-protocol\.conf'
check "no package: not enabled or restarted" sh -c "! grep -qE '^systemctl (enable|restart) ' '$T/state/calls'"
check "no package: the run went on" went_on

# 14. No package lists yet: the update makes the install work. A failed update
#     is a warning, and the install is tried anyway.
mg_world
touch "$T/state/apt.needs-update"
mg_install "${I[@]}"
check "no package lists yet: DONE after apt-get update" out_has 'DONE +memory'
mg_world
touch "$T/state/apt.fail-update"
mg_install "${I[@]}"
check "update fails: the warning" out_has 'WARNING: apt-get update failed; trying the install anyway'
check "update fails: DONE" out_has 'DONE +memory'

# 15. A held package counts as installed: everything in place is OK.
mg_world
mg_in_place 15 8
touch "$T/state/dpkg.earlyoom.held"
mg_install "${I[@]}"
check "held package: OK" out_has 'OK +memory +earlyoom 1\.7-2 running'
check "held package: no install" not_called 'apt-get install'

# 16. earlyoom does not stay up, or the restart fails: SKIP.
mg_world
touch "$T/state/earlyoom.crashes"
mg_install "${I[@]}"
check "earlyoom stops: exit 0" rc_is 0
check "earlyoom stops: SKIP naming the journal" out_has 'SKIP +memory +earlyoom stopped again right after its restart \(see journalctl -u earlyoom\)'
check "earlyoom stops: no DONE" out_lacks 'DONE +memory'
mg_world
touch "$T/state/systemctl.fail-restart"
mg_install "${I[@]}"
check "restart fails: SKIP" out_has 'SKIP +memory +systemctl restart earlyoom failed'

# 17. systemd has not loaded what is on disk (a drop-in changed since the last
#     reload): everything else in place, it reloads and restarts.
mg_world
mg_in_place 15 8
printf '[Service]\nMemoryMax=60M\n' >"$(dropdir)/00-limit.conf"
mg_install "${I[@]}"
check "needs reload: exit 0" rc_is 0
check "needs reload: daemon-reload ran" called 'systemctl daemon-reload'
check "needs reload: our drop-in was not rewritten" [ "$(calls_count '^sudo ')" -eq 4 ]
check "needs reload: DONE" out_has 'DONE +memory'
check "needs reload: a note names the other drop-in" out_has 'note: other drop-ins for earlyoom are there: 00-limit\.conf'

# 18. A later drop-in that sets its own ExecStart wins: the guard is reported
#     as not set up (SKIP), not OK or DONE.
mg_world
mg_in_place 15 8
printf '[Service]\nExecStart=\nExecStart=/usr/bin/earlyoom -m 5\n' >"$(dropdir)/zz-local.conf"
mg_systemctl daemon-reload; mg_systemctl restart earlyoom; : >"$T/state/calls"
mg_install "${I[@]}"
check "overridden: exit 0" rc_is 0
check "overridden: no OK and no DONE" sh -c "! grep -qE '^  (OK|DONE) +memory' '$OUT'"
check "overridden: SKIP naming the other drop-in" out_has 'SKIP +memory +earlyoom runs, but not with this drop-in.s settings: another drop-in replaces them \(zz-local\.conf\)'
check "overridden: the other drop-in is left as it is" [ -f "$(dropdir)/zz-local.conf" ]
mg_world
mg_in_place 15 8
printf '[Service]\nExecStart=\nExecStart=/usr/bin/earlyoom -m 5\n' >"$(dropdir)/zz-local.conf"
mg_install "${I[@]}"
check "overridden, not reloaded yet: reloaded, then SKIP" \
    sh -c "grep -q '^systemctl daemon-reload' '$T/state/calls' && grep -qE '^  SKIP +memory +earlyoom runs, but not with' '$OUT'"

# 19. /proc cannot be read: the command line systemd loaded is checked instead.
mg_world
touch "$T/state/earlyoom.no-proc"
mg_install "${I[@]}"
check "no /proc: DONE from the loaded ExecStart" out_has 'DONE +memory'
mg_world
touch "$T/state/earlyoom.no-proc"
mkdir -p "$(dropdir)"
printf '[Service]\nExecStart=\nExecStart=/usr/bin/earlyoom -m 5\n' >"$(dropdir)/zz-local.conf"
mg_install "${I[@]}"
check "no /proc, overridden: SKIP" out_has 'SKIP +memory +earlyoom runs, but not with'

# 20. A dry run on a fresh machine: it prints the drop-in's settings and the
#     commands, runs nothing as root (not even the sudo probe), writes nothing.
mg_world
(cd "$T/etc" && find . -print | LC_ALL=C sort) >"$T/etc.before"
mg_install "${I[@]}" --dry-run
(cd "$T/etc" && find . -print | LC_ALL=C sort) >"$T/etc.after"
check "dry run: exit 0" rc_is 0
check "dry run: PLAN" out_has 'PLAN +memory +would set up earlyoom: SIGTERM at 15 %, SIGKILL at 8 %'
check "dry run: it shows the ExecStart line" out_has '^    ExecStart=/usr/bin/earlyoom -r 600 -m 15,8 -s 100,100 '
check "dry run: it shows the package install with its options" \
    out_has 'would run: apt-get -o DPkg::Lock::Timeout=120 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold install -y -qq --no-install-recommends earlyoom'
check "dry run: it shows the restart" out_has 'would run: systemctl restart earlyoom'
check "dry run: nothing run as root, no sudo at all" no_root_run
check "dry run: nothing written under /etc" cmp -s "$T/etc.before" "$T/etc.after"

# 21. A dry run with everything in place: OK. Before the manifest can be read
#     (no gh sign-in): the defaults, and it says so.
mg_world
mg_in_place 15 8
mg_install "${I[@]}" --dry-run
check "dry run, in place: OK" out_has 'OK +memory +earlyoom 1\.7-2 running'
check "dry run, in place: nothing run as root" no_root_run
mg_world
rm -f "$T/state/gh.authed"
mg_install "${I[@]}" --dry-run
check "dry run, manifest not read: the defaults, said so" \
    out_has 'PLAN +memory .*\(the defaults; the manifest is not read yet\)'

# 22. Test mode without GP_ETC: nothing is ever written to the real /etc.
mg_world
t_install "${I[@]}" </dev/null
check "test mode, no GP_ETC: exit 0" rc_is 0
check "test mode, no GP_ETC: SKIP, nothing written" out_has 'SKIP +memory +test mode without GP_ETC'
check "test mode, no GP_ETC: no sudo" not_called sudo

# 23. The tests themselves running as root: root_prepare still goes through
#     the stub sudo (GP_TEST), so nothing runs as root.
mg_world
stub_id_root
rm -f "$T/state/sudo.allow"
mg_install "${I[@]}"
check "as root: preflight sees root" out_has 'OK +preflight .*running as root'
check "as root: the probe still went to the stub sudo" grep -qx 'sudo -n 2' "$T/state/calls"
check "as root: nothing ran (the stub refused), SKIP" out_has 'SKIP +memory +it needs root'
check "as root: no drop-in" [ ! -e "$(dropin)" ]

# 24. Outside the test mode, as root, commands run directly, without sudo.
#     (A fake id says root; the command is a touch in the sandbox, run as the
#     test's own user.) Before root_prepare, as_root runs nothing.
t_new; t_stub sudo; stub_id_root
# shellcheck disable=SC2016  # the inner script's own $1 and $2
env -i HOME="$T/home" PATH="$T/stubs:$T/sysbin" STUB_STATE="$T/state" LANG=C LC_ALL=C bash -c '
    . "$1/install/lib/common.sh"
    as_root touch "$2/before"; echo "unprepared: $?"
    root_prepare "a test" && echo "mode: $ROOT_MODE"
    as_root touch "$2/made"; echo "direct: $?"' _ "$SRC" "$T" >"$OUT" 2>&1
check "as_root before root_prepare: 126, nothing run" sh -c "grep -qx 'unprepared: 126' '$OUT' && [ ! -e '$T/before' ]"
check "root, not a test: direct mode" grep -qx 'mode: direct' "$OUT"
check "root, not a test: the command ran" [ -f "$T/made" ]
check "root, not a test: no sudo" not_called sudo

# 25. root_prepare's choice (GP_TEST, the stub sudo): --yes or no terminal is
#     sudo -n after one probe; an interactive run asks once with sudo -v.
t_new; t_stub sudo; touch "$T/state/sudo.allow"
rp() {   # YES HAVE_TTY
    # shellcheck disable=SC2016  # the inner script's own $1
    env -i HOME="$T/home" PATH="$T/stubs:$T/sysbin" STUB_STATE="$T/state" GP_TEST=1 YES="$1" HAVE_TTY="$2" \
        LANG=C LC_ALL=C bash -c '. "$1/install/lib/common.sh"; root_prepare "a test" >/dev/null && echo "mode: $ROOT_MODE"' _ "$SRC"
}
check "root_prepare, no terminal, no --yes: sudo -n" [ "$(rp 0 0)" = "mode: sudo-n" ]
check "root_prepare, --yes with a terminal: sudo -n" [ "$(rp 1 1)" = "mode: sudo-n" ]
check "root_prepare: the non-interactive runs probed with sudo -n true only" \
    sh -c "[ \"\$(grep -c '^sudo -n 2' '$T/state/calls')\" -eq 2 ] && ! grep -q '^sudo -v' '$T/state/calls'"
check "root_prepare, interactive: sudo" [ "$(rp 0 1)" = "mode: sudo" ]
check "root_prepare, interactive: one sudo -v" [ "$(calls_count '^sudo -v ')" -eq 1 ]

# 26. mg_render checks the thresholds itself before they reach ExecStart.
t_new
mgr() {   # term kill
    # shellcheck disable=SC2016  # the inner script's own $1, $2, $3
    env -i HOME="$T/home" PATH="$T/stubs:$T/sysbin" LANG=C LC_ALL=C bash -c '
        GP_DIR="$1"; . "$1/install/lib/common.sh"; . "$1/install/lib/service.sh"
        MG_TERM="$2"; MG_KILL="$3"; make_work || exit 2
        if mg_render "$GP_WORK/x"; then echo "rendered: $MG_EXPECTED"; else echo refused; fi
        cleanup_work' _ "$SRC" "$1" "$2"
}
check "mg_render: 15 and 8 are rendered" sh -c "printf '%s' \"\$1\" | grep -q '^rendered: /usr/bin/earlyoom .* -m 15,8 '" _ "$(mgr 15 8)"
check "mg_render: a threshold that is not a whole number is refused" [ "$(mgr '1/g;s/x' 8)" = "refused" ]
check "mg_render: a leading zero is refused" [ "$(mgr 15 08)" = "refused" ]

finish_tests
