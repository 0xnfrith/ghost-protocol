// The git sign-in's two halves without systemd: git-auth.mjs's checks and
// signing, and git-credential.mjs, the session's helper, against a stand-in
// git.sock that answers with git-auth.mjs's own answer(). The last test runs
// real git (2.46 or newer) against a stand-in relay that challenges with
// `WWW-Authenticate: Nostr`, and checks the header git sent.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { verifyEvent } from "nostr-tools/pure";
import { answer, relayGitOrigin, repoRoot, signIn } from "../src/git-auth.mjs";
import { ADAPTER, identity } from "./helpers.mjs";

const HELPER = join(ADAPTER, "src", "git-credential.mjs");
const agent = identity();
const owner = identity();
const TAG = ["auth", owner.pubkey, "", "d".repeat(128)];
const dir = mkdtempSync(join(tmpdir(), "gp-git-credential-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const origin = relayGitOrigin("wss://Relay.Example.com");
const state = { secret: agent.secret, pubkey: agent.pubkey, authTag: TAG, origin };

test("the relay's git origin: https for wss and https, http for ws and http, the host as git names it", () => {
  assert.deepEqual(relayGitOrigin("wss://relay.example.com"), { scheme: "https", host: "relay.example.com" });
  assert.deepEqual(relayGitOrigin("https://relay.example.com/"), { scheme: "https", host: "relay.example.com" });
  assert.deepEqual(relayGitOrigin("ws://127.0.0.1:3000"), { scheme: "http", host: "127.0.0.1:3000" });
  assert.throws(() => relayGitOrigin("ftp://relay.example.com"), /must start with/);
  assert.throws(() => relayGitOrigin(undefined), /set BUZZ_RELAY_URL/);
});

test("the repository root: the relay's suffixes stripped, one repository only", () => {
  const repo = `git/${owner.pubkey}/hive`;
  for (const path of [repo, `/${repo}`, `${repo}/`, `${repo}/info/refs`, `${repo}/git-upload-pack`, `${repo}/git-receive-pack`]) {
    assert.equal(repoRoot(origin, { protocol: "https", host: "relay.example.com", path }).url, `https://relay.example.com/${repo}`);
  }
  assert.equal(repoRoot(origin, { protocol: "https", host: "RELAY.example.com", path: `${repo}.git` }).url, `https://relay.example.com/${repo}.git`);
  for (const request of [
    { protocol: "https", host: "relay.example.com.evil", path: repo },
    { protocol: "https", host: "relay.example.com", path: `${repo}/../../events` },
    { protocol: "https", host: "relay.example.com", path: "" },
    { protocol: "https", host: "relay.example.com" },
    { protocol: "https", host: "relay.example.com", path: `git/${owner.pubkey}/${"a".repeat(65)}` },
    { protocol: "https", host: "relay.example.com", path: `git/${owner.pubkey.toUpperCase()}/hive` },
    null,
    [],
  ]) {
    assert.ok(repoRoot(origin, request).error, JSON.stringify(request));
  }
});

test("the sign-in: kind 27235, the repository root in u, GET, the owner's tag, signed by the key", () => {
  const event = JSON.parse(Buffer.from(signIn(agent.secret, "https://relay.example.com/git/x/y", TAG), "base64").toString("utf8"));
  assert.ok(verifyEvent(event));
  assert.equal(event.kind, 27235);
  assert.equal(event.pubkey, agent.pubkey);
  assert.deepEqual(event.tags, [["u", "https://relay.example.com/git/x/y"], ["method", "GET"], TAG]);
  const bare = JSON.parse(Buffer.from(signIn(agent.secret, "https://relay.example.com/git/x/y", undefined), "base64").toString("utf8"));
  assert.deepEqual(bare.tags, [["u", "https://relay.example.com/git/x/y"], ["method", "GET"]]);
  assert.deepEqual(answer(state, { op: "ping" }), { ok: true, pubkey: agent.pubkey });
  assert.equal(answer(state, { op: "nope" }).ok, false);
});

/** A stand-in git.sock: each connection gets git-auth.mjs's answer() to its line. Records the requests. */
async function standInSocket(label) {
  const path = join(dir, `${label}.sock`);
  const requests = [];
  const server = createServer((conn) => {
    let text = "";
    conn.on("data", (chunk) => {
      text += chunk;
      const nl = text.indexOf("\n");
      if (nl < 0) return;
      const request = JSON.parse(text.slice(0, nl));
      requests.push(request);
      const { owner: _o, repo: _r, ...body } = answer(state, request);
      conn.end(`${JSON.stringify(body)}\n`);
    });
  });
  await new Promise((done) => server.listen(path, done));
  after(() => server.close());
  return { path, requests };
}

// Run with spawn, never spawnSync: the stand-in socket answers from this process's event loop.
const helper = (socket, action, input = "") =>
  new Promise((done) => {
    const child = spawn(process.execPath, [HELPER, "--socket", socket, action], { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (status) => done({ status, stdout, stderr }));
    child.stdin.end(input);
  });

test("the helper: answers a relay's challenge with the key service's sign-in, and sends only protocol, host and path", async () => {
  const sock = await standInSocket("get");
  const repo = `git/${owner.pubkey}/hive`;
  const request = ["capability[]=authtype", "protocol=https", "host=relay.example.com", `path=${repo}/info/refs`, 'wwwauth[]=Nostr realm="buzz", method="GET"', "", ""].join("\n");
  const r = await helper(sock.path, "get", request);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n");
  assert.deepEqual(lines.slice(0, 2), ["capability[]=authtype", "authtype=Nostr"]);
  const credential = lines.find((l) => l.startsWith("credential=")).slice("credential=".length);
  const event = JSON.parse(Buffer.from(credential, "base64").toString("utf8"));
  assert.ok(verifyEvent(event));
  assert.equal(event.tags[0][1], `https://relay.example.com/${repo}`);
  assert.ok(lines.includes("ephemeral=true"));
  assert.equal(r.stderr, "");
  assert.deepEqual(sock.requests, [{ op: "sign", protocol: "https", host: "relay.example.com", path: `${repo}/info/refs` }]);
});

test("the helper: silent for no challenge, an old git, store and erase; refuses with no path; reports a refusal", async () => {
  const sock = await standInSocket("quiet");
  const repo = `git/${owner.pubkey}/hive`;
  const noChallenge = await helper(sock.path, "get", ["capability[]=authtype", "protocol=https", "host=relay.example.com", `path=${repo}`, "", ""].join("\n"));
  assert.equal(noChallenge.status, 0);
  assert.equal(noChallenge.stdout, "\n");
  const oldGit = await helper(sock.path, "get", ["protocol=https", "host=relay.example.com", `path=${repo}`, "wwwauth[]=Nostr realm=buzz", "", ""].join("\n"));
  assert.equal(oldGit.status, 0);
  assert.equal(oldGit.stdout, "\n");
  for (const action of ["store", "erase"]) {
    const r = await helper(sock.path, action, "protocol=https\n\n");
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
  assert.deepEqual(sock.requests, []);
  const noPath = await helper(sock.path, "get", ["capability[]=authtype", "protocol=https", "host=relay.example.com", "wwwauth[]=Nostr realm=buzz", "", ""].join("\n"));
  assert.equal(noPath.status, 1);
  assert.match(noPath.stderr, /useHttpPath/);
  const other = await helper(sock.path, "get", ["capability[]=authtype", "protocol=https", "host=evil.example.com", `path=${repo}`, "wwwauth[]=Nostr realm=buzz", "", ""].join("\n"));
  assert.equal(other.status, 1);
  assert.equal(other.stdout, "");
  assert.match(other.stderr, /refused: only the instance's own relay/);
  assert.doesNotMatch(other.stderr, /credential=|[A-Za-z0-9+/=]{60,}/); // a refusal carries no sign-in
});

test("the helper's probe: the key's public key, or why there was no answer", async () => {
  const sock = await standInSocket("probe");
  const ok = await helper(sock.path, "probe");
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, `probe: ${sock.path} answered (key ${agent.pubkey})\n`);
  const missing = await helper(join(dir, "nothing.sock"), "probe");
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /could not reach the key service \(ENOENT\)/);
});

test("real git: a fetch from a relay that challenges with Nostr sends the key service's sign-in as its Authorization", async (t) => {
  const v = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.match(/(\d+)\.(\d+)/);
  if (!v || Number(v[1]) < 2 || (Number(v[1]) === 2 && Number(v[2]) < 46)) return t.skip("git 2.46 or newer is needed (capability[]=authtype)");
  const seen = [];
  const http = createHttpServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    if (!req.headers.authorization) {
      res.writeHead(401, { "WWW-Authenticate": 'Nostr realm="buzz", method="GET"' });
      return res.end();
    }
    res.writeHead(403);
    res.end("stand-in: seen\n");
  });
  await new Promise((done) => http.listen(0, "127.0.0.1", done));
  after(() => http.close());
  const port = http.address().port;
  const hostState = { ...state, origin: relayGitOrigin(`ws://127.0.0.1:${port}`) };
  const sockPath = join(dir, "real.sock");
  const sock = createServer((conn) => {
    let text = "";
    conn.on("data", (chunk) => {
      text += chunk;
      const nl = text.indexOf("\n");
      if (nl < 0) return;
      const { owner: _o, repo: _r, ...body } = answer(hostState, JSON.parse(text.slice(0, nl)));
      conn.end(`${JSON.stringify(body)}\n`);
    });
  });
  await new Promise((done) => sock.listen(sockPath, done));
  after(() => sock.close());
  const home = join(dir, "home");
  spawnSync("mkdir", ["-p", home]);
  const base = `http://127.0.0.1:${port}`;
  writeFileSync(
    join(home, ".gitconfig"),
    `[credential "${base}"]\n\thelper =\n\thelper = !${process.execPath} ${HELPER} --socket ${sockPath}\n\tuseHttpPath = true\n`,
  );
  const url = `${base}/git/${owner.pubkey}/hive`;
  const r = await new Promise((done) => {
    const child = spawn("git", ["ls-remote", url], {
      env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (status) => done({ status, err }));
  });
  assert.notEqual(r.status, 0); // the stand-in refuses after it has seen the header
  const authed = seen.find((s) => s.auth);
  assert.ok(authed, `git sent no Authorization header (git said: ${r.err})`);
  assert.match(authed.auth, /^Nostr [A-Za-z0-9+/=]+$/);
  const event = JSON.parse(Buffer.from(authed.auth.slice("Nostr ".length), "base64").toString("utf8"));
  assert.ok(verifyEvent(event));
  assert.equal(event.pubkey, agent.pubkey);
  assert.deepEqual(event.tags[0], ["u", url]);
  assert.deepEqual(event.tags[2], TAG);
});
