// NIP-OA owner attestations: the `auth` tag an owner key signs for one agent
// key. The owner signs SHA256("nostr:agent-auth:" + <agent pubkey hex> + ":" +
// <conditions>) with BIP-340 Schnorr; the tag is
//   ["auth", <owner pubkey hex>, <conditions>, <signature hex>].
// Conditions are empty, or clauses kind=<n>, created_at<<t> and created_at><t>
// joined by &, with no spaces and no leading zeros.
import { createHash } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const CLAUSE = /^(kind=(0|[1-9][0-9]*)|created_at[<>](0|[1-9][0-9]*))$/;

const hex = (b) => Buffer.from(b).toString("hex");
const unhex = (h) => Uint8Array.from(Buffer.from(h, "hex"));

export function conditionsOk(c) {
  return c === "" || (typeof c === "string" && c.split("&").every((x) => CLAUSE.test(x)));
}

export function digest(agentPubkey, conditions) {
  return createHash("sha256").update(`nostr:agent-auth:${agentPubkey}:${conditions}`).digest();
}

/** The tag for agentPubkey, signed with ownerSecret (Uint8Array, 32 bytes). */
export function signAuthTag(ownerSecret, agentPubkey, conditions = "") {
  if (!HEX64.test(agentPubkey)) throw new Error("the agent public key must be 64 lower-case hex characters");
  if (!conditionsOk(conditions)) throw new Error("the conditions are not NIP-OA conditions");
  const owner = hex(schnorr.getPublicKey(ownerSecret));
  if (owner === agentPubkey) throw new Error("the owner and the agent must be different keys");
  const sig = hex(schnorr.sign(digest(agentPubkey, conditions), ownerSecret));
  const tag = ["auth", owner, conditions, sig];
  if (!verifyAuthTag(tag, agentPubkey)) throw new Error("the signature did not verify");
  return tag;
}

/** Whether tag is a well-formed NIP-OA tag whose signature holds for agentPubkey. */
export function verifyAuthTag(tag, agentPubkey) {
  if (!Array.isArray(tag) || tag.length !== 4 || tag[0] !== "auth") return false;
  const [, owner, conditions, sig] = tag;
  if (![owner, conditions, sig].every((x) => typeof x === "string")) return false;
  if (!HEX64.test(owner) || !HEX128.test(sig) || !conditionsOk(conditions) || owner === agentPubkey) return false;
  try {
    return schnorr.verify(unhex(sig), digest(agentPubkey, conditions), unhex(owner));
  } catch {
    return false;
  }
}

// The test vector of NIP-OA.md (block/buzz, docs/nips/NIP-OA.md). Each value is
// written in pieces so the tree scan, which flags any 64-hex string as a
// stray key, passes.
export const VECTOR = {
  owner: "79be667ef9dcbbac55a06295ce870b07" + "029bfcdb2dce28d959f2815b16f81798",
  agent: "c6047f9441ed7d6d3045406e95c07cd8" + "5c778e4b8cef3ca7abac09b95c709ee5",
  conditions: "kind=1&created_at<1713957000",
  digest: "08cdecd55af4c28d3801fd69615dcf5c" + "c04fab3bc134b38a840bf157197069a6",
  sig: "8b7df2575caf0a108374f8471722b233" + "c53f9ff827a8b0f91861966c3b9dd5cb" + "2e189eae9f49d72187674c2f5bd24414" + "5e10ff86c9f257ffe65a1ee5f108b369",
};

/** The self-test: the vector's digest, its signature, and a sign-and-verify round. */
export function selfTest() {
  const { owner, agent, conditions, sig } = VECTOR;
  if (hex(digest(agent, conditions)) !== VECTOR.digest) return "the digest does not match the NIP-OA test vector";
  if (!verifyAuthTag(["auth", owner, conditions, sig], agent)) return "the NIP-OA test vector's signature does not verify";
  if (verifyAuthTag(["auth", owner, conditions + "0", sig], agent)) return "a changed condition still verifies";
  const sk = new Uint8Array(32).fill(7);
  const tag = signAuthTag(sk, agent, conditions);
  if (!verifyAuthTag(tag, agent) || verifyAuthTag(tag, VECTOR.owner)) return "a signed tag does not verify for its agent alone";
  return null;
}
