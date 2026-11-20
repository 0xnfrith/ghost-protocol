#!/usr/bin/env bash
# ci/run: refuses what it should, and never shows the token.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

R=$T/repo
mk_repo "$R"
commit "$R" "Start"
cd "$R" || exit 1
RUN=$PUB/ci/run
tok=fake-token-for-the-test

env -u GP_PUBLISH_TOKEN GP_PUBLISH_REPO=o/r "$RUN" >/dev/null 2>&1
check_eq "no token: refused" "$?" "1"
env -u GP_PUBLISH_REPO GP_PUBLISH_TOKEN=$tok "$RUN" >/dev/null 2>&1
check_eq "no repository: refused" "$?" "1"
GP_PUBLISH_TOKEN=$tok GP_PUBLISH_REPO='not a repo' "$RUN" >/dev/null 2>&1
check_eq "a bad repository name: refused (exit 2)" "$?" "2"
GP_PUBLISH_TOKEN=$tok GP_PUBLISH_REPO=o/r GP_PUBLISH_HOST='a b' "$RUN" >/dev/null 2>&1
check_eq "a bad host: refused (exit 2)" "$?" "2"
GP_PUBLISH_TOKEN='a b' GP_PUBLISH_REPO=o/r "$RUN" >/dev/null 2>&1
check_eq "a token with a space: refused (exit 2)" "$?" "2"

# A shallow clone is refused.
git clone -q --depth 1 "file://$R" "$T/shallow"
(cd "$T/shallow" && GP_PUBLISH_TOKEN=$tok GP_PUBLISH_REPO=o/r "$RUN" >/dev/null 2>&1)
check_eq "a shallow clone: refused (exit 2)" "$?" "2"

# Whatever happens, the token is not in the output or in a command line of the run (the host is unreachable here).
rc=0
out=$(GP_PUBLISH_TOKEN=$tok GP_PUBLISH_REPO=o/r GP_PUBLISH_HOST=127.0.0.1:1 GIT_TRACE=1 "$RUN" 2>&1) || rc=$?
check_eq "an unreachable host: not published" "$([ "$rc" -ne 0 ] && echo failed)" "failed"
check_eq "the token is not in the output" "$(grep -c -F "$tok" <<<"$out" || true)" "0"
check_eq "the credential's base64 is not in the output" "$(grep -c -F "$(printf 'x-access-token:%s' "$tok" | base64 -w0)" <<<"$out" || true)" "0"

done_tests
