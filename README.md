# Ghost Protocol

Ghost Protocol is a personal agent system for Claude Code: an always-on agent that runs on your own machine, under your own keys, and talks to people and other agents through adapters.

A hosted version is coming soon. For now it runs on a computer you own, as one container for Linux, macOS and Windows, under the [Elastic License 2.0](LICENSE).

The terms it uses (GHOST, RECAP) are defined in [`VOCABULARY.md`](VOCABULARY.md).

## Quick start

With Docker running, on Linux or macOS:

```sh
curl -fsSL https://github.com/0xnfrith/ghost-protocol/releases/latest/download/get.sh | sh -s -- --name "My agent" --relay wss://relay.example.com --owner <your public key>
```

On Windows, the PowerShell line is in the quick start. The [quick start](docs/quick-start.md) says what you need, how to do the same from Buzz's "Create a new agent" form, how to give the agent its owner's attestation (or add it as a relay member), how to sign it in to Claude, and how to update, go back and remove it.

## Design

The system is split into a core and adapters:

- **Core** is the agent itself. It must be self-sufficient: it never depends on any one chat system or server to work. (Nothing is in the core yet.)
- **Adapters** connect the agent to the places where people and agents talk. Each adapter lives in its own folder under [`adapters/`](adapters/) with its code, tests and docs. Nothing outside an adapter's folder assumes that adapter exists.

The repository is also a Claude Code plugin and a one-plugin marketplace. The plugin manifest ([`.claude-plugin/plugin.json`](.claude-plugin/plugin.json)) and the MCP server list ([`.mcp.json`](.mcp.json)) at the root point into the adapters.

## Install as a plugin

The plugin is for Claude Code 2.1.314, the one version the image pins and the one that is tested. In a session:

```
/plugin install ghost-protocol --marketplace 0xnfrith/ghost-protocol
```

Or from a shell:

```sh
claude plugin marketplace add 0xnfrith/ghost-protocol
claude plugin install ghost-protocol@ghost-protocol
```

Claude Code then asks for the plugin's settings. Each adapter's README explains its settings and any extra setup.

Ghost Protocol recommends Anthropic's security-guidance plugin, but does not need it: Ghost Protocol, and its Buzz channel, load with or without it. It is not a plugin dependency, since Claude Code does not load a plugin whose dependency is missing. The installer installs it when it is missing, and a failure there is a warning, not a stop. To install it by hand (the first command only on a machine where no interactive Claude Code session has run yet, since that session adds the official marketplace):

```sh
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install security-guidance@claude-plugins-official
```

## Installer

[`install/`](install/) holds the installer that sets up a machine to run an instance: a repo with a `.ghost-protocol/instance.toml` manifest ([schema](install/schema/instance-v1.md)). It has a menu, a dry run, pinned and sha256-checked downloads of gh and Claude Code, git 2.46 or newer (which clones of a Buzz relay's repos need; on Ubuntu, `boot.sh` takes it from the Git stable PPA, whose signing key is pinned; on macOS an older git is a warning), GitHub and Claude sign-in checks, GHOST Protocol's own plugin from the pinned checkout (below), Anthropic's security-guidance plugin (installed when missing; a failure is a warning), and the memory guard below; the later steps are still to come. A [key service](#key-service), which keeps an instance's relay key with a separate OS user, is set up by the machine's admin with its own script. See `install/install --help`, and run its tests with `install/test/run.sh`.

### The pinned checkout and the plugin

`install/boot.sh` clones GHOST Protocol at one exact commit, by default into `~/ghost-protocol`. The commit is `GP_COMMIT` in `boot.sh`, written by a release, or the one given with `--commit <40-character id>`. The clone stays detached at that commit: nothing on the machine moves it to a newer one, and no hook or sync follows `main`. A bad merge to `main` therefore reaches no instance until the operator moves one.

The installer's step 11 adds that checkout as a directory marketplace and installs `ghost-protocol@ghost-protocol` from it, at user scope. Claude Code reads a directory marketplace's plugin straight from that folder, so the instance runs exactly the checkout's commit.

- When the plugin is already installed from the checkout, the step refreshes Claude Code's record of it (`claude plugin marketplace update`, then `claude plugin update`). Both are no-ops when nothing changed.
- A marketplace named `ghost-protocol` that comes from anywhere else (GitHub, or another folder) is never repointed. `claude plugin marketplace add` would repoint it without asking, and every instance on the machine with it, so the installer stops with a FAIL and prints the command to run by hand.
- Any failure in GHOST Protocol's own plugin stops the run.

### Updating an instance

An update moves one machine's checkout to a newer pinned commit, refreshes the plugin, brings the memory and auto-mode guards in line with the new commit, and restarts the instance's service. The operator runs it, on one instance first. Once that one answers as it should, the operator runs it on the next.

What the operator types, on the instance's machine (`<id>` is the full commit id of the new commit; `<owner/repo>` and `<root>/<name>` are the instance's repo and home, as in the manifest):

```sh
# 1. The dry run: changes nothing, prints the plan.
bash ~/ghost-protocol/install/boot.sh --instance <owner/repo> --commit <id> --update --instance-dir <root>/<name> --dry-run

# 2. The update.
bash ~/ghost-protocol/install/boot.sh --instance <owner/repo> --commit <id> --update --instance-dir <root>/<name> --yes

# 3. If the new commit misbehaves: back to the commit before the update.
bash ~/ghost-protocol/install/boot.sh --instance <owner/repo> --rollback --instance-dir <root>/<name> --yes
```

What runs, in order:

1. `boot.sh` checks `--commit` (a full 40-character id) and that the checkout is a clean clone of GHOST Protocol.
2. It prints the commit it moves from, a link to what changes between the two commits, and the exact command that goes back.
3. It fetches the new commit, switches the checkout to it, and stops unless `git rev-parse HEAD` is exactly that commit.
4. It records the old commit in `<checkout>/.git/gp-previous-commit`. That record is what `--rollback` reads.
5. It runs the new commit's installer with `--update`. The update steps are:
   - step 1, the preflight;
   - step 3, the instance's home already on the machine (`--instance-dir`, or `~/<repo>`); an update never clones;
   - step 4, the manifest, for the instance's name;
   - step 7, the pinned Claude Code, without the sign-in check. The instance is already set up, and its sign-in may be a token in its service that the operator's shell cannot see.
   - step 11, the plugin refresh. When the Buzz adapter's lockfile changed between the two commits, the adapter's dependencies are installed again from the new lockfile, with the command the channel itself runs (`npm ci` without install scripts, under the channel's own install lock), so step 14 finds them. Without npm, or when that install fails, the adapter's `node_modules` folder is removed instead, so the channel installs the new dependencies when the instance starts. A changed `buzz-mcp.pin` is a warning with the build command, since buzz-mcp is built by hand for now.
   - step 14, the services, as in a full run, then the restart:
     - the memory guard, checked and set up again if it differs;
     - the auto-mode guard, when the manifest has `[automode_guard]`: its root-owned copy moves to the new commit, with the adapter's dependencies from step 11. If those could not be installed, the guard is a SKIP and keeps its old copy until a run without `--update`. A failure in either guard is a warning, as in a full run;
     - the restart: `systemctl try-restart <name>.service`, as root, when the checkout moved and the unit is installed and running. A stopped unit stays stopped. With no systemd or no unit, a SKIP line says to restart the instance by hand.

   The update steps ask no menu questions and make no GitHub call. A run without `--update` checks everything.
6. Any FAIL stops the run before the restart, and the summary prints the command that goes back. Run it at once: the checkout is already at the new commit, and Claude Code reads the plugin from that folder, so the instance's next start of any kind (a crash, a reboot) would load the new commit. When only the restart failed, the update is in place: restart the instance by hand (the summary prints the command), or go back.

Needed for an update:

- **git access to this repository from the machine.** `boot.sh` fetches the commit over HTTPS. The machine needs to reach github.com over HTTPS.
- **root for the restart.** With `--yes`, or without a terminal, sudo is used only when it needs no password. Otherwise the restart is a FAIL with the command to run by hand.
- **the instance's unit** at `<name>.service`, as `install/service/start --print-unit` prints it, for the restart.

All instances on one machine share its checkout, so an update moves them all. The restart covers the instance named by `--instance`.

On an instance with a [key service](#key-service), the key side's code is a root-owned copy of its own commit: the update's summary says so, and the admin moves it with `install/keyservice/setup --update` (see [Updating](#key-service) there).

## Memory guard

An instance runs Claude Code with many subagents, and their test suites and builds, often on a small Linux machine with no swap. When memory runs out there, the kernel's own out-of-memory killer may never act: the machine just stops answering until someone restarts it from outside.

On Debian and Ubuntu the installer (step 14) sets up [earlyoom](https://github.com/rfjakob/earlyoom) to prevent that. It installs the `earlyoom` package with a drop-in at `/etc/systemd/system/earlyoom.service.d/ghost-protocol.conf` ([the template](install/memory-guard/earlyoom.conf), whose comments explain each setting), then enables and restarts the service, and checks that earlyoom runs with exactly those settings. earlyoom then stops one process early:

- It asks one process to stop when available memory falls to 15 % of RAM, and kills it outright at 8 %.
- It picks a few build, compile and OCR tools first: esbuild, cargo, rustc, go, pytest, tesseract and ImageMagick.
- It picks Claude Code, the instance's watchdog (`install/service/start`, whose process name is `start`), tmux, systemd, sshd, dbus, cron and zsh last.
- Everything else is ranked by size alone. That includes node, bun, npm and python, which are what MCP servers and channels run as, and node test runners such as vitest or jest, whose process name is node.
- Claude Code is still killed if it alone holds most of the memory. A supervisor such as the instance's systemd unit ([`install/service/`](install/service/)) would start it again, but the installer does not set that unit up yet.

When it runs:

- On Linux, it runs by default on the `vm` profile.
- On the `laptop` profile, it runs only when the manifest says `enabled = "true"`; desktop Ubuntu already runs systemd-oomd.
- On macOS, it is skipped.
- The two thresholds can be set in the instance's manifest; see [the schema](install/schema/instance-v1.md).

It needs root:

- A run with `--yes`, or without a terminal, uses sudo only if sudo needs no password.
- An interactive run says so first, then asks for the password once.

If anything fails (no apt or systemd, no root, the package missing, earlyoom not running with these settings), the installer prints a warning with the commands to run by hand, and the install goes on. Watch it with `journalctl -u earlyoom`: one memory line every 10 minutes, and one line for each process it stops.

To undo it on a machine:

```sh
sudo rm /etc/systemd/system/earlyoom.service.d/ghost-protocol.conf
sudo systemctl daemon-reload
sudo systemctl restart earlyoom   # earlyoom with the package's own defaults
sudo apt-get remove earlyoom      # or remove earlyoom altogether
```

The installer sets it up again on its next run unless the manifest turns it off:

```toml
[memory_guard]
enabled = "false"
```

## Auto-mode guard

Claude Code's auto mode decides what the agent may do without asking from three lists of rules in the user's settings file (`~/.claude/settings.json`): `autoMode.allow`, `autoMode.soft_deny` and `autoMode.hard_deny`. An instance keeps a copy of them, the snapshot, in its own repo, and may keep a signing ledger: one line per rule the operator added or removed. The rules can change without the operator noticing:

- a settings save from a stale copy (say, a long-running session's) can drop rules;
- another agent, or a person, can add a rule the operator never made.

The auto-mode guard checks every 15 minutes and asks the operator, the instance's owner, about it on Buzz, in plain words. It runs as a systemd timer outside Claude Code, so nothing in Claude Code's settings can switch it off, and so the agent's own session never edits its settings file: the guard's unit does that, on the owner's answer.

- **Signed changes:** when every changed rule is signed in the ledger and in force (its latest ledger line is an add with no expiry or one still to come, or a remove), it posts nothing at all. A ledger line is a plain line of text, not a key signature: see [what it is, and what it is not](#auto-mode-guard) below.
- **Rules not on record** (in the live settings, not in the snapshot, not signed): one message, which tags the owner and stays open until answered: "I found 2 rules you didn't make. Another agent may have added them; I'm not sure. What would you like to do?" with **Show me them**, **Keep them** and **Remove them**.
- **Rules on record that are gone** (in the snapshot, or added in the ledger and in force, but missing from the live settings, unless the ledger's latest line for them is a remove): "2 rules on record are gone. I'm not sure what removed them." Then each rule, quoted (cut to fit), with where it is on record: the saved copy on `main` (the snapshot, with its path), or a line of the ledger (its number). Then "What would you like to do?" with **Show me them**, **Put them back** and **Leave them out**. It never says the owner made them: the snapshot and the ledger are files the instance's user can write, so they show where a rule is on record, not who made it.
- **Rules that expired but are still live** (in the live settings, not in the snapshot, and the latest ledger line for them an add whose expiry has passed, or can't be read): "I found 1 rule that expired but is still live." Then each rule, quoted, with its ledger line and time limit, "If you keep it, it won't have a time limit any more.", and **Show me**, **Keep it** and **Remove it**. An expiry that can't be read counts as passed, never as no expiry. **Keep** signs the rule again with no time limit, and the note says so.
- **`"$defaults"`** (Claude Code's own default rules) is never asked about as added. Its removal from a list that had it, in the snapshot or in the live settings as the guard saw them before (the state keeps those list names, never a rule), is always asked about as gone, whatever the ledger says: no ledger line counts for it either way. **Put them back** puts it first in its list. **Leave them out** writes no ledger line; it forgets that the list had it, but while the snapshot on `main` holds it, it is asked about again. The guard can only remember what it saw: a list that lost `"$defaults"` before the guard's first run (or before the update that brought this), and that the snapshot never held, is not asked about.
- **The answer is the owner's reply in that message's thread,** one of the options in a word or two ("keep", "Remove them", "put it back"), with nothing else to run. Each run reads the thread through the adapter's one-shot thread read, which checks every signature, and the guard acts only on a reply whose signed author is the owner's key (`owner` in the manifest), never on what a message says. The owner's key must be another key than the one the guard reads and posts with; the thread read refuses its own key as the author. The first answer counts. Show me them posts the rules in the thread. Keep and Leave out record the owner's answer in the ledger. Remove and Put back change the live settings, with a backup of the three lists, and record it in the ledger. Each acts only on that message's rules that are still in its kind now, so an answer applied twice changes nothing more, and the guard says what it did in the thread. No answer leaves everything as it is.
- **More of the same kind:** when more rules of one kind turn up while its message is open, a new message asks about all of them, and the old thread is no longer read. When an open message's rules are all fixed some other way, it closes quietly.
- **The snapshot as committed on `main`:** the guard reads it with git from the instance repo, never from the working tree an agent edits. It must be a plain file there: a committed symlink, or a path through a committed folder symlink, counts as a broken check.
- **A broken check:** for example the settings file or the ledger is unreadable, a rule is not valid Unicode text, or anything else the guard did not plan for goes wrong. It is reported once ("I can't check your rules right now…"), and once more when the check runs again, so the guard never goes quiet on an error.

The pieces:

| Piece | What it does |
|---|---|
| [`install/automode-guard/guard`](install/automode-guard/guard) | One run: the check, the messages, reading and applying the owner's answers, and its state. |
| [`install/automode-guard/`](install/automode-guard/) units | `<name>-automode-guard.service` (sandboxed) and its `.timer`, made from the manifest. |
| [`adapters/buzz/src/send.mjs`](adapters/buzz/src/send.mjs) | The Buzz adapter's one-shot send (`node launch.mjs send`), which posts each message, in a thread with `--reply`. |
| [`adapters/buzz/src/thread.mjs`](adapters/buzz/src/thread.mjs) | The adapter's one-shot thread read (`node launch.mjs thread`), which reads the replies and checks each signature. |
| [`tools/automode/watch`](tools/automode/watch) | The same comparison for people and the session hook: read-only. See [`tools/automode/README.md`](tools/automode/README.md). |
| [`hooks/automode-drift`](hooks/automode-drift) | The same check when the instance's main thread starts, printed into the session as data, for the registered instance only (the one with the guard installed). It never asks the agent to change a rule. |

To turn it on, add an `[automode_guard]` section to the instance's manifest ([schema](install/schema/instance-v1.md)):

```toml
[automode_guard]
snapshot = "config/claude/automode.json"
buzz_relay_url = "https://relay.example.com"
buzz_key_command = "op read op://vault/item/field"
buzz_channel = "<the channel id the message goes to>"
buzz_mentions = ["<64 hex characters: who the message notifies>"]
read_paths = ["~/.local/bin/op"]
owner = "<64 hex characters: the owner's public key, the one key whose answers count>"
ledger = "~/.local/share/automode/LEDGER.md"   # optional; left out, the guard keeps its own
# Optional: each alert is a task root, with the open state on it.
buzz_task_open_emoji = "open-loop"
buzz_task_open_emoji_url = "https://media.example.com/open-loop.gif"
```

The installer's step 14 then installs it on Linux, and an update (`boot.sh --update`) puts it at the new commit the same way. [`install/automode-guard/setup`](install/automode-guard/setup) does the same on its own. It is a dry run by default, `--apply` installs, and `--uninstall` removes it:

- **Never root:** the unit runs as the owner of the instance home. The step refuses to run as root (run the installer as the instance's user; it asks sudo for each root step itself), a home owned by root, and a home or `$HOME` owned by someone other than who runs it. A dry run prints both units in full, `User=` included.
- **Root-owned:** the guard and the Buzz adapter are copied to `/usr/local/lib/ghost-protocol/<name>/automode-guard/`, so the instance's user can't change what the timer runs. The guard runs `/bin/bash`, `/usr/bin/python3` and `/usr/bin/git` by their paths, with `PATH=/usr/bin:/bin`; only the adapter's process gets the wider `GP_GUARD_SEND_PATH` (with `~/.local/bin`), for the key command.
- **The units** go in `/etc/systemd/system`; the timer is enabled and runs once at once.
- **Credentials for the key command** (an API token, say) go in the instance's own drop-in, `/etc/systemd/system/<name>-automode-guard.service.d/instance.conf`, as `LoadCredentialEncrypted=` lines. The guard hands each one to the adapter alone (the send and the thread read), never to the check. A credential's name may not steer the adapter (`PATH`, `NODE_*`, `BUZZ_*` and the like are refused), with one exception: an instance on the relay through its owner's attestation gives the guard the same `buzz-auth-tag` credential its listener gets (`LoadCredential=buzz-auth-tag:<file>`), and the adapter puts it in its relay login as `BUZZ_AUTH_TAG`.
- **The sandbox:** it runs as the instance's user, with no capabilities. Home folders are hidden except the instance repo's `.git` folder, node and the manifest's `read_paths`, each read-only, and two files it may write, each bound on its own (not its folder): the settings file, and the ledger when the manifest names one. Everything else is read-only except its state folder, which holds its state, its own ledger when the manifest names none, and the backups. Its network is IPv4, IPv6 and local sockets only.
- **Writing the settings file:** only for the owner's Remove or Put back. Since the unit binds that one file, a rename can't replace it, so the guard writes it in place, and only after the file reads back unchanged since it was read and is still the file in place; then it reads it back. A shorter text is padded with spaces to the old size before the file is cut, so the file is valid JSON at every step of a write that runs to the end, and a write that fails is undone from the copy in memory. Before each write, the three lists before and after go to `backups/` in the state folder (`0600`, the newest 20 kept), never the rest of the file, whose `env` block may hold live keys. The guard never logs or posts anything from the file but the rules.
- **The ledger** must be there when the manifest names one (the installer makes it); a missing one is a broken check. Without `ledger`, the guard keeps its own, so rules signed only by a sign script's ledger elsewhere are asked about as rules the owner didn't make. It is one line per signed change, as an instance's sign script writes it: `- <add|remove> | autoMode.<list> | expires <never|YYYY-MM-DD HH:MM +HH> | <source> | entry sha256 <first 16 hex of the rule's sha256> | <rule>`. The latest line for a rule (its list and exact text) decides; a line whose entry sha256 does not match is ignored. The guard appends one line per rule it acts on, with `reply <event id>` as the source; a rule put back keeps the expiry of the line that signed it. A rule with an invisible or control character never gets a ledger line from a reply, so Keep and Leave out leave it as it is, and it is asked about again.
- **Size:** a message stays under 30,000 bytes of UTF-8. Show me them splits the rules over as many messages as that needs, and cuts a rule too long for one.
- **A task root:** with `buzz_task_open_emoji` (a plain emoji, or a custom emoji's name with its image in `buzz_task_open_emoji_url`), each alert (each question, and the message that the check can't run) gets the open state right after it is sent and recorded, through the adapter's [one-shot task](adapters/buzz/README.md#one-shot-task), so it shows among the agent's open [task roots](adapters/buzz/README.md#dm-task-roots). The all-clear and the guard's replies in a thread get none, and an answered or closed question keeps its open state. It is best effort: a failure is logged, and the alert still counts as sent. Use the same emoji as the channel's `task_open_emoji`, or the alert never reads as open.
- **Node:** it needs node 22 or later, and runs it by its path. Rerun the step after node moves, for example after a version manager's upgrade.

**Undo:** `install/automode-guard/setup --home <home> --uninstall --apply`, or `enabled = "false"` in the section, which prints the commands.

**What it is, and what it is not:** a drift detector, not a security boundary against a malicious agent. It catches what changes the rules by accident or in passing: a tool that rewrites the settings file, a sync, a hand edit, a save from a stale copy. A process running as the instance's user can change the settings file, the snapshot (the local branch `main` too), the ledger and the guard's state, and on a host where that user has passwordless sudo, the guard itself. So the snapshot and the ledger decide what stays quiet, and the only thing that acts is a reply the owner's key signed. When the agent's user no longer has passwordless sudo, this is to be looked at again, with silence resting on owner-signed records alone.

**Limits:** If Claude Code replaces the settings file after the unit started, the guard's write is refused; one that lands in the instant between its last check and its write is lost, and the next run asks again. An answer is acted on at the next run, up to 15 minutes later. A send that never works (the relay or the key command down for good) is logged and tried again every run, but it can't report itself. The owner's reply also reaches the agent's session when the channel delivers it; the agent must leave it to the guard.

**Order:** a manifest with `[automode_guard]` needs a plugin and an installer that know the section. An older one refuses the unknown section, which switches off every hook for that instance and stops the installer. So update the plugin first, then add the section. The same goes for the `owner` and `ledger` keys.

## Memory backup

Claude Code keeps an agent's auto-memory in a folder of notes (`MEMORY.md` and the notes beside it, under `~/.claude/projects/<project>/memory/`). The agent rewrites it as it goes, and a background run of Claude Code's own may rewrite or prune it at any time. Nothing keeps the old versions.

The memory backup keeps every version of that folder in git, in the instance's own repo, and proves that the copy restores:

- **Where:** the branch `memory/<name>` of the instance repo, never `main`. The branch shares no history with `main`, holds the folder under `memory/` in its tree (never at the top, so no file in the folder can act as the repo's own, a workflow in `.github/` say), and opens no pull request. A push there starts no workflow: the pushed commit's tree holds none.
- **When:** every 15 minutes by a timer, and right after the agent writes a file in the folder, through the plugin's hook and a path unit. A write that never passes through a tool call (Claude Code's own background memory work) is the timer's.
- **Only what changed:** a run commits only when the folder differs from the branch's last commit, and a write that lands during a run is backed up by the same run. The folder is kept as it is: every regular text file in every subfolder, its bytes untouched (no `.gitignore`, `.gitattributes`, filter or line-ending conversion applies).
- **Left out, and reported:** a symlink (a memory folder needs none, and a restore never writes one), a socket or a pipe, a name git can't keep (a `.git` folder), a file over the size cap (`max_file_kb`, 1 MB by default) and a file that is not text (binary or compressed, UTF-32, or any file whose decoded text still holds a NUL: the scan could not read it). One alert names them; the rest of the folder is backed up, and the verify fails until they are gone.
- **Removals are checked:** a missing folder is reported. A run that would leave the backup empty (a first run of an empty folder too) is never committed, When a run would remove more than `max_removed_percent` of the notes (30% by default), only the removals are held back and reported: the removed notes stay on the branch as they were, and everything else still goes in. A note held back stays held while it is gone, whatever its share later (new notes don't let it through); removals beyond the held ones are judged by the share rule and join them when held. `backup run --accept-removals` takes on the notes held back, and no other.
- **A secret scan before every commit:** the new and changed files (a UTF-16 one decoded first), every file and folder name, and the commit message are scanned for private key blocks and token shapes (GitHub, GitLab, Anthropic, OpenAI, AWS, Slack, Stripe, Google, 1Password service accounts, Linear, Neon, PostHog, npm, Hugging Face, DigitalOcean, Cloudflare, Hetzner, nostr secret keys, JWTs, passwords in URLs), wherever they start in a line. On a hit nothing is committed and nothing is pushed; the alert names the file, the line and the rule, never the text. Every name an alert, the log or a listing shows is scanned first; one that holds a secret shape is shown as "(a name that holds a possible secret)". Bare hex strings are not flagged: notes are full of event ids and public keys.
- **History is never rewritten:** the commit is pushed by its id, with no `--force` and no `+`, so the remote takes nothing but a fast-forward; the local branch moves only once the push went through. A push refused as not a fast-forward is reported and left as it is. Every commit made here is recorded, and a remote branch holding a commit this machine did not make (another writer, or the machine this one replaces) is held until `backup run --adopt-remote`. A push the remote refuses for what it holds (a size rule, say) puts the local branch back to the remote's tip, and the folder is committed afresh. Commits that waited here and leave the branch that way (or with `--adopt-remote`) are kept on the machine, under `refs/dropped/<UTC time>` in the state folder's repo, never pushed, and one alert gives their count and the ref. When the remote is out of reach, commits wait in the state folder and go out on the next run that reaches it; four runs in a row without it are reported.
- **The proof, every hour:** the verify backs up, fetches the branch from the remote into a fresh repo, checks that its tip is the last commit made here, restores it into a temporary folder and compares that with the live folder, byte for byte. A mismatch that is still there after one retry is reported.
- **Restore:** `backup restore [--at <commit> | --at tip~<n>] [--into <folder>]` fetches the branch from the remote, writes that commit's folder into a new folder (default: a new temporary one) and lists how it differs from the live folder, by name. It never writes the live folder, nor a folder inside or above it: copy a note back by hand. A commit someone else put on the branch can't write outside the new folder: git checks every object a fetch brings in (`fsckObjects`), and the backup checks every entry before it writes anything (regular files only, never a symlink, no `..` or other bad name, no path twice), then makes each folder one part at a time, never through a link.
- **Alerts:** one message per change, by the auto-mode guard's rule (a run held back, a verify that fails, and one more when it works again), on Buzz through the adapter's one-shot send when the section names a channel; otherwise in the journal only. With `buzz_task_open_emoji` (and its `_url`), each alert is a task root, as for the auto-mode guard.

The pieces:

| Piece | What it does |
|---|---|
| [`install/memory-backup/backup`](install/memory-backup/backup) | `run`, `verify` and `restore`. It reads its settings only from the root-owned file beside it. |
| [`install/memory-backup/`](install/memory-backup/) units | `<name>-memory-backup.service` (sandboxed) with its `.timer` and `.path`, and `<name>-memory-verify.service` with its `.timer`, made from the manifest. |
| [`hooks/memory-backup`](hooks/memory-backup) | After a Write or Edit inside a folder an installed backup watches, writes the time into its trigger file, which the path unit watches. |

To turn it on, add a `[memory_backup]` section to the instance's manifest ([schema](install/schema/instance-v1.md)):

```toml
[memory_backup]
folder = "~/.claude/projects/<project>/memory"
remote = "https://github.com/<owner>/<instance repo>.git"
branch = "memory/<name>"
# Optional: alerts on Buzz, as for the auto-mode guard.
buzz_relay_url = "https://relay.example.com"
buzz_key_command = "op read op://vault/item/field"
buzz_channel = "<the channel id the alerts go to>"
buzz_mentions = ["<64 hex characters: who the alerts notify>"]
read_paths = ["~/.local/bin/op"]
```

The installer's step 14 then installs it on Linux. [`install/memory-backup/setup`](install/memory-backup/setup) does the same on its own: a dry run by default, which prints the settings and every unit in full and what the first backup would commit (read-only); `--apply` installs it and runs one backup and one verify, and exits non-zero (a FAIL line says why) when it installs nothing or that first backup or verify fails; an `--apply` that finds it installed already runs a verify before it says OK; `--uninstall` removes it. In the installer the same failures are warnings, and the run goes on.

Optional keys: `max_file_kb = "1024"` (the size cap) and `max_removed_percent = "30"` (the removal limit).

A rebuilt machine, or a new one that takes over an instance, finds the branch made by another machine: its first run is held and says so. `sudo -u <user> /usr/local/lib/ghost-protocol/<name>/memory-backup/backup run --adopt-remote` takes that history on; the timer carries on from there. The same command clears a branch that moved apart from this machine's: the commits made here are kept under `refs/dropped/`, and the folder is committed on the remote's tip. A branch here that is only ahead (commits that waited out an outage) is kept, and its commits go out.

- **Never root:** the units run as the owner of the instance home; the step refuses to run as root.
- **Root-owned:** the backup and its settings file (and the Buzz adapter, for alerts) are copied to `/usr/local/lib/ghost-protocol/<name>/memory-backup/`, so the instance's user can't change what runs or where the memory goes. The hook trusts only that settings file, never the session's manifest.
- **The sandbox:** no capabilities; everything read-only except the state folder, `/var/lib/ghost-protocol/<name>-memory-backup/` (the backup's own bare repo and its alert state); home folders hidden except the memory folder (read-only), and node and `read_paths` when alerts go to Buzz.
- **The push goes as the machine is:** git runs with no user or system config, no hooks and no credential helper, so the remote must take a push from this machine without a password (a GitHub integration host, for example). The commits are not signed.
- **Credentials for the alerts' key command** go in the instance's own drop-ins, `/etc/systemd/system/<name>-memory-backup.service.d/` and `<name>-memory-verify.service.d/`, as for the auto-mode guard.

**Undo:** `install/memory-backup/setup --home <home> --uninstall --apply`. The state folder stays (its repo may hold commits that never reached the remote); the branch on the remote is never touched.

**Limits:** like the auto-mode guard, it guards against accidents, not against a process running as the instance's user, which can change the folder and the state folder. What it protects is the remote's history, which no run rewrites. A rule on the remote that refuses non-fast-forward pushes and deletions on `memory/*` makes that hold for every writer.

**Order:** a manifest with `[memory_backup]` needs a plugin and an installer that know the section. An older one refuses the unknown section, which switches off every hook for that instance. So update the plugin first, then add the section.

## Key service

Without a key service, an instance's relay private key reaches the instance's own processes: the Buzz adapter runs the key command as the session's user and hands the key to the channel and to buzz-mcp, which run as that user too. So the model's tools could run the same command, or read a server's environment.

A key service keeps the key with a separate OS user, so the model's processes can never read it: not the key, not its file, and not the key processes' environment or memory. A mention still gets a reply through the channel and the Buzz tools. The machine then has three users:

| User | Runs | Root |
|---|---|---|
| the admin (for example the machine's first user) | installs and updates, with sudo; never Claude Code | yes |
| the agent user | the instance: Claude Code, its hooks, tools and subagents, and the adapter's two keyless pipes | no: no sudo, and none of the groups that amount to root. Rootless Docker is fine |
| the key's user, `gp-key-<name>` | the channel and buzz-mcp, one process per connection, as systemd units | no; a system user with no home and no shell |
| the GitHub App key's user, `gp-gh-<name>` | only with the [GitHub App slot](#the-github-app-slot): its review action, one process per connection | no; a system user with no home and no shell, alone in its own group |

The adapter's side of this (the pipe and `launch.mjs serve`) is in [`adapters/buzz/README.md`](adapters/buzz/README.md#key-service). The admin sets up the rest with [`install/keyservice/setup`](install/keyservice/setup), from the admin's own clone of GHOST Protocol. It is a dry run by default, which checks everything and prints every file in full; `--apply` makes the changes:

```sh
# 1. The dry run.
install/keyservice/setup --name <name> --agent-user <user> --settings <file> --key-from-stdin

# 2. The install, with a key that already exists (it goes from stdin straight to the root-owned code that writes it):
op read <ref> | install/keyservice/setup --name <name> --agent-user <user> --settings <file> --key-from-stdin --apply
#    or with a key made on this machine, whose public key it prints:
install/keyservice/setup --name <name> --agent-user <user> --settings <file> --key-generate --apply
```

The setup runs code from that clone (itself, and the shell libraries in `install/lib/`) before any of its checks, and with root through sudo: what it checks cannot vouch for the code doing the checking. So run it only from a clone the agent user cannot write, in a home folder the agent user cannot write either, never from the agent user's own copy. It then checks the clone too, and refuses one the agent user could change (below).

`--settings` names a file of `KEY=value` lines: `BUZZ_RELAY_URL` and `BUZZ_CHANNELS`, and any of `BUZZ_CHANNEL`, `BUZZ_WATCH_PUBKEY`, `BUZZ_DM_MESSAGES`, `BUZZ_TRUSTED_PUBKEYS`, `BUZZ_ALLOWED_PUBKEYS`, `BUZZ_ALLOWLIST_FILE` and `BUZZ_CATCHUP_MAX_AGE`, each checked for its form. A key, a key command or a tag there is refused. A sender allowlist is required (`BUZZ_ALLOWED_PUBKEYS` or `BUZZ_ALLOWLIST_FILE`; `BUZZ_TRUSTED_PUBKEYS` alone turns none on): without one, anyone who mentions the agent in its rooms reaches the session. `--no-sender-allowlist` runs without one on purpose, with a warning. `--tag <file>` installs the owner's NIP-OA tag. `install/keyservice/setup --help` lists every option.

**What it installs:**

| Path | Owner, mode | What |
|---|---|---|
| `/opt/ghost-protocol/<commit>/` | root, nothing writable by group or others | The code the key units run: the Buzz adapter at that commit, taken from git (fetched from the admin's checkout into a fresh repository that checks every object against its hash; never a working tree), its dependencies from the lockfile, the buzz-mcp build of its pin, the copy step, and a copy of node unless the node given is root-owned already. |
| `/etc/ghost-protocol/<name>/buzz-key` | root, 0400 | The key. Only root reads it; systemd opens it and hands the open file to the key units (`OpenFile=`). |
| `/etc/ghost-protocol/<name>/buzz.env` | root, 0644 | The Buzz settings, read by the key units. |
| `/etc/ghost-protocol/<name>/auth-tag.json` | root, 0644 | The owner's tag, when there is one (`LoadCredential=`). |
| `/etc/ghost-protocol/<name>/commit`, `previous-commit` | root, 0644 | The commit the units run, and the one before the last update. |
| `/etc/ghost-protocol/<name>/github-app.pem` | root, 0400 | With the [GitHub App slot](#the-github-app-slot): the App's private key. Only root reads it; systemd opens it and hands the open file to the GitHub unit (`OpenFile=`). |
| `/etc/ghost-protocol/<name>/github.conf` | root, 0644 | With the slot: the App's client ID and the allowlist, the repos it may review with the installation that holds each; the reviewer's own bot identities and whether COMMENT is allowed; where the public-text rules are. |
| `/etc/ghost-protocol/<name>/public-text.json` | root, 0644 | With the slot: the public-text rules a review's body must pass in a repo that is not private. The setup installs it after the root-owned copy's code has checked it. |
| `/srv/ghost-protocol/<name>/` | root, 0711 | The folders the session and the key's user share, below. |
| `.../outbox/` | the agent user, the key's group, 2770 | Where the session puts a file to send. |
| `.../files/` | the key's user, the agent's group, 2750 | buzz-mcp's `BUZZ_MCP_ROOT`: the only folder its `path` and `files` arguments read. Only the key's user writes it, but the outbox's copy step puts the session's files there, so nothing in it is trusted: never an allowlist. |
| `.../media/` | the key's user, the agent's group, 2750 | Where `media_get` saves, readable by the agent user. |
| `/etc/systemd/system/gp-key-<name>-*` | root, 0644 | Six units, made from [`install/service/key-*`](install/service/): the channel's and buzz-mcp's sockets and services, and the outbox's path unit and service. With the GitHub App slot, two more: the GitHub socket and its service. |
| `/var/lib/ghost-protocol-key/<name>/` | the key's user, 0700 | The channel's cursor, log and lock (systemd's `StateDirectory=`). |
| `/run/ghost-protocol-key/<name>/` | made by systemd | The two sockets (three with the GitHub App slot: `github.sock`). Only root and the agent user's own group can connect. |
| `/run/ghost-protocol-setup/setup.lock` | root, 0600, in a root 0700 folder | Held by root for a running `--apply`, so that one runs at a time. |

**What it refuses, before changing anything:**

- a machine without systemd 253 or later (`OpenFile=` needs it), or without `flock` (util-linux: the lock that keeps two runs apart), or with `fs.protected_symlinks` or `fs.protected_hardlinks` off;
- an agent user that is root, is the admin running the setup, or can become root: a member of `root`, `sudo`, `wheel`, `admin`, `docker`, `lxd`, `lxc`, `incus-admin`, `incus`, `microk8s`, `disk`, `libvirt` or `staff` (Debian's, which writes `/usr/local`, on root's `PATH`), able to run sudo with no password, able to run any sudo at all (unless `--agent-sudo password`, below), able to run doas (a `permit` rule for it, or a group it is in, in `/etc/doas.conf`), or able to write a container engine's socket (Docker's, containerd's, Podman's, LXD's or Incus's). Its groups are what `id -Gn <user>` says, so a directory service's groups count too. `sudo -l -U <user>` must say either that it may run commands or that it may not: any other answer is refused (a machine with no sudo at all is fine). `adm` and `systemd-journal` are fine: they read logs, and the agent user reads the key units' journal through them. polkit rules are not read: an agent user that polkit lets manage units or run `pkexec` is root-equivalent all the same, so give it no such rule. `--accept-root-equivalent-agent` goes on with a warning instead: the key is then out of every casual path, but anything run as root still reaches it;
- `--agent-sudo password` (sudo that needs a password only a person knows, for a personal agent on its own machine) unless sudo caches no ticket for the agent user: `sudo -l -U <user>` must show `timestamp_timeout=0` (`Defaults:<user> timestamp_timeout=0`), and no other `timestamp_timeout` but 0 anywhere in its listing (a `Defaults>root` or `Defaults!<command>` one included). This shape is root-equivalent all the same, and the setup always says so: that password must never be typed in any session of the agent user (a terminal, tmux window or ssh session it owns), because a ticket cached there, a sudo shadowed on its `PATH`, or a debugger attached to its own shell leads to root. The safer shape gives the agent user no sudo at all, and keeps sudo with the admin's own user;
- an agent user whose own group holds another user (it is the sockets' group), or a key's user that exists but is not a system user with no shell, or shares a group with the agent user;
- an instance unit (`<name>.service`, with its drop-ins, read with `systemctl cat` as root, the way systemd reads it: a comment line skipped, the first byte-order mark dropped, a line ending in an odd number of backslashes continued, spaces and tabs around a line and around `=` dropped; a line with a control character, or a second byte-order mark, is refused, since how systemd reads it cannot be told) that:
  - runs as anyone but the agent user (`User=` missing means root);
  - loads a credential named `buzz*` or `nostr*`, in any case, by `LoadCredential=`, `SetCredential=`, their encrypted forms, or an `ImportCredential=` pattern that could match one. systemd puts an instance's credentials in `/run/credentials/<name>.service/`, which the agent user, the unit's own user, reads;
  - sets or passes a `BUZZ_*` or `NOSTR_*` variable, in any case, by `Environment=`, `PassEnvironment=` or an `EnvironmentFile=` (whose names only are taken out of it, by the root process: no value reaches the setup). With a key service, the relay's settings and key are the key service's;
  - has systemd read, as root, a file that could be the key: a `LoadCredential=` path, an `EnvironmentFile=` or a `StandardInput=file:` in or above `/etc/ghost-protocol` (a folder given to `LoadCredential=` is read in full), one the agent user could point at the key file (a link on the way in a folder it can change, or a folder it can change at the path or above it), or one with a systemd specifier (`%`), which the setup cannot follow.

  Other credentials and settings, such as the session's API tokens from `/etc/credstore`, stay the instance's own. An instance unit that is not installed yet is not checked, and the summary says so with a SKIP line: run the setup again once it is;
- a checkout that borrows objects from another store (git alternates), or a `GIT_ALTERNATE_OBJECT_DIRECTORIES` or `GIT_OBJECT_DIRECTORY` in the environment. git runs with no repository, config or object store named by the environment;
- a checkout the agent user could change: the clone, its git folder and its common one (a worktree has both), or anything in them (`HEAD`, the refs, `packed-refs`, the objects, `config`, `shallow`; `hooks/` aside, since no hook runs) or in `install/` (the setup's code and the unit templates it fills in) that is a link, the agent user's, or writable by a group or by others; or a `core.sharedRepository` setting, which makes git write files a group can change. A umask of `002` makes a clone group-writable: `chmod -R go-w <clone>` fixes it;
- an instance with the [auto-mode guard](#auto-mode-guard) installed: its send runs the key command as the agent user, a way to the key. The guard's send from the key's side comes in a later change, and until then the installer's step 14 skips the guard on an instance with a key service;
- code, a node, a buzz-mcp build, settings or a tag that the agent user could change, or that is reached through a link sitting in a folder the agent user can change. Each such file is checked, then copied at once into the setup's private work folder: opened without following a link, checked on the open file and copied from it. Only that copy is used from then on, so nothing can be swapped between the check and the use;
- an allowlist file (`BUZZ_ALLOWLIST_FILE`) that is missing, reached through a link, inside the key service's shared or state folders (`/srv/ghost-protocol/`, `/var/lib/ghost-protocol-key/`, any instance's), changeable by the agent user, or not root's alone (the file and every folder above it owned by root, writable by no group or others). The allowlist decides who can instruct the agent, so it belongs where only root writes, for example `/etc/ghost-protocol/<name>/allowlist.json`, and the agent user cannot widen it. The channel's unit cannot see the shared folders at all (`InaccessiblePaths=`), so an allowlist named there by a later hand edit is never read;
- for every file it checks: any group write counts, whatever the group, since a POSIX ACL entry that grants writing shows in the group bits. A sticky folder above the file is fine (others cannot rename or delete what they do not own in it); the code's own check in `launch.mjs serve` allows none, because node looks for modules in every folder above its code;
- a missing key, or a key given when one is there: a key file is never replaced. `--key-from-stdin` takes a pipe or a file, never a terminal (a key typed there shows on the screen and stays in its scrollback).

One `--apply` runs at a time, for every instance: root takes a lock, `/run/ghost-protocol-setup/setup.lock`, and another run stops at once, saying so (two runs would remove each other's copies of the code). No other user can open that file (it is root's, 0600, in a folder of root's, 0700), so none can hold the lock to stop the setup; a lock file there that is not root's 0600 is replaced, never used. Root holds it for as long as the run lives. A run whose instance another run changed since its checks stops too: run it again. A dry run takes no lock: it writes nothing.

After writing, it asks, as the agent user and as the key's user (with `runuser`, so it is the kernel's answer), whether either can read the key file, and whether the agent user can write the code, the settings, the tag or the allowlist. It also checks that everything installed is root's alone: every file and folder of the code, the settings folder and its files, the units, node, and every folder above them (an existing `/opt/ghost-protocol`, `/etc/ghost-protocol` or `/srv/ghost-protocol` keeps its owner through `install -d`). And it reads each unit as systemd loads it (`systemctl show` and, as root, `systemctl cat`, an instance's name for each template, so the drop-ins are systemd's own list, read by systemd): from the file it wrote, read since it changed, and with no drop-in, in any folder systemd reads (`/etc`, `/run`, `/usr/lib`, a unit's own `.d` folder or a `gp-key-<name>-….d` prefix folder), that sets more than limits, timeouts, restarts and logging. A drop-in is read the way systemd reads it, as an instance unit is (above): `[Service] ` with a trailing space or tab, CR LF line ends and a byte-order mark are all `[Service]`. A drop-in that changes who runs a unit, what it runs or is handed, what it can reach or where it listens (`User=`, `ExecStart*=`, `OpenFile=`, `Environment=`, `ListenStream=`, `SocketMode=`, any sandbox setting, and every other key not on that list), or a `JoinsNamespaceOf=`, is named, and fails the check. So does one this check cannot read as systemd does: a section header other than `[Unit]`, `[Service]`, `[Socket]`, `[Path]` or `[Install]` alone on its line, a key before any header, a control character, a second byte-order mark, or a drop-in that cannot be read at all. A failure stops it with a FAIL: nothing is left listening, and the commit is not recorded. Run it again once fixed, without `--key-from-stdin` or `--key-generate` (the key file is there): every run that passes leaves the listeners enabled and running. A key's user that cannot read the allowlist gets a warning: the channel then lets nobody in from it.

Then, with the listeners on, it makes one real connection to each socket, as the agent user, with the root-owned node and code (`launch.mjs probe`: an MCP `initialize`, never the end of the handshake, so a probed channel never reaches the relay). Each must be answered, or the run ends with a FAIL that names the socket and the units' journal (`journalctl -u 'gp-key-<name>-channel@*' -u 'gp-key-<name>-buzz-mcp@*'`), and nothing is reported as installed. The channel's socket, while a session holds it (one connection at a time), is not probed; that connection shows it serves. A session is a running `gp-key-<name>-channel@<nr>-<pid>-<uid>` instance whose peer process is alive. The socket's connection count is no proof either way: systemd 255 counts a connection until its instance is dead (a probe that gave up, or a connection the channel dropped, stays counted), and a `daemon-reload` sets the count to 0 while the connections run on. A session that connects between that look and the probe gets the probe's connection closed before an answer (by systemd at once, or, after a reload, by the probe's own channel, which finds the session's lock): only that answer ("closed the connection before answering"), with a session holding the socket after it, counts as held. A probe that timed out, got an error, or was answered by a server that is not a channel fails, whatever holds the socket. An update probes after the key service starts again and before the instance does. Running the setup again with nothing changed makes all of these checks again: that is how to check an installed key service.

**The real systemd test.** [`install/test/live/keyservice-systemd.sh`](install/test/live/keyservice-systemd.sh) runs the key service end to end on a real systemd, for a throwaway machine only: as its admin, from a clone at the commit to test, with node 22 and buzz-mcp built, `install/test/live/keyservice-systemd.sh --throwaway`. It makes an agent user and a test instance with a key made on the machine (no relay login is needed), installs it with the setup, checks that each socket answers a real connection, that there is no drop-in and the journal holds no refusal, that a channel held by a session is not probed while a channel that hangs fails, that drop-ins systemd applies fail the setup however they are written (`User=root` plainly, and behind a header with a trailing space or tab, CR LF line ends, a byte-order mark, a line ending in two backslashes, a lone CR or a NUL; `ListenStream=` with CR LF), while a limit written with a byte-order mark and CR LF passes, that a stand-in instance unit whose drop-in continues a line into one starting with byte 2 fails, then adds the [GitHub App slot](#the-github-app-slot) with a throwaway RSA key made on the machine and `--skip-github-check` (GitHub is never asked) and checks that only its socket starts, that the agent user cannot read its key, that the socket answers the agent user with the key's fingerprint and refuses a repo off the allowlist, that a user outside the agent's group cannot connect, and that a second key is refused while a swap on purpose works, and then takes it all away again (`--keep` leaves it). It prints exit codes and counts, and exits 0 only when every step passed.

**The instance's side.** After the first install, as the agent user: in the instance's settings file, set the plugin's `buzz_key_socket` to `/run/ghost-protocol-key/<name>` and its `buzz_key_command` to empty, remove any copy of the key, and restart the instance. [`install/service/start`](install/service/start) then:

- checks, instead of a buzz-mcp build, that both sockets are there and that no key command is left (a start refuses otherwise);
- refuses to export any `BUZZ_*` or `NOSTR_*` credential from the instance's drop-in into Claude Code's environment. That keeps such a credential out of the session's environment, not off the disk: systemd writes it to `/run/credentials/<name>.service/`, which the agent user reads, so the setup refuses an instance unit that loads one (above), and this is only a second net. `BUZZ_AUTH_TAG`, the owner's public tag, is let through only on an instance without a key service; with one, the tag is the key units';
- gives `--test` a throwaway channel: its settings copy empties `buzz_key_socket`, so the test never takes the instance's own channel, which takes one connection at a time;
- takes the plugin's servers off Claude Code's needs-login list (`~/.claude/mcp-needs-auth-cache.json`) before claude starts, every start and every `--test`. Claude Code 2.1.314 puts a plugin server there after one failed start, such as a key service not answering yet, and then skips it at every later start, so the instance would come up deaf for good. Other servers' entries stay; a dry run says what a start would take off.

**Sending a file.** buzz-mcp reads a file to send only from `files/`, which the session cannot write: anyone who can write in that folder could swap a file for a link between buzz-mcp's check of the path and its read. So the session writes the file into `outbox/` under a name starting with a dot, then renames it. The file must be readable by its group, the key's group (the folder is setgid): with the agent user's umask at `077`, a file comes out `0600` and the copy step leaves it ("could not open it"). A umask of `027` or `022` for the session, or a `chmod g+r` before the rename, does it. `gp-key-<name>-outbox.path` sees the change, and [`install/keyservice/outbox-copy`](install/keyservice/outbox-copy), run as the key's user but never given the key, moves each regular file at the top of the outbox into `files/`. It never follows a link, takes no FIFO, no folder, no file with another hard link and no file over 64 MiB, keeps `files/` within a quota (1000 files and 1 GiB in all), and leaves a line in its journal for anything it leaves. The session then sends `/srv/ghost-protocol/<name>/files/<file>` by path. Files there older than seven days are removed.

**Updating.** An update of the instance (`boot.sh --update`, as the agent user) moves the plugin's checkout, and its summary says the key service is still at the old commit. The admin then moves the key side, from the admin's own checkout at the new commit:

```sh
install/keyservice/setup --name <name> --agent-user <user> --update --commit <id> --apply
# If the new commit misbehaves: back to the commit before the update.
install/keyservice/setup --name <name> --agent-user <user> --rollback --apply
```

Each puts the code for that commit in place (or reuses it; a rollback runs its old copy as it is, with no `npm ci`, when that copy is intact: root's alone, the commit's files, buzz-mcp of its pin, its dependencies there), writes the units for it, records the commit it moves from, stops the listeners and every open connection, starts the listeners again, and then restarts `<name>.service`: a pipe cannot hand a running MCP session over to a new server, so the whole instance starts again. Copies that no instance runs or rolls back to are removed.

**Undo.** As the admin: `systemctl disable --now gp-key-<name>-channel.socket gp-key-<name>-buzz-mcp.socket gp-key-<name>-outbox.path`, remove the six units and `daemon-reload`, then set the instance's key command back and empty `buzz_key_socket`. The key file, the settings and the state stay until removed by hand, so nothing is lost by mistake. The GitHub App slot alone: `systemctl disable --now gp-key-<name>-github.socket`, stop `gp-key-<name>-github@*.service`, remove its two units and `daemon-reload`, then remove `github.conf` and `public-text.json`, shred `github-app.pem` and any `.github-app.pem.new-*` or `.github-app.pem.old-*` beside it (the slot is on while the key or `github.conf` is there), remove its user (`userdel gp-gh-<name>`), and delete the key on GitHub.

### The GitHub App slot

A reviewer agent approves pull requests as a GitHub App. The slot keeps the App's private key away from the agent, as the relay key is kept: the agent never holds the key, a JWT or a token, and gets one fixed action instead, posting a review. Its code is [`adapters/buzz/src/github-review.mjs`](adapters/buzz/src/github-review.mjs) (Node.js built-ins only), run from the root-owned copy by `gp-key-<name>-github@.service`, one process per connection to `/run/ghost-protocol-key/<name>/github.sock`. The session's side is [`tools/github-review/gp-github-review`](tools/github-review/), which holds no key.

That unit runs as a user of its own, `gp-gh-<name>`, which the setup makes: a system user with no home and no shell, alone in its own group. It is never the key's user, `gp-key-<name>`, which runs buzz-mcp, the channel and the copy step, all of which take what the agent and the relay send. A process can read the memory of another process of the same user (`/proc/<pid>/mem`), and `ProtectProc=invisible` hides only other users' processes; on a kernel without Yama nothing else stops it. So a buzz-mcp someone took over, under one user, could otherwise read the App key out of the GitHub process while it serves a request. With a user of its own, it cannot: a process of another user, with no capabilities, may not read that memory. The App key's user reads neither key file itself: systemd opens the App key for it (`OpenFile=`), and the setup checks, as that user, that it cannot read either file.

```sh
# The settings: the App's client ID, the repos it may review (each with the installation that holds it),
# and the reviewer's own identities, which the limits below compare with: the App's bot login and its
# bot noreply address. Optionally GITHUB_REVIEW_ALLOW_COMMENT=1 (0 when absent).
cat >github.env <<'EOF'
GITHUB_APP_CLIENT_ID=Iv23li...
GITHUB_REVIEW_REPOS=<installation id>:<owner>/<repo>,<installation id>:<owner>/<repo>
GITHUB_REVIEW_OWN_LOGINS=<app slug>[bot]
GITHUB_REVIEW_OWN_EMAILS=<the bot's user id>+<app slug>[bot]@users.noreply.github.com
EOF
# The key, piped straight from where it is kept (a pipe or a file, never a terminal), and the public-text rules:
<the App's private key> | install/keyservice/setup --name <name> --agent-user <user> --github-settings "$PWD/github.env" --github-public-text "$PWD/public-text.json" --github-app-key-from-stdin --apply
```

**Only an App's bot is "own".** `GITHUB_REVIEW_OWN_LOGINS` takes logins ending `[bot]`, and `GITHUB_REVIEW_OWN_EMAILS` addresses of the form `<id>+<name>[bot]@users.noreply.github.com`; the setup and the key service refuse anything else. A person's address can never be written down as the reviewer's own, and that matters: every builder commits under one shared noreply author, and counting it as the reviewer's own would refuse every review. Both lists are needed (1 to 10 entries each, none twice in any case). The setup's last check also asks GitHub which App the key belongs to and refuses it when no own login is `<its slug>[bot]` (a typo would silently switch the own-pull-request and own-commit limits off; `--skip-github-check` leaves that out with the rest).

**The public-text rules** are a JSON list, `[{"name": "<slug>", "pattern": "<regular expression>", "ignore_case": true}, ...]` (`ignore_case` is optional and false when absent; nothing else is allowed in a rule), written by whoever holds the list the reviewers' fence uses, so that both read one list. They hold internal names, so they are not in this repository and `--github-public-text <file>` is how they arrive. Between 1 and 200 rules; each name a slug, and **a neutral word, because the name of the rule a body fails goes back to the reviewer in the refusal** (never the pattern, and never the text that matched); each pattern 1 to 500 characters.

The patterns are written for Python's `re` (the fence's) and read here by a JavaScript `RegExp`, compiled with `u` (code points, as Python reads them) and, for `ignore_case`, `iu` (Unicode case folding, so `ſ` and the Kelvin sign match `s` and `k` as they do in Python's `re.I`). So the loader refuses what the two read differently, or only one has, instead of letting a rule silently never match: the escapes `\A \Z \z` (Python's) and `\p \P \k \c \u{...}` (JavaScript's); a back-reference; `{,n}` (Python's 0 to n; JavaScript's literal text); any `(?` group other than `(?:`, `(?=`, `(?!`, `(?<=` and `(?<!` (inline flags, named groups, comments, conditions); a `$` (Python also matches it before a final newline; write the rule so that it does not need one); and a class that starts with `]`. A pattern that does not compile with `u` (such as `\@`, which Python takes) is refused too. What is left shares a syntax, but not every meaning: `\w \d \s \b` on non-ASCII text, and `.` on `\r`, still differ, and the fleet's parity test against the fence is where those are named. A pattern that matches the empty text is refused.

**A rule cannot stall the key service.** A pattern that backtracks without end would hold the process (matching is synchronous, so the connection's timer cannot fire) until the unit's 2-minute stop, with its token unrevoked. So every match runs under a time limit (`vm`'s `timeout`, which interrupts a running regular expression): 100 ms for one rule against a body, 2 s for all of them. A rule that runs out of time is a `public-text` refusal with its own clause (`the public-text check of the body took too long (rule <name>), so the body was not accepted`); it posts nothing and the token is revoked as for any refusal. The loader also tries each pattern against a few texts that provoke backtracking, under the same limit, and refuses the file when one runs out of time, along with a repeated group that holds an unbounded repeat (`(a+)+`, `(a+b){2}`): those two are a first filter at setup, and neither proves a pattern safe. `serve` tries the time limit once at every start and refuses to start where it does not work. The root-owned copy's code (`github-review.mjs rules check <path>`) reads the file before the setup installs it, so a refused file never replaces the one there, and `serve` reads it again at every start, from a file and folders only root can change, and refuses to start without it. Needed the first time; afterwards the installed file is kept, and read again, unless `--github-public-text` is given again.

One key on stdin per run, so on a new machine install the relay key first, then add the slot. Adding it to an instance that runs makes the App key's user and starts only the GitHub socket: the session is not restarted. `--github-app-key-from-stdin` takes the PEM GitHub hands out, an RSA key of 2048 bits or more, in one PEM block. The root-owned copy's code checks it and writes it, as root, to `github-app.pem` (0400), and prints only its fingerprint, the form GitHub shows on the App's page. A key file that is there is never replaced, unless `--replace-github-app-key` says so. Rotation:

1. Make a new key on GitHub.
2. Swap it in with `--github-app-key-from-stdin --replace-github-app-key`. The setup does it in one step and prints both fingerprints. The key it replaced is overwritten with zeros and removed, and so is anything an earlier run left beside the key file (`.github-app.pem.new-*`, `.github-app.pem.old-*`); every run of the setup clears those. A leftover that is only a second name for a file kept elsewhere, as a run stopped between its link and its unlink leaves for the live key, is removed but never overwritten, so the live key keeps its bytes and its mode.
3. Delete the old key on GitHub.

Keep one key for each reviewer machine, so one machine's key can be revoked alone.

**The action.** `gp-github-review review <owner/repo> <pr> <head-sha> <APPROVE|REQUEST_CHANGES|COMMENT> [<body> | -]` (with `-`, the body is read from stdin). On the key's side, in this order:

1. Every field is checked: an `owner/repo`, a pull request number, the head's full 40-character id, one of the three events (never `PENDING`), and a body of at most 60,000 bytes, which `REQUEST_CHANGES` and `COMMENT` need. A request with any other field, or any other action, is refused.
2. The repo must be on the allowlist (check `repo`). Its entry names the installation; the request never does. And `COMMENT` is refused unless `GITHUB_REVIEW_ALLOW_COMMENT=1` (check `event`): a reviewer approves or requests changes. Both are decided before the key is read or GitHub is asked anything.
3. Only then is the key read, for a JWT (RS256, its `iat` a minute back, its `exp` nine minutes ahead, its `iss` the client ID).
4. It asks for a token for that one repo with `pull_requests: write` alone, never `contents`, and refuses a token GitHub makes wider (another permission, more repos, or every repo). A reviewer App holds `contents: write` on its installation, which its approval needs to count. An approval made with a token asked for `pull_requests: write` alone counts all the same, and that token cannot push. The token is taken as an opaque string, as GitHub asks: 20 to 4096 characters of letters, digits, `_`, `.` and `-`, with no fixed length or inner form. GitHub's installation tokens are stateless since October 2026, about 520 characters with dots in them, where they were 40 before. Anything else in a token (a space, a control character) is refused.
5. It reads the pull request once with the token. From that one answer, so that the facts are one snapshot, it refuses unless: it is in that repo and open (`open`); its head is the id given (`head`); its title does not start with `HOLD:` (any case, after leading whitespace) and it has no `hold` label (`hold`: the two ways `merge-by-policy` holds one, and a title or labels it cannot read are a hold too); it is not a draft (`draft`); it is not the reviewer's own, which is to say its author is none of the own logins, compared in any case (`own-pr`); and, in a repo that GitHub does not say is private, the body passes the public-text rules (`public-text`; a `private` field that is missing or not `true` counts as public, and a body that is empty has nothing to check).
6. It lists the pull request's commits (`own-commit`): at most 100 (a pull request with more is refused, as is one whose count cannot be read), the list must be the pull request's whole (as many commits as the pull request says) and hold the head the review is pinned to (GitHub's order is not relied on), and no commit may be authored by an own login or an own email, compared in any case. A commit's author is read from the commit itself and from the account GitHub links to it, and a commit with neither readable is refused, not skipped. The list is read with the same token (`pull_requests` alone); if GitHub refuses it (a 403, no answer) that is refused as `own-commit` too, so that a failed read can never pass as "no own commits".
7. It posts the review with `commit_id` set to that head.
8. It reads the pull request again. If the head moved meanwhile (a push between step 5 and step 7), the answer is not ok: "the head moved while the review was posted", with the review it posted, and the ledger line has `head_after`. The same goes when it cannot read the pull request again, and when the pull request has become held or a draft: GitHub takes a review on no condition, so that last window (about a second between steps 5 and 7) is closed by finding the change, not by preventing it, and the answer names the review for the lead to deal with.
9. It revokes the token (`DELETE /installation/token`), whatever happened. Once GitHub has made a token, every way out revokes it, a token refused in step 4 too, as long as it can be sent back as it is (visible characters only). The ledger line then says whether it was revoked.

It answers with the review's id, state and link, or with why it refused. A refusal for a limit carries the name of the check (`{"ok":false,"check":"hold","error":"the title starts with HOLD:"}`), and `gp-github-review` prints it as one line on stderr and exits 1: `refused: hold: the title starts with HOLD:`. A failure that is no limit (no token, no answer from GitHub) names no check. No clause repeats a title, a body, a login or an address, and a commit is named by its first seven characters; the journal's ledger line for it has the check's name beside the repo, pull request, head and event, and never the body. Every refusal before step 7 posts nothing: `repo` and `event` send nothing to GitHub at all, and the others have made a token, read, and revoked it. It never answers with the key, a JWT or a token, and it offers nothing else the App could do: no merge, no update-branch, no contents write. An update-branch push that doesn't change the diff can leave an earlier approval in force, so the App never gets one through here. Each request leaves one ledger line in the unit's journal, with the repo, the pull request, the head, the event, the body's sha256 and length, the result and whether the token was revoked (`journalctl -u 'gp-key-<name>-github@*'`). Two more requests answer the setup's last check: `fingerprint`, which returns the key's fingerprint with no network call, and `app`, a `GET /app` with a JWT, which returns the App's id, slug, owner and permissions after checking that its client ID is the configured one.

**Every repo on the allowlist needs two branch rules**, in its ruleset or branch protection: dismiss stale approvals when new commits are pushed (`dismiss_stale_reviews_on_push`), and require approval of the most recent reviewable push (`require_last_push_approval`). The review is pinned to the head the reviewer read (`commit_id`), and the action reads the pull request again after posting, but a push can still land between GitHub taking the review and that second read. These rules make GitHub dismiss an approval that is no longer for the latest push, and keep a pusher's own approval from counting.

**What the limits cannot see.** Every builder and reviewer commits under one shared noreply author, so `own-commit` cannot tell a reviewer's own commit from a builder's: it catches work authored by the App's bot (a commit made through the API as the App, a pull request the App opened), nothing more. Keeping a reviewer off its own pair's work stays a matter of who is asked to review. The limits do not count reviews per pull request, do not know who a pull request is assigned to, and do not check that a lead said "go".

**Time limits.** The request line must arrive within 5 seconds. Each GitHub request gets 15 seconds, and a review makes six. The whole connection gets 100 seconds; past that it revokes a token it still holds and ends. The unit stops any process at 2 minutes (`RuntimeMaxSec=`), and the client waits 130 seconds.

**Where it may connect.** systemd filters by address, not by name, and `api.github.com`'s addresses change. So the one origin is fixed in the code: `https://api.github.com`, with no redirect followed and TLS checked against node's own roots. The serve process refuses to start with any setting that would loosen that or log the traffic (`NODE_TLS_REJECT_UNAUTHORIZED`, `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `SSLKEYLOGFILE`, `NODE_USE_ENV_PROXY`, `NODE_DEBUG`, `NODE_DEBUG_NATIVE`), along with the loader settings and node options `launch.mjs serve` refuses. The unit unsets them all, and allows IPv4, IPv6 and local sockets only. The module's own tests talk to a stand-in on `127.0.0.1` through `GP_TEST_GITHUB_API`, which serve refuses outright under systemd (`INVOCATION_ID` set).

**What the setup checks.** Before changing anything, it checks:

- the App key's user, `gp-gh-<name>`, when it is there already: made by this setup for this role and this instance (its comment, `Ghost Protocol GitHub App key for <name>`, says so), a system user with no shell and no home, alone in its own group, sharing no group with the agent user or the key's user (otherwise the setup makes it). The key's user is held to the same rule with its own comment, so a user made for one role or instance is never taken over by another. No instance name gives a key's user (`gp-key-<name>`) a `gp-gh-` name, so instances `foo` and `foo-gh` never share a user;
- the settings' form: a client ID (`Iv...`), each repo once with its installation, at most 100; the own logins and own emails, both there, App bots only, none twice, at most 10 each; `GITHUB_REVIEW_ALLOW_COMMENT` 0 or 1;
- the public-text rules: given the first time (`--github-public-text`), or the installed file there; the root-owned copy's code reads the file before it is installed (after the code is in place, before `github.conf` is written), so a refused file leaves the one there and the settings untouched;
- the key: given when there is none, or swapped on purpose;
- that the commit has the slot's code. A rollback to a commit from before the slot, or an update to one, is refused.

After writing, it checks:

- that none of the agent user, the key's user and the App key's user can read `github-app.pem` or `buzz-key`, and that the agent user cannot write `github.conf` or `public-text.json`;
- the two units as systemd loads them, with no drop-in that changes them;
- as the agent user, through the socket: the key's fingerprint, which must be the file's. That shows systemd hands the key over, with no network.
- then GitHub's answer for the App, which must be an App whose `<slug>[bot]` is among the own logins, unless `--skip-github-check` leaves that out with a SKIP line (for a test key GitHub doesn't know).

A failure there is a FAIL, and the listeners stay on for the next run. The slot is on for as long as its key or its settings are there; updates and rollbacks move its units with the others and end its open connections too.

**Updating an instance that has the slot from before the limits.** `--update` refuses, before anything changes, until it is given what is new: `--github-settings <file>` with the two `GITHUB_REVIEW_OWN_*` lines (the file holds all of the settings again; the installed `github.conf` is kept only when it is not given) and `--github-public-text <file>`. So the new code never runs with the old settings, and the request that would have got through under the old rules is never answered by a service that quietly lacks the new ones. The unit file does not change, and only the GitHub socket restarts. A **rollback** to a commit from before the limits works when it is run from this commit's setup (the older code reads only the two settings it knows and ignores the rest), and it runs without any of the limits: say so when you do it.

**What still reaches the key.** Root does, and anything that can become root, as for the relay key: the setup refuses an agent user that can. The App key's user itself only through the descriptor, during one request.

## Workspace layout

An instance keeps its work under one root folder: its own repo at `<root>/<name>`, beside `repos/`, `worktrees/`, `media/`, `desk/` and `scratch/`. The home stays on main and every edit goes through a worktree under `worktrees/<repo>/<branch>`. [`docs/layout.md`](docs/layout.md) is the spec. It covers:

- the installer's layout step;
- the Claude Code worktree hook ([`install/layout/worktree-hook`](install/layout/worktree-hook));
- the move script for an older single-folder instance ([`install/layout/move`](install/layout/move));
- the start script and systemd unit that run an instance ([`install/service/`](install/service/)).

## Restarts

The start script ([`install/service/start`](install/service/start)) is the instance's systemd service, and it watches the instance's own `claude`, not only its tmux session. The operator may open other windows in that session (an editor, a git tool, a shell):

- **When `claude`'s window ends** (`/exit`, a crash) and other windows keep the session alive, the script starts `claude` again in a new window of the same session, within `GP_WATCH_SECONDS` seconds (10 by default), resumed as on any start and with the Buzz channel. The other windows stay as they are, and the new window opens behind the one the operator is on. A pane that tmux's `remain-on-exit` keeps is closed first. Moving `claude`'s window to another session of the same tmux server counts as its window ending. The new `claude` runs without the names in tmux's `update-environment` that the start script itself does not have (such as `SSH_AUTH_SOCK` and `DISPLAY`, which tmux copies from each attaching client into the session), so it never gets an attached operator's forwarded agent and sees what a first start sees; a name the script has, such as `PATH` or a credential, is never removed, whatever the list says. The operator's own windows keep them. So after `/exit`, `claude` comes back on whatever binary `GP_CLAUDE` names: to upgrade Claude Code, install the new version first, then `/exit`.
- **No two `claude`s at once.** Before the new one starts, what is left of the old one (every process in its session or process group) gets `GP_STOP_SECONDS` seconds (10 by default) to end, then TERM, then KILL, each only while its start time is the one noted, so a pid another process holds now is never signalled. If anything is left after KILL, the start time is unknown (no `/proc`) while the pid or its process group is in use, or `claude`'s pid was never read, the script exits 1 and systemd's stop ends the whole service instead. A child that called `setsid` itself has left that session and group, and only that hand-over catches it.
- **When the whole session ends** (`claude` was its only window, or the session was killed), the script exits 1 and systemd starts it again, after a delay that grows with each restart.
- **Quick ends:** a `claude` that ends within 90 seconds of its start counts as a quick exit. After two in a row, the next start begins a new session instead of resuming (a broken transcript cannot keep the instance down). A third quick exit in a row, in its window, goes to systemd for its growing delay, and the session's other windows end with the service then.
- **Remote Control:** when `claude` runs with `--remote-control` (or `--rc`, which a `GP_CLAUDE` wrapper may add; or `GP_REMOTE_CONTROL=on`), the script checks after each start that Remote Control came up: up is a `bridgeSessionId` in Claude Code's own session file (`~/.claude/sessions/<claude's pid>.json`, not a documented interface); down is no bridge session after `GP_RC_WAIT` seconds (60 by default). The pane is never read for it, so text shown there cannot cause a restart. Claude Code does not retry a failed start by itself, so the script restarts `claude`, resumed, never by typing into the pane: after `GP_RC_BACKOFF` seconds (120 by default, doubled each time), only once the instance is idle, and not counted as a quick exit. It also waits while a tmux client is attached. After `GP_RC_TRIES` starts (3 by default, at most 16, never reset) it gives up and leaves `claude` running. Once up, a drop is only reported (`down` after `GP_RC_WAIT` seconds), never retried: Claude Code reconnects by itself. Both checks read `claude`'s own process, so a `GP_CLAUDE` wrapper must `exec` claude. The state (`checking`, `up`, `retrying`, `failed`, `down` or `off`) is in `~/.local/state/ghost-protocol/<name>/remote-control`, and `start --dry-run` prints it while the session runs: `retrying`, `failed` and `down` are a `FAIL` line and end the dry run `NOT READY`. `GP_REMOTE_CONTROL=off` turns the watch off.

## Unattended mode

An instance that runs under its service has nobody at its terminal. Plain auto mode still opens a dialog there in a few cases, and a dialog nobody answers stalls the agent: the turn never ends, and nothing reaches the thread it was asked in. In a test of an unattended agent, these all waited for a key:

- auto mode's confirmation after three blocked actions in a row ("Do you want to proceed?");
- a read outside the working folders;
- AskUserQuestion;
- the offer to teach auto mode about the environment (`/auto-mode-setup`), which appeared on its own.

Unattended mode answers or removes each of those, so the turn ends and the block is reported in the thread. It is the plugin setting `unattended`, **off by default**, so an instance with a person at its terminal is unchanged. Turn it on in the instance's own settings file (`~/.config/ghost-protocol/<name>.json`, the one the service passes with `--settings`). The start script reads it from there and from Claude Code's managed settings only, the first that sets it deciding. A value in your user settings or in the home's `.claude/` settings files is never read, so a stray one cannot turn it on for a session a person starts by hand:

```json
{ "pluginConfigs": { "ghost-protocol@ghost-protocol": { "options": { "unattended": "on" } } } }
```

When it is on, the start script ([`install/service/start`](install/service/start)) does four things at every start, and its dry run shows them:

| Piece | Why |
|---|---|
| A PermissionRequest hook ([`adapters/buzz/hooks/unattended-deny`](adapters/buzz/hooks/unattended-deny)) denies every permission dialog, with a message that tells the agent not to retry or work around the step, and to report in the Buzz thread that it needs a person. | The three dialogs above are permission requests. Denied, the turn goes on, ends, and says what was blocked. The hook acts only with `GP_UNATTENDED=1`, which the start script passes to the pane's `claude` alone (not to the tmux server), so no other session is touched. |
| `skillOverrides` with `"auto-mode-setup": "off"` | The offer to teach auto mode is a dialog of its own, not a permission request. |
| `switchModelsOnFlag: true` | A safeguard flag can switch the session to another model. Unset, Claude Code may ask first in an interactive session; `false` pauses on a dialog. `true` switches without asking. |
| `--permission-mode auto`, unless `GP_PERMISSION_MODE` in the instance's drop-in names another mode | The command line beats a settings file's `defaultMode`, and a resumed session would otherwise come back in the mode it saved. `bypassPermissions` is refused: it skips every check, and Claude Code asks at startup to confirm it. |

The two settings go into a copy of the instance's settings file, `~/.local/state/ghost-protocol/<name>/settings.json`, written at every start; the instance's own file is never changed. The channel test (`start --test`) starts in the same mode.

### Fresh starts

An unattended instance resumes its one conversation across restarts. The plugin keeps that the right conversation after a `/clear`, and a fresh start begins a new one on purpose:

- **After `/clear` or `/resume`,** Claude Code goes on in another conversation. The plugin's [`session-id`](hooks/session-id) hook writes its id to the file the start script resumes, so a restart or a crash comes back to it. It acts only in the instance's own `claude`: the start script passes the instance's name to that `claude` alone (`env GP_INSTANCE_NAME=<name> claude …` on the pane's command line, never into the tmux server, whose other windows would get it), and writes its pid to `~/.local/state/ghost-protocol/<name>/pane-pid`. The hook acts only when the first `claude` above it is that pid. So a `claude` in another window of the same tmux server, or a `claude` the agent runs itself (which inherits the name), never moves the file.
- **A fresh start:** while the file `~/.local/state/ghost-protocol/<name>/fresh` exists, the next start begins a new session instead of resuming. It deletes the file before `claude` starts, and puts it back if `claude` cannot start. Only a regular file counts: a link, a folder or anything else of that name is ignored, with a log line, and never followed. A file the start script cannot delete is ignored too, with a log line, and the instance resumes as usual, so a stuck file can never keep it down or restart it in a loop.
- **`start --fresh` never cuts off work it can see.** It is meant for unattended agents, whose work all happens in their turns. It waits until the instance is idle, sets the file and ends the session; the start script's watchdog starts the new session at once. Idle means all of these:
  - the plugin's [`turn-state`](hooks/turn-state) hook marked the last turn ended (busy at the prompt, idle at the Stop with that prompt's id, or at the StopFailure that Claude Code fires instead when an API error ends the turn);
  - the transcript shows the turn is over. A Stop that a hook blocks is followed by more of the same turn, so the marker alone is not enough;
  - the turn left no background Agent run and no workflow going. Claude Code 2.1.314 counts them on each turn's end in the transcript (`pendingBackgroundAgentCount`, `pendingWorkflowCount`), and they go on after the turn, though one in a long model call, web fetch or MCP call writes nothing for a while. A count a crash left high keeps the instance busy until its next turn;
  - nothing in the session's own folder (where a background subagent writes its transcript), and no other conversation's transcript in the same project folder, was written in the last `GP_FRESH_QUIET` seconds (60 by default);
  - on Linux, the instance's `claude` runs no tool command, such as a background Bash or Monitor command. Each is a child of it that runs Claude Code's shell snapshot (`~/.claude/shell-snapshots/`); most read `/dev/null`, and a Bash one writes a task output file. A child with any of these signs counts; its MCP servers show none.

  Still busy after `GP_FRESH_TIMEOUT` seconds (300 by default), it says the last sign of work it saw, then refuses with a fixed line starting `start: BUSY:` and sets nothing. If the instance moves on while it waits (another `--fresh` restarted it, a crash restarted it, or a `/clear`), it ends nothing and says so. It makes the `fresh` file only where there is none (a link of that name is removed, never written through) and reads the pane's pid once more just before it ends the session, so two calls at once never mean two restarts.
- **The agent can ask for it itself** when its work is done: `install/service/start --root <root> --name <name> --fresh`. Asked from the instance's own session, the call returns at once and the wait goes on in the background, since the agent's own turn is the busy one; the result lands in `~/.local/state/ghost-protocol/<name>/fresh.log`. The agent ends its turn, and the restart follows once the session has been quiet for `GP_FRESH_QUIET` seconds.

## Hooks

The plugin ships these Claude Code hooks. [`hooks/README.md`](hooks/README.md) explains them.

- **Time stamp:** every prompt gets a line with the current time, in the time zone you set.
- **Auto-pull:** right after the agent runs `gh pr merge`, the instance's clean checkout of that repo is fast-forwarded.
- **Chrome guard:** the instance's main thread does not drive Chrome; a subagent does.
- **Reply guard** (Buzz adapter): a turn in which the operator messaged the agent on Buzz cannot end until each message has an answer on Buzz. With [DM task roots](adapters/buzz/README.md#dm-task-roots) on, a top-level DM from the operator is a task: it also needs a state from the channel's `task` tool and an answer in its thread. A PostToolUse hook keeps its own record of the Buzz sends, reactions and task states, since Claude Code can write a turn's last tool calls to the transcript only after the Stop hooks ran.
- **Root limit** (Buzz adapter): a top-level Buzz post, in a channel or a DM, may be at most 5 non-empty lines and 400 characters, so the top level reads as a list of threads. A longer one is refused, and the agent posts a short root and puts the rest in a reply. Replies are never limited. The operator can exempt a channel, give it its own limit, or allow a few longer roots with a [pass only root can write](adapters/buzz/README.md#exceptions).
- **Auto-mode drift check:** when the instance's main thread starts, any drift between Claude Code's auto-mode rules and the instance's snapshot is printed into the session, for the operator to check. It runs only where the auto-mode guard is installed (see [Auto-mode guard](#auto-mode-guard)).
- **Memory backup trigger:** right after a Write or Edit inside a memory folder that an installed memory backup watches, that backup runs (see [Memory backup](#memory-backup)).
- **Load proof:** at a start of the instance's own `claude`, the sha256 and first line of its class file and its team repo's `AGENTS.md` go to a `proof.json` in its state folder, and one line to a Buzz channel, so the operator can tell which rules an agent started with (see the [hooks README](hooks/README.md#load-proof)).
- **Session id and turn state:** for the start script, in the instance's own session only (see [Fresh starts](#fresh-starts)).
- **Unattended mode's permission hook** (Buzz adapter): off unless [unattended mode](#unattended-mode) is on.

The first eight are on by default, each switched off by its own plugin setting. The session-id and turn-state hooks have no switch: they act only in the `claude` the start script launched. The permission hook follows `unattended`.

## Status line

[`statusline/`](statusline/) is GHOST Protocol's status line for Claude Code: the branch, the full folder path, the model and its version, a context bar that is full when compaction is due, the effort level, and four clocks (Bangkok, US East, US West and the machine's own). An instance can give it its own name, a glitch animation for that name, and quotes, in a private settings file; without one it shows a plain `GHOST` name. A plugin cannot set Claude Code's status line, so the installer wires it into the user's settings (step 7b). [`statusline/README.md`](statusline/README.md) has the details.

## Buzz adapter (first)

[`adapters/buzz/`](adapters/buzz/) connects the agent to a [Buzz](https://github.com/block/buzz) relay. It is a Claude Code channel: when someone mentions the agent in one of its Buzz rooms (a list you choose, or every room it is in), or writes to it in a direct message, the message is pushed into the running Claude Code session. Replies go out through Block's buzz-mcp server. It reconnects after drops, catches up on what it missed, and never delivers a message twice.

Channels are a Claude Code research preview, so the adapter runs only in an interactive session started with `--channels`, on a machine whose Claude Code managed settings allow the channel. Setup, configuration, security notes and limits are in [`adapters/buzz/README.md`](adapters/buzz/README.md).

## Agents

[`agents/`](agents/) holds the plugin's agents, which Claude Code runs as `ghost-protocol:<name>`.

- **blackout** ([`agents/blackout.md`](agents/blackout.md)) redacts a screenshot so it is safe to share. It covers the sensitive parts with solid black boxes, then checks its own work with full-resolution crops and OCR until nothing sensitive can be read. It runs on Linux and macOS, and needs Python 3, ImageMagick and Tesseract. Its tool, and how to install those, is in [`tools/blackout/`](tools/blackout/README.md).

## How changes land: approve by exception

`main` changes only through a pull request, and a pull request merges on its own once every required check passes. No person approves an ordinary change.

- **The gates** are CI checks, run from one workflow, [`tests.yml`](.github/workflows/tests.yml), whose `all-tests` check is the one listed in [`.github/required-checks`](.github/required-checks). It calls the tests that a change touches, and fails unless each one it called passed: the installer and core hook tests on Linux (`install-test`), the blackout tool's tests on Linux (`blackout-test`), the Buzz adapter's tests with the reply guard's (`adapter-tests`), the rollout check's tests with the hooks they run (`rollout-check-test`), and, for every change, a secret scan of every commit and a scan of the tree for internal names, stray keys and email addresses (`gates`). [`.github/tests-to-run.sh`](.github/tests-to-run.sh) lists which paths call which tests; a change under `.github/` calls them all, and a path it does not list fails the run until it is added.
- **macOS in CI is paused,** because macOS runner minutes cost too much. The installer and the tools still support macOS, but CI no longer runs their tests there, nor under macOS's bash 3.2. The note on each workflow's `os` matrix says how to turn it back on.
- **The one exception** is [`.github/CODEOWNERS`](.github/CODEOWNERS) itself: a change to that list waits for the code owner, so no pull request nobody approves can add a gate or remove that one. Since 2026-11-11 nothing else waits for a person: the workflows, the list of required checks and the secret scan's settings merge on the checks like any other change. A new gate is added as an automated check.
- **What the checks do not cover.** A pull request can change a workflow, a test or the secret scan's settings, or weaken them, and merge on the checks it changed. A code-review gate, still to come, is meant to cover that.
- **Undo** is a revert of one squash commit.

### The branch ruleset

[`tools/ruleset/ruleset`](tools/ruleset/ruleset) makes GitHub hold `main` to these rules, as one ruleset named "Protect main":

- A change lands only through a pull request, merged by squash (the only merge method it allows). It needs no approval, except that a change to a path in CODEOWNERS needs the code owner's. A new push dismisses an earlier approval. GitHub's extra approval for a pull request that Copilot opens under its own identity stays on, as GitHub sets it by default; it adds an approval only where at least one is required, so here it adds none.
- Every check in `.github/required-checks` must pass, reported by GitHub Actions. A pull request need not be up to date with `main` first.
- Nobody can force-push to `main` or delete it.
- Nobody can bypass the ruleset, admins included.

GitHub's auto-merge switch is not part of the ruleset; it is a repository setting. With it on, the merge job ([`merge-by-policy.yml`](.github/workflows/merge-by-policy.yml), its tests in [`.github/merge-by-policy/`](.github/merge-by-policy/)) switches auto-merge on for each pull request that qualifies, and GitHub merges it once the ruleset is satisfied. Nobody presses merge.

- **With the ruleset as this script makes it** (no approval required), a pull request qualifies once every required check has passed on its latest commit. No approval is needed, and the repository variable `MERGE_REVIEWER_LOGINS` is not used.
- **What still stops it:** a title that starts with `HOLD:` or a `hold` label, a draft, a reviewer's latest review that requests changes, a change to a CODEOWNERS path or to a CODEOWNERS file, a merge conflict, and a ruleset that no longer requires `all-tests`, the code owner's review or the dismissal of stale approvals.
- **If the ruleset requires approvals** (1 or more), the job also needs that many approvals of the latest commit from the logins in `MERGE_REVIEWER_LOGINS`, and the rule that the most recent push is approved by someone other than its pusher.
- **"Require approval of the most recent reviewable push" must be off** for a pull request to merge with no approval. GitHub applies it even when the ruleset requires 0 approvals, so it still asks for one approval after every push. This script turns it off.

Run the script with the gh login of an admin of the repo; it refuses an integration or app token. Without `--apply` it changes nothing and prints the exact request:

```sh
tools/ruleset/ruleset --repo <owner>/<repo>            # dry run
tools/ruleset/ruleset --repo <owner>/<repo> --apply    # create it, or update it to match
```

- **A second run sends nothing** when the ruleset already matches. Any other setting on it (another merge method, required reviewers, switched off, another branch, a setting GitHub adds later) counts as a difference, and `--apply` puts it back. The dry run and `--apply` name each setting that differs, with what this script sends and what GitHub has.
- **It proves the ruleset is in force.** After sending, it reads the ruleset back and the rules GitHub enforces on `main`. On a private repo GitHub enforces a ruleset only on a paid plan, so on a free one the script stops with that reason.
- **It refuses while a listed check has not reported on `main`,** since a required check that never reports blocks every pull request. Run it after the change that adds a check has merged.
- **To add tests,** give the new test workflow `on: workflow_call`, then add its row in `.github/tests-to-run.sh` and its job in `tests.yml` (the head of `tests.yml` lists the five places). `all-tests` then covers it, and the ruleset does not change.
- **The one required check is `all-tests`.** New tests join it, as above, so the ruleset does not change for them. A check that should be required beside it is the rare case: add its job and its line in `.github/required-checks` in one pull request (the list's test fails unless every job that runs on pull requests is listed or is needed by a listed job), merge it, then run the script again from `main`. Until then the new check runs but is not required. The same pull request also relaxes the assert "the one listed check is all-tests" in `install/test/ruleset.test.sh`, or the list's test fails.
- **To rename or remove a required check** (as the move from four checks to `all-tests` did), the pull request that does it no longer reports the old name, so it could never merge while the ruleset requires that name. Point the ruleset at the new list first:
  1. From that pull request's branch, run the script with `--allow-unreported --apply`. It reads the branch's `.github/required-checks`; `--allow-unreported` lets it go ahead although the new name has not reported on `main` yet.
  2. Merge the pull request. Other open pull requests don't report the new name until they merge `main` in, so each waits until then.
  3. Run the script again from `main`, without `--allow-unreported`. It should say the ruleset already matches.

  Or switch the ruleset off, merge, and run `--apply` again.
- **One effect of "no bypass":** GitHub never lets authors approve their own pull requests, and the code owner is one person. So a pull request that the code owner opens and that touches `.github/CODEOWNERS` can't merge while the ruleset is on. Have someone else open it, or switch the ruleset off for that merge.

**To undo it,** with the same admin login, delete it. `<id>` is the number the script prints, also shown under Settings, Rules, Rulesets.

```sh
gh api --method DELETE repos/<owner>/<repo>/rulesets/<id>
```

To switch it off but keep it, open it under Settings, Rules, Rulesets and set its enforcement status to Disabled. Running the script with `--apply` again switches it back on, or makes it anew.

**After the first `--apply`,** check that it holds:

1. `gh api repos/<owner>/<repo>/rules/branches/main` lists the four rule types: `deletion`, `non_fast_forward`, `pull_request` and `required_status_checks`.
2. A throwaway pull request that touches `.github/CODEOWNERS`, opened by an account other than the code owner's (an agent's, say), shows that a code owner's review is required. A second one that touches no CODEOWNERS path (a workflow, say) merges with no approval once its checks pass. Close the first and revert the second.

## Licence

Ghost Protocol is licensed under the [Elastic License 2.0](LICENSE). You may use, copy, change and share it, but you may not provide it to others as a hosted or managed service, and you may not remove or obscure its licence notices.

[`NOTICE`](NOTICE) lists the third-party software the image carries, and its licence: the Buzz tools (`buzz-mcp`), built from Block's `buzz-app` under the Apache License 2.0.

Outside contributions are not taken for now.
