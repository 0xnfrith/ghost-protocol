// One NIP-42 login to a relay, to tell its answer apart:
//   connected           the relay accepted the login (or asked for none)
//   refused-not-member  the relay refused it ("restricted: not a relay member",
//                       or any other refusal of the login)
//   unreachable         no connection, or no answer in time
// The login is signed with the given secret key and carries the owner's NIP-OA
// tag when one is given. With no event it sends nothing else and reads nothing
// else.
//
// With an event (already signed), it sends that event once the login is
// accepted (or at once on a relay that asks for none) and waits for the
// relay's OK for it: the answer then also has sent (true or false) and, on a
// refusal, the relay's reason in detail. A relay that asks for no login at
// first but refuses the event with "auth-required:" gets the login when it
// sends its challenge, and the event once more.
import { finalizeEvent } from "nostr-tools/pure";

export async function relayCheck({ url, secret, tag, event, timeoutMs = 10000, quietMs = 3000, WebSocketImpl = globalThis.WebSocket }) {
  return await new Promise((resolve) => {
    let ws;
    let done = false;
    let quiet;
    const finish = (relay, detail = "", sent) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(quiet);
      try {
        ws.close();
      } catch {
        // already closed
      }
      const r = { relay, detail: String(detail).slice(0, 200) };
      if (event) r.sent = sent === true;
      resolve(r);
    };
    const timer = setTimeout(() => finish("unreachable", "no answer in time"), timeoutMs);
    try {
      ws = new WebSocketImpl(url);
    } catch (err) {
      finish("unreachable", err?.message ?? "could not connect");
      return;
    }
    let authId = null;
    let loggedIn = false;
    let resent = false;
    const send = () => ws.send(JSON.stringify(["EVENT", event]));
    const open = (detail) => {
      loggedIn = true;
      if (event) send();
      else finish("connected", detail);
    };
    ws.onopen = () => {
      // A relay that asks for no login within quietMs is open.
      quiet = setTimeout(() => open("the relay asked for no login"), quietMs);
    };
    ws.onerror = (e) => finish("unreachable", e?.message ?? "connection error");
    ws.onclose = () => finish("unreachable", "the relay closed the connection");
    ws.onmessage = (m) => {
      let msg;
      try {
        msg = JSON.parse(typeof m.data === "string" ? m.data : Buffer.from(m.data).toString("utf8"));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      if (msg[0] === "AUTH" && typeof msg[1] === "string" && authId === null) {
        clearTimeout(quiet);
        const tags = [["relay", url], ["challenge", msg[1]]];
        if (tag) tags.push(tag);
        const ev = finalizeEvent({ kind: 22242, created_at: Math.floor(Date.now() / 1000), tags, content: "" }, secret);
        authId = ev.id;
        ws.send(JSON.stringify(["AUTH", ev]));
      } else if (msg[0] === "OK" && msg[1] === authId) {
        if (msg[2] !== true) finish("refused-not-member", msg[3] ?? "");
        else if (event && !resent && loggedIn) {
          resent = true;
          send();
        } else open(msg[3] ?? "");
      } else if (event && msg[0] === "OK" && msg[1] === event.id) {
        const why = String(msg[3] ?? "");
        if (msg[2] === true) finish("connected", why, true);
        else if (/^auth-required:/.test(why) && authId === null) {
          // the login follows the relay's challenge, then the event once more
        } else finish("connected", why, false);
      }
    };
  });
}
