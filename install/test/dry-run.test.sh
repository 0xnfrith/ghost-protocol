#!/usr/bin/env bash
# dry-run.test.sh: a dry run changes nothing. A sorted listing of HOME, with
# the sha256 of every file, is the same before and after, and no stub saw a
# call that changes anything (a sign-in, a sign-out, a download, sudo).
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

no_writes() {
    not_called "gh auth login" && not_called "gh auth logout" \
        && not_called "claude auth login" && not_called "claude auth logout" \
        && not_called curl && not_called sudo
}
same_home() { cmp -s "$T/before" "$T/after"; }

# 1. Signed in everywhere, the instance not cloned yet: the manifest is read
#    from a temporary clone; the setup hook is only planned.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
t_snapshot >"$T/before"
t_install --instance example/instance --dry-run --yes
t_snapshot >"$T/after"
check "dry run, not cloned: exit 0" rc_is 0
check "dry run, not cloned: HOME is unchanged" same_home
check "dry run, not cloned: nothing that writes was called" no_writes
check "dry run, not cloned: the manifest was still read" out_has 'OK +manifest'
check "dry run, not cloned: the setup hook is planned, not run" not_called setup
check "dry run, not cloned: it prints the clone command" out_has 'would run: git clone --branch main https://github.com/example/instance.git'
check "dry run, not cloned: no temp folder is left" no_temp_left

# 2. The instance already cloned: the setup hook runs with --dry-run appended.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"; t_clone_into_home
t_snapshot >"$T/before"
t_install --instance example/instance --dry-run --yes
t_snapshot >"$T/after"
check "dry run, cloned: exit 0" rc_is 0
check "dry run, cloned: HOME is unchanged" same_home
check "dry run, cloned: nothing that writes was called" no_writes
check "dry run, cloned: the setup hook ran with --dry-run (4 arguments)" grep -qx 'setup 4' "$T/state/calls"

# 3. Nothing at all: no gh, no Claude Code, no sign-ins. Every step is a plan,
#    and nothing is downloaded.
t_new; t_stub curl; t_stub sudo; t_make_instance "$FIX/manifests/good.toml"
t_snapshot >"$T/before"
t_install --instance example/instance --dry-run --yes
t_snapshot >"$T/after"
check "dry run, bare machine: exit 0" rc_is 0
check "dry run, bare machine: HOME is unchanged" same_home
check "dry run, bare machine: nothing was downloaded" not_called curl
check "dry run, bare machine: it says it would download the pinned gh" out_has 'would download https://github.com/cli/cli/releases/download/v'
check "dry run, bare machine: it says it would download Claude Code" out_has 'would download https://downloads.claude.ai/claude-code-releases/'
check "dry run, bare machine: the sign-in is planned" out_has 'PLAN +github +token mode; would sign in'

# 4. Integration mode: the git config line is only planned.
t_new; t_std_env; rm -f "$T/state/gh.authed"; t_integration
t_make_instance "$FIX/manifests/good.toml" int
t_snapshot >"$T/before"
t_install --instance example/instance --dry-run --yes
t_snapshot >"$T/after"
check "dry run, integration: exit 0" rc_is 0
check "dry run, integration: HOME is unchanged" same_home
check "dry run, integration: the insteadOf lines are planned" out_has 'PLAN +gitconfig +would write 2 url.insteadOf'
check "dry run, integration: no gh sign-in" no_writes
check "dry run, integration: the repo check still runs (read-only)" out_has 'OK +account +integration mode: github.int.exe.xyz answers the GitHub API for 2 repo'
check "dry run, integration: no /user call" not_called "gh api user"

# 4b. Integration mode with no gh on the machine: the repo check is planned.
t_new; t_stub curl; t_stub sudo; t_integration; t_make_instance "$FIX/manifests/good.toml" int
t_snapshot >"$T/before"
t_install --instance example/instance --dry-run --yes
t_snapshot >"$T/after"
check "dry run, integration, no gh: exit 0" rc_is 0
check "dry run, integration, no gh: HOME is unchanged" same_home
check "dry run, integration, no gh: the repo check is planned, naming the repos" \
    out_has 'PLAN +account +integration mode: would check that github.int.exe.xyz answers the GitHub API for example/instance example/tools \(github.login is not matched\)'

# 5. A wrong account in a dry run: reported (exit 5), but nothing is signed out.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
echo "someone-else" >"$T/state/gh.login"
t_snapshot >"$T/before"
t_install --instance example/instance --dry-run --yes
t_snapshot >"$T/after"
check "dry run, wrong GitHub account: exit 5" rc_is 5
check "dry run, wrong GitHub account: nothing signed out or changed" no_writes
check "dry run, wrong GitHub account: HOME is unchanged" same_home

# 6. A WORK or GP_WORK folder in the caller's environment is never adopted as
#    the temp folder, so the cleanup never deletes it.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
mkdir -p "$T/keep"; echo keep >"$T/keep/marker"
t_env WORK="$T/keep" GP_WORK="$T/keep" "$SRC/install/install" --instance example/instance --dry-run --yes >"$OUT" 2>&1
RC=$?
check "a WORK from the environment survives a dry run" [ -f "$T/keep/marker" ]
t_env WORK="$T/keep" GP_WORK="$T/keep" "$SRC/install/install" --instance example/instance --yes >"$OUT" 2>&1
RC=$?
check "a WORK from the environment survives a real run" [ -f "$T/keep/marker" ]
check "the real run with WORK set still succeeds" rc_is 0

finish_tests
