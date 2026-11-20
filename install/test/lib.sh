# shellcheck shell=bash
# lib.sh: helpers for the installer tests, sourced by each *.test.sh.
#
# Every test runs in a sandbox $T made fresh by t_new:
#   $T/home     the HOME the scripts see
#   $T/state    stub behaviour files and the call log (outside HOME)
#   $T/stubs    stand-ins (gh, claude, curl, sudo), first on PATH; always git,
#               whose --version answers from $T/state/git.version (2.50.1)
#   $T/sysbin   links to the system tools the scripts need, and nothing else,
#               so a real gh, claude or curl can never run
#   $T/remote   local bare repos standing in for GitHub and the integration
# The scripts run under `env -i` with only the variables listed in t_env.
# git may use only file:// (GIT_ALLOW_PROTOCOL=file), so no test reaches the
# network; t_deploykey adds ssh, whose only program in the sandbox is the ssh
# stand-in. Stubs record call names and argument counts only.

TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SRC="$(cd "$TEST_DIR/../.." && pwd -P)"
FIX="$TEST_DIR/fixtures"
PASS=0
FAIL=0
T=""
OUT=""
RC=0
TTY_IN=""
T_PINS=""
T_GIT_ALLOW=""
SANDBOXES=""

ok()  { echo "PASS  $1"; PASS=$((PASS + 1)); }
bad() {
    echo "FAIL  $1"
    FAIL=$((FAIL + 1))
    if [ -n "$OUT" ] && [ -f "$OUT" ]; then
        echo "      --- last output ---"
        tail -n 30 "$OUT" | sed 's/^/      | /'
    fi
}
check() { local name="$1"; shift; if "$@"; then ok "$name"; else bad "$name"; fi; }
out_has()     { grep -qE -- "$1" "$OUT"; }
out_lacks()   { ! grep -qE -- "$1" "$OUT"; }
called()      { grep -q "^$1 " "$T/state/calls" 2>/dev/null; }
not_called()  { ! called "$1"; }
rc_is()       { [ "$RC" -eq "$1" ]; }

finish_tests() {
    echo
    echo "$PASS passed, $FAIL failed"
    [ "$FAIL" -eq 0 ]
}

cleanup_sandboxes() {
    local d
    for d in $SANDBOXES; do rm -rf "$d"; done
}
trap cleanup_sandboxes EXIT

sha_of() {
    if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
    else sha256sum "$1" | cut -d' ' -f1; fi
}

SYSTOOLS="bash sh env git awk sed grep cat cp mv rm mkdir rmdir mktemp chmod ln ls find sort uniq
cut tr head tail wc date uname id df tar gzip gunzip unzip zip shasum sha256sum perl dirname basename
readlink sleep touch dpkg-query xargs tee diff cmp stat xcode-select expr true false test printf ldd"

t_new() {
    local t d
    T="$(mktemp -d "${TMPDIR:-/tmp}/gp-test.XXXXXX")"
    T="$(cd "$T" && pwd -P)"
    SANDBOXES="$SANDBOXES $T"
    mkdir -p "$T/home" "$T/state" "$T/stubs" "$T/sysbin" "$T/remote" "$T/tmp"
    : >"$T/state/calls"
    for t in $SYSTOOLS; do
        for d in /usr/bin /bin /usr/sbin /sbin; do
            if [ -x "$d/$t" ]; then ln -s "$d/$t" "$T/sysbin/$t"; break; fi
        done
    done
    # git --version answers from the state file (fixtures/stubs/git), so no
    # test depends on the machine's git; a test may change it.
    t_stub git
    echo "2.50.1" >"$T/state/git.version"
    cat >"$T/gitconfig" <<EOF
[user]
	name = Test
	email = test@example.com
[init]
	defaultBranch = main
[advice]
	detachedHead = false
[protocol "file"]
	allow = always
[url "file://$T/remote/github/"]
	insteadOf = https://github.com/
EOF
    export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1
    OUT="$T/out.txt"
    RC=0
    TTY_IN=""
    T_PINS=""
    T_GIT_ALLOW=""
}

# deploykey mode: the ssh stand-in (fixtures/stubs/ssh) and the real
# ssh-keygen; git may use ssh, which only ever runs the stand-in. github.com
# shows its pinned ed25519 host key, and no deploy key is added yet. Returns 1
# when this machine has no ssh-keygen, so a test can say SKIP instead.
t_deploykey() {
    t_tool ssh-keygen || return 1
    t_stub ssh
    T_GIT_ALLOW="file:ssh"
    grep '^github\.com ssh-ed25519 ' "$SRC/install/github-known-hosts" >"$T/state/github-hostkey"
    : >"$T/state/deploykeys"
}

# Adds the deploy key at $1 (its .pub) to example/instance: $2 is rw or ro, $3
# the repo (default example/instance).
t_add_deploykey() {
    printf '%s %s %s\n' "$2" "${3:-example/instance}" "$(cut -d' ' -f1,2 "$1.pub")" >>"$T/state/deploykeys"
}

# The integration host answers too (as a local bare repo).
t_integration() {
    printf '[url "file://%s/remote/int/"]\n\tinsteadOf = https://github.int.exe.xyz/\n' "$T" >>"$T/gitconfig"
}

t_stub() { cp "$FIX/stubs/$1" "$T/stubs/$1"; chmod +x "$T/stubs/$1"; }

# One more system tool in the sandbox (for example jq). Returns 1 when this
# machine has none, so a test can say SKIP instead.
t_tool() {
    local d
    for d in /usr/bin /bin /usr/sbin /sbin; do
        if [ -x "$d/$1" ]; then ln -sf "$d/$1" "$T/sysbin/$1"; return 0; fi
    done
    return 1
}

pin_value() { sed -n "s/^$1=\"\\([^\"]*\\)\".*/\\1/p" "$SRC/install/pins.env"; }

# The usual world: gh installed and signed in as the manifest's login, Claude
# Code at the pin and signed in as the manifest's email, sudo present.
t_std_env() {
    t_stub gh
    t_stub curl
    t_stub sudo
    mkdir -p "$T/home/.local/bin"
    cp "$FIX/stubs/claude" "$T/home/.local/bin/claude"
    chmod +x "$T/home/.local/bin/claude"
    echo "$(pin_value CLAUDE_CODE_VERSION) (Claude Code)" >"$T/state/claude.version"
    echo "example-bot" >"$T/state/gh.login"
    echo "agent@example.com" >"$T/state/claude.email"
    touch "$T/state/gh.authed" "$T/state/claude.authed"
}

# A bare repo for example/instance holding the given manifest and a setup hook
# that records its calls. $2: github (default) or int.
t_make_instance() {
    local manifest="$1" where="${2:-github}" src="$T/src-instance"
    rm -rf "$src"
    mkdir -p "$src/.ghost-protocol"
    cp "$manifest" "$src/.ghost-protocol/instance.toml"
    cp "$FIX/instance-setup.sh" "$src/setup.sh"
    chmod +x "$src/setup.sh"
    git -C "$src" init -q
    git -C "$src" add -A
    git -C "$src" commit -q -m "instance fixture"
    mkdir -p "$T/remote/$where/example"
    rm -rf "$T/remote/$where/example/instance.git"
    git clone -q --bare "$src" "$T/remote/$where/example/instance.git"
}

# A new commit on the fixture remote (to prove an existing clone is not fetched).
t_advance_instance() {
    local src="$T/src-instance"
    echo "change" >>"$src/setup.sh"
    git -C "$src" commit -q -am "move main"
    git -C "$src" push -q "$T/remote/github/example/instance.git" HEAD:main
}

# An existing clone of the instance in HOME, as a person would have it.
t_clone_into_home() {
    git clone -q "https://github.com/example/instance.git" "$T/home/instance"
}

t_env() {
    env -i HOME="$T/home" PATH="$T/stubs:$T/sysbin" TMPDIR="$T/tmp" LANG=C LC_ALL=C \
        GP_TEST=1 STUB_STATE="$T/state" GP_PINS_FILE="${T_PINS:-}" \
        GP_TTY="${TTY_IN:-$T/no-terminal}" \
        GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_ALLOW_PROTOCOL="${T_GIT_ALLOW:-file}" \
        "$@"
}

t_install() {
    t_env "$SRC/install/install" "$@" >"$OUT" 2>&1
    RC=$?
}

# Lines typed at the fake terminal, one per argument.
t_tty() {
    TTY_IN="$T/tty"
    : >"$TTY_IN"
    local l
    for l in "$@"; do printf '%s\n' "$l" >>"$TTY_IN"; done
}

# A listing of HOME with the sha256 of every file and the target of every link.
t_snapshot() {
    (
        cd "$T/home" || exit 1
        find . -print | LC_ALL=C sort | while IFS= read -r p; do
            if [ -L "$p" ]; then printf 'L %s -> %s\n' "$p" "$(readlink "$p")"
            elif [ -f "$p" ]; then printf 'F %s %s\n' "$p" "$(sha_of "$p")"
            else printf 'D %s\n' "$p"; fi
        done
    )
}

# No private temp folder may be left behind in HOME.
no_temp_left() { [ -z "$(find "$T/home" -maxdepth 1 -name '.gp-*' -print)" ]; }

# t_claude_standin DIR [NAME]: a stand-in for a running claude, DIR/NAME
# (default claude), for the hooks that act only in the instance's own claude
# (hooks/lib/own-claude.sh). Its process name is NAME (/proc's comm is the
# script's name, so its first line is an absolute /bin/bash, not env bash).
# It runs its arguments as a child, never by exec, so it is their parent.
# With PANE_FILE set, it first writes its pid there, as install/service/start
# writes the pid of the pane's claude, and unsets it for what it runs.
t_claude_standin() {
    local f="$1/${2:-claude}"
    mkdir -p "$1"
    cat >"$f" <<'STANDIN'
#!/bin/bash
if [ -n "${PANE_FILE:-}" ]; then printf '%s\n' "$$" >"$PANE_FILE"; fi
unset PANE_FILE
"$@"
exit $?
STANDIN
    chmod +x "$f"
}
