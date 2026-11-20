#!/usr/bin/env bash
# hook-sync-mains.test.sh: hooks/sync-mains fast-forwards a clean checkout on
# its default branch, and leaves every other checkout exactly as it was.
#
# Hermetic: a throwaway HOME holds the workspace (~/work/instance, the home,
# and ~/work/repos/g/*). Each checkout's origin reads as a GitHub URL
# (github.com, the integration host, or the scp form), and a per-repo insteadOf
# rule sends the fetch to a local bare repo. No network.
#
# Then the mutation check: the script is copied with one guard broken at a
# time, and this test is run against each copy; every copy must fail it.
#
# SYNC_MAINS=<a copy of the script> runs it once against that copy, without
# the mutation check.
# The checks read `cond && ok "..." || bad "..."`: ok never fails, so bad runs
# only when cond does (SC2015). Expected output names paths with a literal ~
# (SC2088), and some commands under test hold a literal $HOME (SC2016).
# shellcheck disable=SC2015,SC2088,SC2016
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

REAL="$SRC/hooks/sync-mains"
SYNC="${SYNC_MAINS:-$REAL}"
INT_HOST="github.int.exe.xyz"
t_new
printf '[user]\n\tname = Test\n\temail = test@example.com\n' >"$GIT_CONFIG_GLOBAL"
export HOME="$T/home" XDG_CONFIG_HOME="$T/home/.config" GIT_CONFIG_NOSYSTEM=1
unset XDG_STATE_HOME GIT_DIR GIT_WORK_TREE
S="$HOME/work"; G="$S/repos/g"
mkdir -p "$G" "$T/remotes" "$T/seeds"

expect() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 (got '$2', want '$3')"; fi; }

# remote NAME [BRANCH]: a bare repo with one commit on BRANCH (default main).
remote() {
    local b="${2:-main}"
    git init -q --bare -b "$b" "$T/remotes/$1.git"
    git init -q -b "$b" "$T/seeds/$1"
    echo one >"$T/seeds/$1/f"
    git -C "$T/seeds/$1" add f && git -C "$T/seeds/$1" commit -q -m one
    git -C "$T/seeds/$1" push -q "$T/remotes/$1.git" "$b"
}
# advance NAME [FILE]: one new commit on the remote's branch (touching FILE).
advance() {
    local f="${2:-f}" b
    b="$(git -C "$T/seeds/$1" symbolic-ref --short HEAD)"
    echo "$RANDOM" >>"$T/seeds/$1/$f"
    git -C "$T/seeds/$1" add "$f" && git -C "$T/seeds/$1" commit -q -m "n$RANDOM"
    git -C "$T/seeds/$1" push -q "$T/remotes/$1.git" "$b"
}
# checkout NAME DEST URL: a clone whose origin reads as URL, fetched from the bare repo.
checkout() {
    git clone -q "$T/remotes/$1.git" "$2"
    git -C "$2" remote set-url origin "$3"
    git -C "$2" config "url.file://$T/remotes/$1.git.insteadOf" "$3"
}
head_of() { git -C "$1" rev-parse HEAD; }
tip() { git -C "$T/remotes/$1.git" rev-parse "${2:-main}"; }
tracking() { git -C "$1" rev-parse "refs/remotes/origin/${2:-main}"; }
GH="https://github.com/g"
INT="https://$INT_HOST/g"

# --- the workspace
remote instance;  checkout instance "$S/instance" "$INT/instance.git"
remote clean;     checkout clean "$G/clean" "$GH/clean.git"
remote scp;       checkout scp "$G/scp" "git@github.com:g/scp.git"
remote sshurl;    checkout sshurl "$G/sshurl" "ssh://git@github.com/g/sshurl.git"
remote dirty;     checkout dirty "$G/dirty" "$INT/dirty.git"
remote staged;    checkout staged "$G/staged" "$INT/staged.git"
remote untracked; checkout untracked "$G/untracked" "$INT/untracked.git"
remote inway;     checkout inway "$G/inway" "$INT/inway.git"
remote branch;    checkout branch "$G/branch" "$INT/branch.git"
remote detached;  checkout detached "$G/detached" "$INT/detached.git"
remote ahead;     checkout ahead "$G/ahead" "$INT/ahead.git"
remote diverged;  checkout diverged "$G/diverged" "$INT/diverged.git"
remote wt;        checkout wt "$G/wtmain" "$INT/wt.git"
remote relay;     checkout relay "$G/relay" "https://relay.example.net/git/abc123/relay"
remote nohead;    checkout nohead "$G/nohead" "$INT/nohead.git"
remote trunk trunk; checkout trunk "$G/trunk" "$INT/trunk.git"
remote midmerge;  checkout midmerge "$G/midmerge" "$INT/midmerge.git"
remote deep;      checkout deep "$G/sub/deep" "$INT/deep.git"
remote gone;      checkout gone "$G/gone" "$INT/gone.git"
remote killed;    checkout killed "$G/killed" "$INT/killed.git"
remote stalemark; checkout stalemark "$G/stalemark" "$INT/stalemark.git"
remote rebasing;  checkout rebasing "$G/rebasing" "$INT/rebasing.git"
remote racer;     checkout racer "$G/racer" "$INT/racer.git"
# ignored: local.env is ignored and holds local state; upstream force-adds it
remote ignored
printf 'local.env\n' >"$T/seeds/ignored/.gitignore"
git -C "$T/seeds/ignored" add .gitignore && git -C "$T/seeds/ignored" commit -q -m ignore && git -C "$T/seeds/ignored" push -q "$T/remotes/ignored.git" main
checkout ignored "$G/ignored" "$INT/ignored.git"
echo MINE=keep >"$G/ignored/local.env"
echo UPSTREAM=1 >"$T/seeds/ignored/local.env"
git -C "$T/seeds/ignored" add -f local.env && git -C "$T/seeds/ignored" commit -q -m forced && git -C "$T/seeds/ignored" push -q "$T/remotes/ignored.git" main
# partway: a required smudge filter that fails (like a failed Git LFS download);
# the merge writes f first, then fails on m.bin
remote partway
printf '*.bin filter=bad\n' >"$T/seeds/partway/.gitattributes"
git -C "$T/seeds/partway" add .gitattributes && git -C "$T/seeds/partway" commit -q -m attrs && git -C "$T/seeds/partway" push -q "$T/remotes/partway.git" main
checkout partway "$G/partway" "$INT/partway.git"
git -C "$G/partway" config filter.bad.smudge false
git -C "$G/partway" config filter.bad.clean cat
git -C "$G/partway" config filter.bad.required true
echo f2 >>"$T/seeds/partway/f"; echo bin >"$T/seeds/partway/m.bin"
git -C "$T/seeds/partway" add -A && git -C "$T/seeds/partway" commit -q -m two && git -C "$T/seeds/partway" push -q "$T/remotes/partway.git" main
mkdir -p "$G/notarepo"; echo x >"$G/notarepo/file"

# the states
echo local >>"$G/dirty/f"
echo new >"$G/staged/new" && git -C "$G/staged" add new
echo mine >"$G/untracked/scratch.txt"
# repo hooks must not run: a post-merge in .git/hooks, and a hooksPath inside
# the repo's own tree (husky style), each writing a marker
for c in "$G/clean" "$G/scp"; do mkdir -p "$c/.git/hooks"; done
printf '#!/bin/sh\ntouch "%s/hook-ran-clean"\n' "$T" >"$G/clean/.git/hooks/post-merge"
mkdir -p "$G/scp/.hooks"
printf '#!/bin/sh\ntouch "%s/hook-ran-scp"\n' "$T" >"$G/scp/.hooks/post-merge"
printf '#!/bin/sh\ntouch "%s/hook-ran-scp-ref"\n' "$T" >"$G/scp/.hooks/reference-transaction"
chmod +x "$G/clean/.git/hooks/post-merge" "$G/scp/.hooks/post-merge" "$G/scp/.hooks/reference-transaction"
git -C "$G/scp" config core.hooksPath .hooks
git -C "$G/branch" checkout -q -b side
git -C "$G/detached" checkout -q --detach
echo l >>"$G/ahead/f" && git -C "$G/ahead" commit -q -am local
echo l >>"$G/diverged/f" && git -C "$G/diverged" commit -q -am local
# wtmain is on side; its linked worktree wtlinked holds main
git -C "$G/wtmain" checkout -q -b side
git -C "$G/wtmain" worktree add -q "$G/wtlinked" main
git -C "$G/nohead" remote set-head origin -d
git -C "$G/midmerge" rev-parse HEAD >"$G/midmerge/.git/MERGE_HEAD"
rm -rf "$T/remotes/gone.git"   # its fetch fails
# killed: a run was killed mid-merge (its marker is left, a tracked file differs)
echo abc1234 >"$G/killed/.git/ghost-sync-mains.merging"; echo half >>"$G/killed/f"
# stalemark: a run was killed after its merge finished (marker left, checkout clean)
echo abc1234 >"$G/stalemark/.git/ghost-sync-mains.merging"
mkdir "$G/rebasing/.git/rebase-merge"

for r in instance clean scp sshurl dirty staged untracked branch detached diverged wt relay nohead midmerge deep killed stalemark rebasing racer; do advance "$r"; done
advance clean
advance trunk
advance inway in-the-way.txt
echo mine >"$G/inway/in-the-way.txt"

# Every checkout's HEAD before the runs, one "<sha> <path>" line each (no
# associative arrays: macOS ships bash 3.2).
for c in "$S/instance" "$G"/* "$G/sub/deep"; do
    [ -e "$c/.git" ] && printf '%s %s\n' "$(head_of "$c")" "$c"
done >"$T/before"
relay_tracking="$(tracking "$G/relay")"
branch_tracking="$(tracking "$G/branch")"; dirty_tracking="$(tracking "$G/dirty")"
unchanged() { grep -qxF "$(head_of "$1") $1" "$T/before"; }
synced() { [ "$(head_of "$1")" = "$(tip "$2" "${3:-main}")" ]; }

run() {   # run [ARGS...]: the script, with stdout, stderr and exit saved
    "$SYNC" "$@" >"$T/out" 2>"$T/err"; echo $? >"$T/rc"
}
sweep() { run --home "$S/instance" --root "$S" "$@"; }   # the instance's whole workspace
quiet0() { [ "$(cat "$T/rc")" = 0 ] && [ ! -s "$T/err" ]; }
LOGF="$HOME/.local/state/ghost-protocol/sync-mains.log"
loglines() { if [ -f "$LOGF" ]; then wc -l <"$LOGF" | tr -d ' '; else echo 0; fi; }

# --- dry run: no fetch, no merge, no log; one verdict per folder
git -C "$G/clean" fetch -q origin   # fetched by hand, so the dry run can see the news
sweep --dry-run
quiet0 && ok "dry run: exit 0, nothing on stderr" || bad "dry run: exit $(cat "$T/rc"), stderr: $(head -c 200 "$T/err")"
moved=0; while read -r _ c; do unchanged "$c" || moved=1; done <"$T/before"
expect "dry run: no checkout moved" "$moved" 0
expect "dry run: no log written" "$(loglines)" 0
[ "$(tracking "$G/scp")" != "$(tip scp)" ] && ok "dry run: nothing fetched" || bad "dry run fetched"
grep -qx "~/work/repos/g/clean main would fast-forward [0-9a-f]*\.\.[0-9a-f]*" "$T/out" && ok "dry run: names the fast-forward it would make" || bad "dry run: no would-fast-forward line for clean"
grep -qx '~/work/repos/g/notarepo skipped: not a git checkout' "$T/out" && ok "dry run: a plain folder is reported, not touched" || bad "dry run: plain folder line"

# --- the sweep
sweep
quiet0 && ok "sweep: exit 0, nothing on stderr" || bad "sweep: exit $(cat "$T/rc"), stderr: $(head -c 200 "$T/err")"
synced "$S/instance" instance && ok "the instance's home (int-host remote) is fast-forwarded" || bad "the home not synced"
synced "$G/clean" clean      && ok "a clean checkout two commits behind is fast-forwarded" || bad "clean not synced"
synced "$G/scp" scp          && ok "an scp-form origin (git@github.com:) is synced" || bad "scp form not synced"
synced "$G/sshurl" sshurl    && ok "an ssh:// origin is synced" || bad "ssh:// form not synced"
ls "$T"/hook-ran-* >/dev/null 2>&1 && bad "a repo hook ran: $(cd "$T" && ls hook-ran-*)" || ok "no repo hook runs (.git/hooks, or a hooksPath in the tree)"
synced "$G/untracked" untracked && ok "an untracked file not in the way does not block it" || bad "untracked blocked it"
[ "$(cat "$G/untracked/scratch.txt")" = mine ] && ok "  and the untracked file is kept" || bad "untracked file lost"
synced "$G/nohead" nohead    && ok "no origin/HEAD: falls back to main" || bad "nohead not synced"
synced "$G/trunk" trunk trunk && ok "a repo whose default branch is trunk is synced on trunk" || bad "trunk not synced"
unchanged "$G/dirty"         && ok "a changed tracked file: left alone" || bad "dirty checkout moved"
grep -q local "$G/dirty/f"   && ok "  and the change is kept" || bad "dirty change lost"
expect "  and it is not even fetched" "$(tracking "$G/dirty")" "$dirty_tracking"
unchanged "$G/staged"        && ok "a staged file: left alone" || bad "staged checkout moved"
unchanged "$G/inway"         && ok "an untracked file the merge would overwrite: left alone" || bad "inway moved"
[ "$(cat "$G/inway/in-the-way.txt")" = mine ] && ok "  and that file is kept" || bad "inway file overwritten"
unchanged "$G/branch"        && ok "a checkout on another branch: left alone" || bad "branch checkout moved"
expect "  still on its branch" "$(git -C "$G/branch" symbolic-ref --short HEAD)" side
expect "  and it is not even fetched" "$(tracking "$G/branch")" "$branch_tracking"
unchanged "$G/detached"      && ok "a detached HEAD: left alone" || bad "detached moved"
unchanged "$G/ahead"         && ok "ahead of origin: left alone" || bad "ahead moved"
unchanged "$G/diverged"      && ok "diverged: left alone" || bad "diverged moved"
expect "  no merge commit made" "$(git -C "$G/diverged" rev-list --merges --count HEAD)" 0
unchanged "$G/wtlinked"      && ok "a linked worktree on main is not synced itself" || bad "linked worktree moved"
unchanged "$G/wtmain"        && ok "  and its main checkout (on side) is left alone" || bad "wtmain moved"
unchanged "$G/relay"         && ok "a non-GitHub origin (relay): left alone" || bad "relay moved"
expect "  and never fetched" "$(tracking "$G/relay")" "$relay_tracking"
unchanged "$G/midmerge"      && ok "a merge in progress: left alone" || bad "midmerge moved"
unchanged "$G/sub/deep"      && ok "a repo deeper than repos/<group>/<repo>: not covered" || bad "deep moved"
unchanged "$G/rebasing"      && ok "a rebase in progress (rebase-merge): left alone" || bad "rebasing moved"
unchanged "$G/ignored"       && ok "an ignored file at a path the merge adds: left alone" || bad "ignored moved"
expect "  and the ignored file keeps its local content" "$(cat "$G/ignored/local.env")" MINE=keep
grep -q 'g/ignored main fast-forward to [0-9a-f]* failed; left as it was: error: The following untracked' "$LOGF" && ok "  and the refusal is logged with git's error line" || bad "  ignored refusal not logged"
unchanged "$G/partway"       && ok "a fast-forward that fails PART-WAY: HEAD unmoved" || bad "partway HEAD moved"
grep -q 'g/partway main fast-forward to [0-9a-f]* failed PART-WAY; tracked files differ from HEAD.*: error: external filter' "$LOGF" && ok "  and it is logged loudly, with git's error line" || bad "  partway not logged loudly"
grep -q '~/work/repos/g/partway main fast-forward to [0-9a-f]* failed PART-WAY' "$T/out" && ok "  and printed" || bad "  partway not printed"
[ -e "$G/partway/.git/ghost-sync-mains.merging" ] && ok "  its marker stays until the checkout is clean" || bad "  partway marker gone"
grep -q 'g/killed main fast-forward to abc1234 failed PART-WAY' "$LOGF" && ok "a killed run (marker left, files changed) is reported, not skipped silently" || bad "killed run not reported"
synced "$G/stalemark" stalemark && ok "a leftover marker on a clean checkout: synced as usual" || bad "stalemark not synced"
[ ! -e "$G/stalemark/.git/ghost-sync-mains.merging" ] && ok "  and the marker is removed" || bad "  stalemark marker left"
n_marks=0; for c in "$S/instance" "$G"/*; do [ -e "$c/.git/ghost-sync-mains.merging" ] && n_marks=$((n_marks + 1)); done
expect "markers left only where a fast-forward broke (partway, killed)" "$n_marks" 2
expect "stdout: one line per fast-forward or PART-WAY failure" "$(wc -l <"$T/out" | tr -d ' ')" 11
grep -qx '~/work/instance main fast-forwarded [0-9a-f]*\.\.[0-9a-f]*' "$T/out" && ok "stdout names the checkout, branch and commits" || bad "stdout format: $(head -1 "$T/out")"
grep -q '~/work/repos/g/trunk trunk fast-forwarded' "$T/out" && ok "  the branch named is the default branch" || bad "trunk line"
grep -q 'g/diverged main held: diverged from origin/main' "$LOGF" && ok "log: diverged is logged" || bad "log: no diverged line"
grep -q 'g/ahead main held: ahead of origin/main' "$LOGF" && ok "log: ahead is logged" || bad "log: no ahead line"
grep -q 'g/gone main fetch failed' "$LOGF" && ok "log: a failed fetch is logged" || bad "log: no fetch failure"
grep -q 'g/inway main fast-forward to [0-9a-f]* failed' "$LOGF" && ok "log: a refused fast-forward is logged" || bad "log: no inway failure"
grep -q 'g/dirty' "$LOGF" && bad "log: a dirty skip was logged (it should be silent)" || ok "log: an expected skip is silent"
expect "log: one line per fast-forward or failure" "$(loglines)" 16

# --- again with nothing new: silent, and held lines are not repeated
n="$(loglines)"
sweep
quiet0 && [ ! -s "$T/out" ] && ok "second sweep: silent" || bad "second sweep printed: $(head -c 200 "$T/out")"
expect "second sweep: no new log line (held and failed are logged once)" "$(loglines)" "$n"
advance diverged
sweep
expect "diverged further: one new line" "$(loglines)" "$((n + 1))"
unchanged "$G/diverged" && ok "  still left alone" || bad "diverged moved on the second run"

# --- CHECKOUT mode (the hook): only the named checkout; every outcome logged
advance clean; advance scp
TL="$T/target.log"
run --log "$TL" -- "$G/clean"
synced "$G/clean" clean && ok "checkout mode: the named checkout is synced" || bad "checkout mode: clean not synced"
[ "$(head_of "$G/scp")" != "$(tip scp)" ] && ok "checkout mode: no other checkout is touched" || bad "checkout mode touched scp"
grep -qx '~/work/repos/g/clean main fast-forwarded [0-9a-f]*\.\.[0-9a-f]*' "$T/out" && ok "checkout mode: prints the fast-forward" || bad "checkout mode stdout"
run --log "$TL" -- "$G/clean" "$G/dirty"
quiet0 && [ ! -s "$T/out" ] && ok "checkout mode, nothing new: prints nothing" || bad "checkout mode printed"
grep -q 'g/clean main already up to date' "$TL" && ok "checkout mode: up to date is logged" || bad "checkout mode: no up-to-date line"
grep -q 'g/dirty main skipped: tracked files are changed' "$TL" && ok "checkout mode: a skip is logged" || bad "checkout mode: no skip line"
run --log "$TL" -- "$T/nowhere"
quiet0 && ok "checkout mode, a missing folder: exit 0, quiet" || bad "checkout mode missing folder"
# The time budget: no fetch starts once it is spent (here it is spent at once).
advance clean
SYNC_MAINS_BUDGET=0 run --log "$TL" -- "$G/clean"
quiet0 && [ "$(head_of "$G/clean")" != "$(tip clean)" ] && ok "checkout mode, budget spent: not fetched" || bad "budget 0 still synced"
grep -q 'g/clean main skipped: out of time for this run' "$TL" && ok "  and the skip is logged" || bad "  budget skip not logged"
SYNC_MAINS_BUDGET=not-a-number run --log "$TL" -- "$G/clean"
synced "$G/clean" clean && ok "a budget that is not a number: the default" || bad "bad budget broke the run"

# --- --home without --root: only the home
remote alt; checkout alt "$T/alt" "https://github.com/example/alt.git"
advance alt; advance instance; advance clean
home_before="$(head_of "$S/instance")"; clean_before="$(head_of "$G/clean")"
"$SYNC" --home "$T/alt" >/dev/null 2>&1
synced "$T/alt" alt && ok "--home: that checkout is synced" || bad "--home ignored"
expect "  and the instance's home is not touched" "$(head_of "$S/instance")" "$home_before"
expect "  and with no --root, no repos/ either" "$(head_of "$G/clean")" "$clean_before"

# --- a branch switch during the fetch: the re-check right before the merge
# catches it. A stand-in timeout (the script runs every fetch through it)
# switches the checkout to another branch once the fetch is done.
mkdir -p "$T/bin"
cat >"$T/bin/timeout" <<'STUB'
#!/bin/sh
shift
"$@"; rc=$?
[ -n "${RACE_DIR:-}" ] && git -C "$RACE_DIR" checkout -q -b during-the-fetch
exit $rc
STUB
chmod +x "$T/bin/timeout"
advance racer   # behind again (the sweep above synced it)
racer_main="$(git -C "$G/racer" rev-parse main)"
PATH="$T/bin:$PATH" RACE_DIR="$G/racer" "$SYNC" --log "$TL" -- "$G/racer" >/dev/null 2>&1
expect "switched branch during the fetch: main is not moved" "$(git -C "$G/racer" rev-parse main)" "$racer_main"
expect "  and the new branch is not moved either" "$(head_of "$G/racer")" "$racer_main"
grep -q 'g/racer main skipped: switched branch or changed files during the fetch' "$TL" && ok "  and the skip is logged" || bad "  race skip not logged"

# --- a stand-in git that acts only on the merge: LOCK_DIR = another git holds
# the index lock and is changing a tracked file (the hook and a sweep
# overlapping); FAKE_ERR = the merge fails with that error text
REAL_GIT="$(command -v git)"
mkdir -p "$T/gitstub"
cat >"$T/gitstub/git" <<STUB
#!/bin/sh
case " \$* " in
    *" merge --ff-only "*)
        if [ -n "\${LOCK_DIR:-}" ]; then : >"\$LOCK_DIR/.git/index.lock"; echo other >>"\$LOCK_DIR/f"; fi
        if [ -n "\${FAKE_ERR:-}" ]; then echo "\$FAKE_ERR" >&2; exit 1; fi ;;
esac
exec "$REAL_GIT" "\$@"
STUB
chmod +x "$T/gitstub/git"
remote locked; checkout locked "$G/locked" "$INT/locked.git"; advance locked
PATH="$T/gitstub:$PATH" LOCK_DIR="$G/locked" "$SYNC" --log "$TL" -- "$G/locked" >"$T/out" 2>/dev/null
grep -q 'g/locked main fast-forward to [0-9a-f]* failed; left as it was: .*index.lock' "$TL" && ok "another git holds index.lock: the plain failure is logged" || bad "index.lock: no plain failure line"
grep -q 'g/locked.*PART-WAY' "$TL" "$T/out" && bad "  index.lock was reported as PART-WAY" || ok "  not reported as PART-WAY"
[ ! -e "$G/locked/.git/ghost-sync-mains.merging" ] && ok "  and no marker is left" || bad "  marker left after a lock failure"
rm -f "$G/locked/.git/index.lock"
remote creds; checkout creds "$G/creds" "$INT/creds.git"; advance creds
PATH="$T/gitstub:$PATH" FAKE_ERR="error: failed to fetch https://someone:tok3n-secret@example.net/x/info/lfs" "$SYNC" --log "$TL" -- "$G/creds" >/dev/null 2>&1
grep -q 'g/creds main fast-forward to [0-9a-f]* failed; left as it was: error: failed to fetch https://example.net/x/info/lfs' "$TL" && ok "userinfo is stripped from a URL in git's error line" || bad "userinfo line: $(grep g/creds "$TL")"
grep -q 'tok3n-secret' "$TL" && bad "  the secret reached the log" || ok "  the secret never reaches the log"

# --- the off switch: ~/.local/state/ghost-protocol/sync-mains.off stops every run
advance clean
touch "$HOME/.local/state/ghost-protocol/sync-mains.off"
n="$(loglines)"
sweep
quiet0 && [ ! -s "$T/out" ] && ok "off: the sweep is silent" || bad "off: the sweep printed"
[ "$(head_of "$G/clean")" != "$(tip clean)" ] && ok "off: nothing is synced" || bad "off: clean was synced"
expect "off: nothing is logged" "$(loglines)" "$n"
run --log "$TL" -- "$G/clean"
[ "$(head_of "$G/clean")" != "$(tip clean)" ] && ok "off: checkout mode (the hook) is off too" || bad "off: checkout mode synced"
sweep --dry-run
grep -q 'sync-mains is off' "$T/out" && ok "off: the dry run says so" || bad "off: the dry run is silent"
rm "$HOME/.local/state/ghost-protocol/sync-mains.off"
sweep
synced "$G/clean" clean && ok "back on: synced again" || bad "back on: clean not synced"

# --- usage
run --bogus
expect "an unknown option: exit 2" "$(cat "$T/rc")" 2
run
expect "no checkout and no --home: exit 2" "$(cat "$T/rc")" 2
run --home "$S/instance" -- "$G/clean"
expect "checkouts and --home together: exit 2" "$(cat "$T/rc")" 2
run --root "$S"
expect "--root without --home: exit 2" "$(cat "$T/rc")" 2

# --- the integration host is the installer's
int_lib="$(sed -n 's/^GP_GITHUB_INT_HOST="\(.*\)"$/\1/p' "$SRC/install/lib/github.sh")"
expect "the integration host is install/lib/github.sh's GP_GITHUB_INT_HOST" "$INT_HOST" "$int_lib"

if [ -n "${SYNC_MAINS:-}" ]; then finish_tests; exit $?; fi

# --- mutation check: each broken guard must fail this test
M="$T/mutants"; mkdir -p "$M"
# Two mutant runs at a time (every run has its own sandbox), so a small
# machine is not swamped; the verdicts are read once all of them are done.
STARTED="" RUNNING=0
mutant() {   # name, sed program
    local name="$1" prog="$2" f
    f="$M/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"
    sed -e "$prog" "$REAL" >"$f"; chmod +x "$f"
    if cmp -s "$f" "$REAL"; then bad "mutant $name: the sed changed nothing"; return; fi
    if [ "$RUNNING" -ge 2 ]; then wait; RUNNING=0; fi
    (SYNC_MAINS="$f" bash "${BASH_SOURCE[0]}" >"$f.out" 2>&1) &
    RUNNING=$((RUNNING + 1))
    STARTED="$STARTED$f|$name
"
}
mutant "no dirty guard"        '/# guard:dirty$/d'
mutant "no branch guard"       '/# guard:branch$/d'
mutant "no worktree guard"     '/# guard:worktree$/d'
mutant "no host guard"         '/# guard:host$/d'
mutant "no in-progress guard"  '/# guard:inprogress$/d'
mutant "repo hooks allowed"    's# -c core.hooksPath=/dev/null"$#"#'
mutant "merge may overwrite ignored files" 's/ --no-overwrite-ignore//'
mutant "no PART-WAY check after a failed merge" 's/^\( *\)if .*# guard:partway$/\1if false; then/'
mutant "no index.lock check before PART-WAY" 's/^\( *\).*# guard:lock$/\1locked=0/'
mutant "userinfo kept in the error line" '/# guard:userinfo$/d'
mutant "no marker check" 's/if \[ -e "\$mark" \]; then # guard:marker$/if false; then/'
mutant "no re-check before the merge" '/# guard:recheck$/d'
mutant "no off switch" 's/if \[ -e "\$OFF" \]; then # guard:off$/if false; then/'
mutant "no ancestor check"     's/elif gro merge-base --is-ancestor "$old" "$up"; then # guard:ancestor$/elif true; then/'
# --ff-only is the second layer behind the ancestor check (it only matters if
# origin/<default> moves between the check and the merge), so it is removed
# together with the check: then a diverged checkout would get a merge commit.
mutant "no ancestor check and no --ff-only" 's/elif gro merge-base --is-ancestor "$old" "$up"; then # guard:ancestor$/elif true; then/
s/merge --ff-only --quiet/merge --no-edit --quiet/'
wait
while IFS='|' read -r f name; do
    [ -n "$f" ] || continue
    fails="$(grep -c '^FAIL' "$f.out")"
    if [ "$fails" -gt 0 ]; then ok "mutant caught: $name ($fails checks fail)"; else bad "mutant NOT caught: $name"; fi
done <<EOF
$STARTED
EOF

finish_tests
