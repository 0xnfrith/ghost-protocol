# Status line

GHOST Protocol's status line for Claude Code: two lines under the prompt, redrawn every second.

```
main ◆ /home/agent/work/agent ◆ Opus 5.5 ◆ █████░░░░░ 50% ◆ EFF high
GHOST ▸ ◆ BKK 15:00 │ EST 03:00 │ PST 00:00 │ UTC 08:00
```

With an instance's own name, glitch and quotes turned on, line 2 reads like this (the name glitches one character a second, and the quote changes each minute):

```
幽霊 ghost.one ▸ ┄┄ 「 The net is vast and infinite. 」 ┄┄ ◆ BKK 15:00 │ EST 03:00 │ PST 00:00 │ UTC 08:00
```

## What each part shows

| Part | What it shows |
|---|---|
| branch | The git branch of the session's folder. Hidden outside a git repo. |
| folder | The session's folder, always as the full path, never shortened with `~`. |
| model | The model's name and version, such as `Opus 5.5`. When Claude Code's display name has no version, the version is read from the model id (`claude-opus-5-5` gives `5.5`). |
| context bar | How close the conversation is to compaction: 10 cells and a percentage. **A full bar means compaction is due.** See below. |
| effort | `EFF` and the session's effort level, coloured by level. Hidden when the model has no effort setting. |
| name | `GHOST ▸` by default. An instance can set its own name, and a glitch that animates it (below). |
| quote | None by default. An instance can set a list of quotes; one shows each minute. |
| clocks | Bangkok, US East and US West time, then this machine's own time, labelled with its time zone (`SRV` when the zone has no name). |

## The context bar

Claude Code compacts the conversation before the context window is full. The bar fills toward that compaction point, not toward the whole window, so 100% means compaction is due.

- **The compaction point** is, for current models, the auto-compact window minus 33,000 tokens: Claude Code keeps up to 20,000 free for the reply, and compacts 13,000 before that. With no window set, a model with a 1M context window compacts at about 967,000 tokens. `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (a percent from 1 to 100 of the window less the reply's 20,000) can only bring the point earlier, and the bar follows it.
- **The auto-compact window** is found the way Claude Code finds it. The first of these wins:
  1. the `CLAUDE_CODE_AUTO_COMPACT_WINDOW` environment variable (a number of tokens, or with `k` or `M`);
  2. `autoCompactWindow` in the settings files, highest first, the first file that sets it winning:
     - managed settings: the drop-ins in `managed-settings.d/` (the last by name first), then `managed-settings.json`, in `/etc/claude-code/` on Linux or `/Library/Application Support/ClaudeCode/` on macOS (the eight highest of these files);
     - the `--settings` file, when [`install/service/start`](../install/service/start) started the session (it names the file in `GP_CLAUDE_SETTINGS`);
     - `.claude/settings.local.json` at the repository's root (for a worktree, the main checkout's root), else in the folder Claude Code was started in;
     - `.claude/settings.json` in the folder Claude Code was started in;
     - the user's `settings.json`, in `~/.claude` or `$CLAUDE_CONFIG_DIR`.

     Within one file, the model's own entry in `modelSettings` beats the top-level key. `"auto"` means the model's own window;
  3. the model's context window.
  The window is capped at the model's context window.
- **The tokens counted** are the ones Claude Code compares with that point: the last request's input (with cached input) and the last reply's output, from `current_usage` when Claude Code sends it.
- **With compaction off** (`DISABLE_AUTO_COMPACT`, `DISABLE_COMPACT`, or `autoCompactEnabled: false`), the bar measures the whole context window, as Claude Code's own `used_percentage` does.

What the status line cannot see, so the bar can be off when one of these is used: a window set with the `--autocompact` flag, a `--settings` file the start script did not pass, managed settings from MDM or the claude.ai console, and a window Claude Code chooses on its own for some sessions (for example cloud sessions).

## Instance settings: the name, its glitch and the quotes

They live in one file, `${XDG_CONFIG_HOME:-~/.config}/ghost-protocol/statusline/config.json`, beside the instance's other private settings in `~/.config/ghost-protocol/`. With no file, the status line shows `GHOST ▸`, still, and no quote. There is no switch for them in Claude Code's plugin settings: they belong to the instance, not to the person using it.

The installer never writes this file. The instance puts it there itself: its setup hook (the installer's step 6) can copy it from the instance's own repo, or a restore of the instance's backup can bring it back. Every session of the machine's user shows the same name, one instance per user.

```json
{
  "name": "幽霊 ghost.one",
  "glitch": "幻影 ｺﾞｰｽﾄ ﾜﾝ ｱ▶",
  "quotes": [
    "The net is vast and infinite.",
    "And where does the newborn go from here?"
  ]
}
```

- **`name`**: the name before the `▸`.
- **`glitch`**: turns the animation on. Each second one more character of the name, from the left, is replaced by the character at the same place in `glitch`, until all of it shows; then the name comes back. The glitch covers the name and the ` ▸` after it, so it must have exactly two more characters than `name`, or the name stays still. Give each place the same width in both (a wide character such as 幽 for a wide one, a half-width one such as ｺ for a narrow one), or the line jumps.
- **`quotes`**: turns the quote on. One quote shows each minute, in turn.

Why a file and not the plugin's settings or the instance manifest: Claude Code passes a plugin's `userConfig` values only to the plugin's own MCP and LSP servers, hooks, skills and agents, never to a status line command. It also asks for them when the plugin is enabled and lists each one in `/config`, so they would face whoever installs it. The instance manifest is read once, by the installer; the status line reads its settings every second.

## How it is wired

A plugin cannot set the main status line: Claude Code applies only the `agent` and `subagentStatusLine` keys of a plugin's settings. So the installer's step 7b runs [`wire`](wire), which writes this `statusLine` into the user's `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`):

```json
{
  "statusLine": {
    "type": "command",
    "command": "<the GHOST Protocol checkout>/statusline/statusline.sh",
    "refreshInterval": 1
  }
}
```

It points at the checkout the installer runs from, a path that stays the same when GHOST Protocol is updated. `wire` keeps a `refreshInterval` you set yourself, keeps every old settings file as `settings.json.bak-statusline-<time>`, and `wire unwire` takes the status line out again. `statusline/wire --help` has the details.

**Moving from another status line:** `wire` leaves one alone, and the installer says so and goes on. To use this one instead, run `statusline/wire wire --replace`; the old `statusLine` is kept in the backup.

## Requirements and limits

- bash 3.2 or later, `jq` and `date`; `git` for the branch. Without `jq` the status line prints one line asking for it, and `wire` refuses.
- `wire` writes the script's path unquoted, so it refuses a checkout whose path holds anything but letters, digits and `. _ - /` (a space, for example).
- A status line command must never write to stderr or exit non-zero, or Claude Code may show nothing. The script silences every command that can fail, and draws what it can: a settings or instance file that is not valid JSON is skipped, and the others still count.
- The script reads only the keys it needs from the settings files, and strips control characters from every text it shows, so nothing in them can reach the terminal as an escape sequence.

The tests are in [`install/test/statusline.test.sh`](../install/test/statusline.test.sh).
