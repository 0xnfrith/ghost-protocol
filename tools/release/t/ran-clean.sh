#!/usr/bin/env bash
# The tests of tools/release/ran-clean, with stand-in docker and systemctl and a real git checkout (no network, no secret):
# the record holds what mark promote judges, and no key or relay address; and mark promote takes the record it writes.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
RAN=$ROOT/tools/release/ran-clean
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0
fail=0
check_eq() { if [ "$2" = "$3" ]; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1"; printf '      got:  %s\n      want: %s\n' "${2//$'\n'/ | }" "${3//$'\n'/ | }"; fi; }
check_has() { if grep -qF -e "$2" <<<"$3"; then pass=$((pass + 1)); echo "ok    $1"; else fail=$((fail + 1)); echo "FAIL  $1"; printf '      wanted: %s\n      in:     %s\n' "$2" "${3//$'\n'/ | }"; fi; }
check_not() { if grep -qF -e "$2" <<<"$3"; then fail=$((fail + 1)); echo "FAIL  $1"; printf '      did not want: %s\n' "$2"; else pass=$((pass + 1)); echo "ok    $1"; fi; }
for tool in git jq; do command -v "$tool" >/dev/null || { echo "SKIP  $tool is not installed"; exit 0; }; done
export GIT_AUTHOR_NAME="Dev" GIT_AUTHOR_EMAIL="dev@example.com" GIT_COMMITTER_NAME="Dev" GIT_COMMITTER_EMAIL="dev@example.com"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

DIGEST=sha256:$(printf 'd%.0s' $(seq 64))
ID=sha256:$(printf 'f%.0s' $(seq 64))
PUB=$(printf 'a%.0s' $(seq 64))
STARTED=$(date -u -d '-2 hours' +%Y-%m-%dT%H:%M:%S.123456789Z)
export S=$T/stub CALLS=$T/stub/calls
mkdir -p "$T/bin" "$S"
# The stand-in docker: one container, gp-agent, whose state is set by STUB_* variables.
cat >"$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$CALLS"
case "$1" in
  inspect)
    [ "$2" = gp-agent ] || { echo "[]"; exit 1; }
    printf '[{"Image":"%s","RestartCount":%s,"Config":{"Image":"%s"},"State":{"Running":%s,"StartedAt":"%s"}}]\n' \
      "$STUB_ID" "${STUB_RESTARTS:-0}" "$STUB_REF" "${STUB_RUNNING:-true}" "$STUB_STARTED" ;;
  image) printf '%s\n' "${STUB_DIGESTS-[\"ghcr.io/acme/ghost-protocol@$STUB_DIGEST\"]}" ;;
  exec)
    [ -n "${STUB_STATUS:-}" ] || exit 1
    printf '%s\n' "$STUB_STATUS" ;;
  *) echo "stub docker: unexpected $*" >&2; exit 1 ;;
esac
STUB
# The stand-in systemctl: `show <unit> -p ...` prints $STUB_SHOW for gp-agent.service, and LoadState=not-found otherwise.
cat >"$T/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >>"$CALLS"
[ "$1" = show ] || exit 1
if [ "$2" = gp-agent.service ]; then printf '%s\n' "$STUB_SHOW"; else printf 'LoadState=not-found\nActiveEnterTimestamp=\nNRestarts=0\n'; fi
STUB
chmod +x "$T/bin/docker" "$T/bin/systemctl"
export PATH="$T/bin:$PATH" STUB_ID=$ID STUB_DIGEST=$DIGEST STUB_STARTED=$STARTED STUB_REF="ghcr.io/acme/ghost-protocol:1.1.0@$DIGEST"
GOOD_STATUS='{"interface":1,"version":"1.1.0","state":"running","agent_pubkey":"'$PUB'","relay_url":"wss://relay.example.test","relay":"connected","claude":"active","update":{"available":false,"version":null},"previous_version":null,"error":null}'
export STUB_STATUS=$GOOD_STATUS

run() { rc=0; out=$("$RAN" "$@" 2>"$T/err") || rc=$?; err=$(cat "$T/err"); }

# An agent from the image.
run --container gp-agent
check_eq "image: exit 0" "$rc" "0"
check_eq "image: a ran-clean record" "$(jq -r .record <<<"$out")" "gp-ran-clean/1"
check_eq "image: the install" "$(jq -r .install <<<"$out")" "image"
check_eq "image: the version is gp status's" "$(jq -r .version <<<"$out")" "1.1.0"
check_eq "image: running, no restarts" "$(jq -c '[.running, .restarts]' <<<"$out")" "[true,0]"
check_eq "image: up since, to the second" "$(jq -r .up_since <<<"$out")" "${STARTED%.*}Z"
check_eq "image: the image's reference, id and registry digests" "$(jq -c .image <<<"$out")" \
  "{\"reference\":\"$STUB_REF\",\"id\":\"$ID\",\"repo_digests\":[\"ghcr.io/acme/ghost-protocol@$DIGEST\"]}"
check_eq "image: the status" "$(jq -c .status <<<"$out")" '{"state":"running","relay":"connected","claude":"active","error":null}'
check_not "image: no agent key in the record" "$PUB" "$out"
check_not "image: no relay address in the record" "relay.example.test" "$out"
check_has "image: a summary on stderr" "ran-clean: image 1.1.0, running true" "$err"
check_eq "image: taken now" "$(( $(date -u +%s) - $(date -u -d "$(jq -r .taken_at <<<"$out")" +%s) < 60 ))" "1"
STUB_STATUS='{"version":"1.1.0","state":"error","relay":"refused-not-member","claude":"active","error":{"code":"relay-refused","message":"m"}}' run --container gp-agent
check_eq "image: the error's code only" "$(jq -c .status <<<"$out")" '{"state":"error","relay":"refused-not-member","claude":"active","error":"relay-refused"}'
: >"$CALLS"
STUB_RUNNING=false run --container gp-agent
check_eq "a stopped container: exit 0 (the record says so)" "$rc" "0"
check_eq "a stopped container: not running, no status asked" "$(jq -c '[.running, .version, .status.state]' <<<"$out")" "[false,null,null]"
check_not "a stopped container: gp status not run" "docker exec" "$(cat "$CALLS")"
STUB_STATUS="" run --container gp-agent
check_eq "gp status fails: exit 0, no status" "$(jq -c '[.version, .status.state]' <<<"$out")" "[null,null]"
STUB_STATUS="not json" run --container gp-agent
check_eq "gp status not JSON: no status" "$(jq -c '[.version, .status.state]' <<<"$out")" "[null,null]"
STUB_RESTARTS=3 run --container gp-agent
check_eq "restarts are counted" "$(jq -r .restarts <<<"$out")" "3"
STUB_DIGESTS="" run --container gp-agent
check_eq "no registry digests read: an empty list" "$(jq -c .image.repo_digests <<<"$out")" "[]"
run --container nowhere
check_eq "no such container: exit 2" "$rc" "2"

# An agent from a checkout, run by a unit.
git init -q -b main "$T/co"
mkdir -p "$T/co/.claude-plugin"
printf '{"name":"x","version":"1.1.0"}\n' >"$T/co/.claude-plugin/plugin.json"
git -C "$T/co" add -A && git -C "$T/co" commit -q -m one
COMMIT=$(git -C "$T/co" rev-parse HEAD)
STUB_SHOW="NRestarts=0
LoadState=loaded
ActiveState=active
SubState=running
ActiveEnterTimestamp=$(date -u -d '-3 hours' '+%a %Y-%m-%d %H:%M:%S UTC')"
export STUB_SHOW
run --checkout "$T/co" --unit gp-agent.service
check_eq "checkout: exit 0" "$rc" "0"
check_eq "checkout: install, version, commit, unchanged" "$(jq -c '[.install, .version, .commit, .changed]' <<<"$out")" "[\"checkout\",\"1.1.0\",\"$COMMIT\",false]"
check_eq "checkout: the unit" "$(jq -c '[.running, .restarts, .unit]' <<<"$out")" '[true,0,{"active_state":"active","sub_state":"running"}]'
check_eq "checkout: up since the unit started" "$(jq -r .up_since <<<"$out")" "$(date -u -d "$(sed -n 's/^ActiveEnterTimestamp=//p' <<<"$STUB_SHOW")" +%Y-%m-%dT%H:%M:%SZ)"
echo untracked >"$T/co/notes.txt"
run --checkout "$T/co" --unit gp-agent.service
check_eq "an untracked file is not a change" "$(jq -r .changed <<<"$out")" "false"
echo '{"name":"x","version":"1.1.0","more":1}' >"$T/co/.claude-plugin/plugin.json"
run --checkout "$T/co" --unit gp-agent.service
check_eq "a changed tracked file is a change" "$(jq -r .changed <<<"$out")" "true"
git -C "$T/co" checkout -q -- .
STUB_SHOW="NRestarts=2
LoadState=loaded
ActiveState=activating
SubState=auto-restart
ActiveEnterTimestamp=" run --checkout "$T/co" --unit gp-agent.service
check_eq "a restarting unit: not running, restarts, no start time" "$(jq -c '[.running, .restarts, .up_since]' <<<"$out")" "[false,2,null]"
run --checkout "$T/co" --unit other.service
check_eq "no such unit: exit 2" "$rc" "2"
run --checkout "$T/nowhere" --unit gp-agent.service
check_eq "not a checkout: exit 2" "$rc" "2"

# --out, and usage.
run --container gp-agent --out "$T/rec.json"
check_eq "--out: nothing on stdout" "$out" ""
check_eq "--out: the record in the file" "$(jq -r .record "$T/rec.json")" "gp-ran-clean/1"
run
check_eq "no argument: exit 2" "$rc" "2"
run --container gp-agent --checkout "$T/co" --unit gp-agent.service
check_eq "both kinds: exit 2" "$rc" "2"
run --checkout "$T/co"
check_eq "--checkout without --unit: exit 2" "$rc" "2"
run --frob
check_eq "an unknown argument: exit 2" "$rc" "2"

# mark promote takes the records ran-clean writes: the image one against get.sh's digest, the checkout one against the tag's commit.
cat >"$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "release view") echo '{"tagName":"v1.1.0","isPrerelease":true,"isDraft":false,"body":"notes"}' ;;
  "release list") echo '[{"tagName":"v1.1.0","isPrerelease":true,"isDraft":false}]' ;;
  "release download") printf 'IMAGE="${GP_IMAGE:-ghcr.io/acme/ghost-protocol:1.1.0@%s}"\n' "$STUB_DIGEST" ;;
  "api repos/acme/ghost-protocol/commits/v1.1.0") echo "$TAG_COMMIT" ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$T/bin/gh"
"$RAN" --container gp-agent --out "$T/image.json" 2>/dev/null
"$RAN" --checkout "$T/co" --unit gp-agent.service --out "$T/checkout.json" 2>/dev/null
for kind in image checkout; do
  out=$(TAG_COMMIT=$COMMIT "$ROOT/tools/release/mark" promote v1.1.0 --repo acme/ghost-protocol --ran "$T/$kind.json" 2>&1)
  check_eq "mark promote takes ran-clean's $kind record" "$?" "0"
done
out=$(TAG_COMMIT=$(printf 'b%.0s' $(seq 40)) "$ROOT/tools/release/mark" promote v1.1.0 --repo acme/ghost-protocol --ran "$T/checkout.json" 2>&1)
check_eq "mark promote refuses ran-clean's record of another commit" "$?" "2"

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
