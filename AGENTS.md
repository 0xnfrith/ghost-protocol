# AGENTS.md

For an agent that helps a person get GHOST Protocol running, or that works in this repository. This file is public.

GHOST Protocol is one container that runs a person's own agent on their own computer. It answers them on their Buzz relay and thinks with their own Claude plan. There are two ways to install it: the Buzz desktop app with the GHOST Protocol plugin (no terminal), or a terminal with `get.sh`. Both make the same container.

## What the person needs before anything else

1. **Docker.** Docker Desktop on macOS and Windows, Docker Engine on Linux. It must be running: `docker version` prints a server version.
2. **A paid Claude plan:** Pro, Max, Ultra, Team or Enterprise. The free plan does not include Claude Code. The agent signs in to Claude Code in one of two ways: with a setup token made by `claude setup-token` on any computer with Claude Code, or by signing in at an address the agent shows. The image has no place for an API key.
3. **A Buzz community (relay) with owner attestations on.** It comes from **Or create a community** in the Buzz app (it needs an account), or from running a relay from [block/buzz](https://github.com/block/buzz#i-want-my-own-hosted-relay). The relay must have owner attestations on: the relay setting `BUZZ_ALLOW_NIP_OA_AUTH=true`, which is **off by default**. Then the attestation Buzz signs for the person is enough. A relay without it is not supported yet.

   Without owner attestations, the relay refuses the agent ("not a relay member") and it never reaches **Running**. The one cure is for the relay's admin to turn owner attestations on, then restart the agent, or wait about a minute: `docker restart gp-<name>`. The same refusal has one other cause: the owner key that signs the attestation must itself be a member of the relay (the person's own Buzz account there is), and `gp attest --relay` checks it. This is the owner's key, not the agent's. The Buzz plugin's refusal text also suggests making the agent a relay member: that way is not supported for now, so do not offer it. Whether a community made in the Buzz app has owner attestations on has not been checked: ask its admin. The quick start's [relay setting](docs/quick-start.md#the-relay-setting-owner-attestations-on) has the steps.
4. **For the Buzz way, the Buzz desktop app,** signed in to that community. The browser build of Buzz cannot install plugins or start Docker.

## The chain, the Buzz way

| Step | What the person does | What can go wrong | The doc |
|---|---|---|---|
| 1. Add the plugin | In Buzz: **Settings → Plugins → Manage plugins → Add**. Put `https://github.com/0xnfrith/buzz-plugins` in **Git or GitHub repository**, press **Find**, pick **GHOST Protocol**, press **Continue**, check the review (every program it may run is `docker`), and press **Install plugin**. | The browser build cannot install it. The plugin does not start (its error is in **Manage plugins**). | The plugin's README, "How to install" |
| 2. Check Docker | Open the plugin's **GHOST Protocol** page (Cmd+K or Ctrl+K, type `GHOST`). It should say **Docker is running**. | **Docker didn't answer**: Docker is not running, or the Buzz app cannot find `docker` on its PATH (a Buzz started from the macOS Dock may not have the PATH a terminal has). | The plugin's README, "What the page shows first" and "Check it on your computer" |
| 3. The create form | **Agents → New agent → Create a new agent**, with **GHOST Protocol** as the **Harness**. Give a name. Choose **This computer** (**Hosted** is coming soon). Then answer the two questions: **Your Claude account** (paste a setup token, or choose to sign in at an address) and **Let GHOST Protocol update itself?** (yes or no). | **Create agent** stays held back until both questions are answered. A token with a space in it is refused. | The plugin's README, "The create form and the agent's tab"; the quick start, "Install, the Buzz way" |
| 4. Create agent | Press **Create agent**. The plugin runs eight steps, each one a `docker` command: check Docker, download the image, make the agent's key, start the agent, start the update helper (after a yes), hand the agent the attestation Buzz signed, sign in to Claude, and wait until the agent runs. | A failure names its step in one line. The first download is about 1 GB on disk. With a token, a relay that refuses the attestation ends the wait with "Your relay does not accept owner attestations…" and the agent's public key: that is prerequisite 3. With the address, Create agent ends at the Claude sign-in ("Waiting for you to sign in to Claude") and does not report the refusal. It shows on the agent's **GHOST Protocol** tab instead: the relay row says *Refused: not a member*, with the agent's public key, even while the agent still waits for its sign-in. After the sign-in the state is *Connecting to the relay*. | The plugin's README, the table under "The create form and the agent's tab" |
| 5. Running | The agent's **GHOST Protocol** tab says **Running** and **Claude: Active**. Mention the agent in a channel, and it answers in the thread. | It waits at *Waiting for a Claude sign-in* (see below), or at *Connecting to the relay* with *Refused: not a member* (prerequisite 3). | The plugin's README, the status screen; the quick start, "Check it" |

**When Claude is connected.** This depends on the way chosen in the form:

- **A setup token pasted in the form:** **Create agent** signs the agent in itself, as step 7, after the attestation and before the wait. The token is held in memory for that one command and is never stored by the plugin.
- **Sign in with an address**, or a token way with no token held (as after Buzz's **Finish setup**, or a restart of Buzz): step 7 is skipped and the agent waits at `needs-claude`. The person signs in afterwards on the agent's **GHOST Protocol** tab: paste a token there, or open the address it shows and paste back the code.

Either way, the sign-in lives in the agent's data volume and survives restarts.

**Names in Docker.** The container is `gp-<name>` and its data volume `gp-<name>-data`, where `<name>` is the agent's name in lower case with dashes. The update helper, after a yes, is `gp-<name>.updater`. So the terminal checks work on an agent Buzz made: `docker exec gp-<name> gp status`.

**Removing it.** Buzz's **Delete agent** removes the container, the helper and the data volume. That deletes the agent's key and its memory, for good. If Buzz has lost the agent's container name (its storage was cleared), Delete leaves the container and the volume in Docker. Remove them with the quick start's "Stop, restart, remove" commands.

## The other way: a terminal

`get.sh` (Linux and macOS) or `get.ps1` (Windows) makes the same container with no Buzz app. The person then gives the agent the owner's attestation (the relay must have owner attestations on) and signs it in to Claude with `gp claude login` or `gp claude token`. The [quick start](docs/quick-start.md), "Install, the terminal way", has every command, and "Check it" has the states and what to do in each.

## What the agent starts with

Both ways make an agent that starts the same:

- **Claude Opus 5.5 at medium effort** (`claude-opus-5-5`), unless its owner picks otherwise with `docker exec gp-<name> gp claude model <model> --effort <level>` (`gp claude model` alone shows both; `default` gives Claude Code's own). The model is a full id such as `claude-sonnet-5-5`, not an alias such as `opus`. An effort needs a model: the one named with it, else the one set now; `--effort` alone fails with `effort-needs-model` when no model is set. The pick is kept across restarts and updates.
- **GHOST Protocol's workspace layout** under `/data/work` in its data volume: its home `/data/work/agent`, and `repos/`, `worktrees/`, `media/`, `desk/` and `scratch/` beside it.
- **A `CLAUDE.md` in its home** that describes the layout. GHOST Protocol never replaces one the owner wrote or edited.

The quick start's [model and workspace](docs/quick-start.md#the-model-and-the-workspace) has the details.

## Where each doc lives

| What | Where |
|---|---|
| The quick start: what you need, the Buzz way, the terminal way, the relay setting, update, remove | this repository, [`docs/quick-start.md`](docs/quick-start.md) |
| This repository's overview and the rest of GHOST Protocol | this repository, [`README.md`](README.md) |
| The plugin: install, the create form, the agent's tab, the Claude guide, what was and was not checked | [0xnfrith/buzz-plugins, `plugins/ghost-protocol/README.md`](https://github.com/0xnfrith/buzz-plugins/tree/main/plugins/ghost-protocol) |
| How to add any plugin to Buzz, and the list of plugins | [0xnfrith/buzz-plugins, `README.md`](https://github.com/0xnfrith/buzz-plugins#readme) |
| The Buzz app: joining or making a community | [block/buzz-app, `README.md`](https://github.com/block/buzz-app#readme) |
| Running a relay, and its settings | [block/buzz, `README.md`](https://github.com/block/buzz#readme) |

## What has and has not been run

- **Run, on Linux, by hand:**
  - the released image pulled by the plugin's exact pin;
  - its key made, and the agent started;
  - the plugin's own create flow, against a real Docker without Buzz, which stopped at the attestation;
  - a setup token taken by `gp claude token`, and `claude -p` answering inside the agent, on the arm64 image under emulation.
- **Not run yet:**
  - the whole Buzz desktop route: the plugin installed from Git in the desktop app, **Create agent**, an attestation accepted by a real relay, a mention answered;
  - anything on a real Mac or on Windows.

Say so when you help someone, and do not promise more.

## Working in this repository

- Every file here is public. Write no private names, hosts, keys, relay addresses or tracker ids in files or commit messages.
- A statement in the quick start, in `README.md` or in this file has a check in [`tools/release/t/quickstart.sh`](tools/release/t/quickstart.sh) when it can have one. Change the doc and its check together.
