// The profile (schema/profile.mjs): what it accepts, and every way it is refused.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkProfile, loadProfileFile, MAX_PATTERN_LENGTH, MAX_PROFILE_BYTES } from "../schema/profile.mjs";
import { table } from "../schema/record-rules.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "profile.json");

// A small valid profile, then a change to it.
const base = () => ({
  version: 1,
  types: { desk: { family: "work", statuses: ["idea", "active", "open", "decided"], sections: ["REFERENCES"], decisionStatuses: ["open", "decided"], extraMoves: { open: ["active"] }, sectionsAnyOf: [["DESCRIPTION", "CONTEXT"]] } },
  extend: { app: { statuses: ["moved"] } },
  knownKeys: ["vendor"],
  requireWhen: [{ type: "desk", field: "vendor", exceptStatuses: ["idea"] }],
  handoff: { status: "moved", field: "tracker_ref", pattern: "^[A-Z]+-\\d+$" },
  typeOrder: ["desk", "app"],
});
const refused = (mutate, expected) => {
  const p = base();
  mutate(p);
  const r = checkProfile(p);
  assert.equal(r.profile, null, JSON.stringify(p));
  assert.ok(r.problems.some((m) => m.includes(expected)), `${expected} in: ${r.problems.join(" | ")}`);
};

test("a valid profile is accepted and normalized, and the fixture profile is valid", () => {
  const r = checkProfile(base());
  assert.deepEqual(r.problems, []);
  assert.equal(r.profile.version, 1);
  assert.deepEqual(r.profile.types.desk.decisionStatuses, ["open", "decided"]);
  assert.deepEqual(checkProfile({ version: 1 }).profile, { version: 1, typeOrder: [], types: table(), extend: table(), knownKeys: [], requireWhen: [], handoff: null });
  const f = loadProfileFile(fixture);
  assert.equal(f.problem, null);
  assert.equal(f.profile.handoff.field, "tracker_ref");
});

test("the profile must be an object with version 1 and no unknown key", () => {
  for (const bad of [null, [], "x", 3]) assert.equal(checkProfile(bad).profile, null);
  refused((p) => delete p.version, "version must be 1");
  refused((p) => (p.version = 2), "version must be 1");
  refused((p) => (p.extra = 1), 'unknown key "extra"');
  refused((p) => (p.types.desk.extra = 1), 'types.desk has an unknown key "extra"');
  refused((p) => (p.handoff.extra = 1), 'handoff has an unknown key "extra"');
  refused((p) => (p.extend.app.extra = 1), 'extend.app has an unknown key "extra"');
  refused((p) => (p.requireWhen[0].extra = 1), 'requireWhen[0] has an unknown key "extra"');
});

test("types: a name, a family, statuses, and nothing that redefines a generic type", () => {
  refused((p) => (p.types.app = p.types.desk), "a generic type cannot be redefined");
  refused((p) => (p.types.Bad_Name = p.types.desk), "the name is not valid");
  refused((p) => (p.types.desk.family = "queue"), "family must be one of");
  refused((p) => (p.types.desk.statuses = []), "at least 1 entry");
  refused((p) => (p.types.desk.statuses = ["a", "a"]), 'appears twice');
  refused((p) => (p.types.desk.statuses = ["Bad Status"]), "is not valid");
  refused((p) => (p.types.desk.sections = ["lower"]), "is not valid");
  refused((p) => (p.types.desk.fields = ["bad key!"]), "is not valid");
  refused((p) => (p.types.desk = "x"), "types.desk must be an object");
  refused((p) => (p.types = []), "types must be an object");
  refused((p) => {
    p.types = {};
    for (let i = 0; i < 41; i++) p.types[`t${i}`] = { family: "work", statuses: ["idea"] };
  }, "at most 40 types");
});

test("decisionStatuses must be the type's own statuses, on a work type only", () => {
  refused((p) => (p.types.desk.decisionStatuses = ["nope"]), "which is not one of its statuses");
  refused((p) => (p.types.desk.family = "chore"), "decisionStatuses is only for a work type");
});

test("extraMoves and sectionsAnyOf", () => {
  refused((p) => (p.types.desk.extraMoves = { nope: ["active"] }), 'starts from "nope"');
  refused((p) => (p.types.desk.extraMoves = { open: ["nope"] }), 'names "nope"');
  refused((p) => (p.types.desk.extraMoves = { open: [] }), "at least 1 entry");
  refused((p) => (p.types.desk.extraMoves = []), "extraMoves must be an object");
  refused((p) => (p.types.desk.sectionsAnyOf = [["ONLY_ONE"]]), "at least 2 entry");
  refused((p) => (p.types.desk.sectionsAnyOf = "x"), "list of lists");
});

test("extend: only a generic type, only new statuses", () => {
  refused((p) => (p.extend.desk = { statuses: ["moved"] }), "only a generic type can be extended");
  refused((p) => (p.extend.app = { statuses: ["active"] }), '"active" is already a status of app');
  refused((p) => (p.extend.app = { statuses: [] }), "at least 1 entry");
  refused((p) => (p.extend.app = []), "extend.app must be an object");
  refused((p) => (p.extend = []), "extend must be an object");
});

test("knownKeys, requireWhen and typeOrder name real things", () => {
  refused((p) => (p.knownKeys = ["bad key"]), "is not valid");
  refused((p) => (p.knownKeys = "x"), "knownKeys must be a list");
  refused((p) => (p.requireWhen[0].type = "nope"), "must name a work type");
  refused((p) => (p.requireWhen[0].type = "decision"), "must name a work type");
  refused((p) => (p.requireWhen[0].type = "chore"), "must name a work type");
  refused((p) => (p.requireWhen[0].field = "bad key"), "is not a valid key name");
  refused((p) => (p.requireWhen = {}), "requireWhen must be a list");
  refused((p) => (p.requireWhen = [3]), "must be an object");
  refused((p) => (p.typeOrder = ["nope"]), 'names "nope"');
  refused((p) => (p.typeOrder = ["desk", "desk"]), "appears twice");
  assert.deepEqual(checkProfile({ ...base(), requireWhen: [{ type: "app", field: "x" }] }).profile.requireWhen, [{ type: "app", field: "x", exceptStatuses: [] }]);
});

test("handoff: a new status word, a key name, and a pattern that is short and compiles", () => {
  for (const reserved of ["completed", "cancelled", "delivered", "concluded", "decided", "retired", "paused", "active", "open"]) refused((p) => (p.handoff.status = reserved), "is already a generic status");
  refused((p) => (p.handoff.status = "Bad Status"), "handoff.status is not a valid status name");
  refused((p) => (p.handoff.field = "bad key"), "handoff.field is not a valid key name");
  refused((p) => (p.handoff.pattern = ""), "non-empty string");
  refused((p) => (p.handoff.pattern = 5), "non-empty string");
  refused((p) => (p.handoff.pattern = "("), "does not compile");
  refused((p) => (p.handoff.pattern = "a".repeat(MAX_PATTERN_LENGTH + 1)), `longer than ${MAX_PATTERN_LENGTH} characters`);
  refused((p) => (p.handoff = []), "handoff must be an object");
  assert.equal(checkProfile({ ...base(), handoff: { status: "moved", field: "f", pattern: "a".repeat(MAX_PATTERN_LENGTH) } }).problems.length, 0, "at the cap");
});

test("handoff: its status must be one that some type the profile adds, or some extend, lists", () => {
  refused((p) => (p.handoff.status = "shipped"), 'handoff.status "shipped" is a status of no type');
  refused((p) => delete p.extend, 'handoff.status "moved" is a status of no type');
  const inType = base();
  delete inType.extend;
  inType.types.desk.statuses.push("moved");
  assert.deepEqual(checkProfile(inType).problems, [], "listed by a type the profile adds");
  assert.deepEqual(checkProfile(base()).problems, [], "listed by an extend");
});

// Keys as JSON.parse makes them: `__proto__` is then an own key, as it is in a profile file.
const parsed = (mutate) => {
  const text = JSON.stringify(base());
  return checkProfile(JSON.parse(mutate(text)));
};

test("extend: a name every object inherits is not a generic type", () => {
  for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const r = parsed((t) => t.replace('"extend":{', `"extend":{"${name}":{"statuses":["parked"]},`));
    assert.equal(r.profile, null, name);
    assert.ok(r.problems.includes(`extend.${name}: only a generic type can be extended (app, infra, plugin, personal-ops, research, decision, chore)`), `${name}: ${r.problems.join(" | ")}`);
  }
});

test("types: a name every object inherits is a new type when it is a valid name, and refused as a name otherwise", () => {
  const spec = '{"family":"work","statuses":["idea","active"]}';
  const ok = parsed((t) => t.replace('"types":{', `"types":{"constructor":${spec},`));
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.profile.types.constructor.statuses, ["idea", "active"]);
  assert.deepEqual(Object.keys(ok.profile.types), ["constructor", "desk"]);
  for (const name of ["__proto__", "toString", "hasOwnProperty"]) {
    const r = parsed((t) => t.replace('"types":{', `"types":{"${name}":${spec},`));
    assert.equal(r.profile, null, name);
    assert.ok(r.problems.includes(`types.${name}: the name is not valid (lower-case letters, digits and -)`), `${name}: ${r.problems.join(" | ")}`);
  }
});

test("every problem is reported, not only the first", () => {
  const p = base();
  p.version = 3;
  p.handoff.pattern = "(";
  p.types.desk.family = "x";
  assert.ok(checkProfile(p).problems.length >= 3);
});

test("a file: unreadable, a folder, too large, not JSON and not a profile are problems, never throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "backlog-profile-"));
  try {
    const at = (name, text) => {
      const f = join(dir, name);
      writeFileSync(f, text);
      return f;
    };
    assert.match(loadProfileFile(join(dir, "missing.json")).problem, /^backlog_profile: cannot read .*missing\.json \(ENOENT\)/);
    mkdirSync(join(dir, "folder"));
    assert.match(loadProfileFile(join(dir, "folder")).problem, /is not a file/);
    assert.match(loadProfileFile(at("big.json", " ".repeat(MAX_PROFILE_BYTES + 1))).problem, /is larger than/);
    assert.match(loadProfileFile(at("bad.json", "{nope")).problem, /is not valid JSON/);
    assert.match(loadProfileFile(at("wrong.json", '{"version": 2}')).problem, /is not a valid profile: version must be 1/);
    assert.equal(loadProfileFile(at("ok.json", '{"version": 1}')).problem, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
