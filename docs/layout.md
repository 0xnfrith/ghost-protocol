# Workspace layout

An instance's machine keeps its work under one folder, the **root**. The instance's own repo, its **home**, sits in the root beside a few shared folders. The manifest names the root and the instance's name ([schema v1](../install/schema/instance-v1.md)), the installer builds the layout, and [`install/layout/move`](../install/layout/move) moves an older single-folder instance into it.

## The folders

| Path | What it holds | Owner |
|---|---|---|
| `<root>/` | The workspace root, named by the manifest's `root`. | operator |
| `<root>/<name>/` | The instance's own repo: its home, where Claude Code runs. | instance |
| `<root>/repos/<owner>/<repo>/` | Every other repo the instance works on, one clone each, grouped by owner. | instance |
| `<root>/worktrees/<repo>/<branch>/` | Every branch being worked on, one worktree each, for the home and for every repo in `repos/`. | product |
| `<root>/media/` | Large files that stay out of git: recordings, images, exports. | product |
| `<root>/desk/` | The operator's scripts waiting to run: one-off moves, fixes, rehearsals. | operator |
| `<root>/scratch/` | Throwaway files. Anything here may be deleted after 7 days. | anyone |

- **Product** is Ghost Protocol: it decides the folder's shape and the tools that fill it.
- **Instance** is the instance's repo and its setup: they decide what goes there.
- **Operator** is the person who runs the instance.

An instance's name can't be one of the shared folders' names (`repos`, `worktrees`, `media`, `desk`, `scratch`). The root can't be the home folder or a folder above it.

## The rules

1. **The home stays on main.** `<root>/<name>` is a clone of the instance repo on its default branch. It only moves forward (pulls, fast-forwards). Nothing is edited or committed there.
2. **Edits go through worktrees.** Every change, in the home or in any repo in `repos/`, is made in a worktree, committed there, and lands by pull request.
3. **Worktrees go to `<root>/worktrees/<repo>/<branch>`**, where `<repo>` is the repo's folder name. Claude Code's worktree hook puts them there (below). To make one by hand: `git -C <root>/<name> worktree add <root>/worktrees/<name>/<branch> -b <branch> origin/main`.

## The worktree hook

[`install/layout/worktree-hook`](../install/layout/worktree-hook) is a Claude Code `WorktreeCreate` and `WorktreeRemove` hook. The installer's layout step and the move script wire it into the user's Claude Code settings (`~/.claude/settings.json`), so it applies to every session on the machine. `worktree-hook unwire` takes it out again.

- **Where:** a worktree of a layout repo goes to `<root>/worktrees/<repo>/<name>`, on a branch called `<name>`. A layout repo is the home (a folder directly in the root holding `.ghost-protocol/instance.toml`) or a repo at `<root>/repos/<owner>/<repo>`.
- **Everything else** gets the place Claude Code itself uses, `<repo>/.claude/worktrees/<name>` on branch `worktree-<name>`, so the hook never stops a worktree from being made. That covers:
  - any other repo, submodules included;
  - a root with no `worktrees/` folder;
  - a name already taken in `worktrees/<repo>/`, for example by another repo with the same folder name.
- **Which branch:** a new branch starts from the remote's default branch as last fetched, with no upstream set. A branch that already exists is checked out as it is, and a folder that is already a worktree of the repo is reused. A name equal to the default branch is refused.
- **Like Claude Code's own worktrees:**
  - the ignored files a repo's `.worktreeinclude` names are copied in;
  - a path that passes through a link below the repo is refused.
- **Removal:** it removes only worktrees it places, never a main checkout. The branch is deleted only when it is merged into the `HEAD` of the repo's main checkout; otherwise it is kept.
- **Differences from Claude Code's own worktrees,** for every repo on the machine once the hook is wired:
  - `worktree.baseRef` is not read: a new branch always starts from the remote's default branch.
  - Claude Code keeps the worktrees a hook made for subagents and workflows. Remove them with `git worktree remove` when the work is done.
- **Not covered:**
  - A worktree made with `git worktree add` in a shell: follow rule 3 by hand.
  - Claude Code asks before it enters an existing worktree outside `.claude/worktrees/` by path. Making a new worktree never asks.

## Moving an old single-folder instance

Before this layout, an instance lived in one folder, usually `~/<repo>`. [`install/layout/move`](../install/layout/move) moves it to `<root>/<name>`:

- **Dry run first:** without `--apply` it runs every check and prints every action, and changes nothing.
- **What it carries:**
  - the repo, with a link left at the old path;
  - Claude Code's project folder for the old path (the transcripts and memory), with a link back;
  - the old path's project entry in `~/.claude.json` (its trust included);
  - plugin and marketplace paths that named the old folder;
  - the repo's worktrees.
- **The hook:** it builds the shared folders and wires the worktree hook.
- **Rollback:** `--rollback` undoes it from a state file.
- **What it refuses:** it never stops anything itself. It refuses to run while any Claude Code session runs, since Claude Code rewrites `~/.claude.json` when it exits, or while the instance's service is active.
- **Links:** a Claude Code file that is a link (a dotfiles setup) stays a link; the file it names is edited, with its mode kept.

After the move, the manifest is written as schema v1 with the new root (the move script prints the lines).

The installer never moves anything. It takes `<root>/<name>` whenever that exists, also when `~/<repo>` is a link to it. It uses an old `~/<repo>` only while there is no `<root>/<name>`: it says so, and builds no layout around it.

A schema v0 manifest whose `dir` is `~/<root>/<name>` is read as v1 for where the home is. The installer builds the folders and wires the hook only for a manifest that says v1, since the hook applies to every session on the machine.

## The service

[`install/service/start`](../install/service/start) runs an instance: Claude Code in `<root>/<name>`, in tmux on the instance's own socket, resuming its session across restarts. `start --root <root> --name <name> --print-unit` prints the systemd unit that runs it ([template](../install/service/instance.service)). Things about it:

- **The operator installs and enables it.** Nothing in Ghost Protocol enables or starts it.
- **Credentials and extra environment come from a drop-in the instance owns** (`/etc/systemd/system/<name>.service.d/`). `start` exports each credential as an environment variable and never prints one.
- **It checks before it starts**, and refuses when a check fails: GHOST Protocol's plugin installed and enabled where the instance runs, buzz-mcp built, the channel allowed in Claude Code's managed settings, and the home trusted in `~/.claude.json`. An untrusted home is refused, since Claude Code would wait at its trust dialog and the instance would hear nothing; `start` never presses a key to get past a dialog. `--dry-run` prints the checks, and, run outside the service, also checks that each of the unit's encrypted credentials decrypts.
- **The persona and the start prompt.** A persona file (`GP_PERSONA`, by default `<home>/.claude/persona/<name>.md`) is added on top of Claude Code's own system prompt. A start prompt file (`GP_START_PROMPT`) becomes the session's first prompt on every start, with `{{host}}`, `{{time}}` and `{{session_note}}` filled in. `{{time}}` is in `GP_TIME_ZONE` when it is set (an IANA name such as `Region/City`), else in the machine's local zone; only that time changes, not the zone claude runs in.
- **`--test` proves the channel registers** with no dialog: a throwaway session on a tmux socket of its own, without credentials, with the plugin's relay and key replaced by unreachable and random ones. It reads the screen for the channel's notice, then removes everything it made.
- **Its session follows `/clear` and `/resume`, and can start fresh.** The plugin's `session-id` hook writes the new id after either, in the instance's own `claude` only (the one in the tmux pane, whose pid the start script writes to `pane-pid`), so a restart or a crash resumes the conversation it went on in. When that `claude`'s window ends while other windows keep the tmux session alive, the start script starts it again in a new window of the session and leaves the other windows alone (see [Restarts](../README.md#restarts)). While `~/.local/state/ghost-protocol/<name>/fresh` exists, the next start begins a new session instead, then deletes the file. `start --fresh`, meant for unattended agents, sets it without cutting off work: it waits until the instance is idle (its turn over with no background Agent run or workflow left going, no recent writes by a subagent or another conversation, no tool command running), then ends the session, and the watchdog starts the new one at once. Asked from the instance's own session, it returns at once and waits in the background. See "Fresh starts" in the [README](../README.md#fresh-starts).
- **Unattended mode** (the plugin setting `unattended`, off by default, read only from the instance's settings file and Claude Code's managed settings) is for an instance nobody watches: `--permission-mode auto`, a settings copy that turns off the auto-mode setup offer and lets a safeguard flag switch the model, and a hook that denies every permission dialog so the turn ends and reports. See [Unattended mode](../README.md#unattended-mode).
- **An update restarts it.** `boot.sh --update` moves GHOST Protocol's checkout to a new pinned commit, and the installer's update steps then restart `<name>.service` if it is running (`systemctl try-restart`). A stopped unit stays stopped. See "Updating an instance" in the [README](../README.md#updating-an-instance).
