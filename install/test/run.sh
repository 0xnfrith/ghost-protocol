#!/usr/bin/env bash
# run.sh: runs every install/test/*.test.sh, then shellcheck where it is
# installed. Each test file runs under `env -i` with a system PATH, its own
# temporary HOME and nothing else from the caller's environment, so no
# setting of the caller's (tokens included) can reach a test or a stub.
#
# Usage: install/test/run.sh [name ...]   (e.g. run.sh menu boot)
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$HERE/../.." && pwd -P)"
SYSPATH="/usr/bin:/bin:/usr/sbin:/sbin"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/gp-run.XXXXXX")"
trap 'rm -rf "$BASE"' EXIT

if [ $# -gt 0 ]; then
    FILES=""
    for n in "$@"; do FILES="$FILES $HERE/$n.test.sh"; done
else
    FILES="$(echo "$HERE"/*.test.sh)"
fi

total_fail=0
summary=""
for t in $FILES; do
    name="$(basename "$t" .test.sh)"
    mkdir -p "$BASE/$name/home" "$BASE/$name/tmp"
    echo "== $name"
    env -i PATH="$SYSPATH" HOME="$BASE/$name/home" TMPDIR="$BASE/$name/tmp" LANG=C LC_ALL=C \
        bash "$t" >"$BASE/$name.log" 2>&1
    rc=$?
    cat "$BASE/$name.log"
    line="$(tail -n 1 "$BASE/$name.log")"
    case "$line" in
        *" passed, "*" failed") ;;
        *) line="did not finish (exit $rc)" ;;
    esac
    summary="$summary
  $name: $line"
    [ "$rc" -eq 0 ] || total_fail=$((total_fail + 1))
    echo
done

echo "== shellcheck"
if command -v shellcheck >/dev/null 2>&1; then
    # The entry points, with -x following what each one sources; then the
    # sourced files on their own, where a variable set in one file and used
    # in another (SC2034, SC2153) is expected.
    if (cd "$ROOT" && shellcheck -x -P SCRIPTDIR install/boot.sh install/install install/install-claude-code.sh \
            install/layout/move install/layout/worktree-hook install/service/start \
            hooks/time-stamp hooks/auto-pull hooks/chrome-guard hooks/sync-mains hooks/automode-drift hooks/session-id hooks/turn-state hooks/load-proof \
            adapters/buzz/hooks/reply-guard adapters/buzz/hooks/unattended-deny tools/ruleset/ruleset \
            tools/automode/watch install/automode-guard/guard install/automode-guard/setup install/keyservice/setup \
            install/memory-backup/backup install/memory-backup/setup hooks/memory-backup \
            statusline/statusline.sh statusline/wire \
            install/test/*.test.sh install/test/run.sh install/test/live/*.sh install/test/fixtures/stubs/* install/test/fixtures/*.sh \
        && shellcheck -s bash -e SC2034,SC2153 install/lib/*.sh install/test/lib.sh); then
        echo "shellcheck: clean"
        summary="$summary
  shellcheck: clean"
    else
        summary="$summary
  shellcheck: FAILED"
        total_fail=$((total_fail + 1))
    fi
else
    echo "shellcheck: not installed here, skipped"
    summary="$summary
  shellcheck: skipped (not installed)"
fi

echo
echo "== results$summary"
[ "$total_fail" -eq 0 ]
