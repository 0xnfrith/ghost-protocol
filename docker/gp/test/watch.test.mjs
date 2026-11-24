import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "gp-watch-"));
process.env.GP_DATA = data;
process.env.GP_IMAGE_VERSION = "1.0.0";
const { L } = await import("../layout.mjs");
const { readJson, writeJson } = await import("../files.mjs");
const { cmp, newest, registryOf, listTags, manifestDigest, check, nextNote, deliver, transcriptHas, typeIntoClaude, noteToken, CONFIRM_MS, TRIES, HELPER_GRACE_MS } = await import("../watch.mjs");
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
  const at = { started: 0, helper: true };
  assert.equal(deliver({ ...at, idle: () => ({ idle: false }), type }), false, "busy: later");
  assert.equal(deliver({ ...at, idle: () => ({ idle: true }), type, taken: () => false }), "typed");
  assert.equal(typed.length, 1);
  assert.equal(readJson(L.handoff).told, false, "not told until a turn took it");
  assert.equal(deliver({ ...at, idle: () => ({ idle: true }), type, taken: () => true }), "given");
  assert.equal(readJson(L.handoff).told, true);
  assert.equal(deliver({ ...at, idle: () => ({ idle: true }), type, taken: () => true }), false, "given once");
  assert.equal(typed.length, 1);
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

// --- the first ask at a start: a note typed into a claude that cannot take it yet is not lost ---

/** A fresh agent with <version> on offer and nothing asked or pending; claude running and idle. */
function freshOffer(version) {
  writeJson(L.handoff, null);
  writeJson(L.updateAsked, { versions: [] });
  writeJson(L.notePending, null);
  writeJson(L.updateAvailable, { version });
  writeFileSync(L.agentState, "running 2026-01-01T00:00:00Z\n");
}
const asked = () => readJson(L.updateAsked, { versions: [] }).versions;
const idle = () => ({ idle: true });

test("the first ask, typed before claude can take it: not marked asked, typed again, given once a turn took it", () => {
  freshOffer("1.3.0");
  const typed = [];
  const type = (t) => (typed.push(t), true);
  let turn = false;
  const taken = (frag, since) => turn && typed.at(-1).endsWith(frag) && Number.isFinite(since);
  const t0 = 1_000_000;
  const at = (ms) => ({ now: t0 + ms, started: t0, helper: true, idle, type, taken });
  // The keys go to a claude still starting: they are lost, and no turn follows.
  assert.equal(deliver(at(0)), "typed");
  assert.deepEqual(asked(), [], "not asked yet: no turn took the note");
  assert.equal(readJson(L.notePending).key, "ask 1.3.0");
  assert.equal(deliver(at(10_000)), false, "within CONFIRM_MS: waits, types nothing");
  assert.equal(typed.length, 1);
  // No turn within CONFIRM_MS: typed again.
  assert.equal(deliver(at(CONFIRM_MS + 1)), "typed");
  assert.equal(typed.length, 2);
  assert.equal(readJson(L.notePending).tries, 2);
  // This time a turn takes it: given, once.
  turn = true;
  assert.equal(deliver(at(CONFIRM_MS + 15_000)), "given");
  assert.deepEqual(asked(), ["1.3.0"]);
  assert.equal(readJson(L.notePending, null), null);
  assert.equal(deliver(at(CONFIRM_MS + 30_000)), false, "once per version");
  assert.equal(deliver(at(10 * CONFIRM_MS)), false);
  assert.equal(typed.length, 2);
  assert.match(typed[0], /^\[GHOST Protocol\] Version 1\.3\.0 .*gp update request/);
});

test("after a restart: a version given is never asked again; a pending note is marked if a turn took it, typed again if not", () => {
  freshOffer("1.4.0");
  const typed = [];
  const type = (t) => (typed.push(t), true);
  const t0 = 2_000_000;
  assert.equal(deliver({ now: t0, started: t0, helper: true, idle, type, taken: () => false }), "typed");
  // A restart before any turn: the new watch finds the note pending, no turn took it, and types it again once CONFIRM_MS passed.
  const t1 = t0 + 20_000;
  assert.equal(deliver({ now: t1, started: t1, helper: true, idle, type, taken: () => false }), false, "waits out CONFIRM_MS");
  assert.equal(deliver({ now: t0 + CONFIRM_MS + 1, started: t1, helper: true, idle, type, taken: () => false }), "typed");
  assert.equal(typed.length, 2);
  // Another restart: the transcript shows a turn took it. Marked, not typed a third time.
  const t2 = t0 + CONFIRM_MS + 5_000;
  assert.equal(deliver({ now: t2, started: t2, helper: true, idle, type, taken: () => true }), "given");
  assert.deepEqual(asked(), ["1.4.0"]);
  // And after one more restart, nothing for 1.4.0.
  const t3 = t2 + 60_000;
  assert.equal(deliver({ now: t3, started: t3, helper: true, idle, type, taken: () => true }), false);
  assert.equal(typed.length, 2);
  // A later version: one note of its own.
  writeJson(L.updateAvailable, { version: "1.5.0" });
  assert.equal(deliver({ now: t3 + 1, started: t3, helper: true, idle, type, taken: () => false }), "typed");
  assert.equal(deliver({ now: t3 + 2_000, started: t3, helper: true, idle, type, taken: () => true }), "given");
  assert.deepEqual(asked(), ["1.4.0", "1.5.0"]);
  assert.equal(typed.length, 3);
});

test("a newer version while a note is pending: the pending one is dropped, the newer one is asked about", () => {
  freshOffer("1.6.0");
  const typed = [];
  const type = (t) => (typed.push(t), true);
  assert.equal(deliver({ now: 1, started: 0, helper: true, idle, type, taken: () => false }), "typed");
  writeJson(L.updateAvailable, { version: "1.7.0" });
  assert.equal(deliver({ now: 2, started: 0, helper: true, idle, type, taken: () => false }), "typed");
  assert.equal(readJson(L.notePending).key, "ask 1.7.0");
  assert.match(typed[1], /Version 1\.7\.0/);
});

test("at most TRIES notes when no turn ever shows: then marked given, never typed again", () => {
  freshOffer("1.8.0");
  const typed = [];
  const type = (t) => (typed.push(t), true);
  const logs = [];
  for (let i = 0; i < 20; i++) deliver({ now: i * (CONFIRM_MS + 1), started: 0, helper: true, idle, type, taken: () => false, log: (l) => logs.push(l) });
  assert.equal(typed.length, TRIES);
  assert.deepEqual(asked(), ["1.8.0"]);
  assert.ok(logs.some((l) => /no turn took the note \(ask 1\.8\.0\) after \d+ tries; marked as given/.test(l)), logs.join("|"));
});

test("not typed while the keys cannot go in (no pane): nothing pending, nothing marked", () => {
  freshOffer("1.9.0");
  assert.equal(deliver({ now: 1, started: 0, helper: true, idle, type: () => false, taken: () => false }), false);
  assert.equal(readJson(L.notePending, null), null);
  assert.deepEqual(asked(), []);
});

test("the first HELPER_GRACE_MS of the watch: no note while the helper was not seen, so the note says the right thing", () => {
  freshOffer("2.0.0");
  const typed = [];
  const type = (t) => (typed.push(t), true);
  const t0 = 5_000_000;
  assert.equal(deliver({ now: t0 + 1_000, started: t0, helper: false, idle, type, taken: () => false }), false, "the helper may not have polled yet");
  assert.equal(typed.length, 0);
  assert.equal(deliver({ now: t0 + 2_000, started: t0, helper: true, idle, type, taken: () => false }), "typed", "seen: at once");
  assert.match(typed[0], /run `gp update request`/);
  freshOffer("2.1.0");
  assert.equal(deliver({ now: t0 + HELPER_GRACE_MS + 1, started: t0, helper: false, idle, type, taken: () => false }), "typed", "no helper after the grace");
  assert.match(typed[1], /no update helper, so they update by hand/);
});

test("the transcript: a turn took the note when a transcript written since holds its token", () => {
  const dir = join(data, "transcripts");
  mkdirSync(dir, { recursive: true });
  const tok = noteToken(Date.now());
  assert.match(tok, /^\[note [0-9a-z]+\]$/);
  assert.notEqual(noteToken(1), noteToken(1), "each typing its own");
  const text = `[GHOST Protocol] Version 3.0.0 of GHOST Protocol is out; you run 1.0.0. Ask your operator once. ${tok}`;
  const f = join(dir, "s1.jsonl");
  writeFileSync(f, JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
  const since = Date.now() - 5_000;
  assert.equal(transcriptHas(tok, since, { dir }), true);
  assert.equal(transcriptHas(noteToken(Date.now()), since, { dir }), false, "another typing's token");
  utimesSync(f, new Date(since - 60_000), new Date(since - 60_000));
  assert.equal(transcriptHas(tok, since, { dir }), false, "a transcript older than the note does not count");
  assert.equal(transcriptHas(tok, since, { dir: join(data, "nowhere") }), false, "no transcripts: not taken");
  writeFileSync(join(dir, "s2.jsonl"), JSON.stringify({ type: "user", message: { content: [{ type: "text", text: 'a "quoted" ' + text }] } }) + "\n");
  assert.equal(transcriptHas(tok, since, { dir }), true, "inside a content block too");
  assert.equal(L.transcripts, join(data, ".claude", "projects", join(data, "work", "agent").replace(/[^A-Za-z0-9]/g, "-")),
    "the project folder install/service/start names (PROJECT_DIR: the home, every other character as -)");
});

// --- the review's cases ---

/** A transcript of the instance's home (L.transcripts) with one prompt. */
function prompt(name, content) {
  mkdirSync(L.transcripts, { recursive: true });
  writeFileSync(join(L.transcripts, name), JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
}

test("a note whose first keys were lost still counts: the transcript holds only its tail", () => {
  freshOffer("2.2.0");
  const typed = [];
  const type = (t) => (typed.push(t), true);
  const t0 = Date.now();
  assert.equal(deliver({ now: t0, started: 0, helper: true, idle, type }), "typed");
  prompt("tail.jsonl", typed[0].slice(40)); // claude took the note without its first 40 characters
  assert.equal(deliver({ now: t0 + 15_000, started: 0, helper: true, idle, type }), "given");
  assert.deepEqual(asked(), ["2.2.0"]);
  assert.equal(typed.length, 1, "not typed again: no second DM");
});

test("an earlier copy of the same words (a resumed session, a handoff that comes again) is not this note taken", () => {
  freshOffer("2.3.0");
  const typed = [];
  const type = (t) => (typed.push(t), true);
  const t0 = Date.now();
  assert.equal(deliver({ now: t0, started: 0, helper: true, idle, type }), "typed");
  const words = typed[0].replace(/ \[note [0-9a-z]+\]$/, "");
  prompt("old.jsonl", `${words} [note earlier]`); // the same note, from an earlier typing, in a transcript written now
  assert.equal(deliver({ now: t0 + CONFIRM_MS + 1, started: 0, helper: true, idle, type }), "typed", "not taken: typed again");
  assert.deepEqual(asked(), []);
  // A turn that took the first try late still counts: every try's token is looked for.
  prompt("late.jsonl", typed[0]);
  assert.equal(deliver({ now: t0 + CONFIRM_MS + 15_000, started: 0, helper: true, idle, type }), "given");
  assert.deepEqual(asked(), ["2.3.0"]);
});

test("a pending ask a turn took, replaced by a newer version before its confirm: still marked asked", () => {
  freshOffer("2.4.0");
  const typed = [];
  const type = (t) => (typed.push(t), true);
  const t0 = Date.now();
  assert.equal(deliver({ now: t0, started: 0, helper: true, idle, type }), "typed");
  prompt("took.jsonl", typed[0]);
  writeJson(L.updateAvailable, { version: "2.5.0" });
  deliver({ now: t0 + 5_000, started: 0, helper: true, idle, type });
  assert.deepEqual(asked(), ["2.4.0"], "the ask a turn took is asked");
  assert.match(typed.at(-1), /Version 2\.5\.0/, "and the newer one is typed");
  writeJson(L.updateAvailable, { version: "2.4.0" });
  writeJson(L.notePending, null);
  assert.equal(nextNote({ helper: true }), null, "2.4.0 never again");
});

test("before the keys, claude's input line is cleared: a try whose Enter was lost is not typed after itself", () => {
  mkdirSync(L.startState, { recursive: true });
  writeFileSync(join(L.startState, "pane-id"), "%3\n");
  const calls = [];
  assert.equal(typeIntoClaude("hello\nthere", { exec: (cmd, args) => calls.push([cmd, ...args].join(" ")) }), true);
  assert.deepEqual(calls, ["tmux -L agent send-keys -t %3 C-u", "tmux -L agent send-keys -t %3 -l hello there", "tmux -L agent send-keys -t %3 Enter"]);
});

test("after an upgrade from a release that lost an ask: the check never offers that older version, and asks about the next", async () => {
  writeJson(L.handoff, null);
  writeJson(L.notePending, null);
  writeJson(L.updateAsked, { versions: ["1.0.5"] }); // lost by the old release: marked as asked, never shown
  writeJson(L.updateAvailable, null);
  const repo = "ghcr.io/0xnfrith/ghost-protocol-staging";
  const digestOf = async () => "sha256:" + "ab".repeat(32);
  assert.equal(await check({ repo, current: "1.1.0", list: async () => ["1.0.4", "1.0.5", "1.1.0"], digestOf }), null, "nothing newer than 1.1.0");
  assert.equal(nextNote({ current: "1.1.0", helper: true }), null);
  assert.equal((await check({ repo, current: "1.1.0", list: async () => ["1.0.5", "1.1.0", "1.2.0"], digestOf })).version, "1.2.0");
  assert.match(nextNote({ current: "1.1.0", helper: true }).text, /Version 1\.2\.0 /, "the next release: asked about");
});

test("the ask names the operator by their key (the owner in config.json): a first prompt knows nobody else", () => {
  const owner = "52".repeat(32);
  writeJson(L.handoff, null);
  writeJson(L.notePending, null);
  writeJson(L.updateAsked, { versions: [] });
  writeJson(L.updateAvailable, { version: "3.1.0" });
  writeJson(L.config, { name: "GHOST", owner });
  const k = `your operator (their Buzz key is ${owner}; open the DM with that key if there is none yet)`;
  assert.ok(nextNote({ helper: true }).text.includes(`Ask ${k} once, in your DM with them on Buzz`), nextNote({ helper: true }).text);
  assert.ok(nextNote({ helper: false }).text.includes(`Tell ${k} once, in your DM with them on Buzz`));
  writeJson(L.config, { name: "GHOST", owner: "5A" + "52".repeat(31) });
  assert.ok(nextNote({ helper: true }).text.includes(`their Buzz key is 5a${"52".repeat(31)};`), "an upper-case key: named, in lower case");
  writeJson(L.config, { name: "GHOST", owner: "not-a-key" });
  assert.match(nextNote({ helper: true }).text, /Ask your operator once, in your DM/, "no key that is one: as before");
  writeJson(L.config, {});
  assert.match(nextNote({ helper: false }).text, /Tell your operator once, in your DM/);
});
