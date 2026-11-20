/**
 * schema/profile.mjs: the profile, a JSON file that adds record types and rules to the generic ones.
 *
 * A host whose store carries more than the generic types (its own types, a status that hands a record off to
 * another tracker, a field some type needs) says so in a profile, set by the `backlog_profile` setting. A
 * profile can only ADD: it adds types, appends statuses to generic types, and switches on named rules. It
 * cannot redefine or remove a generic type, and unknown keys are refused. It holds no message text: the
 * validator's messages are the core's own, with the type, field and status filled in.
 *
 * Shape (version 1; every key but `version` is optional):
 *
 *   {
 *     "version": 1,
 *     "typeOrder": ["app", "vendor", ...],     // only orders the type list in a message; unlisted types follow
 *     "types": {
 *       "<new type>": {
 *         "family": "work" | "decision" | "chore",
 *         "statuses": ["idea", ...],           // in the order messages list them
 *         "sections": ["REFERENCES", ...],     // required, in order
 *         "sectionsAnyOf": [["DESCRIPTION", "CONTEXT"]],   // from each group, at least one is required
 *         "fields": [],                        // required non-null frontmatter fields
 *         "decisionStatuses": ["open", "decided"],   // statuses at which this work type acts as a decision
 *         "extraMoves": { "open": ["active"] } // moves beyond the family's table
 *       }
 *     },
 *     "extend": { "app": { "statuses": ["moved"] } },   // appended after a generic type's statuses
 *     "knownKeys": ["vendor"],                 // more frontmatter keys the record tool may set
 *     "requireWhen": [{ "type": "vendor", "field": "vendor", "exceptStatuses": ["idea", "draft"] }],
 *     "handoff": { "status": "moved", "field": "tracker_ref", "pattern": "^[A-Za-z][A-Za-z0-9]*-\\d+$" }
 *   }
 *
 * `handoff` turns on the rules for a record whose work went on elsewhere: the status is finished and frozen
 * (it moves nowhere, and any live work status may move to it), the pointer field is required with it, must match
 * the pattern, and is refused on any record that is not at that status (arcs and initiatives never are); the
 * record clears four fields instead of two; its ACTIVITY_LOG names the pointer.
 *
 * Pure apart from reading the one file. Depends only on ./record-rules.mjs.
 */
import { readFileSync, statSync } from "node:fs";
import { CORE_TYPES, isCoreType, table } from "./record-rules.mjs";

export const MAX_PROFILE_BYTES = 256 * 1024;
export const MAX_PATTERN_LENGTH = 200;
const MAX_TYPES = 40;
const MAX_LIST = 40;
const MAX_TEXT = 40;
const FAMILIES = ["work", "decision", "chore"];
const KEYS = ["version", "typeOrder", "types", "extend", "knownKeys", "requireWhen", "handoff"];
const TYPE_KEYS = ["family", "statuses", "sections", "sectionsAnyOf", "fields", "decisionStatuses", "extraMoves"];

// Every status the generic types use, and the finished ones: a handoff status must be a new word.
const RESERVED_STATUSES = new Set([...Object.values(CORE_TYPES).flatMap((t) => t.statuses), "delivered"]);

const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const STATUS = /^[a-z][a-z0-9_-]{0,39}$/;
const SECTION = /^[A-Z][A-Z0-9_]{0,39}$/;
const FIELD = /^[A-Za-z_][\w-]{0,39}$/;

const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const strings = (v, re, label, problems, { max = MAX_LIST, min = 0 } = {}) => {
  if (!Array.isArray(v)) {
    problems.push(`${label} must be a list`);
    return [];
  }
  if (v.length > max) problems.push(`${label} may hold at most ${max} entries`);
  if (v.length < min) problems.push(`${label} must hold at least ${min} entry`);
  const out = [];
  for (const s of v.slice(0, max)) {
    if (typeof s !== "string" || !re.test(s)) problems.push(`${label} entry ${JSON.stringify(s)} is not valid`);
    else if (out.includes(s)) problems.push(`${label} entry "${s}" appears twice`);
    else out.push(s);
  }
  return out;
};
const unknownKeys = (obj, allowed, label, problems) => {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) problems.push(`${label} has an unknown key "${k}"`);
};

/** Checks a parsed profile. Returns { profile, problems }: `profile` is the normalized profile, or null when there are problems. */
export function checkProfile(data) {
  const problems = [];
  if (!isObject(data)) return { profile: null, problems: ["the profile must be a JSON object"] };
  unknownKeys(data, KEYS, "the profile", problems);
  if (data.version !== 1) problems.push("version must be 1");

  // The tables a profile's own keys index have no prototype (record-rules.mjs `table`).
  const profile = { version: 1, typeOrder: [], types: table(), extend: table(), knownKeys: [], requireWhen: [], handoff: null };

  // types
  if (data.types !== undefined) {
    if (!isObject(data.types)) problems.push("types must be an object");
    else {
      const names = Object.keys(data.types);
      if (names.length > MAX_TYPES) problems.push(`types may hold at most ${MAX_TYPES} types`);
      for (const name of names.slice(0, MAX_TYPES)) {
        const label = `types.${name}`;
        const spec = data.types[name];
        if (!NAME.test(name)) problems.push(`${label}: the name is not valid (lower-case letters, digits and -)`);
        else if (isCoreType(name)) problems.push(`${label}: a generic type cannot be redefined (use extend to add statuses)`);
        if (!isObject(spec)) {
          problems.push(`${label} must be an object`);
          continue;
        }
        unknownKeys(spec, TYPE_KEYS, label, problems);
        if (!FAMILIES.includes(spec.family)) problems.push(`${label}.family must be one of ${FAMILIES.join(", ")}`);
        const statuses = strings(spec.statuses, STATUS, `${label}.statuses`, problems, { min: 1 });
        const sections = strings(spec.sections ?? [], SECTION, `${label}.sections`, problems);
        const fields = strings(spec.fields ?? [], FIELD, `${label}.fields`, problems);
        const decisionStatuses = strings(spec.decisionStatuses ?? [], STATUS, `${label}.decisionStatuses`, problems);
        for (const s of decisionStatuses) if (!statuses.includes(s)) problems.push(`${label}.decisionStatuses names "${s}", which is not one of its statuses`);
        if (decisionStatuses.length && spec.family !== "work") problems.push(`${label}.decisionStatuses is only for a work type`);
        const sectionsAnyOf = [];
        if (spec.sectionsAnyOf !== undefined) {
          if (!Array.isArray(spec.sectionsAnyOf)) problems.push(`${label}.sectionsAnyOf must be a list of lists`);
          else
            for (const [i, group] of spec.sectionsAnyOf.slice(0, MAX_LIST).entries()) {
              const g = strings(group, SECTION, `${label}.sectionsAnyOf[${i}]`, problems, { min: 2 });
              if (g.length) sectionsAnyOf.push(g);
            }
        }
        const extraMoves = table();
        if (spec.extraMoves !== undefined) {
          if (!isObject(spec.extraMoves)) problems.push(`${label}.extraMoves must be an object`);
          else
            for (const [from, to] of Object.entries(spec.extraMoves)) {
              if (!statuses.includes(from)) problems.push(`${label}.extraMoves starts from "${from}", which is not one of its statuses`);
              const list = strings(to, STATUS, `${label}.extraMoves.${from}`, problems, { min: 1 });
              for (const s of list) if (!statuses.includes(s)) problems.push(`${label}.extraMoves.${from} names "${s}", which is not one of its statuses`);
              extraMoves[from] = list;
            }
        }
        profile.types[name] = { family: spec.family, statuses, sections, sectionsAnyOf, fields, decisionStatuses, extraMoves };
      }
    }
  }

  // extend
  if (data.extend !== undefined) {
    if (!isObject(data.extend)) problems.push("extend must be an object");
    else
      for (const [name, ext] of Object.entries(data.extend)) {
        const label = `extend.${name}`;
        if (!isCoreType(name)) problems.push(`${label}: only a generic type can be extended (${Object.keys(CORE_TYPES).join(", ")})`);
        if (!isObject(ext)) {
          problems.push(`${label} must be an object`);
          continue;
        }
        unknownKeys(ext, ["statuses"], label, problems);
        const statuses = strings(ext.statuses, STATUS, `${label}.statuses`, problems, { min: 1 });
        for (const s of statuses) if (isCoreType(name) && CORE_TYPES[name].statuses.includes(s)) problems.push(`${label}.statuses: "${s}" is already a status of ${name}`);
        profile.extend[name] = { statuses };
      }
  }

  // knownKeys
  if (data.knownKeys !== undefined) profile.knownKeys = strings(data.knownKeys, FIELD, "knownKeys", problems);

  // handoff
  if (data.handoff !== undefined) {
    const h = data.handoff;
    if (!isObject(h)) problems.push("handoff must be an object");
    else {
      unknownKeys(h, ["status", "field", "pattern"], "handoff", problems);
      if (typeof h.status !== "string" || !STATUS.test(h.status)) problems.push("handoff.status is not a valid status name");
      else if (RESERVED_STATUSES.has(h.status)) problems.push(`handoff.status "${h.status}" is already a generic status`);
      if (typeof h.field !== "string" || !FIELD.test(h.field)) problems.push("handoff.field is not a valid key name");
      if (typeof h.pattern !== "string" || h.pattern === "") problems.push("handoff.pattern must be a non-empty string");
      else if (h.pattern.length > MAX_PATTERN_LENGTH) problems.push(`handoff.pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
      else
        try {
          new RegExp(h.pattern);
        } catch (e) {
          problems.push(`handoff.pattern does not compile (${e.message})`);
        }
      // A handoff status no type can hold would load and do nothing: some type the profile adds, or some extend,
      // must list it.
      if (typeof h.status === "string" && STATUS.test(h.status) && !RESERVED_STATUSES.has(h.status)) {
        const holders = [...Object.values(profile.types), ...Object.values(profile.extend)].filter((t) => t.statuses.includes(h.status));
        if (!holders.length) problems.push(`handoff.status "${h.status}" is a status of no type (list it in a type's statuses, or in extend)`);
      }
      if (!problems.some((p) => p.startsWith("handoff"))) profile.handoff = { status: h.status, field: h.field, pattern: h.pattern };
    }
  }

  const known = new Set([...Object.keys(CORE_TYPES), ...Object.keys(profile.types)]);
  const work = new Set([...Object.entries(CORE_TYPES), ...Object.entries(profile.types)].filter(([, t]) => t.family === "work").map(([n]) => n));

  // requireWhen
  if (data.requireWhen !== undefined) {
    if (!Array.isArray(data.requireWhen)) problems.push("requireWhen must be a list");
    else
      for (const [i, rule] of data.requireWhen.slice(0, MAX_LIST).entries()) {
        const label = `requireWhen[${i}]`;
        if (!isObject(rule)) {
          problems.push(`${label} must be an object`);
          continue;
        }
        unknownKeys(rule, ["type", "field", "exceptStatuses"], label, problems);
        if (typeof rule.type !== "string" || !work.has(rule.type)) problems.push(`${label}.type must name a work type (a generic one, or one the profile adds with family work)`);
        if (typeof rule.field !== "string" || !FIELD.test(rule.field)) problems.push(`${label}.field is not a valid key name`);
        const except = strings(rule.exceptStatuses ?? [], STATUS, `${label}.exceptStatuses`, problems);
        profile.requireWhen.push({ type: rule.type, field: rule.field, exceptStatuses: except });
      }
  }

  // typeOrder
  if (data.typeOrder !== undefined) {
    const order = strings(data.typeOrder, NAME, "typeOrder", problems, { max: MAX_TYPES + Object.keys(CORE_TYPES).length });
    for (const n of order) if (!known.has(n)) problems.push(`typeOrder names "${n}", which is not a known type`);
    profile.typeOrder = order;
  }

  return problems.length ? { profile: null, problems } : { profile, problems: [] };
}

/** Reads and checks a profile file. Returns { profile, problem }: one of them is null. Never throws. */
export function loadProfileFile(path) {
  let text;
  try {
    const st = statSync(path);
    if (!st.isFile()) return { profile: null, problem: `backlog_profile: ${path} is not a file` };
    if (st.size > MAX_PROFILE_BYTES) return { profile: null, problem: `backlog_profile: ${path} is larger than ${MAX_PROFILE_BYTES} bytes` };
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { profile: null, problem: `backlog_profile: cannot read ${path} (${e.code ?? e.message})` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { profile: null, problem: `backlog_profile: ${path} is not valid JSON (${e.message})` };
  }
  const { profile, problems } = checkProfile(data);
  if (!profile) return { profile: null, problem: `backlog_profile: ${path} is not a valid profile: ${problems.join("; ")}` };
  return { profile, problem: null };
}
