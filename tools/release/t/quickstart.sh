#!/usr/bin/env bash
# The quick start (docs/quick-start.md) against the tree: the parts the plan names are there, every gp command and installer option
# it shows exists, and it passes the scan's public words. No network, no secret.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
DOC=$ROOT/docs/quick-start.md
pass=0
fail=0
check() {
  local n=$1
  shift
  if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "ok    $n"; else fail=$((fail + 1)); echo "FAIL  $n"; fi
}
[ -f "$DOC" ] || { echo "FAIL  docs/quick-start.md is missing"; exit 1; }

for h in "What you need" "Install, the Buzz way" "Install, the terminal way" "The relay setting and the member fallback" "Docker Desktop on a laptop" "Update" "The way back" "Stop, restart, remove"; do
  check "has the section: $h" grep -qx "## $h" "$DOC"
done
check "says Hosted is coming soon" grep -q "coming soon" "$DOC"
check "names both fallbacks: the option and the member" bash -c "grep -q 'owner-attestation option' '$DOC' && grep -q 'Add the agent as a member' '$DOC'"
check "has no work-in-progress label" bash -c "! grep -qi 'work in progress' '$DOC'"

# Every `gp <command>` it shows is one that gp has.
cmds=$(sed -n '/^const COMMANDS = {/,/^};/p' "$ROOT/docker/gp/gp.mjs" | sed -n 's/^  "\{0,1\}\([a-z-]*\)"\{0,1\}: .*/\1/p')
for c in $(grep -oE '(docker exec( -i)? gp-[a-z-]+ gp|docker run --rm [^ ]+ gp) [a-z-]+' "$DOC" | awk '{print $NF}' | sort -u); do
  check "gp has the command '$c'" grep -qx "$c" <<<"$cmds"
done
for w in request rollback; do check "gp update $w exists" grep -q "$w" "$ROOT/docker/gp/update.mjs"; done
for w in login token status; do check "gp claude $w exists" grep -q "$w" "$ROOT/docker/gp/claude.mjs"; done
check "gp auth-tag set exists" grep -q "set" "$ROOT/docker/gp/authtag.mjs"

# The installer options it shows are the installers'.
for o in --name --relay --owner --updater; do
  check "$o is in the doc and get.sh" bash -c "grep -q -e '$o' '$DOC' && grep -q -e '$o)' '$ROOT/docker/get.sh'"
done
for o in Name Relay Owner Updater; do
  check "-$o is in the doc and get.ps1" bash -c "grep -q -e '-$o' '$DOC' && grep -q -e '\$$o' '$ROOT/docker/get.ps1'"
done
# The lines it shows are the ones the tools print.
check "GP_AGENT_PUBKEY is what get.sh prints" grep -q 'GP_AGENT_PUBKEY' "$ROOT/docker/get.sh"
for k in STATE RELAY CLAUDE VERSION UPDATE_AVAILABLE; do check "gp status prints GP_$k" grep -q "out.kv(\"$k\"" "$ROOT/docker/gp/status.mjs"; done
for s in needs-auth-tag needs-claude connecting running error refused-not-member unreachable; do check "state or relay '$s' exists" grep -q "$s" "$ROOT/docker/gp/status.mjs"; done

# The public README (P6): no work-in-progress label, the quick start as the install, the licence, Hosted coming soon, one Claude Code version.
README=$ROOT/README.md
check "README: no work-in-progress label" bash -c "! grep -qi 'work in progress' '$README'"
check "README: links the quick start" grep -q '](docs/quick-start.md)' "$README"
check "README: shows the install line" grep -q 'releases/latest/download/get.sh' "$README"
check "README: says Hosted is coming soon" grep -qi 'hosted version is coming soon' "$README"
check "README: names the licence" grep -q 'Elastic License 2.0' "$README"
pinned=$(sed -n 's/^CLAUDE_CODE_VERSION="\(.*\)"$/\1/p' "$ROOT/install/pins.env")
check "README: the Claude Code version is the pinned one ($pinned)" bash -c "grep -q 'Claude Code $pinned' '$README'"
check "README: no other 2.1.x version in its install text" bash -c "! grep -oE 'Claude Code 2\.1\.[0-9]+ or later' '$README'"

# The public words: scan the file in a temporary repository.
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
if command -v python3 >/dev/null && [ -x "$ROOT/tools/publish/scan" ]; then
  git init -q -b main "$T/r"
  mkdir -p "$T/r/docs"
  cp "$DOC" "$T/r/docs/"
  git -C "$T/r" add -A
  git -C "$T/r" -c user.name=t -c user.email=t@example.com commit -q -m t
  check "passes the scan's public words" bash -c "cd '$T/r' && '$ROOT/tools/publish/scan' --public-only tree HEAD"
fi

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
