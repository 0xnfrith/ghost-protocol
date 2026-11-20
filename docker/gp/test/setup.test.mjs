import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const data = mkdtempSync(join(tmpdir(), "gp-setup-"));
process.env.GP_DATA = data;
const { L } = await import("../layout.mjs");
const { setup, slugOf, readJson } = await import("../setup.mjs");
const OWNER = "ab".repeat(32);
const mode = (p) => statSync(p).mode & 0o777;

test.after(() => rmSync(data, { recursive: true, force: true }));

test("slugs: lower-case letters, digits and dashes", () => {
  assert.equal(slugOf("Ada Lovelace"), "ada-lovelace");
  assert.equal(slugOf("  Zoë's agent #2 "), "zoe-s-agent-2");
  assert.equal(slugOf("!!!"), "agent");
});

test("a volume with no settings is not set up", () => {
  assert.match(setup({}), /^error not set up/);
});

test("an env file seeds the volume, and setup writes what start needs", () => {
  const env = {
    GP_RELAY_KEY: "cd".repeat(32),
    BUZZ_RELAY_URL: "wss://relay.example.com",
    BUZZ_ALLOWED_PUBKEYS: `${OWNER},${"ef".repeat(32)}`,
    BUZZ_AUTH_TAG: '["auth","x","","y"]',
    CLAUDE_CODE_OAUTH_TOKEN: "token-for-the-test",
    GP_NAME: "Ada Lovelace",
  };
  assert.equal(setup(env), "ok");
  assert.equal(mode(L.key), 0o600);
  assert.equal(mode(L.token), 0o600);
  assert.equal(readFileSync(L.tag, "utf8"), '["auth","x","","y"]\n');
  const cfg = readJson(L.config);
  assert.deepEqual([cfg.name, cfg.slug, cfg.relay_url, cfg.owner], ["Ada Lovelace", "ada-lovelace", "wss://relay.example.com", OWNER]);
  const opts = readJson(L.settings).pluginConfigs["ghost-protocol@ghost-protocol"].options;
  assert.equal(opts.unattended, "on");
  assert.equal(opts.load_proof, "off");
  assert.equal(opts.buzz_allowed_pubkeys, OWNER);
  assert.equal(opts.buzz_key_command, `cat ${L.key}`);
  assert.equal(opts.buzz_channels, "*");
  const s = readJson(L.claudeSettings);
  assert.deepEqual(s.pluginConfigs["ghost-protocol@ghost-protocol"].options, opts);
  assert.ok(s.permissions.allow.includes("mcp__plugin_ghost-protocol_buzz-channel"));
  const cj = readJson(L.claudeJson);
  assert.equal(cj.hasCompletedOnboarding, true);
  assert.equal(cj.projects[L.home].hasTrustDialogAccepted, true);
  assert.ok(existsSync(join(L.home, ".git")));
  assert.match(readFileSync(L.manifest, "utf8"), /^schema = "ghost-protocol\/instance\/v1"$/m);
  const persona = readFileSync(L.persona, "utf8");
  assert.match(persona, /^# Ada Lovelace$/m);
  assert.ok(!persona.includes("{{name}}"));
});

test("a second start keeps what the first wrote and what Claude Code added", () => {
  const cj = readJson(L.claudeJson);
  assert.equal(setup({}), "ok");
  assert.deepEqual(readJson(L.claudeJson), cj);
  assert.equal(readJson(L.config).name, "Ada Lovelace");
});
