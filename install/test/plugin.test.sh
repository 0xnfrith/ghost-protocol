#!/usr/bin/env bash
# plugin.test.sh: step 11, plugins.
# GHOST Protocol's own plugin (more cases in update.test.sh):
#   - A full run installs it from the checkout the installer runs from, as a
#     directory marketplace, at user scope; a dry run plans exactly that, and
#     names the real checkout when boot.sh runs it from a temporary clone.
#   - A ghost-protocol marketplace from anywhere else is never repointed: a
#     FAIL that stops the run before the service step. So is a failed install.
# Anthropic's security-guidance plugin is recommended, never required.
#   - plugin.json declares no dependency. Claude Code does not load a plugin
#     whose dependency is missing, and GHOST Protocol (with its Buzz channel)
#     must load whether or not security-guidance is there.
#   - The installer's step 11 installs security-guidance at user scope when it
#     is missing there, adding the official marketplace first when needed. A
#     copy at project or local scope does not count, and no project's
#     settings change the answer (claude runs from /). A failure is a warning
#     and a SKIP line, and the run goes on to the end.
#   - Claude Code's JSON is read the same way pretty or compact, in any key
#     order, with nested objects, and even when the command exits non-zero;
#     output that is not JSON is read as "nothing there".
#   - The README says how to install it by hand.
# The stub claude (fixtures/stubs/claude) answers the plugin commands from
# $T/state.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

PJ="$SRC/.claude-plugin/plugin.json"
MJ="$SRC/.claude-plugin/marketplace.json"
README="$SRC/README.md"
SG="security-guidance@claude-plugins-official"

# ---------------------------------------------------------------- the manifest

t_new
if t_tool jq; then
    JQ="$T/sysbin/jq"
    check "plugin.json is JSON" sh -c "'$JQ' -e . '$PJ' >/dev/null"
    check "plugin.json declares no dependencies (a missing plugin must never stop GHOST Protocol from loading)" \
        sh -c "'$JQ' -e '(.dependencies // []) | length == 0' '$PJ' >/dev/null"
    check "marketplace.json's entries declare no dependencies either" \
        sh -c "'$JQ' -e '[.plugins[]? | (.dependencies // [])[]] | length == 0' '$MJ' >/dev/null"
else
    echo "SKIP  plugin.json is JSON (no jq on this machine)"
    check "plugin.json declares no dependencies" sh -c "! grep -q '\"dependencies\"' '$PJ'"
    check "marketplace.json declares no dependencies" sh -c "! grep -q '\"dependencies\"' '$MJ'"
fi
check "README: says how to install security-guidance by hand" grep -qx "claude plugin install $SG" "$README"

# ---------------------------------------------------------------- step 11

GP="ghost-protocol@ghost-protocol"
# Each security-guidance case starts with GHOST Protocol's plugin already
# installed from this checkout, so only security-guidance's calls are new.
# The cases add to the state files (>>), never replace them.
fresh() {
    t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
    echo "ghost-protocol $SRC" >"$T/state/claude.marketplaces"
    echo "$GP enabled" >"$T/state/claude.plugins"
}
bare() { t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"; }
# security-guidance already there, so every plugin call left is GHOST Protocol's.
with_sg() {
    echo "claude-plugins-official" >>"$T/state/claude.marketplaces"
    echo "$SG enabled" >>"$T/state/claude.plugins"
}
I=(--instance example/instance --yes)
went_on() { out_has '== 16\. status'; }

# 1. Missing, and the official marketplace not added: both are added.
fresh
t_install "${I[@]}"
check "missing: exit 0" rc_is 0
check "missing: the official marketplace is added" called "claude plugin marketplace add"
check "missing: security-guidance is installed" called "claude plugin install"
check "missing: DONE" out_has "DONE +security +$SG installed"
check "missing: installed at user scope, named explicitly" grep -qx "$SG enabled user" "$T/state/claude.plugins"
check "missing: GHOST Protocol's plugin is refreshed, not installed again" out_has "OK +gp-plugin +$GP installed and enabled"

# 2. Already installed and enabled: nothing to do.
fresh
echo "$SG enabled" >>"$T/state/claude.plugins"
t_install "${I[@]}"
check "enabled: exit 0" rc_is 0
check "enabled: OK" out_has "OK +security +$SG installed and enabled"
check "enabled: no install" not_called "claude plugin install"
check "enabled: GHOST Protocol's plugin refreshed" sh -c "grep -q '^claude plugin marketplace update ' '$T/state/calls' && grep -q '^claude plugin update ' '$T/state/calls'"
check "enabled: no marketplace added" not_called "claude plugin marketplace add"

# 3. Installed but disabled: a choice, left as it is.
fresh
echo "$SG disabled" >>"$T/state/claude.plugins"
t_install "${I[@]}"
check "disabled: OK, left as it is" out_has "OK +security +.*disabled by choice \\(user scope\\); left as it is"
check "disabled: no install" not_called "claude plugin install"
check "disabled: the run went on" went_on

# 4. The official marketplace already added: only the install.
fresh
echo "claude-plugins-official" >>"$T/state/claude.marketplaces"
t_install "${I[@]}"
check "marketplace there: not added again" not_called "claude plugin marketplace add"
check "marketplace there: installed" out_has "DONE +security"

# 5. The install fails: a warning, a SKIP line, and the run goes on to the end.
fresh
touch "$T/state/claude.plugin-install-fails"
t_install "${I[@]}"
check "install fails: exit 0" rc_is 0
check "install fails: a warning" out_has "WARNING: $SG was not installed: claude plugin install failed"
check "install fails: says GHOST Protocol runs without it" out_has 'WARNING: GHOST Protocol runs without it'
check "install fails: SKIP" out_has "SKIP +security +$SG not installed"
check "install fails: no FAIL line" out_lacks '^  FAIL '
check "install fails: the run went on" went_on

# 6. The official marketplace can't be added: a warning, no install tried.
fresh
touch "$T/state/claude.marketplace-add-fails"
t_install "${I[@]}"
check "marketplace add fails: exit 0" rc_is 0
check "marketplace add fails: a warning" out_has 'WARNING: .* could not add the official marketplace'
check "marketplace add fails: no install tried" not_called "claude plugin install"
check "marketplace add fails: the run went on" went_on
check "marketplace add fails: SKIP" out_has "SKIP +security"

# 7. The install says yes but the plugin is not listed: a warning.
fresh
touch "$T/state/claude.plugin-install-noop"
t_install "${I[@]}"
check "install lists nothing: exit 0" rc_is 0
check "install lists nothing: SKIP" out_has "SKIP +security"
check "install lists nothing: says why" out_has 'not listed as enabled at user scope after the install'
check "install lists nothing: the run went on" went_on

# 8. A dry run: planned, read-only.
fresh
t_install "${I[@]}" --dry-run
check "dry run: exit 0" rc_is 0
check "dry run: PLAN" out_has "PLAN +security +would install $SG"
check "dry run: prints the marketplace it would add" out_has 'would run: claude plugin marketplace add anthropics/claude-plugins-official$'
check "dry run: prints the install, at user scope" out_has "would run: claude plugin install $SG --scope user\$"
check "dry run: no marketplace added" not_called "claude plugin marketplace add"
check "dry run: no install" not_called "claude plugin install"

# 9. Only the user scope counts.
#    (A) A copy installed for one project (local scope): installed for the user too.
fresh
echo "$SG enabled local" >>"$T/state/claude.plugins"
t_install "${I[@]}"
check "local copy only: installed at user scope" out_has "DONE +security"
check "local copy only: the user-scope line" grep -qx "$SG enabled user" "$T/state/claude.plugins"
#    (B) Enabled at project scope only: the same.
fresh
echo "$SG enabled project" >>"$T/state/claude.plugins"
t_install "${I[@]}"
check "project copy only: installed at user scope" out_has "DONE +security"
#    (C) A project that disables it, around wherever the installer runs: no
#        effect, since claude runs from /.
fresh
echo "$SG enabled" >>"$T/state/claude.plugins"
touch "$T/state/claude.cwd-disables"
t_install "${I[@]}"
check "a project disables it: still OK at user scope" out_has "OK +security +$SG installed and enabled \(user scope\)"
fresh
touch "$T/state/claude.cwd-disables"
t_install "${I[@]}"
check "a project disables it: a fresh install still reads as DONE" out_has "DONE +security"
#    Disabled at user scope, enabled for one project: the user's choice stands.
fresh
printf '%s disabled user\n%s enabled local\n' "$SG" "$SG" >>"$T/state/claude.plugins"
t_install "${I[@]}"
check "user disabled, local enabled: left as it is" out_has 'OK +security +.*disabled by choice \(user scope\)'
check "user disabled, local enabled: no install" not_called "claude plugin install"

# 10. The shapes of Claude Code's JSON.
for shape in compact reordered; do
    fresh
    printf 'other@x enabled\n%s disabled local\n%s enabled user\nlast@y disabled\n' "$SG" "$SG" >>"$T/state/claude.plugins"
    touch "$T/state/claude.json-$shape"
    t_install "${I[@]}"
    check "$shape JSON, listed with others and twice: OK at user scope" out_has "OK +security +$SG installed and enabled"
done
#    Reordered, with a nested object claiming user scope and enabled for a
#    local copy: the nested object is not the entry.
fresh
echo "$SG enabled local" >>"$T/state/claude.plugins"
touch "$T/state/claude.json-reordered" "$T/state/claude.json-compact"
t_install "${I[@]}"
check "a nested object that claims user scope: not believed" out_has "DONE +security"

# 11. plugin list and marketplace list that fail.
#     Not JSON: read as nothing there; the install is tried, and since the
#     list still can't be read, a warning; the run goes on.
fresh
touch "$T/state/claude.list-garbage"
t_install "${I[@]}"
check "plugin list not JSON: security-guidance is a SKIP" out_has "SKIP +security"
check "plugin list not JSON: GHOST Protocol's own plugin cannot be confirmed: FAIL" out_has "FAIL +gp-plugin +$GP is not listed as enabled at user scope after the install"
check "plugin list not JSON: exit 1, and the run stops before the service step" sh -c "[ $RC -eq 1 ] && ! grep -q '== 14\. service' '$OUT'"
#     JSON, then a non-zero exit: the JSON counts.
fresh
echo "$SG enabled" >>"$T/state/claude.plugins"
touch "$T/state/claude.list-json-fails"
t_install "${I[@]}"
check "plugin list JSON with exit 1: read" out_has "OK +security"
fresh
touch "$T/state/claude.mlist-garbage"
t_install "${I[@]}"
check "marketplace list not JSON: the marketplace is added, then the install" out_has "DONE +security"
check "marketplace list not JSON: exit 0" rc_is 0
fresh
echo "claude-plugins-official" >>"$T/state/claude.marketplaces"
touch "$T/state/claude.mlist-json-fails"
t_install "${I[@]}"
check "marketplace list JSON with exit 1: read, not added again" not_called "claude plugin marketplace add"
check "marketplace list JSON with exit 1: installed" out_has "DONE +security"

# 12. A dry run on a machine with no Claude Code yet.
t_new; t_stub curl; t_stub sudo; t_make_instance "$FIX/manifests/good.toml"
t_install "${I[@]}" --dry-run
check "no claude, dry run: PLAN" out_has 'PLAN +security +would install .* once Claude Code is there'
check "no claude, dry run: GHOST Protocol's plugin planned too" out_has "PLAN +gp-plugin +would install $GP from $SRC .* once Claude Code is there"

# ---------------------------------------------------------------- GHOST Protocol's own plugin

# 13. Not there: the checkout is added as a directory marketplace and the
#     plugin installed at user scope; the run goes on.
bare
t_install "${I[@]}"
check "GP missing: exit 0" rc_is 0
check "GP missing: the checkout added as the ghost-protocol marketplace" grep -qx "ghost-protocol $SRC" "$T/state/claude.marketplaces"
check "GP missing: installed at user scope" grep -qx "$GP enabled user" "$T/state/claude.plugins"
check "GP missing: DONE" out_has "DONE +gp-plugin +$GP installed from $SRC \(a directory marketplace, user scope\)"
check "GP missing: the run went on" went_on

# 14. A dry run plans the same, and changes nothing.
bare
t_install "${I[@]}" --dry-run
check "GP dry run: exit 0" rc_is 0
check "GP dry run: prints the marketplace add" out_has "would run: claude plugin marketplace add $SRC\$"
check "GP dry run: prints the install, at user scope" out_has "would run: claude plugin install $GP --scope user\$"
check "GP dry run: PLAN" out_has "PLAN +gp-plugin +would install $GP from $SRC"
check "GP dry run: nothing added or installed" sh -c "! grep -qE '^claude plugin (install|marketplace add) ' '$T/state/calls'"
#    From boot.sh's temporary clone: the plan names the real checkout.
bare
t_env GP_TARGET_DIR="$T/home/ghost-protocol" "$SRC/install/install" "${I[@]}" --dry-run >"$OUT" 2>&1; RC=$?
check "GP dry run, temporary clone: names the real checkout" out_has "would run: claude plugin marketplace add $T/home/ghost-protocol\$"
#    GP_TARGET_DIR counts only in a dry run.
bare
t_env GP_TARGET_DIR="$T/home/ghost-protocol" "$SRC/install/install" "${I[@]}" >"$OUT" 2>&1; RC=$?
check "GP_TARGET_DIR in a real run: ignored, the checkout itself is used" grep -qx "ghost-protocol $SRC" "$T/state/claude.marketplaces"

# 15. A ghost-protocol marketplace from somewhere else: never repointed.
bare; with_sg
echo "ghost-protocol $T/elsewhere" >>"$T/state/claude.marketplaces"
t_install "${I[@]}"
check "GP elsewhere: exit 1" rc_is 1
check "GP elsewhere: FAIL" out_has "FAIL +gp-plugin +the ghost-protocol marketplace comes from $T/elsewhere, not $SRC; left as it is"
check "GP elsewhere: not repointed" grep -qx "ghost-protocol $T/elsewhere" "$T/state/claude.marketplaces"
check "GP elsewhere: no marketplace add" not_called "claude plugin marketplace add"
check "GP elsewhere: says how to repoint it by hand" out_has "WARNING:   claude plugin marketplace add $SRC\$"
check "GP elsewhere: the run stops before the service step" out_lacks '== 14\. service'
#    The dry run says the same, and stops there too.
bare
echo "ghost-protocol $T/elsewhere" >"$T/state/claude.marketplaces"
t_install "${I[@]}" --dry-run
check "GP elsewhere, dry run: FAIL" out_has "FAIL +gp-plugin +the ghost-protocol marketplace comes from"

# 16. Its install fails: FAIL, the run stops; security-guidance is still in.
bare
echo "$GP" >"$T/state/claude.plugin-install-fails"
t_install "${I[@]}"
check "GP install fails: exit 1" rc_is 1
check "GP install fails: FAIL" out_has "FAIL +gp-plugin +claude plugin install $GP failed"
check "GP install fails: security-guidance installed anyway" out_has "DONE +security"
check "GP install fails: the run stops before the service step" out_lacks '== 14\. service'

finish_tests
