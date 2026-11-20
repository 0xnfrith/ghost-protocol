#!/usr/bin/env bash
# shellcheck disable=SC2016  # jq filters name jq's own $variables in single quotes
# statusline.test.sh: GHOST Protocol's status line (statusline/statusline.sh),
# its wiring (statusline/wire) and the installer's step 7b. The status line runs
# on a fixed clock (the date stand-in), under LANG=C, with only the tools it
# needs, and every run must exit 0 with nothing on stderr.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SL="$SRC/statusline/statusline.sh"
WIRE="$SRC/statusline/wire"
ESC="$(printf '\033')"
NOW=1762156800   # 08:00:00 UTC: 15:00 in Bangkok, 03:00 EST, 00:00 PST

# ---------------------------------------------------------------- helpers

# A fresh sandbox with jq, a git repo at $T/proj (on main) and the fixed clock.
# Returns 1 when this machine has no jq.
sl_new() {
    t_new
    t_tool jq || return 1
    t_stub date
    echo "$NOW" >"$T/state/now"
    mkdir -p "$T/proj/.claude" "$T/home"
    git -C "$T/proj" init -q
    M_ID=claude-opus-5-5; M_NAME="Opus 5.5"; IN_TOK=0; OUT_TOK=0; SIZE=1000000; USED=0; EFFORT=high
    CWD="$T/proj"
    return 0
}
at() { echo "$((NOW + $1))" >"$T/state/now"; }   # seconds after $NOW

# The session JSON Claude Code would send, from the M_*, *_TOK, SIZE, USED,
# EFFORT and CWD variables.
session() {
    printf '{"cwd":"%s","model":{"id":"%s","display_name":"%s"},"workspace":{"current_dir":"%s","project_dir":"%s"},"context_window":{"total_input_tokens":%s,"total_output_tokens":%s,"context_window_size":%s,"used_percentage":%s},"effort":{"level":"%s"}}' \
        "$CWD" "$M_ID" "$M_NAME" "$CWD" "$T/proj" "$IN_TOK" "$OUT_TOK" "$SIZE" "$USED" "$EFFORT"
}

# Run the status line on stdin $1 (default: the session JSON). Extra
# arguments are VAR=value words for its environment. $OUT gets the text
# without colours, L1 and L2 its two lines, $T/raw the bytes, $T/err stderr.
render_input() {
    local input="$1"; shift
    printf '%s' "$input" >"$T/in.json"
    env -i HOME="$T/home" PATH="$T/stubs:$T/sysbin" TMPDIR="$T/tmp" LANG=C LC_ALL=C STUB_STATE="$T/state" TZ=UTC GP_TEST=1 \
        GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1 "$@" \
        bash "$SL" <"$T/in.json" >"$T/raw" 2>"$T/err"
    RC=$?
    sed "s/${ESC}\\[[0-9;]*m//g" "$T/raw" >"$OUT"
    L1="$(sed -n 1p "$OUT")"
    L2="$(sed -n 2p "$OUT")"
}
render() { render_input "$(session)" "$@"; }

clean_run() { rc_is 0 && [ ! -s "$T/err" ]; }
l1_has() { printf '%s\n' "$L1" | grep -qF -- "$1"; }
l2_has() { printf '%s\n' "$L2" | grep -qF -- "$1"; }
l1_lacks() { ! l1_has "$1"; }
l2_lacks() { ! l2_has "$1"; }
bar_is() { l1_has "◆ $1 $2% ◆"; }          # cells percent
head2() { printf '%s' "$L2" | sed 's/ ◆ BKK.*//'; }   # line 2 before the clocks

user_settings()  { mkdir -p "$T/home/.claude"; printf '%s\n' "$1" >"$T/home/.claude/settings.json"; }
proj_settings()  { printf '%s\n' "$1" >"$T/proj/.claude/settings.json"; }
local_settings() { printf '%s\n' "$1" >"$T/proj/.claude/settings.local.json"; }
instance_cfg()   { mkdir -p "$T/home/.config/ghost-protocol/statusline"; printf '%s\n' "$1" >"$T/home/.config/ghost-protocol/statusline/config.json"; }

HALF="█████░░░░░"
FULL="██████████"

if ! sl_new; then
    echo "SKIP  status line tests (no jq on this machine; the status line needs it)"
    finish_tests
    exit $?
fi

# ---------------------------------------------------------------- line 1

# 1. Branch, the full folder, the model with its version, effort.
sl_new; CWD="$T/home/deep/folder"; mkdir -p "$CWD"; git -C "$CWD" init -q
render
check "line 1: a clean run (exit 0, nothing on stderr)" clean_run
check "line 1: two lines" [ "$(wc -l <"$OUT" | tr -d ' ')" = 2 ]
check "line 1: the branch comes first" l1_has "main ◆ $CWD ◆"
check "folder: the full path, also under HOME" l1_has " $T/home/deep/folder "
check "folder: never shortened with ~" l1_lacks "~"
check "model: the name and version" l1_has "◆ Opus 5.5 ◆"
check "effort: EFF and the level" l1_has "◆ EFF high"

# 2. The model's version when the display name has none.
sl_new
M_ID=claude-opus-5-5; M_NAME=Opus; render
check "model: version from the id (claude-opus-5-5)" l1_has "◆ Opus 5.5 ◆"
M_ID='claude-opus-5-5[1m]'; M_NAME=Opus; render
check "model: a [1m] id" l1_has "◆ Opus 5.5 ◆"
M_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0; M_NAME=Sonnet; render
check "model: a provider id with a date and -v1:0" l1_has "◆ Sonnet 4.5 ◆"
M_ID=claude-opus-4-1@20250805; M_NAME=Opus; render
check "model: an @date id" l1_has "◆ Opus 4.1 ◆"
M_ID=claude-3-5-sonnet-20241022; M_NAME=Sonnet; render
check "model: an old-style id (claude-3-5-sonnet)" l1_has "◆ Sonnet 3.5 ◆"
M_ID=claude-opus-4-6; M_NAME="Opus 4.6 (1M context)"; render
check "model: a trailing (…) is dropped" l1_has "◆ Opus 4.6 ◆"
M_ID=my-gateway-model; M_NAME=""; render
check "model: no display name shows the id" l1_has "◆ my-gateway-model ◆"
M_ID=claude-fable-5-1; M_NAME=Fable; render
check "model: claude-fable-5-1" l1_has "◆ Fable 5.1 ◆"

# 3. No branch outside a repo, no effort when Claude Code sends none.
sl_new; CWD="$T/home/plain"; mkdir -p "$CWD"
render_input "{\"workspace\":{\"current_dir\":\"$CWD\",\"project_dir\":\"$CWD\"},\"model\":{\"id\":\"claude-opus-5-5\",\"display_name\":\"Opus 5.5\"},\"context_window\":{\"total_input_tokens\":0,\"context_window_size\":1000000,\"used_percentage\":null}}"
check "no repo, no effort: a clean run" clean_run
check "no repo: line 1 starts with the folder" [ "$L1" = "$CWD ◆ Opus 5.5" ]
check "no data yet (used_percentage null): no bar" l1_lacks "%"

# ---------------------------------------------------------------- the context bar

# 4. A full bar means compaction: a 670000 window compacts at 637000.
sl_new; user_settings '{"autoCompactWindow": 670000, "theme": "dark"}'
IN_TOK=637000; USED=64; render
check "bar: 637000 of a 670000 window is a full bar" bar_is "$FULL" 100
IN_TOK=318500; USED=32; render
check "bar: 318500 is half" bar_is "$HALF" 50
IN_TOK=300000; OUT_TOK=18500; render
check "bar: the last reply's output counts too" bar_is "$HALF" 50
OUT_TOK=0; IN_TOK=700000; USED=70; render
check "bar: past the point it stays full at 100%" bar_is "$FULL" 100
IN_TOK=95550; USED=10; render
check "bar: a part-filled edge cell (15%)" bar_is "█▒░░░░░░░░" 15
CW='"total_input_tokens":999999,"total_output_tokens":0,"context_window_size":1000000,"used_percentage":31,"current_usage":{"input_tokens":100000,"cache_creation_input_tokens":18500,"cache_read_input_tokens":195000,"output_tokens":5000}'
render_input "{\"workspace\":{\"current_dir\":\"$T/proj\",\"project_dir\":\"$T/proj\"},\"model\":{\"id\":\"claude-opus-5-5\",\"display_name\":\"Opus 5.5\"},\"context_window\":{$CW},\"effort\":{\"level\":\"high\"}}"
check "bar: current_usage (all four counts) wins over the totals" bar_is "$HALF" 50

# 5. No setting: the model's own window, compacting 33000 before its end.
sl_new; IN_TOK=483500; USED=48; render
check "bar: no setting: 1M compacts at 967000 (483500 is half)" bar_is "$HALF" 50
check "bar: no setting: a clean run" clean_run

# 6. The variable beats the files; k and M; small and junk values.
sl_new; user_settings '{"autoCompactWindow": 670000}'
IN_TOK=183500; USED=18
render CLAUDE_CODE_AUTO_COMPACT_WINDOW=400k
check "bar: CLAUDE_CODE_AUTO_COMPACT_WINDOW=400k beats the file" bar_is "$HALF" 50
render CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000
check "bar: the variable as a plain number" bar_is "$HALF" 50
IN_TOK=483500; render CLAUDE_CODE_AUTO_COMPACT_WINDOW=1M
check "bar: the variable with M" bar_is "$HALF" 50
IN_TOK=33500; render CLAUDE_CODE_AUTO_COMPACT_WINDOW=200
check "bar: 200 (tokens) counts as the 100000 minimum" bar_is "$HALF" 50
IN_TOK=318500; render CLAUDE_CODE_AUTO_COMPACT_WINDOW=lots
check "bar: an unusable value is ignored (the file applies)" bar_is "$HALF" 50

# 7. Which file wins: local, then project, then user; in a file, the model's
#    own entry beats the top-level key; "auto" is the model's own window.
sl_new; IN_TOK=183500; USED=18
user_settings '{"autoCompactWindow": 670000, "modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 400000}}}'
render
check "bar: the model's entry beats the top-level key" bar_is "$HALF" 50
M_ID='claude-opus-5-5[1m]'; render
check "bar: the model's entry matches a [1m] id" bar_is "$HALF" 50
M_ID=claude-opus-5; render
check "bar: another model gets the top-level key" bar_is "██▓░░░░░░░" 28
M_ID=claude-opus-5-5
user_settings '{"autoCompactWindow": 670000}'
proj_settings '{"autoCompactWindow": 400000}'
render
check "bar: project settings beat user settings" bar_is "$HALF" 50
local_settings '{"autoCompactWindow": 670000}'
IN_TOK=318500; render
check "bar: local settings beat project settings" bar_is "$HALF" 50
rm -f "$T/proj/.claude/settings.local.json"
proj_settings '{"autoCompactWindow": "auto"}'
IN_TOK=483500; render
check "bar: auto in a higher file means the model's own window" bar_is "$HALF" 50
proj_settings '{"autoCompactWindow": 5}'
IN_TOK=318500; render
check "bar: an out-of-range value is skipped (the next file applies)" bar_is "$HALF" 50

# 8. The window is capped at the context window; CLAUDE_CONFIG_DIR moves the
#    user settings.
sl_new; user_settings '{"autoCompactWindow": 670000}'
SIZE=200000; IN_TOK=83500; USED=42; render
check "bar: a 200000 context window caps the window (compacts at 167000)" bar_is "$HALF" 50
sl_new; mkdir -p "$T/cfgdir"; printf '{"autoCompactWindow": 400000}\n' >"$T/cfgdir/settings.json"
IN_TOK=183500; USED=18; render CLAUDE_CONFIG_DIR="$T/cfgdir"
check "bar: CLAUDE_CONFIG_DIR's settings.json is the user settings" bar_is "$HALF" 50

# 9. Compaction off: the bar is the whole context window again.
sl_new; user_settings '{"autoCompactWindow": 670000}'
IN_TOK=318500; USED=31
render DISABLE_AUTO_COMPACT=1
check "bar: DISABLE_AUTO_COMPACT=1: the whole window (31%)" bar_is "███░░░░░░░" 31
render DISABLE_COMPACT=true
check "bar: DISABLE_COMPACT=true: the whole window" bar_is "███░░░░░░░" 31
user_settings '{"autoCompactWindow": 670000, "autoCompactEnabled": false}'
render
check "bar: autoCompactEnabled false: the whole window" bar_is "███░░░░░░░" 31

# 10. A settings file that is not JSON: the line still draws.
sl_new; user_settings '{"autoCompactWindow": 670000'
IN_TOK=483500; USED=48; render
check "bad settings: a clean run" clean_run
check "bad settings: the bar falls back to the model's window" bar_is "$HALF" 50

# 10b. CLAUDE_AUTOCOMPACT_PCT_OVERRIDE brings compaction earlier: a percent of
#      the window less the 20000 kept for the reply (670000 - 20000 = 650000).
sl_new; user_settings '{"autoCompactWindow": 670000}'
IN_TOK=162500; USED=16; render CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=50
check "bar: a 50% override compacts at 325000 (162500 is half)" bar_is "$HALF" 50
IN_TOK=318500; USED=31; render CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=99
check "bar: an override past the usual point changes nothing (637000)" bar_is "$HALF" 50
render CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=150
check "bar: an override above 100 is ignored" bar_is "$HALF" 50
render CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=half
check "bar: an override that is not a number is ignored" bar_is "$HALF" 50
IN_TOK=483500; USED=48; render CLAUDE_CODE_AUTO_COMPACT_WINDOW=5M
check "bar: a variable above 1M counts as 1M (967000)" bar_is "$HALF" 50

# 10c. The higher file wins whole: a model's entry in a lower file loses to
#      the top-level key in a higher one.
sl_new; IN_TOK=183500; USED=18
user_settings '{"modelSettings": {"claude-opus-5-5": {"autoCompactWindow": 670000}}}'
proj_settings '{"autoCompactWindow": 400000}'
render
check "bar: a higher file's top-level key beats a lower file's model entry" bar_is "$HALF" 50

# 10d. Managed settings (drop-ins over managed-settings.json), then the
#      --settings file the start script names, then the rest.
sl_new; IN_TOK=183500; USED=18
M="$T/managed"; mkdir -p "$M/managed-settings.d"
user_settings '{"autoCompactWindow": 670000}'
local_settings '{"autoCompactWindow": 670000}'
printf '{"autoCompactWindow": 400000}\n' >"$T/flag.json"
render GP_CLAUDE_SETTINGS="$T/flag.json"
check "bar: the --settings file (GP_CLAUDE_SETTINGS) beats local settings" bar_is "$HALF" 50
printf '{"autoCompactWindow": 670000}\n' >"$T/flag.json"
printf '{"autoCompactWindow": 400000}\n' >"$M/managed-settings.json"
render GP_CLAUDE_SETTINGS="$T/flag.json" GP_TEST_MANAGED_DIR="$M"
check "bar: managed-settings.json beats the --settings file" bar_is "$HALF" 50
printf '{"autoCompactWindow": 670000}\n' >"$M/managed-settings.json"
printf '{"autoCompactWindow": 900000}\n' >"$M/managed-settings.d/10-a.json"
printf '{"autoCompactWindow": 400000}\n' >"$M/managed-settings.d/20-b.json"
render GP_TEST_MANAGED_DIR="$M"
check "bar: the last drop-in by name wins in the managed tier" bar_is "$HALF" 50
printf '{"autoCompactWindow": ' >"$M/managed-settings.d/30-broken.json"
render GP_TEST_MANAGED_DIR="$M"
check "bar: a broken drop-in is skipped, the others still count" bar_is "$HALF" 50
check "bar: a broken drop-in: a clean run" clean_run

# 10e. Project local settings sit at the repository's root, and for a
#      worktree at the main checkout's root.
sl_new; IN_TOK=183500; USED=18
user_settings '{"autoCompactWindow": 670000}'
local_settings '{"autoCompactWindow": 400000}'
git -C "$T/proj" commit -q --allow-empty -m one
mkdir -p "$T/proj/sub"
render_input "$(CWD="$T/proj/sub" session | sed "s#\"project_dir\":\"$T/proj\"#\"project_dir\":\"$T/proj/sub\"#")"
check "bar: started in a subfolder: the repository root's local file" bar_is "$HALF" 50
git -C "$T/proj" worktree add -q "$T/wt" -b side
render_input "$(CWD="$T/wt" session | sed "s#\"project_dir\":\"$T/proj\"#\"project_dir\":\"$T/wt\"#")"
check "bar: in a worktree: the main checkout's local file" bar_is "$HALF" 50
check "branch: the worktree's branch" l1_has "side ◆ $T/wt ◆"

# ---------------------------------------------------------------- line 2

# 11. No instance settings: the generic name, still; no quote; four clocks.
sl_new; render
check "line 2: a clean run" clean_run
check "name: GHOST by default" [ "$(head2)" = "GHOST ▸" ]
check "quote: none by default" l2_lacks "「"
check "clocks: Bangkok, US East, US West and this machine (UTC)" \
    l2_has "◆ BKK 15:00 │ EST 03:00 │ PST 00:00 │ UTC 08:00"
cp "$T/raw" "$T/raw.0"
at 7; render
check "name: the default does not animate (second 7 draws the same)" cmp -s "$T/raw.0" "$T/raw"
render TZ=Asia/Bangkok
check "clocks: a zone with no name is labelled SRV" l2_has "│ SRV 15:00"

# 12. The instance's name and glitch: one more character glitches each second,
#     on a loop one longer than the name plus " ▸" (13 + 1 = 14 seconds).
sl_new
instance_cfg '{"name": "幽霊 test.one", "glitch": "幻影 ｱｲｳｴｵｶｷ ｸ▶", "quotes": ["one", "two", "three"]}'
at 0; render
check "glitch: a clean run" clean_run
check "glitch: second 0 is the name" [ "$(head2 | sed 's/ ┄┄.*//')" = "幽霊 test.one ▸" ]
at 4; render
check "glitch: second 4: the first 4 characters glitched" [ "$(head2 | sed 's/ ┄┄.*//')" = "幻影 ｱest.one ▸" ]
at 13; render
check "glitch: second 13: all of it" [ "$(head2 | sed 's/ ┄┄.*//')" = "幻影 ｱｲｳｴｵｶｷ ｸ▶" ]
at 14; render
check "glitch: second 14: the name again" [ "$(head2 | sed 's/ ┄┄.*//')" = "幽霊 test.one ▸" ]
check "glitch: CJK characters are magenta" grep -qF "${ESC}[1;35m幽${ESC}[0m" "$T/raw"
check "glitch: ASCII characters are cyan" grep -qF "${ESC}[1;36mt${ESC}[0m" "$T/raw"
at 4; render
check "glitch: glitched characters are green" grep -qF "${ESC}[1;32mｱ${ESC}[0m" "$T/raw"

# 13. The quote: one per minute, in turn; it breathes every 3 seconds.
at 0; render
check "quote: minute 0: the first" l2_has "▸ ┄┄ 「 one 」 ┄┄ ◆ BKK"
at 60; render
check "quote: minute 1: the second" l2_has "「 two 」"
at 240; render
check "quote: minute 4: the second again (3 quotes)" l2_has "「 two 」"
at 0; render
check "quote: seconds 0-2 bright" grep -qF "${ESC}[0;35m「 one 」" "$T/raw"
at 3; render
check "quote: seconds 3-5 dim" grep -qF "${ESC}[2;35m「 one 」" "$T/raw"

# 14. A glitch of the wrong length: the name stays still; the quote list may
#     be empty; control characters never reach the terminal.
sl_new
instance_cfg '{"name": "agent", "glitch": "short", "quotes": []}'
at 3; render
check "glitch: wrong length: the name stays still" [ "$(head2)" = "agent ▸" ]
check "quote: an empty list: no quote" l2_lacks "「"
instance_cfg '{"name": "solo"}'
at 5; render
check "name only, no glitch: the name stays still" [ "$(head2)" = "solo ▸" ]
instance_cfg '{"name": "a\u001b[31mb", "quotes": ["x\u001b]0;title\u0007y"]}'
render
check "control characters: a clean run" clean_run
check "control characters: no escape from the settings" sh -c "! grep -qF '${ESC}[31m' '$T/raw' && ! grep -qF '${ESC}]0' '$T/raw'"
check "control characters: the rest of the text stays" l2_has "「 x]0;titley 」"
instance_cfg '{"name": "c\u009b1mz"}'
render
check "control characters: a C1 CSI (U+009B) in the name is stripped" sh -c "! grep -q \"$(printf '\302\233')\" '$T/raw'"
git -C "$T/proj" checkout -q -b "$(printf 'br\302\2331mx')" 2>/dev/null
render
check "control characters: a C1 CSI in the branch is stripped" sh -c "! grep -q \"$(printf '\302\233')\" '$T/raw' && grep -qF 'br1mx ◆' '$OUT'"

# 15. Instance settings that are not JSON: the generic line, and the settings
#     files still count.
sl_new; instance_cfg '{"name": '
user_settings '{"autoCompactWindow": 670000}'
IN_TOK=318500; USED=31; render
check "bad instance settings: a clean run" clean_run
check "bad instance settings: the generic name" [ "$(head2)" = "GHOST ▸" ]
check "bad instance settings: the window from the good settings file still applies" bar_is "$HALF" 50

# 16. Odd input: empty stdin, and no jq at all.
sl_new; render_input ""
check "empty stdin: a clean run" clean_run
check "empty stdin: still two lines, with the clocks" l2_has "◆ BKK 15:00"
t_new; t_stub date; echo "$NOW" >"$T/state/now"
render_input '{"cwd":"/x"}'
check "no jq: a clean run" clean_run
check "no jq: one line that says so" [ "$(cat "$OUT")" = "status line: install jq to see it" ]

# ---------------------------------------------------------------- wire

sl_new
S="$T/home/.claude/settings.json"
wire() { env -i HOME="$T/home" PATH="$T/stubs:$T/sysbin" TMPDIR="$T/tmp" LANG=C LC_ALL=C STUB_STATE="$T/state" \
    bash "$WIRE" "$@" >"$OUT" 2>&1; RC=$?; }
points_here() { jq -e --arg c "$SRC/statusline/statusline.sh" '.statusLine == {type: "command", command: $c, refreshInterval: 1}' "$S" >/dev/null 2>&1; }
backups() { find "$T/home/.claude" -name 'settings.json.bak-statusline-*' | wc -l | tr -d ' '; }

# 17. No settings file: a dry run writes nothing; wire writes it; again: nothing.
wire wire --dry-run
check "wire, dry run: exit 0, would wire" sh -c "[ $RC -eq 0 ] && grep -q '^would wire: write' '$OUT'"
check "wire, dry run: no file" [ ! -e "$S" ]
wire wire
check "wire: exit 0, wired" sh -c "[ $RC -eq 0 ] && grep -q '^wired: wrote' '$OUT'"
check "wire: statusLine points at this checkout, every second" points_here
cp "$S" "$T/s.before"
wire wire
check "wire again: already wired" out_has '^already wired: '
check "wire again: the file is unchanged" cmp -s "$T/s.before" "$S"

# 18. Another status line is left alone, unless --replace.
printf '{"theme":"dark","statusLine":{"type":"command","command":"~/.claude/my-line.sh"}}\n' >"$S"
cp "$S" "$T/s.before"
wire wire
check "another status line: exit 3" rc_is 3
check "another status line: it says how to replace it" out_has 'already has another status line.*--replace'
check "another status line: untouched" cmp -s "$T/s.before" "$S"
wire wire --replace --dry-run
check "--replace, dry run: would wire, untouched" sh -c "grep -q '^would wire: set' '$OUT' && cmp -s '$T/s.before' '$S'"
wire wire --replace
check "--replace: wired" out_has '^wired: set the status line'
check "--replace: it points here" points_here
check "--replace: the other keys are kept" jq -e '.theme == "dark"' "$S"
check "--replace: the old file is kept as a backup" [ "$(backups)" = 1 ]

# 19. An older statusline.sh by the same name, but not ours (no ID line): foreign.
mkdir -p "$T/old/statusline"; printf '#!/bin/bash\n# Statusline-ID: something-else\n' >"$T/old/statusline/statusline.sh"
printf '{"statusLine":{"type":"command","command":"%s/old/statusline/statusline.sh","refreshInterval":1}}\n' "$T" >"$S"
wire wire
check "a statusline.sh without our ID line is not ours" rc_is 3

# 20. Ours from a checkout that is gone: pointed here, its padding kept.
printf '{"statusLine":{"type":"command","command":"/gone/checkout/statusline/statusline.sh","refreshInterval":1,"padding":2}}\n' >"$S"
wire wire
check "ours from a gone checkout: wired without --replace" out_has '^wired: set'
check "ours from a gone checkout: padding kept" jq -e --arg c "$SRC/statusline/statusline.sh" \
    '.statusLine == {type: "command", command: $c, refreshInterval: 1, padding: 2}' "$S"

# 21. unwire: only ours.
printf '{"theme":"dark","statusLine":{"type":"command","command":"/x/line.sh"}}\n' >"$S"
cp "$S" "$T/s.before"
wire unwire
check "unwire another status line: not wired, untouched" sh -c "[ $RC -eq 0 ] && grep -q '^not wired:' '$OUT' && cmp -s '$T/s.before' '$S'"
wire wire --replace
wire unwire --dry-run
check "unwire, dry run: would unwire" out_has '^would unwire: '
check "unwire, dry run: still wired" points_here
wire unwire
check "unwire: unwired" out_has '^unwired: '
check "unwire: the status line is gone, the rest kept" jq -e '(has("statusLine") | not) and .theme == "dark"' "$S"
check "unwire: a backup is kept" [ "$(backups)" -ge 2 ]

# 21b. Ours already, with its own refreshInterval: left as it is.
printf '{"statusLine":{"type":"command","command":"%s/statusline/statusline.sh","refreshInterval":5}}\n' "$SRC" >"$S"
cp "$S" "$T/s.before"
wire wire
check "ours with refreshInterval 5: already wired, untouched" sh -c "grep -q '^already wired' '$OUT' && cmp -s '$T/s.before' '$S'"
printf '{"statusLine":{"type":"command","command":"%s/statusline/statusline.sh"}}\n' "$SRC" >"$S"
wire wire
check "ours with no refreshInterval: given 1" points_here

# 21c. A settings file that is not a JSON object: refused, untouched.
printf '{"theme": ' >"$S"; cp "$S" "$T/s.before"
wire wire
check "not JSON: exit 3, untouched" sh -c "[ $RC -eq 3 ] && cmp -s '$T/s.before' '$S'"
printf '[1, 2]\n' >"$S"; cp "$S" "$T/s.before"
wire wire
check "a JSON array: exit 3, untouched" sh -c "[ $RC -eq 3 ] && cmp -s '$T/s.before' '$S'"

# 21d. CLAUDE_CONFIG_DIR: the settings file there, as Claude Code reads it.
mkdir -p "$T/cfgdir2"
env -i HOME="$T/home" PATH="$T/stubs:$T/sysbin" TMPDIR="$T/tmp" LANG=C LC_ALL=C CLAUDE_CONFIG_DIR="$T/cfgdir2" \
    bash "$WIRE" wire >"$OUT" 2>&1; RC=$?
check "CLAUDE_CONFIG_DIR: wired into its settings.json" sh -c "[ $RC -eq 0 ] && jq -e '.statusLine.refreshInterval == 1' '$T/cfgdir2/settings.json' >/dev/null"

# 22. A linked settings file: the link stays; the backup sits beside the link.
sl_new; S="$T/home/.claude/settings.json"
mkdir -p "$T/home/dotfiles" "$T/home/.claude"
printf '{"theme":"dark"}\n' >"$T/home/dotfiles/settings.json"; chmod 600 "$T/home/dotfiles/settings.json"
ln -s "$T/home/dotfiles/settings.json" "$S"
wire wire
check "linked settings: still a link" [ -L "$S" ]
check "linked settings: the file behind it is wired" points_here
check "linked settings: its mode is kept" sh -c "ls -l '$T/home/dotfiles/settings.json' | grep -q '^-rw-------'"
check "linked settings: no backup inside dotfiles/" [ -z "$(find "$T/home/dotfiles" -name '*.bak-*')" ]

# 23. No jq: nothing is written.
t_new; S="$T/home/.claude/settings.json"
wire wire
check "wire without jq: exit 3, it says why" sh -c "[ $RC -eq 3 ] && grep -q 'needs jq' '$OUT'"
check "wire without jq: no file" [ ! -e "$S" ]
wire nonsense
check "wire: an unknown first word is a usage error" rc_is 2

# ---------------------------------------------------------------- installer, step 7b

I=(--instance example/instance --yes)

# 24. Wired on the first run, already wired on the second, planned in a dry run.
sl_new; t_std_env; t_make_instance "$FIX/manifests/good-v1.toml"; S="$T/home/.claude/settings.json"
t_snapshot >"$T/before"
t_install "${I[@]}" --dry-run
t_snapshot >"$T/after"
check "installer, dry run: PLAN statusline" out_has 'PLAN +statusline +would wire .*/statusline/statusline.sh'
check "installer, dry run: HOME unchanged" cmp -s "$T/before" "$T/after"
t_install "${I[@]}"
check "installer: exit 0" rc_is 0
check "installer: the 7b heading" out_has '^== 7b\. status line'
check "installer: DONE statusline" out_has 'DONE +statusline +wired: .*/statusline/statusline.sh'
check "installer: settings.json points at this checkout" points_here
check "installer: the worktree hook is there too" grep -q 'install/layout/worktree-hook create' "$S"
cp "$S" "$T/s.before"
t_install "${I[@]}"
check "installer again: OK statusline, already wired" out_has 'OK +statusline +already wired'
check "installer again: settings.json unchanged" cmp -s "$T/s.before" "$S"

# 25. Another status line: left alone; the run goes on.
sl_new; t_std_env; t_make_instance "$FIX/manifests/good-v1.toml"; S="$T/home/.claude/settings.json"
mkdir -p "$T/home/.claude"; printf '{"statusLine":{"type":"command","command":"/x/mine.sh"}}\n' >"$S"
t_install "${I[@]}"
check "installer, another status line: exit 0" rc_is 0
check "installer, another status line: SKIP statusline" out_has 'SKIP +statusline +not wired: .*another status line'
check "installer, another status line: kept" jq -e '.statusLine.command == "/x/mine.sh"' "$S"

# 26. No jq: SKIP, and the run goes on.
t_new; t_std_env; t_make_instance "$FIX/manifests/good-v1.toml"
t_install "${I[@]}"
check "installer, no jq: exit 0" rc_is 0
check "installer, no jq: SKIP statusline, needs jq" out_has 'SKIP +statusline +not wired: the status line needs jq'

finish_tests
