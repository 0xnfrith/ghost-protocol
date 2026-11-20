// The GitHub review action's mutation check: runs test/github-review.test.mjs
// against broken copies of src/github-review.mjs, one break each. Every copy
// must fail the suite; a break whose text is no longer in the code (not
// applied) fails this check too, so the list stays in step with the code.
// Each break undoes one guard: the allowlist before the key and the network,
// the token's scope (one repo, pull_requests:write alone, never contents, and
// one GitHub makes wider refused), the token's form (an opaque string of
// 20 to 4096 safe characters, a stateless one as GitHub hands them out now),
// the pull request's head and state, the review pinned to the head and the
// head read again after it, the token revoked on every way out once made
// (one refused for its form too, unless node would refuse it in a header)
// and never passed on, the request's fields, the JWT's window,
// serve's refusals and time limit (and its revoke), the key's owner checked
// apart from the code's, the key file's rules (leftovers and a replaced key
// overwritten, but never a second name for the live key or anything else),
// the client's cap on a body from stdin, and the reviewer's limits: COMMENT
// only where allowed (and before the key or the network), a HOLD: title or
// hold label (the cases and the places merge-by-policy reads them in), a
// draft, the reviewer's own pull request and commits (by login and by email,
// in any case; never the builders' shared noreply author), the commit list
// tied to the head, the public-text rules (their file, its trust and its
// shape; a repo whose privacy is not plain true is public), the second read
// after the post, and a refusal that names its check and never repeats a
// title, a body or an address.
//
// The suite's GitHub is a stand-in on 127.0.0.1, and serve refuses to start
// with the stand-in's switch under systemd, so no break here can send a
// request anywhere else.
//
// The module, the suite and the session's client are copied once into a
// temporary folder, laid out as in the repo; each break is written into that
// copy and taken out again, so the working tree is never changed.
//
// Run: node test/github-review-mutants.mjs   (the suite runs once for each break: some half an hour; not part of npm test)
//      node test/github-review-mutants.mjs --applies   (only checks that each break's text is in the code once)
//      node test/github-review-mutants.mjs --only <text>   (only the breaks whose name holds <text>, after a change to one guard)
//      node test/github-review-mutants.mjs --part <i>/<n>   (only every n-th break, from the i-th: n runs side by side, each in its own folder)
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The module and its suite need no dependency, so neither does this check (helpers.mjs would load the MCP SDK).
const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "..");

const SRC = "adapters/buzz/src/github-review.mjs";
const SUITE = "adapters/buzz/test/github-review.test.mjs";

// [name, [[exact text, replacement], ...]]
const MUTANTS = [
  // The allowlist, before the key and the network.
  ["a repo off the allowlist takes the first entry's installation", [
    ["    const entry = config.repos.get(req.repo.toLowerCase());\n", "    const entry = config.repos.get(req.repo.toLowerCase()) ?? [...config.repos.values()][0];\n"],
  ]],
  ["the key is read before the allowlist", [
    ["    const entry = config.repos.get(req.repo.toLowerCase());\n", "    loadKey();\n    const entry = config.repos.get(req.repo.toLowerCase());\n"],
  ]],
  // The token's scope.
  ["the token is asked for contents:write too", [
    ['permissions: { pull_requests: "write" } },', 'permissions: { pull_requests: "write", contents: "write" } },'],
  ]],
  ["the token is asked for no permissions (all the App holds)", [[', permissions: { pull_requests: "write" } },', " },"]]],
  ["the token is asked for every repo", [["      body: { repositories: [entry.name], ", "      body: { "]]],
  ["a wider token is used", [["    if (wide) refuse(wide);\n", ""]]],
  ["a token with contents passes the check", [['    if (!(k === "pull_requests" && v === "write") && !(k === "metadata" && v === "read")) {', '    if (!(k === "pull_requests" && v === "write") && !(k === "metadata" && v === "read") && k !== "contents") {']]],
  ["a token for every repo passes the check", [['  if (json.repository_selection !== "selected") return "GitHub\'s token is not limited to selected repos";\n', ""]]],
  ["a token for two repos passes the check", [["repos.length !== 1 || ", ""]]],
  // The pull request.
  ["a head that moved is reviewed", [["    if (head !== req.headSha) {\n", "    if (false) {\n"]]],
  ["a closed pull request is reviewed", [['    if (p.state !== "open") refuse(', '    if (false) refuse(']]],
  ["a pull request in another repo is reviewed", [["    if (String(p.base?.repo?.full_name ?? \"\").toLowerCase() !== req.repo.toLowerCase()) refuse(", "    if (false) refuse("]]],
  ["the review is not pinned to the head", [["    const body = { commit_id: req.headSha, event: req.event };\n", "    const body = { event: req.event };\n"]]],
  ["a head that moved while posting is ok", [["    if (after !== req.headSha) {\n", "    if (false) {\n"]]],
  ["the pull request is not read again after posting", [
    ['    const again = await api({ method: "GET", path, auth: token });\n', "    const again = { status: 200, json: { head: { sha: req.headSha } } };\n"],
  ]],
  // The token after.
  ["the token is not revoked", [["    if (token) {\n      const d = await api(", "    if (false) {\n      const d = await api("]]],
  ["the token is answered", [['    return { ok: true, action: "review", review: out };\n', '    return { ok: true, action: "review", review: out, token };\n']]],
  ["the token goes into the ledger", [["      fields.token_revoked = d.status === 204;\n", "      fields.token_revoked = d.status === 204;\n      fields.token = token;\n"]]],
  ["GitHub's message passes on unchanged", [['.replace(/[^\\x20-\\x7e]/g, "?")', ""]]],
  // The token's form: an opaque string, revoked on every way out once made.
  ["the old shape (40-character tokens, no dots) comes back", [["const RE_TOKEN = new RegExp(`^[A-Za-z0-9_.-]{20,${MAX_TOKEN}}$`);", "const RE_TOKEN = /^[A-Za-z0-9_]{20,255}$/;"]]],
  ["a token of any length is taken", [["{20,${MAX_TOKEN}}$`);", "{20,}$`);"]]],
  ["a token under 20 characters is taken", [["{20,${MAX_TOKEN}}$`);", "{1,${MAX_TOKEN}}$`);"]]],
  ["a token with a space is taken", [["`^[A-Za-z0-9_.-]{20,", "`^[A-Za-z0-9_. -]{20,"]]],
  ["a token refused for its form is not revoked", [["RE_REVOCABLE.test(t.json.token)", "RE_TOKEN.test(t.json.token)"]]],
  ["a token node would refuse in a header is sent to be revoked", [["const RE_REVOCABLE = /^[\\x21-\\x7e]{1,16384}$/;", "const RE_REVOCABLE = /^[\\s\\S]{1,16384}$/;"]]],
  ["the ledger says nothing of a token it could not revoke", [["    if (minted) fields.token_revoked = false;\n", ""]]],
  ["a header node refuses throws out of the client", [["        return finish({ status: 0 });\n      }\n      req.on(", "        throw new Error(\"refused\");\n      }\n      req.on("]]],
  // The request.
  ["PENDING is an event", [['new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT"])', 'new Set(["APPROVE", "REQUEST_CHANGES", "COMMENT", "PENDING"])']]],
  ["a short sha is taken", [["const RE_SHA = /^[0-9a-f]{40}$/;", "const RE_SHA = /^[0-9a-f]{7,40}$/;"]]],
  ["extra fields are taken", [["  if (given.length !== wanted.length || given.some((k, i) => k !== wanted[i])) {\n", "  if (wanted.some((k) => !given.includes(k))) {\n"]]],
  ["a repo .. is taken", [['  if (!m || !RE_OWNER.test(m[1]) || !RE_NAME.test(m[2]) || m[2] === "." || m[2] === "..") refuse("repo must be <owner>/<repo>");', '  if (!m || !RE_OWNER.test(m[1]) || !RE_NAME.test(m[2])) refuse("repo must be <owner>/<repo>");']]],
  ["REQUEST_CHANGES needs no body", [['  if (r.event !== "APPROVE" && !r.body.trim()) refuse(`${r.event} needs a body`);\n', ""]]],
  ["the body has no cap", [['  if (Buffer.byteLength(r.body, "utf8") > MAX_BODY) refuse(', "  if (false) refuse("]]],
  ["a pull request number past 2^31 is taken", [[" || r.pr > PR_MAX", ""]]],
  // The JWT.
  ["the JWT lives an hour", [["export const JWT_LIFETIME_S = 540;", "export const JWT_LIFETIME_S = 3600;"]]],
  ["the JWT's iat is not set back", [["export const JWT_BACKDATE_S = 60;", "export const JWT_BACKDATE_S = 0;"]]],
  ["the App's client ID is not checked", [["    if (j.client_id !== config.clientId) {\n", "    if (false) {\n"]]],
  // serve.
  ["the stand-in's switch works under systemd", [['  if ("INVOCATION_ID" in process.env) fail(`${TEST_API_SWITCH} is set under systemd', '  if (false) fail(`${TEST_API_SWITCH} is set under systemd']]],
  ["the stand-in's switch takes any host", [["/^http:\\/\\/127\\.0\\.0\\.1:[0-9]{1,5}$/.test(test)", "/^http:\\/\\/.+$/.test(test)"]]],
  ["NODE_TLS_REJECT_UNAUTHORIZED is let through", [['  "NODE_TLS_REJECT_UNAUTHORIZED",\n', ""]]],
  ["NODE_USE_ENV_PROXY is let through", [['  "NODE_USE_ENV_PROXY",\n', ""]]],
  ["the trust switch works under systemd", [['      if ("INVOCATION_ID" in process.env) say(`serve: ${TEST_TRUST_SWITCH} is ignored', '      if (false) say(`serve: ${TEST_TRUST_SWITCH} is ignored']]],
  ["the request line has no time limit", [["    const timer = setTimeout(() => finish(null), READ_MS);\n", "    const timer = null;\n"]]],
  ["node options are let through", [["    if (process.execArgv.some((o) => !ALLOWED_NODE_OPTIONS.has(o))) fail(", "    if (false) fail("]]],
  ["code others can change is run", [["    if (problem) fail(`refusing to run code", "    if (false) fail(`refusing to run code"]]],
  ["a key file others can read is used", [["    if (fdProblem) fail(fdProblem);\n", ""]]],
  ["the key's owner is checked against the code's trust", [["keyFdProblem(fd, trustedKey)", "keyFdProblem(fd, trustedCode)"]]],
  ["the time limit does not revoke", [["      if (live.token) {\n        const d = await api(", "      if (false) {\n        const d = await api("]]],
  ["the token is never handed to the time limit", [["      live.token = token; // for serve's time limit, which revokes it too\n", ""]]],
  // The key and the key file.
  ["a 1024-bit key is taken", [["bits < 2048 ||", "bits < 1024 ||"]]],
  ["two PEM blocks are taken", [["  if (count !== 1) refuse(", "  if (count < 1) refuse("]]],
  ["write replaces a key that is there", [["    } else linkSync(tmp, path);\n", "    } else renameSync(tmp, path);\n"]]],
  ["the replaced key is removed, not overwritten", [["      shredFile(old, path);\n", "      unlinkSync(old);\n"]]],
  ["what an earlier run left beside the key stays", [["  scrubLeftovers(path);\n", ""]]],
  ["a leftover that is a second name for the live key is overwritten", [
    ["    if (st.nlink > 1 || (live && sameFile(st, live))) {\n", "    if (false) {\n"],
    ["    if (!sameFile(now, st) || now.nlink > 1) {\n", "    if (false) {\n"],
  ]],
  ["a leftover with a name elsewhere is overwritten", [
    ["    if (st.nlink > 1 || (live && sameFile(st, live))) {\n", "    if (live && sameFile(st, live)) {\n"],
    ["    if (!sameFile(now, st) || now.nlink > 1) {\n", "    if (!sameFile(now, st)) {\n"],
  ]],
  ["the key file is written 0644", [["constants.O_EXCL | constants.O_NOFOLLOW, 0o400);", "constants.O_EXCL | constants.O_NOFOLLOW, 0o644);"]]],
  ["the key is read from a terminal", [["  if (isatty(0)) quit(2,", "  if (false) quit(2,"]]],
  ["the same key replaces itself", [['  if (previous === fp) quit(1, "the new key is the key that is there already");\n', ""]]],
  // The limits.
  ["COMMENT is posted where the settings do not allow it", [['    if (req.event === "COMMENT" && !config.allowComment) refuse(', '    if (false) refuse(']]],
  ["COMMENT is allowed whatever the settings say", [["req.event === \"COMMENT\" && !config.allowComment", "req.event === \"COMMENT\" && false"]]],
  ["COMMENT is checked after the token is made", [
    ['    if (req.event === "COMMENT" && !config.allowComment) refuse("COMMENT is not allowed here: post APPROVE or REQUEST_CHANGES", "event");\n', ""],
    ['    const path = `/repos/${entry.owner}/${entry.name}/pulls/${req.pr}`;\n', '    if (req.event === "COMMENT" && !config.allowComment) refuse("COMMENT is not allowed here: post APPROVE or REQUEST_CHANGES", "event");\n    const path = `/repos/${entry.owner}/${entry.name}/pulls/${req.pr}`;\n'],
  ]],
  ["COMMENT is on when the setting is absent", [['const comment = env.GITHUB_REVIEW_ALLOW_COMMENT ?? "0";', 'const comment = env.GITHUB_REVIEW_ALLOW_COMMENT ?? "1";']]],
  ["a HOLD: title is reviewed", [['  if (p.title.trimStart().toLowerCase().startsWith("hold:")) return', "  if (false) return"]]],
  ["a HOLD: title is held in capitals only", [['p.title.trimStart().toLowerCase().startsWith("hold:")', 'p.title.trimStart().startsWith("HOLD:")']]],
  ["a HOLD: title is held at its very start only", [['p.title.trimStart().toLowerCase()', "p.title.toLowerCase()"]]],
  ["a title with HOLD: anywhere is held", [['p.title.trimStart().toLowerCase().startsWith("hold:")', 'p.title.toLowerCase().includes("hold:")']]],
  ["the hold label is ignored", [['  if (p.labels.some((l) => l.name.trim().toLowerCase() === "hold")) return', "  if (false) return"]]],
  ["the hold label is held in lower case only", [['l.name.trim().toLowerCase() === "hold"', 'l.name === "hold"']]],
  ["a label that holds the word is a hold", [['l.name.trim().toLowerCase() === "hold"', 'l.name.toLowerCase().includes("hold")']]],
  ["labels that cannot be read count as no hold", [['  if (!Array.isArray(p.labels) || !p.labels.every((l) => l && typeof l === "object" && typeof l.name === "string")) {', "  if (false) {"]]],
  ["a title that cannot be read counts as no hold", [['  if (typeof p?.title !== "string") return', "  if (false) return"]]],
  ["a draft is reviewed", [['  if (p.draft) return { check: "draft"', '  if (false) return { check: "draft"']]],
  ["a draft flag that cannot be read counts as no draft", [['  if (typeof p.draft !== "boolean") return', "  if (false) return"]]],
  ["a hold and a draft are not looked for", [["    const held = heldProblem(p);\n    if (held) refuse(held.why, held.check);\n", ""]]],
  ["the reviewer's own pull request is reviewed", [["    if (config.ownLogins.has(p.user.login.toLowerCase())) refuse(", "    if (false) refuse("]]],
  ["the author is compared in its own case", [["config.ownLogins.has(p.user.login.toLowerCase())", "config.ownLogins.has(p.user.login)"]]],
  ["a pull request whose author cannot be read is reviewed", [['    if (typeof p.user?.login !== "string") refuse(', "    if (false) refuse("]]],
  ["a body is not checked for public text", [["    if (req.body && p.base?.repo?.private !== true) {", "    if (false) {"]]],
  ["a private repo's body is checked too", [["p.base?.repo?.private !== true", "true"]]],
  ["a repo whose privacy is not a boolean is read as private", [["p.base?.repo?.private !== true", "p.base?.repo?.private === false"]]],
  ["no rules loaded passes a public body", [['      if (!Array.isArray(config.rules) || config.rules.length === 0) refuse("the public-text rules are not loaded", "public-text");\n', ""]]],
  ["only the first public-text rule is applied", [["  for (const { name, re } of rules) {\n    const left", "  for (const { name, re } of rules.slice(0, 1)) {\n    const left"]]],
  ["ignore_case is ignored", [['re = new RegExp(r.pattern, r.ignore_case === true ? "iu" : "u");', 're = new RegExp(r.pattern, "u");']]],
  ["every rule ignores case", [['re = new RegExp(r.pattern, r.ignore_case === true ? "iu" : "u");', 're = new RegExp(r.pattern, "iu");']]],
  ["rules are compiled without the u flag", [['re = new RegExp(r.pattern, r.ignore_case === true ? "iu" : "u");', 're = new RegExp(r.pattern, r.ignore_case === true ? "i" : "");']]],
  ["a rule that does not ignore case is compiled without the u flag", [['r.ignore_case === true ? "iu" : "u");', 'r.ignore_case === true ? "iu" : "");']]],
  ["a rule that ignores case is compiled without the u flag", [['r.ignore_case === true ? "iu" : "u");', 'r.ignore_case === true ? "i" : "u");']]],
  ["a rule that matches the empty text is taken", [['    if (re.test("")) refuse(', "    if (false) refuse("]]],
  ["a back-reference in a rule is taken", [['      if (/[1-9]/.test(n)) return "a back-reference";', "      if (false) return \"a back-reference\";"]]],
  ["the escape \\p, \\P and \\c are taken", [["      if (/[AZzpPkc]/.test(n)) return", "      if (/[AZzk]/.test(n)) return"]]],
  ["the escape \\p is taken", [["      if (/[AZzpPkc]/.test(n)) return", "      if (/[AZzPkc]/.test(n)) return"]]],
  ["the escape \\P is taken", [["      if (/[AZzpPkc]/.test(n)) return", "      if (/[AZzpkc]/.test(n)) return"]]],
  ["the escape \\c is taken", [["      if (/[AZzpPkc]/.test(n)) return", "      if (/[AZzpPk]/.test(n)) return"]]],
  ["the escape \\A is taken", [["      if (/[AZzpPkc]/.test(n)) return", "      if (/[ZzpPkc]/.test(n)) return"]]],
  ["the escape \\Z is taken", [["      if (/[AZzpPkc]/.test(n)) return", "      if (/[AzpPkc]/.test(n)) return"]]],
  ["the escape \\z is taken", [["      if (/[AZzpPkc]/.test(n)) return", "      if (/[AZpPkc]/.test(n)) return"]]],
  ["the escape \\u{...} is taken", [['      if (n === "u" && p[i + 2] === "{") return', '      if (false) return']]],
  ["a class that starts with ] is taken", [['      if (p[i + 1] === "]") return "a class that starts with ]";', "      if (false) return \"a class that starts with ]\";"]]],
  ["a $ anchor is taken", [['    if (c === "$") return "a $ anchor";', "    if (false) return \"a $ anchor\";"]]],
  ["a {,n} repeat is taken", [['    if (c === "{" && p[i + 1] === ",") return', "    if (false) return"]]],
  ["a group other than the plain ones is taken", [['    if (c === "(" && p[i + 1] === "?" && !/^\\(\\?(:|=|!|<=|<!)/.test(p.slice(i, i + 4))) {', "    if (false) {"]]],
  ["a lookbehind group is refused", [["(:|=|!|<=|<!)/.test(p.slice(i, i + 4))", "(:|=|!)/.test(p.slice(i, i + 4))"]]],
  ["a class is not told from the pattern", [["    if (inClass) {\n      if (c === \"]\") inClass = false;", "    if (false) {\n      if (c === \"]\") inClass = false;"]]],
  ["an escaped backslash is not skipped", [["      i += 1;\n      continue;\n    }\n    if (inClass) {", "      continue;\n    }\n    if (inClass) {"]]],
  ["a counted repeat of a group that holds an unbounded repeat is taken", [["\\)[+*{]/.test(r.pattern)) refuse(", "\\)[+*]/.test(r.pattern)) refuse("]]],
  ["a rule's limit is ten seconds", [["export const MATCH_MS = 100;", "export const MATCH_MS = 10_000;"]]],
  ["the limit for all the rules is a minute", [["export const MATCH_TOTAL_MS = 2_000;", "export const MATCH_TOTAL_MS = 60_000;"]]],
  ["a class is never left", [['      if (c === "]") inClass = false;\n      continue;\n    }\n    if (c === "[") {', "      continue;\n    }\n    if (c === \"[\") {"]]],
  ["matching has no time limit", [["matchScript.runInContext(matchContext, { timeout: ms })", "matchScript.runInContext(matchContext, {})"]]],
  ["a match that runs out of time passes the body", [["    if (hit === null) refuse(`the public-text check of the body took too long", "    if (false) refuse(`the public-text check of the body took too long"]]],
  ["the rules together have no budget", [["    const hit = left > 0 ? matchWithin(re, text, Math.min(matchMs, left)) : null;", "    const hit = matchWithin(re, text, matchMs);"]]],
  ["each rule gets the whole budget", [["Math.min(matchMs, left)", "left"]]],
  ["a rule is not tried against the probes", [["    for (const probe of PROBES) {", "    for (const probe of []) {"]]],
  ["a probe that runs out of time passes the rule", [["if (matchWithin(re, probe, MATCH_MS) === null) refuse(", "if (matchWithin(re, probe, MATCH_MS) === 42) refuse("]]],
  ["the config's own match limit is not passed on", [["{ matchMs: config.matchMs, totalMs: config.totalMatchMs }", "{}"]]],
  ["a repeated group with an unbounded repeat in a rule is taken", [["    if (/\\([^()]*[+*][^()]*\\)[+*{]/.test(r.pattern)) refuse(", "    if (false) refuse("]]],
  ["more rules than the cap are taken", [["|| list.length > MAX_RULES) refuse(", ") refuse("]]],
  ["no rules at all are taken", [["list.length < 1 ||", ""]]],
  ["a rule with another field is taken", [['    if (keys !== "name,pattern" && keys !== "ignore_case,name,pattern") refuse(', "    if (false) refuse("]]],
  ["a rule name twice is taken", [["    if (seen.has(r.name)) refuse(", "    if (false) refuse("]]],
  ["a pattern over the cap is taken", [["r.pattern.length > MAX_PATTERN)", "false)"]]],
  ["a rules file others could change is read", [["    if (problem) refuse(`the public-text rules file could be changed", "    if (false) refuse(`the public-text rules file could be changed"]]],
  ["a rules file that is a link is followed", [['  if (!st.isFile()) refuse("the public-text rules file is not a regular file");\n', ""]]],
  ["a rules file over the cap is read", [["  if (st.size > MAX_RULES_BYTES) refuse(", "  if (false) refuse("]]],
  ["serve loads no rules", [["      config.rules = loadRules(config.publicTextFile, trustedCode);", "      config.rules = parseRules(JSON.stringify([{ name: \"none\", pattern: \"^$a\" }]));"]]],
  ["serve loads the rules without the trust check", [["loadRules(config.publicTextFile, trustedCode)", "loadRules(config.publicTextFile, null)"]]],
  ["the rules check takes a relative path", [['!args[1].startsWith("/")) quit(2, "usage: github-review.mjs rules check', 'false) quit(2, "usage: github-review.mjs rules check']]],
  ["no rules file is required in the settings", [['  if (!RE_RULES_PATH.test(publicTextFile) || publicTextFile.split("/").some((part) => part === "." || part === "..")) {', "  if (false) {"]]],
  ["the commits are not read", [["    const cl = await api({ method: \"GET\", path: `${path}/commits?per_page=${MAX_COMMITS}`, auth: token });", "    const cl = { status: 200, json: [{ sha: req.headSha, commit: { author: { email: \"x@example.com\" } } }] };"]]],
  ["a pull request over 100 commits is read anyway", [["    if (n > MAX_COMMITS) refuse(", "    if (false) refuse("]]],
  ["a commit count that cannot be read passes", [["    if (!Number.isSafeInteger(n) || n < 1) refuse(", "    if (false) refuse("]]],
  ["a commit list that cannot be read passes", [["    if (cl.status !== 200 || !Array.isArray(cl.json)) refuse(", "    if (false) refuse("]]],
  ["a commit list of another length than the count passes", [["    if (cl.json.length !== n) refuse(", "    if (false) refuse("]]],
  ["a commit list need not hold the head", [["    if (!cl.json.some((c) => c.sha === req.headSha)) refuse(", "    if (false) refuse("]]],
  ["a commit list must end at the head (the order is relied on)", [["    if (!cl.json.some((c) => c.sha === req.headSha)) refuse(", "    if (cl.json[cl.json.length - 1].sha !== req.headSha) refuse("]]],
  ["a commit that cannot be read passes", [['      if (typeof sha !== "string" || !RE_SHA.test(sha) || typeof email !== "string") refuse(', "      if (false) refuse("]]],
  ["a commit's login is not compared with the own logins", [["(typeof login === \"string\" && config.ownLogins.has(login.toLowerCase()))", "false"]]],
  ["a commit's email is not compared with the own emails", [["config.ownEmails.has(email.toLowerCase()) || ", ""]]],
  ["a commit's login is compared in its own case", [["config.ownLogins.has(login.toLowerCase())", "config.ownLogins.has(login)"]]],
  ["a commit's email is compared in its own case", [["config.ownEmails.has(email.toLowerCase())", "config.ownEmails.has(email)"]]],
  ["only the last commit is looked at", [["    for (const c of cl.json) {", "    for (const c of cl.json.slice(-1)) {"]]],
  ["the builders' shared noreply author counts as the reviewer's own", [["config.ownEmails.has(email.toLowerCase()) || ", "config.ownEmails.has(email.toLowerCase()) || /@users\\.noreply\\.github\\.com$/i.test(email) || "]]],
  ["the second read does not look for a hold or a draft", [["    const heldNow = heldProblem(again.json);\n", "    const heldNow = null;\n"]]],
  ["a refusal does not name its check", [["    return check ? { ok: false, check, error: why } : { ok: false, error: why };", "    return { ok: false, error: why };"]]],
  ["the ledger does not name the check", [['    Object.assign(fields, { result: "refused", reason: why, ...(check ? { check } : {}) });', '    Object.assign(fields, { result: "refused", reason: why });']]],
  ["the title goes into a refusal", [['why: "the title starts with HOLD:" };', "why: `the title starts with HOLD: ${p.title}` };"]]],
  ["the body goes into a refusal", [["refuse(`the body fails the public-text check (rule ${rule})`, \"public-text\");", "refuse(`the body fails the public-text check (rule ${rule}) ${req.body}`, \"public-text\");"]]],
  ["a commit's email goes into a refusal", [["is authored by the reviewer's own identity`, \"own-commit\");", "is authored by the reviewer's own identity (${email})`, \"own-commit\");"]]],
  ["the client prints no check", [["    err(`refused: ${named}${typeof a.error", "    err(`refused: ${typeof a.error"]]],
  ["the client prints a check name that is no name", [['typeof a.check === "string" && RE_CHECK.test(a.check)', 'typeof a.check === "string"']]],
  // The settings.
  ["a person is taken as an own login", [["const RE_OWN_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\\[bot\\]$/;", "const RE_OWN_LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}(\\[bot\\])?$/;"]]],
  ["the builders' shared noreply author is taken as an own email", [["const RE_OWN_EMAIL = /^[0-9]{1,12}\\+[A-Za-z0-9][A-Za-z0-9-]{0,38}\\[bot\\]@users\\.noreply\\.github\\.com$/;", "const RE_OWN_EMAIL = /^[0-9]{1,12}\\+[A-Za-z0-9][A-Za-z0-9-]{0,38}(\\[bot\\])?@users\\.noreply\\.github\\.com$/;"]]],
  ["an own identity twice is taken", [["    if (out.has(item.toLowerCase())) refuse(", "    if (false) refuse("]]],
  ["own identities are kept in their own case", [["    out.add(item.toLowerCase());", "    out.add(item);"]]],
  ["more than 10 own identities are taken", [["  if (out.size > MAX_OWN) refuse(", "  if (false) refuse("]]],
  ["a COMMENT switch of any value is taken", [['  if (comment !== "0" && comment !== "1") refuse(', "  if (false) refuse("]]],
  // The session's client.
  ["the client sends a body over the cap from stdin", [["    if (n > MAX_BODY) return null;\n", ""]]],
];

/** The names of the tests a run failed: the spec reporter prints "✖ <name> (<n>ms)" once for each, and again in its summary. */
const failedTests = (stdout) => new Set([...stdout.matchAll(/^\s*✖ (.*?) \([\d.]+ms\)$/gm)].map((m) => m[1]));

if (process.argv.includes("--applies")) {
  const original = readFileSync(join(ADAPTER, "src", "github-review.mjs"), "utf8");
  const missing = MUTANTS.filter(([, edits]) => edits.some(([from]) => original.split(from).length !== 2)).map(([name]) => name);
  for (const name of missing) console.log(`NOT APPLIED  ${name}`);
  console.log(`${MUTANTS.length - missing.length} of ${MUTANTS.length} apply`);
  process.exit(missing.length ? 1 : 0);
}

const work = mkdtempSync(join(tmpdir(), "gp-github-review-mutants-"));
const ROOT = join(ADAPTER, "..", "..");
try {
  for (const part of ["adapters/buzz/src", "adapters/buzz/test", "adapters/buzz/package.json", "tools/github-review"]) {
    cpSync(join(ROOT, part), join(work, part), { recursive: true });
  }
  const run = () =>
    spawnSync(process.execPath, ["--test", SUITE], { cwd: work, encoding: "utf8", timeout: 300_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  const base = run();
  if (base.status !== 0) {
    console.log("the suite fails on the code as it is; fix that first");
    console.log([...failedTests(base.stdout)].join("\n"));
    process.exit(1);
  }
  const original = readFileSync(join(work, SRC), "utf8");
  let caught = 0;
  const missed = [];
  const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : "";
  const part = process.argv.includes("--part") ? /^(\d+)\/(\d+)$/.exec(process.argv[process.argv.indexOf("--part") + 1] ?? "") : null;
  const chosen = MUTANTS.filter(([name]) => name.includes(only)).filter((_, at) => !part || at % Number(part[2]) === Number(part[1]));
  if (chosen.length === 0) {
    console.log(`no break's name holds "${only}"`);
    process.exit(1);
  }
  for (const [name, edits] of chosen) {
    let text = original;
    let applied = true;
    for (const [from, to] of edits) {
      if (text.split(from).length !== 2) applied = false;
      else text = text.replace(from, () => to); // as written: no $` or $& patterns in `to`
    }
    if (!applied) {
      missed.push(`${name}: NOT APPLIED (its text is not in the code once)`);
      continue;
    }
    writeFileSync(join(work, SRC), text);
    const r = run();
    writeFileSync(join(work, SRC), original);
    if (r.status !== 0) {
      caught += 1;
      console.log(`caught  ${name} (${failedTests(r.stdout).size} test(s) fail)`);
    } else {
      missed.push(name);
      console.log(`MISSED  ${name}`);
    }
  }
  console.log(`\n${caught} of ${chosen.length} caught${part ? ` (part ${part[1]}/${part[2]})` : ""}`);
  for (const m of missed) console.log(`  missed: ${m}`);
  process.exitCode = missed.length ? 1 : 0;
} finally {
  rmSync(work, { recursive: true, force: true });
}
