# shellcheck shell=bash
# keyservice.sh: an instance's key service, set up by install/keyservice/setup
# (which says how to run it). The relay private key lives with a separate OS
# user, the key's user, and the instance's own user (the one that runs Claude
# Code, its tools and subagents) can never read it: not the key, not its file,
# and not the key processes' environment or memory. A mention still gets a
# reply through the channel and the Buzz tools, which reach the key's side
# through two Unix sockets (adapters/buzz/README.md, "Key service").
#
# Three users on the machine:
#   the admin        runs this (with sudo); never runs Claude Code here
#   the agent user   runs the instance (Claude Code); no root, no way to it
#   the key's user   gp-key-<name>, a system user with no home and no shell,
#                    made here; runs the key service's units
#
# What it installs, for instance <name> at GHOST Protocol commit <commit>:
#   /opt/ghost-protocol/<commit>/          root-owned code the key units run:
#       adapters/buzz/                       the adapter at that commit (from
#                                            git, never a working tree), with
#                                            node_modules from its lockfile
#       buzz-mcp/buzz-mcp.mjs                the buzz-mcp build of its pin
#       bin/node                             a copy of node, unless the node
#                                            given is root-owned already
#       install/keyservice/outbox-copy       the copy step
#   /etc/ghost-protocol/<name>/            root-owned, 0755:
#       buzz-key        0400  the key (root alone reads it; systemd hands the
#                             open file to the key's units: OpenFile=)
#       buzz.env        0644  the Buzz settings (relay, channels, people)
#       auth-tag.json   0644  the owner's NIP-OA tag, when there is one
#       commit          0644  the commit the units run; previous-commit, the
#                             one before the last update (for --rollback)
#     and, for an instance with a GitHub App key (the GitHub App slot, below):
#       github-app.pem  0400  the App's private key (root alone reads it;
#                             systemd hands the open file to the GitHub unit)
#       github.conf     0644  the App's client ID and the allowlist: the repos
#                             it may review, each with its installation; the
#                             reviewer's own bot identities and whether COMMENT
#                             is allowed (its limits)
#       public-text.json 0644 the public-text rules a review's body must pass in
#                             a repo that is not private
#   /srv/ghost-protocol/<name>/            root, 0711:
#       outbox/   <agent>:<key's group>  2770  the session puts files to send here
#       files/    <key's user>:<agent's group> 2750  buzz-mcp's BUZZ_MCP_ROOT
#       media/    <key's user>:<agent's group> 2750  where media_get saves
#   /etc/systemd/system/gp-key-<name>-*    the units, from install/service/key-*:
#       channel.socket, channel@.service, buzz-mcp.socket, buzz-mcp@.service,
#       outbox.path, outbox.service; and with the GitHub App slot,
#       github.socket and github@.service
#   /var/lib/ghost-protocol-key/<name>/    the key's user's state (systemd's
#                                          StateDirectory=): the channel's
#                                          cursor, log and lock
#   /run/ghost-protocol-key/<name>/        the sockets (systemd makes it)
#
# It refuses, before changing anything, when (each check's line says which):
#   - this is not Linux with systemd 253 or later (OpenFile= needs it);
#   - fs.protected_symlinks or fs.protected_hardlinks is not 1;
#   - the agent user is root, is the user running this, or can become root:
#     a member of root, sudo, wheel, admin, docker, lxd, lxc, incus-admin,
#     incus, microk8s, disk or libvirt (adm and systemd-journal are fine: they
#     read logs), sudo with no password, any sudo at all unless --agent-sudo
#     password, or write access to a container engine's socket.
#     --accept-root-equivalent-agent turns these into warnings: then the key is
#     out of every casual path, but anything run as root still reaches it.
#     --agent-sudo password is root-equivalent too, and always says so: it
#     needs timestamp_timeout=0 for the agent user (no cached sudo ticket), and
#     its password must never be typed in any session of the agent user;
#   - the instance's own unit (<name>.service, with its drop-ins) loads a
#     credential named buzz* or nostr* (any case): systemd puts an instance's
#     credentials in /run/credentials/<name>.service/, which the agent user
#     reads;
#   - the agent user's own group holds another user (it is the sockets' group);
#   - the key's user exists but is not a system user with no shell, or shares
#     a group with the agent user;
#   - the auto-mode guard is installed for the instance: its send runs the key
#     command as the agent user, a way to the key (its key-side send comes in
#     a later change);
#   - this checkout borrows objects from another store (git alternates), or
#     the environment points git elsewhere. The commit is fetched from it into
#     a fresh repository in this run's work folder, which checks every object
#     against its hash, and the code comes from that copy;
#   - the code it copies (this checkout, node, the buzz-mcp build, the
#     settings file, the tag) could be changed by the agent user, or is
#     reached through a link in a folder the agent user can change. Each of
#     these files is checked, then copied at once into this run's private work
#     folder (opened without following a link, checked and copied from the
#     open descriptor), and only that copy is used afterwards, so nothing can
#     be swapped between the check and the use;
#   - there is no sender allowlist (BUZZ_ALLOWED_PUBKEYS or
#     BUZZ_ALLOWLIST_FILE), unless --no-sender-allowlist says so on purpose;
#   - the allowlist file (BUZZ_ALLOWLIST_FILE), which decides who can instruct
#     the agent, is missing, reached through a link, in the key service's
#     shared or state folders, or not root's alone (the file and every folder
#     above it owned by root and writable by no group or others): it belongs
#     where only root writes, such as /etc/ghost-protocol/<name>/;
#   - the settings are missing or malformed.
# And after writing: if the agent user, or the key's user, can read the key
# file, or the agent user can write the code, the settings, the tag or the
# allowlist, or any installed file or folder (and the folders above them) is
# not root's alone, or systemd loads a unit from another file or with a
# drop-in that changes more than its limits, timeouts and logging (who runs
# it, what it runs or is handed, what it can reach, where it listens), it
# stops with a FAIL. The commit is recorded only after that check passes, and
# every run that passes leaves the listeners enabled. Then, with the
# listeners on, it makes one real connection to each socket as the agent
# user, which must be answered (an MCP initialize: launch.mjs probe); one
# that is not is a FAIL too, and nothing is reported as installed.
#
# The GitHub App slot (optional; a reviewer's instance has it): a second
# key, a GitHub App's private key, with one fixed action on its own socket,
# github.sock (adapters/buzz/src/github-review.mjs): review a pull request in
# a repo on the allowlist, pinned to its head commit. The key, a JWT or a
# token never reach the agent user, and the App does nothing else through
# it. Its unit runs as a user of its own, gp-gh-<name> (a system user
# with no home and no shell, alone in its own group, made here; no instance
# name gives a key's user that name, gp-key-<name>, so no instance's key
# processes can run as another's GitHub user): never the
# key's user, whose buzz-mcp, channel and copy step take what the agent and
# the relay send, and a process of the same user could read the GitHub
# unit's memory while it holds the key (/proc/<pid>/mem; ProtectProc= hides
# only other users' processes). --github-app-key-from-stdin writes the key (a PEM RSA key of 2048 bits
# or more, checked and written by the root-owned copy's code, as root; never
# printed: only its fingerprint, as GitHub shows it), never over one that is
# there unless --replace-github-app-key says so; --github-settings gives the
# client ID and the allowlist. The slot is on while the key or its settings
# are there. Its units are checked like the others, the key and the settings
# like buzz-key and buzz.env, and the last check asks the socket, as the
# agent user, for the key's fingerprint (no network), then GitHub for the
# App (GET /app with a JWT, made on the key's side) unless
# --skip-github-check. Adding the slot to an instance that runs restarts only
# the GitHub socket, never the session. It refuses, before changing anything:
#   - settings that are not GITHUB_APP_CLIENT_ID (Iv...) and
#     GITHUB_REVIEW_REPOS (<installation id>:<owner>/<repo>, comma-separated,
#     each repo once), or none the first time;
#   - a key given when one is there (without --replace-github-app-key), none
#     to replace, or no key while the slot is on;
#   - a commit with no GitHub review code (a rollback past the slot's start);
#   - a GitHub App key user that is there but was not made by this setup for
#     this role and this instance (its comment says which), or is not a
#     system user with no shell alone in its own group, or shares a group
#     with the agent user or the key's user.
# The key's user, when it is there, must carry this setup's comment for this
# instance too: a user made for another role or instance is never taken.
#
# The git sign-in (on for every commit that has adapters/buzz/src/git-auth.mjs):
# a socket of its own, git.sock, served as the key's user like buzz-mcp, with
# one fixed action and no network: one NIP-98 sign-in for git over HTTP to one
# repository on the instance's own relay (BUZZ_RELAY_URL). The agent user's git
# reaches it through git-credential.mjs, a credential helper with no key that
# runs from the root-owned copy; setup names it in the agent user's global git
# settings for the relay's address only (an empty helper first, so no other
# helper answers for that address, and useHttpPath), and changes nothing else
# there. The last check asks the socket, as the agent user, for its key's
# public key, which must be the instance's. A rollback to a commit without it
# takes its units away; the git settings stay, and git then says it cannot
# reach the key service.
#
# Sourced by install/keyservice/setup only.

KS_TEMPLATES="$GP_DIR/install/service"
KS_RE_NAME='^[a-z0-9][a-z0-9-]*$'
KS_RE_USER='^[a-z_][a-z0-9_-]*$'
KS_RE_PATH='^/[A-Za-z0-9._/-]+$'
KS_RE_COMMIT='^[0-9a-f]{40}$'
KS_RE_HEX64='^[0-9a-f]{64}$'
KS_RE_PUBKEY='([0-9a-f]{64}|npub1[02-9ac-hj-np-z]{58})'
# Container engines' sockets: write access to one is root.
KS_ENGINE_SOCKETS="/var/run/docker.sock /run/docker.sock /run/containerd/containerd.sock /run/podman/podman.sock /var/snap/lxd/common/lxd/unix.socket /var/lib/lxd/unix.socket /var/lib/incus/unix.socket"
KS_MIN_SYSTEMD=253
KS_MIN_NODE=22
# Settings buzz.env may hold, in the order it is written. The units set the
# rest (the state folder, buzz-mcp's path and root, the lock).
KS_SETTING_KEYS="BUZZ_RELAY_URL BUZZ_CHANNELS BUZZ_CHANNEL BUZZ_WATCH_PUBKEY BUZZ_DM_MESSAGES BUZZ_TRUSTED_PUBKEYS BUZZ_ALLOWED_PUBKEYS BUZZ_ALLOWLIST_FILE BUZZ_CATCHUP_MAX_AGE BUZZ_TASK_ROOTS BUZZ_TASK_OPEN_EMOJI BUZZ_TASK_OPEN_EMOJI_URL BUZZ_TASK_DONE_EMOJI BUZZ_TASK_DONE_EMOJI_URL"

KS_NAME=""; KS_AGENT=""; KS_AGENT_UID=""; KS_AGENT_GROUP=""; KS_AGENT_GIDS=""
KS_KEY_USER=""; KS_KEY_EXISTS=0; KS_ME=""
KS_ETC=""; KS_UNITDIR=""; KS_OPT=""; KS_SRV=""; KS_RUN=""; KS_STATE=""; KS_PROCSYS=""; KS_SYSROOT=""; KS_LOCKDIR=""
KS_LOCK_FD=""
KS_COMMIT=""; KS_CUR=""; KS_PREV=""
KS_NODE_SRC=""; KS_NODE=""; KS_NODE_COPY=0
KS_BUZZ_MCP_SRC=""; KS_PIN=""
KS_ENV_FILE=""; KS_TAG_FILE=""; KS_ALLOWLIST=""
KS_PROBLEMS=""; KS_ROOTEQ=""; KS_SUDO_WARN=""; KS_NO_ALLOWLIST_USED=0
KS_SRC_GIT=""; KS_REUSE=0
# Root, for ks_root_only: uid 0, up to /. (A test stands in for root with its
# own uid, up to its stand-ins for /etc, /opt, /srv and /var/lib: ks_paths.)
KS_ROOT_UID=0; KS_ROOT_TOPS=""
KS_STAGE=""; KS_UNITS_WORK=""; KS_CHANGED=0; KS_PUBKEY=""; KS_WHY=""; KS_ANSWERED=""
# The GitHub App slot: on (1) while its key or settings are there, or given.
KS_GH=0; KS_GH_KEY_MODE=""; KS_GH_REPLACE=0; KS_GH_SETTINGS_OPT=""; KS_GH_LINES=""; KS_GH_SKIP_CHECK=0
KS_GH_RULES_OPT=""; KS_GH_RULES_COPY=""
# The reviewer's own identities are an App's bot only (as github-review.mjs's
# parseConfig has it): a person's address, above all the builders' shared
# noreply author, can never be written down as the reviewer's own.
KS_RE_OWN_LOGIN='^[A-Za-z0-9][A-Za-z0-9-]{0,38}\[bot\]$'
KS_RE_OWN_EMAIL='^[0-9]{1,12}\+[A-Za-z0-9][A-Za-z0-9-]{0,38}\[bot\]@users\.noreply\.github\.com$'
KS_GH_FP=""; KS_GH_FP_PREV=""; KS_GH_CHANGED=0; KS_GH_ANSWERED=""; KS_GH_USER=""; KS_GH_EXISTS=0
KS_GH_CODE="adapters/buzz/src/github-review.mjs"
# The git sign-in: on (1) when the commit has its code (ks_git_state).
KS_GIT=0; KS_GIT_CHANGED=0; KS_GIT_ORIGIN=""; KS_AGENT_HOME=""
KS_GIT_CODE="adapters/buzz/src/git-auth.mjs"
KS_GIT_HELPER="adapters/buzz/src/git-credential.mjs"
KS_RE_FP='^SHA256:[A-Za-z0-9+/]{43}=$'

ks_problem() { KS_PROBLEMS="${KS_PROBLEMS}$*
"; }
# A root-equivalence finding: a problem, or a warning with --accept-root-equivalent-agent.
ks_rooteq() {
    if [ "${KS_ACCEPT_ROOT:-0}" = 1 ]; then KS_ROOTEQ="${KS_ROOTEQ}$*
"; else ks_problem "$*"; fi
}
# One root command, never reading this script's stdin (that is the key's, with --key-from-stdin).
ks_root() { as_root "$@" </dev/null; }

# The unit names, from the template names (key-channel.socket -> gp-key-<name>-channel.socket).
KS_TEMPLATE_FILES="key-channel.socket key-channel@.service key-buzz-mcp.socket key-buzz-mcp@.service key-outbox.path key-outbox.service"
KS_GH_TEMPLATE_FILES="key-github.socket key-github@.service"
KS_GIT_TEMPLATE_FILES="key-git.socket key-git@.service"
ks_templates() {
    printf '%s' "$KS_TEMPLATE_FILES"
    [ "$KS_GIT" = 0 ] || printf ' %s' "$KS_GIT_TEMPLATE_FILES"
    [ "$KS_GH" = 0 ] || printf ' %s' "$KS_GH_TEMPLATE_FILES"
}
ks_unit_name() { printf 'gp-key-%s-%s' "$KS_NAME" "${1#key-}"; }
ks_listeners() {
    printf '%s ' "$(ks_unit_name key-channel.socket)" "$(ks_unit_name key-buzz-mcp.socket)" "$(ks_unit_name key-outbox.path)"
    [ "$KS_GIT" = 0 ] || printf '%s ' "$(ks_unit_name key-git.socket)"
    [ "$KS_GH" = 0 ] || printf '%s ' "$(ks_unit_name key-github.socket)"
}

# ---------------------------------------------------------------- paths

# The real paths, or the test suite's own (GP_ETC, GP_OPT, GP_SRV, GP_RUN,
# GP_VARLIB, GP_PROC_SYS, honoured only when GP_TEST=1). A test without them
# gets no paths, so nothing is ever written outside its sandbox.
ks_paths() {
    local etc=/etc opt=/opt srv=/srv run=/run var=/var/lib procsys=/proc/sys sysroot=""
    if [ "${GP_TEST:-}" = "1" ]; then
        etc="${GP_ETC:-}"; opt="${GP_OPT:-}"; srv="${GP_SRV:-}"
        run="${GP_RUN:-${GP_ETC:-}/run}"; var="${GP_VARLIB:-${GP_ETC:-}/var-lib}"
        procsys="${GP_PROC_SYS:-${GP_ETC:-}/proc-sys}"; sysroot="${GP_ETC:-}/rootfs"
        [ -n "$etc" ] && [ -n "$opt" ] && [ -n "$srv" ] || return 1
        # Never the real folders: test mode makes this user stand in for root.
        local v real
        for v in "$etc:/etc" "$opt:/opt" "$srv:/srv" "$run:/run" "$var:/var/lib" "$procsys:/proc/sys"; do
            real="${v##*:}"; v="${v%:*}"
            if [ "$(readlink -m -- "$v" 2>/dev/null || printf '%s' "$v")" = "$real" ]; then
                echo "setup: TEST MODE (GP_TEST=1) with the real $real: refused (test mode makes this user stand in for root)" >&2
                return 2
            fi
        done
        # The test's own user stands in for root (its sudo runs commands as
        # that user), and its folders for /etc, /opt, /srv and /var/lib.
        KS_ROOT_UID="$(id -u)"; KS_ROOT_TOPS="$etc $opt $srv $var $run"
        echo "setup: TEST MODE (GP_TEST=1): the key service uses $etc, $opt, $srv, $run and $var" >&2
    fi
    KS_ETC="$etc/ghost-protocol/$KS_NAME"
    KS_UNITDIR="$etc/systemd/system"
    KS_OPT="$opt/ghost-protocol"
    KS_SRV="$srv/ghost-protocol/$KS_NAME"
    KS_RUN="$run/ghost-protocol-key/$KS_NAME"
    KS_LOCKDIR="$run/ghost-protocol-setup"
    KS_STATE="$var/ghost-protocol-key/$KS_NAME"
    KS_PROCSYS="$procsys"
    KS_SYSROOT="$sysroot"
    ks_read_commits
    return 0
}
# The commit the instance's key service runs, and the one before it.
ks_read_commits() {
    KS_CUR=""; KS_PREV=""
    [ -f "$KS_ETC/commit" ] && KS_CUR="$(tr -d '[:space:]' <"$KS_ETC/commit")"
    [ -f "$KS_ETC/previous-commit" ] && KS_PREV="$(tr -d '[:space:]' <"$KS_ETC/previous-commit")"
    [[ ${KS_CUR:-x} =~ $KS_RE_COMMIT ]] || KS_CUR=""
    [[ ${KS_PREV:-x} =~ $KS_RE_COMMIT ]] || KS_PREV=""
    return 0
}
# One run at a time, for every instance: two runs would remove each other's
# copies (ks_prune) or put the same one in place at once. The lock is taken by
# root, on a 0600 file in a 0700 folder of root's (/run/ghost-protocol-setup):
# no other user can open it, so none can hold it to stop the setup (a lock
# file others can read, they could hold for ever). Root's flock holds it for
# as long as this run lives, and lets go when it ends (ks_unlock), or within
# a fifth of a second of it dying. A lock file there that is not root's 0600
# (not one this setup made) is replaced, never used. With the lock taken, the
# instance's commits are read again: a run that went first since the checks
# stops this one.
ks_lock() {
    local d="$KS_LOCKDIR" f="$KS_LOCKDIR/setup.lock" cur="$KS_CUR" prev="$KS_PREV" st line="" p
    # Checked before anything is written there: the folder is no link, and it
    # (when there) and the deepest folder above it that is there are root's
    # alone. (In a test, a stand-in top folder not made yet is fine.)
    p="${d%/*}"
    while [ ! -e "$p" ] && [ ! -L "$p" ]; do
        case " $KS_ROOT_TOPS " in *" $p "*) p=""; break ;; esac
        p="$(dirname -- "$p")"
    done
    if [ -L "$d" ] || { [ -n "$p" ] && ! ks_root_only "$p"; } || { [ -e "$d" ] && ! ks_root_only "$d"; }; then
        KS_WHY="$d, or a folder above it, is not root's alone (or is a link)"; return 1
    fi
    { ks_root install -d -m 0700 "$d" && ks_root chmod 0700 "$d"; } || { KS_WHY="could not make $d"; return 1; }
    if [ -L "$d" ] || ! ks_root_only "$d"; then KS_WHY="$d, or a folder above it, is not root's alone"; return 1; fi
    st="$(ks_root stat -c '%u %a %F' -- "$f" 2>/dev/null)"
    if [ -n "$st" ] && [ "$st" != "$KS_ROOT_UID 600 regular empty file" ]; then
        ks_root rm -f -- "$f" || { KS_WHY="could not replace the lock file $f ($st)"; return 1; }
        st=""
    fi
    if [ -z "$st" ]; then ks_root install -m 0600 /dev/null "$f" || { KS_WHY="could not make the lock file $f"; return 1; }; fi
    # shellcheck disable=SC2016  # $1 and $2 are the inner sh's: this run's pid, and its release file
    exec {KS_LOCK_FD}< <(as_root flock -n -o "$f" sh -c 'echo held; exec >/dev/null 2>&1
        while kill -0 "$1" && [ ! -e "$2" ]; do sleep 0.2; done' sh "$$" "$GP_WORK/unlock" </dev/null 2>/dev/null)
    read -r -t 60 line <&"$KS_LOCK_FD"
    if [ "$line" != held ]; then
        exec {KS_LOCK_FD}<&-; KS_LOCK_FD=""
        KS_WHY="could not take the lock $f: another run of the setup holds it. Let it finish, then run this again"
        return 1
    fi
    trap 'ks_unlock; cleanup_work' EXIT
    ks_read_commits
    if [ "$KS_CUR" != "$cur" ] || [ "$KS_PREV" != "$prev" ]; then
        KS_WHY="another run changed instance $KS_NAME's key service since the checks (it runs ${KS_CUR:-nothing} now): run this again"
        return 1
    fi
}
# Lets the lock go, and waits until root's flock has (its pipe ends).
ks_unlock() {
    [ -n "$KS_LOCK_FD" ] || return 0
    [ -n "$GP_WORK" ] && [ -d "$GP_WORK" ] && : >"$GP_WORK/unlock"
    read -r -t 10 _ <&"$KS_LOCK_FD"
    exec {KS_LOCK_FD}<&-; KS_LOCK_FD=""
}

# ---------------------------------------------------------------- users

# A user's passwd line, or nothing.
ks_passwd() { getent passwd "$1" 2>/dev/null | head -n 1; }
# The names of every group a user is in, as the system resolves them for a
# login (id -Gn, through NSS): a directory service's groups too, which
# getent group need not list.
ks_groups_of() { id -Gn -- "$1" 2>/dev/null; }
# The users other than <user> whose primary group is <gid>, or who are
# listed in the group <gid>.
ks_group_others() {   # gid user
    {
        getent passwd 2>/dev/null | awk -F: -v g="$1" -v u="$2" '$4 == g && $1 != u { print $1 }'
        getent group 2>/dev/null | awk -F: -v g="$1" -v u="$2" '
            $3 == g { n = split($4, m, ","); for (i = 1; i <= n; i++) if (m[i] != "" && m[i] != u) print m[i] }'
    } | sort -u | tr '\n' ' ' | sed 's/ $//'
}

ks_check_agent() {
    local line uid gid g groups others
    KS_ME="$(id -un)"
    line="$(ks_passwd "$KS_AGENT")"
    if [ -z "$line" ]; then ks_problem "the agent user $KS_AGENT does not exist (make it first: it runs the instance's Claude Code)"; return; fi
    uid="$(printf '%s' "$line" | cut -d: -f3)"; gid="$(printf '%s' "$line" | cut -d: -f4)"
    KS_AGENT_UID="$uid"
    KS_AGENT_HOME="$(printf '%s' "$line" | cut -d: -f6)"
    KS_AGENT_GROUP="$(getent group "$gid" 2>/dev/null | cut -d: -f1)"
    if [ "$uid" = 0 ]; then ks_problem "the agent user $KS_AGENT is root"; return; fi
    if [ "$KS_AGENT" = "$KS_ME" ]; then
        ks_problem "the agent user $KS_AGENT is the user running this; run it as the admin user, never as the instance's own user"
    fi
    if [ "$KS_AGENT" = "$KS_KEY_USER" ]; then ks_problem "the agent user cannot be the key's user ($KS_KEY_USER)"; fi
    if [ "$KS_AGENT" = "$KS_GH_USER" ]; then ks_problem "the agent user cannot be the GitHub App key's user ($KS_GH_USER)"; fi
    if ! [[ $KS_AGENT_GROUP =~ $KS_RE_USER ]]; then
        ks_problem "the agent user's group (gid $gid) has no plain name; the sockets' group must be a name"
        return
    fi
    groups="$(ks_groups_of "$KS_AGENT")"
    KS_AGENT_GIDS="$(id -G -- "$KS_AGENT" 2>/dev/null)"
    if [ -z "$groups" ] || [ -z "$KS_AGENT_GIDS" ]; then
        ks_problem "could not list the groups of the agent user $KS_AGENT (id -Gn $KS_AGENT)"; return
    fi
    others="$(ks_group_others "$gid" "$KS_AGENT")"
    if [ -n "$others" ]; then
        ks_problem "the agent user's group $KS_AGENT_GROUP also holds $others; the sockets' group must hold the agent user alone"
    fi
    ks_check_agent_root "$groups"
}

# >>> root-equivalence checks: whether the agent user can become root (pins.test.sh allows the word sudo here; nothing here runs sudo itself)
# Groups that make a user root-equivalent: sudo and its siblings, the
# container engines (a container can mount the host), raw disks, and staff
# (Debian's: it writes /usr/local, which is on root's PATH).
KS_REFUSED_GROUPS="root sudo wheel admin docker lxd lxc incus-admin incus microk8s disk libvirt staff"
# The groups that grant sudo itself (with a password, under --agent-sudo password).
KS_SUDO_GROUPS="sudo wheel admin"
ks_check_agent_root() {   # the agent user's groups, space-separated
    local g list rc answered sudo_rights no_password in_group s p tt tu to rules groups="$1"
    for g in $KS_REFUSED_GROUPS; do
        # With --agent-sudo password, the sudo groups are what grants sudo
        # with a password; the probes below refuse it without one.
        if [ "${KS_AGENT_SUDO:-none}" = password ]; then
            case "$g" in sudo|wheel|admin) continue ;; esac
        fi
        case " $groups " in
            *" $g "*) ks_rooteq "the agent user $KS_AGENT is in the group $g, which makes it root-equivalent (leave it out: id $KS_AGENT must not show any of $KS_REFUSED_GROUPS; rootless Docker needs none of them)" ;;
        esac
    done
    # What sudo -l (as root, in the C locale: its wording is matched) says the
    # user may run, and whether it runs with no password (asked as that user).
    list="$(ks_root env LC_ALL=C sudo -l -U "$KS_AGENT" 2>/dev/null)"; rc=$?
    # Matched in the shell, never by a pipe into grep -q: under pipefail that
    # loses the match whenever grep stops reading before the listing ends.
    # The listing must say one or the other: anything else (an error, a
    # sudoers it cannot read, another language) is not an answer. Status 127:
    # there is no sudo on this machine at all, so no rights.
    sudo_rights=0; answered=1
    case "$list" in
        *'may run the following commands'*) sudo_rights=1 ;;
        *' is not allowed to run '*) ;;
        *) answered=0 ;;
    esac
    if [ "$answered" = 0 ] && [ "$rc" != 127 ]; then
        ks_problem "could not read what sudo allows the agent user $KS_AGENT: sudo -l -U $KS_AGENT (as root, in the C locale) said neither that it may run commands nor that it is not allowed to (status $rc). Fix sudo, then run this again"
    fi
    in_group=0
    for g in $KS_SUDO_GROUPS; do case " $groups " in *" $g "*) in_group=1 ;; esac; done
    no_password=0
    case "$list" in *NOPASSWD*|*'!authenticate'*) no_password=1 ;; esac
    if [ "$no_password" = 1 ]; then
        ks_rooteq "the agent user $KS_AGENT may run sudo with no password (sudo -l -U $KS_AGENT lists NOPASSWD or !authenticate)"
    elif [ "$sudo_rights" = 1 ] && [ "${KS_AGENT_SUDO:-none}" != password ]; then
        ks_rooteq "the agent user $KS_AGENT may run sudo (sudo -l -U $KS_AGENT lists commands); a team agent gets none. For a personal agent on its own machine whose sudo needs a password only a person knows: --agent-sudo password"
    elif [ "${KS_AGENT_SUDO:-none}" = password ] && { [ "$sudo_rights" = 1 ] || [ "$in_group" = 1 ]; }; then
        # --agent-sudo password (or a sudo group with it): allowed, but it is
        # root-equivalent, and says so.
        KS_SUDO_WARN="the agent user $KS_AGENT is root-equivalent: it may run sudo with its password (--agent-sudo password). That password must never be typed in any session of $KS_AGENT (a terminal, tmux window or ssh session it owns): a sudo ticket cached there, a sudo shadowed on its PATH, or a debugger attached to its own shell all lead to root. The safer shape gives the agent user no sudo at all, and keeps sudo with the admin's own user"
        tt="$(ks_sudo_timestamp_timeout "$list")"; tu="${tt%%|*}"; to="${tt#*|}"
        if ! [[ $tu =~ ^0+(\.0+)?$ ]]; then
            ks_problem "--agent-sudo password needs sudo to cache no ticket for $KS_AGENT: sudo -l -U $KS_AGENT shows timestamp_timeout=${tu:-<not set>}, not 0. Add Defaults:$KS_AGENT timestamp_timeout=0 (visudo -f /etc/sudoers.d/$KS_AGENT), then run this again"
        elif [ -n "$to" ]; then
            ks_problem "--agent-sudo password needs sudo to cache no ticket for $KS_AGENT: sudo -l -U $KS_AGENT shows timestamp_timeout=$to in a Runas or command default (Defaults>user or Defaults!command), not 0. Every timestamp_timeout that applies to $KS_AGENT must be 0; then run this again"
        fi
    fi
    if ks_root runuser -u "$KS_AGENT" -- sudo -n true >/dev/null 2>&1; then
        ks_rooteq "the agent user $KS_AGENT can run sudo -n true: it is root without a password"
    fi
    # The real sockets always (a test's stand-in root comes on top of them,
    # never instead).
    for s in $KS_ENGINE_SOCKETS; do
        for p in "$s" ${KS_SYSROOT:+"$KS_SYSROOT$s"}; do
            [ -S "$p" ] || [ -e "$p" ] || continue
            if ks_root runuser -u "$KS_AGENT" -- test -w "$p" >/dev/null 2>&1; then
                ks_rooteq "the agent user $KS_AGENT can write $p, a container engine's socket, which is root (rootless Docker uses its own socket under /run/user)"
            fi
        done
    done
    # doas, where it is installed: a permit rule for the agent user, or for a
    # group it is in. (polkit rules are not read: see the README.)
    for p in "$KS_SYSROOT/etc/doas.conf" "$KS_SYSROOT/usr/local/etc/doas.conf"; do
        [ -e "$p" ] || continue
        rules="$(ks_root cat "$p" 2>/dev/null | ks_doas_permits "$KS_AGENT" "$groups")"
        [ -z "$rules" ] || ks_rooteq "the agent user $KS_AGENT may run doas ($p: $(printf '%s' "$rules" | tr '\n' ';' | sed 's/;$//; s/;/; /g')), which makes it root-equivalent"
    done
}
# The permit rules of a doas.conf (on stdin) that name <user>, or a group in
# <groups> (as :group); a line ending in a backslash goes on into the next.
ks_doas_permits() {   # user groups
    awk -v u="$1" -v groups=" $2 " '
        /\\$/ { cont = cont substr($0, 1, length($0) - 1) " "; next }
        {
            line = cont $0; cont = ""
            sub(/#.*/, "", line); rule = line
            gsub(/setenv[[:space:]]*\{[^}]*\}/, " ", line)
            n = split(line, w, /[[:space:]]+/); i = 1
            while (i <= n && w[i] == "") i++
            if (w[i] != "permit") next
            for (i++; i <= n; i++) if (w[i] != "" && w[i] !~ /^(nopass|nolog|persist|keepenv)$/) break
            id = w[i]
            if (id == u || (substr(id, 1, 1) == ":" && index(groups, " " substr(id, 2) " "))) {
                sub(/^[[:space:]]+/, "", rule); sub(/[[:space:]]+$/, "", rule); print rule
            }
        }'
}
# timestamp_timeout in a sudo -l listing, as "<user's>|<other>": the user's
# is the last one in its Matching Defaults entries (comma-separated, wrapped
# onto indented lines); the other is the first one anywhere in the listing
# (a Runas or command default too: Defaults>root, Defaults!/usr/bin/x) that is
# not 0. Each is empty when there is none.
ks_sudo_timestamp_timeout() {   # the -l listing
    printf '%s\n' "$1" | awk '
        /^Matching Defaults entries/ { on = 1; next }
        on && (/^[^[:space:]]/ || /^[[:space:]]*$/) { on = 0 }
        {
            line = $0
            while (match(line, /timestamp_timeout[[:space:]]*=[[:space:]]*[^,[:space:]]*/)) {
                e = substr(line, RSTART, RLENGTH); line = substr(line, RSTART + RLENGTH)
                sub(/^timestamp_timeout[[:space:]]*=[[:space:]]*/, "", e); gsub(/"/, "", e)
                if (on) user = e
                if (e !~ /^0+(\.0+)?$/ && other == "") other = (e == "" ? "<empty>" : e)
            }
        }
        END { print user "|" other }'
}
# <<< root-equivalence checks

# Each user this setup makes carries a comment that names its role and its
# instance (useradd --comment). One that is there already must carry it: a
# user made for another role or another instance is never taken over.
KS_KEY_COMMENT=""; KS_GH_COMMENT=""
ks_check_role() {   # passwd line, what, the comment it must carry
    local c
    c="$(printf '%s' "$1" | cut -d: -f5)"
    [ "$c" = "$3" ] || ks_problem "$2 $(printf '%s' "$1" | cut -d: -f1) is there, but it was not made by this setup for this role and this instance: its comment is \"${c:-<none>}\", not \"$3\". Use another instance name, or, if it is this instance's own, set its comment (usermod -c \"$3\")"
}

# The key's user: made here, or checked when it is there.
ks_check_key_user() {
    local line uid gid shell home others g kgroups
    line="$(ks_passwd "$KS_KEY_USER")"
    if [ -z "$line" ]; then KS_KEY_EXISTS=0; return; fi
    KS_KEY_EXISTS=1
    uid="$(printf '%s' "$line" | cut -d: -f3)"; gid="$(printf '%s' "$line" | cut -d: -f4)"
    home="$(printf '%s' "$line" | cut -d: -f6)"; shell="$(printf '%s' "$line" | cut -d: -f7)"
    if [ "$uid" = 0 ]; then ks_problem "the key's user $KS_KEY_USER is root"; return; fi
    if [ "$uid" -ge 1000 ] 2>/dev/null; then ks_problem "the key's user $KS_KEY_USER is there, but not a system user (uid $uid); it was not made by this setup"; fi
    ks_check_role "$line" "the key's user" "$KS_KEY_COMMENT"
    case "$shell" in */nologin|/bin/false|/usr/bin/false) ;; *) ks_problem "the key's user $KS_KEY_USER has a login shell ($shell)" ;; esac
    case "$home" in /nonexistent|/) ;; *) [ -d "$home" ] && ks_problem "the key's user $KS_KEY_USER has a home folder ($home)" ;; esac
    if [ "$(getent group "$gid" 2>/dev/null | cut -d: -f1)" != "$KS_KEY_USER" ]; then
        ks_problem "the key's user $KS_KEY_USER's group is not its own group $KS_KEY_USER"
    fi
    others="$(ks_group_others "$gid" "$KS_KEY_USER")"
    [ -z "$others" ] || ks_problem "the key's user's group $KS_KEY_USER also holds $others"
    kgroups=" $(ks_groups_of "$KS_KEY_USER")"
    for g in $(ks_groups_of "$KS_AGENT"); do
        case "$kgroups " in *" $g "*) ks_problem "the key's user and the agent user share the group $g" ;; esac
    done
}

# The GitHub App key's own user (the slot only): made here, or checked when it
# is there, as the key's user is. It shares no group with the agent user, nor
# with the key's user, which runs buzz-mcp, the channel and the copy step.
ks_check_gh_user() {
    local line uid gid shell home others g ggroups u="$KS_GH_USER"
    line="$(ks_passwd "$u")"
    if [ -z "$line" ]; then KS_GH_EXISTS=0; return; fi
    KS_GH_EXISTS=1
    uid="$(printf '%s' "$line" | cut -d: -f3)"; gid="$(printf '%s' "$line" | cut -d: -f4)"
    home="$(printf '%s' "$line" | cut -d: -f6)"; shell="$(printf '%s' "$line" | cut -d: -f7)"
    if [ "$uid" = 0 ]; then ks_problem "the GitHub App key's user $u is root"; return; fi
    if [ "$uid" -ge 1000 ] 2>/dev/null; then ks_problem "the GitHub App key's user $u is there, but not a system user (uid $uid); it was not made by this setup"; fi
    ks_check_role "$line" "the GitHub App key's user" "$KS_GH_COMMENT"
    case "$shell" in */nologin|/bin/false|/usr/bin/false) ;; *) ks_problem "the GitHub App key's user $u has a login shell ($shell)" ;; esac
    case "$home" in /nonexistent|/) ;; *) [ -d "$home" ] && ks_problem "the GitHub App key's user $u has a home folder ($home)" ;; esac
    if [ "$(getent group "$gid" 2>/dev/null | cut -d: -f1)" != "$u" ]; then
        ks_problem "the GitHub App key's user $u's group is not its own group $u"
    fi
    others="$(ks_group_others "$gid" "$u")"
    [ -z "$others" ] || ks_problem "the GitHub App key's user's group $u also holds $others"
    ggroups=" $(ks_groups_of "$u")"
    for g in $(ks_groups_of "$KS_AGENT") $(ks_groups_of "$KS_KEY_USER"); do
        case "$ggroups " in *" $g "*) ks_problem "the GitHub App key's user $u shares the group $g with the agent user or the key's user" ;; esac
    done
}

# ---------------------------------------------------------------- the machine

ks_check_machine() {
    local v f n
    if [ "$GP_OS" != linux ]; then ks_problem "the key service is for Linux with systemd; this is $GP_OS"; return; fi
    if ! command -v systemctl >/dev/null 2>&1; then ks_problem "no systemd here (systemctl is missing)"; return; fi
    v="$(systemctl --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
    case "$v" in ''|*[!0-9]*) ks_problem "could not read systemd's version" ;; *)
        [ "$v" -ge "$KS_MIN_SYSTEMD" ] || ks_problem "systemd $v is too old: the key's units need OpenFile=, which came in systemd $KS_MIN_SYSTEMD" ;;
    esac
    for n in protected_symlinks protected_hardlinks; do
        f="$KS_PROCSYS/fs/$n"
        v="$(tr -d '[:space:]' <"$f" 2>/dev/null)"
        if [ "$v" != 1 ]; then
            ks_problem "fs.$n is ${v:-unreadable}, not 1: the outbox's copy step relies on it (set it for good: sysctl -w fs.$n=1, and in /etc/sysctl.d)"
        fi
    done
    for f in useradd runuser getent python3 flock; do
        command -v "$f" >/dev/null 2>&1 || ks_problem "$f is missing (the setup needs it)"
    done
    if [ -f "$KS_UNITDIR/$KS_NAME-automode-guard.service" ]; then
        ks_problem "the auto-mode guard is installed for $KS_NAME ($KS_UNITDIR/$KS_NAME-automode-guard.service): its send runs the relay key command as the agent user, which would leave the agent a way to the key. Remove it first (install/automode-guard/setup --home <home> --uninstall --apply); its key-side send comes in a later change"
    fi
}

# ---------------------------------------------------------------- the instance's own unit

# The instance's unit (<name>.service and its drop-ins, as systemctl cat shows
# them, read as root) must run as the agent user, and must not hand the
# session a relay key, nor anything systemd reads as root that could be the
# key:
#   - no credential named buzz* or nostr* (any case): systemd puts the
#     credentials in /run/credentials/<name>.service/, which the agent user,
#     the unit's own user, can read; start keeping them out of Claude Code's
#     environment does not keep them off that disk;
#   - no BUZZ_* or NOSTR_* variable (any case) set by Environment=, passed by
#     PassEnvironment= or in an EnvironmentFile=: with a key service, the
#     relay's settings and key are the key service's;
#   - no file systemd reads as root for it (a LoadCredential= path, an
#     EnvironmentFile=, StandardInput=file:) in or above
#     /etc/ghost-protocol (a folder is read in full), nor one the agent user
#     could point elsewhere: a link to the key file there would hand it the
#     key.
# Names only are read and printed: a value never leaves this function (an
# environment file's names are taken out of it by the root process itself).
# Other credentials and settings (an API token for the session, say) are the
# instance's own.
KS_W_BUZZ=buzz; KS_W_NOSTR=nostr
ks_cred_name_is_relay() {   # name, lower-case
    case "$1" in buzz*|nostr*) return 0 ;; esac
    return 1
}
ks_env_name_is_relay() {   # name
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in buzz_*|nostr_*) return 0 ;; esac
    return 1
}
# The unit's lines as systemd reads them (its conf-parser), from systemctl
# cat's output, where each line is one that systemd reads (a CR, an LF, a CR LF
# or a NUL ends one). In systemd's order:
#   - a comment line (# or ; first, after spaces and tabs) is skipped, first
#     of all;
#   - the first byte-order mark at the start of a line is dropped (systemd
#     drops one, once per file);
#   - a line ending in an odd number of backslashes goes on into the next
#     (the last backslash read as a space); an even number is not one;
#   - spaces and tabs around a line and around its first = go: "Key = value"
#     is "Key=value", and " [Service] " is "[Service]".
# A CR before the LF is that line's end as well (a systemctl that passes the
# bytes through prints it). A line that still holds a control character (the
# caller turns a NUL into \001), or a byte-order mark systemd would keep, is
# printed as KS_UNREADABLE alone: this check cannot be sure how systemd reads
# it, and every caller fails on it. With --markers (ks_check_loaded, after
# ks_dropin_part), a line that starts with \002 is a file's name from
# ks_dropin_part, and passes as it is; without it, a \002 is a control
# character like any other.
KS_UNREADABLE=$'\001'
ks_unit_lines() {   # [--markers], unit text on stdin
    local m=0
    [ "${1:-}" = --markers ] && m=1
    LC_ALL=C awk -v markers="$m" '
        BEGIN { bom = "\357\273\277"; ctl = "[\001-\010\013-\037\177]" }
        function put(l,   i, k, v) {
            if (index(l, bom)) { print "\001"; return }
            sub(/^[ \t]+/, "", l); sub(/[ \t]+$/, "", l)
            if (l == "") return
            i = index(l, "=")
            if (i == 0) { print l; return }
            k = substr(l, 1, i - 1); v = substr(l, i + 1)
            sub(/[ \t]+$/, "", k); sub(/^[ \t]+/, "", v)
            print k "=" v
        }
        markers == 1 && substr($0, 1, 1) == "\002" { if (cont != "") put(cont); cont = ""; print; next }
        { sub(/\r$/, "") }
        $0 ~ ctl { print "\001"; next }
        /^[ \t]*[#;]/ { next }
        {
            l = $0
            if (!bom_seen && substr(l, 1, 3) == bom) { l = substr(l, 4); bom_seen = 1 }
            p = cont l
            if (match(p, /\\+$/) && RLENGTH % 2 == 1) { cont = substr(p, 1, length(p) - 1) " "; next }
            put(p); cont = ""
        }
        END { if (cont != "") put(cont) }'
}
# The drop-ins in systemctl cat's output on stdin: what follows the unit file,
# which systemctl prints first and which must be, line for line, the file this
# setup wrote (<work file>, installed as <path>). Each drop-in's "# <path>"
# line (after an empty line) becomes \002<path>, and a \002 in any other line
# \001. Status 1 when the output does not start with that unit file.
ks_dropin_part() {   # work file, installed path
    LC_ALL=C awk -v want="$1" -v head="# $2" '
        bad { next }
        NR == 1 { if ($0 != head) bad = 1; next }
        !rest { if ((getline w < want) > 0) { if ($0 != w) bad = 1; next }; rest = 1 }
        { gsub("\002", "\001") }
        prev == "" && /^# \// { print "\002" substr($0, 3); prev = $0; next }
        { print; prev = $0 }
        END { if (NR == 0 || bad || (!rest && (getline w < want) > 0)) exit 1 }'
}
# Why systemd, reading <path> as root for the instance, could be reading the
# key, or nothing: the path, as given or with its links followed, is in or
# above the key service's settings folder; the agent user could point it
# elsewhere (a link on the way in a folder it can change, or a folder it can
# change, at the path or above it); or it holds a systemd specifier, which
# this check cannot follow. A relative path names the credential store.
ks_unit_path_problem() {   # path
    local p="$1" top="${KS_ETC%/*}" x d why
    case "$p" in *%*) printf 'it holds a systemd specifier (%%), which this check cannot follow: write the path out'; return 0 ;; esac
    case "$p" in /*) ;; *) return 1 ;; esac
    for x in "$p" "$(readlink -m -- "$p" 2>/dev/null)"; do
        [ -n "$x" ] || continue
        x="${x%/}"
        case "$x/" in "$top/"*) printf 'it is in %s, where the key file is' "$top"; return 0 ;; esac
        case "$top/" in "$x/"*) printf 'it is a folder above %s, where the key file is' "$top"; return 0 ;; esac
    done
    if why="$(ks_link_in_agent_folder "$p")"; then printf 'the agent user could point it at the key file (%s)' "$why"; return 0; fi
    d="$p"
    while [ ! -e "$d" ] && [ ! -L "$d" ] && [ "$d" != / ]; do d="$(dirname -- "$d")"; done
    if why="$(ks_agent_can_change "$d")"; then printf 'the agent user could put a link to the key file there (%s)' "$why"; return 0; fi
    return 1
}
ks_check_instance_creds() {
    local unit="$KS_NAME.service" text line kind v n p lc u why found="" paths="" unreadable=0
    if [ "$(systemctl show -p LoadState --value "$unit" 2>/dev/null)" != loaded ]; then
        record SKIP instance "$unit is not installed yet: its user, credentials and environment are checked by a run after it is (run this again then)"
        return 0
    fi
    u="$(systemctl show -p User --value "$unit" 2>/dev/null)"
    if [ "$u" != "$KS_AGENT" ] && [ "$u" != "${KS_AGENT_UID:-}" ]; then
        ks_problem "$unit runs as ${u:-root (no User=)}, not as the agent user $KS_AGENT: the agent user is the one the key service lets in, so give the unit User=$KS_AGENT, or name its user with --agent-user"
    fi
    # A NUL goes in as \001, which ks_unit_lines refuses: the shell would drop it.
    if ! text="$(set -o pipefail; ks_root systemctl cat "$unit" 2>/dev/null | LC_ALL=C tr '\000' '\001')"; then
        ks_problem "could not read $unit with systemctl cat (as root), so its credentials could not be checked for a relay key"
        return
    fi
    while IFS= read -r line; do
        if [ "$line" = "$KS_UNREADABLE" ]; then unreadable=1; continue; fi
        kind="${line%%=*}"; v="${line#*=}"
        case "$line" in *=*) ;; *) continue ;; esac
        case "$kind" in
            LoadCredential|LoadCredentialEncrypted|SetCredential|SetCredentialEncrypted)
                n="${v%%:*}"
                [ -n "$n" ] || continue
                lc="$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]')"
                ks_cred_name_is_relay "$lc" && found="$found $kind=$n"
                case "$kind:$v" in
                    Load*:*:*)
                        p="${v#*:}"; p="${p#"${p%%[![:space:]]*}"}"
                        if why="$(ks_unit_path_problem "$p")"; then paths="$paths
$kind=$n:$p: $why"; fi ;;
                esac ;;
            ImportCredential)
                # A glob: refused when it could match a buzz* or nostr* name,
                # judged by its text before the first wildcard.
                n="${v%%[*?[]*}"
                lc="$(printf '%s' "$n" | tr '[:upper:]' '[:lower:]')"
                if [ -z "$lc" ] || [ "${KS_W_BUZZ#"$lc"}" != "$KS_W_BUZZ" ] || [ "${KS_W_NOSTR#"$lc"}" != "$KS_W_NOSTR" ] \
                    || ks_cred_name_is_relay "$lc"; then
                    found="$found $kind=$v"
                fi ;;
            Environment)
                # Every NAME= at the start, after a space or after a quote
                # (one inside a quoted value too): the names only.
                while [[ $v =~ (^|[[:space:]\"\'])([A-Za-z_][A-Za-z0-9_]*)= ]]; do
                    n="${BASH_REMATCH[2]}"
                    ks_env_name_is_relay "$n" && found="$found $kind=$n"
                    v="${v#*"${BASH_REMATCH[0]}"}"
                done ;;
            PassEnvironment)
                for n in $v; do ks_env_name_is_relay "$n" && found="$found $kind=$n"; done ;;
            EnvironmentFile)
                p="${v#-}"
                if why="$(ks_unit_path_problem "$p")"; then paths="$paths
$kind=$p: $why"; continue; fi
                # The names in it, taken out by the root process: no value
                # reaches this script.
                for n in $(ks_root sed -n 's/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}\([A-Za-z_][A-Za-z0-9_]*\)[[:space:]]*=.*/\2/p' -- "$p" 2>/dev/null); do
                    ks_env_name_is_relay "$n" && found="$found $kind=$p:$n"
                done ;;
            StandardInput)
                case "$v" in file:*)
                    p="${v#file:}"
                    if why="$(ks_unit_path_problem "$p")"; then paths="$paths
$kind=$v: $why"; fi ;;
                esac ;;
        esac
    done <<EOF
$(printf '%s\n' "$text" | ks_unit_lines)
EOF
    unset text line v
    if [ "$unreadable" = 1 ]; then
        ks_problem "$unit or one of its drop-ins holds a line with a control character or a second byte-order mark, so this check cannot tell how systemd reads it, nor whether it hands the session a relay credential: write it as plain text, then daemon-reload"
    fi
    if [ -n "$found" ]; then
        ks_problem "$unit hands the session a Buzz or Nostr credential or setting ($(printf '%s' "${found# }" | sed 's/ /, /g')): systemd puts a credential in /run/credentials/$unit/, which $KS_AGENT reads, and a variable in the session's environment. Remove it from the unit and its drop-ins (the key lives only in the key file, the relay's settings in the key service's buzz.env), then daemon-reload"
    fi
    while IFS= read -r line; do
        [ -n "$line" ] || continue
        ks_problem "$unit has systemd read, as root, a file that could be the key: $line. Name a file only root can change, outside ${KS_ETC%/*} (for example in /etc/credstore), then daemon-reload"
    done <<EOF
$paths
EOF
}

# ---------------------------------------------------------------- paths the agent could change

# Why the agent user could change what <path> holds, or nothing: it owns the
# path or a folder above it, or one of them is writable by its group or by
# everyone. Any group write counts, whatever the group: POSIX ACL entries that
# grant writing (to the agent user, or any group) show in the group bits, the
# ACL's mask. A sticky folder is fine above the path: others cannot rename or
# delete what they do not own in it. (These are files the setup reads once; the
# code's own check in launch.mjs serve has no sticky exception, because node
# looks for modules in every folder above its code.)
ks_agent_can_change() {   # path
    local p uid gid mode m first=1
    p="$(readlink -f -- "$1" 2>/dev/null)" || { printf '%s is missing' "$1"; return 0; }
    [ -e "$p" ] || { printf '%s is missing' "$1"; return 0; }
    while :; do
        read -r uid gid mode <<EOF
$(stat -c '%u %g %a' -- "$p" 2>/dev/null)
EOF
        case "$mode" in ''|*[!0-7]*) printf 'could not read %s' "$p"; return 0 ;; esac
        m=$((8#$mode))
        if [ "$uid" = "$KS_AGENT_UID" ]; then printf '%s is owned by the agent user' "$p"; return 0; fi
        if [ "$first" = 1 ] || [ ! -d "$p" ] || [ $((m & 8#1000)) = 0 ]; then
            if [ $((m & 8#020)) != 0 ]; then
                case " $KS_AGENT_GIDS " in
                    *" $gid "*) printf '%s can be written by a group the agent user is in' "$p" ;;
                    *) printf '%s can be written by its group (gid %s), or through an ACL entry' "$p" "$gid" ;;
                esac
                return 0
            fi
            if [ $((m & 8#002)) != 0 ]; then printf '%s can be written by everyone' "$p"; return 0; fi
        fi
        [ "$p" = / ] && return 1
        p="$(dirname -- "$p")"; first=0
    done
}
# Why a link on <path> as given could be pointed elsewhere by the agent user,
# or nothing: a link on the way (the path itself, or a folder in it) that
# sits in a folder the agent user can write. The path is walked as given,
# with no link resolved first, so a link the agent planted cannot hide; the
# resolved path is then checked by ks_agent_can_change.
ks_link_in_agent_folder() {   # path
    local p="$1" d uid mode m
    case "$p" in /*) ;; *) printf '%s is not an absolute path' "$p"; return 0 ;; esac
    while [ -n "$p" ] && [ "$p" != / ]; do
        d="$(dirname -- "$p")"
        if [ -L "$p" ]; then
            read -r uid mode <<EOF
$(stat -L -c '%u %a' -- "$d" 2>/dev/null)
EOF
            case "$mode" in ''|*[!0-7]*) printf 'could not read %s' "$d"; return 0 ;; esac
            m=$((8#$mode))
            if [ "$uid" = "$KS_AGENT_UID" ] || [ $((m & 8#022)) != 0 ]; then
                printf '%s is a link in %s, a folder the agent user can change, so it could be pointed elsewhere after the check' "$p" "$d"
                return 0
            fi
        fi
        p="$d"
    done
    return 1
}

# An input file, taken once: checked (no link on the way the agent user could
# point elsewhere, and nothing it could change on its real path), then copied
# at once into this run's private work folder. The copy is made from the real
# path opened without following a link (O_NOFOLLOW, O_NONBLOCK), checked on
# the open descriptor (a regular file, at most <max> bytes) and read from that
# descriptor. Only the copy is used afterwards. Sets KS_COPY, or KS_WHY and
# status 1.
KS_COPY=""; KS_TAKEN=0
KS_PY_TAKE='
import os, stat, sys
src, dst, cap, mode = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4], 8)
fd = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
st = os.fstat(fd)
if not stat.S_ISREG(st.st_mode) or st.st_size > cap:
    sys.exit(1)
out = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
n = 0
while True:
    b = os.read(fd, 1 << 20)
    if not b:
        break
    n += len(b)
    if n > cap:
        sys.exit(1)
    os.write(out, b)
os.fchmod(out, mode)
os.close(out)
'
ks_take() {   # path what max-bytes mode
    local given="$1" what="$2" real why dest
    KS_COPY=""
    if why="$(ks_link_in_agent_folder "$given")"; then KS_WHY="$what: $why"; return 1; fi
    real="$(readlink -f -- "$given" 2>/dev/null)"
    if [ -z "$real" ] || [ ! -f "$real" ]; then KS_WHY="$what $given is not a file"; return 1; fi
    if why="$(ks_agent_can_change "$real")"; then KS_WHY="$what could be changed by the agent user ($why)"; return 1; fi
    KS_TAKEN=$((KS_TAKEN + 1))
    dest="$GP_WORK/in/$KS_TAKEN-${real##*/}"
    if ! mkdir -p "$GP_WORK/in" || ! python3 -I -c "$KS_PY_TAKE" "$real" "$dest" "$3" "$4" 2>/dev/null; then
        rm -f "$dest"
        KS_WHY="$what $real could not be copied to this run's work folder (not a regular file, or over $3 bytes)"; return 1
    fi
    KS_COPY="$dest"
}

# This run's work folder, where the inputs are copied: the agent user must
# not be able to change it, or anything above it.
ks_check_work() {
    local why
    if why="$(ks_agent_can_change "$GP_WORK")"; then
        ks_problem "this run's work folder $GP_WORK could be changed by the agent user ($why): run the setup as the admin, whose home folder the agent user cannot write"
        return 1
    fi
}

# ---------------------------------------------------------------- the code

# git with nothing inherited: no repository, object store or index named by
# the environment (an inherited GIT_DIR wins over -C), no config from the
# environment, the system or the user, no replace objects, no hooks, no
# fsmonitor.
ks_git_env() {
    env -u GIT_DIR -u GIT_COMMON_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY \
        -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_NAMESPACE -u GIT_CONFIG -u GIT_CONFIG_PARAMETERS \
        -u GIT_CONFIG_COUNT -u GIT_EXEC_PATH -u GIT_TEMPLATE_DIR \
        GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_NO_REPLACE_OBJECTS=1 GIT_ATTR_NOSYSTEM=1 \
        git -c core.fsmonitor=false -c core.hooksPath=/dev/null "$@"
}
# git on this checkout, for reading. safe.directory: run as root on the
# admin's own clone, git would otherwise refuse a repository another user
# owns. That clone has been checked: the agent user cannot change it.
ks_git() { ks_git_env -c safe.directory="$GP_DIR" -C "$GP_DIR" "$@"; }
# git on this run's fresh copy of the commit (ks_fetch_source).
ks_src() { ks_git_env -C "$KS_SRC_GIT" "$@"; }

# The commit, fetched from this checkout into a fresh bare repository in this
# run's work folder. A fetch moves objects as a pack, and the receiving side
# names each object by the hash of what it got, and checks it (fsck), so an
# object whose content is not what its name says never arrives; git archive
# on the checkout itself would read it as it is. Everything the key service
# takes from the commit comes from this copy.
ks_fetch_source() {
    local err
    KS_SRC_GIT="$GP_WORK/source.git"
    rm -rf "$KS_SRC_GIT"
    if ! ks_git_env init -q --bare "$KS_SRC_GIT" >/dev/null 2>&1; then
        ks_problem "could not make a fresh repository in this run's work folder ($KS_SRC_GIT)"; return 1
    fi
    if ! err="$(ks_src -c safe.directory="$GP_DIR" -c fetch.fsckObjects=true -c transfer.fsckObjects=true fetch -q --no-tags --depth=1 \
            "$GP_DIR" "$KS_COMMIT" 2>&1)"; then
        ks_problem "commit $KS_COMMIT could not be fetched from $GP_DIR into this run's work folder, where every object is checked against its hash: the checkout may be damaged, or hold an object that is not what its name says (git fsck finds it). git said: $(printf '%s' "$err" | tail -n 1)"
        return 1
    fi
    if ! ks_src cat-file -e "$KS_COMMIT^{commit}" 2>/dev/null; then
        ks_problem "commit $KS_COMMIT is not in the fresh copy after the fetch"; return 1
    fi
}

ks_check_source() {
    local why d alt gitdir common n v
    # git's object stores are this checkout's own, and only its own.
    for d in GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_OBJECT_DIRECTORY; do
        if [ -n "${!d:-}" ]; then
            ks_problem "$d is set in this environment: git would read objects from elsewhere. Unset it, then run this again"
            return
        fi
    done
    gitdir="$(ks_git rev-parse --absolute-git-dir 2>/dev/null)"
    common="$(ks_git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
    for d in "$GP_DIR" "$gitdir" "$common"; do
        [ -n "$d" ] || { ks_problem "$GP_DIR is not a git checkout; the key service's code comes from a commit in it"; return; }
        if why="$(ks_agent_can_change "$d")"; then
            ks_problem "this checkout could be changed by the agent user ($why): run this from the admin's own clone of GHOST Protocol"
            return
        fi
    done
    # And inside them: HEAD, the refs, the objects, the config, everything in
    # the git folders (hooks aside: they never run here), a worktree's .git
    # file, and the setup's own folder (its code, and the unit templates it
    # fills in). Nothing there may be a link, the agent user's, or writable by
    # a group or by others.
    local -a tops=() own=()
    for d in "$GP_DIR/.git" "$gitdir" "$common" "$GP_DIR/install"; do
        case " ${tops[*]} " in *" $d "*) ;; *) tops+=("$d") ;; esac
    done
    [ -z "${KS_AGENT_UID:-}" ] || own=(-o -uid "$KS_AGENT_UID")
    n="$(find "${tops[@]}" \( -path "$GP_DIR/.git/hooks" -o -path "$gitdir/hooks" -o -path "$common/hooks" \) -prune \
        -o \( -type l -o -perm /022 ${own[@]+"${own[@]}"} \) -print 2>/dev/null | head -n 1)"
    if [ -n "$n" ]; then
        ks_problem "this checkout could be changed by the agent user: $n is a link, the agent user's, or writable by a group or by others, and git or the setup would read it. Run this from the admin's own clone of GHOST Protocol with nothing in it writable by others (a umask of 002 makes a clone group-writable: chmod -R go-w $GP_DIR)"
        return
    fi
    v="$(ks_git config --get core.sharedRepository 2>/dev/null)"
    case "$(printf '%s' "$v" | tr '[:upper:]' '[:lower:]')" in
        ''|false|no|off|0|umask) ;;
        *) ks_problem "this checkout sets core.sharedRepository=$v: git makes what it writes there writable by a group or by everyone. Unset it (git config --unset core.sharedRepository), chmod -R go-w $GP_DIR, then run this again"
           return ;;
    esac
    alt="$(ks_git rev-parse --path-format=absolute --git-path objects/info/alternates 2>/dev/null)"
    if [ -n "$alt" ] && [ -f "$alt" ] && grep -q '[^[:space:]]' "$alt" 2>/dev/null; then
        ks_problem "this checkout borrows objects from another store ($alt, git alternates), which this setup cannot check: run it from a clone with every object of its own (git repack -a -d, then remove that file)"
        return
    fi
    if [ -z "$KS_COMMIT" ]; then KS_COMMIT="$(ks_git rev-parse HEAD 2>/dev/null)"; fi
    if ! [[ $KS_COMMIT =~ $KS_RE_COMMIT ]]; then ks_problem "--commit must be a full 40-character commit id"; return; fi
    if ! ks_git cat-file -e "$KS_COMMIT^{commit}" 2>/dev/null; then
        ks_problem "commit $KS_COMMIT is not in $GP_DIR (fetch it first)"; return
    fi
    ks_fetch_source || return
    if ! ks_src cat-file -e "$KS_COMMIT:adapters/buzz/src/launch.mjs" 2>/dev/null \
        || ! ks_src cat-file -e "$KS_COMMIT:adapters/buzz/src/keyfile.mjs" 2>/dev/null \
        || ! ks_src cat-file -e "$KS_COMMIT:install/keyservice/outbox-copy" 2>/dev/null; then
        ks_problem "commit $KS_COMMIT has no key service (it is older than the key service's installer)"; return
    fi
    KS_PIN="$(ks_src show "$KS_COMMIT:adapters/buzz/buzz-mcp.pin" 2>/dev/null | sed -n 's/^commit=\([0-9a-f]\{40\}\)$/\1/p')"
    [ -n "$KS_PIN" ] || ks_problem "commit $KS_COMMIT has no buzz-mcp pin"
}

# node: a root-owned one is run where it is; any other is copied in, from
# the copy ks_take made.
ks_check_node() {
    local p real v
    p="${KS_NODE_OPT:-}"
    if [ -z "$p" ]; then
        command -v node >/dev/null 2>&1 || { ks_problem "node is not installed (the key service needs node $KS_MIN_NODE or later)"; return; }
        p="$(node -e 'process.stdout.write(process.execPath)' 2>/dev/null)"
    fi
    real="$(readlink -f -- "$p" 2>/dev/null)"
    if [ -z "$real" ] || [ ! -f "$real" ] || ! [[ $real =~ $KS_RE_PATH ]]; then ks_problem "node's path is not a plain file path: $p"; return; fi
    if ks_root_only "$real" && ! ks_link_in_agent_folder "$p" >/dev/null; then
        KS_NODE_COPY=0; KS_NODE="$real"; KS_NODE_SRC="$real"
    else
        if ! ks_take "$p" "node" $((512 * 1024 * 1024)) 700; then ks_problem "$KS_WHY"; return; fi
        KS_NODE_COPY=1; KS_NODE="$KS_OPT/$KS_COMMIT/bin/node"; KS_NODE_SRC="$KS_COPY"
    fi
    v="$("$KS_NODE_SRC" -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
    case "$v" in ''|*[!0-9]*) ks_problem "could not read the version of $real"; return ;; esac
    [ "$v" -ge "$KS_MIN_NODE" ] || { ks_problem "node $v at $real is too old (the key service needs $KS_MIN_NODE or later)"; return; }
}
# The path and every folder above it are root's, and none is writable by its
# group or by others, sticky or not: what launch.mjs serve demands of node.
# (In a test, its own uid up to its stand-in folders: ks_paths.)
ks_root_only() {   # path
    local p="$1" uid mode m t
    while :; do
        read -r uid mode <<EOF
$(stat -c '%u %a' -- "$p" 2>/dev/null)
EOF
        case "$mode" in ''|*[!0-7]*) return 1 ;; esac
        m=$((8#$mode))
        [ "$uid" = "$KS_ROOT_UID" ] && [ $((m & 8#022)) = 0 ] || return 1
        [ "$p" = / ] && return 0
        for t in $KS_ROOT_TOPS; do [ "$p" = "$t" ] && return 0; done
        p="$(dirname -- "$p")"
    done
}
# Before anything is written: root makes folders in, empties, copies into and
# renames inside /opt/ghost-protocol, /etc/ghost-protocol/<name>,
# /srv/ghost-protocol/<name> and the units folder, and runs the code it put
# there (keyfile.mjs, with the key on its stdin). install -d keeps an existing
# folder's owner and mode, so each one, or the deepest part of it that is
# there (a link counts as there), and every folder above it, must be root's
# alone first. (In a test, a stand-in top folder not made yet is fine.)
ks_check_tops() {
    local p q
    for p in "$KS_OPT" "$KS_ETC" "$KS_SRV" "$KS_UNITDIR"; do
        q="$(ks_deepest_there "$p")" || continue
        ks_root_only "$q" || ks_problem "$q, or a folder above it, is not root's alone (each owned by root, writable by no group or others, and no link): root writes the key service's files under it, so the agent user must not be able to change it. Fix its owner and mode (chown root:root, chmod go-w), or remove it, then run this again"
    done
}
# The deepest part of <path> that is there (a link counts as there); status 1
# when that would be above a test's stand-in top folder.
ks_deepest_there() {   # path
    local q="$1" t
    while [ ! -e "$q" ] && [ ! -L "$q" ]; do
        for t in $KS_ROOT_TOPS; do [ "$q" = "$t" ] && return 1; done
        [ "$q" = / ] && break
        q="$(dirname -- "$q")"
    done
    printf '%s' "$q"
}
# The first file or folder under <path>s that is not root's alone (links
# aside: their mode says nothing), or nothing. One find, for the thousands of
# files in node_modules.
ks_not_root_under() {   # path...
    find "$@" ! -type l \( ! -uid "$KS_ROOT_UID" -o -perm /022 \) -print 2>/dev/null | head -n 1
}

ks_check_buzz_mcp() {
    local f built
    f="${KS_BUZZ_MCP_OPT:-${BUZZ_MCP_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/ghost-protocol/buzz}/buzz-mcp.mjs}"
    if [ ! -f "$f" ]; then
        ks_problem "no buzz-mcp build at $f: build it as this user first (adapters/buzz/scripts/build-buzz-mcp.sh at commit $KS_COMMIT), or name one with --buzz-mcp"
        return
    fi
    if ! ks_take "${f%/*}/buzz-mcp.commit" "the buzz-mcp build's commit file" 4096 600; then ks_problem "$KS_WHY"; return; fi
    built="$(tr -d '[:space:]' <"$KS_COPY")"
    if [ -n "$KS_PIN" ] && [ "$built" != "$KS_PIN" ]; then
        ks_problem "the buzz-mcp build at $f is from ${built:-an unknown commit}, not the pin of $KS_COMMIT ($KS_PIN): rebuild it with that commit's adapters/buzz/scripts/build-buzz-mcp.sh"
    fi
    if ! ks_take "$f" "the buzz-mcp build" $((64 * 1024 * 1024)) 600; then ks_problem "$KS_WHY"; return; fi
    KS_BUZZ_MCP_SRC="$KS_COPY"
}

# ---------------------------------------------------------------- settings

# One setting's value is checked against what that setting may hold. Prints
# the problem, or nothing.
ks_setting_problem() {   # key value
    local k="$1" v="$2" re
    case "$k" in
        BUZZ_RELAY_URL)
            re='^(https|wss)://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$'
            [[ $v =~ $re ]] || echo "BUZZ_RELAY_URL must be https:// or wss://, a host, an optional port and path" ;;
        BUZZ_CHANNELS)
            re='^([*]|[A-Za-z0-9-]{1,64}(,[A-Za-z0-9-]{1,64})*)$'
            [[ $v =~ $re ]] || echo "BUZZ_CHANNELS must be * or comma-separated channel ids" ;;
        BUZZ_CHANNEL)
            re='^[A-Za-z0-9-]{1,64}$'
            [[ $v =~ $re ]] || echo "BUZZ_CHANNEL must be one channel id" ;;
        BUZZ_WATCH_PUBKEY)
            re="^$KS_RE_PUBKEY\$"
            [[ $v =~ $re ]] || echo "BUZZ_WATCH_PUBKEY must be a public key (64 hex or npub1)" ;;
        BUZZ_TRUSTED_PUBKEYS|BUZZ_ALLOWED_PUBKEYS)
            re="^$KS_RE_PUBKEY(,$KS_RE_PUBKEY)*\$"
            [[ $v =~ $re ]] || echo "$k must be comma-separated public keys (64 hex or npub1)" ;;
        BUZZ_DM_MESSAGES)
            case "$v" in all|mentions) ;; *) echo "BUZZ_DM_MESSAGES must be all or mentions" ;; esac ;;
        BUZZ_ALLOWLIST_FILE)
            # (A test's sandbox, the folder holding its GP_ETC, stands for /
            # here, as its GP_ETC does for /etc everywhere.)
            local shown="$v" top
            if [ "${GP_TEST:-}" = 1 ] && [ -n "${GP_ETC:-}" ]; then
                top="${GP_ETC%/*}"
                case "$v" in "$top"/*) shown="${v#"$top"}" ;; esac
            fi
            if ! [[ $v =~ $KS_RE_PATH ]]; then echo "BUZZ_ALLOWLIST_FILE must be an absolute plain path"
            else
                case "$shown/" in
                    *"/../"*|*"/./"*|*"//"*) echo "BUZZ_ALLOWLIST_FILE must have no ., .. or empty segments" ;;
                    /home/*|/root/*|/run/user/*|/tmp/*|/var/tmp/*)
                        echo "BUZZ_ALLOWLIST_FILE is under /$(printf '%s' "$shown" | cut -d/ -f2), which the key's units cannot see (ProtectHome=, PrivateTmp=); put it where only root writes, for example $KS_ETC/allowlist.json" ;;
                esac
            fi ;;
        BUZZ_CATCHUP_MAX_AGE)
            re='^[1-9][0-9]{0,8}$'
            [[ $v =~ $re ]] || echo "BUZZ_CATCHUP_MAX_AGE must be a whole number of seconds" ;;
        BUZZ_TASK_ROOTS)
            case "$v" in on|off) ;; *) echo "BUZZ_TASK_ROOTS must be on or off" ;; esac ;;
        BUZZ_TASK_OPEN_EMOJI|BUZZ_TASK_DONE_EMOJI)
            # A custom emoji's name, or one plain emoji (no ASCII at all); the
            # channel checks the rest (its image, open and done apart).
            re='^[a-z0-9_-]{1,64}$'
            if ! [[ $v =~ $re ]] && { [ "$(printf '%s' "$v" | LC_ALL=C wc -c | tr -d ' ')" -gt 64 ] \
                || [ -n "$(printf '%s' "$v" | LC_ALL=C tr -d '\200-\377')" ]; }; then
                echo "$k must be a custom emoji's name (lower-case letters, digits, _ and -) or one plain emoji"
            fi ;;
        BUZZ_TASK_OPEN_EMOJI_URL|BUZZ_TASK_DONE_EMOJI_URL)
            re='^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._~/-]+$'
            [[ $v =~ $re ]] || echo "$k must be an https:// URL with a host and a path" ;;
        BUZZ_PRIVATE_KEY|BUZZ_KEY_COMMAND|NOSTR_*)
            echo "$k never goes into the settings: the key comes only from the key file (--key-from-stdin or --key-generate)" ;;
        BUZZ_AUTH_TAG)
            echo "BUZZ_AUTH_TAG goes in its own file: --tag <file>" ;;
        BUZZ_STATE_DIR|BUZZ_MCP_PATH|BUZZ_MCP_ROOT|BUZZ_CHANNEL_LOCK|BUZZ_LOG_FILE|BUZZ_MCP_CACHE|BUZZ_KEY_SOCKET)
            echo "$k is set by the key's units, not the settings" ;;
        *)
            echo "$k is not a key service setting (one of: $KS_SETTING_KEYS)" ;;
    esac
}

# Reads a settings file (KEY=value lines, # comments, blank lines; no quotes)
# into KS_ENV_LINES, in KS_SETTING_KEYS order. Problems go to ks_problem.
KS_ENV_LINES=""
ks_read_settings() {   # file
    local f="$1" line k v n=0 p seen=" " out="" key re_line
    re_line="^[A-Z][A-Z0-9_]*=[^[:space:]'\"\\\\\$\`]*\$"
    if [ ! -f "$f" ]; then ks_problem "the settings file $f is not there"; return; fi
    if ! ks_take "$f" "the settings file" 65536 600; then ks_problem "$KS_WHY"; return; fi
    f="$KS_COPY"
    while IFS= read -r line || [ -n "$line" ]; do
        n=$((n + 1))
        line="${line%$'\r'}"
        case "$line" in ''|'#'*) continue ;; esac
        if ! [[ $line =~ $re_line ]]; then
            ks_problem "settings line $n is not KEY=value (no quotes, spaces, backslashes, \$ or backticks)"; continue
        fi
        k="${line%%=*}"; v="${line#*=}"
        case "$seen" in *" $k "*) ks_problem "settings line $n: $k appears twice"; continue ;; esac
        seen="$seen$k "
        if [ -z "$v" ]; then continue; fi
        p="$(ks_setting_problem "$k" "$v")"
        if [ -n "$p" ]; then ks_problem "settings line $n: $p"; continue; fi
        eval "ksv_$k=\$v"
    done <"$f"
    for key in BUZZ_RELAY_URL BUZZ_CHANNELS; do
        eval "v=\${ksv_$key:-}"
        [ -n "$v" ] || ks_problem "the settings must set $key"
    done
    # A custom task emoji (a name) needs its image, and only a custom one takes it.
    for key in BUZZ_TASK_OPEN_EMOJI BUZZ_TASK_DONE_EMOJI; do
        eval "v=\${ksv_$key:-}; u=\${ksv_${key}_URL:-}"
        if [[ $v =~ ^[a-z0-9_-]{1,64}$ ]] && [ -z "$u" ]; then
            ks_problem "$key names a custom emoji: give its image as ${key}_URL"
        elif [ -n "$u" ] && ! [[ $v =~ ^[a-z0-9_-]{1,64}$ ]]; then
            ks_problem "${key}_URL is only for a custom $key (a name)"
        fi
    done
    # A sender allowlist, unless --no-sender-allowlist says otherwise: without
    # one, anyone who mentions the agent in its rooms reaches the session.
    if [ -z "${ksv_BUZZ_ALLOWED_PUBKEYS:-}" ] && [ -z "${ksv_BUZZ_ALLOWLIST_FILE:-}" ]; then
        if [ "${KS_NO_ALLOWLIST:-0}" = 1 ]; then KS_NO_ALLOWLIST_USED=1
        else
            ks_problem "the settings set no sender allowlist (BUZZ_ALLOWED_PUBKEYS or BUZZ_ALLOWLIST_FILE; BUZZ_TRUSTED_PUBKEYS alone turns none on): anyone who mentions the agent in its rooms would reach the session, and could have it add someone to a room through buzz-mcp's members tool. Set one, or give --no-sender-allowlist to run without one on purpose"
        fi
    fi
    for key in $KS_SETTING_KEYS; do
        eval "v=\${ksv_$key:-}"
        [ -n "$v" ] && out="$out$key=$v
"
        eval "unset ksv_$key"
    done
    KS_ENV_LINES="$out"
}

ks_render_env() {   # dest
    {
        printf '# buzz.env: the Buzz settings of the Ghost Protocol instance %s, read by its\n' "$KS_NAME"
        printf '# key service'"'"'s units (EnvironmentFile=). Made by install/keyservice/setup;\n'
        printf '# root-owned. It never holds the key, which is in buzz-key beside it.\n'
        printf '%s' "$KS_ENV_LINES"
    } >"$1" 2>/dev/null
}

# The allowlist file decides who can instruct the agent, so only root may
# change it: the file and every folder above it are root's, writable by no
# group or others, and it is outside the key service's shared and state
# folders, where the outbox's copy step and the key's user write. It is named
# by its real path (the channel reads it again whenever it changes, so no
# copy would do). The channel's unit cannot see the shared folders at all
# (InaccessiblePaths=), in case its settings are later changed by hand.
ks_check_allowlist() {
    local f why real
    f="$(printf '%s' "$KS_ENV_LINES" | sed -n 's/^BUZZ_ALLOWLIST_FILE=//p')"
    KS_ALLOWLIST="$f"
    [ -n "$f" ] || return 0
    if [ ! -f "$f" ]; then
        ks_problem "the allowlist file $f is not there: make it first, where only root writes (for example $KS_ETC/allowlist.json)"; return
    fi
    real="$(readlink -f -- "$f" 2>/dev/null)"
    if [ "$real" != "$f" ]; then
        ks_problem "the allowlist file $f is reached through a link; name its real path ($real), where only root writes"; return
    fi
    case "$f" in
        "${KS_SRV%/*}"/*|"${KS_STATE%/*}"/*)
            ks_problem "the allowlist file $f is in the key service's shared or state folders (${KS_SRV%/*}, ${KS_STATE%/*}), where the outbox's copy step and the key's user write: the agent could replace it. Put it where only root writes, for example $KS_ETC/allowlist.json"
            return ;;
    esac
    if why="$(ks_agent_can_change "$f")"; then
        ks_problem "the allowlist file decides who can instruct the agent, and the agent user could change it ($why): put it where only root writes, for example $KS_ETC/allowlist.json"
        return
    fi
    if ! ks_root_only "$f"; then
        ks_problem "the allowlist file $f, or a folder above it, is not root's alone (each owned by root, and writable by no group or others): put it where only root writes, for example $KS_ETC/allowlist.json"
    fi
}

# The owner's tag: one JSON array, ["auth", <64 hex>, <conditions>, <128 hex>].
# Only its shape is checked here; launch.mjs serve checks it again.
ks_check_tag() {   # file
    local f="$1" text re
    if [ "$(wc -c <"$f")" -gt 8192 ]; then ks_problem "the tag file is longer than 8192 bytes"; return; fi
    text="$(tr -d '\n' <"$f")"
    re='^[[:space:]]*\[[[:space:]]*"auth"[[:space:]]*,[[:space:]]*"[0-9a-f]{64}"[[:space:]]*,[[:space:]]*"[^"\\]*"[[:space:]]*,[[:space:]]*"[0-9a-f]{128}"[[:space:]]*\][[:space:]]*$'
    [[ $text =~ $re ]] || ks_problem "the tag file is not one NIP-OA auth tag: [\"auth\", \"<owner public key, 64 hex>\", \"<conditions>\", \"<signature, 128 hex>\"]"
}

# ---------------------------------------------------------------- the copy

# The files the key service runs from the commit, from the fetched copy
# (never the checkout's working tree, nor its object store directly).
KS_TRACKED="adapters/buzz/src adapters/buzz/package.json adapters/buzz/package-lock.json adapters/buzz/buzz-mcp.pin install/keyservice/outbox-copy"
ks_extract() {   # dest
    # shellcheck disable=SC2086  # the paths, no spaces in them
    ks_src archive --format=tar "$KS_COMMIT" -- $KS_TRACKED | tar -x -C "$1"
}

# A rollback runs the copy it left at /opt/ghost-protocol/<commit> when that
# copy is intact: root's alone throughout, its COMMIT the commit, its files
# the commit's (from the fetched copy), its buzz-mcp build of the commit's
# pin, its dependencies there, and a node to run (its own, or a root-owned
# one). Then nothing is put together again (no npm ci). Sets KS_REUSE, or
# says why not.
ks_check_reuse() {
    local d="$KS_OPT/$KS_COMMIT" x="$GP_WORK/reuse-$KS_COMMIT" p why=""
    KS_REUSE=0
    if [ "$(tr -d '[:space:]' <"$d/COMMIT" 2>/dev/null)" != "$KS_COMMIT" ]; then why="its COMMIT file is not $KS_COMMIT"
    elif ! ks_root_only "$d" || [ -n "$(ks_not_root_under "$d")" ]; then why="it is not root's alone"
    elif [ "$(tr -d '[:space:]' <"$d/buzz-mcp/buzz-mcp.commit" 2>/dev/null)" != "$KS_PIN" ] || [ ! -f "$d/buzz-mcp/buzz-mcp.mjs" ]; then
        why="its buzz-mcp build is not of the pin $KS_PIN"
    elif [ ! -f "$d/adapters/buzz/node_modules/nostr-tools/package.json" ] \
        || [ ! -f "$d/adapters/buzz/node_modules/@modelcontextprotocol/sdk/package.json" ]; then why="its dependencies are missing"
    else
        rm -rf "$x"; mkdir -p "$x"
        if ! ks_extract "$x"; then why="the commit's files could not be taken out of the fetched copy"
        else
            for p in $KS_TRACKED; do
                diff -r "$x/$p" "$d/$p" >/dev/null 2>&1 || { why="$p differs from the commit's"; break; }
            done
        fi
        rm -rf "$x"
    fi
    if [ -n "$why" ]; then say "the copy at $d is not reused ($why): it is put together again"; return 0; fi
    KS_REUSE=1
}

# The root-owned code, put together as the admin first, in GP_WORK.
ks_stage() {
    local d="$GP_WORK/code-$KS_COMMIT"
    KS_STAGE="$d"
    rm -rf "$d"; mkdir -p "$d"
    if ! ks_extract "$d"; then KS_WHY="could not take commit $KS_COMMIT's files out of the fetched copy"; return 1; fi
    if ! command -v npm >/dev/null 2>&1; then KS_WHY="npm is missing (the adapter's dependencies come from its lockfile)"; return 1; fi
    if ! (cd "$d/adapters/buzz" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error </dev/null >&2); then
        KS_WHY="npm ci failed in the copy of the adapter"; return 1
    fi
    if [ ! -f "$d/adapters/buzz/node_modules/nostr-tools/package.json" ] \
        || [ ! -f "$d/adapters/buzz/node_modules/@modelcontextprotocol/sdk/package.json" ]; then
        KS_WHY="the adapter's dependencies are missing after npm ci"; return 1
    fi
    mkdir -p "$d/buzz-mcp"
    if ! { cp "$KS_BUZZ_MCP_SRC" "$d/buzz-mcp/buzz-mcp.mjs" && printf '%s\n' "$KS_PIN" >"$d/buzz-mcp/buzz-mcp.commit"; }; then
        KS_WHY="could not copy buzz-mcp"; return 1
    fi
    if [ "$KS_NODE_COPY" = 1 ]; then
        if ! { mkdir -p "$d/bin" && cp "$KS_NODE_SRC" "$d/bin/node" && chmod 0755 "$d/bin/node"; }; then
            KS_WHY="could not copy node"; return 1
        fi
    fi
    if ! printf '%s\n' "$KS_COMMIT" >"$d/COMMIT" 2>/dev/null; then KS_WHY="could not write $d/COMMIT"; return 1; fi
    if ! chmod -R u+rwX,go-w,go+rX "$d"; then KS_WHY="could not set the modes of the files in $d"; return 1; fi
}

# Puts the copy at /opt/ghost-protocol/<commit>, root-owned, in one step.
ks_install_code() {
    local dest="$KS_OPT/$KS_COMMIT" new="$KS_OPT/.new-$KS_COMMIT" old="$KS_OPT/.old-$KS_COMMIT"
    if [ -f "$dest/COMMIT" ] && diff -rq "$KS_STAGE" "$dest" >/dev/null 2>&1; then
        say "$dest is already this copy"
        return 0
    fi
    say "copying the key service's code to $dest (root-owned)"
    ks_root install -d -m 0755 "$KS_OPT" || { KS_WHY="${KS_WHY:-a root step failed while putting the code in place}"; return 1; }
    ks_root rm -rf "$new" "$old" || { KS_WHY="${KS_WHY:-a root step failed while putting the code in place}"; return 1; }
    ks_root cp -R "$KS_STAGE" "$new" || { KS_WHY="${KS_WHY:-a root step failed while putting the code in place}"; return 1; }
    ks_root chown -R root:root "$new" || { KS_WHY="${KS_WHY:-a root step failed while putting the code in place}"; return 1; }
    ks_root chmod -R u+rwX,go-w,go+rX "$new" || { KS_WHY="${KS_WHY:-a root step failed while putting the code in place}"; return 1; }
    if [ -d "$dest" ]; then ks_root mv "$dest" "$old" || { KS_WHY="${KS_WHY:-a root step failed while putting the code in place}"; return 1; }; fi
    ks_root mv "$new" "$dest" || { KS_WHY="${KS_WHY:-a root step failed while putting the code in place}"; return 1; }
    ks_root rm -rf "$old" || warn "could not remove $old"
    KS_CHANGED=1
}

# ---------------------------------------------------------------- the units

ks_tag_line() {
    if [ -n "$KS_TAG_FILE" ] || [ -f "$KS_ETC/auth-tag.json" ]; then
        printf 'LoadCredential=buzz-auth-tag:%s/auth-tag.json' "$KS_ETC"
    fi
}

ks_render() {   # template dest
    local v
    for v in "$KS_NAME" "$KS_AGENT_GROUP" "$KS_KEY_USER" "$KS_GH_USER" "$KS_NODE" "$KS_OPT/$KS_COMMIT" "$KS_ETC" "$KS_RUN" "$KS_SRV" "$KS_STATE"; do
        case "$v" in *[!A-Za-z0-9._/-]*|'') echo "a value for the units holds characters a unit line cannot carry unquoted: $v" >&2; return 1 ;; esac
    done
    KSR_NAME="$KS_NAME" KSR_AGENT_GROUP="$KS_AGENT_GROUP" KSR_KEY_USER="$KS_KEY_USER" KSR_GH_USER="$KS_GH_USER" KSR_NODE="$KS_NODE" \
    KSR_CODE="$KS_OPT/$KS_COMMIT" KSR_ETC="$KS_ETC" KSR_RUN="$KS_RUN" KSR_SRV="$KS_SRV" KSR_STATE="$KS_STATE" \
    KSR_COMMIT="$KS_COMMIT" KSR_TAG="$(ks_tag_line)" \
    awk '
        $0 == "@TAG_CREDENTIAL@" { if (ENVIRON["KSR_TAG"] != "") print ENVIRON["KSR_TAG"]; next }
        {
            line = $0
            gsub(/@NAME@/, ENVIRON["KSR_NAME"], line); gsub(/@AGENT_GROUP@/, ENVIRON["KSR_AGENT_GROUP"], line)
            gsub(/@KEY_USER@/, ENVIRON["KSR_KEY_USER"], line); gsub(/@NODE@/, ENVIRON["KSR_NODE"], line)
            gsub(/@GH_USER@/, ENVIRON["KSR_GH_USER"], line)
            gsub(/@CODE@/, ENVIRON["KSR_CODE"], line); gsub(/@ETC@/, ENVIRON["KSR_ETC"], line)
            gsub(/@RUN@/, ENVIRON["KSR_RUN"], line); gsub(/@SRV@/, ENVIRON["KSR_SRV"], line)
            gsub(/@STATE@/, ENVIRON["KSR_STATE"], line); gsub(/@COMMIT@/, ENVIRON["KSR_COMMIT"], line)
            print line
        }' "$1" >"$2" || return 1
    ! grep -q '@[A-Z_]*@' "$2"
}

ks_render_units() {
    local t
    KS_UNITS_WORK="$GP_WORK/units"
    rm -rf "$KS_UNITS_WORK"; mkdir -p "$KS_UNITS_WORK"
    for t in $(ks_templates); do
        ks_render "$KS_TEMPLATES/$t" "$KS_UNITS_WORK/$(ks_unit_name "$t")" || return 1
    done
}

# ---------------------------------------------------------------- the files

# The root-owned copy's keyfile.mjs, as root, in a clean environment, on the
# instance's key file: write (the key on this script's stdin), generate or
# pubkey. It prints the public key only. (A test passes its stand-ins' state.)
ks_keyfile() {   # write|generate|pubkey
    local t=""
    [ "${GP_TEST:-}" = 1 ] && t="STUB_STATE=${STUB_STATE:-}"
    as_root env -i PATH=/usr/bin:/bin ${t:+"$t"} "$KS_NODE" --disable-sigusr1 \
        "$KS_OPT/$KS_COMMIT/adapters/buzz/src/keyfile.mjs" "$1" "$KS_ETC/buzz-key"
}

# A folder with an exact owner and mode, never through a link.
ks_folder() {   # path mode owner:group
    if [ -L "$1" ]; then KS_WHY="$1 is a link; refusing to use it"; return 1; fi
    ks_root install -d -m "$2" "$1" && ks_root chown "$3" "$1" && ks_root chmod "$2" "$1"
}

ks_write_files() {
    local f
    ks_root install -d -m 0755 "${KS_ETC%/*}" "$KS_ETC" || { KS_WHY="could not make $KS_ETC"; return 1; }
    ks_render_env "$GP_WORK/buzz.env" || { KS_WHY="could not write the settings to $GP_WORK/buzz.env"; return 1; }
    if ! cmp -s "$GP_WORK/buzz.env" "$KS_ETC/buzz.env"; then
        say "writing $KS_ETC/buzz.env"
        ks_root install -m 0644 "$GP_WORK/buzz.env" "$KS_ETC/buzz.env" || { KS_WHY="could not write $KS_ETC/buzz.env"; return 1; }
        KS_CHANGED=1
    fi
    if [ -n "$KS_TAG_FILE" ] && ! cmp -s "$KS_TAG_FILE" "$KS_ETC/auth-tag.json"; then
        say "writing $KS_ETC/auth-tag.json"
        ks_root install -m 0644 "$KS_TAG_FILE" "$KS_ETC/auth-tag.json" || { KS_WHY="could not write the tag"; return 1; }
        KS_CHANGED=1
    fi
    # The key, written by the root-owned copy's keyfile.mjs, as root. Its
    # stdin is this script's (--key-from-stdin): never a variable here.
    f="$KS_ETC/buzz-key"
    case "${KS_KEY_MODE:-}" in
        stdin)
            say "writing the key to $f (0400, root), from stdin"
            KS_PUBKEY="$(ks_keyfile write)" || { KS_WHY="the key was not written (keyfile.mjs said why, above)"; return 1; }
            KS_CHANGED=1 ;;
        generate)
            say "making a new key in $f (0400, root)"
            KS_PUBKEY="$(ks_keyfile generate </dev/null)" || { KS_WHY="the key was not made (keyfile.mjs said why, above)"; return 1; }
            KS_CHANGED=1 ;;
        *)
            KS_PUBKEY="$(ks_keyfile pubkey </dev/null)" || { KS_WHY="the key file $f could not be read (keyfile.mjs said why, above)"; return 1; } ;;
    esac
    [[ $KS_PUBKEY =~ $KS_RE_HEX64 ]] || { KS_WHY="the key file gave no public key"; return 1; }
    ks_root chmod 0400 "$f" || { KS_WHY="could not set $f to 0400"; return 1; }
    # The folders the session and the key's user share.
    ks_root install -d -m 0755 "${KS_SRV%/*}" || { KS_WHY="could not make ${KS_SRV%/*}"; return 1; }
    ks_folder "$KS_SRV" 0711 root:root || { KS_WHY="could not set up $KS_SRV"; return 1; }
    ks_folder "$KS_SRV/outbox" 2770 "$KS_AGENT:$KS_KEY_USER" || { KS_WHY="could not set up $KS_SRV/outbox"; return 1; }
    ks_folder "$KS_SRV/files" 2750 "$KS_KEY_USER:$KS_AGENT_GROUP" || { KS_WHY="could not set up $KS_SRV/files"; return 1; }
    ks_folder "$KS_SRV/media" 2750 "$KS_KEY_USER:$KS_AGENT_GROUP" || { KS_WHY="could not set up $KS_SRV/media"; return 1; }
}

ks_write_units() {
    local f n
    for f in "$KS_UNITS_WORK"/*; do
        n="${f##*/}"
        cmp -s "$f" "$KS_UNITDIR/$n" && continue
        say "writing $KS_UNITDIR/$n"
        ks_root install -m 0644 "$f" "$KS_UNITDIR/$n" || { KS_WHY="could not write $KS_UNITDIR/$n"; return 1; }
        # A GitHub unit restarts only the GitHub socket (ks_restart_github).
        case "$n" in "gp-key-$KS_NAME-github"*) KS_GH_CHANGED=1 ;; *) KS_CHANGED=1 ;; esac
    done
    ks_root systemctl daemon-reload || { KS_WHY="systemctl daemon-reload failed"; return 1; }
}

# After writing: the agent user (and the key's user) must not read the key,
# and the agent user must not write the code, the settings, the tag or the
# allowlist. Each is asked as that user (runuser), so it is the kernel's
# answer. And everything installed is root's alone: every file and folder of
# the code, the settings folder and its files, the shared folders' parent,
# the units, node, and every folder above them (an existing
# /opt/ghost-protocol, /etc/ghost-protocol or /srv/ghost-protocol keeps its
# owner through install -d). And systemd loads each unit as written, with no
# drop-in that changes it (ks_check_loaded).
ks_verify() {
    local u p bad=0 n gh_key="" gh_user=""
    [ "$KS_GH" = 0 ] || { gh_key="$KS_ETC/github-app.pem"; gh_user="$KS_GH_USER"; }
    # The GitHub App key's user too: it gets its key only as the descriptor
    # systemd opens, and never reads the relay key.
    for u in "$KS_AGENT" "$KS_KEY_USER" ${gh_user:+"$gh_user"}; do
        for p in "$KS_ETC/buzz-key" ${gh_key:+"$gh_key"}; do
            if ks_root runuser -u "$u" -- test -r "$p" >/dev/null 2>&1; then
                warn "$u can read the key file $p"; bad=1
            fi
        done
    done
    for p in "$KS_OPT/$KS_COMMIT" "$KS_OPT/$KS_COMMIT/adapters/buzz/src/launch.mjs" "$KS_OPT/$KS_COMMIT/$KS_GH_CODE" "$KS_NODE" \
             "$KS_OPT/$KS_COMMIT/buzz-mcp/buzz-mcp.mjs" "$KS_ETC" "$KS_ETC/buzz.env" "$KS_ETC/auth-tag.json" "$KS_ETC/github.conf" "$KS_ETC/public-text.json" \
             "$KS_SRV" "$KS_SRV/files" ${KS_ALLOWLIST:+"$KS_ALLOWLIST"}; do
        [ -e "$p" ] || continue
        if ks_root runuser -u "$KS_AGENT" -- test -w "$p" >/dev/null 2>&1; then
            warn "$KS_AGENT can write $p"; bad=1
        fi
    done
    for p in "$KS_OPT/$KS_COMMIT" "$KS_ETC" "$KS_SRV" "$KS_UNITDIR" "$KS_NODE" ${KS_ALLOWLIST:+"$KS_ALLOWLIST"}; do
        if ! ks_root_only "$p"; then warn "$p, or a folder above it, is not root's alone (owned by root, writable by no group or others)"; bad=1; fi
    done
    n="$(ks_not_root_under "$KS_OPT/$KS_COMMIT")"
    [ -z "$n" ] || { warn "$n is not root's alone (owned by root, writable by no group or others)"; bad=1; }
    n="$(find "$KS_ETC" "$KS_UNITDIR" -maxdepth 1 \( -path "$KS_ETC/*" -o -name "gp-key-$KS_NAME-*" \) ! -type l \
        \( ! -uid "$KS_ROOT_UID" -o -perm /022 \) -print 2>/dev/null | head -n 1)"
    [ -z "$n" ] || { warn "$n is not root's alone (owned by root, writable by no group or others)"; bad=1; }
    if [ -n "$KS_ALLOWLIST" ] && ! ks_root runuser -u "$KS_KEY_USER" -- test -r "$KS_ALLOWLIST" >/dev/null 2>&1; then
        warn "$KS_KEY_USER cannot read the allowlist $KS_ALLOWLIST: the channel lets nobody in from it until it can (make it readable, for example 0644)"
    fi
    ks_check_loaded || bad=1
    [ "$bad" = 0 ]
}

# ---------------------------------------------------------------- what systemd loads

# What a drop-in may set in the key service's units: limits, timeouts,
# restarts, scheduling and logging. Nothing about who runs it, what it runs or
# is handed, what it can reach or where it listens: any other key in a
# drop-in's [Service], [Socket] or [Path] is refused, and so is
# JoinsNamespaceOf= in [Unit] (it shares another unit's /tmp). The rest of
# [Unit], and [Install], are free.
KS_DROPIN_OK=" TimeoutSec TimeoutStartSec TimeoutStopSec TimeoutAbortSec TimeoutStartFailureMode TimeoutStopFailureMode
 RuntimeMaxSec RuntimeRandomizedExtraSec WatchdogSec WatchdogSignal Restart RestartSec RestartSteps RestartMaxDelaySec
 SuccessExitStatus RestartPreventExitStatus RestartForceExitStatus KillMode KillSignal RestartKillSignal FinalKillSignal
 SendSIGKILL SendSIGHUP OOMPolicy OOMScoreAdjust Nice CPUSchedulingPolicy CPUSchedulingPriority CPUSchedulingResetOnFork
 CPUAffinity NUMAPolicy NUMAMask IOSchedulingClass IOSchedulingPriority TimerSlackNSec Slice CPUAccounting CPUWeight
 StartupCPUWeight CPUQuota CPUQuotaPeriodSec AllowedCPUs StartupAllowedCPUs AllowedMemoryNodes StartupAllowedMemoryNodes
 MemoryAccounting MemoryMin MemoryLow MemoryHigh MemoryMax MemorySwapMax MemoryZSwapMax TasksAccounting TasksMax
 IOAccounting IOWeight StartupIOWeight ManagedOOMSwap ManagedOOMMemoryPressure ManagedOOMMemoryPressureLimit
 ManagedOOMPreference LimitCPU LimitFSIZE LimitDATA LimitSTACK LimitRSS LimitNOFILE LimitAS LimitNPROC LimitMEMLOCK
 LimitLOCKS LimitSIGPENDING LimitMSGQUEUE LimitNICE LimitRTPRIO LimitRTTIME LogLevelMax LogRateLimitIntervalSec
 LogRateLimitBurst SyslogIdentifier SyslogLevel SyslogFacility SyslogLevelPrefix Backlog ReceiveBuffer SendBuffer
 PipeSize KeepAlive KeepAliveTimeSec KeepAliveIntervalSec KeepAliveProbes NoDelay Priority DeferAcceptSec
 PollLimitIntervalSec PollLimitBurst TriggerLimitIntervalSec TriggerLimitBurst "

# Each unit as systemd loads it, which is what runs: from the file this setup
# wrote (not one in a folder systemd reads before /etc/systemd/system), read
# since it last changed, and with no drop-in, wherever systemd finds it
# (/etc, /run or /usr/lib, the unit's own .d folder or a gp-key-<name>-…d
# prefix folder), that sets a key KS_DROPIN_OK does not list. systemd's own
# answer, asked for an instance name for each template, since a template
# itself cannot be shown: systemctl show for where it loads the unit from,
# systemctl cat (as root) for the unit and its drop-ins as systemd lists and
# reads them, never a list split here. A drop-in it cannot read fails, and so
# does one this check cannot read as systemd does: a section header it does
# not know (any line that starts with [), a key outside [Unit], [Service],
# [Socket], [Path] or [Install], a control character, or a byte-order mark
# systemd keeps.
ks_check_loaded() {
    local f n shown frag text line file section key ins bad=0
    for f in "$KS_UNITS_WORK"/*; do
        n="${f##*/}"; shown="${n/@./@verify.}"
        frag="$(systemctl show -p FragmentPath --value "$shown" 2>/dev/null)"
        if [ "$frag" != "$KS_UNITDIR/$n" ]; then
            warn "systemd loads $n from ${frag:-no file}, not from $KS_UNITDIR/$n: remove that file, then systemctl daemon-reload"
            bad=1; continue
        fi
        if [ "$(systemctl show -p NeedDaemonReload --value "$shown" 2>/dev/null)" != no ]; then
            warn "systemd has not read $n or its drop-ins since they changed: systemctl daemon-reload, then run this again"
            bad=1
        fi
        ins="its drop-ins, as root: systemctl cat '$shown'"
        if ! text="$(set -o pipefail; ks_root env SYSTEMD_COLORS=0 SYSTEMD_URLIFY=0 systemctl cat --no-pager -- "$shown" 2>/dev/null \
                | LC_ALL=C tr '\000' '\001' | ks_dropin_part "$f" "$KS_UNITDIR/$n" | ks_unit_lines --markers)"; then
            warn "could not read $n and its drop-ins as systemd loads them (systemctl cat, as root), or it did not show $KS_UNITDIR/$n as this setup writes it, so its drop-ins could not be checked ($ins)"
            bad=1; continue
        fi
        file="a drop-in"; section=""
        while IFS= read -r line; do
            case "$line" in
                $'\002'*) file="the drop-in ${line#?}"; section=""; continue ;;
                "$KS_UNREADABLE")
                    warn "$file of $n holds a control character or a second byte-order mark, so this check cannot tell how systemd reads it: write it as plain text, then systemctl daemon-reload ($ins)"
                    bad=1; continue ;;
                "[Unit]"|"[Service]"|"[Socket]"|"[Path]"|"[Install]") section="${line#[}"; section="${section%]}"; continue ;;
                "["*)
                    warn "$file of $n has a section header this check does not know, $line: name only [Unit], [Service], [Socket], [Path] or [Install], each alone on its line, then systemctl daemon-reload ($ins)"
                    bad=1; section="?"; continue ;;
                *=*) key="${line%%=*}" ;;
                *) continue ;;
            esac
            case "$section" in
                Service|Socket|Path) case "$KS_DROPIN_OK" in *[[:space:]]"$key"[[:space:]]*) continue ;; esac ;;
                Unit) [ "$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')" = joinsnamespaceof ] || continue ;;
                Install) continue ;;
                "?") continue ;;
                *)
                    warn "$file of $n sets $key= before any section header: put it under one, or remove it, then systemctl daemon-reload ($ins)"
                    bad=1; continue ;;
            esac
            warn "$file sets $key= in [$section] of $n. A drop-in may change only the key service's limits, timeouts, restarts and logging, never who runs it, what it runs or is handed, what it can reach or where it listens: remove it, then systemctl daemon-reload"
            bad=1
        done <<EOF
$text
EOF
    done
    [ "$bad" = 0 ]
}

# ---------------------------------------------------------------- the sockets answer

# One real connection to the socket <channel|buzz-mcp>, as the agent user,
# with the root-owned node and code: an MCP initialize, which the key service
# must answer (launch.mjs probe). It never finishes the handshake, so a
# probed channel never reaches the relay. It prints one line, the server's
# name or why there was no answer; nothing the key service holds.
ks_probe() {   # channel|buzz-mcp
    local t=""
    [ "${GP_TEST:-}" = 1 ] && t="STUB_STATE=${STUB_STATE:-}"
    ks_root runuser -u "$KS_AGENT" -- env -i PATH=/usr/bin:/bin ${t:+"$t"} BUZZ_KEY_SOCKET="$KS_RUN" \
        "$KS_NODE" --disable-sigusr1 "$KS_OPT/$KS_COMMIT/adapters/buzz/src/launch.mjs" probe "$1"
}
# Whether a session holds the channel's socket now. It takes one connection at
# a time, and systemd runs one gp-key-<name>-channel@<nr>-<pid>-<uid>.service
# instance for each, named after its peer. A running instance whose peer is
# alive (root sees it in /proc) is a session's. The socket's connection count
# (NConnections) is no proof either way: systemd 255 counts a connection
# until its instance is dead, so a probe that gave up, or a connection the
# channel dropped, is still counted though its peer is gone; and a
# daemon-reload sets the count to 0 while the connections it counted run on.
ks_channel_held() {
    local u pid
    while read -r u _; do
        case "$u" in "gp-key-$KS_NAME-channel@"*.service) ;; *) continue ;; esac
        pid="${u#*@}"; pid="${pid%.service}"
        [[ $pid =~ ^[0-9]+-([0-9]+)-[0-9]+$ ]] || continue
        ks_root test -d "/proc/${BASH_REMATCH[1]}" 2>/dev/null && return 0
    done <<EOF
$(systemctl list-units --plain --no-legend --state=running "gp-key-$KS_NAME-channel@*.service" 2>/dev/null)
EOF
    return 1
}
# Each socket answers one real connection. The channel's, which takes one
# connection at a time, is not probed while a session holds it
# (ks_channel_held): that shows the channel serves. A session can also connect
# between that look and the probe. Then the probe's connection is closed
# before an answer: by systemd at once (MaxConnections=1), or, when a
# daemon-reload has reset systemd's count, by the probe's own channel, which
# stops when it finds the session's lock. So only "closed the connection
# before answering", with a session holding the socket after it, counts as
# held, not failed. A probe that timed
# out, got an error, or an answer that is not a channel's fails, whatever
# holds the socket.
# Sets KS_ANSWERED to ok or fail (KS_WHY says why), so a caller knows the
# probe was made.
ks_answers() {
    local t out rc failed=""
    for t in channel buzz-mcp; do
        if [ "$t" = channel ] && ks_channel_held; then
            say "$KS_RUN/channel.sock is held by the session's connection (one at a time): not probed, it serves"
            continue
        fi
        out="$(ks_probe "$t" 2>&1 | head -n 5)"; rc=$?
        [ -n "$out" ] || out="probe: $KS_RUN/$t.sock: no answer, and nothing said why"
        say "$out"
        case "$out" in *" answered (server "*) [ "$rc" = 0 ] || failed="$failed $t"; continue ;; esac
        case "$t:$out" in
            "channel:"*"closed the connection before answering"*)
                if ks_channel_held; then
                    say "$KS_RUN/channel.sock is held now by the session's connection, which came in while it was probed (one at a time): it serves"
                    continue
                fi ;;
        esac
        failed="$failed $t"
    done
    if [ -n "$failed" ]; then
        KS_ANSWERED=fail
        KS_WHY="no answer on${failed} as $KS_AGENT, so the session would hear nothing. Its key units say why: journalctl -u 'gp-key-$KS_NAME-channel@*' -u 'gp-key-$KS_NAME-buzz-mcp@*'"
        return 1
    fi
    if [ "$KS_GIT" = 1 ]; then
        out="$(ks_git_probe 2>&1)"; rc=$?
        out="$(printf '%s\n' "$out" | head -n 3)"
        [ -n "$out" ] || out="probe: $KS_RUN/git.sock: no answer, and nothing said why"
        say "$out"
        case "$out" in
            *" answered (key $KS_PUBKEY)"*) [ "$rc" = 0 ] && [ -n "$KS_PUBKEY" ] || failed=" git" ;;
            *) failed=" git" ;;
        esac
        if [ -n "$failed" ]; then
            KS_ANSWERED=fail
            KS_WHY="the git socket did not answer as $KS_AGENT with the instance's public key ($KS_PUBKEY), so git could not sign in to the relay. Its unit says why: journalctl -u 'gp-key-$KS_NAME-git@*'"
            return 1
        fi
    fi
    KS_ANSWERED=ok
    return 0
}

# The listeners enabled and running, whatever an earlier run left: a run that
# stopped at its last check disabled them. Says whether it had to.
# Status 0: they were on already; 2: turned on now; 1: that failed (KS_WHY).
ks_listening() {
    local u off=0
    for u in $(ks_listeners); do
        { systemctl is-enabled --quiet "$u" && systemctl is-active --quiet "$u"; } 2>/dev/null || off=1
    done
    [ "$off" = 0 ] && return 0
    # shellcheck disable=SC2046  # three unit names
    ks_root systemctl enable --now $(ks_listeners) || { KS_WHY="systemctl enable --now $(ks_listeners)failed (see journalctl)"; return 1; }
    return 2
}

# The listeners off, the running connections ended, the listeners on again,
# one real connection to each socket (ks_answers), then the instance itself:
# a pipe cannot hand a running MCP session to a new server, so the whole
# instance starts again.
ks_restart() {
    local unit="$KS_NAME.service" gh="" git=""
    [ "$KS_GH" = 0 ] || gh="gp-key-$KS_NAME-github@*.service"
    [ "$KS_GIT" = 0 ] || git="gp-key-$KS_NAME-git@*.service"
    # shellcheck disable=SC2046  # three or four unit names, no spaces in them
    ks_root systemctl stop $(ks_listeners) || warn "could not stop the key service's listeners"
    ks_root systemctl stop "gp-key-$KS_NAME-channel@*.service" "gp-key-$KS_NAME-buzz-mcp@*.service" ${git:+"$git"} ${gh:+"$gh"} \
        || warn "could not stop the key service's open connections"
    # shellcheck disable=SC2046
    if ! ks_root systemctl start $(ks_listeners); then KS_WHY="could not start the key service's listeners again"; return 1; fi
    # Each socket answers, while the session's connections are closed: once
    # the instance is back, its own connection holds the channel.
    ks_answers || true
    if [ "$(systemctl show -p LoadState --value "$unit" 2>/dev/null)" != loaded ]; then
        say "$unit is not installed: restart instance $KS_NAME's session by hand, so it connects again"
        return 0
    fi
    if ! systemctl is-active --quiet "$unit" 2>/dev/null; then
        say "$unit is not running; it connects when it is started"
        return 0
    fi
    say "restarting $unit, so the session connects to the key service again"
    ks_root systemctl try-restart "$unit" || { KS_WHY="systemctl try-restart $unit failed"; return 1; }
    return 0
}

# ---------------------------------------------------------------- the git sign-in

# On when the commit has the git sign-in's code (and its helper).
ks_git_state() {
    KS_GIT=0
    [ -n "$KS_SRC_GIT" ] && [ -n "$KS_COMMIT" ] || return 0
    ks_src cat-file -e "$KS_COMMIT:$KS_GIT_CODE" 2>/dev/null && ks_src cat-file -e "$KS_COMMIT:$KS_GIT_HELPER" 2>/dev/null && KS_GIT=1
    return 0
}

# The session's side of the probe: the helper, as the agent user, asks the
# git socket for its key's public key (no sign-in is made). One line.
ks_git_probe() {
    local t=""
    [ "${GP_TEST:-}" = 1 ] && t="STUB_STATE=${STUB_STATE:-}"
    ks_root runuser -u "$KS_AGENT" -- env -i PATH=/usr/bin:/bin ${t:+"$t"} \
        "$KS_NODE" --disable-sigusr1 "$KS_OPT/$KS_COMMIT/$KS_GIT_HELPER" --socket "$KS_RUN/git.sock" probe
}

# The relay's git address from BUZZ_RELAY_URL in the settings:
# <https|http>://<host[:port]>, as git names it in its credential settings.
ks_git_origin() {
    local u s h
    u="$(printf '%s\n' "$KS_ENV_LINES" | sed -n 's/^BUZZ_RELAY_URL=//p' | head -n 1)"
    case "$u" in wss://*|https://*) s=https ;; ws://*|http://*) s=http ;; *) return 1 ;; esac
    h="${u#*://}"; h="${h%%/*}"; h="${h##*@}"
    [[ $h =~ ^[A-Za-z0-9.-]+(:[0-9]{1,5})?$ ]] || return 1
    # The scheme's own port is left out, as git leaves it out of the address.
    case "$s:$h" in https:*:443) h="${h%:443}" ;; http:*:80) h="${h%:80}" ;; esac
    printf '%s://%s' "$s" "$(printf '%s' "$h" | tr '[:upper:]' '[:lower:]')"
}

# git as the agent user, in a clean environment. Its callers name the agent
# user's own file (--file=<its home>/.gitconfig), never --global: this setup
# runs as the admin, whose own git settings it never touches.
ks_git_as_agent() {
    # -C the agent's home: git looks for a repository in the folder it starts
    # in, and the admin's own folder is one the agent user cannot read.
    ks_root runuser -u "$KS_AGENT" -- env -i HOME="$KS_AGENT_HOME" PATH=/usr/bin:/bin GIT_CONFIG_NOSYSTEM=1 git -C "$KS_AGENT_HOME" "$@"
}

# The agent user's git settings for the relay's address: an empty helper
# (so no helper set elsewhere answers for it), then the root-owned helper
# with the git socket, and useHttpPath (the sign-in names the repository).
# Nothing else in its git settings changes. Sets KS_GIT_CHANGED when it
# wrote, KS_GIT_ORIGIN, or KS_WHY.
ks_git_config() {
    local origin helper want cur
    KS_GIT_CHANGED=0
    origin="$(ks_git_origin)" || { KS_WHY="BUZZ_RELAY_URL gives no git address (https://<host> or http://<host>)"; return 1; }
    KS_GIT_ORIGIN="$origin"
    case "$KS_AGENT_HOME" in /*) ;; *) KS_WHY="the agent user $KS_AGENT has no home folder for its git settings"; return 1 ;; esac
    helper="!$KS_NODE --disable-sigusr1 $KS_OPT/$KS_COMMIT/$KS_GIT_HELPER --socket $KS_RUN/git.sock"
    want="$(printf '\n%s' "$helper")"
    cur="$(ks_git_as_agent config "--file=$KS_AGENT_HOME/.gitconfig" --get-all "credential.$origin.helper" 2>/dev/null)"
    if [ "$cur" != "$want" ]; then
        # Status 5: there was none to take away.
        ks_git_as_agent config "--file=$KS_AGENT_HOME/.gitconfig" --unset-all "credential.$origin.helper" >/dev/null 2>&1
        if ! ks_git_as_agent config "--file=$KS_AGENT_HOME/.gitconfig" --add "credential.$origin.helper" "" >/dev/null 2>&1 \
            || ! ks_git_as_agent config "--file=$KS_AGENT_HOME/.gitconfig" --add "credential.$origin.helper" "$helper" >/dev/null 2>&1; then
            KS_WHY="could not write credential.$origin.helper in $KS_AGENT's git settings ($KS_AGENT_HOME/.gitconfig)"; return 1
        fi
        KS_GIT_CHANGED=1
    fi
    local gv
    gv="$(ks_git_as_agent --version 2>/dev/null | sed -n 's/^git version \([0-9][0-9.]*\).*/\1/p')"
    if [ -n "$gv" ] && ! version_at_least "$gv" "${GIT_MIN_VERSION:-2.46}"; then
        warn "$KS_AGENT's git is $gv: the git sign-in needs ${GIT_MIN_VERSION:-2.46} or newer (capability[]=authtype); until then its git cannot sign in to the relay"
    fi
    if [ "$(ks_git_as_agent config "--file=$KS_AGENT_HOME/.gitconfig" --get "credential.$origin.useHttpPath" 2>/dev/null)" != true ]; then
        ks_git_as_agent config "--file=$KS_AGENT_HOME/.gitconfig" "credential.$origin.useHttpPath" true >/dev/null 2>&1 \
            || { KS_WHY="could not write credential.$origin.useHttpPath in $KS_AGENT's git settings"; return 1; }
        KS_GIT_CHANGED=1
    fi
    return 0
}

# A commit without the git sign-in (a rollback past its start): its units,
# if an earlier run installed them, stopped, disabled and taken away.
ks_drop_git_units() {
    local s n gone=0
    s="$(ks_unit_name key-git.socket)"
    for n in "$s" "$(ks_unit_name key-git@.service)"; do
        [ -e "$KS_UNITDIR/$n" ] || continue
        if [ "$gone" = 0 ]; then
            ks_root systemctl disable --now "$s" >/dev/null 2>&1 || warn "could not stop $s"
            ks_root systemctl stop "gp-key-$KS_NAME-git@*.service" >/dev/null 2>&1 || true
            gone=1
        fi
        say "removing $KS_UNITDIR/$n (this commit has no git sign-in)"
        ks_root rm -f "$KS_UNITDIR/$n" || { KS_WHY="could not remove $KS_UNITDIR/$n"; return 1; }
    done
    [ "$gone" = 0 ] || ks_root systemctl daemon-reload || { KS_WHY="systemctl daemon-reload failed"; return 1; }
    ks_git_unconfig
    return 0
}

# The agent user's git settings for the relay taken away again, but only when
# they are this setup's own (an empty helper, then the git sign-in's helper for
# this instance's socket): a helper someone else set is left as it is.
ks_git_unconfig() {
    local origin cur
    origin="$(ks_git_origin)" || return 0
    case "$KS_AGENT_HOME" in /*) ;; *) return 0 ;; esac
    cur="$(ks_git_as_agent config "--file=$KS_AGENT_HOME/.gitconfig" --get-all "credential.$origin.helper" 2>/dev/null)"
    case "$cur" in
        $'\n!'*"/$KS_GIT_HELPER --socket $KS_RUN/git.sock") ;;
        *) return 0 ;;
    esac
    say "taking the git sign-in out of $KS_AGENT's git settings for $origin (this commit has none)"
    ks_git_as_agent config "--file=$KS_AGENT_HOME/.gitconfig" --unset-all "credential.$origin.helper" >/dev/null 2>&1
    ks_git_as_agent config "--file=$KS_AGENT_HOME/.gitconfig" --unset-all "credential.$origin.useHttpPath" >/dev/null 2>&1
    return 0
}

# ---------------------------------------------------------------- the GitHub App slot

# Whether the slot is on: its key or its settings are there, or given.
ks_github_state() {
    KS_GH=0
    if [ -e "$KS_ETC/github-app.pem" ] || [ -L "$KS_ETC/github-app.pem" ] || [ -e "$KS_ETC/github.conf" ] \
        || [ -e "$KS_ETC/public-text.json" ] || [ -n "$KS_GH_KEY_MODE" ] || [ -n "$KS_GH_SETTINGS_OPT" ] || [ -n "$KS_GH_RULES_OPT" ]; then
        KS_GH=1
    fi
}

# One setting of github.conf, checked against what it may hold: the problem, or nothing.
ks_github_setting_problem() {   # key value
    local k="$1" v="$2" item seen=" " full n=0
    case "$k" in
        GITHUB_APP_CLIENT_ID)
            [[ $v =~ ^Iv[0-9A-Za-z.]{6,40}$ ]] || echo "GITHUB_APP_CLIENT_ID must be the App's client ID (Iv..., on its settings page)" ;;
        GITHUB_REVIEW_REPOS)
            case "$v" in ,*|*,|*,,*) echo "GITHUB_REVIEW_REPOS has an empty entry"; return ;; esac
            for item in ${v//,/ }; do
                n=$((n + 1))
                if ! [[ $item =~ ^[1-9][0-9]{0,11}:[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$ ]]; then
                    echo "GITHUB_REVIEW_REPOS must be <installation id>:<owner>/<repo>, comma-separated (not: $item)"; return
                fi
                case "${item##*/}" in .|..) echo "GITHUB_REVIEW_REPOS names a repo . or .."; return ;; esac
                full="$(printf '%s' "${item#*:}" | tr '[:upper:]' '[:lower:]')"
                case "$seen" in *" $full "*) echo "GITHUB_REVIEW_REPOS names $full twice"; return ;; esac
                seen="$seen$full "
            done
            [ "$n" -le 100 ] || echo "GITHUB_REVIEW_REPOS names more than 100 repos" ;;
        GITHUB_REVIEW_OWN_LOGINS|GITHUB_REVIEW_OWN_EMAILS)
            local re="$KS_RE_OWN_LOGIN" form="the App's bot login, <name>[bot]"
            if [ "$k" = GITHUB_REVIEW_OWN_EMAILS ]; then re="$KS_RE_OWN_EMAIL"; form="the App's bot noreply address, <id>+<name>[bot]@users.noreply.github.com"; fi
            [ -n "$v" ] || { echo "$k is empty: name the reviewer's own identities ($form)"; return; }
            case "$v" in ,*|*,|*,,*) echo "$k has an empty entry"; return ;; esac
            # Split on commas into an array and quote it: an identity holds [bot], which an unquoted
            # word would let the shell expand as a pattern against file names.
            local -a items=()
            IFS=',' read -r -a items <<<"$v"
            for item in "${items[@]}"; do
                n=$((n + 1))
                if ! [[ $item =~ $re ]]; then echo "$k must be $form, comma-separated (not: $item)"; return; fi
                full="$(printf '%s' "$item" | tr '[:upper:]' '[:lower:]')"
                case "$seen" in *" $full "*) echo "$k names $full twice"; return ;; esac
                seen="$seen$full "
            done
            [ "$n" -le 10 ] || echo "$k names more than 10 identities" ;;
        GITHUB_REVIEW_ALLOW_COMMENT)
            [[ $v =~ ^[01]$ ]] || echo "GITHUB_REVIEW_ALLOW_COMMENT must be 0 or 1" ;;
        GITHUB_REVIEW_PUBLIC_TEXT_FILE)
            # The setup's own line, in the github.conf it wrote: never a choice.
            [ "$v" = "$KS_ETC/public-text.json" ] || echo "GITHUB_REVIEW_PUBLIC_TEXT_FILE is the setup's own line ($KS_ETC/public-text.json): the rules come from --github-public-text" ;;
        *)
            echo "$k is not a GitHub App slot setting (one of: GITHUB_APP_CLIENT_ID GITHUB_REVIEW_REPOS GITHUB_REVIEW_OWN_LOGINS GITHUB_REVIEW_OWN_EMAILS GITHUB_REVIEW_ALLOW_COMMENT)" ;;
    esac
}

# Reads the slot's settings (KEY=value lines, # comments; no quotes) into
# KS_GH_LINES, in a fixed order. Problems go to ks_problem.
ks_read_github_settings() {   # file
    local f="$1" line k v n=0 p seen=" " re_line gh_client="" gh_repos="" gh_logins="" gh_emails="" gh_comment=0
    re_line="^[A-Z][A-Z0-9_]*=[^[:space:]'\"\\\\\$\`]*\$"
    if [ ! -f "$f" ]; then ks_problem "the GitHub settings file $f is not there"; return; fi
    if ! ks_take "$f" "the GitHub settings file" 65536 600; then ks_problem "$KS_WHY"; return; fi
    f="$KS_COPY"
    while IFS= read -r line || [ -n "$line" ]; do
        n=$((n + 1))
        line="${line%$'\r'}"
        case "$line" in ''|'#'*) continue ;; esac
        if ! [[ $line =~ $re_line ]]; then
            ks_problem "GitHub settings line $n is not KEY=value (no quotes, spaces, backslashes, \$ or backticks)"; continue
        fi
        k="${line%%=*}"; v="${line#*=}"
        case "$seen" in *" $k "*) ks_problem "GitHub settings line $n: $k appears twice"; continue ;; esac
        seen="$seen$k "
        p="$(ks_github_setting_problem "$k" "$v")"
        if [ -n "$p" ]; then ks_problem "GitHub settings line $n: $p"; continue; fi
        case "$k" in
            GITHUB_APP_CLIENT_ID) gh_client="$v" ;;
            GITHUB_REVIEW_REPOS) gh_repos="$v" ;;
            GITHUB_REVIEW_OWN_LOGINS) gh_logins="$v" ;;
            GITHUB_REVIEW_OWN_EMAILS) gh_emails="$v" ;;
            GITHUB_REVIEW_ALLOW_COMMENT) gh_comment="$v" ;;
        esac
    done <"$f"
    [ -n "$gh_client" ] || ks_problem "the GitHub settings must set GITHUB_APP_CLIENT_ID"
    [ -n "$gh_repos" ] || ks_problem "the GitHub settings must set GITHUB_REVIEW_REPOS (<installation id>:<owner>/<repo>, comma-separated): the repos the App may review"
    [ -n "$gh_logins" ] || ks_problem "the GitHub settings must set GITHUB_REVIEW_OWN_LOGINS (the App's bot login, <name>[bot]): the reviewer's own identities, which the own-pull-request and own-commit limits compare with"
    [ -n "$gh_emails" ] || ks_problem "the GitHub settings must set GITHUB_REVIEW_OWN_EMAILS (the App's bot noreply address, <id>+<name>[bot]@users.noreply.github.com): the reviewer's own commit addresses"
    KS_GH_LINES="GITHUB_APP_CLIENT_ID=$gh_client
GITHUB_REVIEW_REPOS=$gh_repos
GITHUB_REVIEW_OWN_LOGINS=$gh_logins
GITHUB_REVIEW_OWN_EMAILS=$gh_emails
GITHUB_REVIEW_ALLOW_COMMENT=$gh_comment
"
}

ks_render_github_conf() {   # dest
    {
        printf '# github.conf: the GitHub App slot of the Ghost Protocol instance %s, read by\n' "$KS_NAME"
        printf '# its GitHub unit (EnvironmentFile=): the App'"'"'s client ID, the repos it may\n'
        printf '# review, each with its installation, the reviewer'"'"'s own bot identities and\n'
        printf '# whether COMMENT is allowed, and where the public-text rules are. Made by\n'
        printf '# install/keyservice/setup; root-owned. It never holds the key, which is in\n'
        printf '# github-app.pem beside it.\n'
        printf '%s' "$KS_GH_LINES"
        printf 'GITHUB_REVIEW_PUBLIC_TEXT_FILE=%s\n' "$KS_ETC/public-text.json"
    } >"$1" 2>/dev/null
}

# The slot's checks, before anything changes (KS_GH=1 only): the commit has
# its code, its settings are there and well-formed, and its key is there, or
# given, never over one that is there unless replaced on purpose.
ks_check_github() {
    local f="$KS_ETC/github-app.pem"
    if [ -n "$KS_SRC_GIT" ] && [ -n "$KS_COMMIT" ] && ! ks_src cat-file -e "$KS_COMMIT:$KS_GH_CODE" 2>/dev/null; then
        ks_problem "commit $KS_COMMIT has no GitHub review code ($KS_GH_CODE), and this instance has the GitHub App slot: its GitHub unit would run nothing. Use a later commit, or take the slot away first (README: Undo)"
    fi
    if [ -n "$KS_GH_SETTINGS_OPT" ]; then ks_read_github_settings "$KS_GH_SETTINGS_OPT"
    elif [ -f "$KS_ETC/github.conf" ]; then ks_read_github_settings "$KS_ETC/github.conf"
    else ks_problem "no GitHub settings: the GitHub App slot needs --github-settings <file> the first time (GITHUB_APP_CLIENT_ID and GITHUB_REVIEW_REPOS)"; fi
    if [ -L "$f" ]; then ks_problem "$f is a link; refusing to use it"
    elif [ -e "$f" ]; then
        if [ "$KS_GH_KEY_MODE" = stdin ] && [ "$KS_GH_REPLACE" = 0 ]; then
            ks_problem "$f is already there, and it is replaced only on purpose: add --replace-github-app-key to swap it for the key on stdin (make the new key on GitHub first; delete the old one there after)"
        fi
    elif [ "$KS_GH_REPLACE" = 1 ]; then ks_problem "$f is not there: nothing to replace (leave out --replace-github-app-key)"
    elif [ -z "$KS_GH_KEY_MODE" ]; then ks_problem "no GitHub App key at $f: give it with --github-app-key-from-stdin"
    fi
    # The public-text rules: given, or the installed file kept. The root-owned
    # copy's code reads the file before it is installed (ks_write_github).
    local r="$KS_ETC/public-text.json"
    KS_GH_RULES_COPY=""
    if [ -n "$KS_GH_RULES_OPT" ]; then
        if ks_take "$KS_GH_RULES_OPT" "the public-text rules file" 262144 600; then KS_GH_RULES_COPY="$KS_COPY"; else ks_problem "$KS_WHY"; fi
    elif [ -L "$r" ]; then ks_problem "$r is a link; refusing to use it"
    elif [ ! -f "$r" ]; then
        ks_problem "no public-text rules at $r: the GitHub App slot needs --github-public-text <file> (a JSON list of {name, pattern}), the rules a review's body must pass in a repo that is not private"
    fi
}

# The root-owned copy's github-review.mjs, as root, in a clean environment, on
# the slot's key file: write or replace (the key on this script's stdin), or
# fingerprint. It prints fingerprints only.
ks_ghkey() {   # write|replace|fingerprint
    local t=""
    [ "${GP_TEST:-}" = 1 ] && t="STUB_STATE=${STUB_STATE:-}"
    as_root env -i PATH=/usr/bin:/bin ${t:+"$t"} "$KS_NODE" --disable-sigusr1 \
        "$KS_OPT/$KS_COMMIT/$KS_GH_CODE" keyfile "$1" "$KS_ETC/github-app.pem"
}

# The slot's files: github.conf (0644), and the key (0400), written from stdin
# or read back for its fingerprint. Sets KS_GH_FP (and KS_GH_FP_PREV after a
# replace), and KS_GH_CHANGED when something was written.
# The public-text rules file, as the root-owned copy's code reads it (it
# prints "rules <n>" or why it refuses the file).
ks_ghrules() {   # <path>
    local t=""
    [ "${GP_TEST:-}" = 1 ] && t="STUB_STATE=${STUB_STATE:-}"
    ks_root env -i PATH=/usr/bin:/bin ${t:+"$t"} "$KS_NODE" --disable-sigusr1 \
        "$KS_OPT/$KS_COMMIT/$KS_GH_CODE" rules check "$1"
}

ks_write_github() {
    local out rules="$KS_ETC/public-text.json"
    # The rules first, checked by the code that will read them: a bad file
    # never replaces a good one, and github.conf (which names the file) is
    # written after it.
    if [ -n "$KS_GH_RULES_COPY" ]; then
        out="$(ks_ghrules "$KS_GH_RULES_COPY" 2>&1)" || { KS_WHY="the public-text rules file was not installed ($out); the one there stays"; return 1; }
        say "the public-text rules: $out"
        if ! cmp -s "$KS_GH_RULES_COPY" "$rules"; then
            say "writing $rules"
            ks_root install -m 0644 "$KS_GH_RULES_COPY" "$rules" || { KS_WHY="could not write $rules"; return 1; }
            KS_GH_CHANGED=1
        fi
    else
        out="$(ks_ghrules "$rules" 2>&1)" || { KS_WHY="the public-text rules file $rules is refused by this commit's code ($out): give a new one with --github-public-text"; return 1; }
        say "the public-text rules: $out (the file there, kept)"
    fi
    ks_render_github_conf "$GP_WORK/github.conf" || { KS_WHY="could not write the GitHub settings to $GP_WORK/github.conf"; return 1; }
    if ! cmp -s "$GP_WORK/github.conf" "$KS_ETC/github.conf"; then
        say "writing $KS_ETC/github.conf"
        ks_root install -m 0644 "$GP_WORK/github.conf" "$KS_ETC/github.conf" || { KS_WHY="could not write $KS_ETC/github.conf"; return 1; }
        KS_GH_CHANGED=1
    fi
    case "$KS_GH_KEY_MODE:$KS_GH_REPLACE" in
        stdin:0)
            say "writing the GitHub App key to $KS_ETC/github-app.pem (0400, root), from stdin"
            out="$(ks_ghkey write)" || { KS_WHY="the GitHub App key was not written (github-review.mjs said why, above)"; return 1; }
            KS_GH_CHANGED=1 ;;
        stdin:1)
            say "swapping the GitHub App key in $KS_ETC/github-app.pem (0400, root) for the one on stdin"
            out="$(ks_ghkey replace)" || { KS_WHY="the GitHub App key was not swapped (github-review.mjs said why, above); the old one stays"; return 1; }
            KS_GH_CHANGED=1 ;;
        *)
            out="$(ks_ghkey fingerprint </dev/null)" || { KS_WHY="the GitHub App key $KS_ETC/github-app.pem could not be read (github-review.mjs said why, above)"; return 1; } ;;
    esac
    KS_GH_FP="$(printf '%s\n' "$out" | sed -n 's/^fingerprint //p' | head -n 1)"
    KS_GH_FP_PREV="$(printf '%s\n' "$out" | sed -n 's/^previous //p' | head -n 1)"
    [[ $KS_GH_FP =~ $KS_RE_FP ]] || { KS_WHY="the GitHub App key file gave no fingerprint"; return 1; }
    ks_root chmod 0400 "$KS_ETC/github-app.pem" || { KS_WHY="could not set $KS_ETC/github-app.pem to 0400"; return 1; }
}

# The slot's socket, as the agent user, with the root-owned node and code
# (github-review.mjs as the session's client): the key's fingerprint, which
# needs no network and must be the key's, then GitHub's answer for the App
# (GET /app with a JWT, made on the key's side, which also checks the App's
# client ID), unless --skip-github-check. Sets KS_GH_ANSWERED to ok, skip or
# fail (KS_WHY says why).
ks_github_probe() {   # fingerprint|app
    local t=""
    [ "${GP_TEST:-}" = 1 ] && t="STUB_STATE=${STUB_STATE:-}"
    ks_root runuser -u "$KS_AGENT" -- env -i PATH=/usr/bin:/bin ${t:+"$t"} \
        "$KS_NODE" --disable-sigusr1 "$KS_OPT/$KS_COMMIT/$KS_GH_CODE" --socket "$KS_RUN" "$1"
}
ks_github_answers() {
    local out rc
    KS_GH_ANSWERED=fail
    out="$(ks_github_probe fingerprint 2>&1 | head -n 3; exit "${PIPESTATUS[0]}")"; rc=$?
    say "$KS_RUN/github.sock: ${out:-no answer, and nothing said why}"
    if [ "$rc" != 0 ] || [ "$out" != "fingerprint $KS_GH_FP" ]; then
        KS_WHY="the GitHub socket did not answer as $KS_AGENT with the key's fingerprint ($KS_GH_FP). Its unit says why: journalctl -u 'gp-key-$KS_NAME-github@*'"
        return 1
    fi
    if [ "$KS_GH_SKIP_CHECK" = 1 ]; then KS_GH_ANSWERED=skip; return 0; fi
    out="$(ks_github_probe app 2>&1 | head -n 3; exit "${PIPESTATUS[0]}")"; rc=$?
    say "$KS_RUN/github.sock: ${out:-no answer, and nothing said why}"
    case "$out" in
        "app "*", key $KS_GH_FP")
            if [ "$rc" = 0 ]; then
                # The App GitHub knows must be one the settings call the reviewer's own, or the
                # own-pull-request and own-commit limits would not see its work (a typo turns them off).
                local slug want logins
                slug="${out#app }"; slug="${slug%% *}"
                want="$(printf '%s[bot]' "$slug" | tr '[:upper:]' '[:lower:]')"
                logins=",$(printf '%s' "$KS_GH_LINES" | sed -n 's/^GITHUB_REVIEW_OWN_LOGINS=//p' | tr '[:upper:]' '[:lower:]'),"
                case "$logins" in
                    *",$want,"*) KS_GH_ANSWERED=ok; return 0 ;;
                esac
                KS_WHY="GitHub knows this key as the App $slug, whose bot login is $want, and GITHUB_REVIEW_OWN_LOGINS does not name it: the own-pull-request and own-commit limits would not see this App's own work. Correct GITHUB_REVIEW_OWN_LOGINS and run again"
                return 1
            fi ;;
    esac
    KS_WHY="GitHub did not answer for the App as configured (the line above says why: a key GitHub does not know, another App's client ID, or no way to api.github.com). The unit's ledger: journalctl -u 'gp-key-$KS_NAME-github@*'"
    return 1
}

# Only the GitHub socket started again, when only the slot changed: its
# listener and open connections stopped, then the listener enabled and
# started. The session is never restarted for it.
ks_restart_github() {
    local s
    s="$(ks_unit_name key-github.socket)"
    ks_root systemctl stop "$s" "gp-key-$KS_NAME-github@*.service" || warn "could not stop the GitHub socket"
    ks_root systemctl enable --now "$s" || { KS_WHY="systemctl enable --now $s failed (see journalctl)"; return 1; }
}

# Removes the copies no instance runs or rolls back to: those named in no
# instance's commit or previous-commit file.
ks_prune() {
    local d c keep
    keep=" $(cat "${KS_ETC%/*}"/*/commit "${KS_ETC%/*}"/*/previous-commit 2>/dev/null | tr -d ' ' | tr '\n' ' ')"
    for d in "$KS_OPT"/*; do
        c="${d##*/}"
        [[ $c =~ $KS_RE_COMMIT ]] || continue
        case "$keep " in *" $c "*) continue ;; esac
        say "removing $d (no instance runs it, or rolls back to it)"
        ks_root rm -rf "$d" || warn "could not remove $d"
    done
}
