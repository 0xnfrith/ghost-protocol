// The key service's GitHub review action (src/github-review.mjs), offline.
// Every App key is an RSA key made here, at test time, and none is ever
// printed. GitHub is a stand-in on 127.0.0.1 that checks each JWT against the
// key's public half (RS256, its issuer, its iat and exp), hands out marked
// tokens, and records every request. These tests hold the action to:
//   - the request: exactly the fields of its action, each checked (the repo,
//     the pull request's number, the head's full id, one of three events, a
//     body within bounds, which REQUEST_CHANGES and COMMENT need);
//   - the order: the allowlist (whose entry names the installation) before
//     the key is read or GitHub is asked anything;
//   - the token, taken as an opaque string: a stateless one as GitHub hands
//     them out now (ghs_, the App's id and a dotted JWT, about 520
//     characters) and a 40-character one from before both work; one with a
//     space or a control character, or over 4096 characters, is refused, and
//     revoked whenever it can be sent back as it is (never one node would
//     refuse in a header);
//   - the calls: a token for that one repo with pull_requests:write alone
//     (one GitHub makes wider is refused, and revoked), the pull request
//     read with it, its commits, a review only when that pull request is open
//     and its head is the one asked about, pinned there with commit_id, the
//     pull request read again (a head that moved meanwhile is not ok), and the
//     token revoked after, whatever happened, and the ledger line saying so
//     on every way out once a token was made; nothing else;
//   - the limits, each refused with its check's name and one clause, with no
//     review posted and the token revoked: repo and event (before the key or
//     the network), open, head, hold (a HOLD: title, the hold label), draft,
//     own-pr, own-commit (by login, by email, an unreadable list, over 100
//     commits, a list that does not match the head), and public-text (a body
//     in a repo that is not private); what must still pass (the builders'
//     shared noreply author, a hold later in the title, a private repo, COMMENT
//     where the settings allow it); a hold or a draft that comes after the post;
//   - the settings: the own identities are App bots only, the rules file is a
//     list of {name, pattern} that compiles, and serve refuses to start
//     without either;
//   - no key, JWT or token (nor any dotted part of one) in any answer,
//     ledger line or output;
//   - serve: node options, settings that run other code or loosen TLS, code
//     others can change, a missing or open key descriptor, bad settings, and
//     the stand-in's switch under systemd, each refused before any request;
//   - the key file: written once, 0400, as PKCS#1 PEM, swapped only on
//     purpose, and only an RSA key of 2048 bits or more, one PEM block; what
//     a run leaves beside it, and the key a swap replaces, overwritten with
//     zeros and removed;
//   - the session's client: a body on stdin over the cap is refused there;
//   - past serve's time limit, a token it holds is revoked;
//   - a leftover beside the key that is a second name for the live key (a
//     run stopped between its link and its unlink) is only removed: the key
//     keeps its bytes and its mode.
//
// serve trusts only code that nobody but root can change, up to /. These
// tests run without root, so (as test/keyservice.test.mjs does) they set the
// test switch and run serve from a copy of the module and of node in a
// private folder under this user's home.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  apiClient,
  app,
  call,
  fingerprint,
  heldProblem,
  loadRules,
  main,
  makeJwt,
  matchWithin,
  MATCH_MS,
  MATCH_TOTAL_MS,
  MAX_BODY,
  MAX_COMMITS,
  MAX_PATTERN,
  MAX_RULES,
  MAX_TOKEN,
  parseAppKey,
  parseConfig,
  parseRequest,
  parseRules,
  publicTextProblem,
  Refusal,
  review,
  SOCKET_NAME,
  tokenProblem,
} from "../src/github-review.mjs";
import { keyFdProblem, untrustedCode } from "../src/keyservice.mjs";

const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = join(ADAPTER, "..", "..");
const MODULE = join(ADAPTER, "src", "github-review.mjs");
const CLIENT = join(ROOT, "tools", "github-review", "gp-github-review");
const ME = process.getuid();

const pemOf = (bits = 2048, type = "pkcs1") =>
  generateKeyPairSync("rsa", { modulusLength: bits }).privateKey.export({ type, format: "pem" });
const KEY_PEM = pemOf();
const KEY = createPrivateKey(KEY_PEM);
const OTHER_PEM = pemOf();
const KEY_BODY = KEY_PEM.split("\n")[5]; // a line from the middle of the key, for the leak check
const CLIENT_ID = `Iv23li${randomBytes(7).toString("hex")}`;
const sha = () => randomBytes(20).toString("hex");
const HEAD = sha();
const REPO = "example-org/review-target";
const INSTALLATION = "4242";
// The reviewer's own identities (its App's bot), and the builders' shared
// noreply author, which is never "own". Made-up values.
const BOT_LOGIN = "review-bot[bot]";
const BOT_EMAIL = "31337+review-bot[bot]@users.noreply.github.com";
const BUILDER_LOGIN = "example-builder";
// (Written in two pieces: the repo's clean-tree scan refuses a noreply-shaped address in a file.)
const NOREPLY = "@users.noreply" + ".github.com";
const BUILDER_EMAIL = `4100+example-builder${NOREPLY}`;
// Made-up public-text rules: the repo carries none of the real ones.
const RULES = [
  { name: "example-host", pattern: "internal\\.example\\.test" },
  { name: "example-ticket", pattern: "\\bEX-[0-9]{3,}\\b" },
  { name: "example-codename", pattern: "blue ?falcon", ignore_case: true },
];
const FAILS_RULES = "see internal.example.test for the log";

// Installation tokens, made here at test time: a literal in the code would be
// a token shape in the repo's history, which the secret scan refuses.
const GHS = "gh" + "s_";
const b64url = (x) => Buffer.from(x).toString("base64url");
/** One from before GitHub's change: ghs_ and 36 more, 40 characters. */
const legacyToken = () => `${GHS}${randomBytes(18).toString("hex")}`;
/** The App id GitHub puts in a stateless token, after ghs_. */
const APP_ID = "31337";
/**
 * One as GitHub hands them out since October 2026 (stateless): ghs_, the
 * App's id and an _, then a three-part base64url JWT; about 520 characters,
 * its length varying. Made again until it holds a - as well, so the cases
 * below never pass by luck.
 */
function statelessToken() {
  for (;;) {
    const head = b64url(JSON.stringify({ alg: "RS256", kid: randomBytes(6).toString("hex"), typ: "JWT" }));
    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: `installation:${INSTALLATION}`, iat: now, exp: now + 3600, jti: randomBytes(4 + (now % 8)).toString("base64url") };
    const t = `${GHS}${APP_ID}_${head}.${b64url(JSON.stringify(claims))}.${b64url(randomBytes(256))}`;
    if (t.includes("-")) return t;
  }
}

// The private folder, and in it a copy of node and of the module, which is
// what serve runs (node is copied, never linked: a link shares the original's
// permissions).
const PRIVATE = mkdtempSync(join(homedir(), ".gp-github-review-test-"));
chmodSync(PRIVATE, 0o700);
{
  const why = untrustedCode([PRIVATE], new Set([0, ME]));
  if (why) throw new Error(`the private test folder is not private: ${why}`);
}
const privateDir = (label) => mkdtempSync(join(PRIVATE, `${label}-`));
const SERVE_NODE = join(PRIVATE, "node");
copyFileSync(realpathSync(process.execPath), SERVE_NODE);
chmodSync(SERVE_NODE, 0o755);
mkdirSync(join(PRIVATE, "src"));
for (const f of ["github-review.mjs", "keyservice.mjs"]) copyFileSync(join(ADAPTER, "src", f), join(PRIVATE, "src", f));
const SERVE_MODULE = join(PRIVATE, "src", "github-review.mjs");
const KEY_FILE = join(privateDir("key"), "github-app.pem");
writeFileSync(KEY_FILE, KEY_PEM, { mode: 0o600 });
const RULES_FILE = join(privateDir("rules"), "public-text.json");
writeFileSync(RULES_FILE, JSON.stringify(RULES), { mode: 0o644 });
const CONFIG_ENV = {
  GITHUB_APP_CLIENT_ID: CLIENT_ID,
  GITHUB_REVIEW_REPOS: `${INSTALLATION}:${REPO},77:example-org/other`,
  GITHUB_REVIEW_OWN_LOGINS: BOT_LOGIN,
  GITHUB_REVIEW_OWN_EMAILS: BOT_EMAIL,
  GITHUB_REVIEW_PUBLIC_TEXT_FILE: RULES_FILE,
};
const CONFIG = { ...parseConfig(CONFIG_ENV), rules: parseRules(JSON.stringify(RULES)) };

const outputs = []; // every answer, stderr and stdout these tests saw, for the leak check
const cleanups = [];
let gh;
before(async () => {
  gh = await standInGitHub();
});
after(async () => {
  for (const c of cleanups.reverse()) await c();
  await gh.close();
  rmSync(PRIVATE, { recursive: true, force: true });
  const text = outputs.join("\n");
  assert.ok(gh.tokens.length > 0 && gh.jwts.length > 0, "the stand-in handed out tokens and saw JWTs");
  for (const t of gh.tokens) {
    assert.ok(!text.includes(t), "a token leaked into an answer or a log");
    // A stateless token's parts, each long enough to be a leak on its own.
    for (const part of t.split(".")) if (part.length >= 20) assert.ok(!text.includes(part), "a part of a token leaked into an answer or a log");
  }
  for (const j of gh.jwts) assert.ok(!text.includes(j.split(".")[2]), "a JWT leaked into an answer or a log");
  assert.ok(!text.includes(KEY_BODY), "the App key leaked into an answer or a log");
});

// ---------------------------------------------------------------- the stand-in for GitHub

/** Why a JWT is not one the App's key made just now, or null. */
function jwtProblem(jwt, { publicKey = KEY, clientId = CLIENT_ID } = {}) {
  const parts = String(jwt).split(".");
  if (parts.length !== 3) return "not three parts";
  const [h, p, s] = parts;
  if (!verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"))) return "bad signature";
  const head = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
  const body = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  if (head.alg !== "RS256" || head.typ !== "JWT") return "not RS256";
  if (body.iss !== clientId) return "another issuer";
  const now = Math.floor(Date.now() / 1000);
  if (!(body.iat <= now - 55 && body.iat >= now - 65)) return "iat not set back a minute";
  if (!(body.exp > now && body.exp - body.iat <= 600)) return "exp over GitHub's 10 minutes";
  if (Object.keys(body).sort().join() !== "exp,iat,iss") return "other claims";
  return null;
}

/**
 * GitHub as these tests need it. `gh.set({...})` changes what it answers;
 * `gh.reset()` puts the defaults back and forgets what it saw.
 */
async function standInGitHub() {
  const seen = [];
  const tokens = [];
  const jwts = [];
  const revoked = new Set();
  const stalled = [];
  let mark = 0; // tokens.length at the last reset
  let s;
  const defaults = () => ({
    tokenStatus: 201,
    tokenForm: "stateless", // as GitHub hands them out now; "legacy": 40 characters
    tokenValue: null, // a token to hand out as it is, instead of one of tokenForm
    // What the installation holds: a reviewer App needs contents:write there
    // for its approval to count. A token gets what it asks for of that (all
    // of it when it asks for nothing, as GitHub does), and metadata:read.
    installation: { pull_requests: "write", contents: "write", metadata: "read" },
    permissions: null, // null: as above
    selection: "selected",
    tokenRepos: null, // null: the one repo asked for
    pr: { state: "open", head: HEAD, base: REPO, title: "Add a thing", draft: false, labels: [], author: BUILDER_LOGIN, private: false },
    commits: null, // null: one commit, the head, by the builder; else [{ sha, email, login }]
    commitsCount: null, // null: as many as listed
    commitsStatus: 200,
    prStatus: 200,
    prAfterReview: null, // changes to the pull request right after the review is posted
    reviewStatus: 200,
    reviewMessage: "Validation Failed",
    headAfterReview: null, // a push right after the review is posted
    stallReview: false, // the review is never answered
    appClientId: CLIENT_ID,
  });
  s = defaults();
  const send = (res, status, json) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(json === undefined ? "" : JSON.stringify(json));
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const auth = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      const rec = { method: req.method, path: req.url, body: text ? JSON.parse(text) : undefined, version: req.headers["x-github-api-version"] };
      seen.push(rec);
      const asApp = () => {
        jwts.push(auth);
        const why = jwtProblem(auth);
        rec.jwt = why ?? "ok";
        return why === null;
      };
      const asToken = () => tokens.includes(auth) && !revoked.has(auth);
      let m;
      if (req.method === "POST" && (m = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(req.url))) {
        if (!asApp()) return send(res, 401, { message: "A JSON web token could not be decoded" });
        if (s.tokenStatus !== 201) return send(res, s.tokenStatus, { message: "There is at least one repository that does not exist or is not accessible to the parent installation." });
        const token = s.tokenValue ?? (s.tokenForm === "legacy" ? legacyToken() : statelessToken());
        tokens.push(token);
        const names = s.tokenRepos ?? (rec.body?.repositories ?? []).map((n) => `example-org/${n}`);
        const asked = rec.body?.permissions;
        const granted = asked
          ? { ...Object.fromEntries(Object.entries(asked).filter(([k, v]) => s.installation[k] === "write" || v === "read")), metadata: "read" }
          : { ...s.installation };
        return send(res, 201, {
          token,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: s.permissions ?? granted,
          repository_selection: rec.body?.repositories ? s.selection : "all",
          repositories: names.map((full_name) => ({ full_name, name: full_name.split("/")[1] })),
        });
      }
      const listed = () => s.commits ?? [{ sha: s.pr.head, email: BUILDER_EMAIL, login: BUILDER_LOGIN }];
      if (req.method === "GET" && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/commits\?per_page=100$/.test(req.url)) {
        if (!asToken()) return send(res, 401, { message: "Bad credentials" });
        if (s.commitsStatus !== 200) return send(res, s.commitsStatus, { message: "Resource not accessible by integration" });
        return send(
          res,
          200,
          listed().map((c) => ({ sha: c.sha, commit: { author: { name: "Example", email: c.email } }, author: c.login ? { login: c.login } : null })),
        );
      }
      if (req.method === "GET" && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(req.url)) {
        if (!asToken()) return send(res, 401, { message: "Bad credentials" });
        if (s.prStatus !== 200) return send(res, s.prStatus, { message: "Not Found" });
        return send(res, 200, {
          number: 1,
          state: s.pr.state,
          head: { sha: s.pr.head },
          base: { repo: { full_name: s.pr.base, private: s.pr.private } },
          title: s.pr.title,
          draft: s.pr.draft,
          labels: s.pr.labels,
          user: { login: s.pr.author },
          commits: s.commitsCount ?? listed().length,
        });
      }
      if (req.method === "POST" && /^\/repos\/[^/]+\/[^/]+\/pulls\/\d+\/reviews$/.test(req.url)) {
        if (!asToken()) return send(res, 401, { message: "Bad credentials" });
        if (s.stallReview) return stalled.push(res);
        if (s.reviewStatus !== 200) return send(res, s.reviewStatus, { message: s.reviewMessage });
        const state = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[rec.body.event];
        if (s.headAfterReview) s.pr = { ...s.pr, head: s.headAfterReview };
        if (s.prAfterReview) s.pr = { ...s.pr, ...s.prAfterReview };
        return send(res, 200, { id: 9001, state, commit_id: rec.body.commit_id, html_url: `https://github.com${req.url.replace(/^\/repos/, "").replace(/\/reviews$/, "")}#pullrequestreview-9001` });
      }
      if (req.method === "DELETE" && req.url === "/installation/token") {
        if (!asToken()) return send(res, 401, { message: "Bad credentials" });
        revoked.add(auth);
        return send(res, 204);
      }
      if (req.method === "GET" && req.url === "/app") {
        if (!asApp()) return send(res, 401, { message: "A JSON web token could not be decoded" });
        return send(res, 200, { id: 31337, slug: "review-bot", client_id: s.appClientId, owner: { login: "example-org" }, permissions: { pull_requests: "write", metadata: "read" } });
      }
      send(res, 404, { message: "Not Found" });
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    seen,
    tokens,
    jwts,
    revoked,
    set: (o) => Object.assign(s, o),
    defaults,
    reset: () => {
      s = defaults();
      seen.length = 0;
      mark = tokens.length;
      for (const r of stalled.splice(0)) r.destroy();
    },
    calls: () => seen.map((r) => `${r.method} ${r.path}`),
    unrevoked: () => tokens.slice(mark).filter((t) => !revoked.has(t)), // since the last reset
    close: () =>
      new Promise((r) => {
        for (const x of stalled.splice(0)) x.destroy();
        server.close(r);
        server.closeAllConnections();
      }),
  };
}

// ---------------------------------------------------------------- the stand-in for systemd

const SD_WRAP = 'export LISTEN_PID=$$; exec "$0" "$@"'; // systemd sets LISTEN_PID to the server's own pid
const envOf = (...parts) => Object.fromEntries(Object.entries(Object.assign({}, ...parts)).filter(([, v]) => v !== undefined));
const BASE_ENV = { PATH: process.env.PATH, GP_TEST_SERVE_TRUST_OWN_UID: "1" };

/**
 * The key service's socket: each connection starts `github-review.mjs serve`
 * with the connection on stdin and stdout and the key file opened for it, as
 * systemd 255 to 258 hand it over (LISTEN_FDS=1, LISTEN_FDNAMES=connection:github-app-key),
 * or 259 and later (`names`).
 */
async function keyService({ env = {}, keyFile = KEY_FILE, names = "connection:github-app-key", args = [] } = {}) {
  const dir = privateDir("sock");
  const path = join(dir, SOCKET_NAME);
  const errs = [];
  const children = new Set();
  const server = createServer({ pauseOnConnect: true }, (conn) => {
    const keyFd = openSync(keyFile, "r");
    const child = spawn("/bin/sh", ["-c", SD_WRAP, SERVE_NODE, ...args, SERVE_MODULE, "serve"], {
      stdio: [conn, conn, "pipe", keyFd],
      detached: true,
      env: envOf(BASE_ENV, CONFIG_ENV, { LISTEN_FDS: "1", LISTEN_FDNAMES: names, GP_TEST_GITHUB_API: gh.origin }, env),
    });
    closeSync(keyFd);
    conn.destroy();
    children.add(child);
    const chunks = [];
    child.stderr.on("data", (c) => chunks.push(c));
    errs.push(() => Buffer.concat(chunks).toString("utf8"));
    child.on("exit", () => children.delete(child));
  });
  await new Promise((r) => server.listen(path, r));
  const ks = {
    dir,
    stderr: () => errs.map((f) => f()).join(""),
    close: async () => {
      for (const c of children) {
        try {
          process.kill(-c.pid, "SIGKILL");
        } catch {
          // gone
        }
      }
      await new Promise((r) => server.close(r));
      outputs.push(ks.stderr());
    },
  };
  cleanups.push(ks.close);
  return ks;
}

const reviewRequest = (o = {}) => ({ action: "review", repo: REPO, pr: 12, head_sha: HEAD, event: "APPROVE", body: "Looks right.", ...o });
async function ask(ks, request) {
  const a = await call(ks.dir, request, { timeoutMs: 30_000 });
  outputs.push(JSON.stringify(a));
  return a;
}

// ---------------------------------------------------------------- the request and the settings

test("parseRequest: a review takes exactly its fields, each checked", () => {
  const ok = parseRequest(JSON.stringify(reviewRequest()));
  assert.deepEqual(ok, { action: "review", repo: REPO, pr: 12, headSha: HEAD, event: "APPROVE", body: "Looks right." });
  assert.deepEqual(parseRequest(JSON.stringify(reviewRequest({ event: "COMMENT", body: "x" }))).event, "COMMENT");
  assert.deepEqual(parseRequest(JSON.stringify(reviewRequest({ body: "" }))).body, "", "an APPROVE needs no body");
  assert.deepEqual(parseRequest('{"action":"fingerprint"}'), { action: "fingerprint" });
  assert.deepEqual(parseRequest('{"action":"app"}'), { action: "app" });
  const bad = [
    ["not JSON", "review please"],
    ["an array", "[1]"],
    ["null", "null"],
    ["no action", JSON.stringify({ repo: REPO })],
    ["another action", JSON.stringify({ action: "merge" })],
    ["a prototype's name", JSON.stringify({ action: "constructor" })],
    ["update-branch", JSON.stringify({ action: "update-branch", repo: REPO, pr: 1 })],
    ["an extra field (an installation)", JSON.stringify({ ...reviewRequest(), installation: 1 })],
    ["a missing field", JSON.stringify({ action: "review", repo: REPO, pr: 1, head_sha: HEAD, event: "APPROVE" })],
    ["a field on fingerprint", JSON.stringify({ action: "fingerprint", repo: REPO })],
    ["repo without owner", JSON.stringify(reviewRequest({ repo: "review-target" }))],
    ["repo with a path", JSON.stringify(reviewRequest({ repo: "example-org/review-target/pulls" }))],
    ["repo ..", JSON.stringify(reviewRequest({ repo: "example-org/.." }))],
    ["repo .", JSON.stringify(reviewRequest({ repo: "example-org/." }))],
    ["owner starting with -", JSON.stringify(reviewRequest({ repo: "-x/y" }))],
    ["owner too long", JSON.stringify(reviewRequest({ repo: `${"a".repeat(40)}/y` }))],
    ["repo with %", JSON.stringify(reviewRequest({ repo: "example-org/a%2fb" }))],
    ["pr 0", JSON.stringify(reviewRequest({ pr: 0 }))],
    ["pr negative", JSON.stringify(reviewRequest({ pr: -3 }))],
    ["pr a fraction", JSON.stringify(reviewRequest({ pr: 1.5 }))],
    ["pr a string", JSON.stringify(reviewRequest({ pr: "12" }))],
    ["pr too large", JSON.stringify(reviewRequest({ pr: 2 ** 31 }))],
    ["sha short", JSON.stringify(reviewRequest({ head_sha: HEAD.slice(0, 12) }))],
    ["sha upper-case", JSON.stringify(reviewRequest({ head_sha: HEAD.toUpperCase().replace(/^[0-9]/, "A") }))],
    ["sha a branch name", JSON.stringify(reviewRequest({ head_sha: "main" }))],
    ["event PENDING", JSON.stringify(reviewRequest({ event: "PENDING" }))],
    ["event lower-case", JSON.stringify(reviewRequest({ event: "approve" }))],
    ["event DISMISS", JSON.stringify(reviewRequest({ event: "DISMISS" }))],
    ["REQUEST_CHANGES with no body", JSON.stringify(reviewRequest({ event: "REQUEST_CHANGES", body: "  " }))],
    ["COMMENT with no body", JSON.stringify(reviewRequest({ event: "COMMENT", body: "" }))],
    ["a body not text", JSON.stringify(reviewRequest({ body: 5 }))],
    ["a body over the cap", JSON.stringify(reviewRequest({ body: "é".repeat(MAX_BODY / 2 + 1) }))],
    ["a body with a NUL", JSON.stringify(reviewRequest({ body: "a\u0000b" }))],
  ];
  for (const [what, line] of bad) assert.throws(() => parseRequest(line), Refusal, what);
  assert.doesNotThrow(() => parseRequest(JSON.stringify(reviewRequest({ body: "a".repeat(MAX_BODY) }))), "a body at the cap");
});

test("parseConfig: the client ID and the allowlist, each entry naming its installation", () => {
  assert.equal(CONFIG.clientId, CLIENT_ID);
  assert.deepEqual(CONFIG.repos.get(REPO), { installation: INSTALLATION, owner: "example-org", name: "review-target" });
  assert.equal(parseConfig({ ...CONFIG_ENV, GITHUB_REVIEW_REPOS: "9:Example-Org/Mixed.Case_name" }).repos.get("example-org/mixed.case_name").name, "Mixed.Case_name");
  const bad = [
    ["no client ID", { GITHUB_REVIEW_REPOS: CONFIG_ENV.GITHUB_REVIEW_REPOS }],
    ["an App id instead of a client ID", { ...CONFIG_ENV, GITHUB_APP_CLIENT_ID: "123456" }],
    ["a client ID with a space", { ...CONFIG_ENV, GITHUB_APP_CLIENT_ID: "Iv23li abc def" }],
    ["no repos", { ...CONFIG_ENV, GITHUB_REVIEW_REPOS: "" }],
    ["a repo with no installation", { ...CONFIG_ENV, GITHUB_REVIEW_REPOS: REPO }],
    ["an installation 0", { ...CONFIG_ENV, GITHUB_REVIEW_REPOS: `0:${REPO}` }],
    ["an installation with letters", { ...CONFIG_ENV, GITHUB_REVIEW_REPOS: `12a:${REPO}` }],
    ["a repo ..", { ...CONFIG_ENV, GITHUB_REVIEW_REPOS: "1:example-org/.." }],
    ["an empty entry", { ...CONFIG_ENV, GITHUB_REVIEW_REPOS: `1:${REPO},` }],
    ["a repo twice, in another case", { ...CONFIG_ENV, GITHUB_REVIEW_REPOS: `1:${REPO},2:${REPO.toUpperCase()}` }],
    ["over 100 repos", { ...CONFIG_ENV, GITHUB_REVIEW_REPOS: Array.from({ length: 101 }, (_, i) => `1:o/r${i}`).join(",") }],
  ];
  for (const [what, env] of bad) assert.throws(() => parseConfig(env), Refusal, what);
});

// ---------------------------------------------------------------- the key and the JWT

test("parseAppKey: one PEM block, an RSA key of 2048 bits or more, not encrypted", () => {
  const ok = parseAppKey(Buffer.from(KEY_PEM));
  assert.equal(fingerprint(ok), fingerprint(KEY));
  assert.doesNotThrow(() => parseAppKey(Buffer.from(pemOf(2048, "pkcs8"))), "PKCS#8 too");
  const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });
  const enc = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "x" });
  const pub = createPublicKey(KEY).export({ type: "spki", format: "pem" });
  const lines = KEY_PEM.trim().split("\n");
  const cut = [...lines.slice(0, 4), ...lines.slice(-3)].join("\n");
  for (const [what, text] of [
    ["1024 bits", pemOf(1024)],
    ["an EC key", ec],
    ["an encrypted key", enc],
    ["two keys", KEY_PEM + OTHER_PEM],
    ["no PEM", "not a key"],
    ["a public key", pub],
    ["a PEM with its middle cut out", cut],
  ]) {
    assert.throws(() => parseAppKey(Buffer.from(text)), Refusal, what);
  }
});

test("fingerprint: GitHub's form, SHA-256 of the public key's DER in base64, as openssl gives it", { skip: spawnSync("openssl", ["version"]).status !== 0 && "no openssl" }, () => {
  const der = spawnSync("openssl", ["rsa", "-pubout", "-outform", "DER"], { input: KEY_PEM });
  assert.equal(der.status, 0);
  assert.equal(fingerprint(KEY), `SHA256:${createHash("sha256").update(der.stdout).digest("base64")}`);
});

test("makeJwt: RS256, signed by the App key, iss the client ID, iat a minute back, exp under ten minutes", () => {
  const jwt = makeJwt(KEY, CLIENT_ID, Date.now());
  assert.equal(jwtProblem(jwt), null);
  assert.equal(jwtProblem(makeJwt(createPrivateKey(OTHER_PEM), CLIENT_ID, Date.now())), "bad signature");
  assert.equal(jwtProblem(makeJwt(KEY, "Iv23liother", Date.now())), "another issuer");
});

test("tokenProblem: only a token for that one repo, with pull_requests:write and at most metadata:read", () => {
  const entry = CONFIG.repos.get(REPO);
  const good = { token: `ghs_${"x".repeat(36)}`, permissions: { pull_requests: "write", metadata: "read" }, repository_selection: "selected", repositories: [{ full_name: REPO }] };
  assert.equal(tokenProblem(good, entry), null);
  assert.equal(tokenProblem({ ...good, permissions: { pull_requests: "write" } }, entry), null);
  for (const [what, j] of [
    ["contents:write", { ...good, permissions: { ...good.permissions, contents: "write" } }],
    ["contents:read", { ...good, permissions: { ...good.permissions, contents: "read" } }],
    ["metadata:write", { ...good, permissions: { pull_requests: "write", metadata: "write" } }],
    ["pull_requests:read", { ...good, permissions: { pull_requests: "read" } }],
    ["no permissions", { ...good, permissions: undefined }],
    ["every repo", { ...good, repository_selection: "all" }],
    ["two repos", { ...good, repositories: [{ full_name: REPO }, { full_name: "example-org/other" }] }],
    ["another repo", { ...good, repositories: [{ full_name: "example-org/other" }] }],
    ["no repositories", { ...good, repositories: undefined }],
    ["no token", { ...good, token: undefined }],
  ]) {
    assert.match(tokenProblem(j, entry) ?? "", /GitHub's/, what);
  }
});

test("tokenProblem: a token is an opaque string; a stateless one (about 520 characters, dotted) and a 40-character one both pass", () => {
  const entry = CONFIG.repos.get(REPO);
  const answer = (token) => ({ token, permissions: { pull_requests: "write", metadata: "read" }, repository_selection: "selected", repositories: [{ full_name: REPO }] });
  for (let i = 0; i < 20; i++) {
    const t = statelessToken();
    assert.ok(t.length > 255 && t.length >= 500 && t.length <= 560, `a stateless token is about 520 characters (${t.length})`);
    const rest = t.slice(GHS.length);
    assert.ok(t.startsWith(`${GHS}${APP_ID}_`), "ghs_, the App's id and an _");
    assert.ok(rest.split(".").length === 3 && rest.includes("-") && rest.includes("_"), "after ghs_: two dots, a - and a _");
    assert.equal(tokenProblem(answer(t), entry), null, "a stateless token");
  }
  assert.equal(legacyToken().length, 40);
  assert.equal(tokenProblem(answer(legacyToken()), entry), null, "a 40-character token");
  const of = (n) => "a".repeat(n);
  assert.equal(tokenProblem(answer(of(20)), entry), null, "20 characters, no prefix: opaque");
  assert.equal(tokenProblem(answer(`${GHS}${of(MAX_TOKEN - 4)}`), entry), null, `${MAX_TOKEN} characters`);
  assert.equal(tokenProblem(answer("a.b-c_d.e-f_g.h-i_j.k"), entry), null, "any number of dots, or none");
  for (const [what, t] of [
    ["19 characters", of(19)],
    [`${MAX_TOKEN + 1} characters`, `${GHS}${of(MAX_TOKEN - 3)}`],
    ["5000 characters", `${GHS}${of(4996)}`],
    ["a space", `${GHS}${of(20)} ${of(20)}`],
    ["a newline", `${GHS}${of(20)}\n${of(20)}`],
    ["a carriage return", `${GHS}${of(20)}\r${of(20)}`],
    ["a tab", `${GHS}${of(20)}\t${of(20)}`],
    ["a NUL", `${GHS}${of(20)}\u0000${of(20)}`],
    ["a leading space", ` ${GHS}${of(36)}`],
    ["a trailing newline", `${GHS}${of(36)}\n`],
    ["a letter outside ASCII", `${GHS}${of(20)}\u00e9${of(20)}`],
    ['a "', `${GHS}${of(20)}"${of(20)}`],
    ["a :", `${GHS}${of(20)}:${of(20)}`],
  ]) {
    const why = tokenProblem(answer(t), entry);
    assert.match(why ?? "", /^GitHub's token is not one this key service takes \(20 to 4096 characters of letters, digits, _, \. and -; it had \d+\)$/, what);
    assert.ok(!why.includes(t.slice(0, 20)), `${what}: the reason holds no part of the token`);
  }
  for (const [what, json] of [
    ["an empty token", answer("")],
    ["a token that is a number", answer(12345678901234567890)],
    ["a token that is a list", answer(["a".repeat(40)])],
    ["no answer", null],
  ]) {
    assert.equal(tokenProblem(json, entry), "GitHub's answer held no token", what);
  }
});

// ---------------------------------------------------------------- the action, against a fake

/**
 * A fake GitHub for review()/app(): records each call and answers from
 * `answers` by method and path. Its token is a stateless one, as GitHub hands
 * them out now, unless `token` gives another.
 */
const prJson = (o = {}) => ({
  state: "open",
  head: { sha: HEAD },
  base: { repo: { full_name: REPO, private: false } },
  title: "Add a thing",
  draft: false,
  labels: [],
  user: { login: BUILDER_LOGIN },
  commits: 1,
  ...o,
});
const commitJson = (commitSha, o = {}) => ({ sha: commitSha, commit: { author: { name: "Example", email: BUILDER_EMAIL } }, author: { login: BUILDER_LOGIN }, ...o });
function fakeApi(answers = {}, { token = statelessToken() } = {}) {
  const calls = [];
  const def = {
    token: { status: 201, json: { token, permissions: { pull_requests: "write", metadata: "read" }, repository_selection: "selected", repositories: [{ full_name: REPO }] } },
    pr: { status: 200, json: prJson() },
    commits: { status: 200, json: [commitJson(HEAD)] },
    prAfter: null, // the second read of the pull request (null: as the first)
    review: { status: 200, json: { id: 5, state: "APPROVED", commit_id: HEAD, html_url: `https://github.com/${REPO}/pull/12#pullrequestreview-5` } },
    revoke: { status: 204, json: null },
    app: { status: 200, json: { id: 3, slug: "review-bot", client_id: CLIENT_ID, owner: { login: "example-org" }, permissions: { pull_requests: "write" } } },
    ...answers,
  };
  let prReads = 0;
  const api = async (r) => {
    calls.push(r);
    if (r.path.endsWith("/access_tokens")) return def.token;
    if (r.path.endsWith("/reviews")) return def.review;
    if (r.path.endsWith("/commits?per_page=100")) return def.commits;
    if (r.path.includes("/pulls/")) return (prReads += 1) > 1 && def.prAfter ? def.prAfter : def.pr;
    if (r.path === "/installation/token") return def.revoke;
    if (r.path === "/app") return def.app;
    throw new Error(`unexpected call ${r.method} ${r.path}`);
  };
  return { api, calls, token, shape: () => calls.map((c) => `${c.method} ${c.path}`) };
}
const deps = (fake, o = {}) => {
  const d = { config: CONFIG, api: fake.api, keyReads: 0, ledgered: [], ...o };
  d.loadKey = () => {
    d.keyReads += 1;
    return KEY;
  };
  d.ledger = (f) => d.ledgered.push(f);
  return d;
};
const req = (o = {}) => parseRequest(JSON.stringify(reviewRequest(o)));
const TOKEN_CALL = `POST /app/installations/${INSTALLATION}/access_tokens`;
const PR_CALL = "GET /repos/example-org/review-target/pulls/12";
const COMMITS_CALL = "GET /repos/example-org/review-target/pulls/12/commits?per_page=100";
const REVIEW_CALL = "POST /repos/example-org/review-target/pulls/12/reviews";
const REVOKE_CALL = "DELETE /installation/token";
const FULL = [TOKEN_CALL, PR_CALL, COMMITS_CALL, REVIEW_CALL, PR_CALL, REVOKE_CALL];

test("review: one token for the one repo, the pull request, the review pinned to its head, the token revoked; nothing else", async () => {
  const fake = fakeApi();
  const d = deps(fake);
  const a = await review(req(), d);
  assert.equal(a.ok, true, a.error);
  assert.deepEqual(fake.shape(), FULL);
  assert.deepEqual(fake.calls[0].body, { repositories: ["review-target"], permissions: { pull_requests: "write" } });
  assert.equal(jwtProblem(fake.calls[0].auth), null, "the token was asked for with the App's JWT");
  for (const c of fake.calls.slice(1)) assert.equal(c.auth, fake.token, "then everything with the token");
  assert.deepEqual(fake.calls[3].body, { commit_id: HEAD, event: "APPROVE", body: "Looks right." });
  assert.deepEqual(a.review, { id: 5, state: "APPROVED", commit_id: HEAD, html_url: `https://github.com/${REPO}/pull/12#pullrequestreview-5` });
  const text = JSON.stringify([a, d.ledgered]);
  assert.ok(!text.includes(fake.token) && !text.includes(fake.calls[0].auth), "no token or JWT in the answer or the ledger");
  assert.equal(d.ledgered.length, 1);
  assert.equal(d.ledgered[0].result, "posted");
  assert.equal(d.ledgered[0].token_revoked, true);
  assert.equal(d.ledgered[0].body_sha256, createHash("sha256").update("Looks right.").digest("hex"));
});

test("review: the token is asked for pull_requests:write alone, for the one repo; never contents, whatever the App holds", async () => {
  // A reviewer App holds contents:write on its installation (its approval
  // counts only then), so a token asked for anything more, or for nothing
  // (all the App holds), could push. The action asks for exactly this.
  const fake = fakeApi();
  await review(req(), deps(fake));
  const asked = fake.calls[0].body;
  assert.deepEqual(Object.keys(asked).sort(), ["permissions", "repositories"]);
  assert.deepEqual(asked.permissions, { pull_requests: "write" });
  assert.ok(!("contents" in asked.permissions), "contents is never asked for");
  assert.deepEqual(asked.repositories, ["review-target"]);
  for (const event of ["REQUEST_CHANGES", "COMMENT"]) {
    const f = fakeApi();
    await review(req({ event, body: "x" }), deps(f, { config: { ...CONFIG, allowComment: true } }));
    assert.deepEqual(f.calls[0].body.permissions, { pull_requests: "write" }, event);
  }
});

test("review: an APPROVE with no body sends none; the installation and the path's case come from the allowlist", async () => {
  const fake = fakeApi();
  const a = await review(req({ body: "", repo: "Example-Org/Review-Target" }), deps(fake));
  assert.equal(a.ok, true, a.error);
  assert.deepEqual(fake.shape(), FULL);
  assert.deepEqual(fake.calls[3].body, { commit_id: HEAD, event: "APPROVE" });
});

test("review: a repo off the allowlist is refused before the key is read or GitHub is asked anything", async () => {
  const fake = fakeApi();
  const d = deps(fake);
  const a = await review(req({ repo: "example-org/not-listed" }), d);
  assert.deepEqual(a, { ok: false, check: "repo", error: "example-org/not-listed is not on this key service's list" });
  assert.deepEqual(fake.calls, []);
  assert.equal(d.keyReads, 0);
  assert.equal(d.ledgered[0].result, "refused");
  assert.equal(d.ledgered[0].check, "repo");
});

test("review: a head that moved, a closed pull request, or one in another repo: no review, and the token revoked", async () => {
  for (const [what, pr, check, why] of [
    ["the head moved", prJson({ head: { sha: sha() } }), "head", /head is [0-9a-f]{40}, not [0-9a-f]{40}: read it again/],
    ["no head", prJson({ head: undefined }), "head", /head is unknown/],
    ["closed", prJson({ state: "closed" }), "open", /is not open/],
    ["another repo", prJson({ base: { repo: { full_name: "example-org/other" } } }), "repo", /in another repo/],
  ]) {
    const fake = fakeApi({ pr: { status: 200, json: pr } });
    const a = await review(req(), deps(fake));
    assert.equal(a.ok, false, what);
    assert.equal(a.check, check, what);
    assert.match(a.error, why, what);
    assert.deepEqual(fake.shape(), [TOKEN_CALL, PR_CALL, REVOKE_CALL], what);
  }
  const fake = fakeApi({ pr: { status: 404, json: { message: "Not Found" } } });
  const a = await review(req(), deps(fake));
  assert.match(a.error, /could not read pull request 12 \(HTTP 404: Not Found\)/);
  assert.deepEqual(fake.shape(), [TOKEN_CALL, PR_CALL, REVOKE_CALL]);
});

test("review: a token wider than asked for is refused, never used, and revoked", async () => {
  for (const [what, json, token] of [
    ["contents:write", { permissions: { pull_requests: "write", metadata: "read", contents: "write" } }, statelessToken()],
    ["every repo", { repository_selection: "all" }, statelessToken()],
    ["two repos", { repositories: [{ full_name: REPO }, { full_name: "example-org/other" }] }, statelessToken()],
    ["contents:write, a 40-character token", { permissions: { pull_requests: "write", metadata: "read", contents: "write" } }, legacyToken()],
  ]) {
    const t = { status: 201, json: { token, permissions: { pull_requests: "write", metadata: "read" }, repository_selection: "selected", repositories: [{ full_name: REPO }], ...json } };
    const f2 = fakeApi({ token: t });
    const a = await review(req(), deps(f2));
    assert.equal(a.ok, false, what);
    assert.match(a.error, /GitHub's token/, what);
    assert.deepEqual(f2.shape(), [TOKEN_CALL, REVOKE_CALL], `${what}: only revoked`);
    assert.equal(f2.calls[1].auth, token, `${what}: the token it was given is revoked`);
    const d = deps(fakeApi({ token: t }));
    const again = await review(req(), d);
    assert.ok(!JSON.stringify([again, d.ledgered]).includes(token), `${what}: the token is in neither the answer nor the ledger`);
    assert.equal(d.ledgered[0].token_revoked, true, `${what}: the ledger says it was revoked`);
  }
});

/** A token answer like GitHub's, for the one repo, with `token` as given. */
const tokenAnswer = (token) => ({
  status: 201,
  json: { token, permissions: { pull_requests: "write", metadata: "read" }, repository_selection: "selected", repositories: [{ full_name: REPO }] },
});

test("review: a stateless token and a 40-character one, each through the whole flow", async () => {
  for (const [what, token] of [
    ["stateless", statelessToken()],
    ["40 characters", legacyToken()],
  ]) {
    const fake = fakeApi({}, { token });
    const d = deps(fake);
    const a = await review(req(), d);
    assert.equal(a.ok, true, `${what}: ${a.error}`);
    assert.deepEqual(fake.shape(), FULL, what);
    for (const c of fake.calls.slice(1)) assert.equal(c.auth, token, `${what}: everything after the mint with the token, as it came`);
    assert.equal(d.ledgered[0].result, "posted", what);
    assert.equal(d.ledgered[0].token_revoked, true, what);
    const text = JSON.stringify([a, d.ledgered]);
    for (const part of [token, ...token.split(".")]) assert.ok(!text.includes(part), `${what}: no token, nor a part of one, in the answer or the ledger`);
  }
});

test("review: a token refused for its form is revoked when it can be sent back as it is, and never sent when it cannot", async () => {
  const body = (n) => randomBytes(n).toString("base64url").replace(/[-_]/g, "x").slice(0, n);
  // Each refused before anything is read with it, then revoked with it.
  for (const [what, token] of [
    ["5000 characters", `${GHS}${body(4996)}`],
    [`${MAX_TOKEN + 1} characters`, `${GHS}${body(MAX_TOKEN - 3)}`],
    ["19 characters", `${GHS}${body(15)}`],
    ['a "', `${GHS}${body(30)}"${body(10)}`],
    ["a +, a / and an = (base64, not base64url)", `${GHS}${body(30)}+/${body(10)}=`],
  ]) {
    const fake = fakeApi({ token: tokenAnswer(token) });
    const d = deps(fake);
    const a = await review(req(), d);
    assert.equal(a.ok, false, what);
    assert.match(a.error, /GitHub's token is not one this key service takes \(20 to 4096 characters of letters, digits, _, \. and -; it had \d+\)/, what);
    assert.deepEqual(fake.shape(), [TOKEN_CALL, REVOKE_CALL], `${what}: refused, then revoked`);
    assert.equal(fake.calls[1].auth, token, `${what}: revoked with the token it was given`);
    assert.equal(d.ledgered[0].result, "refused", what);
    assert.equal(d.ledgered[0].token_revoked, true, `${what}: the ledger says it was revoked`);
    assert.ok(!JSON.stringify([a, d.ledgered]).includes(token), `${what}: the token is in neither the answer nor the ledger`);
  }
  // Each refused and never sent anywhere: node would refuse it in a header,
  // or it would change what the header says.
  for (const [what, token] of [
    ["a space", `${GHS}${body(30)} ${body(10)}`],
    ["a newline", `${GHS}${body(30)}\n${body(10)}`],
    ["a carriage return and a header after it", `${GHS}${body(30)}\r\nX-Injected: 1`],
    ["a tab", `${GHS}${body(30)}\t${body(10)}`],
    ["a NUL", `${GHS}${body(30)}\u0000${body(10)}`],
    ["a letter outside ASCII", `${GHS}${body(30)}\u00e9${body(10)}`],
  ]) {
    const fake = fakeApi({ token: tokenAnswer(token) });
    const d = deps(fake);
    const a = await review(req(), d);
    assert.equal(a.ok, false, what);
    assert.match(a.error, /GitHub's token is not one this key service takes/, what);
    assert.deepEqual(fake.shape(), [TOKEN_CALL], `${what}: never sent`);
    assert.equal(d.ledgered[0].token_revoked, false, `${what}: the ledger says it was not revoked`);
  }
  // An answer with no token at all: nothing to send back, and the ledger says so.
  for (const [what, json] of [
    ["no token", { permissions: { pull_requests: "write" } }],
    ["an empty token", { token: "" }],
    ["a token that is a number", { token: 12345678901234567890 }],
    ["no JSON", null],
  ]) {
    const fake = fakeApi({ token: { status: 201, json } });
    const d = deps(fake);
    const a = await review(req(), d);
    assert.match(a.error, /GitHub's answer held no token/, what);
    assert.deepEqual(fake.shape(), [TOKEN_CALL], what);
    assert.equal(d.ledgered[0].token_revoked, false, what);
  }
  // A revoke GitHub does not take is in the ledger as not revoked.
  const fake = fakeApi({ token: tokenAnswer(`${GHS}${body(4996)}`), revoke: { status: 401, json: { message: "Bad credentials" } } });
  const d = deps(fake);
  await review(req(), d);
  assert.deepEqual(fake.shape(), [TOKEN_CALL, REVOKE_CALL]);
  assert.equal(d.ledgered[0].token_revoked, false);
});

test("review: every way out once GitHub made a token revokes it, and the ledger says so; before that, the ledger has no token_revoked", async () => {
  const other = prJson();
  for (const [what, answers, body] of [
    ["posted", {}],
    ["a wider token", { token: { status: 201, json: { ...tokenAnswer("").json, permissions: { pull_requests: "write", contents: "write" } } } }],
    ["the pull request not read", { pr: { status: 404, json: { message: "Not Found" } } }],
    ["closed", { pr: { status: 200, json: { ...other, state: "closed" } } }],
    ["the head moved", { pr: { status: 200, json: { ...other, head: { sha: sha() } } } }],
    ["the review not taken", { review: { status: 422, json: { message: "Validation Failed" } } }],
    ["the head moved after the post", { prAfter: { status: 200, json: { ...other, head: { sha: sha() } } } }],
    ["the pull request not read again", { prAfter: { status: 502, json: null } }],
    ["held after the post", { prAfter: { status: 200, json: { ...other, title: "HOLD: wait" } } }],
    ["held", { pr: { status: 200, json: { ...other, title: "HOLD: wait" } } }],
    ["a draft", { pr: { status: 200, json: { ...other, draft: true } } }],
    ["the reviewer's own", { pr: { status: 200, json: { ...other, user: { login: BOT_LOGIN } } } }],
    ["the body fails the rules", {}, FAILS_RULES],
    ["the commits not read", { commits: { status: 403, json: { message: "Resource not accessible by integration" } } }],
    ["an own commit", { commits: { status: 200, json: [commitJson(HEAD, { author: { login: BOT_LOGIN } })] } }],
  ]) {
    const token = statelessToken();
    if (answers.token) answers.token.json.token = token;
    const fake = fakeApi(answers, { token });
    const d = deps(fake);
    await review(req(body ? { body } : {}), d);
    assert.deepEqual(fake.shape().at(-1), REVOKE_CALL, `${what}: revoked last`);
    assert.equal(fake.calls.at(-1).auth, token, `${what}: with the token it was given`);
    assert.equal(d.ledgered.length, 1, what);
    assert.equal(d.ledgered[0].token_revoked, true, `${what}: the ledger says so`);
  }
  for (const [what, answers, request] of [
    ["off the allowlist", {}, req({ repo: "example-org/not-listed" })],
    ["no token made", { token: { status: 422, json: { message: "Unprocessable" } } }, req()],
    ["no answer", { token: { status: 0 } }, req()],
  ]) {
    const d = deps(fakeApi(answers));
    await review(request, d);
    assert.ok(!("token_revoked" in d.ledgered[0]), `${what}: no token was made, so none to revoke`);
  }
});

test("review: no token, or a review GitHub does not take: refused with GitHub's reason", async () => {
  let fake = fakeApi({ token: { status: 422, json: { message: "There is at least one repository that does not exist" } } });
  let a = await review(req(), deps(fake));
  assert.match(a.error, /GitHub gave no token for example-org\/review-target \(HTTP 422: There is at least one repository/);
  assert.deepEqual(fake.shape(), [FULL[0]]);
  fake = fakeApi({ token: { status: 0, json: null } });
  a = await review(req(), deps(fake));
  assert.match(a.error, /\(no answer\)/);
  fake = fakeApi({ review: { status: 422, json: { message: "Unprocessable\nEntity\u0007" } } });
  a = await review(req(), deps(fake));
  assert.match(a.error, /GitHub did not take the review \(HTTP 422: Unprocessable\?Entity\?\)/);
  assert.deepEqual(fake.shape(), [TOKEN_CALL, PR_CALL, COMMITS_CALL, REVIEW_CALL, REVOKE_CALL]);
});

test("review: a head that moved while the review was posted is not ok; the review is named, and the token revoked", async () => {
  const moved = sha();
  let fake = fakeApi({ prAfter: { status: 200, json: prJson({ head: { sha: moved } }) } });
  let d = deps(fake);
  let a = await review(req(), d);
  assert.equal(a.ok, false);
  assert.match(a.error, new RegExp(`the head moved while the review was posted \\(now ${moved}\\): the review is pinned to ${HEAD}`));
  assert.equal(a.review.id, 5, "the review it posted is named");
  assert.deepEqual(fake.shape(), FULL);
  assert.equal(a.check, "head");
  assert.equal(d.ledgered[0].check, "head");
  assert.equal(d.ledgered[0].result, "posted, head moved");
  assert.equal(d.ledgered[0].head_after, moved);
  assert.equal(d.ledgered[0].token_revoked, true);
  fake = fakeApi({ prAfter: { status: 502, json: { message: "Bad Gateway" } } });
  d = deps(fake);
  a = await review(req(), d);
  assert.equal(a.ok, false);
  assert.match(a.error, /could not be read again to check its head \(HTTP 502: Bad Gateway\)/);
  assert.equal(d.ledgered[0].result, "posted, head not read again");
});

// ---------------------------------------------------------------- the limits

test("parseConfig: the own identities are an App's bot, COMMENT is off unless allowed, and the rules file is named", () => {
  assert.deepEqual([...CONFIG.ownLogins], [BOT_LOGIN]);
  assert.deepEqual([...CONFIG.ownEmails], [BOT_EMAIL]);
  assert.equal(CONFIG.allowComment, false, "COMMENT is off when the setting is absent");
  assert.equal(CONFIG.publicTextFile, RULES_FILE);
  assert.equal(parseConfig({ ...CONFIG_ENV, GITHUB_REVIEW_ALLOW_COMMENT: "1" }).allowComment, true);
  assert.equal(parseConfig({ ...CONFIG_ENV, GITHUB_REVIEW_ALLOW_COMMENT: "0" }).allowComment, false);
  const two = parseConfig({ ...CONFIG_ENV, GITHUB_REVIEW_OWN_LOGINS: "Review-Bot[bot],other-bot[bot]", GITHUB_REVIEW_OWN_EMAILS: `${BOT_EMAIL.replace("review-bot", "Review-Bot")},7+other-bot[bot]@users.noreply.github.com` });
  assert.deepEqual([...two.ownLogins], ["review-bot[bot]", "other-bot[bot]"], "kept lower-cased, to be compared so");
  assert.deepEqual([...two.ownEmails], [BOT_EMAIL, "7+other-bot[bot]@users.noreply.github.com"]);
  const bad = [
    ["no own logins", { ...CONFIG_ENV, GITHUB_REVIEW_OWN_LOGINS: undefined }],
    ["empty own logins", { ...CONFIG_ENV, GITHUB_REVIEW_OWN_LOGINS: "" }],
    ["a person as the own login", { ...CONFIG_ENV, GITHUB_REVIEW_OWN_LOGINS: BUILDER_LOGIN }],
    ["a bot and a person", { ...CONFIG_ENV, GITHUB_REVIEW_OWN_LOGINS: `${BOT_LOGIN},${BUILDER_LOGIN}` }],
    ["an empty login entry", { ...CONFIG_ENV, GITHUB_REVIEW_OWN_LOGINS: `${BOT_LOGIN},` }],
    ["a login twice, in another case", { ...CONFIG_ENV, GITHUB_REVIEW_OWN_LOGINS: `${BOT_LOGIN},${BOT_LOGIN.toUpperCase()}` }],
    ["over 10 logins", { ...CONFIG_ENV, GITHUB_REVIEW_OWN_LOGINS: Array.from({ length: 11 }, (_, i) => `bot${i}[bot]`).join(",") }],
    ["no own emails", { ...CONFIG_ENV, GITHUB_REVIEW_OWN_EMAILS: undefined }],
    ["the builders' shared noreply author as an own email", { ...CONFIG_ENV, GITHUB_REVIEW_OWN_EMAILS: BUILDER_EMAIL }],
    ["a bot noreply with no id", { ...CONFIG_ENV, GITHUB_REVIEW_OWN_EMAILS: "review-bot[bot]@users.noreply.github.com" }],
    ["a bot address on another domain", { ...CONFIG_ENV, GITHUB_REVIEW_OWN_EMAILS: "31337+review-bot[bot]@example.com" }],
    ["an email twice", { ...CONFIG_ENV, GITHUB_REVIEW_OWN_EMAILS: `${BOT_EMAIL},${BOT_EMAIL.replace("review-bot", "Review-Bot")}` }],
    ["COMMENT allowed with 2", { ...CONFIG_ENV, GITHUB_REVIEW_ALLOW_COMMENT: "2" }],
    ["COMMENT allowed with true", { ...CONFIG_ENV, GITHUB_REVIEW_ALLOW_COMMENT: "true" }],
    ["COMMENT allowed with nothing", { ...CONFIG_ENV, GITHUB_REVIEW_ALLOW_COMMENT: "" }],
    ["no rules file", { ...CONFIG_ENV, GITHUB_REVIEW_PUBLIC_TEXT_FILE: undefined }],
    ["a relative rules path", { ...CONFIG_ENV, GITHUB_REVIEW_PUBLIC_TEXT_FILE: "public-text.json" }],
    ["a rules path with ..", { ...CONFIG_ENV, GITHUB_REVIEW_PUBLIC_TEXT_FILE: "/etc/../public-text.json" }],
  ];
  for (const [what, env] of bad) assert.throws(() => parseConfig(env), Refusal, what);
});

test("parseRules: a list of {name, pattern}, each compiled, none empty-matching; a refusal names the rule, never the pattern", () => {
  const rules = parseRules(JSON.stringify(RULES));
  assert.deepEqual(rules.map((r) => r.name), ["example-host", "example-ticket", "example-codename"]);
  assert.equal(publicTextProblem("a clean body", rules), null);
  assert.equal(publicTextProblem("see internal.example.test", rules), "example-host");
  assert.equal(publicTextProblem("about EX-1234 today", rules), "example-ticket");
  assert.equal(publicTextProblem("about EX-12 today", rules), null, "a pattern is only what it says");
  assert.equal(publicTextProblem("the BLUE falcon", rules), "example-codename", "ignore_case");
  assert.equal(publicTextProblem("INTERNAL.EXAMPLE.TEST", rules), null, "no ignore_case: case matters");
  assert.equal(publicTextProblem("EX-1234 and internal.example.test", rules), "example-host", "the first rule that fails, in the file's order");
  const rule = (o = {}) => JSON.stringify([{ name: "r", pattern: "x", ...o }]);
  assert.doesNotThrow(() => parseRules(rule()));
  for (const pattern of ["(?:a|b)c", "(?=x)xa", "(?!x)ya", "(?<=x)a", "(?<!x)a", "a\\$", "[$]a", "a{2,3}", "\\{,3\\}", "[(?]a", "[\\]]a", "\\\\Afoo", "\\bfoo\\b", "\\d{3}-x", "a\\.b", "a\\/b"]) {
    assert.doesNotThrow(() => parseRules(rule({ pattern })), pattern);
  }
  assert.doesNotThrow(() => parseRules(JSON.stringify(Array.from({ length: MAX_RULES }, (_, i) => ({ name: `r${i}`, pattern: `w${i}` })))), "at the cap");
  assert.doesNotThrow(() => parseRules(rule({ pattern: `${"a".repeat(MAX_PATTERN - 1)}b` })), "a pattern at the cap");
  const bad = [
    ["not JSON", "[{"],
    ["an object", "{}"],
    ["no rules", "[]"],
    ["over the cap", JSON.stringify(Array.from({ length: MAX_RULES + 1 }, (_, i) => ({ name: `r${i}`, pattern: `w${i}` })))],
    ["a rule that is a string", '["x"]'],
    ["a rule that is null", "[null]"],
    ["an extra field", rule({ flags: "g" })],
    ["no pattern", JSON.stringify([{ name: "r" }])],
    ["no name", JSON.stringify([{ pattern: "x" }])],
    ["a name in capitals", rule({ name: "Rule" })],
    ["a name with a space", rule({ name: "a b" })],
    ["a name over 40 characters", rule({ name: "a".repeat(41) })],
    ["a name twice", JSON.stringify([{ name: "r", pattern: "x" }, { name: "r", pattern: "y" }])],
    ["ignore_case a string", rule({ ignore_case: "yes" })],
    ["an empty pattern", rule({ pattern: "" })],
    ["a pattern over the cap", rule({ pattern: "a".repeat(MAX_PATTERN + 1) })],
    ["a pattern that does not compile", rule({ pattern: "(" })],
    ["a Python-only named group", rule({ pattern: "(?P<n>a)" })],
    ["a JavaScript-only named group", rule({ pattern: "(?<n>a)" })],
    ["a Python-only inline flag", rule({ pattern: "(?i)x" })],
    ["a scoped inline flag", rule({ pattern: "(?i:x)" })],
    ["a comment group", rule({ pattern: "(?#c)x" })],
    ["a conditional group", rule({ pattern: "(?(1)a|b)" })],
    ["an atomic group", rule({ pattern: "(?>a)" })],
    ["Python's start of text, \\A", rule({ pattern: "\\Afoo" })],
    ["Python's end of text, \\Z", rule({ pattern: "foo\\Z" })],
    ["Python 3.14's end of text, \\z", rule({ pattern: "foo\\z" })],
    ["JavaScript's property escape, \\p", rule({ pattern: "\\p{L}" })],
    ["JavaScript's negated property escape, \\P", rule({ pattern: "\\P{L}" })],
    ["JavaScript's code point escape, \\u{...}", rule({ pattern: "\\u{41}" })],
    ["JavaScript's control escape, \\c", rule({ pattern: "\\cJ" })],
    ["Python's {,n} repeat", rule({ pattern: "ab{,3}c" })],
    ["a $ anchor, which Python also matches before a final newline", rule({ pattern: "foo$" })],
    ["a class that starts with ]", rule({ pattern: "[]a]x" })],
    ["a negated class that starts with ]", rule({ pattern: "[^]a]x" })],
    ["a backslash at the end", rule({ pattern: "foo\\" })],
    ["a repeated group with a counted repeat", rule({ pattern: "(.*a){20}" })],
    ["a counted repeat of a group that holds an unbounded repeat", rule({ pattern: "(a+b){2}c" })],
    ["a pattern that backtracks without end, past the group guard", rule({ pattern: "(a|aa)+c" })],
    ["a pattern that backtracks without end, with an alternation of the same text", rule({ pattern: "(a|a)+c" })],
    ["a pattern that backtracks without end, with nested groups", rule({ pattern: "((a+)b?)+c" })],
    ["a punctuation escape only Python takes", rule({ pattern: "a\\@b" })],
    ["a $ anchor after a class", rule({ pattern: "[a]$" })],
    ["a group Python only has, after a class", rule({ pattern: "[a](?P<n>x)" })],
    ["a {,n} repeat after a class", rule({ pattern: "[a]{,3}" })],
    ["a pattern that matches the empty text", rule({ pattern: "x*" })],
    ["a pattern that matches anything", rule({ pattern: ".*" })],
    ["a back-reference", rule({ pattern: "(a)\\1" })],
    ["a named back-reference", rule({ pattern: "(?<n>a)\\k<n>" })],
    ["a repeated group that holds an unbounded repeat", rule({ pattern: "(a+)+b" })],
    ["a starred group that holds a star", rule({ pattern: "(a*b*)*c" })],
  ];
  for (const [what, text] of bad) assert.throws(() => parseRules(text), Refusal, what);
  // The message names the rule, and never the pattern.
  assert.throws(() => parseRules(JSON.stringify([{ name: "secret-rule", pattern: "(not-shown" }])), (e) => e instanceof Refusal && /rule secret-rule/.test(e.message) && !e.message.includes("not-shown"));
});

test("loadRules: a regular file of at most 256 KiB, and, for the key service, one that only root could have changed", () => {
  assert.equal(loadRules(RULES_FILE, null).length, RULES.length);
  assert.equal(loadRules(RULES_FILE, new Set([0, ME])).length, RULES.length, "this user's file is trusted when this user is");
  if (ME !== 0) assert.throws(() => loadRules(RULES_FILE, new Set([0])), /could be changed by a user other than root/, "a file another user could change");
  const dir = privateDir("rules-bad");
  assert.throws(() => loadRules(join(dir, "missing.json"), null), /is not there/);
  assert.throws(() => loadRules(dir, null), /not a regular file/, "a folder");
  const target = join(dir, "target.json");
  writeFileSync(target, JSON.stringify(RULES));
  const link = join(dir, "link.json");
  symlinkSync(target, link);
  assert.throws(() => loadRules(link, null), /not a regular file/, "a link is not followed");
  const big = join(dir, "big.json");
  writeFileSync(big, " ".repeat(256 * 1024 + 1));
  assert.throws(() => loadRules(big, null), /longer than 262144 bytes/);
  const junk = join(dir, "junk.json");
  writeFileSync(junk, "not json");
  assert.throws(() => loadRules(junk, null), /not JSON/);
});

test("parseRules: compiled as Python's re reads a pattern: code points, and Unicode case folding with ignore_case", () => {
  const [fold] = parseRules(JSON.stringify([{ name: "fold", pattern: "mask", ignore_case: true }]));
  assert.equal(publicTextProblem("a MASK", [fold]), "fold");
  assert.equal(publicTextProblem("maſK", [fold]), "fold", "the long s and the Kelvin sign fold to s and k, as in Python's re.I");
  const [exact] = parseRules(JSON.stringify([{ name: "exact", pattern: "mask" }]));
  assert.equal(publicTextProblem("a MASK", [exact]), null, "without ignore_case, case matters");
  assert.equal(publicTextProblem("maſK", [exact]), null);
  // A dot is one code point (Python's), not one UTF-16 unit.
  const [dot] = parseRules(JSON.stringify([{ name: "dot", pattern: "a.b" }]));
  assert.equal(publicTextProblem("a\u{1F600}b", [dot]), "dot");
  assert.equal(publicTextProblem("a\nb", [dot]), null);
});

test("parseRules: the refusal says which construct, also where the pattern would not compile in JavaScript anyway", () => {
  const says = (pattern, what) =>
    assert.throws(() => parseRules(JSON.stringify([{ name: "r", pattern }])), (e) => e instanceof Refusal && e.message === `public-text rule r: the pattern has ${what}, which Python and JavaScript read differently (or only one has)`, pattern);
  says("\\Afoo", "the escape \\A");
  says("foo\\Z", "the escape \\Z");
  says("foo\\z", "the escape \\z");
  says("\\p{L}", "the escape \\p");
  says("\\P{L}", "the escape \\P");
  says("\\cJ", "the escape \\c");
  says("(a)\\1", "a back-reference");
  says("\\u{41}", "the escape \\u{...}");
  says("foo$", "a $ anchor");
  says("ab{,3}c", "a {,n} repeat");
  says("[]a]x", "a class that starts with ]");
  says("[^]a]x", "a class that starts with ]");
  says("(?i)x", "a group other than (?:, (?=, (?!, (?<= and (?<!");
  says("(?<n>a)", "a group other than (?:, (?=, (?!, (?<= and (?<!");
  says("(?P<n>a)", "a group other than (?:, (?=, (?!, (?<= and (?<!");
  says("foo\\", "a backslash at the end");
  // The bad construct comes after a character class: the class must not hide what follows it.
  says("[a]$", "a $ anchor");
  says("[a](?P<n>x)", "a group other than (?:, (?=, (?!, (?<= and (?<!");
  says("[a]{,3}", "a {,n} repeat");
  says("[^a]x$", "a $ anchor");
  says("[a][b]{,3}", "a {,n} repeat");
  // A name reaches the reviewer, so a rule's name is a slug; the pattern never does.
  assert.throws(() => parseRules(JSON.stringify([{ name: "r", pattern: "(?i)secret-word" }])), (e) => !e.message.includes("secret-word"));
});

test("matchWithin and publicTextProblem: a match is cut off, and a rule that runs out of time refuses the body", async () => {
  assert.equal(matchWithin(/a/u, "a", MATCH_MS), true);
  assert.equal(matchWithin(/b/u, "a", MATCH_MS), false);
  const slow = /(a|aa)+$/u; // loader-proof only in this test: parseRules refuses it
  const body = `${"a".repeat(40)}b`; // without the limit, tens of seconds
  const began = Date.now();
  assert.equal(matchWithin(slow, body, 50), null, "cut off");
  assert.ok(Date.now() - began < 2000, "within the limit, not after a minute");
  assert.equal(matchWithin(/a/u, "a", MATCH_MS), true, "the next match works as before");
  assert.throws(
    () => publicTextProblem(body, [{ name: "slow-rule", re: slow }], { matchMs: 50 }),
    (e) => e instanceof Refusal && e.check === "public-text" && e.message === "the public-text check of the body took too long (rule slow-rule), so the body was not accepted",
  );
  // All the rules together have a budget too: with none left, even a fast rule is not run.
  assert.throws(() => publicTextProblem("x", [{ name: "fast-rule", re: /x/u }], { totalMs: 0 }), /took too long \(rule fast-rule\)/);
  assert.equal(publicTextProblem("x", [{ name: "fast-rule", re: /y/u }]), null);
});

test("publicTextProblem: on the defaults a slow rule is cut off within a second, and the limits keep the connection under its own", async () => {
  // Production runs on the defaults: no config override here.
  const body = `${"a".repeat(40)}b`; // without a limit, tens of seconds
  const began = Date.now();
  assert.throws(
    () => publicTextProblem(body, [{ name: "slow-rule", re: /(a|aa)+$/u }]),
    (e) => e instanceof Refusal && e.check === "public-text" && /took too long \(rule slow-rule\)/.test(e.message),
  );
  assert.ok(Date.now() - began < 1000, "cut off by the rule's own limit, long before the total");
  // The limits themselves: a rule's is short, the total is a few seconds, and the six requests (15 s each), the 5 s to read the request and the matching stay under the connection's 100 s.
  assert.ok(MATCH_MS >= 10 && MATCH_MS <= 200, `a rule's limit is ${MATCH_MS} ms`);
  assert.ok(MATCH_TOTAL_MS >= MATCH_MS && MATCH_TOTAL_MS <= 5000, `the total limit is ${MATCH_TOTAL_MS} ms`);
  assert.ok(5_000 + 6 * 15_000 + MATCH_TOTAL_MS < 100_000, "the connection's limit holds with the matching in it");
});

test("review: a rule that backtracks without end refuses the body within the limit, posts nothing, and revokes the token", async () => {
  const slow = { name: "slow-rule", re: /(a|aa)+$/u };
  const config = { ...CONFIG, rules: [slow, ...CONFIG.rules], matchMs: 50 };
  const body = `${"a".repeat(40)}b`;
  const began = Date.now();
  const { a, fake, d, text } = await limited({}, req({ body }), { config });
  assert.ok(Date.now() - began < 1000, "refused within the limit (50 ms for the rule), not after the whole budget");
  assert.deepEqual(a, { ok: false, check: "public-text", error: "the public-text check of the body took too long (rule slow-rule), so the body was not accepted" });
  assert.deepEqual(fake.shape(), PR_ONLY);
  assert.equal(d.ledgered[0].check, "public-text");
  assert.equal(d.ledgered[0].token_revoked, true, "the token is revoked");
  assert.ok(!text.includes(body.slice(0, 30)), "the body is not repeated");
  // A body the rule is fast on goes through the same rules.
  const ok = await limited({}, req({ body: "Looks right." }), { config: { ...CONFIG, rules: CONFIG.rules } });
  assert.equal(ok.a.ok, true, ok.a.error);
  // The budget for all the rules is the config's own: with none, not even a fast rule is run, and the body is not accepted.
  const none = await limited({}, req({ body: "Looks right." }), { config: { ...CONFIG, totalMatchMs: 0 } });
  assert.deepEqual(none.a, { ok: false, check: "public-text", error: "the public-text check of the body took too long (rule example-host), so the body was not accepted" });
  assert.deepEqual(none.fake.shape(), PR_ONLY);
  assert.equal(none.d.ledgered[0].token_revoked, true);
});

test("gp-github-review: a check name that is not a name is dropped from the line the client prints; no reason given is said so", async () => {
  const dir = privateDir("fake-ks");
  const answers = [
    { ok: false, check: "NOT A CHECK!", error: "the clause" },
    { ok: false, check: "../etc", error: "the clause" },
    { ok: false, check: 7, error: "the clause" },
    { ok: false, check: "hold", error: 5 },
    { ok: false, error: "the clause" },
  ];
  let n = 0;
  const server = createServer((conn) => {
    conn.on("data", () => conn.end(`${JSON.stringify(answers[n++ % answers.length])}\n`));
  });
  await new Promise((r) => server.listen(join(dir, SOCKET_NAME), r));
  cleanups.push(() => new Promise((r) => server.close(r)));
  const out = [];
  for (const want of ["refused: the clause\n", "refused: the clause\n", "refused: the clause\n", "refused: hold: no reason given\n", "refused: the clause\n"]) {
    let err = "";
    const code = await main(["--socket", dir, "review", REPO, "12", HEAD, "APPROVE"], { out: (x) => out.push(x), err: (x) => (err += x) });
    assert.equal(code, 1);
    assert.equal(err, want);
  }
  assert.deepEqual(out, []);
});

test("rules check: the root-owned copy tells the setup whether a rules file will do", () => {
  const run = (...args) => spawnSync(process.execPath, [MODULE, "rules", ...args], { encoding: "utf8", env: { PATH: process.env.PATH } });
  let r = run("check", RULES_FILE);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `rules ${RULES.length}\n`);
  const bad = join(privateDir("rules-check"), "bad.json");
  writeFileSync(bad, JSON.stringify([{ name: "r", pattern: "(" }]));
  r = run("check", bad);
  assert.equal(r.status, 1);
  assert.equal(r.stderr, "github-review rules: public-text rule r: the pattern does not compile\n");
  assert.equal(r.stdout, "");
  assert.equal(run("check", "relative.json").status, 2, "an absolute path only");
  assert.equal(run("check").status, 2);
  assert.equal(run("install", RULES_FILE).status, 2);
});

test("heldProblem: a HOLD: title or the hold label as merge-by-policy reads them, a draft, and what cannot be read", () => {
  assert.equal(heldProblem(prJson()), null);
  for (const title of ["HOLD: wait", "hold: wait", "Hold:wait", "  HOLD: wait", "\t\nHOLD: wait", "HOLD:"]) {
    assert.deepEqual(heldProblem(prJson({ title })), { check: "hold", why: "the title starts with HOLD:" }, JSON.stringify(title));
  }
  for (const title of ["Fix the HOLD: button", "HOLD wait", "HOLDING: x", "Add hold", "THE HOLD:", ""]) assert.equal(heldProblem(prJson({ title })), null, JSON.stringify(title));
  for (const name of ["hold", "HOLD", " Hold ", "\thold\n"]) {
    assert.deepEqual(heldProblem(prJson({ labels: [{ name: "bug" }, { name }] })), { check: "hold", why: "the pull request has the hold label" }, JSON.stringify(name));
  }
  for (const name of ["holdup", "on hold", "no-hold", "hold-me"]) assert.equal(heldProblem(prJson({ labels: [{ name }] })), null, name);
  assert.deepEqual(heldProblem(prJson({ draft: true })), { check: "draft", why: "the pull request is a draft" });
  for (const [what, pr, check] of [
    ["no title", prJson({ title: undefined }), "hold"],
    ["a title that is a number", prJson({ title: 5 }), "hold"],
    ["labels that are a string", prJson({ labels: "hold" }), "hold"],
    ["no labels", prJson({ labels: undefined }), "hold"],
    ["a label that is a string", prJson({ labels: ["bug"] }), "hold"],
    ["a label with no name", prJson({ labels: [{}] }), "hold"],
    ["a draft flag that is a string", prJson({ draft: "false" }), "draft"],
    ["no draft flag", prJson({ draft: undefined }), "draft"],
    ["no pull request", undefined, "hold"],
  ]) {
    assert.equal(heldProblem(pr)?.check, check, what);
    assert.match(heldProblem(pr).why, /could not be read/, what);
  }
});

/** A review against a fake GitHub: the answer, the calls it made, the ledger, and what it said. */
async function limited(answers, request, o = {}) {
  const fake = fakeApi(answers);
  const d = deps(fake, o);
  const a = await review(request, d);
  return { a, fake, d, text: JSON.stringify([a, d.ledgered]) };
}
const PR_ONLY = [TOKEN_CALL, PR_CALL, REVOKE_CALL];
const WITH_COMMITS = [TOKEN_CALL, PR_CALL, COMMITS_CALL, REVOKE_CALL];

test("review: each limit refuses with its check's name and one clause, posts nothing, and revokes the token", async () => {
  const mark = "zebra-marker"; // in every title: a refusal never repeats one
  const pr = (o = {}) => ({ pr: { status: 200, json: prJson({ title: `${mark} change`, ...o }) } });
  const commits = (list, o = {}) => ({ ...pr({ commits: list.length, ...o }), commits: { status: 200, json: list } });
  const other = sha();
  const cases = [
    // [what, answers, request, check, the whole clause (a string) or a pattern, the calls]
    ["head: moved", pr({ head: { sha: other } }), req(), "head", new RegExp(`^pull request 12's head is ${other}, not ${HEAD}: read it again$`), PR_ONLY],
    ["open: closed", pr({ state: "closed" }), req(), "open", "pull request 12 is not open", PR_ONLY],
    ["hold: a HOLD: title", pr({ title: `HOLD: ${mark}` }), req(), "hold", "the title starts with HOLD:", PR_ONLY],
    ["hold: a lower-case title after a space", pr({ title: `  hold: ${mark}` }), req(), "hold", "the title starts with HOLD:", PR_ONLY],
    ["hold: the hold label", pr({ labels: [{ name: "bug" }, { name: " Hold " }] }), req(), "hold", "the pull request has the hold label", PR_ONLY],
    ["hold: a title that cannot be read", pr({ title: null }), req(), "hold", "the title could not be read", PR_ONLY],
    ["hold: labels that cannot be read", pr({ labels: null }), req(), "hold", "the labels could not be read", PR_ONLY],
    ["draft: a draft", pr({ draft: true }), req(), "draft", "the pull request is a draft", PR_ONLY],
    ["draft: a flag that cannot be read", pr({ draft: undefined }), req(), "draft", "whether the pull request is a draft could not be read", PR_ONLY],
    ["own-pr: the App's PR", pr({ user: { login: BOT_LOGIN } }), req(), "own-pr", "the pull request is the reviewer's own", PR_ONLY],
    ["own-pr: in another case", pr({ user: { login: "Review-Bot[BOT]" } }), req(), "own-pr", "the pull request is the reviewer's own", PR_ONLY],
    ["own-pr: no author", pr({ user: null }), req(), "own-pr", "the pull request's author could not be read", PR_ONLY],
    ["public-text: a rule fails in a public repo", pr(), req({ body: FAILS_RULES }), "public-text", "the body fails the public-text check (rule example-host)", PR_ONLY],
    ["public-text: a rule, ignoring case", pr(), req({ body: "Ask the Blue Falcon team" }), "public-text", "the body fails the public-text check (rule example-codename)", PR_ONLY],
    ["public-text: REQUEST_CHANGES too", pr(), req({ event: "REQUEST_CHANGES", body: "fix EX-4321" }), "public-text", "the body fails the public-text check (rule example-ticket)", PR_ONLY],
    ["public-text: privacy missing is public", pr({ base: { repo: { full_name: REPO } } }), req({ body: FAILS_RULES }), "public-text", "the body fails the public-text check (rule example-host)", PR_ONLY],
    ["public-text: privacy a string is public", pr({ base: { repo: { full_name: REPO, private: "true" } } }), req({ body: FAILS_RULES }), "public-text", "the body fails the public-text check (rule example-host)", PR_ONLY],
    ["public-text: privacy 1 is public", pr({ base: { repo: { full_name: REPO, private: 1 } } }), req({ body: FAILS_RULES }), "public-text", "the body fails the public-text check (rule example-host)", PR_ONLY],
    ["public-text: privacy null is public", pr({ base: { repo: { full_name: REPO, private: null } } }), req({ body: FAILS_RULES }), "public-text", "the body fails the public-text check (rule example-host)", PR_ONLY],
    ["public-text: privacy an object is public", pr({ base: { repo: { full_name: REPO, private: {} } } }), req({ body: FAILS_RULES }), "public-text", "the body fails the public-text check (rule example-host)", PR_ONLY],
    ["public-text: privacy false is public", pr({ base: { repo: { full_name: REPO, private: false } } }), req({ body: FAILS_RULES }), "public-text", "the body fails the public-text check (rule example-host)", PR_ONLY],
    ["own-commit: by login", commits([commitJson(sha()), commitJson(HEAD, { author: { login: BOT_LOGIN } })]), req(), "own-commit", /^commit [0-9a-f]{7} is authored by the reviewer's own identity$/, WITH_COMMITS],
    ["own-commit: by login, in another case", commits([commitJson(HEAD, { author: { login: "REVIEW-BOT[bot]" } })]), req(), "own-commit", /authored by the reviewer's own identity/, WITH_COMMITS],
    ["own-commit: by email, with no linked account", commits([commitJson(HEAD, { author: null, commit: { author: { name: "x", email: BOT_EMAIL } } })]), req(), "own-commit", /authored by the reviewer's own identity/, WITH_COMMITS],
    ["own-commit: by email, in capitals", commits([commitJson(HEAD, { commit: { author: { name: "x", email: BOT_EMAIL.toUpperCase() } } })]), req(), "own-commit", /authored by the reviewer's own identity/, WITH_COMMITS],
    ["own-commit: not the head, the first one", commits([commitJson(sha(), { author: { login: BOT_LOGIN } }), commitJson(HEAD)]), req(), "own-commit", /authored by the reviewer's own identity/, WITH_COMMITS],
    ["own-commit: the list cannot be read (403)", { ...pr(), commits: { status: 403, json: { message: "Resource not accessible by integration" } } }, req(), "own-commit", "the commits could not be read, so none was checked (HTTP 403: Resource not accessible by integration)", WITH_COMMITS],
    ["own-commit: no answer", { ...pr(), commits: { status: 0, json: null } }, req(), "own-commit", "the commits could not be read, so none was checked (no answer)", WITH_COMMITS],
    ["own-commit: an answer that is no list", { ...pr(), commits: { status: 200, json: { message: "x" } } }, req(), "own-commit", /^the commits could not be read, so none was checked/, WITH_COMMITS],
    ["own-commit: a shorter list than the pull request's count", { ...commits([commitJson(HEAD)], { commits: 2 }) }, req(), "own-commit", "the commit list does not match the pull request (1 of 2)", WITH_COMMITS],
    ["own-commit: a longer list", { ...commits([commitJson(sha()), commitJson(HEAD)], { commits: 1 }) }, req(), "own-commit", "the commit list does not match the pull request (2 of 1)", WITH_COMMITS],
    ["own-commit: a list that does not hold the head", commits([commitJson(sha())]), req(), "own-commit", "the commit list does not hold the head", WITH_COMMITS],
    ["own-commit: a list of the right length that does not hold the head", commits([commitJson(sha()), commitJson(sha())]), req(), "own-commit", "the commit list does not hold the head", WITH_COMMITS],
    ["own-commit: a commit with no email", commits([commitJson(HEAD, { commit: { author: {} } })]), req(), "own-commit", "a commit in the list could not be read, so it was not checked", WITH_COMMITS],
    ["own-commit: a commit with no sha", commits([{ commit: { author: { email: BUILDER_EMAIL } } }]), req(), "own-commit", "a commit in the list could not be read, so it was not checked", WITH_COMMITS],
    ["own-commit: over 100 commits (the list is not asked for)", pr({ commits: MAX_COMMITS + 1 }), req(), "own-commit", `the pull request has ${MAX_COMMITS + 1} commits, and this check reads at most ${MAX_COMMITS}`, PR_ONLY],
    ["own-commit: no commit count", pr({ commits: undefined }), req(), "own-commit", "the number of commits could not be read, so none was checked", PR_ONLY],
    ["own-commit: a commit count of 0", pr({ commits: 0 }), req(), "own-commit", "the number of commits could not be read, so none was checked", PR_ONLY],
  ];
  for (const [what, answers, request, check, clause, calls] of cases) {
    const { a, fake, d, text } = await limited(answers, request);
    assert.equal(a.ok, false, what);
    assert.equal(a.check, check, what);
    if (typeof clause === "string") assert.equal(a.error, clause, what);
    else assert.match(a.error, clause, what);
    assert.deepEqual(Object.keys(a).sort(), ["check", "error", "ok"], `${what}: nothing posted, so no review in the answer`);
    assert.deepEqual(fake.shape(), calls, what);
    assert.ok(!fake.shape().includes(REVIEW_CALL), `${what}: no review posted`);
    assert.equal(d.ledgered.length, 1, what);
    assert.equal(d.ledgered[0].result, "refused", what);
    assert.equal(d.ledgered[0].check, check, `${what}: the ledger names the check`);
    assert.equal(d.ledgered[0].token_revoked, true, `${what}: the token revoked`);
    for (const never of [mark, "internal.example.test", "EX-4321", "Blue Falcon", BOT_EMAIL, BOT_EMAIL.toUpperCase(), BUILDER_EMAIL, fake.token, "Ask the", "see "]) {
      assert.ok(!text.includes(never), `${what}: the answer and the ledger never repeat ${never.slice(0, 12)}…`);
    }
  }
});

test("review: the limits run in order, the first that fails is the one named", async () => {
  // A pull request that fails everything the pull request's own facts can fail.
  const all = prJson({ head: { sha: sha() }, state: "closed", title: "HOLD: x", draft: true, user: { login: BOT_LOGIN }, commits: 500 });
  const order = [
    ["open", all],
    ["head", { ...all, state: "open" }],
    ["hold", { ...all, state: "open", head: { sha: HEAD } }],
    ["draft", { ...all, state: "open", head: { sha: HEAD }, title: "ok" }],
    ["own-pr", { ...all, state: "open", head: { sha: HEAD }, title: "ok", draft: false }],
    ["public-text", { ...all, state: "open", head: { sha: HEAD }, title: "ok", draft: false, user: { login: BUILDER_LOGIN } }],
  ];
  for (const [check, json] of order) {
    const { a } = await limited({ pr: { status: 200, json } }, req({ body: FAILS_RULES }));
    assert.equal(a.check, check);
  }
  // With the body clean, the commits are what is left.
  const { a } = await limited({ pr: { status: 200, json: { ...order[5][1] } } }, req());
  assert.equal(a.check, "own-commit");
  // Rules that are not loaded refuse a body for a public repo, not pass it.
  for (const rules of [undefined, []]) {
    const none = await limited({}, req({ body: "a clean body" }), { config: { ...CONFIG, rules } });
    assert.deepEqual(none.a, { ok: false, check: "public-text", error: "the public-text rules are not loaded" });
  }
  // repo, then event, before the key or the network.
  let r = await limited({}, req({ repo: "example-org/not-listed", event: "COMMENT", body: "x" }));
  assert.equal(r.a.check, "repo");
  r = await limited({}, req({ event: "COMMENT", body: "x" }));
  assert.deepEqual(r.a, { ok: false, check: "event", error: "COMMENT is not allowed here: post APPROVE or REQUEST_CHANGES" });
  assert.deepEqual(r.fake.calls, [], "GitHub is asked nothing");
  assert.equal(r.d.keyReads, 0, "and the key is not read");
});

test("review: what must still pass: the builders' shared noreply author, a hold later in the title, a private repo, COMMENT where allowed", async () => {
  const cases = [
    ["three commits by the builders' shared noreply author, with and without an account", { pr: { status: 200, json: prJson({ commits: 3 }) }, commits: { status: 200, json: [commitJson(sha(), { author: null }), commitJson(sha()), commitJson(HEAD)] } }, req()],
    ["a commit by another bot", { commits: { status: 200, json: [commitJson(HEAD, { author: { login: "other-bot[bot]" }, commit: { author: { name: "x", email: "9+other-bot[bot]@users.noreply.github.com" } } })] } }, req()],
    ["HOLD: later in the title", { pr: { status: 200, json: prJson({ title: "Fix the HOLD: button" }) } }, req()],
    ["a label that only contains hold", { pr: { status: 200, json: prJson({ labels: [{ name: "holdup" }, { name: "on hold soon" }] }) } }, req()],
    ["a PR by a person whose name starts like the bot's", { pr: { status: 200, json: prJson({ user: { login: "review-bot" } }) } }, req()],
    ["the head listed first (the order is not relied on)", { pr: { status: 200, json: prJson({ commits: 2 }) }, commits: { status: 200, json: [commitJson(HEAD), commitJson(sha())] } }, req()],
    ["100 commits", { pr: { status: 200, json: prJson({ commits: MAX_COMMITS }) }, commits: { status: 200, json: [...Array.from({ length: MAX_COMMITS - 1 }, () => commitJson(sha())), commitJson(HEAD)] } }, req()],
    ["a body that fails a rule, in a private repo", { pr: { status: 200, json: prJson({ base: { repo: { full_name: REPO, private: true } } }) } }, req({ body: FAILS_RULES })],
    ["an APPROVE with no body, in a public repo", {}, req({ body: "" })],
    ["a clean REQUEST_CHANGES", {}, req({ event: "REQUEST_CHANGES", body: "Please add a test for the empty case." })],
    ["a rule's word as part of a longer word", {}, req({ body: "EX-12 and EX-1234x and xEX-1234" })],
  ];
  for (const [what, answers, request] of cases) {
    const { a, fake } = await limited(answers, request);
    assert.equal(a.ok, true, `${what}: ${a.error}`);
    assert.equal(fake.shape().length, FULL.length, what);
  }
  const { a, fake } = await limited({}, req({ event: "COMMENT", body: "A note." }), { config: { ...CONFIG, allowComment: true } });
  assert.equal(a.ok, true, "COMMENT where the settings allow it");
  assert.deepEqual(fake.shape(), FULL);
  assert.equal(fake.calls[3].body.event, "COMMENT");
});

test("review: a hold, a hold label or a draft that comes after the post: not ok, the review is named, the token revoked", async () => {
  for (const [what, change, check, clause] of [
    ["a HOLD: title", { title: "HOLD: wait" }, "hold", "the title starts with HOLD:"],
    ["the hold label", { labels: [{ name: "hold" }] }, "hold", "the pull request has the hold label"],
    ["a draft", { draft: true }, "draft", "the pull request is a draft"],
    ["a title that cannot be read", { title: undefined }, "hold", "the title could not be read"],
  ]) {
    const { a, fake, d } = await limited({ prAfter: { status: 200, json: prJson(change) } }, req());
    assert.equal(a.ok, false, what);
    assert.equal(a.check, check, what);
    assert.equal(a.error, `the review was posted, but the pull request changed while it was posted (${clause}): look at it before relying on the review`, what);
    assert.equal(a.review.id, 5, `${what}: the review it posted is named`);
    assert.deepEqual(fake.shape(), FULL, what);
    assert.equal(d.ledgered[0].result, `posted, then ${check}`, what);
    assert.equal(d.ledgered[0].check, check, what);
    assert.equal(d.ledgered[0].review_id, 5, what);
    assert.equal(d.ledgered[0].token_revoked, true, what);
  }
});

// ---------------------------------------------------------------- the limits, through the socket and the client

test("serve: the limits against the stand-in: each refused, nothing posted, every token revoked, the ledger naming the check and never the body", async () => {
  const ks = await keyService();
  const pr = (o) => ({ pr: { ...gh.defaults().pr, ...o } });
  const cases = [
    ["hold", pr({ title: "HOLD: wait" }), {}, "the title starts with HOLD:", PR_ONLY],
    ["hold", pr({ labels: [{ name: "hold" }] }), {}, "the pull request has the hold label", PR_ONLY],
    ["draft", pr({ draft: true }), {}, "the pull request is a draft", PR_ONLY],
    ["own-pr", pr({ author: BOT_LOGIN }), {}, "the pull request is the reviewer's own", PR_ONLY],
    ["public-text", pr({ private: false }), { body: FAILS_RULES }, "the body fails the public-text check (rule example-host)", PR_ONLY],
    ["own-commit", {}, { commits: [{ sha: HEAD, email: BOT_EMAIL, login: null }] }, /authored by the reviewer's own identity/, WITH_COMMITS],
    ["own-commit", {}, { commits: [{ sha: HEAD, email: BUILDER_EMAIL, login: BOT_LOGIN }] }, /authored by the reviewer's own identity/, WITH_COMMITS],
    ["own-commit", {}, { commitsStatus: 403 }, /the commits could not be read, so none was checked \(HTTP 403: Resource not accessible by integration\)/, WITH_COMMITS],
  ];
  for (const [check, set, extra, clause, calls] of cases) {
    gh.reset();
    const { body, ...state } = extra;
    gh.set({ ...set, ...state });
    const a = await ask(ks, reviewRequest(body ? { body } : {}));
    assert.equal(a.ok, false, check);
    assert.equal(a.check, check);
    if (typeof clause === "string") assert.equal(a.error, clause);
    else assert.match(a.error, clause);
    assert.deepEqual(gh.calls(), calls.map((c) => c.replace(/\/installations\/\d+\//, `/installations/${INSTALLATION}/`)), check);
    assert.deepEqual(gh.unrevoked(), [], `${check}: every token revoked`);
    await waitForText(ks, new RegExp(`"result":"refused","reason":"[^"]*","check":"${check}","token_revoked":true`), `${check}: the ledger`);
  }
  assert.ok(!ks.stderr().includes("internal.example.test"), "the body is never in the journal");
  // The same body in a private repo, and a hold that is not one, go through.
  gh.reset();
  gh.set({ pr: { ...gh.defaults().pr, private: true } });
  let a = await ask(ks, reviewRequest({ body: FAILS_RULES }));
  assert.equal(a.ok, true, a.error ?? ks.stderr());
  gh.reset();
  gh.set({ pr: { ...gh.defaults().pr, title: "Fix the HOLD: button" } });
  a = await ask(ks, reviewRequest());
  assert.equal(a.ok, true, a.error);
  // A hold that comes right after the post.
  gh.reset();
  gh.set({ prAfterReview: { title: "HOLD: wait" } });
  a = await ask(ks, reviewRequest());
  assert.equal(a.ok, false);
  assert.equal(a.check, "hold");
  assert.match(a.error, /the review was posted, but the pull request changed while it was posted \(the title starts with HOLD:\)/);
  assert.equal(a.review.state, "APPROVED");
  assert.equal(gh.calls().length, FULL.length);
  assert.deepEqual(gh.unrevoked(), []);
  await waitForText(ks, /"result":"posted, then hold","check":"hold","review_id":9001/, "the ledger");
  gh.reset();
});

test("gp-github-review: a refusal is one line, refused: <check>: <clause>, and exit 1; a failure that is no limit names none", async () => {
  gh.reset();
  const ks = await keyService();
  const run = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLIENT, "--socket", ks.dir, ...args], { env: { PATH: process.env.PATH } });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        outputs.push(out, err);
        resolve({ code, out, err });
      });
    });
  gh.set({ pr: { ...gh.defaults().pr, title: "HOLD: wait" } });
  let r = await run(["review", REPO, "12", HEAD, "APPROVE"]);
  assert.equal(r.code, 1);
  assert.equal(r.err, "refused: hold: the title starts with HOLD:\n");
  assert.equal(r.out, "");
  r = await run(["review", REPO, "12", HEAD, "COMMENT", "a note"]);
  assert.equal(r.code, 1);
  assert.equal(r.err, "refused: event: COMMENT is not allowed here: post APPROVE or REQUEST_CHANGES\n");
  gh.reset();
  gh.set({ prStatus: 404 });
  r = await run(["review", REPO, "12", HEAD, "APPROVE"]);
  assert.equal(r.code, 1);
  assert.equal(r.err, "refused: could not read pull request 12 (HTTP 404: Not Found)\n", "no limit failed, so no check is named");
  gh.reset();
  gh.set({ prAfterReview: { draft: true } });
  r = await run(["review", REPO, "12", HEAD, "APPROVE"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /^refused: draft: the review was posted, but the pull request changed while it was posted \(the pull request is a draft\)[^\n]*\ngp-github-review: the review that was posted: https:\/\/github.com\/[^\n]*\n$/);
  const json = await run(["--json", "review", REPO, "12", HEAD, "COMMENT", "a note"]);
  assert.equal(json.code, 1);
  assert.deepEqual(JSON.parse(json.out), { ok: false, check: "event", error: "COMMENT is not allowed here: post APPROVE or REQUEST_CHANGES" });
  gh.reset();
});

test("app: GET /app with the JWT, and the App must be the configured one", async () => {
  let fake = fakeApi();
  let a = await app(deps(fake));
  assert.equal(a.ok, true, a.error);
  assert.deepEqual(fake.shape(), ["GET /app"]);
  assert.equal(jwtProblem(fake.calls[0].auth), null);
  assert.deepEqual(a.app, { id: 3, slug: "review-bot", owner: "example-org", client_id: CLIENT_ID, permissions: { pull_requests: "write" } });
  assert.equal(a.fingerprint, fingerprint(KEY));
  fake = fakeApi({ app: { status: 200, json: { id: 3, slug: "x", client_id: "Iv23lisomeoneelse", owner: { login: "o" } } } });
  a = await app(deps(fake));
  assert.match(a.error, /client ID is Iv23lisomeoneelse, not /);
  fake = fakeApi({ app: { status: 401, json: { message: "A JSON web token could not be decoded" } } });
  a = await app(deps(fake));
  assert.match(a.error, /GitHub did not take the App's JWT \(HTTP 401/);
});

// ---------------------------------------------------------------- serve, through the socket

test("serve: a review through the socket, against the stand-in; the key, JWT and token stay on the key's side", async () => {
  gh.reset();
  const ks = await keyService();
  const a = await ask(ks, reviewRequest());
  assert.equal(a.ok, true, a.error ?? ks.stderr());
  assert.equal(a.review.state, "APPROVED");
  assert.equal(a.review.commit_id, HEAD);
  assert.deepEqual(gh.calls(), FULL.map((c) => c.replace(/\/installations\/\d+\//, `/installations/${INSTALLATION}/`)));
  assert.equal(gh.seen[0].jwt, "ok", "the stand-in checked the JWT");
  assert.deepEqual(gh.seen[0].body, { repositories: ["review-target"], permissions: { pull_requests: "write" } });
  assert.deepEqual(gh.seen[3].body, { commit_id: HEAD, event: "APPROVE", body: "Looks right." });
  assert.ok(gh.seen.every((r) => r.version === "2022-11-28"));
  assert.ok(!("contents" in gh.seen[0].body.permissions), "never contents, though the installation holds contents:write");
  assert.deepEqual(gh.unrevoked(), [], "every token revoked");
  const minted = gh.tokens.at(-1);
  assert.ok(minted.length > 255 && minted.split(".").length === 3, "the stand-in handed out a stateless token, as GitHub does now");
  assert.ok(gh.revoked.has(minted));
  const err = ks.stderr();
  assert.match(err, /github-review: ledger \{"action":"review","repo":"example-org\/review-target","pr":12,.*"result":"posted".*"token_revoked":true\}/);
});

test("serve: a 40-character token, as GitHub handed them out before, works the same", async () => {
  gh.reset();
  gh.set({ tokenForm: "legacy" });
  const ks = await keyService();
  const a = await ask(ks, reviewRequest());
  assert.equal(a.ok, true, a.error ?? ks.stderr());
  assert.equal(gh.tokens.at(-1).length, 40);
  assert.deepEqual(gh.calls(), FULL.map((c) => c.replace(/\/installations\/\d+\//, `/installations/${INSTALLATION}/`)));
  assert.ok(gh.revoked.has(gh.tokens.at(-1)));
  gh.reset();
});

test("serve: a token refused for its form, against the stand-in: revoked when it can be sent back, never sent when it cannot", async () => {
  const filler = (n) => "Q".repeat(n);
  for (const [what, token, revoked] of [
    ["5000 characters", `${GHS}${filler(4996)}`, true],
    ["a newline", `${GHS}${filler(30)}\n${filler(10)}`, false],
    ["a carriage return and a header after it", `${GHS}${filler(30)}\r\nX-Injected: 1`, false],
    ["a space", `${GHS}${filler(30)} ${filler(10)}`, false],
  ]) {
    gh.reset();
    gh.set({ tokenValue: token });
    const ks = await keyService();
    const a = await ask(ks, reviewRequest());
    assert.equal(a.ok, false, what);
    assert.match(a.error, /GitHub's token is not one this key service takes/, what);
    const calls = revoked ? [TOKEN_CALL, REVOKE_CALL] : [TOKEN_CALL];
    assert.deepEqual(gh.calls(), calls.map((c) => c.replace(/\/installations\/\d+\//, `/installations/${INSTALLATION}/`)), what);
    assert.equal(gh.revoked.has(token), revoked, what);
    await waitForText(ks, new RegExp(`"result":"refused".*"token_revoked":${revoked}\\}`), `${what}: the ledger`);
  }
  gh.reset();
});

test("apiClient: a header node will not send is no request, and no throw", async () => {
  gh.reset();
  const api = apiClient(gh.origin);
  for (const auth of ["a\nb", "a\r\nX-Injected: 1", "a\u0000b"]) {
    assert.deepEqual(await api({ method: "GET", path: "/app", auth }), { status: 0 });
  }
  assert.deepEqual(gh.calls(), [], "nothing reached the stand-in");
  // A path the stand-in does not serve: answered 404, and no JWT recorded.
  const r = await api({ method: "GET", path: "/not-a-route", auth: "a-header-node-sends" });
  assert.equal(r.status, 404, "a header it can send goes out");
  assert.deepEqual(gh.calls(), ["GET /not-a-route"]);
  gh.reset();
});

test("serve: fingerprint (no network) and app", async () => {
  gh.reset();
  const ks = await keyService();
  let a = await ask(ks, { action: "fingerprint" });
  assert.deepEqual(a, { ok: true, action: "fingerprint", fingerprint: fingerprint(KEY) });
  assert.deepEqual(gh.calls(), []);
  a = await ask(ks, { action: "app" });
  assert.equal(a.ok, true, a.error ?? ks.stderr());
  assert.equal(a.app.slug, "review-bot");
  assert.deepEqual(gh.calls(), ["GET /app"]);
  assert.equal(gh.seen[0].jwt, "ok");
});

test("serve: refusals before GitHub is asked anything", async () => {
  gh.reset();
  const ks = await keyService();
  for (const [what, request, why] of [
    ["off the allowlist", reviewRequest({ repo: "example-org/not-listed" }), /not on this key service's list/],
    ["COMMENT, which the settings do not allow", reviewRequest({ event: "COMMENT", body: "x" }), /COMMENT is not allowed here/],
    ["a merge", { action: "merge", repo: REPO, pr: 12 }, /must be review, fingerprint or app/],
    ["an installation of its own", { ...reviewRequest(), installation: 1 }, /exactly the fields/],
    ["a short sha", reviewRequest({ head_sha: "abc1234" }), /head_sha must be/],
  ]) {
    const a = await ask(ks, request);
    assert.equal(a.ok, false, what);
    assert.match(a.error, why, what);
  }
  assert.deepEqual(gh.calls(), []);
  const raw = await rawAsk(join(ks.dir, SOCKET_NAME), "this is not JSON\n");
  outputs.push(raw);
  assert.match(raw, /"ok":false,"error":"the request is not one JSON object"/);
  const big = await rawAsk(join(ks.dir, SOCKET_NAME), "x".repeat(200 * 1024));
  outputs.push(big);
  assert.match(big, /"ok":false,"error":"the request must be one line of at most 131072 bytes, sent within 5 s"/);
  assert.deepEqual(gh.calls(), []);
});

/** A raw connection: what the key service answers to bytes that are not a request. */
function rawAsk(path, bytes) {
  return new Promise((resolve) => {
    let text = "";
    const c = createConnection(path);
    c.on("connect", () => c.end(bytes));
    c.on("data", (d) => (text += d));
    c.on("error", () => {});
    c.on("close", () => resolve(text));
  });
}

test("serve: the head moved under the stand-in: no review, the token revoked", async () => {
  gh.reset();
  gh.set({ pr: { ...gh.defaults().pr, head: sha() } });
  const ks = await keyService();
  const a = await ask(ks, reviewRequest());
  assert.equal(a.ok, false);
  assert.match(a.error, /read it again/);
  assert.deepEqual(gh.calls(), [TOKEN_CALL, PR_CALL, REVOKE_CALL].map((c) => c.replace(/\/installations\/\d+\//, `/installations/${INSTALLATION}/`)));
  assert.deepEqual(gh.unrevoked(), [], "every token revoked");
  gh.reset();
});

test("serve: a push right after the post, under the stand-in: not ok, and the token revoked", async () => {
  gh.reset();
  const moved = sha();
  gh.set({ headAfterReview: moved });
  const ks = await keyService();
  const a = await ask(ks, reviewRequest());
  assert.equal(a.ok, false);
  assert.match(a.error, new RegExp(`head moved while the review was posted \\(now ${moved}\\)`));
  assert.equal(gh.calls().length, 6);
  assert.deepEqual(gh.unrevoked(), [], "every token revoked");
  await waitForText(ks, /"result":"posted, head moved","check":"head".*"head_after":"[0-9a-f]{40}"/, "the ledger");
  gh.reset();
});

test("serve: a request line that does not come within 5 s is refused", async () => {
  gh.reset();
  const ks = await keyService();
  const raw = await new Promise((resolve) => {
    let text = "";
    const c = createConnection(join(ks.dir, SOCKET_NAME));
    c.on("data", (d) => (text += d));
    c.on("error", () => {});
    c.on("close", () => resolve(text));
    setTimeout(() => c.destroy(), 15_000);
  });
  outputs.push(raw);
  assert.match(raw, /"ok":false,"error":"the request must be one line of at most 131072 bytes, sent within 5 s"/);
  assert.deepEqual(gh.calls(), []);
});

test("keyFdProblem: the key's descriptor must be root's (a file of this user's is refused)", { skip: ME === 0 && "root owns what it makes" }, () => {
  const fd = openSync(KEY_FILE, "r");
  try {
    assert.match(keyFdProblem(fd, new Set([0])), new RegExp(`owned by uid ${ME}`));
    assert.equal(keyFdProblem(fd, new Set([0, ME])), null);
  } finally {
    closeSync(fd);
  }
});

test("serve: past its time limit, the token it holds is revoked", async () => {
  gh.reset();
  gh.set({ stallReview: true });
  const before = gh.tokens.length;
  const ks = await keyService({ env: { GP_TEST_SERVE_CONNECTION_MS: "2000" } });
  const a = await ask(ks, reviewRequest());
  assert.deepEqual(a, { ok: false, error: "the key service took too long" });
  assert.equal(gh.tokens.length, before + 1, "one token minted");
  assert.ok(gh.revoked.has(gh.tokens.at(-1)), "and revoked by the time limit, the review never having answered");
  assert.deepEqual(gh.calls(), [TOKEN_CALL, PR_CALL, COMMITS_CALL, REVIEW_CALL, REVOKE_CALL].map((c) => c.replace(/\/installations\/\d+\//, `/installations/${INSTALLATION}/`)));
  await waitForText(ks, /"action":"timeout","token_revoked":true/, "the ledger");
  gh.reset();
});

test("serve: with only its code trusted, a key file this user owns is refused", { skip: ME === 0 && "root owns what it makes" }, async () => {
  gh.reset();
  const ks = await keyService({ env: { GP_TEST_SERVE_TRUST_OWN_UID: "code" } });
  const a = await ask(ks, { action: "fingerprint" });
  assert.equal(a.ok, false);
  assert.match(a.error, /not set up right; its journal says why/);
  await waitForText(ks, new RegExp(`serve: the key file is owned by uid ${ME}`), "the key's owner");
  assert.doesNotMatch(ks.stderr(), /refusing to run code/, "the code passed; the key's own check refused");
  assert.deepEqual(gh.calls(), []);
});

test("serve: refuses to start, before any request, when it is not set up right", async () => {
  const cases = [
    ["NODE_TLS_REJECT_UNAUTHORIZED", { env: { NODE_TLS_REJECT_UNAUTHORIZED: "0" } }, /NODE_TLS_REJECT_UNAUTHORIZED is set/],
    ["NODE_EXTRA_CA_CERTS", { env: { NODE_EXTRA_CA_CERTS: "/dev/null" } }, /NODE_EXTRA_CA_CERTS is set/],
    ["NODE_OPTIONS", { env: { NODE_OPTIONS: "--no-warnings" } }, /NODE_OPTIONS is set/],
    ["SSLKEYLOGFILE", { env: { SSLKEYLOGFILE: "/dev/null" } }, /SSLKEYLOGFILE is set/],
    ["NODE_USE_ENV_PROXY", { env: { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://127.0.0.1:9" } }, /NODE_USE_ENV_PROXY is set/],
    ["a node option", { args: ["--no-warnings"] }, /node was started with options/],
    ["no key descriptor named", { env: { LISTEN_FDNAMES: "connection:buzz-key" } }, /must name exactly one file descriptor github-app-key/],
    ["no descriptors", { env: { LISTEN_FDS: undefined } }, /no file descriptors were handed over/],
    ["a bad client ID", { env: { GITHUB_APP_CLIENT_ID: "nope" } }, /github.conf: GITHUB_APP_CLIENT_ID/],
    ["no allowlist", { env: { GITHUB_REVIEW_REPOS: undefined } }, /github.conf: GITHUB_REVIEW_REPOS is empty/],
    ["the stand-in's switch under systemd", { env: { INVOCATION_ID: "0123" } }, /GP_TEST_GITHUB_API is set under systemd/],
    ["the stand-in's switch not on 127.0.0.1", { env: { GP_TEST_GITHUB_API: "http://192.0.2.1:80" } }, /must be http:\/\/127.0.0.1:<port>/],
    ["a test time limit out of range", { env: { GP_TEST_SERVE_CONNECTION_MS: "500" } }, /GP_TEST_SERVE_CONNECTION_MS must be 1000 to 100000/],
    // The limits' own settings: none may be missing or wrong, or the key service would run without them.
    ["no own logins", { env: { GITHUB_REVIEW_OWN_LOGINS: undefined } }, /github.conf: GITHUB_REVIEW_OWN_LOGINS is empty/],
    ["a person as the own login", { env: { GITHUB_REVIEW_OWN_LOGINS: BUILDER_LOGIN } }, /GITHUB_REVIEW_OWN_LOGINS must be an App's bot login/],
    ["no own emails", { env: { GITHUB_REVIEW_OWN_EMAILS: undefined } }, /github.conf: GITHUB_REVIEW_OWN_EMAILS is empty/],
    ["the builders' shared noreply author as the own email", { env: { GITHUB_REVIEW_OWN_EMAILS: BUILDER_EMAIL } }, /GITHUB_REVIEW_OWN_EMAILS must be an App's bot noreply address/],
    ["a COMMENT switch that is not 0 or 1", { env: { GITHUB_REVIEW_ALLOW_COMMENT: "yes" } }, /GITHUB_REVIEW_ALLOW_COMMENT must be 0 or 1/],
    ["no rules file named", { env: { GITHUB_REVIEW_PUBLIC_TEXT_FILE: undefined } }, /must be the absolute path of the public-text rules file/],
  ];
  const rulesDir = privateDir("rules-start");
  for (const [what, text, why] of [
    ["not JSON", "not json", /serve: the public-text rules are not JSON/],
    ["an empty list", "[]", /serve: the public-text rules must be a list of 1 to 200 rules/],
    ["a rule that matches everything", '[{"name":"all","pattern":".*"}]', /serve: public-text rule all: the pattern matches the empty text/],
    ["a rule in Python's syntax only", '[{"name":"py","pattern":"(?P<n>x)"}]', /serve: public-text rule py: the pattern has a group other than/],
    ["a rule that does not compile", '[{"name":"py","pattern":"("}]', /serve: public-text rule py: the pattern does not compile/],
    ["a rule that backtracks without end", '[{"name":"slow","pattern":"(a|aa)+c"}]', /serve: public-text rule slow: the pattern takes too long on a test text/],
  ]) {
    const f = join(rulesDir, `${what.replace(/\W+/g, "-")}.json`);
    writeFileSync(f, text);
    cases.push([`a rules file that is ${what}`, { env: { GITHUB_REVIEW_PUBLIC_TEXT_FILE: f } }, why]);
  }
  cases.push(["a rules file that is not there", { env: { GITHUB_REVIEW_PUBLIC_TEXT_FILE: join(rulesDir, "missing.json") } }, /serve: the public-text rules file is not there/]);
  // The rules are root's to write: a file in a folder others can write is not read, even when this user owns it.
  const openDir = privateDir("rules-open");
  chmodSync(openDir, 0o777);
  const openRules = join(openDir, "public-text.json");
  writeFileSync(openRules, JSON.stringify(RULES));
  cases.push(["a rules file in a folder others can write", { env: { GITHUB_REVIEW_PUBLIC_TEXT_FILE: openRules } }, /serve: the public-text rules file could be changed by a user other than root/]);
  if (ME !== 0) {
    cases.push(["code it does not trust (no test switch)", { env: { GP_TEST_SERVE_TRUST_OWN_UID: undefined } }, /refusing to run code that a user other than root can change/]);
    // Under systemd the test switch is ignored, so this user's code is not
    // trusted. (No stand-in switch here: under systemd it is refused, and the
    // request below, a fingerprint, asks GitHub nothing.)
    cases.push([
      "the trust switch under systemd",
      { env: { INVOCATION_ID: "0123", GP_TEST_GITHUB_API: undefined }, request: { action: "fingerprint" } },
      /GP_TEST_SERVE_TRUST_OWN_UID is ignored under systemd[\s\S]*refusing to run code that a user other than root can change/,
    ]);
    const open = join(privateDir("open"), "github-app.pem");
    writeFileSync(open, KEY_PEM, { mode: 0o640 });
    cases.push(["a key file its group can read", { keyFile: open }, /permissions for its group or for others/]);
  }
  for (const [what, opts, why] of cases) {
    gh.reset();
    const ks = await keyService(opts);
    const a = await ask(ks, opts.request ?? reviewRequest());
    assert.equal(a.ok, false, what);
    assert.match(a.error, /not set up right; its journal says why/, what);
    await waitForText(ks, why, what);
    assert.deepEqual(gh.calls(), [], `${what}: GitHub was asked nothing`);
  }
});

async function waitForText(ks, re, what) {
  for (let i = 0; i < 100; i++) {
    if (re.test(ks.stderr())) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.match(ks.stderr(), re, what);
}

test("serve: systemd 259's descriptor list (one name for each) works too", async () => {
  gh.reset();
  const ks = await keyService({ names: "github-app-key" });
  const a = await ask(ks, { action: "fingerprint" });
  assert.equal(a.ok, true, ks.stderr());
});

test("gp-github-review: the session's command line, through the socket", async () => {
  gh.reset();
  const ks = await keyService({ env: { GITHUB_REVIEW_ALLOW_COMMENT: "1" } });
  const run = (args, input) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [CLIENT, "--socket", ks.dir, ...args], { env: { PATH: process.env.PATH } });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => {
        outputs.push(out, err);
        resolve({ code, out, err });
      });
      child.stdin.end(input ?? "");
    });
  let r = await run(["review", REPO, "12", HEAD, "REQUEST_CHANGES", "-"], "Please fix the test.\n");
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, new RegExp(`^posted: CHANGES_REQUESTED on ${REPO}#12 at ${HEAD} https://github.com/`));
  assert.deepEqual(gh.seen[3].body, { commit_id: HEAD, event: "REQUEST_CHANGES", body: "Please fix the test.\n" });
  r = await run(["review", "example-org/not-listed", "12", HEAD, "APPROVE"]);
  assert.equal(r.code, 1);
  assert.equal(r.err, "refused: repo: example-org/not-listed is not on this key service's list\n", "one line: refused: <check>: <clause>");
  r = await run(["--json", "fingerprint"]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { ok: true, action: "fingerprint", fingerprint: fingerprint(KEY) });
  const before = gh.seen.length;
  r = await run(["review", REPO, "12", HEAD, "COMMENT", "-"], "x".repeat(MAX_BODY + 1));
  assert.equal(r.code, 2, "a body on stdin over the cap is a usage error");
  assert.match(r.err, /the body on stdin is longer than 60000 bytes/);
  assert.equal(gh.seen.length, before, "nothing was sent");
  r = await run(["review", REPO, "12", HEAD, "COMMENT", "-"], "y".repeat(MAX_BODY));
  assert.equal(r.code, 0, `a body at the cap is sent whole: ${r.err}`);
  assert.equal(gh.seen.find((x) => x.path.endsWith("/reviews") && x.body.body.length === MAX_BODY)?.body.body, "y".repeat(MAX_BODY));
  r = await run(["merge", REPO, "12"]);
  assert.equal(r.code, 2);
  r = await run(["review", REPO, "x", HEAD, "APPROVE"]);
  assert.equal(r.code, 2);
});

// ---------------------------------------------------------------- the key file

/** Runs `github-review.mjs keyfile ...`, with stdin from `input`. */
function kf(args, input) {
  const r = spawnSync(process.execPath, [MODULE, "keyfile", ...args], { input: input ?? "", encoding: "utf8" });
  outputs.push(r.stdout, r.stderr);
  return r;
}

test("keyfile: write once, 0400, PKCS#1; replace on purpose; only fingerprints printed", () => {
  const dir = privateDir("keyfile");
  const path = join(dir, "github-app.pem");
  let r = kf(["write", path], KEY_PEM);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `fingerprint ${fingerprint(KEY)}\n`);
  assert.equal(statSync(path).mode & 0o777, 0o400);
  const written = readFileSync(path, "utf8");
  assert.match(written, /^-----BEGIN RSA PRIVATE KEY-----\n/);
  assert.equal(fingerprint(createPrivateKey(written)), fingerprint(KEY));
  r = kf(["write", path], OTHER_PEM);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists; it is replaced only with --replace-github-app-key/);
  assert.equal(fingerprint(createPrivateKey(readFileSync(path, "utf8"))), fingerprint(KEY), "the first one stays");
  r = kf(["fingerprint", path]);
  assert.equal(r.stdout, `fingerprint ${fingerprint(KEY)}\n`);
  r = kf(["replace", path], KEY_PEM);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the new key is the key that is there already/);
  // What an earlier run left beside the key, and the key a swap replaces: overwritten, removed.
  writeFileSync(join(dir, ".github-app.pem.new-4242"), "half-written", { mode: 0o400 });
  writeFileSync(join(dir, ".github-app.pem.old-4242"), "an old key", { mode: 0o400 });
  // An open descriptor on the old key, to see its bytes after (a second name
  // would rightly keep it from being overwritten).
  const oldKey = openSync(path, "r");
  r = kf(["replace", path], OTHER_PEM);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(dir).filter((n) => n.startsWith(".github-app.pem")), [], "nothing left beside the key");
  const left = readFileSync(oldKey);
  closeSync(oldKey);
  assert.ok(left.length > 0 && left.every((b) => b === 0), "the replaced key's bytes are overwritten with zeros");
  const other = fingerprint(createPrivateKey(OTHER_PEM));
  assert.equal(r.stdout, `fingerprint ${other}\nprevious ${fingerprint(KEY)}\n`);
  assert.equal(fingerprint(createPrivateKey(readFileSync(path, "utf8"))), other);
  assert.equal(statSync(path).mode & 0o777, 0o400);
  r = kf(["replace", join(dir, "missing.pem")], KEY_PEM);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nothing to replace/);
  for (const [what, text] of [["1024 bits", pemOf(1024)], ["two keys", KEY_PEM + OTHER_PEM], ["not a key", "hello\n"]]) {
    const p = join(dir, `${what.replace(/ /g, "-")}.pem`);
    r = kf(["write", p], text);
    assert.equal(r.status, 1, what);
    assert.ok(!existsSync(p), `${what}: nothing written`);
  }
  if (ME !== 0) {
    const open = join(dir, "open.pem");
    writeFileSync(open, KEY_PEM, { mode: 0o644 });
    r = kf(["fingerprint", open]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /must be readable by its owner only/);
  }
  r = kf(["write", "relative.pem"], KEY_PEM);
  assert.equal(r.status, 2);
});

// A run stopped between linkSync and unlinkSync (write) or between linkSync
// and the rename (replace) leaves a .new-* or .old-* name for the live key's
// own bytes. The next run removes that name and keeps the key.
for (const kind of ["new", "old"]) {
  test(`keyfile: a .${kind}-* leftover that is a second name for the live key is removed; the key keeps its bytes and mode`, () => {
    const dir = privateDir(`linked-${kind}`);
    const path = join(dir, "github-app.pem");
    let r = kf(["write", path], KEY_PEM);
    assert.equal(r.status, 0, r.stderr);
    const bytes = readFileSync(path);
    linkSync(path, join(dir, `.github-app.pem.${kind}-4242`));
    r = kf(["fingerprint", path]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `fingerprint ${fingerprint(KEY)}\n`);
    assert.deepEqual(readdirSync(dir), ["github-app.pem"], "the leftover name is gone");
    assert.ok(readFileSync(path).equals(bytes), "the live key keeps its bytes");
    assert.equal(statSync(path).mode & 0o777, 0o400, "and its mode");
    assert.equal(statSync(path).nlink, 1);
  });
}

test("keyfile: a leftover with a name elsewhere is removed, never overwritten", () => {
  const dir = privateDir("linked-elsewhere");
  const path = join(dir, "github-app.pem");
  let r = kf(["write", path], KEY_PEM);
  assert.equal(r.status, 0, r.stderr);
  const elsewhere = join(privateDir("elsewhere"), "kept");
  writeFileSync(elsewhere, "kept elsewhere", { mode: 0o400 });
  linkSync(elsewhere, join(dir, ".github-app.pem.old-77"));
  r = kf(["fingerprint", path]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(dir), ["github-app.pem"]);
  assert.equal(readFileSync(elsewhere, "utf8"), "kept elsewhere");
  assert.equal(statSync(elsewhere).mode & 0o777, 0o400);
});

test("keyfile: never from a terminal", { skip: spawnSync("python3", ["--version"]).status !== 0 && "no python3" }, () => {
  const path = join(privateDir("tty"), "github-app.pem");
  const r = spawnSync(
    "python3",
    ["-I", "-c", "import os, subprocess, sys\nm, s = os.openpty()\nsys.exit(subprocess.run(sys.argv[1:], stdin=s, timeout=60).returncode)", process.execPath, MODULE, "keyfile", "write", path],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 2);
  assert.match(r.stderr, /never from a terminal/);
  assert.ok(!existsSync(path));
});
