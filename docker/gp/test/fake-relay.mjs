// A tiny WebSocket relay for the tests, on node:http alone (text frames only).
// mode: "accept" | "refuse" | "silent" (asks for no login) | "mute" (never answers the login)
//   | "late" (asks for no login at first, refuses an event with "auth-required:",
//     then sends its challenge) | "no-events" (takes the login, refuses every event)
// An EVENT is answered with OK: true after an accepted login (or with no login
// in "silent").
import { createServer } from "node:http";
import { createHash } from "node:crypto";

function frame(text) {
  const p = Buffer.from(text);
  const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([head, p]);
}

function* frames(buf) {
  let i = 0;
  while (i + 2 <= buf.length) {
    let len = buf[i + 1] & 127;
    let o = i + 2;
    if (len === 126) {
      len = buf.readUInt16BE(o);
      o += 2;
    } else if (len === 127) {
      len = Number(buf.readBigUInt64BE(o));
      o += 8;
    }
    const mask = buf.subarray(o, o + 4);
    o += 4;
    if (o + len > buf.length) return;
    const data = Buffer.from(buf.subarray(o, o + len)).map((b, k) => b ^ mask[k % 4]);
    yield { op: buf[i] & 15, text: data.toString("utf8"), end: o + len };
    i = o + len;
  }
}

export async function startFakeRelay(mode) {
  const seen = [];
  const server = createServer();
  server.on("upgrade", (req, sock) => {
    const accept = createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    if (mode !== "silent" && mode !== "late") sock.write(frame(JSON.stringify(["AUTH", "challenge-1"])));
    let authed = false;
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      let used = 0;
      for (const f of frames(buf)) {
        used = f.end;
        if (f.op === 8) return sock.end();
        if (f.op !== 1) continue;
        const msg = JSON.parse(f.text);
        seen.push(msg);
        if (msg[0] === "AUTH" && mode !== "mute") {
          const ok = mode !== "refuse";
          authed = ok;
          sock.write(frame(JSON.stringify(["OK", msg[1].id, ok, ok ? "" : "restricted: not a relay member"])));
        } else if (msg[0] === "EVENT") {
          if (mode === "late" && !authed) {
            sock.write(frame(JSON.stringify(["OK", msg[1].id, false, "auth-required: log in first"])));
            sock.write(frame(JSON.stringify(["AUTH", "challenge-2"])));
          } else {
            const ok = mode !== "no-events" && (authed || mode === "silent");
            sock.write(frame(JSON.stringify(["OK", msg[1].id, ok, ok ? "" : "blocked: not allowed"])));
          }
        }
      }
      buf = buf.subarray(used);
    });
    sock.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${server.address().port}`;
  return { url, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
