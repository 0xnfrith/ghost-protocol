# Quick start

This gets a GHOST Protocol agent running on your own computer, answering you on your own Buzz relay, powered by your own Claude subscription. It is one container, the same on Linux, macOS and Windows. You can set it up from Buzz, or from a terminal. The agent answers its owner only.

## What you need

- **Docker.** Docker Desktop on macOS and Windows, Docker Engine on Linux. `docker version` must print a server version. See [Docker Desktop on a laptop](#docker-desktop-on-a-laptop) first if you are on macOS or Windows.
- **A paid Claude plan**: Pro, Max, Ultra, Team or Enterprise. The free plan does not include Claude Code, so it is not enough. The agent uses the plan for every answer. It signs in with a setup token (`claude setup-token`, on any computer with Claude Code) or at an address it shows. It takes no API key.
- **A Buzz relay** you can reach, and your own Buzz account. A community comes from **Or create a community** in Buzz (it needs an account), or from [a relay of your own](https://github.com/block/buzz#i-want-my-own-hosted-relay). The relay must admit the agent: its admin turns owner attestations on, which is off by default, or adds the agent as a member (see [the relay setting](#the-relay-setting-and-the-member-fallback)). Otherwise the relay refuses the attestation Buzz signs for you. Whether a community made in Buzz has owner attestations on has not been checked: ask its admin. The agent becomes yours: it answers you and nobody else. The Buzz way takes the relay and your key from Buzz. The terminal way needs the relay's address (it starts with `wss://` or `ws://`) and your public key (64 hex characters, or `npub1...`).
- **Hosted:** coming soon. For now the agent runs on a computer you own.

## Install, the Buzz way

This needs the Buzz **desktop** app: the browser build cannot install plugins or start Docker. Buzz uses the relay you are on and your own key, so you type neither. For an agent helping someone through these steps, [`AGENTS.md`](../AGENTS.md) has the whole chain in one page.

1. Install the GHOST Protocol plugin. In Buzz, open **Settings → Plugins → Manage plugins** and press **Add**. Put `https://github.com/0xnfrith/buzz-plugins` in **Git or GitHub repository** and press **Find**. Pick **GHOST Protocol**, press **Continue**, read what it asks for (every program it may run is `docker`), and press **Install plugin**. The [plugin's README](https://github.com/0xnfrith/buzz-plugins/tree/main/plugins/ghost-protocol) shows each screen.
2. Make sure Docker is running. The plugin's **GHOST Protocol** page (press **Cmd+K**, or Ctrl+K, and type `GHOST`) says **Docker is running** when Buzz can reach it.
3. **Agents → New agent → Create a new agent**, and choose **GHOST Protocol** as the **Harness**. Choose **This computer**. (**Hosted** is shown as coming soon and cannot be chosen.)
4. Give it a name, and answer the form's two questions. **Create agent** is held back until both are answered:
   - **Your Claude account**: paste a setup token (run `claude setup-token` on a computer with Claude Code), or choose to sign in at an address.
   - **Let GHOST Protocol update itself?** Yes starts the update helper (see [Update](#update)). No starts none, and you update by hand.
5. Press **Create agent**. Buzz downloads the image (about 1 GB on disk, so the first time takes a while), makes the agent's key, starts it, signs its attestation as you and, with a token, signs it in to Claude. No terminal is needed. If you chose the address, open the agent's **GHOST Protocol** tab and sign in there.

   **When Claude is connected:** with a setup token pasted in the form, **Create agent** signs the agent in to Claude itself, after it hands the agent your attestation and before it waits for the agent to run. With the address, **Create agent** leaves the agent waiting for Claude, and you sign in afterwards on the agent's **GHOST Protocol** tab.
6. When its status says **Running**, mention it in a channel.

If its status says the relay refused the attestation, go to [the relay setting](#the-relay-setting-and-the-member-fallback).

In Docker the agent has the terminal way's names: the container `gp-<name>` and the data volume `gp-<name>-data`, where `<name>` is the agent's name in lower case with dashes. So the commands below work on it too, such as `docker exec gp-<name> gp status`.

**Delete agent** in Buzz removes the container, its update helper and its data volume: the agent's key and its memory, for good. To keep the memory, stop the agent and copy its volume first. The plugin's README shows how. If Buzz has lost the agent's container name (its storage was cleared), Delete leaves the container and the volume in Docker: remove them with the commands in [Stop, restart, remove](#stop-restart-remove).

## Install, the terminal way

### 1. Install

Linux and macOS:

```sh
curl -fsSL https://github.com/0xnfrith/ghost-protocol/releases/latest/download/get.sh | sh -s -- --name "My agent" --relay wss://relay.example.com --owner <your public key>
```

Windows, in PowerShell:

```powershell
& ([scriptblock]::Create((irm https://github.com/0xnfrith/ghost-protocol/releases/latest/download/get.ps1))) -Name "My agent" -Relay wss://relay.example.com -Owner <your public key>
```

To install one exact version, put `download/v<version>` where `latest/download` is. The file is a short script of `docker` commands, and the release lists its checksum in `SHA256SUMS`: read it first if you like. It pulls the image (the version and digest are filled in by the release), makes the agent's key inside a new data volume (the key never leaves it), starts the container, and prints one line:

```
GP_AGENT_PUBKEY=<64 hex characters>
```

That is the agent's public key. Keep it for the next step. The agent is called `gp-<name>` in Docker, where `<name>` is your name in lower case with dashes (`My agent` becomes `gp-my-agent`), and its data is the volume `gp-my-agent-data`. Below, `gp-my-agent` stands for yours.

The installer asks once whether to start the update helper (see [Update](#update)). Answer with `--updater yes` or `--updater no` (`-Updater` in PowerShell) to skip the question. With no terminal it starts none.

Run it again with the same name to change the relay or the owner: the key stays.

### 2. Let the relay accept it: the owner's attestation

A Buzz relay admits an agent that carries your signed attestation (your tag). Make it and give it to the agent. If you hold your owner key in a file (64 hex characters or `nsec1...`):

```sh
docker exec -i gp-my-agent gp attest <agent public key> < owner.key \
  | sed -n 's/^GP_AUTH_TAG=//p' \
  | docker exec -i gp-my-agent gp auth-tag set
```

The key goes in on standard input and is never printed or kept. The answer is `GP_AUTH_TAG=accepted`. If you have the tag from somewhere else (it is one line, `["auth", ...]`), write it to `docker exec -i gp-my-agent gp auth-tag set` the same way.

### 3. Sign in to Claude

Either way, the sign-in lives in the data volume and survives restarts.

- **Sign in with a code.** `docker exec -i gp-my-agent gp claude login` prints `GP_CLAUDE_LOGIN_URL=<address>`. Open the address in a browser, sign in, and paste the code you are given at the prompt, then Enter. It ends with `GP_CLAUDE=active`.
- **Or paste a setup token.** On a computer with Claude Code, run `claude setup-token`. Then `docker exec -i gp-my-agent gp claude token` and paste the token. It is checked once and never shown again.

### 4. Check it

```sh
docker exec gp-my-agent gp status
```

prints lines like `GP_STATE=running`, `GP_RELAY=connected` and `GP_CLAUDE=active`. (`gp status --json` prints the same as one JSON object.) The state goes from `needs-auth-tag` and `needs-claude` (whichever is still to do) to `connecting` and then `running`.

Then mention the agent in a channel on your relay. It answers in the thread.

| State | What to do |
| --- | --- |
| `needs-auth-tag` | Step 2. |
| `needs-claude` | Step 3. |
| `connecting` | Wait a moment. If `GP_RELAY` is `refused-not-member`, see [the relay setting](#the-relay-setting-and-the-member-fallback). If it is `unreachable`, check the relay address and that this computer can reach it. |
| `running` | Nothing. |
| `error` | `GP_ERROR_MESSAGE` says what. `docker logs gp-my-agent` has more. |

## The relay setting and the member fallback

A Buzz relay admits a key that is not a member only when the relay's owner-attestation option is on, and that option is **off by default**. Without it, the agent connects, is refused with "not a relay member", and `gp status` shows `GP_RELAY=refused-not-member`. You have two ways out:

1. **Turn the option on** at the relay (its admin does this: `BUZZ_ALLOW_NIP_OA_AUTH=true` in the relay's settings), then restart the agent: `docker restart gp-my-agent`.
2. **Add the agent as a member.** Give the relay's admin the agent's public key (`GP_AGENT_PUBKEY` from the install, also in `gp status`) and ask for it to be added as a member. The tag is then not needed, and `gp auth-tag set` can be skipped.

If you own the relay, you are the admin.

## Docker Desktop on a laptop

On macOS and Windows, containers run inside Docker Desktop's virtual machine, and these things follow from that:

- **Docker Desktop starts when you sign in**, not when the computer starts. Until then nothing runs, and the agent is off. Turn on *Start Docker Desktop when you sign in* in its settings.
- **"Always on" means while Docker Desktop runs.** The agent's container restarts with Docker (`--restart unless-stopped`), so it comes back after you quit and reopen Docker Desktop, or after a reboot and a sign-in. It does not answer while the computer sleeps, is shut down, or Docker Desktop is quit. A server that stays up is the better home for an agent that must always answer.
- **Windows** needs Docker Desktop with its WSL 2 backend. Windows Server cannot run Docker Desktop. The install passes no environment file, so Windows line endings cause no trouble.
- **macOS**: Apple silicon and Intel are both covered; the image is built for `linux/amd64` and `linux/arm64`, and Docker picks the right one.

## Update

A release is a new image. Your data (the key, the sign-in, the agent's memory) lives in the volume, so it is kept.

A new release starts as a pre-release, and stays one until one of our own agents has run it cleanly. Until then neither `latest/download` nor the agent's update check offers it; you can still install it by its exact version.

- **With the update helper** (a second container, `gp-my-agent.updater`, which holds the Docker socket and is started only if you said yes at install): `docker exec gp-my-agent gp update request`. The agent finishes what it is doing, then the helper swaps in the new version. `gp status` shows `updating`, then `running` with the new `GP_VERSION`. For a few seconds the container may be missing: that is the swap.
- **By hand**, with no helper. Take the new release's image (the release page names it), and run:

  ```sh
  docker pull <image>:<new version>
  docker rm -f gp-my-agent
  docker run -d --name gp-my-agent --restart unless-stopped -v gp-my-agent-data:/data <image>:<new version>
  ```

  Use the same volume and the same name. Or run the new release's `get.sh` again with the same name, relay and owner: it does these steps for you.

`gp status` says in `GP_UPDATE_AVAILABLE` whether a new version is known.

## The way back

- **With the helper:** `docker exec gp-my-agent gp update rollback`. It goes back to the version that ran before, and `gp status` shows it.
- **By hand:** the same three commands as the manual update, with the old version's image.

Nothing in the data volume is removed by either.

## Stop, restart, remove

- Restart: `docker restart gp-my-agent`. Stop: `docker stop gp-my-agent`.
- Remove the agent but keep its data: `docker rm -f gp-my-agent gp-my-agent.updater`. Installing again with the same name finds the same key and sign-in.
- Remove everything. This deletes the agent's key, its sign-in and its memory, and cannot be undone:

  ```sh
  docker rm -f gp-my-agent gp-my-agent.updater
  docker volume rm gp-my-agent-data
  docker image rm <image>:<version>
  ```

  An agent whose key was deleted cannot be brought back: a new install makes a new key, a new agent.

## Licence

GHOST Protocol is under the Elastic License 2.0. See [`LICENSE`](../LICENSE) and [`NOTICE`](../NOTICE).
