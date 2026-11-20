import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import http from "node:http";

const data = mkdtempSync(join(tmpdir(), "gp-update-"));
process.env.GP_DATA = data;
process.env.GP_IMAGE_VERSION = "1.0.0";
const { L } = await import("../layout.mjs");
const { readJson, writeJson } = await import("../setup.mjs");
const { update, finish } = await import("../update.mjs");
const { Helper, parseRef, gpLines, recreateConfig } = await import("../updater.mjs");
const { docker, demux } = await import("../dockerapi.mjs");
mkdirSync(join(data, ".gp"), { recursive: true });
test.after(() => rmSync(data, { recursive: true, force: true }));
const DIGEST = "sha256:" + "5e".repeat(32);
const PIN = `ghcr.io/0xnfrith/ghost-protocol:1.1.0@${DIGEST}`;

function capture() {
  const c = { out: "" };
  c.o = { header: () => { if (!c.out) c.out = "GP_INTERFACE=1\n"; }, kv: (k, v) => (c.out += `GP_${k}=${v}\n`), log: () => {}, raw: (x) => (c.out += x), error: () => {} };
  c.kv = (k) => c.out.match(new RegExp(`^GP_${k}=(.*)$`, "m"))?.[1];
  return c;
}
const gp = async (argv, opts) => {
  const c = capture();
  try {
    c.rc = await update(argv, c.o, opts);
  } catch (e) {
    c.rc = e.exitCode;
    c.code = e.code;
  }
  return c;
};

test("an update: asked, waited for idle, swapped, finished by the new version", async () => {
  assert.equal((await gp(["request"])).code, "no-updater", "no helper seen: no buttons");
  assert.equal((await gp(["poll"])).kv("UPDATE_REQUEST"), "none");
  assert.equal((await gp(["request"])).code, "no-update-available");
  assert.equal((await gp(["rollback"])).code, "no-previous-version");
  assert.equal((await gp(["offer", "1.1.0"])).kv("UPDATE_AVAILABLE"), "yes");
  assert.deepEqual(readJson(L.updateAvailable), { version: "1.1.0" }, "a test's offer, unpinned");
  assert.equal((await gp(["offer", "1.1.0", "--image", "r/ghost-protocol:1.1.0"])).rc, 2, "a bare tag is refused");
  assert.equal((await gp(["offer", "1.1.0", "--image", PIN.replace("1.1.0@", "1.2.0@")])).rc, 2, "another version's image is refused");
  assert.equal((await gp(["offer", "1.1.0", "--image", PIN])).kv("UPDATE_AVAILABLE"), "yes");
  assert.deepEqual(readJson(L.updateAvailable), { version: "1.1.0", image: PIN, digest: DIGEST });
  const r = await gp(["request"]);
  assert.equal(r.rc, 0);
  assert.equal(r.kv("UPDATE"), "requested");
  assert.equal(r.kv("UPDATE_VERSION"), "1.1.0");
  assert.equal((await gp(["request"])).code, "update-in-progress");
  const p = await gp(["poll"]);
  assert.deepEqual([p.kv("VERSION"), p.kv("UPDATE_REQUEST"), p.kv("UPDATE_VERSION")], ["1.0.0", "update", "1.1.0"]);
  // Busy: nothing changes, the helper asks again.
  assert.equal((await gp(["begin"], { idle: () => ({ idle: false, why: "the turn marker says busy" }) })).kv("UPDATE"), "busy");
  assert.ok(existsSync(L.updateRequest) && !existsSync(L.updateState));
  assert.equal((await gp(["begin"], { idle: () => ({ idle: true }) })).kv("UPDATE"), "begun");
  assert.equal(readJson(L.updateState).state, "updating");
  assert.equal((await gp(["request"])).code, "update-in-progress");
  assert.equal(finish({ version: "1.0.0" }), null, "the old version does not finish it");
  // The new container: done.
  assert.equal(finish({ version: "1.1.0" }), "done");
  assert.equal(readFileSync(L.previousVersion, "utf8").trim(), "1.0.0");
  assert.ok(!existsSync(L.updateAvailable) && !existsSync(L.updateState));
  assert.deepEqual((({ action, from, to, result }) => ({ action, from, to, result }))(readJson(L.handoff)), { action: "update", from: "1.0.0", to: "1.1.0", result: "done" });
});

test("the way back: the previous version, then the one it left is on offer again", async () => {
  process.env.GP_IMAGE_VERSION = "1.1.0";
  await gp(["poll"]);
  const r = await gp(["rollback"]);
  assert.equal(r.kv("UPDATE"), "rollback-requested");
  assert.equal(r.kv("UPDATE_VERSION"), "1.0.0");
  await gp(["begin"], { idle: () => ({ idle: true }) });
  assert.equal(finish({ version: "1.0.0" }), "done");
  assert.ok(!existsSync(L.previousVersion));
  assert.deepEqual(readJson(L.updateAvailable), { version: "1.1.0", image: PIN, digest: DIGEST }, "on offer again, pinned as before");
  process.env.GP_IMAGE_VERSION = "1.0.0";
});

test("a failed swap: back on the old version, the handoff says so; a stuck one is dropped", async () => {
  await gp(["poll"]);
  await gp(["request"]);
  await gp(["begin"], { idle: () => ({ idle: true }) });
  const f = await gp(["failed", "--reason", "1.1.0 did not start"]);
  assert.equal(f.kv("UPDATE"), "failed");
  assert.ok(!existsSync(L.updateState) && !existsSync(L.updateRequest));
  assert.equal(readJson(L.handoff).result, "failed");
  assert.deepEqual(readJson(L.updateAvailable), { version: "1.1.0", image: PIN, digest: DIGEST }, "still on offer");
  const { collect } = await import("../status.mjs");
  writeJson(L.config, { relay_url: "wss://relay.example.com", owner: "ab".repeat(32) });
  writeFileSync(L.key, "11".repeat(32) + "\n");
  const st = await collect({ probe: async () => "connected", claude: () => true });
  assert.equal(st.state, "error");
  assert.equal(st.error.code, "update-failed");
  assert.equal((await collect({ now: Date.now() + 11 * 60 * 1000, probe: async () => "connected", claude: () => true })).error, null, "shown for a while only");
  writeJson(L.updateState, { state: "updating", action: "update", from: "1.0.0", to: "1.1.0", at: "2020-01-01T00:00:00Z" });
  assert.equal(finish({ version: "1.0.0" }), "stale");
  assert.ok(!existsSync(L.updateState));
  // An old poll: the helper is gone.
  writeJson(L.updateRequest, {});
  rmSync(L.updateRequest);
  assert.equal((await gp(["request"], { now: Date.now() + 5 * 60 * 1000 })).code, "no-updater");
});

test("image references, GP_ lines, and the create request that keeps the docker run's settings", () => {
  assert.deepEqual(parseRef("ghcr.io/o/ghost-protocol:0.1.0"), { repo: "ghcr.io/o/ghost-protocol", tag: "0.1.0" });
  assert.deepEqual(parseRef("localhost:5000/ghost-protocol:1"), { repo: "localhost:5000/ghost-protocol", tag: "1" });
  assert.equal(parseRef("localhost:5000/ghost-protocol"), null);
  assert.deepEqual(parseRef(`ghcr.io/o/ghost-protocol:0.1.0@sha256:${"a".repeat(64)}`), { repo: "ghcr.io/o/ghost-protocol", tag: "0.1.0" }, "pinned, as get.sh runs it");
  assert.deepEqual(parseRef(`localhost:5000/ghost-protocol:1@sha256:${"a".repeat(64)}`), { repo: "localhost:5000/ghost-protocol", tag: "1" });
  assert.equal(parseRef("x@sha256:" + "a".repeat(64)), null);
  assert.equal(parseRef("localhost:5000/ghost-protocol@sha256:" + "a".repeat(64)), null, "a digest alone");
  assert.equal(parseRef("sha256:" + "a".repeat(64)), null);
  assert.deepEqual(gpLines("GP_INTERFACE=1\nlog\nGP_UPDATE=begun\n"), { INTERFACE: "1", UPDATE: "begun" });
  const c = {
    Config: { Env: ["PATH=/x", "GP_IMAGE_VERSION=1.0.0", "TZ=UTC"], Cmd: ["agent"], Entrypoint: ["/e"], Labels: { a: "1", mine: "y" } },
    HostConfig: { Binds: ["gp-a-data:/data"], RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "default" },
  };
  const img = { Config: { Env: ["PATH=/x", "GP_IMAGE_VERSION=1.0.0"], Cmd: ["agent"], Entrypoint: ["/e"], Labels: { a: "1" } } };
  assert.deepEqual(recreateConfig(c, "r/ghost-protocol:1.1.0", img), {
    Image: "r/ghost-protocol:1.1.0",
    Env: ["TZ=UTC"],
    Labels: { mine: "y" },
    HostConfig: { Binds: ["gp-a-data:/data"], RestartPolicy: { Name: "unless-stopped" }, NetworkMode: "default" },
  });
});

// A stand-in for Docker: one agent container whose gp answers like update.mjs's.
function fakeDocker({ newWorks = true, pullFails = false, busyTimes = 0, image = "r/ghost-protocol:1.0.0" } = {}) {
  const st = { image, version: "1.0.0", request: "update", to: "1.1.0", running: true, calls: [], busy: busyTimes, failed: null };
  const d = {
    st,
    async inspect(n) {
      if (n === "me") return { Id: "me1", Config: { Image: "r/ghost-protocol:1.0.0", Cmd: ["updater", "--target", "gp-a"] }, HostConfig: { Binds: ["/var/run/docker.sock:/var/run/docker.sock"] } };
      if (!st.running) return null;
      return { Name: "/gp-a", Image: "sha:old", State: { Running: true }, Config: { Image: st.image, Env: [], Cmd: ["agent"] }, HostConfig: { Binds: ["gp-a-data:/data"], RestartPolicy: { Name: "unless-stopped" } } };
    },
    async imageInspect(ref) {
      return ref === "r/ghost-protocol:1.1.0" || ref === "sha:old" ? { Config: { Env: [], Cmd: ["agent"] } } : null;
    },
    async pull(repo, tag) {
      st.calls.push(`pull ${repo}:${tag}`);
      if (pullFails) throw new Error("no such host");
    },
    async stop(n) { st.calls.push(`stop ${n}`); },
    async remove(n) { st.calls.push(`rm ${n}`); st.running = false; },
    async create(n, cfg) { st.calls.push(`create ${n || "-"} ${cfg.Image}`); if (n === "gp-a") st.image = cfg.Image; return "id-" + st.calls.length; },
    async start(n) { st.calls.push(`start ${n}`); if (n === "gp-a") { st.running = true; st.version = st.image.split(":").pop(); } },
    async exec(n, cmd) {
      const a = cmd.slice(1).join(" ");
      if (a === "update poll") return { code: 0, stdout: `GP_INTERFACE=1\nGP_VERSION=${st.version}\nGP_UPDATE_REQUEST=${st.request}\n${st.request === "none" ? "" : `GP_UPDATE_VERSION=${st.to}\n`}` };
      if (a === "update begin") {
        if (st.busy-- > 0) return { code: 0, stdout: "GP_UPDATE=busy\n" };
        st.request = "none";
        return { code: 0, stdout: "GP_UPDATE=begun\n" };
      }
      if (a.startsWith("update failed")) { st.failed = a; return { code: 0, stdout: "GP_UPDATE=failed\n" }; }
      if (a === "status --json") {
        if (st.version === "1.1.0" && !newWorks) throw new Error("is not running");
        return { code: 0, stdout: JSON.stringify({ version: st.version, state: "running" }) };
      }
      throw new Error(`unexpected exec ${a}`);
    },
  };
  return d;
}
const helper = (d) => new Helper({ target: "gp-a", d, log: () => {}, sleep: async () => {}, checkMs: 50, self: "me" });

test("the helper: pulls while the agent works, swaps once idle, and moves itself onto the new tag", async () => {
  const d = fakeDocker({ busyTimes: 1 });
  const h = helper(d);
  assert.equal(await h.step(), "busy");
  assert.equal(await h.step(), "updated");
  assert.deepEqual(d.st.calls, [
    "pull r/ghost-protocol:1.1.0",
    "stop gp-a",
    "rm gp-a",
    "create gp-a r/ghost-protocol:1.1.0",
    "start gp-a",
    "create - r/ghost-protocol:1.1.0",
    "start id-6",
  ]);
  assert.equal(await h.step(), "idle");
});

test("the helper: an agent run pinned by digest (as get.sh runs it) is updated onto the new tag", async () => {
  const d = fakeDocker({ image: `r/ghost-protocol:1.0.0@sha256:${"e".repeat(64)}` });
  assert.equal(await helper(d).step(), "updated");
  assert.deepEqual(d.st.calls.slice(0, 4), ["pull r/ghost-protocol:1.1.0", "stop gp-a", "rm gp-a", "create gp-a r/ghost-protocol:1.1.0"]);
});

test("the helper: a new version that fails its check is the way back; a pull that fails changes nothing", async () => {
  const d = fakeDocker({ newWorks: false });
  assert.equal(await helper(d).step(), "reverted");
  assert.equal(d.st.image, "r/ghost-protocol:1.0.0");
  assert.match(d.st.failed, /^update failed --reason 1\.1\.0 did not start$/);
  const d2 = fakeDocker({ pullFails: true });
  d2.imageInspect = async () => null;
  assert.equal(await helper(d2).step(), "failed");
  assert.deepEqual(d2.st.calls, ["pull r/ghost-protocol:1.1.0"]);
  assert.match(d2.st.failed, /could not pull/);
  const d3 = fakeDocker();
  d3.st.running = false;
  assert.equal(await helper(d3).step(), "waiting", "no agent container: it waits");
});

test("the Docker API client over a unix socket: inspect, a 404, exec's stream", async () => {
  const sock = join(data, "docker.sock");
  const frame = (kind, text) => {
    const b = Buffer.from(text);
    const h = Buffer.alloc(8);
    h[0] = kind;
    h.writeUInt32BE(b.length, 4);
    return Buffer.concat([h, b]);
  };
  const srv = http.createServer((req, res) => {
    if (req.url === "/containers/gp-a/json") return res.end(JSON.stringify({ Name: "/gp-a" }));
    if (req.url === "/containers/gp-a/exec") return res.writeHead(201).end(JSON.stringify({ Id: "e1" }));
    if (req.url === "/exec/e1/start") return res.end(Buffer.concat([frame(1, "GP_X=1\n"), frame(2, "a log\n")]));
    if (req.url === "/exec/e1/json") return res.end(JSON.stringify({ ExitCode: 3 }));
    res.writeHead(404).end(JSON.stringify({ message: "No such container: x" }));
  });
  await new Promise((r) => srv.listen(sock, r));
  try {
    const d = docker(sock);
    assert.deepEqual(await d.inspect("gp-a"), { Name: "/gp-a" });
    assert.equal(await d.inspect("x"), null);
    assert.deepEqual(await d.exec("gp-a", ["gp"]), { code: 3, stdout: "GP_X=1\n", stderr: "a log\n" });
    await assert.rejects(d.start("x"), /No such container/);
  } finally {
    srv.close();
  }
  assert.deepEqual(demux(Buffer.alloc(0)), { stdout: "", stderr: "" });
});
