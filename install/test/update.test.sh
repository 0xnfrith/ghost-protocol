#!/usr/bin/env bash
# update.test.sh: the installer's update steps (install/install --update), as
# boot.sh --update runs them after it moved the checkout to a new pinned
# commit (GP_PREVIOUS_COMMIT names the commit it moved from).
#   - Only steps 1, 3, 4, 7 (without the sign-in check), 11 and 14 run: no
#     GitHub call, no menu question, no clone, and no Claude sign-in, so an
#     instance whose sign-in the operator's shell cannot see (a token in its
#     service) updates, with or without a terminal.
#   - The instance's home must already be there (--instance-dir, or ~/<repo>).
#   - Step 11 installs GHOST Protocol's plugin from the checkout as a
#     directory marketplace at user scope, or refreshes it; it never repoints
#     a ghost-protocol marketplace that comes from somewhere else. A failure
#     there stops the run before the restart.
#   - When the adapter's lockfile changed between the two commits, its
#     dependencies are installed again (npm ci, inside launch.mjs's lock),
#     before step 14; without npm, or when npm ci fails, node_modules goes, so
#     the channel installs them at its next start; while another install holds
#     the lock, it is left to that one. A changed buzz-mcp pin is a warning.
#   - Step 14 restarts <name>.service with try-restart when the checkout moved
#     and the unit is installed and running; a stopped one stays stopped; no
#     root, a failed restart or a unit that does not come back is a FAIL.
#   - With [automode_guard] in the manifest, step 14 also puts the guard's
#     root-owned copy at the new commit, with the dependencies just
#     installed, before the restart.
#   - A dry run changes nothing and plans the restart.
# The installer runs from $T/gp, a copy of this repo with two commits of its
# own, never from the source tree, so nothing here touches the tree's files.
# uname is a stub that says Linux, so the systemd cases run on macOS too.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

stub_uname() {   # system machine
    # shellcheck disable=SC2016  # the stub's own $1, written as is
    printf '#!/bin/sh\ncase "$1" in -s) echo %s ;; -m) echo %s ;; *) echo %s ;; esac\n' "$1" "$2" "$1" >"$T/stubs/uname"
    chmod +x "$T/stubs/uname"
}

UNIT="instance.service"
GP_PLUGIN="ghost-protocol@ghost-protocol"
SG="security-guidance@claude-plugins-official"

# A copy of the repo's files at two commits: C1, then C2 with $1 changed
# (lock: the adapter's lockfile; pin: buzz-mcp.pin; other: a file elsewhere).
# HEAD is C2. node_modules stands in for installed dependencies.
make_gp() {   # what changes between C1 and C2
    local gp="$T/gp"
    rm -rf "$gp"; mkdir -p "$gp"
    (cd "$SRC" && git ls-files -co --exclude-standard -z | xargs -0 tar cf -) | (cd "$gp" && tar xf -)
    git -C "$gp" init -q
    git -C "$gp" add -A
    git -C "$gp" commit -q -m one
    C1="$(git -C "$gp" rev-parse HEAD)"
    case "$1" in
        lock)  echo " " >>"$gp/adapters/buzz/package-lock.json" ;;
        pin)   echo "# moved" >>"$gp/adapters/buzz/buzz-mcp.pin" ;;
        other) echo "two" >"$gp/two.txt" ;;
    esac
    git -C "$gp" add -A
    git -C "$gp" commit -q -m two
    C2="$(git -C "$gp" rev-parse HEAD)"
    mkdir -p "$gp/adapters/buzz/node_modules/some-package"
    GP="$(cd "$gp" && pwd -P)"
}

# The usual world, the instance's home already cloned, the Claude Code stub
# signed out (the sign-in lives in the instance's service), security-guidance
# already installed (so every plugin call left is GHOST Protocol's), the unit
# installed and running, sudo allowed.
world() {   # what changes between C1 and C2
    t_new; t_std_env; t_make_instance "$FIX/manifests/good-v1.toml"
    git clone -q "https://github.com/example/instance.git" "$T/home/work/instance"
    rm -f "$T/state/claude.authed"
    echo "claude-plugins-official" >"$T/state/claude.marketplaces"
    echo "$SG enabled" >"$T/state/claude.plugins"
    stub_uname Linux x86_64
    t_stub systemctl
    touch "$T/state/unit-$UNIT.loaded" "$T/state/unit-$UNIT.active" "$T/state/sudo.allow"
    make_gp "${1:-other}"
}
# The plugin already installed from the checkout (enabled, or disabled).
installed() {
    echo "ghost-protocol $GP" >>"$T/state/claude.marketplaces"
    echo "$GP_PLUGIN ${1:-enabled}" >>"$T/state/claude.plugins"
}
# shellcheck disable=SC2088  # the installer expands ~/ itself, as a person would type it
I=(--instance example/instance --instance-dir "~/work/instance")
update() {   # extra installer args
    t_env GP_PREVIOUS_COMMIT="$C1" "$GP/install/install" "${I[@]}" --update "$@" >"$OUT" 2>&1
    RC=$?
}
restarts() { cat "$T/state/unit-$UNIT.restarts" 2>/dev/null || echo 0; }
no_github() { not_called gh && ! grep -q '^git clone' "$T/state/calls"; }

# 1. A first update on a signed-out machine, --yes: the plugin is installed
#    from the checkout, the unit restarted once; no sign-in, no GitHub.
world
update --yes
check "update: exit 0" rc_is 0
check "update: says what it moves from and to" out_has "update: from $C1 to $C2"
check "update: no Claude sign-in was tried" not_called "claude auth login"
check "update: the sign-in is not checked" out_has 'OK +claude +.*sign-in not checked \(update\)'
check "update: no GitHub call and no clone" no_github
check "update: the setup hook did not run" not_called setup
check "update: the skipped steps are named" out_has 'SKIP +update +update: GitHub access, the layout, the setup hook'
check "update: the checkout added as a directory marketplace" grep -qx "ghost-protocol $GP" "$T/state/claude.marketplaces"
check "update: the plugin installed at user scope" grep -qx "$GP_PLUGIN enabled user" "$T/state/claude.plugins"
check "update: DONE gp-plugin" out_has "DONE +gp-plugin +$GP_PLUGIN installed from $GP"
check "update: the unit restarted once" [ "$(restarts)" = "1" ]
check "update: through try-restart, as root" sh -c "grep -q '^sudo -n ' '$T/state/calls' && grep -q '^systemctl try-restart ' '$T/state/calls'"
check "update: DONE restart" out_has "DONE +restart +restarted $UNIT: it runs $C2 \\(it ran $C1\\)"
check "update: the instance's home is left as it is" out_has 'OK +instance +.*not fetched, pulled or switched'
check "update: no menu question" out_has 'Choices \(update: none asked\)'

# 1b. An instance with a key service (install/keyservice/setup): the update
#     says that the admin moves the key side's root-owned copy, with the
#     command, and moves nothing of it itself.
world
mkdir -p "$T/etc/ghost-protocol/instance"
printf '%s\n' "$C1" >"$T/etc/ghost-protocol/instance/commit"
t_env GP_ETC="$T/etc" GP_PREVIOUS_COMMIT="$C1" "$GP/install/install" "${I[@]}" --update --yes >"$OUT" 2>&1; RC=$?
check "key service: exit 0" rc_is 0
check "key service: the admin's command to move it" out_has "install/keyservice/setup --name instance --agent-user $(id -un) --update --commit $C2 --apply"
check "key service: a SKIP line names both commits" out_has "SKIP +keyservice +the key service runs $C1; the admin moves it to $C2"
check "key service: its commit is not moved here" grep -qx "$C1" "$T/etc/ghost-protocol/instance/commit"
printf '%s\n' "$C2" >"$T/etc/ghost-protocol/instance/commit"
t_env GP_ETC="$T/etc" GP_PREVIOUS_COMMIT="$C1" "$GP/install/install" "${I[@]}" --update --yes >"$OUT" 2>&1; RC=$?
check "key service at the same commit: OK" out_has "OK +keyservice +the key service runs $C2 too"

# 2. No terminal and no --yes: the same (an update asks nothing).
world
update
check "no terminal, no --yes: exit 0" rc_is 0
check "no terminal, no --yes: restarted" [ "$(restarts)" = "1" ]

# 3. A terminal there, Claude signed out: still no sign-in prompt.
world
t_tty "" "" "" ""
update
check "a terminal, signed out: exit 0" rc_is 0
check "a terminal, signed out: no sign-in" not_called "claude auth login"

# 4. The home is not on this machine: refused, nothing installed or restarted.
world
rm -rf "$T/home/work/instance"
update --yes
check "no home: exit 1" rc_is 1
check "no home: FAIL, an update never clones" out_has 'FAIL +instance +an update needs the instance.s home on this machine'
check "no home: nothing cloned" no_github
check "no home: no plugin call" not_called "claude plugin install"
check "no home: no restart" [ "$(restarts)" = "0" ]

# 5. A ghost-protocol marketplace from somewhere else: never repointed; FAIL,
#    the command to do it by hand, the way back, and no restart.
world
echo "ghost-protocol $T/elsewhere" >>"$T/state/claude.marketplaces"
update --yes
check "other marketplace: exit 1" rc_is 1
check "other marketplace: FAIL gp-plugin" out_has "FAIL +gp-plugin +the ghost-protocol marketplace comes from $T/elsewhere"
check "other marketplace: not repointed" grep -qx "ghost-protocol $T/elsewhere" "$T/state/claude.marketplaces"
check "other marketplace: no marketplace add" not_called "claude plugin marketplace add"
check "other marketplace: says how to repoint it by hand" out_has "claude plugin marketplace add $GP\$"
check "other marketplace: no restart" [ "$(restarts)" = "0" ]
check "other marketplace: the way back" out_has "install/boot.sh --instance example/instance --dir $GP --rollback"
check "other marketplace: says to go back now (the checkout already moved)" out_has 'would load it\. Go back now:$'
#    A GitHub-sourced one: the same.
world
echo "ghost-protocol" >>"$T/state/claude.marketplaces"
update --yes
check "GitHub marketplace: FAIL, left as it is" out_has 'FAIL +gp-plugin +the ghost-protocol marketplace comes from github'
check "GitHub marketplace: no restart" [ "$(restarts)" = "0" ]

# 6. Already installed from the checkout: refreshed, not installed again.
world; installed
update --yes
check "refresh: exit 0" rc_is 0
check "refresh: marketplace update" called "claude plugin marketplace update"
check "refresh: plugin update" called "claude plugin update"
check "refresh: no install, no add" sh -c "! grep -qE '^claude plugin (install|marketplace add) ' '$T/state/calls'"
check "refresh: OK gp-plugin" out_has "OK +gp-plugin +$GP_PLUGIN installed and enabled \\(user scope\\), read from $GP; refreshed"
check "refresh: restarted" [ "$(restarts)" = "1" ]
#    Installed but disabled: refreshed, left disabled, with a warning.
world; installed disabled
update --yes
check "disabled: exit 0" rc_is 0
check "disabled: left as it is, with a warning" sh -c "grep -q 'disabled by choice' '$OUT' && grep -q 'WARNING: .*hears nothing until it is enabled' '$OUT'"

# 7. The refresh fails: FAIL, and no restart into it.
for what in plugin-update marketplace-update; do
    world; installed
    touch "$T/state/claude.$what-fails"
    update --yes
    check "$what fails: exit 1" rc_is 1
    check "$what fails: FAIL gp-plugin" out_has 'FAIL +gp-plugin +claude plugin .*update .* failed'
    check "$what fails: no restart" [ "$(restarts)" = "0" ]
done
#    The install fails on a first update: the same.
world
echo "$GP_PLUGIN" >"$T/state/claude.plugin-install-fails"
update --yes
check "install fails: exit 1" rc_is 1
check "install fails: no restart" [ "$(restarts)" = "0" ]

# 8. The checkout did not move: nothing restarted.
world; installed
t_env "$GP/install/install" "${I[@]}" --update --yes >"$OUT" 2>&1; RC=$?
check "did not move: exit 0" rc_is 0
check "did not move: says so" out_has 'update: the checkout is at .* and did not move'
check "did not move: OK, not restarted" out_has "OK +restart +the checkout did not move; $UNIT not restarted"
check "did not move: no restart" [ "$(restarts)" = "0" ]

# 9. No unit installed: a SKIP that says to restart it by hand.
world; installed
rm -f "$T/state/unit-$UNIT.loaded"
update --yes
check "no unit: exit 0" rc_is 0
check "no unit: SKIP restart" out_has "SKIP +restart +$UNIT is not installed; restart instance instance yourself"
#    No systemctl at all: the same kind of line.
world; installed
rm -f "$T/stubs/systemctl"
update --yes
check "no systemd: SKIP restart" out_has 'SKIP +restart +no systemd here'
#    macOS: no systemd either.
world; installed
stub_uname Darwin arm64
update --yes
check "macOS: SKIP restart" out_has 'SKIP +restart +no systemd here'
check "macOS: no restart" [ "$(restarts)" = "0" ]

# 10. The unit is stopped: left stopped.
world; installed
rm -f "$T/state/unit-$UNIT.active"
update --yes
check "stopped: exit 0" rc_is 0
check "stopped: left stopped" out_has "OK +restart +$UNIT not running; left stopped"
check "stopped: no restart" [ "$(restarts)" = "0" ]

# 11. No root (sudo wants a password; --yes never waits for one): FAIL, with
#     the command to run by hand.
world; installed
rm -f "$T/state/sudo.allow"; touch "$T/state/sudo.needs-password"
update --yes
check "no root: exit 1" rc_is 1
check "no root: FAIL restart" out_has "FAIL +restart +$UNIT not restarted"
check "no root: the hand command" out_has "^    sudo systemctl restart $UNIT\$"
check "no root: no restart" [ "$(restarts)" = "0" ]
check "no root: the update is in place; restart by hand or go back" sh -c "grep -q 'the running instance was not restarted' '$OUT' && grep -q -- '--rollback' '$OUT'"

# 12. try-restart fails, or the unit does not come back: FAIL.
world; installed
touch "$T/state/systemctl.fail-try-restart"
update --yes
check "restart fails: exit 1" rc_is 1
check "restart fails: FAIL restart" out_has "FAIL +restart +systemctl try-restart $UNIT failed"
world; installed
touch "$T/state/unit-$UNIT.dies"
update --yes
check "does not come back: exit 1" rc_is 1
check "does not come back: FAIL restart" out_has "FAIL +restart +$UNIT is not running after the restart"

# 13. A dry run: nothing changes; the restart and the install are planned, and
#     the plan names the real checkout (GP_TARGET_DIR) when boot.sh runs it
#     from a temporary clone.
world lock; t_stub npm
t_snapshot >"$T/before"
t_env GP_PREVIOUS_COMMIT="$C1" GP_TARGET_DIR="$T/home/ghost-protocol" "$GP/install/install" "${I[@]}" --update --dry-run --yes >"$OUT" 2>&1; RC=$?
t_snapshot >"$T/after"
check "dry run: exit 0" rc_is 0
check "dry run: HOME is unchanged" cmp -s "$T/before" "$T/after"
check "dry run: PLAN restart" out_has "PLAN +restart +would restart $UNIT, so that it runs $C2 \\(now $C1\\)"
check "dry run: the install is planned from the real checkout" out_has "would run: claude plugin marketplace add $T/home/ghost-protocol\$"
check "dry run: PLAN gp-plugin" out_has "PLAN +gp-plugin +would install $GP_PLUGIN from $T/home/ghost-protocol"
check "dry run: no sudo, no restart" sh -c "! grep -q '^sudo' '$T/state/calls' && [ ! -e '$T/state/unit-$UNIT.restarts' ]"
check "dry run: no plugin change" sh -c "! grep -qE '^claude plugin (install|update|marketplace (add|update)) ' '$T/state/calls'"
check "dry run: node_modules kept" [ -d "$GP/adapters/buzz/node_modules/some-package" ]
check "dry run: no npm ci" not_called "npm ci"
check "dry run: says it would install them again if the lockfile changed" out_has 'it would install the adapter.s dependencies again \(npm ci, before step 14\)'

# 14. The adapter's dependencies follow its lockfile: installed again now,
#     inside launch.mjs's lock, so step 14 finds them.
line_of() { grep -n -m 1 "^$1" "$T/state/calls" | cut -d: -f1; }
world lock; installed; t_stub npm
NM="$GP/adapters/buzz/node_modules"
update --yes
check "lockfile changed: exit 0" rc_is 0
check "lockfile changed: npm ci in the adapter, inside its install lock" grep -qx 'npm ci locked' "$T/state/calls"
check "lockfile changed: the new dependencies are in" sh -c "[ -f '$NM/nostr-tools/package.json' ] && [ -f '$NM/@modelcontextprotocol/sdk/package.json' ] && [ ! -e '$NM/some-package' ]"
check "lockfile changed: the lock is released" [ ! -e "$GP/adapters/buzz/.install-lock" ]
check "lockfile changed: says so" out_has 'lockfile changed .*installing its dependencies again'
check "lockfile changed: installed from the new lockfile" out_has 'installed from the new lockfile \(npm ci, no install scripts\)'
check "lockfile changed: before step 14's restart" [ "$(line_of 'npm ci ')" -lt "$(line_of 'systemctl try-restart ')" ]
#    No npm on PATH: node_modules goes, so the channel installs them at start.
world lock; installed
update --yes
check "no npm: exit 0" rc_is 0
check "no npm: node_modules removed" [ ! -e "$GP/adapters/buzz/node_modules" ]
check "no npm: says why, and that the channel installs them at its start" \
    sh -c "grep -q 'WARNING: the Buzz adapter.s dependencies were not installed: npm is not on PATH. Removed its node_modules' '$OUT' && grep -q 'the channel installs the new ones when the instance starts' '$OUT'"
check "no npm: says an auto-mode guard keeps its old copy until a full run" out_has 'an auto-mode guard already set up keeps its old copy'
#    npm ci fails: its part-made folder goes too, and the lock is released.
world lock; installed; t_stub npm; touch "$T/state/npm.fail"
update --yes
check "npm fails: exit 0" rc_is 0
check "npm fails: the part-made node_modules removed" [ ! -e "$GP/adapters/buzz/node_modules" ]
check "npm fails: says so" out_has 'not installed: npm ci failed \(exit 1\)'
check "npm fails: the lock is released" [ ! -e "$GP/adapters/buzz/.install-lock" ]
#    Another install holds the lock (a channel starting): left to it.
world lock; installed; t_stub npm; mkdir "$GP/adapters/buzz/.install-lock"
update --yes
check "lock held: npm not run" not_called "npm ci"
check "lock held: node_modules left as it is" [ -d "$GP/adapters/buzz/node_modules/some-package" ]
check "lock held: the other install's lock left alone" [ -d "$GP/adapters/buzz/.install-lock" ]
check "lock held: says so" out_has 'another install holds .*install-lock'
world other; installed; t_stub npm
update --yes
check "lockfile the same: node_modules kept" [ -d "$GP/adapters/buzz/node_modules/some-package" ]
check "lockfile the same: npm not run" not_called "npm ci"
check "lockfile the same: no buzz-mcp warning" out_lacks "buzz-mcp's pin changed"
world pin; installed
update --yes
check "buzz-mcp pin changed: a warning with the build command" sh -c "grep -q \"WARNING: buzz-mcp's pin changed\" '$OUT' && grep -q 'adapters/buzz/scripts/build-buzz-mcp.sh' '$OUT'"
check "buzz-mcp pin changed: still exit 0" rc_is 0
check "buzz-mcp pin changed: node_modules kept" [ -d "$GP/adapters/buzz/node_modules" ]

# 15. An update with [automode_guard] in the manifest: step 14 runs the guard's
#     install again, so its root-owned copy (here GP_LIBDIR) moves to the new
#     commit, with the dependencies step 11 just installed, before the restart.
CHAN="0000aaaa-1111-2222-3333-444455556666"
KEY="$(printf '%064d' 7)"
ag_world() {   # what changes between C1 and C2
    world "$1"; installed
    t_stub node; t_tool install; t_tool python3 >/dev/null
    local h="$T/home/work/instance"
    { cat "$FIX/manifests/good-v1.toml"; printf '\n[automode_guard]\n'
      printf 'snapshot = "config/automode.json"\nbuzz_relay_url = "https://relay.example.com"\n'
      printf 'buzz_key_command = "~/bin/key"\nbuzz_channel = "%s"\nbuzz_mentions = ["%s"]\n' "$CHAN" "$KEY"
      printf 'read_paths = ["~/bin/key"]\n'; } >"$h/.ghost-protocol/instance.toml"
    mkdir -p "$h/config"; printf '{"allow": [], "hard_deny": [], "soft_deny": []}\n' >"$h/config/automode.json"
    git -C "$h" add -A && git -C "$h" commit -q -m "the auto-mode guard"
    mkdir -p "$T/home/.claude" "$T/home/bin"; printf '{"autoMode": {}}\n' >"$T/home/.claude/settings.json"
    printf '#!/bin/sh\n' >"$T/home/bin/key"; chmod +x "$T/home/bin/key"
    mkdir -p "$T/etc/systemd/system" "$T/varlib"
    # The guard as an earlier run left it: a copy from the old commit.
    LIBD="$T/usrlib/ghost-protocol/instance/automode-guard"
    mkdir -p "$LIBD"; echo "the old commit's guard" >"$LIBD/guard"
}
ag_update() {
    t_env GP_PREVIOUS_COMMIT="$C1" GP_ETC="$T/etc" GP_LIBDIR="$T/usrlib" GP_VARLIB="$T/varlib" GP_GUARD_STATE="$T/no-state" \
        "$GP/install/install" "${I[@]}" --update --yes >"$OUT" 2>&1
    RC=$?
}
if [ -x /usr/bin/python3 ] && [ -x /usr/bin/git ] && [ "$(id -u)" != 0 ]; then
    ag_world lock; t_stub npm
    ag_update
    check "guard, lockfile changed: exit 0" rc_is 0
    check "guard, lockfile changed: DONE automode" out_has 'DONE +automode +installed, the timer running'
    check "guard, lockfile changed: the root-owned guard is the new commit's" cmp -s "$LIBD/guard" "$GP/install/automode-guard/guard"
    check "guard, lockfile changed: with the adapter's new dependencies" sh -c "[ -f '$LIBD/buzz/node_modules/nostr-tools/package.json' ] && [ ! -e '$LIBD/buzz/node_modules/some-package' ]"
    check "guard, lockfile changed: and the new commit's send" cmp -s "$LIBD/buzz/src/send.mjs" "$GP/adapters/buzz/src/send.mjs"
    check "guard, lockfile changed: its units written" [ -f "$T/etc/systemd/system/instance-automode-guard.service" ]
    check "guard, lockfile changed: dependencies, then the guard, then the restart" \
        [ "$(line_of 'npm ci ')" -lt "$(line_of 'systemctl start: unit in place')" ] && [ "$(line_of 'systemctl start: unit in place')" -lt "$(line_of 'systemctl try-restart ')" ]
    check "guard, lockfile changed: the instance restarted once" [ "$(restarts)" = "1" ]
    #    Without npm: the guard is skipped, its old copy kept, said; the update goes on.
    ag_world lock
    ag_update
    check "guard, no npm: exit 0" rc_is 0
    check "guard, no npm: SKIP automode, the dependencies missing" out_has "SKIP +automode +the Buzz adapter's dependencies are not installed"
    check "guard, no npm: the old copy kept" grep -qx "the old commit's guard" "$LIBD/guard"
    check "guard, no npm: the instance still restarted" [ "$(restarts)" = "1" ]
    #    The lockfile the same: the guard still moves to the new commit.
    ag_world other
    mkdir -p "$GP/adapters/buzz/node_modules/nostr-tools" "$GP/adapters/buzz/node_modules/@modelcontextprotocol/sdk"
    printf '{}\n' >"$GP/adapters/buzz/node_modules/nostr-tools/package.json"
    printf '{}\n' >"$GP/adapters/buzz/node_modules/@modelcontextprotocol/sdk/package.json"
    ag_update
    check "guard, lockfile the same: DONE automode" out_has 'DONE +automode +installed'
    check "guard, lockfile the same: the root-owned guard is the new commit's" cmp -s "$LIBD/guard" "$GP/install/automode-guard/guard"
else
    echo "SKIP  the update with [automode_guard] (needs /usr/bin/python3 and /usr/bin/git, and a user that is not root)"
fi

finish_tests
