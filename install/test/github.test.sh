#!/usr/bin/env bash
# github.test.sh: GitHub access, the instance clone and the account check.
# Token mode uses a stub gh and a local bare repo; integration mode uses a
# url.insteadOf mapping from the integration host to another local bare repo.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

I=(--instance example/instance --yes)
origin_of() { git -C "$1" config --get remote.origin.url 2>/dev/null; }

# 1. Token mode, a fresh sign-in as the right login: it goes on.
t_new; t_std_env; rm -f "$T/state/gh.authed"; t_make_instance "$FIX/manifests/good.toml"
t_tty ""
t_install "${I[@]}"
check "token, right login: exit 0" rc_is 0
check "token, right login: gh auth login ran" called "gh auth login"
check "token, right login: nothing was signed out" not_called "gh auth logout"
check "token, right login: cloned into the manifest's dir" [ -d "$T/home/instance/.git" ]
check "token, right login: the clone's origin is the github.com address" \
    [ "$(origin_of "$T/home/instance")" = "https://github.com/example/instance.git" ]
check "token, right login: the summary says github.login matched" out_has 'OK +login +matched github.login \(example-bot\)'
check "token, right login: the setup hook ran (3 arguments)" grep -qx 'setup 3' "$T/state/calls"
check "token, right login: no git config line is written" [ ! -e "$T/home/.gitconfig-host" ]
check "token, right login: no ~/.gitconfig is written" [ ! -e "$T/home/.gitconfig" ]
check "token, right login: no temp folder is left" no_temp_left
check "token, right login: the account check read the login (gh api user)" called "gh api user"
check "token, right login: no repo check" not_called "gh api repos"
check "real run: steps 7-15 are SKIP lines" sh -c "[ \$(grep -cE '^  SKIP  (secrets|lease|restore|plugins|ears|managed|service|kit-timer|status) ' '$OUT') -eq 9 ]"

# 2. Token mode, a fresh sign-in as the wrong login: signed out, clone deleted, exit 5.
t_new; t_std_env; rm -f "$T/state/gh.authed"; t_make_instance "$FIX/manifests/good.toml"
echo "someone-else" >"$T/state/gh.login"
t_tty ""
t_install "${I[@]}"
check "token, wrong login: exit 5" rc_is 5
check "token, wrong login: gh auth logout ran" called "gh auth logout"
check "token, wrong login: the new clone is deleted" [ ! -e "$T/home/instance" ]
check "token, wrong login: the setup hook never ran" not_called setup
check "token, wrong login: it names both logins" out_has 'acts as someone-else, but this instance expects example-bot'

# 3. A wrong login that was signed in before the run: refused, never signed out.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
echo "someone-else" >"$T/state/gh.login"
t_install "${I[@]}"
check "earlier sign-in, wrong login: exit 5" rc_is 5
check "earlier sign-in, wrong login: not signed out" not_called "gh auth logout"
check "earlier sign-in, wrong login: the new clone is deleted" [ ! -e "$T/home/instance" ]

# 3b. Token mode with the integration's GH_HOST exported: the login check
#     still reads github.com (--hostname wins), so the stub's 403 never applies.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
t_env GH_HOST=github.int.exe.xyz "$SRC/install/install" "${I[@]}" >"$OUT" 2>&1
RC=$?
check "token, GH_HOST exported: exit 0" rc_is 0
check "token, GH_HOST exported: the login was read and matched" out_has 'OK +login +matched github.login \(example-bot\)'

# 3c. Token mode, gh api user fails and prints an error body (as the real gh
#     does on stdout, even with --jq), right after this run's own sign-in: the
#     body is never taken as a login, so nothing is signed out (exit 1, not 5).
t_new; t_std_env; rm -f "$T/state/gh.authed"; t_make_instance "$FIX/manifests/good.toml"
touch "$T/state/gh.user-error"
t_tty ""
t_install "${I[@]}"
check "token, api user error: exit 1, not 5" rc_is 1
check "token, api user error: the sign-in ran this run" called "gh auth login"
check "token, api user error: the fixed-text FAIL" out_has 'FAIL +account +could not read which GitHub login this machine acts as'
check "token, api user error: the error body is never shown as a login" out_lacks 'Bad credentials|acts as \{'
check "token, api user error: nothing is signed out" not_called "gh auth logout"
check "token, api user error: the new clone is deleted" [ ! -e "$T/home/instance" ]
check "token, api user error: the setup hook never ran" not_called setup

# 3d. The same with an earlier sign-in and an existing clone: both are kept.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"; t_clone_into_home
before="$(git -C "$T/home/instance" rev-parse HEAD)"
touch "$T/state/gh.user-error"
t_install "${I[@]}"
check "token, api user error, earlier sign-in: exit 1" rc_is 1
check "token, api user error, earlier sign-in: not signed out" not_called "gh auth logout"
check "token, api user error, earlier sign-in: still signed in" [ -f "$T/state/gh.authed" ]
check "token, api user error, existing clone: still there, unchanged" \
    [ "$(git -C "$T/home/instance" rev-parse HEAD 2>/dev/null)" = "$before" ]

# 4. An existing clone survives a wrong login.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"; t_clone_into_home
before="$(git -C "$T/home/instance" rev-parse HEAD)"
echo "someone-else" >"$T/state/gh.login"
rm -f "$T/state/gh.authed"
t_tty ""
t_install "${I[@]}"
check "existing clone, wrong login: exit 5" rc_is 5
check "existing clone, wrong login: the clone is still there, unchanged" \
    [ "$(git -C "$T/home/instance" rev-parse HEAD 2>/dev/null)" = "$before" ]

# 5. An existing clone is never fetched, pulled or switched.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"; t_clone_into_home
before="$(git -C "$T/home/instance" rev-parse HEAD)"
t_advance_instance
t_install "${I[@]}"
check "existing clone: exit 0" rc_is 0
check "existing clone: HEAD did not move" [ "$(git -C "$T/home/instance" rev-parse HEAD)" = "$before" ]
check "existing clone: no fetch (main on the remote is newer)" \
    [ "$(git -C "$T/home/instance" rev-parse origin/main)" = "$before" ]
check "existing clone: it says it was left as it is" out_has 'left exactly as it is'

# 6. An existing directory that is not a clone of the instance is refused, untouched.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
mkdir -p "$T/home/instance"; echo keep >"$T/home/instance/notes.txt"
t_install "${I[@]}"
check "not a clone: exit 1" rc_is 1
check "not a clone: left untouched" [ "$(cat "$T/home/instance/notes.txt")" = "keep" ]
check "not a clone: it says why" out_has 'exists and is not a clone of example/instance'

# 7. Integration mode (auto): no GitHub sign-in; the git config lines are written.
t_new; t_std_env; rm -f "$T/state/gh.authed"; t_integration
t_make_instance "$FIX/manifests/good.toml" int
t_install "${I[@]}"
check "integration: exit 0" rc_is 0
check "integration: auto picked integration mode" out_has 'integration mode'
check "integration: no gh sign-in or sign-out" sh -c "! grep -qE '^gh auth (login|logout|status) ' '$T/state/calls'"
check "integration: cloned through the integration" [ -d "$T/home/instance/.git" ]
check "integration: the clone's origin is the github.com address" \
    [ "$(origin_of "$T/home/instance")" = "https://github.com/example/instance.git" ]
check "integration: the instance's insteadOf line is in host_config" \
    [ "$(git config --file "$T/home/.gitconfig-host" --get url.https://github.int.exe.xyz/example/instance.git.insteadOf)" = "https://github.com/example/instance.git" ]
check "integration: each listed repo gets its line too" \
    [ "$(git config --file "$T/home/.gitconfig-host" --get url.https://github.int.exe.xyz/example/tools.git.insteadOf)" = "https://github.com/example/tools.git" ]
check "integration: ~/.gitconfig itself is not written" [ ! -e "$T/home/.gitconfig" ]
check "integration: no /user call (the integration host answers it 403)" not_called "gh api user"
check "integration: one repo check per repo (the instance and example/tools)" \
    [ "$(grep -c '^gh api repos ' "$T/state/calls")" -eq 2 ]
check "integration: it says which check ran" out_has 'integration mode: checking repo access \(gh api repos/<owner>/<repo> through github.int.exe.xyz\), not github.login'
check "integration: the summary says the repos answered" out_has 'OK +account +integration mode: github.int.exe.xyz answers the GitHub API for 2 repo\(s\); github.login is not matched'

# 8. Integration mode acts as the integration's own identity, so github.login
#    is not matched: a login that differs does not stop the run.
t_new; t_std_env; t_integration; t_make_instance "$FIX/manifests/good.toml" int
echo "someone-else" >"$T/state/gh.login"
t_install "${I[@]}"
check "integration, login not matched: exit 0" rc_is 0
check "integration, login not matched: the clone is kept" [ -d "$T/home/instance/.git" ]
check "integration, login not matched: the git config lines are written" [ -f "$T/home/.gitconfig-host" ]

# 8a. Integration mode, the integration does not answer the API for the
#     instance repo: the new clone is deleted and no line is written.
t_new; t_std_env; rm -f "$T/state/gh.authed"; t_integration; t_make_instance "$FIX/manifests/good.toml" int
echo "example/instance" >"$T/state/gh.int-denied"
t_install "${I[@]}"
check "integration, instance repo not answered: exit 1" rc_is 1
check "integration, instance repo not answered: FAIL names the repo" out_has 'FAIL +account +integration mode: github.int.exe.xyz does not answer the GitHub API for example/instance'
check "integration, instance repo not answered: the new clone is deleted" [ ! -e "$T/home/instance" ]
check "integration, instance repo not answered: no git config line" [ ! -e "$T/home/.gitconfig-host" ]
check "integration, instance repo not answered: the setup hook never ran" not_called setup

# 8a2. The same for a repo in github.repos.
t_new; t_std_env; rm -f "$T/state/gh.authed"; t_integration; t_make_instance "$FIX/manifests/good.toml" int
echo "example/tools" >"$T/state/gh.int-denied"
t_install "${I[@]}"
check "integration, listed repo not answered: exit 1" rc_is 1
check "integration, listed repo not answered: FAIL names the repo" out_has 'FAIL +account +integration mode: github.int.exe.xyz does not answer the GitHub API for example/tools'
check "integration, listed repo not answered: the new clone is deleted" [ ! -e "$T/home/instance" ]
check "integration, listed repo not answered: no git config line" [ ! -e "$T/home/.gitconfig-host" ]

# 8a3. An existing clone survives a repo the integration does not answer for.
t_new; t_std_env; t_integration; t_make_instance "$FIX/manifests/good.toml" int
git clone -q "https://github.int.exe.xyz/example/instance.git" "$T/home/instance"
before="$(git -C "$T/home/instance" rev-parse HEAD)"
echo "example/tools" >"$T/state/gh.int-denied"
t_install "${I[@]}"
check "integration, existing clone, repo not answered: exit 1" rc_is 1
check "integration, existing clone, repo not answered: the clone is still there, unchanged" \
    [ "$(git -C "$T/home/instance" rev-parse HEAD 2>/dev/null)" = "$before" ]

# 8b. Integration mode with no host_config: refused before any clone.
t_new; t_std_env; t_integration; t_make_instance "$FIX/manifests/good-no-host-config.toml" int
t_install "${I[@]}"
check "integration, no host_config: exit 1" rc_is 1
check "integration, no host_config: nothing cloned" [ ! -e "$T/home/instance" ]
check "integration, no host_config: it says why" out_has 'needs github.host_config'

# 8c. host_config spelled to reach ~/.gitconfig: refused, ~/.gitconfig untouched.
t_new; t_std_env; t_integration; t_make_instance "$FIX/manifests/bad-gitconfig-dot.toml" int
t_install "${I[@]}"
check "integration, host_config ~/./.gitconfig: exit 1" rc_is 1
check "integration, host_config ~/./.gitconfig: ~/.gitconfig not written" [ ! -e "$T/home/.gitconfig" ]
check "integration, host_config ~/./.gitconfig: nothing cloned" [ ! -e "$T/home/instance" ]

# 8c2. The same in upper case (macOS file names ignore case).
t_new; t_std_env; t_integration; t_make_instance "$FIX/manifests/bad-gitconfig-upper.toml" int
t_install "${I[@]}"
check "integration, host_config ~/.GITCONFIG: exit 1" rc_is 1
check "integration, host_config ~/.GITCONFIG: nothing written" sh -c "[ -z \"\$(find '$T/home' -maxdepth 1 -iname .gitconfig)\" ]"

# 8d. --instance-dir to a new place still checks the manifest before cloning.
t_new; t_std_env; t_make_instance "$FIX/manifests/bad-schema.toml"
t_install "${I[@]}" --instance-dir "$T/home/inst"
check "--instance-dir, bad manifest: exit 1" rc_is 1
check "--instance-dir, bad manifest: nothing cloned" [ ! -e "$T/home/inst" ]

# 9. --github integration when the integration host does not answer: exit 1.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
t_install "${I[@]}" --github integration
check "forced integration, no host: exit 1" rc_is 1

# 10. Token mode, not signed in, no terminal: exit 4.
t_new; t_std_env; rm -f "$T/state/gh.authed"; t_make_instance "$FIX/manifests/good.toml"
t_install "${I[@]}"
check "token, no terminal: exit 4" rc_is 4
check "token, no terminal: nothing cloned" [ ! -e "$T/home/instance" ]

# 11. A second login is allowed only by the manifest (github.also_login), and
#     the summary says which login matched. There is no flag for it.
t_new; t_std_env; t_make_instance "$FIX/manifests/good-also-login.toml"
echo "rehearsal-bot" >"$T/state/gh.login"
t_install "${I[@]}"
check "also_login: exit 0" rc_is 0
check "also_login: the summary says it matched also_login" out_has 'OK +login +matched github.also_login \(rehearsal-bot\)'
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
echo "other-bot" >"$T/state/gh.login"
t_install "${I[@]}" --github-login other-bot
check "--github-login no longer exists (exit 2)" rc_is 2
check "--github-login: nothing cloned" [ ! -e "$T/home/instance" ]

# 12. --instance-dir: the clone goes where it says.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
t_install "${I[@]}" --instance-dir "$T/home/elsewhere/inst"
check "--instance-dir: exit 0" rc_is 0
check "--instance-dir: cloned there" [ -d "$T/home/elsewhere/inst/.git" ]
check "--instance-dir: not in the default place" [ ! -e "$T/home/instance" ]

# 13. The pinned gh: with no gh installed it is downloaded, checked and used.
mk_gh_archive() {   # builds the release asset for this platform; prints its name
    local v asset dir
    v="$(pin_value GH_VERSION)"
    case "$(uname -s)-$(uname -m)" in
        Darwin-arm64) asset="gh_${v}_macOS_arm64.zip"; dir="gh_${v}_macOS_arm64" ;;
        Linux-x86_64) asset="gh_${v}_linux_amd64.tar.gz"; dir="gh_${v}_linux_amd64" ;;
        *) asset="gh_${v}_linux_arm64.tar.gz"; dir="gh_${v}_linux_arm64" ;;
    esac
    mkdir -p "$T/pkg/$dir/bin"
    cp "$FIX/stubs/gh" "$T/pkg/$dir/bin/gh"
    chmod +x "$T/pkg/$dir/bin/gh"
    case "$asset" in
        *.zip) (cd "$T/pkg" && zip -qr "$T/gh.zip" "$dir") && mv "$T/gh.zip" "$T/state/curl.body" ;;
        *) tar -czf "$T/state/curl.body" -C "$T/pkg" "$dir" ;;
    esac
    echo "https://github.com/cli/cli/releases/download/v$v/$asset" >"$T/state/curl.expect-url"
}
pins_with_gh_sum() {   # sum
    T_PINS="$T/pins.env"
    sed -E "s/^(GH_SHA256_[A-Z0-9_]+)=\"[0-9a-f]*\"/\\1=\"$1\"/" "$SRC/install/pins.env" >"$T_PINS"
}
if [ "$(uname -s)" = "Darwin" ] && ! command -v zip >/dev/null 2>&1; then
    echo "SKIP  pinned gh download (no zip here to build the test archive)"
else
    t_new; t_std_env; rm -f "$T/stubs/gh"; rm -f "$T/state/gh.authed"; t_make_instance "$FIX/manifests/good.toml"
    mk_gh_archive
    pins_with_gh_sum "$(sha_of "$T/state/curl.body")"
    t_tty ""
    t_install "${I[@]}"
    check "pinned gh: exit 0" rc_is 0
    check "pinned gh: downloaded once, from the pinned address" [ "$(grep -c '^curl ' "$T/state/calls")" -eq 1 ]
    check "pinned gh: the unpacked gh did the sign-in" called "gh auth login"
    check "pinned gh: it says the sha256 matched" out_has 'matched its pinned sha256'
    check "pinned gh: the temp folder is gone" no_temp_left

    t_new; t_std_env; rm -f "$T/stubs/gh"; rm -f "$T/state/gh.authed"; t_make_instance "$FIX/manifests/good.toml"
    mk_gh_archive
    pins_with_gh_sum "$(printf '%064d' 0)"
    t_tty ""
    t_install "${I[@]}"
    check "pinned gh, wrong sha256: exit 1" rc_is 1
    check "pinned gh, wrong sha256: refused" out_has 'does not match the pinned sha256'
    check "pinned gh, wrong sha256: gh never ran" not_called "gh auth status"
    check "pinned gh, wrong sha256: nothing cloned" [ ! -e "$T/home/instance" ]
fi

# 14. deploykey mode (--github deploykey): an ed25519 key made here for the
#     instance repo alone, git over SSH to github.com with its pinned host
#     keys, no gh and no token. ssh is the stand-in (fixtures/stubs/ssh).
dk_key() { printf '%s' "$T/home/.ssh/ghost-protocol/example/instance.key"; }
dk_first_run() {   # a sandbox, the instance, and the first run that makes the key
    t_new; t_std_env; t_deploykey; t_make_instance "$FIX/manifests/good.toml"
    t_install "${I[@]}" --github deploykey
}
if ! command -v ssh-keygen >/dev/null 2>&1; then
    echo "SKIP  deploykey mode (no ssh-keygen here)"
else
    # 14a. The first run makes the key, prints only its public half and stops (6).
    dk_first_run
    K="$(dk_key)"
    check "deploykey, first run: exit 6" rc_is 6
    check "deploykey, first run: an ed25519 key was made" grep -q '^ssh-ed25519 ' "$K.pub"
    check "deploykey, first run: the key is 0600, its folders 0700" sh -c "
        [ \"\$(stat -c %a '$K' 2>/dev/null || stat -f %Lp '$K')\" = 600 ] &&
        for d in '$T/home/.ssh' '$T/home/.ssh/ghost-protocol' '$T/home/.ssh/ghost-protocol/example'; do
            [ \"\$(stat -c %a \"\$d\" 2>/dev/null || stat -f %Lp \"\$d\")\" = 700 ] || exit 1; done"
    check "deploykey, first run: the public key printed is the private key's own" \
        grep -qF -- "$(ssh-keygen -y -f "$K" | cut -d' ' -f1,2)" "$OUT"
    leaked=0
    while IFS= read -r l; do
        case "$l" in -----*|"") continue ;; esac
        grep -qF -- "$l" "$OUT" && leaked=1
    done <"$K"
    check "deploykey, first run: no line of the private key is printed" [ "$leaked" -eq 0 ]
    check "deploykey, first run: the FAIL says to add it, then run again" \
        out_has 'FAIL +github +deploykey mode: the key is not added to example/instance yet; add the public key above as a deploy key with write access'
    check "deploykey, first run: nothing cloned" [ ! -e "$T/home/instance" ]
    check "deploykey, first run: known_hosts is exactly github.com's three pinned keys" \
        sh -c "grep '^github\.com ' '$SRC/install/github-known-hosts' | cmp -s - '$T/home/.ssh/ghost-protocol/known_hosts'"
    check "deploykey, first run: no gh at all" sh -c "! grep -q '^gh ' '$T/state/calls'"
    check "deploykey, first run: ssh was tried" called ssh
    check "deploykey, first run: the setup hook never ran" not_called setup
    key_sum="$(sha_of "$K")"

    # 14b. Added with write access: the same key clones over SSH, the push side
    #      is checked, the clone's own git config carries the key; exit 0.
    t_add_deploykey "$K" rw
    t_install "${I[@]}" --github deploykey
    check "deploykey, added: exit 0" rc_is 0
    check "deploykey, added: the same key, not a new one" [ "$(sha_of "$K")" = "$key_sum" ]
    check "deploykey, added: cloned" [ -d "$T/home/instance/.git" ]
    check "deploykey, added: the clone's origin is the SSH address" \
        [ "$(origin_of "$T/home/instance")" = "git@github.com:example/instance.git" ]
    sshcmd="$(git -C "$T/home/instance" config --get core.sshCommand)"
    has_all() {   # text, then each piece it must hold
        local text="$1" w; shift
        for w in "$@"; do case "$text" in *"$w"*) ;; *) return 1 ;; esac; done
    }
    check "deploykey, added: the clone's core.sshCommand uses only this key, the pinned host keys, never a prompt" \
        has_all "$sshcmd" "ssh -F /dev/null " "-i '$K'" "IdentitiesOnly=yes" "IdentityAgent=none" \
            "UserKnownHostsFile='$T/home/.ssh/ghost-protocol/known_hosts'" "GlobalKnownHostsFile=/dev/null" \
            "StrictHostKeyChecking=yes" "UpdateHostKeys=no" "BatchMode=yes"
    t_env git -C "$T/home/instance" ls-remote origin HEAD >"$T/lsr.txt" 2>&1
    check "deploykey, added: the clone's own git reaches the repo with that config" grep -q 'HEAD$' "$T/lsr.txt"
    check "deploykey, added: the push side was checked" out_has 'OK +account +deploykey mode: the key can push to example/instance; github.login is not matched'
    check "deploykey, added: the git config line is the clone's own" out_has 'DONE +gitconfig +core.sshCommand in .*/instance/.git/config'
    check "deploykey, added: no ~/.gitconfig and no host_config written" sh -c "[ ! -e '$T/home/.gitconfig' ] && [ ! -e '$T/home/.gitconfig-host' ]"
    check "deploykey, added: it says github.repos is not reached" out_has 'github.repos \(example/tools.*a deploy key reaches the instance repo only'
    check "deploykey, added: the setup hook ran" called setup
    check "deploykey, added: still no gh" sh -c "! grep -q '^gh ' '$T/state/calls'"
    check "deploykey, added: no temp folder is left" no_temp_left

    # 14c. The caller's GIT_SSH_COMMAND never decides which ssh the installer uses.
    rm -rf "$T/home/instance"
    t_env GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=no" "$SRC/install/install" "${I[@]}" --github deploykey >"$OUT" 2>&1
    RC=$?
    check "deploykey, a GIT_SSH_COMMAND exported: ignored (exit 0, cloned)" sh -c "[ $RC -eq 0 ] && [ -d '$T/home/instance/.git' ]"

    # 14d. A read-only deploy key: the new clone is deleted, exit 1.
    dk_first_run
    t_add_deploykey "$(dk_key)" ro
    t_install "${I[@]}" --github deploykey
    check "deploykey, read-only: exit 1" rc_is 1
    check "deploykey, read-only: the FAIL says it needs write access" out_has 'FAIL +account +deploykey mode: the deploy key on example/instance is read-only'
    check "deploykey, read-only: the new clone is deleted" [ ! -e "$T/home/instance" ]
    check "deploykey, read-only: the setup hook never ran" not_called setup

    # 14e. The key added to another repo only: not reached, still exit 6.
    dk_first_run
    t_add_deploykey "$(dk_key)" rw example/other
    t_install "${I[@]}" --github deploykey
    check "deploykey, added to another repo: exit 6" rc_is 6
    check "deploykey, added to another repo: nothing cloned" [ ! -e "$T/home/instance" ]

    # 14f. github.com shows a host key that is not pinned: nothing is trusted.
    dk_first_run
    t_add_deploykey "$(dk_key)" rw
    ssh-keygen -q -t ed25519 -N '' -f "$T/other-host" </dev/null >/dev/null 2>&1
    echo "github.com $(cut -d' ' -f1,2 "$T/other-host.pub")" >"$T/state/github-hostkey"
    t_install "${I[@]}" --github deploykey
    check "deploykey, unpinned host key: exit 1" rc_is 1
    check "deploykey, unpinned host key: it says so" out_has 'FAIL +github +deploykey mode: github.com did not show a pinned host key'
    check "deploykey, unpinned host key: no 'add it' line" out_lacks 'Add it to example/instance'
    check "deploykey, unpinned host key: nothing cloned" [ ! -e "$T/home/instance" ]

    # 14g. An existing key that others can read: refused, left as it is.
    t_new; t_std_env; t_deploykey; t_make_instance "$FIX/manifests/good.toml"
    mkdir -p "$T/home/.ssh/ghost-protocol/example"
    ssh-keygen -q -t ed25519 -N '' -f "$(dk_key)" </dev/null >/dev/null 2>&1
    chmod 644 "$(dk_key)"
    key_sum="$(sha_of "$(dk_key)")"
    t_install "${I[@]}" --github deploykey
    check "deploykey, key readable by others: exit 1" rc_is 1
    check "deploykey, key readable by others: it says to chmod 600" out_has 'has mode 644; it must be 600'
    check "deploykey, key readable by others: the key is untouched" [ "$(sha_of "$(dk_key)")" = "$key_sum" ]
    check "deploykey, key readable by others: ssh never ran" not_called ssh

    # 14h. A link where the key goes: refused.
    t_new; t_std_env; t_deploykey; t_make_instance "$FIX/manifests/good.toml"
    mkdir -p "$T/home/.ssh/ghost-protocol/example"
    ln -s "$T/elsewhere" "$(dk_key)"
    t_install "${I[@]}" --github deploykey
    check "deploykey, the key path is a link: exit 1" rc_is 1
    check "deploykey, the key path is a link: it says so" out_has 'is a link or not a file'
    check "deploykey, the key path is a link: nothing made behind it" [ ! -e "$T/elsewhere" ]

    # 14i. Dry run with no key: nothing made at all.
    t_new; t_std_env; t_deploykey; t_make_instance "$FIX/manifests/good.toml"
    t_install "${I[@]}" --github deploykey --dry-run
    check "deploykey, dry run, no key: exit 0" rc_is 0
    check "deploykey, dry run, no key: it says what it would make" out_has 'PLAN +github +deploykey mode: would make an ed25519 key at'
    check "deploykey, dry run, no key: the clone waits for the key" out_has 'PLAN +instance +would clone example/instance \(main\) once its deploy key is added'
    check "deploykey, dry run, no key: no ~/.ssh made" [ ! -e "$T/home/.ssh" ]
    check "deploykey, dry run, no key: nothing cloned" [ ! -e "$T/home/instance" ]
    check "deploykey, dry run, no key: no temp folder is left" no_temp_left

    # 14j. Dry run with an added key: the reads run, nothing in HOME changes.
    dk_first_run
    t_add_deploykey "$(dk_key)" rw
    before="$(t_snapshot)"
    t_install "${I[@]}" --github deploykey --dry-run
    check "deploykey, dry run, added: exit 0" rc_is 0
    check "deploykey, dry run, added: the key reaches the repo" out_has 'OK +github +deploykey mode: the key at .* reaches example/instance over SSH'
    check "deploykey, dry run, added: the clone is a PLAN" out_has 'PLAN +instance +would clone example/instance'
    check "deploykey, dry run, added: the git config is a PLAN" out_has 'PLAN +gitconfig +would set core.sshCommand'
    check "deploykey, dry run, added: HOME is unchanged" [ "$(t_snapshot)" = "$before" ]

    # 14k. An existing clone with an https origin: its git config gets the key,
    #      its origin is switched to the SSH address (the same repo), the clone
    #      is not moved, and no hook of the clone's runs in the push check.
    dk_first_run
    t_add_deploykey "$(dk_key)" rw
    t_clone_into_home
    before="$(git -C "$T/home/instance" rev-parse HEAD)"
    printf '#!/bin/sh\ntouch "%s"\n' "$T/hook-ran" >"$T/home/instance/.git/hooks/pre-push"
    chmod +x "$T/home/instance/.git/hooks/pre-push"
    t_install "${I[@]}" --github deploykey
    check "deploykey, existing https clone: exit 0" rc_is 0
    check "deploykey, existing https clone: HEAD did not move" [ "$(git -C "$T/home/instance" rev-parse HEAD)" = "$before" ]
    check "deploykey, existing https clone: core.sshCommand is set" git -C "$T/home/instance" config --get core.sshCommand
    check "deploykey, existing https clone: origin switched to the SSH address" \
        [ "$(origin_of "$T/home/instance")" = "git@github.com:example/instance.git" ]
    check "deploykey, existing https clone: the summary says so" out_has 'DONE +gitconfig .*origin switched from https://github.com/example/instance.git'
    t_env git -C "$T/home/instance" ls-remote origin HEAD >"$T/lsr.txt" 2>&1
    check "deploykey, existing https clone: its own git now reaches the repo" grep -q 'HEAD$' "$T/lsr.txt"
    check "deploykey, existing https clone: the clone's pre-push hook never ran" [ ! -e "$T/hook-ran" ]

    # 14l. A url.insteadOf in the user's git config cannot send the installer
    #      elsewhere: its git reads no user or system config in this mode.
    dk_first_run
    t_add_deploykey "$(dk_key)" rw
    printf '[url "git@example.org:"]\n\tinsteadOf = git@github.com:\n' >>"$T/gitconfig"
    t_install "${I[@]}" --github deploykey
    check "deploykey, a user insteadOf: ignored (exit 0, cloned)" sh -c "[ $RC -eq 0 ] && [ -d '$T/home/instance/.git' ]"
    check "deploykey, a user insteadOf: ssh only ever saw github.com" sh -c "! grep -q 'unexpected host' '$OUT'"

    # 14n. A url.pushInsteadOf in the clone's own .git/config cannot fake the
    #      push check: the installer's deploykey git speaks ssh only, so a
    #      push rewritten to a local path is refused, and a read-only key stays
    #      a FAIL (review 2, G1).
    dk_first_run
    t_add_deploykey "$(dk_key)" ro
    t_clone_into_home
    git clone -q --bare "$T/remote/github/example/instance.git" "$T/fake.git"
    git -C "$T/home/instance" config "url.$T/fake.git.pushInsteadOf" "git@github.com:example/instance.git"
    t_install "${I[@]}" --github deploykey
    check "deploykey, a pushInsteadOf to a local path with a read-only key: exit 1" rc_is 1
    check "deploykey, a pushInsteadOf to a local path: the push check did not pass" out_lacks 'OK +account +deploykey mode: the key can push'

    # 14m. An old .pub that is not the key's own: the key's own is printed, and
    #      the .pub is written again from the key.
    dk_first_run
    ssh-keygen -q -t ed25519 -N '' -f "$T/stranger" </dev/null >/dev/null 2>&1
    cp "$T/stranger.pub" "$(dk_key).pub"
    t_install "${I[@]}" --github deploykey
    check "deploykey, a stale .pub: still exit 6" rc_is 6
    check "deploykey, a stale .pub: the key's own public key is printed" \
        grep -qF -- "$(ssh-keygen -y -f "$(dk_key)" | cut -d' ' -f1,2)" "$OUT"
    check "deploykey, a stale .pub: the stranger's key is not" out_lacks "$(cut -d' ' -f2 "$T/stranger.pub")"
    check "deploykey, a stale .pub: the .pub is the key's own again" \
        [ "$(cut -d' ' -f1,2 "$(dk_key).pub")" = "$(ssh-keygen -y -f "$(dk_key)" | cut -d' ' -f1,2)" ]
fi

# 15. --instance with a . or .. part never reaches a key path.
for bad in ../instance example/.. ./instance; do
    t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
    t_install --instance "$bad" --yes --github deploykey
    check "--instance $bad: usage (exit 2)" rc_is 2
    check "--instance $bad: no ~/.ssh made" [ ! -e "$T/home/.ssh" ]
done

# 16. --github takes only the four modes.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
t_install "${I[@]}" --github sshkey
check "--github sshkey: usage (exit 2)" rc_is 2
check "--github sshkey: it names the four modes" out_has 'auto, integration, token or deploykey'

finish_tests
