// gp allow (allow.mjs), the adapter that reads its file, and the setup that points the adapter at it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "gp-allow-"));
process.env.GP_DATA = data;
const { L } = await import("../layout.mjs");
const { main } = await import("../gp.mjs");
const { setup, readJson, writeJson } = await import("../setup.mjs");
const { makeOut } = await import("../out.mjs");
const { adapter } = await import("../paths.mjs");
const { nip19 } = await import("nostr-tools");
test.after(() => rmSync(data, { recursive: true, force: true }));

const OWNER = "ab".repeat(32);
const [A, B] = ["a1".repeat(32), "b2".repeat(32)];
async function gp(...argv) {
  const [so, se] = [[], []];
  const code = await main(argv, makeOut({ write: (t) => so.push(t) }, { write: (t) => se.push(t) }));
  return { code, stdout: so.join(""), error: /^GP_ERROR=(.*)$/m.exec(so.join(""))?.[1] };
}
const file = () => JSON.parse(readFileSync(L.allowlist, "utf8"));

test("add, list and remove edit the file; an npub is kept as its hex; adding twice says so", async () => {
  writeJson(L.config, { owner: OWNER });
  assert.equal((await gp("allow", "list")).stdout.includes(`GP_OWNER=${OWNER}`), true);
  assert.match((await gp("allow", "add", A)).stdout, /^GP_ALLOW=added$/m);
  assert.match((await gp("allow", "add", nip19.npubEncode(B))).stdout, /^GP_ALLOW=added$/m);
  assert.match((await gp("allow", "add", A)).stdout, /^GP_ALLOW=already$/m);
  assert.deepEqual(file(), { entries: [{ pubkey: A, source: "local" }, { pubkey: B, source: "local" }] });
  assert.match((await gp("allow", "list")).stdout, new RegExp(`^GP_ALLOWED=${A} local\\nGP_ALLOWED=${B} local$`, "m"));
  assert.match((await gp("allow", "remove", A)).stdout, /^GP_ALLOW=removed$/m);
  assert.deepEqual(file().entries.map((x) => x.pubkey), [B]);
});

test("the owner is refused, added or removed, in either spelling, and the file is not touched", async () => {
  const before = readFileSync(L.allowlist, "utf8");
  for (const argv of [["add", OWNER], ["remove", OWNER], ["add", nip19.npubEncode(OWNER)], ["remove", nip19.npubEncode(OWNER)]]) assert.equal((await gp("allow", ...argv)).error, "owner-fixed", argv.join(" "));
  assert.equal(readFileSync(L.allowlist, "utf8"), before);
});

test("a bad key, an unlisted one, an order's, and too many are each refused", async () => {
  for (const [argv, code] of [[["add", "nope"], "bad-key"], [["add", "ab".repeat(31)], "bad-key"], [["add", "zz".repeat(32)], "bad-key"], [["remove", A], "not-listed"], [["list", A], "usage"], [["add"], "usage"], [["frob"], "usage"]]) assert.equal((await gp("allow", ...argv)).error, code, argv.join(" "));
  writeJson(L.allowlist, { entries: [{ pubkey: A, source: "order" }] }, 0o644);
  assert.equal((await gp("allow", "remove", A)).error, "order-managed");
  writeJson(L.allowlist, { entries: Array.from({ length: 64 }, (_, i) => ({ pubkey: i.toString(16).padStart(64, "0"), source: "local" })) }, 0o644);
  assert.equal((await gp("allow", "add", B)).error, "too-many");
});

test("the adapter reads the file again when it changes: an added sender is let in and a removed one is out, with no restart", async () => {
  writeJson(L.allowlist, { entries: [] }, 0o644);
  const { SenderAllowlist } = await import(adapter("src/allowlist.mjs"));
  const list = new SenderAllowlist({ listed: { keys: [OWNER], skipped: 0 }, file: L.allowlist, trusted: [OWNER], log: () => {} });
  assert.deepEqual([list.allows(OWNER), list.allows(A)], [true, false]);
  await gp("allow", "add", A);
  assert.equal(list.allows(A), true);
  await gp("allow", "remove", A);
  assert.equal(list.allows(A), false);
});

test("setup points the adapter at the file, and the env's other keys go in it, not in the owner's place", () => {
  rmSync(L.allowlist);
  assert.equal(setup({ GP_RELAY_KEY: "cd".repeat(32), BUZZ_RELAY_URL: "wss://relay.example.com", BUZZ_ALLOWED_PUBKEYS: `${OWNER}, ${A},nope,${OWNER}`, GP_NAME: "Ada" }), "ok");
  const opts = readJson(L.settings).pluginConfigs["ghost-protocol@ghost-protocol"].options;
  assert.deepEqual([opts.buzz_allowed_pubkeys, opts.buzz_trusted_pubkeys, opts.buzz_operator_pubkeys, opts.buzz_allowlist_file], [OWNER, OWNER, OWNER, L.allowlist]);
  assert.deepEqual(file(), { entries: [{ pubkey: A, source: "local" }] });
  rmSync(L.allowlist);
  assert.equal(setup({}), "ok");
  assert.deepEqual([existsSync(L.allowlist), file()], [true, { entries: [] }], "the file is there, so the adapter reads an empty list and not a missing file");
});
