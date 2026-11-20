# Provenance

Where the code in this repository and in its image comes from, and under what licence. `LICENSE` is the Elastic License 2.0, for GHOST Protocol's own code. `NOTICE` carries the notices of the third-party software the image carries.

## What the image carries

| Part | Where it comes from | Licence |
| --- | --- | --- |
| GHOST Protocol's own code (this repository) | written here | Elastic License 2.0 |
| `buzz-mcp`, the Buzz tools as a stdio MCP server | built at the image build from Block's `block/buzz-app`, at the commit in `adapters/buzz/buzz-mcp.pin`, unchanged | Apache License 2.0 |
| The packages bundled in that build | `@modelcontextprotocol/server`, `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@scure/base`, `nostr-tools`, `zod` | Apache-2.0 and MIT, MIT, MIT, MIT, MIT, Unlicense, MIT; the notices are in `NOTICE` |
| The adapter's npm dependencies (`adapters/buzz`, 103 packages, installed with `npm ci --omit=dev`) | the npm registry, at the versions and checksums of `adapters/buzz/package-lock.json` | MIT (92), ISC (7), BSD-3-Clause (2), BSD-2-Clause (1), Unlicense (1: `nostr-tools`). Each stays in the image as published, with its own `LICENSE` file |
| Claude Code | Anthropic's release server, at the version and checksum in `install/pins.env`, installed at the image build | Anthropic's own terms; not licensed by this repository. A user needs their own Claude subscription |
| Node.js and the base system (Debian packages: bash, git, python3, jq, tmux, curl, procps, tini) | the official `node` image and Debian's archive | Each package's own licence, in `/usr/share/doc/<package>/copyright` in the image |

The adapter's packages are those of `package-lock.json` that are not development-only. Their licences are the `license` field of each lockfile entry. None is a copyleft licence.

## `adapters/buzz/src/relay.mjs` and Block's code

`relay.mjs` is the adapter's relay subscription: login, catch-up, dedupe and reconnect. Block's buzz-app has its own relay code in TypeScript (`src/features/relay`, and the Buzz tools in `src/buzz-mcp`), at the pinned commit. The two were compared on 2026-11-16:

- **Method.** Every line of `adapters/buzz/src/*.mjs` of 35 characters or more, with its white space collapsed, was looked up among the lines of `src/features/relay`, `src/buzz-mcp` and `src/features/agents` of the pinned commit. Comments and imports were left out.
- **Result.** Across the adapter's 1,512 such lines there are 12 matches. All are one-line common idioms: `Math.floor(Date.now() / 1000)`, `return new Promise((resolve, reject) => {`, `const value = process.env[name]?.trim();` and the like. `relay.mjs` has three, all the timestamp one. No function, block or comment is shared.
- **What they have in common.** Both speak the same protocol: the event kinds (9 for a message, 22242 for the login, 39000 and 39002 for room details and rosters, 44100 and 44101 for membership notices) and the owner's attestation tag. Those are the relay's interface, not Block's expression. The adapter takes them from the relay's documented behaviour and builds on `nostr-tools`.
- **So:** no file of Block's was copied into this repository, and no file here needs Apache-2.0's notice in its header. If one is ever copied, it keeps its upstream notice, and `NOTICE` names it.

## buzz-mcp and Apache-2.0

The Apache License asks that a distribution carry a copy of the licence and the upstream's attribution notices that pertain to what it distributes. `NOTICE` has the licence's full text, Block's copyright line, the pertaining paragraphs of the upstream's `NOTICE.md`, and the notices of the packages bundled into the build. The image has `NOTICE` and `LICENSE` at `/opt/ghost-protocol`.

## Keeping this true

- When `buzz-mcp.pin` moves, read the upstream `NOTICE.md` and `package.json` again at the new commit, list the packages in the new build (the `//#region node_modules/.pnpm/...` lines of the built script name them), and update `NOTICE` and the table above in the same pull request.
- When an npm dependency of the adapter changes, its licence comes from the lockfile; a copyleft one needs a decision first.
- `tools/release/t/provenance.sh` checks that `NOTICE` names the pinned commit and every bundled package, and that this note lists the same packages.
