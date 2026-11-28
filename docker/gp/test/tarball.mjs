// A gzip'd tar from a list of entries, for the pack's tests: ustar headers with a right checksum, and the wrong ones a test asks for (a link, a device, a long-name header, a bad sum, a size that is not the data's: `declare`, a `prefix` of its own).
import { gzipSync } from "node:zlib";

const field = (b, at, text, len) => b.write(text.slice(0, len), at, "utf8");
const octal = (n, len) => n.toString(8).padStart(len - 1, "0") + "\0";

export function header({ path, data = Buffer.alloc(0), type = "0", linkname = "", magic = "ustar\0" + "00", badSum = false, declare = null, prefix: given = null }) {
  const h = Buffer.alloc(512);
  let [name, prefix] = [path, ""];
  if (given !== null) prefix = given;
  else if (Buffer.byteLength(path) > 100) [prefix, name] = [path.slice(0, path.lastIndexOf("/", 150)), path.slice(path.lastIndexOf("/", 150) + 1)];
  field(h, 0, name, 100);
  field(h, 100, octal(type === "5" ? 0o755 : 0o644, 8), 8);
  field(h, 108, octal(0, 8), 8);
  field(h, 116, octal(0, 8), 8);
  field(h, 124, octal(type === "5" ? 0 : (declare ?? data.length), 12), 12);
  field(h, 136, octal(0, 12), 12);
  h.fill(32, 148, 156);
  h[156] = type.charCodeAt(0);
  field(h, 157, linkname, 100);
  field(h, 257, magic, 8);
  field(h, 345, prefix, 155);
  const sum = h.reduce((n, x) => n + x, 0);
  field(h, 148, badSum ? "0000001\0" : octal(sum, 7) + " ", 8);
  return h;
}

export function tar(entries, { gz = true } = {}) {
  const parts = [];
  for (const e of entries) {
    const data = typeof e.data === "string" ? Buffer.from(e.data) : (e.data ?? Buffer.alloc(0));
    parts.push(header({ ...e, data }));
    if (data.length && e.type !== "5") parts.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  const raw = Buffer.concat(parts);
  return gz ? gzipSync(raw) : raw;
}

// A pack of skills: each name a folder with a SKILL.md.
export const skills = (...names) => tar(names.flatMap((n) => [{ path: `${n}/`, type: "5" }, { path: `${n}/SKILL.md`, data: `---\nname: ${n}\ndescription: a skill for a test\n---\nSay ok.\n` }]));
