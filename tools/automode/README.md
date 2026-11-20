# automode

`watch` compares Claude Code's auto-mode rules with a snapshot, and changes nothing.

Claude Code's auto mode decides what the agent may do without asking from three lists of plain-English rules in the user's settings file, `~/.claude/settings.json`: `autoMode.allow`, `autoMode.soft_deny` and `autoMode.hard_deny`. An instance keeps a copy of the three lists, the snapshot, in its own repo, so a rebuilt machine gets them back. `watch` says whether the two drifted apart, either way:

- **VANISHED:** a snapshot rule that is missing from the settings file.
- **NEW:** a rule in the settings file that is not in the snapshot yet, so it is not backed up.

The [session hook](../../hooks/README.md#auto-mode-drift-check) runs it when the instance's main thread starts, with the snapshot as committed on the instance repo's `main`, and takes no side: a VANISHED rule may have been dropped from the settings, or added to the snapshot. The [auto-mode guard](../../README.md#auto-mode-guard) makes the same comparison itself every 15 minutes, with the signing ledger too, and asks the owner on Buzz.

## Use

```sh
tools/automode/watch --against <snapshot>            # counts, then each VANISHED and NEW rule
tools/automode/watch --against <snapshot> --json     # the same, as one JSON report
tools/automode/watch --snapshot > <snapshot>         # a new snapshot from the settings file
```

`--settings <file>` reads another settings file instead of `~/.claude/settings.json`.

**Exit codes:**
- 0: no drift;
- 1: a rule drifted, either way;
- 2: an error, such as a file that is missing or is not JSON. The message names the path and a position, never the file's content.

`--snapshot` exits 0. It refuses (exit 2) a rule that holds a control or format character (Unicode Cc or Cf), which a snapshot must never carry.

## What it reads and prints

- **Only the three lists.** It reads the settings file's `autoMode` key, and of that only `allow`, `soft_deny` and `hard_deny`. Nothing else in the file reaches its output: not `autoMode.environment`, and not the `env` block, which may hold live keys.
- **Escaped rules.** Every rule it prints is JSON-quoted, with invisible characters (Unicode Cc, Cf, Co, Cs, Cn, Zl, Zp) escaped. So a rule can't hide or rewrite what is around it on a terminal.
- **Sets, not lists.** Each list is compared as a set, so a rule listed twice changes nothing.
- **It writes nothing.**

The `--json` report:

```json
{
  "drift": true,
  "live": {"allow": 12, "soft_deny": 5, "hard_deny": 0},
  "snapshot": {"allow": 12, "soft_deny": 6, "hard_deny": 0},
  "vanished": [{"list": "soft_deny", "shown": "\"the rule, JSON-quoted\""}],
  "new": [],
  "digest": "<64 hex characters>"
}
```

- `shown` is the whole rule as the plain output prints it, never cut short.
- `digest` is a sha256 of the full rules that drifted, tagged by direction and list. With no drift it is `null`. Two drifts that share a long beginning never give the same digest.

It needs python3. Its test is `install/test/automode-watch.test.sh`.
