#!/usr/bin/env bash
# manifest.test.sh: the instance manifest check (install/schema/instance-v0.md)
# on good and bad fixtures, through the installer's own functions.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

GP_DIR="$SRC"
HOME="${HOME:-/nonexistent}"
# shellcheck source=../lib/common.sh
. "$SRC/install/lib/common.sh"
# shellcheck source=../lib/github.sh
. "$SRC/install/lib/github.sh"
# shellcheck source=../lib/instance.sh
. "$SRC/install/lib/instance.sh"

M="$FIX/manifests"
t_new

good() {   # file name
    if manifest_load "$1"; then ok "$2"; else bad "$2"; printf '%s' "$MANIFEST_ERRORS" | sed 's/^/      | /'; fi
}
rejects() {   # file name pattern
    if manifest_load "$1"; then
        bad "$2 (it was accepted)"
    elif printf '%s' "$MANIFEST_ERRORS" | grep -qE -- "$3"; then
        ok "$2"
    else
        bad "$2 (wrong message)"
        printf '%s' "$MANIFEST_ERRORS" | sed 's/^/      | /'
    fi
}

good "$M/good.toml" "good manifest is accepted"
check "good: name" [ "$M_NAME" = "instance" ]
check "good: dir" [ "$M_DIR" = \~/instance ]
check "good: github.login" [ "$M_GITHUB_LOGIN" = "example-bot" ]
check "good: github.host_config" [ "$M_GITHUB_HOST_CONFIG" = \~/.gitconfig-host ]
check "good: github.repos" [ "$M_GITHUB_REPOS" = "example/tools
" ]
check "good: claude.email" [ "$M_CLAUDE_EMAIL" = "agent@example.com" ]
check "good: setup.command" [ "$M_SETUP_COMMAND" = "setup.sh --profile {profile} --no-auth" ]
PROFILE=vm
check "good: {profile} is filled in" [ "$(setup_words)" = "setup.sh --profile vm --no-auth" ]

check "good (v0, dir ~/instance): a single folder, no root" [ -z "$M_ROOT_DIR" ] && [ -z "$M_ROOT_FROM" ]

good "$M/good-minimal.toml" "a manifest with only the required keys is accepted"
check "minimal: no dir" [ -z "$M_DIR" ]
check "minimal (v0, no dir): a single folder, no root" [ -z "$M_ROOT_DIR" ]

# Schema v1: a root and a name.
good "$M/good-v1.toml" "a v1 manifest is accepted"
check "v1: root" [ "$M_ROOT" = \~/work ]
check "v1: the root is expanded" [ "$M_ROOT_DIR" = "$HOME/work" ]
check "v1: the root comes from root" [ "$M_ROOT_FROM" = root ]
check "v1: no dir" [ -z "$M_DIR" ]

# A v0 dir of ~/<root>/<name> is read as v1 with that root.
good "$M/good-v0-under-root.toml" "a v0 manifest with dir ~/work/instance is accepted"
check "v0 dir ~/work/instance: read with root ~/work" [ "$M_ROOT" = \~/work ] && [ "$M_ROOT_DIR" = "$HOME/work" ]
check "v0 dir ~/work/instance: the root comes from dir" [ "$M_ROOT_FROM" = dir ]

rejects "$M/bad-unknown-key.toml"     "an unknown key is rejected"            'line 4: unknown key colour'
rejects "$M/bad-schema.toml"          "a wrong schema is rejected"            'schema must be "ghost-protocol/instance/v1"'
rejects "$M/bad-array.toml"           "a bad array (trailing comma) is rejected" 'github.repos must be an array of strings'
rejects "$M/bad-missing-login.toml"   "a missing github.login is rejected"    'missing github.login'
rejects "$M/bad-gitconfig.toml"       "host_config = ~/.gitconfig is rejected" "must not be git's global config"
rejects "$M/bad-gitconfig-dot.toml"   "host_config = ~/./.gitconfig is rejected" 'must not contain \. or \.\.'
rejects "$M/bad-gitconfig-dotdot.toml" "host_config with a .. segment is rejected" 'must not contain \. or \.\.'
rejects "$M/bad-gitconfig-empty-segment.toml" "host_config with an empty segment is rejected" 'must not contain \. or \.\.'
rejects "$M/bad-gitconfig-xdg.toml"   "host_config = ~/.config/git/config is rejected" "must not be git's global config"
rejects "$M/bad-gitconfig-upper.toml" "host_config = ~/.GITCONFIG is rejected (case-blind)" "must not be git's global config"
rejects "$M/bad-gitconfig-xdg-mixed.toml" "host_config = ~/.Config/Git/config is rejected (case-blind)" "must not be git's global config"
good "$M/good-also-login.toml" "a manifest with github.also_login is accepted"
check "also_login: parsed" [ "$M_GITHUB_ALSO_LOGIN" = "rehearsal-bot" ]
rejects "$M/bad-command.toml"         "a shell command in setup.command is rejected" 'setup.command may hold only'
rejects "$M/bad-section.toml"         "an unknown section is rejected"        'unknown section \[claud\]'
rejects "$M/bad-string.toml"          "an unquoted string is rejected"        'name must be one string in double quotes'
rejects "$M/bad-duplicate.toml"       "a repeated section is rejected"        'section \[github\] appears twice'
rejects "$T/none.toml"                "a missing file is rejected"            'no manifest at'

# A few more, made on the fly.
mk() { cat >"$T/m.toml"; }
mk <<'EOF'
schema = "ghost-protocol/instance/v0"
name = "instance"
[github]
login = "example-bot"
[claude]
email = "agent@example.com"
[setup]
command = "../outside/setup"
EOF
rejects "$T/m.toml" "a setup path outside the repo is rejected" 'must not leave the instance repo'
sed 's#^command = .*#command = "setup.sh --x {user}"#' "$T/m.toml" >"$T/m2.toml"
rejects "$T/m2.toml" "an unknown placeholder is rejected" 'the only placeholder is \{profile\}'
sed 's|^login = .*|login = "example-bot" # inline comment|' "$T/m.toml" >"$T/m3.toml"
rejects "$T/m3.toml" "an inline comment is rejected" 'github.login must be one string'
sed 's#^email = .*#email = "not-an-email"#' "$T/m.toml" >"$T/m4.toml"
rejects "$T/m4.toml" "a bad email is rejected" 'claude.email is not an email address'
printf 'schema = "ghost-protocol/instance/v0"\nname = "instance"\nlogin = "example-bot"\n' >"$T/m5.toml"
rejects "$T/m5.toml" "a key in the wrong section is rejected" 'unknown key login'
printf 'schema = "ghost-protocol/instance/v0"\n[github]\nrepos = ["a/b",\n  "c/d"]\n' >"$T/m6.toml"
rejects "$T/m6.toml" "a multi-line array is rejected" 'must be an array of strings|not a \[section\]'

# v1 and the root, made on the fly from good-v1.toml.
v1() {   # sed-expression name pattern
    sed "$1" "$M/good-v1.toml" >"$T/v1.toml"
    rejects "$T/v1.toml" "$2" "$3"
}
v1 '/^root = /d'                              "v1 without root is rejected"            'missing root'
awk '{ print } /^root = / { print "dir = \"~/work/instance\"" }' "$M/good-v1.toml" >"$T/v1dir.toml"
rejects "$T/v1dir.toml" "v1 with dir is rejected" 'dir is schema v0; v1 names root'
v1 's#^root = .*#root = "work"#'               "a relative root is rejected"            'root must start with ~/ or /'
v1 's#^root = .*#root = "~"#'                  "root ~ is rejected"                     'root must start with ~/ or /'
v1 's#^root = .*#root = "~/a b"#'              "a root with a space is rejected"        'root must start with ~/ or / and hold only'
v1 's#^root = .*#root = "~/a/../b"#'           "a root with .. is rejected"             'root must not contain \. or \.\.'
v1 's#^root = .*#root = "~/work/"#'            "a root ending in / is rejected"         'root must not contain'
home_real="$(cd "$HOME" && pwd -P)"
v1 "s#^root = .*#root = \"$home_real\"#"       "the home folder as root is rejected"    'not .* itself or above it'
v1 "s#^root = .*#root = \"${home_real%/*}\"#"  "a folder above the home folder is rejected" 'not .* itself or above it'
v1 's#^root = .*#root = "/"#'                  "/ as root is rejected"                  'root must start with ~/ or / and hold only|itself or above it'
v1 's#^name = .*#name = "repos"#'              "a name that is a layout folder is rejected" 'name must not be one of the layout'
sed 's#^schema = .*#schema = "ghost-protocol/instance/v0"#' "$M/good-v1.toml" >"$T/v0root.toml"
rejects "$T/v0root.toml" "root in a v0 manifest is rejected" 'root needs schema "ghost-protocol/instance/v1"'

# [memory_guard]: optional; both percentages or neither, digits only, kill
# below term, term at most 50; enabled is "true" or "false".
mg() {   # name pattern-or-"ok" line...
    local name="$1" want="$2"
    shift 2
    { cat "$M/good-v1.toml"; printf '\n[memory_guard]\n'; printf '%s\n' "$@"; } >"$T/mg.toml"
    if [ "$want" = ok ]; then good "$T/mg.toml" "$name"; else rejects "$T/mg.toml" "$name" "$want"; fi
}
good "$M/good-v1.toml" "no [memory_guard]: accepted"
check "no [memory_guard]: nothing set" [ -z "$M_MEMORY_GUARD_ENABLED$M_MEMORY_GUARD_TERM$M_MEMORY_GUARD_KILL" ]
mg "memory_guard 20/10 and enabled true: accepted" ok 'enabled = "true"' 'term_percent = "20"' 'kill_percent = "10"'
check "memory_guard: the values are read" \
    [ "$M_MEMORY_GUARD_ENABLED/$M_MEMORY_GUARD_TERM/$M_MEMORY_GUARD_KILL" = "true/20/10" ]
mg "memory_guard enabled false alone: accepted" ok 'enabled = "false"'
check "memory_guard enabled false: read" [ "$M_MEMORY_GUARD_ENABLED" = "false" ]
mg "memory_guard 50/1 (the limits): accepted" ok 'term_percent = "50"' 'kill_percent = "1"'
mg "memory_guard: term_percent alone is rejected"    'together, or neither' 'term_percent = "15"'
mg "memory_guard: kill_percent alone is rejected"    'together, or neither' 'kill_percent = "8"'
mg "memory_guard: kill equal to term is rejected"    'kill_percent must be below term_percent' 'term_percent = "10"' 'kill_percent = "10"'
mg "memory_guard: kill above term is rejected"       'kill_percent must be below term_percent' 'term_percent = "8"' 'kill_percent = "15"'
mg "memory_guard: term above 50 is rejected"         'term_percent must be at most 50' 'term_percent = "60"' 'kill_percent = "8"'
mg "memory_guard: a % sign is rejected"              'whole numbers from 1 to 99' 'term_percent = "15%"' 'kill_percent = "8"'
mg "memory_guard: a leading zero is rejected"        'whole numbers from 1 to 99' 'term_percent = "15"' 'kill_percent = "08"'
mg "memory_guard: zero is rejected"                  'whole numbers from 1 to 99' 'term_percent = "15"' 'kill_percent = "0"'
mg "memory_guard: a decimal is rejected"             'whole numbers from 1 to 99' 'term_percent = "15.5"' 'kill_percent = "8"'
mg "memory_guard: words after the number are rejected" 'whole numbers from 1 to 99' 'term_percent = "15 --dryrun"' 'kill_percent = "8"'
mg "memory_guard: an unquoted number is rejected"    'memory_guard.term_percent must be one string' 'term_percent = 15' 'kill_percent = "8"'
mg "memory_guard: enabled other than true/false is rejected" 'memory_guard.enabled must be "true" or "false"' 'enabled = "no"'
mg "memory_guard: an unknown key is rejected"        'unknown key memory_guard.kill_at' 'kill_at = "8"'

# [automode_guard]: optional; once on, snapshot, buzz_relay_url,
# buzz_key_command and buzz_channel are required; enabled = "false" alone
# turns it off. Syntax only: a snapshot that is not on disk is accepted.
ag() {   # name pattern-or-"ok" line...
    local name="$1" want="$2"
    shift 2
    { cat "$M/good-v1.toml"; printf '\n[automode_guard]\n'; printf '%s\n' "$@"; } >"$T/ag.toml"
    if [ "$want" = ok ]; then good "$T/ag.toml" "$name"; else rejects "$T/ag.toml" "$name" "$want"; fi
}
# A public key and a channel id, made here so no file holds one.
KEY="$(printf '%064d' 7)"
CHAN="0000aaaa-1111-2222-3333-444455556666"
AG_MIN=('snapshot = "config/automode.json"' 'buzz_relay_url = "https://relay.example.com"'
        'buzz_key_command = "op read op://vault/item/field"' "buzz_channel = \"$CHAN\"")
good "$M/good-v1.toml" "no [automode_guard]: accepted"
check "no [automode_guard]: nothing set" [ -z "$M_AUTOMODE_GUARD_SET$M_AUTOMODE_GUARD_SNAPSHOT" ]
ag "automode_guard with the four required keys: accepted" ok "${AG_MIN[@]}"
check "automode_guard: the values are read" \
    [ "$M_AUTOMODE_GUARD_SET|$M_AUTOMODE_GUARD_SNAPSHOT|$M_AUTOMODE_GUARD_RELAY_URL|$M_AUTOMODE_GUARD_KEY_COMMAND|$M_AUTOMODE_GUARD_CHANNEL" \
      = "1|config/automode.json|https://relay.example.com|op read op://vault/item/field|$CHAN" ]
ag "automode_guard with mentions and read paths: accepted" ok "${AG_MIN[@]}" \
    "buzz_mentions = [\"$KEY\"]" 'read_paths = ["~/.local/bin/op", "/opt/keys/key.sh"]' 'enabled = "true"'
check "automode_guard: the mentions are read" [ "$M_AUTOMODE_GUARD_MENTIONS" = "$KEY
" ]
# shellcheck disable=SC2088  # the manifest's ~/ is kept as written
check "automode_guard: the read paths are read" [ "$M_AUTOMODE_GUARD_READ_PATHS" = "~/.local/bin/op
/opt/keys/key.sh
" ]
ag "automode_guard: a wss:// relay with a port and path is accepted" ok 'snapshot = "a.json"' \
    'buzz_relay_url = "wss://relay.example.com:8443/r"' 'buzz_key_command = "bin/key"' "buzz_channel = \"$CHAN\""
ag "automode_guard enabled false alone: accepted (off)" ok 'enabled = "false"'
check "automode_guard enabled false: read" [ "$M_AUTOMODE_GUARD_SET/$M_AUTOMODE_GUARD_ENABLED" = "1/false" ]
ag "automode_guard: an empty array alone turns the section on" 'missing snapshot' 'read_paths = []'
ag "automode_guard: snapshot missing"        'automode_guard: missing snapshot' "${AG_MIN[@]:1}"
ag "automode_guard: buzz_relay_url missing"  'missing buzz_relay_url' "${AG_MIN[0]}" "${AG_MIN[2]}" "${AG_MIN[3]}"
ag "automode_guard: buzz_key_command missing" 'missing buzz_key_command' "${AG_MIN[0]}" "${AG_MIN[1]}" "${AG_MIN[3]}"
ag "automode_guard: buzz_channel missing"    'missing buzz_channel' "${AG_MIN[@]:0:3}"
ag "automode_guard: an absolute snapshot is rejected" 'snapshot must be a path inside the instance repo' \
    'snapshot = "/etc/automode.json"' "${AG_MIN[@]:1}"
ag "automode_guard: a snapshot with .. is rejected" 'must not contain . or .. segments' \
    'snapshot = "config/../../x.json"' "${AG_MIN[@]:1}"
ag "automode_guard: an http:// relay is rejected" 'buzz_relay_url must be https:// or wss://' \
    "${AG_MIN[0]}" 'buzz_relay_url = "http://relay.example.com"' "${AG_MIN[2]}" "${AG_MIN[3]}"
# shellcheck disable=SC2016  # the $ is the point: it must stay literal
ag "automode_guard: a key command with \$ is rejected" 'buzz_key_command may hold only words' \
    "${AG_MIN[0]}" "${AG_MIN[1]}" 'buzz_key_command = "op read $X"' "${AG_MIN[3]}"
ag "automode_guard: a key command with ; is rejected" 'buzz_key_command may hold only words' \
    "${AG_MIN[0]}" "${AG_MIN[1]}" 'buzz_key_command = "true; rm -rf x"' "${AG_MIN[3]}"
ag "automode_guard: a key command with % is rejected" 'buzz_key_command may hold only words' \
    "${AG_MIN[0]}" "${AG_MIN[1]}" 'buzz_key_command = "key %h"' "${AG_MIN[3]}"
ag "automode_guard: a channel that is not an id is rejected" 'buzz_channel must be a channel id' \
    "${AG_MIN[@]:0:3}" 'buzz_channel = "general"'
ag "automode_guard: an upper-case channel id is rejected" 'buzz_channel must be a channel id' \
    "${AG_MIN[@]:0:3}" 'buzz_channel = "0000AAAA-1111-2222-3333-444455556666"'
ag "automode_guard: a short mention is rejected" 'buzz_mentions: each must be a public key' \
    "${AG_MIN[@]}" 'buzz_mentions = ["abc"]'
ag "automode_guard: an npub mention is rejected" 'buzz_mentions: each must be a public key' \
    "${AG_MIN[@]}" 'buzz_mentions = ["npub1example"]'
ag "automode_guard: a relative read path is rejected" 'read_paths: each must start with ~/ or /' \
    "${AG_MIN[@]}" 'read_paths = ["bin/key"]'
ag "automode_guard: a read path with .. is rejected" 'read_paths: no . or .. or empty segments' \
    "${AG_MIN[@]}" 'read_paths = ["~/x/../.ssh"]'
ag "automode_guard: / as a read path is rejected" 'read_paths: each must start with ~/ or /' \
    "${AG_MIN[@]}" 'read_paths = ["/"]'
ag "automode_guard: a read path with a space is rejected" 'read_paths: each must start with ~/ or /' \
    "${AG_MIN[@]}" 'read_paths = ["~/my keys"]'
ag "automode_guard: enabled other than true/false is rejected" 'automode_guard.enabled must be "true" or "false"' \
    "${AG_MIN[@]}" 'enabled = "yes"'
ag "automode_guard: an unknown key is rejected" 'unknown key automode_guard.channel' "${AG_MIN[@]}" 'channel = "x"'
ag "automode_guard: an owner and a ledger are accepted" ok "${AG_MIN[@]}" "owner = \"$KEY\"" 'ledger = "~/.local/share/automode/LEDGER.md"'
check "automode_guard: the owner and the ledger are read" \
    [ "$M_AUTOMODE_GUARD_OWNER|$M_AUTOMODE_GUARD_LEDGER" = "$KEY|~/.local/share/automode/LEDGER.md" ]
ag "automode_guard: an absolute ledger is accepted" ok "${AG_MIN[@]}" 'ledger = "/srv/automode/LEDGER.md"'
ag "automode_guard: a short owner is rejected" 'automode_guard.owner must be a public key' "${AG_MIN[@]}" 'owner = "abc"'
ag "automode_guard: an npub owner is rejected" 'automode_guard.owner must be a public key' "${AG_MIN[@]}" 'owner = "npub1example"'
ag "automode_guard: a relative ledger is rejected" 'automode_guard.ledger must start with ~/ or /' "${AG_MIN[@]}" 'ledger = "LEDGER.md"'
ag "automode_guard: a ledger with .. is rejected" 'automode_guard.ledger: no . or .. or empty segments' \
    "${AG_MIN[@]}" 'ledger = "~/x/../.claude/settings.json"'
ag "automode_guard: a ledger with a trailing / is rejected" 'automode_guard.ledger: no . or .. or empty segments' \
    "${AG_MIN[@]}" 'ledger = "~/ledger/"'
ag "automode_guard: a string where an array belongs is rejected" 'automode_guard.read_paths must be an array' \
    "${AG_MIN[@]}" 'read_paths = "~/x"'
# Syntax only: a snapshot that is not there is accepted, so the hooks that read
# this manifest keep working; the install step reports it.
check "automode_guard: a snapshot not on disk is accepted (no disk check)" [ ! -e "$HOME/work/instance/config/automode.json" ]

# v0 manifests that stay single folders.
v0dir() {   # dir name
    sed "s#^dir = .*#dir = \"$1\"#" "$M/good.toml" >"$T/v0.toml"
    if manifest_load "$T/v0.toml" && [ -z "$M_ROOT_DIR" ]; then ok "$2"; else bad "$2"; fi
}
v0dir \~/work/other    "v0 dir whose last segment is not the name: a single folder"
v0dir "/srv/instance"   "v0 absolute dir: a single folder"
v0dir \~/instance      "v0 dir directly in the home folder: a single folder"

finish_tests
