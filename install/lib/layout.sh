# shellcheck shell=bash
# layout.sh: step 5, the root layout (docs/layout.md): the shared folders
# beside the instance's home, <root>/<name>, the Claude Code worktree hook
# that puts every new worktree under <root>/worktrees/<repo>/<branch>, and the
# shared folders in the Claude Code settings' permissions.additionalDirectories.
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

# ------------------------------------------------- Claude Code's additional directories

# The shared folders go into permissions.additionalDirectories of the user's
# Claude Code settings, so a session in the home may read and edit them too.
# The edit is a jq merge: other keys and other entries are kept, a folder
# already there is not added again, and a later copy of one is dropped. An
# old root's folders are replaced: a parent that holds all five shared folders
# in the list and is not this root is taken for an old root (a move or a new
# root in the manifest), and its five entries go.
layout_settings_file() { printf '%s' "$HOME/.claude/settings.json"; }

# The jq filters name jq's own $variables inside single quotes, on purpose.
# shellcheck disable=SC2016
LAYOUT_DIRS_JQ='
    def split_: if type == "string" then (capture("^(?<p>.+)/(?<n>[^/]+)$") // null) else null end;
    def shared: split_ as $m | $m != null and any($names[]; . == $m.n);
    def has_($a; $x): any($a[]; . == $x);
    (.permissions.additionalDirectories // []) as $cur
    | if ($cur | type) != "array" then error("permissions.additionalDirectories is not a list") else . end
    | ($names | map($root + "/" + .)) as $want
    | ([$cur[] | select(shared) | split_.p] | unique
       | map(. as $p | select($p != $root and (test("[|\n]") | not)
             and all($names[]; has_($cur; $p + "/" + .))))) as $gone
    | (reduce ($cur[] | select((shared and has_($gone; split_.p)) | not)) as $e
         ([]; if has_($want; $e) and has_(.; $e) then . else . + [$e] end)) as $kept
    | ($kept + [$want[] | select(. as $w | has_($kept; $w) | not)]) as $new
    | if $new == $cur then . else .permissions.additionalDirectories = $new end'

# What the last layout_add_dirs did, for the move script's state file:
# LAYOUT_DIRS_ADDED and LAYOUT_DIRS_DROPPED (one path per line), the list
# before and after (LAYOUT_DIRS_BEFORE, LAYOUT_DIRS_AFTER, as one-line JSON),
# and LAYOUT_DIRS_MADE: the key it made (permissions, additionalDirectories or
# nothing). DIRS_STATE is added, already, would or not.
LAYOUT_DIRS_ADDED="" LAYOUT_DIRS_DROPPED="" LAYOUT_DIRS_MADE="" DIRS_STATE="" DIRS_LINE=""
LAYOUT_DIRS_BEFORE="" LAYOUT_DIRS_AFTER=""

# Put <root>/<folder> for each shared folder into the settings' list. It sets
# DIRS_STATE, and DIRS_LINE to a line that says what it did; dry=1 only says
# what it would do.
layout_add_dirs() {   # root dry(0|1)
    local root="$1" dry="$2" f names src out new gone what
    f="$(layout_settings_file)"
    LAYOUT_DIRS_ADDED="" LAYOUT_DIRS_DROPPED="" LAYOUT_DIRS_MADE="" DIRS_STATE=not
    LAYOUT_DIRS_BEFORE="" LAYOUT_DIRS_AFTER=""
    command -v jq >/dev/null 2>&1 || { DIRS_LINE="not added: putting the shared folders in $f needs jq"; return 0; }
    # shellcheck disable=SC2086  # the folder names, split on purpose
    names="$(printf '%s\n' $LAYOUT_DIRS | jq -R . | jq -sc .)"
    # An empty file (nothing in it but blanks) is taken as {}.
    if [ -e "$f" ] && grep -q '[^[:space:]]' "$f" 2>/dev/null; then
        jq -e 'type == "object"' "$f" >/dev/null 2>&1 || { DIRS_LINE="not added: $f is not a JSON object"; return 0; }
        src="$(cat "$f")"
    else
        src='{}'
    fi
    out="$(printf '%s' "$src" | jq --arg root "$root" --argjson names "$names" "$LAYOUT_DIRS_JQ" 2>&1)" \
        || { DIRS_LINE="not added: jq could not edit $f ($out)"; return 0; }
    if [ -e "$f" ] && printf '%s\n' "$out" | jq -e --slurpfile a "$f" '. == $a[0]' >/dev/null 2>&1; then
        DIRS_STATE=already
        DIRS_LINE="already there: the shared folders of $root are in $f (permissions.additionalDirectories)"
        return 0
    fi
    # The old and new text go to jq on stdin (as [old, new]), not as
    # arguments: a settings file can be larger than one argument may be.
    # shellcheck disable=SC2016
    LAYOUT_DIRS_ADDED="$(printf '%s\n%s\n' "$src" "$out" | jq -rs \
        '(.[0].permissions.additionalDirectories // []) as $o | .[1].permissions.additionalDirectories[] | select(. as $x | any($o[]; . == $x) | not)')"
    # shellcheck disable=SC2016
    LAYOUT_DIRS_DROPPED="$(printf '%s\n%s\n' "$src" "$out" | jq -rs \
        '.[1].permissions.additionalDirectories as $n | (.[0].permissions.additionalDirectories // [])[] | select(type == "string" and (. as $x | any($n[]; . == $x) | not))' | sort -u)"
    LAYOUT_DIRS_BEFORE="$(printf '%s' "$src" | jq -c '.permissions.additionalDirectories // []')"
    LAYOUT_DIRS_AFTER="$(printf '%s' "$out" | jq -c '.permissions.additionalDirectories')"
    new="$(printf '%s' "$LAYOUT_DIRS_ADDED" | grep -c . || true)"
    gone="$(printf '%s' "$LAYOUT_DIRS_DROPPED" | grep -c . || true)"
    what="$new shared folder(s) of $root"
    [ "$gone" = "0" ] || what="$what, in place of $gone entries of an old root,"
    if printf '%s' "$src" | jq -e '(.permissions | type) != "object"' >/dev/null 2>&1; then LAYOUT_DIRS_MADE=permissions
    elif printf '%s' "$src" | jq -e '.permissions | has("additionalDirectories") | not' >/dev/null 2>&1; then LAYOUT_DIRS_MADE=additionalDirectories
    fi
    if [ "$dry" = "1" ]; then
        DIRS_STATE=would
        DIRS_LINE="would add: $what to $f (permissions.additionalDirectories)"
        return 0
    fi
    if [ -e "$f" ]; then
        write_json_file "$f" "$out" || { DIRS_STATE=not; DIRS_LINE="not added: could not write $f"; return 0; }
    else
        { mkdir -p "$(dirname "$f")" && printf '%s\n' "$out" >"$f"; } || { DIRS_LINE="not added: could not write $f"; return 0; }
    fi
    DIRS_STATE=added
    DIRS_LINE="added: $what to $f (permissions.additionalDirectories)"
}

step_layout() {
    local root want n hook dirs
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
    layout_add_dirs "$root" "$DRY_RUN"
    say "$DIRS_LINE"
    case "$DIRS_STATE" in
        added) dirs="shared folders added to additionalDirectories" ;;
        already) dirs="shared folders already in additionalDirectories" ;;
        would) dirs="would add the shared folders to additionalDirectories" ;;
        *) dirs="shared folders NOT in additionalDirectories (see above)"; warn "the shared folders are not in Claude Code's additionalDirectories: a session in the home asks before it reads or edits them" ;;
    esac
    if [ "$DRY_RUN" = "1" ] && { [ "$n" -gt 0 ] || [ "$HOOK_STATE" = would ] || [ "$DIRS_STATE" = would ]; }; then
        record PLAN layout "$root: would make $n folders; $hook; $dirs"
    elif [ "$n" -gt 0 ] || [ "$HOOK_STATE" = wired ] || [ "$DIRS_STATE" = added ]; then
        record DONE layout "$root: made $n folders; $hook; $dirs"
    else
        record OK layout "$root: every folder there; $hook; $dirs"
    fi
    return 0
}
