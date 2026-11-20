// The schema's mutation check: runs the suites against broken copies of backlog/, one break each. Every copy must
// fail its suites; a break whose text is no longer in the file (not applied, or found more than once) fails this check
// too, so the list stays in step with the code.
//
// Run: node backlog/test/schema-mutants.mjs [part of a name]   (a few minutes; not part of `node --test`)
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKLOG = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(BACKLOG, "..");

// Which suites judge a break in which file.
const SUITES = {
  "schema/record-rules.mjs": ["record-rules", "gaps", "profile", "render-subitems", "validate", "golden"],
  "schema/validate.mjs": ["gaps", "validate", "golden"],
  "schema/render-subitems.mjs": ["render-subitems", "record-rules", "validate"],
  "schema/config.mjs": ["config"],
  "schema/profile.mjs": ["profile"],
  "schema/setup.mjs": ["gaps", "render-subitems", "compare-store", "validate"],
  "scripts/compare-store.mjs": ["compare-store"],
};

const RR = "schema/record-rules.mjs";
const VA = "schema/validate.mjs";
const RS = "schema/render-subitems.mjs";
const CF = "schema/config.mjs";
const PR = "schema/profile.mjs";
const CS = "scripts/compare-store.mjs";

// [name, file, exact text, replacement]
// Not listed, because no test can tell them apart: dropping the `.sort()` after readdirSync (node's own listing is already in
// name order, so it only pins the order against a locale), and a bad value kept as it is (every check returns its input), and a pattern for any capital-letter prefix (the id's prefix is then looked up in the table of
// prefixes, and an unknown one is not a record either way).
// Nor the id-kind table as an ordinary object, nor a profile's own `extraMoves` table: the id pattern admits only the
// prefix, ARC and INIT, and createRules rebuilds every profile type's moves into a table of its own.
const MUTANTS = [
  // the finished set and the fields a finished record clears
  ["finished set drops delivered", RR, 'const CORE_TERMINAL = ["completed", "concluded", "delivered", "cancelled", "decided", "retired"];', 'const CORE_TERMINAL = ["completed", "concluded", "cancelled", "decided", "retired"];'],
  ["finished set drops retired", RR, '"cancelled", "decided", "retired"];', '"cancelled", "decided"];'],
  ["finished set drops decided", RR, '"delivered", "cancelled", "decided", "retired"];', '"delivered", "cancelled", "retired"];'],
  ["finished set drops completed", RR, 'const CORE_TERMINAL = ["completed", ', 'const CORE_TERMINAL = ['],
  ["a finished record clears one field only", RR, 'export const TERMINAL_CLEARS = ["next_action", "waiting_on"];', 'export const TERMINAL_CLEARS = ["next_action"];'],
  ["a handed-off record clears two fields only", RR, 'export const HANDOFF_NULL_FIELDS = ["next_action", "waiting_on", "blocked_on", "waiting_since"];', 'export const HANDOFF_NULL_FIELDS = ["next_action", "waiting_on"];'],
  ["a handed-off record is not held to its four fields", RR, 'if (handoff && status === handoff.status) return HANDOFF_NULL_FIELDS;', ''],
  ["the handoff status is not finished", RR, 'if (handoff) terminal.add(handoff.status);', ''],
  ["a finished record is judged live", RR, 'return isTerminal(status) ? TERMINAL_CLEARS : [];', 'return [];'],

  // each row of the legal moves
  ["work idea may not be cancelled", RR, 'idea: ["draft", "scoped", "active", "cancelled"],', 'idea: ["draft", "scoped", "active"],'],
  ["work idea may park", RR, 'idea: ["draft", "scoped", "active", "cancelled"],', 'idea: ["draft", "scoped", "active", "cancelled", "deferred"],'],
  ["work draft may not demote to idea", RR, 'draft: ["idea", "scoped", "active", "blocked", "deferred", "completed", "concluded", "delivered", "cancelled"],', 'draft: ["scoped", "active", "blocked", "deferred", "completed", "concluded", "delivered", "cancelled"],'],
  ["work scoped may not go back to draft", RR, 'scoped: ["draft", "active", "blocked",', 'scoped: ["active", "blocked",'],
  ["work active may not be blocked", RR, 'active: ["draft", "scoped", "blocked", "deferred",', 'active: ["draft", "scoped", "deferred",'],
  ["work blocked may not resume", RR, 'blocked: ["draft", "scoped", "active", "deferred",', 'blocked: ["draft", "scoped", "deferred",'],
  ["work deferred may not resume", RR, 'deferred: ["draft", "scoped", "active", "blocked",', 'deferred: ["draft", "scoped", "blocked",'],
  ["work completed may not reopen to draft", RR, 'completed: ["draft", "concluded", "delivered", "cancelled"],', 'completed: ["concluded", "delivered", "cancelled"],'],
  ["work concluded may not reopen to draft", RR, 'concluded: ["draft", "completed", "delivered", "cancelled"],', 'concluded: ["completed", "delivered", "cancelled"],'],
  ["work delivered may not reopen to draft", RR, 'delivered: ["draft", "completed", "concluded", "cancelled"],', 'delivered: ["completed", "concluded", "cancelled"],'],
  ["work cancelled may not reopen to draft", RR, 'cancelled: ["draft", "completed", "concluded", "delivered"],', 'cancelled: ["completed", "concluded", "delivered"],'],
  ["a finished work record may reopen to active", RR, 'completed: ["draft", "concluded", "delivered", "cancelled"],', 'completed: ["draft", "active", "concluded", "delivered", "cancelled"],'],
  ["decision open may not be decided", RR, 'open: ["decided", "cancelled"],', 'open: ["cancelled"],'],
  ["decision decided may not reopen", RR, 'decided: ["open", "cancelled"],', 'decided: ["cancelled"],'],
  ["decision cancelled may not reopen", RR, 'cancelled: ["open", "decided"],', 'cancelled: ["decided"],'],
  ["chore active may not pause", RR, 'active: ["paused", "retired"],', 'active: ["retired"],'],
  ["chore paused may not resume", RR, 'paused: ["active", "retired"],', 'paused: ["retired"],'],
  ["chore retired may not resume", RR, 'retired: ["active", "paused"],', 'retired: ["paused"],'],
  ["a handoff is not a legal move from live work", RR, 'for (const from of LIVE_WORK) moves.work[from].push(handoff.status);', ''],
  ["a handoff is not a legal move from an open decision", RR, 'moves.decision.open.push(handoff.status);', ''],
  ["a handed-off work record may move on", RR, 'moves.work[handoff.status] = [];', ''],
  ["a handed-off decision may move on", RR, 'moves.decision[handoff.status] = [];', ''],
  ["extra moves ignored", RR, 'const extra = spec.extraMoves[from] ?? [];', 'const extra = [];'],
  ["a move to a status the type lacks is legal", RR, '.filter((to) => spec.statuses.includes(to));', ';'],
  ["a move from a status the type lacks is judged", RR, 'if (!spec || !spec.statuses.includes(from)) return [];', 'if (!spec) return [];'],
  ["no move is a move", RR, 'if (!type || !from || !to || from === to) return null;', 'if (!type || !from || !to) return null;'],
  ["an unknown target status is judged", RR, 'if (!spec || !spec.statuses.includes(from) || !spec.statuses.includes(to)) return null;', 'if (!spec) return null;'],
  ["the frozen text is not used", RR, 'if (handoff && from === handoff.status) return', 'if (false) return'],
  ["a final status is not said to be final", RR, ': `\\`${from}\\` is final for a record of type \\`${type}\\``;', ': "";'],

  // families and types
  ["the type table inherits from Object", RR, "const types = table(typeNames.map", "const types = Object.fromEntries(typeNames.map"],
  ["the status table inherits from Object", RR, "const itemStatuses = table(", "const itemStatuses = Object.fromEntries("],
  ["the move tables inherit from Object", RR, 'const moves = table([["work", table()], ["decision", table()], ["chore", table()]]);', "const moves = { work: {}, decision: {}, chore: {} };"],
  ["a profile type's extra moves inherit from Object", RR, "extraMoves: table(Object.entries(spec.extraMoves)", "extraMoves: Object.fromEntries(Object.entries(spec.extraMoves)"],
  ["a generic type is any name CORE_TYPES answers to", RR, "Object.hasOwn(CORE_TYPES, name)", "name in CORE_TYPES"],
  ["a table is an ordinary object", RR, "const t = Object.create(null);", "const t = {};"],
  ["a decision status does not make a decision", RR, 'spec.family === "decision" || (!!status && spec.decisionStatuses.includes(status))', 'spec.family === "decision"'],
  ["every status makes a decision", RR, '(!!status && spec.decisionStatuses.includes(status))', '(!!status && spec.decisionStatuses.length > 0)'],
  ["an unknown type is not work", RR, 'if (!spec) return "work";', 'if (!spec) return "chore";'],
  ["work types include the decision family", RR, 'typeNames.filter((n) => types[n].family === "work")', 'typeNames.filter((n) => types[n].family !== "chore")'],
  ["typeOrder ignored", RR, 'const typeNames = [...listed, ...Object.keys(specs).filter((n) => !listed.includes(n))];', 'const typeNames = Object.keys(specs);'],
  ["extended statuses come first", RR, 'specs[name].statuses.push(...ext.statuses)', 'specs[name].statuses.unshift(...ext.statuses)'],
  ["a profile type's sections are dropped", RR, 'sections: [...spec.sections],\n        sectionsAnyOf', 'sections: [],\n        sectionsAnyOf'],
  ["the handoff field is not a known key", RR, '...(handoff ? [handoff.field] : [])', ''],
  ["the family statuses keep decision statuses in work", RR, 'work: union([...workTypes].map((t) => types[t].statuses), allDecisionStatuses),', 'work: union([...workTypes].map((t) => types[t].statuses)),'],

  // who holds the ball
  ["the operator's names are case sensitive", RR, '`^(${alternatives})$`, "i")', '`^(${alternatives})$`)'],
  ["a waiting party is case sensitive", RR, '`^(${alternatives})\\\\b(?!\\\\s*#)`, "i")', '`^(${alternatives})\\\\b(?!\\\\s*#)`)'],
  ["a name may run into the next word", RR, '`^(${alternatives})\\\\b(?!\\\\s*#)`', '`^(${alternatives})(?!\\\\s*#)`'],
  ["an agent named Operator #N is the operator", RR, '`^(${alternatives})\\\\b(?!\\\\s*#)`', '`^(${alternatives})\\\\b`'],
  ["names are not escaped", RR, '.map(escapeRegExp).join("|")', '.join("|")'],
  ["the word operator is not always a name", RR, '[OPERATOR, ...operatorNames]', '[...operatorNames]'],
  ["an owner is not trimmed", RR, 'operatorExact.test(s.trim())', 'operatorExact.test(s)'],
  ["a waiting party is not trimmed", RR, 'operatorLead.test(s.trim())', 'operatorLead.test(s)'],
  ["an absent owner is not the operator", RR, 'isNull(r.owner) ? OPERATOR : r.owner', 'isNull(r.owner) ? "nobody" : r.owner'],
  ["blocked_on is read before waiting_on", RR, '(!isNull(r.waiting_on) ? r.waiting_on : !isNull(r.blocked_on) ? r.blocked_on : null)', '(!isNull(r.blocked_on) ? r.blocked_on : !isNull(r.waiting_on) ? r.waiting_on : null)'],
  ["a record waits on the operator by blocked_on first", RR, '(!isNull(r.waiting_on) ? namesOperator(r.waiting_on) : namesOperator(r.blocked_on))', '(!isNull(r.blocked_on) ? namesOperator(r.blocked_on) : namesOperator(r.waiting_on))'],
  ["a record is waiting only when blocked", RR, 'r.status === "blocked" || !isNull(r.waiting_on)', 'r.status === "blocked"'],
  ["a stray waiting_since is not reported", RR, 'if (!isNull(r.waiting_since) && !isWaiting(r) &&', 'if (false && !isNull(r.waiting_since) && !isWaiting(r) &&'],
  ["a handed-off record's waiting_since is reported twice", RR, ' && !finishedClears(r.status).includes("waiting_since"))', ')'],
  ["tilde is not empty", RR, ' || v === "~" ||', ' ||'],
  ["the word null is not empty", RR, ' || v === "null" ||', ' ||'],
  ["a quoted empty string is not empty", RR, ' || v === \'""\' ||', ' ||'],
  ["a single-quoted empty string is not empty", RR, ' || v === "\'\'"', ''],

  // the verdict
  ["the frontmatter inherits from Object", VA, "const fm = table();", "const fm = {};"],
  ["a sessions/ folder outside the data folder is not a record folder", VA, 'const RECORD_DIRS = new Set(["items", "arcs", "initiatives", "sessions"]);', 'const RECORD_DIRS = new Set(["items", "arcs", "initiatives"]);'],
  ["a block exits 1", VA, 'return { code: 2, lines };', 'return { code: 1, lines };'],
  ["a warning exits 2", VA, 'return { code: 1, lines }; // not 2', 'return { code: 2, lines }; // not 2'],
  ["a warning exits 0", VA, 'return { code: 1, lines }; // not 2', 'return { code: 0, lines }; // not 2'],
  ["the warning line says warnings for one", VA, 'warnings.length === 1 ? "a non-blocking warning" : "non-blocking warnings"', 'warnings.length === 1 ? "non-blocking warnings" : "a non-blocking warning"'],
  ["the warning line is reworded", VA, 'is valid, with ${warnings.length === 1', 'is valid with ${warnings.length === 1'],
  ["the block line is reworded", VA, 'does not match the backlog schema', 'does not match the schema'],
  ["no blank line before the fix line", VA, 'lines.push("");\n    lines.push("Fix the record', 'lines.push("Fix the record'],
  ["a block drops its warnings", VA, 'for (const w of warnings) lines.push(`  - (warning) ${w}`);', ''],
  ["a bad setting blocks", VA, 'for (const p of problems) warnings.push(p);', 'for (const p of problems) errors.push(p);'],
  ["a bad setting is dropped", VA, 'for (const p of problems) warnings.push(p);', ''],
  ["a bad profile blocks", VA, 'if (profileProblem) return { code: 1,', 'if (profileProblem) return { code: 2,'],
  ["a bad profile is ignored", VA, 'if (profileProblem) return { code: 1,', 'if (false) return { code: 1,'],
  ["a bad profile skips the warning header", VA, '`⚠ ${basename(file)} is valid, with a non-blocking warning:`, `  - ${profileProblem}', '`${basename(file)}:`, `  - ${profileProblem}'],
  ["a file outside the data folder is not judged by its id", VA, 'inferred = true;\n    } else if ("start_ts" in fm', 'inferred = false;\n    } else if ("start_ts" in fm'],
  ["the data folder is matched as a substring", VA, 'const underDataDir = hasSegments(dirname(file).split(/[\\\\/]/), config.dirSegments);', 'const underDataDir = dirname(file).includes(config.dir);'],
  ["the data folder needs only one of its segments", VA, 'segments.every((s, j) => parts[i + j] === s)', 'segments.some((s, j) => parts[i + j] === s)'],
  ["the prefix is not anchored", VA, '`^(${config.prefix}|ARC|INIT)-', '`(${config.prefix}|ARC|INIT)-'],
  ["a provisional id is not an id", VA, '(\\\\d+|tmp-[0-9A-Fa-f]+)', '(\\\\d+)'],
  ["the inbox is judged", VA, '["inbox.md", "CLAUDE.md", "README.md"]', '["CLAUDE.md", "README.md"]'],
  ["the status move is judged for an inferred record", VA, 'if (!inferred) {\n      const before = headStatus(file);', 'if (true) {\n      const before = headStatus(file);'],
  ["a long next_action is not a warning", VA, 'fm.next_action.length > naLimit', 'fm.next_action.length > 10 * naLimit'],
  ["the next_action limit is 301", VA, 'const NEXT_ACTION_WARN_CHARS = 300;', 'const NEXT_ACTION_WARN_CHARS = 301;'],
  ["the legacy next_action limit is 300", VA, 'const NEXT_ACTION_WARN_CHARS_LEGACY = 600;', 'const NEXT_ACTION_WARN_CHARS_LEGACY = 300;'],
  ["a cadence is any word", VA, '!CADENCE_RE.test(fm.cadence)', 'false'],
  ["a wake_when needs no review_after", VA, '!isNull(fm.wake_when) && isNull(fm.review_after)', 'false'],
  ["a dangling parent is a block", VA, 'warnings.push(`\\`parent: ${fm.parent}\\` points at', 'errors.push(`\\`parent: ${fm.parent}\\` points at'],
  ["a stale sub-item block is a block", VA, 'warnings.push(`\\`## SUB_ITEMS\\` is a generated projection', 'errors.push(`\\`## SUB_ITEMS\\` is a generated projection'],
  ["a stale parent block is not reported", VA, 'if (pRaw && hasSubItemsSection(pRaw) &&', 'if (false && pRaw && hasSubItemsSection(pRaw) &&'],
  ["a duplicate id is a block", VA, 'warnings.push(`\\`id: ${fm.id}\\` is also carried by', 'errors.push(`\\`id: ${fm.id}\\` is also carried by'],
  ["a handoff pointer is not checked on arcs", VA, '    checkRecordings();\n    checkHandoffField();\n  } else if (kind === "initiatives")', '    checkRecordings();\n  } else if (kind === "initiatives")'],
  ["a handoff pointer is not checked on initiatives", VA, '    requireSections(INITIATIVE.sections);\n    checkHandoffField();', '    requireSections(INITIATIVE.sections);'],
  ["a handoff pointer is not checked on items", VA, '    checkHandoffField();\n    // The finished set', '    // The finished set'],
  ["a pointer's shape is not checked", VA, '!h.pattern.test(fm[h.field].replace(/^["\']|["\']$/g, ""))', 'false'],
  ["a handoff log line need not name the pointer", VA, 'h.pattern.test(id) && !namesIssue(activityLog(raw), id)', 'false'],
  ["a pointer's number may run on", VA, '(?![0-9])`, "i")', '`, "i")'],
  ["a session needs no start_ts", VA, 'requireFields(["date", "cwd", "start_ts"]);', 'requireFields(["date", "cwd"]);'],

  // sub-items
  ["the end sentinel is reworded", RS, 'export const END = "<!-- /nf-backlog:sub-items -->";', 'export const END = "<!-- /nf-backlog:subitems -->";'],
  ["the begin sentinel is reworded", RS, 'BEGIN_RE = /<!--\\s*nf-backlog:sub-items\\b', 'BEGIN_RE = /<!--\\s*nf-backlog:subitems\\b'],
  ["the begin note is reworded", RS, '<!-- nf-backlog:sub-items GENERATED —', '<!-- nf-backlog:sub-items generated —'],
  ["the empty text is reworded", RS, '"_No sub-items._"', '"No sub-items."'],
  ["the ticks are swapped", RS, 'closed.has(k.status) ? "x" : " "', 'closed.has(k.status) ? " " : "x"'],
  ["sub-items are not sorted", RS, 'kids.sort((a, b) => idNum(a.id) - idNum(b.id) || a.id.localeCompare(b.id));', ''],
  ["sub-items sort by name", RS, 'idNum(a.id) - idNum(b.id) || a.id.localeCompare(b.id)', 'a.id.localeCompare(b.id)'],
  ["a section is not inserted before the log", RS, 'return raw.slice(0, log.index) + block + "\\n\\n" + raw.slice(log.index);', 'return raw.replace(/\\s*$/, "") + "\\n\\n" + block + "\\n";'],
  ["--all adds a section to every parent", RS, 'if (!hasSubItemsSection(raw)) continue; // refresh-existing-only: never blanket-add', ''],
  ["a current section is rewritten", RS, 'return norm(next) === norm(raw) ? raw : next;', 'return next;'],
  ["the default folder is fixed", RS, 'const defaultItems = join(...config.dirSegments, "items");', 'const defaultItems = join("backlog", "items");'],

  // the settings
  ["a prefix of one letter is allowed", CF, '/^[A-Z]{2,12}$/', '/^[A-Z]{1,12}$/'],
  ["a prefix of thirteen letters is allowed", CF, '/^[A-Z]{2,12}$/', '/^[A-Z]{2,13}$/'],
  ["a lower-case prefix is allowed", CF, '/^[A-Z]{2,12}$/', '/^[A-Za-z]{2,12}$/'],
  ["a prefix may hold digits", CF, '/^[A-Z]{2,12}$/', '/^[A-Z0-9]{2,12}$/'],
  ["a reserved prefix is allowed", CF, 'if (RESERVED_PREFIXES.includes(v))', 'if (false)'],
  ["a dot-dot segment is allowed", CF, 'if (s === "." || s === "..") throw', 'if (false) throw'],
  ["a dot segment is allowed", CF, 'if (s === "." || s === "..")', 'if (s === "..")'],
  ["four segments are allowed", CF, 'if (segments.length > 3)', 'if (segments.length > 4)'],
  ["a segment may hold any character", CF, 'if (!SEGMENT_RE.test(s)) throw', 'if (false) throw'],
  ["nine operator names are allowed", CF, 'export const MAX_OPERATOR_NAMES = 8;', 'export const MAX_OPERATOR_NAMES = 9;'],
  ["a name may end in a dot", CF, '[A-Za-z0-9 .\'-]{0,38}[A-Za-z0-9])?$/', '[A-Za-z0-9 .\'-]{0,39})?$/'],
  ["a name may start with a digit", CF, "const NAME_RE = /^[A-Za-z]", "const NAME_RE = /^[A-Za-z0-9]"],
  ["a name may be 41 characters", CF, "{0,38}[A-Za-z0-9])?$/", "{0,39}[A-Za-z0-9])?$/"],
  ["a name twice is kept twice", CF, '!names.some((n) => n.toLowerCase() === name.toLowerCase())', 'true'],
  ["the environment wins over a flag", CF, '["flag", () => nonEmpty(flags[name])],\n      ["env", () => nonEmpty(env[`BACKLOG_${upper}`])],', '["env", () => nonEmpty(env[`BACKLOG_${upper}`])],\n      ["flag", () => nonEmpty(flags[name])],'],
  ["settings.json wins over the hook's variable", CF, '["hook", () => nonEmpty(env[`CLAUDE_PLUGIN_OPTION_BACKLOG_${upper}`])],\n      ["settings", () => nonEmpty(lazySaved()[setting.option])],', '["settings", () => nonEmpty(lazySaved()[setting.option])],\n      ["hook", () => nonEmpty(env[`CLAUDE_PLUGIN_OPTION_BACKLOG_${upper}`])],'],
  ["the hook's variable has another name", CF, '`CLAUDE_PLUGIN_OPTION_BACKLOG_${upper}`', '`CLAUDE_PLUGIN_OPTION_${upper}`'],
  ["a blank value is a value", CF, 'typeof v === "string" && v.trim() !== "" ? v.trim() : null', 'typeof v === "string" && v !== "" ? v : null'],
  ["a bad value stops the search", CF, '        problems.push(`${setting.option}: "${v}" is not used (${e.message})`);\n        continue;', '        problems.push(`${setting.option}: "${v}" is not used (${e.message})`);\n        break;'],
  ["a bad value is not reported", CF, '        problems.push(`${setting.option}: "${v}" is not used (${e.message})`);\n        continue;', '        continue;'],
  ["two plugin entries are not ambiguous", CF, 'if (keys.length > 1) return', 'if (keys.length > 2) return'],
  ["the single other entry is not used", CF, 'if (keys.length === 1) entry = configs[keys[0]];', ''],
  ["CLAUDE_CONFIG_DIR is ignored", CF, 'env.CLAUDE_CONFIG_DIR || join(', 'join('],
  ["a relative profile is accepted", CF, 'if (!isAbsolute(v)) throw', 'if (false) throw'],
  ["settings.json is always read", CF, 'let saved = null;', 'let saved = readPluginOptions(env);'],
  ["the plugin id is another", CF, 'export const PLUGIN_ID = "ghost-protocol@ghost-protocol";', 'export const PLUGIN_ID = "ghost-protocol@elsewhere";'],

  // the profile
  ["a new type named like an inherited key is a generic one", PR, "else if (isCoreType(name)) problems.push", "else if (CORE_TYPES[name]) problems.push"],
  ["extend takes a name like an inherited key for a generic type", PR, "if (!isCoreType(name)) problems.push", "if (!CORE_TYPES[name]) problems.push"],
  ["extend's statuses are checked against an inherited key", PR, "if (isCoreType(name) && CORE_TYPES[name].statuses.includes(s))", "if (CORE_TYPES[name]?.statuses.includes(s))"],
  ["the profile's tables inherit from Object", PR, "types: table(), extend: table(),", "types: {}, extend: {},"],
  ["a handoff status no type lists is accepted", PR, "if (!holders.length) problems.push", "if (false) problems.push"],
  ["a handoff status listed only by an extend is refused", PR, "...Object.values(profile.types), ...Object.values(profile.extend)]", "...Object.values(profile.types)]"],
  ["a handoff status listed only by an added type is refused", PR, "[...Object.values(profile.types), ...Object.values(profile.extend)]", "[...Object.values(profile.extend)]"],
  ["the version is not checked", PR, 'if (data.version !== 1)', 'if (false)'],
  ["an unknown top-level key is accepted", PR, 'unknownKeys(data, KEYS, "the profile", problems);', ''],
  ["an unknown type key is accepted", PR, 'unknownKeys(spec, TYPE_KEYS, label, problems);', ''],
  ["an unknown handoff key is accepted", PR, 'unknownKeys(h, ["status", "field", "pattern"], "handoff", problems);', ''],
  ["a generic type may be redefined", PR, 'else if (isCoreType(name)) problems.push', 'else if (false) problems.push'],
  ["a family is not checked", PR, 'if (!FAMILIES.includes(spec.family))', 'if (false)'],
  ["a type may have no statuses", PR, '{ min: 1 });\n        const sections', '{ min: 0 });\n        const sections'],
  ["decision statuses may be foreign", PR, 'if (!statuses.includes(s)) problems.push(`${label}.decisionStatuses names', 'if (false) problems.push(`${label}.decisionStatuses names'],
  ["decision statuses on a chore", PR, 'if (decisionStatuses.length && spec.family !== "work")', 'if (false)'],
  ["a section group of one", PR, "{ min: 2 });\n              if (g.length)", "{ min: 1 });\n              if (g.length)"],
  ["an extra move may start from a foreign status", PR, 'if (!statuses.includes(from)) problems.push(`${label}.extraMoves starts from', 'if (false) problems.push(`${label}.extraMoves starts from'],
  ["an extra move may go to a foreign status", PR, 'if (!statuses.includes(s)) problems.push(`${label}.extraMoves.${from} names', 'if (false) problems.push(`${label}.extraMoves.${from} names'],
  ["a profile type may be extended", PR, 'if (!isCoreType(name)) problems.push(`${label}: only a generic type can be extended', 'if (false) problems.push(`${label}: only a generic type can be extended'],
  ["an existing status may be appended", PR, 'if (isCoreType(name) && CORE_TYPES[name].statuses.includes(s)) problems.push', 'if (false) problems.push'],
  ["a handoff status may be a generic one", PR, 'else if (RESERVED_STATUSES.has(h.status)) problems.push', 'else if (false) problems.push'],
  ["delivered may be the handoff status", PR, '...Object.values(CORE_TYPES).flatMap((t) => t.statuses), "delivered"]', '...Object.values(CORE_TYPES).flatMap((t) => t.statuses)]'],
  ["a handoff pattern need not compile", PR, '          new RegExp(h.pattern);', '          void 0;'],
  ["a handoff pattern may be long", PR, 'else if (h.pattern.length > MAX_PATTERN_LENGTH)', 'else if (false)'],
  ["the pattern cap is off by one", PR, 'h.pattern.length > MAX_PATTERN_LENGTH', 'h.pattern.length >= MAX_PATTERN_LENGTH'],
  ["a handoff field is not checked", PR, 'if (typeof h.field !== "string" || !FIELD.test(h.field))', 'if (false)'],
  ["a requireWhen may name a decision type", PR, '!work.has(rule.type)', '!known.has(rule.type)'],
  ["a typeOrder may name an unknown type", PR, 'if (!known.has(n)) problems.push(`typeOrder names', 'if (false) problems.push(`typeOrder names'],
  ["a profile larger than the cap is read", PR, 'if (st.size > MAX_PROFILE_BYTES) return', 'if (false) return'],
  ["a profile folder is read", PR, 'if (!st.isFile()) return', 'if (false) return'],
  ["a bad profile is returned anyway", PR, 'return problems.length ? { profile: null, problems } : { profile, problems: [] };', 'return { profile, problems };'],

  // the command lines
  ["a relative --profile is not resolved", "schema/setup.mjs", 'resolve(argv[i])', 'argv[i]'],
  ["--dir is ignored", "schema/setup.mjs", 'else if (a === "--dir") flags.dir = argv[++i];', 'else if (a === "--dir") ++i;'],
  ["--prefix is ignored", "schema/setup.mjs", 'if (a === "--prefix") flags.prefix = argv[++i];', 'if (a === "--prefix") ++i;'],
  ["--operator-names is ignored", "schema/setup.mjs", 'flags.operator_names = argv[++i];', '++i;'],
  ["a bad profile is not reported", "schema/setup.mjs", 'if (config.profile) ({ profile, problem: profileProblem } = loadProfileFile(config.profile));', 'if (config.profile) ({ profile } = loadProfileFile(config.profile));'],

  // compare-store
  ["the error counts are not compared", CS, 'a.code === b.code && a.errors === b.errors && a.warnings === b.warnings', 'a.code === b.code && a.warnings === b.warnings'],
  ["the warning counts are not compared", CS, 'a.code === b.code && a.errors === b.errors && a.warnings === b.warnings', 'a.code === b.code && a.errors === b.errors'],
  ["the exit codes are not compared", CS, 'a.code === b.code && a.errors === b.errors && a.warnings === b.warnings', 'a.errors === b.errors && a.warnings === b.warnings'],
  ["a verdict difference does not fail", CS, 'return verdictDiffs > 0 || (strict && textDiffs > 0) ? 1 : 0;', 'return strict && textDiffs > 0 ? 1 : 0;'],
  ["--strict does not fail a text difference", CS, 'return verdictDiffs > 0 || (strict && textDiffs > 0) ? 1 : 0;', 'return verdictDiffs > 0 ? 1 : 0;'],
  ["a text difference always fails", CS, 'return verdictDiffs > 0 || (strict && textDiffs > 0) ? 1 : 0;', 'return verdictDiffs > 0 || textDiffs > 0 ? 1 : 0;'],
  ["text differences are not told apart from none", CS, '} else if (oldText !== newText) {', '} else if (false) {'],
  ["a killed old validator passes", CS, 'if (run.error || run.signal) {', 'if (run.error) {'],
  ["a missing old validator passes", CS, 'if (run.error || run.signal) {', 'if (run.signal) {'],
  ["an empty store passes", CS, 'if (files.length === 0) {', 'if (false) {'],
  ["a block is read as a warning", CS, 'const block = lines[0]?.startsWith("✗");', 'const block = false;'],
  ["warnings inside a block count as errors", CS, 'if (block && !m[1]) errors++;', 'if (block) errors++;'],
  ["--old-via is ignored", CS, 'spawnSync(command, via ? [old, file] : [file]', 'spawnSync(old, [file]'],
  ["only items are compared", CS, 'const RECORD_FOLDERS = ["items", "arcs", "initiatives", "sessions"];', 'const RECORD_FOLDERS = ["items"];'],
];

const filter = process.argv[2] ?? "";
const only = MUTANTS.filter(([name]) => name.includes(filter));

// One suite file at a time, the quick ones first, until one fails: most breaks die in the first.
const runSuite = (dir, suite) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ["--test", "--test-concurrency=1", `backlog/test/${suite}.test.mjs`], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });

const run = async (mutant) => {
  const [name, file, from, to] = mutant;
  const dir = mkdtempSync(join(tmpdir(), "backlog-mutant-"));
  try {
    mkdirSync(join(dir, ".claude-plugin"));
    cpSync(join(REPO, ".claude-plugin", "plugin.json"), join(dir, ".claude-plugin", "plugin.json"));
    cpSync(BACKLOG, join(dir, "backlog"), { recursive: true });
    const path = join(dir, "backlog", file);
    const text = readFileSync(path, "utf8");
    const count = text.split(from).length - 1;
    if (count !== 1) return { name, status: "NOT APPLIED", detail: `${JSON.stringify(from.slice(0, 70))} is in ${file} ${count} times` };
    writeFileSync(path, text.replace(from, () => to));
    for (const suite of SUITES[file] ?? []) {
      const { code, out } = await runSuite(dir, suite);
      if (code !== 0) return { name, status: "killed", detail: `${suite}: ${(out.match(/^✖ .*$/m) ?? [""])[0].slice(0, 90)}` };
    }
    return { name, status: "SURVIVED", detail: "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const results = [];
let next = 0;
const worker = async () => {
  while (next < only.length) {
    const mutant = only[next++];
    const r = await run(mutant);
    results.push(r);
    console.log(`${r.status.padEnd(11)} ${r.name}  ${r.detail}`);
  }
};
await Promise.all(Array.from({ length: Math.min(2, only.length) }, worker));
const bad = results.filter((r) => r.status !== "killed");
console.log(`\n${results.length} mutants, ${results.length - bad.length} killed, ${bad.length} not`);
process.exitCode = bad.length ? 1 : 0;
