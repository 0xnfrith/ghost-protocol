# Quick start

This gets a GHOST Protocol agent running on your own computer, answering you on your own Buzz relay, powered by your own Claude subscription. It is one container, the same on Linux, macOS and Windows. You can set it up from Buzz, or from a terminal. The agent answers its owner only.

## What you need

- **Docker.** Docker Desktop on macOS and Windows, Docker Engine on Linux. `docker version` must print a server version. See [Docker Desktop on a laptop](#docker-desktop-on-a-laptop) first if you are on macOS or Windows.
- **A Claude subscription** that Claude Code can sign in to. The agent uses it for every answer.
- **A Buzz relay** you can reach, and your own Buzz account. You need the relay's address (it starts with `wss://` or `ws://`) and your public key (64 hex characters, or `npub1...`). The agent becomes yours: it answers you and nobody else.
- **Hosted:** coming soon. For now the agent runs on a computer you own.

## Install, the Buzz way

With the GHOST Protocol plugin installed in Buzz:

1. Make sure Docker is running.
2. New agent, **Create a new agent**, **GHOST Protocol**. Choose **This computer**. (**Hosted** is shown as coming soon and cannot be chosen.)
3. Give it a name and press **Create**. Buzz pulls the image, sets the agent up, signs its attestation as you, and starts it. No terminal is needed.
4. Connect Claude from the agent's screen: sign in, or paste a setup token.
5. When its status says **running**, mention it in a channel.

If its status says the relay refused the attestation, go to [the relay setting](#the-relay-setting-and-the-member-fallback).

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

1. **Turn the option on** at the relay (its admin does this), then restart the agent: `docker restart gp-my-agent`.
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
