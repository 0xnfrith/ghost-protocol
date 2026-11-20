// The settings reader (schema/config.mjs): where a setting comes from, and what a bad value does.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, operatorNames, readPluginOptions } from "../schema/config.mjs";

// The plugin's id, written out: a test that used the reader's own constant would follow it wherever it went.
const PLUGIN_ID = "ghost-protocol@ghost-protocol";

const here = dirname(fileURLToPath(import.meta.url));

// A throwaway home with an optional settings.json; returns { env, done }.
const home = (settings) => {
  const dir = mkdtempSync(join(tmpdir(), "backlog-config-"));
  const claude = join(dir, ".claude");
  mkdirSync(claude);
  if (settings !== undefined) writeFileSync(join(claude, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings));
  return { dir, env: { HOME: dir }, done: () => rmSync(dir, { recursive: true, force: true }) };
};
const saved = (options, id = PLUGIN_ID) => ({ pluginConfigs: { [id]: { options } } });

test("nothing set: the defaults, from no source", () => {
  const h = home();
  try {
    const { config, problems, sources } = loadConfig({ env: h.env });
    assert.deepEqual(config, { prefix: "BL", dir: "backlog", dirSegments: ["backlog"], operatorNames: [], profile: "" });
    assert.deepEqual(problems, []);
    assert.deepEqual(Object.values(sources), ["default", "default", "default", "default"]);
  } finally {
    h.done();
  }
});

test("first match wins: a flag, then BACKLOG_*, then the hook's CLAUDE_PLUGIN_OPTION_*, then settings.json", () => {
  const h = home(saved({ backlog_prefix: "SET" }));
  try {
    const env = { ...h.env, CLAUDE_PLUGIN_OPTION_BACKLOG_PREFIX: "HOOK", BACKLOG_PREFIX: "ENV" };
    assert.deepEqual(pick(loadConfig({ flags: { prefix: "FLAG" }, env })), ["FLAG", "flag"]);
    assert.deepEqual(pick(loadConfig({ env })), ["ENV", "env"]);
    delete env.BACKLOG_PREFIX;
    assert.deepEqual(pick(loadConfig({ env })), ["HOOK", "hook"]);
    delete env.CLAUDE_PLUGIN_OPTION_BACKLOG_PREFIX;
    assert.deepEqual(pick(loadConfig({ env })), ["SET", "settings"]);
  } finally {
    h.done();
  }
});
const pick = (r) => [r.config.prefix, r.sources.prefix];

test("unset, empty and blank all fall through to the next source", () => {
  const h = home(saved({ backlog_prefix: "SET", backlog_dir: "" }));
  try {
    const env = { ...h.env, BACKLOG_PREFIX: "", CLAUDE_PLUGIN_OPTION_BACKLOG_PREFIX: "   " };
    const r = loadConfig({ flags: { prefix: "" }, env });
    assert.deepEqual(pick(r), ["SET", "settings"]);
    assert.equal(r.config.dir, "backlog");
    assert.deepEqual(r.problems, []);
  } finally {
    h.done();
  }
});

test("the prefix is 2 to 12 capital letters and not ARC or INIT; a bad one is dropped with one line and the next source applies", () => {
  const h = home(saved({ backlog_prefix: "GOOD" }));
  try {
    for (const ok of ["BL", "ALPHA", "ABCDEFGHIJKL"]) assert.equal(loadConfig({ env: { ...h.env, BACKLOG_PREFIX: ok } }).config.prefix, ok, ok);
    for (const bad of ["B", "abc", "AB1", "ABCDEFGHIJKLM", "ARC", "INIT", "A-B", "AB CD"]) {
      const r = loadConfig({ env: { ...h.env, BACKLOG_PREFIX: bad } });
      assert.equal(r.config.prefix, "GOOD", `${bad} falls through to settings.json`);
      assert.equal(r.problems.length, 1, bad);
      assert.match(r.problems[0], /^backlog_prefix: ".*" is not used \(/, bad);
    }
    const none = loadConfig({ env: { HOME: home().dir, BACKLOG_PREFIX: "x" } });
    assert.equal(none.config.prefix, "BL");
  } finally {
    h.done();
  }
});

test("the data folder is 1 to 3 plain relative segments", () => {
  const h = home();
  try {
    for (const ok of ["backlog", "docs/backlog", "a/b/c", "my.backlog_2", "x-y"]) {
      const r = loadConfig({ env: { ...h.env, BACKLOG_DIR: ok } });
      assert.equal(r.config.dir, ok, ok);
      assert.deepEqual(r.config.dirSegments, ok.split("/"));
    }
    for (const bad of ["/abs", "../x", "a/../b", "a/./b", "./a", "a/b/c/d", "with space", "a//b", "a/", "back\\slash", "ünï"]) {
      const r = loadConfig({ env: { ...h.env, BACKLOG_DIR: bad } });
      assert.equal(r.config.dir, "backlog", `${bad} falls back to the default`);
      assert.equal(r.problems.length, 1, bad);
      assert.match(r.problems[0], /^backlog_dir: /, bad);
    }
  } finally {
    h.done();
  }
});

test("operator names: ASCII, a letter first and a letter or digit last, at most 8, no duplicates", () => {
  assert.deepEqual(operatorNames("Sam, Ann-Marie ,O'Neil,Dr. Who,x").names, ["Sam", "Ann-Marie", "O'Neil", "Dr. Who", "x"]);
  assert.deepEqual(operatorNames("").names, []);
  assert.deepEqual(operatorNames(" , ,").names, []);
  assert.deepEqual(operatorNames("Sam,sam,SAM").names, ["Sam"], "a name twice, in any case, once");
  const bad = operatorNames("Sam.,'Neil,9lives,Zoë,a_b,ok");
  assert.deepEqual(bad.names, ["ok"]);
  assert.equal(bad.problems.length, 5);
  for (const p of bad.problems) assert.match(p, /^backlog_operator_names: ".*" is not used/);
  const many = operatorNames("a1,b1,c1,d1,e1,f1,g1,h1,i1,j1");
  assert.equal(many.names.length, 8);
  assert.equal(many.problems.length, 2);
  assert.match(many.problems[0], /at most 8 names/);
  assert.equal(operatorNames("A" + "b".repeat(39)).names.length, 1, "40 characters");
  assert.equal(operatorNames("A" + "b".repeat(40)).names.length, 0, "41 characters");
});

test("the names reach the config, and a bad one is a problem there too", () => {
  const h = home();
  try {
    const r = loadConfig({ env: { ...h.env, BACKLOG_OPERATOR_NAMES: "Sam, Zoë" } });
    assert.deepEqual(r.config.operatorNames, ["Sam"]);
    assert.equal(r.problems.length, 1);
  } finally {
    h.done();
  }
});

test("the profile setting must be an absolute path", () => {
  const h = home();
  try {
    assert.equal(loadConfig({ env: { ...h.env, BACKLOG_PROFILE: "/etc/backlog-profile.json" } }).config.profile, "/etc/backlog-profile.json");
    const r = loadConfig({ env: { ...h.env, BACKLOG_PROFILE: "profile.json" } });
    assert.equal(r.config.profile, "");
    assert.match(r.problems[0], /^backlog_profile: "profile.json" is not used \(must be an absolute path\)/);
  } finally {
    h.done();
  }
});

test("settings.json: CLAUDE_CONFIG_DIR, the plugin's own entry, else the one ghost-protocol@ entry; two are ambiguous", () => {
  const h = home(saved({ backlog_prefix: "OWN" }));
  const other = home(saved({ backlog_prefix: "ELSE" }, "ghost-protocol@other"));
  const both = home({ pluginConfigs: { "ghost-protocol@other": { options: { backlog_prefix: "ELSE" } }, [PLUGIN_ID]: { options: { backlog_prefix: "OWN" } } } });
  const two = home({ pluginConfigs: { "ghost-protocol@a": { options: { backlog_prefix: "AA" } }, "ghost-protocol@b": { options: { backlog_prefix: "BB" } } } });
  try {
    assert.equal(loadConfig({ env: h.env }).config.prefix, "OWN");
    assert.equal(loadConfig({ env: { HOME: "/nonexistent", CLAUDE_CONFIG_DIR: join(h.dir, ".claude") } }).config.prefix, "OWN", "CLAUDE_CONFIG_DIR");
    assert.equal(loadConfig({ env: other.env }).config.prefix, "ELSE", "the single ghost-protocol@ entry");
    const b = loadConfig({ env: both.env });
    assert.equal(b.config.prefix, "OWN", "the plugin's own entry wins over another ghost-protocol@ one");
    assert.deepEqual(b.problems, []);
    const r = loadConfig({ env: two.env });
    assert.equal(r.config.prefix, "BL", "two entries: none is used");
    assert.equal(r.problems.length, 1);
    assert.match(r.problems[0], /several ghost-protocol@ entries/);
  } finally {
    h.done();
    other.done();
    both.done();
    two.done();
  }
});

test("settings.json: a missing, broken or odd file is ignored without a throw, and only strings count", () => {
  for (const content of [undefined, "{not json", "[]", "null", '{"pluginConfigs": 5}', '{"pluginConfigs": {"ghost-protocol@ghost-protocol": 5}}']) {
    const h = home(content);
    try {
      assert.deepEqual(readPluginOptions(h.env).options, {}, String(content));
      assert.equal(loadConfig({ env: h.env }).config.prefix, "BL");
    } finally {
      h.done();
    }
  }
  const h = home(saved({ backlog_prefix: 5, backlog_dir: ["x"], backlog_operator_names: "Sam" }));
  try {
    const r = loadConfig({ env: h.env });
    assert.equal(r.config.prefix, "BL");
    assert.equal(r.config.dir, "backlog");
    assert.deepEqual(r.config.operatorNames, ["Sam"]);
  } finally {
    h.done();
  }
});

test("settings.json is only read when a setting is not found earlier", () => {
  const h = home("{not json");
  try {
    const r = loadConfig({ flags: { prefix: "AB", dir: "d", operator_names: "Sam", profile: "/p.json" }, env: h.env });
    assert.deepEqual(r.problems, []);
    assert.deepEqual(Object.values(r.sources), ["flag", "flag", "flag", "flag"]);
  } finally {
    h.done();
  }
});

test("every setting is declared in plugin.json, as a string whose default is empty", () => {
  const manifest = JSON.parse(readFileSync(join(here, "..", "..", ".claude-plugin", "plugin.json"), "utf8"));
  for (const option of ["backlog_prefix", "backlog_dir", "backlog_operator_names", "backlog_profile"]) {
    const decl = manifest.userConfig[option];
    assert.ok(decl, `${option} is declared`);
    assert.equal(decl.type, "string");
    assert.equal(decl.default, "");
    assert.ok(decl.title && decl.description, option);
  }
});
