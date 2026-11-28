// relayaddr.mjs: which addresses a hosted agent's relay may resolve to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nonPublic, refusePrivateRelay } from "../relayaddr.mjs";

test("ranges that are not the public internet's are refused, an IPv4 address inside an IPv6 one as itself", () => {
  const refused = ["0.0.0.0", "10.0.0.1", "10.255.255.255", "100.64.0.1", "127.0.0.1", "127.9.9.9", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.1", "192.168.0.1", "198.18.0.1", "224.0.0.1", "255.255.255.255",
    "::", "::1", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b::a00:1", "2002:7f00:1::", "not an address", "1.2.3", "::g"];
  for (const ip of refused) assert.equal(nonPublic(ip), true, ip);
  const public_ = ["1.1.1.1", "8.8.8.8", "93.184.216.34", "172.15.255.255", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.0.1", "192.0.1.1", "198.17.0.1", "198.20.0.1", "223.255.255.255", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "fec0::1".replace("fec0", "2fec")];
  for (const ip of public_) assert.equal(nonPublic(ip), false, ip);
});

test("every address a name resolves to is checked, and a name that does not resolve is refused", async () => {
  const lookup = (answers) => async () => (answers instanceof Error ? Promise.reject(answers) : answers);
  assert.deepEqual(await refusePrivateRelay("wss://relay.example.test", { lookup: lookup([{ address: "93.184.216.34" }, { address: "2606:4700:4700::1111" }]) }), ["93.184.216.34", "2606:4700:4700::1111"]);
  assert.deepEqual(await refusePrivateRelay("wss://93.184.216.34:443/x"), ["93.184.216.34"], "an address as it is, with no lookup");
  for (const [what, url, answers] of [["one private of two", "wss://r.example.test", [{ address: "93.184.216.34" }, { address: "fd00::1" }]], ["no answer", "wss://r.example.test", []], ["no such name", "wss://r.example.test", new Error("ENOTFOUND")],
    ["not an address", "relay", [{ address: "93.184.216.34" }]], ["a literal", "ws://[::1]:3000", []], ["a decimal host", "ws://2130706433", []], ["an octal host", "ws://0177.0.0.1", []]]) {
    await assert.rejects(() => refusePrivateRelay(url, { lookup: lookup(answers) }), (e) => e.code === "relay-private", what);
  }
});
