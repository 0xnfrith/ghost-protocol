# shellcheck shell=bash disable=SC2034
# Helpers for the tests of tools/publish. Sourced, not run.
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
# PUBLISH_TREE: a copy of tools/publish to test instead (the revert proofs in commit-fields.sh use it).
PUB=${PUBLISH_TREE:-$ROOT/tools/publish}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0
fail=0
check() { # name command...: the command passes
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "ok    $name"; else fail=$((fail + 1)); echo "FAIL  $name"; fi
}
check_not() { # name command...: the command fails
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then fail=$((fail + 1)); echo "FAIL  $name"; else pass=$((pass + 1)); echo "ok    $name"; fi
}
eq() { [ "$1" = "$2" ]; } # eq <got> <want>; on a difference, shows both
check_eq() { # name got want
  if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok    $1"; else
    fail=$((fail + 1)); echo "FAIL  $1"; printf '      got:  %s\n      want: %s\n' "${2//$'\n'/ | }" "${3//$'\n'/ | }"
  fi
}
done_tests() { echo "$pass passed, $fail failed"; [ "$fail" -eq 0 ]; }

# A throwaway internal repository in $1, with a few commits' worth of files in the shapes the export cares about.
export GIT_AUTHOR_NAME="Internal Dev" GIT_AUTHOR_EMAIL="dev@example.com" GIT_COMMITTER_NAME="Internal Dev" GIT_COMMITTER_EMAIL="dev@example.com"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null
BOT_EMAIL="gp-publisher@users.""noreply.github.com"
mk_repo() {
  git init -q -b main "$1"
  mkdir -p "$1/src" "$1/tools/publish/internal" "$1/evals" "$1/docs/plans"
  printf 'readme\n' >"$1/README.md"
  printf 'licence\n' >"$1/LICENSE"
  printf 'a\n' >"$1/src/a.txt"
  printf '#!/bin/sh\necho hi\n' >"$1/src/run"
  chmod +x "$1/src/run"
  printf 'notes\n' >"$1/notes.txt"
  printf 'private\n' >"$1/tools/private-note.txt"
  printf 'words\n' >"$1/tools/publish/internal/words.txt"
  printf 'eval\n' >"$1/evals/case.txt"
  printf 'plan\n' >"$1/docs/plans/plan.md"
  cat >"$1/tools/publish/allowlist" <<'LIST'
# a test allowlist
README.md
LICENSE
src/
tools/
!tools/private-note.txt
LIST
}
commit() { # repo message: commits everything
  git -C "$1" add -A && git -C "$1" commit -q -m "$2"
}
# uni TEXT: TEXT with \n, \xHH (one raw byte), \uXXXX and \UXXXXXXXX (a character, in UTF-8) made into bytes, whatever the locale.
uni() {
  python3 -I -c 'import re, sys
out = sys.stdout.buffer
for tok in re.split(r"(\\n|\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8})", sys.argv[1]):
    if tok == "\\n": out.write(b"\n")
    elif tok[:2] == "\\x": out.write(bytes([int(tok[2:], 16)]))
    elif tok[:2] in ("\\u", "\\U"): out.write(chr(int(tok[2:], 16)).encode())
    else: out.write(tok.encode())' "$1"
}
