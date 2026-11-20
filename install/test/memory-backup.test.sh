#!/usr/bin/env bash
# memory-backup.test.sh: the memory backup (install/memory-backup/,
# install/lib/memory-backup.sh, hooks/memory-backup).
#   - run: the first run commits the whole folder, as it is (CRLF, a
#     .gitattributes, a subfolder, a .github folder), under memory/ on the
#     branch memory/<name> of the remote, which shares no history with main and
#     leaves main alone; each commit is recorded as this machine's; a run with
#     nothing changed commits nothing; a change is one commit on top; a write
#     that lands during a run is backed up by the same run. The live folder is
#     never written.
#   - the secret scan, before any commit or push, with one alert that names the
#     file, the line and the rule, never the text: a token in a new note, in a
#     note already backed up, right after an _, in a UTF-16 note, a key block,
#     tokens of Linear, Neon, PostHog, Cloudflare and Hetzner; a token in a file
#     name holds the run without the name being shown. The same hit again sends
#     nothing; once it is gone, the backup commits and one all-clear goes out.
#   - left out, and reported, while the rest is backed up: a compressed or
#     binary file, a UTF-32 note with a token in it (LE and BE), a note with a
#     NUL in it, a file over the size cap.
#   - a missing folder is reported; an emptied folder (an empty one on the
#     first run too) is held. A run that would remove more than the set share
#     of the notes holds back the removals alone: the rest (a new note) goes
#     in, the removed notes stay as they were, the same hold alerts once;
#     --accept-removals takes on the notes held back and no other (four more
#     gone at once are held in their turn); the reviewer's case (10 notes, 4
#     held, then 10 new and 1 more removed) keeps the 4 held, sends no
#     all-clear, and lets the 1 more in.
#   - the history is never rewritten: a push the remote refuses as not a
#     fast-forward is reported and never forced, and the local branch does not
#     move; a push the remote refuses for its content (a size rule) is
#     reported, the local branch goes back to the remote's tip, and the run
#     recovers once the file is gone; when the refused file is in commits that
#     waited here (two runs offline, a note x.md in the first alone), they
#     leave the branch, are kept under refs/dropped/ (x.md comes back from
#     it), never pushed, and one alert says how many and where; a branch with
#     commits this machine did not make is held (two machines on one branch:
#     A, B, A), and taken on only with
#     --adopt-remote (a rebuilt machine too); commits of this machine that
#     moved apart are held, and --adopt-remote clears that too, keeping them
#     under refs/dropped/ (a branch here only ahead is kept and pushed); a remote out of reach keeps the commits here, and
#     is reported after four runs in a row.
#   - restore: a note deleted from the live folder comes back byte for byte; a
#     note an auto-dream-like run rewrote, and two it pruned, come back from the
#     commit before; a restore never writes into the live folder. Crafted
#     commits on the remote (a symlink folder with a file under it, a .. entry,
#     a path twice, a file with a file under it) are refused by git's check of
#     the fetch, and, with that check off, each by its own check in the
#     backup; nothing is ever written outside the restore folder.
#   - verify: silent when the remote restores to the live folder; one alert
#     when it does not, even after the retry; entries in the live folder that
#     no backup keeps (a symlink, a .Git folder) are listed and alerted, one
#     whose name is a token by a placeholder, never the token; one all-clear
#     after. A restore lists a token-named entry by the placeholder too.
#   - the dry run writes, pushes and sends nothing.
#   - settings: a branch that is not memory/<name>, a remote with a user in it,
#     or an unknown setting is refused.
#   - the hook: a write inside the watched folder writes the trigger; one
#     outside it, through .., in a folder that only starts with its name, or
#     with the switch off does not; a write through a symlink into it does.
#   - the manifest section, the unit templates, and the install step through
#     install/memory-backup/setup (dry run, apply, a second apply, uninstall; an
#     --apply that installs nothing, or whose first run fails, exits non-zero;
#     a second --apply runs a verify before it says OK, and a failing one is a
#     FAIL).
# Then the mutation check: the backup and the hook are copied with one guard
# broken at a time, and this test is run against each copy; every copy must
# fail it.
#
# MB_BACKUP=<a copy of the backup> or MB_HOOK=<a copy of the hook> runs it
# once against that copy, without the setup cases or the mutation check;
# MB_SETUP=<setup in a copy of the checkout> runs it once against that copy's
# install step, without the mutation check.
# The checks read `cond && ok "..." || bad "..."` (SC2015); some commands hold
# a literal $ (SC2016).
# shellcheck disable=SC2015,SC2016
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REAL="$SRC/install/memory-backup/backup"
REAL_HOOK="$SRC/hooks/memory-backup"
TOOL="${MB_BACKUP:-$REAL}"
HOOK_SRC="${MB_HOOK:-$REAL_HOOK}"
SETUP="${MB_SETUP:-$SRC/install/memory-backup/setup}"
CHAN="0000aaaa-1111-2222-3333-444455556666"
BR="memory/example"

t_new
if ! t_tool python3; then
    echo "SKIP  every case (no python3 on this machine)"
    finish_tests
    exit $?
fi
expect() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

# The secrets, built from pieces at run time, so this file holds none.
D5="-----"
TOKEN="gh""p_$(printf 'Zq7%.0s' 1 2 3 4 5 6 7 8 9 10 11 12)"
# A GitHub App installation token in the stateless form (since October 2026):
# ghs_, then base64url parts joined by dots, about 520 characters. This one
# has a - and an _ early on, where the old rule (letters and digits only)
# stopped, and no JWT header, so only the github-token rule can find it.
STATELESS="gh""s_$(printf 'Ab-%.0s' $(seq 12)).$(printf 'Cd_%.0s' $(seq 40)).$(printf 'Ef9%.0s' $(seq 120))"
PEM="${D5}BEGIN OPENSSH PRIV""ATE KEY${D5}"
LIN="lin""_api_$(printf 'A%.0s' $(seq 40))"
NAPI="nap""i_$(printf 'a1%.0s' $(seq 32))"
PHX="ph""x_$(printf 'B%.0s' $(seq 43))"
CF="CLOUD""FLARE_API_TOKEN=$(printf 'c%.0s' $(seq 40))"
HZ="het""zner token: $(printf 'H%.0s' $(seq 64))"

# ------------------------------------------------------------------ the world

R="$T/remote/instance.git"       # the instance's repo, with its main
LIVE="$T/live"                   # the memory folder
STATE_D="$T/mbstate"
SET="$T/settings"
git init -q --bare "$R"
git init -q "$T/seed" && echo main >"$T/seed/README" && git -C "$T/seed" add -A \
    && git -C "$T/seed" commit -q -m main && git -C "$T/seed" push -q "$R" HEAD:main
MAIN0="$(git --git-dir="$R" rev-parse main)"
# The remote refuses a pushed file over 2000 bytes while refuse-big is there,
# as a remote with a size rule does.
cat >"$R/hooks/pre-receive" <<EOF
#!/bin/sh
[ -f "$T/state/refuse-big" ] || exit 0
while read -r old new ref; do
    for oid in \$(git rev-list --objects "\$new" --not --all | cut -d' ' -f1); do
        if [ "\$(git cat-file -t "\$oid")" = blob ] && [ "\$(git cat-file -s "\$oid")" -gt 2000 ]; then
            echo "a file is over the 2000-byte limit" >&2; exit 1
        fi
    done
done
exit 0
EOF
chmod +x "$R/hooks/pre-receive"

mkdir -p "$LIVE/sub" "$LIVE/.github/workflows"
printf '# Memory index\n- [a](a.md)\n- [b](b.md)\n- [c](c.md)\n' >"$LIVE/MEMORY.md"
printf 'note a\r\nwith CRLF\r\n' >"$LIVE/a.md"
printf 'note b\n' >"$LIVE/b.md"
printf 'note c\n' >"$LIVE/c.md"
printf 'deep\n' >"$LIVE/sub/d.md"
printf '* text eol=crlf\n*.md filter=nope\n' >"$LIVE/.gitattributes"
printf 'on: push\n' >"$LIVE/.github/workflows/x.yml"
ORIG="$T/orig"; cp -Rp "$LIVE" "$ORIG"

settings() {   # extra lines
    {
        printf 'NAME=example\nFOLDER=%s\nREMOTE=file://%s\nBRANCH=%s\nSTATE=%s\n' "$LIVE" "$R" "$BR" "$STATE_D"
        printf 'CHANNEL=%s\n' "$CHAN"
        printf '%s\n' "$@"
    } >"$SET"
}
settings

# The send's stand-in: each alert's text to a file, one count line each, and
# the event id a send prints. Called as `task …` (an alert's open state), it
# notes its arguments and emoji settings in tasks.log, or fails with task.rc.
ALERTS="$T/state/alerts.txt"; : >"$ALERTS"
TASKS="$T/state/tasks.log"
cat >"$T/stubs/mb-send" <<EOF
#!/bin/sh
if [ "\$1" = task ]; then
    st=\$(cut -d: -f1 "$STATE_D/alert-run" 2>/dev/null)
    echo "argv=\$* emoji=\${BUZZ_TASK_OPEN_EMOJI:-} url=\${BUZZ_TASK_OPEN_EMOJI_URL:-} state=\$st" >>"$TASKS"
    rc=0; [ -f "$T/state/task.rc" ] && rc=\$(cat "$T/state/task.rc")
    exit "\$rc"
fi
{ cat; echo; echo "--- end"; } >>"$ALERTS"
echo "sent $(printf '%064d' 2)"
exit 0
EOF
chmod +x "$T/stubs/mb-send"
alerts() { grep -c '^--- end$' "$ALERTS"; }
last_alert_has() { tail -n 3 "$ALERTS" | grep -qF -- "$1"; }

# A git that can fail its ls-remote or its push on demand (a remote out of
# reach), and that sends the https remote of the setup cases to the local one.
cat >"$T/stubs/mb-git" <<EOF
#!/bin/bash
for a in "\$@"; do
    case "\$a" in
        ls-remote) [ -f "$T/state/lsremote.fails" ] && { echo "fatal: unable to access" >&2; exit 128; } ;;
        push) [ -f "$T/state/push.fails" ] && { echo "fatal: unable to access" >&2; exit 128; } ;;
    esac
done
args=()
for a in "\$@"; do
    [ "\$a" = "https://github.example.com/example/instance.git" ] && a="file://$R"
    args+=("\$a")
done
exec /usr/bin/git "\${args[@]}"
EOF
chmod +x "$T/stubs/mb-git"

# A listing of the live folder: names, link targets and checksums.
live_sum() {
    (cd "$LIVE" 2>/dev/null && find . -print | LC_ALL=C sort | while IFS= read -r p; do
        if [ -L "$p" ]; then printf 'L %s %s\n' "$p" "$(readlink "$p")"
        elif [ -f "$p" ]; then printf 'F %s %s\n' "$p" "$(cksum <"$p")"
        else printf 'D %s\n' "$p"; fi
    done)
}
TOUCHED=0
mb() {   # backup arguments; the live folder is checked unchanged after each
    local before
    before="$(live_sum)"
    t_env GP_MB_SETTINGS="$SET" GP_MB_SEND="$T/stubs/mb-send" GP_MB_GIT="$T/stubs/mb-git" "$TOOL" "$@" >"$OUT" 2>&1
    RC=$?
    [ "$(live_sum)" = "$before" ] || TOUCHED=$((TOUCHED + 1))
}
mbs() {   # settings file, backup arguments: another machine
    local set="$1"; shift
    t_env GP_MB_SETTINGS="$set" GP_MB_SEND="$T/stubs/mb-send" GP_MB_GIT="$T/stubs/mb-git" "$TOOL" "$@" >"$OUT" 2>&1
    RC=$?
}
rgit() { git --git-dir="$R" "$@"; }
tip() { rgit rev-parse -q --verify "refs/heads/$BR"; }
commits() { rgit rev-list --count "refs/heads/$BR" 2>/dev/null || echo 0; }
local_tip() { git --git-dir="$STATE_D/repo.git" rev-parse -q --verify "refs/heads/$BR"; }
in_tip() { rgit cat-file -e "$(tip):memory/$1" 2>/dev/null; }

# ------------------------------------------------------------------ settings

settings "BRANCH=main"
sed -i.bak '/^BRANCH=memory/d' "$SET"
mb run
check "settings: a branch that is not memory/<name> is refused (exit 2)" rc_is 2
check "settings: ... and nothing reaches the remote" [ -z "$(tip)" ]
settings
sed "s#^REMOTE=.*#REMOTE=https://user:pw@example.com/example/instance.git#" "$SET" >"$SET.2" && mv "$SET.2" "$SET"
mb run
check "settings: a remote with a user in it is refused (exit 2)" rc_is 2
settings "SOMETHING=else"
mb run
check "settings: an unknown setting is refused (exit 2)" rc_is 2
settings

# ------------------------------------------------------------------ dry run

mb run --dry-run
check "dry run: exit 0" rc_is 0
check "dry run: says what it would commit" out_has 'dry run: would commit 7 added, 0 changed, 0 removed'
check "dry run: nothing reaches the remote" [ -z "$(tip)" ]
check "dry run: no state folder" [ ! -e "$STATE_D" ]
expect "dry run: no alert" "$(alerts)" 0

# ------------------------------------------------------------------ first run

mb run
check "first run: exit 0" rc_is 0
C1="$(tip)"
expect "first run: one commit on $BR" "$(commits)" 1
expect "first run: main left as it was" "$(rgit rev-parse main)" "$MAIN0"
check "first run: the branch shares no history with main" sh -c "! git --git-dir='$R' merge-base main '$C1' >/dev/null 2>&1"
expect "first run: the tree's top holds memory/ alone" "$(rgit ls-tree --name-only "$C1")" "memory"
expect "first run: every entry is there, .github under memory/" \
    "$(rgit ls-tree -r --name-only "$C1" | tr '\n' ' ')" \
    "memory/.gitattributes memory/.github/workflows/x.yml memory/MEMORY.md memory/a.md memory/b.md memory/c.md memory/sub/d.md "
check "first run: the CRLF note, byte for byte" sh -c "git --git-dir='$R' cat-file blob '$C1:memory/a.md' | cmp -s - '$LIVE/a.md'"
expect "first run: the local branch is the remote's" "$(local_tip)" "$C1"
check "first run: the commit is recorded as this machine's" grep -qx "$C1" "$STATE_D/made"
expect "first run: no alert" "$(alerts)" 0

# ------------------------------------------------------------------ no change, a change

mb run
check "no change: exit 0" rc_is 0
expect "no change: no new commit" "$(commits)" 1
check "no change: says so" out_has 'nothing changed since'
printf 'note b, edited\n' >"$LIVE/b.md"
mb run
check "a change: exit 0" rc_is 0
C2="$(tip)"
expect "a change: one commit on top" "$(commits)" 2
expect "a change: its parent is the first" "$(rgit rev-parse "$C2^")" "$C1"
check "a change: the commit says what changed" sh -c "git --git-dir='$R' log -1 --format=%B '$C2' | grep -qx 'M b.md'"

# ------------------------------------------------------------------ the secret scan

printf 'fine line\nthe token %s here\n' "$TOKEN" >"$LIVE/leak.md"
mb run
check "secret: exit 1" rc_is 1
expect "secret: nothing committed on the remote" "$(tip)" "$C2"
expect "secret: nothing committed here" "$(local_tip)" "$C2"
expect "secret: one alert" "$(alerts)" 1
check "secret: the alert names the file, the line and the rule" grep -q 'leak.md line 2 (github-token)' "$ALERTS"
check "secret: the token is not in the alert" sh -c "! grep -qF '$TOKEN' '$ALERTS'"
check "secret: the token is not in the log" sh -c "! grep -qF '$TOKEN' '$OUT'"
check "secret: the state names no file" sh -c "grep -qx 'secret:[0-9a-f]*' '$STATE_D/alert-run'"
mb run
check "secret again: exit 1" rc_is 1
expect "secret again: no second alert" "$(alerts)" 1
printf 'fine line\n' >"$LIVE/leak.md"
printf 'header\n%s\nbody\n' "$PEM" >"$LIVE/key.md"
mb run
check "a key block: exit 1" rc_is 1
check "a key block: named by its rule" last_alert_has 'key.md line 2 (private-key)'
expect "a key block: still nothing committed" "$(tip)" "$C2"
check "a key block: the block is not in the alert" sh -c "! grep -qF 'PRIV''ATE KEY$D5' '$ALERTS'"
rm "$LIVE/key.md"
printf 'note b, edited\nand a token %s\n' "$TOKEN" >"$LIVE/b.md"
mb run
check "a secret added to a note already backed up: exit 1" rc_is 1
check "... named by file, line and rule" last_alert_has 'b.md line 2 (github-token)'
expect "... nothing committed" "$(tip)" "$C2"
printf 'note b, edited\nmy_%s\n' "$TOKEN" >"$LIVE/b.md"
mb run
check "a token right after an _: exit 1" rc_is 1
check "... found" last_alert_has 'b.md line 2 (github-token)'
printf 'note b, edited\n' >"$LIVE/b.md"
python3 -c 'import sys; open(sys.argv[1], "wb").write(("note\n" + sys.argv[2] + "\n").encode("utf-16"))' "$LIVE/wide.md" "$TOKEN"
mb run
check "a token in a UTF-16 note: exit 1" rc_is 1
check "... found" last_alert_has 'wide.md line 2 (github-token)'
rm "$LIVE/wide.md"
printf 'note\nthe new form %s here\n' "$STATELESS" >"$LIVE/stateless.md"
mb run
check "a stateless GitHub token (dots, a - and an _ early on): exit 1" rc_is 1
check "... found" last_alert_has 'stateless.md line 2 (github-token)'
check "... the token is not in the alert" sh -c "! grep -qF '$STATELESS' '$ALERTS'"
check "... the token is not in the log" sh -c "! grep -qF '$STATELESS' '$OUT'"
expect "... nothing committed" "$(tip)" "$C2"
rm "$LIVE/stateless.md"
printf 'ok\n' >"$LIVE/note-$TOKEN.md"
mb run
check "a token in a file name: exit 1" rc_is 1
check "... held, the name not shown" last_alert_has 'a file or folder name in the memory folder holds a possible secret (github-token)'
check "... the token is not in the alert" sh -c "! grep -qF '$TOKEN' '$ALERTS'"
check "... the token is not in the log" sh -c "! grep -qF '$TOKEN' '$OUT'"
expect "... nothing committed" "$(tip)" "$C2"
rm "$LIVE/note-$TOKEN.md"
printf '%s\n' "$LIN" "$NAPI" "$PHX" "$CF" "$HZ" >"$LIVE/providers.md"
mb run
check "provider tokens: exit 1" rc_is 1
for r in linear-api-key neon-api-key posthog-personal-api-key cloudflare-api-token hetzner-api-token; do
    check "provider tokens: $r found" last_alert_has "($r)"
done
rm "$LIVE/providers.md"
mb run
check "secret gone: exit 0" rc_is 0
expect "secret gone: committed" "$(commits)" 3
check "secret gone: one all-clear" last_alert_has 'backing up again'
n_alerts="$(alerts)"
printf 'x %s\n' "$TOKEN" >"$LIVE/leak2.md"
mb run --dry-run
check "dry run with a secret: exit 1" rc_is 1
check "dry run with a secret: says it would be held" out_has 'would be held back'
check "dry run with a secret: the token is not in the output" sh -c "! grep -qF '$TOKEN' '$OUT'"
expect "dry run with a secret: no alert" "$(alerts)" "$n_alerts"
rm "$LIVE/leak2.md"

# ------------------------------------------------------------------ what is left out

printf 'x %s\n' "$TOKEN" | gzip -c >"$LIVE/packed.gz"
printf 'note e\n' >"$LIVE/e.md"
mb run
check "a compressed file: the run goes on (exit 0)" rc_is 0
check "... the rest is committed" in_tip e.md
check "... the compressed file is not" sh -c "! git --git-dir='$R' cat-file -e '$(tip):memory/packed.gz' 2>/dev/null"
check "... and the alert says it is left out" last_alert_has 'packed.gz (not text (binary or compressed))'
rm "$LIVE/packed.gz"
python3 -c 'import sys; t = ("note\n" + sys.argv[3] + "\n")
open(sys.argv[1], "wb").write(b"\xff\xfe\x00\x00" + t.encode("utf-32-le"))
open(sys.argv[2], "wb").write(b"\x00\x00\xfe\xff" + t.encode("utf-32-be"))' "$LIVE/wide32le.md" "$LIVE/wide32be.md" "$TOKEN"
mb run
check "a token in UTF-32 notes (LE and BE): the run goes on (exit 0)" rc_is 0
check "... neither is committed" sh -c "! git --git-dir='$R' cat-file -e '$(tip):memory/wide32le.md' 2>/dev/null && ! git --git-dir='$R' cat-file -e '$(tip):memory/wide32be.md' 2>/dev/null"
check "... the LE one is left out, as UTF-32" last_alert_has 'wide32le.md (UTF-32, which the secret scan cannot read)'
check "... the BE one too" last_alert_has 'wide32be.md (UTF-32, which the secret scan cannot read)'
check "... the token is not in the alert or the log" sh -c "! grep -qF '$TOKEN' '$ALERTS' && ! grep -qF '$TOKEN' '$OUT'"
rm "$LIVE/wide32le.md" "$LIVE/wide32be.md"
printf 'a note\000with a NUL in it\n' >"$LIVE/nul.md"
mb run
check "a NUL in a note: left out, and said" last_alert_has 'nul.md (not text (binary or compressed))'
check "... not committed" sh -c "! git --git-dir='$R' cat-file -e '$(tip):memory/nul.md' 2>/dev/null"
rm "$LIVE/nul.md"
settings "MAX_FILE_KB=1"
head -c 2048 /dev/zero | tr '\0' 'a' >"$LIVE/big.md"
printf 'note e, again\n' >"$LIVE/e.md"
mb run
check "a file over the cap: the run goes on (exit 0)" rc_is 0
check "... the rest is committed" sh -c "git --git-dir='$R' cat-file blob '$(tip):memory/e.md' | grep -q again"
check "... the big file is not" sh -c "! git --git-dir='$R' cat-file -e '$(tip):memory/big.md' 2>/dev/null"
check "... and the alert says it is left out" last_alert_has 'big.md (over the 1 KB cap)'
rm "$LIVE/big.md"
settings
mb run
check "nothing left out: the all-clear" last_alert_has 'backing up again'

# ------------------------------------------------------------------ a missing or wiped folder

mv "$LIVE" "$T/live.away"
mb run
check "a missing folder: exit 1" rc_is 1
check "... reported" last_alert_has "the memory folder $LIVE is not there"
mv "$T/live.away" "$LIVE"
mb run
check "the folder back: exit 0, all-clear" sh -c "[ $RC = 0 ] && tail -n 3 '$ALERTS' | grep -q 'backing up again'"
n_c="$(commits)"
mkdir -p "$T/wiped"; mv "$LIVE"/* "$LIVE"/.gitattributes "$LIVE"/.github "$T/wiped/"
settings "MAX_REMOVED_PERCENT=100"
mb run
check "an emptied folder: held (exit 1)" rc_is 1
check "... reported" last_alert_has 'the memory folder is empty'
expect "... nothing committed" "$(commits)" "$n_c"
mv "$T/wiped"/* "$T/wiped"/.gitattributes "$T/wiped"/.github "$LIVE/"
mkdir -p "$T/live-empty"
printf 'NAME=example\nFOLDER=%s\nREMOTE=file://%s\nBRANCH=memory/empty\nSTATE=%s\nCHANNEL=%s\n' \
    "$T/live-empty" "$R" "$T/state-empty" "$CHAN" >"$T/set-empty"
mbs "$T/set-empty" run
check "an empty folder on the first run: held (exit 1)" rc_is 1
check "... reported" last_alert_has 'the memory folder is empty, so there is nothing to back up yet'
check "... no branch made" sh -c "! git --git-dir='$R' rev-parse -q --verify refs/heads/memory/empty"
settings
mkdir -p "$T/pruned"; mv "$LIVE/c.md" "$LIVE/e.md" "$LIVE/sub" "$T/pruned/"
printf 'note f, new\n' >"$LIVE/f.md"
mb run
check "a third of the notes gone at once: held (exit 1)" rc_is 1
check "... reported, with the way to take them on" last_alert_has '3 of 9 notes are gone from the folder, and their removal is held back'
expect "... the rest still goes in: one commit" "$(commits)" "$((n_c + 1))"
check "... with the new note" in_tip f.md
check "... and the removed notes kept as they were" sh -c "git --git-dir='$R' cat-file blob '$(tip):memory/c.md' | grep -qx 'note c' && git --git-dir='$R' cat-file -e '$(tip):memory/e.md' && git --git-dir='$R' cat-file -e '$(tip):memory/sub/d.md'"
n_alerts="$(alerts)"
mb run
check "... held again: exit 1" rc_is 1
expect "... no new commit" "$(commits)" "$((n_c + 1))"
expect "... no second alert" "$(alerts)" "$n_alerts"
# --accept-removals takes on the notes held back and no other: four more gone
# at once (over the limit) are held in their turn.
mv "$LIVE/a.md" "$LIVE/b.md" "$LIVE/MEMORY.md" "$LIVE/leak.md" "$T/pruned/"
mb run --accept-removals
check "--accept-removals with four more gone: held (exit 1)" rc_is 1
check "... the three held before taken on" sh -c "! git --git-dir='$R' cat-file -e '$(tip):memory/c.md' 2>/dev/null && ! git --git-dir='$R' cat-file -e '$(tip):memory/sub/d.md' 2>/dev/null"
check "... the four new ones held, and reported" sh -c "git --git-dir='$R' cat-file -e '$(tip):memory/a.md' && git --git-dir='$R' cat-file -e '$(tip):memory/leak.md' && tail -n 3 '$ALERTS' | grep -q '4 of 10 notes are gone'"
mb run --accept-removals
check "--accept-removals again: exit 0" rc_is 0
check "... the four taken on" sh -c "! git --git-dir='$R' cat-file -e '$(tip):memory/a.md' 2>/dev/null && ! git --git-dir='$R' cat-file -e '$(tip):memory/leak.md' 2>/dev/null"
check "... and the new note kept" in_tip f.md
mv "$T/pruned"/* "$LIVE/"
mb run
check "the notes back: exit 0" rc_is 0
rm "$LIVE/f.md"
mb run
check "f.md gone, one of ten: exit 0" rc_is 0

# The reviewer's case: 10 notes, 4 removed and held; then 10 new notes and 1
# more removed. The 4 stay held whatever their share now; the 1 more, under
# the share, goes in; no all-clear until --accept-removals.
mkdir -p "$T/liveH"
for i in 01 02 03 04 05 06 07 08 09 10; do printf 'n%s\n' "$i" >"$T/liveH/n$i.md"; done
printf 'NAME=example\nFOLDER=%s\nREMOTE=file://%s\nBRANCH=memory/held\nSTATE=%s\nCHANNEL=%s\n' \
    "$T/liveH" "$R" "$T/stateH" "$CHAN" >"$T/setH"
in_held() { git --git-dir="$R" cat-file -e "refs/heads/memory/held:memory/$1" 2>/dev/null; }
mbs "$T/setH" run
rm "$T/liveH/n01.md" "$T/liveH/n02.md" "$T/liveH/n03.md" "$T/liveH/n04.md"
mbs "$T/setH" run
check "held set: 4 of 10 removed, held (exit 1)" rc_is 1
for i in 01 02 03 04 05 06 07 08 09 10; do printf 'm%s\n' "$i" >"$T/liveH/m$i.md"; done
mbs "$T/setH" run
check "held set: 10 new notes: still held (exit 1)" rc_is 1
check "... the new notes in" in_held m10.md
check "... the 4 still on the branch" sh -c "for n in 01 02 03 04; do git --git-dir='$R' cat-file -e refs/heads/memory/held:memory/n\$n.md || exit 1; done"
n_alerts="$(alerts)"
rm "$T/liveH/n05.md"
mbs "$T/setH" run
check "held set: 1 more removed: still held (exit 1)" rc_is 1
check "... the 4 still on the branch" sh -c "for n in 01 02 03 04; do git --git-dir='$R' cat-file -e refs/heads/memory/held:memory/n\$n.md || exit 1; done"
check "... the 1 more, under the share, went in" sh -c "! git --git-dir='$R' cat-file -e refs/heads/memory/held:memory/n05.md 2>/dev/null"
expect "... no all-clear, no new alert" "$(alerts)" "$n_alerts"
mbs "$T/setH" run --accept-removals
check "held set: --accept-removals: exit 0" rc_is 0
check "... the 4 taken on" sh -c "! git --git-dir='$R' cat-file -e refs/heads/memory/held:memory/n01.md 2>/dev/null"
check "... and an all-clear" last_alert_has 'backing up again'

# ------------------------------------------------------------------ a write during a run

cat >"$T/stubs/mb-midrun" <<EOF
#!/bin/sh
[ -f "$T/state/midrun.done" ] && exit 0
touch "$T/state/midrun.done"
printf 'written during the run\n' >>"$LIVE/b.md"
EOF
chmod +x "$T/stubs/mb-midrun"
n_c="$(commits)"
printf 'note b, before the run\n' >"$LIVE/b.md"
t_env GP_MB_SETTINGS="$SET" GP_MB_SEND="$T/stubs/mb-send" GP_MB_GIT="$T/stubs/mb-git" \
    GP_MB_MID_RUN="$T/stubs/mb-midrun" "$TOOL" run >"$OUT" 2>&1
RC=$?
check "a write during a run: exit 0" rc_is 0
expect "... the same run backs it up too (two commits)" "$(commits)" "$((n_c + 2))"
check "... the tip holds it" sh -c "git --git-dir='$R' cat-file blob '$(tip):memory/b.md' | grep -q 'written during the run'"

# ------------------------------------------------------------------ restore

cp "$LIVE/c.md" "$T/c.orig"
rm "$LIVE/c.md"
mb restore --into "$T/r1"
check "restore after a delete: exit 1 (the live folder differs)" rc_is 1
check "restore after a delete: names the note" out_has 'only in the backup: c.md'
check "restore after a delete: the note comes back byte for byte" cmp -s "$T/r1/c.md" "$T/c.orig"
check "restore after a delete: the CRLF note too" cmp -s "$T/r1/a.md" "$ORIG/a.md"
check "restore after a delete: the live folder still lacks it" [ ! -e "$LIVE/c.md" ]
cp "$T/r1/c.md" "$LIVE/c.md"
mb restore --into "$T/r2"
check "restore with nothing missing: exit 0" rc_is 0
check "restore with nothing missing: matches byte for byte" out_has 'matches the live folder, byte for byte'
mb restore --into "$LIVE/restored"
check "restore into the live folder: refused (exit 2)" rc_is 2
check "restore into the live folder: nothing written there" [ ! -e "$LIVE/restored" ]
mb restore --into "$LIVE"
check "restore over the live folder: refused (exit 2)" rc_is 2
mb restore --into "$T"
check "restore above the live folder: refused (exit 2)" rc_is 2
mb restore --at 0123456789abcdef
check "restore of a commit not on the branch: refused (exit 2)" rc_is 2
printf 'changed under it\n' >"$LIVE/sub/d.md"
mb restore --into "$T/r3"
check "restore with a note changed: exit 1" rc_is 1
check "restore with a note changed: names it" out_has 'differs: sub/d.md'
printf 'deep\n' >"$LIVE/sub/d.md"
ln -s b.md "$LIVE/note-$TOKEN.md"
mb restore --into "$T/r6"
check "restore with a token-named entry in the live folder: listed by a placeholder" \
    grep -qF 'left out of every backup: (a name that holds a possible secret) (a symlink)' "$OUT"
check "... the token is not in the listing" sh -c "! grep -qF '$TOKEN' '$OUT'"
rm "$LIVE/note-$TOKEN.md"

# ------------------------------------------------------------------ crafted commits

# Commits no backup writes, put on the remote by hand: each must be refused,
# with nothing written outside the restore folder. A tree with two entries of
# one name is how a symlink and a folder can share a name.
cat >"$T/craft.py" <<'PY'
import subprocess, sys
gd, kind, outside = sys.argv[1], sys.argv[2], sys.argv[3]
def obj(k, data):
    return subprocess.run(["git", "--git-dir", gd, "hash-object", "-t", k, "--literally", "-w", "--stdin"],
                          input=data, capture_output=True, check=True).stdout.decode().strip()
def tree(entries):
    return obj("tree", b"".join(m.encode() + b" " + n.encode() + b"\0" + bytes.fromhex(o) for m, n, o in entries))
blob = obj("blob", b"pwned\n")
sub = tree([("100644", "pwn.md", blob)])
mem = {
    "symlink": [("120000", "evil", obj("blob", outside.encode())), ("40000", "evil", sub)],
    "dotdot": [("40000", "..", sub)],
    "twice": [("100644", "pwn.md", blob), ("100644", "pwn.md", blob)],
    "fileparent": [("100644", "evil", blob), ("40000", "evil", sub)],
}[kind]
top = tree([("40000", "memory", tree(mem))])
print(obj("commit", ("tree %s\nauthor a <a@example.com> 0 +0000\ncommitter a <a@example.com> 0 +0000\n\nx\n" % top).encode()))
PY
crafted() {   # kind check-env expected-message
    local kind="$1" env="$2" want="$3" c dest="$T/rx/$1-${2%%=*}" stray
    mkdir -p "$T/rx" "$T/outside-dir"
    c="$(python3 "$T/craft.py" "$R" "$kind" "$T/outside-dir")" && rgit update-ref "refs/heads/memory/evil-$kind" "$c"
    sed "s#^BRANCH=.*#BRANCH=memory/evil-$kind#" "$SET" >"$T/set-evil"
    t_env GP_MB_SETTINGS="$T/set-evil" GP_MB_GIT="$T/stubs/mb-git" "$env" "$TOOL" restore --into "$dest" >"$OUT" 2>&1
    RC=$?
    check "crafted $kind ($env): refused (exit 1)" rc_is 1
    check "crafted $kind ($env): refused by $want" out_has "$want"
    stray="$(find "$T" -name pwn.md ! -path "$dest/*" -print | head -n 1)"
    check "crafted $kind ($env): nothing written outside the restore folder" [ -z "$stray" ]
    check "crafted $kind ($env): nothing through the link" [ -z "$(ls -A "$T/outside-dir")" ]
}
crafted symlink GP_MB_X= "the fetch was refused"
crafted dotdot GP_MB_X= "the fetch was refused"
crafted symlink GP_MB_NO_FSCK=1 "refused: a symlink"
crafted dotdot GP_MB_NO_FSCK=1 "refused: an entry with a bad name"
crafted twice GP_MB_NO_FSCK=1 "refused: a path that is there twice"
crafted fileparent GP_MB_NO_FSCK=1 "refused: a parent of evil/pwn.md is not a folder"
check "crafted: a refusal found before writing leaves the restore folder empty" \
    sh -c "[ -z \"\$(ls -A '$T/rx/symlink-GP_MB_NO_FSCK')\" ] && [ -z \"\$(ls -A '$T/rx/twice-GP_MB_NO_FSCK')\" ]"

# ------------------------------------------------------------------ an auto-dream-like run

mb run
BEFORE_DREAM="$(tip)"
mkdir -p "$T/predream"; cp "$LIVE/MEMORY.md" "$LIVE/a.md" "$LIVE/c.md" "$T/predream/"
printf '# Memory index (consolidated)\n- [merged](merged.md)\n' >"$LIVE/MEMORY.md"
cat "$LIVE/a.md" "$LIVE/c.md" >"$LIVE/merged.md"
rm "$LIVE/a.md" "$LIVE/c.md"
mb run
check "dream: the rewrite is backed up" rc_is 0
expect "dream: one more commit" "$(rgit rev-parse "$(tip)^")" "$BEFORE_DREAM"
mb restore --at tip~1 --into "$T/r4"
check "dream: restore of the commit before: exit 1 (it differs from now)" rc_is 1
check "dream: MEMORY.md comes back byte for byte" cmp -s "$T/r4/MEMORY.md" "$T/predream/MEMORY.md"
check "dream: a pruned note comes back byte for byte" cmp -s "$T/r4/a.md" "$T/predream/a.md"
check "dream: the other pruned note too" cmp -s "$T/r4/c.md" "$T/predream/c.md"
check "dream: the merged note is not in it" [ ! -e "$T/r4/merged.md" ]
mb restore --at "$BEFORE_DREAM" --into "$T/r5"
check "dream: the same by commit id" cmp -s "$T/r5/MEMORY.md" "$T/predream/MEMORY.md"
cp "$T/predream/"* "$LIVE/" && rm "$LIVE/merged.md"
mb run

# ------------------------------------------------------------------ verify

n_alerts="$(alerts)"
mb verify
check "verify: exit 0 when the remote restores to the live folder" rc_is 0
check "verify: says so" out_has 'restores to the live folder, byte for byte'
expect "verify: no alert" "$(alerts)" "$n_alerts"
cat >"$T/stubs/mb-dream" <<EOF
#!/bin/sh
echo "\$\$" >>"$LIVE/b.md"
EOF
chmod +x "$T/stubs/mb-dream"
t_env GP_MB_SETTINGS="$SET" GP_MB_SEND="$T/stubs/mb-send" GP_MB_GIT="$T/stubs/mb-git" \
    GP_MB_AFTER_BACKUP="$T/stubs/mb-dream" "$TOOL" verify >"$OUT" 2>&1
RC=$?
check "verify: exit 1 when the folder keeps moving under it" rc_is 1
expect "verify: one alert" "$(alerts)" "$((n_alerts + 1))"
check "verify: the alert says the verify failed" last_alert_has 'the verify failed'
mb verify
check "verify: exit 0 once it holds still" rc_is 0
expect "verify: one all-clear" "$(alerts)" "$((n_alerts + 2))"
check "verify: the all-clear says it passes" last_alert_has 'the verify passes again'
mkdir -p "$LIVE/.Git"; printf 'x\n' >"$LIVE/.Git/x"
ln -s b.md "$LIVE/link.md"
mb verify
check "verify with entries no backup keeps: exit 1" rc_is 1
check "... lists them" sh -c "grep -q 'left out of every backup: .Git' '$OUT' && grep -q 'left out of every backup: link.md (a symlink)' '$OUT'"
check "... and alerts" last_alert_has 'are in no backup'
rm -r "$LIVE/.Git" "$LIVE/link.md"
# A token-named entry that lands after the verify's backup (a backup holds a
# run whose names hold one): the verify lists it, and alerts, by a placeholder.
cat >"$T/stubs/mb-tokenname" <<EOF
#!/bin/sh
[ -L "$LIVE/note-$TOKEN.md" ] || ln -s b.md "$LIVE/note-$TOKEN.md"
EOF
chmod +x "$T/stubs/mb-tokenname"
t_env GP_MB_SETTINGS="$SET" GP_MB_SEND="$T/stubs/mb-send" GP_MB_GIT="$T/stubs/mb-git" \
    GP_MB_AFTER_BACKUP="$T/stubs/mb-tokenname" "$TOOL" verify >"$OUT" 2>&1
RC=$?
rm "$LIVE/note-$TOKEN.md"
check "verify with a token-named entry left out: exit 1" rc_is 1
check "... the alert names it by a placeholder" last_alert_has 'in no backup: (a name that holds a possible secret) (a symlink)'
check "... the token is not in the alert" sh -c "! grep -qF '$TOKEN' '$ALERTS'"
check "... nor in the listing" sh -c "! grep -qF '$TOKEN' '$OUT'"
mb verify
check "verify: passes again once they are gone" rc_is 0

# ------------------------------------------------------------------ a push the remote refuses

touch "$T/state/refuse-big"
TIPR="$(tip)"
head -c 3000 /dev/zero | tr '\0' 'b' >"$LIVE/bigish.md"
mb run
check "a refused push: exit 1" rc_is 1
check "... reported, with the remote's reason" last_alert_has 'the remote refused the push'
expect "... the remote left as it is" "$(tip)" "$TIPR"
expect "... the local branch stays at the remote's tip" "$(local_tip)" "$TIPR"
rm "$LIVE/bigish.md"
mb run
check "... it recovers once the file is gone (exit 0)" rc_is 0
check "... with an all-clear" last_alert_has 'backing up again'
check "... and nothing was dropped" [ -z "$(git --git-dir="$STATE_D/repo.git" for-each-ref refs/dropped/)" ]
# Two runs while the remote is out of reach: two commits wait here, and x.md is
# in the first alone. The remote then refuses the push (the big file is in the
# first): both commits leave the branch, are kept under refs/dropped/, and an
# alert says how many and where; the folder as it is goes in afresh.
touch "$T/state/lsremote.fails" "$T/state/push.fails"
head -c 3000 /dev/zero | tr '\0' 'b' >"$LIVE/bigish.md"
printf 'only during the outage\n' >"$LIVE/x.md"
printf 'note b, offline\n' >"$LIVE/b.md"
mb run
rm "$LIVE/bigish.md" "$LIVE/x.md"
printf 'note b, offline, again\n' >"$LIVE/b.md"
mb run
rm "$T/state/lsremote.fails" "$T/state/push.fails"
WAITING="$(local_tip)"
expect "offline: two commits wait here" "$(git --git-dir="$STATE_D/repo.git" rev-list --count "$(tip)..$WAITING")" 2
mb run
check "a refused push of waiting commits: the run recovers (exit 0)" rc_is 0
check "... the folder reached the remote" sh -c "git --git-dir='$R' cat-file blob '$(tip):memory/b.md' | grep -q 'offline, again'"
check "... without the big file anywhere in its history" sh -c "! git --git-dir='$R' rev-list --objects '$(tip)' | grep -q bigish.md"
expect "... the local branch is the remote's" "$(local_tip)" "$(tip)"
DROPPED="$(git --git-dir="$STATE_D/repo.git" for-each-ref --format='%(refname)' refs/dropped/ | tail -n 1)"
check "... the waiting commits kept under refs/dropped/" sh -c "[ -n '$DROPPED' ] && [ \"\$(git --git-dir='$STATE_D/repo.git' rev-parse '$DROPPED')\" = '$WAITING' ]"
check "... x.md comes back from it, byte for byte" sh -c "git --git-dir='$STATE_D/repo.git' cat-file blob '$DROPPED~1:memory/x.md' | grep -qx 'only during the outage'"
check "... an alert says how many commits, and where" sh -c "grep -q '2 commit(s) made on this machine never reached the remote' '$ALERTS' && grep -qF '$DROPPED' '$ALERTS'"
check "... refs/dropped/ never reaches the remote" [ -z "$(rgit for-each-ref refs/dropped/)" ]
rm "$T/state/refuse-big"

# ------------------------------------------------------------------ the history is never rewritten

# A writer elsewhere moves the branch; this machine cannot see the remote, so
# it builds on its own tip, and the push must be refused, never forced.
TIP0="$(tip)"
git clone -q -b "$BR" "$R" "$T/other"
echo other >"$T/other/memory/other.md"
git -C "$T/other" add -A 2>/dev/null && git -C "$T/other" commit -q -m other && git -C "$T/other" push -q origin "$BR"
OTHER="$(tip)"
printf 'note b, again\n' >"$LIVE/b.md"
touch "$T/state/lsremote.fails"
n_alerts="$(alerts)"
mb run
rm "$T/state/lsremote.fails"
check "refused push: exit 1" rc_is 1
expect "refused push: the remote keeps the other writer's commit" "$(tip)" "$OTHER"
expect "refused push: ... and its history" "$(rgit rev-parse "$OTHER^")" "$TIP0"
expect "refused push: one alert" "$(alerts)" "$((n_alerts + 1))"
check "refused push: the alert says it was not a fast-forward" last_alert_has 'not a fast-forward'
expect "refused push: the local branch did not move" "$(local_tip)" "$TIP0"
mb run
check "another writer: held (exit 1)" rc_is 1
expect "another writer: the remote left as it is" "$(tip)" "$OTHER"
check "another writer: the alert says so" last_alert_has 'holds commits this machine did not make'
mb run --adopt-remote
check "taken on with --adopt-remote: exit 0" rc_is 0
expect "... built on the other writer's commit" "$(rgit rev-parse "$(tip)^")" "$OTHER"
# A local branch that is only ahead (a commit that waited out an outage):
# --adopt-remote keeps it, and the commit reaches the remote.
touch "$T/state/push.fails"
printf 'note b, ahead\n' >"$LIVE/b.md"
mb run
rm "$T/state/push.fails"
AHEAD="$(local_tip)"
n_dropped="$(git --git-dir="$STATE_D/repo.git" for-each-ref refs/dropped/ | wc -l)"
mb run --adopt-remote
check "--adopt-remote with the branch here only ahead: exit 0" rc_is 0
check "... the waiting commit reached the remote" git --git-dir="$R" merge-base --is-ancestor "$AHEAD" "refs/heads/$BR"
expect "... nothing dropped" "$(git --git-dir="$STATE_D/repo.git" for-each-ref refs/dropped/ | wc -l)" "$n_dropped"
# Commits of this machine's own that moved apart (the branch here waited
# offline while the remote moved to a commit this machine also knows).
touch "$T/state/push.fails"
printf 'note b, apart\n' >"$LIVE/b.md"
mb run
rm "$T/state/push.fails"
git -C "$T/other" pull -q origin "$BR" 2>/dev/null
echo other2 >"$T/other/memory/other2.md"
git -C "$T/other" add -A 2>/dev/null && git -C "$T/other" commit -q -m other2 && git -C "$T/other" push -q origin "$BR"
OTHER2="$(tip)"
echo "$OTHER2" >>"$STATE_D/made"
mb run
check "moved apart: held (exit 1)" rc_is 1
expect "moved apart: the remote left as it is" "$(tip)" "$OTHER2"
check "moved apart: the alert says so" last_alert_has 'moved apart'
check "moved apart: ... and names the way out" last_alert_has 'run --adopt-remote'
APART="$(local_tip)"
n_left="$(grep -c 'left the branch' "$ALERTS")"
mb run --adopt-remote
check "moved apart, taken on with --adopt-remote: exit 0" rc_is 0
expect "... built on the remote's tip" "$(rgit rev-parse "$(tip)^")" "$OTHER2"
check "... the commit made here kept under refs/dropped/" sh -c "git --git-dir='$STATE_D/repo.git' for-each-ref --format='%(objectname)' refs/dropped/ | grep -qx '$APART'"
expect "... and reported, once" "$(grep -c 'left the branch' "$ALERTS")" "$((n_left + 1))"

# Two machines, two folders, one branch: A, then B, then A. B holds at once;
# taken on, it builds on A; A then holds.
mkdir -p "$T/liveA" "$T/liveB"
printf 'a one\n' >"$T/liveA/one.md"; printf 'a two\n' >"$T/liveA/two.md"
cp "$T/liveA/"* "$T/liveB/"; printf 'b three\n' >"$T/liveB/three.md"
for m in A B; do
    printf 'NAME=example\nFOLDER=%s\nREMOTE=file://%s\nBRANCH=memory/two\nSTATE=%s\nCHANNEL=%s\n' \
        "$T/live$m" "$R" "$T/state$m" "$CHAN" >"$T/set$m"
done
two() { rgit rev-parse -q --verify refs/heads/memory/two; }
mbs "$T/setA" run
check "two machines: A's first run: exit 0" rc_is 0
TWO_A="$(two)"
n_alerts="$(alerts)"
mbs "$T/setB" run
check "two machines: B holds at once (exit 1)" rc_is 1
expect "two machines: ... the remote left as it is" "$(two)" "$TWO_A"
expect "two machines: ... one alert" "$(alerts)" "$((n_alerts + 1))"
mbs "$T/setB" run --adopt-remote
check "two machines: B taken on: exit 0" rc_is 0
TWO_B="$(two)"
expect "two machines: B built on A" "$(rgit rev-parse "$TWO_B^")" "$TWO_A"
mbs "$T/setA" run
check "two machines: A then holds (exit 1)" rc_is 1
expect "two machines: ... the remote left as it is" "$(two)" "$TWO_B"
check "two machines: ... and alerts" last_alert_has 'holds commits this machine did not make'

# A remote out of reach: commits wait here; the fourth run in a row says so.
touch "$T/state/lsremote.fails" "$T/state/push.fails"
n_alerts="$(alerts)"
for i in 1 2 3; do printf 'off %s\n' "$i" >>"$LIVE/b.md"; mb run; done
check "out of reach: exit 1" rc_is 1
expect "out of reach: three runs, no alert yet" "$(alerts)" "$n_alerts"
check "out of reach: the commits wait here" [ "$(git --git-dir="$STATE_D/repo.git" rev-list --count "$(tip)..$(local_tip)")" = 3 ]
mb run
expect "out of reach: the fourth run alerts" "$(alerts)" "$((n_alerts + 1))"
rm "$T/state/lsremote.fails" "$T/state/push.fails"
mb run
check "back in reach: exit 0" rc_is 0
expect "back in reach: every waiting commit pushed" "$(tip)" "$(local_tip)"
check "back in reach: one all-clear" last_alert_has 'backing up again'

# A rebuilt machine: a new state folder, and the remote already holds the
# folder. It holds until told the history is its own; then it catches up.
n_c="$(commits)"
mv "$STATE_D" "$T/mbstate.old"
mb run
check "rebuilt machine: held until told (exit 1)" rc_is 1
mb run --adopt-remote
check "rebuilt machine: taken on: exit 0" rc_is 0
expect "rebuilt machine: no new commit" "$(commits)" "$n_c"
expect "rebuilt machine: the local branch catches up with the remote's" "$(local_tip)" "$(tip)"
mb verify
check "rebuilt machine: the verify passes" rc_is 0

expect "the live folder was never written by a run, a restore or a verify" "$TOUCHED" 0

# ------------------------------------------------------------------ alerts as task roots

# With TASK_EMOJI (the manifest's buzz_task_open_emoji), an alert gets the
# open state once it is sent; an all-clear does not; a failure to set it is
# logged and changes nothing else.
tasks() { if [ -f "$TASKS" ]; then wc -l <"$TASKS" | tr -d ' '; else echo 0; fi; }
IMG="https://media.example.com/open.gif"
n_t="$(tasks)"
mv "$LIVE" "$T/live.away"
mb run
check "no task emoji: an alert, no state" sh -c "[ $RC = 1 ] && [ $(tasks) = $n_t ]"
mv "$T/live.away" "$LIVE"; mb run
settings "TASK_EMOJI=open-loop" "TASK_EMOJI_URL=$IMG"
mv "$LIVE" "$T/live.away"
n_a="$(alerts)"
mb run
check "task emoji: the alert goes out" sh -c "[ $RC = 1 ] && [ $(alerts) = $((n_a + 1)) ]"
check "task emoji: one task call, open on the event the send printed" \
    grep -q "^argv=task set --channel $CHAN --id $(printf '%064d' 2) --state open emoji=open-loop url=$IMG state=" "$TASKS"
check "task emoji: marked only once the alert's state was written (never while it read clean)" \
    sh -c "tail -n 1 '$TASKS' | grep -q ' state=[a-z]' && ! grep -q ' state=clean\$' '$TASKS'"
check "task emoji: logged" out_has 'alert marked open \(a task root\)'
mv "$T/live.away" "$LIVE"
n_t="$(tasks)"
mb run
check "the all-clear: no state" sh -c "[ $RC = 0 ] && [ $(tasks) = $n_t ] && tail -n 3 '$ALERTS' | grep -q 'backing up again'"
settings "TASK_EMOJI=⭕"
echo 3 >"$T/state/task.rc"
mv "$LIVE" "$T/live.away"
n_a="$(alerts)"
mb run
check "the task tool fails: the alert still went out" sh -c "[ $(alerts) = $((n_a + 1)) ]"
check "... logged" out_has 'alert NOT marked open: the task tool exited 3'
mb run
check "... and it is not sent again" sh -c "[ $(alerts) = $((n_a + 1)) ] && grep -q 'already reported' '$OUT'"
rm -f "$T/state/task.rc"
mv "$T/live.away" "$LIVE"; mb run
settings "TASK_EMOJI=a b"
mb run
check "a TASK_EMOJI of the wrong form: refused (exit 2)" rc_is 2
settings

# ------------------------------------------------------------------ the hook

if t_tool jq; then
    HK="$T/hookcopy/hooks"; mkdir -p "$HK"
    cp -R "$SRC/hooks/lib" "$HK/lib"; mkdir -p "$T/hookcopy/install"; cp -R "$SRC/install/lib" "$T/hookcopy/install/lib"
    sed -e "s#^MB_LIBDIR=.*#MB_LIBDIR=$T/mblib#" -e "s#^MB_OWNER=0\$#MB_OWNER=$(id -u)#" "$HOOK_SRC" >"$HK/memory-backup"
    chmod +x "$HK/memory-backup"
    mkdir -p "$T/mblib/example/memory-backup" "$T/hstate" "$T/elsewhere" "${LIVE}-other"
    printf 'NAME=example\nFOLDER=%s\nSTATE=%s\n' "$(cd "$LIVE" && pwd -P)" "$T/hstate" >"$T/mblib/example/memory-backup/settings"
    ln -s "$LIVE" "$T/to-live"
    hook() {   # file path [env...]
        local f="$1"; shift
        rm -f "$T/hstate/trigger"
        printf '{"tool_name":"Write","cwd":"%s","tool_input":{"file_path":"%s"}}' "$T" "$f" \
            | t_env "$@" "$HK/memory-backup" >"$OUT" 2>&1
        RC=$?
    }
    hook "$LIVE/new.md"
    check "hook: a write in the folder writes the trigger" [ -s "$T/hstate/trigger" ]
    check "hook: exit 0, silent" sh -c "[ $RC = 0 ] && [ ! -s '$OUT' ]"
    hook "$LIVE/sub/x.md"
    check "hook: a write in a subfolder too" [ -s "$T/hstate/trigger" ]
    hook "$T/elsewhere/x.md"
    check "hook: a write elsewhere does not" [ ! -e "$T/hstate/trigger" ]
    hook "$LIVE/../elsewhere/x.md"
    check "hook: a path through .. that lands outside does not" [ ! -e "$T/hstate/trigger" ]
    hook "${LIVE}-other/x.md"
    check "hook: a folder that only starts with its name does not" [ ! -e "$T/hstate/trigger" ]
    hook "$T/to-live/y.md"
    check "hook: a path through a symlink into it does" [ -s "$T/hstate/trigger" ]
    hook "$LIVE/new.md" CLAUDE_PLUGIN_OPTION_MEMORY_BACKUP=off
    check "hook: switched off, nothing" [ ! -e "$T/hstate/trigger" ]
    mv "$T/mblib/example/memory-backup/settings" "$T/mbsettings"; ln -s "$T/mbsettings" "$T/mblib/example/memory-backup/settings"
    hook "$LIVE/new.md"
    check "hook: a settings file that is a symlink is ignored" [ ! -e "$T/hstate/trigger" ]
    rm "$T/mblib/example/memory-backup/settings"; mv "$T/mbsettings" "$T/mblib/example/memory-backup/settings"
    sed -e "s#^MB_LIBDIR=.*#MB_LIBDIR=$T/mblib#" "$HOOK_SRC" >"$HK/memory-backup"
    hook "$LIVE/new.md"
    check "hook: a settings file not owned by root is ignored" [ ! -e "$T/hstate/trigger" ]
else
    echo "SKIP  the hook cases (no jq on this machine)"
fi

if [ -n "${MB_BACKUP:-}${MB_HOOK:-}" ]; then finish_tests; exit $?; fi

# ------------------------------------------------------------------ the manifest

GP_DIR="$SRC"
# shellcheck source=../lib/common.sh
. "$SRC/install/lib/common.sh"
# shellcheck source=../lib/instance.sh
. "$SRC/install/lib/instance.sh"
man() {   # memory_backup lines...
    { cat "$FIX/manifests/good-v1.toml"; printf '\n[memory_backup]\n'; printf '%s\n' "$@"; } >"$T/m.toml"
    manifest_load "$T/m.toml"
}
GOOD=('folder = "~/.claude/projects/-x/memory"' 'remote = "https://github.example.com/example/instance.git"' 'branch = "memory/instance"')
man "${GOOD[@]}" && ok "manifest: a good section is accepted (v1)" || bad "manifest: a good section is accepted (v1): $MANIFEST_ERRORS"
expect "manifest: its values are read" "$M_MEMORY_BACKUP_BRANCH $M_MEMORY_BACKUP_SET" "memory/instance 1"
{ cat "$FIX/manifests/good.toml"; printf '\n[memory_backup]\n'; printf '%s\n' "${GOOD[@]}"; } >"$T/m0.toml"
manifest_load "$T/m0.toml" && ok "manifest: a good section is accepted (v0)" || bad "manifest: a good section is accepted (v0): $MANIFEST_ERRORS"
man "${GOOD[0]}" "${GOOD[1]}" 'branch = "main"'; check "manifest: branch main is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[0]}" "${GOOD[1]}" 'branch = "memory"'; check "manifest: a branch outside memory/ is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[0]}" 'remote = "https://u:t@example.com/example/instance.git"' "${GOOD[2]}"
check "manifest: a remote with a user and token is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[0]}" 'remote = "ssh://example.com/example/instance.git"' "${GOOD[2]}"
check "manifest: a remote that is not https is refused" [ -n "$MANIFEST_ERRORS" ]
man 'folder = "~/a/../b"' "${GOOD[1]}" "${GOOD[2]}"; check "manifest: a folder through .. is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[1]}" "${GOOD[2]}"; check "manifest: a missing folder is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[@]}" "buzz_channel = \"$CHAN\""; check "manifest: a channel without a relay and a key command is refused" [ -n "$MANIFEST_ERRORS" ]
man 'enabled = "false"'; check "manifest: enabled false needs nothing else" [ -z "$MANIFEST_ERRORS" ]
man "${GOOD[@]}" 'max_file_kb = "512"' 'max_removed_percent = "40"'
check "manifest: the size cap and the removal limit are read" [ -z "$MANIFEST_ERRORS" ] && [ "$M_MEMORY_BACKUP_MAX_REMOVED" = 40 ]
man "${GOOD[@]}" 'max_removed_percent = "101"'; check "manifest: a removal limit over 100 is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[@]}" 'max_file_kb = "0"'; check "manifest: a size cap of 0 is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[@]}" 'what = "x"'; check "manifest: an unknown key is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[@]}" 'buzz_task_open_emoji = "open-loop"' 'buzz_task_open_emoji_url = "https://media.example.com/open.gif"'
check "manifest: a custom task emoji with its image is read" sh -c "[ -z '$MANIFEST_ERRORS' ] && [ '$M_MEMORY_BACKUP_TASK_EMOJI' = open-loop ]"
man "${GOOD[@]}" 'buzz_task_open_emoji = "⭕"'; check "manifest: a plain task emoji is accepted" [ -z "$MANIFEST_ERRORS" ]
man "${GOOD[@]}" 'buzz_task_open_emoji = "open-loop"'; check "manifest: a custom task emoji without its image is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[@]}" 'buzz_task_open_emoji = "open-loop"' 'buzz_task_open_emoji_url = "http://media.example.com/open.gif"'
check "manifest: a task emoji image that is not https is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[@]}" 'buzz_task_open_emoji = "⭕"' 'buzz_task_open_emoji_url = "https://media.example.com/open.gif"'
check "manifest: an image for a plain task emoji is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[@]}" 'buzz_task_open_emoji = "Open Loop"'; check "manifest: a task emoji of the wrong form is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[@]}" 'buzz_task_open_emoji = "🚨"'; check "manifest: the emergency emoji as the task emoji is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[@]}" 'buzz_task_open_emoji = "✅"'; check "manifest: the done default as the open emoji is refused" [ -n "$MANIFEST_ERRORS" ]
man "${GOOD[@]}" 'buzz_task_open_emoji_url = "https://media.example.com/open.gif"'; check "manifest: a task emoji image alone is refused" [ -n "$MANIFEST_ERRORS" ]

# ------------------------------------------------------------------ the templates

TPL="$SRC/install/memory-backup/memory-backup.service"
check "service template: runs the root-owned copy" grep -qx 'ExecStart=@LIB@/backup @COMMAND@' "$TPL"
check "service template: the folder, read-only" grep -qx 'BindReadOnlyPaths=-@FOLDER@' "$TPL"
check "service template: the home hidden" grep -qx 'ProtectHome=tmpfs' "$TPL"
check "service template: nothing writable but the state" grep -qx 'ProtectSystem=strict' "$TPL"
check "service template: no root" sh -c "! grep -qE '^User=root' '$TPL'"
check "path template: the trigger in the state folder" grep -qx 'PathChanged=@STATE@/trigger' "$SRC/install/memory-backup/memory-backup.path"
check "backup: /usr/bin/python3, by its path" grep -qx 'PYTHON=/usr/bin/python3' "$REAL"
PUSH_LINE="$(grep '# guard:push$' "$REAL")"
case "$PUSH_LINE" in
    *--force* | *'f"+{'*) bad "backup: the push line has no --force and no + in its refspec" ;;
    *'f"{commit}:{REF}"'*) ok "backup: the push line has no --force and no + in its refspec" ;;
    *) bad "backup: the push line has no --force and no + in its refspec (no push line found)" ;;
esac

# ------------------------------------------------------------------ the step

mb_world() {
    t_new; t_std_env
    t_stub systemctl; t_stub node; t_tool install; t_tool python3 >/dev/null
    printf '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo x86_64 ;; *) echo Linux ;; esac\n' >"$T/stubs/uname"
    chmod +x "$T/stubs/uname"
    H="$T/home/work/instance"
    mkdir -p "$H/.ghost-protocol" "$T/home/.claude/projects/-x/memory"
    { cat "$FIX/manifests/good-v1.toml"; printf '\n[memory_backup]\n'; printf '%s\n' "${GOOD[@]}"; } >"$H/.ghost-protocol/instance.toml"
    printf '# index\n' >"$T/home/.claude/projects/-x/memory/MEMORY.md"
    printf 'a note\n' >"$T/home/.claude/projects/-x/memory/a.md"
    R="$T/remote/instance.git"; git init -q --bare "$R"
    cp "$OLD_T/stubs/mb-git" "$T/stubs/mb-git"; sed -i.bak "s#file://[^\"]*\"#file://$R\"#" "$T/stubs/mb-git"
    mkdir -p "$T/etc/systemd/system" "$T/usrlib" "$T/varlib"
}
setup() {
    t_env GP_ETC="$T/etc" GP_LIBDIR="$T/usrlib" GP_VARLIB="$T/varlib" GP_MB_GIT="$T/stubs/mb-git" \
        "$SETUP" --home "$H" "$@" >"$OUT" 2>&1
    RC=$?
}
OLD_T="$T"
mb_world
LIBD="$T/usrlib/ghost-protocol/instance/memory-backup"
U="$T/etc/systemd/system"
before="$(t_snapshot)"
setup
check "setup dry run: exit 0" rc_is 0
check "setup dry run: PLAN" out_has 'PLAN +memory-backup +would install the memory backup'
check "setup dry run: the settings in full" out_has "^    \\| BRANCH=memory/instance\$"
check "setup dry run: the backup unit in full" out_has '^    \| ExecStart=.*/memory-backup/backup run$'
check "setup dry run: the verify unit in full" out_has '^    \| ExecStart=.*/memory-backup/backup verify$'
check "setup dry run: the timers" sh -c "grep -q '^    | OnCalendar=\\*:0/15\$' '$OUT' && grep -q '^    | OnCalendar=\\*:07\$' '$OUT'"
check "setup dry run: the path unit" out_has "^    \\| PathChanged=$T/varlib/ghost-protocol/instance-memory-backup/trigger\$"
check "setup dry run: what the first backup would commit" out_has 'dry run: would commit 2 added, 0 changed, 0 removed'
check "setup dry run: notes that alerts are logged only" out_has 'alerts are logged only'
check "setup dry run: no sudo" not_called sudo
check "setup dry run: nothing written" sh -c "[ ! -e '$LIBD' ] && [ -z \"\$(ls '$U')\" ]"
check "setup dry run: HOME unchanged" [ "$(t_snapshot)" = "$before" ]
check "setup dry run: nothing pushed" sh -c "! git --git-dir='$R' rev-parse -q --verify refs/heads/memory/instance"
check "setup dry run: no temp folder left" no_temp_left

touch "$T/state/sudo.allow"
setup --apply --yes
check "setup apply: exit 0" rc_is 0
check "setup apply: DONE" out_has 'DONE +memory-backup +installed, the timers running'
check "setup apply: the backup copied" cmp -s "$LIBD/backup" "$REAL"
check "setup apply: the settings beside it" grep -qx "FOLDER=$T/home/.claude/projects/-x/memory" "$LIBD/settings"
check "setup apply: no alerts setting without a channel" sh -c "! grep -q '^CHANNEL=' '$LIBD/settings'"
for u in memory-backup.service memory-backup.timer memory-backup.path memory-verify.service memory-verify.timer; do
    check "setup apply: $u written, every placeholder filled" sh -c "[ -f '$U/instance-$u' ] && ! grep -q '@[A-Z_]*@' '$U/instance-$u'"
done
check "setup apply: the unit binds the real folder read-only" grep -qx "BindReadOnlyPaths=-$T/home/.claude/projects/-x/memory" "$U/instance-memory-backup.service"
check "setup apply: the unit runs as the user" grep -qx "User=$(id -un)" "$U/instance-memory-backup.service"
check "setup apply: daemon-reload" called "systemctl daemon-reload"
check "setup apply: the timers and the path enabled" sh -c "[ -f '$T/state/memunit.instance-memory-backup.timer.enabled' ] && [ -f '$T/state/memunit.instance-memory-backup.path.enabled' ] && [ -f '$T/state/memunit.instance-memory-verify.timer.enabled' ]"
check "setup apply: one backup and one verify, units in place" sh -c "grep -q '^systemctl start: instance-memory-backup.service in place' '$T/state/calls' && grep -q '^systemctl start: instance-memory-verify.service in place' '$T/state/calls'"
check "setup apply: no temp folder left" no_temp_left
setup --apply --yes
check "setup again: nothing to do" out_has 'OK +memory-backup +installed and running, and a verify just passed'
check "setup again: ... after a verify" sh -c "[ \"\$(grep -c '^systemctl start: instance-memory-verify.service' '$T/state/calls')\" -ge 2 ]"
touch "$T/state/memunit.start-fails"
setup --apply --yes
check "setup again, the verify failing: exit 1" rc_is 1
check "... says so" out_has 'FAIL +memory-backup +installed and running, but the verify exited non-zero'
check "... and never OK" out_lacks 'OK +memory-backup'
rm "$T/state/memunit.start-fails"
setup
check "setup again, a dry run: OK, and it says a verify runs with --apply" sh -c "grep -qE 'OK +memory-backup +installed and running \\(a dry run runs no verify\\)' '$OUT'"
setup --uninstall --apply --yes
check "uninstall: exit 0" rc_is 0
check "uninstall: the units gone" sh -c "[ -z \"\$(ls '$U' | grep memory)\" ]"
check "uninstall: the copy gone" [ ! -e "$LIBD" ]
check "uninstall: the timers disabled" [ ! -f "$T/state/memunit.instance-memory-backup.timer.enabled" ]
check "uninstall: says the state folder stays" out_has 'the state folder .* stays'
setup --manifest "$H/.ghost-protocol/instance.toml" --apply
check "setup: --manifest with --apply is refused" rc_is 2
# An --apply that installs nothing, or whose first run fails, exits non-zero.
touch "$T/state/memunit.start-fails"
setup --apply --yes
check "setup apply, the first backup failing: exit 1" rc_is 1
check "... says so" out_has 'FAIL +memory-backup +installed, but the first backup exited non-zero'
check "... and never says it is done" out_lacks 'DONE +memory-backup'
rm "$T/state/memunit.start-fails"
sed -i.bak '/^\[memory_backup\]/,$d' "$H/.ghost-protocol/instance.toml"
setup --apply --yes
check "setup apply, no [memory_backup]: exit 1" rc_is 1
check "... says nothing was installed" out_has 'FAIL +memory-backup +nothing installed'
setup
check "setup dry run, no [memory_backup]: exit 0 (a SKIP line)" rc_is 0

if [ -n "${MB_SETUP:-}" ]; then finish_tests; exit $?; fi

# ------------------------------------------------------------------ mutation check

T="$OLD_T"
M="$T/mutants"; mkdir -p "$M"
STARTED="" RUNNING=0
mutant() {   # name, sed program, [backup (default), hook, or lib (install/lib/memory-backup.sh)]
    local name="$1" prog="$2" src="$REAL" var=MB_BACKUP f run
    f="$M/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"
    run="$f"
    case "${3:-backup}" in
        hook) src="$REAL_HOOK"; var=MB_HOOK ;;
        lib)  # a copy of the checkout with the install step changed; setup runs from it
              src="$SRC/install/lib/memory-backup.sh"; var=MB_SETUP; run="$f.src/install/memory-backup/setup"
              mkdir -p "$f.src" && (cd "$SRC" && tar --exclude=./.git -cf - .) | (cd "$f.src" && tar -xf -) ;;
    esac
    sed -e "$prog" "$src" >"$f"; chmod +x "$f"
    if cmp -s "$f" "$src"; then bad "mutant $name: the sed changed nothing"; return; fi
    [ "${3:-backup}" = lib ] && cp "$f" "$f.src/install/lib/memory-backup.sh"
    if [ "$RUNNING" -ge 3 ]; then wait; RUNNING=0; fi
    (env "$var=$run" bash "${BASH_SOURCE[0]}" >"$f.out" 2>&1) &
    RUNNING=$((RUNNING + 1))
    STARTED="$STARTED$f|$name
"
}
mutant "no check for an unchanged folder"   's/unchanged = bool(base) and tree == base_tree   # guard:unchanged/unchanged = False/'
mutant "the scan skipped"                   's/hits = scan(files, added + changed)/hits = []/'
mutant "the scan of new files only"         's/hits = scan(files, added + changed)/hits = scan(files, added)/'
mutant "a scan hit ignored"                 's/if hits:   # guard:scan/if False:/'
mutant "a token after an _ missed"          's/^B = r"(?<!\[A-Za-z0-9\])"   # guard:boundary$/B = r"\\b"/'
mutant "GitHub tokens: letters and digits only" 's/gh\[pousr\]_\[A-Za-z0-9_.-\]{36,}/gh[pousr]_[A-Za-z0-9]{36,}/'
mutant "UTF-16 not read"                    's/if data\[:2\] in (b"\\xff\\xfe", b"\\xfe\\xff"):   # guard:utf16/if False:/'
mutant "file names not scanned"             's/if name_hits:   # guard:filenames/if False:/'
mutant "binary files kept"                  's/if text is None:   # guard:text/if False:/'
mutant "UTF-32 read as UTF-16"              's/if data\[:4\] in (b"\\xff\\xfe\\x00\\x00", b"\\x00\\x00\\xfe\\xff"):   # guard:utf32/if False:/'
mutant "a NUL in decoded text kept"         's/if "\\0" in text:   # guard:nul/if False:/'
mutant "a token-named entry shown"          's/return SECRET_NAME if scan_text(s) else s   # guard:safename/return s/'
mutant "no size cap"                        's/elif st.st_size > MAX_FILE_BYTES:   # guard:size/elif False:/'
mutant "a missing folder not reported"      's/if not os.path.isdir(FOLDER):   # guard:missing/if False:/'
mutant "an emptied folder committed"        's/if not files:   # guard:empty/if False:/'
mutant "mass removals committed"            's/if len(beyond) \* 100 > MAX_REMOVED_PERCENT \* n_base:   # guard:removals/if False:/'
mutant "another writer taken in"            's/elif remote not in made:   # guard:foreign/elif False:/'
mutant "a forced push"                      's/"push", "--porcelain"/"push", "--force", "--porcelain"/'
mutant "a + in the push refspec"            's/f"{commit}:{REF}", check=False)   # guard:push/f"+{commit}:{REF}", check=False)/'
mutant "no reset after a refused push"      's/set_local(gitdir, remote, local)   # guard:reset/pass/'
mutant "no fresh commit after a refused push" 's/if reachable and base != remote and not rebuilt:   # guard:rebuild/if False:/'
mutant "a write during a run left for later" 's/if not folder_moved(gitdir, seen):   # guard:again/if True:/'
mutant "any branch, main too"               's/^.*# guard:branch.*$/    "BRANCH": r"[a-z0-9\/-]+",/'
mutant "the folder at the top of the tree"  's/PREFIX + rel)   # guard:prefix/rel)/'
mutant "a remote that moved apart taken as behind" 's/elif is_ancestor(gitdir, remote, local):   # guard:diverged/elif True:/'
mutant "a restore into the live folder"     's/if inside(into, FOLDER):   # guard:live/if False:/'
mutant "a verify that ignores a mismatch"   's/if only_b or only_l or differ:   # guard:mismatch/if False:/'
mutant "a verify blind to what is left out" 's/if left_out:   # guard:leftout/if False:/'
mutant "a compare that ignores content"     's/if fa\[p\] != fb\[p\])   # guard:compare/if False)/'
mutant "the local branch never catches up"  's/if base and base != local and not dry:   # guard:catchup/if False:/'
mutant "no check of the fetched objects"     's/^        else "\[transfer\].*# guard:fsck$/        else "")/'
mutant "a bad name let through"             's/if not rel or rel.startswith(b"\/") or bad_name(rel):   # guard:names/if not rel:/'
mutant "a symlink entry let through"        's/if mode == b"120000":   # guard:symlink/if False:/'
mutant "a path twice let through"           's/if rel in seen:   # guard:duplicate/if False:/'
mutant "a parent that is not a folder"      's/if not real_folder(fd, part):   # guard:parent/if False:/'
mutant "the hook: any folder"               '/# guard:inside$/d' hook
mutant "waiting commits dropped unkept"     's/                keep_dropped(gitdir, local, remote)   # guard:keepdropped/                pass/'
mutant "dropped commits not reported"       's/return alert("dropped", "dropped:" + name,   # guard:reportdropped/return True or alert("dropped", "dropped:" + name,/'
mutant "removals held stop the whole run"   's/            hold = Held("removals:"/            raise Held("removals:"/'
mutant "removals held but committed"        's/files.update(base_files(gitdir, base, names))   # guard:keepbase/pass/'
mutant "--accept-removals takes more"       's/if len(beyond) \* 100 > MAX_REMOVED_PERCENT \* n_base:   # guard:removals/if not accept_removals and len(beyond) * 100 > MAX_REMOVED_PERCENT * n_base:/'
mutant "a held note let through once smaller" 's/keep = gone & held   # guard:heldpaths/keep = set()/'
mutant "--adopt-remote drops a branch only ahead" 's/            and not is_ancestor(gitdir, remote, local)):   # guard:adoptahead/            ):/'
mutant "--adopt-remote cannot clear a split" 's/^    if (adopt and not dry and reachable and remote and local and local != remote$/    if False and (adopt and not dry and reachable and remote and local and local != remote/'
mutant "an alert not marked open"           's/            mark_open(sent)   # guard:markopen/            pass/'
mutant "the all-clear marked open"          's/        if now != "clean":   # guard:markwhen/        if True:/'
mutant "marked before its state is written" 's/^        fd, tmp = tempfile.mkstemp(dir=STATE, prefix=f".alert-{which}.")$/        mark_open(sent) if now != "clean" else None\n&/'
mutant "a second --apply verifies nothing"  's/if as_root systemctl start "$n-memory-verify.service"; then   # guard:againverify/if true; then/' lib
wait
while IFS='|' read -r f name; do
    [ -n "$f" ] || continue
    fails="$(grep -c '^FAIL' "$f.out")"
    if [ "$fails" -gt 0 ]; then ok "mutant caught: $name ($fails checks fail)"; else bad "mutant NOT caught: $name"; fi
done <<EOF
$STARTED
EOF

finish_tests
