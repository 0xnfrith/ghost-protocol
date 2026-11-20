#!/usr/bin/env bash
# git.test.sh: git 2.46 or newer, which clones of relay repos need.
#   - boot.sh, once its clone is there: on Ubuntu an older git is replaced from
#     the Git stable PPA, its signing key checked against the pinned
#     fingerprint first; an apt source already there is left alone; any other
#     Linux is told, and nothing changes. A test never gets past the key
#     check: with GP_TEST=1 boot.sh stops before apt, its as_root refuses
#     (also for a test run as root), and sudo is a stub that refuses. So the
#     writes themselves (the keyring, the source, the rollback after a failed
#     apt-get update, the version check after the install) are not run here;
#     the source's text is, through the dry run.
#   - the installer's preflight: an older git stops a real Linux run, is a
#     PLAN line in a dry run, and is a warning on macOS.
#   - the pins: the minimum version, the fingerprint and the key file.
# The stub git (lib.sh) answers --version from $T/state/git.version; uname is a
# stub too, so the Linux cases run on macOS and the other way round. boot.sh
# reads os-release and the apt sources from $T/etc (GP_ETC, honoured only when
# GP_TEST=1).
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

MIN="$(pin_value GIT_MIN_VERSION)"
FPR="$(pin_value GIT_PPA_FINGERPRINT)"
OTHER_FPR="1111111111111111111111111111111111111111"
KEY="$SRC/install/apt/git-core-ppa.asc"

# A small Ghost Protocol repo holding what boot.sh reads from its clone (the
# pins and the key), and an install/install stand-in that records that it ran;
# then boot.sh pinned to its commit.
make_gp_repo() {
    local src="$T/src-gp" c
    mkdir -p "$src/install/apt"
    cp "$SRC/install/pins.env" "$src/install/pins.env"
    cp "$KEY" "$src/install/apt/"
    cat >"$src/install/install" <<'EOF'
#!/bin/sh
echo "install $#" >>"$STUB_STATE/calls"
EOF
    chmod +x "$src/install/install"
    git -C "$src" init -q
    git -C "$src" add -A
    git -C "$src" commit -q -m one
    c="$(git -C "$src" rev-parse HEAD)"
    git clone -q --bare "$src" "$T/remote/gp.git"
    sed "s/^GP_COMMIT=\"\"\$/GP_COMMIT=\"$c\"/" "$SRC/install/boot.sh" >"$T/boot.sh"
    chmod +x "$T/boot.sh"
}

stub_uname() {   # system machine
    # shellcheck disable=SC2016  # the stub's own $1, written as is
    printf '#!/bin/sh\ncase "$1" in -s) echo %s ;; -m) echo %s ;; *) echo %s ;; esac\n' "$1" "$2" "$1" >"$T/stubs/uname"
    chmod +x "$T/stubs/uname"
}

fake_etc() {   # id codename
    mkdir -p "$T/etc/apt/sources.list.d"
    printf 'NAME="Test Linux"\nID="%s"\nVERSION_CODENAME=%s\n' "$1" "$2" >"$T/etc/os-release"
}

# A Linux sandbox for boot.sh: curl, sudo and gpg stubs, Ubuntu noble.
boot_world() {   # git-version
    t_new
    t_stub curl; t_stub sudo; t_stub gpg
    stub_uname Linux x86_64
    echo "$1" >"$T/state/git.version"
    make_gp_repo
    fake_etc ubuntu noble
}
boot() {
    t_env GP_REPO_URL="file://$T/remote/gp.git" GP_ETC="$T/etc" "$T/boot.sh" "$@" >"$OUT" 2>&1
    RC=$?
}
installer_ran()   { grep -q '^install ' "$T/state/calls"; }
# Nothing ran as root: no sudo call, and no as_root reached (in a test it
# refuses, so reaching it means a write came before the test-mode stop).
no_root()         { not_called sudo && out_lacks 'refusing to run as root'; }

prev_minor="${MIN%%.*}.$(( ${MIN#*.} - 1 )).9"

# ---------------------------------------------------------------- the pins

check "GIT_MIN_VERSION is major.minor" sh -c "printf '%s' '$MIN' | grep -qE '^[0-9]+\.[0-9]+\$'"
check "GIT_MIN_VERSION is 2.46 or newer (capability[]=authtype)" \
    sh -c "[ '${MIN%%.*}' -gt 2 ] || { [ '${MIN%%.*}' -eq 2 ] && [ '${MIN#*.}' -ge 46 ]; }"
check "GIT_PPA_FINGERPRINT is a full 40-hex fingerprint" sh -c "printf '%s' '$FPR' | grep -qE '^[0-9A-F]{40}\$'"
check "boot.sh holds no copy of the fingerprint (it reads pins.env)" sh -c "! grep -qE '[0-9A-F]{40}' '$SRC/install/boot.sh'"
check "boot.sh takes git from the Git stable PPA" \
    grep -q '^GIT_PPA_URI="https://ppa.launchpadcontent.net/git-core/ppa/ubuntu/"$' "$SRC/install/boot.sh"
check "the key file is one armored public key block" \
    sh -c "[ \"\$(grep -c -- '-----BEGIN PGP PUBLIC KEY BLOCK-----' '$KEY')\" -eq 1 ] && grep -q -- '-----END PGP PUBLIC KEY BLOCK-----' '$KEY'"
check "the key file holds no private key" sh -c "! grep -qi 'private' '$KEY'"
t_new
if t_tool gpg; then
    mkdir -m 700 "$T/gnupg"
    got="$(GNUPGHOME="$T/gnupg" "$T/sysbin/gpg" --batch --show-keys --with-colons "$KEY" 2>/dev/null \
        | awk -F: '$1 == "pub" { p = 1; next } p && $1 == "fpr" { print $10; p = 0 }')"
    check "the key file is the key with the pinned fingerprint (checked with this machine's gpg)" [ "$got" = "$FPR" ]
else
    echo "SKIP  the key file's fingerprint (no gpg on this machine)"
fi

# ---------------------------------------------------------------- boot.sh

# 1. git new enough: nothing to do, and the installer runs.
boot_world 2.50.1
boot --instance example/instance
check "boot, new git: exit 0" rc_is 0
check "boot, new git: it says the version is enough" out_has "git 2\.50\.1 \(clones of relay repos need $MIN or newer\)"
check "boot, new git: the installer ran" installer_ran
check "boot, new git: no gpg, no sudo" sh -c "! grep -qE '^(gpg|sudo) ' '$T/state/calls'"

# 2. Exactly the minimum is enough; a version below it is not.
boot_world "$MIN.0"
boot --instance example/instance --dry-run
check "boot, git $MIN.0: enough" out_has "git $MIN\.0 \(clones of relay repos need"
check "boot, git $MIN.0: no PPA planned" out_lacks 'Git stable PPA'
boot_world "$prev_minor"
boot --instance example/instance --dry-run
check "boot, git $prev_minor: older than $MIN" out_has "git $prev_minor is older than $MIN"

# 3. Older git on Ubuntu, dry run: the PPA and the install are planned; nothing
#    is called, written or installed, and the installer's dry run follows.
boot_world 2.43.0
boot --instance example/instance --dry-run
check "boot dry run, old git: exit 0" rc_is 0
check "boot dry run, old git: it plans the Git stable PPA for noble" out_has 'would add the Git stable PPA \(ppa:git-core/ppa, noble\)'
check "boot dry run, old git: it names the pinned fingerprint" out_has "pinned fingerprint $FPR"
check "boot dry run, old git: it plans the git install" out_has 'would apt-get install git'
check "boot dry run, old git: the source file it would write" out_has '/etc/apt/sources.list.d/git-core-ubuntu-ppa-noble.sources would read:'
check "boot dry run, old git: source line Types" out_has '^    Types: deb$'
check "boot dry run, old git: source line URIs" out_has '^    URIs: https://ppa\.launchpadcontent\.net/git-core/ppa/ubuntu/$'
check "boot dry run, old git: source line Suites" out_has '^    Suites: noble$'
check "boot dry run, old git: source line Components" out_has '^    Components: main$'
check "boot dry run, old git: source line Signed-By" out_has '^    Signed-By: /etc/apt/keyrings/git-core-ppa\.asc$'
check "boot dry run, old git: no gpg, no sudo" sh -c "! grep -qE '^(gpg|sudo) ' '$T/state/calls'"
check "boot dry run, old git: the installer's dry run ran" installer_ran
check "boot dry run, old git: no temp folder is left" no_temp_left

# 4. An apt source for the PPA already there (a .list under the old host name):
#    left as it is, so only the install is planned.
boot_world 2.43.0
echo 'deb http://ppa.launchpad.net/git-core/ppa/ubuntu noble main' >"$T/etc/apt/sources.list.d/git-core-ubuntu-ppa-noble.list"
boot --instance example/instance --dry-run
check "boot, source already there: it is left as it is" out_has 'already there; it would be left as it is'
check "boot, source already there: no second source is planned" out_lacks 'would add the Git stable PPA'
check "boot, source already there: the git install is planned" out_has 'would apt-get install git'
# The same in a real run: no key check, and the test stops before apt.
boot --instance example/instance
check "boot, source already there, real run: no key check" not_called gpg
check "boot, source already there, real run: stops before apt (exit 1)" rc_is 1
check "boot, source already there, real run: says why" out_has 'TEST MODE: stopping before apt'
check "boot, source already there, real run: no sudo" no_root
# A commented-out line is not a source, nor a deb-src line, nor one for
# another release.
boot_world 2.43.0
echo '# deb https://ppa.launchpadcontent.net/git-core/ppa/ubuntu noble main' >"$T/etc/apt/sources.list"
boot --instance example/instance --dry-run
check "boot, commented-out PPA line: the PPA is still planned" out_has 'would add the Git stable PPA'
boot_world 2.43.0
echo 'deb-src https://ppa.launchpadcontent.net/git-core/ppa/ubuntu noble main' >"$T/etc/apt/sources.list.d/src.list"
boot --instance example/instance --dry-run
check "boot, a deb-src PPA line: the PPA is still planned" out_has 'would add the Git stable PPA'
boot_world 2.43.0
echo 'deb [signed-by=/etc/apt/keyrings/x.asc] https://ppa.launchpadcontent.net/git-core/ppa/ubuntu noble main' >"$T/etc/apt/sources.list.d/signed.list"
boot --instance example/instance --dry-run
check "boot, a deb line with options: counts as there" out_has 'already there; it would be left as it is'
boot_world 2.43.0
echo 'deb https://ppa.launchpadcontent.net/git-core/ppa/ubuntu jammy main' >"$T/etc/apt/sources.list.d/old.list"
boot --instance example/instance --dry-run
check "boot, a PPA line for another release: the PPA is still planned" out_has 'would add the Git stable PPA'

# deb822 .sources files, the form boot.sh writes: an enabled one for this
# release counts; a disabled one (left by a release upgrade) does not.
sources_file() {   # name enabled-line
    printf 'Types: deb\nURIs: https://ppa.launchpadcontent.net/git-core/ppa/ubuntu/\nSuites: noble\nComponents: main\n%s' "$2" \
        >"$T/etc/apt/sources.list.d/$1"
}
boot_world 2.43.0
sources_file mine.sources ""
boot --instance example/instance --dry-run
check "boot, an enabled .sources for noble: left as it is" out_has 'already there; it would be left as it is'
for off in no false off; do
    boot_world 2.43.0
    sources_file old.sources "Enabled: $off
"
    boot --instance example/instance --dry-run
    check "boot, a .sources with Enabled: $off: the PPA is still planned" out_has 'would add the Git stable PPA'
done
# A disabled source in the very file boot.sh would write: it is never
# overwritten; the run stops and says so.
boot_world 2.43.0
sources_file git-core-ubuntu-ppa-noble.sources "Enabled: no
"
boot --instance example/instance --dry-run
check "boot, its own file there but disabled: exit 1" rc_is 1
check "boot, its own file there but disabled: left as it is" out_has 'is not an enabled Git stable PPA source for noble; left as it is'
check "boot, its own file there but disabled: nothing planned past it" out_lacks 'would apt-get install git'

# 5. Not Ubuntu: it says so, changes nothing, and the installer still runs (its
#    preflight decides).
boot_world 2.43.0
fake_etc debian bookworm
boot --instance example/instance
check "boot, Debian: exit 0" rc_is 0
check "boot, Debian: says the PPA is for Ubuntu only" out_has 'Git stable PPA is for Ubuntu only \(this is debian\); nothing was changed'
check "boot, Debian: no gpg, no sudo" sh -c "! grep -qE '^(gpg|sudo) ' '$T/state/calls'"
check "boot, Debian: the installer ran" installer_ran

# 6. The key file is another key: ABORT before anything is written.
boot_world 2.43.0
echo "$OTHER_FPR" >"$T/state/gpg.fprs"
boot --instance example/instance
check "boot, wrong key: exit 1" rc_is 1
check "boot, wrong key: ABORT names the pin" out_has "ABORT: .* is not the Git stable PPA key pinned in install/pins.env \($FPR\)"
check "boot, wrong key: gpg checked it" called gpg
check "boot, wrong key: it stops at the key, not later" out_lacks 'TEST MODE: stopping before apt'
check "boot, wrong key: no sudo" no_root
check "boot, wrong key: the installer never ran" sh -c "! grep -q '^install ' '$T/state/calls'"
check "boot, wrong key: no temp folder is left" no_temp_left

# 7. A file holding the pinned key and one more: refused too.
boot_world 2.43.0
printf '%s\n%s\n' "$FPR" "$OTHER_FPR" >"$T/state/gpg.fprs"
boot --instance example/instance
check "boot, two keys: exit 1" rc_is 1
check "boot, two keys: ABORT" out_has 'ABORT: '

# 8. The pinned key: checked (the subkey's fingerprint not counted), then the
#    test stops before apt.
boot_world 2.43.0
echo "$FPR" >"$T/state/gpg.fprs"
boot --instance example/instance
check "boot, pinned key: the key check passes" out_has "signing key matches the pinned fingerprint $FPR"
check "boot, pinned key: stops before apt (exit 1)" rc_is 1
check "boot, pinned key: says why" out_has 'TEST MODE: stopping before apt'
check "boot, pinned key: no sudo" no_root
check "boot, pinned key: the installer never ran" sh -c "! grep -q '^install ' '$T/state/calls'"
check "boot, pinned key: no temp folder is left" no_temp_left

# 9. No gpg on the machine: a test never installs one.
boot_world 2.43.0
rm -f "$T/stubs/gpg"
boot --instance example/instance
check "boot, no gpg: exit 1" rc_is 1
check "boot, no gpg: says it has none" out_has 'no gpg to check the key with'
check "boot, no gpg: no sudo" no_root

# 10. macOS (the Command Line Tools present): boot.sh leaves git to the
#     installer's preflight.
boot_world 2.39.5
stub_uname Darwin arm64
printf '#!/bin/sh\nexit 0\n' >"$T/stubs/xcode-select"
chmod +x "$T/stubs/xcode-select"
boot --instance example/instance --dry-run
check "boot, macOS: exit 0" rc_is 0
check "boot, macOS: no PPA planned" out_lacks 'Git stable PPA'
check "boot, macOS: the installer's dry run ran" installer_ran

# ---------------------------------------------------------------- preflight

pre_world() {   # system machine git-version
    t_new; t_std_env
    stub_uname "$1" "$2"
    echo "$3" >"$T/state/git.version"
    t_make_instance "$FIX/manifests/good.toml"
}

# 11. Linux, older git: a real run stops at preflight; a dry run plans it and
#     goes on.
pre_world Linux x86_64 2.43.0
t_install --instance example/instance --yes
check "preflight, Linux, old git: exit 1" rc_is 1
check "preflight, Linux, old git: FAIL names the versions" out_has "FAIL +preflight +git 2\.43\.0 is older than $MIN"
check "preflight, Linux, old git: says boot.sh replaces it on Ubuntu" out_has 'boot.sh replaces it from the Git stable PPA'
check "preflight, Linux, old git: the GitHub step never ran" sh -c "! grep -q '^gh ' '$T/state/calls'"
pre_world Linux x86_64 2.43.0
t_install --instance example/instance --yes --dry-run
check "preflight dry run, Linux, old git: a PLAN line" out_has "PLAN +preflight .*git 2\.43\.0, older than $MIN: a real run stops here unless boot\.sh replaces it first"
check "preflight dry run, Linux, old git: no FAIL" out_lacks 'FAIL +preflight'
check "preflight dry run, Linux, old git: the run goes on" out_has '== 2\. GitHub access'

# 12. Linux, exactly the minimum, and a minor version past 99: enough.
pre_world Linux x86_64 "$MIN.0"
t_install --instance example/instance --yes
check "preflight, Linux, git $MIN.0: OK with the version" out_has "OK +preflight .*git $MIN\.0\$"
pre_world Linux x86_64 2.100.1
t_install --instance example/instance --yes
check "preflight, Linux, git 2.100.1: compared as numbers, OK" out_has 'OK +preflight .*git 2\.100\.1$'

# 13. macOS with Apple's git 2.39: a warning, and the run goes on.
pre_world Darwin arm64 '2.39.5 (Apple Git-154)'
t_install --instance example/instance --yes
check "preflight, macOS, old git: a warning" out_has "WARNING: git 2\.39\.5 is older than $MIN"
check "preflight, macOS, old git: says to update the Command Line Tools" out_has 'Command Line Tools'
check "preflight, macOS, old git: OK, with the note" out_has "OK +preflight .*git 2\.39\.5, older than $MIN \(see the warning\)"
check "preflight, macOS, old git: no FAIL" out_lacks 'FAIL +preflight'

# ---------------------------------------------------------------- both

# 14. A dry run through boot.sh on Ubuntu with git 2.43, the real installer
#     behind it (--dev-source this checkout): boot.sh plans the PPA, the
#     installer's preflight plans it too, and the whole dry run succeeds.
#     Linux only: on macOS a pretend Linux would run the real installer's
#     later steps on the wrong platform.
if [ "$(uname -s)" = "Linux" ]; then
    pre_world Linux x86_64 2.43.0
    fake_etc ubuntu noble
    t_env GP_ETC="$T/etc" "$SRC/install/boot.sh" --instance example/instance --dev-source "$SRC" --dry-run --yes >"$OUT" 2>&1
    RC=$?
    check "boot and installer dry run, old git: exit 0" rc_is 0
    check "boot and installer dry run, old git: boot.sh plans the PPA" out_has 'would add the Git stable PPA \(ppa:git-core/ppa, noble\)'
    check "boot and installer dry run, old git: preflight is a PLAN" out_has 'PLAN +preflight .*a real run stops here unless boot\.sh replaces it first'
    check "boot and installer dry run, old git: the later steps are planned" out_has 'PLAN +claude|OK +claude'
    check "boot and installer dry run, old git: no sudo" no_root
else
    echo "SKIP  boot and installer dry run with an old git (Linux only)"
fi

finish_tests
