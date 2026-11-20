# shellcheck shell=bash
# memory-backup.sh: step 14's memory backup (install/memory-backup/). Claude
# Code keeps an agent's auto-memory in a folder of notes that it, and the
# agent, rewrite as they go; a background run of Claude Code's own may rewrite
# or prune it at any time. The backup keeps every version of that folder in
# git, on the branch memory/<name> of the instance's own repo, and proves
# hourly that the remote copy restores (install/memory-backup/backup says how).
#
# This step installs it when the manifest has [memory_backup] (schema:
# install/schema/instance-v1.md), on Linux with systemd:
#   - a root-owned copy of the backup, its settings file (the manifest's
#     values, expanded) and, when alerts go to Buzz, the Buzz adapter (its
#     src/, package.json and node_modules/), in
#     /usr/local/lib/ghost-protocol/<name>/memory-backup/, so the instance's
#     user can't change what runs or where the memory goes;
#   - five units in /etc/systemd/system, made from install/memory-backup/:
#     <name>-memory-backup.service with its timer (every 15 minutes) and its
#     path unit (right after a memory write, through the plugin's hook), and
#     <name>-memory-verify.service with its timer (every hour);
#   - then daemon-reload, the timers and the path unit enabled and started,
#     and one backup and one verify now.
# The units run as the instance home's owner, never as root: the step refuses
# to run as root (it asks sudo for each root step itself) and a home owned by
# root or by someone else. Credentials for the alerts' key command go in the
# instance's own drop-ins (<unit>.service.d/); this step never writes one. A
# dry run prints every unit and the settings in full, and what the first
# backup would commit (the backup's own --dry-run: read-only). enabled =
# "false" turns the step off and prints how to remove an earlier one. In the
# installer any failure is a warning, a SKIP line, and the run goes on; with
# install/memory-backup/setup --apply (MB_STRICT=1) a step that installs
# nothing, or whose first backup or verify fails, is a FAIL line and the
# setup exits non-zero.
# install/memory-backup/setup runs this same step on its own, and removes it.
#
# Sourced by install/install (after service.sh, whose ag_owner, ag_node and
# ag_buzz it uses) and by install/memory-backup/setup.

MB_SRC="$GP_DIR/install/memory-backup"
MB_ETC=""; MB_LIB=""; MB_STATE=""; MB_USER=""; MB_GROUP=""; MB_HOME=""; MB_FOLDER=""
MB_READ=""; MB_NODE=""; MB_BUZZ=""; MB_WHY=""; MB_ALERTS=0

# Where the units, the root-owned copy and the state go. Tests point them at
# folders of their own (GP_ETC, GP_LIBDIR and GP_VARLIB, honoured only when
# GP_TEST=1); a test without GP_ETC and GP_LIBDIR gets no path, so nothing is
# written.
mb_paths() {
    local etc=/etc lib=/usr/local/lib var=/var/lib
    if [ "${GP_TEST:-}" = "1" ]; then
        etc="${GP_ETC:-}"; lib="${GP_LIBDIR:-}"; var="${GP_VARLIB:-${GP_ETC:-}/var-lib}"
    fi
    MB_ETC=""; MB_LIB=""; MB_STATE=""
    [ -n "$etc" ] && [ -n "$lib" ] || return 1
    MB_ETC="$etc/systemd/system"
    MB_LIB="$lib/ghost-protocol/$M_NAME/memory-backup"
    MB_STATE="$var/ghost-protocol/$M_NAME-memory-backup"
}

# The values the units and the settings are made from, each a plain path or
# word. Sets MB_* or MB_WHY.
mb_values() {
    local me o_uid o_user o_group h_uid h_rest home repo f p a lines="" re_name='^[a-z_][a-z0-9_-]*$'
    me="$(id -u)"
    if [ "$me" = "0" ]; then
        MB_WHY="this step runs as root; run it as the instance's user, which gets root for each root step itself, so the backup never runs as root"
        return 1
    fi
    repo="$(phys "$INSTANCE_DIR")"
    read -r o_uid o_user o_group <<EOF
$(ag_owner "$repo")
EOF
    case "$o_uid" in ''|*[!0-9]*) MB_WHY="could not tell who owns $repo"; return 1 ;; esac
    if [ "$o_uid" = "0" ]; then MB_WHY="the instance repo $repo is owned by root; the backup runs as its owner, never as root"; return 1; fi
    if [ "$o_uid" != "$me" ]; then
        MB_WHY="the instance repo $repo is owned by $o_user (uid $o_uid), not by $(id -un) (uid $me), who runs this; run it as $o_user"
        return 1
    fi
    MB_USER="$o_user"; MB_GROUP="$o_group"
    if ! [[ $MB_USER =~ $re_name ]] || ! [[ $MB_GROUP =~ $re_name ]]; then
        MB_WHY="the user or group name is not a plain name ($MB_USER:$MB_GROUP)"; return 1
    fi
    home="$(phys "$HOME")"
    if ! [[ $home =~ $AG_RE_PATH ]]; then MB_WHY="the home folder is not a plain path: $home"; return 1; fi
    read -r h_uid h_rest <<EOF
$(ag_owner "$home")
EOF
    if [ "$h_uid" != "$me" ]; then MB_WHY="HOME ($home) is not $MB_USER's own folder"; return 1; fi
    MB_HOME="$home"
    [ -x /usr/bin/python3 ] || { MB_WHY="the backup runs /usr/bin/python3, and it is not there"; return 1; }
    [ -x /usr/bin/git ] || { MB_WHY="the backup runs /usr/bin/git, and it is not there"; return 1; }
    f="$(expand_home "$M_MEMORY_BACKUP_FOLDER")"
    if [ -d "$f" ]; then
        f="$(phys "$f")"
        if [ "$(ag_owner "$f" | cut -d' ' -f1)" != "$me" ]; then MB_WHY="the memory folder $f is not $MB_USER's"; return 1; fi
    else
        warn "the memory backup: the memory folder $f is not there yet; each run says so until Claude Code writes the first memory"
    fi
    if ! [[ $f =~ $AG_RE_PATH ]]; then MB_WHY="the memory folder is not a plain path: $f"; return 1; fi
    MB_FOLDER="$f"
    while IFS= read -r p; do
        [ -n "$p" ] || continue
        a="$(expand_home "$p")"
        if ! [[ $a =~ $AG_RE_PATH ]]; then MB_WHY="read path $p is not a plain path"; return 1; fi
        [ -e "$a" ] || warn "the memory backup: read path $a is not there; the alerts' key command may fail without it"
        lines="${lines}BindReadOnlyPaths=-$a
"
    done <<EOF
$M_MEMORY_BACKUP_READ_PATHS
EOF
    MB_ALERTS=0; MB_NODE=""; MB_BUZZ=""
    if [ -n "$M_MEMORY_BACKUP_CHANNEL" ]; then
        MB_ALERTS=1
        if ! ag_node; then MB_WHY="$AG_WHY (for the alerts)"; return 1; fi
        if ! ag_buzz; then MB_WHY="$AG_WHY (for the alerts)"; return 1; fi
        MB_NODE="$AG_NODE"; MB_BUZZ="$AG_BUZZ"
        lines="${lines}BindReadOnlyPaths=-$MB_NODE
"
    fi
    MB_READ="${lines%
}"
    return 0
}

# The settings file the backup reads (install/memory-backup/backup, KEYS).
mb_settings() {
    printf 'NAME=%s\nFOLDER=%s\nREMOTE=%s\nBRANCH=%s\nSTATE=%s\n' \
        "$M_NAME" "$MB_FOLDER" "$M_MEMORY_BACKUP_REMOTE" "$M_MEMORY_BACKUP_BRANCH" "$MB_STATE"
    [ -z "$M_MEMORY_BACKUP_MAX_FILE_KB" ] || printf 'MAX_FILE_KB=%s\n' "$M_MEMORY_BACKUP_MAX_FILE_KB"
    [ -z "$M_MEMORY_BACKUP_MAX_REMOVED" ] || printf 'MAX_REMOVED_PERCENT=%s\n' "$M_MEMORY_BACKUP_MAX_REMOVED"
    if [ "$MB_ALERTS" = "1" ]; then
        printf 'NODE=%s\nCHANNEL=%s\nRELAY_URL=%s\nKEY_COMMAND=%s\nSEND_PATH=%s\n' \
            "$MB_NODE" "$M_MEMORY_BACKUP_CHANNEL" "$M_MEMORY_BACKUP_RELAY_URL" "$M_MEMORY_BACKUP_KEY_COMMAND" \
            "$MB_HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
        [ -z "$M_MEMORY_BACKUP_MENTIONS" ] || printf 'MENTIONS=%s\n' "$(printf '%s' "$M_MEMORY_BACKUP_MENTIONS" | tr '\n' ' ' | sed 's/ $//')"
        [ -z "$M_MEMORY_BACKUP_TASK_EMOJI" ] || printf 'TASK_EMOJI=%s\n' "$M_MEMORY_BACKUP_TASK_EMOJI"
        [ -z "$M_MEMORY_BACKUP_TASK_EMOJI_URL" ] || printf 'TASK_EMOJI_URL=%s\n' "$M_MEMORY_BACKUP_TASK_EMOJI_URL"
    fi
}

# A template with the values filled in (none holds & or \).
mb_render() {   # template dest unit what command calendar when
    MBR_NAME="$M_NAME" MBR_USER="$MB_USER" MBR_GROUP="$MB_GROUP" MBR_HOME="$MB_HOME" MBR_LIB="$MB_LIB" \
    MBR_FOLDER="$MB_FOLDER" MBR_STATE="$MB_STATE" MBR_READ="$MB_READ" MBR_UNIT="$3" MBR_WHAT="$4" \
    MBR_COMMAND="$5" MBR_CALENDAR="$6" MBR_WHEN="$7" \
    awk '
        $0 == "@READ_PATHS@" { if (ENVIRON["MBR_READ"] != "") print ENVIRON["MBR_READ"]; next }
        {
            line = $0
            gsub(/@NAME@/, ENVIRON["MBR_NAME"], line); gsub(/@USER@/, ENVIRON["MBR_USER"], line)
            gsub(/@GROUP@/, ENVIRON["MBR_GROUP"], line); gsub(/@HOME@/, ENVIRON["MBR_HOME"], line)
            gsub(/@LIB@/, ENVIRON["MBR_LIB"], line); gsub(/@FOLDER@/, ENVIRON["MBR_FOLDER"], line)
            gsub(/@STATE@/, ENVIRON["MBR_STATE"], line); gsub(/@UNIT@/, ENVIRON["MBR_UNIT"], line)
            gsub(/@WHAT@/, ENVIRON["MBR_WHAT"], line); gsub(/@COMMAND@/, ENVIRON["MBR_COMMAND"], line)
            gsub(/@CALENDAR@/, ENVIRON["MBR_CALENDAR"], line); gsub(/@WHEN@/, ENVIRON["MBR_WHEN"], line)
            print line
        }' "$1" >"$2" || return 1
    ! grep -q '@[A-Z_]*@' "$2"
}

# What goes into the root-owned folder, put together as the user first.
mb_stage() {   # dest
    local d="$1"
    mkdir -p "$d" && cp "$MB_SRC/backup" "$d/backup" && mb_settings >"$d/settings" || return 1
    if [ "$MB_ALERTS" = "1" ]; then
        mkdir -p "$d/buzz" && cp -R "$MB_BUZZ/src" "$d/buzz/src" && cp "$MB_BUZZ/package.json" "$d/buzz/package.json" \
            && cp -R "$MB_BUZZ/node_modules" "$d/buzz/node_modules" || return 1
    fi
    chmod -R go-w "$d" && chmod 0755 "$d/backup" && chmod 0644 "$d/settings"
}

# The five units, rendered into a folder: name, then what each is.
MB_UNITS="memory-backup.service memory-backup.timer memory-backup.path memory-verify.service memory-verify.timer"
mb_render_all() {   # folder
    local w="$1" b="$M_NAME-memory-backup" v="$M_NAME-memory-verify"
    mb_render "$MB_SRC/memory-backup.service" "$w/$b.service" "$b" "a memory backup" run "" "" \
        && mb_render "$MB_SRC/memory-backup.timer" "$w/$b.timer" "$b" "a memory backup" "" "*:0/15" "every 15 minutes" \
        && mb_render "$MB_SRC/memory-backup.path" "$w/$b.path" "$b" "" "" "" "" \
        && mb_render "$MB_SRC/memory-backup.service" "$w/$v.service" "$v" "the memory backup's verify" verify "" "" \
        && mb_render "$MB_SRC/memory-backup.timer" "$w/$v.timer" "$v" "the memory backup's verify" "" "*:07" "every hour"
}

# A step that installs nothing is a SKIP line in the installer (a warning; the
# run goes on), and a FAIL with install/memory-backup/setup --apply
# (MB_STRICT=1), which then exits non-zero.
mb_record_skip() {   # detail
    if [ "${MB_STRICT:-0}" = "1" ]; then
        say "the memory backup is NOT installed: $1"
        record FAIL memory-backup "nothing installed: $1"
    else
        record SKIP memory-backup "$1"
    fi
}

mb_skip() {   # why
    warn "the memory backup was not set up: $1."
    warn "The instance runs without it: its memory folder is not backed up."
    mb_record_skip "$1"
}

mb_line() {
    printf '%s to %s on %s, every 15 min and after each memory write, verified hourly' \
        "${MB_FOLDER:-$M_MEMORY_BACKUP_FOLDER}" "$M_MEMORY_BACKUP_BRANCH" "$M_MEMORY_BACKUP_REMOTE"
}

mb_hand_undo() {
    local n="$M_NAME"
    say "to remove one already set up, run: install/memory-backup/setup --home <instance home> --uninstall --apply"
    say "  (it disables $n-memory-backup.timer, $n-memory-backup.path and $n-memory-verify.timer, and removes the units)"
}

memory_backup() {
    local work stage n="$M_NAME" u same=1 enabled=1 f
    if [ "$M_MEMORY_BACKUP_SET" != "1" ]; then
        say "the memory backup: not set up (the manifest has no [memory_backup])"
        mb_record_skip "not set up: the manifest has no [memory_backup]"
        return 0
    fi
    if [ "$M_MEMORY_BACKUP_ENABLED" = "false" ]; then
        say "the memory backup is turned off in the manifest ([memory_backup] enabled = \"false\")."
        mb_hand_undo
        mb_record_skip "turned off in the manifest; one already set up is left as it is"
        return 0
    fi
    if [ "$GP_OS" != "linux" ]; then
        say "the memory backup runs from systemd units, for Linux; nothing to do on $GP_OS"
        mb_record_skip "systemd units, for Linux; nothing to do on $GP_OS"
        return 0
    fi
    say "the memory backup: $(mb_line)"
    if ! command -v systemctl >/dev/null 2>&1; then mb_skip "no systemd here (systemctl is missing)"; return 0; fi
    if ! mb_paths; then
        say "TEST MODE (GP_TEST=1) without GP_ETC and GP_LIBDIR: nothing is written"
        mb_record_skip "test mode without GP_ETC and GP_LIBDIR; nothing written"
        return 0
    fi
    if ! mb_values; then mb_skip "$MB_WHY"; return 0; fi
    [ "$MB_ALERTS" = "1" ] || say "note: no buzz_channel in [memory_backup], so its alerts are logged only (journalctl)"
    if ! make_work; then mb_skip "could not make a private temporary folder"; return 0; fi
    work="$GP_WORK/memory-backup-units"; stage="$GP_WORK/memory-backup"
    rm -rf "$work" "$stage"; mkdir -p "$work"
    if ! mb_stage "$stage"; then mb_skip "could not put the backup's files together"; return 0; fi
    if ! mb_render_all "$work"; then mb_skip "could not fill in the unit templates in $MB_SRC"; return 0; fi

    # What is there now: read-only, so a dry run does it too.
    [ -d "$MB_LIB" ] && diff -rq "$stage" "$MB_LIB" >/dev/null 2>&1 || same=0
    for u in $MB_UNITS; do cmp -s "$work/$n-$u" "$MB_ETC/$n-$u" || same=0; done
    for u in memory-backup.timer memory-backup.path memory-verify.timer; do
        systemctl is-enabled --quiet "$n-$u" 2>/dev/null && systemctl is-active --quiet "$n-$u" 2>/dev/null || enabled=0
    done
    if [ "$same$enabled" = "11" ]; then
        say "the memory backup is installed and its timers run, as this run would set it up"
        if [ "$DRY_RUN" = "1" ]; then
            say "with --apply, a verify runs first (as root), before it is called done"
            record OK memory-backup "installed and running (a dry run runs no verify): $(mb_line)"
            return 0
        fi
        # Installed is not proven: a verify now, before anything says done.
        if ! root_prepare "The memory backup"; then mb_skip "$ROOT_PROBLEM"; return 0; fi
        say "a verify now, before calling it done:"
        if as_root systemctl start "$n-memory-verify.service"; then   # guard:againverify
            record OK memory-backup "installed and running, and a verify just passed: $(mb_line)"
        else
            warn "the memory backup: the verify exited non-zero (see journalctl -u $n-memory-verify)"
            if [ "${MB_STRICT:-0}" = "1" ]; then
                record FAIL memory-backup "installed and running, but the verify exited non-zero (see journalctl -u $n-memory-verify)"
            else
                record SKIP memory-backup "installed and running, but the verify exited non-zero (see journalctl -u $n-memory-verify)"
            fi
        fi
        return 0
    fi

    if [ "$DRY_RUN" = "1" ]; then
        if [ "$same" = "1" ]; then say "$MB_LIB and the units are already these files"; fi
        say "would copy the backup$([ "$MB_ALERTS" = 1 ] && echo ' and the Buzz adapter') to $MB_LIB (root-owned), with this settings file:"
        sed 's/^/    | /' "$stage/settings"
        for u in $MB_UNITS; do
            f="$work/$n-$u"
            if cmp -s "$f" "$MB_ETC/$n-$u"; then say "$MB_ETC/$n-$u is already this file"; continue; fi
            if [ -f "$MB_ETC/$n-$u" ]; then
                say "would replace $MB_ETC/$n-$u (as root); the differences:"
                diff -u "$MB_ETC/$n-$u" "$f" | sed 's/^/    /' || true
            else say "would write $MB_ETC/$n-$u (as root), this file in full:"; sed 's/^/    | /' "$f"; fi
        done
        show_cmd systemctl daemon-reload
        show_cmd systemctl enable --now "$n-memory-backup.timer" "$n-memory-backup.path" "$n-memory-verify.timer"
        show_cmd systemctl start "$n-memory-backup.service"
        show_cmd systemctl start "$n-memory-verify.service"
        say "(each as root; in the installer a failure is a warning, not a stop; with install/memory-backup/setup --apply, a failed first backup or verify makes it exit non-zero)"
        say "what the first backup would do now (the backup's own --dry-run: read-only, nothing written or pushed):"
        env -i PATH="/usr/bin:/bin" HOME="$HOME" LANG=C.UTF-8 TMPDIR="${TMPDIR:-/tmp}" GP_TEST="${GP_TEST:-}" \
            GP_MB_GIT="${GP_MB_GIT:-}" GP_MB_SETTINGS="$stage/settings" "$stage/backup" run --dry-run 2>&1 \
            | sed 's/^/    /' || true
        record PLAN memory-backup "would install the memory backup: $(mb_line)"
        return 0
    fi

    if ! root_prepare "The memory backup"; then mb_skip "$ROOT_PROBLEM"; return 0; fi
    if [ ! -d "$MB_LIB" ] || ! diff -rq "$stage" "$MB_LIB" >/dev/null 2>&1; then
        say "copying the backup to $MB_LIB"
        if ! as_root rm -rf "$MB_LIB.new" "$MB_LIB.old" \
            || ! as_root install -d -m 0755 "${MB_LIB%/*}" \
            || ! as_root cp -R "$stage" "$MB_LIB.new" \
            || ! as_root chmod -R go-w "$MB_LIB.new"; then
            mb_skip "could not copy the backup to $MB_LIB.new as root"; return 0
        fi
        if [ -d "$MB_LIB" ] && ! as_root mv "$MB_LIB" "$MB_LIB.old"; then mb_skip "could not move the old $MB_LIB aside"; return 0; fi
        if ! as_root mv "$MB_LIB.new" "$MB_LIB"; then mb_skip "could not put $MB_LIB in place"; return 0; fi
        as_root rm -rf "$MB_LIB.old" || warn "could not remove $MB_LIB.old"
    fi
    for u in $MB_UNITS; do
        cmp -s "$work/$n-$u" "$MB_ETC/$n-$u" && continue
        say "writing $MB_ETC/$n-$u"
        if ! as_root install -m 0644 "$work/$n-$u" "$MB_ETC/$n-$u"; then mb_skip "could not write $MB_ETC/$n-$u as root"; return 0; fi
    done
    if ! as_root systemctl daemon-reload; then mb_skip "systemctl daemon-reload failed"; return 0; fi
    if ! as_root systemctl enable --now "$n-memory-backup.timer" "$n-memory-backup.path" "$n-memory-verify.timer"; then
        mb_skip "systemctl enable --now of the timers and the path unit failed"; return 0
    fi
    say "the first backup and the first verify now:"
    local result="the first backup and verify finished"
    as_root systemctl start "$n-memory-backup.service" || result="the first backup exited non-zero (see journalctl -u $n-memory-backup)"
    if [ "$result" = "the first backup and verify finished" ]; then
        as_root systemctl start "$n-memory-verify.service" || result="the first verify exited non-zero (see journalctl -u $n-memory-verify)"
    fi
    if [ "$result" = "the first backup and verify finished" ]; then
        say "the memory backup is installed; $result"
        record DONE memory-backup "installed, the timers running; $result: $(mb_line)"
    else
        warn "the memory backup: $result"
        say "the memory backup is installed, but $result: it is not proven yet"
        if [ "${MB_STRICT:-0}" = "1" ]; then
            record FAIL memory-backup "installed, but $result"
        else
            record DONE memory-backup "installed, the timers running, but $result: $(mb_line)"
        fi
    fi
    return 0
}

# Removes the units and the root-owned copy: install/memory-backup/setup
# --uninstall. The state folder stays (its repo may hold commits that never
# reached the remote), and so do the instance's drop-ins.
memory_backup_uninstall() {
    local n="$M_NAME" u
    if ! mb_paths; then
        say "TEST MODE (GP_TEST=1) without GP_ETC and GP_LIBDIR: nothing is removed"
        record SKIP memory-backup "test mode without GP_ETC and GP_LIBDIR; nothing removed"
        return 0
    fi
    if [ "$DRY_RUN" = "1" ]; then
        show_cmd systemctl disable --now "$n-memory-backup.timer" "$n-memory-backup.path" "$n-memory-verify.timer"
        show_cmd systemctl stop "$n-memory-backup.service" "$n-memory-verify.service"
        for u in $MB_UNITS; do show_cmd rm -f "$MB_ETC/$n-$u"; done
        show_cmd rm -rf "$MB_LIB" "$MB_LIB.new" "$MB_LIB.old"
        show_cmd rmdir "${MB_LIB%/*}"
        show_cmd systemctl daemon-reload
        say "(each as root; rmdir only when the folder is empty. The state folder $MB_STATE stays: its repo may"
        say "  hold commits that never reached the remote. The drop-ins in $MB_ETC/$n-memory-*.service.d/ are the instance's, and stay.)"
        record PLAN memory-backup "would remove the memory backup"
        return 0
    fi
    if ! root_prepare "Removing the memory backup"; then record FAIL memory-backup "$ROOT_PROBLEM"; return 1; fi
    as_root systemctl disable --now "$n-memory-backup.timer" "$n-memory-backup.path" "$n-memory-verify.timer" || warn "no timers to disable"
    as_root systemctl stop "$n-memory-backup.service" "$n-memory-verify.service" || warn "no service to stop"
    for u in $MB_UNITS; do
        as_root rm -f "$MB_ETC/$n-$u" || { record FAIL memory-backup "could not remove $MB_ETC/$n-$u"; return 1; }
    done
    as_root rm -rf "$MB_LIB" "$MB_LIB.new" "$MB_LIB.old" || { record FAIL memory-backup "could not remove $MB_LIB"; return 1; }
    as_root rmdir "${MB_LIB%/*}" 2>/dev/null || true
    as_root systemctl daemon-reload || warn "systemctl daemon-reload failed"
    say "removed; the state folder $MB_STATE stays (remove it by hand once its commits are on the remote),"
    say "  and so do the instance's drop-ins"
    record DONE memory-backup "removed the memory backup"
    return 0
}
