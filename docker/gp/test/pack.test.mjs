// pack.mjs: the tar a pack is read from (nothing but plain files and folders), the skills in it, and the install into ~/.claude/skills. The bytes arrive as a Response, so the
// hash is checked as it is on the wire; the order service's own routes are in hosted.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { skills, tar } from "./tarball.mjs";

const data = mkdtempSync(join(tmpdir(), "gp-pack-"));
process.env.GP_DATA = data;
const { L } = await import("../layout.mjs");
const { LIMITS, installPack, readTar } = await import("../pack.mjs");
const { readJson } = await import("../files.mjs");
test.after(() => rmSync(data, { recursive: true, force: true }));

const ORIGIN = "https://orders.example.test";
const sha = (b) => createHash("sha256").update(b).digest("hex");
const reset = () => readdirSync(data).forEach((f) => rmSync(join(data, f), { recursive: true, force: true }));
const nothing = () => assert.deepEqual([existsSync(L.skills), existsSync(L.pack), readdirSync(data).filter((f) => f.startsWith("pack-"))], [false, false, []]);
// installPack for these bytes, named by their own hash unless `named` says another, from a fetch that is a Response.
const put = (bytes, { named = sha(bytes), headers = {}, status = 200 } = {}) =>
  installPack({ name: "p.tar.gz", sha256: named, url: `${ORIGIN}/v1/machine/pack?n=p` }, ORIGIN, { fetchImpl: async () => new Response(bytes, { status, headers }) });
const refused = (bytes, why, code = "pack-refused") => assert.rejects(() => put(bytes), (e) => e.code === code && e.message.includes(why), why);
const e = (path, extra = {}) => ({ path, data: "x", ...extra });
const dir = (path) => ({ path, type: "5" });

test("a pack of skill folders is read: plain files and folders, with the paths as they are", () => {
  const entries = readTar(skills("hello-skill", "writer"));
  assert.deepEqual(entries.map((x) => [x.path, x.dir]), [["hello-skill", true], ["hello-skill/SKILL.md", false], ["writer", true], ["writer/SKILL.md", false]]);
  assert.deepEqual(readTar(tar([e("./a/SKILL.md"), e("a/b/" + "x".repeat(90) + ".md")])).map((x) => x.path.slice(0, 12)), ["a/SKILL.md", "a/b/xxxxxxxx"]);
});

test("a tar is refused whole for a link, a device, an extended header, a path out of its folder, a wrong sum, or too much", () => {
  const sizes = { ...LIMITS };
  const bad = [
    ["a symbolic link", [e("a/SKILL.md"), { path: "a/l", type: "2", linkname: "/etc/passwd" }]],
    ["a hard link", [e("a/SKILL.md"), { path: "a/l", type: "1", linkname: "a/SKILL.md" }]],
    ["a character device", [{ path: "a/dev", type: "3" }]],
    ["a block device", [{ path: "a/dev", type: "4" }]],
    ["a fifo", [{ path: "a/fifo", type: "6" }]],
    ["a contiguous file", [e("a/SKILL.md", { type: "7" })]],
    ["a pax header", [{ path: "a/x", type: "x", data: "30 path=a/../../b\n" }]],
    ["a GNU long name", [{ path: "././@LongLink", type: "L", data: "a/b\0" }]],
    ["an absolute path", [e("/etc/cron.d/x")]],
    ["a path that climbs", [e("a/../../x")]],
    ["a path that climbs at the start", [e("../x")]],
    ["a backslash", [e("a\\x")]],
    ["a control character", [e("a/\u0001x")]],
    ["a path twice", [e("a/SKILL.md"), e("a/SKILL.md")]],
    ["a header whose sum is wrong", [e("a/SKILL.md", { badSum: true })]],
    ["a path too deep", [e("a/b/c/d/e/f/g/h/i")]],
    ["a file that is also a folder", [e("a/SKILL.md"), e("a/SKILL.md/y")]],
    ["a folder after a file of its name", [e("a"), e("a/SKILL.md")]],
  ];
  for (const [what, entries] of bad) assert.throws(() => readTar(tar(entries)), (x) => x.code === "pack-refused", what);
  assert.throws(() => readTar(Buffer.from("not gzip")), { code: "pack-refused" });
  assert.throws(() => readTar(tar([e("a/SKILL.md")], { gz: false })), { code: "pack-refused" }, "a tar that is not gzip'd");
  const whole = tar([e("a/SKILL.md", { data: "y".repeat(2000) })], { gz: false });
  // Each is refused for its own reason, so that one guard standing in for another does not hide a guard that is gone.
  for (const [what, cut, why] of [["inside a file", whole.subarray(0, 700), /ends inside a file/], ["inside a header", whole.subarray(0, 100), /end marker/], ["at a block's end", whole.subarray(0, whole.length - 1024), /end marker/]]) {
    assert.throws(() => readTar(gzipSync(cut)), { code: "pack-refused", message: why }, `an archive cut short ${what}`);
  }
  const lies = [
    ["a size larger than the data that follows", tar([e("a/SKILL.md", { data: "y".repeat(10), declare: 5000 })]), /ends inside a file/],
    ["a size smaller than the data, so the rest is read as a header", tar([e("a/SKILL.md", { data: "y".repeat(900), declare: 3 })]), /checksum/],
    ["a size that is not a number", tar([e("a/SKILL.md", { declare: "zz" })]), /size is not allowed/],
  ];
  for (const [what, bytes, why] of lies) assert.throws(() => readTar(bytes), { code: "pack-refused", message: why }, what);
  const flipped = Buffer.from(skills("a", "b"));
  flipped[Math.floor(flipped.length / 2)] ^= 0xff;
  assert.throws(() => readTar(flipped), { code: "pack-refused" }, "a gzip stream with a byte changed");
  const bomb = tar([e("a/SKILL.md", { data: Buffer.alloc(3 * 2 ** 20) })]);
  assert.ok(bomb.length < 10_000, "the bomb is small as sent");
  LIMITS.unpacked = 2 ** 20;
  try {
    assert.throws(() => readTar(bomb), { code: "pack-refused", message: /unpacks to more than the limit/ }, "a gzip bomb is stopped while it unpacks, not after");
  } finally {
    LIMITS.unpacked = sizes.unpacked;
  }
  try {
    LIMITS.file = 4;
    assert.throws(() => readTar(tar([e("a/SKILL.md", { data: "12345" })])), { code: "pack-refused" }, "a file over the limit");
    LIMITS.file = sizes.file;
    LIMITS.files = 1;
    assert.throws(() => readTar(tar([e("a/SKILL.md"), e("a/b.md")])), { code: "pack-refused" }, "more files than the limit");
    LIMITS.files = sizes.files;
    LIMITS.unpacked = 600;
    assert.throws(() => readTar(tar([e("a/SKILL.md", { data: "z".repeat(400) }), e("a/b.md", { data: "z".repeat(400) })])), { code: "pack-refused" }, "more bytes than the limit");
  } finally {
    Object.assign(LIMITS, sizes);
  }
});

test("a pack is folders with a SKILL.md each, named in plain lower case", async () => {
  reset();
  await refused(tar([e("README.md")]), "a file is at the top");
  await refused(tar([dir("a"), e("a/other.md")]), "has no SKILL.md");
  await refused(tar([e("Hello/SKILL.md")]), "folder name");
  await refused(tar([e(".hidden/SKILL.md")]), "folder name");
  await refused(tar([]), "no skill");
  nothing();
});

test("the bytes are held to the hash before anything is read", async () => {
  reset();
  const ok = skills("a");
  await assert.rejects(() => put(ok, { named: "22".repeat(32) }), { code: "pack-checksum" });
  await assert.rejects(() => put(ok, { headers: { "x-content-sha256": "33".repeat(32) } }), { code: "pack-refused" });
  await assert.rejects(() => put(ok, { status: 404 }), { code: "pack-unreachable" });
  await assert.rejects(() => installPack({ name: "p", sha256: sha(ok), url: "https://elsewhere.example.test/p" }, ORIGIN, { fetchImpl: async () => new Response(ok) }), { code: "pack-refused" });
  await assert.rejects(() => installPack({ name: "p", sha256: "zz" }, ORIGIN), { code: "pack-refused" });
  const size = LIMITS.download;
  LIMITS.download = 10;
  try {
    await assert.rejects(() => put(ok), { code: "pack-refused" });
  } finally {
    LIMITS.download = size;
  }
  nothing();
});

test("the skills are put in ~/.claude/skills as files, once, and a new pack replaces the old pack's skills and no others", async () => {
  reset();
  mkdirSync(join(L.skills, "mine"), { recursive: true });
  writeFileSync(join(L.skills, "mine", "SKILL.md"), "the owner's own");
  const one = skills("a", "b");
  assert.equal(await put(one), "installed");
  assert.deepEqual(readJson(L.pack).skills, ["a", "b"]);
  assert.match(readFileSync(join(L.skills, "a", "SKILL.md"), "utf8"), /name: a/);
  assert.equal(await put(one), "current");
  assert.equal(await installPack({ name: "p", sha256: sha(one), url: `${ORIGIN}/x` }, ORIGIN, { fetchImpl: async () => Promise.reject(new Error("no fetch for a pack that is current")) }), "current");
  const two = skills("b", "c");
  assert.equal(await put(two), "installed");
  assert.deepEqual([existsSync(join(L.skills, "a")), existsSync(join(L.skills, "b", "SKILL.md")), existsSync(join(L.skills, "c", "SKILL.md"))], [false, true, true]);
  assert.equal(readFileSync(join(L.skills, "mine", "SKILL.md"), "utf8"), "the owner's own", "a skill that is not the pack's is left alone");
  assert.deepEqual(readJson(L.pack).skills, ["b", "c"]);
  assert.deepEqual(readdirSync(dirname(L.skills)).filter((f) => f.startsWith("pack-")), [], "no staging folder is left");
});

test("a pack that would replace a skill of the owner's own is refused, and that skill is untouched", async () => {
  reset();
  mkdirSync(join(L.skills, "a"), { recursive: true });
  writeFileSync(join(L.skills, "a", "SKILL.md"), "the owner's own");
  await refused(skills("a", "b"), "already there");
  assert.deepEqual([readFileSync(join(L.skills, "a", "SKILL.md"), "utf8"), existsSync(join(L.skills, "b")), existsSync(L.pack)], ["the owner's own", false, false]);
});

const files = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? files(join(dir, x.name)) : [join(dir, x.name)])) : []);
const snapshot = () => Object.fromEntries(files(data).map((f) => [f, readFileSync(f).toString("latin1")]));

test("nothing is written outside the pack's folders", async () => {
  reset();
  const canary = join(data, "outside");
  writeFileSync(canary, "untouched");
  const traps = [
    ["a path that climbs out", tar([e("a/SKILL.md"), e("a/../../outside")])],
    ["a path that climbs at once", tar([e("../outside"), e("a/SKILL.md")])],
    ["an absolute path", tar([e("a/SKILL.md"), e(canary)])],
    ["a symbolic link, then a file through it", tar([e("a/SKILL.md"), { path: "a/l", type: "2", linkname: data }, e("a/l/outside")])],
    ["a hard link to a file outside", tar([e("a/SKILL.md"), { path: "a/h", type: "1", linkname: canary }])],
    ["a device", tar([e("a/SKILL.md"), { path: "a/d", type: "3" }])],
  ];
  for (const [what, bytes] of traps) await assert.rejects(() => put(bytes), { code: "pack-refused" }, what);
  assert.deepEqual(files(data), [canary], "no file was made, and the one that was there is as it was");
  assert.equal(readFileSync(canary, "utf8"), "untouched");
  assert.equal(await put(skills("a", "b")), "installed");
  const made = files(data).filter((f) => f !== canary);
  assert.deepEqual(made.filter((f) => !f.startsWith(`${L.skills}/a/`) && !f.startsWith(`${L.skills}/b/`) && f !== L.pack), [], "every file is in a skill's folder, or is the record");
});

test("a link where a skill goes is the owner's own, whether it leads anywhere or not, and is never followed", async () => {
  for (const [what, target] of [["a link to nothing", "gone"], ["a link to a folder", ""]]) {
    reset();
    const outside = join(data, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep"), "mine");
    mkdirSync(L.skills, { recursive: true });
    symlinkSync(join(outside, target), join(L.skills, "a"));
    await assert.rejects(() => put(skills("a")), { code: "pack-refused", message: /already there/ }, what);
    assert.deepEqual([lstatSync(join(L.skills, "a")).isSymbolicLink(), readFileSync(join(outside, "keep"), "utf8"), readdirSync(outside)], [true, "mine", ["keep"]], what);
  }
});

test("a pack that is refused leaves the installed one exactly as it was", async () => {
  reset();
  assert.equal(await put(skills("a", "b")), "installed");
  const before = snapshot();
  mkdirSync(join(L.skills, "mine"), { recursive: true });
  writeFileSync(join(L.skills, "mine", "SKILL.md"), "the owner's own");
  const kept = { ...before, [join(L.skills, "mine", "SKILL.md")]: "the owner's own" };
  const next = skills("b", "c");
  for (const [what, run] of [
    ["a hash that is not the bytes'", () => put(next, { named: "44".repeat(32) })],
    ["a header naming another hash", () => put(next, { headers: { "x-content-sha256": "55".repeat(32) } })],
    ["a service that answers 500", () => put(next, { status: 500 })],
    ["a pack with a link in it", () => put(tar([e("b/SKILL.md"), { path: "b/l", type: "2", linkname: "/etc" }]))],
    ["a pack cut short", () => put(gzipSync(tar([e("b/SKILL.md")], { gz: false }).subarray(0, 1024)))],
    ["a pack with no SKILL.md", () => put(tar([e("c/readme.md")]))],
    ["a pack that would replace the owner's skill", () => put(skills("mine", "c"))],
  ]) {
    await assert.rejects(run, (x) => x.code.startsWith("pack-"), what);
    assert.deepEqual(snapshot(), kept, what);
  }
});

// A pack made by GNU tar 1.35, as the first test pack was: `tar --format=gnu --owner=0 --group=0 --numeric-owner --mtime=@0 -cf - hello-skill | gzip -n -9`. Its magic is GNU's, not POSIX's.
const GNU_PACK = Buffer.from(
  "H4sIAAAAAAACA+3SPQ6CMBiA4c49RS9QBKSQcAMjGydohAQiP4biwO1FWQjGER18n+Xrl3Z7W5VN" +
  "02t3rZvmIHbizxJjXnO2ne/nwA/CSCgjvuDuRjsoJf5Uteqfn09Z5rXFHv3jKPrcPzGb/sExjIXy" +
  "6b87rbXsbFumavUTZFG6y1DfxrrvUuXs5JZb+Xyd22nZPCkAAAAAAAAAAAAAAAAA/NIDXu6wdwAo" +
  "AAA=",
  "base64",
);

test("a pack made by GNU tar, whose magic is not POSIX ustar's, is read and installed", async () => {
  reset();
  assert.equal(gunzipSync(GNU_PACK).subarray(257, 265).toString("latin1"), "ustar  \0", "the fixture is in GNU's format");
  assert.deepEqual(readTar(GNU_PACK).map((x) => [x.path, x.dir]), [["hello-skill", true], ["hello-skill/SKILL.md", false]]);
  assert.equal(await put(GNU_PACK), "installed");
  assert.match(readFileSync(join(L.skills, "hello-skill", "SKILL.md"), "utf8"), /^---\nname: hello-skill/);
});

test("a ustar prefix is joined to the name and checked with it, and a GNU header's prefix bytes are not a prefix", () => {
  const prefixed = (prefix, name = "x") => tar([e(name, { prefix })]);
  assert.deepEqual(readTar(prefixed("a/b", "SKILL.md")).map((x) => x.path), ["a/b/SKILL.md"]);
  for (const [what, prefix] of [["a prefix that climbs", "../.."], ["a prefix that climbs inside", "a/../.."], ["an absolute prefix", "/etc"], ["a prefix with a control character", "a/\u0001b"], ["a prefix that makes it too deep", "a/b/c/d/e/f/g/h"]]) {
    assert.throws(() => readTar(prefixed(prefix)), { code: "pack-refused", message: /path is absolute, climbs/ }, what);
  }
  const gnu = tar([e("a/SKILL.md", { prefix: "../..", magic: "ustar  \0" })]);
  assert.deepEqual(readTar(gnu).map((x) => x.path), ["a/SKILL.md"], "in GNU's header those bytes are other things, and are not read as a path");
});
