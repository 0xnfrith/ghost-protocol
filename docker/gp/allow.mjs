// gp allow: the senders besides the owner, in one file that the adapter reads again when it changes (BUZZ_ALLOWLIST_FILE, adapters/buzz/src/allowlist.mjs).
//   gp allow list | add <key, hex or npub1> | remove <key>
// The owner is not in the file: it is cfg.owner, always allowed, trusted and the operator, and nothing here adds, removes or changes it. A hosted agent's other senders are `order`
// entries that each pull rewrites, so removing one by hand is refused; the ones added by hand are `local`. The file is replaced in one step, as the adapter asks.
import { GpError } from "./out.mjs";
import { L } from "./layout.mjs";
import { readJson, writeJson } from "./files.mjs";
import { adapter } from "./paths.mjs";

const MAX_ENTRIES = 64;

export const readAllowlist = () => (Array.isArray(readJson(L.allowlist).entries) ? readJson(L.allowlist).entries.filter((e) => typeof e?.pubkey === "string") : []);
const write = (entries) => writeJson(L.allowlist, { entries }, 0o644);

/** The file exists, so the adapter reads an empty list and not a missing file. */
export function ensureAllowlist() {
  if (readJson(L.allowlist).entries === undefined) write([]);
}

/** The order service's senders after the owner replace the `order` entries; the local ones stay, except one the order now lists. */
export function setOrderSenders(owner, senders) {
  const order = senders.filter((k) => k !== owner);
  const local = readAllowlist().filter((e) => e.source === "local" && !order.includes(e.pubkey) && e.pubkey !== owner);
  write([...order.map((pubkey) => ({ pubkey, source: "order" })), ...local]);
}

/** A key from the env seed (BUZZ_ALLOWED_PUBKEYS after the first): a local entry. */
export function addLocal(pubkey, owner) {
  const entries = readAllowlist();
  if (pubkey === owner || entries.some((e) => e.pubkey === pubkey)) return false;
  write([...entries, { pubkey, source: "local" }]);
  return true;
}

export async function allow(argv, out) {
  const [sub, key, ...rest] = argv;
  if (!["list", "add", "remove"].includes(sub) || rest.length || (sub === "list") !== (key === undefined)) throw new GpError("usage", "usage: gp allow list | gp allow add <public key> | gp allow remove <public key>", 2);
  out.header();
  const owner = readJson(L.config).owner;
  const entries = readAllowlist();
  if (sub === "list") {
    out.kv("OWNER", owner || "none");
    for (const e of entries) out.kv("ALLOWED", `${e.pubkey} ${e.source === "order" ? "order" : "local"}`);
    return 0;
  }
  const { parsePublicKey } = await import(adapter("src/config.mjs"));
  let pubkey;
  try {
    pubkey = parsePublicKey(key, "the public key");
  } catch {
    throw new GpError("bad-key", "the key must be a public key: 64 hex characters or npub1");
  }
  if (pubkey === owner) throw new GpError("owner-fixed", "that is the owner: the owner is always allowed, is not in this list, and nothing here changes it");
  const found = entries.find((e) => e.pubkey === pubkey);
  if (sub === "add") {
    if (found) out.kv("ALLOW", "already");
    else if (entries.length >= MAX_ENTRIES) throw new GpError("too-many", `the list holds ${MAX_ENTRIES} senders at most`);
    else (write([...entries, { pubkey, source: "local" }]), out.kv("ALLOW", "added"));
    return 0;
  }
  if (!found) throw new GpError("not-listed", "that key is not in the list");
  if (found.source === "order") throw new GpError("order-managed", "the order service lists that sender, so removing it here would not last: change it where the order was made");
  write(entries.filter((e) => e.pubkey !== pubkey));
  out.kv("ALLOW", "removed");
  return 0;
}
