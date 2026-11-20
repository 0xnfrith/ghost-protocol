// The workflow rule's mutation check: runs its tests against broken copies of
// the code, one break each. Every copy must fail the suites; a break whose
// text is no longer in the code (not applied), or leaves code that does not
// parse, fails this check too, so the list stays in step with the code. It
// covers what keeps a stranger from waking the agent through a workflow: the
// relay's key as the only signer that counts, the signature, the shape of
// each stamp, the agent named by the stamp, the one rule used by the three
// places that ask the allowlist (rejectReason, the delivery path and the
// thread context), the relay's key read for every kind of room list, and a
// refusal kept under the owner, the relay's key read in the background (and
// again at the heartbeat) instead of at the login's expense, and a workflow
// the agent owns treated as its own message.
//
// The adapter is copied once into a temporary folder (its node_modules
// too); each break is written into that copy and taken out again, so the
// working tree is never changed.
//
// Run: node test/workflow-owner-mutants.mjs [part of a name]   (a few minutes; not part of npm test)
// With a part of a name, only the breaks whose name has it.
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER, tempDir } from "./helpers.mjs";

const RELAY = "src/relay.mjs";
const STATE = "src/state.mjs";
const CHANNEL = "src/channel.mjs";
const UNIT = "test/workflow-owner-unit.test.mjs";
const E2E = "test/workflow-owner.test.mjs";
const STATE_SUITE = "test/state.test.mjs";

// [name, file, suites, [[exact text, replacement], ...]]
const MUTANTS = [
  // Who counts as the relay.
  ["any author may carry the stamps", RELAY, [UNIT, E2E], [["!event || event.pubkey !== relayKey || event.kind", "!event || event.kind"]]],
  [
    "no known relay key means any author does",
    RELAY,
    [UNIT, E2E],
    [["!relayKey || !event || event.pubkey !== relayKey ||", "!event || (relayKey && event.pubkey !== relayKey) ||"]],
  ],
  ["the signature is never checked", RELAY, [UNIT], [["  return signed(event) ? owners[0][1] : undefined;\n", "  return owners[0][1];\n"]]],
  ["any kind counts", RELAY, [UNIT], [[" || event.kind !== KIND_MESSAGE || !Array.isArray(event.tags)", " || !Array.isArray(event.tags)"]]],
  // The stamps.
  ["a workflow with any marker value counts", RELAY, [UNIT], [[' || markers[0][1] !== "true"', ""]]],
  ["two workflow markers count", RELAY, [UNIT], [["markers.length !== 1 ||", "markers.length < 1 ||"]]],
  ["a workflow with no owner counts as the first one", RELAY, [UNIT], [["owners.length !== 1 ||", "owners.length < 1 ||"]]],
  ["an owner that is not a public key counts", RELAY, [UNIT, E2E], [[" || !oneKey(owners[0])", ""]]],
  ["a malformed mention stamp is skipped", RELAY, [UNIT, E2E], [["  if (!mentions.every(oneKey)) return undefined;\n", ""]]],
  ["a mention named twice counts", RELAY, [UNIT], [["named.size !== mentions.length || ", ""]]],
  ["a stamp for any agent counts", RELAY, [UNIT, E2E], [[" || !named.has(watchPubkey)", ""]]],
  // The one rule, in the three places.
  ["the allowlist is asked about the author, not the owner", RELAY, [UNIT], [["return { key: owner ?? event.pubkey, owner };", "return { key: event.pubkey, owner };"]]],
  ["rejectReason asks about the author", RELAY, [UNIT], [["if (!allows(sender.key)) return", "if (!allows(event.pubkey)) return"]]],
  ["a stamp is no mention", RELAY, [UNIT], [[" || sender.owner !== undefined;", ";"]]],
  [
    "the delivery path asks about the author",
    RELAY,
    [E2E],
    [["          if (!this.allows(sender.key)) {\n", "          if (!this.allows(event.pubkey)) {\n"]],
  ],
  [
    "the thread context asks about the author",
    RELAY,
    [UNIT, E2E],
    [["allowlisted: allows(sender.key) === true,", "allowlisted: allows(e.pubkey) === true,"]],
  ],
  ["the thread context never gets the relay's key", RELAY, [E2E], [["          relayKey: this.relayKey,\n          allows: this.allows,\n", "          allows: this.allows,\n"]]],
  ["the thread context never gets this agent's key", RELAY, [E2E], [["          watchPubkey: this.watchPubkey,\n          relayKey: this.relayKey,\n", "          relayKey: this.relayKey,\n"]]],
  // The relay's key is read whatever the room list.
  [
    "the relay's key is read only for room lists and DMs",
    RELAY,
    [E2E],
    [["    if (!this.allRooms && !this.dmAll) this.learnRelayKey();\n", ""]],
  ],
  [
    "the login waits for the relay's key",
    RELAY,
    [E2E],
    [["    if (!this.allRooms && !this.dmAll) this.learnRelayKey();\n", "    if (!this.allRooms && !this.dmAll) await this.ensureRelayKey();\n"]],
  ],
  [
    "a read of the key that failed is never tried again",
    RELAY,
    [E2E],
    [["    if (this.live && !this.allRooms && !this.dmAll) this.learnRelayKey(true);\n", ""]],
  ],
  ["every try to read the key logs", RELAY, [E2E], [["if (!this.relayKey && !quiet) {", "if (!this.relayKey) {"]]],
  [
    "a key that arrives late does not start the catch-up over",
    RELAY,
    [E2E],
    [['asking for the messages since the cursor again");\n        this.subscribe();\n', 'asking for the messages since the cursor again");\n']],
  ],
  ["the catch-up starts over at every start", RELAY, [E2E], [["if (!key || !this.heldBack || !this.live", "if (!key || !this.live"]]],
  ["a held-back message is not noted, so nothing starts over", RELAY, [E2E], [["      this.heldBack = true;\n", ""]]],
  [
    "a key that arrives after a reconnect is ignored",
    RELAY,
    [E2E],
    [
      ["  learnRelayKey(retry = false) {\n", "  learnRelayKey(retry = false) {\n    const ws = this.ws;\n"],
      ["if (!key || !this.heldBack || !this.live || this.ws?.readyState !== OPEN) return;", "if (!key || !this.heldBack || ws !== this.ws || !this.live) return;"],
    ],
  ],
  [
    "the thread context trusts an undefined owner",
    RELAY,
    [UNIT],
    [["(owner !== undefined && agents.includes(owner))", "agents.includes(owner)"]],
  ],
  [
    "rejectReason trusts an undefined owner",
    RELAY,
    [UNIT],
    [["sender.owner !== undefined && (sender.owner === watchPubkey || sender.owner === ownPubkey)", "(sender.owner === watchPubkey || sender.owner === ownPubkey)"]],
  ],
  [
    "a refusal made without the relay's key is kept",
    RELAY,
    [E2E],
    [['if (!this.relayKey && tagsNamed(event, "buzz:workflow-owner").length > 0) {', "if (false) {"]],
  ],
  [
    "the delivery path hides the relay's key from rejectReason",
    RELAY,
    [E2E],
    [["            relayKey: this.relayKey,\n            partners: this.partners,\n", "            partners: this.partners,\n"]],
  ],
  // A workflow the agent owns is its own message.
  [
    "a workflow the agent owns wakes it",
    RELAY,
    [UNIT, E2E],
    [['  if (sender.owner !== undefined && (sender.owner === watchPubkey || sender.owner === ownPubkey)) return "own message";\n', ""]],
  ],
  [
    "a workflow the agent owns does not end the thread context",
    RELAY,
    [UNIT],
    [["    return agents.includes(e.pubkey) || (owner !== undefined && agents.includes(owner));\n", "    return agents.includes(e.pubkey);\n"]],
  ],
  // What is passed on, and what is kept.
  ["the owner is not passed to the format", RELAY, [E2E], [["              workflowOwner: sender.owner,\n", ""]]],
  ["the owner is not in the notification", CHANNEL, [E2E], [["          ...(workflowOwner ? { workflow_owner: workflowOwner } : {}),\n", ""]]],
  ["the owner is not in the thread context", CHANNEL, [E2E], [['    const owner = e.workflowOwner ? ` workflow_owner="${e.workflowOwner}"` : "";\n', '    const owner = "";\n']]],
  ["a refusal is kept under the signer", RELAY, [E2E], [["this.state.refuse(event, this.senderOf(event).key);", "this.state.refuse(event);"]]],
  [
    "a refusal is kept under the signer, in the state",
    STATE,
    [STATE_SUITE],
    [["    this.refused.set(event.id, [event.created_at, sender]);\n    this.pruneRefused(sender);\n", "    this.refused.set(event.id, [event.created_at, event.pubkey]);\n    this.pruneRefused(event.pubkey);\n"]],
  ],
  ["the log does not name the owner", RELAY, [UNIT, E2E], [[", workflow owner ${owner}", ""]]],
];

const ONLY = process.argv[2];
const WANTED = ONLY ? MUTANTS.filter(([name]) => name.includes(ONLY)) : MUTANTS;
if (WANTED.length === 0) {
  console.log(`no break has "${ONLY}" in its name`);
  process.exit(2);
}
const COPY = tempDir("workflow-owner-mutants");
for (const part of ["src", "test", "package.json", "package-lock.json", "buzz-mcp.pin", "node_modules"]) {
  cpSync(join(ADAPTER, part), join(COPY, part), { recursive: true, verbatimSymlinks: true });
}

const count = (s, sub) => s.split(sub).length - 1;
let killed = 0;
const rows = [];
try {
  for (const [name, file, suites, pairs] of WANTED) {
    const path = join(COPY, file);
    const original = readFileSync(path, "utf8");
    const counts = pairs.map(([old]) => count(original, old));
    if (counts.some((n) => n !== 1)) {
      rows.push([name, `NOT APPLIED (${counts.join(",")} matches)`]);
      continue;
    }
    let text = original;
    for (const [old, now] of pairs) text = text.replace(old, () => now);
    writeFileSync(path, text);
    // A break that is not valid JavaScript would be "killed" by the crash alone, and prove nothing.
    if (spawnSync(process.execPath, ["--check", path]).status !== 0) {
      writeFileSync(path, original);
      rows.push([name, "NOT VALID JAVASCRIPT"]);
      continue;
    }
    const r = spawnSync(process.execPath, ["--test", ...suites.map((suite) => join(COPY, suite))], {
      cwd: COPY,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
      timeout: 600_000,
    });
    writeFileSync(path, original);
    const fails = (r.stdout.match(/^ℹ fail (\d+)/m) || r.stdout.match(/^# fail (\d+)/m) || [])[1];
    if (r.status !== 0) {
      killed += 1;
      rows.push([name, `killed (${fails ?? "?"} failing)`]);
    } else {
      rows.push([name, "SURVIVED"]);
    }
  }
} finally {
  rmSync(COPY, { recursive: true, force: true });
}
for (const [name, res] of rows) console.log(`  ${name.padEnd(56)} ${res}`);
console.log(`mutants: ${killed}/${WANTED.length} killed`);
process.exit(killed === WANTED.length ? 0 : 1);
