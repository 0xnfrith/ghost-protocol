#!/usr/bin/env bash
# automode-watch.test.sh: tools/automode/watch, the read-only check of Claude
# Code's auto-mode rules against a snapshot.
#   - Drift either way: a snapshot rule missing from the settings file
#     (VANISHED) and a rule not in the snapshot yet (NEW) both exit 1; no
#     drift exits 0; an error exits 2.
#   - --json: the counts, each drifted rule in full and JSON-quoted, and a
#     digest of the full rules, so two rules that share a long beginning never
#     give the same digest.
#   - --snapshot prints the three lists, sorted, and refuses a rule with a
#     control or format character.
#   - Lists compare as sets; invisible characters are escaped, never printed.
#   - It never prints the env block, another key or autoMode.environment, and
#     never writes the settings file.
# Settings files are fixtures made here; the real one is never read.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

W="$SRC/tools/automode/watch"
t_new
if ! t_tool python3; then
    echo "SKIP  every case (no python3 on this machine)"
    finish_tests
    exit $?
fi
ALL="$T/all.txt"; : >"$ALL"
S="$T/home/.claude/settings.json"
SNAP="$T/snapshot.json"
mkdir -p "$T/home/.claude"

ENV_MARK="FAKE_ENV_VALUE_7f3a9c"
OTHER_MARK="OTHER_KEY_VALUE_51be02"
ENVIRONMENT_MARK="ENVIRONMENT_LINE_c4d811"
A1="Allow one: reading logs on the test box."
A2="Allow two: café, naïve, em dash — unicode survives."
S1="Soft-deny one: deleting data unless asked."
S2="Soft-deny two: a subagent driving the browser unless asked."
X1="A new rule, not backed up yet."

# settings <allow...> -- <soft_deny...>: a settings file with an env block,
# another key and an environment list that must never surface.
settings() {
    t_env python3 -I - "$S" "$@" <<'PY'
import json, sys
out, rest = sys.argv[1], sys.argv[2:]
groups, cur = [], []
for a in rest:
    if a == "--":
        groups.append(cur); cur = []
    else:
        cur.append(a)
groups.append(cur)
data = {"env": {"SOME_TOKEN": "FAKE_ENV_VALUE_7f3a9c"},
        "autoMode": {"environment": ["ENVIRONMENT_LINE_c4d811"], "allow": groups[0],
                     "soft_deny": groups[1] if len(groups) > 1 else []},
        "permissions": {"allow": ["Bash(echo OTHER_KEY_VALUE_51be02)"]}}
open(out, "w", encoding="utf-8").write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
PY
}
w() { t_env "$W" "$@" >"$OUT" 2>&1; RC=$?; cat "$OUT" >>"$ALL"; }
# jget <expression>: a value of the JSON in OUT. The eval runs only the
# expressions written in this file, never input.
jget() { t_env python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$OUT" "$1"; }

# The snapshot, made from a settings file by --snapshot.
settings "$A1" "$A2" -- "$S1" "$S2"
w --snapshot
check "snapshot: exit 0" rc_is 0
cp "$OUT" "$SNAP"
check "snapshot: exactly the three lists, sorted" \
    [ "$(jget 'sorted(d)')" = "['allow', 'hard_deny', 'soft_deny']" ]
check "snapshot: no environment line" out_lacks "$ENVIRONMENT_MARK"

# 1. No drift.
w --against "$SNAP"
check "same rules: exit 0" rc_is 0
check "same rules: OK" out_has '^OK: the settings file and the snapshot hold the same rules\.$'
check "same rules: the counts" out_has '^auto-mode rules now: allow 2, soft_deny 2, hard_deny 0$'

# 2. A NEW rule alone is drift.
settings "$A1" "$A2" -- "$S1" "$S2" "$X1"
w --against "$SNAP"
check "a new rule: exit 1" rc_is 1
check "a new rule: NEW, JSON-quoted" out_has "^NEW soft_deny: \"$X1\"\$"
check "a new rule: the drift line" out_has '^DRIFT: 0 vanished from the settings file, 1 not in the snapshot yet\.$'

# 3. A VANISHED rule.
settings "$A1" -- "$S1" "$S2" "$X1"
cp "$S" "$T/before.json"
w --against "$SNAP"
check "a vanished rule: exit 1" rc_is 1
check "a vanished rule: VANISHED, JSON-quoted" out_has "^VANISHED allow: \"$A2\"\$"
check "the settings file is never written" cmp -s "$S" "$T/before.json"

# 4. --json.
w --against "$SNAP" --json
check "json: exit 1 on drift" rc_is 1
check "json: drift true" [ "$(jget 'd["drift"]')" = True ]
check "json: the vanished rule in full" [ "$(jget 'd["vanished"]')" = "[{'list': 'allow', 'shown': '\"$A2\"'}]" ]
check "json: the new rule in full" [ "$(jget 'd["new"]')" = "[{'list': 'soft_deny', 'shown': '\"$X1\"'}]" ]
check "json: the counts" [ "$(jget 'd["live"], d["snapshot"]')" = "({'allow': 1, 'soft_deny': 3, 'hard_deny': 0}, {'allow': 2, 'soft_deny': 2, 'hard_deny': 0})" ]
check "json: a 64-hex digest" sh -c "[ \"\$(printf '%s' '$(jget 'd["digest"]')' | grep -cE '^[0-9a-f]{64}$')\" = 1 ]"
check "json: exactly six keys" [ "$(jget 'sorted(d)')" = "['digest', 'drift', 'live', 'new', 'snapshot', 'vanished']" ]
D1="$(jget 'd["digest"]')"
w --against "$SNAP" --json
check "json: the same drift, the same digest" [ "$(jget 'd["digest"]')" = "$D1" ]
settings "$A1" "$A2" -- "$S1" "$S2" "$X1"
w --against "$SNAP" --json
check "json: a different drift, a different digest" [ "$(jget 'd["digest"]')" != "$D1" ]
settings "$A1" "$A2" -- "$S1" "$S2"
w --against "$SNAP" --json
check "json, no drift: exit 0, digest null" sh -c "[ $RC = 0 ] && [ '$(jget 'd["digest"]')' = None ]"

# 5. Two rules that share a 150-character beginning get different digests.
P="$(t_env python3 -I -c 'print("Shared beginning " + "x" * 133)')"
settings "$A1" "$A2" -- "$S1" "$S2" "$P tail one"
w --against "$SNAP" --json; D2="$(jget 'd["digest"]')"
check "json: a long rule is shown in full" out_has 'tail one'
settings "$A1" "$A2" -- "$S1" "$S2" "$P tail two"
w --against "$SNAP" --json; D3="$(jget 'd["digest"]')"
check "json: a shared long beginning does not hide a change" [ -n "$D2" ] && [ "$D2" != "$D3" ]

# 6. Sets: a rule listed twice changes nothing.
settings "$A1" "$A1" "$A2" -- "$S1" "$S2" "$S2"
w --against "$SNAP"
check "duplicates: exit 0" rc_is 0

# 7. Invisible characters are escaped.
ESC="$(printf '\033')"
RLO="$(printf '\342\200\256')"
settings "$A1" "$A2" -- "$S1" "$S2" "Hides ${ESC}[2K itself ${RLO}reversed"
w --against "$SNAP"
check "an escape character is shown as \\u001b" out_has 'Hides \\u001b\[2K itself'
check "U+202E is shown as \\u202e" out_has '\\u202ereversed'
check "no raw escape character" out_lacks "$ESC"
check "no raw U+202E" out_lacks "$RLO"
w --against "$SNAP" --json
check "json: no raw escape character" out_lacks "$ESC"
w --snapshot
check "snapshot of a rule with a control character: refused, exit 2" rc_is 2
check "the refused snapshot prints no lists" out_lacks '"soft_deny"'

# 8. Errors exit 2 and name the path only.
w --against "$SNAP" --settings "$T/missing.json"
check "settings missing: exit 2" rc_is 2
check "settings missing: names the path" out_has "settings file not found: $T/missing.json"
printf '{"autoMode": {"allow": "not a list"}, "env": {"K": "%s"}}\n' "$ENV_MARK" >"$T/bad.json"
w --against "$SNAP" --settings "$T/bad.json"
check "a list that is not a list: exit 2" rc_is 2
check "a list that is not a list: named" out_has 'autoMode.allow is not a list of strings'
printf '{"env": {"K": "%s"}, "autoMode": {' "$ENV_MARK" >"$T/broken.json"
w --against "$SNAP" --settings "$T/broken.json"
check "broken JSON: exit 2, a position, no content" sh -c "[ $RC = 2 ] && grep -q 'is not valid JSON' '$OUT'"
w --against "$T/no-snapshot.json"
check "snapshot missing: exit 2" rc_is 2
w
check "no --against and no --snapshot: exit 2 (usage)" rc_is 2
w --snapshot --against "$SNAP"
check "--snapshot with --against: exit 2 (usage)" rc_is 2
w --json --snapshot
check "--json with --snapshot: exit 2 (usage)" rc_is 2
settings
w --against "$SNAP"
check "no autoMode lists at all: every snapshot rule vanished, exit 1" sh -c "[ $RC = 1 ] && [ \$(grep -c '^VANISHED' '$OUT') = 4 ]"

# Never: the env block, another key, an environment line.
OUT="$ALL"
check "no output ever shows the env block" out_lacks "$ENV_MARK"
check "no output ever shows another key" out_lacks "$OTHER_MARK"
check "no output ever shows an environment line" out_lacks "$ENVIRONMENT_MARK"

finish_tests
