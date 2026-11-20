import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "gp-watch-"));
process.env.GP_DATA = data;
process.env.GP_IMAGE_VERSION = "1.0.0";
const { L } = await import("../layout.mjs");
const { readJson, writeJson } = await import("../files.mjs");
const { cmp, newest, registryOf, listTags, manifestDigest, check, nextNote, deliver } = await import("../watch.mjs");
const { createHash } = await import("node:crypto");
mkdirSync(join(data, ".gp"), { recursive: true });
test.after(() => rmSync(data, { recursive: true, force: true }));

test("versions: plain x.y.z only, the newest newer one", () => {
  assert.ok(cmp("1.10.0", "1.9.9") > 0);
  assert.ok(cmp("1.0.0-rc.1", "1.0.0") < 0);
  assert.equal(newest(["0.9.0", "1.0.0", "1.2.0", "1.10.0", "2.0.0-rc.1", "latest", "sha-abc"], "1.0.0"), "1.10.0");
  assert.equal(newest(["1.0.0", "0.1.0"], "1.0.0"), null);
  assert.equal(newest(["1.0.0"], "1.0.0-rc.2"), "1.0.0");
});

test("registries: a host of its own, or Docker Hub", () => {
  assert.deepEqual(registryOf("ghcr.io/o/ghost-protocol"), { host: "ghcr.io", path: "o/ghost-protocol" });
  assert.deepEqual(registryOf("localhost:5000/ghost-protocol"), { host: "localhost:5000", path: "ghost-protocol" });
  assert.deepEqual(registryOf("o/ghost-protocol"), { host: "registry-1.docker.io", path: "o/ghost-protocol" });
});

test("the tag list, with the registry's anonymous token", async () => {
  const seen = [];
  const res = (status, body, headers = {}) => ({ status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] } });
  const fetchFn = async (url, opts = {}) => {
    seen.push([url, opts.headers?.Authorization ?? ""]);
    if (url.startsWith("https://ghcr.io/token")) return res(200, { token: "anon" });
    if (opts.headers?.Authorization === "Bearer anon") return res(200, { tags: ["1.0.0", "1.1.0"] });
    return res(401, {}, { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/ghost-protocol:pull"' });
  };
  assert.deepEqual(await listTags("ghcr.io/o/ghost-protocol", { fetchFn }), ["1.0.0", "1.1.0"]);
  assert.equal(seen[1][0], "https://ghcr.io/token?service=ghcr.io&scope=repository%3Ao%2Fghost-protocol%3Apull");
  assert.equal(await check({ repo: "", list: async () => ["9.0.0"] }), null, "no repository: no check");
});

test("the release manifest's digest: the sha256 of the bytes served, checked against the registry's own", async () => {
  const body = Buffer.from('{"schemaVersion":2,"mediaType":"application/vnd.oci.image.index.v1+json","manifests":[]}');
  const digest = "sha256:" + createHash("sha256").update(body).digest("hex");
  const seen = [];
  const mk = (said) => async (url, opts = {}) => {
    seen.push([url, opts.headers?.Accept ?? "", opts.headers?.Authorization ?? ""]);
    if (url.startsWith("https://ghcr.io/token")) return { status: 200, json: async () => ({ token: "anon" }), headers: { get: () => null } };
    if (opts.headers?.Authorization !== "Bearer anon") return { status: 401, headers: { get: (k) => (k === "www-authenticate" ? 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/ghost-protocol:pull"' : null) } };
    return { status: 200, arrayBuffer: async () => body, headers: { get: (k) => (k === "docker-content-digest" ? said : null) } };
  };
  assert.equal(await manifestDigest("ghcr.io/o/ghost-protocol", "1.1.0", { fetchFn: mk(digest) }), digest);
  assert.equal(seen[0][0], "https://ghcr.io/v2/o/ghost-protocol/manifests/1.1.0");
  assert.match(seen[0][1], /^application\/vnd\.oci\.image\.index\.v1\+json, application\/vnd\.docker\.distribution\.manifest\.list\.v2\+json/, "the index first");
  assert.equal(seen[2][2], "Bearer anon");
  assert.equal(await manifestDigest("ghcr.io/o/ghost-protocol", "1.1.0", { fetchFn: mk(null) }), digest, "no digest header: the computed one");
  await assert.rejects(manifestDigest("ghcr.io/o/ghost-protocol", "1.1.0", { fetchFn: mk("sha256:" + "0".repeat(64)) }), /does not match/);
});

test("a check puts the newest release on offer pinned by its digest, never as a bare tag", async () => {
  const repo = "ghcr.io/0xnfrith/ghost-protocol";
  const d = "sha256:" + "c0".repeat(32);
  assert.equal(await check({ repo: "", list: async () => ["9.0.0"] }), null, "no repository: no check");
  assert.equal(await check({ repo, list: async () => ["1.0.0"], digestOf: async () => d }), null, "nothing newer");
  await assert.rejects(check({ repo, list: async () => ["1.0.0", "1.1.0"], digestOf: async () => { throw new Error("the registry answered 404"); } }), /404/);
  await assert.rejects(check({ repo, list: async () => ["1.1.0"], digestOf: async () => "latest" }), /no digest/);
  await assert.rejects(check({ repo: "ghcr.io/o/other", list: async () => ["1.1.0"], digestOf: async () => d }), /not a release repository/);
  assert.ok(!readJson(L.updateAvailable, null), "no digest, no offer");
  const want = { version: "1.1.0", image: `${repo}:1.1.0@${d}`, digest: d };
  assert.deepEqual(await check({ repo, list: async () => ["1.0.0", "1.1.0"], digestOf: async () => d }), want);
  assert.deepEqual(readJson(L.updateAvailable), want);
  assert.deepEqual(readJson(L.releaseImages)["1.1.0"], { image: want.image, digest: d }, "remembered for a way back");
});

test("only the two release repositories, exactly: ghcr.io/0xnfrith/ghost-protocol and its -staging copy", async () => {
  const { isPinned, isReleaseRepo } = await import("../releases.mjs");
  const d = "sha256:" + "c1".repeat(32);
  const pin = (repo, v = "1.2.0") => `${repo}:${v}@${d}`;
  for (const repo of ["ghcr.io/0xnfrith/ghost-protocol", "ghcr.io/0xnfrith/ghost-protocol-staging"]) {
    assert.equal(isReleaseRepo(repo), true, repo);
    assert.equal(isPinned(pin(repo), "1.2.0"), true, repo);
    assert.equal(isPinned(pin(repo), "1.2.1"), false, `${repo}: another version`);
    assert.equal(isPinned(`${repo}:1.2.0`, "1.2.0"), false, `${repo}: a bare tag`);
    assert.equal(isPinned(`${repo}:1.2.0@sha256:${"c1".repeat(31)}`, "1.2.0"), false, `${repo}: a short digest`);
    assert.equal(isPinned(`${repo}:1.2.0@${d}x`, "1.2.0"), false, `${repo}: a digest with more after it`);
  }
  const refused = [
    ["ghcr.io/someone-else/ghost-protocol", "another owner"],
    ["ghcr.io/someone-else/ghost-protocol-staging", "another owner, staging name"],
    ["ghcr.io/0xnfrith/ghost-protocol-staging2", "an extra suffix"],
    ["ghcr.io/0xnfrith/ghost-protocol-evil", "an extra suffix"],
    ["ghcr.io/0xnfrith/ghost-protocolx", "an extra suffix"],
    ["ghcr.io/0xnfrith/x/ghost-protocol", "a path before the name"],
    ["ghcr.io/0xnfrith/x/ghost-protocol-staging", "a path before the staging name"],
    ["ghcr.io/0xnfrith/ghost-protocol/extra", "a path after the name"],
    ["ghcr.io/0xnfrith/ghost-protocol-staging/extra", "a path after the staging name"],
    ["xghcr.io/0xnfrith/ghost-protocol", "a prefix on the host"],
    ["ghcr.io:443/0xnfrith/ghost-protocol", "a port on the host"],
    ["docker.io/0xnfrith/ghost-protocol", "another registry"],
    ["localhost:5000/0xnfrith/ghost-protocol", "another registry"],
    ["evil.example/ghcr.io/0xnfrith/ghost-protocol", "another registry, the name as a path"],
    ["0xnfrith/ghost-protocol", "no registry host"],
    ["localhost:5000/ghost-protocol", "another registry, the bare name"],
    ["GHCR.IO/0xnfrith/ghost-protocol", "case: host"],
    ["ghcr.io/0xNfrith/ghost-protocol", "case: owner"],
    ["ghcr.io/0xnfrith/Ghost-Protocol", "case: name"],
    ["ghcr.io/0xnfrith/ghost-protocol-STAGING", "case: staging name"],
    [" ghcr.io/0xnfrith/ghost-protocol", "a leading space"],
    ["ghcr.io/0xnfrith/ghost-protocol ", "a trailing space"],
    ["", "nothing"],
  ];
  for (const [repo, why] of refused) {
    assert.equal(isReleaseRepo(repo), false, `${why}: ${repo}`);
    assert.equal(isPinned(pin(repo), "1.2.0"), false, `${why}: ${repo}`);
  }
  assert.equal(isPinned(`ghcr.io/0xnfrith/ghost-protocol:1.2.0@${d}\n`, "1.2.0"), false, "a trailing newline");
  assert.equal(isPinned(`ghcr.io/0xnfrith/ghost-protocol:1.2.0@${d}`, ""), false, "no version");
  assert.equal(isPinned(null, "1.2.0"), false);

  for (const repo of ["ghcr.io/0xnfrith/ghost-protocol", "ghcr.io/0xnfrith/ghost-protocol-staging"]) {
    const want = { version: "1.2.0", image: pin(repo), digest: d };
    assert.deepEqual(await check({ repo, current: "1.1.0", list: async () => ["1.1.0", "1.2.0", "pre-1.3.0"], digestOf: async () => d }), want, repo);
    assert.deepEqual(readJson(L.updateAvailable), want);
  }
  let asked = 0;
  const list = async () => (asked++, ["1.2.0"]);
  const digestOf = async () => (asked++, d);
  for (const [repo, why] of refused.filter(([r]) => r)) {
    await assert.rejects(check({ repo, current: "1.1.0", list, digestOf }), /is not a release repository \(only ghcr\.io\/0xnfrith\/ghost-protocol or ghcr\.io\/0xnfrith\/ghost-protocol-staging\)/, `${why}: ${repo}`);
  }
  assert.equal(asked, 0, "another repository is refused before its registry is asked anything");
  assert.equal(readJson(L.updateAvailable).image, pin("ghcr.io/0xnfrith/ghost-protocol-staging"), "a refused check leaves the offer as it was");
  writeJson(L.updateAvailable, { version: "1.1.0", image: `ghcr.io/0xnfrith/ghost-protocol:1.1.0@${"sha256:" + "c0".repeat(32)}`, digest: "sha256:" + "c0".repeat(32) });
});

test("the ask: once per version, with the helper or without it", () => {
  let n = nextNote({ helper: true });
  assert.match(n.text, /^\[GHOST Protocol\] Version 1\.1\.0 .* run `gp update request`/);
  n.mark();
  assert.equal(nextNote({ helper: true }), null, "asked once");
  writeJson(L.updateAvailable, { version: "1.2.0" });
  n = nextNote({ helper: false });
  assert.match(n.text, /no update helper, so they update by hand/);
  n.mark();
  assert.deepEqual(readJson(L.updateAsked).versions, ["1.1.0", "1.2.0"]);
});

test("the confirm after an update, a way back and a failed one, given once, only to an idle claude", () => {
  writeJson(L.handoff, { action: "update", from: "0.9.0", to: "1.0.0", result: "done", told: false });
  assert.match(nextNote().text, /updated from version 0\.9\.0 to 1\.0\.0.*in the thread where they said yes/);
  writeJson(L.handoff, { action: "rollback", from: "1.1.0", to: "1.0.0", result: "done", told: false });
  assert.match(nextNote().text, /moved back from version 1\.1\.0 to 1\.0\.0/);
  writeJson(L.handoff, { action: "update", from: "1.0.0", to: "1.1.0", result: "failed", reason: "1.1.0 did not start", told: false });
  assert.match(nextNote().text, /update to version 1\.1\.0 did not work \(1\.1\.0 did not start\); you still run 1\.0\.0/);

  const typed = [];
  const type = (t) => (typed.push(t), true);
  writeFileSync(L.agentState, "needs-claude 2026-01-01T00:00:00Z\n");
  assert.equal(deliver({ idle: () => ({ idle: true }), type }), false, "claude not running");
  writeFileSync(L.agentState, "running 2026-01-01T00:00:00Z\n");
  assert.equal(deliver({ idle: () => ({ idle: false }), type }), false, "busy: later");
  assert.equal(deliver({ idle: () => ({ idle: true }), type }), true);
  assert.equal(typed.length, 1);
  assert.equal(readJson(L.handoff).told, true);
  assert.equal(deliver({ idle: () => ({ idle: true }), type }), false, "given once");
});

test("a check against a registry over HTTP: the digest Docker-Content-Digest gives, on offer and in gp status --json", async () => {
  const { fakeRegistry, digestOf } = await import("./fake-registry.mjs");
  const { server, port } = await fakeRegistry(["0.9.0", "1.0.0", "1.1.0", "1.2.0", "latest"]);
  try {
    // The registry is a fake one on 127.0.0.1; the repository checked is the public one.
    const fake = `127.0.0.1:${port}/ghost-protocol`;
    const repo = "ghcr.io/0xnfrith/ghost-protocol";
    const got = await check({ repo, current: "1.0.0", list: () => listTags(fake), digestOf: (_, v) => manifestDigest(fake, v) });
    assert.deepEqual(got, { version: "1.2.0", image: `${repo}:1.2.0@${digestOf("1.2.0")}`, digest: digestOf("1.2.0") });
    const { updateField } = await import("../releases.mjs");
    assert.deepEqual(updateField("1.0.0"), { available: true, ...got });
    assert.deepEqual(updateField("1.2.0"), { available: false, version: null }, "the running version is never on offer");
  } finally {
    server.close();
  }
});
