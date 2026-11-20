/**
 * schema/validate.mjs: the backlog schema checker.
 *
 * Called by the plugin's PostToolUse and Stop hooks, and by CI:
 *   validate [settings flags] <absolute path to the changed markdown record>
 *
 *   exit 0  -> valid (silent)
 *   exit 2  -> invalid: BLOCK; the message printed on stderr is shown to Claude, which then fixes the record
 *   other   -> invalid: WARN (non-blocking)
 *
 * A setting that is wrong (see ./config.mjs) or a profile that cannot be read is never the record's fault, so
 * it only adds a non-blocking line; a profile that cannot be read means the record is not judged at all.
 *
 * This mirrors schema/schema.md: change them together, in one commit.
 * The status values, the finished set, the legal moves and the wait rules are defined once, in
 * ./record-rules.mjs; this checker holds no copy of its own.
 */
import { readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { hasSubItemsSection, extractBody, renderBody, norm } from "./render-subitems.mjs";
import { isNull, table } from "./record-rules.mjs";
import { setup } from "./setup.mjs";

// ── Schema: mirrors schema/schema.md ───────────────────────────────────────────
// The type table (statuses, sections, fields) is rules.types: the generic types plus a profile's.
// Advisory threshold: a `next_action` longer than this is a desk-dump, not one physical action. WARN, never block.
// Tiered so untouched older records stay quiet: a record that carries `owner` is held to 300; a legacy record
// without it to 600.
const NEXT_ACTION_WARN_CHARS = 300;
const NEXT_ACTION_WARN_CHARS_LEGACY = 600;
// chore `cadence` shape (schema.md "chore"): fixed words or `every N days|weeks|months`, or `once`.
const CADENCE_RE = /^(daily|weekly|monthly|quarterly|yearly|once|every \d+ (days?|weeks?|months?))$/;
const ARC = { statuses: ["active", "paused", "completed", "cancelled"], sections: ["OBJECTIVE", "SUCCESS_CRITERIA", "ACTIVITY_LOG"] };
const INITIATIVE = { statuses: ["draft", "active", "completed", "cancelled"], sections: ["GOALS", "ACTIVITY_LOG"] };
const COMMON_FIELDS = ["id", "title", "created", "updated"];
const RECORD_DIRS = new Set(["items", "arcs", "initiatives", "sessions"]);

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The text of `## ACTIVITY_LOG`, up to the next `## ` heading ('' when there is none).
const activityLog = (text) => {
  const h = /^##\s+ACTIVITY_LOG\b[^\n]*$/m.exec(text);
  if (!h) return "";
  const rest = text.slice(h.index + h[0].length);
  const next = /^##\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
};
// Whether `text` names tracker item `id` as a whole identifier (ABC-12, not ABC-120 or XABC-12).
const namesIssue = (text, id) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(id)}(?![0-9])`, "i").test(text);

// The record's `status` at git HEAD, or null when there is nothing to compare: not inside a git work tree, no
// HEAD, a file that is new since HEAD, no git, or git failing. It never throws: a crash here would exit 1
// without the WARN line, which CI's records merger reads as a block (in CI the PR tree is checked out at the
// merge commit, so HEAD equals the file and nothing is judged there). `HEAD:./name` is resolved from the
// record's own folder.
function headStatus(path) {
  try {
    const r = spawnSync("git", ["-C", dirname(path), "show", `HEAD:./${basename(path)}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
    if (r.status !== 0 || typeof r.stdout !== "string") return null;
    const head = r.stdout.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const s = head && head[1].match(/^status:\s*(.*)$/m);
    return s ? s[1].trim() : null;
  } catch {
    return null;
  }
}

const listDir = (dir) => {
  try {
    return readdirSync(dir).sort();
  } catch {
    return null;
  }
};

/** Whether `parts` (a path's segments) holds `segments` as consecutive entries. */
const hasSegments = (parts, segments) => {
  for (let i = 0; i + segments.length <= parts.length; i++) if (segments.every((s, j) => parts[i + j] === s)) return true;
  return false;
};

/**
 * Judges one record. Returns { code, lines }: the exit code and the lines for stderr (no newlines).
 *   rules, config   from setup()
 *   problems        bad settings, one line each; shown as non-blocking warnings on a record that is judged
 *   profileProblem  why the profile could not be read, or null; a record that would be judged is then not
 */
export function validateFile(file, { rules, config, problems = [], profileProblem = null }) {
  const clean = { code: 0, lines: [] };
  if (!file) return clean;

  // The inbox and directory-doc files are never validated; only records are ours to judge.
  // `CLAUDE.md`/`README.md` are folder instructions (e.g. the one in sessions/), not records.
  if (["inbox.md", "CLAUDE.md", "README.md"].includes(basename(file))) return clean;

  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return clean; // unreadable / deleted -> nothing to validate
  }

  const fm = table(); // a frontmatter key is the record's text: `constructor` here is the record's, never inherited
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (fmMatch) {
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (m) fm[m[1]] = m[2].trim();
    }
  }
  const sections = [...raw.matchAll(/^##\s+([A-Z_]+)/gm)].map((m) => m[1]);
  const has = (s) => sections.includes(s);

  // Which schema applies. Inside the data folder the folder decides: items / arcs / initiatives / sessions hold
  // records, and any other folder there (searches/, attachments/, references/, the data folder's root) is not ours
  // to judge. Outside the data folder (a scratch copy, a staged temp file, an export) the record's own id
  // decides: an item-prefix id is an item, `ARC-` an arc, `INIT-` an initiative, read from the `id` field, else
  // from the file name, provisional `-tmp-<hex>` ids included; a session record (no id prefix) is recognised by
  // a `start_ts` or `cwd` frontmatter key. A file with none of those is still not ours (silent exit 0), so
  // non-record files stay quiet.
  const ID_KIND = table([[config.prefix, "items"], ["ARC", "arcs"], ["INIT", "initiatives"]]);
  const ID_RE = new RegExp(`^(${config.prefix}|ARC|INIT)-(\\d+|tmp-[0-9A-Fa-f]+)(?![\\w])`);
  const folder = basename(dirname(file));
  const underDataDir = hasSegments(dirname(file).split(/[\\/]/), config.dirSegments);
  let kind = folder;
  let inferred = false; // true: kind came from the id, so no sibling folder to check against
  if (!RECORD_DIRS.has(folder) && !underDataDir) {
    const idSource = isNull(fm.id) ? basename(file) : fm.id.replace(/^["']|["']$/g, "");
    const m = idSource.match(ID_RE);
    if (m) {
      kind = ID_KIND[m[1]];
      inferred = true;
    } else if ("start_ts" in fm || "cwd" in fm) {
      kind = "sessions";
      inferred = true;
    }
  }
  if (!["items", "arcs", "initiatives", "sessions"].includes(kind)) return clean; // not a record folder and no record id outside the data folder -> not ours to judge
  if (profileProblem) return { code: 1, lines: [`⚠ ${basename(file)} is valid, with a non-blocking warning:`, `  - ${profileProblem}; this record was not judged`] };

  const errors = [];
  const warnings = []; // non-blocking: surfaced, never the exit-2 block path

  const requireFields = (names) => {
    for (const f of names) if (isNull(fm[f])) errors.push(`missing required field \`${f}\``);
  };
  const requireSections = (names) => {
    for (const s of names) if (!has(s)) errors.push(`missing required section \`## ${s}\``);
  };
  const checkStatus = (allowed) => {
    if (!fm.status) errors.push("missing `status`");
    else if (!allowed.includes(fm.status)) errors.push(`status \`${fm.status}\` is not valid here (allowed: ${allowed.join(", ")})`);
  };
  // recordings: scheme-prefixed meeting-recording pointers, valid on items AND arcs (schema.md "recordings").
  // Shape-only: each entry must look like `<scheme>:<id>` (e.g. `fathom:123456789`); the scheme set is OPEN, so an
  // unknown scheme is fine and must never block. The line parser sees only inline flow lists (`[a, b]`); a
  // block-style YAML list is invisible to it and passes untouched, the same tolerance every other list field gets.
  const checkRecordings = () => {
    const v = fm.recordings;
    if (isNull(v) || v === "[]") return;
    const m = v.match(/^\[(.*)\]$/);
    if (!m) {
      errors.push("`recordings` must be a list — inline form `[fathom:<call_id>, …]` (see schema.md `recordings`)");
      return;
    }
    const entries = m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    for (const e of entries)
      if (!/^[A-Za-z][\w.+-]*:\S+$/.test(e))
        errors.push(`recordings entry \`${e}\` is not \`<scheme>:<id>\` — e.g. \`fathom:123456789\` (any scheme is accepted; only the shape is checked)`);
  };
  // The handoff pointer (a profile's `handoff`): only a handed-off record carries it, and it must match the
  // pattern. On an arc or initiative (which never reach that status) it is always refused. No effect without a profile.
  const checkHandoffField = () => {
    const h = rules.handoff;
    if (!h || isNull(fm[h.field])) return;
    if (fm.status !== h.status)
      errors.push(`\`${h.field}\` is only valid on a ${h.status} record (status here: \`${fm.status ?? "none"}\`) — a record that still lives in the backlog points at the tracker with \`external_ref\`, not \`${h.field}\``);
    else if (!h.pattern.test(fm[h.field].replace(/^["']|["']$/g, "")))
      errors.push(`\`${h.field}: ${fm[h.field]}\` is not a tracker identifier — it must match \`${h.pattern.source}\``);
  };

  // ── Validate ──────────────────────────────────────────────────────────────────
  if (kind === "items") {
    requireFields(COMMON_FIELDS);
    const t = fm.type;
    const spec = t ? rules.types[t] : undefined;
    if (!t) errors.push("missing `type`");
    else if (!spec) errors.push(`unknown item type \`${t}\` (expected one of: ${rules.typeNames.join(", ")})`);
    if (spec) {
      checkStatus(spec.statuses);
      requireFields(spec.fields);
      requireSections(spec.sections);
      if (rules.workTypes.has(t)) {
        // GTD discipline, the load-bearing rules: an active item must carry a live next action; a blocked
        // item must say what it's waiting on.
        if (fm.status === "active" && isNull(fm.next_action))
          errors.push("`status: active` requires a non-null `next_action` — an active item with no next action is stuck by definition");
        if (fm.status === "blocked" && isNull(fm.blocked_on))
          errors.push("`status: blocked` requires `blocked_on` — say who/what you're waiting on (and set `waiting_since`)");
        // an idea is captured, never committed: it must NOT carry a next action (mirror-image of the `active`
        // rule: an idea with a next action is a committed item in denial) and cannot be waiting on anything.
        if (fm.status === "idea" && !isNull(fm.next_action))
          errors.push("`status: idea` requires a null `next_action` — an idea with a next action is committed work; promote it to `draft`/`active` instead");
        if (fm.status === "idea" && (!isNull(fm.blocked_on) || !isNull(fm.waiting_since) || !isNull(fm.waiting_on)))
          errors.push("`status: idea` cannot carry `blocked_on`/`waiting_since`/`waiting_on` — an uncommitted idea waits on nothing");
        // a profile's `requireWhen`: a field a type must carry once it is past its first statuses
        for (const rule of rules.requireWhen)
          if (rule.type === t && !rule.exceptStatuses.includes(fm.status) && isNull(fm[rule.field]))
            errors.push(`\`type: ${t}\` requires a non-null \`${rule.field}\` once past ${rule.exceptStatuses.length ? rule.exceptStatuses.map((s) => `\`${s}\``).join("/") : "its first status"}`);
      }
      // a profile's `sectionsAnyOf`: from each group at least one section is required
      for (const group of spec.sectionsAnyOf)
        if (!group.some(has))
          errors.push(`missing required section \`## ${group[0]}\` (a \`${t}\` record may carry ${group.slice(1).map((s) => `\`## ${s}\``).join(" or ")} instead)`);
      // A work type at one of its decision statuses is a decision: it must say what is being decided.
      const decisionHere = !!fm.status && rules.decisionStatusesOf(t).has(fm.status);
      if (decisionHere && isNull(fm.question))
        errors.push(`\`status: ${fm.status}\` on an \`${t}\` record makes it a decision, which requires \`question\` — the one-line question being decided`);
      // `decision`: open means undecided; decided says what and when (schema.md "decision"). The same rules
      // hold for a work type while it is a decision.
      if (spec.family === "decision" || decisionHere) {
        if (fm.status === "decided" && isNull(fm.decided))
          errors.push("`status: decided` requires `decided` — the option that was chosen");
        if (fm.status === "decided" && isNull(fm.decided_on))
          errors.push("`status: decided` requires `decided_on` — the date the call was made (YYYY-MM-DD)");
        if (fm.status === "open" && (!isNull(fm.decided) || !isNull(fm.decided_on)))
          errors.push("`status: open` requires null `decided`/`decided_on` — a decision that has been made is `decided`, not `open`");
        if (!isNull(fm.options) && fm.options !== "[]" && !/^\[.*\]$/.test(fm.options))
          errors.push("`options` must be an inline list of short labels — `[shared, dedicated]` (elaborate them in `## OPTIONS`)");
      }
      // `chore`: active means it recurs on a cadence and has a next due date (schema.md "chore").
      if (spec.family === "chore") {
        if (fm.status === "active" && isNull(fm.cadence))
          errors.push("`status: active` on a chore requires `cadence` — daily | weekly | monthly | quarterly | yearly | every N days/weeks/months | once");
        if (fm.status === "active" && isNull(fm.next_due))
          errors.push("`status: active` on a chore requires `next_due` (YYYY-MM-DD) — a reader needs it to know when it is due");
        if (!isNull(fm.cadence) && !CADENCE_RE.test(fm.cadence))
          errors.push(`\`cadence: ${fm.cadence}\` is not a recognised cadence — daily | weekly | monthly | quarterly | yearly | every N days/weeks/months | once`);
      }
      // A profile's `handoff`: the record's work went on elsewhere, so it must say where. The converse (the
      // pointer on a record that is not at that status) is refused below, for every record kind. A handed-off
      // record is frozen (the finished-record rule below, BLOCK), and its ACTIVITY_LOG names the pointer.
      const h = rules.handoff;
      if (h && fm.status === h.status) {
        if (isNull(fm[h.field]))
          errors.push(`\`status: ${h.status}\` requires \`${h.field}\` — the tracker identifier the record was handed off to`);
        else {
          const id = fm[h.field].replace(/^["']|["']$/g, "");
          if (h.pattern.test(id) && !namesIssue(activityLog(raw), id))
            errors.push(`\`status: ${h.status}\` requires an \`ACTIVITY_LOG\` line naming the tracker item (\`${id}\`, with its link) — the pointer from the frozen record to where the work went`);
        }
      }
      checkRecordings();
    }
    checkHandoffField();
    // The finished set, the wait rules and the legal moves, all from ./record-rules.mjs (schema.md "Finished
    // records", "Who holds the ball", "Legal moves"). The one finished-record rule reports each field a
    // finished record must clear once: a BLOCK on a handed-off record (the frozen shape), a WARN on any other.
    for (const f of rules.terminalLeftovers(fm)) {
      if (rules.handoff && fm.status === rules.handoff.status)
        errors.push(`\`status: ${fm.status}\` requires a null \`${f}\` — the record is frozen and its work lives in the tracker; null it`);
      else
        warnings.push(`\`status: ${fm.status}\` is finished, but the record still carries \`${f}\` — a finished record has no next action and waits on no one, so set it to null (backlog-record: \`${f === "next_action" ? "--clear-next-action" : "--clear-waiting"}\`)`);
    }
    for (const p of rules.waitProblems(fm)) warnings.push(p);
    // The status move since the last commit. Only a record in its items/ folder, inside a git work tree whose
    // HEAD has a copy of it, has a "before" to judge; anything else is skipped. Local only: it sees HEAD and
    // the file on disk, not each write, so two legal edits made before one commit (active → completed → draft)
    // read as one move (active → draft) and may warn. CI judges nothing (its HEAD is the merge commit).
    if (!inferred) {
      const before = headStatus(file);
      const why = rules.checkMove(fm.type, before, fm.status);
      if (why) warnings.push(`the status changed since the last commit: ${why} (a local check: it compares this file with its copy at the last commit, so two legal edits made before one commit can read here as a single move the table does not allow)`);
    }
    // `wake_when`: the free-text wake condition must be PAIRED with a `review_after` date (schema.md
    // `wake_when`). Nothing evaluates the condition, so the date is the only thing that ever wakes the record; a
    // `wake_when` alone is a tickler that never fires. BLOCK (not WARN) because the pairing is the entire point
    // of the field.
    if (!isNull(fm.wake_when) && isNull(fm.review_after))
      errors.push("`wake_when` requires `review_after` — the condition is free text nothing evaluates, so pair it with the date that wakes the record anyway");
    // advisory (WARN, never BLOCK): a paragraph-length next_action is a desk dump, not the next physical action.
    const naLimit = isNull(fm.owner) ? NEXT_ACTION_WARN_CHARS_LEGACY : NEXT_ACTION_WARN_CHARS;
    if (!isNull(fm.next_action) && fm.next_action.length > naLimit)
      warnings.push(`\`next_action\` is ${fm.next_action.length} characters — keep it to one physical action and move the rest to \`ACTIVITY_LOG\` (advisory, threshold ${naLimit}${isNull(fm.owner) ? " for a record without `owner`; 300 once it carries one" : ""})`);
    // advisory (WARN, never BLOCK): the same `id` carried by two files in this directory. The next four checks
    // read the record's sibling files, so they run only when the file sits in its items/ folder; a copy
    // validated elsewhere has no siblings to compare.
    if (!inferred && !isNull(fm.id)) {
      const names = listDir(dirname(file)) ?? [];
      const reD = new RegExp(`^${escapeRegExp(fm.id)}(-.*)?\\.md$`);
      const twins = names.filter((n) => reD.test(n) && n !== basename(file));
      if (twins.length)
        warnings.push(`\`id: ${fm.id}\` is also carried by ${twins.join(", ")} — two records share one id; renumber one (allocate a fresh id with the backlog's allocate-id tool) so references stay unambiguous (this is a warning, not a block)`);
    }
    // referential check (WARN, never BLOCK): a set `parent` should point at an existing item. A dangling
    // pointer (typo, renumbered parent) is flagged, but the write is never blocked: the edge is advisory
    // metadata, not a structural requirement. See schema.md "Sub-items → Referential check".
    if (!inferred && !isNull(fm.parent)) {
      const dir = dirname(file); // the items/ directory
      const re = new RegExp(`^${escapeRegExp(fm.parent)}(-.*)?\\.md$`); // {ID}.md or {ID}-slug.md
      const names = listDir(dir);
      const found = names === null ? true : names.some((n) => re.test(n)); // can't read the dir -> can't prove absence -> don't warn
      if (!found)
        warnings.push(`\`parent: ${fm.parent}\` points at an item that doesn't exist in ${basename(dir)}/ — check for a typo or a renumbered parent (this is a warning, not a block; the record is otherwise valid)`);
    }
    // SUB_ITEMS materialized-view drift (WARN, never BLOCK). The optional `## SUB_ITEMS` section is a GENERATED,
    // read-only projection of an item's sub-items: a human-viewing cache, never a source of truth (membership
    // stays derived from each child's `parent`). ./render-subitems.mjs is the single writer; here we only DETECT
    // staleness and nudge a regenerate. Both directions are checked because a PostToolUse validate only sees the
    // one file written:
    const dir2 = dirname(file);
    const thisId = isNull(fm.id) ? basename(file).match(/^([A-Za-z]+-\d+)/)?.[1] : fm.id;
    // (a) this record carries a ## SUB_ITEMS section -> it must match its live derivation
    if (!inferred && thisId && hasSubItemsSection(raw) && norm(extractBody(raw)) !== norm(renderBody(thisId, dir2, rules.terminal)))
      warnings.push(`\`## SUB_ITEMS\` is a generated projection and is now stale — it no longer matches the live sub-items (items whose \`parent\` is ${thisId}). Regenerate it via backlog-manage \`regen-subitems ${thisId}\` (it is read-only — never hand-edit between the sentinels).`);
    // (b) this record IS a sub-item -> creating/closing it may have left the PARENT's projection stale (the
    //     parent file wasn't the one written, so nothing else checks it)
    if (!inferred && !isNull(fm.parent)) {
      const re2 = new RegExp(`^${escapeRegExp(fm.parent)}(-.*)?\\.md$`);
      const pName = (listDir(dir2) ?? []).find((n) => re2.test(n));
      if (pName) {
        let pRaw;
        try {
          pRaw = readFileSync(join(dir2, pName), "utf8");
        } catch {
          pRaw = undefined;
        }
        if (pRaw && hasSubItemsSection(pRaw) && norm(extractBody(pRaw)) !== norm(renderBody(fm.parent, dir2, rules.terminal)))
          warnings.push(`parent \`${fm.parent}\` carries a generated \`## SUB_ITEMS\` projection that is now stale after this change — regenerate it via backlog-manage \`regen-subitems ${fm.parent}\`.`);
      }
    }
  } else if (kind === "arcs") {
    requireFields(COMMON_FIELDS);
    checkStatus(ARC.statuses);
    requireSections(ARC.sections);
    checkRecordings();
    checkHandoffField();
  } else if (kind === "initiatives") {
    requireFields(COMMON_FIELDS);
    checkStatus(INITIATIVE.statuses);
    requireSections(INITIATIVE.sections);
    checkHandoffField();
  } else {
    // Session records: durable, queryable per-engagement notes. There is no `status` lifecycle to enforce.
    // Light-touch: a few metadata fields only; the body is prose (Title-case headings), deliberately unschema'd.
    requireFields(["date", "cwd", "start_ts"]);
  }
  for (const p of problems) warnings.push(p);

  // ── Verdict ───────────────────────────────────────────────────────────────────
  // Exit codes (per the header + the hook wrapper): 2 = BLOCK, 0 = clean, anything else (here: 1) = non-blocking WARN.
  const lines = [];
  if (errors.length) {
    lines.push(`✗ ${basename(file)} does not match the backlog schema${inferred ? ` (judged as ${kind === "items" ? "an item" : kind === "arcs" ? "an arc" : kind === "sessions" ? "a session" : "an initiative"} from its ${kind === "sessions" ? "frontmatter" : "id"} — the file is outside ${config.dir}/)` : ""}:`);
    for (const e of errors) lines.push(`  - ${e}`);
    for (const w of warnings) lines.push(`  - (warning) ${w}`);
    lines.push("");
    lines.push("Fix the record to match the plugin's schema/schema.md, then re-save.");
    return { code: 2, lines };
  }
  if (warnings.length) {
    // The warning line is a contract with a records repository's CI, which tells this WARN from a crash by this
    // exact line: keep it byte-for-byte, or change both together.
    lines.push(`⚠ ${basename(file)} is valid, with ${warnings.length === 1 ? "a non-blocking warning" : "non-blocking warnings"}:`);
    for (const w of warnings) lines.push(`  - ${w}`);
    return { code: 1, lines }; // not 2 -> the hook surfaces this as context, never a block
  }
  return clean;
}

/** The command line. Returns the exit code; prints the verdict on stderr. */
export function main(argv, env = process.env) {
  const { config, problems, profileProblem, rules, rest } = setup(argv, env);
  const { code, lines } = validateFile(rest[0], { rules, config, problems, profileProblem });
  for (const line of lines) process.stderr.write(`${line}\n`);
  return code;
}
