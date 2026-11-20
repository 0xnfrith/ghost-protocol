// REMOTE_SCRIPT, the one thing run on a VM, run for real under sh (and bash, where there is one) against a folder standing in for
// the VM; and parseRemote, which reads what it prints. Run: node --test test/*.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { REMOTE_SCRIPT, parseRemote } from "../lib.mjs";
import { NOT_A_FILE, SESSION, SHA, cleanUp, renderRemote, sha256, snapshot, tempDir } from "./helpers.mjs";

after(cleanUp);

const shells = ["sh", "bash", "dash"].filter((sh) => spawnSync(sh, ["-c", "exit 0"]).status === 0);

const DIR = Symbol("dir");
class Link {
  constructor(target) {
    this.target = target;
  }
}
const link = (target) => new Link(target);

/** A folder standing in for a VM: <root>/home, <root>/clone, <root>/state. `files` are written as given: a string or Buffer, or DIR / link(target). */
function vm(files = {}) {
  const root = tempDir("vm");
  const at = { home: join(root, "home"), clone: join(root, "clone"), state: join(root, "state") };
  for (const dir of Object.values(at)) mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    if (content === DIR) mkdirSync(path, { recursive: true });
    else if (content instanceof Link) symlinkSync(content.target, path);
    else writeFileSync(path, content);
  }
  return { root, ...at };
}

function run(v, { shell = "sh", args, env } = {}) {
  const result = spawnSync(shell, ["-s", "--", ...(args ?? [v.home, v.clone, v.state])], { input: REMOTE_SCRIPT, encoding: "utf8", env: env ?? { PATH: process.env.PATH, LANG: "C" } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const parsed = (v, options) => {
  const out = run(v, options);
  const r = parseRemote(out);
  assert.notEqual(r, null, out);
  return r;
};

const CLASS = Buffer.from([0x23, 0x20, 0x00, 0xff, 0xfe, 0x0a, 0x0d, 0x0a, 0x80]); // bytes, not text
const AGENTS = Buffer.from("# AGENTS.md\nthe team rules\n");

for (const shell of shells) {
  test(`${shell}: the script reads the class file, the agents file, the session id and the proof`, () => {
    const proof = JSON.stringify({ schema: "x", n: 1 });
    const v = vm({ "home/CLAUDE.md": CLASS, "clone/AGENTS.md": AGENTS, "state/session-id": `${SESSION}\n`, "state/pane-pid": "4242\n", "state/proof.json": proof });
    const r = parsed(v, { shell });
    assert.equal(r.classDisk, sha256(CLASS));
    assert.equal(r.agentsDisk, sha256(AGENTS));
    assert.equal(r.sessionId, SESSION);
    assert.equal(r.panePid, 4242);
    assert.equal(r.proof.kind, "text");
    assert.equal(r.proof.bytes.toString(), proof);
  });

  test(`${shell}: a file that is not there, or is not a file, or is a link`, () => {
    let r = parsed(vm({}), { shell });
    assert.equal(r.classDisk, "missing");
    assert.equal(r.agentsDisk, "missing");
    assert.equal(r.sessionId, null);
    assert.deepEqual(r.proof, { kind: "missing" });

    const dirs = vm({ "home/CLAUDE.md": DIR, "clone/AGENTS.md": DIR, "state/proof.json": DIR });
    r = parsed(dirs, { shell });
    assert.equal(r.classDisk, "not-a-file");
    assert.equal(r.agentsDisk, "not-a-file");
    assert.deepEqual(r.proof, { kind: "not-a-file" });

    // A link to a regular file counts, as it does for Claude Code and for the hook; a dangling one is missing.
    const linkedFiles = vm({ "elsewhere.md": CLASS, "home/CLAUDE.md": link("../elsewhere.md"), "clone/AGENTS.md": link("../nowhere.md") });
    r = parsed(linkedFiles, { shell });
    assert.equal(r.classDisk, sha256(CLASS));
    assert.equal(r.agentsDisk, "missing");
  });

  test(`${shell}: no team repo (an empty clone argument) skips the agents file`, () => {
    const v = vm({ "home/CLAUDE.md": CLASS, "clone/AGENTS.md": AGENTS });
    const r = parsed(v, { shell, args: [v.home, "", v.state] });
    assert.equal(r.agentsDisk, "skipped");
    assert.equal(r.classDisk, sha256(CLASS));
  });

  test(`${shell}: the session id is read as hooks/session-id reads it`, () => {
    const id = (content) => parsed(vm({ "state/session-id": content }), { shell }).sessionId;
    assert.equal(id(SESSION), SESSION);
    assert.equal(id(`${SESSION}\n`), SESSION);
    assert.equal(id(`  ${SESSION}\r\n\n`), SESSION);
    assert.equal(id(`${SESSION.slice(0, 13)} ${SESSION.slice(13)}\n`), SESSION, "all white space is removed, as the hook does");
    for (const bad of ["", "\n", "not-a-session", SESSION.toUpperCase(), `${SESSION}\n${SESSION}\n`, `${SESSION}x`, SESSION.slice(1), `${SESSION}${" ".repeat(2000)}x`]) {
      assert.equal(id(bad), null, JSON.stringify(bad));
    }
    // Nothing printed for a bad one can break the framing.
    assert.notEqual(parseRemote(run(vm({ "state/session-id": `${SESSION}\nend\nclass x\n` }), { shell })), null);
  });

  test(`${shell}: a session-id that is a link or a folder is missing, as for the hook`, () => {
    const linked = vm({ "target-id": SESSION, "state/session-id": link("../target-id") });
    assert.equal(parsed(linked, { shell }).sessionId, null);
    assert.equal(parsed(vm({ "state/session-id": DIR }), { shell }).sessionId, null);
  });

  test(`${shell}: the claude pid is read from pane-pid as digits, as the hooks read it`, () => {
    const pid = (content) => parsed(vm({ "state/pane-pid": content }), { shell }).panePid;
    assert.equal(pid("4242"), 4242);
    assert.equal(pid("4242\n"), 4242);
    assert.equal(pid("  4242 \r\n\n"), 4242);
    assert.equal(pid("42\n42\n"), 4242, "white space is removed, as the hook removes it when it records the pid");
    for (const bad of ["", "\n", "abc", "42a", "-42", "4.2", "0", "1", "0042", "99999999999", `4242${" ".repeat(2000)}x`, "0x10"]) assert.equal(pid(bad), null, JSON.stringify(bad));
    assert.equal(parsed(vm({}), { shell }).panePid, null, "no file");
    // Nothing printed for a bad one can break the framing.
    assert.notEqual(parseRemote(run(vm({ "state/pane-pid": "1\nend\nclass x\n" }), { shell })), null);
  });

  test(`${shell}: a pane-pid that is a link or a folder is missing`, () => {
    const linked = vm({ "target-pid": "4242", "state/pane-pid": link("../target-pid") });
    assert.equal(parsed(linked, { shell }).panePid, null);
    assert.equal(parsed(vm({ "state/pane-pid": DIR }), { shell }).panePid, null);
  });

  test(`${shell}: the proof is passed on whole, as bytes, and capped at 64 KiB`, () => {
    const bytes = Buffer.from([0x7b, 0x00, 0xff, 0x0a, 0x22, 0x20, 0x7d, 0x0a, 0x0a]);
    assert.deepEqual(parsed(vm({ "state/proof.json": bytes }), { shell }).proof.bytes, bytes);
    assert.equal(parsed(vm({ "state/proof.json": "" }), { shell }).proof.bytes.length, 0);
    assert.equal(parsed(vm({ "state/proof.json": Buffer.alloc(65_536, 0x20) }), { shell }).proof.bytes.length, 65_536);
    assert.equal(parsed(vm({ "state/proof.json": Buffer.alloc(300_000, 0x20) }), { shell }).proof.bytes.length, 65_537);
    const linked = vm({ "elsewhere.json": "{}", "state/proof.json": link("../elsewhere.json") });
    assert.deepEqual(parsed(linked, { shell }).proof, { kind: "not-a-file" });
  });

  test(`${shell}: arguments with spaces and quotes are single words`, () => {
    const root = tempDir("odd");
    const home = join(root, "ho me'x");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "CLAUDE.md"), CLASS);
    const r = parseRemote(run({}, { shell, args: [home, "", join(root, "st ate")] }));
    assert.equal(r.classDisk, sha256(CLASS));
  });

  test(`${shell}: it changes nothing on the VM`, () => {
    const v = vm({ "home/CLAUDE.md": CLASS, "clone/AGENTS.md": AGENTS, "state/session-id": SESSION, "state/proof.json": "{}", "state/other": "x" });
    const before = snapshot(v.root);
    run(v, { shell });
    run(vm({}), { shell });
    assert.deepEqual(snapshot(v.root), before);
    // Also a folder it cannot write to: a read-only tree gives the same output. The `now` line is the VM's clock, so two runs can
    // fall in different seconds: it is blanked on both before they are compared.
    const clockless = (out) => out.replace(/^now \d+$/m, "now X");
    chmodSync(v.state, 0o500);
    try {
      assert.equal(clockless(run(v, { shell })), clockless(run(v, { shell })));
    } finally {
      chmodSync(v.state, 0o700);
    }
  });
}

test("the hash falls back from sha256sum to shasum to openssl, and says so when there is none", () => {
  const tools = ["tr", "head", "od", "perl"];
  const bin = (...extra) => {
    const dir = tempDir("bin");
    for (const name of [...tools, ...extra]) {
      const which = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      if (which) symlinkSync(which, join(dir, name));
    }
    return dir;
  };
  const v = vm({ "home/CLAUDE.md": CLASS });
  const withTools = (...extra) => parsed(v, { shell: "/bin/sh", env: { PATH: bin(...extra), LANG: "C" } }).classDisk;
  assert.equal(withTools("sha256sum"), sha256(CLASS));
  assert.equal(withTools("shasum"), sha256(CLASS));
  assert.equal(withTools("openssl"), sha256(CLASS));
  assert.equal(withTools(), "no-sha256");
});

test("a hash tool that prints something else than a sha256 is unreadable, not a sha", () => {
  const v = vm({ "home/CLAUDE.md": CLASS });
  for (const printed of ["abc123 -", "zz -", "", `${sha256(CLASS)}0 -`, `${sha256(CLASS).slice(1)} -`, `${sha256(CLASS).toUpperCase()} -`]) {
    const dir = tempDir("fakehash");
    for (const name of ["tr", "head", "od"]) symlinkSync(spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim(), join(dir, name));
    writeFileSync(join(dir, "sha256sum"), `#!/bin/sh\n/bin/cat >/dev/null\n${printed ? `echo '${printed}'` : "exit 1"}\n`, { mode: 0o755 });
    assert.equal(parsed(v, { shell: "/bin/sh", env: { PATH: dir, LANG: "C" } }).classDisk, "unreadable", printed);
  }
});

test("the script only reads: it writes nowhere, and runs no command that writes", () => {
  const code = REMOTE_SCRIPT.replace(/^\s*#.*$/gm, "");
  assert.doesNotMatch(code.replace(/2>\/dev\/null|>\/dev\/null|2>&1/g, ""), />/, "a redirection other than to /dev/null");
  assert.doesNotMatch(code, /<</, "no here-document");
  assert.doesNotMatch(code, /`/, "no backquote");
  assert.doesNotMatch(code, /\b(rm|mv|cp|tee|dd|touch|mkdir|rmdir|chmod|chown|ln|install|truncate|sed|awk|curl|wget|nc|scp|rsync|sftp|ssh|git|kill|sudo|eval|exec|source|sh|bash)\b/);
  const commands = new Set([...code.matchAll(/(?:^|[;&|(]\s*|\$\(\s*|\{\s+|then\s+|else\s+|do\s+)([a-z][a-z0-9_-]*)/gm)].map((m) => m[1]));
  const allowed = new Set(["printf", "command", "sha256sum", "shasum", "openssl", "tr", "head", "od", "export", "return", "echo", "if", "then", "elif", "else", "fi", "case", "esac", "sha256_of", "file_sha", "d", "f", "s", "m", "n", "t", "k", "id", "stat", "date", "LC_ALL"]);
  for (const c of commands) assert.ok(allowed.has(c), `unexpected command word: ${c}`);
});

test("the script is a constant: it holds no placeholder for a config value", () => {
  assert.doesNotMatch(REMOTE_SCRIPT, /\$\{(?!d%%|t%%|t#|#d|#id)/);
  assert.match(REMOTE_SCRIPT, /"\$1\/CLAUDE\.md"/);
  assert.match(REMOTE_SCRIPT, /"\$2\/AGENTS\.md"/);
  assert.match(REMOTE_SCRIPT, /"\$3\/session-id"/);
  assert.match(REMOTE_SCRIPT, /"\$3\/pane-pid"/);
  assert.match(REMOTE_SCRIPT, /"\$3\/turn"/);
  assert.match(REMOTE_SCRIPT, /"\$3\/proof\.json"/);
});

test("parseRemote reads the script's output and nothing else", () => {
  const good = renderRemote({ proof: { schema: "s" } });
  const r = parseRemote(good);
  assert.equal(r.classDisk, SHA("a"));
  assert.equal(r.agentsDisk, SHA("b"));
  assert.equal(r.sessionId, SESSION);
  assert.equal(r.panePid, 4242);
  assert.equal(r.proof.bytes.toString(), '{"schema":"s"}');
  assert.equal(parseRemote(renderRemote({ proof: null })).proof.kind, "missing");
  assert.equal(parseRemote(renderRemote({ proof: NOT_A_FILE })).proof.kind, "not-a-file");
  assert.equal(parseRemote(renderRemote({ agentsDisk: "skipped" })).agentsDisk, "skipped");
  for (const word of ["missing", "not-a-file", "unreadable", "no-sha256"]) assert.equal(parseRemote(renderRemote({ classDisk: word, agentsDisk: word })).classDisk, word);
  assert.equal(parseRemote(renderRemote({ session: "missing" })).sessionId, null);
  assert.equal(parseRemote(renderRemote({ session: "invalid" })).sessionId, null);
  assert.equal(parseRemote(renderRemote({ session: "0b1c-2d" })).sessionId, null, "a token that is not an id is an invalid id, not garbage");
  assert.equal(parseRemote(renderRemote({ panePid: "missing" })).panePid, null);
  assert.equal(parseRemote(renderRemote({ panePid: "invalid" })).panePid, null);
  for (const odd of ["0", "1", "0042", "99999999999"]) assert.equal(parseRemote(renderRemote({ panePid: odd })).panePid, null, `${odd} is no pid`);
  assert.equal(parseRemote(renderRemote({ panePid: "2" })).panePid, 2);
});

test("parseRemote refuses anything but the whole output: cut, padded, reordered, or odd", () => {
  const lines = renderRemote({ proof: { a: 1 }, turn: "idle p1", turnMtime: "100", now: "160" }).split("\n");
  // 0 marker, 1 class, 2 agents, 3 session, 4 pane-pid, 5 turn, 6 turn-mtime, 7 now, 8 proof, 9 end, 10 empty (the final newline)
  const join_ = (l) => l.join("\n");
  const at = (i, line) => join_([...lines.slice(0, i), line, ...lines.slice(i + 1)]);
  const bad = {
    empty: "",
    "a banner first": `Welcome\n${join_(lines)}`,
    "no end": join_(lines.filter((l) => l !== "end")),
    "cut in the middle": join_(lines.slice(0, 5)),
    "cut before the pane pid": join_([...lines.slice(0, 4), ...lines.slice(5)]),
    "the output of the first version, with no turn": join_(["rollout-check v1", ...lines.slice(1, 5), ...lines.slice(8)]),
    "no turn lines": join_([...lines.slice(0, 5), ...lines.slice(8)]),
    "turn without its time and the clock": join_([...lines.slice(0, 6), ...lines.slice(8)]),
    "text after the end": `${join_(lines)}more\n`,
    "no final newline": join_(lines).replace(/\n$/, ""),
    "two blocks": join_(lines) + join_(lines),
    reordered: join_([lines[0], lines[2], lines[1], ...lines.slice(3)]),
    "pane pid before the session": join_([...lines.slice(0, 3), lines[4], lines[3], ...lines.slice(5)]),
    "the turn before the pane pid": join_([...lines.slice(0, 4), lines[5], lines[4], ...lines.slice(6)]),
    "the clock before the marker's time": join_([...lines.slice(0, 6), lines[7], lines[6], ...lines.slice(8)]),
    "wrong version": at(0, "rollout-check v1"),
    "a later version": at(0, "rollout-check v3"),
    "class is not a sha": at(1, "class xyz"),
    "class sha too short": at(1, `class ${SHA("a").slice(1)}`),
    "class sha upper case": at(1, `class ${SHA("A")}`),
    "agents is the class word": at(2, "agents nothing"),
    "class says skipped": at(1, "class skipped"),
    "session with a space": at(3, "session a b"),
    "session empty": at(3, "session "),
    "pane pid with a space": at(4, "pane-pid 4 2"),
    "pane pid empty": at(4, "pane-pid "),
    "pane pid in letters": at(4, "pane-pid abc"),
    "pane pid of 33 digits": at(4, `pane-pid ${"1".repeat(33)}`),
    "pane pid word unknown": at(4, "pane-pid gone"),
    "line 5 is not a turn line": at(5, "pane-pid 4242"),
    "line 5 is a turn line of another name": at(5, "turns idle p1"),
    "line 6 is not a turn-mtime line": at(6, "turn 100"),
    "line 7 is not a now line": at(7, "time 160"),
    "turn word unknown": at(5, "turn gone"),
    "turn empty": at(5, "turn "),
    "turn busy without an id": at(5, "turn busy"),
    "turn busy with an empty id": at(5, "turn busy "),
    "turn busy with a space in the id": at(5, "turn busy a b"),
    "turn idle with a symbol in the id": at(5, "turn idle a;b"),
    "turn idle with a 65-character id": at(5, `turn idle ${"a".repeat(65)}`),
    "turn with an unknown state word": at(5, "turn done p1"),
    "turn upper case": at(5, "turn IDLE p1"),
    "mtime in letters": at(6, "turn-mtime abc"),
    "mtime negative": at(6, "turn-mtime -5"),
    "mtime of 13 digits": at(6, `turn-mtime ${"1".repeat(13)}`),
    "mtime empty": at(6, "turn-mtime "),
    "mtime a decimal": at(6, "turn-mtime 1.5"),
    "mtime word unknown": at(6, "turn-mtime gone"),
    "clock in letters": at(7, "now abc"),
    "clock of 13 digits": at(7, `now ${"1".repeat(13)}`),
    "clock empty": at(7, "now "),
    "clock word unknown": at(7, "now gone"),
    "proof hex odd": join_([...lines.slice(0, 8), "proof-hex abc", "end", ""]),
    "proof hex upper": join_([...lines.slice(0, 8), "proof-hex 7B", "end", ""]),
    "proof hex with a space": join_([...lines.slice(0, 8), "proof-hex 7b 7d", "end", ""]),
    "proof word unknown": join_([...lines.slice(0, 8), "proof gone", "end", ""]),
    "an extra line": join_([...lines.slice(0, 9), "extra", "end", ""]),
    "the end marker is another word": join_([...lines.slice(0, 9), "fin", ""]),
  };
  for (const [why, text] of Object.entries(bad)) assert.equal(parseRemote(text), null, why);
  assert.equal(parseRemote(undefined), null);
});

// The turn marker: hooks/turn-state writes `busy <prompt id>` at UserPromptSubmit and `idle <prompt id>` at the Stop, in one step.
for (const shell of shells) {
  const turn = (content, options) => parsed(vm({ "state/turn": content }), { shell, ...options }).turn;

  test(`${shell}: the turn marker is read as hooks/turn-state writes it`, () => {
    const first = turn("busy p-1\n");
    assert.equal(first.state, "busy");
    assert.equal(first.promptId, "p-1");
    assert.ok(first.mtime !== null && first.now !== null && first.ageSeconds >= 0);
    assert.equal(turn("idle abc-123\n").state, "idle");
    assert.equal(turn("idle abc-123\n").promptId, "abc-123");
    assert.equal(turn("busy -\n").promptId, "-", "the hook writes - when Claude Code gave no prompt id");
    assert.equal(turn(`idle ${"a".repeat(64)}\n`).promptId, "a".repeat(64));
    assert.equal(turn("idle p1").promptId, "p1", "no final newline");
    assert.equal(turn("idle p1\nbusy p2\n").promptId, "p1", "the first line only");
  });

  test(`${shell}: a marker that is not the hook's form is invalid, and never breaks the framing`, () => {
    const bad = ["", "\n", "busy", "busy ", "idle", "idle a b", "done p1", "idle a;b", "idle $(x)", "idle `x`", `idle ${"a".repeat(65)}`, "IDLE p1", "busy p1\r\n", "\u0000", " idle p1", "idle  p1", "busy\tp1", "x".repeat(300_000)];
    for (const content of bad) {
      const r = turn(content);
      assert.equal(r.state, "invalid", JSON.stringify(content.slice(0, 40)));
      assert.equal(r.promptId, null);
    }
    // A marker that says "end" or another line's name cannot move the other lines.
    const r = parseRemote(run(vm({ "state/turn": "idle x\nend\nclass y\nproof missing\n" }), { shell }));
    assert.equal(r.turn.promptId, "x");
    assert.equal(r.classDisk, "missing");
  });

  test(`${shell}: a marker that holds shell syntax runs nothing`, () => {
    const v = vm({ "state/turn": "busy $(touch ../PWNED)\nidle ;touch ../PWNED\n" });
    assert.equal(parsed(v, { shell }).turn.state, "invalid");
    const w = vm({ "state/turn": "idle `touch ../PWNED`\n" });
    assert.equal(parsed(w, { shell }).turn.state, "invalid");
    for (const x of [v, w]) assert.deepEqual(snapshot(x.root).filter((l) => l.includes("PWNED")), []);
  });

  test(`${shell}: a marker that is missing, a folder or a link is not a marker`, () => {
    assert.equal(parsed(vm({}), { shell }).turn.state, "missing");
    assert.equal(parsed(vm({ "state/turn": DIR }), { shell }).turn.state, "not-a-file");
    assert.equal(parsed(vm({ "target-turn": "idle p1\n", "state/turn": link("../target-turn") }), { shell }).turn.state, "not-a-file", "as for session-id and pane-pid");
    assert.equal(parsed(vm({}), { shell }).turn.mtime, null);
  });

  test(`${shell}: the marker's age is the VM's own difference between its clock and the file's time`, () => {
    const v = vm({ "state/turn": "idle p1\n" });
    const mtime = Math.floor(Date.now() / 1000) - 125;
    utimesSync(join(v.state, "turn"), mtime, mtime);
    const r = parsed(v, { shell }).turn;
    assert.equal(r.mtime, mtime);
    assert.ok(r.now >= mtime + 125 && r.now <= mtime + 130, `now ${r.now}`);
    assert.ok(r.ageSeconds >= 125 && r.ageSeconds <= 130, `age ${r.ageSeconds}`);
    // A marker dated after the VM's clock has no age.
    const future = Math.floor(Date.now() / 1000) + 5000;
    utimesSync(join(v.state, "turn"), future, future);
    assert.equal(parsed(v, { shell }).turn.ageSeconds, null);
    assert.equal(parsed(v, { shell }).turn.mtime, future);
  });
}

test("a clock or a stat that is not there gives no age, not an error", () => {
  const tools = ["tr", "head", "od", "sha256sum"];
  const bin = (...extra) => {
    const dir = tempDir("bin2");
    for (const name of [...tools, ...extra]) {
      const which = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      if (which) symlinkSync(which, join(dir, name));
    }
    return dir;
  };
  const v = vm({ "state/turn": "idle p1\n" });
  const readWith = (...extra) => parsed(v, { shell: "/bin/sh", env: { PATH: bin(...extra), LANG: "C" } }).turn;
  const none = readWith();
  assert.equal(none.state, "idle");
  assert.equal(none.mtime, null);
  assert.equal(none.now, null);
  assert.equal(none.ageSeconds, null);
  const both = readWith("stat", "date");
  assert.ok(both.mtime !== null && both.now !== null && both.ageSeconds >= 0);
  assert.equal(readWith("date").mtime, null, "a clock with no stat has no time for the file");
});

test("the script still changes nothing on the VM with a turn marker there", () => {
  const v = vm({ "state/turn": "busy p1\n", "state/session-id": SESSION });
  const before = snapshot(v.root);
  for (const shell of shells) run(v, { shell });
  assert.deepEqual(snapshot(v.root), before);
});
