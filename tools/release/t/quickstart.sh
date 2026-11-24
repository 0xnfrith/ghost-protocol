#!/usr/bin/env bash
# The quick start (docs/quick-start.md), README.md and AGENTS.md against the tree: the parts the plan names are there, every gp command
# and installer option it shows exists, the way a stranger takes is told the same in each, and they pass the scan's public words.
# No network, no secret.
# The checks hand small scripts to bash -c in single quotes, with their values as arguments: that is on purpose.
# shellcheck disable=SC2016
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

# The Buzz way is enough for someone who has only the Buzz app: where the plugin is, the form as the plugin draws it, the agent's
# names in Docker, and what Delete removes.
BUZZ=$(sed -n '/^## Install, the Buzz way$/,/^## Install, the terminal way$/p' "$DOC")
check "the Buzz way says it needs the desktop app" grep -q 'Buzz \*\*desktop\*\* app' <<<"$BUZZ"
check "the Buzz way gives the plugin's repository" grep -qF 'https://github.com/0xnfrith/buzz-plugins' <<<"$BUZZ"
check "the Buzz way gives the install's buttons" bash -c "grep -q 'Manage plugins' <<<\"\$1\" && grep -q 'Install plugin' <<<\"\$1\"" _ "$BUZZ"
check "the Buzz way names the Harness" grep -q 'as the \*\*Harness\*\*' <<<"$BUZZ"
# at <text>: the number of the Buzz section's first line holding <text> (empty when none does).
at() { grep -nF -e "$1" <<<"$BUZZ" | head -n 1 | cut -d: -f1; }
claude_q=$(at '**Your Claude account**')
update_q=$(at '**Let GHOST Protocol update itself?**')
press=$(at 'Press **Create agent**')
check "the Buzz way names the button Create agent, never a bare Create" bash -c "[ -n \"\$1\" ] && ! grep -qF '**Create**' <<<\"\$2\"" _ "$press" "$BUZZ"
check "the Buzz way asks the Claude and update questions before Create agent is pressed" \
  bash -c "[ -n \"\$1\" ] && [ -n \"\$2\" ] && [ -n \"\$3\" ] && [ \"\$1\" -lt \"\$3\" ] && [ \"\$2\" -lt \"\$3\" ]" _ "$claude_q" "$update_q" "$press"
check "the Buzz way says Create agent waits for both questions" grep -qF '**Create agent** is held back until both are answered' <<<"$BUZZ"
check "the Buzz way names the container and the volume" bash -c "grep -qF '\`gp-<name>\`' <<<\"\$1\" && grep -qF '\`gp-<name>-data\`' <<<\"\$1\"" _ "$BUZZ"
check "the Buzz way says, on Delete agent's own line, that it removes the memory" grep -qE '^\*\*Delete agent\*\* .*data volume.*memory' <<<"$BUZZ"
check "the Buzz way says Delete leaves the container and volume when Buzz lost the name" \
  bash -c "grep -E '^\*\*Delete agent\*\* ' <<<\"\$1\" | grep -qF 'Delete leaves the container and the volume in Docker'" _ "$BUZZ"

# What a stranger needs, said in the quick start itself: a paid Claude plan, where a relay comes from and the relay admin's step, when
# Claude is connected, and the links to the plugin's README and to AGENTS.md.
NEED=$(sed -n '/^## What you need$/,/^## Install, the Buzz way$/p' "$DOC")
RELAY=$(sed -n '/^## The relay setting and the member fallback$/,/^## Docker Desktop on a laptop$/p' "$DOC")
check "What you need: a paid Claude plan, not the free plan" \
  bash -c 'grep -qF "**A paid Claude plan**: Pro, Max, Ultra, Team or Enterprise. The free plan does not include Claude Code" <<<"$1"' _ "$NEED"
check "What you need: where a relay comes from" \
  bash -c 'grep -qF "**Or create a community** in Buzz (it needs an account)" <<<"$1" && grep -qF "(https://github.com/block/buzz#i-want-my-own-hosted-relay)" <<<"$1"' _ "$NEED"
check "What you need: the relay's admin turns owner attestations on (off by default) or adds the agent as a member" \
  bash -c 'grep -qF "its admin turns owner attestations on, which is off by default, or adds the agent as a member" <<<"$1"' _ "$NEED"
check "the relay setting names the relay's option" grep -qF '`BUZZ_ALLOW_NIP_OA_AUTH=true`' <<<"$RELAY"
check "the Buzz way says when Claude is connected, for each way" \
  bash -c 'grep -qF "**When Claude is connected:** with a setup token pasted in the form, **Create agent** signs the agent in to Claude itself, after it hands the agent your attestation" <<<"$1" && grep -qF "With the address, **Create agent** leaves the agent waiting for Claude" <<<"$1"' _ "$BUZZ"
check "the Buzz way links the plugin's README" grep -qF '](https://github.com/0xnfrith/buzz-plugins/tree/main/plugins/ghost-protocol)' <<<"$BUZZ"
check "the Buzz way links AGENTS.md" grep -qF '](../AGENTS.md)' <<<"$BUZZ"

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

# The way a stranger takes, in README.md and AGENTS.md: the plugin's README linked, a paid Claude plan, the relay's admin step, and
# when Claude is connected. The quick start links back from its Buzz way; the plugin's README links here from its own side.
PLUGIN_README='https://github.com/0xnfrith/buzz-plugins/tree/main/plugins/ghost-protocol'
PLUGINS_README='https://github.com/0xnfrith/buzz-plugins#readme'
QS=$(sed -n '/^## Quick start$/,/^## Design$/p' "$README")
AGENTS=$ROOT/AGENTS.md
# both <text> <text> <file or ->: both texts are in it (fixed strings).
both() { grep -qF -e "$1" "$3" && grep -qF -e "$2" "$3"; }
check "README: the quick start links the plugin's README" grep -qF "]($PLUGIN_README)" <<<"$QS"
check "README: the quick start says a paid Claude plan, and not the free plan" bash -c 'grep -qF "**A paid Claude plan** (Pro, Max, Ultra, Team or Enterprise)" <<<"$1" && grep -qF "The free plan does not include Claude Code" <<<"$1"' _ "$QS"
check "README: the quick start says where a relay comes from" bash -c 'grep -qF "**Or create a community** in Buzz (it needs an account)" <<<"$1" && grep -qF "(https://github.com/block/buzz#i-want-my-own-hosted-relay)" <<<"$1"' _ "$QS"
check "README: the relay's admin turns owner attestations on (off by default) or adds the agent as a member" \
  bash -c 'grep -qF "BUZZ_ALLOW_NIP_OA_AUTH=true" <<<"$1" && grep -qF "that is off by default" <<<"$1" && grep -qF "the admin adds the agent as a member" <<<"$1"' _ "$QS"
check "README: a pasted token is signed in by Create agent, an address afterwards on the tab" \
  bash -c 'grep -qF "**Create agent** signs the agent in to Claude itself" <<<"$1" && grep -qF "you sign in afterwards on the agent'"'"'s **GHOST Protocol** tab" <<<"$1"' _ "$QS"
check "README: the quick start links AGENTS.md" grep -qF '](AGENTS.md)' <<<"$QS"
check "AGENTS.md is there" test -s "$AGENTS"
check "AGENTS.md is public: the export's allowlist takes it" \
  bash -c 'printf "100644 blob %s\tAGENTS.md\n" "$(git -C "$1" hash-object AGENTS.md)" | "$1/tools/publish/export" --filter "$1/tools/publish/allowlist" | grep -q "	AGENTS.md$"' _ "$ROOT"
check "AGENTS.md links the quick start and README.md" both '](docs/quick-start.md)' '](README.md)' "$AGENTS"
check "AGENTS.md links the plugin's README and the plugins' README" both "$PLUGIN_README" "$PLUGINS_README" "$AGENTS"
check "AGENTS.md gives the whole chain, in order" bash -c '
  n() { grep -nF -e "$1" "$2" | head -n 1 | cut -d: -f1; }
  f=$1
  a=$(n "| 1. Add the plugin |" "$f"); b=$(n "| 2. Check Docker |" "$f"); c=$(n "| 3. The create form |" "$f"); d=$(n "| 4. Create agent |" "$f"); e=$(n "| 5. Running |" "$f")
  [ -n "$a" ] && [ -n "$b" ] && [ -n "$c" ] && [ -n "$d" ] && [ -n "$e" ] && [ "$a" -lt "$b" ] && [ "$b" -lt "$c" ] && [ "$c" -lt "$d" ] && [ "$d" -lt "$e" ]' _ "$AGENTS"
check "AGENTS.md says a paid Claude plan" both '**A paid Claude plan:** Pro, Max, Ultra, Team or Enterprise.' 'The free plan does not include Claude Code.' "$AGENTS"
check "AGENTS.md gives the relay's admin step: owner attestations on (off by default) or a member" \
  bash -c 'grep -qF "\`BUZZ_ALLOW_NIP_OA_AUTH=true\`, which is **off by default**" "$1" && grep -qF "**The agent is added as a relay member,** by the relay'"'"'s admin" "$1"' _ "$AGENTS"
check "AGENTS.md says when Claude is connected, for each way" \
  both '**Create agent** signs the agent in itself, as step 7' 'step 7 is skipped and the agent waits at `needs-claude`' "$AGENTS"
check "AGENTS.md gives the terminal way" grep -qx '## The other way: a terminal' "$AGENTS"
check "AGENTS.md names the Buzz app's button: Or create a community, which needs an account" grep -qF '**Or create a community** in the Buzz app (it needs an account)' "$AGENTS"
check "AGENTS.md: the relay's refusal ends Create agent with a token; with the address Create agent does not report it, the tab does" \
  bash -c 'row=$(grep -F "| 4. Create agent |" "$1"); grep -qF "With a token, a relay that refuses the attestation ends the wait" <<<"$row" && grep -qF "With the address, Create agent ends at the Claude sign-in (\"Waiting for you to sign in to Claude\") and does not report the refusal." <<<"$row" && grep -qF "the relay row says *Refused: not a member*, with the agent'"'"'s public key, even while the agent still waits for its sign-in" <<<"$row"' _ "$AGENTS"
check "AGENTS.md says the desktop route has not run yet" grep -qF 'the whole Buzz desktop route' "$AGENTS"

# The public words: scan the file in a temporary repository.
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
if command -v python3 >/dev/null && [ -x "$ROOT/tools/publish/scan" ]; then
  git init -q -b main "$T/r"
  mkdir -p "$T/r/docs"
  cp "$DOC" "$T/r/docs/"
  cp "$README" "$T/r/"
  [ -f "$AGENTS" ] && cp "$AGENTS" "$T/r/"
  git -C "$T/r" add -A
  git -C "$T/r" -c user.name=t -c user.email=t@example.com commit -q -m t
  check "the quick start, README.md and AGENTS.md pass the scan's public words" bash -c "cd '$T/r' && '$ROOT/tools/publish/scan' --public-only tree HEAD"
fi

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
