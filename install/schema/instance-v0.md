# Instance manifest, schema v0

> Superseded by [schema v1](instance-v1.md), which names a root and a name
> instead of one folder. The installer still reads v0: a `dir` of
> `~/<root>/<name>` is read as v1 with that root, and any other v0 manifest is
> a single-folder instance, exactly as described here.

An instance is a repo that the installer sets a machine up to run. Its
manifest is the file `.ghost-protocol/instance.toml` on the repo's `main`.
The installer reads it with `awk` (`install/lib/manifest.awk`) and then checks
each value (`manifest_check_values` in `install/lib/instance.sh`). Any problem
stops the run, and every problem is listed with its line number.

## The format: a strict subset of TOML

Only these lines are allowed:

- blank lines;
- whole-line comments, starting with `#`;
- section headers: `[github]`, `[claude]`, `[setup]`;
- `key = "string"`: one string in double quotes, with no backslash, no
  double quote and no tab inside;
- `key = ["a", "b"]`: an array of such strings, on one line. `[]` is an empty
  array. A trailing comma is an error.

Anything else is an error: inline comments, multi-line arrays, numbers,
booleans, tables of tables, escapes. Each key and each section may appear only
once. Unknown keys and unknown sections are errors, so a typo never passes
silently. Later schema versions add sections.

## Keys

| Key | Required | Type | Meaning |
|---|---|---|---|
| `schema` | yes | string | Exactly `"ghost-protocol/instance/v0"`. |
| `name` | yes | string | The instance's short name: lower-case letters, digits and dashes. |
| `dir` | no | string | Where the instance is cloned, starting with `~/` or `/`. Default: `~/<repo name>`. `--instance-dir` overrides it. |
| `[github] login` | yes | string | The GitHub login the machine must act as in token mode (a gh sign-in). A different login is refused (exit 5). The summary says which login matched. Integration mode does not match it: the integration acts as its own identity (by default a shared GitHub App bot, not a user login), and its host answers only `/repos/OWNER/REPO/...` paths, so `/user` is refused. There the account check is instead that the integration answers the GitHub API (`gh api repos/<owner>/<repo>`) for the instance repo and each repo in `repos`. Deploykey mode (`--github deploykey`) does not match it either: a deploy key acts as its repo, not as a login. There the check is that the key can push to the instance repo (`git push --dry-run`, which sends nothing); a read-only key stops the run (exit 1). |
| `[github] also_login` | no | string | Token mode only: one more login the machine may act as, for example a rehearsal account. It lives here, in the reviewed manifest, so no command-line flag can widen the account check. |
| `[github] host_config` | no; needed in integration mode (checked before cloning) | string | A git config file, starting with `~/`, with no `.`, `..` or empty path segments, and never git's own global config (`~/.gitconfig`, `~/.config/git/config`), where integration mode writes one `url.<integration>.insteadOf` line per repo. The instance's own setup makes the user's git config include it. Deploykey mode does not use it: it sets `core.sshCommand` in the clone's own `.git/config`. |
| `[github] repos` | no | array | Other `owner/repo` repos reached through the integration. The instance repo is always included. In integration mode the account check asks the GitHub API for each one; a repo the integration does not answer for stops the run (exit 1) before any git config line is written, and a clone this run made is deleted. Deploykey mode does not reach them: a deploy key reaches the instance repo only, and the run says so. |
| `[claude] email` | yes | string | The Claude account the machine must be signed in to. A different account is refused (exit 5). |
| `[setup] command` | yes | string | The instance's setup hook, run from the instance directory. Plain words separated by spaces: letters, digits and `_ . / { } = -` only, so no shell is ever involved. The first word is a path inside the repo. `{profile}` becomes `vm` or `laptop`. A dry run appends `--dry-run`, so the hook must accept it and change nothing. |

## Example

```toml
# The instance manifest for example/instance.
schema = "ghost-protocol/instance/v0"
name = "instance"
dir = "~/instance"

[github]
login = "example-bot"
host_config = "~/.gitconfig-host"
repos = ["example/tools"]

[claude]
email = "owner@example.com"

[setup]
command = "bin/setup --profile {profile} --no-auth"
```
