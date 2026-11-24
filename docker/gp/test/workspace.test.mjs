// How a new agent starts: the model and effort, GHOST Protocol's workspace
// layout and the home's CLAUDE.md (setup.mjs), and gp claude model
// (claude.mjs). Each test starts from an empty volume of its own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const data = mkdtempSync(join(tmpdir(), "gp-workspace-"));
process.env.GP_DATA = data;
const { L, ROOT } = await import("../layout.mjs");
const { setup, readJson, writeJson, CLAUDE_DEFAULTS, claudeMdText } = await import("../setup.mjs");
const { model, effortKey } = await import("../claude.mjs");
const { GP_ROOT } = await import("../paths.mjs");

const SHARED = ["repos", "worktrees", "media", "desk", "scratch"];
const ENV = { GP_RELAY_KEY: "cd".repeat(32), BUZZ_RELAY_URL: "ws://127.0.0.1:9", BUZZ_ALLOWED_PUBKEYS: "ab".repeat(32), GP_NAME: "Ada" };

test.after(() => rmSync(data, { recursive: true, force: true }));

/** An empty volume. */
function empty() {
  for (const f of readdirSync(data)) rmSync(join(data, f), { recursive: true, force: true });
}
function capture() {
  let out = "";
  let err = "";
  return { o: { header: () => {}, kv: (k, v) => (out += `GP_${k}=${v}\n`), log: (l) => (err += l + "\n") }, get out() { return out; }, get err() { return err; } };
}
const settings = () => readJson(L.claudeSettings);
// Claude Code's effort for a model: modelSettings.<model>.effortLevel.
const effort = (m, s = settings()) => s.modelSettings?.[m]?.effortLevel;

test("a new volume: claude-opus-5-5 at medium effort, in Claude Code's user settings", () => {
  empty();
  assert.equal(setup(ENV), "ok");
  const s = settings();
  assert.equal(s.model, "claude-opus-5-5");
  assert.deepEqual(s.modelSettings, { "claude-opus-5-5": { effortLevel: "medium" } });
  // Not the top-level effortLevel: Claude Code no longer reads it from the user's settings for current models.
  assert.equal(s.effortLevel, undefined);
  assert.deepEqual(CLAUDE_DEFAULTS, { model: "claude-opus-5-5", effort: "medium" });
  const seen = readJson(L.claudeDefaults);
  assert.equal(seen.model.set, "claude-opus-5-5");
  assert.equal(seen.effort.set, "medium");
  // Not in the instance's --settings file: that would beat the owner's own pick.
  const flag = readJson(L.settings);
  assert.equal(flag.model, undefined);
  assert.equal(flag.modelSettings, undefined);
  assert.equal(flag.effortLevel, undefined);
});

test("a new volume: the layout's shared folders beside the home, the worktree hook, the folders in additionalDirectories", () => {
  empty();
  assert.equal(setup(ENV), "ok");
  assert.equal(L.home, join(ROOT, "agent"));
  for (const d of SHARED) assert.ok(statSync(join(ROOT, d)).isDirectory(), `${d} is a folder`);
  const s = settings();
  assert.deepEqual(s.permissions.additionalDirectories, SHARED.map((d) => join(ROOT, d)));
  const hook = join(GP_ROOT, "install", "layout", "worktree-hook");
  assert.equal(s.hooks.WorktreeCreate[0].hooks[0].command, `${hook} create --root ${ROOT}`);
  assert.equal(s.hooks.WorktreeRemove[0].hooks[0].command, `${hook} remove --root ${ROOT}`);
  // What the plugin needs is still there.
  assert.ok(s.permissions.allow.includes("mcp__plugin_ghost-protocol_buzz-channel"));
  assert.equal(s.pluginConfigs["ghost-protocol@ghost-protocol"].options.unattended, "on");
});

test("a new volume: the home's CLAUDE.md describes the layout, with the real paths", () => {
  empty();
  assert.equal(setup(ENV), "ok");
  const md = readFileSync(L.claudeMd, "utf8");
  assert.equal(md, claudeMdText());
  assert.ok(!md.includes("{{"), "every placeholder filled in");
  assert.match(md, /^# Your workspace$/m);
  assert.ok(md.includes(`\`${L.home}/\``));
  for (const d of SHARED) assert.ok(md.includes(`\`${ROOT}/${d}/`), `names ${d}/`);
  assert.ok(md.includes(`${ROOT}/repos/<owner>/<repo>`));
  assert.ok(md.includes(`${ROOT}/worktrees/<repo>/<branch>`));
  assert.ok(md.includes("additionalDirectories"));
  assert.equal(statSync(L.claudeMd).mode & 0o777, 0o644);
});

test("a second start changes nothing: no second copy of a folder or hook, the same settings and CLAUDE.md", () => {
  empty();
  assert.equal(setup(ENV), "ok");
  const s = readFileSync(L.claudeSettings, "utf8");
  const md = readFileSync(L.claudeMd, "utf8");
  const backups = readdirSync(dirname(L.claudeSettings)).filter((f) => f.startsWith("settings.json.bak-")).length;
  assert.equal(setup({}), "ok");
  assert.equal(readFileSync(L.claudeSettings, "utf8"), s);
  assert.equal(readFileSync(L.claudeMd, "utf8"), md);
  assert.equal(readdirSync(dirname(L.claudeSettings)).filter((f) => f.startsWith("settings.json.bak-")).length, backups);
});

test("the owner's own model and effort are kept, and so is a key the owner took out", () => {
  empty();
  mkdirSync(dirname(L.claudeSettings), { recursive: true });
  writeJson(L.claudeSettings, { model: "claude-sonnet-5-5", modelSettings: { "claude-opus-5-5": { effortLevel: "high", autoCompactWindow: 400000 } }, theme: "dark" });
  assert.equal(setup(ENV), "ok");
  let s = settings();
  assert.deepEqual([s.model, effort("claude-opus-5-5", s), s.modelSettings["claude-opus-5-5"].autoCompactWindow, s.theme], ["claude-sonnet-5-5", "high", 400000, "dark"]);
  assert.equal(readJson(L.claudeDefaults).model.kept, "claude-sonnet-5-5");
  assert.equal(readJson(L.claudeDefaults).effort.kept, "high");
  // The owner takes the model and the effort out (Claude Code's own defaults): they stay out.
  delete s.model;
  delete s.modelSettings["claude-opus-5-5"].effortLevel;
  writeJson(L.claudeSettings, s);
  assert.equal(setup({}), "ok");
  s = settings();
  assert.equal(s.model, undefined);
  assert.equal(effort("claude-opus-5-5", s), undefined);
  // And on a volume where the image set them, an owner's change is kept too.
  empty();
  assert.equal(setup(ENV), "ok");
  writeJson(L.claudeSettings, { ...settings(), modelSettings: { "claude-opus-5-5": { effortLevel: "low" } } });
  assert.equal(setup({}), "ok");
  assert.equal(effort("claude-opus-5-5"), "low");
  // Settings whose modelSettings is not an object: left alone, and the start goes on.
  empty();
  mkdirSync(dirname(L.claudeSettings), { recursive: true });
  writeJson(L.claudeSettings, { modelSettings: "odd" });
  assert.equal(setup(ENV), "ok");
  assert.equal(settings().modelSettings, "odd");
  assert.equal(settings().model, "claude-opus-5-5");
});

test("an older volume upgrades: the layout, the defaults and CLAUDE.md are added, the rest is kept", () => {
  empty();
  // What an earlier image left: settings, Claude Code's own keys, a home with its
  // manifest and the agent's own files, a session's state, and no layout.
  assert.equal(setup(ENV), "ok");
  for (const d of SHARED) rmSync(join(ROOT, d), { recursive: true });
  rmSync(L.claudeMd);
  rmSync(L.claudeDefaults);
  rmSync(L.claudeMdState);
  const old = settings();
  delete old.model;
  delete old.modelSettings;
  delete old.hooks;
  old.permissions.additionalDirectories = ["/data/elsewhere"];
  old.statusLine = { type: "command", command: "true" };
  writeJson(L.claudeSettings, old);
  writeFileSync(join(L.home, "tasks.md"), "- a task\n");
  assert.equal(setup({}), "ok");
  const s = settings();
  assert.deepEqual([s.model, effort("claude-opus-5-5", s)], ["claude-opus-5-5", "medium"]);
  assert.deepEqual(s.permissions.additionalDirectories, ["/data/elsewhere", ...SHARED.map((d) => join(ROOT, d))]);
  assert.deepEqual(s.statusLine, old.statusLine);
  assert.ok(s.hooks.WorktreeCreate);
  for (const d of SHARED) assert.ok(existsSync(join(ROOT, d)));
  assert.equal(readFileSync(join(L.home, "tasks.md"), "utf8"), "- a task\n");
  assert.equal(readFileSync(L.claudeMd, "utf8"), claudeMdText());
});

test("CLAUDE.md: the owner's own, and an edited copy, are kept; an unedited older copy is replaced; a missing one comes back", () => {
  empty();
  mkdirSync(L.home, { recursive: true });
  writeFileSync(L.claudeMd, "# Mine\n");
  assert.equal(setup(ENV), "ok");
  assert.equal(readFileSync(L.claudeMd, "utf8"), "# Mine\n");
  assert.equal(existsSync(L.claudeMdState), false);

  empty();
  assert.equal(setup(ENV), "ok");
  writeFileSync(L.claudeMd, claudeMdText() + "\n- my own note\n");
  assert.equal(setup({}), "ok");
  assert.match(readFileSync(L.claudeMd, "utf8"), /my own note/);

  // An older image's copy, never edited: its hash is the one recorded.
  empty();
  assert.equal(setup(ENV), "ok");
  const older = "# Your workspace\n\nAn older text.\n";
  writeFileSync(L.claudeMd, older);
  writeJson(L.claudeMdState, { sha256: execFileSync("sha256sum", [L.claudeMd], { encoding: "utf8" }).split(" ")[0] });
  assert.equal(setup({}), "ok");
  assert.equal(readFileSync(L.claudeMd, "utf8"), claudeMdText());

  unlinkSync(L.claudeMd);
  assert.equal(setup({}), "ok");
  assert.equal(readFileSync(L.claudeMd, "utf8"), claudeMdText());
});

test("a layout folder's place taken by a file: left alone, and the start still goes on", () => {
  empty();
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(join(ROOT, "media"), "not a folder\n");
  assert.equal(setup(ENV), "ok");
  assert.equal(readFileSync(join(ROOT, "media"), "utf8"), "not a folder\n");
  assert.ok(existsSync(join(ROOT, "scratch")));
  assert.ok(existsSync(L.claudeMd));
});

test("gp claude model: shows the model and effort, and picks others that setup then keeps", () => {
  empty();
  assert.equal(setup(ENV), "ok");
  let c = capture();
  let restarted = 0;
  const restart = () => (restarted++, true);
  assert.equal(model([], c.o, { restart }), 0);
  assert.equal(c.out, "GP_CLAUDE_MODEL=claude-opus-5-5\nGP_CLAUDE_EFFORT=medium\n");
  assert.equal(restarted, 0);

  c = capture();
  assert.equal(model(["claude-sonnet-5-5", "--effort", "high"], c.o, { restart }), 0);
  assert.equal(c.out, "GP_CLAUDE_MODEL=claude-sonnet-5-5\nGP_CLAUDE_EFFORT=high\n");
  assert.equal(restarted, 1);
  assert.equal(setup({}), "ok");
  assert.deepEqual([settings().model, effort("claude-sonnet-5-5"), effort("claude-opus-5-5")], ["claude-sonnet-5-5", "high", "medium"]);
  assert.equal(settings().effortLevel, undefined);

  // An effort alone is for the model set now.
  c = capture();
  assert.equal(model(["--effort", "xhigh"], c.o, { restart }), 0);
  assert.equal(c.out, "GP_CLAUDE_MODEL=claude-sonnet-5-5\nGP_CLAUDE_EFFORT=xhigh\n");
  assert.deepEqual([effort("claude-sonnet-5-5"), effort("claude-opus-5-5")], ["xhigh", "medium"]);

  // Back to the opus default model: its own effort, medium, is still there.
  c = capture();
  assert.equal(model(["claude-opus-5-5"], c.o, { restart }), 0);
  assert.equal(c.out, "GP_CLAUDE_MODEL=claude-opus-5-5\nGP_CLAUDE_EFFORT=medium\n");

  c = capture();
  assert.equal(model(["--effort", "default"], c.o, { restart }), 0);
  assert.equal(c.out, "GP_CLAUDE_MODEL=claude-opus-5-5\nGP_CLAUDE_EFFORT=default\n");
  c = capture();
  assert.equal(model(["default"], c.o, { restart }), 0);
  assert.equal(c.out, "GP_CLAUDE_MODEL=default\nGP_CLAUDE_EFFORT=default\n");
  assert.equal(setup({}), "ok");
  assert.deepEqual([settings().model, effort("claude-opus-5-5")], [undefined, undefined]);
  // The rest of Claude Code's settings stay as they were.
  assert.ok(settings().hooks.WorktreeCreate);
  assert.equal(effort("claude-sonnet-5-5"), "xhigh");

  // With no model set, an effort needs one named.
  assert.throws(() => model(["--effort", "high"], capture().o, { restart }), (e) => e.code === "effort-needs-model");
  for (const bad of [["--effort", "huge"], ["two words"], ["a", "b"], ["--effort"], ["--model", "x"]]) {
    assert.throws(() => model(bad, capture().o, { restart }), (e) => ["usage", "bad-model", "bad-effort"].includes(e.code), bad.join(" "));
  }
});

test("gp claude model before the first start: setup does not put the default back", () => {
  empty();
  mkdirSync(dirname(L.claudeSettings), { recursive: true });
  assert.equal(model(["default"], capture().o, { restart: () => false }), 0);
  assert.equal(setup(ENV), "ok");
  assert.equal(settings().model, undefined);
  assert.equal(effort("claude-opus-5-5"), "medium");
});

test("the layout only adds: an owner's set of shared folders under another parent stays in additionalDirectories", () => {
  empty();
  mkdirSync(dirname(L.claudeSettings), { recursive: true });
  const other = SHARED.map((d) => `/srv/other/${d}`);
  writeJson(L.claudeSettings, { permissions: { additionalDirectories: other } });
  assert.equal(setup(ENV), "ok");
  assert.deepEqual(settings().permissions.additionalDirectories, [...other, ...SHARED.map((d) => join(ROOT, d))]);
  assert.equal(setup({}), "ok");
  assert.deepEqual(settings().permissions.additionalDirectories, [...other, ...SHARED.map((d) => join(ROOT, d))]);
});

test("gp claude model: a settings file that is not a JSON object is refused, and left as it is", () => {
  for (const text of ["{not json", "[1, 2]", "\"a string\"", "null"]) {
    empty();
    mkdirSync(dirname(L.claudeSettings), { recursive: true });
    writeFileSync(L.claudeSettings, text);
    let restarted = 0;
    for (const argv of [["claude-sonnet-5-5"], ["--effort", "high"], []]) {
      assert.throws(() => model(argv, capture().o, { restart: () => (restarted++, true) }), (e) => e.code === "bad-settings", `${text}: ${argv.join(" ")}`);
    }
    assert.equal(readFileSync(L.claudeSettings, "utf8"), text);
    assert.equal(existsSync(L.claudeDefaults), false);
    assert.equal(restarted, 0);
  }
  // An empty file is no settings yet: taken as {}.
  empty();
  mkdirSync(dirname(L.claudeSettings), { recursive: true });
  writeFileSync(L.claudeSettings, "");
  assert.equal(model(["claude-sonnet-5-5"], capture().o, { restart: () => false }), 0);
  assert.equal(settings().model, "claude-sonnet-5-5");
});

test("gp claude model: full model ids only; the effort goes under the plain id, where Claude Code reads it", () => {
  assert.equal(effortKey("claude-opus-5-5"), "claude-opus-5-5");
  assert.equal(effortKey("claude-opus-5-5[1m]"), "claude-opus-5-5");
  assert.equal(effortKey("claude-opus-4-1@20250805"), "claude-opus-4-1");
  assert.equal(effortKey("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  for (const m of ["opus", "sonnet", "Claude-Opus-5-5", "claude-", "claude-opus-5-5[2m]", "x".repeat(200), undefined]) assert.equal(effortKey(m), null, String(m));

  empty();
  assert.equal(setup(ENV), "ok");
  const restart = () => true;
  // An alias is refused, with or without an effort, and nothing is written.
  const before = readFileSync(L.claudeSettings, "utf8");
  for (const argv of [["opus"], ["opus", "--effort", "high"], ["sonnet"]]) {
    assert.throws(() => model(argv, capture().o, { restart }), (e) => e.code === "bad-model" && /full model id/.test(e.message), argv.join(" "));
  }
  assert.equal(readFileSync(L.claudeSettings, "utf8"), before);

  // The 1M-context spelling: the model as given, the effort under the plain id.
  let c = capture();
  assert.equal(model(["claude-opus-5-5[1m]", "--effort", "high"], c.o, { restart }), 0);
  assert.equal(c.out, "GP_CLAUDE_MODEL=claude-opus-5-5[1m]\nGP_CLAUDE_EFFORT=high\n");
  assert.equal(settings().model, "claude-opus-5-5[1m]");
  assert.deepEqual(settings().modelSettings, { "claude-opus-5-5": { effortLevel: "high" } });

  // A model set by hand as an alias: its effort cannot be told, and an effort alone needs a full id named.
  writeJson(L.claudeSettings, { ...settings(), model: "opus" });
  c = capture();
  assert.equal(model([], c.o, { restart }), 0);
  assert.equal(c.out, "GP_CLAUDE_MODEL=opus\nGP_CLAUDE_EFFORT=unknown\n");
  assert.throws(() => model(["--effort", "low"], capture().o, { restart }), (e) => e.code === "effort-needs-model");
  c = capture();
  assert.equal(model(["claude-opus-5-5", "--effort", "low"], c.o, { restart }), 0);
  assert.equal(c.out, "GP_CLAUDE_MODEL=claude-opus-5-5\nGP_CLAUDE_EFFORT=low\n");
});

function dirname(p) {
  return p.slice(0, p.lastIndexOf("/"));
}
