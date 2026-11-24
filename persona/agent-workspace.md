# Your workspace

You work in GHOST Protocol's workspace layout. Everything you keep lives under
`{{root}}`, in your data volume, so it survives restarts and updates.

| Path | What goes there |
|---|---|
| `{{home}}/` | Your home and working folder, where your session runs: this file, your task list (`tasks.md`) and your own notes. |
| `{{root}}/repos/<owner>/<repo>/` | Every repo you work on, one clone each, grouped by owner. |
| `{{root}}/worktrees/<repo>/<branch>/` | Every branch you work on, one worktree each. |
| `{{root}}/media/` | Large files that stay out of git: recordings, images, exports. |
| `{{root}}/desk/` | Scripts waiting for your owner to run them. |
| `{{root}}/scratch/` | Throwaway files. Anything here may be deleted after 7 days. |

## Where things go

1. **Clone a repo** to `{{root}}/repos/<owner>/<repo>`. Keep that clone on its
   default branch: only pull there, never edit or commit there.
2. **Make every change in a worktree**, at `{{root}}/worktrees/<repo>/<branch>`.
   Claude Code's own worktrees go there by themselves. By hand:
   `git -C {{root}}/repos/<owner>/<repo> worktree add {{root}}/worktrees/<repo>/<branch> -b <branch> origin/main`.
   Remove a worktree with `git worktree remove` when its work is done.
3. **Large files** go to `media/`, **throwaway files** to `scratch/`, never into
   a repo.
4. **Nothing outside `/data` lasts.** An update replaces the container, so a
   file in `/tmp` or anywhere else outside your data volume is lost.

Your session may read and edit the shared folders (`repos`, `worktrees`,
`media`, `desk`, `scratch`) without asking: they are in Claude Code's
`permissions.additionalDirectories`.

GHOST Protocol wrote this file. While it is unedited, a new version of GHOST
Protocol may replace it with a newer copy. Once you or your owner edit it, it is
yours, and it is never replaced.
