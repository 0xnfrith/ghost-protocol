#!/usr/bin/env bash
# automode-guard.test.sh: the auto-mode guard (install/automode-guard/).
#   - The guard (guard): what it asks the owner about, in plain words.
#     Nothing when every changed rule is signed in the ledger and in force,
#     and never "$defaults" as added. Rules not on record, rules on record
#     that are gone (from the snapshot on main, or a ledger add not yet
#     expired), and rules that expired (or whose expiry can't be read) but
#     are still live, each one message, tagging the owner, once; a new
#     message when more rules of that kind turn up; closed quietly when fixed
#     some other way. "$defaults" gone from a list that had it (in the
#     snapshot, or live as the guard saw it before) is always asked about,
#     whatever the ledger says, and Put back restores it first in its list.
#     The gone and expired questions quote each rule and say where it is on
#     record, never "you made". No technical words in anything the owner
#     reads.
#   - The owner's answers, read through the adapter's thread read (a
#     stand-in here): only from the owner's key (a mutant without that check
#     acts on a stranger's reply), only that message's rules still in its
#     kind, the first answer only; Show me them in the thread; Keep, Remove,
#     Put back and Leave out applied, with ledger lines naming the reply and
#     a backup holding the three lists only; applied twice changes nothing;
#     no reply changes nothing; a failed read or write changes nothing and is
#     tried again; a rule with hidden characters is never signed by a reply.
#   - A broken check (settings, snapshot or ledger unreadable) is reported
#     once, and the run after it that works sends one all-clear. The state
#     file never holds a rule. Credentials reach the adapter alone, as
#     variables named by start's rule (reserved names refused), never the
#     check. The adapter gets private XDG folders. The test-only overrides
#     work only with GP_TEST=1. The snapshot is read from main only.
#   - DM task roots: with BUZZ_TASK_OPEN_EMOJI, each question and each
#     broken-check message gets the open state once it is on record; the
#     all-clear, the replies in a thread and a dry run get none; a failed
#     state call is logged and changes nothing.
#   - The unit templates: every placeholder filled, the sandbox lines, nothing
#     writable but the state folder, the settings file and the ledger, no
#     secret in the unit; systemd-analyze where it is installed.
#   - The install step (automode_guard, through install/automode-guard/setup):
#     skipped without [automode_guard], off, on macOS, without the snapshot,
#     without node 22, without the adapter's dependencies; a dry run writes
#     nothing and calls no sudo; --apply copies the guard root-owned (here:
#     to GP_LIBDIR), makes a missing ledger, writes both units (GP_ETC),
#     reloads, enables the timer and runs it once; a second run changes
#     nothing; a changed copy is put back; --uninstall removes it all but the
#     instance's drop-in; --manifest with --apply is refused. And the full
#     installer's step 14.
# The adapter is a stub; nothing reaches a relay. uname is a stub, so the
# Linux cases run on macOS too.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

GUARD_SRC="$SRC/install/automode-guard/guard"
TPL="$SRC/install/automode-guard/automode-guard.service"
TIMER_TPL="$SRC/install/automode-guard/automode-guard.timer"
SETUP="$SRC/install/automode-guard/setup"
CHAN="0000aaaa-1111-2222-3333-444455556666"
KEY="$(printf '%064d' 7)"                # another key the messages mention
OWNER="$(printf '%064d' 9)"              # the owner
STRANGER="$(printf '%064d' 5)"           # any other key
TOKEN="FAKE_TOKEN_VALUE_9d2e71"
ENV_MARK="FAKE_ENV_VALUE_7f3a9c"; OTHER_MARK="OTHER_KEY_VALUE_51be02"; ENVIRONMENT_MARK="ENVIRONMENT_LINE_c4d811"

t_new
if ! t_tool python3; then
    echo "SKIP  every case (no python3 on this machine)"
    finish_tests
    exit $?
fi

# ---------------------------------------------------------------- the guard

# The installed layout: the guard alone (the adapter is the stand-in below).
G="$T/lib"; mkdir -p "$G"
cp "$GUARD_SRC" "$G/guard"; chmod +x "$G/guard"
STATE_D="$T/gstate"; mkdir -p "$STATE_D"; chmod 700 "$STATE_D"
CREDS="$T/creds"; mkdir -p "$CREDS"
printf '%s\n' "$TOKEN" >"$CREDS/api-token"
printf 'x\n' >"$CREDS/canary"
printf 'x\n' >"$CREDS/path"
printf 'x\n' >"$CREDS/node-options"
# The owner's attestation goes through; any other BUZZ_ name does not.
AUTH_MARK="FAKE_AUTH_TAG_VALUE_3e8b51"
printf '%s\n' "$AUTH_MARK" >"$CREDS/buzz-auth-tag"
printf 'https://elsewhere.example.com\n' >"$CREDS/buzz-relay-url"
SETTINGS_F="$T/home/.claude/settings.json"; mkdir -p "$T/home/.claude"
LEDGER_F="$T/home/ledger/LEDGER.md"; mkdir -p "$T/home/ledger"; : >"$LEDGER_F"   # the installer makes it
# The instance repo, with the snapshot committed on main: the guard reads it
# from there, never from the working tree.
REPO="$T/repo"; SNAP_REL="config/automode.json"; SNAPF="$REPO/$SNAP_REL"
git init -q "$REPO"; mkdir -p "$REPO/config"
SEND_PATH="$T/sendbin:/usr/bin:/bin"
MSG="$T/state/message.txt"; SENDS="$T/state/sends.log"; READS="$T/state/reads.log"
MSGS="$T/state/msgs"; mkdir -p "$MSGS"
REPLIES="$T/state/replies.jsonl"; : >"$REPLIES"
echo 0 >"$T/state/send.rc"; echo 0 >"$T/state/read.rc"; echo 0 >"$T/state/count"
# The adapter's stand-in (`node launch.mjs …`). send: the message to a file
# (fixture rules only), and names, yes/no and counts for the rest, never a
# value; it answers "sent <id>", a new id each time. thread: the arguments
# to a log, and the replies the test put in $REPLIES, whatever was asked.
# task (an alert's open state): its arguments, the emoji settings, and
# whether the alert was on record in the state at that moment, to tasks.log;
# it answers as the adapter's one-shot task does, or fails with task.rc.
TASKS="$T/state/tasks.log"
cat >"$T/stubs/adapter-stub" <<EOF
#!/bin/sh
yn() { if [ -n "\$1" ]; then echo yes; else echo no; fi; }
tok=no; [ "\${API_TOKEN:-}" = "$TOKEN" ] && tok=match
tag=no; [ "\${BUZZ_AUTH_TAG:-}" = "$AUTH_MARK" ] && tag=match
relay_is_unit=no; [ "\${BUZZ_RELAY_URL:-}" = https://relay.example.com ] && relay_is_unit=yes
sp=no; [ "\$PATH" = "$SEND_PATH" ] && sp=yes
xdg=no; [ -d "\${XDG_CONFIG_HOME:-/nonexistent}" ] && xdg="\$(ls -ld "\$XDG_CONFIG_HOME" | cut -c1-10)"
pis=yes; [ "\$PATH" = x ] && pis=no
envs="api_token=\$tok canary=\$(yn "\${CANARY:-}") path_is_system=\$pis send_path=\$sp node_options=\$(yn "\${NODE_OPTIONS:-}") xdg_config=\$xdg relay=\$(yn "\${BUZZ_RELAY_URL:-}") relay_is_unit=\$relay_is_unit auth_tag=\$tag"
if [ "\$1" = thread ]; then
    echo "argv=\$* \$envs" >>"$READS"
    rc="\$(cat "$T/state/read.rc")"
    [ "\$rc" = 0 ] && cat "$REPLIES"
    [ "\$rc" = 0 ] || echo "buzz thread: the relay refused the request: test" >&2
    exit "\$rc"
fi
if [ "\$1" = task ]; then
    id=""; prev=""; for a in "\$@"; do [ "\$prev" = --id ] && id="\$a"; prev="\$a"; done
    rec=no; [ -n "\$id" ] && grep -qF "\$id" "$STATE_D/state.json" 2>/dev/null && rec=yes
    chk=\$(grep -o '"check": "[a-z]*' "$STATE_D/state.json" 2>/dev/null | sed 's/.*"//')
    echo "argv=\$* emoji=\${BUZZ_TASK_OPEN_EMOJI:-} url=\${BUZZ_TASK_OPEN_EMOJI_URL:-} \$envs on_record=\$rec check=\$chk" >>"$TASKS"
    rc=0; [ -f "$T/state/task.rc" ] && rc=\$(cat "$T/state/task.rc")
    [ "\$rc" = 0 ] && echo "\$(printf '%.8s' "\$id"): none -> open"
    exit "\$rc"
fi
cat >"$MSG"
n=\$((\$(cat "$T/state/count") + 1)); echo "\$n" >"$T/state/count"
cp "$MSG" "$MSGS/\$n.txt"
bytes=\$(wc -c <"$MSG" | tr -d ' ')
echo "argv=\$* \$envs bytes=\$bytes" >>"$SENDS"
rc="\$(cat "$T/state/send.rc")"
[ "\$rc" = 0 ] && [ ! -e "$T/state/no-id" ] && printf 'sent %064x\n' "\$n"
exit "\$rc"
EOF
chmod +x "$T/stubs/adapter-stub"
A1="Allow one: reading logs on the test box."
A2="Allow two: café, naïve, em dash — unicode survives."
S1="Soft-deny one: deleting data unless asked."
S2="Soft-deny two: a subagent driving the browser unless asked."
X1="A new rule nobody signed."
X2="A second new rule, with a \`backtick\` and [a link](https://example.com)."
X3="A third new rule, added later."
ALL="$T/all.txt"; : >"$ALL"

# Settings, snapshot and ledger, from Python, each list given after its name:
#   settings allow <rule>... soft_deny <rule>... hard_deny <rule>...
lists_json() {
    t_env python3 -I - "$@" <<'PY'
import json, sys
out, cur = {"allow": [], "soft_deny": [], "hard_deny": []}, None
for a in sys.argv[1:]:
    if a in out:
        cur = a
    else:
        out[cur].append(a)
print(json.dumps(out, ensure_ascii=False))
PY
}
settings() {
    t_env python3 -I - "$SETTINGS_F" "$(lists_json "$@")" <<'PY'
import json, sys
lists = json.loads(sys.argv[2])
data = {"env": {"SOME_TOKEN": "FAKE_ENV_VALUE_7f3a9c"},
        "autoMode": {"environment": ["ENVIRONMENT_LINE_c4d811"], **{k: v for k, v in lists.items() if v or k != "hard_deny"}},
        "permissions": {"allow": ["Bash(echo OTHER_KEY_VALUE_51be02)"]}}
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
PY
}
snapshot() {   # written, and committed on main
    t_env python3 -I - "$SNAPF" "$(lists_json "$@")" <<'PY'
import json, sys
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(json.loads(sys.argv[2]), indent=2, sort_keys=True, ensure_ascii=False) + "\n")
PY
    commit
}
commit() { git -C "$REPO" add -A && git -C "$REPO" commit -q --allow-empty -m snapshot; }
# ledger <add|remove> <list> <rule> [expires]: one line, as a sign script writes it.
ledger() {
    t_env python3 -I - "$LEDGER_F" "$@" <<'PY'
import hashlib, sys
path, action, k, rule = sys.argv[1:5]
exp = sys.argv[5] if len(sys.argv) > 5 else "never"
entry = hashlib.sha256(rule.encode("utf-8")).hexdigest()[:16]
with open(path, "a", encoding="utf-8") as f:
    f.write(f"- {action} | autoMode.{k} | expires {exp} | draft test-draft.md | entry sha256 {entry} | {rule}\n")
PY
}
# The live lists, as one line per rule: <list> <rule>.
live() {
    t_env python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8")).get("autoMode") or {}
for k in ("allow", "soft_deny", "hard_deny"):
    for r in d.get(k) or []:
        print(k, r)' "$SETTINGS_F"
}
live_has() { live | grep -qxF -- "$1 $2"; }
# state <python expression over s, the state>: prints it. The expression is
# always one of this file's own (eval of test code over test data).
state() { t_env python3 -I -c 'import json, sys; s = json.load(open(sys.argv[1])); print(eval(sys.argv[2]))' "$STATE_D/state.json" "$1" 2>/dev/null; }
alert_id() { state "s['alerts']['$1']['id']"; }
no_alert() { [ "$(state "'$1' in s['alerts']")" = False ]; }
# reply <root> <author> <text>: one reply the thread read returns; its id is
# then in LAST_REPLY.
REPLY_N=0
reply() {
    REPLY_N=$((REPLY_N + 1))
    LAST_REPLY="$(printf '%064x' $((0xabc000 + REPLY_N)))"
    t_env python3 -I -c '
import json, sys
print(json.dumps({"id": "%064x" % (0xabc000 + int(sys.argv[4])), "pubkey": sys.argv[2], "created_at": 2000000000 + int(sys.argv[4]),
                  "root": sys.argv[1], "content": sys.argv[3]}, ensure_ascii=False))' "$1" "$2" "$3" "$REPLY_N" >>"$REPLIES"
}
sends() { if [ -f "$SENDS" ]; then wc -l <"$SENDS" | tr -d ' '; else echo 0; fi; }
reads() { if [ -f "$READS" ]; then wc -l <"$READS" | tr -d ' '; else echo 0; fi; }
msg_has() { grep -qF -- "$1" "$MSG"; }
msg_is() { [ "$(cat "$MSG")" = "$1" ]; }
last_send_has() { tail -n 1 "$SENDS" | grep -qF -- "$1"; }
ledger_has() { grep -qF -- "$1" "$LEDGER_F"; }
ledger_count() { grep -cE -- "$1" "$LEDGER_F" 2>/dev/null || true; }
# msg_n <k>: the message sent k messages before the last one.
msg_n() { cat "$MSGS/$(( $(cat "$T/state/count") - ${1:-0} )).txt"; }
no_alerts() { [ ! -e "$STATE_D/state.json" ] || [ "$(state "len(s['alerts'])")" = 0 ]; }

# guard [VAR=value ...] [-- args]: one run as the unit makes it.
guard() {
    local args=()
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do args+=("$1"); shift; done
    [ "${1:-}" = "--" ] && shift
    t_env GP_GUARD_NAME=instance GP_GUARD_REPO="$REPO" GP_GUARD_SNAPSHOT="$SNAP_REL" GP_GUARD_SETTINGS="$SETTINGS_F" \
        GP_GUARD_LEDGER="$LEDGER_F" GP_GUARD_OWNER="$OWNER" \
        GP_GUARD_SEND_PATH="$SEND_PATH" GP_GUARD_CHANNEL="$CHAN" GP_GUARD_MENTIONS="$KEY" BUZZ_RELAY_URL=https://relay.example.com \
        BUZZ_KEY_COMMAND="bin/key" STATE_DIRECTORY="$STATE_D" CREDENTIALS_DIRECTORY="$CREDS" \
        GP_GUARD_SEND="$T/stubs/adapter-stub" GP_GUARD_RETRY_SECS=0 \
        ${args[@]+"${args[@]}"} "${GUARD_BIN:-$G/guard}" "$@" >"$OUT" 2>&1
    RC=$?
    { cat "$OUT"; cat "$MSG" 2>/dev/null; cat "$STATE_D/state.json" 2>/dev/null; cat "$STATE_D"/backups/* 2>/dev/null; } >>"$ALL"
}
reset_world() {   # a clean start: no state, no ledger, no replies
    rm -rf "$STATE_D"; mkdir -p "$STATE_D"; chmod 700 "$STATE_D"
    : >"$LEDGER_F"; : >"$REPLIES"
}

UNMADE2="I found 2 rules you didn't make. Another agent may have added them; I'm not sure. What would you like to do?
• Show me them
• Keep them
• Remove them"
UNMADE1="I found 1 rule you didn't make. Another agent may have added it; I'm not sure. What would you like to do?
• Show me
• Keep it
• Remove it"
# Where a rule is on record, as the gone and expired questions say it.
ON_MAIN="on record in the saved copy of your rules (\`$SNAP_REL\` on main)"
GONE3="3 rules on record are gone. I'm not sure what removed them.
1. Allows: \`$A2\`, $ON_MAIN
2. Allows: \`$X1\`, on record in line 1 of \`LEDGER.md\`
3. Blocks unless you ask: \`$S2\`, $ON_MAIN
What would you like to do?
• Show me them
• Put them back
• Leave them out"
GONE1="1 rule on record is gone. I'm not sure what removed it.
1. Blocks unless you ask: \`$S2\`, $ON_MAIN
What would you like to do?
• Show me
• Put it back
• Leave it out"

# 1. Nothing changed: no message, nothing on record.
snapshot allow "$A1" "$A2" soft_deny "$S1" "$S2"
settings allow "$A1" "$A2" soft_deny "$S1" "$S2"
guard
check "nothing changed: exit 0" rc_is 0
check "nothing changed: says so" out_has 'nothing to ask about'
check "nothing changed: no message" [ "$(sends)" = 0 ]
check "nothing changed: no thread read" [ "$(reads)" = 0 ]
check "nothing changed: the state holds no message" no_alerts

# 2. Every changed rule is one the owner signed: nothing at all.
ledger add allow "$X1"
ledger remove soft_deny "$S2"
ledger add hard_deny "$X3" "2099-01-01 00:00 +00"   # a grant still in force
settings allow "\$defaults" "$A1" "$A2" "$X1" soft_deny "$S1" hard_deny "$X3"
guard
check "signed changes only: exit 0" rc_is 0
check "signed changes only: no message at all" [ "$(sends)" = 0 ]
check "signed changes only: counted as nothing" out_has "rules not on record: 0; rules on record that are gone: 0; expired but still live: 0"
check "\$defaults added is never a rule anyone asks about" [ "$(sends)" = 0 ]
check "\$defaults live: the state keeps the list's name, never a rule" [ "$(state "s['defaults']")" = "['allow']" ]
reset_world

# 3. Rules the owner didn't make: one message, the owner's words, tagged.
settings allow "$A1" "$A2" "$X1" soft_deny "$S1" "$S2" "$X2"
guard
check "unmade: exit 0" rc_is 0
check "unmade: one message" [ "$(sends)" = 1 ]
check "unmade: the owner's words, exactly" msg_is "$UNMADE2"
check "unmade: tags the owner and the other mention" grep -q "argv=send --channel $CHAN --mention $KEY --mention $OWNER " "$SENDS"
check "unmade: a root, not a reply" sh -c "! grep -q -- '--reply' '$SENDS'"
check "unmade: the log has counts, never a rule" sh -c "grep -q 'rules not on record: 2' '$OUT' && ! grep -qF 'nobody signed' '$OUT'"
check "unmade: the state has the message's id" [ "$(alert_id unmade)" = "$(printf '%064x' 1)" ]
check "unmade: the state has two digests" [ "$(state "len(s['alerts']['unmade']['rules'])")" = 2 ]
check "unmade: the state never holds a rule" sh -c "! grep -qF 'nobody signed' '$STATE_D/state.json'"
check "unmade: the credential reaches the adapter as API_TOKEN" grep -q " api_token=match " "$SENDS"
check "unmade: another credential by start's rule (canary as CANARY)" grep -q " canary=yes " "$SENDS"
check "unmade: a credential named path does not replace PATH" grep -q " path_is_system=yes " "$SENDS"
check "unmade: the adapter's PATH is GP_GUARD_SEND_PATH" grep -q " send_path=yes " "$SENDS"
check "unmade: a credential named node-options is refused" grep -q " node_options=no " "$SENDS"
check "unmade: the log names each refused credential" sh -c "grep -q 'skipped credential PATH: that name is reserved' '$OUT' && grep -q 'skipped credential NODE_OPTIONS' '$OUT'"
check "unmade: buzz-auth-tag reaches the adapter as BUZZ_AUTH_TAG" grep -q " auth_tag=match " "$SENDS"
check "unmade: another BUZZ_ credential is refused (buzz-relay-url)" sh -c "grep -q ' relay_is_unit=yes ' '$SENDS' && grep -q 'skipped credential BUZZ_RELAY_URL: that name is reserved' '$OUT'"
check "the attestation's value reaches no log" sh -c "! grep -q '$AUTH_MARK' '$OUT'"
check "unmade: the adapter gets a private XDG config folder" grep -q " xdg_config=drwx------ " "$SENDS"
U1="$(alert_id unmade)"
guard
check "the same rules again: no second message" [ "$(sends)" = 1 ]
check "the same rules again: the thread is read, as the owner's key" grep -q "argv=thread --channel $CHAN --author $OWNER --since [0-9]* --root $U1" "$READS"
check "the same rules again: the read gets the credential too" grep -q " api_token=match " "$READS"

# 4. No reply, however many runs: nothing changes.
before="$(sha_of "$SETTINGS_F")"
for _ in 1 2 3; do guard; done
check "no reply: exit 0" rc_is 0
check "no reply: nothing sent" [ "$(sends)" = 1 ]
check "no reply: the settings file is as it was" [ "$(sha_of "$SETTINGS_F")" = "$before" ]
check "no reply: no ledger written" [ ! -s "$LEDGER_F" ]
check "no reply: the message stays open" [ "$(alert_id unmade)" = "$U1" ]

# 5. A reply from another key: ignored, whatever it says.
reply "$U1" "$STRANGER" "Remove them"
guard
check "another key's Remove: exit 0" rc_is 0
check "another key's Remove: logged as ignored" out_has 'ignored a reply from another key'
check "another key's Remove: the settings file is as it was" [ "$(sha_of "$SETTINGS_F")" = "$before" ]
check "another key's Remove: nothing sent" [ "$(sends)" = 1 ]
check "another key's Remove: the message stays open" [ "$(alert_id unmade)" = "$U1" ]

# 6. The owner: something that is not an option, then Show me them.
reply "$U1" "$OWNER" "what are these?"
reply "$U1" "$OWNER" "Show me them"
guard
check "show: exit 0" rc_is 0
check "show: one message, in the thread" sh -c "[ $(sends) = 2 ] && tail -n 1 '$SENDS' | grep -q -- '--reply $U1'"
check "show: tags the owner" last_send_has "--mention $OWNER"
check "show: the head" msg_has "Here they are (2):"
check "show: each rule numbered, in a plain label" sh -c "grep -qF '1. Allows: \`$X1\`' '$MSG' && grep -qF '2. Blocks unless you ask: ' '$MSG'"
check "show: a backtick in a rule gets a longer fence" msg_has "\`\`$X2\`\`"
check "show: the settings file is as it was" [ "$(sha_of "$SETTINGS_F")" = "$before" ]
check "show: the message stays open" [ "$(alert_id unmade)" = "$U1" ]
check "show: the other reply is handled too, without a message" [ "$(state "len(s['alerts']['unmade']['handled'])")" = 2 ]
guard
check "show: shown once per reply" [ "$(sends)" = 2 ]
reply "$U1" "$OWNER" "@ghost show me them."
guard
check "show, asked again: shown again" [ "$(sends)" = 3 ]

# 7. A mutant without the owner check acts on the stranger's reply: the
# check in step 5 is what stops it.
MUT="$T/mutant"; mkdir -p "$MUT"
sed 's/            if r\["pubkey"\] != OWNER:/            if False:/' "$GUARD_SRC" >"$MUT/guard"; chmod +x "$MUT/guard"
check "mutant: the owner check is there to remove" sh -c "! cmp -s '$GUARD_SRC' '$MUT/guard'"
cp -R "$STATE_D" "$T/state.keep"; cp "$SETTINGS_F" "$T/settings.keep"
n="$(sends)"
GUARD_BIN="$MUT/guard" guard
check "mutant: the stranger's Remove takes the rules out (so step 5's checks would fail)" sh -c "! grep -qF 'nobody signed' '$SETTINGS_F'"
rm -rf "$STATE_D"; cp -R "$T/state.keep" "$STATE_D"; cp "$T/settings.keep" "$SETTINGS_F"; : >"$LEDGER_F"
head -n "$((n))" "$SENDS" >"$SENDS.t"; mv "$SENDS.t" "$SENDS"
before="$(sha_of "$SETTINGS_F")"

# 8. The owner's Keep: signed into the ledger, the settings as they are, a
# note in the thread, and nothing asked again.
reply "$U1" "$OWNER" "Keep them"; KEEP_ID="$LAST_REPLY"
reply "$U1" "$OWNER" "Remove them"   # a later answer: ignored
guard
check "keep: exit 0" rc_is 0
check "keep: the settings file is as it was" [ "$(sha_of "$SETTINGS_F")" = "$before" ]
check "keep: a ledger add line per rule, naming the reply" \
    [ "$(ledger_count "^- add \| autoMode\.(allow|soft_deny) \| expires never \| reply $KEEP_ID \| entry sha256 [0-9a-f]{16} \| ")" = 2 ]
check "keep: the note in the thread" sh -c "[ \"\$(cat '$MSG')\" = 'Done: I kept the 2 rules.' ] && tail -n 1 '$SENDS' | grep -q -- '--reply $U1'"
check "keep: the note tags nobody" sh -c "! tail -n 1 '$SENDS' | grep -q -- '--mention'"
check "keep: the message is closed" no_alert unmade
check "keep: the later Remove changed nothing" sh -c "grep -qF 'nobody signed' '$SETTINGS_F' && ! grep -q '^- remove' '$LEDGER_F'"
n="$(sends)"
guard
check "kept rules: never asked about again" sh -c "[ $RC = 0 ] && [ $(sends) = $n ]"

# 9. Applied twice (a state from before the answer): nothing changes again.
cp -R "$T/state.keep" "$T/state.again"
rm -rf "$STATE_D"; cp -R "$T/state.again" "$STATE_D"
lsum="$(sha_of "$LEDGER_F")"
guard
check "applied twice: the settings file is as it was" [ "$(sha_of "$SETTINGS_F")" = "$before" ]
check "applied twice: the ledger is as it was" [ "$(sha_of "$LEDGER_F")" = "$lsum" ]
check "applied twice: says there was nothing to do" msg_is "Nothing to do: those rules changed since I asked."

# 10. More rules of the same kind: one new message for all of them, and the
# old thread is no longer read.
settings allow "$A1" "$A2" "$X1" "$X3" soft_deny "$S1" "$S2" "$X2"
ledger add allow "$X1"
ledger add soft_deny "$X2"
guard
check "a new rule: one message" msg_is "$UNMADE1"
U2="$(alert_id unmade)"
settings allow "$A1" "$A2" "$X1" "$X3" "Yet another rule." soft_deny "$S1" "$S2" "$X2"
n="$(sends)"
guard
check "one more rule of the same kind: a new message for both" sh -c "[ $(sends) = $((n + 1)) ] && grep -qF 'I found 2 rules' '$MSG'"
U3="$(alert_id unmade)"
check "... with a new id" [ "$U3" != "$U2" ]
: >"$REPLIES"; reply "$U2" "$OWNER" "Keep it"
guard
check "a reply in the old thread: not read any more" sh -c "! grep -qF 'Yet another rule.' '$LEDGER_F' && ! grep -qF '$X3' '$LEDGER_F'"
check "... the thread read asks for the new root only" sh -c "tail -n 1 '$READS' | grep -q -- '--root $U3' && ! tail -n 1 '$READS' | grep -q -- '--root $U2'"

# 11. The owner's Remove (with a mention and a bullet): out of the live
# settings, everything else in the file kept, a backup of the lists only.
: >"$REPLIES"; reply "$U3" "$OWNER" "@ghost • Remove them!"
guard
check "remove: exit 0" rc_is 0
check "remove: both rules are out" sh -c "! grep -qF 'Yet another rule.' '$SETTINGS_F' && ! grep -qF '$X3' '$SETTINGS_F'"
check "remove: the other rules stay" sh -c "grep -qF '$A2' '$SETTINGS_F' && grep -qF '$S2' '$SETTINGS_F' && grep -qF '$X1' '$SETTINGS_F'"
check "remove: the env block, other keys and autoMode.environment stay" sh -c "grep -q '$ENV_MARK' '$SETTINGS_F' && grep -q '$OTHER_MARK' '$SETTINGS_F' && grep -q '$ENVIRONMENT_MARK' '$SETTINGS_F'"
check "remove: the file is still valid JSON" t_env python3 -I -c 'import json, sys; json.load(open(sys.argv[1]))' "$SETTINGS_F"
check "remove: ledger remove lines" [ "$(ledger_count '^- remove \| autoMode\.allow \| expires never \| reply ')" = 2 ]
check "remove: a backup with the three lists before and after" sh -c "f=\$(ls '$STATE_D'/backups/*.json | head -n 1); grep -qF 'Yet another rule.' \"\$f\" && grep -q '\"before\"' \"\$f\" && grep -q '\"after\"' \"\$f\""
check "remove: the backup never holds the rest of the file" sh -c "! grep -q '$ENV_MARK\\|$OTHER_MARK\\|$ENVIRONMENT_MARK' '$STATE_D'/backups/*.json"
check "remove: the backup is private" sh -c "ls -l '$STATE_D'/backups/*.json | cut -c1-10 | grep -qx -- '-rw-------'"
check "remove: the note" msg_is "Done: I removed the 2 rules."
check "remove: closed" no_alert unmade

# 12. Rules of the owner's that are gone: from the snapshot, and a ledger add
# not yet expired; an expired grant that is gone is not asked about.
reset_world
snapshot allow "$A1" "$A2" soft_deny "$S1" "$S2"
ledger add allow "$X1" "2099-01-01 00:00 +07"
ledger add allow "$X2" "2020-01-01 00:00 +07"
settings allow "$A1" soft_deny "$S1"
n="$(sends)"
guard
check "gone: one message" [ "$(sends)" = "$((n + 1))" ]
check "gone: the words, exactly, each rule quoted with where it is on record (two on main, one in the ledger)" msg_is "$GONE3"
check "gone: an expired grant that is gone is not counted" out_has "rules on record that are gone: 3"
G1="$(alert_id gone)"
reply "$G1" "$OWNER" "Keep them"   # not an option for this message
guard
check "gone: Keep is not an option here; nothing changes" sh -c "[ $RC = 0 ] && ! grep -qF '$A2' '$SETTINGS_F' && [ $(sends) = $((n + 1)) ]"
reply "$G1" "$OWNER" "Put them back"
guard
check "put back: exit 0" rc_is 0
put_back_ok() { live_has allow "$A2" && live_has soft_deny "$S2" && live_has allow "$X1"; }
check "put back: each rule in its list again" put_back_ok
check "put back: the expired grant stays out" sh -c "! grep -qF 'with a' '$SETTINGS_F'"
check "put back: ledger add lines" [ "$(ledger_count '^- add \| .* \| reply ')" = 3 ]
check "put back: a grant keeps the expiry it was signed with" ledger_has "- add | autoMode.allow | expires 2099-01-01 00:00 +07 | reply "
check "put back: a snapshot rule comes back with no expiry" ledger_has "- add | autoMode.allow | expires never | reply "
check "put back: the note" msg_is "Done: I put the 3 rules back."
check "put back: closed, and nothing to ask" no_alert gone

# 13. Leave them out: a remove line, the settings as they are, never asked again.
settings allow "$A1" soft_deny "$S1" "$S2"
snapshot allow "$A1" soft_deny "$S1" "$S2"
reset_world
settings allow "$A1" soft_deny "$S1"
guard
check "one gone rule: the singular" msg_is "$GONE1"
G2="$(alert_id gone)"
before="$(sha_of "$SETTINGS_F")"
reply "$G2" "$OWNER" "leave it out"
guard
check "leave out: the settings file is as it was" [ "$(sha_of "$SETTINGS_F")" = "$before" ]
check "leave out: a remove line" ledger_has "- remove | autoMode.soft_deny | expires never | reply "
check "leave out: the note" msg_is "Done: I left the rule out."
n="$(sends)"; guard
check "left out: never asked about again" sh -c "[ $RC = 0 ] && [ $(sends) = $n ]"

# 14. Put back where the list is missing: made as ["\$defaults", <rule>].
reset_world
snapshot allow "$A1" hard_deny "$S1"
settings allow "$A1"
guard
reply "$(alert_id gone)" "$OWNER" "put it back"
guard
# shellcheck disable=SC2016  # "$defaults" is Claude Code's own word, not a variable
check "put back into a missing list: [\"\$defaults\", <rule>]" t_env python3 -I -c '
import json, sys
assert json.load(open(sys.argv[1]))["autoMode"]["hard_deny"] == ["$defaults", sys.argv[2]]' "$SETTINGS_F" "$S1"

# 15. Fixed some other way while the message is open: closed quietly.
reset_world
snapshot allow "$A1"
settings allow "$A1" "$X1"
guard
n="$(sends)"
settings allow "$A1"
guard
check "fixed some other way: closed, nothing sent" sh -c "[ $RC = 0 ] && [ $(sends) = $n ] && grep -q 'nothing left to ask; closed' '$OUT'"
check "... the message is gone from the state" no_alert unmade

# 16. A rule with hidden characters: never signed by a reply.
reset_world
HID="$(printf 'A rule with a zero\342\200\213width space.')"
settings allow "$A1" "$HID"
guard
reply "$(alert_id unmade)" "$OWNER" "Keep it"
guard
check "hidden characters: no ledger line" sh -c "[ ! -s '$LEDGER_F' ]"
check "hidden characters: the note says so" [ "$(msg_n 1)" = "I left 1 rule as it is: it has hidden characters, so I'll ask again." ]
check "hidden characters: asked again" msg_is "$UNMADE1"
reply "$(alert_id unmade)" "$OWNER" "Show me"
guard
check "hidden characters: shown escaped, never raw" sh -c "grep -qF 'zero\\u200bwidth' '$MSG' && ! grep -q \"\$(printf '\\342\\200\\213')\" '$MSG'"
reply "$(alert_id unmade)" "$OWNER" "Remove it"
guard
check "hidden characters: Remove takes it out" sh -c "! grep -q 'zero' '$SETTINGS_F'"

# 17. The thread read fails: nothing applied, exit 1, tried again next run.
reset_world
settings allow "$A1" "$X1"
guard
reply "$(alert_id unmade)" "$OWNER" "Remove it"
echo 1 >"$T/state/read.rc"
guard
check "read fails: exit 1" rc_is 1
check "read fails: logged" out_has 'the replies were NOT read'
check "read fails: nothing changed" live_has allow "$X1"
echo 0 >"$T/state/read.rc"
guard
check "read works again: applied" sh -c "[ $RC = 0 ] && ! grep -qF '$X1' '$SETTINGS_F'"

# 18. The settings write is refused (a symlink): nothing changed, one note,
# exit 1, tried again; then it goes through.
reset_world
settings allow "$A1" "$X1"
guard
UA="$(alert_id unmade)"
reply "$UA" "$OWNER" "Remove it"
mv "$SETTINGS_F" "$T/home/.claude/real.json"; ln -s real.json "$SETTINGS_F"
n="$(sends)"
guard
check "write refused: exit 1" rc_is 1
check "write refused: logged, not applied" out_has 'was NOT applied: could not open the settings file to write'
check "write refused: the rule is still there" grep -qF "$X1" "$T/home/.claude/real.json"
check "write refused: one plain note" sh -c "[ $(sends) = $((n + 1)) ] && grep -qx \"I couldn't change the rules just now. I'll try again in a few minutes.\" '$MSG'"
guard
check "still refused: no second note" sh -c "[ $RC = 1 ] && [ $(sends) = $((n + 1)) ]"
rm "$SETTINGS_F"; mv "$T/home/.claude/real.json" "$SETTINGS_F"
guard
check "the write goes through next run" sh -c "[ $RC = 0 ] && ! grep -qF '$X1' '$SETTINGS_F'"

# 19. A send that fails: the state stays, the next run sends.
reset_world
settings allow "$A1" "$X1"
echo 1 >"$T/state/send.rc"
guard
check "send fails: exit 1" rc_is 1
check "send fails: logged" out_has 'message NOT sent'
check "send fails: nothing on record" no_alerts
echo 0 >"$T/state/send.rc"
guard
check "the next run sends" sh -c "[ $RC = 0 ] && grep -qF \"I found 1 rule you didn't make\" '$MSG'"

# 20. No owner set: the first sentence alone, and no reply is read.
reset_world
settings allow "$A1" "$X1"
n="$(reads)"
guard GP_GUARD_OWNER=
check "no owner: the first sentence alone" msg_is "I found 1 rule you didn't make. Another agent may have added it; I'm not sure."
check "no owner: tags only the mentions" last_send_has "--mention $KEY api_token="
guard GP_GUARD_OWNER=
check "no owner: no thread read" [ "$(reads)" = "$n" ]

# 21. An unwritable state folder: nothing goes out (it would every run).
reset_world
chmod 500 "$STATE_D"
if ( : >"$STATE_D/.w" ) 2>/dev/null; then
    rm -f "$STATE_D/.w"; ok "SKIP the unwritable state case (running as root)"
else
    n="$(sends)"
    guard
    check "unwritable state: exit 1" rc_is 1
    check "unwritable state: logged" out_has 'is not writable'
    check "unwritable state: no message" [ "$(sends)" = "$n" ]
fi
chmod 700 "$STATE_D"

# 22. Broken: the settings file missing. One plain message, exit 1, then
# quiet; the run that works again sends one all-clear.
reset_world
settings allow "$A1"
guard   # nothing to ask
mv "$SETTINGS_F" "$T/settings.away"
n="$(sends)"
guard
check "broken: exit 1" rc_is 1
check "broken: logged with the reason" out_has "the check could not run: settings file not found: $SETTINGS_F"
check "broken: one message" [ "$(sends)" = "$((n + 1))" ]
check "broken: plain words" msg_is "I can't check your rules right now, so I won't notice if they change. I'll tell you when I can again."
check "broken: the state is a hash" sh -c "grep -qE '\"check\": \"broken:[0-9a-f]{64}\"' '$STATE_D/state.json'"
guard
check "still broken: exit 1, no second message" sh -c "[ $RC = 1 ] && [ $(sends) = $((n + 1)) ]"
mv "$T/settings.away" "$SETTINGS_F"
guard
check "working again: one all-clear" sh -c "[ $(sends) = $((n + 2)) ] && [ \"\$(cat '$MSG')\" = 'I can check your rules again.' ]"
guard
check "clean twice: no second all-clear" [ "$(sends)" = "$((n + 2))" ]

# 23. Broken, then a rule to ask about: the question, no separate all-clear.
mv "$SETTINGS_F" "$T/settings.away"; guard; mv "$T/settings.away" "$SETTINGS_F"
settings allow "$A1" "$X1"
n="$(sends)"; guard
check "broken, then a rule: the question only" sh -c "[ $(sends) = $((n + 1)) ] && grep -qF \"I found 1 rule\" '$MSG'"
check "... and the check is ok again" [ "$(state "s['check']")" = ok ]

# 24. Broken: a ledger that can't be read, a snapshot or settings that are
# not JSON, or not lists of strings.
reset_world
settings allow "$A1"
: >"$LEDGER_F"; chmod 000 "$LEDGER_F"
if cat "$LEDGER_F" >/dev/null 2>&1; then
    ok "SKIP the unreadable ledger case (running as root)"
else
    guard
    check "an unreadable ledger: broken" sh -c "[ $RC = 1 ] && grep -q 'cannot read the ledger' '$OUT'"
fi
chmod 600 "$LEDGER_F"
printf '{"autoMode": {"allow": "not a list"}}\n' >"$SETTINGS_F"
guard
check "a list that is not a list: broken" out_has 'autoMode.allow is not a list of strings'
printf '{"autoMode": \n' >"$SETTINGS_F"
guard
check "settings that are not JSON: broken, the path and a position only" out_has "settings file is not valid JSON: $SETTINGS_F \\(line 2"
settings allow "$A1"

# 25. A ledger line whose entry sha256 does not match its rule: ignored.
reset_world
settings allow "$A1" "$X1"
printf -- '- add | autoMode.allow | expires never | draft x.md | entry sha256 0000000000000000 | %s\n' "$X1" >"$LEDGER_F"
guard
check "a ledger line that does not match: ignored, and said" sh -c "grep -q 'entry sha256 does not match' '$OUT' && grep -qF \"I found 1 rule\" '$MSG'"

# 26. The state file before this one: a broken check stays reported; any
# other value is dropped.
reset_world
settings allow "$A1"
mv "$SETTINGS_F" "$T/settings.away"
guard; reason_state="$(state "s['check']")"
rm -f "$STATE_D/state.json"; printf '%s\n' "$reason_state" >"$STATE_D/last-alert"
n="$(sends)"; guard
check "the old state file: a broken check stays reported" sh -c "[ $RC = 1 ] && [ $(sends) = $n ]"
mv "$T/settings.away" "$SETTINGS_F"
rm -f "$STATE_D/state.json"; printf 'drift:%064d\n' 3 >"$STATE_D/last-alert"
guard
check "the old state file: drift is dropped, nothing sent" sh -c "[ $RC = 0 ] && [ $(sends) = $n ]"
printf 'garbage\n' >"$STATE_D/state.json"
guard
check "a state file holding nothing usable: said, and started again" out_has 'holds nothing usable'
printf '{"version": 2, "check": "ok", "alerts": {}, "defaults": [[]]}\n' >"$STATE_D/state.json"
guard
check "a state whose list names are not names: nothing usable, never a crash" \
    sh -c "[ $RC = 0 ] && grep -q 'holds nothing usable' '$OUT' && ! grep -q 'the guard failed' '$OUT'"
rm -f "$STATE_D/state.json"; mkdir "$STATE_D/state.json"   # a state that can't be read at all
n="$(sends)"
guard
check "a state that can't be read: the broken check still goes out" \
    sh -c "[ $RC = 1 ] && [ $(sends) = $((n + 1)) ] && grep -qF \"I can't check your rules right now\" '$MSG'"
rmdir "$STATE_D/state.json"

# 27. A big Show me them: split under 30,000 bytes a message.
reset_world
t_env python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1]))
d["autoMode"]["allow"] += [f"Big rule {i:02d} " + "\U0001F600" * 2000 for i in range(12)]
open(sys.argv[1], "w").write(json.dumps(d, indent=2) + "\n")' "$SETTINGS_F"
guard
reply "$(alert_id unmade)" "$OWNER" "show me them"
n="$(sends)"; guard
check "a big show: more than one message" sh -c "[ $(sends) -gt $((n + 1)) ]"
check "a big show: each within 30,000 bytes" sh -c "for f in '$MSGS'/*.txt; do [ \$(wc -c <\"\$f\") -le 30000 ] || exit 1; done"
check "a big show: every rule shown" sh -c "[ \$(cat '$MSGS'/*.txt | grep -ao 'Big rule [0-9][0-9]' | sort -u | wc -l) = 12 ]"

# 27a. Only that message's rules: a rule that turns up after the message
# was posted is not touched by its answer, and is asked about on its own.
reset_world
settings allow "$A1" "$X1"
guard
UO="$(alert_id unmade)"
settings allow "$A1" "$X1" "$X2"
reply "$UO" "$OWNER" "Remove it"
guard
check "only that message's rules: its rule is removed" sh -c "! grep -qF '$X1' '$SETTINGS_F'"
check "only that message's rules: the later rule stays" grep -qF "nd new rule, with a" "$SETTINGS_F"
check "only that message's rules: the later rule gets its own question" msg_is "$UNMADE1"

# 27b. A rule that is not valid Unicode text (a lone surrogate): a broken
# check, reported in plain words, never a crash.
reset_world
printf '{"autoMode": {"allow": ["Allow one: reading logs on the test box.", "Bad \\ud800 rule"]}}\n' >"$SETTINGS_F"
n="$(sends)"
guard
check "a lone surrogate in a rule: exit 1" rc_is 1
check "a lone surrogate in a rule: a broken check, said in fixed words" out_has 'the check could not run: autoMode.allow rule 2 is not valid Unicode text'
check "a lone surrogate in a rule: never a traceback" out_lacks 'Traceback'
check "a lone surrogate in a rule: one plain message" sh -c "[ $(sends) = $((n + 1)) ] && grep -qF \"I can't check your rules right now\" '$MSG'"
guard
check "a lone surrogate in a rule: reported once" [ "$(sends)" = "$((n + 1))" ]

# 27c. A lone surrogate elsewhere in the file: Remove still works, and that
# text is kept as the same escape.
reset_world
printf '{"env": {"ODD": "x\\ud800y"}, "autoMode": {"allow": ["%s", "%s"]}}\n' "$A1" "$X1" >"$SETTINGS_F"
guard
reply "$(alert_id unmade)" "$OWNER" "remove it"
guard
check "a lone surrogate elsewhere: the answer is applied" sh -c "[ $RC = 0 ] && ! grep -qF '$X1' '$SETTINGS_F'"
check "a lone surrogate elsewhere: kept, as the same JSON" t_env python3 -I -c '
import json, sys
assert json.load(open(sys.argv[1]))["env"]["ODD"] == "x\ud800y"' "$SETTINGS_F"
check "a lone surrogate elsewhere: never a traceback" out_lacks 'Traceback'

# 27d. Anything the guard did not plan for: a broken check, reported once,
# the log naming the error's type only.
reset_world
settings allow "$A1"
n="$(sends)"
guard GP_GUARD_FAULT=classify
check "an unplanned error: exit 1" rc_is 1
check "an unplanned error: a broken check, by its type only" out_has 'the check could not run: the guard failed \(RuntimeError\)'
check "an unplanned error: never a traceback" out_lacks 'Traceback'
check "an unplanned error: one plain message" sh -c "[ $(sends) = $((n + 1)) ] && grep -qF \"I can't check your rules right now\" '$MSG'"
guard GP_GUARD_FAULT=classify
check "an unplanned error: reported once" sh -c "[ $RC = 1 ] && [ $(sends) = $((n + 1)) ]"
guard
check "the run after it works: the all-clear" sh -c "[ $RC = 0 ] && [ \"\$(cat '$MSG')\" = 'I can check your rules again.' ]"

# 27e. A ledger the manifest names that is not there: a broken check, never
# read as empty (which would make every signed rule look unsigned).
reset_world
settings allow "$A1" "$X1"
ledger add allow "$X1"
mv "$LEDGER_F" "$T/ledger.away"
guard
check "a named ledger that is gone: a broken check" sh -c "[ $RC = 1 ] && grep -q 'the ledger .* is not there' '$OUT'"
check "a named ledger that is gone: no question about the signed rule" sh -c "! grep -qF \"rule you didn't make\" '$MSG'"
mv "$T/ledger.away" "$LEDGER_F"
guard
check "the ledger back: nothing to ask" sh -c "[ $RC = 0 ] && grep -q 'nothing to ask about' '$OUT'"

# 27f. The settings file changes, or is replaced, between the guard's read
# and its write: nothing is written, one note, and the next run applies it.
for fault in settings-changed settings-replaced; do
    reset_world
    settings allow "$A1" "$X1"
    guard
    reply "$(alert_id unmade)" "$OWNER" "Remove it"
    n="$(sends)"
    guard GP_GUARD_FAULT="$fault"
    check "$fault: exit 1, not applied" sh -c "[ $RC = 1 ] && grep -q 'was NOT applied: the settings file changed while the guard ran' '$OUT'"
    check "$fault: the rule is still there" grep -qF "$X1" "$SETTINGS_F"
    check "$fault: no ledger line" [ ! -s "$LEDGER_F" ]
    check "$fault: one plain note" sh -c "[ $(sends) = $((n + 1)) ] && grep -qx \"I couldn't change the rules just now. I'll try again in a few minutes.\" '$MSG'"
    guard
    check "$fault: the next run applies it" sh -c "[ $RC = 0 ] && ! grep -qF '$X1' '$SETTINGS_F'"
done

# 27g. A write that fails halfway: the file is put back, byte for byte.
reset_world
settings allow "$A1" "$X1"
guard
reply "$(alert_id unmade)" "$OWNER" "Remove it"
before="$(sha_of "$SETTINGS_F")"
guard GP_GUARD_FAULT=write-fails
check "a write that fails: exit 1, said" sh -c "[ $RC = 1 ] && grep -q 'the settings write failed (a test.s fault); the file was put back' '$OUT'"
check "a write that fails: the file is as it was, byte for byte" [ "$(sha_of "$SETTINGS_F")" = "$before" ]
check "a write that fails: no ledger line" [ ! -s "$LEDGER_F" ]

# 27h. The settings change but the ledger lines fail: the rule is out, and
# the log says the lines were not written.
guard GP_GUARD_FAULT=ledger-fails
check "the ledger fails after the settings change: the rule is out" sh -c "[ $RC = 0 ] && ! grep -qF '$X1' '$SETTINGS_F'"
check "the ledger fails after the settings change: said" out_has 'the settings changed, but the ledger lines were NOT written'
check "a shorter file is cut to its size: no padding left" t_env python3 -I -c '
import sys
b = open(sys.argv[1], "rb").read()
assert b.endswith(b"}\n") and not b.endswith(b" }\n")' "$SETTINGS_F"

# 27i. The rules can't be read again after an answer: nothing more is asked
# that run, from rules that are out of date.
reset_world
settings allow "$A1" "$X1" "$X2"
guard
UR="$(alert_id unmade)"
reply "$UR" "$OWNER" "Remove them"
n="$(sends)"
guard GP_GUARD_FAULT=reload-fails
check "the read after an answer fails: exit 1" rc_is 1
check "the read after an answer fails: the answer is applied" sh -c "! grep -qF '$X1' '$SETTINGS_F'"
check "the read after an answer fails: only the note goes out, no new question" sh -c "[ $(sends) = $((n + 1)) ] && grep -q 'nothing more is asked this run' '$OUT'"

# 27j. A send that prints no event id counts as not sent: never a message
# whose thread can't be read.
reset_world
settings allow "$A1" "$X1"
touch "$T/state/no-id"
guard
check "no event id: exit 1, said" sh -c "[ $RC = 1 ] && grep -q 'no event id came back; it counts as NOT sent' '$OUT'"
check "no event id: nothing on record" no_alerts
rm -f "$T/state/no-id"
guard
check "no event id: the next run asks again" sh -c "[ $RC = 0 ] && [ -n \"\$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))[\"alerts\"][\"unmade\"][\"id\"])' '$STATE_D/state.json')\" ]"

# 27k. NaN or Infinity in the settings file: not JSON, so a broken check.
reset_world
printf '{"x": NaN, "autoMode": {"allow": ["%s"]}}\n' "$A1" >"$SETTINGS_F"
guard
check "NaN in the settings file: a broken check" sh -c "[ $RC = 1 ] && grep -q 'settings file is not valid JSON: .* (NaN or Infinity' '$OUT'"

# 27l. A number too large for a float (1e400): an answer that would write
# the file back is refused, and nothing is written.
reset_world
printf '{"someNumber": 1e400, "autoMode": {"allow": ["%s", "%s"]}}\n' "$A1" "$X1" >"$SETTINGS_F"
guard
reply "$(alert_id unmade)" "$OWNER" "Remove it"
before="$(sha_of "$SETTINGS_F")"
guard
check "1e400: the answer is refused, said" sh -c "[ $RC = 1 ] && grep -q \"a number the guard can't write back exactly; nothing was written\" '$OUT'"
check "1e400: the file is as it was" [ "$(sha_of "$SETTINGS_F")" = "$before" ]
check "1e400: the owner gets the plain note" msg_is "I couldn't change the rules just now. I'll try again in a few minutes."

# 27m. The backup can't be kept (a file where its folder goes): the answer
# is refused with the plain note, and nothing is written.
reset_world
settings allow "$A1" "$X1"
guard
reply "$(alert_id unmade)" "$OWNER" "Remove it"
rm -rf "$STATE_D/backups"; : >"$STATE_D/backups"
guard
check "no backup: refused, said, nothing written" sh -c "[ $RC = 1 ] && grep -q 'could not keep the backup in the state folder' '$OUT' && grep -qF '$X1' '$SETTINGS_F'"
check "no backup: the plain note, not a broken check" msg_is "I couldn't change the rules just now. I'll try again in a few minutes."
rm -f "$STATE_D/backups"

# 27n. The fault points do nothing without GP_TEST=1.
reset_world
settings allow "$A1"
guard GP_TEST= GP_GUARD_FAULT=classify GP_GUARD_SEND=
check "without GP_TEST, GP_GUARD_FAULT does nothing" sh -c "[ $RC = 0 ] && ! grep -q 'the guard failed' '$OUT'"

# 27o. A grant that expired but is still live (and not in the snapshot):
# asked about as expired but still live, never taken as signed; a grant
# still in force is not asked about.
EXPIRED1="I found 1 rule that expired but is still live.
1. Always blocks: \`$X3\`, line 1 of \`LEDGER.md\` gave it until 2020-01-01 00:00 +00
If you keep it, it won't have a time limit any more.
What would you like to do?
• Show me
• Keep it
• Remove it"
reset_world
snapshot allow "$A1"
settings allow "$A1" hard_deny "$X3"
ledger add hard_deny "$X3" "2099-01-01 00:00 +00"
n="$(sends)"
guard
check "a grant still in force: nothing asked" sh -c "[ $RC = 0 ] && [ $(sends) = $n ]"
reset_world
ledger add hard_deny "$X3" "2020-01-01 00:00 +00"
guard
check "an expired grant still live: exit 0" rc_is 0
check "an expired grant still live: one message" [ "$(sends)" = "$((n + 1))" ]
check "an expired grant still live: the rule quoted, with its time limit and ledger line" msg_is "$EXPIRED1"
check "an expired grant still live: counted" out_has "rules not on record: 0; rules on record that are gone: 0; expired but still live: 1"
check "an expired grant still live: tags the owner" last_send_has "--mention $OWNER"
reply "$(alert_id expired)" "$OWNER" "Keep it"
guard
check "an expired grant, kept: a ledger add with no time limit, naming the reply" \
    ledger_has "- add | autoMode.hard_deny | expires never | reply $LAST_REPLY | "
check "an expired grant, kept: the note says it has no time limit now" msg_is "Done: I kept the rule, with no time limit now."
n="$(sends)"; guard
check "an expired grant, kept: not asked about again" sh -c "[ $RC = 0 ] && [ $(sends) = $n ]"
reset_world
settings allow "$A1" "$X1" hard_deny "$X3"
ledger add hard_deny "$X3" "2020-01-01 00:00 +00"
ledger add allow "$X1" "2020-01-01 00:00 +00"
guard
check "two expired grants still live: the plural, exactly" msg_is "I found 2 rules that expired but are still live.
1. Allows: \`$X1\`, line 2 of \`LEDGER.md\` gave it until 2020-01-01 00:00 +00
2. Always blocks: \`$X3\`, line 1 of \`LEDGER.md\` gave it until 2020-01-01 00:00 +00
If you keep them, they won't have a time limit any more.
What would you like to do?
• Show me them
• Keep them
• Remove them"

# 27p. An expiry that can't be read (it passes the line's pattern, not the
# calendar) is invalid, never "never": a live rule is asked about as
# expired; a ledger-only rule that is gone is not on record; and Put back
# never copies it.
EXPIRED_BAD="I found 1 rule that expired but is still live.
1. Allows: \`$X1\`, line 1 of \`LEDGER.md\` gives it a time limit I can't read (\`2026-13-01 00:00 +00\`), so I count it as passed
If you keep it, it won't have a time limit any more.
What would you like to do?
• Show me
• Keep it
• Remove it"
reset_world
settings allow "$A1" "$X1"
ledger add allow "$X1" "2026-13-01 00:00 +00"
guard
check "an expiry that can't be read: asked about as expired, never taken as never" msg_is "$EXPIRED_BAD"
reply "$(alert_id expired)" "$OWNER" "Remove it"
guard
check "an expiry that can't be read: Remove takes the rule out" sh -c "[ $RC = 0 ] && ! grep -qF '$X1' '$SETTINGS_F'"
reset_world
snapshot allow "$A1" "$S2"
ledger add allow "$S2" "2026-13-01 00:00 +00"
ledger add allow "$X1" "2026-13-01 00:00 +00"
settings allow "$A1"
guard
check "an expiry that can't be read, gone: the snapshot's rule is asked about, the ledger-only rule is not on record" \
    sh -c "grep -qF '1 rule on record is gone' '$MSG' && grep -qF '$S2' '$MSG' && ! grep -qF '$X1' '$MSG'"
reply "$(alert_id gone)" "$OWNER" "put it back"
guard
check "an expiry that can't be read: Put back writes no time limit, never the one it can't read" \
    sh -c "grep -qF -- '- add | autoMode.allow | expires never | reply ' '$LEDGER_F' && [ \$(grep -c '2026-13-01' '$LEDGER_F') = 2 ]"

# 27q. "$defaults" gone from soft_deny, where the snapshot has it: always
# asked about, even with a ledger line that says it was taken out; Leave out
# writes no ledger line and it is asked about again while main holds it;
# Put back puts it first in its list.
DEF_LINE="1. Blocks unless you ask: \`\$defaults\` (Claude Code's built-in rules)"
ASK_ONE="What would you like to do?
• Show me
• Put it back
• Leave it out"
GONE_DEF="1 rule on record is gone. I'm not sure what removed it.
$DEF_LINE, $ON_MAIN
$ASK_ONE"
reset_world
snapshot allow "$A1" soft_deny "\$defaults" "$S1"
settings allow "$A1" soft_deny "\$defaults" "$S1"
n="$(sends)"; guard
check "\$defaults in place: nothing asked" sh -c "[ $RC = 0 ] && [ $(sends) = $n ]"
settings allow "$A1" soft_deny "$S1"
ledger remove soft_deny "\$defaults"   # a ledger line can't sign it away
guard
check "\$defaults gone from soft_deny: asked about, whatever the ledger says" msg_is "$GONE_DEF"
check "\$defaults gone from soft_deny: counted" out_has "rules on record that are gone: 1"
reply "$(alert_id gone)" "$OWNER" "Leave it out"
guard
check "\$defaults, Leave out: no ledger line from the reply" sh -c "[ $RC = 0 ] && ! grep -q '| reply ' '$LEDGER_F'"
check "\$defaults, Leave out: the note says why it will be asked again" \
    [ "$(msg_n 1)" = "Claude Code's built-in rules are in the saved copy of your rules on main, so I'll ask about them again until that copy changes." ]
check "\$defaults, Leave out while main has it: asked again" msg_is "$GONE_DEF"
reply "$(alert_id gone)" "$OWNER" "Put it back"
guard
# shellcheck disable=SC2016  # "$defaults" is Claude Code's own word, not a variable
check "\$defaults, Put back: first in its list again" t_env python3 -I -c '
import json, sys
assert json.load(open(sys.argv[1]))["autoMode"]["soft_deny"] == ["$defaults", sys.argv[2]]' "$SETTINGS_F" "$S1"
check "\$defaults, Put back: no ledger line for it" sh -c "! grep -q '| reply ' '$LEDGER_F'"
check "\$defaults, Put back: the note" msg_is "Done: I put the rule back."
n="$(sends)"; guard
check "\$defaults back: nothing more asked" sh -c "[ $RC = 0 ] && [ $(sends) = $n ]"
settings allow "$A1"   # soft_deny gone whole: "$defaults" and the rule with it
guard
reply "$(alert_id gone)" "$OWNER" "Put them back"
guard
# shellcheck disable=SC2016  # "$defaults" is Claude Code's own word, not a variable
check "\$defaults, Put back into a list gone whole: [\"\$defaults\", <rule>]" t_env python3 -I -c '
import json, sys
assert json.load(open(sys.argv[1]))["autoMode"]["soft_deny"] == ["$defaults", sys.argv[2]]' "$SETTINGS_F" "$S1"

# 27r. "$defaults" gone from a list the snapshot never had it in, but the
# live settings did when the guard looked before: asked about, and still
# open on the runs after (never closed as fixed); Leave out forgets the list.
reset_world
snapshot allow "$A1" soft_deny "$S1"
settings allow "$A1" soft_deny "\$defaults" "$S1"
n="$(sends)"; guard
check "\$defaults live, not in the snapshot: nothing asked, the list kept" \
    sh -c "[ $RC = 0 ] && [ $(sends) = $n ] && grep -q '\"defaults\": \\[\"soft_deny\"\\]' '$STATE_D/state.json'"
settings allow "$A1" soft_deny "$S1"
guard
check "\$defaults gone, seen live before: asked about" \
    msg_is "1 rule on record is gone. I'm not sure what removed it.
$DEF_LINE, it was in your settings when I looked before
$ASK_ONE"
guard
check "\$defaults gone, seen live before: still open the run after, never closed as fixed" \
    sh -c "[ $RC = 0 ] && [ $(sends) = $((n + 1)) ] && ! grep -q 'nothing left to ask' '$OUT'"
check "... its question still on record" [ "$(state "'gone' in s['alerts']")" = True ]
reply "$(alert_id gone)" "$OWNER" "leave it out"
guard
check "\$defaults seen live, Leave out: no ledger line" sh -c "[ $RC = 0 ] && ! grep -q '| reply ' '$LEDGER_F'"
check "\$defaults seen live, Leave out: the note" msg_is "Done: I left the rule out."
check "\$defaults seen live, Leave out: the list is forgotten" [ "$(state "s['defaults']")" = "[]" ]
n="$(sends)"; guard
check "\$defaults seen live, left out: never asked again" sh -c "[ $RC = 0 ] && [ $(sends) = $n ]"

# 27s. A gone question too big for one message: the rules that fit, each
# cut, then how many more and how to see them; the options last.
reset_world
t_env python3 -I -c '
import json, sys
d = {"allow": [sys.argv[2]] + [f"Big rule {i:02d} " + "\U0001F600" * 2000 for i in range(20)], "soft_deny": [], "hard_deny": []}
open(sys.argv[1], "w", encoding="utf-8").write(json.dumps(d, indent=2) + "\n")' "$SNAPF" "$A1"
commit
settings allow "$A1"
n="$(sends)"; guard
check "a big gone question: one message, within 30,000 bytes" sh -c "[ $(sends) = $((n + 1)) ] && [ \$(wc -c <'$MSG') -le 30000 ]"
check "a big gone question: says how many more, and how to see them" grep -qE '^…and [0-9]+ more: say Show me them to see them all\.$' "$MSG"
check "a big gone question: the options last" sh -c "tail -n 1 '$MSG' | grep -qx '• Leave them out'"
snapshot allow "$A1"
reset_world

# 27t. No question says who made a rule on record.
check "neutral words: no gone or expired question says \"you made\"" sh -c "! cat '$MSGS'/*.txt | grep -qF 'you made'"

# 28. Nothing the owner reads holds a technical word.
check "plain words: no auto-mode, guard, snapshot, allow list or settings.json in any message" \
    sh -c "! cat '$MSGS'/*.txt | grep -v '^[0-9]*\\. ' | grep -qiE 'auto-?mode|guard|snapshot|allow ?list|settings\\.json'"

# 29. The dry run: no credential, no read, no send, nothing written.
reset_world
settings allow "$A1" "$X1"
n="$(sends)"; r="$(reads)"
t_env GP_GUARD_NAME=instance GP_GUARD_REPO="$REPO" GP_GUARD_SNAPSHOT="$SNAP_REL" GP_GUARD_SETTINGS="$SETTINGS_F" \
    GP_GUARD_LEDGER="$LEDGER_F" GP_GUARD_OWNER="$OWNER" GP_GUARD_CHANNEL="$CHAN" GP_GUARD_SEND="$T/stubs/adapter-stub" \
    GP_GUARD_STATE="$STATE_D" GP_GUARD_RETRY_SECS=0 "$G/guard" --dry-run >"$OUT" 2>&1; RC=$?
cat "$OUT" >>"$ALL"
check "dry run: exit 0" rc_is 0
check "dry run: the message it would send" sh -c "grep -q '(dry run) would send to Buzz channel $CHAN' '$OUT' && grep -qF \"I found 1 rule you didn't make\" '$OUT'"
check "dry run: sends nothing, reads nothing" sh -c "[ $(sends) = $n ] && [ $(reads) = $r ]"
check "dry run: writes nothing" sh -c "[ ! -e '$STATE_D/state.json' ] && [ ! -s '$LEDGER_F' ]"

# 30. The test-only overrides need GP_TEST=1: without it the stand-in is not
# used, and with no node nothing goes out.
reset_world
n="$(sends)"
guard GP_TEST=
check "without GP_TEST, GP_GUARD_SEND is ignored: nothing reaches the stand-in" [ "$(sends)" = "$n" ]
check "without GP_TEST: the real adapter is tried, and node is missing" out_has "the adapter can't run: node is missing"

# 31. The snapshot as committed on main must be a plain file: a committed
# symlink, or a path through a committed folder symlink, is a broken check.
# A snapshot that is not JSON is too, and the reason names main:<path>.
reset_world
settings allow "$A1"
ln -s automode.json "$REPO/config/link.json"; ln -s config "$REPO/linkdir"; commit
n="$(sends)"
guard GP_GUARD_SNAPSHOT=config/link.json
check "a symlink on main: exit 1" rc_is 1
check "a symlink on main: refused" out_has 'the snapshot config/link.json is a symlink on main'
check "a symlink on main: reported once" [ "$(sends)" = "$((n + 1))" ]
guard GP_GUARD_SNAPSHOT=linkdir/automode.json
check "a path through a folder symlink on main: refused" out_has 'the snapshot linkdir/automode.json is not on main'
rm "$REPO/config/link.json" "$REPO/linkdir"; commit
printf 'not json\n' >"$SNAPF"; commit
guard
check "a snapshot on main that is not JSON: broken" out_has 'snapshot is not valid JSON: main:config/automode.json \(line 1, column 1\)'
guard
check "... reported once (the reason is the same each run)" out_has 'already reported, nothing sent'

# 32. The snapshot is read from main, never the working tree.
snapshot allow "$A1"
guard   # the all-clear
WIDE="Run any command at all without asking."
t_env python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1])); d["allow"].append(sys.argv[2])
open(sys.argv[1], "w").write(json.dumps(d, indent=2) + "\n")' "$SNAPF" "$WIDE"
n="$(sends)"
guard
check "a rule in the working tree only: nothing to ask" sh -c "[ $RC = 0 ] && [ $(sends) = $n ]"
commit
guard
check "the same rule committed on main: asked about as gone" sh -c "[ $(sends) = $((n + 1)) ] && grep -qF '1 rule on record is gone' '$MSG'"
snapshot allow "$A1"
guard

# 33. The branch main, never a tag named main; a partial clone never fetches.
reset_world
settings allow "$A1"
guard
git -C "$REPO" checkout -q -b side
t_env python3 -I -c '
import json, sys
d = json.load(open(sys.argv[1])); d["allow"].append(sys.argv[2])
open(sys.argv[1], "w").write(json.dumps(d, indent=2) + "\n")' "$SNAPF" "$WIDE"
commit; git -C "$REPO" checkout -q main; git -C "$REPO" tag main side
check "control: a bare main now names the hostile tag" \
    sh -c "[ \"\$(git -C '$REPO' rev-parse main 2>/dev/null)\" = \"\$(git -C '$REPO' rev-parse refs/tags/main)\" ]"
n="$(sends)"
guard
check "a tag named main: ignored (the branch is read)" sh -c "[ $RC = 0 ] && [ $(sends) = $n ]"
git -C "$REPO" tag -d main >/dev/null; git -C "$REPO" branch -D -q side
read -r gmaj gmin <<EOF
$(/usr/bin/git version 2>/dev/null | sed -n 's/^git version \([0-9]*\)\.\([0-9]*\).*/\1 \2/p')
EOF
if [ "${gmaj:-0}" -gt 2 ] || { [ "${gmaj:-0}" = 2 ] && [ "${gmin:-0}" -ge 44 ]; }; then
    BARE="$T/bare.git"; git clone -q --bare "$REPO" "$BARE"
    git -C "$BARE" config uploadpack.allowFilter true; git -C "$BARE" config uploadpack.allowAnySHA1InWant true
    PC="$T/partial"; git clone -q --filter=blob:none --no-checkout "file://$BARE" "$PC"
    oid="$(git -C "$PC" ls-tree refs/heads/main -- "$SNAP_REL" | awk '{ print $3 }')"
    check "control: the partial clone lacks the snapshot's blob" sh -c "[ -n '$oid' ] && ! GIT_NO_LAZY_FETCH=1 git -C '$PC' cat-file -e '$oid' 2>/dev/null"
    guard GP_GUARD_REPO="$PC"
    check "a partial clone: a broken check, not a fetch" sh -c "[ $RC = 1 ] && grep -q 'could not read the snapshot from main' '$OUT'"
    check "... the blob is still not there (nothing was fetched)" sh -c "! GIT_NO_LAZY_FETCH=1 git -C '$PC' cat-file -e '$oid' 2>/dev/null"
else
    echo "SKIP  the partial-clone case (/usr/bin/git here is older than 2.44, which ignores GIT_NO_LAZY_FETCH)"
fi

# 33b. DM task roots: with BUZZ_TASK_OPEN_EMOJI (the manifest's
# buzz_task_open_emoji), each question and each message that the check can't
# run gets the open state once it is sent and on record. The all-clear and
# the replies in a thread get none, a dry run sets none, and a failure to set
# it is logged and changes nothing.
tasks() { if [ -f "$TASKS" ]; then wc -l <"$TASKS" | tr -d ' '; else echo 0; fi; }
IMG="https://media.example.com/open.gif"
reset_world
settings allow "$A1" "$X1"
n="$(tasks)"; s="$(sends)"
guard
check "no task emoji: the question goes out without a state" sh -c "[ $RC = 0 ] && [ $(sends) = $((s + 1)) ] && [ $(tasks) = $n ]"
reset_world
s="$(sends)"
guard BUZZ_TASK_OPEN_EMOJI=open-loop BUZZ_TASK_OPEN_EMOJI_URL="$IMG"
T1="$(alert_id unmade)"
check "task emoji: the question is sent, exit 0" sh -c "[ $RC = 0 ] && [ $(sends) = $((s + 1)) ] && [ -n '$T1' ]"
check "task emoji: one task call, open on the event the send printed, with the emoji and the credentials" \
    grep -q "^argv=task set --channel $CHAN --id $T1 --state open emoji=open-loop url=$IMG api_token=match .* on_record=yes check=ok\$" "$TASKS"
check "task emoji: one call only" [ "$(tasks)" = "$((n + 1))" ]
check "task emoji: logged" out_has 'alert marked open \(a task root\)'
check "task emoji: the task record holds no token" sh -c "! grep -qF '$TOKEN' '$TASKS'"
n="$(tasks)"
guard BUZZ_TASK_OPEN_EMOJI=open-loop BUZZ_TASK_OPEN_EMOJI_URL="$IMG"
check "already asked: no second state" sh -c "[ $RC = 0 ] && [ $(tasks) = $n ]"
settings allow "$A1" "$X1" "$X2"
guard BUZZ_TASK_OPEN_EMOJI=⭕
T2="$(alert_id unmade)"
check "a new question for more rules: its own open state" \
    sh -c "[ '$T2' != '$T1' ] && [ $(tasks) = $((n + 1)) ] && tail -n 1 '$TASKS' | grep -q -- '--id $T2 --state open emoji=⭕ url= '"
n="$(tasks)"; s="$(sends)"
reply "$T2" "$OWNER" "Show me them"
guard BUZZ_TASK_OPEN_EMOJI=⭕
check "show me them: the rules in the thread, with no state" sh -c "[ $(sends) = $((s + 1)) ] && [ $(tasks) = $n ]"
reply "$T2" "$OWNER" "Keep them"
guard BUZZ_TASK_OPEN_EMOJI=⭕
check "keep: the note in the thread, with no state" sh -c "[ $(sends) = $((s + 2)) ] && [ $(tasks) = $n ] && grep -qF 'Done: I kept' '$MSG'"
# The task tool fails: logged; the question still counts as sent, so nothing
# is sent again and the state is not tried again.
reset_world
settings allow "$A1" "$X1"
n="$(tasks)"; s="$(sends)"; echo 4 >"$T/state/task.rc"
guard BUZZ_TASK_OPEN_EMOJI=⭕
check "the task tool fails: exit 0 all the same" rc_is 0
check "... the failure is logged" out_has 'alert NOT marked open: the task tool exited 4'
check "... one task call was tried" [ "$(tasks)" = "$((n + 1))" ]
check "... the question is on record" sh -c "[ -n \"$(alert_id unmade)\" ] && [ $(sends) = $((s + 1)) ]"
guard BUZZ_TASK_OPEN_EMOJI=⭕
check "... and the next run sends nothing again, and tries no state" sh -c "[ $(sends) = $((s + 1)) ] && [ $(tasks) = $((n + 1)) ]"
rm -f "$T/state/task.rc"
# A broken check: its message gets the state too, once the broken check is on
# record; the all-clear after it gets none.
reset_world
settings allow "$A1"
guard BUZZ_TASK_OPEN_EMOJI=⭕   # nothing to ask
mv "$SETTINGS_F" "$T/settings.away"
n="$(tasks)"; s="$(sends)"
guard BUZZ_TASK_OPEN_EMOJI=⭕
check "broken: exit 1, one message" sh -c "[ $RC = 1 ] && [ $(sends) = $((s + 1)) ]"
check "broken: marked open on the event the send printed, once the broken check was on record" \
    sh -c "[ $(tasks) = $((n + 1)) ] && tail -n 1 '$TASKS' | grep -q -- '--id $(printf '%064x' "$(cat "$T/state/count")") --state open .* check=broken\$'"
guard BUZZ_TASK_OPEN_EMOJI=⭕
check "still broken: no second message, no second state" sh -c "[ $RC = 1 ] && [ $(sends) = $((s + 1)) ] && [ $(tasks) = $((n + 1)) ]"
mv "$T/settings.away" "$SETTINGS_F"
guard BUZZ_TASK_OPEN_EMOJI=⭕
check "the all-clear: sent, with no state" sh -c "[ $RC = 0 ] && [ $(sends) = $((s + 2)) ] && [ $(tasks) = $((n + 1)) ]"
check "the all-clear: its words" msg_is "I can check your rules again."
# An error the guard did not plan for: its broken-check message gets the state too.
n="$(tasks)"; s="$(sends)"
guard BUZZ_TASK_OPEN_EMOJI=⭕ GP_GUARD_FAULT=classify
check "an unplanned error: one message, marked open once the broken check was on record" \
    sh -c "[ $RC = 1 ] && [ $(sends) = $((s + 1)) ] && [ $(tasks) = $((n + 1)) ] && tail -n 1 '$TASKS' | grep -q ' check=broken\$'"
guard BUZZ_TASK_OPEN_EMOJI=⭕   # the all-clear
check "... the all-clear after it: no state" sh -c "[ $RC = 0 ] && [ $(tasks) = $((n + 1)) ]"
# The dry run: no task call.
reset_world
settings allow "$A1" "$X1"
n="$(tasks)"
t_env GP_GUARD_NAME=instance GP_GUARD_REPO="$REPO" GP_GUARD_SNAPSHOT="$SNAP_REL" GP_GUARD_SETTINGS="$SETTINGS_F" \
    GP_GUARD_LEDGER="$LEDGER_F" GP_GUARD_OWNER="$OWNER" GP_GUARD_CHANNEL="$CHAN" GP_GUARD_SEND="$T/stubs/adapter-stub" \
    GP_GUARD_STATE="$STATE_D" GP_GUARD_RETRY_SECS=0 BUZZ_TASK_OPEN_EMOJI=⭕ "$G/guard" --dry-run >"$OUT" 2>&1; RC=$?
cat "$OUT" >>"$ALL"
check "dry run with a task emoji: no task call" sh -c "[ $RC = 0 ] && [ $(tasks) = $n ] && grep -qF \"I found 1 rule you didn't make\" '$OUT'"
reset_world

# 34. Usage and setup errors exit 2.
t_env "$G/guard" >"$OUT" 2>&1; RC=$?
check "no settings: exit 2" rc_is 2
t_env GP_GUARD_NAME=instance GP_GUARD_REPO="$REPO" GP_GUARD_SNAPSHOT="$SNAP_REL" "$G/guard" >"$OUT" 2>&1; RC=$?
check "no STATE_DIRECTORY and no --dry-run: exit 2" rc_is 2
t_env GP_GUARD_NAME=instance GP_GUARD_REPO="$REPO" GP_GUARD_SNAPSHOT=/etc/passwd STATE_DIRECTORY="$STATE_D" "$G/guard" >"$OUT" 2>&1; RC=$?
check "an absolute snapshot path: exit 2" rc_is 2
t_env GP_GUARD_NAME=instance GP_GUARD_REPO="$REPO" GP_GUARD_SNAPSHOT=../x.json STATE_DIRECTORY="$STATE_D" "$G/guard" >"$OUT" 2>&1; RC=$?
check "a snapshot path out of the repo: exit 2" rc_is 2
guard GP_GUARD_OWNER=abc
check "an owner that is not a key: exit 2" rc_is 2
guard GP_GUARD_LEDGER=relative/ledger.md
check "a relative ledger: exit 2" rc_is 2
guard GP_GUARD_LEDGER="$SETTINGS_F"
check "the settings file as the ledger: exit 2" rc_is 2
t_env "$G/guard" --bogus >"$OUT" 2>&1; RC=$?
check "an unknown option: exit 2" rc_is 2

# Never: the env block, another key, an environment line, the token.
OUT="$ALL"
check "nothing ever shows the env block" out_lacks "$ENV_MARK"
check "nothing ever shows another key" out_lacks "$OTHER_MARK"
check "nothing ever shows an environment line" out_lacks "$ENVIRONMENT_MARK"
check "nothing ever shows the token" out_lacks "$TOKEN"
OUT="$SENDS"; check "the adapter's record holds no token" out_lacks "$TOKEN"

# ---------------------------------------------------------------- the templates

t_new
for f in "$TPL" "$TIMER_TPL"; do check "${f##*/}: there" [ -f "$f" ]; done
for want in "User=@USER@" "NoNewPrivileges=yes" "ProtectSystem=strict" "ProtectHome=tmpfs" "PrivateTmp=yes" \
    "PrivateDevices=yes" "CapabilityBoundingSet=" "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6" \
    "StateDirectoryMode=0700" "UMask=0077" "ExecStart=@LIB@/guard" "BindPaths=-@HOME@/.claude/settings.json" "@LEDGER_PATHS@" \
    "Environment=GP_GUARD_LEDGER=@LEDGER@" "Environment=GP_GUARD_OWNER=@OWNER@" \
    "BindReadOnlyPaths=-@REPO@/.git" "BindReadOnlyPaths=-@NODE@" "@READ_PATHS@" "StateDirectory=ghost-protocol/@NAME@-automode-guard" \
    "Environment=PATH=/usr/bin:/bin" "Environment=GP_GUARD_REPO=@REPO@" "Environment=GP_GUARD_SNAPSHOT=@SNAPSHOT@" \
    "Environment=GP_GUARD_SEND_PATH=@HOME@/.local/bin:/usr/local/bin:/usr/bin:/bin" \
    "Environment=BUZZ_TASK_OPEN_EMOJI=@TASK_EMOJI@" "Environment=BUZZ_TASK_OPEN_EMOJI_URL=@TASK_EMOJI_URL@"; do
    if grep -qxF -- "$want" "$TPL"; then ok "service template: $want"; else bad "service template lacks: $want"; fi
done
check "service template: writable only the state folder, the settings file and the ledger" \
    sh -c "[ -z \"\$(grep -E '^(BindPaths|ReadWritePaths)=' '$TPL' | grep -vxF 'BindPaths=-@HOME@/.claude/settings.json')\" ]"
check "service template: never all of ~/.claude" sh -c "! grep -qE '^Bind(ReadOnly)?Paths=-?@HOME@/\\.claude/?\$' '$TPL'"
check "service template: no credential of its own (the drop-in names them)" sh -c "! grep -qE '^LoadCredential' '$TPL'"
check "service template: never root" sh -c "! grep -qE '^(User|Group)=root' '$TPL'"
check "timer template: every 15 minutes" grep -qx 'OnCalendar=\*:0/15' "$TIMER_TPL"
check "service template: the guard's PATH is root-only" sh -c "! grep -qE '^Environment=PATH=.*@HOME@' '$TPL'"
check "service template: never the snapshot file itself (it is read from main)" sh -c "! grep -q 'BindReadOnlyPaths=-@SNAPSHOT@' '$TPL'"
check "guard: #!/bin/bash" [ "$(head -n 1 "$GUARD_SRC")" = "#!/bin/bash" ]
check "guard: /usr/bin/python3, by its path" grep -qx 'PYTHON=/usr/bin/python3' "$GUARD_SRC"
check "guard: /usr/bin/git, by its path" grep -qx 'GIT = "/usr/bin/git"' "$GUARD_SRC"

# ---------------------------------------------------------------- the step

# An instance home with a manifest and its snapshot; a fake Buzz adapter with
# its dependencies "installed"; node 22 (a stub); Linux.
ag_world() {
    t_new; t_std_env
    t_stub systemctl; t_stub node; t_tool install
    t_tool python3 >/dev/null
    # shellcheck disable=SC2016  # the stub's own $1, written as is
    printf '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n' >"$T/stubs/uname"
    chmod +x "$T/stubs/uname"
    H="$T/home/work/instance"
    mkdir -p "$H/.ghost-protocol" "$H/config"
    { cat "$FIX/manifests/good-v1.toml"; printf '\n[automode_guard]\n'
      printf 'snapshot = "config/automode.json"\nbuzz_relay_url = "https://relay.example.com"\n'
      printf 'buzz_key_command = "~/bin/key"\nbuzz_channel = "%s"\nbuzz_mentions = ["%s"]\n' "$CHAN" "$KEY"
      printf 'read_paths = ["~/bin/key", "~/.local/bin"]\n'
      printf 'owner = "%s"\nledger = "~/ledger/LEDGER.md"\n' "$OWNER"; } >"$H/.ghost-protocol/instance.toml"
    mkdir -p "$T/home/ledger"
    printf '{"allow": [], "hard_deny": [], "soft_deny": []}\n' >"$H/config/automode.json"
    git -C "$H" init -q && git -C "$H" add -A && git -C "$H" commit -q -m one   # the snapshot on main
    mkdir -p "$T/home/.claude" "$T/home/bin"; printf '{"autoMode": {}}\n' >"$T/home/.claude/settings.json"
    printf '#!/bin/sh\n' >"$T/home/bin/key"; chmod +x "$T/home/bin/key"
    B="$T/buzz"; mkdir -p "$B/src" "$B/node_modules/nostr-tools" "$B/node_modules/@modelcontextprotocol/sdk"
    : >"$B/src/launch.mjs"; : >"$B/src/send.mjs"; printf '{}\n' >"$B/package.json"
    printf '{}\n' >"$B/node_modules/nostr-tools/package.json"; printf '{}\n' >"$B/node_modules/@modelcontextprotocol/sdk/package.json"
    mkdir -p "$T/etc/systemd/system" "$T/usrlib" "$T/varlib"
}
setup() {
    t_env GP_ETC="$T/etc" GP_LIBDIR="$T/usrlib" GP_VARLIB="$T/varlib" GP_GUARD_BUZZ_SRC="$B" GP_GUARD_STATE="$T/no-state" \
        "$SETUP" --home "$H" "$@" >"$OUT" 2>&1
    RC=$?
}
LIBD() { printf '%s' "$T/usrlib/ghost-protocol/instance/automode-guard"; }
UNITF() { printf '%s' "$T/etc/systemd/system/instance-automode-guard.service"; }
TIMERF() { printf '%s' "$T/etc/systemd/system/instance-automode-guard.timer"; }

# 1. The dry run: every check, nothing written, no sudo.
ag_world
before="$(t_snapshot)"
setup
check "dry run: exit 0" rc_is 0
check "dry run: PLAN" out_has 'PLAN +automode +would install the auto-mode guard'
check "dry run: would copy the guard root-owned" out_has "would copy the guard and the Buzz adapter to $(LIBD) \(root-owned\)"
check "dry run: would make the missing ledger" out_has "would make an empty ledger at $T/home/ledger/LEDGER.md \(0600, as $(id -un)\)"
check "dry run: would write the service" out_has "would write $(UNITF) \(as root\)"
check "dry run: would write the timer" out_has "would write $(TIMERF) \(as root\)"
check "dry run: would enable the timer" out_has 'would run: systemctl enable --now instance-automode-guard.timer'
check "dry run: says what the first run would do" out_has 'guard: nothing to ask about'
check "dry run: the service in full, its user shown" out_has "^    \\| User=$(id -un)\$"
check "dry run: the service in full, its root-only PATH" out_has '^    \| Environment=PATH=/usr/bin:/bin$'
check "dry run: the service in full, the repo's .git read-only" out_has '^    \| BindReadOnlyPaths=-.*/work/instance/\.git$'
check "dry run: the timer in full" out_has '^    \| OnCalendar=\*:0/15$'
check "dry run: notes the missing drop-in" out_has 'no drop-in in .*instance-automode-guard.service.d/'
check "dry run: no sudo" not_called sudo
check "dry run: no systemctl change" sh -c "! grep -qE '^systemctl (daemon-reload|enable|start|disable|stop) ' '$T/state/calls'"
check "dry run: nothing written" [ ! -e "$(UNITF)" ] && [ ! -e "$(LIBD)" ]
check "dry run: HOME unchanged" [ "$(t_snapshot)" = "$before" ]
check "dry run: no temp folder left" no_temp_left

# 2. --apply: the copy, the units, the reload, the timer, one run.
touch "$T/state/sudo.allow"
setup --apply --yes
check "apply: exit 0" rc_is 0
check "apply: DONE" out_has 'DONE +automode +installed, the timer running; its first run finished'
check "apply: the guard is copied" [ -x "$(LIBD)/guard" ] && cmp -s "$(LIBD)/guard" "$GUARD_SRC"
check "apply: no watch tool copied (the guard reads the rules itself)" [ ! -e "$(LIBD)/watch" ]
check "apply: the missing ledger is made, private" sh -c "[ -f '$T/home/ledger/LEDGER.md' ] && [ ! -s '$T/home/ledger/LEDGER.md' ] && ls -l '$T/home/ledger/LEDGER.md' | cut -c1-10 | grep -qx -- '-rw-------'"
check "apply: the adapter is copied with its dependencies" [ -f "$(LIBD)/buzz/src/send.mjs" ] && [ -f "$(LIBD)/buzz/node_modules/nostr-tools/package.json" ]
check "apply: nothing in the copy is group- or world-writable" sh -c "[ -z \"\$(find '$(LIBD)' -perm -020 -o -perm -002 | head -n 1)\" ]"
check "apply: the service is written" [ -f "$(UNITF)" ]
check "apply: the timer is written" [ -f "$(TIMERF)" ]
check "apply: sudo -n only (--yes)" sh -c "grep -q '^sudo -n ' '$T/state/calls' && ! grep -qE '^sudo [0-9]' '$T/state/calls'"
check "apply: daemon-reload" called "systemctl daemon-reload"
check "apply: the timer enabled and started" called "systemctl enable"
check "apply: one run, with the unit in place" grep -q '^systemctl start: unit in place' "$T/state/calls"
check "apply: no temp folder left" no_temp_left

# The rendered unit.
U="$(UNITF)"
check "unit: no placeholder left" sh -c "! grep -q '@[A-Z_]*@' '$U'"
check "unit: the user" grep -qx "User=$(id -un)" "$U"
check "unit: the instance repo, by its real path" grep -qx "Environment=GP_GUARD_REPO=$(cd "$H" && pwd -P)" "$U"
check "unit: the snapshot's path in it" grep -qx "Environment=GP_GUARD_SNAPSHOT=config/automode.json" "$U"
check "unit: the repo's .git, read-only" grep -qx "BindReadOnlyPaths=-$(cd "$H" && pwd -P)/.git" "$U"
check "unit: the guard's PATH is root-only" grep -qx "Environment=PATH=/usr/bin:/bin" "$U"
check "unit: the send's PATH" grep -qx "Environment=GP_GUARD_SEND_PATH=$T/home/.local/bin:/usr/local/bin:/usr/bin:/bin" "$U"
check "unit: the channel" grep -qx "Environment=GP_GUARD_CHANNEL=$CHAN" "$U"
check "unit: the mention" grep -qx "Environment=\"GP_GUARD_MENTIONS=$KEY\"" "$U"
check "unit: the owner" grep -qx "Environment=GP_GUARD_OWNER=$OWNER" "$U"
check "unit: the ledger's path" grep -qx "Environment=GP_GUARD_LEDGER=$T/home/ledger/LEDGER.md" "$U"
check "unit: the settings file and the ledger, read-write, one file each" \
    sh -c "grep -qx 'BindPaths=-$T/home/.claude/settings.json' '$U' && grep -qx 'BindPaths=-$T/home/ledger/LEDGER.md' '$U' && [ \$(grep -c '^BindPaths=' '$U') = 2 ]"
check "unit: the key command, quoted" grep -qx 'Environment="BUZZ_KEY_COMMAND=~/bin/key"' "$U"
check "unit: each read path, read-only" sh -c "grep -qx 'BindReadOnlyPaths=-$T/home/bin/key' '$U' && grep -qx 'BindReadOnlyPaths=-$T/home/.local/bin' '$U'"
check "unit: node by its path" grep -qx "Environment=GP_GUARD_NODE=$T/stubs/node" "$U"
check "unit: runs the root-owned copy" grep -qx "ExecStart=$(LIBD)/guard" "$U"
if command -v systemd-analyze >/dev/null 2>&1; then
    # A "<file>:<line>: ..." line about another unit (one the host ships, which
    # verify loads as a dependency, such as a newer systemd's notes on old
    # options there) is not about the rendered units, so it is left out.
    v="$(systemd-analyze verify "$U" "$(TIMERF)" 2>&1 | grep -vE 'is not executable: No such file|Failed to resolve unit specifiers|nonexistent|ProtectHome' \
        | awk -v u="$U" -v t="$(TIMERF)" '{ p = $0; sub(/:[0-9]+: .*/, "", p) } p == $0 || p == u || p == t' || true)"
    if [ -z "$v" ]; then ok "systemd-analyze verify: the rendered units are clean"; else bad "systemd-analyze verify: $v"; fi
    score="$(systemd-analyze security --offline=true "$U" 2>/dev/null | tail -n 1 | grep -oE '[0-9]+\.[0-9]+' | head -n 1)"
    if [ -n "$score" ] && awk -v s="$score" 'BEGIN { exit !(s <= 2.0) }'; then ok "systemd-analyze security: exposure $score (2.0 or less)"
    elif [ -z "$score" ]; then echo "SKIP  systemd-analyze security (no offline scoring here)"
    else bad "systemd-analyze security: exposure $score is over 2.0"; fi
else
    echo "SKIP  systemd-analyze (not installed here)"
fi

# 3. A second run changes nothing.
: >"$T/state/calls"
setup --apply --yes
check "second run: exit 0" rc_is 0
check "second run: OK" out_has 'OK +automode +installed and running'
check "second run: no root step" not_called sudo

# 4. A changed copy is put back.
chmod u+w "$(LIBD)/guard"; echo "# changed" >>"$(LIBD)/guard"
setup --apply --yes
check "a changed copy: DONE again" out_has 'DONE +automode'
check "a changed copy: put back" cmp -s "$(LIBD)/guard" "$GUARD_SRC"
check "a changed copy: no .new or .old left" [ ! -e "$(LIBD).new" ] && [ ! -e "$(LIBD).old" ]

# 5. --uninstall: a dry run first, then everything but the drop-in.
mkdir -p "$T/etc/systemd/system/instance-automode-guard.service.d"; : >"$T/etc/systemd/system/instance-automode-guard.service.d/instance.conf"
mkdir -p "$T/varlib/ghost-protocol/instance-automode-guard"; : >"$T/varlib/ghost-protocol/instance-automode-guard/last-alert"
setup --uninstall
check "uninstall dry run: exit 0, PLAN" sh -c "[ $RC = 0 ] && grep -q 'PLAN  automode  would remove the auto-mode guard' '$OUT'"
check "uninstall dry run: nothing removed" [ -f "$(UNITF)" ] && [ -d "$(LIBD)" ]
check "uninstall dry run: shows the leftovers of a failed apply" out_has "would run: rm -rf $(LIBD) $(LIBD).new $(LIBD).old"
check "uninstall dry run: shows the rmdir" out_has "would run: rmdir $T/usrlib/ghost-protocol/instance"
check "uninstall dry run: shows the reset-failed" out_has 'would run: systemctl reset-failed instance-automode-guard.service'
mkdir -p "$(LIBD).new" "$(LIBD).old"   # as a failed apply leaves them
setup --uninstall --apply --yes
check "uninstall: exit 0, DONE" sh -c "[ $RC = 0 ] && grep -q 'DONE  automode  removed the auto-mode guard' '$OUT'"
check "uninstall: the units are gone" [ ! -e "$(UNITF)" ] && [ ! -e "$(TIMERF)" ]
check "uninstall: the copy is gone" [ ! -e "$(LIBD)" ]
check "uninstall: a failed apply's .new and .old are gone" [ ! -e "$(LIBD).new" ] && [ ! -e "$(LIBD).old" ]
check "uninstall: the state is gone" [ ! -e "$T/varlib/ghost-protocol/instance-automode-guard" ]
check "uninstall: the instance's drop-in stays" [ -f "$T/etc/systemd/system/instance-automode-guard.service.d/instance.conf" ]
check "uninstall: the timer disabled" grep -q '^systemctl disable ' "$T/state/calls"

# 6. When the step skips, with the reason.
skip_case() {   # name pattern setup-command
    ag_world; eval "$3"; setup
    if [ "$RC" = 0 ] && out_has "$2"; then ok "$1"; else bad "$1"; fi
}
# Each case's set-up command is single-quoted on purpose: skip_case evals it.
# shellcheck disable=SC2016
{
skip_case "no [automode_guard]: SKIP" 'SKIP +automode +not set up: the manifest has no \[automode_guard\]' \
    'sed -i.bak "/^\[automode_guard\]/,\$d" "$H/.ghost-protocol/instance.toml"'
skip_case "enabled false: SKIP, with the commands that remove it" 'sudo systemctl disable --now instance-automode-guard.timer' \
    'printf "enabled = \"false\"\n" >>"$H/.ghost-protocol/instance.toml"'
skip_case "a key service: SKIP (its send would be a way to the key)" 'SKIP +automode +instance instance has a key service' \
    'mkdir -p "$T/etc/ghost-protocol/instance" && printf "%040d\n" 0 >"$T/etc/ghost-protocol/instance/commit"'
skip_case "macOS: SKIP" 'SKIP +automode +a systemd timer, for Linux' \
    'printf "#!/bin/sh\ncase \"\$1\" in -s) echo Darwin ;; -m) echo arm64 ;; *) echo Darwin ;; esac\n" >"$T/stubs/uname"'
skip_case "no snapshot on main: SKIP" 'SKIP +automode +the snapshot config/automode.json is not on main' \
    'git -C "$H" rm -q config/automode.json && git -C "$H" commit -q -m rm'
skip_case "the snapshot in the working tree only: SKIP" 'SKIP +automode +the snapshot config/automode.json is not on main' \
    'git -C "$H" rm -q --cached config/automode.json && git -C "$H" commit -q -m untrack'
skip_case "a symlink on main: SKIP" 'SKIP +automode +the snapshot config/automode.json is a symlink on main' \
    'mv "$H/config/automode.json" "$H/config/real.json"; ln -s real.json "$H/config/automode.json"; git -C "$H" add -A; git -C "$H" commit -q -m link'
skip_case "a path through a folder symlink on main, leading out: SKIP" 'SKIP +automode +the snapshot config/automode.json is not on main' \
    'mv "$H/config" "$T/outside-config"; ln -s "$T/outside-config" "$H/config"; git -C "$H" add -A; git -C "$H" commit -q -m link'
skip_case "MED 2: run as root: SKIP, never a root unit" 'SKIP +automode +this step runs as root; run the installer as the instance' \
    'printf "#!/bin/sh\nif [ \"\$1\" = -u ]; then echo 0; exit 0; fi\nexec /usr/bin/id \"\$@\"\n" >"$T/stubs/id"; chmod +x "$T/stubs/id"'
skip_case "MED 2: the home owned by someone else: SKIP" 'SKIP +automode +the instance repo .* is owned by .* \(uid [0-9]+\), not by .* \(uid 4242\)' \
    'printf "#!/bin/sh\nif [ \"\$1\" = -u ]; then echo 4242; exit 0; fi\nexec /usr/bin/id \"\$@\"\n" >"$T/stubs/id"; chmod +x "$T/stubs/id"'
skip_case "node 20: SKIP" 'SKIP +automode +node 20 is too old' 'echo 20 >"$T/state/node.major"'
skip_case "a ledger that is a symlink: SKIP" 'SKIP +automode +the ledger .*/ledger/LEDGER.md is a symlink' \
    'ln -s elsewhere.md "$T/home/ledger/LEDGER.md"'
skip_case "a ledger whose folder is not there: SKIP" "SKIP +automode +the ledger's folder .*/ledger is not there" \
    'rmdir "$T/home/ledger"'
skip_case "no node: SKIP" 'SKIP +automode +node is not installed' 'rm "$T/stubs/node"'
skip_case "the adapter's dependencies missing: SKIP" "SKIP +automode +the Buzz adapter's dependencies are not installed" 'rm -rf "$B/node_modules"'
skip_case "no systemctl: SKIP" 'SKIP +automode +no systemd here' 'rm "$T/stubs/systemctl"'
}
ag_world; touch "$T/state/sudo.allow"; touch "$T/state/automode.start-fails"
setup --apply --yes
check "a first run that fails: still DONE, with a warning" sh -c "[ $RC = 0 ] && grep -q 'its first run exited non-zero' '$OUT'"
ag_world; setup --apply --yes
check "no root (sudo refuses): SKIP, nothing written" sh -c "[ $RC = 0 ] && grep -qE 'SKIP +automode' '$OUT' && [ ! -e '$(UNITF)' ]"

# 7. --manifest: a preview only.
ag_world
cp "$H/.ghost-protocol/instance.toml" "$T/preview.toml"
setup --manifest "$T/preview.toml" --apply
check "--manifest with --apply: refused (exit 2)" rc_is 2
check "--manifest with --apply: says why" out_has '--manifest is for a preview dry run only'
setup --manifest "$T/preview.toml"
check "--manifest dry run: PREVIEW, PLAN" sh -c "[ $RC = 0 ] && grep -q 'PREVIEW' '$OUT' && grep -qE 'PLAN +automode' '$OUT'"
printf 'nonsense\n' >"$H/.ghost-protocol/instance.toml"
setup
check "a bad manifest: FAIL, exit 1" sh -c "[ $RC = 1 ] && grep -qE 'FAIL +manifest' '$OUT'"

# 8. The full installer's step 14 runs it too (dry run).
ag_world
cp "$H/.ghost-protocol/instance.toml" "$T/manifest.toml"
rm -rf "$T/home/work"
t_make_instance "$T/manifest.toml"
t_env GP_ETC="$T/etc" GP_LIBDIR="$T/usrlib" GP_GUARD_BUZZ_SRC="$B" "$SRC/install/install" --instance example/instance --yes --dry-run >"$OUT" 2>&1
RC=$?
check "installer, step 14: the auto-mode guard's line" out_has 'automode '

finish_tests
