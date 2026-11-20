# shellcheck shell=bash
# instance.sh: step 3 (clone the instance repo), step 4 (read and check its
# manifest, .ghost-protocol/instance.toml) and step 6 (its setup hook).
# Sourced by install/install, install/layout/move and the manifest tests.

MANIFEST_REL=".ghost-protocol/instance.toml"
SCHEMA_V0="ghost-protocol/instance/v0"
SCHEMA_V1="ghost-protocol/instance/v1"
# The root layout's shared folders (docs/layout.md). An instance name may not
# be one of them, since the instance's home is <root>/<name> beside them.
LAYOUT_DIRS="repos worktrees media desk scratch"
INSTANCE_DIR=""
INSTANCE_CREATED=0    # 1 only when this run made the clone
INSTANCE_EXISTS=0     # 1 when the directory was already a clone
INSTANCE_OLD_FOLDER=0 # 1 when an old single-folder ~/<repo> is used: no root layout yet
ROOT_CREATED=""       # the root folder, when this run made it for a new clone
MANIFEST_FILE=""
PEEK_COMMIT=""
M_SCHEMA=""; M_NAME=""; M_DIR=""; M_ROOT=""
# M_ROOT_DIR: the root, expanded; empty for a single-folder instance.
# M_ROOT_FROM: root (schema v1), dir (a v0 dir of <root>/<name>), or empty.
M_ROOT_DIR=""; M_ROOT_FROM=""
M_GITHUB_LOGIN=""; M_GITHUB_ALSO_LOGIN=""; M_GITHUB_HOST_CONFIG=""; M_GITHUB_REPOS=""
M_CLAUDE_EMAIL=""; M_SETUP_COMMAND=""
# [memory_guard]: enabled ("true" or "false"), and both percentages or neither.
M_MEMORY_GUARD_ENABLED=""; M_MEMORY_GUARD_TERM=""; M_MEMORY_GUARD_KILL=""
# [automode_guard]: the auto-mode drift guard (install/automode-guard/). The
# arrays hold one value per line. M_AUTOMODE_GUARD_SET is 1 when the section
# holds any key.
M_AUTOMODE_GUARD_SET=""; M_AUTOMODE_GUARD_ENABLED=""; M_AUTOMODE_GUARD_SNAPSHOT=""
M_AUTOMODE_GUARD_RELAY_URL=""; M_AUTOMODE_GUARD_KEY_COMMAND=""; M_AUTOMODE_GUARD_CHANNEL=""
M_AUTOMODE_GUARD_MENTIONS=""; M_AUTOMODE_GUARD_READ_PATHS=""; M_AUTOMODE_GUARD_OWNER=""; M_AUTOMODE_GUARD_LEDGER=""
M_AUTOMODE_GUARD_TASK_EMOJI=""; M_AUTOMODE_GUARD_TASK_EMOJI_URL=""
# [memory_backup]: the memory backup (install/memory-backup/). The arrays hold
# one value per line. M_MEMORY_BACKUP_SET is 1 when the section holds any key.
M_MEMORY_BACKUP_SET=""; M_MEMORY_BACKUP_ENABLED=""; M_MEMORY_BACKUP_FOLDER=""; M_MEMORY_BACKUP_REMOTE=""
M_MEMORY_BACKUP_BRANCH=""; M_MEMORY_BACKUP_RELAY_URL=""; M_MEMORY_BACKUP_KEY_COMMAND=""
M_MEMORY_BACKUP_CHANNEL=""; M_MEMORY_BACKUP_MENTIONS=""; M_MEMORY_BACKUP_READ_PATHS=""
M_MEMORY_BACKUP_MAX_FILE_KB=""; M_MEMORY_BACKUP_MAX_REMOVED=""
M_MEMORY_BACKUP_TASK_EMOJI=""; M_MEMORY_BACKUP_TASK_EMOJI_URL=""
MANIFEST_ERRORS=""

# ---------------------------------------------------------------- manifest

# Read and check a manifest. Sets the M_* variables; on failure returns 1 with
# one problem per line in MANIFEST_ERRORS.
manifest_load() {
    local file="$1" out rc k a b
    M_SCHEMA=""; M_NAME=""; M_DIR=""; M_ROOT=""; M_ROOT_DIR=""; M_ROOT_FROM=""
    M_GITHUB_LOGIN=""; M_GITHUB_ALSO_LOGIN=""; M_GITHUB_HOST_CONFIG=""; M_GITHUB_REPOS=""
    M_CLAUDE_EMAIL=""; M_SETUP_COMMAND=""
    M_MEMORY_GUARD_ENABLED=""; M_MEMORY_GUARD_TERM=""; M_MEMORY_GUARD_KILL=""
    M_AUTOMODE_GUARD_SET=""; M_AUTOMODE_GUARD_ENABLED=""; M_AUTOMODE_GUARD_SNAPSHOT=""
    M_AUTOMODE_GUARD_RELAY_URL=""; M_AUTOMODE_GUARD_KEY_COMMAND=""; M_AUTOMODE_GUARD_CHANNEL=""
    M_AUTOMODE_GUARD_MENTIONS=""; M_AUTOMODE_GUARD_READ_PATHS=""; M_AUTOMODE_GUARD_OWNER=""; M_AUTOMODE_GUARD_LEDGER=""
    M_AUTOMODE_GUARD_TASK_EMOJI=""; M_AUTOMODE_GUARD_TASK_EMOJI_URL=""
    M_MEMORY_BACKUP_SET=""; M_MEMORY_BACKUP_ENABLED=""; M_MEMORY_BACKUP_FOLDER=""; M_MEMORY_BACKUP_REMOTE=""
    M_MEMORY_BACKUP_BRANCH=""; M_MEMORY_BACKUP_RELAY_URL=""; M_MEMORY_BACKUP_KEY_COMMAND=""
    M_MEMORY_BACKUP_CHANNEL=""; M_MEMORY_BACKUP_MENTIONS=""; M_MEMORY_BACKUP_READ_PATHS=""
    M_MEMORY_BACKUP_MAX_FILE_KB=""; M_MEMORY_BACKUP_MAX_REMOVED=""
    M_MEMORY_BACKUP_TASK_EMOJI=""; M_MEMORY_BACKUP_TASK_EMOJI_URL=""
    MANIFEST_ERRORS=""
    if [ ! -f "$file" ]; then
        MANIFEST_ERRORS="no manifest at $file"
        return 1
    fi
    out="$(awk -f "$GP_DIR/install/lib/manifest.awk" "$file")"
    rc=$?
    while IFS="$(printf '\t')" read -r k a b; do
        case "$k" in
            "") ;;
            ERR) MANIFEST_ERRORS="${MANIFEST_ERRORS}line $a: $b
" ;;
            schema) M_SCHEMA="$a" ;;
            name) M_NAME="$a" ;;
            dir) M_DIR="$a" ;;
            root) M_ROOT="$a" ;;
            github.login) M_GITHUB_LOGIN="$a" ;;
            github.also_login) M_GITHUB_ALSO_LOGIN="$a" ;;
            github.host_config) M_GITHUB_HOST_CONFIG="$a" ;;
            "github.repos[]") M_GITHUB_REPOS="${M_GITHUB_REPOS}$a
" ;;
            claude.email) M_CLAUDE_EMAIL="$a" ;;
            setup.command) M_SETUP_COMMAND="$a" ;;
            memory_guard.enabled) M_MEMORY_GUARD_ENABLED="$a" ;;
            memory_guard.term_percent) M_MEMORY_GUARD_TERM="$a" ;;
            memory_guard.kill_percent) M_MEMORY_GUARD_KILL="$a" ;;
            automode_guard.enabled) M_AUTOMODE_GUARD_SET=1; M_AUTOMODE_GUARD_ENABLED="$a" ;;
            automode_guard.snapshot) M_AUTOMODE_GUARD_SET=1; M_AUTOMODE_GUARD_SNAPSHOT="$a" ;;
            automode_guard.buzz_relay_url) M_AUTOMODE_GUARD_SET=1; M_AUTOMODE_GUARD_RELAY_URL="$a" ;;
            automode_guard.buzz_key_command) M_AUTOMODE_GUARD_SET=1; M_AUTOMODE_GUARD_KEY_COMMAND="$a" ;;
            automode_guard.buzz_channel) M_AUTOMODE_GUARD_SET=1; M_AUTOMODE_GUARD_CHANNEL="$a" ;;
            automode_guard.owner) M_AUTOMODE_GUARD_SET=1; M_AUTOMODE_GUARD_OWNER="$a" ;;
            automode_guard.ledger) M_AUTOMODE_GUARD_SET=1; M_AUTOMODE_GUARD_LEDGER="$a" ;;
            automode_guard.buzz_task_open_emoji) M_AUTOMODE_GUARD_SET=1; M_AUTOMODE_GUARD_TASK_EMOJI="$a" ;;
            automode_guard.buzz_task_open_emoji_url) M_AUTOMODE_GUARD_SET=1; M_AUTOMODE_GUARD_TASK_EMOJI_URL="$a" ;;
            "automode_guard.buzz_mentions#"|"automode_guard.read_paths#") M_AUTOMODE_GUARD_SET=1 ;;
            "automode_guard.buzz_mentions[]") M_AUTOMODE_GUARD_MENTIONS="${M_AUTOMODE_GUARD_MENTIONS}$a
" ;;
            "automode_guard.read_paths[]") M_AUTOMODE_GUARD_READ_PATHS="${M_AUTOMODE_GUARD_READ_PATHS}$a
" ;;
            memory_backup.enabled) M_MEMORY_BACKUP_SET=1; M_MEMORY_BACKUP_ENABLED="$a" ;;
            memory_backup.folder) M_MEMORY_BACKUP_SET=1; M_MEMORY_BACKUP_FOLDER="$a" ;;
            memory_backup.remote) M_MEMORY_BACKUP_SET=1; M_MEMORY_BACKUP_REMOTE="$a" ;;
            memory_backup.branch) M_MEMORY_BACKUP_SET=1; M_MEMORY_BACKUP_BRANCH="$a" ;;
            memory_backup.buzz_relay_url) M_MEMORY_BACKUP_SET=1; M_MEMORY_BACKUP_RELAY_URL="$a" ;;
            memory_backup.buzz_key_command) M_MEMORY_BACKUP_SET=1; M_MEMORY_BACKUP_KEY_COMMAND="$a" ;;
            memory_backup.buzz_channel) M_MEMORY_BACKUP_SET=1; M_MEMORY_BACKUP_CHANNEL="$a" ;;
            memory_backup.max_file_kb) M_MEMORY_BACKUP_SET=1; M_MEMORY_BACKUP_MAX_FILE_KB="$a" ;;
            memory_backup.max_removed_percent) M_MEMORY_BACKUP_SET=1; M_MEMORY_BACKUP_MAX_REMOVED="$a" ;;
            memory_backup.buzz_task_open_emoji) M_MEMORY_BACKUP_SET=1; M_MEMORY_BACKUP_TASK_EMOJI="$a" ;;
            memory_backup.buzz_task_open_emoji_url) M_MEMORY_BACKUP_SET=1; M_MEMORY_BACKUP_TASK_EMOJI_URL="$a" ;;
            "memory_backup.buzz_mentions#"|"memory_backup.read_paths#") M_MEMORY_BACKUP_SET=1 ;;
            "memory_backup.buzz_mentions[]") M_MEMORY_BACKUP_MENTIONS="${M_MEMORY_BACKUP_MENTIONS}$a
" ;;
            "memory_backup.read_paths[]") M_MEMORY_BACKUP_READ_PATHS="${M_MEMORY_BACKUP_READ_PATHS}$a
" ;;
        esac
    done <<EOF
$out
EOF
    if [ "$rc" -ne 0 ] && [ -z "$MANIFEST_ERRORS" ]; then
        MANIFEST_ERRORS="could not read $file"
    fi
    [ -n "$MANIFEST_ERRORS" ] && return 1
    manifest_check_values || return 1
    manifest_resolve_root
}

manifest_problem() { MANIFEST_ERRORS="${MANIFEST_ERRORS}$*
"; }

# github.host_config: a plain path under ~/, never one of git's own global
# config files (~/.gitconfig, ~/.config/git/config). "." and ".." segments and
# empty segments are refused, so no spelling can reach those files.
host_config_problem() {
    local p="$1" rest
    case "$p" in
        \~/?*) ;;
        *) manifest_problem "github.host_config must start with ~/"; return ;;
    esac
    rest="/${p#\~/}/"
    case "$rest" in
        *//*|*/./*|*/../*)
            manifest_problem "github.host_config must not contain . or .. or empty path segments"; return ;;
    esac
    # Lower-cased first: macOS file names ignore case, so ~/.GITCONFIG is ~/.gitconfig.
    case "$(lower "$p")" in
        \~/.gitconfig|\~/.config/git/config)
            manifest_problem "github.host_config must not be git's global config ($p); name a file it includes"; return ;;
    esac
    return 0
}

# The same rule on the expanded path, just before writing to it.
host_config_is_global() {
    local f
    f="$(lower "$1")"
    [ "$f" = "$(lower "$HOME/.gitconfig")" ] || [ "$f" = "$(lower "$HOME/.config/git/config")" ] \
        || [ "$f" = "$(lower "${XDG_CONFIG_HOME:-$HOME/.config}/git/config")" ]
}

# A root (or a v0 dir's parent): ~/<path> or /<path>, letters, digits and
# . _ - / only (it goes into a systemd unit and a hook command unquoted), no
# ".", ".." or empty segments, and never the home folder or a folder above it,
# so the layout's folders never land in HOME itself. Prints the problem.
root_problem_text() {
    local p="$1" rest e h
    local re='^(~/|/)[A-Za-z0-9._/-]+$'
    if ! [[ $p =~ $re ]]; then
        printf 'must start with ~/ or / and hold only letters, digits and . _ - /'; return
    fi
    case "$p" in \~/*) rest="/${p#\~/}/" ;; *) rest="${p}/" ;; esac
    case "$rest" in
        *//*|*/./*|*/../*) printf 'must not contain . or .. or empty path segments (or end in /)'; return ;;
    esac
    # Compared as real paths, so a link or a doubled / in HOME changes nothing.
    e="$(phys "$(expand_home "$p")")"
    h="$(phys "$HOME")"
    case "$h/" in
        "$e"/*) printf 'must be a folder below the home folder or elsewhere, not %s itself or above it' "$HOME"; return ;;
    esac
}

manifest_check_values() {
    local re_name='^[a-z0-9][a-z0-9-]*$'
    local re_login='^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\[bot\])?$'
    local re_repo='^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
    local re_email='^[^@ ]+@[^@ ]+\.[^@ ]+$'
    local re_cmd='^[A-Za-z0-9_./{}=-]+( +[A-Za-z0-9_./{}=-]+)*$'
    local r first rest t

    case "$M_SCHEMA" in
        "") manifest_problem "missing schema" ;;
        "$SCHEMA_V0"|"$SCHEMA_V1") ;;
        *) manifest_problem "schema must be \"$SCHEMA_V1\" (or the older \"$SCHEMA_V0\"), not \"$M_SCHEMA\"" ;;
    esac
    if [ -z "$M_NAME" ]; then manifest_problem "missing name"
    elif ! [[ $M_NAME =~ $re_name ]]; then manifest_problem "name must be lower-case letters, digits and dashes"
    else
        case " $LAYOUT_DIRS " in
            *" $M_NAME "*) manifest_problem "name must not be one of the layout's folders ($LAYOUT_DIRS)" ;;
        esac
    fi
    if [ "$M_SCHEMA" = "$SCHEMA_V1" ]; then
        if [ -n "$M_DIR" ]; then
            manifest_problem "dir is schema v0; v1 names root instead (the instance lives at <root>/<name>)"
        fi
        if [ -z "$M_ROOT" ]; then manifest_problem "missing root"
        else
            t="$(root_problem_text "$M_ROOT")"
            [ -z "$t" ] || manifest_problem "root $t"
        fi
    else
        if [ -n "$M_ROOT" ]; then manifest_problem "root needs schema \"$SCHEMA_V1\""; fi
        case "$M_DIR" in
            ""|\~/?*|/?*) ;;
            *) manifest_problem "dir must start with ~/ or /" ;;
        esac
    fi
    if [ -z "$M_GITHUB_LOGIN" ]; then manifest_problem "missing github.login"
    elif ! [[ $M_GITHUB_LOGIN =~ $re_login ]]; then manifest_problem "github.login is not a GitHub login"; fi
    if [ -n "$M_GITHUB_ALSO_LOGIN" ] && ! [[ $M_GITHUB_ALSO_LOGIN =~ $re_login ]]; then
        manifest_problem "github.also_login is not a GitHub login"
    fi
    if [ -n "$M_GITHUB_HOST_CONFIG" ]; then
        host_config_problem "$M_GITHUB_HOST_CONFIG"
    fi
    while IFS= read -r r; do
        [ -n "$r" ] || continue
        [[ $r =~ $re_repo ]] || manifest_problem "github.repos: \"$r\" is not owner/repo"
    done <<EOF
$M_GITHUB_REPOS
EOF
    if [ -z "$M_CLAUDE_EMAIL" ]; then manifest_problem "missing claude.email"
    elif ! [[ $M_CLAUDE_EMAIL =~ $re_email ]]; then manifest_problem "claude.email is not an email address"; fi
    if [ -z "$M_SETUP_COMMAND" ]; then
        manifest_problem "missing setup.command"
    elif ! [[ $M_SETUP_COMMAND =~ $re_cmd ]]; then
        manifest_problem "setup.command may hold only words of letters, digits and _ . / { } = - separated by spaces"
    else
        first="${M_SETUP_COMMAND%% *}"
        rest="${M_SETUP_COMMAND//\{profile\}/}"
        case "$first" in
            /*) manifest_problem "setup.command must start with a path inside the instance repo, not $first" ;;
        esac
        case "/$first/" in
            */../*) manifest_problem "setup.command must not leave the instance repo (..)" ;;
        esac
        case "$rest" in
            *"{"*|*"}"*) manifest_problem "setup.command: the only placeholder is {profile}" ;;
        esac
    fi
    memory_guard_problems
    automode_guard_problems
    memory_backup_problems
    [ -z "$MANIFEST_ERRORS" ]
}

# [memory_guard]: enabled is "true" or "false". term_percent and kill_percent
# come together or not at all: whole numbers, kill_percent below term_percent,
# term_percent at most 50 (a guard at more than half of memory would kill
# processes in normal use). Only digits pass, so nothing else can reach the
# earlyoom command line.
memory_guard_problems() {
    local re_pct='^[1-9][0-9]?$' t="$M_MEMORY_GUARD_TERM" k="$M_MEMORY_GUARD_KILL"
    case "$M_MEMORY_GUARD_ENABLED" in
        ""|true|false) ;;
        *) manifest_problem "memory_guard.enabled must be \"true\" or \"false\"" ;;
    esac
    [ -n "$t$k" ] || return 0
    if [ -z "$t" ] || [ -z "$k" ]; then
        manifest_problem "memory_guard: give term_percent and kill_percent together, or neither (the defaults are 15 and 8)"
        return 0
    fi
    if ! [[ $t =~ $re_pct ]] || ! [[ $k =~ $re_pct ]]; then
        manifest_problem "memory_guard: term_percent and kill_percent must be whole numbers from 1 to 99, like \"15\""
        return 0
    fi
    if [ "$t" -gt 50 ]; then
        manifest_problem "memory_guard.term_percent must be at most 50"
    fi
    if [ "$k" -ge "$t" ]; then
        manifest_problem "memory_guard.kill_percent must be below term_percent"
    fi
    return 0
}

# [automode_guard]: the auto-mode drift guard (install/automode-guard/). Syntax
# only: nothing here looks at the disk. Every hook reads the manifest through
# this check, so a missing snapshot file must not switch the other hooks off;
# the guard's install step and the guard itself check that the files are
# there. Every value goes into a systemd unit, so each is held to characters
# that systemd and sh pass on as they are (no quote, backslash, % or $).
#   enabled           "true" or "false"; left out, the section is on.
#   snapshot          the snapshot file: a path inside the instance repo.
#   buzz_relay_url    https:// or wss://, a host, an optional port and path.
#   buzz_key_command  the Buzz adapter's key command: plain words.
#   buzz_channel      the Buzz channel the alert goes to (a channel id).
#   buzz_mentions     public keys the alert mentions, 64 hex characters each.
#   read_paths        paths the key command needs inside the guard's sandbox:
#                     each ~/<path> or /<path>, never / itself.
#   owner             the owner's public key (64 hex): the one key whose
#                     replies the guard acts on. Left out, it reads none.
#   ledger            the signing ledger: ~/<path> or /<path>. Left out, the
#                     guard keeps its own in its state folder.
#   buzz_task_open_emoji, buzz_task_open_emoji_url
#                     when set, each alert is a task root: the open state goes
#                     on it once it is sent (task_emoji_problems).
# Once on, snapshot, buzz_relay_url, buzz_key_command and buzz_channel are
# required. enabled = "false" alone turns the guard off.
automode_guard_problems() {
    local re_rel='^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'
    local re_url='^(https|wss)://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$'
    local re_cmd='^[A-Za-z0-9_./~:=@+,-]+( +[A-Za-z0-9_./~:=@+,-]+)*$'
    local re_chan='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    local re_key='^[0-9a-f]{64}$'
    local re_path='^(~/|/)[A-Za-z0-9._/-]+$'
    local p rest
    [ "$M_AUTOMODE_GUARD_SET" = "1" ] || return 0
    case "$M_AUTOMODE_GUARD_ENABLED" in
        ""|true|false) ;;
        *) manifest_problem "automode_guard.enabled must be \"true\" or \"false\"" ;;
    esac
    [ "$M_AUTOMODE_GUARD_ENABLED" = "false" ] && return 0
    if [ -z "$M_AUTOMODE_GUARD_SNAPSHOT" ]; then
        manifest_problem "automode_guard: missing snapshot (the snapshot file, a path inside the instance repo)"
    elif ! [[ $M_AUTOMODE_GUARD_SNAPSHOT =~ $re_rel ]]; then
        manifest_problem "automode_guard.snapshot must be a path inside the instance repo: letters, digits and _ . - /, no leading /"
    else
        case "/$M_AUTOMODE_GUARD_SNAPSHOT/" in
            */./*|*/../*) manifest_problem "automode_guard.snapshot must not contain . or .. segments" ;;
        esac
    fi
    if [ -z "$M_AUTOMODE_GUARD_RELAY_URL" ]; then
        manifest_problem "automode_guard: missing buzz_relay_url"
    elif ! [[ $M_AUTOMODE_GUARD_RELAY_URL =~ $re_url ]]; then
        manifest_problem "automode_guard.buzz_relay_url must be https:// or wss://, a host, and an optional port and path"
    fi
    if [ -z "$M_AUTOMODE_GUARD_KEY_COMMAND" ]; then
        manifest_problem "automode_guard: missing buzz_key_command"
    elif ! [[ $M_AUTOMODE_GUARD_KEY_COMMAND =~ $re_cmd ]]; then
        manifest_problem "automode_guard.buzz_key_command may hold only words of letters, digits and _ . / ~ : = @ + , - separated by spaces"
    fi
    if [ -z "$M_AUTOMODE_GUARD_CHANNEL" ]; then
        manifest_problem "automode_guard: missing buzz_channel"
    elif ! [[ $M_AUTOMODE_GUARD_CHANNEL =~ $re_chan ]]; then
        manifest_problem "automode_guard.buzz_channel must be a channel id (lower-case hex, 8-4-4-4-12)"
    fi
    while IFS= read -r p; do
        [ -n "$p" ] || continue
        [[ $p =~ $re_key ]] || manifest_problem "automode_guard.buzz_mentions: each must be a public key of 64 lower-case hex characters"
    done <<EOF
$M_AUTOMODE_GUARD_MENTIONS
EOF
    if [ -n "$M_AUTOMODE_GUARD_OWNER" ] && ! [[ $M_AUTOMODE_GUARD_OWNER =~ $re_key ]]; then
        manifest_problem "automode_guard.owner must be a public key of 64 lower-case hex characters"
    fi
    if [ -n "$M_AUTOMODE_GUARD_LEDGER" ]; then
        if ! [[ $M_AUTOMODE_GUARD_LEDGER =~ $re_path ]]; then
            manifest_problem "automode_guard.ledger must start with ~/ or / and hold only letters, digits and . _ - /"
        else
            case "$M_AUTOMODE_GUARD_LEDGER" in \~/*) rest="/${M_AUTOMODE_GUARD_LEDGER#\~/}/" ;; *) rest="${M_AUTOMODE_GUARD_LEDGER}/" ;; esac
            case "$rest" in
                *//*|*/./*|*/../*) manifest_problem "automode_guard.ledger: no . or .. or empty segments, and no trailing /" ;;
            esac
        fi
    fi
    while IFS= read -r p; do
        [ -n "$p" ] || continue
        if ! [[ $p =~ $re_path ]]; then
            manifest_problem "automode_guard.read_paths: each must start with ~/ or / and hold only letters, digits and . _ - /"
            continue
        fi
        case "$p" in \~/*) rest="/${p#\~/}/" ;; *) rest="${p}/" ;; esac
        case "$rest" in
            *//*|*/./*|*/../*) manifest_problem "automode_guard.read_paths: no . or .. or empty segments, and no trailing / ($p)" ;;
        esac
    done <<EOF
$M_AUTOMODE_GUARD_READ_PATHS
EOF
    task_emoji_problems automode_guard "$M_AUTOMODE_GUARD_TASK_EMOJI" "$M_AUTOMODE_GUARD_TASK_EMOJI_URL"
    return 0
}

# task_emoji_problems SECTION EMOJI URL: buzz_task_open_emoji, the reaction
# that marks an alert open (a task root; the Buzz adapter's src/task.mjs), and
# its _url. The emoji is a custom emoji's name (lower-case letters, digits, _
# and -), which needs its image's https:// URL, or one plain emoji (no ASCII
# at all, at most 64 bytes), which takes none: never 🚨 (the emergency state)
# or ✅ (the done state's default). The same rule as the adapter's
# (src/task.mjs). Unset, alerts get no state.
task_emoji_problems() {
    local sec="$1" e="$2" u="$3"
    local re_name='^[a-z0-9_-]{1,64}$'
    local re_img='^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+$'
    if [ -z "$e" ]; then
        [ -z "$u" ] || manifest_problem "$sec.buzz_task_open_emoji_url is only for a custom buzz_task_open_emoji, which is not set"
        return 0
    fi
    if [[ $e =~ $re_name ]]; then
        if [ -z "$u" ]; then
            manifest_problem "$sec.buzz_task_open_emoji names a custom emoji: give its image as buzz_task_open_emoji_url (https://)"
        elif ! [[ $u =~ $re_img ]]; then
            manifest_problem "$sec.buzz_task_open_emoji_url must be an https:// URL with a host and a path"
        fi
    elif [ "$(printf '%s' "$e" | LC_ALL=C wc -c | tr -d ' ')" -gt 64 ] \
        || [ -n "$(printf '%s' "$e" | LC_ALL=C tr -d '\200-\377')" ] || [ "$e" = "🚨" ] || [ "$e" = "✅" ]; then
        manifest_problem "$sec.buzz_task_open_emoji must be a custom emoji's name (lower-case letters, digits, _ and -) or one plain emoji other than 🚨 and ✅"
    elif [ -n "$u" ]; then
        manifest_problem "$sec.buzz_task_open_emoji_url is only for a custom emoji; buzz_task_open_emoji is a plain one"
    fi
}

# [memory_backup]: the memory backup (install/memory-backup/). Syntax only, as
# for [automode_guard]: nothing here looks at the disk. Every value goes into
# a systemd unit or the backup's settings file, so each is held to characters
# that pass on as they are (no quote, backslash, space, % or $).
#   enabled           "true" or "false"; left out, the section is on.
#   folder            the memory folder: ~/<path> or /<path>.
#   remote            the instance repo's https:// URL, with no user or token
#                     in it (the push goes as the machine is).
#   branch            memory/<name>: always under memory/, so never main.
#   buzz_relay_url, buzz_key_command, buzz_channel, buzz_mentions, read_paths
#                     where alerts go, as for [automode_guard]: the first three
#                     together or none (then alerts are logged only).
#   max_file_kb       a file over this size is left out and reported (default
#                     "1024"): a whole number from 1 to 9999999.
#   max_removed_percent  a run that would remove more than this share of the
#                     notes is held (default "30"): a whole number, 1 to 100.
#   buzz_task_open_emoji, buzz_task_open_emoji_url
#                     as for [automode_guard]: each alert is a task root.
# Once on, folder, remote and branch are required.
memory_backup_problems() {
    local re_path='^(~/|/)[A-Za-z0-9._/-]+$'
    local re_remote='^https://[A-Za-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]+$'
    local re_branch='^memory/[a-z0-9][a-z0-9-]*$'
    local re_url='^(https|wss)://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$'
    local re_cmd='^[A-Za-z0-9_./~:=@+,-]+( +[A-Za-z0-9_./~:=@+,-]+)*$'
    local re_chan='^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    local re_key='^[0-9a-f]{64}$'
    local p rest n=0
    [ "$M_MEMORY_BACKUP_SET" = "1" ] || return 0
    case "$M_MEMORY_BACKUP_ENABLED" in
        ""|true|false) ;;
        *) manifest_problem "memory_backup.enabled must be \"true\" or \"false\"" ;;
    esac
    [ "$M_MEMORY_BACKUP_ENABLED" = "false" ] && return 0
    if [ -z "$M_MEMORY_BACKUP_FOLDER" ]; then
        manifest_problem "memory_backup: missing folder (the memory folder, ~/<path> or /<path>)"
    elif ! [[ $M_MEMORY_BACKUP_FOLDER =~ $re_path ]]; then
        manifest_problem "memory_backup.folder must start with ~/ or / and hold only letters, digits and . _ - /"
    else
        case "$M_MEMORY_BACKUP_FOLDER" in \~/*) rest="/${M_MEMORY_BACKUP_FOLDER#\~/}/" ;; *) rest="${M_MEMORY_BACKUP_FOLDER}/" ;; esac
        case "$rest" in
            *//*|*/./*|*/../*) manifest_problem "memory_backup.folder: no . or .. or empty segments, and no trailing /" ;;
        esac
    fi
    if [ -z "$M_MEMORY_BACKUP_REMOTE" ]; then
        manifest_problem "memory_backup: missing remote (the instance repo's https:// URL)"
    elif ! [[ $M_MEMORY_BACKUP_REMOTE =~ $re_remote ]]; then
        manifest_problem "memory_backup.remote must be an https:// URL with a host and a path, and no user or token in it"
    fi
    if [ -z "$M_MEMORY_BACKUP_BRANCH" ]; then
        manifest_problem "memory_backup: missing branch (memory/<name>)"
    elif ! [[ $M_MEMORY_BACKUP_BRANCH =~ $re_branch ]]; then
        manifest_problem "memory_backup.branch must be memory/<name> (lower-case letters, digits and dashes), never main"
    fi
    [ -n "$M_MEMORY_BACKUP_RELAY_URL" ] && n=$((n + 1))
    [ -n "$M_MEMORY_BACKUP_KEY_COMMAND" ] && n=$((n + 1))
    [ -n "$M_MEMORY_BACKUP_CHANNEL" ] && n=$((n + 1))
    if [ "$n" -ne 0 ] && [ "$n" -ne 3 ]; then
        manifest_problem "memory_backup: give buzz_relay_url, buzz_key_command and buzz_channel together, or none (alerts are then logged only)"
    fi
    if [ -n "$M_MEMORY_BACKUP_RELAY_URL" ] && ! [[ $M_MEMORY_BACKUP_RELAY_URL =~ $re_url ]]; then
        manifest_problem "memory_backup.buzz_relay_url must be https:// or wss://, a host, and an optional port and path"
    fi
    if [ -n "$M_MEMORY_BACKUP_KEY_COMMAND" ] && ! [[ $M_MEMORY_BACKUP_KEY_COMMAND =~ $re_cmd ]]; then
        manifest_problem "memory_backup.buzz_key_command may hold only words of letters, digits and _ . / ~ : = @ + , - separated by spaces"
    fi
    if [ -n "$M_MEMORY_BACKUP_CHANNEL" ] && ! [[ $M_MEMORY_BACKUP_CHANNEL =~ $re_chan ]]; then
        manifest_problem "memory_backup.buzz_channel must be a channel id (lower-case hex, 8-4-4-4-12)"
    fi
    if [ -n "$M_MEMORY_BACKUP_MAX_FILE_KB" ] && ! [[ $M_MEMORY_BACKUP_MAX_FILE_KB =~ ^[1-9][0-9]{0,6}$ ]]; then
        manifest_problem "memory_backup.max_file_kb must be a whole number from 1 to 9999999, like \"1024\""
    fi
    if [ -n "$M_MEMORY_BACKUP_MAX_REMOVED" ] && ! [[ $M_MEMORY_BACKUP_MAX_REMOVED =~ ^([1-9][0-9]?|100)$ ]]; then
        manifest_problem "memory_backup.max_removed_percent must be a whole number from 1 to 100, like \"30\""
    fi
    while IFS= read -r p; do
        [ -n "$p" ] || continue
        [[ $p =~ $re_key ]] || manifest_problem "memory_backup.buzz_mentions: each must be a public key of 64 lower-case hex characters"
    done <<EOF
$M_MEMORY_BACKUP_MENTIONS
EOF
    while IFS= read -r p; do
        [ -n "$p" ] || continue
        if ! [[ $p =~ $re_path ]]; then
            manifest_problem "memory_backup.read_paths: each must start with ~/ or / and hold only letters, digits and . _ - /"
            continue
        fi
        case "$p" in \~/*) rest="/${p#\~/}/" ;; *) rest="${p}/" ;; esac
        case "$rest" in
            *//*|*/./*|*/../*) manifest_problem "memory_backup.read_paths: no . or .. or empty segments, and no trailing / ($p)" ;;
        esac
    done <<EOF
$M_MEMORY_BACKUP_READ_PATHS
EOF
    task_emoji_problems memory_backup "$M_MEMORY_BACKUP_TASK_EMOJI" "$M_MEMORY_BACKUP_TASK_EMOJI_URL"
    return 0
}

# The snapshot is read as committed on the instance repo's main, never from
# the working tree: an agent working in the repo can edit a file there, but a
# rule only counts once it is on main. The installer (step 14), the guard and
# the session hook all read it this way.
#
# automode_git REPO ARGS...: git on REPO's own objects, for reading: no
# system or user config, no optional locks, no fsmonitor, and no fetch from
# a remote for an object a partial clone lacks (GIT_NO_LAZY_FETCH, git 2.44+).
automode_git() {
    local repo="$1"; shift
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_OPTIONAL_LOCKS=0 GIT_NO_LAZY_FETCH=1 \
        git --git-dir="$repo/.git" -c core.fsmonitor=false "$@"
}

# automode_snapshot_blob REPO REL: the object id of the snapshot REL as
# committed on REPO's main, on stdout; otherwise the reason on stdout and
# status 1. REPO is the instance repo's real path, with a .git folder of its
# own. The entry must be a plain file on main: a committed symlink, or a path
# through a committed folder symlink, is refused (git does not follow them).
automode_snapshot_blob() {
    local repo="$1" rel="$2" line tab
    tab="$(printf '\t')"
    case "$rel" in
        '' | /*) printf 'the snapshot path must be relative to the instance repo: %s' "$rel"; return 1 ;;
    esac
    if [ -L "$repo/.git" ] || [ ! -d "$repo/.git" ]; then
        printf 'the instance repo %s has no .git folder of its own (a worktree, or a symlink); the snapshot is read from main in the main checkout' "$repo"
        return 1
    fi
    # The full ref: a tag named main would outrank a bare "main".
    if ! line="$(automode_git "$repo" ls-tree refs/heads/main -- "$rel" 2>/dev/null)"; then
        printf 'could not read branch main in %s' "$repo"; return 1
    fi
    case "$line" in
        "100644 blob "*"$tab$rel" | "100755 blob "*"$tab$rel")
            line="${line#* blob }"; printf '%s' "${line%%"$tab"*}"; return 0 ;;
        "120000 "*) printf 'the snapshot %s is a symlink on main in %s; it must be a plain file' "$rel" "$repo"; return 1 ;;
        '') printf 'the snapshot %s is not on main in %s (commit it there; a path through a symlinked folder is not followed)' "$rel" "$repo"; return 1 ;;
        *) printf 'the snapshot %s is not a plain file on main in %s' "$rel" "$repo"; return 1 ;;
    esac
}

# The root, from a checked manifest. Schema v1 names it. A v0 manifest whose
# dir is ~/<root>/<name> (under the home folder, its last segment the name, and
# its parent a valid root) is read as v1 with that root: the automatic
# migration. Any other v0 manifest is a single-folder instance, with no root
# layout, exactly as before.
manifest_resolve_root() {
    local parent
    M_ROOT_DIR=""; M_ROOT_FROM=""
    if [ "$M_SCHEMA" = "$SCHEMA_V1" ]; then
        M_ROOT_DIR="$(expand_home "$M_ROOT")"; M_ROOT_FROM=root
        return 0
    fi
    case "$M_DIR" in \~/?*/?*) ;; *) return 0 ;; esac
    [ "${M_DIR##*/}" = "$M_NAME" ] || return 0
    parent="${M_DIR%/*}"
    [ -n "$parent" ] || return 0
    [ -z "$(root_problem_text "$parent")" ] || return 0
    M_ROOT="$parent"
    M_ROOT_DIR="$(expand_home "$parent")"; M_ROOT_FROM=dir
    return 0
}

# One line on how the manifest names the instance's place, for the summary.
manifest_layout_line() {
    case "$M_ROOT_FROM" in
        root) printf 'schema v1, root %s' "$M_ROOT" ;;
        dir)  printf 'schema v0, read as v1 with root %s (from dir %s)' "$M_ROOT" "$M_DIR" ;;
        *)    printf 'schema v0, a single folder (no root)' ;;
    esac
}

# ---------------------------------------------------------------- clone

instance_is_clone() {
    local url want
    url="$(git -C "$1" config --get remote.origin.url 2>/dev/null || true)"
    url="$(lower "${url%.git}")"
    want="$(lower "$INSTANCE")"
    case "$url" in
        "https://github.com/$want"|"git@github.com:$want"|"ssh://git@github.com/$want") return 0 ;;
        "https://$GP_GITHUB_INT_HOST/$want") return 0 ;;
    esac
    return 1
}

# Delete the instance clone, but only one this run made (and the root folder
# made for it, while it is still empty).
instance_remove_new_clone() {
    if [ "$INSTANCE_CREATED" = "1" ] && [ -n "$INSTANCE_DIR" ] && [ -d "$INSTANCE_DIR" ] \
        && [ "$INSTANCE_DIR" != "$HOME" ] && [ "$INSTANCE_DIR" != "/" ]; then
        rm -rf "$INSTANCE_DIR"
        say "deleted the new clone at $INSTANCE_DIR"
        INSTANCE_CREATED=0
        if [ -n "$ROOT_CREATED" ] && rmdir "$ROOT_CREATED" 2>/dev/null; then
            say "deleted the empty root folder $ROOT_CREATED"
        fi
    fi
}

# Read the manifest on main without a full clone: a shallow, blob-less clone
# into the private temp folder, then the one file. Sets PEEK_COMMIT and writes
# $GP_WORK/peek.toml.
instance_peek() {
    local url
    url="$(github_url "$INSTANCE")"
    make_work || return 1
    rm -rf "$GP_WORK/peek"
    if ! remote_git clone -q --depth 1 --filter=blob:none --no-checkout --branch main \
        "$url" "$GP_WORK/peek" 2>"$GP_WORK/git.err"; then
        sed 's/^/    /' "$GP_WORK/git.err" >&2
        return 1
    fi
    PEEK_COMMIT="$(git -C "$GP_WORK/peek" rev-parse HEAD)"
    if ! remote_git -C "$GP_WORK/peek" show "HEAD:$MANIFEST_REL" >"$GP_WORK/peek.toml" 2>"$GP_WORK/git.err"; then
        echo "install: $INSTANCE has no $MANIFEST_REL on main" >&2
        return 2
    fi
    return 0
}

# Where the instance goes, in order:
#   1. --instance-dir;
#   2. <root>/<name>, when it exists: the root layout always wins, also over an
#      old ~/<repo> that is a link to it;
#   3. an old single-folder clone at ~/<repo>, only while <root>/<name> does
#      not exist (install/layout/move moves it into the layout);
#   4. a fresh clone at <root>/<name>, or for a single-folder (v0) manifest at
#      its dir, else ~/<repo>.
# The root comes from the manifest: the one in ~/<repo> when that is already a
# clone, else the one on main, read before cloning.
step_instance() {
    local repo url d commit branch rc old
    heading "3. instance repo"
    repo="${INSTANCE#*/}"
    url="$(github_url "$INSTANCE")"
    old="$HOME/$repo"

    if [ -n "$INSTANCE_DIR_OPT" ]; then
        INSTANCE_DIR="$(expand_home "$INSTANCE_DIR_OPT")"
    elif [ -e "$old" ] && instance_is_clone "$old"; then
        INSTANCE_DIR="$old"
        if manifest_load "$old/$MANIFEST_REL" && [ -n "$M_ROOT_DIR" ]; then
            if [ -e "$M_ROOT_DIR/$M_NAME" ]; then
                INSTANCE_DIR="$M_ROOT_DIR/$M_NAME"
            elif [ ! -L "$old" ]; then
                INSTANCE_OLD_FOLDER=1
            fi
        fi
    elif [ "$GITHUB_MODE" = "token" ] && [ "$GH_AUTHED" != "1" ]; then
        # Dry run, not signed in: nothing can be read yet.
        INSTANCE_DIR="$old"
        record PLAN instance "would clone $INSTANCE (main) after the sign-in, into <root>/<name> from the manifest (or a v0 manifest's dir, else $old)"
        return 0
    elif [ "$GITHUB_MODE" = "deploykey" ] && [ "$DEPLOYKEY_READY" != "1" ]; then
        # Dry run, the deploy key not made or not added yet: nothing can be read.
        INSTANCE_DIR="$old"
        record PLAN instance "would clone $INSTANCE (main) once its deploy key is added, into <root>/<name> from the manifest (or a v0 manifest's dir, else $old)"
        return 0
    else
        instance_peek
        rc=$?
        if [ "$rc" -ne 0 ]; then
            record FAIL instance "could not read $MANIFEST_REL from $INSTANCE (main)"
            return 1
        fi
        if ! manifest_load "$GP_WORK/peek.toml"; then
            printf '%s' "$MANIFEST_ERRORS" | sed 's/^/    /' >&2
            record FAIL manifest "$MANIFEST_REL on main ($PEEK_COMMIT) is not valid"
            return 1
        fi
        if [ -n "$M_ROOT_DIR" ]; then d="$M_ROOT_DIR/$M_NAME"
        elif [ -n "$M_DIR" ]; then d="$(expand_home "$M_DIR")"
        else d="$old"; fi
        INSTANCE_DIR="$d"
    fi
    # The real path, with any link resolved: Claude Code keys trust and its
    # project folder by it.
    INSTANCE_DIR="$(phys "$INSTANCE_DIR")"

    if [ -e "$INSTANCE_DIR" ]; then
        if ! instance_is_clone "$INSTANCE_DIR"; then
            record FAIL instance "$INSTANCE_DIR exists and is not a clone of $INSTANCE; move it or pass --instance-dir"
            return 1
        fi
        INSTANCE_EXISTS=1
        commit="$(git -C "$INSTANCE_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
        branch="$(git -C "$INSTANCE_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
        say "$INSTANCE_DIR is already a clone (branch $branch, commit $commit); left exactly as it is"
        if [ "$INSTANCE_OLD_FOLDER" = "1" ]; then
            say "it is an old single-folder instance: $M_ROOT_DIR/$M_NAME does not exist yet, so the root layout is not built."
            say "To move it into the layout: install/layout/move --from $INSTANCE_DIR --root $M_ROOT (dry run first)."
            record OK instance "$INSTANCE_DIR already a clone, branch $branch, commit $commit; an old single folder, not moved"
        else
            record OK instance "$INSTANCE_DIR already a clone, branch $branch, commit $commit; not fetched, pulled or switched"
        fi
        MANIFEST_FILE="$INSTANCE_DIR/$MANIFEST_REL"
        return 0
    fi

    # A fresh clone: the manifest on main is read and checked first, so a bad
    # manifest never leaves a clone behind.
    if [ -z "$PEEK_COMMIT" ]; then
        if ! instance_peek; then
            record FAIL instance "could not read $MANIFEST_REL from $INSTANCE (main)"
            return 1
        fi
        if ! manifest_load "$GP_WORK/peek.toml"; then
            printf '%s' "$MANIFEST_ERRORS" | sed 's/^/    /' >&2
            record FAIL manifest "$MANIFEST_REL on main ($PEEK_COMMIT) is not valid"
            return 1
        fi
    fi
    if [ "$GITHUB_MODE" = "integration" ] && [ -z "$M_GITHUB_HOST_CONFIG" ]; then
        record FAIL instance "integration mode needs github.host_config in the manifest; nothing was cloned"
        return 1
    fi

    if [ "$DRY_RUN" = "1" ]; then
        show_cmd git clone --branch main "$url" "$INSTANCE_DIR"
        record PLAN instance "would clone $INSTANCE (main, now $PEEK_COMMIT) into $INSTANCE_DIR"
        MANIFEST_FILE="$GP_WORK/peek.toml"
        return 0
    fi

    say "cloning $INSTANCE (main) into $INSTANCE_DIR"
    if [ -n "$M_ROOT_DIR" ] && [ ! -e "$M_ROOT_DIR" ]; then ROOT_CREATED="$M_ROOT_DIR"; fi
    mkdir -p "$(dirname "$INSTANCE_DIR")"
    if ! remote_git clone -q --branch main "$url" "$INSTANCE_DIR"; then
        rm -rf "$INSTANCE_DIR"
        record FAIL instance "git clone of $INSTANCE failed"
        return 1
    fi
    INSTANCE_CREATED=1
    if [ "$GITHUB_MODE" = "integration" ]; then
        # The clone came straight from the integration host. Its origin is the
        # github.com address; the url.insteadOf line written after the account
        # check routes that address back through the integration.
        git -C "$INSTANCE_DIR" remote set-url origin "https://github.com/$INSTANCE.git"
    fi
    commit="$(git -C "$INSTANCE_DIR" rev-parse HEAD)"
    say "cloned at main, commit $commit"
    record DONE instance "cloned $INSTANCE into $INSTANCE_DIR at main, commit $commit"
    MANIFEST_FILE="$INSTANCE_DIR/$MANIFEST_REL"
    return 0
}

# Step 3 on an update (--update): the instance's home that is already on this
# machine, read with no network and never cloned: --instance-dir, else
# ~/<repo> (a link to <root>/<name>, or an old single folder). An update moves
# GHOST Protocol, not the instance, so the home is left exactly as it is.
step_instance_update() {
    local d=""
    if [ -n "$INSTANCE_DIR_OPT" ]; then
        d="$(expand_home "$INSTANCE_DIR_OPT")"
    elif [ -e "$HOME/${INSTANCE#*/}" ]; then
        d="$HOME/${INSTANCE#*/}"
    fi
    if [ -z "$d" ] || [ ! -e "$d" ] || ! instance_is_clone "$d"; then
        heading "3. instance repo"
        record FAIL instance "an update needs the instance's home on this machine, a clone of $INSTANCE: pass --instance-dir <root>/<name> (an update never clones)"
        return 1
    fi
    step_instance
}

step_manifest() {
    heading "4. manifest"
    if [ -z "$MANIFEST_FILE" ]; then
        record PLAN manifest "would read and check $MANIFEST_REL after the clone"
        return 0
    fi
    if ! manifest_load "$MANIFEST_FILE"; then
        printf '%s' "$MANIFEST_ERRORS" | sed 's/^/    /' >&2
        record FAIL manifest "$MANIFEST_REL is not valid (see above)"
        instance_remove_new_clone
        return 1
    fi
    say "instance $M_NAME, $(manifest_layout_line)"
    case "$M_ROOT_FROM" in
        dir)
            say "note: schema v0 is read as v1 for where the home is. To build the root layout"
            say "  too (its folders and the worktree hook), write schema = \"$SCHEMA_V1\" and"
            say "  root = \"$M_ROOT\" in the manifest, and drop dir." ;;
        "")
            if [ "$M_SCHEMA" = "$SCHEMA_V0" ]; then
                say "note: a single-folder instance (schema v0, ${M_DIR:-no dir}). For the root layout"
                say "  (docs/layout.md), move it with install/layout/move, then write schema v1 with a root."
            fi ;;
    esac
    record OK manifest "instance $M_NAME, $(manifest_layout_line)"
    return 0
}

# ---------------------------------------------------------------- setup hook

# The setup command as words, with {profile} filled in. No shell is involved:
# the manifest check allows only plain words.
setup_words() {
    local w out=""
    for w in $M_SETUP_COMMAND; do
        out="$out ${w//\{profile\}/$PROFILE}"
    done
    printf '%s' "${out# }"
}

step_setup() {
    local words first exe rc
    heading "6. setup hook"
    if [ -z "$M_SETUP_COMMAND" ]; then
        record PLAN setup "would run the instance's setup hook (known after the manifest is read)"
        return 0
    fi
    words="$(setup_words)"
    [ "$DRY_RUN" = "1" ] && words="$words --dry-run"
    first="${words%% *}"
    exe="$INSTANCE_DIR/$first"
    if [ "$DRY_RUN" = "1" ] && [ "$INSTANCE_EXISTS" != "1" ]; then
        say "would run, from $INSTANCE_DIR: $words"
        record PLAN setup "would run: $words"
        return 0
    fi
    if [ ! -f "$exe" ] || [ ! -x "$exe" ]; then
        record FAIL setup "$first is not an executable file in $INSTANCE_DIR"
        return 1
    fi
    say "running, from $INSTANCE_DIR: $words"
    # shellcheck disable=SC2086  # plain words, checked by the manifest check
    (cd "$INSTANCE_DIR" && "$exe" ${words#"$first"})
    rc=$?
    if [ "$rc" -ne 0 ]; then
        record FAIL setup "$words exited with $rc"
        return 1
    fi
    if [ "$DRY_RUN" = "1" ]; then
        record OK setup "ran $words"
    else
        record DONE setup "ran $words"
    fi
    return 0
}
