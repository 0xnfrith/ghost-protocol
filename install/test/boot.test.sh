#!/usr/bin/env bash
# boot.test.sh: boot.sh clones exactly its pinned commit or refuses. The
# Ghost Protocol repo is a local bare repo, reached through GP_REPO_URL, which
# boot.sh honours only when GP_TEST=1. Its install/install is a stand-in that
# records only that it ran, its argument count, and whether GP_DIR and
# GP_COMMIT were right; and on a second line whether it got --update, the
# commit GP_PREVIOUS_COMMIT names, and whether GP_TARGET_DIR was set.
# The update cases: --commit pins a commit the operator chose, --update moves
# the checkout and records where it was, --rollback goes back, and a dry run
# changes nothing.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# A small Ghost Protocol repo with two commits and an annotated tag. With
# with-boot, boot.sh itself is in it (GP_COMMIT empty, as on main), and C2's
# copy is 400 lines longer than C1's, so a run of the checkout's own boot.sh
# sees its file change under it.
make_gp_repo() {   # [with-boot]
    local src="$T/src-gp" i
    mkdir -p "$src/install/apt"
    # What boot.sh reads from its clone: the pins and the Git stable PPA key.
    cp "$SRC/install/pins.env" "$src/install/pins.env"
    cp "$SRC/install/apt/git-core-ppa.asc" "$src/install/apt/"
    cat >"$src/install/install" <<'EOF'
#!/bin/sh
here="$(cd "$(dirname "$0")/.." && pwd -P)"
d=bad; [ "$GP_DIR" = "$here" ] && d=ok
c=bad; [ "$GP_COMMIT" = "$(git -C "$here" rev-parse HEAD)" ] && c=ok
echo "install $# gp_dir=$d gp_commit=$c" >>"$STUB_STATE/calls"
u=no; for a in "$@"; do [ "$a" = "--update" ] && u=yes; done
echo "install-update $u prev=${GP_PREVIOUS_COMMIT:-none} target=${GP_TARGET_DIR:+set}" >>"$STUB_STATE/calls"
EOF
    chmod +x "$src/install/install"
    [ "${1:-}" = "with-boot" ] && cp "$SRC/install/boot.sh" "$src/install/boot.sh"
    git -C "$src" init -q
    git -C "$src" add -A
    git -C "$src" commit -q -m one
    C1="$(git -C "$src" rev-parse HEAD)"
    echo two >"$src/two.txt"
    if [ "${1:-}" = "with-boot" ]; then
        {
            sed -n 1p "$SRC/install/boot.sh"
            i=0
            while [ "$i" -lt 400 ]; do echo "# padding line $i, so every later line moves"; i=$((i + 1)); done
            sed 1d "$SRC/install/boot.sh"
        } >"$src/install/boot.sh"
    fi
    git -C "$src" add -A
    git -C "$src" commit -q -m two
    C2="$(git -C "$src" rev-parse HEAD)"
    git -C "$src" tag -a -m "a tag" v2
    TAG="$(git -C "$src" rev-parse v2)"
    git clone -q --bare "$src" "$T/remote/gp.git"
    GP_URL="file://$T/remote/gp.git"
}

# boot.sh with GP_COMMIT set, as the release script will write it.
boot_at() {   # commit
    sed "s/^GP_COMMIT=\"\"\$/GP_COMMIT=\"$1\"/" "$SRC/install/boot.sh" >"$T/boot.sh"
    chmod +x "$T/boot.sh"
}
boot() {   # args...
    t_env GP_REPO_URL="$GP_URL" "${BOOT:-$T/boot.sh}" "$@" >"$OUT" 2>&1
    RC=$?
}
installer_ran() { grep -q '^install ' "$T/state/calls"; }
update_line() { grep '^install-update ' "$T/state/calls" | tail -n 1; }
head_of() { git -C "$T/home/ghost-protocol" rev-parse HEAD; }
recorded() { cat "$T/home/ghost-protocol/.git/gp-previous-commit" 2>/dev/null; }

check "boot.sh ships unreleased (GP_COMMIT is empty)" grep -qx 'GP_COMMIT=""' "$SRC/install/boot.sh"
check "boot.sh has exactly one GP_COMMIT line" [ "$(grep -c '^GP_COMMIT=' "$SRC/install/boot.sh")" -eq 1 ]

# 1. The pinned commit: cloned, checked, and the installer runs with GP_DIR and GP_COMMIT.
t_new; make_gp_repo; boot_at "$C2"
boot --instance example/instance --yes
check "pinned: exit 0" rc_is 0
check "pinned: HEAD is the pinned commit" [ "$(git -C "$T/home/ghost-protocol" rev-parse HEAD)" = "$C2" ]
check "pinned: the installer ran with GP_DIR and GP_COMMIT right" grep -q '^install 3 gp_dir=ok gp_commit=ok$' "$T/state/calls"
check "pinned: no temp folder is left" no_temp_left
check "pinned: the test repo address is announced as TEST MODE" out_has 'TEST MODE \(GP_TEST=1\): cloning from file://'

# 2. The fetched commit differs from GP_COMMIT (an annotated tag's id peels to
#    another commit): refused, the new clone removed, the installer never runs.
t_new; make_gp_repo; boot_at "$TAG"
boot --instance example/instance
check "commit differs: exit 1" rc_is 1
check "commit differs: refused" out_has 'REFUSED: .* not the pinned commit'
check "commit differs: the clone is removed" [ ! -e "$T/home/ghost-protocol" ]
check "commit differs: the installer never ran" sh -c "! grep -q '^install ' '$T/state/calls'"

# 3. An empty GP_COMMIT without --dev-source: refused, nothing cloned.
t_new; make_gp_repo
BOOT="$SRC/install/boot.sh" boot --instance example/instance
check "unreleased: exit 1" rc_is 1
check "unreleased: refused" out_has 'unreleased'
check "unreleased: nothing cloned" [ ! -e "$T/home/ghost-protocol" ]

# 4. An empty GP_COMMIT with --dev-source: a warning, and the local checkout runs.
t_new; make_gp_repo
BOOT="$SRC/install/boot.sh" boot --instance example/instance --dev-source "$T/src-gp"
check "--dev-source: exit 0" rc_is 0
check "--dev-source: warns it is for development only" out_has 'development only'
check "--dev-source: the local checkout's installer ran" grep -q '^install 2 gp_dir=ok gp_commit=ok$' "$T/state/calls"

# 5. An existing --dir at another commit: refused unless --update.
t_new; make_gp_repo; boot_at "$C1"
boot --instance example/instance
boot_at "$C2"
: >"$T/state/calls"
boot --instance example/instance
check "existing dir, other commit: exit 1" rc_is 1
check "existing dir, other commit: says to pass --update" out_has 'pass --update'
check "existing dir, other commit: left at its commit" [ "$(git -C "$T/home/ghost-protocol" rev-parse HEAD)" = "$C1" ]
check "existing dir, other commit: the installer never ran" sh -c "! grep -q '^install ' '$T/state/calls'"
boot --instance example/instance --update
check "--update: exit 0" rc_is 0
check "--update: now at the pinned commit" [ "$(git -C "$T/home/ghost-protocol" rev-parse HEAD)" = "$C2" ]
check "--update: the installer ran" installer_ran

# 6. An existing --dir at the pinned commit is reused as it is.
: >"$T/state/calls"
boot --instance example/instance
check "existing dir at the pin: exit 0" rc_is 0
check "existing dir at the pin: the installer ran" installer_ran

# 7. Local changes in an existing --dir are refused.
echo "edited" >>"$T/home/ghost-protocol/install/install"
: >"$T/state/calls"
boot --instance example/instance
check "local changes: exit 1" rc_is 1
check "local changes: refused" out_has 'local changes'

# 8. --dir pointing at something that is not a Ghost Protocol clone: refused.
t_new; make_gp_repo; boot_at "$C2"
mkdir -p "$T/home/other"; echo keep >"$T/home/other/f"
boot --instance example/instance --dir "$T/home/other"
check "not a clone: exit 1" rc_is 1
check "not a clone: left untouched" [ "$(cat "$T/home/other/f")" = "keep" ]

# 9. A dry run clones nothing into HOME: the installer's dry run runs from a
#    temporary clone, which is removed.
t_new; make_gp_repo; boot_at "$C2"
t_snapshot >"$T/before"
boot --instance example/instance --dry-run
t_snapshot >"$T/after"
check "dry run: exit 0" rc_is 0
check "dry run: HOME is unchanged" cmp -s "$T/before" "$T/after"
check "dry run: the installer ran as a dry run (3 arguments)" grep -q '^install 3 gp_dir=ok gp_commit=ok$' "$T/state/calls"

# 10. Usage and platform.
t_new; make_gp_repo; boot_at "$C2"
boot
check "no --instance: exit 2" rc_is 2
boot --instance example/instance --dir ""
check "an empty --dir: exit 2" rc_is 2
check "an empty --dir: nothing cloned into the current folder" [ ! -e "$T/home/.git" ]
# shellcheck disable=SC2016  # the stub's own $1, written as is
printf '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo riscv64 ;; *) echo Linux ;; esac\n' >"$T/stubs/uname"
chmod +x "$T/stubs/uname"
boot --instance example/instance
check "unsupported platform: exit 3" rc_is 3
check "unsupported platform: nothing cloned" [ ! -e "$T/home/ghost-protocol" ]

# 11. --commit with an unreleased boot.sh: the operator's commit is the pin.
t_new; make_gp_repo
BOOT="$SRC/install/boot.sh" boot --instance example/instance --commit "$C1" --yes
check "--commit, first install: exit 0" rc_is 0
check "--commit, first install: at that commit" [ "$(head_of)" = "$C1" ]
check "--commit, first install: the full installer (no --update)" [ "$(update_line)" = "install-update no prev=none target=" ]
check "--commit, first install: nothing recorded to go back to" [ -z "$(recorded)" ]

# 12. --commit with --update: moved, the old commit recorded, the way back
#     printed, and the installer told it is an update from C1.
: >"$T/state/calls"
BOOT="$SRC/install/boot.sh" boot --instance example/instance --commit "$C2" --update --yes
check "update: exit 0" rc_is 0
check "update: at the new commit" [ "$(head_of)" = "$C2" ]
check "update: still detached, following no branch" sh -c "! git -C '$T/home/ghost-protocol' symbolic-ref -q HEAD"
check "update: the old commit is recorded" [ "$(recorded)" = "$C1" ]
check "update: the installer ran its update steps, from C1" [ "$(update_line)" = "install-update yes prev=$C1 target=" ]
check "update: says what it moves" out_has "updating .*ghost-protocol from $C1 to $C2"
check "update: prints the way back, with the old commit" out_has "install/boot.sh --instance example/instance --dir .*ghost-protocol --commit $C1 --update --yes\$"

# 13. --rollback: back to C1, C2 now recorded, an update from C2.
: >"$T/state/calls"
BOOT="$SRC/install/boot.sh" boot --instance example/instance --rollback --yes
check "rollback: exit 0" rc_is 0
check "rollback: back at the old commit" [ "$(head_of)" = "$C1" ]
check "rollback: the commit it left is recorded" [ "$(recorded)" = "$C2" ]
check "rollback: the installer ran its update steps, from C2" [ "$(update_line)" = "install-update yes prev=$C2 target=" ]

# 14. --update at the pin: nothing moves; the update steps run with no
#     previous commit (so nothing is restarted).
: >"$T/state/calls"
BOOT="$SRC/install/boot.sh" boot --instance example/instance --commit "$C1" --update --yes
check "update at the pin: exit 0" rc_is 0
check "update at the pin: no previous commit passed" [ "$(update_line)" = "install-update yes prev=none target=" ]
check "update at the pin: the record is left as it was" [ "$(recorded)" = "$C2" ]

# 15. A dry run of an update changes nothing; the installer's dry run, from a
#     temporary clone, hears the commit it would move from and the real dir.
t_snapshot >"$T/before"
: >"$T/state/calls"
BOOT="$SRC/install/boot.sh" boot --instance example/instance --commit "$C2" --update --dry-run
t_snapshot >"$T/after"
check "update dry run: exit 0" rc_is 0
check "update dry run: HOME is unchanged" cmp -s "$T/before" "$T/after"
check "update dry run: still at the old commit" [ "$(head_of)" = "$C1" ]
check "update dry run: says what it would move" out_has "would move .*ghost-protocol from $C1 to $C2"
check "update dry run: prints the way back" out_has "--commit $C1 --update\$"
check "update dry run: the installer's dry run, an update from C1, naming the real dir" [ "$(update_line)" = "install-update yes prev=$C1 target=set" ]
check "update dry run: no temp folder is left" no_temp_left

# 16. Refusals, each changing nothing.
for bad in "${C2%?}" "$(printf '%s' "$C2" | tr 'a-f' 'A-F')" "HEAD" "v2"; do
    BOOT="$SRC/install/boot.sh" boot --instance example/instance --commit "$bad" --update
    check "--commit $bad: exit 2" rc_is 2
done
check "bad --commit: still at the old commit" [ "$(head_of)" = "$C1" ]
BOOT="$SRC/install/boot.sh" boot --instance example/instance --commit "$C2" --rollback
check "--commit with --rollback: exit 2" rc_is 2
BOOT="$SRC/install/boot.sh" boot --instance example/instance --dev-source "$T/src-gp" --update
check "--dev-source with --update: exit 2" rc_is 2
rm -f "$T/home/ghost-protocol/.git/gp-previous-commit"
BOOT="$SRC/install/boot.sh" boot --instance example/instance --rollback
check "--rollback with nothing recorded: exit 1" rc_is 1
check "--rollback with nothing recorded: says why" out_has 'nothing to roll back to'
t_new; make_gp_repo
BOOT="$SRC/install/boot.sh" boot --instance example/instance --commit "$C2" --update
check "--update with no checkout yet: exit 1" rc_is 1
check "--update with no checkout yet: nothing cloned" [ ! -e "$T/home/ghost-protocol" ]
check "--update with no checkout yet: says a first install takes no --update" out_has 'nothing to update'

# 17. The checkout's own boot.sh, run from inside it while the update rewrites
#     it (C2's copy is 400 lines longer): it reads its own old copy to the end.
t_new; make_gp_repo with-boot
BOOT="$SRC/install/boot.sh" boot --instance example/instance --commit "$C1" --yes
: >"$T/state/calls"
BOOT="$T/home/ghost-protocol/install/boot.sh" boot --instance example/instance --commit "$C2" --update --yes
check "own boot.sh: exit 0" rc_is 0
check "own boot.sh: at the new commit" [ "$(head_of)" = "$C2" ]
check "own boot.sh: the file did change under it" [ "$(grep -c 'padding line' "$T/home/ghost-protocol/install/boot.sh")" = "400" ]
check "own boot.sh: the installer ran its update steps, from C1" [ "$(update_line)" = "install-update yes prev=$C1 target=" ]

finish_tests
