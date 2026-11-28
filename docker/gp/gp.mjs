#!/usr/bin/env node
// gp: GHOST Protocol's commands in the image, for the Buzz plugin, the evals
// and people. The output follows interface 1 (out.mjs).
//
//   gp attest <agent-pubkey> ...   the owner's NIP-OA tag for an agent key (attest.mjs)
//   gp status [--json]             the agent's state (status.mjs)
//   gp init --name --relay --owner set up the agent in its volume; gp slug <name> (init.mjs)
//   gp auth-tag set|show           the owner's tag, on stdin (authtag.mjs)
//   gp claude status|login|token   the Claude sign-in; gp claude model, its model and effort (claude.mjs)
//   gp update request|rollback|... updates and the way back (update.mjs)
//   gp updater --target <container> the update helper, in a container of its own (updater.mjs)
//   gp profile publish [--retry]   the agent's own Buzz profile, its name (profile.mjs)
//   gp allow list|add|remove       the senders besides the owner, in a file the adapter reads again (allow.mjs)
//   gp hosted start|sync|report    an agent made by an order service: its boot, config, skills pack and status (hosted.mjs)
import { GpError, makeOut } from "./out.mjs";

const COMMANDS = {
  attest: async (argv, out) => (await import("./attest.mjs")).attest(argv, out),
  status: async (argv, out) => (await import("./status.mjs")).status(argv, out),
  init: async (argv, out) => (await import("./init.mjs")).init(argv, out),
  slug: async (argv, out) => (await import("./init.mjs")).slug(argv, out),
  "auth-tag": async (argv, out) => (await import("./authtag.mjs")).authTag(argv, out),
  claude: async (argv, out) => (await import("./claude.mjs")).claude(argv, out),
  update: async (argv, out) => (await import("./update.mjs")).update(argv, out),
  updater: async (argv, out) => (await import("./updater.mjs")).updater(argv, out),
  profile: async (argv, out) => (await import("./profile.mjs")).profile(argv, out),
  allow: async (argv, out) => (await import("./allow.mjs")).allow(argv, out),
  hosted: async (argv, out) => (await import("./hosted.mjs")).hosted(argv, out),
};

export async function main(argv, out = makeOut()) {
  const [cmd, ...rest] = argv;
  try {
    const run = COMMANDS[cmd];
    if (!run) throw new GpError("usage", `usage: gp <${Object.keys(COMMANDS).join("|")}> ...`, 2);
    return await run(rest, out);
  } catch (err) {
    if (err instanceof GpError) {
      out.error(err.code, err.message);
      return err.exitCode;
    }
    out.log(`gp: ${err?.stack ?? err}`);
    out.error("internal", "an unexpected error; the line before says what");
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/gp")) {
  process.exitCode = await main(process.argv.slice(2));
}
