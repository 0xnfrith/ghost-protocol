# shellcheck shell=bash
# own-claude.sh: what the session-id and turn-state hooks share: whether the
# hook was run by the instance's own claude, the one install/service/start
# started in the instance's tmux pane. Sourced, never run. bash 3.2 compatible.
#
# GP_INSTANCE_NAME alone cannot say so: every process claude starts inherits
# it, a claude -p the agent runs from a Bash call among them. So start writes
# the pid of the pane's claude to <state>/pane-pid, and own_claude <state> is
# true only when, walking up from the hook's parent, the first claude it meets
# is that pid. A claude met first (a process named claude, or named as the
# pane's process is) is another one: one the instance's claude started, whose
# hooks must leave the instance's state alone. A claude in another window of
# the instance's tmux server never has the pane's claude above it at all.
#
# It reads the process tree from /proc, else from ps (macOS), and fails
# closed: no pane-pid file, no pid in it, no way to read a process, or no such
# ancestor within 64 steps, and it is false.

# own_proc_ppid PID: the parent's pid, or nothing.
own_proc_ppid() {
    local k v
    if [ -r "/proc/$1/status" ]; then
        while read -r k v; do
            if [ "$k" = "PPid:" ]; then printf '%s' "$v"; return 0; fi
        done <"/proc/$1/status"
        return 0
    fi
    v="$(ps -o ppid= -p "$1" 2>/dev/null)" || return 0
    printf '%s' "${v//[[:space:]]/}"
}

# own_proc_name PID: the process's name (/proc's comm, or ps's command without
# its folder), or nothing.
own_proc_name() {
    local n=""
    if [ -r "/proc/$1/comm" ]; then
        read -r n <"/proc/$1/comm" || true
    else
        n="$(ps -o comm= -p "$1" 2>/dev/null)" || n=""
        n="${n##*/}"
    fi
    printf '%s' "$n"
}

# own_claude STATE: true when the nearest claude above this hook is the one in
# STATE/pane-pid (see the top).
own_claude() {
    local pane="" p name pane_name i=0
    [ -f "$1/pane-pid" ] && [ ! -L "$1/pane-pid" ] || return 1
    read -r pane <"$1/pane-pid" || [ -n "$pane" ] || return 1
    case "$pane" in '' | *[!0-9]* | 0 | 1) return 1 ;; esac
    pane_name="$(own_proc_name "$pane")"
    p="${PPID:-}"
    while [ "$i" -lt 64 ]; do
        case "$p" in '' | *[!0-9]* | 0 | 1) return 1 ;; esac
        [ "$p" = "$pane" ] && return 0
        name="$(own_proc_name "$p")"
        if [ "$name" = claude ] || { [ -n "$pane_name" ] && [ "$name" = "$pane_name" ]; }; then
            return 1
        fi
        p="$(own_proc_ppid "$p")"
        i=$((i + 1))
    done
    return 1
}
