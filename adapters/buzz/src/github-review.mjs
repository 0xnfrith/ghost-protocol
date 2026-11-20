#!/usr/bin/env node
// github-review.mjs: a key service's GitHub review action. A reviewer's
// GitHub App private key stays with the key's user, as the relay key does
// (README.md, "Key service"; the top-level README, "The GitHub App slot"),
// and the session gets one fixed action through a Unix socket: post a review
// on a pull request in an allowed repo, pinned to the head commit it read.
// The key, a JWT or a token never leave the key's side, and nothing else the
// App could do is offered: no merge, no update-branch, no contents write.
//
//   node github-review.mjs serve
//       the key's side, run by systemd as the App key's own user (never the
//       relay key's user, which runs buzz-mcp), one process per connection
//       (gp-key-<name>-github@.service): one JSON request in, one
//       JSON answer out. The App key arrives as the file descriptor systemd
//       opened (OpenFile=<key file>:github-app-key:read-only); the client ID
//       and the allowlist come from github.conf (EnvironmentFile=).
//   node github-review.mjs keyfile write|replace|fingerprint <path>
//       the key file, run as root by install/keyservice/setup from its
//       root-owned copy: write a new one from stdin (a PEM RSA private key of
//       2048 bits or more; a pipe or a file, never a terminal), swap the one
//       there for a new one from stdin, or read the one there. Each prints
//       only fingerprints, as GitHub shows them. Each first overwrites with
//       zeros and removes what an earlier run left beside the key
//       (.<name>.new-*, .<name>.old-*), and a swap does the same to the key
//       it replaced.
//   node github-review.mjs rules check <path>
//       the public-text rules file (see parseRules), run as root by
//       install/keyservice/setup from its root-owned copy before it installs
//       one: prints "rules <n>" or why the file is refused.
//   node github-review.mjs [--socket <folder>] [--json] review <owner/repo> <pr> <head-sha> <event> [<body> | -]
//   node github-review.mjs [--socket <folder>] [--json] fingerprint|app
//       the session's side (tools/github-review/gp-github-review): it holds
//       no key, and only sends the request and prints the answer.
//
// The socket answers three requests, each one JSON object on one line:
//   {"action":"review","repo":"<owner>/<repo>","pr":<n>,"head_sha":"<40 hex>",
//    "event":"APPROVE"|"REQUEST_CHANGES"|"COMMENT","body":"<text>"}
//       In this order: every field is checked; the repo must be on the
//       allowlist, whose entry names the installation (the request never
//       does), and COMMENT only goes where the settings allow it; only then
//       is the key read. It mints a token for that one repo
//       with pull_requests:write alone, never contents, and refuses one
//       GitHub makes wider, or one it cannot take as an opaque string (20 to
//       4096 characters of letters, digits, _, . and -). (A reviewer App
//       holds contents:write on its installation, which its approval needs
//       to count; an approval made with a token asked for pull_requests:write
//       alone counts all the same, and that token cannot push.) It reads the
//       pull request once, and from that one answer refuses unless it is open
//       and its head is <head-sha>, its title does not start with HOLD: and it
//       has no hold label, it is not a draft, it is not the reviewer's own
//       (its author is not one of the settings' own logins), and, in a repo
//       that is not private, the body passes the public-text rules. It then
//       lists the pull request's commits (at most 100, as many as the pull
//       request says, the head among them) and refuses one authored by an own login or an own email. It
//       posts the review with commit_id <head-sha>; reads the pull request
//       again, and answers ok only when the head is still <head-sha> and it
//       is neither held nor a draft now (a change between the check and the
//       post is answered "not ok", with the review it posted, which the
//       repo's rules or the reviewer's lead must deal with); then revokes
//       the token. Once GitHub made a token, it is revoked on every way out,
//       a refused one too. Every request leaves one ledger line in the
//       journal.
//       A refusal for a limit names its check: {"ok":false,"check":"hold",
//       "error":"the title starts with HOLD:"}. The checks are repo, event,
//       open, head, hold, draft, own-pr, own-commit and public-text; a failure
//       that is not a limit (no token, no answer from GitHub) names none.
//   {"action":"fingerprint"}   the App key's fingerprint (no network)
//   {"action":"app"}           GET /app with a JWT: the App's id, slug, owner
//                              and permissions, after checking that its
//                              client ID is the configured one
// The answer: {"ok":true,...} or {"ok":false,"error":"<why>"}.
//
// Only Node.js built-ins: the key's side never installs anything.
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import { createConnection } from "node:net";
import { basename, dirname, join } from "node:path";
import { isatty } from "node:tty";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { keyFdProblem, namedFd, readFd, untrustedCode } from "./keyservice.mjs";

/** The one origin the key's side talks to. */
export const GITHUB_API = "https://api.github.com";
export const KEY_FD_NAME = "github-app-key";
export const SOCKET_NAME = "github.sock";
export const EVENTS = new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"]);
/** A review's body, in bytes of UTF-8 (GitHub takes up to 65536 characters). */
export const MAX_BODY = 60_000;
const MAX_REQUEST = 128 * 1024;
const MAX_ANSWER = 256 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const MAX_PEM = 16 * 1024;
const MAX_REPOS = 100;
/**
 * The request line must arrive within READ_MS; each GitHub request takes at
 * most REQUEST_MS, and a review makes six (the token, the pull request, its
 * commits, the review, the pull request again, the revoke). CONNECTION_MS is
 * above both together (5 + 6 x 15 = 95 s) and, with the revoke it makes when
 * it fires, under the unit's RuntimeMaxSec=2min.
 */
const READ_MS = 5_000;
const REQUEST_MS = 15_000;
const CONNECTION_MS = 100_000;
/** The client waits longer than the key's side can take. */
const CALL_MS = 130_000;
/** A JWT's iat is set back for clock drift; its exp stays under GitHub's 10 minutes. */
export const JWT_BACKDATE_S = 60;
export const JWT_LIFETIME_S = 540;
/**
 * Test switches for serve, each ignored or refused under systemd (INVOCATION_ID
 * set). The trust switch "1" trusts this user's own files as root's, for the
 * code and the key file; "code" for the code only, so the key file's owner is
 * checked as it is in production. The connection limit, in milliseconds
 * (1000 to CONNECTION_MS), counts only with the stand-in for GitHub.
 */
const TEST_TRUST_SWITCH = "GP_TEST_SERVE_TRUST_OWN_UID";
const TEST_CONNECTION_SWITCH = "GP_TEST_SERVE_CONNECTION_MS";
/** For this module's own tests only: a stand-in for GitHub on 127.0.0.1. Refused under systemd. */
export const TEST_API_SWITCH = "GP_TEST_GITHUB_API";

const RE_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const RE_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const RE_SHA = /^[0-9a-f]{40}$/;
const RE_CLIENT_ID = /^Iv[0-9A-Za-z.]{6,40}$/;
const RE_INSTALLATION = /^[1-9][0-9]{0,11}$/;
/**
 * An installation token, taken as GitHub says to take it: an opaque string,
 * with no fixed length or inner form. Since October 2026 GitHub's tokens are
 * stateless (still ghs_, but about 520 characters with dots in them, and the
 * length varies); before, 40 characters. Only the characters here go into a
 * header: no space, no control character, nothing that could end the header.
 */
export const MAX_TOKEN = 4096;
const RE_TOKEN = new RegExp(`^[A-Za-z0-9_.-]{20,${MAX_TOKEN}}$`);
/**
 * A token the answer holds, though refused, is still revoked when it can go
 * into a header as it is: visible ASCII only (Node refuses a header with a
 * control character, and a space would change what the header says).
 */
const RE_REVOCABLE = /^[\x21-\x7e]{1,16384}$/;
const RE_SLUG = /^[a-z0-9][a-z0-9-]{0,99}$/;
const RE_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\[bot\])?$/;
const PR_MAX = 2 ** 31 - 1;
/**
 * The reviewer's own identities, as the settings name them: only an App's bot
 * (a login ending [bot], a noreply address with [bot] before the @), never a
 * person's. The builders' shared noreply author has no [bot], so it cannot be
 * written down as the reviewer's own, which would refuse every review.
 */
const RE_OWN_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\[bot\]$/;
const RE_OWN_EMAIL = /^[0-9]{1,12}\+[A-Za-z0-9][A-Za-z0-9-]{0,38}\[bot\]@users\.noreply\.github\.com$/;
const MAX_OWN = 10;
const RE_RULES_PATH = /^\/[A-Za-z0-9._+/-]{1,200}$/;
/** A check's name, as a refusal carries it. */
const RE_CHECK = /^[a-z][a-z-]{0,29}$/;
/** A pull request's commits are read in one page, so a pull request over this is refused. */
export const MAX_COMMITS = 100;
/** The public-text rules file: at most this many bytes, rules, characters of a pattern. */
export const MAX_RULES_BYTES = 256 * 1024;
export const MAX_RULES = 200;
export const MAX_PATTERN = 500;
const RE_RULE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
/**
 * A rule's match against a body is cut off after MATCH_MS, and all the rules
 * together after MATCH_TOTAL_MS (matching is synchronous: without a cut-off a
 * pattern that backtracks without end would stall the process, with its
 * token unrevoked, until the unit's stop). A pattern is tried against the
 * PROBES when the rules are read, with the same cut-off, and refused if it
 * runs out of time. MATCH_TOTAL_MS plus the six requests' 90 s and the 5 s
 * to read the request stay under CONNECTION_MS.
 */
export const MATCH_MS = 100;
export const MATCH_TOTAL_MS = 2_000;
const PROBES = ["a".repeat(30), `${"a".repeat(50)}!`, `${"ab".repeat(25)}!`, `${"a ".repeat(25)}!`, `${"0".repeat(50)}x`, "x".repeat(60)];

// Settings that make node, OpenSSL or the loader run other code in this
// process before the server, or loosen its TLS, or log its traffic.
const REFUSED_VARIABLES = [
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_COMPILE_CACHE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "OPENSSL_CONF",
  "OPENSSL_MODULES",
  "OPENSSL_ENGINES",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SSLKEYLOGFILE",
  "NODE_USE_ENV_PROXY",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
];
const ALLOWED_NODE_OPTIONS = new Set(["--disable-sigusr1"]);

/**
 * A refusal, with a fixed reason that never holds a key, a JWT or a token,
 * and, for a limit, the name of the check that failed (check).
 */
export class Refusal extends Error {
  constructor(why, check) {
    super(why);
    this.check = check;
  }
}
const refuse = (why, check) => {
  throw new Refusal(why, check);
};

// ---------------------------------------------------------------- the settings

/**
 * A comma-separated list of between 1 and MAX_OWN identities, each matching
 * `re`, with none twice (in any case): the lower-cased set, or a Refusal that
 * names `name`.
 */
function identityList(env, name, re, form) {
  const list = env[name] ?? "";
  if (!list) refuse(`${name} is empty: name the reviewer's own identities (${form})`);
  const out = new Set();
  for (const item of list.split(",")) {
    if (!re.test(item)) refuse(`${name} must be ${form}, comma-separated`);
    if (out.has(item.toLowerCase())) refuse(`${name} names ${item.toLowerCase()} twice`);
    out.add(item.toLowerCase());
  }
  if (out.size > MAX_OWN) refuse(`${name} names more than ${MAX_OWN} identities`);
  return out;
}

/**
 * github.conf, as the unit hands it over (EnvironmentFile=):
 *   GITHUB_APP_CLIENT_ID=<the App's client ID>
 *   GITHUB_REVIEW_REPOS=<installation id>:<owner>/<repo>[,...]
 *   GITHUB_REVIEW_OWN_LOGINS=<login>[bot][,...]   the reviewer's own GitHub logins (its App's bot)
 *   GITHUB_REVIEW_OWN_EMAILS=<id>+<login>[bot]@users.noreply.github.com[,...]
 *   GITHUB_REVIEW_ALLOW_COMMENT=0|1               whether COMMENT may be posted (0 when absent)
 *   GITHUB_REVIEW_PUBLIC_TEXT_FILE=<absolute path> the public-text rules (see parseRules)
 * Returns { clientId, repos: Map<"owner/repo" lower-cased, { installation, owner, name }>,
 * ownLogins, ownEmails (lower-cased Sets), allowComment, publicTextFile },
 * or throws a Refusal. A setting that is missing is an error, not a default,
 * except GITHUB_REVIEW_ALLOW_COMMENT: a key service with no limits is not set up.
 */
export function parseConfig(env) {
  const clientId = env.GITHUB_APP_CLIENT_ID ?? "";
  if (!RE_CLIENT_ID.test(clientId)) refuse("GITHUB_APP_CLIENT_ID is not a GitHub App client ID (Iv…)");
  const list = env.GITHUB_REVIEW_REPOS ?? "";
  if (!list) refuse("GITHUB_REVIEW_REPOS is empty: name each repo the App may review, as <installation id>:<owner>/<repo>");
  const repos = new Map();
  for (const item of list.split(",")) {
    const m = /^([^:]+):([^/]+)\/([^/]+)$/.exec(item);
    if (!m || !RE_INSTALLATION.test(m[1]) || !RE_OWNER.test(m[2]) || !RE_NAME.test(m[3]) || m[3] === "." || m[3] === "..") {
      refuse("GITHUB_REVIEW_REPOS must be <installation id>:<owner>/<repo>, comma-separated");
    }
    const full = `${m[2]}/${m[3]}`.toLowerCase();
    if (repos.has(full)) refuse(`GITHUB_REVIEW_REPOS names ${full} twice`);
    repos.set(full, { installation: m[1], owner: m[2], name: m[3] });
  }
  if (repos.size > MAX_REPOS) refuse(`GITHUB_REVIEW_REPOS names more than ${MAX_REPOS} repos`);
  const ownLogins = identityList(env, "GITHUB_REVIEW_OWN_LOGINS", RE_OWN_LOGIN, "an App's bot login, <name>[bot]");
  const ownEmails = identityList(env, "GITHUB_REVIEW_OWN_EMAILS", RE_OWN_EMAIL, "an App's bot noreply address, <id>+<name>[bot]@users.noreply.github.com");
  const comment = env.GITHUB_REVIEW_ALLOW_COMMENT ?? "0";
  if (comment !== "0" && comment !== "1") refuse("GITHUB_REVIEW_ALLOW_COMMENT must be 0 or 1");
  const publicTextFile = env.GITHUB_REVIEW_PUBLIC_TEXT_FILE ?? "";
  if (!RE_RULES_PATH.test(publicTextFile) || publicTextFile.split("/").some((part) => part === "." || part === "..")) {
    refuse("GITHUB_REVIEW_PUBLIC_TEXT_FILE must be the absolute path of the public-text rules file");
  }
  return { clientId, repos, ownLogins, ownEmails, allowComment: comment === "1", publicTextFile };
}

// ---------------------------------------------------------------- the public-text rules

/**
 * Why a pattern may not be a rule, or null. The file is written from the
 * fence's own list, in Python's re, and read here by a JavaScript RegExp, so
 * a pattern is refused when the two read it differently (a rule that never
 * matches is worse than none), or when only one of them has it at all:
 * the escapes \A \Z \z (Python's) and \p \P \k \c \u{...} (JavaScript's); a
 * back-reference; {,n} (Python's 0 to n; JavaScript's literal text); a group
 * other than (?:, (?=, (?!, (?<= and (?<! (inline flags, named groups,
 * comments, conditions); a $, which Python also matches before a final
 * newline; and a class that starts with ], which Python reads as a literal
 * ] and JavaScript as an empty class. What is left shares one syntax; the
 * meaning of \w \d \s \b and . on non-ASCII text and on \r still
 * differs, and is for the fleet's parity test against the fence.
 */
function patternProblem(p) {
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") {
      const n = p[i + 1];
      if (n === undefined) return "a backslash at the end";
      if (/[AZzpPkc]/.test(n)) return `the escape \\${n}`;
      if (/[1-9]/.test(n)) return "a back-reference";
      if (n === "u" && p[i + 2] === "{") return "the escape \\u{...}";
      i += 1;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      if (p[i + 1] === "^") i += 1;
      if (p[i + 1] === "]") return "a class that starts with ]";
      continue;
    }
    if (c === "$") return "a $ anchor";
    if (c === "{" && p[i + 1] === ",") return "a {,n} repeat";
    if (c === "(" && p[i + 1] === "?" && !/^\(\?(:|=|!|<=|<!)/.test(p.slice(i, i + 4))) {
      return "a group other than (?:, (?=, (?!, (?<= and (?<!";
    }
  }
  return null;
}

/**
 * Whether `re` matches `text`, cut off after `ms` milliseconds: true or
 * false, or null when it ran out of time. (vm's timeout interrupts a regular
 * expression that is running, which a timer on this thread cannot.)
 */
const matchScript = new vm.Script("re.test(s)");
const matchContext = vm.createContext({ re: null, s: "" });
export function matchWithin(re, text, ms) {
  matchContext.re = re;
  matchContext.s = text;
  try {
    return matchScript.runInContext(matchContext, { timeout: ms });
  } catch (err) {
    if (err?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") return null;
    throw err;
  } finally {
    matchContext.re = null;
    matchContext.s = "";
  }
}

/**
 * The public-text rules, from the text of their file: a JSON array of
 * { "name": "<slug>", "pattern": "<regular expression>", "ignore_case": true }
 * (ignore_case is optional and false when absent; nothing else is allowed in
 * a rule). Between 1 and MAX_RULES rules, names unique (a name reaches the
 * reviewer in a refusal: a neutral word), a pattern of at most MAX_PATTERN
 * characters that patternProblem lets through, that compiles here (with the
 * u flag, and i when ignore_case is true: code point matching and Unicode
 * case folding, as Python's), does not match the empty text (which would
 * hold against every body), holds no group that holds an unbounded repeat
 * and is itself repeated (the shape that backtracks without end), and runs
 * out of time on none of the PROBES (which catches more of them, and still
 * does not prove a pattern safe: the match is cut off at run time too, and
 * the file is root's).
 * Returns [{ name, re }], or throws a Refusal that names the rule, never a pattern.
 */
export function parseRules(text) {
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    refuse("the public-text rules are not JSON");
  }
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_RULES) refuse(`the public-text rules must be a list of 1 to ${MAX_RULES} rules`);
  const rules = [];
  const seen = new Set();
  list.forEach((r, i) => {
    if (!r || typeof r !== "object" || Array.isArray(r)) refuse(`public-text rule ${i + 1} is not an object`);
    const keys = Object.keys(r).sort().join(",");
    if (keys !== "name,pattern" && keys !== "ignore_case,name,pattern") refuse(`public-text rule ${i + 1} has exactly the fields name, pattern and, optionally, ignore_case`);
    if (typeof r.name !== "string" || !RE_RULE_NAME.test(r.name)) refuse(`public-text rule ${i + 1}'s name must be a slug of at most 40 characters`);
    if (seen.has(r.name)) refuse(`public-text rule ${r.name} is named twice`);
    seen.add(r.name);
    if (Object.hasOwn(r, "ignore_case") && typeof r.ignore_case !== "boolean") refuse(`public-text rule ${r.name}: ignore_case must be true or false`);
    if (typeof r.pattern !== "string" || r.pattern.length < 1 || r.pattern.length > MAX_PATTERN) refuse(`public-text rule ${r.name}: the pattern must be 1 to ${MAX_PATTERN} characters`);
    const unlike = patternProblem(r.pattern);
    if (unlike) refuse(`public-text rule ${r.name}: the pattern has ${unlike}, which Python and JavaScript read differently (or only one has)`);
    if (/\([^()]*[+*][^()]*\)[+*{]/.test(r.pattern)) refuse(`public-text rule ${r.name}: a repeated group that holds an unbounded repeat is not allowed`);
    let re;
    try {
      re = new RegExp(r.pattern, r.ignore_case === true ? "iu" : "u");
    } catch {
      refuse(`public-text rule ${r.name}: the pattern does not compile`);
    }
    if (re.test("")) refuse(`public-text rule ${r.name}: the pattern matches the empty text`);
    for (const probe of PROBES) {
      if (matchWithin(re, probe, MATCH_MS) === null) refuse(`public-text rule ${r.name}: the pattern takes too long on a test text (it can backtrack without end)`);
    }
    rules.push({ name: r.name, re });
  });
  return rules;
}

/**
 * The name of the first rule the text fails, or null. Each rule gets at most
 * `matchMs`, all of them `totalMs`; a rule that runs out of time is a
 * Refusal (check public-text) that names it: the body is not accepted.
 */
export function publicTextProblem(text, rules, { matchMs = MATCH_MS, totalMs = MATCH_TOTAL_MS } = {}) {
  const deadline = Date.now() + totalMs;
  for (const { name, re } of rules) {
    const left = deadline - Date.now();
    const hit = left > 0 ? matchWithin(re, text, Math.min(matchMs, left)) : null;
    if (hit === null) refuse(`the public-text check of the body took too long (rule ${name}), so the body was not accepted`, "public-text");
    if (hit) return name;
  }
  return null;
}

/**
 * The rules from their file: a regular file (no link), at most
 * MAX_RULES_BYTES, and, with `trusted` (a Set of uids), one that nobody but
 * those users could have changed: its owner and every folder above it
 * (untrustedCode). Throws a Refusal.
 */
export function loadRules(path, trusted) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    refuse("the public-text rules file is not there");
  }
  if (!st.isFile()) refuse("the public-text rules file is not a regular file");
  if (st.size > MAX_RULES_BYTES) refuse(`the public-text rules file is longer than ${MAX_RULES_BYTES} bytes`);
  if (trusted) {
    let problem;
    try {
      problem = untrustedCode([path], trusted);
    } catch {
      problem = "the check could not read it";
    }
    if (problem) refuse(`the public-text rules file could be changed by a user other than root: ${problem}`);
  }
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    refuse("the public-text rules file could not be read");
  }
  return parseRules(text);
}

// ---------------------------------------------------------------- the request

const ACTIONS = {
  review: ["action", "repo", "pr", "head_sha", "event", "body"],
  fingerprint: ["action"],
  app: ["action"],
};

/** One request line, checked field by field; throws a Refusal. */
export function parseRequest(line) {
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    refuse("the request is not one JSON object");
  }
  if (!r || typeof r !== "object" || Array.isArray(r)) refuse("the request is not one JSON object");
  if (typeof r.action !== "string" || !Object.hasOwn(ACTIONS, r.action)) refuse("the action must be review, fingerprint or app");
  const keys = ACTIONS[r.action];
  const given = Object.keys(r).sort();
  const wanted = [...keys].sort();
  if (given.length !== wanted.length || given.some((k, i) => k !== wanted[i])) {
    refuse(`a ${r.action} request has exactly the fields ${keys.join(", ")}`);
  }
  if (r.action !== "review") return { action: r.action };
  if (typeof r.repo !== "string") refuse("repo must be <owner>/<repo>");
  const m = /^([^/]+)\/([^/]+)$/.exec(r.repo);
  if (!m || !RE_OWNER.test(m[1]) || !RE_NAME.test(m[2]) || m[2] === "." || m[2] === "..") refuse("repo must be <owner>/<repo>");
  if (!Number.isSafeInteger(r.pr) || r.pr < 1 || r.pr > PR_MAX) refuse("pr must be a pull request number");
  if (typeof r.head_sha !== "string" || !RE_SHA.test(r.head_sha)) refuse("head_sha must be the head commit's full id, 40 lower-case hex");
  if (typeof r.event !== "string" || !EVENTS.has(r.event)) refuse("event must be APPROVE, REQUEST_CHANGES or COMMENT");
  if (typeof r.body !== "string") refuse("body must be text");
  if (Buffer.byteLength(r.body, "utf8") > MAX_BODY) refuse(`the body is longer than ${MAX_BODY} bytes`);
  if (r.body.includes("\u0000")) refuse("the body holds a NUL");
  if (r.event !== "APPROVE" && !r.body.trim()) refuse(`${r.event} needs a body`);
  return { action: "review", repo: r.repo, pr: r.pr, headSha: r.head_sha, event: r.event, body: r.body };
}

// ---------------------------------------------------------------- the key

/**
 * The App key from PEM bytes: exactly one PEM block, an RSA private key of
 * 2048 to 8192 bits, not encrypted. Throws a Refusal (with a fixed reason,
 * never the key). The bytes are the caller's to zero.
 */
export function parseAppKey(bytes) {
  const marker = Buffer.from("-----BEGIN ");
  let count = 0;
  for (let at = bytes.indexOf(marker); at >= 0; at = bytes.indexOf(marker, at + 1)) count += 1;
  if (count !== 1) refuse("the App key must be one PEM block (as GitHub hands it out: one private key)");
  let key;
  try {
    key = createPrivateKey({ key: bytes, format: "pem" });
  } catch {
    refuse("the App key is not a PEM private key (or it is encrypted)");
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (key.asymmetricKeyType !== "rsa" || bits < 2048 || bits > 8192) refuse("the App key must be an RSA private key of 2048 to 8192 bits");
  return key;
}

/** GitHub's fingerprint of a key: SHA-256 of its public key's DER, in base64. */
export function fingerprint(key) {
  const der = createPublicKey(key).export({ type: "spki", format: "der" });
  return `SHA256:${createHash("sha256").update(der).digest("base64")}`;
}

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** A JWT for the App: RS256, iat set back JWT_BACKDATE_S, exp JWT_LIFETIME_S ahead, iss the client ID. */
export function makeJwt(key, clientId, nowMs) {
  const now = Math.floor(nowMs / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: clientId }));
  const input = `${head}.${body}`;
  return `${input}.${b64url(sign("sha256", Buffer.from(input), key))}`;
}

// ---------------------------------------------------------------- GitHub

/**
 * A client for one origin: GITHUB_API, or (tests only) http://127.0.0.1:<port>.
 * It sends one request and resolves with { status, json } (json null when
 * the answer is not JSON), or { status: 0 } when there was no answer. It
 * follows no redirect, reads at most MAX_RESPONSE bytes, and gives up after
 * REQUEST_MS.
 */
export function apiClient(origin) {
  const u = new URL(origin);
  const mod = u.protocol === "https:" ? https : http;
  return ({ method, path, auth, body }) =>
    new Promise((resolve) => {
      const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const headers = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ghost-protocol-github-review",
        Authorization: `Bearer ${auth}`,
      };
      if (data) Object.assign(headers, { "Content-Type": "application/json", "Content-Length": data.length });
      let done = false;
      const finish = (r) => {
        if (!done) {
          done = true;
          resolve(r);
        }
      };
      let req;
      try {
        req = mod.request(
          { protocol: u.protocol, hostname: u.hostname, port: u.port || undefined, method, path, headers, agent: false, timeout: REQUEST_MS },
          (res) => {
            const chunks = [];
            let n = 0;
            res.on("data", (c) => {
              n += c.length;
              if (n > MAX_RESPONSE) {
                req.destroy();
                return finish({ status: 0 });
              }
              chunks.push(c);
            });
            res.on("end", () => {
              let json = null;
              try {
                json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              } catch {
                // not JSON (an empty 204, say)
              }
              finish({ status: res.statusCode ?? 0, json });
            });
            res.on("error", () => finish({ status: 0 }));
          },
        );
      } catch {
        // node refuses to send a header it cannot send as it is (a control
        // character in it, say): no request went out.
        return finish({ status: 0 });
      }
      req.on("timeout", () => req.destroy());
      req.on("error", () => finish({ status: 0 }));
      req.end(data);
    });
}

/** GitHub's own message about an error, made safe to pass on: printable, short. */
function said(r) {
  const m = typeof r.json?.message === "string" ? r.json.message.replace(/[^\x20-\x7e]/g, "?").slice(0, 200) : "";
  return r.status ? `HTTP ${r.status}${m ? `: ${m}` : ""}` : "no answer";
}

/**
 * Why a token answer is not what was asked for, or null: a token, for exactly
 * the one repo, with pull_requests:write and at most metadata:read besides.
 */
export function tokenProblem(json, entry) {
  if (!json || typeof json !== "object" || typeof json.token !== "string" || !json.token) return "GitHub's answer held no token";
  if (!RE_TOKEN.test(json.token)) {
    return `GitHub's token is not one this key service takes (20 to ${MAX_TOKEN} characters of letters, digits, _, . and -; it had ${json.token.length})`;
  }
  const perms = json.permissions;
  if (!perms || typeof perms !== "object") return "GitHub's token came with no permissions";
  for (const [k, v] of Object.entries(perms)) {
    if (!(k === "pull_requests" && v === "write") && !(k === "metadata" && v === "read")) {
      return `GitHub's token can do more than was asked (${String(k).slice(0, 40)}: ${String(v).slice(0, 10)})`;
    }
  }
  if (perms.pull_requests !== "write") return "GitHub's token cannot write pull requests";
  if (json.repository_selection !== "selected") return "GitHub's token is not limited to selected repos";
  const repos = json.repositories;
  const want = `${entry.owner}/${entry.name}`.toLowerCase();
  if (!Array.isArray(repos) || repos.length !== 1 || String(repos[0]?.full_name ?? "").toLowerCase() !== want) {
    return "GitHub's token is not for exactly that one repo";
  }
  return null;
}

/**
 * Why a pull request is held or a draft, or null: { check, why } with the
 * check "hold" (a title that starts with HOLD:, in any case, after leading
 * whitespace; a label named hold, in any case, trimmed: the two ways
 * .github/workflows/merge-by-policy.yml holds one) or "draft". A title, labels
 * or draft flag that cannot be read are a reason too: a guard that cannot read
 * its input must not read it as "no hold".
 */
export function heldProblem(p) {
  if (typeof p?.title !== "string") return { check: "hold", why: "the title could not be read" };
  if (p.title.trimStart().toLowerCase().startsWith("hold:")) return { check: "hold", why: "the title starts with HOLD:" };
  if (!Array.isArray(p.labels) || !p.labels.every((l) => l && typeof l === "object" && typeof l.name === "string")) {
    return { check: "hold", why: "the labels could not be read" };
  }
  if (p.labels.some((l) => l.name.trim().toLowerCase() === "hold")) return { check: "hold", why: "the pull request has the hold label" };
  if (typeof p.draft !== "boolean") return { check: "draft", why: "whether the pull request is a draft could not be read" };
  if (p.draft) return { check: "draft", why: "the pull request is a draft" };
  return null;
}

/**
 * The review action. `deps`: config (parseConfig, with `rules` from
 * loadRules; a test may add matchMs and totalMatchMs to cut matching
 * shorter), loadKey() (the App key), api (an apiClient), now() (ms),
 * ledger(fields). Returns the answer object; throws nothing (a refusal is an
 * answer). The checks, in the order they run (the brief's numbers in
 * brackets): repo [2] and event [3], before the key or the network; then,
 * with a token for that one repo, the pull request is read once and judged
 * whole: open, head [1], hold and draft [4], own pull request [5], the body in
 * a repo that is not private [6]; its commits are read, tied to the head
 * [5]; only then the review is posted, and the pull request is read again.
 */
export async function review(req, { config, loadKey, api, now = Date.now, ledger = () => {}, live = {} }) {
  const fields = {
    action: "review",
    repo: req.repo,
    pr: req.pr,
    head_sha: req.headSha,
    event: req.event,
    body_sha256: createHash("sha256").update(req.body).digest("hex"),
    body_bytes: Buffer.byteLength(req.body, "utf8"),
  };
  let token = null;
  let minted = false;
  try {
    // The allowlist, before the key or the network: its entry names the installation.
    const entry = config.repos.get(req.repo.toLowerCase());
    if (!entry) refuse(`${req.repo} is not on this key service's list`, "repo");
    if (req.event === "COMMENT" && !config.allowComment) refuse("COMMENT is not allowed here: post APPROVE or REQUEST_CHANGES", "event");
    const jwt = makeJwt(loadKey(), config.clientId, now());
    const t = await api({
      method: "POST",
      path: `/app/installations/${entry.installation}/access_tokens`,
      auth: jwt,
      body: { repositories: [entry.name], permissions: { pull_requests: "write" } },
    });
    if (t.status !== 201) refuse(`GitHub gave no token for ${req.repo} (${said(t)})`);
    // GitHub made a token. Whatever happens next it is revoked (below, in
    // finally), and the ledger line says whether it was: a token refused
    // here (its form, or wider than asked) too, as long as it can be sent
    // back as it is.
    minted = true;
    if (typeof t.json?.token === "string" && RE_REVOCABLE.test(t.json.token)) {
      token = t.json.token;
      live.token = token; // for serve's time limit, which revokes it too
    }
    const wide = tokenProblem(t.json, entry);
    if (wide) refuse(wide);
    const path = `/repos/${entry.owner}/${entry.name}/pulls/${req.pr}`;
    const pr = await api({ method: "GET", path, auth: token });
    if (pr.status !== 200 || !pr.json || typeof pr.json !== "object") refuse(`could not read pull request ${req.pr} (${said(pr)})`);
    const p = pr.json;
    if (String(p.base?.repo?.full_name ?? "").toLowerCase() !== req.repo.toLowerCase()) refuse("GitHub's pull request is in another repo", "repo");
    if (p.state !== "open") refuse(`pull request ${req.pr} is not open`, "open");
    const head = p.head?.sha;
    if (head !== req.headSha) {
      refuse(`pull request ${req.pr}'s head is ${typeof head === "string" && RE_SHA.test(head) ? head : "unknown"}, not ${req.headSha}: read it again`, "head");
    }
    const held = heldProblem(p);
    if (held) refuse(held.why, held.check);
    // The reviewer's own pull request: its author is one of the reviewer's own logins.
    if (typeof p.user?.login !== "string") refuse("the pull request's author could not be read", "own-pr");
    if (config.ownLogins.has(p.user.login.toLowerCase())) refuse("the pull request is the reviewer's own", "own-pr");
    // A body goes to a public repo unless GitHub says the repo is private: a
    // field that is missing or not a boolean is read as public.
    if (req.body && p.base?.repo?.private !== true) {
      if (!Array.isArray(config.rules) || config.rules.length === 0) refuse("the public-text rules are not loaded", "public-text");
      const rule = publicTextProblem(req.body, config.rules, { matchMs: config.matchMs, totalMs: config.totalMatchMs });
      if (rule) refuse(`the body fails the public-text check (rule ${rule})`, "public-text");
    }
    // The commits, tied to the head the review is pinned to: the list must
    // be the pull request's whole (as many as the pull request says), and hold that head.
    const n = p.commits;
    if (!Number.isSafeInteger(n) || n < 1) refuse("the number of commits could not be read, so none was checked", "own-commit");
    if (n > MAX_COMMITS) refuse(`the pull request has ${n} commits, and this check reads at most ${MAX_COMMITS}`, "own-commit");
    const cl = await api({ method: "GET", path: `${path}/commits?per_page=${MAX_COMMITS}`, auth: token });
    if (cl.status !== 200 || !Array.isArray(cl.json)) refuse(`the commits could not be read, so none was checked (${said(cl)})`, "own-commit");
    if (cl.json.length !== n) refuse(`the commit list does not match the pull request (${cl.json.length} of ${n})`, "own-commit");
    for (const c of cl.json) {
      const sha = c?.sha;
      const email = c?.commit?.author?.email;
      if (typeof sha !== "string" || !RE_SHA.test(sha) || typeof email !== "string") refuse("a commit in the list could not be read, so it was not checked", "own-commit");
      const login = c.author?.login; // null when GitHub links the commit to no account
      if (config.ownEmails.has(email.toLowerCase()) || (typeof login === "string" && config.ownLogins.has(login.toLowerCase()))) {
        refuse(`commit ${sha.slice(0, 7)} is authored by the reviewer's own identity`, "own-commit");
      }
    }
    // Held to the head the review is pinned to: a list that does not hold it is some other head's (the order GitHub lists them in is not relied on).
    if (!cl.json.some((c) => c.sha === req.headSha)) refuse("the commit list does not hold the head", "own-commit");
    const body = { commit_id: req.headSha, event: req.event };
    if (req.body) body.body = req.body;
    const r = await api({ method: "POST", path: `${path}/reviews`, auth: token, body });
    if (r.status !== 200 || !r.json || typeof r.json !== "object") refuse(`GitHub did not take the review (${said(r)})`);
    const out = {
      id: Number.isSafeInteger(r.json.id) ? r.json.id : null,
      state: typeof r.json.state === "string" && /^[A-Z_]{1,40}$/.test(r.json.state) ? r.json.state : null,
      commit_id: typeof r.json.commit_id === "string" && RE_SHA.test(r.json.commit_id) ? r.json.commit_id : null,
      html_url: typeof r.json.html_url === "string" && /^https:\/\/github\.com\/[\x21-\x7e]{1,300}$/.test(r.json.html_url) ? r.json.html_url : null,
    };
    // A push between the check above and the post leaves a review pinned to
    // a head that is no longer the pull request's: read it again. A title
    // made HOLD:, a hold label or a draft inside that window is found here
    // too, not prevented: GitHub takes a review on no condition.
    const again = await api({ method: "GET", path, auth: token });
    const after = again.status === 200 ? again.json?.head?.sha : undefined;
    if (after !== req.headSha) {
      const shown = typeof after === "string" && RE_SHA.test(after) ? after : null;
      Object.assign(fields, { result: shown ? "posted, head moved" : "posted, head not read again", check: "head", review_id: out.id, state: out.state, head_after: shown });
      const error = shown
        ? `the head moved while the review was posted (now ${shown}): the review is pinned to ${req.headSha}, and the repo's rules must dismiss it; read the pull request again, then review again`
        : `the review was posted, but the pull request could not be read again to check its head (${said(again)}): look at it before relying on the review`;
      return { ok: false, check: "head", error, review: out };
    }
    const heldNow = heldProblem(again.json);
    if (heldNow) {
      Object.assign(fields, { result: `posted, then ${heldNow.check}`, check: heldNow.check, review_id: out.id, state: out.state });
      const error = `the review was posted, but the pull request changed while it was posted (${heldNow.why}): look at it before relying on the review`;
      return { ok: false, check: heldNow.check, error, review: out };
    }
    Object.assign(fields, { result: "posted", review_id: out.id, state: out.state });
    return { ok: true, action: "review", review: out };
  } catch (err) {
    const why = err instanceof Refusal ? err.message : "the review failed";
    const check = err instanceof Refusal && err.check ? err.check : undefined;
    Object.assign(fields, { result: "refused", reason: why, ...(check ? { check } : {}) });
    return check ? { ok: false, check, error: why } : { ok: false, error: why };
  } finally {
    if (minted) fields.token_revoked = false;
    if (token) {
      const d = await api({ method: "DELETE", path: "/installation/token", auth: token });
      fields.token_revoked = d.status === 204;
      token = null;
      live.token = null;
    }
    ledger(fields);
  }
}

/** The app action: GET /app, as the App, with its client ID checked. */
export async function app({ config, loadKey, api, now = Date.now, ledger = () => {} }) {
  const fields = { action: "app" };
  try {
    const key = loadKey();
    const fp = fingerprint(key);
    const r = await api({ method: "GET", path: "/app", auth: makeJwt(key, config.clientId, now()) });
    if (r.status !== 200 || !r.json || typeof r.json !== "object") refuse(`GitHub did not take the App's JWT (${said(r)})`);
    const j = r.json;
    if (j.client_id !== config.clientId) {
      refuse(`the key belongs to an App whose client ID is ${typeof j.client_id === "string" && RE_CLIENT_ID.test(j.client_id) ? j.client_id : "unknown"}, not ${config.clientId}`);
    }
    const permissions = {};
    for (const [k, v] of Object.entries(j.permissions && typeof j.permissions === "object" ? j.permissions : {})) {
      if (/^[a-z_]{1,64}$/.test(k) && /^(read|write|admin)$/.test(v)) permissions[k] = v;
    }
    const out = {
      id: Number.isSafeInteger(j.id) ? j.id : null,
      slug: typeof j.slug === "string" && RE_SLUG.test(j.slug) ? j.slug : null,
      owner: typeof j.owner?.login === "string" && RE_LOGIN.test(j.owner.login) ? j.owner.login : null,
      client_id: config.clientId,
      permissions,
    };
    Object.assign(fields, { result: "ok", app_id: out.id, slug: out.slug });
    return { ok: true, action: "app", app: out, fingerprint: fp };
  } catch (err) {
    const why = err instanceof Refusal ? err.message : "the check failed";
    Object.assign(fields, { result: "refused", reason: why });
    return { ok: false, error: why };
  } finally {
    ledger(fields);
  }
}

// ---------------------------------------------------------------- serve

const say = (message) => process.stderr.write(`github-review: ${message}\n`);

/** The names this process started with: process.env, and /proc/self/environ on Linux. */
function startingVariableNames() {
  const names = new Set(Object.keys(process.env));
  try {
    for (const entry of readFileSync("/proc/self/environ", "latin1").split("\0")) {
      const at = entry.indexOf("=");
      if (at > 0) names.add(entry.slice(0, at));
    }
  } catch {
    // not Linux
  }
  return names;
}

function stdinIsSocket() {
  try {
    return fstatSync(0).isSocket();
  } catch {
    return false;
  }
}

/**
 * Reads one request line from stdin: up to the first newline (or the end), at
 * most MAX_REQUEST bytes, within READ_MS. Resolves null otherwise.
 */
function readLine(stream) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    let done = false;
    const timer = setTimeout(() => finish(null), READ_MS);
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream.off("data", onData);
      stream.pause();
      resolve(v);
    };
    const onData = (c) => {
      const nl = c.indexOf(10);
      if (nl >= 0) {
        chunks.push(c.subarray(0, nl));
        return finish(Buffer.concat(chunks).toString("utf8"));
      }
      chunks.push(c);
      n += c.length;
      if (n > MAX_REQUEST) finish(null);
    };
    stream.on("data", onData);
    stream.on("end", () => finish(n > 0 || chunks.length ? Buffer.concat(chunks).toString("utf8") : null));
    stream.on("error", () => finish(null));
  });
}

/** The origin: GitHub's, or under the test switch (never under systemd) a stand-in on 127.0.0.1. */
function apiOrigin(fail) {
  const test = process.env[TEST_API_SWITCH];
  if (test === undefined) return GITHUB_API;
  if ("INVOCATION_ID" in process.env) fail(`${TEST_API_SWITCH} is set under systemd (INVOCATION_ID is set): the key service talks only to ${GITHUB_API}`);
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(test)) fail(`${TEST_API_SWITCH} must be http://127.0.0.1:<port>`);
  say(`test mode (${TEST_API_SWITCH}): a stand-in for GitHub at ${test}`);
  return test;
}

/** The connection's time limit: CONNECTION_MS, or a shorter one for a test against the stand-in. */
function connectionLimit(origin, fail) {
  const v = process.env[TEST_CONNECTION_SWITCH];
  if (v === undefined) return CONNECTION_MS;
  if (origin === GITHUB_API) {
    say(`serve: ${TEST_CONNECTION_SWITCH} is ignored without the stand-in for GitHub`);
    return CONNECTION_MS;
  }
  const ms = /^[0-9]{4,6}$/.test(v) ? Number(v) : NaN;
  if (!(ms >= 1000 && ms <= CONNECTION_MS)) fail(`${TEST_CONNECTION_SWITCH} must be 1000 to ${CONNECTION_MS}`);
  return ms;
}

/**
 * The key's side, one connection. It refuses to start (an answer that says
 * the key service is not set up right, the reason in the journal) when node
 * has options or a setting that runs other code, loosens TLS or logs
 * traffic; when its code can be changed by anyone but root; or when the key's
 * file descriptor is missing or wrong. Then one request, one answer.
 */
export async function serve() {
  const answer = (obj) =>
    new Promise((resolve) => {
      process.stdout.write(`${JSON.stringify(obj)}\n`, () => resolve());
    });
  const fail = (why) => {
    say(`serve: ${why}`);
    process.stdout.write(`${JSON.stringify({ ok: false, error: "the key service is not set up right; its journal says why" })}\n`, () =>
      process.exit(2),
    );
    setTimeout(() => process.exit(2), 2000).unref();
    throw new Refusal(why);
  };
  try {
    if (process.execArgv.some((o) => !ALLOWED_NODE_OPTIONS.has(o))) fail("node was started with options; the key service runs node with none, except --disable-sigusr1");
    const names = startingVariableNames();
    for (const name of REFUSED_VARIABLES) if (names.has(name)) fail(`${name} is set; remove it (UnsetEnvironment=${name})`);
    const origin = apiOrigin(fail);
    const connectionMs = connectionLimit(origin, fail);
    const trustedCode = new Set([0]);
    const trustedKey = new Set([0]);
    const trust = process.env[TEST_TRUST_SWITCH];
    if (trust === "1" || trust === "code") {
      if ("INVOCATION_ID" in process.env) say(`serve: ${TEST_TRUST_SWITCH} is ignored under systemd (INVOCATION_ID is set)`);
      else {
        trustedCode.add(process.getuid());
        if (trust === "1") trustedKey.add(process.getuid());
      }
    }
    const self = fileURLToPath(import.meta.url);
    let problem;
    try {
      problem = untrustedCode([self, join(dirname(self), "keyservice.mjs"), process.execPath], trustedCode);
    } catch {
      problem = "the check could not read them";
    }
    if (problem) fail(`refusing to run code that a user other than root can change: ${problem}`);
    const fd = namedFd(process.env, KEY_FD_NAME, process.pid, { stdinIsSocket: stdinIsSocket() });
    if (typeof fd === "string") fail(fd);
    const fdProblem = keyFdProblem(fd, trustedKey);
    if (fdProblem) fail(fdProblem);
    let config;
    try {
      config = parseConfig(process.env);
    } catch (err) {
      fail(`github.conf: ${err.message}`);
    }
    try {
      config.rules = loadRules(config.publicTextFile, trustedCode);
    } catch (err) {
      fail(err instanceof Refusal ? err.message : "the public-text rules could not be loaded");
    }
    // The cut-off on matching runs a watchdog thread; if this sandbox does not let it run, say so now, not at a public repo's first body.
    try {
      if (matchWithin(/a/u, "a", MATCH_MS) !== true) fail("the time limit on matching the public-text rules does not work here");
    } catch (err) {
      if (err instanceof Refusal) throw err;
      fail("the time limit on matching the public-text rules does not work here");
    }
    const api = apiClient(origin);
    for (const name of ["LISTEN_FDS", "LISTEN_PID", "LISTEN_FDNAMES"]) delete process.env[name];
    let keyRead = false;
    const loadKey = () => {
      if (keyRead) refuse("the key was read already");
      keyRead = true;
      const raw = readFd(fd, MAX_PEM);
      if (typeof raw === "string") refuse("the key service could not read the App key; its journal says why");
      try {
        return parseAppKey(raw);
      } finally {
        raw.fill(0);
      }
    };
    const ledger = (fields) => say(`ledger ${JSON.stringify(fields)}`);
    const live = { token: null };
    const timer = setTimeout(async () => {
      say("serve: the connection took too long; ended");
      if (live.token) {
        const d = await api({ method: "DELETE", path: "/installation/token", auth: live.token });
        ledger({ action: "timeout", token_revoked: d.status === 204 });
      }
      process.stdout.write(`${JSON.stringify({ ok: false, error: "the key service took too long" })}\n`, () => process.exit(1));
    }, connectionMs);
    timer.unref();
    const line = await readLine(process.stdin);
    let req;
    let out;
    try {
      if (line === null) refuse(`the request must be one line of at most ${MAX_REQUEST} bytes, sent within ${READ_MS / 1000} s`);
      req = parseRequest(line);
    } catch (err) {
      out = { ok: false, error: err instanceof Refusal ? err.message : "the request could not be read" };
      ledger({ action: "unknown", result: "refused", reason: out.error });
    }
    if (!out) {
      if (req.action === "review") out = await review(req, { config, loadKey, api, ledger, live });
      else if (req.action === "app") out = await app({ config, loadKey, api, ledger });
      else {
        try {
          out = { ok: true, action: "fingerprint", fingerprint: fingerprint(loadKey()) };
          ledger({ action: "fingerprint", result: "ok" });
        } catch (err) {
          out = { ok: false, error: err instanceof Refusal ? err.message : "could not read the App key" };
          ledger({ action: "fingerprint", result: "refused", reason: out.error });
        }
      }
    }
    if (!keyRead) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
    clearTimeout(timer);
    await answer(out);
    process.exit(0);
  } catch (err) {
    if (!(err instanceof Refusal)) {
      say("serve: failed");
      process.exit(2);
    }
  }
}

// ---------------------------------------------------------------- the key file (root)

function quit(code, message, what = "keyfile") {
  if (message) process.stderr.write(`github-review ${what}: ${message}\n`);
  process.exit(code);
}

/** Reads a descriptor to its end, at most MAX_PEM bytes, into a buffer the caller zeroes. */
function readAllFd(fd) {
  const buf = Buffer.alloc(MAX_PEM + 1);
  let n = 0;
  try {
    for (;;) {
      let r;
      try {
        r = readSync(fd, buf, n, buf.length - n, null);
      } catch (err) {
        if (err.code === "EAGAIN") continue;
        throw err;
      }
      if (r === 0) break;
      n += r;
      if (n > MAX_PEM) {
        buf.fill(0);
        quit(1, `the key is longer than ${MAX_PEM} bytes`);
      }
    }
  } catch {
    buf.fill(0);
    quit(1, "could not read the key");
  }
  const out = Buffer.from(buf.subarray(0, n));
  buf.fill(0);
  return out;
}

function keyFrom(bytes) {
  try {
    return parseAppKey(bytes);
  } catch (err) {
    return quit(1, err instanceof Refusal ? err.message : "the App key could not be read");
  } finally {
    bytes.fill(0);
  }
}

/** The key in the file at `path`: a regular file, no link, readable by its owner only. */
function keyAt(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    quit(1, `could not open ${path}`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) quit(1, `${path} is not a regular file`);
    if (st.mode & 0o077) quit(1, `${path} has permissions for its group or for others; it must be readable by its owner only`);
    return keyFrom(readAllFd(fd));
  } finally {
    closeSync(fd);
  }
}

/** Whether two stats are one file (one inode on one device). */
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;

/**
 * Overwrites a regular file (never through a symbolic link) with zeros, then
 * removes it. A file with another name besides this one, above all the live
 * key's (`keep`), is only removed: never overwritten, its mode never changed.
 * A run that stopped between its link and its unlink leaves exactly that: a
 * .new-* or .old-* name for the live key's own bytes.
 */
function shredFile(path, keep) {
  let fd;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return;
    let live = null;
    try {
      live = lstatSync(keep);
    } catch {
      // no live key there
    }
    if (st.nlink > 1 || (live && sameFile(st, live))) {
      unlinkSync(path);
      return;
    }
    // A key file is 0400: made writable for its owner first (root writes
    // anyway; a test run as another user does not). The folder is root's.
    chmodSync(path, 0o600);
    fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    const now = fstatSync(fd);
    if (!sameFile(now, st) || now.nlink > 1) {
      closeSync(fd);
      fd = undefined;
      unlinkSync(path);
      return;
    }
    if (now.size > 0) writeSync(fd, Buffer.alloc(now.size), 0, now.size, 0);
    fsyncSync(fd);
  } catch {
    // gone, or not ours to write: removed below all the same
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** What an earlier run left beside the key file: half-written new keys, replaced old ones. */
function scrubLeftovers(path) {
  const dir = dirname(path);
  const base = basename(path);
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    if (n.startsWith(`.${base}.new-`) || n.startsWith(`.${base}.old-`)) shredFile(join(dir, n), path);
  }
}

/**
 * Writes the key, as PKCS#1 PEM (the form GitHub hands out), into a new file
 * beside `path`, mode 0400, then puts it at `path` in one step: a link that
 * fails when `path` is there (write), or a rename over the one there
 * (replace), whose old key keeps a name of its own until it is overwritten
 * with zeros and removed.
 */
function putKey(path, key, replace) {
  const tmp = join(dirname(path), `.${basename(path)}.new-${process.pid}`);
  const old = join(dirname(path), `.${basename(path)}.old-${process.pid}`);
  let fd;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  } catch {
    quit(1, `could not create a file in ${dirname(path)}`);
  }
  const pem = Buffer.from(key.export({ type: "pkcs1", format: "pem" }));
  let problem = null;
  try {
    writeSync(fd, pem);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (replace) {
      linkSync(path, old);
      renameSync(tmp, path);
      shredFile(old, path);
    } else linkSync(tmp, path);
  } catch (err) {
    problem = err.code === "EEXIST" ? `${path} already exists; it is replaced only with --replace-github-app-key` : `could not put the key at ${path}`;
  } finally {
    pem.fill(0);
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch {
      // renamed, or gone
    }
  }
  if (problem) quit(1, problem);
}

function keyfile(command, path, rest) {
  if (!["write", "replace", "fingerprint"].includes(command) || !path || rest.length > 0 || !path.startsWith("/")) {
    quit(2, "usage: github-review.mjs keyfile write|replace|fingerprint <absolute path>");
  }
  scrubLeftovers(path);
  if (command === "fingerprint") {
    process.stdout.write(`fingerprint ${fingerprint(keyAt(path))}\n`);
    return;
  }
  // A key typed into a terminal shows on its screen and stays in its scrollback.
  if (isatty(0)) quit(2, `${command} reads the key from a pipe or a file, never from a terminal`);
  let previous = null;
  if (command === "replace") {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      quit(1, `${path} is not there: nothing to replace (write a new one instead)`);
    }
    if (!st.isFile()) quit(1, `${path} is not a regular file`);
    previous = fingerprint(keyAt(path));
  }
  const key = keyFrom(readAllFd(0));
  const fp = fingerprint(key);
  if (previous === fp) quit(1, "the new key is the key that is there already");
  putKey(path, key, command === "replace");
  process.stdout.write(`fingerprint ${fp}\n`);
  if (previous) process.stdout.write(`previous ${previous}\n`);
}

// ---------------------------------------------------------------- the rules file (root)

/** `rules check <absolute path>`: prints "rules <n>", or why the file is refused (exit 1). */
function rulesCheck(args) {
  if (args.length !== 2 || args[0] !== "check" || !args[1].startsWith("/")) quit(2, "usage: github-review.mjs rules check <absolute path>", "rules");
  try {
    process.stdout.write(`rules ${loadRules(args[1], null).length}\n`);
  } catch (err) {
    quit(1, err instanceof Refusal ? err.message : "the public-text rules file could not be checked", "rules");
  }
}

// ---------------------------------------------------------------- the session's side

/** The socket folder: --socket, else GP_KEY_SOCKET, else the one key service here that has a GitHub socket. */
export function socketFolder(given, env = process.env, run = "/run/ghost-protocol-key") {
  if (given) return given;
  if (env.GP_KEY_SOCKET) return env.GP_KEY_SOCKET;
  let found = [];
  try {
    found = readdirSync(run).filter((n) => {
      try {
        return lstatSync(join(run, n, SOCKET_NAME)).isSocket();
      } catch {
        return false;
      }
    });
  } catch {
    // no key service here
  }
  if (found.length === 1) return join(run, found[0]);
  return null;
}

/** One request to the key service's GitHub socket; resolves with its answer, or { ok: false, error }. */
export function call(folder, request, { timeoutMs = CALL_MS } = {}) {
  return new Promise((resolve) => {
    const socket = createConnection(join(folder, SOCKET_NAME));
    const chunks = [];
    let n = 0;
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `the key service sent no answer within ${timeoutMs} ms` }), timeoutMs);
    socket.on("connect", () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on("data", (c) => {
      n += c.length;
      if (n > MAX_ANSWER) return finish({ ok: false, error: "the key service's answer was too long" });
      chunks.push(c);
      const text = Buffer.concat(chunks).toString("utf8");
      const nl = text.indexOf("\n");
      if (nl < 0) return;
      try {
        const a = JSON.parse(text.slice(0, nl));
        finish(a && typeof a === "object" && typeof a.ok === "boolean" ? a : { ok: false, error: "the key service's answer was not one" });
      } catch {
        finish({ ok: false, error: "the key service's answer was not JSON" });
      }
    });
    socket.on("error", (err) => finish({ ok: false, error: `could not reach the key service at ${join(folder, SOCKET_NAME)} (${err.code ?? "error"})` }));
    socket.on("close", () => finish({ ok: false, error: "the key service closed the connection before answering" }));
  });
}

const USAGE = `usage: gp-github-review [--socket <folder>] [--json] review <owner/repo> <pr> <head-sha> <APPROVE|REQUEST_CHANGES|COMMENT> [<body> | -]
       gp-github-review [--socket <folder>] [--json] fingerprint | app
       (COMMENT only where the key service allows it)`;

/** The body from stdin, or null when it is longer than MAX_BODY bytes. */
function readStdinText() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  let n = 0;
  for (;;) {
    let r;
    try {
      r = readSync(0, buf, 0, buf.length, null);
    } catch (err) {
      if (err.code === "EAGAIN") continue;
      if (err.code === "EOF") break;
      throw err;
    }
    if (r === 0) break;
    chunks.push(Buffer.from(buf.subarray(0, r)));
    n += r;
    if (n > MAX_BODY) return null;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The session's command line. Returns the exit code: 0 done, 1 refused, 2 usage. */
export async function main(argv, { out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
  const usage = (why) => {
    err(why ? `gp-github-review: ${why}\n` : `${USAGE}\n`);
    return 2;
  };
  let given = null;
  let json = false;
  const args = [...argv];
  while (args.length && args[0].startsWith("--")) {
    const o = args.shift();
    if (o === "--socket" && args.length) given = args.shift();
    else if (o === "--json") json = true;
    else return usage();
  }
  const [action, ...rest] = args;
  let request;
  if (action === "review") {
    if (rest.length < 4 || rest.length > 5) return usage();
    const [repo, pr, sha, event, text = ""] = rest;
    if (!/^[1-9][0-9]{0,9}$/.test(pr)) return usage("<pr> must be a pull request number");
    const body = text === "-" ? readStdinText() : text;
    if (body === null) return usage(`the body on stdin is longer than ${MAX_BODY} bytes`);
    request = { action, repo, pr: Number(pr), head_sha: sha, event, body };
  } else if ((action === "fingerprint" || action === "app") && rest.length === 0) {
    request = { action };
  } else {
    return usage();
  }
  const folder = socketFolder(given);
  if (!folder) return usage("no key service socket found: give --socket <folder> (/run/ghost-protocol-key/<name>)");
  const a = await call(folder, request);
  if (json) out(`${JSON.stringify(a)}\n`);
  else if (!a.ok) {
    // One line: refused: <check>: <clause> (a failure that is no limit has no check).
    const named = typeof a.check === "string" && RE_CHECK.test(a.check) ? `${a.check}: ` : "";
    err(`refused: ${named}${typeof a.error === "string" ? a.error : "no reason given"}\n`);
    if (a.review?.html_url) err(`gp-github-review: the review that was posted: ${a.review.html_url}\n`);
  } else if (a.action === "review") {
    const r = a.review ?? {};
    out(`posted: ${r.state ?? "a review"} on ${request.repo}#${request.pr} at ${request.head_sha}${r.html_url ? ` ${r.html_url}` : ""}\n`);
  } else if (a.action === "fingerprint") out(`fingerprint ${a.fingerprint}\n`);
  else {
    const p = Object.entries(a.app?.permissions ?? {})
      .map(([k, v]) => `${k}:${v}`)
      .join(",");
    out(
      `app ${a.app?.slug ?? "?"} (id ${a.app?.id ?? "?"}), client id ${a.app?.client_id ?? "?"}, owner ${a.app?.owner ?? "?"}, permissions ${p || "none"}, key ${a.fingerprint}\n`,
    );
  }
  return a.ok ? 0 : 1;
}

// ---------------------------------------------------------------- entry

let isMain = false;
try {
  isMain = realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
} catch {
  // not run as a script
}
if (isMain) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === "serve" && rest.length === 0) await serve();
  else if (mode === "keyfile") keyfile(rest[0], rest[1], rest.slice(2));
  else if (mode === "rules") rulesCheck(rest);
  else process.exitCode = await main(process.argv.slice(2));
}
