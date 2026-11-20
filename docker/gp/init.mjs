// init: set up an agent in its data volume, the plugin's provision step.
//
//   docker run --rm -v gp-<slug>-data:/data <image> init --name <name> --relay <relay url> --owner <owner public key>
//
// Makes the agent's relay key inside the volume (0600) when there is none, and
// never prints it; writes .gp/config.json (name, slug, relay_url, owner). It
// prints GP_INTERFACE=1, GP_VERSION, GP_SLUG and GP_AGENT_PUBKEY. Run again,
// it keeps the key, so it prints the same public key, and takes the new
// name, relay and owner. Any failure is GP_ERROR=init-failed.
//
//   gp slug <name>   prints GP_SLUG, the name's slug (lower-case letters,
//                    digits and -), for the container and volume names
import { existsSync, readFileSync } from "node:fs";
import { GpError } from "./out.mjs";
import { L } from "./layout.mjs";
import { readJson, writeJson, writeFileAtomic, slugOf } from "./setup.mjs";
import { imageVersion } from "./status.mjs";
import { adapter } from "./paths.mjs";

const fail = (message) => new GpError("init-failed", message);

export function checkName(name) {
  // One non-empty line (the plugin's rule): no line break or other control
  // character; anything else, quotes and all, is kept as it was typed.
  if (typeof name !== "string" || !name.trim()) throw fail("--name is required");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw fail("the name must be one line, with no control characters");
  return name.trim();
}

export async function init(argv, out) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!["--name", "--relay", "--owner"].includes(a)) throw fail(`unknown argument ${a.split("=")[0]}; usage: init --name <name> --relay <relay url> --owner <owner public key>`);
    if (i + 1 >= argv.length) throw fail(`${a} needs a value`);
    o[a.slice(2)] = argv[++i];
  }
  out.header();
  const name = checkName(o.name);
  const { parseSecretKey, parsePublicKey, publicKeyOf, relaySocketUrl } = await import(adapter("src/config.mjs"));
  if (!o.relay) throw fail("--relay is required");
  try {
    relaySocketUrl(o.relay);
  } catch {
    throw fail("the relay address must start with https://, http://, wss:// or ws://");
  }
  let owner;
  try {
    owner = parsePublicKey(o.owner ?? "", "the owner public key");
  } catch {
    throw fail("--owner must be the owner's public key: 64 hex characters or npub1");
  }
  let pubkey;
  try {
    if (existsSync(L.key)) {
      pubkey = publicKeyOf(parseSecretKey(readFileSync(L.key, "utf8")));
    } else {
      const { generateSecretKey } = await import("nostr-tools/pure");
      const sk = generateSecretKey();
      writeFileAtomic(L.key, Buffer.from(sk).toString("hex") + "\n", 0o600);
      pubkey = publicKeyOf(sk);
      sk.fill(0);
    }
  } catch {
    throw fail("could not read or make the agent's key in the data volume (is /data a volume?)");
  }
  if (pubkey === owner) throw fail("the owner key and the agent key must differ");
  const cfg = readJson(L.config);
  try {
    writeJson(L.config, { ...cfg, name, slug: slugOf(name), relay_url: o.relay, owner });
  } catch {
    throw fail("could not write the settings into the data volume");
  }
  out.kv("VERSION", imageVersion());
  out.kv("SLUG", slugOf(name));
  out.kv("AGENT_PUBKEY", pubkey);
  return 0;
}

export async function slug(argv, out) {
  if (argv.length !== 1) throw new GpError("usage", "usage: gp slug <name>", 2);
  out.header();
  out.kv("SLUG", slugOf(checkName(argv[0])));
  return 0;
}
