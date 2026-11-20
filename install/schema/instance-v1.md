# Instance manifest, schema v1

An instance is a repo that the installer sets a machine up to run. Its
manifest is the file `.ghost-protocol/instance.toml` on the repo's `main`.
The installer reads it with `awk` (`install/lib/manifest.awk`) and then checks
each value (`manifest_check_values` in `install/lib/instance.sh`). Any problem
stops the run, and every problem is listed with its line number.

v1 names a **root** and a **name** instead of one folder: the instance's home
is `<root>/<name>`, inside the root layout ([`docs/layout.md`](../../docs/layout.md)).
Schema v0 ([`instance-v0.md`](instance-v0.md)) is still read; see Migration below.

## The format: a strict subset of TOML

Only these lines are allowed:

- blank lines;
- whole-line comments, starting with `#`;
- section headers: `[github]`, `[claude]`, `[setup]`, `[memory_guard]`, `[automode_guard]`, `[memory_backup]`;
- `key = "string"`: one string in double quotes, with no backslash, no
  double quote and no tab inside;
- `key = ["a", "b"]`: an array of such strings, on one line. `[]` is an empty
  array. A trailing comma is an error.

Anything else is an error: inline comments, multi-line arrays, numbers,
booleans, tables of tables, escapes. Each key and each section may appear only
once. Unknown keys and unknown sections are errors, so a typo never passes
silently.

## Keys

| Key | Required | Type | Meaning |
|---|---|---|---|
| `schema` | yes | string | Exactly `"ghost-protocol/instance/v1"`. |
| `name` | yes | string | The instance's short name: lower-case letters, digits and dashes. Its home is `<root>/<name>`. It may not be one of the layout's folders: `repos`, `worktrees`, `media`, `desk`, `scratch`. |
| `root` | yes | string | The workspace root, starting with `~/` or `/`. Letters, digits and `. _ - /` only, with no `.`, `..` or empty segments and no trailing `/`. Never the home folder itself or a folder above it. `--instance-dir` overrides where the home goes; the layout is built only when that is `<root>/<name>`. |
| `[github] login` | yes | string | The GitHub login the machine must act as in token mode (a gh sign-in). A different login is refused (exit 5). The summary says which login matched. Integration mode does not match it: the integration acts as its own identity (by default a shared GitHub App bot, not a user login), and its host answers only `/repos/OWNER/REPO/...` paths, so `/user` is refused. There the account check is instead that the integration answers the GitHub API (`gh api repos/<owner>/<repo>`) for the instance repo and each repo in `repos`. Deploykey mode (`--github deploykey`) does not match it either: a deploy key acts as its repo, not as a login. There the check is that the key can push to the instance repo (`git push --dry-run`, which sends nothing); a read-only key stops the run (exit 1). |
| `[github] also_login` | no | string | Token mode only: one more login the machine may act as, for example a rehearsal account. It lives here, in the reviewed manifest, so no command-line flag can widen the account check. |
| `[github] host_config` | no; needed in integration mode (checked before cloning) | string | A git config file, starting with `~/`, with no `.`, `..` or empty path segments, and never git's own global config (`~/.gitconfig`, `~/.config/git/config`), where integration mode writes one `url.<integration>.insteadOf` line per repo. The instance's own setup makes the user's git config include it. Deploykey mode does not use it: it sets `core.sshCommand` in the clone's own `.git/config`. |
| `[github] repos` | no | array | Other `owner/repo` repos reached through the integration. The instance repo is always included. In integration mode the account check asks the GitHub API for each one; a repo the integration does not answer for stops the run (exit 1) before any git config line is written, and a clone this run made is deleted. Deploykey mode does not reach them: a deploy key reaches the instance repo only, and the run says so. |
| `[claude] email` | yes | string | The Claude account the machine must be signed in to. A different account is refused (exit 5). |
| `[setup] command` | yes | string | The instance's setup hook, run from the instance directory. Plain words separated by spaces: letters, digits and `_ . / { } = -` only, so no shell is ever involved. The first word is a path inside the repo. `{profile}` becomes `vm` or `laptop`. A dry run appends `--dry-run`, so the hook must accept it and change nothing. |
| `[memory_guard] enabled` | no | string | `"true"` or `"false"`. Left out, the installer's memory guard (step 14: earlyoom on Debian and Ubuntu; see the README) runs on the `vm` profile only. `"true"` turns it on for the `laptop` profile too. `"false"` turns it off anywhere; an earlyoom already set up on the machine is then left as it is, and the installer prints how to remove it. |
| `[memory_guard] term_percent` | no; only together with `kill_percent` | string | earlyoom asks one process to stop (SIGTERM) when available memory falls to this percentage of RAM. A whole number, at most 50, in quotes. Default `"15"`. |
| `[memory_guard] kill_percent` | no; only together with `term_percent` | string | earlyoom kills one process outright (SIGKILL) when available memory falls to this percentage. A whole number of at least 1, below `term_percent`, in quotes. Default `"8"`. |

| `[automode_guard] enabled` | no | string | `"true"` or `"false"`. Left out, the section is on. `"false"` turns the [auto-mode guard](../../README.md#auto-mode-guard) off: the installer then prints how to remove one already set up, and the session hook prints nothing. With `"false"` the other keys may be left out. |
| `[automode_guard] snapshot` | yes, once the section is on | string | The snapshot of Claude Code's auto-mode rules: a file in the instance repo, as a path from its top (letters, digits and `_ . - /`, no `.` or `..` segments, no leading `/`). Its content is what `tools/automode/watch --snapshot` prints. It is read as committed on the instance repo's `main` (with git), never from the working tree, and it must be a plain file there: the installer, the guard and the session hook refuse a committed symlink, or a path through a committed folder symlink. The instance home must be the main checkout, with a `.git` folder of its own. |
| `[automode_guard] buzz_relay_url` | yes, once on | string | The Buzz relay the message goes through: `https://` or `wss://`, a host, an optional port and path. |
| `[automode_guard] buzz_key_command` | yes, once on | string | The command that prints the relay private key, as the Buzz adapter's `buzz_key_command`: plain words of letters, digits and `_ . / ~ : = @ + , -`, so it reaches the unit unchanged. It runs inside the guard's sandbox. |
| `[automode_guard] buzz_channel` | yes, once on | string | The Buzz channel the message goes to: a channel id, lower-case hex in 8-4-4-4-12 form. |
| `[automode_guard] buzz_mentions` | no | array | Public keys the message notifies, each 64 lower-case hex characters. |
| `[automode_guard] buzz_task_open_emoji` | no | string | When set, each alert is a [task root](../../adapters/buzz/README.md#dm-task-roots): the open state goes on it right after it is sent. A custom emoji's name (lower-case letters, digits, `_` and `-`), which needs `buzz_task_open_emoji_url`, or one plain emoji (never 🚨). Left out, alerts get no state. |
| `[automode_guard] buzz_task_open_emoji_url` | with a custom `buzz_task_open_emoji` | string | The custom emoji's image: `https://`, a host, an optional port and a path. |
| `[automode_guard] read_paths` | no | array | Paths the key command needs inside the guard's sandbox, where home folders are otherwise hidden: each `~/<path>` or `/<path>` (letters, digits and `. _ - /`, no `.`, `..` or empty segments). Each is mounted read-only. Credentials the key command needs go in the unit's drop-in instead. |
| `[automode_guard] owner` | no | string | The owner's public key, 64 lower-case hex characters, never the key the guard posts with: the one key whose replies the guard acts on (Keep, Remove, Put back, Leave out, Show me them). It is always mentioned in the messages. Left out, the messages carry no options and no reply is read. |
| `[automode_guard] ledger` | no | string | The signing ledger, a plain file: `~/<path>` or `/<path>` (letters, digits and `. _ - /`, no `.`, `..` or empty segments), never the settings file or a symlink. The guard treats a rule whose latest line adds it, with no expiry or one still to come, as signed: a record, not proof of who made the rule (a plain line of text the instance's user can write, not a key signature: the guard is a drift detector, not a security boundary; see the [auto-mode guard](../../README.md#auto-mode-guard)). An add whose expiry has passed, or can't be read, is no longer signed. The guard appends a line for each answer it applies. The unit binds this one file read-write; the installer makes it empty (`0600`) when it is not there. Left out, the guard keeps its own in its state folder. |

| `[memory_backup] enabled` | no | string | `"true"` or `"false"`. Left out, the section is on. `"false"` turns the [memory backup](../../README.md#memory-backup) off; with it the other keys may be left out. |
| `[memory_backup] folder` | yes, once the section is on | string | The Claude Code memory folder to back up: `~/<path>` or `/<path>` (letters, digits and `. _ - /`, no `.`, `..` or empty segments). |
| `[memory_backup] remote` | yes, once on | string | The instance repo's `https://` URL: a host, an optional port and a path, with no user or token in it. The push goes as the machine is, with no credential helper. |
| `[memory_backup] branch` | yes, once on | string | `memory/<name>`: lower-case letters, digits and dashes under `memory/`, so it can never be `main`. |
| `[memory_backup] buzz_relay_url`, `buzz_key_command`, `buzz_channel` | no; the three together | string | Where alerts go, in the same form as `[automode_guard]`'s. Without them, alerts are logged only. |
| `[memory_backup] buzz_mentions`, `read_paths` | no | array | As for `[automode_guard]`: who the alerts notify, and what the key command reads inside the sandbox. |
| `[memory_backup] buzz_task_open_emoji`, `buzz_task_open_emoji_url` | no | string | As for `[automode_guard]`: each alert is a task root. |
| `[memory_backup] max_file_kb` | no | string | A whole number from 1 to 9999999, default `"1024"`: a file over this many KB is left out of the backup and reported. |
| `[memory_backup] max_removed_percent` | no | string | A whole number from 1 to 100, default `"30"`: when a run would remove more than this share of the notes, the removals alone are held back and reported (the rest goes in) until `backup run --accept-removals` takes on those notes; a note held back stays held while it is gone. |

`dir` is not a v1 key: a v1 manifest with `dir` is refused.

The `[automode_guard]` values are checked for their form only: the manifest check never looks at the disk, because every hook reads the manifest, and a missing file must not switch the others off. The installer's step reports a snapshot that is not there.

`[memory_guard]` came after the first v1 installers, which refuse it as an unknown section, so an instance that sets it needs an installer that has the memory guard. A v0 manifest may hold it too. The same goes for `[automode_guard]` and `[memory_backup]`, which also reach the hooks: a plugin older than the section refuses the whole manifest, and every hook then does nothing for that instance. Update the plugin and the installer first, then add the section. The same holds for a new key in a section: `buzz_task_open_emoji` and `buzz_task_open_emoji_url` need a plugin and an installer that know them before they go into `[automode_guard]` or `[memory_backup]`. For example:

```toml
[memory_guard]
term_percent = "20"
kill_percent = "10"
```

## Unattended mode is not a manifest key

[Unattended mode](../../README.md#unattended-mode) (for an instance nobody watches: permission dialogs denied, `--permission-mode auto`, no auto-mode setup offer, a model switch without asking) is the plugin setting `unattended` in the instance's settings file (`~/.config/ghost-protocol/<name>.json`, the one the service passes with `--settings`), with `GP_PERMISSION_MODE` in the instance's drop-in to name another mode. It is not in this manifest, for three reasons:

- **It is about how this machine runs the instance,** not about the repo: the same instance repo may run attended on a laptop and unattended under its service. The settings file and the drop-in are the machine's.
- **Every hook reads the manifest,** and a plugin older than a new key refuses the whole manifest, which would switch every hook off for that instance (the trap described above for `[memory_guard]` and `[automode_guard]`).
- **The start script already reads the instance's settings file** (and Claude Code's managed settings, which come first), and it hands the mode to the session, so the four pieces cannot disagree. It reads `unattended` from those two only, never from the home's `.claude/` settings or the user's: a stray value there must not turn the mode on for a session a person runs.

## A key service is not a manifest key

A [key service](../../README.md#key-service), which keeps the instance's relay key with a separate OS user, is set up by the machine's admin with `install/keyservice/setup`, not by a manifest key, for the same reasons as unattended mode, and one more:

- **It is about how this machine runs the instance:** the same instance repo may run with its key in a key command on one machine and behind a key service on another.
- **Every hook reads the manifest,** and a plugin older than a new key refuses the whole manifest.
- **The instance's own user cannot set it up:** it needs root, and the point of it is that this user has none. The admin's setup records it in `/etc/ghost-protocol/<name>/`, where the installer's update step and the auto-mode guard's step see it.

## Migration from v0

The installer reads a v0 manifest in one of two ways, and says which in the
summary:

- **Read as v1 for the home.** When `dir` is `~/<root>/<name>` (under the
  home folder, its last segment equal to `name`, and its parent a valid root),
  the parent is the root. The installer chooses the home as for v1, so
  `<root>/<name>` wins over an old `~/<repo>`. It does not build the layout's
  folders or wire the worktree hook, which reaches every session on the
  machine, until the manifest says v1. It prints the two lines to write:
  `schema = "ghost-protocol/instance/v1"` and `root = "~/<root>"`, with `dir`
  dropped.
- **A single folder.** Any other v0 manifest (no `dir`, a `dir` directly in the
  home folder, an absolute `dir`, or a last segment that is not the name) keeps
  the old behaviour: the instance lives in that one folder (`dir`, else
  `~/<repo>`) and no layout is built. To move it into the layout, run
  `install/layout/move` (dry run first), then write the manifest as v1.

## Example

```toml
# The instance manifest for example/instance.
schema = "ghost-protocol/instance/v1"
name = "instance"
root = "~/work"

[github]
login = "example-bot"
host_config = "~/.gitconfig-host"
repos = ["example/tools"]

[claude]
email = "owner@example.com"

[setup]
command = "bin/setup --profile {profile} --no-auth"
```

The instance's home is then `~/work/instance`.
