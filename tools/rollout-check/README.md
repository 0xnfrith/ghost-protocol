# rollout-check

Names every agent that is not yet running the current rule files, and does nothing else. Each agent has two: its class file (`CLAUDE.md` in its home) and its team repo's `AGENTS.md` (in its clone). `rollout-check` compares both, on every agent's VM, with the copy on `main`, reads the proof the agent wrote when its session started, and prints one line when something is wrong. It is meant to run every hour. It **only reads**: applying files, draining and restarting come later, after these reports have been watched to be right. `--plan` says what a version that acts would do for each agent, and what would stop it; this version cannot act.

```sh
rollout-check run --config <file> --state <file> --class-sha-cmd <cmd> --agents-sha-cmd <cmd> [--ssh <cmd>] [--ssh-timeout <secs>] [--json | --plan]
```

A Node CLI with no dependencies (node 22 or later). The logic is in [`lib.mjs`](lib.mjs), the plan in [`plan.mjs`](plan.mjs) and the state names in [`states.mjs`](states.mjs); [`rollout-check`](rollout-check) is a few lines around them.

## What an agent can be

| State | When |
|---|---|
| `current` | Both files on its VM match `main`, and a proof from its **current session and current `claude` process** shows `main`'s shas. |
| `applied, not proved` | Both files match `main`, but the proof is missing, unreadable, of another schema, from another session or from another `claude` process, has no `pane-pid` beside it, shows other shas, or shows `agents: none` while the config names a team repo. A missing proof is "not proved", never an error. |
| `applied, restarts at Done` | The same condition, for an agent whose `role` is `builder` or `reviewer`: it restarts itself with `start --fresh` when its task is done, and that start writes the proof, so it is not wrong for not having one yet. It is shown by `--json` and `--plan` from the first run and left out of the printed line until it has lasted 3 days, since a builder that has not reached Done in 3 days is worth a line. The 3 days count from when the agent first was `applied, not proved` or `applied, restarts at Done`, so giving an agent a role does not start them over. |
| `behind on disk` | A file on the VM differs from `main`, is missing, or is not a regular file. The line names which: `class`, `agents`, or both. |
| `unknown` | ssh failed, timed out, printed too much, or printed something that is not the script's output, whole; or a file is there but could not be read, or the VM has no sha256 tool. Named with the reason, and **never counted as current**. |

A file that could not be read says nothing about the file, so it is `unknown` and not `behind on disk`: an apply would not fix it. A file that is certainly behind is still said, so an agent whose class file differs and whose agents file cannot be read is `behind` (class). An agent with `team_repo: null` is judged on its class file alone.

## The line, and when it is printed

When every agent is `current`, nothing is printed and the exit status is 0. Otherwise one line, with only the sections that have someone:

```
behind: agent-a (class), agent-b (agents), agent-c (class and agents); not proved: agent-d; waiting for Done: agent-f, agent-g; unknown: agent-e (ssh timeout)
```

The unknown reasons are `ssh timeout`, `ssh failed`, `output too large`, `unparseable output`, `class file unreadable`, `agents file unreadable` and `no sha256 tool`. Nothing the VM printed ever reaches the line.

The check is meant to run every hour, but the line is printed **only when the set of non-current agents, or the way one of them is wrong, changes since the last run, and once a day while it stays the same** (24 hours after the last line, less ten minutes, so that a timer's jitter does not push the reminder an hour later). A different reason for the same state (`ssh timeout`, then `ssh failed`) is not a change. A set that shrinks is a change too: someone recovered, and that is said, for as long as someone is still not current. When the last agent recovers, nothing is printed, as when everyone has been current all along.

**A lost state file hides nothing.** A missing, empty, unreadable or malformed state file, one of another schema, one with no usable record of the last set or of the last line, and a last line dated in the future all count as no state, so the line is printed. If the state file cannot be written, the line is still printed, a warning goes to stderr, and the exit status stays 0, so the line is printed again on every run until the file can be written.

## Inputs

**Config** (`--config`, JSON): an array with one entry per agent, the first seven keys required and the last five optional.

| Key | Meaning |
|---|---|
| `name` | The instance's name (lowercase letters, digits, `-`). |
| `ssh` | A host alias that your ssh config resolves (letters, digits, `.`, `_`, `-`; not starting with `-`). |
| `class` | The class name, the argument of `--class-sha-cmd`. |
| `home` | The instance's home folder on the VM: an absolute path. |
| `team_repo` | `owner/repo`, the argument of `--agents-sha-cmd`, or `null` for none. |
| `clone` | The team repo's clone on the VM: an absolute path; `null` or ignored when `team_repo` is `null`. |
| `state_dir` | The instance's state folder on the VM, where `proof.json` and `session-id` are: an absolute path. |
| `role` | Optional. `lead`, `builder`, `reviewer` or `other` (the default). Only a lead is ever restarted by a version that acts; a builder or a reviewer restarts itself at Done. |
| `lead` | Optional, `null` by default. The name of the lead this agent works for: it must be an agent of this config whose role is `lead`, and a lead has none. A lead's pairs are the agents that name it. |
| `root` | Optional, `null` by default. The instance's workspace root on the VM: an absolute path, for `start --root`. |
| `plugin_dir` | Optional, `null` by default. The instance's checkout of the plugin on the VM: an absolute path, where `hooks/sync-mains` and `install/service/start` are. |
| `class_apply` | Optional, `true` by default. `false` leaves the agent's class file alone. |

A config of the first version, with the seven keys, still loads, and every agent is then `other` with nothing else set. None of the five new values is sent to a VM in this version. They are checked as the others are (the same path form, the same instance-name form), so that the version that sends them can quote them.

It is checked strictly, before anything is run: an unknown or missing key, a value that does not match its form (paths are letters, digits, `.`, `_`, `-` and `/`, with no `..`, no empty segment and no trailing `/`), or two agents with the same `name` or the same `ssh` alias stops the run with exit 2, naming the agent and the key. The message shows a bad value as JSON text, cut, so a hostile one cannot reach a terminal.

**Expected shas** (`--class-sha-cmd`, `--agents-sha-cmd`): commands you supply, each given as one string and split into words (no shell reads it: quotes are not special, so wrap anything complex in a script). The class, or the `owner/repo`, is appended as the last word. Each prints the sha256 of that file's bytes on `main` (64 hex characters, nothing else; not git's blob id), and is run **once per distinct value per run**, before any ssh. A command that fails, times out or prints anything else fails the run: exit 2, nothing printed, no ssh, no state written.

**ssh** (`--ssh`, default `ssh -o BatchMode=yes -o ConnectTimeout=10`): the program, with its options, that is run as `<ssh> <alias> <command>`, once per agent, a few at a time (6), each stopped after `--ssh-timeout` seconds (default 30; 1 to 300), with its whole process group. The key is yours: this tool never reads, takes or passes one.

## What runs on a VM

One thing: [`REMOTE_SCRIPT`](lib.mjs), a constant in the code, sent to `sh -s` on ssh's standard input. The command line the VM's shell reads is `sh -s -- '<home>' '<clone>' '<state_dir>'`: config values reach the script only there, single-quoted (with any `'` escaped), after the pattern check above. The script reads and prints; it writes no file and runs no command that writes:

| Line | What it is |
|---|---|
| `class` | The sha256 of `<home>/CLAUDE.md`, else `missing`, `not-a-file` or `unreadable`. |
| `agents` | The same for `<clone>/AGENTS.md`; `skipped` when there is no team repo. |
| `session` | The instance's current session id (below). |
| `pane-pid` | The pid of the instance's `claude` (below). |
| `turn` | The instance's turn marker, `<state_dir>/turn`, which [`hooks/turn-state`](../../hooks/turn-state) writes: `busy <prompt id>` while a turn is on and `idle <prompt id>` once it has ended. Read as the hook writes it: a regular file that is not a link, its first line, a prompt id of letters, digits and `-` at most 64 long (the hook writes `-` when Claude Code gave none). Else `missing`, `not-a-file` or `invalid`. |
| `turn-mtime`, `now` | When the marker was last written, and the VM's own clock, both in seconds (`none` when not known), so the marker's age is the VM's own difference and no clock of ours is trusted. |
| `proof-hex` | The first 64 KiB of `<state_dir>/proof.json`, in hex, so nothing in it can break the framing; `proof missing` or `proof not-a-file` otherwise. |

The output must be exactly that, from the marker line to `end`. Anything else (a banner, a cut connection, an extra line) is `unknown`.

### The current session and the current process

A proof counts only when it is of the session the agent is in now, and of the `claude` process it is running now. Both are in the instance's state folder, `<state_dir>`, that is `~/.local/state/ghost-protocol/<name>/`, beside `proof.json`:

- **`<state_dir>/session-id`** is the session id: the file `install/service/start` writes when it launches `claude`, resumes from, and keeps current through [`hooks/session-id`](../../hooks/session-id) after a `/clear` or a `/resume`. The proof names its session in `session_id`.
- **`<state_dir>/pane-pid`** is the pid of the instance's `claude`: the file `install/service/start` rewrites at every start of `claude`, and which the hooks use to tell the instance's own `claude` from any other. The `load-proof` hook records it in the proof as `claude_pid`. A resume keeps the session id, so the session id alone cannot tell a `claude` that was restarted with `--resume` from the one before it, whose proof is still on disk until the new one's hook has run; the pid can.

The script reads both as the hooks do: a regular file that is not a link, all white space removed. The session id must then be a lowercase UUID, and the pid decimal digits, without a leading zero and more than 1 (the hooks refuse 0 and 1). Anything else is no session id, or no pid, and then no proof can prove the agent.

**The whole reading rule**, as `hooks/load-proof` states it for a reader: a proof counts only when its `session_id` is the id in `session-id` and its `claude_pid` is the pid in `pane-pid`. A proof beside no `pane-pid`, or with no `claude_pid`, is not proved. A missing `proof.json` is "not proved", never an error. Then the shas in the proof must be `main`'s, for the class file and, when the config names a team repo, for the agents file. They are checked in that order, and the reason says which failed.

[`test/session-source.test.mjs`](test/session-source.test.mjs) holds the tool to the hooks. The UUID form is compared with the line in `hooks/session-id`. The real `session-id` hook is run in a throwaway home after a resume and a clear, under a stand-in `claude` that lives as long as a session, and the tool must read what it wrote. When `hooks/load-proof` is in the tree, its own `proof.json` must come out `current`; then `applied, not proved` when only the session id moved, when the `claude` was restarted with the same session id, and when `pane-pid` is gone.

### The proof

Read as written by the `load-proof` hook (schema `ghost-protocol/load-proof/v1`): the session id, the `claude_pid`, the class and agents records (`status`, `sha256`), and the plugin's `version` and `commit`. Only fields of a strict form are carried into the table; the first lines and paths in the proof, and anything else free, are not.

## What it would do (`--plan`)

`--plan` prints, for each agent that is not current, what a version that acts would do and what would stop it. It does nothing and writes no state, as `--json` does not. The rules:

| State and role | Would do | What stops it |
|---|---|---|
| `unknown` | nothing | it is never acted on |
| `behind on disk` (class), not a lead | write the class file | `class_apply` off |
| `behind on disk` (agents) | fast-forward the team clone through `sync-mains` | no `plugin_dir` |
| `behind on disk`, a lead | write the class file in the same step as its restart, and restart it with `start --fresh` | no `root` or `plugin_dir`; no valid drain ack; its own turn or a pair's is busy, or has no usable marker (an idle marker with the prompt id `-` is not usable) |
| `applied, not proved`, a lead | restart it with `start --fresh` | the same |
| `applied, not proved` or `applied, restarts at Done`, a builder or a reviewer | nothing: it restarts itself at Done | |
| `applied, not proved`, `other` | nothing: only leads are restarted | |

A lead's pairs are the agents whose `lead` names it. The drain ack is not in this version: the plan only says it would be needed.

## `--json`

**The hourly timer calls `run` without `--json`.** `--json` is for a person at a terminal. It prints the full per-agent table instead of the line, whether or not anyone is behind, with exit status 0; it writes no state file and uses up no line or reminder, so it can be run by hand at any time. `--json` and `--plan` are alternatives. Called by a timer it would print a table every hour and never the line, which is why the two are not the same call.

The table has `generated`, `all_current`, and:
- `line`: the line a run would build now, or `null` when everyone is current;
- `would_print`: whether a run at this moment would print it (the set changed since the last real run, or the day is up, or there is no usable state);
- for each agent, its `state`, `behind`, `reason`, `since`, its `role` and `lead`, whether it is `quiet` (`applied, restarts at Done` for less than 3 days), its `plan`, the `expected` and on-`disk` shas, the session id and the pane's pid, the turn marker (`state`, `prompt_id`, `mtime`, `age_seconds`), and from its proof the session it names (and whether that is the current one), the `claude_pid`, the shas, the time, and the Ghost Protocol `version` and `commit`.

`since` is read from the state file.

## The state file

`--state`, JSON, written in one step (a temporary file beside it, then a rename), mode 0600, its folder made if needed: the schema (version 2), `updated`, `last_printed`, `signature` (the set the last line was for), `actions` and `drain` (empty here: the places a version that acts keeps its journal and its drain records, which this version carries along untouched), and for each agent its state, what it is behind in, `since` (the time its state last changed, not its detail), `checked`, the shas seen and what its proof showed. Agents that leave the config leave the file. A state file of the first version is read as one with no actions and no drain, and written as version 2, so the upgrade prints no line of its own. The line is written before the state, so a run cut short prints again rather than not at all.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Done: nothing to say, or the line printed, or the `--json` table. |
| 2 | The run failed (the reason on stderr; nothing on stdout; no state written): the config, the sha commands, or the usage. |

## It never writes to a VM

There is no `scp`, `rsync`, `sftp` or write command anywhere in the tool. The only process it starts for a VM is the ssh command, with the fixed script, once per agent per run. [`test/cli.test.mjs`](test/cli.test.mjs) runs the real CLI against folders that stand in for VMs, with a stand-in ssh that records what it is given, and asserts that it got the one fixed script, once per agent, and that no file, mode or time on the VMs changed; [`test/remote.test.mjs`](test/remote.test.mjs) does the same for the script itself, under `sh` and `bash`, and checks it by reading too.

## Tests

```sh
node --test tools/rollout-check/test/*.test.mjs
node tools/rollout-check/test/rollout-check-mutants.mjs    # about half an hour; not part of the tests
```

The suite uses fakes for the processes (ssh and the sha commands), the clock and the VMs, plus the real CLI as a process; it needs `bash`, `jq` and `git` for the hook tests (the real `session-id`, `turn-state` and `load-proof` hooks are run in a throwaway home) (`ROLLOUT_CHECK_TEST_REQUIRE=1`, which CI sets, turns a skip into a failure). `ROLLOUT_CHECK_PLUGIN=<a plugin folder>` runs the hook tests against the hooks of that folder; run the mutants with `hooks/load-proof` in the tree, or with that variable set to a folder that has it. The mutants file breaks copies of `lib.mjs` one guard at a time and runs the suite against each; every copy must fail it, and a break whose text is no longer in the code fails the check too. CI runs the tests as `rollout-check-test` (`.github/workflows/rollout-check-test.yml`), called from `tests.yml` when this folder or a hook it reads changes.
