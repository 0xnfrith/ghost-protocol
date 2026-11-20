#!/usr/bin/env bash
# clean-tree.test.sh: this repo is meant to be public, so no file in it may
# carry an operator's internal names, links, keys or addresses.
#   - a denylist of words (built from pieces below, so this file holds none);
#   - no 64-hex string (a stray key) outside the pins (install/pins.env,
#     .github/workflows/) and the fixtures;
#   - no email address except example domains and git@github.com.
# Only the files that tools/publish/allowlist names are scanned (the folders that stay internal may hold what the public tree must not).
# Tests use the instance example/instance.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SELF="install/test/clean-tree.test.sh"

# Every tracked or new (not ignored) file, relative to the repo root.
if git -C "$SRC" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    FILES="$(cd "$SRC" && git ls-files --cached --others --exclude-standard)"
else
    FILES="$(cd "$SRC" && find . -type f ! -path './.git/*' ! -path '*/node_modules/*' | sed 's#^\./##')"
fi
check "the tree lists some files" [ -n "$FILES" ]

# Only the paths that are, or can become, public are scanned (tools/publish/allowlist): the folders that stay internal (the evals,
# the plans under docs/, the publish scan's own word list) may name what the public tree must not. Without an allowlist (a tree
# that has no tools/publish) every file is scanned.
EXPORT="$SRC/tools/publish/export"
ALLOW="$SRC/tools/publish/allowlist"
if [ -f "$ALLOW" ] && [ -x "$EXPORT" ]; then
    SCOPED="$("$EXPORT" --filter "$ALLOW" <<<"$FILES")"
    check "the allowlist is read and keeps some files" [ -n "$SCOPED" ]
    FILES="$SCOPED"
    # The scoping itself, on a made-up allowlist and file list: what it leaves out, or never exports, is not scanned.
    SCOPE_T="$(mktemp -d)"
    printf '%s\n' 'src/' 'docs/' 'notes.txt' '!src/private.txt' >"$SCOPE_T/allowlist"
    kept="$("$EXPORT" --filter "$SCOPE_T/allowlist" <<<"src/a.txt
src/private.txt
docs/plans/x.md
docs/layout.md
evals/case.txt
notes.txt
other.txt
tools/publish/internal/words.txt")"
    check "scope: a listed file and a listed folder are scanned" [ "$(printf '%s\n' "$kept" | grep -cE '^(src/a\.txt|docs/layout\.md|notes\.txt)$')" = 3 ]
    check "scope: nothing else is" [ "$(printf '%s\n' "$kept" | grep -c .)" = 3 ]
    rm -rf "$SCOPE_T"
fi

scan() {   # grep-flags pattern [skip-regex]: prints file:line for each hit
    local flags="$1" pat="$2" skip="${3:-}" f
    while IFS= read -r f; do
        if [ -z "$f" ] || [ ! -f "$SRC/$f" ]; then continue; fi
        if [ -n "$skip" ] && printf '%s' "$f" | grep -qE "$skip"; then continue; fi
        # shellcheck disable=SC2086
        grep -I -n $flags -- "$pat" "$SRC/$f" 2>/dev/null | sed "s#^#$f:#"
    done <<EOF
$FILES
EOF
}

# The denylist, in pieces.
w1="sect""ion-9"
w2="s9""t"
w3="mega""tech"
w4="bu""zz:""//"
w5="(^|[^a-z0-9])s""9-"
w6="GHO""ST-"
# The output names each word by number only, so the log carries none of them.
i=0
for w in "$w1" "$w2" "$w3" "$w4" "$w5" "$w6"; do
    i=$((i + 1))
    flags=-iE
    [ "$i" -eq 6 ] && flags=-E
    hits="$(scan "$flags" "$w")"
    if [ -z "$hits" ]; then ok "no denylist word $i anywhere in the tree"
    else bad "denylist word $i found:"; printf '%s\n' "$hits" | cut -d: -f1,2 | sed 's/^/      /'; fi
done

# 64-hex strings: pins are 64 hex by design (the installer's in pins.env, CI's
# own tools in .github/workflows/), and fixtures
# may hold test values.
hits="$(scan -E '[0-9a-fA-F]{64}' "^install/pins\\.env\$|^\\.github/workflows/|^install/test/fixtures/|^$SELF\$")"
if [ -z "$hits" ]; then ok "no 64-hex string outside the pins (pins.env, .github/workflows/) and the fixtures"
else bad "64-hex strings found (file:line):"; printf '%s\n' "$hits" | cut -d: -f1,2 | sed 's/^/      /'; fi

# Email addresses: only example domains, and git@github.com (an ssh address).
emails="$(scan -oE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' \
    | grep -viE ':[^:@]+@example\.(com|org|net)$|:git@github\.com$' || true)"
if [ -z "$emails" ]; then ok "no email address outside example domains"
else bad "email addresses found (file:line):"; printf '%s\n' "$emails" | cut -d: -f1,2 | sed 's/^/      /'; fi

finish_tests
