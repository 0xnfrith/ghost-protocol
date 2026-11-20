# shellcheck shell=bash
# layout.sh: step 5, the root layout (docs/layout.md): the shared folders
# beside the instance's home, <root>/<name>, and the Claude Code worktree hook
# that puts every new worktree under <root>/worktrees/<repo>/<branch>.
# Sourced by install/install and install/layout/move. Needs instance.sh
# (LAYOUT_DIRS) and common.sh.

LAYOUT_MADE=""   # the folders the last layout_make_dirs made, one per line

# Make the layout's folders under a root (the root too, if it is missing).
# dry=1 only says what it would make. Returns 1 when a folder's place holds
# something that is not a folder (it is left alone).
layout_make_dirs() {   # root dry(0|1)
    local root="$1" dry="$2" f p bad=0
    LAYOUT_MADE=""
    for f in . $LAYOUT_DIRS; do
        if [ "$f" = "." ]; then p="$root"; else p="$root/$f"; fi
        if [ -d "$p" ]; then
            continue
        elif [ -e "$p" ] || [ -L "$p" ]; then
            say "$p exists and is not a folder; left alone"
            bad=1
        elif [ "$dry" = "1" ]; then
            say "would make $p"
            LAYOUT_MADE="$LAYOUT_MADE$p
"
        else
            mkdir -p "$p" || return 1
            say "made $p"
            LAYOUT_MADE="$LAYOUT_MADE$p
"
        fi
    done
    return "$bad"
}

# Wire the worktree hook into the user's Claude Code settings. Prints the
# hook's own lines; sets HOOK_STATE to wired, already, would or not.
layout_wire_hook() {   # root dry(0|1)
    local out rc
    if [ "$2" = "1" ]; then
        out="$("$GP_DIR/install/layout/worktree-hook" wire --root "$1" --dry-run 2>&1)"
    else
        out="$("$GP_DIR/install/layout/worktree-hook" wire --root "$1" 2>&1)"
    fi
    rc=$?
    [ -z "$out" ] || printf '%s\n' "$out" | sed 's/^/  /'
    case "$rc:$out" in
        "0:wired"*) HOOK_STATE=wired ;;
        "0:already"*) HOOK_STATE=already ;;
        "0:would"*) HOOK_STATE=would ;;
        *) HOOK_STATE=not ;;
    esac
}

step_layout() {
    local root want n hook
    heading "5. layout"
    if [ -z "$M_NAME" ]; then
        record PLAN layout "would build the root layout once the manifest is read"
        return 0
    fi
    if [ -z "$M_ROOT_DIR" ]; then
        say "a single-folder instance (schema v0 with no root): no root layout"
        record SKIP layout "single-folder instance: no root layout (docs/layout.md)"
        return 0
    fi
    root="$(phys "$M_ROOT_DIR")"
    want="$root/$M_NAME"
    if [ "$M_ROOT_FROM" = "dir" ]; then
        # A v0 manifest names the home only; the folders and a hook for every
        # session on the machine wait until the manifest says v1.
        say "schema v0: the home is $want, but the layout is built only for a schema v1 manifest"
        record SKIP layout "schema v0: write schema v1 with root = \"$M_ROOT\" to build the layout"
        return 0
    fi
    if [ "$INSTANCE_DIR" != "$want" ]; then
        say "the instance is at $INSTANCE_DIR, not $want: the layout is built only around <root>/<name>"
        record SKIP layout "the instance is not at $want; no layout built"
        return 0
    fi
    if ! layout_make_dirs "$root" "$DRY_RUN"; then
        record FAIL layout "a layout folder's place under $root holds something else (see above)"
        return 1
    fi
    n="$(printf '%s' "$LAYOUT_MADE" | grep -c . || true)"
    layout_wire_hook "$root" "$DRY_RUN"
    case "$HOOK_STATE" in
        wired) hook="worktree hook wired" ;;
        already) hook="worktree hook already wired" ;;
        would) hook="would wire the worktree hook" ;;
        *) hook="worktree hook NOT wired (see above)"; warn "the worktree hook is not wired: new worktrees go to Claude Code's default place" ;;
    esac
    if [ "$DRY_RUN" = "1" ] && { [ "$n" -gt 0 ] || [ "$HOOK_STATE" = would ]; }; then
        record PLAN layout "$root: would make $n folders; $hook"
    elif [ "$n" -gt 0 ] || [ "$HOOK_STATE" = wired ]; then
        record DONE layout "$root: made $n folders; $hook"
    else
        record OK layout "$root: every folder there; $hook"
    fi
    return 0
}
