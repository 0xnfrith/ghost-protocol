// gp attest <agent-pubkey>: the owner's NIP-OA tag for one agent key.
//
//   gp attest <agent-pubkey> [--key-file <file>] [--conditions <c> | --expires-in <n>s|m|h|d] [--relay <url>]
//   gp attest --self-test
//
// The owner's secret key (64 hex or nsec1) is read from --key-file, or from
// stdin when there is no --key-file or it is -, never from the command line.
// It is never printed. Before it signs, it checks itself against the NIP-OA
// test vector. It prints:
//   GP_INTERFACE=1
//   GP_SELF_TEST=passed
//   GP_OWNER_PUBKEY=<64 hex>
//   GP_AUTH_TAG=["auth","<owner>","<conditions>","<signature>"]
//   GP_RELAY_OWNER=connected|refused-not-member|unreachable   with --relay
// --relay logs in to the relay once as the owner. The relay admits an agent by
// its tag only when the owner is a relay member, so refused-not-member there
// means the relay will refuse the tag too; unreachable means no answer.
// Conditions: none by default (the tag never expires, as Buzz's own app signs
// it); --expires-in bounds it with created_at<(now + n).
import { readFileSync } from "node:fs";
import { GpError } from "./out.mjs";
import { selfTest, signAuthTag, conditionsOk } from "./nipoa.mjs";
import { relayCheck } from "./relaycheck.mjs";
import { adapter } from "./paths.mjs";

const UNITS = { s: 1, m: 60, h: 3600, d: 86400 };

export function parseAttestArgs(argv) {
  const o = { agent: null, keyFile: null, conditions: null, expiresIn: null, relay: null, selfTest: false };
  const need = (i, flag) => {
    if (i + 1 >= argv.length) throw new GpError("usage", `${flag} needs a value`, 2);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--self-test") o.selfTest = true;
    else if (a === "--key-file") o.keyFile = need(i++, a);
    else if (a === "--conditions") o.conditions = need(i++, a);
    else if (a === "--expires-in") o.expiresIn = need(i++, a);
    else if (a === "--relay") o.relay = need(i++, a);
    else if (a.startsWith("-")) throw new GpError("usage", `unknown option ${a.split("=")[0]} (the owner key is read from --key-file or stdin, never from the command line)`, 2);
    else if (o.agent === null) o.agent = a;
    else throw new GpError("usage", "one agent public key only (the owner key is read from --key-file or stdin, never from the command line)", 2);
  }
  if (o.selfTest) return o;
  if (!o.agent) throw new GpError("usage", "usage: gp attest <agent-pubkey> [--key-file <file>] [--expires-in <n>s|m|h|d | --conditions <c>] [--relay <url>]", 2);
  if (o.conditions !== null && o.expiresIn !== null) throw new GpError("usage", "--conditions and --expires-in go one at a time", 2);
  if (o.conditions !== null && !conditionsOk(o.conditions)) throw new GpError("bad-conditions", "the conditions must be NIP-OA clauses (kind=<n>, created_at<<t>, created_at><t>) joined by &", 2);
  if (o.expiresIn !== null && !/^[1-9][0-9]*[smhd]$/.test(o.expiresIn)) throw new GpError("usage", "--expires-in takes a number and a unit, such as 2h or 30d", 2);
  return o;
}

export async function attest(argv, out, { stdin = 0, now = () => Date.now() } = {}) {
  const o = parseAttestArgs(argv);
  out.header();
  const problem = selfTest();
  if (problem) throw new GpError("self-test-failed", problem);
  out.kv("SELF_TEST", "passed");
  if (o.selfTest) return 0;

  const { parseSecretKey, parsePublicKey, publicKeyOf, relaySocketUrl } = await import(adapter("src/config.mjs"));
  let agent;
  try {
    agent = parsePublicKey(o.agent, "the agent public key");
  } catch {
    throw new GpError("bad-agent-pubkey", "the agent public key must be 64 hex characters or npub1");
  }
  let raw;
  if (o.keyFile === null || o.keyFile === "-") {
    if (stdin === 0 && process.stdin.isTTY) throw new GpError("owner-key-unreadable", "give the owner key on stdin or with --key-file <file>; it is never read from the command line");
    try {
      raw = readFileSync(stdin, "utf8");
    } catch {
      throw new GpError("owner-key-unreadable", "could not read the owner key from stdin");
    }
  } else {
    try {
      raw = readFileSync(o.keyFile, "utf8");
    } catch {
      throw new GpError("owner-key-unreadable", "could not read the owner key file");
    }
  }
  let secret;
  try {
    secret = parseSecretKey(raw);
  } catch {
    throw new GpError("bad-owner-key", "the owner key must be 64 hex characters or nsec1");
  } finally {
    raw = undefined;
  }
  let conditions = o.conditions ?? "";
  if (o.expiresIn !== null) {
    const n = Number(o.expiresIn.slice(0, -1)) * UNITS[o.expiresIn.slice(-1)];
    conditions = `created_at<${Math.floor(now() / 1000) + n}`;
  }
  let tag;
  try {
    tag = signAuthTag(secret, agent, conditions);
  } catch (err) {
    throw new GpError("attest-failed", err.message);
  }
  out.kv("OWNER_PUBKEY", publicKeyOf(secret));
  out.kv("AUTH_TAG", JSON.stringify(tag));
  if (o.relay !== null) {
    let url;
    try {
      url = relaySocketUrl(o.relay);
    } catch {
      secret.fill(0);
      throw new GpError("bad-relay-url", "the relay address must start with https://, http://, wss:// or ws://");
    }
    const r = await relayCheck({ url, secret });
    out.kv("RELAY_OWNER", r.relay);
    if (r.relay === "refused-not-member") out.log("the relay refused the owner's login: the owner is not a relay member there, so the relay will refuse this tag too");
    if (r.relay === "unreachable") out.log(`the relay did not answer (${r.detail})`);
  }
  secret.fill(0);
  return 0;
}
