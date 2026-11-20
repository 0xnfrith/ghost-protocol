#!/usr/bin/env bash
# ruleset.test.sh: tools/ruleset/ruleset against a stand-in gh
# (fixtures/stubs/gh-rulesets) for the repo example/instance: the request it
# builds, the dry run, the admin refusal, create, a second run that sends
# nothing, update, the proof that it is in force, refusals, all with a list of
# four checks (fixtures/required-checks); then this repo's
# .github/required-checks against .github/workflows/, and the secret scan's
# settings; then the mutation check: the script is copied with one
# guard broken at a time, and this test is run against each copy; every copy
# must fail it.
#
# RULESET=<a copy of the script> runs it once against that copy, without the
# workflow and mutation checks.
# The awk program and the jq filters hold literal $ and ${{ }} (SC2016).
# shellcheck disable=SC2016
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REAL="$SRC/tools/ruleset/ruleset"
RS="${RULESET:-$REAL}"
CHK="$FIX/required-checks"   # four checks, so the list's order and each guard show
REQ="$SRC/.github/required-checks"
A=(--repo example/instance --checks "$CHK")

t_new
if ! t_tool jq || ! command -v jq >/dev/null 2>&1; then
    echo "SKIP  ruleset tests (no jq on this machine; the script needs it)"
    finish_tests
    exit $?
fi

# A sandbox where gh is signed in as an admin of example/instance, the repo has
# no ruleset, and every listed check has reported on main.
world() {
    t_new
    ST="$T/state"
    cp "$FIX/stubs/gh-rulesets" "$T/stubs/gh"; chmod +x "$T/stubs/gh"
    t_tool jq
    echo "example/instance" >"$ST/repo"
    echo '{"full_name":"example/instance","default_branch":"main","permissions":{"admin":true,"maintain":true,"push":true,"triage":true,"pull":true}}' >"$ST/repo.json"
    echo '{"login":"example-admin"}' >"$ST/user.json"
    echo '[]' >"$ST/rulesets.json"
    runs_from "$CHK"
}
# runs.json: every check in a checks file has reported, from the app it names.
runs_from() {
    grep -v '^#' "$1" | grep . \
        | jq -Rn '{ total_count: 0, check_runs: [ inputs | { name: sub("^[0-9]+ "; ""), app: { id: (split(" ")[0] | tonumber) } } ] }' \
        >"$ST/runs.json"
}
rs() { t_env "$RS" "$@" >"$OUT" 2>&1; RC=$?; }
body_of() { sed -n "/<<'JSON'\$/,/^JSON\$/p" "$OUT" | sed '1d;$d'; }
bj() { body_of | jq -e "$@" >/dev/null 2>&1; }
writes() { grep -cvE '^gh api GET ' "$ST/calls" || true; }   # every call that is not a read
posts()  { grep -cE '^gh api POST ' "$ST/calls" || true; }
puts()   { grep -cE '^gh api PUT ' "$ST/calls" || true; }
counts_are() { [ "$(posts)" -eq "$1" ] && [ "$(puts)" -eq "$2" ]; }   # POSTs, PUTs
stored() { jq -e "$2" "$ST/ruleset-$1.json" >/dev/null 2>&1; }

# The ruleset the spec asks for, written out here on its own.
expected_body() {   # branch
    grep -v '^#' "$CHK" | grep . | jq -Rn --arg b "$1" '{
        name: ("Protect " + $b), target: "branch", enforcement: "active", bypass_actors: [],
        conditions: { ref_name: { include: ["refs/heads/" + $b], exclude: [] } },
        rules: [
            { type: "deletion" },
            { type: "non_fast_forward" },
            { type: "pull_request", parameters: { required_approving_review_count: 0, require_code_owner_review: true,
                dismiss_stale_reviews_on_push: true, require_last_push_approval: false, required_review_thread_resolution: false,
                require_extra_approval_for_unattributed_changes: true, allowed_merge_methods: ["squash"] } },
            { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false,
                required_status_checks: [ inputs | { context: sub("^[0-9]+ "; ""), integration_id: (split(" ")[0] | tonumber) } ] } }
        ] }'
}
body_is() { body_of >"$T/got.json"; expected_body "$1" >"$T/want.json"; jq -e -n --slurpfile a "$T/got.json" --slurpfile b "$T/want.json" '$a[0] == $b[0]' >/dev/null 2>&1; }

# 1. Usage.
world
rs;                                       check "usage: no --repo: exit 2" rc_is 2
rs --repo nope;                           check "usage: not owner/name: exit 2" rc_is 2
rs --repo a/b/c;                          check "usage: owner/name/extra: exit 2" rc_is 2
rs "${A[@]}" --bogus;                     check "usage: an unknown option: exit 2" rc_is 2
rs "${A[@]}" --branch 'two words';        check "usage: a bad branch name: exit 2" rc_is 2
NL="$(printf 'x\ny')"; NL="${NL%y}"; NL="${NL#x}"   # a newline
rs --repo "a/b${NL}c" --checks "$CHK";     check "usage: a newline in the repo: exit 2" rc_is 2
rs --repo "a/b${NL}" --checks "$CHK";      check "usage: a trailing newline in the repo: exit 2" rc_is 2
rs --repo a/.. --checks "$CHK";            check "usage: .. in the repo: exit 2" rc_is 2
rs --repo /b --checks "$CHK";              check "usage: no owner: exit 2" rc_is 2
rs "${A[@]}" --branch "main${NL}evil";    check "usage: a newline in the branch: exit 2" rc_is 2
rs "${A[@]}" --branch main/;              check "usage: a branch ending in /: exit 2" rc_is 2
rs "${A[@]}" --branch /main;              check "usage: a branch starting with /: exit 2" rc_is 2
rs "${A[@]}" --branch a//b;               check "usage: // in the branch: exit 2" rc_is 2
rs "${A[@]}" --branch ../x;               check "usage: .. in the branch: exit 2" rc_is 2
rs --help
check "help: exit 0" rc_is 0
check "help: it shows the usage and the exit codes" sh -c "grep -q '^Usage:' '$OUT' && grep -q '^Exit codes:' '$OUT'"
check "usage: no call to gh" [ ! -s "$ST/calls" ]

# 2. A dry run: the exact request, and nothing sent.
world
rs "${A[@]}"
check "dry run: exit 0" rc_is 0
check "dry run: it would create the ruleset" out_has 'has no ruleset named "Protect main": --apply creates it'
check "dry run: it prints the gh command" out_has "^gh api --method POST repos/example/instance/rulesets --input - <<'JSON'\$"
check "dry run: the body is the spec's ruleset, whole" body_is main
check "dry run: name Protect main, on refs/heads/main only" bj '.name == "Protect main" and .conditions.ref_name == {include: ["refs/heads/main"], exclude: []}'
check "dry run: active, for a branch" bj '.enforcement == "active" and .target == "branch"'
check "dry run: no bypass actors" bj '.bypass_actors == []'
check "dry run: deletion and force-push are blocked" bj 'any(.rules[]; .type == "deletion") and any(.rules[]; .type == "non_fast_forward")'
check "dry run: a pull request, 0 approvals, code-owner review, stale approvals dismissed" \
    bj '.rules[] | select(.type == "pull_request") | .parameters | .required_approving_review_count == 0 and .require_code_owner_review == true and .dismiss_stale_reviews_on_push == true'
check "dry run: squash is the only merge method" bj '.rules[] | select(.type == "pull_request") | .parameters.allowed_merge_methods == ["squash"]'
check "dry run: the extra approval for unattributed Copilot pull requests is sent, on (GitHub's default)" \
    bj '.rules[] | select(.type == "pull_request") | .parameters.require_extra_approval_for_unattributed_changes == true'
check "dry run: the checks are not strict" bj '.rules[] | select(.type == "required_status_checks") | .parameters.strict_required_status_checks_policy == false'
check "dry run: the four checks, in the file's order" \
    bj '[.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] == ["install-test (ubuntu-latest)", "blackout-test (ubuntu-latest)", "adapter-tests", "secret-scan"]'
check "dry run: every check is pinned to GitHub Actions (15368)" \
    bj '[.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].integration_id] | length == 4 and all(. == 15368)'
check "dry run: no NOTE when every check has reported" out_lacks '^NOTE'
check "dry run: nothing was sent" [ "$(writes)" -eq 0 ]
check "dry run: it says so" out_has '^Dry run: nothing was sent'
DRY="$T/dry.json"; body_of >"$DRY"

# 3. The branch and the name.
world
jq '.default_branch = "trunk"' "$ST/repo.json" >"$ST/r" && mv "$ST/r" "$ST/repo.json"
rs "${A[@]}"
check "default branch trunk: the ruleset is on refs/heads/trunk" body_is trunk
rs "${A[@]}" --branch release/v2
check "--branch release/v2: on refs/heads/release/v2" bj '.conditions.ref_name.include == ["refs/heads/release/v2"] and .name == "Protect release/v2"'
rs "${A[@]}" --name "Main rules"
check "--name: the ruleset takes it" bj '.name == "Main rules"'
jq --arg b "odd${NL}name" '.default_branch = $b' "$ST/repo.json" >"$ST/r" && mv "$ST/r" "$ST/repo.json"
rs "${A[@]}"
check "a default branch with a newline: exit 1, nothing built" sh -c "[ $RC -eq 1 ] && grep -q 'has a name this script does not take' '$OUT'"

# 4. Not an admin: the request is still shown, then refused; --apply sends nothing.
world
jq '.permissions.admin = false' "$ST/repo.json" >"$ST/r" && mv "$ST/r" "$ST/repo.json"
rm -f "$ST/user.json"
rs "${A[@]}"
check "not admin, dry run: exit 1" rc_is 1
check "not admin, dry run: the request is still printed" body_is main
check "not admin: it says why" out_has 'is not an admin of example/instance'
check "not admin: it names the way out" out_has 'integration token never reports admin'
rs "${A[@]}" --apply
check "not admin, --apply: exit 1" rc_is 1
check "not admin, --apply: nothing was sent" [ "$(writes)" -eq 0 ]
echo '{"login":"someone-else"}' >"$ST/user.json"
rs "${A[@]}" --apply
check "not admin: it names the login" out_has 'signed in as \(someone-else\) is not an admin'
echo '{"full_name":"example/instance","default_branch":"main"}' >"$ST/repo.json"
rs "${A[@]}" --apply
check "no permissions in the answer: refused" rc_is 1
check "no permissions in the answer: nothing was sent" [ "$(writes)" -eq 0 ]
# A matching ruleset, read by a login that cannot see its bypass list.
world
rs "${A[@]}" --apply
jq '.permissions.admin = false' "$ST/repo.json" >"$ST/r" && mv "$ST/r" "$ST/repo.json"
touch "$ST/hide-bypass"
rs "${A[@]}"
check "no bypass list in the answer: never 'already says this'" out_lacks 'already says this'
check "no bypass list in the answer: it says it cannot tell" out_has 'cannot read its bypass list, so whether it matches is not known'

# 5. --apply creates it; the body sent is the dry run's.
world
rs "${A[@]}" --apply
check "apply: exit 0" rc_is 0
check "apply: one POST" [ "$(posts)" -eq 1 ]
check "apply: no PUT" [ "$(puts)" -eq 0 ]
check "apply: the body sent is the dry run's" sh -c "jq -S . '$ST/body.json' >'$T/a' && jq -S . '$DRY' >'$T/b' && cmp -s '$T/a' '$T/b'"
check "apply: it names the new ruleset, in force" out_has 'OK  created ruleset 101, in force on main: https://github.com/example/instance/rules/101'

# 6. A second run sends nothing; a dry run says so.
rs "${A[@]}" --apply
check "apply again: exit 0" rc_is 0
check "apply again: nothing more was sent" [ "$(writes)" -eq 1 ]
check "apply again: it says so" out_has 'OK  ruleset 101 already says this, and is in force; nothing was sent'
check "apply again: what GitHub fills in (required_reviewers: []) still counts as the same" \
    stored 101 '.rules[] | select(.type == "pull_request") | .parameters.required_reviewers == []'
rs "${A[@]}"
check "dry run after: exit 0" rc_is 0
check "dry run after: it would send nothing" out_has 'ruleset 101 \("Protect main"\) already says this: --apply sends nothing'
check "dry run after: no setting is named as differing" out_lacks '^  differs at '

# 7. A ruleset of the same name that says anything else is replaced, in
# place: a bypass actor, strict checks, a missing rule, another merge method,
# required reviewers, a setting this script does not know, a default setting
# changed, the extra approval for unattributed Copilot pull requests cleared,
# switched off, or on another branch. The dry run names what differs.
PUTS=0
replaced() {   # label, jq edit of the stored ruleset, jq check of it after[, the difference the dry run names]
    jq "$2" "$ST/ruleset-101.json" >"$ST/r" && mv "$ST/r" "$ST/ruleset-101.json"
    rs "${A[@]}"
    check "$1: the dry run would replace it" out_has 'says something else: --apply replaces it'
    check "$1: the dry run names what differs" out_has "^  differs at ${4:-}"
    check "$1: the dry run shows a PUT to it" out_has "^gh api --method PUT repos/example/instance/rulesets/101 --input - <<'JSON'\$"
    rs "${A[@]}" --apply
    PUTS=$((PUTS + 1))
    check "$1: one PUT, no new POST" sh -c "[ $RC -eq 0 ] && [ $(puts) -eq $PUTS ] && [ $(posts) -eq 1 ]"
    check "$1: put right" stored 101 "$3"
}
PR='.rules[] | select(.type == "pull_request") | .parameters'
SC='.rules[] | select(.type == "required_status_checks") | .parameters'
replaced "a bypass actor added" '.bypass_actors = [{actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always"}]' '.bypass_actors == []' \
    'bypass_actors: this script sends \[\], GitHub has \[\{'
replaced "strict turned on" '.rules |= map(if .type == "required_status_checks" then .parameters.strict_required_status_checks_policy = true else . end)' "$SC | .strict_required_status_checks_policy == false"
replaced "the pull request rule removed" '.rules |= map(select(.type != "pull_request"))' 'any(.rules[]; .type == "pull_request")'
replaced "another merge method" '.rules |= map(if .type == "pull_request" then .parameters.allowed_merge_methods = ["rebase"] else . end)' "$PR | .allowed_merge_methods == [\"squash\"]"
replaced "required reviewers" '.rules |= map(if .type == "pull_request" then .parameters.required_reviewers = [{minimum_approvals: 1, file_patterns: ["*"], reviewer: {id: 1, type: "Team"}}] else . end)' "$PR | .required_reviewers == []"
replaced "a setting it does not know" '.rules |= map(if .type == "pull_request" then .parameters.some_new_setting = true else . end)' "$PR | has(\"some_new_setting\") | not" \
    'rules\.pull_request\.some_new_setting: this script sends nothing, GitHub has true$'
replaced "a default setting changed" '.rules |= map(if .type == "required_status_checks" then .parameters.do_not_enforce_on_create = true else . end)' "$SC | .do_not_enforce_on_create == false"
replaced "the unattributed-changes approval cleared" '.rules |= map(if .type == "pull_request" then .parameters.require_extra_approval_for_unattributed_changes = false else . end)' \
    "$PR | .require_extra_approval_for_unattributed_changes == true" \
    'rules\.pull_request\.require_extra_approval_for_unattributed_changes: this script sends true, GitHub has false$'
replaced "switched off" '.enforcement = "disabled"' '.enforcement == "active"' 'enforcement: this script sends "active", GitHub has "disabled"$'
replaced "on another branch" '.conditions.ref_name.include = ["refs/heads/other"]' '.conditions.ref_name.include == ["refs/heads/main"]'
rs "${A[@]}" --apply
check "after the updates: exit 0, nothing more is sent" sh -c "[ $RC -eq 0 ] && [ $(writes) -eq $((PUTS + 1)) ]"

# 7b. It proves the ruleset is in force on the branch, from its own id.
world
touch "$ST/unenforced"
rs "${A[@]}" --apply
check "stored, not in force: exit 1" rc_is 1
check "stored, not in force: it says so, and why" out_has 'is stored, but GitHub does not enforce it on main .*paid plan'
check "stored, not in force: it names the rules not in force" out_has 'not in force: deletion, non_fast_forward, pull_request, required_status_checks'
rs "${A[@]}" --apply
check "already there, not in force: exit 1" sh -c "[ $RC -eq 1 ] && grep -q 'does not enforce it on main' '$OUT'"
check "already there, not in force: nothing more was sent" [ "$(writes)" -eq 1 ]
rm -f "$ST/unenforced"
# Another active ruleset holds the same four rules on main; ours is not in force.
world
echo '[{"id": 7, "name": "Older rules"}]' >"$ST/rulesets.json"
jq -n '{id: 7, name: "Older rules", target: "branch", enforcement: "active", bypass_actors: [],
        conditions: {ref_name: {include: ["refs/heads/main"], exclude: []}},
        rules: [{type: "deletion"}, {type: "non_fast_forward"}, {type: "pull_request", parameters: {}}, {type: "required_status_checks", parameters: {}}]}' >"$ST/ruleset-7.json"
touch "$ST/unenforced-102"
rs "${A[@]}" --apply
check "in force only from another ruleset: exit 1" sh -c "[ $RC -eq 1 ] && grep -q 'ruleset 102 is stored, but GitHub does not enforce it' '$OUT'"

# 8. Another ruleset is left alone; two of the same name are refused.
world
echo '[{"id": 7, "name": "Older rules"}]' >"$ST/rulesets.json"
echo '{"id": 7, "name": "Older rules", "target": "branch", "enforcement": "evaluate", "rules": [{"type": "creation"}]}' >"$ST/ruleset-7.json"
cp "$ST/ruleset-7.json" "$T/seven"
rs "${A[@]}" --apply
check "another ruleset: a new one is created" counts_are 1 0
check "another ruleset: it is untouched" cmp -s "$ST/ruleset-7.json" "$T/seven"
world
echo '[{"id": 7, "name": "Protect main"}, {"id": 8, "name": "Protect main"}]' >"$ST/rulesets.json"
rs "${A[@]}" --apply
check "two of the same name: exit 1" rc_is 1
check "two of the same name: it says so" out_has 'more than one ruleset named "Protect main" \(ids 7 8 \)'
check "two of the same name: nothing was sent" [ "$(writes)" -eq 0 ]

# 9. Checks that have not reported on the branch are named, and refused
# unless --allow-unreported.
world
grep -v 'blackout-test (ubuntu-latest)' "$CHK" | sed 's/^15368 secret-scan$/99 secret-scan/' >"$T/fewer"
runs_from "$T/fewer"
rs "${A[@]}"
check "unreported checks, dry run: exit 1" rc_is 1
check "unreported checks: the request is still printed" body_is main
check "unreported checks: a NOTE" out_has '^NOTE  not reported on main'
check "unreported checks: the missing one is named" out_has '^        blackout-test \(ubuntu-latest\)$'
check "unreported checks: one from another app is named" out_has '^        secret-scan$'
check "unreported checks: a reported one is not" out_lacks '^        adapter-tests$'
check "unreported checks: it says why, and the way past" out_has 'has not reported on main .*--allow-unreported goes ahead'
rs "${A[@]}" --apply
check "unreported checks, --apply: exit 1" rc_is 1
check "unreported checks, --apply: nothing was sent" [ "$(writes)" -eq 0 ]
rs "${A[@]}" --allow-unreported
check "unreported checks, --allow-unreported dry run: exit 0" rc_is 0
rs "${A[@]}" --apply --allow-unreported
check "unreported checks, --allow-unreported --apply: created" sh -c "[ $RC -eq 0 ] && [ $(posts) -eq 1 ]"
echo '{"total_count": 0, "check_runs": []}' >"$ST/runs.json"
rs "${A[@]}"
check "no check has reported: all four are named" [ "$(grep -cE '^        [a-z-]+( \([a-z-]+\))?$' "$OUT")" -eq 4 ]
check "no check has reported: exit 1" rc_is 1
rm -f "$ST/runs.json"
rs "${A[@]}"
check "check runs unreadable: exit 1, with a NOTE" sh -c "[ $RC -eq 1 ] && grep -q '^NOTE  cannot read the checks' '$OUT'"
rs "${A[@]}" --allow-unreported
check "check runs unreadable, --allow-unreported: exit 0" rc_is 0
echo 'not json' >"$ST/runs.json"
rs "${A[@]}"
check "check runs not JSON: exit 1, with a NOTE" sh -c "[ $RC -eq 1 ] && grep -q '^NOTE  cannot read the checks' '$OUT'"
runs_from "$CHK"
# A grep that fails while comparing: refused, not taken as "all reported".
printf '#!/bin/sh\ncase " $* " in *" -vxF "*) exit 2 ;; esac\nexec "%s" "$@"\n' "$T/sysbin/grep" >"$T/stubs/grep"
chmod +x "$T/stubs/grep"
rs "${A[@]}"
check "grep fails while comparing: exit 1, and it says so" sh -c "[ $RC -eq 1 ] && grep -q 'cannot compare the listed checks' '$OUT'"
rm -f "$T/stubs/grep"

# 10. The checks file.
world
rs --repo example/instance --checks "$T/none"
check "no checks file: exit 1" rc_is 1
printf '# only a comment\n\n' >"$T/c"; rs --repo example/instance --checks "$T/c"
check "no checks listed: exit 1" rc_is 1
printf 'abc some-check\n' >"$T/c"; rs --repo example/instance --checks "$T/c"
check "an app id that is not a number: exit 1, with the line" sh -c "[ $RC -eq 1 ] && grep -q 'line 1: expected' '$OUT'"
printf '15368\n' >"$T/c"; rs --repo example/instance --checks "$T/c"
check "no check name: exit 1" rc_is 1
printf '15368 lint \n' >"$T/c"; rs --repo example/instance --checks "$T/c"
check "a stray space after the name: exit 1" rc_is 1
printf '15368 lint\n15368 build\n15368 lint\n' >"$T/c"; rs --repo example/instance --checks "$T/c"
check "a check listed twice: exit 1, with the line" sh -c "[ $RC -eq 1 ] && grep -q 'line 3: \"lint\" is listed twice' '$OUT'"
printf '# one\n42 lint (ubuntu-latest)' >"$T/c"; rs --repo example/instance --checks "$T/c"
check "one check, no newline at the end: it is the only one" \
    bj '[.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[]] == [{context: "lint (ubuntu-latest)", integration_id: 42}]'
check "the checks file's errors: nothing was sent" [ "$(writes)" -eq 0 ]

# 11. Failures: GitHub refuses the write; GitHub stores something else; no
# such repo; no jq.
world
touch "$ST/post.fail"
rs "${A[@]}" --apply
check "GitHub refuses: exit 1, with its message" sh -c "[ $RC -eq 1 ] && grep -q 'did not take the ruleset: gh: Validation Failed' '$OUT'"
rm -f "$ST/post.fail"
touch "$ST/store-drops-codeowner"
rs "${A[@]}" --apply
check "stored otherwise: exit 1" rc_is 1
check "stored otherwise: it says so" out_has 'GitHub stored something else'
check "stored otherwise: it shows what was sent and what was stored" sh -c "grep -q '^  sent:   .*\"require_code_owner_review\":true' '$OUT' && grep -q '^  stored: .*\"require_code_owner_review\":false' '$OUT'"
check "stored otherwise: it names the setting that differs" out_has '^  differs at rules\.pull_request\.require_code_owner_review: this script sends true, GitHub has false$'
# GitHub stores a setting this script does not send (as when GitHub adds a new
# setting with a default): the read-back fails and names that setting alone.
world
touch "$ST/store-adds-setting"
rs "${A[@]}" --apply
check "GitHub adds a setting: exit 1, stored something else" sh -c "[ $RC -eq 1 ] && grep -q 'GitHub stored something else' '$OUT'"
check "GitHub adds a setting: it is named as the difference" out_has '^  differs at rules\.pull_request\.a_new_default: this script sends nothing, GitHub has true$'
check "GitHub adds a setting: nothing else is named" [ "$(grep -c '^  differs at ' "$OUT")" -eq 1 ]
rs "${A[@]}"
check "GitHub adds a setting: the dry run after would replace it, and names it" \
    sh -c "grep -q 'says something else: --apply replaces it' '$OUT' && grep -q '^  differs at rules\.pull_request\.a_new_default: ' '$OUT'"
world
rs --repo other/repo --checks "$CHK"
check "no such repo: exit 1" rc_is 1
check "no such repo: it says so" out_has 'cannot read other/repo with gh'
t_env "$T/stubs/gh" api --bogus repos/example/instance >/dev/null 2>&1
check "the stand-in: a call with an unknown flag is recorded, and counts as sent" [ "$(writes)" -eq 1 ]
rm -f "$T/sysbin/jq"
: >"$ST/calls"
rs "${A[@]}"
check "no jq: exit 1, and it says so" sh -c "[ $RC -eq 1 ] && grep -q 'jq is not installed' '$OUT'"
check "no jq: gh was never called" [ ! -s "$ST/calls" ]

if [ -n "${RULESET:-}" ]; then finish_tests; exit $?; fi

# 12. The default checks file is this repo's .github/required-checks.
world
rs --repo example/instance
check "default checks file: .github/required-checks, 1 check" out_has "checks: 1, from $REQ\$"

# 13. .github/required-checks against .github/workflows/: each listed check
# comes from exactly one job, and every job that runs on pull requests is
# listed, or is one that a listed job needs. That is how all-tests
# (tests.yml) works: it needs every other job of tests.yml, and the test
# workflows those jobs call have no pull_request trigger of their own.
# A check's name is the job's name (else its id); a matrix over os fills in
# ${{ matrix.os }}, or GitHub adds " (<os>)" when the name has none. A job's
# needs are read from one line (needs: x, or needs: [x, y]).
# A workflow runs on pull requests when its on: names pull_request, inline
# (on: pull_request, on: [push, pull_request]) or as a block (a key or a list
# item). A path filter on pull_request is refused: its checks would not report
# on every pull request, and a required check that does not report blocks it.
pr_trigger() {   # prints "pr", "pr-paths" or nothing
    awk -v q="'" '
        function hasword(s) { return s ~ /(^|[^A-Za-z0-9_-])pull_request([^A-Za-z0-9_-]|$)/ }
        $0 ~ ("^(\"on\"|" q "on" q "|on):") {
            v = $0; sub(/^[^:]*:[ ]*/, "", v); sub(/[ ]+#.*$/, "", v)
            if (v != "") { if (hasword(v)) { pr = 1; if (v ~ /paths/) paths = 1 } }
            else inon = 1
            next
        }
        inon && /^[^ #]/ { inon = 0 }
        inon && /^  [^ #]/ {
            t = $0; sub(/^  (- )?/, "", t); rest = t; sub(/[: ].*$/, "", t)
            inpr = (t == "pull_request")
            if (inpr) { pr = 1; if (rest ~ /paths/) paths = 1 }
            next
        }
        inon && inpr && /^   +(paths|paths-ignore):/ { paths = 1 }
        END { if (pr) print (paths ? "pr-paths" : "pr") }
    ' "$1"
}
job_table() {   # one line per check: the job's id, the check's name and the job's needs (a,b,c), tab-separated
    awk -v q="'" '
        function trim(s) { sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s); return s }
        function unq(s,   c) {
            s = trim(s); c = substr(s, 1, 1)
            if (length(s) >= 2 && (c == "\"" || c == q) && substr(s, length(s), 1) == c) s = substr(s, 2, length(s) - 2)
            return s
        }
        function flush(   base, n, i, a, o, k) {
            if (job == "") return
            base = (name != "") ? name : job
            if (os == "") print job "\t" base "\t" needs
            else {
                n = split(os, a, ",")
                for (i = 1; i <= n; i++) {
                    o = unq(a[i]); k = index(base, "${{ matrix.os }}")
                    if (k > 0) print job "\t" substr(base, 1, k - 1) o substr(base, k + 16) "\t" needs
                    else print job "\t" base " (" o ")\t" needs
                }
            }
            job = ""; name = ""; os = ""; needs = ""
        }
        /^jobs:/ { injobs = 1; next }
        injobs && /^[^ #]/ { flush(); injobs = 0 }
        injobs && /^  [A-Za-z0-9_-]+:[ ]*$/ { flush(); job = trim($0); sub(/:$/, "", job); next }
        injobs && job != "" && /^    name:/ { name = $0; sub(/^    name:/, "", name); name = unq(name) }
        injobs && job != "" && /^    needs:/ { needs = $0; sub(/^    needs:/, "", needs); sub(/[ ]+#.*$/, "", needs); gsub(/[][ ]/, "", needs) }
        injobs && job != "" && /^ +os:[ ]*\[/ { os = $0; sub(/^ +os:[ ]*\[/, "", os); sub(/\].*$/, "", os) }
        END { flush() }
    ' "$@"
}
job_checks() { job_table "$@" | cut -f2; }
: >"$T/table" ; : >"$T/filtered"
for wf in "$SRC"/.github/workflows/*.yml "$SRC"/.github/workflows/*.yaml; do
    [ -f "$wf" ] || continue
    case "$(pr_trigger "$wf")" in
        pr)       job_table "$wf" | awk -v f="$(basename "$wf")" '{ print f "\t" $0 }' >>"$T/table" ;;
        pr-paths) job_table "$wf" | awk -v f="$(basename "$wf")" '{ print f "\t" $0 }' >>"$T/table"; basename "$wf" >>"$T/filtered" ;;
    esac
done
if [ ! -s "$T/filtered" ]; then ok "workflows: no pull_request trigger has a path filter"
else bad "workflows: a path filter on pull_request in: $(tr '\n' ' ' <"$T/filtered")"; fi
grep -v '^#' "$REQ" | grep . | sed 's/^[0-9]* //' | sort >"$T/listed"
cut -f3 "$T/table" | sort >"$T/made"
check "workflows: the jobs make some checks" [ -s "$T/made" ]
dups="$(uniq -d "$T/made")"
if [ -z "$dups" ]; then ok "workflows: no two jobs make a check of the same name"
else bad "workflows: more than one job makes each of: $(echo "$dups" | tr '\n' ',')"; fi
unmade="$(comm -23 "$T/listed" "$T/made")"
if [ -z "$unmade" ]; then ok "workflows: each check in .github/required-checks is made by a job that runs on pull requests"
else bad "workflows: listed, but made by no job that runs on pull requests: $(echo "$unmade" | tr '\n' ',')"; fi
# workflow:job for each job that runs on pull requests and is neither listed
# nor needed by a listed job.
uncovered="$(awk -F'\t' '
    NR == FNR { listed[$0] = 1; next }
    { all[$1 ":" $2] = 1 }
    $3 in listed { cov[$1 ":" $2] = 1; n = split($4, a, ","); for (i = 1; i <= n; i++) cov[$1 ":" a[i]] = 1 }
    END { for (j in all) if (!(j in cov)) print j }' "$T/listed" "$T/table" | sort)"
if [ -z "$uncovered" ]; then ok "workflows: every job that runs on pull requests is listed, or is needed by a listed job"
else bad "workflows: runs on pull requests, but no listed check covers it: $(echo "$uncovered" | tr '\n' ',')"; fi
check "workflows: every listed check is from GitHub Actions (15368)" sh -c "! grep -v '^#' '$REQ' | grep . | grep -qv '^15368 '"
# all-tests is the one required check, and it reports whatever its needs did:
# without if: always(), a failed test would skip it, and a skipped required
# check counts as passed.
TESTS="$SRC/.github/workflows/tests.yml"
check "workflows: the one listed check is all-tests" [ "$(cat "$T/listed")" = "all-tests" ]
awk '/^  all-tests:/ { f = 1; next } f && /^  [A-Za-z0-9_-]+:/ { f = 0 } f' "$TESTS" >"$T/all-tests"
check "workflows: all-tests runs whatever its needs did (if: always())" grep -qxF '    if: ${{ always() }}' "$T/all-tests"
check "workflows: all-tests has no other if" [ "$(grep -c '^    if:' "$T/all-tests")" -eq 1 ]
check "workflows: all-tests has no step-level if" sh -c "! grep -qE '^      +(- )?if:' '$T/all-tests'"
check "workflows: all-tests never continues on an error (job or step)" sh -c "! grep -q 'continue-on-error' '$T/all-tests'"
check "workflows: all-tests' script can fail (exit 1)" grep -qE '^ +exit 1$' "$T/all-tests"
# A title or description edit queues behind a running run instead of
# cancelling it into a cancelled all-tests; a newer push or a base change
# (a retarget, which also arrives as an edit) cancels.
check "workflows: an edit's run queues; a newer push or a retarget cancels" \
    grep -qxF "  cancel-in-progress: \${{ github.event_name == 'pull_request' && (github.event.action != 'edited' || github.event.changes.base != null) }}" "$TESTS"
# The group has no base in it: with one, a retarget's run would sit in a
# group of its own and could never cancel the old base's run.
check "workflows: the concurrency group has no base in it" \
    grep -qxF "  group: tests-\${{ github.event.pull_request.number || github.sha }}" "$TESTS"
# The publish job runs in the publish environment, which only main can deploy
# from: its push credential is that environment's secret, so a run from any
# other branch never gets it.
awk '/^  publish:/ { f = 1; next } f && /^  [A-Za-z0-9_-]+:/ { f = 0 } f' "$SRC/.github/workflows/publish.yml" >"$T/publish-job"
check "workflows: the publish job runs in the publish environment" grep -qxF '    environment: publish' "$T/publish-job"
# The parser itself, on a made-up workflow.
cat >"$T/wf.yml" <<'EOF'
on:
  pull_request:
jobs:
  plain:
    runs-on: ubuntu-latest
  named:
    name: "lint all"
    runs-on: ubuntu-latest
  grid:
    strategy:
      matrix:
        os: [ubuntu-latest, 'macos-latest']
    runs-on: ${{ matrix.os }}
  grid-named:
    name: build on ${{ matrix.os }}
    strategy:
      matrix:
        os: [a, b]
    steps:
      - name: not a job name
        run: echo
EOF
check "workflows: the parser reads ids, names and an os matrix" \
    [ "$(job_checks "$T/wf.yml" | tr '\n' '|')" = "plain|lint all|grid (ubuntu-latest)|grid (macos-latest)|build on a|build on b|" ]
cat >"$T/needs.yml" <<'EOF'
on:
  pull_request:
jobs:
  first:
    runs-on: ubuntu-latest
  one:
    needs: first # a comment
    runs-on: ubuntu-latest
  all:
    name: all
    needs: [first, one]
    if: ${{ always() }}
EOF
check "workflows: the parser reads a job's needs, one or a list" \
    [ "$(job_table "$T/needs.yml" | tr '\t\n' ' |')" = "first first |one one first|all all first,one|" ]
# The trigger parser, on made-up on: blocks.
trig() { printf '%b' "$1" >"$T/t.yml"; [ "$(pr_trigger "$T/t.yml")" = "$2" ]; }
check "triggers: on: pull_request"                trig 'on: pull_request\njobs:\n' pr
check "triggers: on: [push, pull_request]"        trig 'on: [push, pull_request]\njobs:\n' pr
check "triggers: a block list"                    trig '"on":\n  - push\n  - pull_request\njobs:\n' pr
check "triggers: a block key"                     trig 'on:\n  push:\n    paths: [x]\n  pull_request:\n    branches: [main]\njobs:\n' pr
check "triggers: paths under pull_request"        trig 'on:\n  pull_request:\n    paths:\n      - src/**\njobs:\n' pr-paths
check "triggers: paths-ignore under pull_request" trig 'on:\n  pull_request:\n    paths-ignore: [docs/**]\njobs:\n' pr-paths
check "triggers: an inline map with paths"        trig 'on: {pull_request: {paths: [x]}}\njobs:\n' pr-paths
check "triggers: pull_request_target is not it"   trig 'on: pull_request_target\njobs:\n' ''
check "triggers: push only"                       trig 'on:\n  push:\n    branches: [main]\njobs:\n' ''

# The secret scan reads its settings only from .github/: its own config, no
# ignore file elsewhere, no inline allow.
GATES="$SRC/.github/workflows/gates.yml"
check "secret scan: the config is .github/gitleaks.toml" grep -q -- '--config \.github/gitleaks\.toml' "$GATES"
check "secret scan: the ignore file is looked for in .github only" grep -q -- '--gitleaks-ignore-path \.github' "$GATES"
check "secret scan: inline gitleaks:allow comments do not count" grep -q -- '--ignore-gitleaks-allow' "$GATES"
check "secret scan: a .gitleaksignore at the root is removed first" grep -q 'rm -f \.gitleaksignore' "$GATES"
check "secret scan: the config is gitleaks' default rules" grep -qx 'useDefault = true' "$SRC/.github/gitleaks.toml"
check "secret scan: the config allows nothing" sh -c "! grep -qiE 'allowlist|^ *(paths|regexes|stopwords|commits) *=' '$SRC/.github/gitleaks.toml'"

# --- mutation check: each broken guard must fail this test
M="$T/mutants"; mkdir -p "$M"
# Two mutant runs at a time (every run has its own sandbox), so a small
# machine is not swamped; the verdicts are read once all of them are done.
STARTED="" RUNNING=0
mutant() {   # name, sed program
    local name="$1" prog="$2" f
    f="$M/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"
    sed -e "$prog" "$REAL" >"$f"; chmod +x "$f"
    if cmp -s "$f" "$REAL"; then bad "mutant $name: the sed changed nothing"; return; fi
    if [ "$RUNNING" -ge 2 ]; then wait; RUNNING=0; fi
    (RULESET="$f" bash "${BASH_SOURCE[0]}" >"$f.out" 2>&1) &
    RUNNING=$((RUNNING + 1))
    STARTED="$STARTED$f|$name
"
}
mutant "no admin refusal"           '/# guard:admin$/d'
mutant "a dry run sends"            '/# guard:dryrun$/d'
mutant "no no-change skip"          '/# guard:nochange$/d'
mutant "no read-back check"         '/# guard:readback$/d'
mutant "unreported checks allowed"  '/# guard:unreported$/d'
mutant "two rulesets of one name"   '/# guard:twins$/d'
mutant "a check listed twice"       '/# guard:dupcheck$/d'
mutant "a bypass actor"             's/^  bypass_actors: \[\],$/  bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }],/'
mutant "checks pinned to no app"    's/, integration_id: (\.\[0\] | tonumber)//'
mutant "no code-owner review"       's/require_code_owner_review: true,/require_code_owner_review: false,/'
mutant "force-push allowed"         '/{ type: "non_fast_forward" },/d'
mutant "strict checks"              's/strict_required_status_checks_policy: false,/strict_required_status_checks_policy: true,/'
mutant "bypass actors not compared" 's/(\.bypass_actors | sort_by(\.actor_type, \.actor_id))/([])/'
mutant "a hidden bypass list read as empty" 's/else "unknown" end/else [] end/'
mutant "enforcement not compared"   '/^    enforcement: \.enforcement,$/d'
mutant "the branch not compared"    's/^    conditions: .*$/    conditions: {},/'
mutant "a changed default dropped"  's/ and \.\[\$e\.key\] == \$e\.value//'
mutant "merge methods not compared" 's#if has("allowed_merge_methods") then .allowed_merge_methods |= sort else . end#del(.allowed_merge_methods)#'
mutant "every merge method allowed" 's/allowed_merge_methods: \["squash"\]/allowed_merge_methods: ["merge", "squash", "rebase"]/'
mutant "unattributed approval left to GitHub" '/require_extra_approval_for_unattributed_changes: true,/d'
mutant "unattributed approval off"  's/require_extra_approval_for_unattributed_changes: true,/require_extra_approval_for_unattributed_changes: false,/'
mutant "differences not named"      's/| select(\$u != \$v)/| select(false)/'
mutant "not proven in force"        '/# guard:enforced$/d'
mutant "in force from any ruleset"  's/\.ruleset_id == \$id and //'
mutant "grep errors ignored"        '/# guard:greprc$/d'
mutant "a newline in the repo"      '/# guard:reponame$/s/|\*\[!A-Za-z0-9\._\/-\]\*//'
mutant "a newline in the branch"    '/# guard:branchname$/s/|\*\[!A-Za-z0-9\._\/-\]\*//'
wait
while IFS='|' read -r f name; do
    [ -n "$f" ] || continue
    fails="$(grep -c '^FAIL' "$f.out")"
    if [ "$fails" -gt 0 ]; then ok "mutant caught: $name ($fails checks fail)"; else bad "mutant NOT caught: $name"; fi
done <<EOF
$STARTED
EOF

finish_tests
