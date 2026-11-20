#!/usr/bin/env bash
# pins.test.sh: everything the installer downloads is pinned and checked.
#   - no curl-to-shell (`curl ... | sh`, `| bash`, `$(curl ...)`) anywhere
#     under install/ or .github/;
#   - every curl in the installer is followed by a sha256 check;
#   - pins.env holds only KEY="value" lines, every *_SHA256_* pin is 64 hex
#     characters, and each supported platform has one;
#   - no Homebrew, no write to ~/.gitconfig, and sudo only where allowed:
#     boot.sh's apt helper, the installer's root helpers (one marked block in
#     common.sh), preflight's check that sudo exists, the text of the
#     memory guard's hand commands, and the key service's checks of whether
#     the agent user can become root (one marked block in keyservice.sh, in
#     fixed forms only).
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

P="$SRC/install/pins.env"
# The installer's own code, without the tests.
CODE="$SRC/install/boot.sh $SRC/install/install $SRC/install/install-claude-code.sh $SRC/install/keyservice/setup $(echo "$SRC"/install/lib/*.sh)"

# 1. No curl-to-shell, comments excepted.
hits="$(grep -rnE 'curl[^|#]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z)?sh\b|\$\(curl' \
    "$SRC/install" "$SRC/.github" 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)"
if [ -z "$hits" ]; then ok "no curl-to-shell under install/ or .github/"
else bad "curl-to-shell found:"; printf '%s\n' "$hits" | sed 's/^/      /'; fi

# 2. Every curl call in the installer is followed, within 8 lines, by a sha256
#    check; and there is no wget.
# shellcheck disable=SC2086
unchecked="$(awk '
    FNR == 1 { pending = 0 }
    /^[[:space:]]*#/ { next }
    pending > 0 && /sha256_of/ { pending = 0 }
    pending > 0 { pending--; if (pending == 0) print where }
    /(^|[^a-z_-])curl[[:space:]]+-/ { pending = 8; where = FILENAME ":" FNR }
    END { if (pending > 0) print where }
' $CODE)"
if [ -z "$unchecked" ]; then ok "every curl download is followed by a sha256 check"
else bad "curl without a sha256 check: $unchecked"; fi
# shellcheck disable=SC2086
n_curl="$(cat $CODE | grep -vE '^[[:space:]]*#' | grep -cE '(^|[^a-z_-])curl[[:space:]]+-')"
check "there is exactly one download command (download_verified)" [ "$n_curl" -eq 1 ]
check "no wget" sh -c "! cat $CODE | grep -vE '^[[:space:]]*#' | grep -qw wget"

# 3. pins.env: only comments, blank lines and KEY="value".
other="$(grep -nvE '^[[:space:]]*(#.*)?$|^[A-Z0-9_]+="[^"]*"$' "$P" || true)"
if [ -z "$other" ]; then ok "pins.env holds only KEY=\"value\" lines"
else bad "pins.env has other lines:"; printf '%s\n' "$other" | sed 's/^/      /'; fi

# 4. Every sha256 pin is 64 lower-case hex characters.
nsum=0
badsum=""
while IFS= read -r line; do
    nsum=$((nsum + 1))
    v="${line#*=\"}"; v="${v%\"}"
    printf '%s' "$v" | grep -qE '^[0-9a-f]{64}$' || badsum="$badsum ${line%%=*}"
done <<EOF
$(grep -E '^[A-Z0-9_]*SHA256[A-Z0-9_]*=' "$P")
EOF
if [ -z "$badsum" ] && [ "$nsum" -ge 6 ]; then ok "all $nsum sha256 pins are 64 hex characters"
else bad "bad sha256 pins:${badsum:- (only $nsum found)}"; fi

# 5. A pin for every platform the installer supports.
for k in GH_SHA256_MACOS_ARM64 GH_SHA256_LINUX_AMD64 GH_SHA256_LINUX_ARM64 \
         CLAUDE_CODE_SHA256_DARWIN_ARM64 CLAUDE_CODE_SHA256_LINUX_X64 CLAUDE_CODE_SHA256_LINUX_ARM64; do
    check "pins.env has $k" [ -n "$(pin_value "$k")" ]
done
for k in GH_VERSION CLAUDE_CODE_VERSION; do
    check "$k is a plain x.y.z version" sh -c "printf '%s' '$(pin_value "$k")' | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'"
done

# 5b. github.com's SSH host keys (deploykey mode), install/github-known-hosts:
#     exactly three key lines, one per type, each the key whose fingerprint
#     the file's comment gives as GitHub publishes it.
KH="$SRC/install/github-known-hosts"
check "github-known-hosts: three key lines, nothing else ssh reads" [ "$(grep -cvE '^[[:space:]]*(#.*)?$' "$KH")" -eq 3 ]
check "github-known-hosts: ed25519, ecdsa and rsa, for github.com" \
    [ "$(grep -E '^github\.com ' "$KH" | cut -d' ' -f2 | tr '\n' ' ')" = "ssh-ed25519 ecdsa-sha2-nistp256 ssh-rsa " ]
if command -v ssh-keygen >/dev/null 2>&1; then
    fp_ok=1
    while IFS= read -r line; do
        fp="$(printf '%s\n' "$line" | ssh-keygen -lf - -E sha256 2>/dev/null | cut -d' ' -f2)"
        grep -qF "#   fingerprint $fp " "$KH" || fp_ok=0
    done <<EOF
$(grep -E '^github\.com ' "$KH")
EOF
    check "github-known-hosts: each key has the fingerprint GitHub publishes" [ "$fp_ok" -eq 1 ]
else
    echo "SKIP  github-known-hosts fingerprints (no ssh-keygen here)"
fi

# 6. Claude Code comes from Anthropic's own download address.
check "Claude Code downloads from downloads.claude.ai" \
    grep -q '^DOWNLOAD_BASE="https://downloads.claude.ai/claude-code-releases"$' "$SRC/install/install-claude-code.sh"
check "gh downloads from the cli/cli GitHub releases" \
    grep -q 'https://github.com/cli/cli/releases/download/v' "$SRC/install/lib/github.sh"

# 7. No Homebrew; no write to the global git config.
# shellcheck disable=SC2086
check "no Homebrew" sh -c "! cat $CODE | grep -vE '^[[:space:]]*#' | grep -qiE '(^|[^a-z])brew[[:space:]]'"
# shellcheck disable=SC2086
check "no git config --global" sh -c "! cat $CODE | grep -qE 'config[[:space:]]+--global'"

# 8. sudo only where allowed:
#    - boot.sh's apt helper;
#    - the installer's root helpers: the one marked block in common.sh
#      (root_prepare and as_root);
#    - preflight's check that sudo exists;
#    - text for a person to type: printf lines in service.sh's marked "hand
#      commands" block, which runs nothing as root;
#    - the key service's root-equivalence checks: keyservice.sh's marked
#      block, where sudo appears only as a group name, in a message, as
#      sudo -l run as root through ks_root (in the C locale), and as sudo -n
#      run as the agent user through runuser (a probe of whether it is root
#      without a password).
#    Every other root step in the installer goes through as_root.
block_of() {   # file marker: "<first line> <last line>" of its >>> / <<< block
    awk -v m="$2" '
        index($0, "# >>> " m) { s = NR }
        index($0, "# <<< " m) { e = NR }
        END { print s + 0, e + 0 }' "$1"
}
# shellcheck disable=SC2046  # two numbers
set -- $(block_of "$SRC/install/lib/common.sh" "root helpers") $(block_of "$SRC/install/lib/service.sh" "hand commands")
RS="$1" RE="$2" HS="$3" HE="$4"
# shellcheck disable=SC2046  # two numbers
set -- $(block_of "$SRC/install/lib/keyservice.sh" "root-equivalence checks")
KS="$1" KE="$2"
check "keyservice.sh has one marked root-equivalence block" test "$KS" -gt 0 -a "$KE" -gt "$KS"
check "common.sh has one marked root-helpers block" test "$RS" -gt 0 -a "$RE" -gt "$RS"
check "service.sh has one marked hand-commands block" test "$HS" -gt 0 -a "$HE" -gt "$HS"
# shellcheck disable=SC2086
sudo_lines="$(grep -nw sudo $CODE | grep -vE ':[0-9]+:[[:space:]]*#' \
    | grep -vE '^[^:]*/install/boot\.sh:' \
    | grep -vE '^[^:]*/install/lib/preflight\.sh:.*command -v sudo' \
    | grep -vE '^[^:]*/install/lib/preflight\.sh:.*sudo_note=|sudo is missing' \
    | awk -F: -v rs="$RS" -v re="$RE" -v hs="$HS" -v he="$HE" -v ks="$KS" -v ke="$KE" '
        $1 ~ /\/install\/lib\/common\.sh$/ && $2 >= rs && $2 <= re { next }
        $1 ~ /\/install\/lib\/keyservice\.sh$/ && $2 >= ks && $2 <= ke { next }
        $1 ~ /\/install\/lib\/service\.sh$/ && $2 >= hs && $2 <= he && $3 ~ /^[[:space:]]*printf / { next }
        { print }' \
    | sed 's/--agent-sudo//g' | grep -w sudo || true)"
# (The key service's option --agent-sudo is its name, not a use: dropped before the last check.)
if [ -z "$sudo_lines" ]; then ok "sudo appears only in boot.sh, the root helpers, preflight's check and the hand commands' text"
else bad "sudo used elsewhere:"; printf '%s\n' "$sudo_lines" | sed 's/^/      /'; fi
# The hand-commands block prints text: no line in it runs as_root or sudo.
hand_runs="$(sed -n "${HS},${HE}p" "$SRC/install/lib/service.sh" | grep -vE '^[[:space:]]*(#|printf )' \
    | grep -E '(^|[;&|({][[:space:]]*|^[[:space:]]+)(as_root|sudo)([[:space:]]|$)' || true)"
check "the hand-commands block runs nothing as root" [ -z "$hand_runs" ]
# The root-equivalence block: sudo only in its fixed forms.
# shellcheck disable=SC2016  # the forms are matched as written, $ and all
ks_other="$(sed -n "${KS},${KE}p" "$SRC/install/lib/keyservice.sh" | grep -nw sudo | grep -vE '^[0-9]+:[[:space:]]*#' \
    | grep -vE '^[0-9]+:KS_(REFUSED|SUDO)_GROUPS="|^[0-9]+:[[:space:]]+case "\$g" in sudo\||^[0-9]+:[[:space:]]+(\*" \$g "\*\) )?ks_(rooteq|problem) "|^[0-9]+:[[:space:]]+KS_SUDO_WARN="' \
    | grep -vxE '[0-9]+:[[:space:]]+list="\$\(ks_root env LC_ALL=C sudo -l -U "\$KS_AGENT" 2>/dev/null\)"; rc=\$\?' \
    | grep -vxE '[0-9]+:[[:space:]]+if ks_root runuser -u "\$KS_AGENT" -- sudo -n true >/dev/null 2>&1; then' || true)"
check "the root-equivalence block uses sudo only as sudo -l through ks_root and sudo -n as the agent user" [ -z "$ks_other" ]

finish_tests
