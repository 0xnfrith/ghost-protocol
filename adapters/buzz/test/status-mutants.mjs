// The status line's mutation check: runs its two suites (status-unit and
// status) against broken copies of the code, one break each: every rule the
// line keeps, above all that no message text reaches it. Every copy must fail
// the suites; a break whose text is no longer in the code (not applied) fails
// this check too, so the list stays in step with the code. The last one takes
// the whole module out.
//
// The adapter is copied once into a temporary folder (its node_modules too);
// each break is written into that copy and taken out again, so the working
// tree is never changed.
//
// Run: node test/status-mutants.mjs   (about five minutes; not part of npm test)
import { spawnSync } from "node:child_process";
import { cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTER, tempDir } from "./helpers.mjs";

const S = "src/status.mjs";
const C = "src/channel.mjs";
const R = "src/rooms.mjs";
const H = "hooks/unattended-deny";
const L = "src/relay.mjs";
const SUITES = ["test/status-unit.test.mjs", "test/status.test.mjs", "test/rooms-unit.test.mjs"];

// [name, file, [[exact text, replacement], ...]]
const MUTANTS = [
  ["the channel hands the message's text to the line", C, [["    status?.delivered(meta.thread_id ?? meta.event_id, { public: room?.public === true });\n", "    status?.delivered(meta.thread_id ?? meta.event_id, { public: room?.public === true });\n    status?.named({ task: notification.params.content });\n"]]],
  ["a root need not be an event id", S, [["  delivered(root, { public: open = false } = {}) {\n    if (typeof root !== \"string\" || !HEX64.test(root)) return;", "  delivered(root, { public: open = false } = {}) {\n    if (typeof root !== \"string\") return;"]]],
  ["a DM's or a private channel's root names the task", S, [["(key && this.publicRoots.has(key) ? rootTask(key) : null)", "(key ? rootTask(key) : null)"]]],
  ["the channel says every room is public", C, [["{ public: room?.public === true }", "{ public: true }"]]],
  ["a DM that says public counts as public", L, [[" && room.type !== \"dm\" });", " });"]]],
  ["a channel that says private too counts as public", R, [["        !event.tags.some((t) => Array.isArray(t) && t[0] === \"private\"),\n", "        true,\n"]]],
  ["a channel that does not say public counts as public", R, [["        event.tags.some((t) => Array.isArray(t) && t[0] === \"public\") &&\n", ""]]],
  ["a refresh that fell due offline is not sent at the login", S, [["    else if (!line.startsWith(\"idle\") && this.refreshTimer === null) this.flush(true);", "    else if (false) this.flush(true);"]]],
  ["the status tool's words are not checked", S, [["      const why = typeof text === \"string\" ? refusedText(text) : null;", "      const why = null;"]]],
  ["a key's 64 hex pass the check", S, [["|| /[0-9a-f]{64}/i.test(s)", ""]]],
  ["a path passes the check", S, [["  if (/[/\\\\]/.test(s)) return", "  if (false) return"]]],
  ["the check runs after the cut", S, [["      const why = typeof text === \"string\" ? refusedText(text) : null;", "      const why = typeof text === \"string\" ? refusedText(cut(clean(text), TASK_MAX)) : null;"]]],
  ["unattended-deny leaves a wait from any claude", H, [["own_claude \"$dir\" || exit 0\n", ""]]],
  ["the turn marker's prompt id is passed on", S, [["      if (m) onTurn(m[1]);", "      if (m) onTurn(m[1], t);"]]],
  ["on by default", S, [["  if (raw === \"on\") on = true;", "  if (raw !== \"off\") on = true;"]]],
  ["on in a key service", C, [["if (statusConf.on && keyService) {", "if (false) {"]]],
  ["any session publishes (no own-claude check)", S, [["  isOwn() {\n    if (this.own()) return true;", "  isOwn() {\n    return true;"]]],
  ["a claude met first counts as the pane's", S, [["    if (name === \"claude\" || (paneName && name === paneName)) return false;\n", ""]]],
  ["no settle", S, [["this.timer = this.clock.setTimeout(() => this.flush(), this.settleMs);", "this.timer = this.clock.setTimeout(() => this.flush(), 0);"]]],
  ["no gap between lines", S, [["    if (this.sent && now - this.sent.at < this.gapMs) {", "    if (false) {"]]],
  ["the same line is sent again", S, [["    if (!force && this.sent && this.sent.line === line) return;\n", ""]]],
  ["no expiry", S, [["    const expires = !line.startsWith(\"idle\");", "    const expires = false;"]]],
  ["no refresh", S, [["    this.refreshTimer = expires ? this.clock.setTimeout(() => this.refresh(), this.refreshMs) : null;", "    this.refreshTimer = null;"]]],
  ["no line cap of 100", S, [["export const LINE_MAX = 100;", "export const LINE_MAX = 140;"]]],
  ["no text cap", S, [["export const TASK_MAX = 50;", "export const TASK_MAX = 500;"]]],
  ["| is kept in a text", S, [["    .replace(/\\|/g, \"/\")\n", ""]]],
  ["another separator", S, [["  if (state === \"working\") return t ? `working | task: ${t}` : \"working\";", "  if (state === \"working\") return t ? `working, task: ${t}` : \"working\";"]]],
  ["a denied wait outlives the next turn", S, [["      if (this.wait?.deny) this.wait = null;\n", ""]]],
  ["done keeps the task's name", S, [["    } else if (state === \"done\" || state === \"none\") {\n      this.names.delete(root);\n", "    } else if (state === \"done\" || state === \"none\") {\n"]]],
  ["no presence offline at stop", S, [["        this.sendPresence(\"offline\");\n", ""]]],
  ["the reader never checks a signature", S, [["typeof event.content === \"string\" && Array.isArray(event.tags) && verifyEvent(event);", "typeof event.content === \"string\" && Array.isArray(event.tags);"]]],
  ["the reader never checks expiry", S, [["      expired: expiresAt !== null && expiresAt <= now,", "      expired: false,"]]],
  ["presence from any signer", S, [["e.pubkey !== relayKey || ", ""]]],
  ["the whole status module taken out", S, [[null, "export {};\n"]]],
];

// As the repository lays it out (adapters/buzz beside hooks/lib), so the
// unattended-deny hook finds its own-claude check.
const ROOT = tempDir("status-mutants");
const COPY = join(ROOT, "adapters", "buzz");
for (const part of ["src", "test", "hooks", "package.json", "package-lock.json", "buzz-mcp.pin", "node_modules"]) {
  cpSync(join(ADAPTER, part), join(COPY, part), { recursive: true, verbatimSymlinks: true });
}
cpSync(join(ADAPTER, "..", "..", "hooks", "lib"), join(ROOT, "hooks", "lib"), { recursive: true });

const count = (s, sub) => s.split(sub).length - 1;
let killed = 0;
const rows = [];
try {
  for (const [name, file, pairs] of MUTANTS) {
    const path = join(COPY, file);
    const original = readFileSync(path, "utf8");
    let text;
    if (pairs[0][0] === null) text = pairs[0][1];
    else {
      const counts = pairs.map(([old]) => count(original, old));
      if (counts.some((n) => n !== 1)) {
        rows.push([name, `NOT APPLIED (${counts.join(",")} matches)`]);
        continue;
      }
      text = original;
      for (const [old, now] of pairs) text = text.replace(old, () => now);
    }
    writeFileSync(path, text);
    const r = spawnSync(process.execPath, ["--test", ...SUITES.map((s) => join(COPY, s))], {
      cwd: COPY,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
      encoding: "utf8",
      timeout: 600_000,
    });
    writeFileSync(path, original);
    const fails = (r.stdout.match(/^# fail (\d+)/m) || [])[1];
    const names = [...r.stdout.matchAll(/^not ok \d+ - (.*)$/gm)].map((m) => m[1]).slice(0, 2);
    if (r.status !== 0) {
      killed += 1;
      rows.push([name, `killed (${fails ?? "?"} failing: ${names.join("; ").slice(0, 120)})`]);
    } else {
      rows.push([name, "SURVIVED"]);
    }
  }
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}
for (const [name, res] of rows) console.log(`  ${name.padEnd(52)} ${res}`);
console.log(`mutants: ${killed}/${MUTANTS.length} killed`);
process.exit(killed === MUTANTS.length ? 0 : 1);
