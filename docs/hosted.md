# A hosted agent

A hosted agent is a GHOST Protocol container that an **order service** made for someone. It starts with two values and nothing else, and becomes the agent its order describes: the service gives it its key, relay, owner, senders and a skills pack. The quick start has the usual way, where the person makes the key themself.

## Start

```
docker run -d --name gp-agent -v gp-agent-data:/data \
  -e GP_BOOT_TOKEN=<the boot token> -e GP_ORDER_URL=<the order service's address> <image>
```

- `GP_ORDER_URL` is the order service's address alone: `https://`, with no path, query, user or password. `http://` is taken only for this machine's own loopback (`localhost`, `127.x.x.x`, `[::1]`), for tests.
- `GP_BOOT_TOKEN` is 32 lower-case hex characters. The order service gives a token once, and it ends after fifteen minutes whether it was used or not.
- With neither value, and on a volume never booted, `gp hosted start` prints `GP_HOSTED=none` and does nothing. A token on a volume that already has an agent key of its own is ignored. The entrypoint unsets both values after it reads them; the address stays in `/data/.gp/hosted.json`.

## What it does

| Step | What happens |
| --- | --- |
| Boot, once | `POST /v1/machine/boot` with the token. The service answers the agent's secret key and config to this one request. The key is written to `/data/.gp/agent.key` (mode 0600) **before** anything else is checked, because a lost answer has no second one. |
| Every start | `GET /v1/machine/config`, a NIP-98 event signed by the agent's own key, then the checks below, then the same setup as any agent. A volume that was booted starts even when the order service does not answer or answers 5xx (`GP_PACK=unchecked`), with what it has; any other failure, a 401 included, stops it, so an ended order stops the agent. |
| While it runs | The same pull every few minutes, so a new sender or pack arrives without a restart. The entrypoint reports `online` at the agent's start, then after each good pull once the agent runs, `error` after a failed one, and `stopping` when it is stopped (`gp hosted heartbeat`, `POST /v1/machine/status`). |

The token is read from the environment, sent once and never written. The key is in the agent's volume and nowhere else: not in an env file, a log, the image or a command's output. A boot that fails after the token was spent has no second answer: its order must be ended and made again.

## What it refuses

- **A config whose first sender is not the owner**, whose attestation is not the owner's valid NIP-OA tag for this agent's key, or whose owner is not the one the first boot set: an owner never changes.
- **A relay that resolves to a private, loopback or link-local address** (IPv4 and IPv6, an IPv4 address inside an IPv6 one counting as itself, and the other ranges that are not the public internet's). Every address the name resolves to is checked, and a name that does not resolve is refused. The agent never connects to it, and the refusal is a start that ends in `error`. The check is of the moment it is made, at each start and each pull, and the programs that connect resolve the name again when they do. So the relay must also be reached over TLS (`wss://` or `https://`; a plain `ws://` relay is refused, `relay-not-tls`): a name that changes its answer after the check reaches no server that has no certificate for the relay's own name.
- **A skills pack whose SHA-256 is not the one the config names**, or that is not what a pack is (below). Nothing is written from a pack that is refused, and the pack that was installed stays.

## Who may speak to it

The first sender of the config is the **owner**: the one allowed, trusted and operator sender, matching the config's owner and the attestation's signer. Every other sender is in one file, `/data/.gp/allowlist.json`, which the adapter reads again whenever it changes.

```
docker exec gp-agent gp allow list
docker exec gp-agent gp allow add <public key, hex or npub1>
docker exec gp-agent gp allow remove <public key>
```

`gp allow` never touches the owner. The service's other senders are `order` entries that each pull rewrites, so removing one by hand is refused; the ones added by hand are `local` and stay.

## The skills pack

The config's `pack` is `{ name, sha256, url, expiresAt }`, or `null`. The pack is a `.tar.gz` of **skill folders**, each with a `SKILL.md`. It is fetched from `url`, which must be on the order service's own origin, with no redirect, and is held to `sha256` as it arrives. The address is a bearer link that lives a few minutes: it is never printed or kept.

A pack is plain files and folders. A link, a device, an extended header, a path that is absolute or climbs, a header whose checksum is wrong, or more than 64 MiB downloaded, 128 MiB unpacked, 2,000 files, 16 MiB in a file or 8 folders deep refuses the whole pack. Make one with `tar -czf pack.tar.gz <skill folders>`: GNU tar's own format and `--format=ustar` are read (GNU's header has no prefix field, and a ustar prefix is joined to the name and checked with it), and `--format=pax` is refused for its extended headers.

Each folder is put at `/data/.claude/skills/<name>` as real files. A skill that is already there, a link included, and is not from the pack's earlier version is the owner's own: the pack is refused rather than replace it. The skills of the earlier version that the new one lacks are removed. `/data/.gp/pack.json` records what is installed, so the same pack is not fetched again.

## Commands

```
gp hosted start            what the entrypoint runs first
gp hosted sync             one pull of the config, applied
gp hosted report <status>  online, error or stopping
```

Output: `GP_HOSTED=none|ready|booted`, `GP_PACK=none|current|installed`, and on a failure `GP_ERROR=<code>`:  `bad-order-url`, `bad-boot-token`, `boot-refused`, `boot-failed`, `order-unreachable`, `bad-config`, `relay-private`, `relay-not-tls`, `config-failed`, `pack-refused`, `pack-checksum`, `pack-unreachable`, `not-booted` and `report-failed`.

## What was and was not run

Run, against a stand-in order service on the machine itself: the boot, the checks above, the senders, the pack and the status. Not run: a real VM with a real order service. A hosted agent still needs a Claude sign-in (`gp claude token`) unless the config carries a token.
