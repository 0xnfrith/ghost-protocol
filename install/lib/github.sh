# shellcheck shell=bash
# github.sh: step 2 (GitHub access) and the account check after the clone.
#
# Three modes:
#   integration  an exe.dev GitHub integration answers at github.int.exe.xyz for
#                the instance repo. The machine holds no GitHub token: git talks
#                to the integration host, and gh is pointed at it with GH_HOST.
#   token        a gh sign-in with a one-time code (gh auth login --web). The
#                token lives in gh's own config.
#   deploykey    an SSH key made on this machine for the instance repo alone,
#                which the repo's admin adds as a deploy key with write access
#                (GitHub takes a deploy key for exactly one repo). git talks SSH
#                to github.com, whose host keys are pinned in
#                install/github-known-hosts.
#                No gh, no token and no sign-in: git only, for that one repo.
#                The first run makes the key, prints its public key and stops
#                (exit 6) until the key is added; the next run goes on.
# "auto" picks integration when `git ls-remote` on the integration host works,
# else token; deploykey is only ever chosen by --github deploykey.
# Sourced by install/install only.

GP_GITHUB_INT_HOST="github.int.exe.xyz"
GITHUB_MODE=""
GH=""                 # the gh this run uses
GH_AUTHED=0
GH_SIGNED_IN_NOW=0    # 1 only when this run made the sign-in
# deploykey mode: the key for the instance repo, and github.com's pinned host
# keys. In a dry run the host keys go to the private temp folder instead.
GP_DEPLOYKEY_DIR="$HOME/.ssh/ghost-protocol"
DEPLOYKEY_FILE=""
DEPLOYKEY_KNOWN_HOSTS=""        # the file this run's ssh reads
DEPLOYKEY_KNOWN_HOSTS_HOME=""   # where it lives for good (the clone's ssh command names it)
DEPLOYKEY_READY=0               # 1 when the key reaches the instance repo

gh_cmd() { GH_NO_UPDATE_NOTIFIER=1 GH_PROMPT_DISABLED=1 "$GH" "$@"; }

# The address to clone owner/repo from, in this run's mode.
github_url() {
    if [ "$GITHUB_MODE" = "integration" ]; then
        printf 'https://%s/%s.git' "$GP_GITHUB_INT_HOST" "$1"
    elif [ "$GITHUB_MODE" = "deploykey" ]; then
        printf 'git@github.com:%s.git' "$1"
    else
        printf 'https://github.com/%s.git' "$1"
    fi
}

# git for anything that talks to GitHub. It never prompts and never uses a
# lasting credential helper. In token mode it gets gh as a one-off helper,
# through environment config only: nothing is written to any git config. In
# deploykey mode its ssh is the deploy key's (GIT_SSH_COMMAND, which wins over
# any core.sshCommand or GIT_SSH the caller has), and the user's and the
# system's git config are not read, so no url.insteadOf there can send the
# instance's address anywhere else. It speaks ssh only (GIT_ALLOW_PROTOCOL),
# so a url.insteadOf or pushInsteadOf in a clone's own .git/config that points
# at a local path or another transport is refused, and the push check can only
# ever pass by reaching GitHub.
remote_git() {
    if [ "$GITHUB_MODE" = "deploykey" ]; then
        GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_ALLOW_PROTOCOL=ssh \
        GIT_TERMINAL_PROMPT=0 GIT_LFS_SKIP_SMUDGE=1 GIT_SSH_COMMAND="$(deploykey_ssh_command "$DEPLOYKEY_KNOWN_HOSTS")" \
        GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0='' \
            git "$@"
    elif [ "$GITHUB_MODE" = "token" ] && [ -n "$GH" ]; then
        GIT_TERMINAL_PROMPT=0 GIT_LFS_SKIP_SMUDGE=1 GIT_CONFIG_COUNT=2 \
        GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0='' \
        GIT_CONFIG_KEY_1=credential.helper GIT_CONFIG_VALUE_1="!'$GH' auth git-credential" \
            git "$@"
    else
        GIT_TERMINAL_PROMPT=0 GIT_LFS_SKIP_SMUDGE=1 GIT_CONFIG_COUNT=1 \
        GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0='' \
            git "$@"
    fi
}

github_int_reachable() {
    GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 \
    GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0='' \
        git ls-remote "https://$GP_GITHUB_INT_HOST/$INSTANCE.git" HEAD >/dev/null 2>&1
}

# A gh: the installed one, else the pinned release unpacked into the private
# temp folder (deleted on exit).
github_ensure_gh() {
    local asset sum url found
    found="$(command -v gh 2>/dev/null || true)"
    if [ -n "$found" ]; then
        GH="$found"
        say "using the installed gh: $GH"
        return 0
    fi
    case "$GP_OS-$GP_ARCH" in
        macos-arm64)   asset="gh_${GH_VERSION}_macOS_arm64.zip";    sum="$GH_SHA256_MACOS_ARM64" ;;
        linux-x86_64)  asset="gh_${GH_VERSION}_linux_amd64.tar.gz"; sum="$GH_SHA256_LINUX_AMD64" ;;
        linux-aarch64) asset="gh_${GH_VERSION}_linux_arm64.tar.gz"; sum="$GH_SHA256_LINUX_ARM64" ;;
        *) record FAIL github "no pinned gh for $GP_OS/$GP_ARCH"; return 1 ;;
    esac
    url="https://github.com/cli/cli/releases/download/v${GH_VERSION}/${asset}"
    if [ "$DRY_RUN" = "1" ]; then
        say "would download $url into a private temp folder and check sha256 $sum"
        GH=""
        return 0
    fi
    if ! make_work; then record FAIL github "could not make a private temp folder"; return 1; fi
    say "downloading the pinned gh $GH_VERSION"
    if ! download_verified "$url" "$GP_WORK/$asset" "$sum"; then
        record FAIL github "the pinned gh $GH_VERSION failed its download or sha256 check"
        return 1
    fi
    mkdir -p "$GP_WORK/gh"
    case "$asset" in
        *.zip)    (cd "$GP_WORK/gh" && unzip -q "$GP_WORK/$asset") ;;
        *.tar.gz) tar -xzf "$GP_WORK/$asset" -C "$GP_WORK/gh" ;;
    esac || { record FAIL github "could not unpack $asset"; return 1; }
    found="$(find "$GP_WORK/gh" -type f -path '*/bin/gh' | head -n 1)"
    if [ -z "$found" ] || [ ! -x "$found" ]; then
        record FAIL github "no gh inside $asset"
        return 1
    fi
    GH="$found"
    say "gh $GH_VERSION matched its pinned sha256 and was unpacked (temporary): $GH"
    return 0
}

step_github() {
    heading "2. GitHub access"
    case "$GITHUB_OPT" in
        auto)
            if github_int_reachable; then
                GITHUB_MODE=integration
                say "$GP_GITHUB_INT_HOST answers for $INSTANCE: integration mode"
            else
                GITHUB_MODE=token
                say "no integration host answers for $INSTANCE: token mode (a gh sign-in)"
            fi ;;
        integration)
            if ! github_int_reachable; then
                record FAIL github "--github integration: $GP_GITHUB_INT_HOST does not answer for $INSTANCE"
                return 1
            fi
            GITHUB_MODE=integration ;;
        token)
            GITHUB_MODE=token ;;
        deploykey)
            GITHUB_MODE=deploykey ;;
    esac
    if [ "$GITHUB_MODE" = "deploykey" ]; then
        github_deploykey
        return
    fi
    github_ensure_gh || return 1

    if [ "$GITHUB_MODE" = "integration" ]; then
        record OK github "integration mode through $GP_GITHUB_INT_HOST; no GitHub token on this machine"
        return 0
    fi

    if [ -n "$GH" ] && gh_cmd auth status --hostname github.com >/dev/null 2>&1; then
        GH_AUTHED=1
        record OK github "token mode; gh is already signed in"
        return 0
    fi
    if [ "$DRY_RUN" = "1" ]; then
        show_cmd gh auth login --web --git-protocol https --hostname github.com --skip-ssh-key
        record PLAN github "token mode; would sign in to GitHub with a one-time code"
        return 0
    fi
    if [ "$HAVE_TTY" != "1" ]; then
        EXIT_CODE=4
        record FAIL github "token mode needs a terminal for the GitHub sign-in code"
        return 1
    fi
    if ! make_work; then record FAIL github "could not make a private temp folder"; return 1; fi
    say "GitHub sign-in: open the address shown in a private browser window,"
    say "signed in as the instance's GitHub account, and enter the code."
    # Whatever the sign-in offers to write to git config goes to a throwaway
    # file in the temp folder, never to a lasting git config.
    if GH_NO_UPDATE_NOTIFIER=1 GIT_CONFIG_GLOBAL="$GP_WORK/login.gitconfig" \
        "$GH" auth login --web --git-protocol https --hostname github.com --skip-ssh-key <&3; then
        GH_AUTHED=1
        GH_SIGNED_IN_NOW=1
        record DONE github "token mode; signed in to GitHub"
        return 0
    fi
    record FAIL github "the GitHub sign-in did not finish"
    return 1
}

# ---------------------------------------------------------------- deploykey

# The ssh command for the deploy key: no ssh config file at all (-F /dev/null:
# neither ~/.ssh/config nor the system's, whose IdentityFile or
# KnownHostsCommand lines would add keys or host keys), this key only (never an
# agent's or the user's other keys), github.com's pinned host keys only (never
# the user's known_hosts, never a key learned on first use), and never a
# prompt. $1: the known_hosts file to read.
deploykey_ssh_command() {
    printf "ssh -F /dev/null -i '%s' -o IdentitiesOnly=yes -o IdentityAgent=none -o UserKnownHostsFile='%s' -o GlobalKnownHostsFile=/dev/null -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o BatchMode=yes" \
        "$DEPLOYKEY_FILE" "$1"
}

# github.com's host keys: the github.com lines of install/github-known-hosts.
GP_GITHUB_KNOWN_HOSTS="$GP_DIR/install/github-known-hosts"
deploykey_known_hosts_lines() { grep -E '^github\.com ' "$GP_GITHUB_KNOWN_HOSTS"; }

# The pinned file must hold exactly github.com's ed25519, ecdsa and rsa keys,
# one line each, in base64, and nothing else that ssh would read.
deploykey_pins_ok() {
    [ -f "$GP_GITHUB_KNOWN_HOSTS" ] || return 1
    [ "$(grep -cvE '^[[:space:]]*(#.*)?$' "$GP_GITHUB_KNOWN_HOSTS")" -eq 3 ] || return 1
    [ "$(grep -cE '^github\.com (ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/]+={0,2}$' "$GP_GITHUB_KNOWN_HOSTS")" -eq 3 ] || return 1
    [ "$(grep -E '^github\.com ' "$GP_GITHUB_KNOWN_HOSTS" | cut -d' ' -f2 | sort -u | wc -l | tr -d ' ')" -eq 3 ]
}

# Writes the pinned host keys to $1 (replaced whole, through a temp file in the
# same folder, so a pin change in an update takes effect).
deploykey_write_known_hosts() {
    local tmp
    tmp="$(mktemp "$1.XXXXXX")" || return 1
    if ! deploykey_known_hosts_lines >"$tmp" || ! chmod 644 "$tmp" || ! mv -f "$tmp" "$1"; then
        rm -f "$tmp"
        return 1
    fi
}

# A file's permission bits, for the key checks.
deploykey_mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }

# Tries the key on the instance repo (git ls-remote: reads only). Sets
# DEPLOYKEY_PROBE to ok, denied (GitHub does not take the key for this repo),
# hostkey (github.com did not show a pinned host key) or other.
deploykey_probe() {
    local err="$GP_WORK/ssh-probe.err"
    if remote_git ls-remote "$(github_url "$INSTANCE")" HEAD >/dev/null 2>"$err"; then
        DEPLOYKEY_PROBE=ok
    elif grep -qE 'Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED' "$err"; then
        DEPLOYKEY_PROBE=hostkey
    elif grep -qE 'Permission denied \(publickey\)|Repository not found' "$err"; then
        DEPLOYKEY_PROBE=denied
    else
        DEPLOYKEY_PROBE=other
        sed 's/^/    /' "$err" >&2
    fi
}

# $1: a public key file written from the private key just now (never an old .pub).
deploykey_show_public() {
    say "the deploy key's public key (read from $DEPLOYKEY_FILE itself):"
    head -n 1 "$1"
    say "Add it to $INSTANCE only, as a deploy key with write access (Settings, Deploy keys, Allow write access)."
}

# Step 2 in deploykey mode. The key is made once and never replaced: an
# existing one that is a link, or that others can read, stops the run.
github_deploykey() {
    local owner="${INSTANCE%%/*}" repo="${INSTANCE#*/}" m
    DEPLOYKEY_FILE="$GP_DEPLOYKEY_DIR/$owner/$repo.key"
    DEPLOYKEY_KNOWN_HOSTS_HOME="$GP_DEPLOYKEY_DIR/known_hosts"
    case "$HOME" in *"'"*) record FAIL github "deploykey mode: HOME has a ' in it, which the ssh command cannot quote"; return 1 ;; esac
    case "$owner/$repo" in .*|*/.*|*/*/*) record FAIL github "deploykey mode: $INSTANCE cannot name a key file"; return 1 ;; esac
    if ! command -v ssh >/dev/null 2>&1 || ! command -v ssh-keygen >/dev/null 2>&1; then
        record FAIL github "deploykey mode needs ssh and ssh-keygen (the OpenSSH client)"
        return 1
    fi
    if ! deploykey_pins_ok; then
        record FAIL github "deploykey mode: install/github-known-hosts must hold exactly github.com's ed25519, ecdsa and rsa host keys"
        return 1
    fi
    if ! make_work; then record FAIL github "could not make a private temp folder"; return 1; fi
    if [ -L "$DEPLOYKEY_FILE" ] || { [ -e "$DEPLOYKEY_FILE" ] && [ ! -f "$DEPLOYKEY_FILE" ]; }; then
        record FAIL github "deploykey mode: $DEPLOYKEY_FILE is a link or not a file; move it away"
        return 1
    fi
    if [ -f "$DEPLOYKEY_FILE" ]; then
        m="$(deploykey_mode_of "$DEPLOYKEY_FILE")"
        case "$m" in
            600|400) ;;
            *) record FAIL github "deploykey mode: $DEPLOYKEY_FILE has mode $m; it must be 600 (chmod 600 it)"; return 1 ;;
        esac
    fi

    if [ "$DRY_RUN" = "1" ]; then
        DEPLOYKEY_KNOWN_HOSTS="$GP_WORK/known_hosts"
        deploykey_write_known_hosts "$DEPLOYKEY_KNOWN_HOSTS" || { record FAIL github "could not write the pinned host keys"; return 1; }
        if [ ! -f "$DEPLOYKEY_FILE" ]; then
            show_cmd ssh-keygen -q -t ed25519 -N '' -C "ghost-protocol deploy key for $INSTANCE" -f "$DEPLOYKEY_FILE"
            record PLAN github "deploykey mode: would make an ed25519 key at $DEPLOYKEY_FILE, write github.com's pinned host keys to $DEPLOYKEY_KNOWN_HOSTS_HOME, print the public key and stop (exit 6) until it is added to $INSTANCE"
            return 0
        fi
        if ! ssh-keygen -y -f "$DEPLOYKEY_FILE" >"$GP_WORK/key.pub" 2>/dev/null; then
            record FAIL github "deploykey mode: could not read the public half of $DEPLOYKEY_FILE"
            return 1
        fi
        deploykey_probe
        case "$DEPLOYKEY_PROBE" in
            ok) DEPLOYKEY_READY=1
                record OK github "deploykey mode: the key at $DEPLOYKEY_FILE reaches $INSTANCE over SSH" ;;
            denied)
                deploykey_show_public "$GP_WORK/key.pub"
                record PLAN github "deploykey mode: the key at $DEPLOYKEY_FILE is not added to $INSTANCE yet (a real run stops here, exit 6)" ;;
            hostkey) record FAIL github "deploykey mode: github.com did not show a pinned host key (install/github-known-hosts); nothing trusted"; return 1 ;;
            *) record FAIL github "deploykey mode: could not reach github.com over SSH"; return 1 ;;
        esac
        return 0
    fi

    if ! mkdir -p "$GP_DEPLOYKEY_DIR/$owner" || ! chmod 700 "$HOME/.ssh" "$GP_DEPLOYKEY_DIR" "$GP_DEPLOYKEY_DIR/$owner"; then
        record FAIL github "deploykey mode: could not make $GP_DEPLOYKEY_DIR/$owner (0700)"
        return 1
    fi
    DEPLOYKEY_KNOWN_HOSTS="$DEPLOYKEY_KNOWN_HOSTS_HOME"
    if ! deploykey_write_known_hosts "$DEPLOYKEY_KNOWN_HOSTS"; then
        record FAIL github "deploykey mode: could not write github.com's pinned host keys to $DEPLOYKEY_KNOWN_HOSTS"
        return 1
    fi
    if [ -f "$DEPLOYKEY_FILE" ]; then
        say "using the deploy key already at $DEPLOYKEY_FILE"
    elif ! (umask 077 && ssh-keygen -q -t ed25519 -N '' -C "ghost-protocol deploy key for $INSTANCE on $(uname -n)" \
                -f "$DEPLOYKEY_FILE" </dev/null >/dev/null 2>&1); then
        record FAIL github "deploykey mode: ssh-keygen could not make $DEPLOYKEY_FILE"
        return 1
    else
        say "made an ed25519 deploy key at $DEPLOYKEY_FILE (0600; only its public half is ever shown)"
    fi
    # The .pub is always written again from the private key, so what is shown
    # and granted is this key's public half, whatever an old .pub held.
    if ! ssh-keygen -y -f "$DEPLOYKEY_FILE" >"$DEPLOYKEY_FILE.pub.$$" 2>/dev/null \
        || ! chmod 644 "$DEPLOYKEY_FILE.pub.$$" || ! mv -f "$DEPLOYKEY_FILE.pub.$$" "$DEPLOYKEY_FILE.pub"; then
        rm -f "$DEPLOYKEY_FILE.pub.$$"
        record FAIL github "deploykey mode: could not read the public half of $DEPLOYKEY_FILE"
        return 1
    fi

    deploykey_probe
    case "$DEPLOYKEY_PROBE" in
        ok)
            DEPLOYKEY_READY=1
            record OK github "deploykey mode: the key at $DEPLOYKEY_FILE reaches $INSTANCE over SSH; no GitHub token on this machine"
            return 0 ;;
        denied)
            deploykey_show_public "$DEPLOYKEY_FILE.pub"
            EXIT_CODE=6
            record FAIL github "deploykey mode: the key is not added to $INSTANCE yet; add the public key above as a deploy key with write access, then run this again"
            return 1 ;;
        hostkey)
            record FAIL github "deploykey mode: github.com did not show a pinned host key (install/github-known-hosts); nothing trusted"
            return 1 ;;
        *)
            record FAIL github "deploykey mode: could not reach github.com over SSH"
            return 1 ;;
    esac
}

# deploykey mode's account check. A deploy key acts as its repo, not as a
# login, so github.login is not matched; instead the key must be able to push:
# git push --dry-run talks to GitHub's receive-pack, which refuses a read-only
# deploy key before anything else, and sends nothing. A key that cannot push
# deletes a clone this run made (never an existing directory) and stops (1).
github_deploykey_access() {
    local out
    if [ "$DEPLOYKEY_READY" != "1" ] || [ -z "$INSTANCE_DIR" ] || [ ! -d "$INSTANCE_DIR/.git" ]; then
        record PLAN account "deploykey mode: would check that the key can push to $INSTANCE (git push --dry-run sends nothing); github.login is not matched"
        return 0
    fi
    say "deploykey mode: checking that the key can push (git push --dry-run, which sends nothing), not github.login: a deploy key acts as its repo, not a login"
    # No hook runs (--no-verify, and no hooks folder) and no fsmonitor: the
    # check is git's own talk with GitHub, nothing from the clone.
    out="$(remote_git -C "$INSTANCE_DIR" -c core.hooksPath=/dev/null -c core.fsmonitor=false \
        push --dry-run --no-verify --porcelain "$(github_url "$INSTANCE")" HEAD:refs/heads/main 2>"$GP_WORK/push.err")"
    if ! printf '%s\n' "$out" | grep -q '^To '; then
        if grep -qiE 'read.only' "$GP_WORK/push.err"; then
            record FAIL account "deploykey mode: the deploy key on $INSTANCE is read-only; it needs write access (Allow write access)"
        else
            sed 's/^/    /' "$GP_WORK/push.err" >&2
            record FAIL account "deploykey mode: the key could not reach $INSTANCE's push side"
        fi
        instance_remove_new_clone
        return 1
    fi
    if [ -n "$M_GITHUB_REPOS" ]; then
        say "github.repos ($(printf '%s\n' "$M_GITHUB_REPOS" | awk 'NF { printf "%s%s", s, $0; s = ", " }')) is for integration mode; a deploy key reaches the instance repo only"
    fi
    record OK account "deploykey mode: the key can push to $INSTANCE; github.login is not matched"
    return 0
}

# The repos this run reaches through the integration: the instance repo first,
# then github.repos, each once.
github_int_repos() {
    printf '%s\n%s\n' "$INSTANCE" "$M_GITHUB_REPOS" | awk 'NF && !seen[$0]++'
}

# Integration mode's account check. The integration acts as its own identity
# (by default a shared GitHub App bot rather than a user), and its host proxies
# only /repos/OWNER/REPO/... paths: /user answers 403. So no login is
# read or matched; instead the integration must answer the GitHub API for the
# instance repo and for each repo in github.repos. A repo it does not answer
# for deletes a clone this run made (never an existing directory) and stops (1).
github_int_access() {
    local list r got n=0
    list="$(github_int_repos)"
    if [ -z "$GH" ]; then
        record PLAN account "integration mode: would check that $GP_GITHUB_INT_HOST answers the GitHub API for $(printf '%s' "$list" | tr '\n' ' ') (github.login is not matched)"
        return 0
    fi
    say "integration mode: checking repo access (gh api repos/<owner>/<repo> through $GP_GITHUB_INT_HOST), not github.login: the integration acts as its own identity and does not serve /user"
    for r in $list; do
        # gh's exit status decides: on an error gh still prints the error body
        # (a 404's JSON) on stdout, so output alone proves nothing.
        if ! got="$(GH_HOST="$GP_GITHUB_INT_HOST" gh_cmd api "repos/$r" --jq .full_name 2>/dev/null)" \
            || [ -z "$got" ]; then
            record FAIL account "integration mode: $GP_GITHUB_INT_HOST does not answer the GitHub API for $r; set the integration up for that repo"
            instance_remove_new_clone
            return 1
        fi
        n=$((n + 1))
    done
    record OK account "integration mode: $GP_GITHUB_INT_HOST answers the GitHub API for $n repo(s); github.login is not matched"
    return 0
}

# After the clone and the manifest. Integration mode: github_int_access above.
# Token mode: gh must act as the expected login. On a mismatch it signs out a
# sign-in this run made (never an older one), deletes a clone this run made
# (never an existing directory) and stops (5).
step_github_account() {
    local want got
    heading "GitHub account"
    if [ "$GITHUB_MODE" = "integration" ]; then
        github_int_access
        return
    fi
    if [ "$GITHUB_MODE" = "deploykey" ]; then
        github_deploykey_access
        return
    fi
    # The manifest names the login, and optionally one more it also accepts.
    want="$M_GITHUB_LOGIN"
    [ -n "$M_GITHUB_ALSO_LOGIN" ] && want="$want or $M_GITHUB_ALSO_LOGIN"
    if [ -z "$GH" ] || { [ "$GITHUB_MODE" = "token" ] && [ "$GH_AUTHED" != "1" ]; }; then
        record PLAN account "would check that GitHub acts as $want"
        return 0
    fi
    # --hostname: an exported GH_HOST (the integration's) must not decide
    # which account a token-mode check reads. gh's exit status decides: on an
    # API error gh still prints the error body on stdout, which must never be
    # taken as a login (nor reach the sign-out below).
    if ! got="$(gh_cmd api user --hostname github.com --jq .login 2>/dev/null)" \
        || [ -z "$got" ]; then
        record FAIL account "could not read which GitHub login this machine acts as"
        instance_remove_new_clone
        return 1
    fi
    if [ "$(lower "$got")" = "$(lower "$M_GITHUB_LOGIN")" ]; then
        say "GitHub acts as $got"
        record OK account "GitHub acts as $got"
        record OK login "matched github.login ($M_GITHUB_LOGIN)"
        return 0
    fi
    if [ -n "$M_GITHUB_ALSO_LOGIN" ] && [ "$(lower "$got")" = "$(lower "$M_GITHUB_ALSO_LOGIN")" ]; then
        say "GitHub acts as $got (the manifest's also_login)"
        record OK account "GitHub acts as $got"
        record OK login "matched github.also_login ($M_GITHUB_ALSO_LOGIN), not github.login ($M_GITHUB_LOGIN)"
        return 0
    fi
    EXIT_CODE=5
    echo "install: GitHub acts as $got, but this instance expects $want." >&2
    if [ "$DRY_RUN" = "1" ]; then
        record FAIL account "GitHub acts as $got, not $want (a real run stops here)"
        return 1
    fi
    if [ "$GITHUB_MODE" = "token" ]; then
        if [ "$GH_SIGNED_IN_NOW" = "1" ]; then
            if gh_cmd auth logout --hostname github.com --user "$got" >/dev/null 2>&1; then
                say "signed $got out of gh"
            else
                warn "could not sign $got out; run: gh auth logout --hostname github.com --user $got"
            fi
        else
            say "left $got signed in: that sign-in was there before this run."
            say "Sign it out with: gh auth logout --hostname github.com --user $got"
        fi
    fi
    instance_remove_new_clone
    record FAIL account "GitHub acts as $got, not $want: wrong account"
    return 1
}

# Integration mode: one url.<integration>.insteadOf line per repo, in the git
# config file the manifest names (never ~/.gitconfig itself), so the clone's
# github.com address keeps going through the integration. GH_HOST is not git
# config: it belongs in the run environment, which a later step sets.
# deploykey mode: github_deploykey_config below.
step_github_config() {
    local f r n=0 key val list
    if [ "$GITHUB_MODE" = "deploykey" ]; then
        github_deploykey_config
        return
    fi
    [ "$GITHUB_MODE" = "integration" ] || return 0
    heading "git config for the integration"
    if [ -z "$M_GITHUB_HOST_CONFIG" ]; then
        record FAIL gitconfig "integration mode needs github.host_config in the manifest"
        return 1
    fi
    f="$(expand_home "$M_GITHUB_HOST_CONFIG")"
    if host_config_is_global "$f"; then
        record FAIL gitconfig "github.host_config $M_GITHUB_HOST_CONFIG is git's global config; refusing to write it"
        return 1
    fi
    list="$(github_int_repos)"
    for r in $list; do
        key="url.https://$GP_GITHUB_INT_HOST/$r.git.insteadOf"
        val="https://github.com/$r.git"
        if [ "$DRY_RUN" = "1" ]; then
            show_cmd git config --file "$f" --replace-all "$key" "$val"
        elif ! git config --file "$f" --replace-all "$key" "$val"; then
            record FAIL gitconfig "could not write $key to $M_GITHUB_HOST_CONFIG"
            return 1
        fi
        n=$((n + 1))
    done
    if [ "$DRY_RUN" = "1" ]; then
        record PLAN gitconfig "would write $n url.insteadOf line(s) to $M_GITHUB_HOST_CONFIG; GH_HOST=$GP_GITHUB_INT_HOST goes in the run environment"
    else
        record DONE gitconfig "$n url.insteadOf line(s) in $M_GITHUB_HOST_CONFIG; GH_HOST=$GP_GITHUB_INT_HOST goes in the run environment"
    fi
    return 0
}

# deploykey mode: core.sshCommand in the clone's own config (.git/config, which
# its worktrees share), so every later git there (pulls, pushes, the hooks)
# uses the deploy key and the pinned host keys. Nothing global is written. An
# existing clone whose origin is the same repo's https address (github.com's or
# the integration's) is switched to the SSH address, which the deploy key
# needs; an ssh:// origin already works and is left as it is.
deploykey_origin_is_https() {   # origin
    case "$(lower "${1%.git}")" in
        "https://github.com/$(lower "$INSTANCE")"|"https://$GP_GITHUB_INT_HOST/$(lower "$INSTANCE")") return 0 ;;
    esac
    return 1
}

github_deploykey_config() {
    local cmd origin want switched=""
    heading "git config for the deploy key"
    cmd="$(deploykey_ssh_command "$DEPLOYKEY_KNOWN_HOSTS_HOME")"
    want="git@github.com:$INSTANCE.git"
    if [ "$DRY_RUN" = "1" ] || [ -z "$INSTANCE_DIR" ] || [ ! -d "$INSTANCE_DIR/.git" ]; then
        show_cmd git -C "${INSTANCE_DIR:-<the clone>}" config core.sshCommand "$cmd"
        if [ -n "$INSTANCE_DIR" ] && [ -d "$INSTANCE_DIR/.git" ] \
            && deploykey_origin_is_https "$(git -C "$INSTANCE_DIR" config --get remote.origin.url 2>/dev/null || true)"; then
            show_cmd git -C "$INSTANCE_DIR" remote set-url origin "$want"
        fi
        record PLAN gitconfig "would set core.sshCommand in the clone's own .git/config: the deploy key and github.com's pinned host keys; nothing global"
        return 0
    fi
    if ! git -C "$INSTANCE_DIR" config core.sshCommand "$cmd"; then
        record FAIL gitconfig "could not set core.sshCommand in $INSTANCE_DIR/.git/config"
        return 1
    fi
    origin="$(git -C "$INSTANCE_DIR" config --get remote.origin.url 2>/dev/null || true)"
    if [ "$origin" != "$want" ] && deploykey_origin_is_https "$origin"; then
        if ! git -C "$INSTANCE_DIR" remote set-url origin "$want"; then
            record FAIL gitconfig "could not switch the clone's origin from $origin to $want, which the deploy key needs"
            return 1
        fi
        say "switched the clone's origin from $origin to $want: the deploy key works over SSH only"
        switched="; origin switched from $origin to $want"
    fi
    record DONE gitconfig "core.sshCommand in $INSTANCE_DIR/.git/config: the deploy key and github.com's pinned host keys; nothing global$switched"
    return 0
}
