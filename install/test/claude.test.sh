#!/usr/bin/env bash
# claude.test.sh: the Claude sign-in check, with a stub claude whose
# `auth status --json` reports a fixture email.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

I=(--instance example/instance --yes)
fresh() { t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"; }

# 1. Already signed in as the manifest's email: it goes on.
fresh
t_install "${I[@]}"
check "claude, right email: exit 0" rc_is 0
check "claude, right email: no sign-in or sign-out" sh -c "! grep -qE '^claude auth (login|logout) ' '$T/state/calls'"
check "claude, right email: it prints the account" out_has 'Signed in to Claude as agent@example.com'

# 2. Not signed in: it signs in on the terminal, then checks the email.
fresh
rm -f "$T/state/claude.authed"
t_tty ""
t_install "${I[@]}"
check "claude, fresh sign-in: exit 0" rc_is 0
check "claude, fresh sign-in: claude auth login ran" called "claude auth login"
check "claude, fresh sign-in: recorded as DONE" out_has 'DONE +claude +signed in as agent@example.com'

# 3. A fresh sign-in with the wrong email: signed out, exit 5.
fresh
rm -f "$T/state/claude.authed"
echo "someone@example.org" >"$T/state/claude.email"
t_tty ""
t_install "${I[@]}"
check "claude, wrong email: exit 5" rc_is 5
check "claude, wrong email: claude auth logout ran" called "claude auth logout"
check "claude, wrong email: it names both accounts" out_has 'signed in as someone@example.org, but this instance expects agent@example.com'

# 4. A wrong email signed in before the run: refused, never signed out.
fresh
echo "someone@example.org" >"$T/state/claude.email"
t_install "${I[@]}"
check "claude, earlier wrong sign-in: exit 5" rc_is 5
check "claude, earlier wrong sign-in: not signed out" not_called "claude auth logout"

# 5. The email check ignores case.
fresh
echo "Agent@Example.COM" >"$T/state/claude.email"
t_install "${I[@]}"
check "claude, same email in other case: exit 0" rc_is 0

# 6. Not signed in and no terminal: exit 4.
fresh
rm -f "$T/state/claude.authed"
t_install "${I[@]}"
check "claude, no terminal: exit 4" rc_is 4
check "claude, no terminal: no sign-in attempted" not_called "claude auth login"

finish_tests
