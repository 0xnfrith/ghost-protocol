// The config check, the command words, and the quoting of what reaches a VM's shell. Run: node --test test/*.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { Failure, parseCommand, remoteCommand, shellQuote, validateConfig } from "../lib.mjs";
import { cleanUp, entry, tempDir } from "./helpers.mjs";

after(cleanUp);

const refuses = (config, pattern) =>
  assert.throws(
    () => validateConfig(config),
    (error) => {
      assert.ok(error instanceof Failure, String(error));
      assert.match(error.message, pattern);
      return true;
    },
  );

test("a good config passes, with a team repo and without", () => {
  const agents = validateConfig([entry("a"), entry("b", { team_repo: null, clone: null }), entry("c", { team_repo: null })]);
  assert.deepEqual(agents.map((a) => a.name), ["a", "b", "c"]);
  assert.equal(agents[0].team_repo, "o/team");
  assert.equal(agents[1].clone, null);
});

test("the config is an array of at least one agent", () => {
  for (const config of [{}, "x", null, 5, { agents: [entry("a")] }]) refuses(config, /must be a JSON array/);
  refuses([], /no agents/);
  refuses(Array.from({ length: 201 }, (_, i) => entry(`a${i}`)), /more than 200/);
});

test("an entry is an object", () => {
  for (const bad of [null, "a", 5, [], [entry("a")]]) refuses([bad], /agent 1: must be an object/);
});

test("an unknown key stops the run, and a missing key does too", () => {
  refuses([entry("a", { extra: 1 })], /agent 1 \("a"\): unknown key "extra"/);
  refuses([entry("a"), entry("b", { Name: "x" })], /agent 2 \("b"\): unknown key "Name"/);
  refuses(JSON.parse('[{"name":"a","ssh":"a-vm","class":"c","home":"/h","team_repo":null,"clone":null,"state_dir":"/s","__proto__":{}}]'), /unknown key "__proto__"/);
  for (const key of ["name", "ssh", "class", "home", "team_repo", "clone", "state_dir"]) {
    const e = entry("a");
    delete e[key];
    refuses([e], new RegExp(`missing key "${key}"`));
  }
});

test("a bad value stops the run, and the message names the key and the agent", () => {
  const cases = {
    name: ["Upper", "-lead", "a b", "a;b", "", 5, null, "a".repeat(64), "a_b", "a/b", "a\nb"],
    ssh: ["-oProxyCommand=x", "a b", "a;b", "h$(x)", "", ".h", 5, null, "h".repeat(129), "a@b", "a'b"],
    class: ["a b", "-x", "../x", "", 5, "a/b", "a;b", "$(x)"],
    team_repo: ["a", "a/b/c", "/a/b", "a/../b", "a/b c", "a/.", "-a/b", 5, "", "a/b;c", "a/$(x)", "a/b\n"],
    home: ["relative/path", "/a/../b", "/a/./b", "//a", "/a//b", "/a/", "/", "/a b", "/a'b", "/a\nb", "/a;b", "/a$(x)", "~/x", 5, null, `/${"a".repeat(260)}`, "/a`x`"],
    state_dir: ["state", "/a/..", "/a b", "/a'b", "", null, "/a\\b"],
    clone: ["clone", "/a/../b", "/a b", "/a'b", "", null, "/a;b"],
  };
  for (const [key, values] of Object.entries(cases)) {
    for (const value of values) refuses([entry("a", { [key]: value })], new RegExp(`agent 1.*: "${key}" `));
  }
  refuses([entry("a", { team_repo: null, clone: "relative" })], /"clone"/);
  refuses([entry("a", { team_repo: null, clone: 5 })], /"clone"/);
  refuses([entry("a", { team_repo: "o/team", clone: null })], /"clone"/);
});

test("two agents with the same name, or the same ssh alias, stop the run", () => {
  refuses([entry("a"), entry("b"), entry("a", { ssh: "other-vm" })], /agent 3 \("a"\): the name "a" is used by another agent/);
  refuses([entry("a"), entry("b", { ssh: "a-vm" })], /agent 2 \("b"\): the ssh alias "a-vm" is used by another agent/);
  refuses([entry("a", { ssh: "Host-1" }), entry("b", { ssh: "host-1" })], /ssh alias "host-1" is used/);
});

test("a hostile value is shown without its control characters", () => {
  const hostile = "a\u001b[31m\nrm -rf /";
  assert.throws(
    () => validateConfig([entry("a", { home: hostile })]),
    (error) => {
      assert.doesNotMatch(error.message, /[\u0000-\u0009\u000b-\u001f]/);
      assert.doesNotMatch(error.message, /\n./);
      assert.match(error.message, /\\u001b/);
      return true;
    },
  );
  assert.throws(() => validateConfig([{ ...entry("a"), name: hostile }]), (error) => !/[\u0000-\u001f]/.test(error.message));
});

test("a long value is cut in the message", () => {
  assert.throws(() => validateConfig([entry("a", { home: `/${"a b".repeat(100)}` })]), (error) => error.message.length < 300);
});

test("commands are split into words, and no shell reads them", () => {
  assert.deepEqual(parseCommand("ssh -o BatchMode=yes  -o ConnectTimeout=10 ", "x"), ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]);
  assert.deepEqual(parseCommand("echo $(touch x);", "x"), ["echo", "$(touch", "x);"]);
  for (const empty of ["", "   ", "\n"]) assert.throws(() => parseCommand(empty, "--ssh"), /--ssh: empty command/);
});

const hostile = ["a'b", "'; touch CANARY; '", "$(touch CANARY)", "`touch CANARY`", "a b", "a\nb", "a\\b", "'", "''", "\"; touch CANARY; \"", "*", "$HOME", "a;b|c&d>e", ""];

test("shellQuote makes one word of anything, run by a real shell", () => {
  const dir = tempDir("quote");
  for (const value of hostile) {
    const out = execFileSync("sh", ["-c", `printf %s ${shellQuote(value.replace("CANARY", join(dir, "CANARY")))}`], { encoding: "utf8" });
    assert.equal(out, value.replace("CANARY", join(dir, "CANARY")));
  }
  assert.equal(existsSync(join(dir, "CANARY")), false);
});

test("remoteCommand: the script's three arguments, quoted, with an empty clone when there is no team repo", () => {
  assert.equal(remoteCommand(entry("a")), "sh -s -- '/home/a' '/home/a/s9/repos/o/team' '/home/a/.local/state/ghost-protocol/a'");
  assert.equal(remoteCommand(entry("a", { team_repo: null, clone: null })), "sh -s -- '/home/a' '' '/home/a/.local/state/ghost-protocol/a'");
  assert.equal(remoteCommand(entry("a", { team_repo: null, clone: "/home/a/clone" })), "sh -s -- '/home/a' '' '/home/a/.local/state/ghost-protocol/a'");
});

test("remoteCommand: hostile values (past the config check) still arrive as three words, run by a real shell", () => {
  const dir = tempDir("remote");
  for (const value of hostile) {
    const v = value.replace("CANARY", join(dir, "CANARY"));
    const command = remoteCommand({ home: v, clone: v, state_dir: v, team_repo: "o/team" }).replace(/^sh -s --/, "show");
    const out = execFileSync("sh", ["-c", `show() { for a in "$@"; do printf '[%s]' "$a"; done; }; ${command}`], { encoding: "utf8" });
    assert.equal(out, `[${v}][${v}][${v}]`);
  }
  assert.equal(existsSync(join(dir, "CANARY")), false);
});

test("the optional keys have defaults, so a config of the first version still loads", () => {
  const [a] = validateConfig([entry("a")]);
  assert.deepEqual([a.role, a.lead, a.root, a.plugin_dir, a.class_apply], ["other", null, null, null, true]);
  const agents = validateConfig([
    entry("boss", { role: "lead", root: "/home/boss/work", plugin_dir: "/home/boss/ghost-protocol", class_apply: false }),
    entry("b", { role: "builder", lead: "boss" }),
    entry("r", { role: "reviewer", lead: "boss", root: null, plugin_dir: null }),
    entry("x", { role: "other", lead: null }),
  ]);
  assert.deepEqual(agents.map((x) => [x.role, x.lead, x.root, x.plugin_dir, x.class_apply]), [
    ["lead", null, "/home/boss/work", "/home/boss/ghost-protocol", false],
    ["builder", "boss", null, null, true],
    ["reviewer", "boss", null, null, true],
    ["other", null, null, null, true],
  ]);
});

test("role is lead, builder, reviewer or other, and nothing else", () => {
  for (const role of ["lead", "builder", "reviewer", "other"]) assert.equal(validateConfig([entry("a", { role })])[0].role, role);
  for (const bad of ["Lead", "boss", "", 5, null, ["lead"], "lead ", "builder\n"]) refuses([entry("a", { role: bad })], /agent 1 \("a"\): "role" must be one of lead, builder, reviewer, other/);
});

test("lead is an instance name or null, names a lead in this config, and a lead has none", () => {
  const boss = entry("boss", { role: "lead" });
  for (const bad of ["Boss", "a b", "a;b", "", 5, ["boss"], "-boss", "$(x)"]) refuses([boss, entry("b", { role: "builder", lead: bad })], /agent 2 \("b"\): "lead" must be an instance name or null/);
  refuses([entry("b", { role: "builder", lead: "boss" })], /agent 1 \("b"\): "lead" names "boss", which is not an agent in this config/);
  refuses([entry("boss", { role: "builder" }), entry("b", { role: "builder", lead: "boss" })], /"lead" names "boss", whose role is not "lead"/);
  refuses([entry("boss", { role: "lead", lead: "boss" })], /agent 1 \("boss"\): a lead has no lead of its own/);
  refuses([boss, entry("other-boss", { role: "lead", lead: "boss" })], /agent 2 \("other-boss"\): a lead has no lead of its own/);
  refuses([entry("b", { role: "builder", lead: "b" })], /"lead" names "b", whose role is not "lead"/);
  assert.equal(validateConfig([boss, entry("x", { lead: "boss" })])[1].lead, "boss", "any role may name a lead; the role of the agent decides what is done to it");
});

test("root and plugin_dir are absolute paths of the same form as home, or null", () => {
  for (const key of ["root", "plugin_dir"]) {
    assert.equal(validateConfig([entry("a", { [key]: "/home/a/x" })])[0][key], "/home/a/x");
    assert.equal(validateConfig([entry("a", { [key]: null })])[0][key], null);
    for (const bad of ["relative", "/a/../b", "/a/./b", "//a", "/a//b", "/a/", "/", "/a b", "/a'b", "/a\nb", "/a;b", "/a$(x)", "~/x", 5, "", `/${"a".repeat(260)}`, "/a`x`", true, []]) {
      refuses([entry("a", { [key]: bad })], new RegExp(`agent 1 \\("a"\\): "${key}" `));
    }
  }
});

test("class_apply is true or false", () => {
  assert.equal(validateConfig([entry("a", { class_apply: true })])[0].class_apply, true);
  assert.equal(validateConfig([entry("a", { class_apply: false })])[0].class_apply, false);
  for (const bad of ["true", "false", 1, 0, null, "", "yes", [], {}]) refuses([entry("a", { class_apply: bad })], /"class_apply" must be true or false/);
});

test("a hostile value for any new key is refused, whatever shell would read it", () => {
  for (const key of ["role", "lead", "root", "plugin_dir", "class_apply"]) {
    for (const value of [...hostile, "$(touch CANARY)", "../../etc", "-oProxyCommand=x"]) {
      assert.throws(() => validateConfig([entry("boss", { role: "lead" }), entry("a", { [key]: value })]), (error) => error instanceof Failure, `${key}: ${JSON.stringify(value)}`);
    }
  }
});

test("the new keys never reach a VM: the command is the same with them all set, and hostile ones still arrive as three words", () => {
  const plain = remoteCommand(entry("a"));
  const [set] = validateConfig([entry("boss", { role: "lead", root: "/r", plugin_dir: "/p", class_apply: false }), entry("a")]);
  assert.equal(remoteCommand(set), remoteCommand(validateConfig([entry("boss")])[0]));
  assert.equal(remoteCommand(validateConfig([entry("a", { role: "builder" })])[0]), plain);
  const dir = tempDir("newkeys");
  for (const value of hostile) {
    const v = value.replace("CANARY", join(dir, "CANARY"));
    // Past the check, as the existing test does: the fields the command is built from, and the new ones beside them.
    const agent = { home: "/h", clone: "/c", state_dir: "/s", team_repo: "o/team", role: v, lead: v, root: v, plugin_dir: v, class_apply: v };
    const command = remoteCommand(agent).replace(/^sh -s --/, "show");
    for (const shell of ["sh", "bash", "dash"]) {
      let out;
      try {
        out = execFileSync(shell, ["-c", `show() { for a in "$@"; do printf '[%s]' "$a"; done; }; ${command}`], { encoding: "utf8" });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      assert.equal(out, "[/h][/c][/s]", shell);
    }
  }
  assert.equal(existsSync(join(dir, "CANARY")), false);
});
