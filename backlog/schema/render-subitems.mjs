/**
 * schema/render-subitems.mjs: the canonical renderer for the `## SUB_ITEMS` materialized-view section.
 *
 * The `## SUB_ITEMS` section on a parent item is a GENERATED, read-only projection of its sub-items (every item
 * whose `parent` is this item). It is a human-viewing convenience, NOT a source of truth: membership is still
 * derived from each child's upward `parent` pointer (schema.md "Sub-items"). This one renderer is the SINGLE
 * WRITER of the section body: schema/validate.mjs imports it to DETECT drift (WARN-only), and the
 * `backlog-manage` skill shells out to it to WRITE and refresh the section. The check and the write share this
 * code, so they can never disagree; that shared renderer is the anti-drift guarantee.
 *
 * CLI (see ./render-subitems, which calls main below):
 *   render-subitems <PREFIX-NNN> [items-dir]       print the canonical section to stdout
 *   render-subitems --write <parent-file> [items-dir]
 *                                                  rewrite the section in <parent-file> in place: replace between
 *                                                  the sentinels, else insert before ## ACTIVITY_LOG, else append.
 *                                                  INSERTS if missing (the per-parent opt-in).
 *   render-subitems --all [items-dir]              refresh EVERY parent that ALREADY has a ## SUB_ITEMS section
 *                                                  (never blanket-adds one).
 * Default items-dir: dirname(parent-file) under --write; <data folder>/items (cwd-relative) otherwise.
 * The settings flags (--prefix, --dir, --operator-names, --profile) come first; see ./config.mjs.
 *
 * Mirrors schema/schema.md: change them together, in one commit.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { isNull } from "./record-rules.mjs";
import { setup } from "./setup.mjs";

// ── Sentinels: fixed, machine-owned. The opening carries a per-parent human note; the body BETWEEN them is the
//    only thing compared for drift, so the note is free to mention the parent id without affecting the check.
//    The sentinel text is stored inside existing records: keep it byte-for-byte (BEGIN_RE, END, beginComment). ──
export const BEGIN_RE = /<!--\s*nf-backlog:sub-items\b[\s\S]*?-->/;
export const END = "<!-- /nf-backlog:sub-items -->";
const beginComment = (parentId) =>
  `<!-- nf-backlog:sub-items GENERATED — derived from items whose \`parent\` is ${parentId}; ` +
  "do not edit by hand. Refresh: backlog-manage `regen-subitems`. -->";

// ── minimal frontmatter parse (mirrors schema/validate.mjs's parser) ───────────────
function parseFm(raw) {
  const fm = {};
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (m) {
    for (const line of m[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2].trim();
    }
  }
  return fm;
}
const idNum = (id) => {
  const m = (id || "").match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
};
const idFromName = (name) => name.match(/^([A-Za-z]+-\d+)/)?.[1];

const unquote = (s) => s.replace(/^(['"])([\s\S]*)\1$/, "$2").trim();
function titleOf(raw, fm, name) {
  if (!isNull(fm.title)) return unquote(fm.title);
  const h1 = raw.match(/^#\s+\S+:\s*(.+)$/m); // "# PREFIX-NNN: Title"
  if (h1) return h1[1].trim();
  return name.replace(/\.md$/, "");
}

// normalize a body for comparison: line endings, trailing space, surrounding blank lines
export const norm = (s) => (s == null ? "" : s.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim());

// ── derive a parent's sub-items, sorted by numeric id ──────────────────────────
export function listSubItems(parentId, itemsDir) {
  let names;
  try {
    names = readdirSync(itemsDir);
  } catch {
    return [];
  }
  const kids = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    let raw;
    try {
      raw = readFileSync(join(itemsDir, name), "utf8");
    } catch {
      continue;
    }
    const fm = parseFm(raw);
    if (isNull(fm.parent) || fm.parent !== parentId) continue;
    const id = isNull(fm.id) ? idFromName(name) ?? name : fm.id;
    kids.push({ id, title: titleOf(raw, fm, name), type: fm.type || "?", status: fm.status || "?" });
  }
  kids.sort((a, b) => idNum(a.id) - idNum(b.id) || a.id.localeCompare(b.id));
  return kids;
}

// ── render just the body (what sits BETWEEN the sentinels) ──────────────────────
// A sub-item is closed (checkbox ticked) when its status is in `closed`, the finished set the rules define
// once (record-rules.mjs); everything else is open.
export function renderBody(parentId, itemsDir, closed) {
  const kids = listSubItems(parentId, itemsDir);
  if (!kids.length) return "_No sub-items._";
  return kids
    .map((k) => `- [${closed.has(k.status) ? "x" : " "}] ${k.id} — ${k.title} · ${k.type} · ${k.status}`)
    .join("\n");
}

// ── render the full section block (no trailing newline; callers manage spacing) ─
export function renderSection(parentId, itemsDir, closed) {
  return `## SUB_ITEMS\n\n${beginComment(parentId)}\n${renderBody(parentId, itemsDir, closed)}\n${END}`;
}

// ── read side: does this record carry the section? extract its current body? ────
export function hasSubItemsSection(raw) {
  return /^##\s+SUB_ITEMS\b/m.test(raw);
}
export function extractBody(raw) {
  const b = raw.match(BEGIN_RE);
  if (!b) return null;
  const after = raw.slice(b.index + b[0].length);
  const e = after.indexOf(END);
  if (e === -1) return null;
  return after.slice(0, e);
}

// ── splice a freshly-rendered block into a parent's raw text ────────────────────
//    replace the existing region; else insert before ## ACTIVITY_LOG; else append.
function spliceSection(raw, block) {
  const header = raw.match(/^##\s+SUB_ITEMS\b.*$/m);
  if (header) {
    const start = header.index;
    const endSent = raw.indexOf(END, start);
    let end;
    if (endSent !== -1) {
      end = endSent + END.length; // clean, sentinel-fenced region
    } else {
      // header present but sentinels missing/corrupt: replace to the next ## or EOF
      const rel = raw.slice(start + header[0].length).search(/\n##\s/);
      end = rel === -1 ? raw.length : start + header[0].length + rel;
    }
    return raw.slice(0, start) + block + raw.slice(end);
  }
  const log = raw.match(/^##\s+ACTIVITY_LOG\b/m);
  if (log) return raw.slice(0, log.index) + block + "\n\n" + raw.slice(log.index);
  return raw.replace(/\s*$/, "") + "\n\n" + block + "\n";
}

// returns the new text, or the original unchanged if already current (no churn)
export function rewriteRaw(raw, parentId, itemsDir, closed) {
  const next = spliceSection(raw, renderSection(parentId, itemsDir, closed));
  return norm(next) === norm(raw) ? raw : next;
}

// ── CLI ────────────────────────────────────────────────────────────────────────
// Returns the exit code; prints to the process's own stdout and stderr.
export function main(argv, env = process.env) {
  const { config, rules, rest: args } = setup(argv, env);
  const closed = rules.terminal;
  const defaultItems = join(...config.dirSegments, "items");
  const usage = "usage: render-subitems [settings flags] <PREFIX-NNN> [items-dir] | --write <parent-file> [items-dir] | --all [items-dir]";

  if (args[0] === "--all") {
    const itemsDir = resolve(args[1] || defaultItems);
    let names;
    try {
      names = readdirSync(itemsDir);
    } catch {
      console.error(`cannot read ${itemsDir}`);
      return 1;
    }
    names.sort();
    const changed = [];
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const file = join(itemsDir, name);
      let raw;
      try {
        raw = readFileSync(file, "utf8");
      } catch {
        continue;
      }
      if (!hasSubItemsSection(raw)) continue; // refresh-existing-only: never blanket-add
      const fm = parseFm(raw);
      const parentId = isNull(fm.id) ? idFromName(name) : fm.id;
      if (!parentId) continue;
      const next = rewriteRaw(raw, parentId, itemsDir, closed);
      if (next !== raw) {
        writeFileSync(file, next);
        changed.push(parentId);
      }
    }
    console.log(changed.length ? `refreshed ## SUB_ITEMS on: ${changed.join(", ")}` : "all ## SUB_ITEMS sections already current");
    return 0;
  }

  if (args[0] === "--write") {
    const file = args[1];
    if (!file) {
      console.error(usage);
      return 1;
    }
    const itemsDir = resolve(args[2] || dirname(file));
    let raw;
    try {
      raw = readFileSync(file, "utf8");
    } catch {
      console.error(`cannot read ${file}`);
      return 1;
    }
    const fm = parseFm(raw);
    const parentId = isNull(fm.id) ? idFromName(basename(file)) : fm.id;
    if (!parentId) {
      console.error(`cannot determine item id for ${file}`);
      return 1;
    }
    const next = rewriteRaw(raw, parentId, itemsDir, closed);
    if (next !== raw) {
      writeFileSync(file, next);
      console.log(`updated ## SUB_ITEMS on ${parentId} (${basename(file)})`);
    } else {
      console.log(`## SUB_ITEMS on ${parentId} already current`);
    }
    return 0;
  }

  const parentId = args[0];
  if (!parentId) {
    console.error(usage);
    return 1;
  }
  const itemsDir = resolve(args[1] || defaultItems);
  console.log(renderSection(parentId, itemsDir, closed));
  return 0;
}
