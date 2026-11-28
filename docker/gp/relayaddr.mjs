// A hosted agent's relay is refused when it resolves to a private, loopback or link-local address (and the other ranges that are not the public internet's). Every address the name
// resolves to is checked, a name that does not resolve is refused, and an IPv4 address inside an IPv6 one is judged as IPv4. The programs that connect resolve the name again, so
// hosted.mjs also takes a relay over TLS only: another address than the checked one is then reached only with a certificate for the relay's name.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { GpError } from "./out.mjs";

const V4 = [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]];
const v4num = (a) => a.split(".").reduce((n, x) => n * 256 + Number(x), 0);
const inV4 = (n) => V4.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(v4num(base) / 2 ** (32 - bits)));

// The 16 bytes of an IPv6 address (a dotted IPv4 tail allowed), or null.
function v6bytes(text) {
  let t = text.split("%")[0].toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(t);
  if (dotted) {
    if (isIP(dotted[1]) !== 4) return null;
    const n = v4num(dotted[1]);
    t = t.slice(0, dotted.index) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = t.split("::");
  if (halves.length > 2) return null;
  const part = (h) => (h === "" ? [] : h.split(":"));
  const [head, tail] = [part(halves[0]), part(halves[1] ?? "")];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 1 ? gap !== 0 : gap < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? gap : 0).fill("0"), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]);
}

/** Whether an IP address (text) is one the relay must not have: private, loopback, link-local and the other ranges that are not the public internet's. */
export function nonPublic(ip) {
  if (isIP(ip) === 4) return inV4(v4num(ip));
  const b = isIP(ip) === 6 ? v6bytes(ip) : null;
  if (b === null) return true;
  const embedded = (at) => b.slice(at, at + 4).join(".");
  if (b.slice(0, 15).every((x) => x === 0) && b[15] <= 1) return true;
  if (b.slice(0, 10).every((x) => x === 0) && b[10] === 255 && b[11] === 255) return inV4(v4num(embedded(12)));
  if (b.slice(0, 12).every((x) => x === 0)) return inV4(v4num(embedded(12)));
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) return inV4(v4num(embedded(12)));
  if (b[0] === 0x20 && b[1] === 0x02) return inV4(v4num(embedded(2)));
  return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) >= 0x80) || b[0] === 0xff;
}

/** Throws relay-private unless every address of the relay's host is public. `lookup` is dns.lookup's promise form, for a test to replace. */
export async function refusePrivateRelay(relayUrl, { lookup = dnsLookup } = {}) {
  const refuse = (why) => new GpError("relay-private", `the relay ${why}: a hosted agent only connects to a relay on the public internet`);
  let host;
  try {
    host = new URL(relayUrl).hostname.replace(/^\[|\]$/g, "");
  } catch {
    throw refuse("is not an address");
  }
  let addresses;
  try {
    // Safe against a name that answers differently at connect time: hosted.mjs takes a relay over TLS only, so another address than this one is reached only with a certificate for the relay's name.
    addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true, verbatim: true });
  } catch {
    throw refuse("does not resolve");
  }
  if (!addresses.length) throw refuse("does not resolve");
  if (addresses.some((a) => nonPublic(a.address))) throw refuse("resolves to a private, loopback or link-local address");
  return addresses.map((a) => a.address);
}
