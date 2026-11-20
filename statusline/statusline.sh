#!/bin/bash
# statusline.sh: GHOST Protocol's status line for Claude Code. Claude Code runs
# it with the session's data as JSON on stdin and shows the two lines it prints.
# statusline/README.md says what each part means and how it is wired.
#
# Statusline-ID: ghost-protocol
#   ^ statusline/wire knows this status line by this line. Keep it.
#
#   1. branch ◆ folder ◆ model ◆ context bar and % ◆ EFF effort
#   2. name ▸ ┄┄ 「 quote 」 ┄┄ ◆ BKK hh:mm │ EST hh:mm │ PST hh:mm │ <zone> hh:mm
#
# - The folder is the full path, never shortened with ~.
# - The model is its name with its version, such as "Opus 5.5".
# - The context bar fills toward the point where Claude Code compacts the
#   conversation, not toward the whole context window: a full bar means
#   compaction is due. The README explains how that point is found.
# - The last clock is this machine's own time, labelled with its time zone.
# - The name, its glitch animation and the quotes are instance settings, read
#   from ${XDG_CONFIG_HOME:-~/.config}/ghost-protocol/statusline/config.json.
#   Without that file the name is GHOST, it does not animate, and there is no
#   quote.
#
# Needs bash 3.2 or later, jq and date; git for the branch.
#
# A status line command must never write to stderr or exit non-zero, or Claude
# Code may show nothing. So stderr goes nowhere, and set -e is never used.

set +e
exec 2>/dev/null

input=$(cat)

if ! command -v jq >/dev/null 2>&1; then
    printf '\033[2;37m%s\033[0m\n' "status line: install jq to see it"
    exit 0
fi

# ---------------------------------------------------------------- the time

now=$(date '+%S %M %H:%M %Z' 2>/dev/null)
read -r now_s now_m srv_time srv_zone <<< "$now"
case "$now_s" in ''|*[!0-9]*) now_s=0 ;; esac
case "$now_m" in ''|*[!0-9]*) now_m=0 ;; esac
sec=$((10#$now_s))
min=$((10#$now_m))

# ---------------------------------------------------------------- the data
#
# One jq program reads the session's JSON, the settings files that can set the
# auto-compact window, and the instance settings. It prints one line of fields
# separated by the unit separator (\037): folder, model, percent, effort, the
# coloured name, the quote. It reads only the keys it needs, and strips control
# characters from every text it passes on.

# shellcheck disable=SC2016  # the jq program names jq's own $variables
PROG='
def clean: tostring | explode | map(select((. >= 32 and . < 127) or . > 159)) | implode;
def get(f): (try f catch null) // "";
def num: if type == "number" then . else 0 end;
def isnum: type == "string" and length > 0 and (explode | all(. >= 48 and . <= 57));
def truthy: (. // "" | ascii_downcase) as $v | ($v == "1" or $v == "true" or $v == "yes" or $v == "on");

# A model id as its canonical name: "us.anthropic.claude-opus-5-5-v1:0",
# "claude-opus-5-5[1m]" and "claude-opus-5-5@20260101" all become
# "claude-opus-5-5"; a date at the end ("-20250929") goes too.
def canon:
  if . == "" then "" else
    (split("claude-") | if length > 1 then "claude-" + (.[1:] | join("claude-")) else .[0] end)
    | (split("[") | .[0]) | (split("@") | .[0]) | (split(":") | .[0])
    | split("-")
    | (if length > 3 and (.[-1] | startswith("v")) and (.[-1][1:] | isnum) then .[:-1] else . end)
    | (if length > 1 and (.[-1] | isnum) and (.[-1] | length) == 8 then .[:-1] else . end)
    | join("-")
  end;

# The version in a canonical name: "claude-opus-5-5" -> "5.5",
# "claude-3-5-sonnet" -> "3.5"; "" when there is none.
def version:
  split("-") as $p
  | if ($p | length) < 3 or $p[0] != "claude" then ""
    elif ($p[1] | isnum) then [$p[1:][] | select(isnum)] | .[:2] | join(".")
    else $p[2:] | if length <= 2 and all(isnum) then join(".") else "" end
    end;

# autoCompactWindow in a settings file: tokens, "auto", or null when unusable.
def setting_window:
  if type == "number" and . >= 100000 and . <= 1000000 then floor
  elif . == "auto" then "auto"
  else null end;

# CLAUDE_CODE_AUTO_COMPACT_WINDOW: tokens, or null when unset or unusable. A
# number may end in k or M; below 100000 counts as 100000, above 1000000 as
# 1000000. (. * 0 == 0 is false for NaN and infinity.)
def tokens_of($s; $mul): ($s | tonumber? // null) | if . == null then null else . * $mul end;
def env_window:
  (. // "" | tostring | ascii_downcase) as $v
  | (if $v == "" then null
     elif ($v | endswith("k")) then tokens_of($v[:-1]; 1000)
     elif ($v | endswith("m")) then tokens_of($v[:-1]; 1000000)
     else tokens_of($v; 1) end)
  | if . == null or (. * 0 == 0 | not) then null
    elif . < 100000 then 100000
    elif . > 1000000 then 1000000
    else floor end;

def esc($code; $s): "\u001b[" + $code + "m" + $s + "\u001b[0m";

. as $in
| ($in | get(.model.id) | clean) as $id
| ($id | canon) as $cm

# The settings files, highest first: managed (its drop-ins, last first, then
# managed-settings.json), the --settings file, project local, project, user.
| ([$m0[0], $m1[0], $m2[0], $m3[0], $m4[0], $m5[0], $m6[0], $m7[0], $flag[0], $local[0], $project[0], $user[0]]
   | map(select(type == "object"))) as $files

# ---- the context bar
| ($in | try .context_window catch {} | if type == "object" then . else {} end) as $cw
| ($cw.context_window_size | num) as $size
# The last request: its input (cached input too) and its reply. current_usage
# is the breakdown of that request; the totals are the same sum.
| ($cw.current_usage | if type == "object"
     then (.input_tokens | num) + (.cache_creation_input_tokens | num)
          + (.cache_read_input_tokens | num) + (.output_tokens | num)
     else null end) as $cu
| ($cu // (($cw.total_input_tokens | num) + ($cw.total_output_tokens | num))) as $tokens
| $cw.used_percentage as $used
| ([$files[] | select(has("autoCompactEnabled")) | .autoCompactEnabled] | .[0]) as $ace
| (($dac | truthy) or ($dc | truthy) or $ace == false) as $off
| (($acw | env_window)
   // first($files[] | (.modelSettings[$cm]?.autoCompactWindow?, .autoCompactWindow?)
             | setting_window | select(. != null))
   // "auto") as $w0
| (if $w0 == "auto" then $size else $w0 end) as $w1
| (if $size > 0 and $w1 > $size then $size else $w1 end) as $win
# Claude Code keeps up to 20000 tokens free for the reply, and compacts 13000
# before that: at the window minus 33000. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE (a
# percent from 1 to 100 of the window less the reply) can only bring it earlier.
| ($win - 20000) as $eff
| ((try ($pco | tonumber) catch null)
   | if . != null and . * 0 == 0 and . > 0 and . <= 100 then . else null end) as $pc
| (if $pc == null then $eff - 13000
   else [($eff * $pc / 100 | floor), $eff - 13000] | min end) as $point
| (if ($used | type) != "number" then ""
   elif $off or $point <= 0 then [$used, 100] | min | floor | tostring
   else [($tokens * 100 / $point | floor), 100] | min | tostring end) as $pct

# ---- the model
| ($in | get(.model.display_name) | clean
   | if endswith(")") then (split(" (") | .[0]) else . end) as $dn
| ($cm | version) as $ver
| (if ($dn | explode | any(. >= 48 and . <= 57)) then $dn
   elif $dn != "" and $ver != "" then $dn + " " + $ver
   elif $dn != "" then $dn
   else $id end) as $model

# ---- the folder and the effort
| ($in | get(.workspace.current_dir) | clean
   | if . == "" then ($in | get(.cwd) | clean) else . end) as $cwd
| ($in | get(.effort.level) | clean) as $effort
| ($branch | clean) as $br

# ---- the name, its glitch and the quote (instance settings)
| ($cfg[0] | if type == "object" then . else {} end) as $c
| ($c.name // "" | clean) as $nm
| ((if $nm == "" then "GHOST" else $nm end | explode | map([.] | implode)) + [" ", "▸"]) as $pre
| ($c.glitch // "" | clean | explode | map([.] | implode)) as $gl
| ($pre | length) as $n
| (if ($gl | length) == $n then $sec % ($n + 1) else 0 end) as $frame
| ([range(0; $n) as $i
    | if $i < $frame then (if $gl[$i] == " " then " " else esc("1;32"; $gl[$i]) end)
      elif $i == $n - 1 then esc("2;35"; $pre[$i])
      elif $pre[$i] == " " then " "
      elif ($pre[$i] | explode | .[0]) > 127 then esc("1;35"; $pre[$i])
      else esc("1;36"; $pre[$i]) end] | join("")) as $prefix
| ($c.quotes | if type == "array" then map(clean | select(. != "")) else [] end) as $qs
| (if ($qs | length) > 0 then $qs[$minute % ($qs | length)] else "" end) as $quote

| [$cwd, $model, $pct, $effort, $prefix, $quote, $br, "."] | join("\u001f")
'

# Where the session works, and the folder Claude Code was started in (the
# project settings live there).
where=$(printf '%s' "$input" | jq -r '[(.workspace.current_dir // .cwd // ""), (.workspace.project_dir // .cwd // "")]
    | map(tostring) | join("\u001f")' 2>/dev/null)
IFS=$'\037' read -r here project <<< "$where"
branch=""
[ -n "$here" ] && branch=$(git -C "$here" branch --show-current 2>/dev/null)

# The settings files that can set the auto-compact window, as Claude Code finds
# them. The project local file sits at the repository's root, and for a
# worktree at its main checkout's root (the folder above the shared .git).
f_user="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/settings.json"
f_flag="${GP_CLAUDE_SETTINGS:-}"   # the --settings file install/service/start passes
f_local="" f_project=""
if [ -n "$project" ]; then
    f_project="$project/.claude/settings.json"
    common=$(git -C "$project" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
    case "$common" in
        /*/.git) f_local="${common%/.git}/.claude/settings.local.json" ;;
        *)       f_local="$project/.claude/settings.local.json" ;;
    esac
fi
# Managed settings: managed-settings.json, then managed-settings.d/*.json in
# name order, the last one winning; kept here highest first, at most 8 of them.
# (MDM and server-managed settings cannot be read.)
managed_dir=""
for d in "/Library/Application Support/ClaudeCode" /etc/claude-code; do
    if [ -d "$d" ]; then managed_dir="$d"; break; fi
done
[ "${GP_TEST:-}" = "1" ] && managed_dir="${GP_TEST_MANAGED_DIR:-}"   # the tests' own
managed=()
if [ -n "$managed_dir" ]; then
    for f in "$managed_dir"/managed-settings.d/*.json; do
        [ -f "$f" ] && managed=("$f" "${managed[@]}")
    done
    [ -f "$managed_dir/managed-settings.json" ] && managed+=("$managed_dir/managed-settings.json")
fi
config="${XDG_CONFIG_HOME:-$HOME/.config}/ghost-protocol/statusline/config.json"

base_args() {
    args=(--argjson sec "$sec" --argjson minute "$min" --arg branch "$branch"
          --arg acw "${CLAUDE_CODE_AUTO_COMPACT_WINDOW-}" --arg pco "${CLAUDE_AUTOCOMPACT_PCT_OVERRIDE-}"
          --arg dac "${DISABLE_AUTO_COMPACT-}" --arg dc "${DISABLE_COMPACT-}")
}
usable() {   # path [check]: a readable file; with check, also one jq can read
    [ -n "$1" ] && [ -f "$1" ] && [ -r "$1" ] && { [ -z "${2:-}" ] || jq empty "$1" >/dev/null 2>&1; }
}
add_file() {   # name path [check]: the file's JSON as $name, or an empty list
    if usable "$2" "${3:-}"; then args+=(--slurpfile "$1" "$2"); else args+=(--argjson "$1" '[]'); fi
}
add_managed() {   # [check]: the managed files, highest first, as $m0 to $m7
    local f i=0
    for f in "${managed[@]}"; do
        [ "$i" -lt 8 ] || break
        if usable "$f" "${1:-}"; then args+=(--slurpfile "m$i" "$f"); i=$((i + 1)); fi
    done
    while [ "$i" -lt 8 ]; do args+=(--argjson "m$i" '[]'); i=$((i + 1)); done
}
render() { printf '%s' "$input" | jq -r "${args[@]}" "$PROG" 2>/dev/null; }

base_args
add_managed; add_file flag "$f_flag"; add_file local "$f_local"; add_file project "$f_project"
add_file user "$f_user"; add_file cfg "$config"
out=$(render)
if [ -z "$out" ]; then
    # A file that is not JSON: draw with the ones that are (checked only here,
    # so a normal redraw costs no extra jq runs).
    base_args
    add_managed check; add_file flag "$f_flag" check; add_file local "$f_local" check
    add_file project "$f_project" check; add_file user "$f_user" check; add_file cfg "$config" check
    out=$(render)
fi
IFS=$'\037' read -r cwd model pct effort prefix quote branch _end <<< "$out"
case "$pct" in ''|*[!0-9]*) pct="" ;; esac

# ---------------------------------------------------------------- line 1

# The context bar: 10 cells, a part-filled edge cell (░ ▒ ▓) for the rest.
context_info=""
if [ -n "$pct" ]; then
    filled=$((pct * 10 / 100))
    remainder=$((pct - filled * 10))
    edge=""
    if (( remainder >= 7 )); then edge="▓"
    elif (( remainder >= 4 )); then edge="▒"
    elif (( remainder >= 1 )); then edge="░"
    fi
    bar=""
    cells=0
    for ((i=0; i<filled; i++)); do bar+="█"; cells=$((cells + 1)); done
    [ -n "$edge" ] && { bar+="$edge"; cells=$((cells + 1)); }
    for ((i=cells; i<10; i++)); do bar+="░"; done
    context_info=$(printf ' \033[2;35m◆\033[0m \033[1;35m%s\033[0m \033[2;35m%d%%\033[0m' "$bar" "$pct")
fi

# The effort, coloured by level. Claude Code leaves it out for a model without
# an effort setting, and then so does this line.
effort_info=""
if [ -n "$effort" ]; then
    case "$effort" in
        low)    eff_color='\033[2;37m' ;;
        medium) eff_color='\033[1;36m' ;;
        high)   eff_color='\033[1;33m' ;;
        xhigh)  eff_color='\033[1;35m' ;;
        max)    eff_color='\033[1;31m' ;;
        *)      eff_color='\033[1;37m' ;;
    esac
    effort_info=$(printf ' \033[2;35m◆\033[0m \033[2;37mEFF\033[0m '"$eff_color"'%s\033[0m' "$effort")
fi

line1=""
[ -n "$branch" ] && line1+=$(printf '\033[1;33m%s\033[0m \033[2;35m◆\033[0m ' "$branch")
[ -n "$cwd" ] && line1+=$(printf '\033[1;36m%s\033[0m' "$cwd")
[ -n "$model" ] && line1+=$(printf ' \033[2;35m◆\033[0m \033[2;36m%s\033[0m' "$model")
line1+="$context_info"
line1+="$effort_info"

# ---------------------------------------------------------------- line 2

# Bangkok, US East and US West (IANA zones follow daylight saving), then this
# machine's own clock, labelled with its zone (SRV when the zone has no name).
bkk=$(TZ="Asia/Bangkok" date +%H:%M 2>/dev/null)
est=$(TZ="America/New_York" date +%H:%M 2>/dev/null)
pst=$(TZ="America/Los_Angeles" date +%H:%M 2>/dev/null)
case "$srv_zone" in ''|*[!A-Za-z]*) srv_label=SRV ;; *) srv_label="$srv_zone" ;; esac
clocks=$(printf ' \033[2;35m◆\033[0m \033[2;37mBKK\033[0m \033[1;97m%s\033[0m \033[2;35m│\033[0m \033[2;37mEST\033[0m \033[1;97m%s\033[0m \033[2;35m│\033[0m \033[2;37mPST\033[0m \033[1;97m%s\033[0m \033[2;35m│\033[0m \033[2;37m%s\033[0m \033[1;97m%s\033[0m' \
    "$bkk" "$est" "$pst" "$srv_label" "$srv_time")

[ -n "$prefix" ] || prefix=$(printf '\033[1;36mGHOST\033[0m \033[2;35m▸\033[0m')
line2="$prefix"
if [ -n "$quote" ]; then
    # The quote breathes: brighter and dimmer every 3 seconds.
    if (( (sec / 3) % 2 == 0 )); then quote_color='\033[0;35m'; else quote_color='\033[2;35m'; fi
    line2+=$(printf ' \033[2;35m┄┄\033[0m '"$quote_color"'「 %s 」\033[0m \033[2;35m┄┄\033[0m' "$quote")
fi
line2+="$clocks"

printf '%s\n' "$line1"
printf '%s\n' "$line2"
exit 0
