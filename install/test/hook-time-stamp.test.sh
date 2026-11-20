#!/usr/bin/env bash
# hook-time-stamp.test.sh: hooks/time-stamp, the UserPromptSubmit hook that
# adds the current time: on by default, in the time_zone plugin option's zone,
# off with time_stamp=off, and never fooled by a zone name that is not one.
# Also checks the plugin's wiring (hooks/hooks.json against plugin.json).
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

HOOK="$SRC/hooks/time-stamp"
t_new
SYSPATH="/usr/bin:/bin:/usr/sbin:/sbin"
FORMAT='^Current time: [A-Z][a-z]{2} [0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2} [^ ]+ \(UTC[+-][0-9]{4}\)'

stamp() {   # stamp [VAR=value ...]: runs the hook with those variables only
    printf '{"hook_event_name":"UserPromptSubmit","prompt":"hi"}' \
        | env -i PATH="$SYSPATH" HOME="$T/home" LANG=C "$@" "$HOOK" >"$OUT" 2>"$T/err"
    RC=$?
}
one_line() { [ "$(wc -l <"$OUT" | tr -d ' ')" = 1 ]; }

# 1. On by default: one line, the format, exit 0, nothing on stderr.
stamp
check "default: exit 0" rc_is 0
check "default: one line" one_line
check "default: the format" out_has "$FORMAT"
check "default: nothing on stderr" [ ! -s "$T/err" ]

# 2. The time zone option.
stamp CLAUDE_PLUGIN_OPTION_TIME_ZONE=UTC
check "time_zone UTC: the zone is named" out_has ' UTC \(UTC\+0000\)$'
stamp CLAUDE_PLUGIN_OPTION_TIME_ZONE=Etc/GMT-7
check "time_zone Etc/GMT-7: seven hours ahead of UTC" out_has '\(UTC\+0700\)$'
# The hour may turn between the two date calls: one retry.
for _ in 1 2; do
    utc_hour="$(env -i TZ=UTC date +%H)"
    stamp CLAUDE_PLUGIN_OPTION_TIME_ZONE=Etc/GMT-7
    hour="$(sed -E 's/^Current time: ... [0-9-]+ ([0-9]{2}):.*/\1/' "$OUT")"
    [ "$(( (10#$utc_hour + 7) % 24 ))" = "$((10#$hour))" ] && break
done
check "time_zone Etc/GMT-7: the hour is UTC + 7" [ "$(( (10#$utc_hour + 7) % 24 ))" = "$((10#$hour))" ]
stamp CLAUDE_PLUGIN_OPTION_TIME_ZONE="  Etc/GMT-7  "
check "time_zone with spaces around it: trimmed" out_has '\(UTC\+0700\)$'
# The session's own TZ is used when the option is empty.
stamp TZ=Etc/GMT+5 CLAUDE_PLUGIN_OPTION_TIME_ZONE=
check "empty time_zone: the session's TZ" out_has '\(UTC-0500\)$'
stamp TZ=Etc/GMT+5 CLAUDE_PLUGIN_OPTION_TIME_ZONE=Etc/GMT-7
check "time_zone wins over the session's TZ" out_has '\(UTC\+0700\)$'

# 3. A name that is not a time zone here is not used, and the line says so.
for bad in Mars/Olympus_Mons ../../etc/passwd /etc/passwd America 'Etc/GMT-7;date' '.hidden' 'a//b'; do
    stamp TZ=UTC CLAUDE_PLUGIN_OPTION_TIME_ZONE="$bad"
    if rc_is 0 && one_line && out_has "$FORMAT" && out_has ' UTC \(UTC\+0000\) \(the time zone setting ' ; then
        ok "time_zone '$bad': not used, and the line says so"
    else
        bad "time_zone '$bad'"
    fi
done

# 4. Off: no line at all.
for v in off OFF false no 0 " off "; do
    stamp CLAUDE_PLUGIN_OPTION_TIME_STAMP="$v"
    if rc_is 0 && [ ! -s "$OUT" ]; then ok "time_stamp='$v': no line"; else bad "time_stamp='$v' printed"; fi
done
for v in on yes "" anything; do
    stamp CLAUDE_PLUGIN_OPTION_TIME_STAMP="$v"
    check "time_stamp='$v': the default, a line" out_has "$FORMAT"
done

# 5. The plugin's wiring: every hook in hooks/hooks.json runs a file that is
#    there and executable (its first word; the reply guard's record mode takes
#    an argument), every switch in plugin.json is on by default, except
#    unattended mode, which is off.
if t_tool jq; then
    t_env jq -e . "$SRC/hooks/hooks.json" >/dev/null 2>&1
    check "hooks.json is valid JSON" [ $? = 0 ]
    missing="" n=0
    while IFS= read -r c; do
        n=$((n + 1))
        f="$(printf '%s' "$c" | sed -e 's/^"\([^"]*\)".*$/\1/' -e "s#^\${CLAUDE_PLUGIN_ROOT}#$SRC#")"
        [ -x "$f" ] || missing="$missing $c"
    done <<EOF
$(t_env jq -r '.hooks[][].hooks[].command' "$SRC/hooks/hooks.json")
EOF
    check "every hook command is an executable file in the plugin" [ -z "$missing" ]
    check "hooks.json wires the fifteen hook commands" [ "$n" = 15 ]
    # shellcheck disable=SC2016  # the command is text, as hooks.json holds it
    check "turn-state runs at UserPromptSubmit, Stop and StopFailure (a turn an API error ended)" \
        [ "$(t_env jq -r '[.hooks | to_entries[] | select(any(.value[].hooks[]; .command == "\"${CLAUDE_PLUGIN_ROOT}/hooks/turn-state\"")) | .key] | sort | join(",")' "$SRC/hooks/hooks.json")" = "Stop,StopFailure,UserPromptSubmit" ]
    # shellcheck disable=SC2016  # the command is text, as hooks.json holds it
    check "the reply guard's record runs on the Buzz send and react tools and the channel's task tool, as record" \
        [ "$(t_env jq -r '.hooks.PostToolUse[] | select(.matcher == "^mcp__.*(buzz__(send|react)|buzz-channel__task)$") | .hooks[].command' "$SRC/hooks/hooks.json")" = '"${CLAUDE_PLUGIN_ROOT}/adapters/buzz/hooks/reply-guard" record' ]
    # shellcheck disable=SC2016  # the command is text, as hooks.json holds it
    check "the root limit runs before the Buzz send tool, alone" \
        [ "$(t_env jq -r '.hooks.PreToolUse[] | select(.matcher == "^mcp__.*buzz__send$") | .hooks[].command' "$SRC/hooks/hooks.json")" = '"${CLAUDE_PLUGIN_ROOT}/adapters/buzz/hooks/root-limit"' ]
    v="$(t_env jq -r '[.userConfig | (.root_limit_lines, .root_limit_chars, .root_limit_exempt, .root_limit_channels) | .default] | join(",")' "$SRC/.claude-plugin/plugin.json")"
    check "plugin.json: the root limit's numbers and lists are empty by default (the hook's own defaults)" [ "$v" = ",,," ]
    v="$(t_env jq -r '.userConfig.unattended | "\(.default) \(.options | join(","))"' "$SRC/.claude-plugin/plugin.json")"
    check "plugin.json: unattended is on/off, off by default (an attended instance is unchanged)" [ "$v" = "off on,off" ]
    for k in time_stamp auto_pull chrome_guard reply_guard root_limit automode_drift memory_backup; do
        # shellcheck disable=SC2016  # $k is jq's variable
        v="$(t_env jq -r --arg k "$k" '.userConfig[$k] | "\(.default) \(.options | join(","))"' "$SRC/.claude-plugin/plugin.json")"
        check "plugin.json: $k is on/off, on by default" [ "$v" = "on on,off" ]
    done
    v="$(t_env jq -r '.userConfig.load_proof | "\(.default) \(.options | join(","))"' "$SRC/.claude-plugin/plugin.json")"
    check "plugin.json: load_proof is on/off, off by default (a fleet's settings turn it on)" [ "$v" = "off on,off" ]
    # shellcheck disable=SC2016  # the command is text, as hooks.json holds it
    check "load-proof runs at SessionStart, next to the auto-mode drift check and the session id" \
        [ "$(t_env jq -r '.hooks.SessionStart[].hooks[].command' "$SRC/hooks/hooks.json" | tr '\n' ' ')" = '"${CLAUDE_PLUGIN_ROOT}/hooks/automode-drift" "${CLAUDE_PLUGIN_ROOT}/hooks/session-id" "${CLAUDE_PLUGIN_ROOT}/hooks/load-proof" ' ]
    check "hooks.json gives load-proof 10 seconds" [ "$(t_env jq -r '.hooks.SessionStart[].hooks[] | select(.command | endswith("/hooks/load-proof\"")) | .timeout' "$SRC/hooks/hooks.json")" = 10 ]
    v="$(t_env jq -r '.userConfig.load_proof_channel | "[\(.default)] \(has("options"))"' "$SRC/.claude-plugin/plugin.json")"
    check "plugin.json: load_proof_channel is a free text, empty by default (file only)" [ "$v" = "[] false" ]
    v="$(t_env jq -r '.userConfig.reply_guard_helpers | "[\(.default)] \(has("options"))"' "$SRC/.claude-plugin/plugin.json")"
    check "plugin.json: reply_guard_helpers is a free list, empty by default" [ "$v" = "[] false" ]
    # The relay, key command and channels are needed only without a key
    # service (buzz_key_socket), so no option is required.
    n="$(t_env jq '[.userConfig[] | select(.required == true)] | length' "$SRC/.claude-plugin/plugin.json")"
    check "plugin.json: no option is required" [ "$n" = 0 ]
    v="$(t_env jq -r '[.userConfig | (.buzz_relay_url, .buzz_key_command, .buzz_channels, .buzz_key_socket) | .default] | join(",")' "$SRC/.claude-plugin/plugin.json")"
    check "plugin.json: the Buzz connection options are empty by default" [ "$v" = ",,," ]
else
    echo "SKIP  the wiring checks (no jq on this machine)"
fi

finish_tests
