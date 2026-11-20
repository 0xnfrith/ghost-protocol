#!/usr/bin/env bash
# install-claude-code.test.sh: the pinned Claude Code download. A stub curl
# serves a fake binary from the official address; a test pins file (honoured
# only with GP_TEST=1) carries that fake binary's sha256.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

V="$(pin_value CLAUDE_CODE_VERSION)"
case "$(uname -s)-$(uname -m)" in
    Darwin-*) PLAT=darwin-arm64 ;;
    Linux-x86_64) PLAT=linux-x64 ;;
    *) PLAT=linux-arm64 ;;
esac

fresh() {
    t_new
    t_stub curl
    # The fake build prints the version it is given.
    printf '#!/bin/sh\necho "%s (Claude Code)"\n' "${1:-$V}" >"$T/state/curl.body"
    echo "https://downloads.claude.ai/claude-code-releases/$V/$PLAT/claude" >"$T/state/curl.expect-url"
    pins_with_claude_sum "$(sha_of "$T/state/curl.body")"
}
pins_with_claude_sum() {
    T_PINS="$T/pins.env"
    sed -E "s/^(CLAUDE_CODE_SHA256_[A-Z0-9_]+)=\"[0-9a-f]*\"/\\1=\"$1\"/" "$SRC/install/pins.env" >"$T_PINS"
}
existing() {   # version: a claude already in ~/.local/bin
    mkdir -p "$T/home/.local/bin"
    printf '#!/bin/sh\necho "%s (Claude Code)"\n' "$1" >"$T/home/.local/bin/claude"
    chmod +x "$T/home/.local/bin/claude"
}
icc() { t_env "$SRC/install/install-claude-code.sh" "$@" >"$OUT" 2>&1; RC=$?; }
bin_version() { "$T/home/.local/bin/claude" --version 2>/dev/null | awk '{ print $1 }'; }

# 1. Nothing installed (vm): downloaded from the official address, checked, installed.
fresh
icc --profile vm
check "fresh install: exit 0" rc_is 0
check "fresh install: one download" [ "$(grep -c '^curl ' "$T/state/calls")" -eq 1 ]
check "fresh install: ~/.local/bin/claude is a link to versions/$V" \
    [ "$(readlink "$T/home/.local/bin/claude")" = "$T/home/.local/share/claude/versions/$V" ]
check "fresh install: it reports the pinned version" [ "$(bin_version)" = "$V" ]
check "fresh install: no temp folder is left" no_temp_left

# 2. A sha256 mismatch: refused, nothing installed.
fresh
pins_with_claude_sum "$(printf '%064d' 0)"
icc --profile vm
check "wrong sha256: exit 1" rc_is 1
check "wrong sha256: refused" out_has 'does not match the pinned sha256'
check "wrong sha256: no claude installed" [ ! -e "$T/home/.local/bin/claude" ]
check "wrong sha256: no build kept" [ ! -e "$T/home/.local/share/claude/versions/$V" ]
check "wrong sha256: no temp folder is left" no_temp_left

# 3. Already at the pin: left alone, nothing downloaded.
fresh
existing "$V"
icc --profile vm
check "at the pin: exit 0" rc_is 0
check "at the pin: nothing downloaded" not_called curl
check "at the pin: left alone" out_has 'left alone'

# 4. The laptop profile never replaces an existing Claude Code; it warns.
fresh
existing "0.0.1"
before="$(sha_of "$T/home/.local/bin/claude")"
icc --profile laptop
check "laptop, other version: exit 0" rc_is 0
check "laptop, other version: nothing downloaded" not_called curl
check "laptop, other version: the file is unchanged" [ "$(sha_of "$T/home/.local/bin/claude")" = "$before" ]
check "laptop, other version: it warns" out_has 'WARNING: Claude Code 0\.0\.1 .* differs from the pin'

# 5. The laptop profile installs when none is present.
fresh
icc --profile laptop
check "laptop, none present: installed" [ "$(bin_version)" = "$V" ]

# 6. The vm profile replaces another version with the pin.
fresh
existing "0.0.1"
icc --profile vm
check "vm, other version: exit 0" rc_is 0
check "vm, other version: now at the pin" [ "$(bin_version)" = "$V" ]

# 7. A build whose sha256 matches but reports another version is refused.
fresh "9.9.9"
icc --profile vm
check "wrong version inside: exit 1" rc_is 1
check "wrong version inside: it says so" out_has "reports version '9\\.9\\.9', not $V"

# 8. The version must match exactly, not just start the same.
fresh
existing "${V}0"
icc --profile laptop
check "a longer version is not the pin" out_has "WARNING: Claude Code ${V}0"

# 9. A dry run downloads nothing and changes nothing.
fresh
t_snapshot >"$T/before"
icc --profile vm --dry-run
t_snapshot >"$T/after"
check "dry run: exit 0" rc_is 0
check "dry run: nothing downloaded" not_called curl
check "dry run: HOME is unchanged" cmp -s "$T/before" "$T/after"
check "dry run: it prints the official address" out_has "would download https://downloads\\.claude\\.ai/claude-code-releases/$V/$PLAT/claude"

# 10. The test pins file is ignored without GP_TEST=1, so it cannot redirect a real run.
fresh
existing "$V"
OUT="$T/out.txt"
env -i HOME="$T/home" PATH="$T/stubs:$T/sysbin" GP_PINS_FILE="$T/does-not-exist" STUB_STATE="$T/state" \
    "$SRC/install/install-claude-code.sh" --profile vm >"$OUT" 2>&1
RC=$?
check "GP_PINS_FILE without GP_TEST=1 is ignored" rc_is 0

# 10b. A test pins file says so loudly, and its values must still be well formed.
fresh
icc --profile vm --dry-run
check "a GP_TEST pins file prints a TEST MODE line" out_has 'TEST MODE \(GP_TEST=1\): pins come from'
fresh
sed -i.bak 's#^CLAUDE_CODE_VERSION=.*#CLAUDE_CODE_VERSION="x/../.."#' "$T_PINS"
icc --profile vm
check "a version that is not dotted digits: exit 1" rc_is 1
check "a version that is not dotted digits: refused" out_has 'not dotted digits'
check "a version that is not dotted digits: nothing downloaded" not_called curl
fresh
sed -i.bak 's#^\(CLAUDE_CODE_SHA256_LINUX_X64\)=.*#\1="abc"#' "$T_PINS"
icc --profile vm
check "a sha256 that is not 64 hex: exit 1" rc_is 1

# 11. A WORK or GP_WORK folder in the environment is never used or deleted.
fresh
mkdir -p "$T/keep"; echo keep >"$T/keep/marker"
t_env WORK="$T/keep" GP_WORK="$T/keep" "$SRC/install/install-claude-code.sh" --profile vm >"$OUT" 2>&1
RC=$?
check "WORK in the environment: the download still works" [ "$(bin_version)" = "$V" ]
check "WORK in the environment: that folder survives" [ -f "$T/keep/marker" ]

finish_tests
