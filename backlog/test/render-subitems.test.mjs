// The `## SUB_ITEMS` renderer (schema/render-subitems.mjs): the section's exact bytes, which sub-items are ticked, and
// the command line that writes it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { BEGIN_RE, END, extractBody, hasSubItemsSection, listSubItems, norm, renderBody, renderSection } from "../schema/render-subitems.mjs";
import { createRules } from "../schema/record-rules.mjs";
import { loadProfileFile } from "../schema/profile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "schema", "render-subitems");
const profile = loadProfileFile(join(here, "fixtures", "profile.json")).profile;
const generic = createRules().terminal;
const full = createRules({ profile }).terminal;

const item = (id, status, extra = "", title = `Title ${id}`) =>
  `---\nid: ${id}\ntitle: "${title}"\ntype: app\nstatus: ${status}\ncreated: 2026-01-01\nupdated: 2026-01-01\n${extra}---\n# ${id}: ${title}\n## DESCRIPTION\nx\n## ACTIVITY_LOG\n- 2026-01-01: made\n`;

const folder = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "backlog-subitems-"));
  const items = join(dir, "backlog", "items");
  mkdirSync(items, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(items, name), text);
  return { dir, items, done: () => rmSync(dir, { recursive: true, force: true }) };
};
const cli = (args, cwd) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: join(cwd, "none"), BACKLOG_PREFIX: "", BACKLOG_DIR: "" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test("the section's exact bytes: the sentinels, the note, one line per sub-item", () => {
  const f = folder({ "ALPHA-102.md": item("ALPHA-102", "draft", "parent: ALPHA-100\n"), "ALPHA-101.md": item("ALPHA-101", "completed", "parent: ALPHA-100\n") });
  try {
    assert.equal(
      renderSection("ALPHA-100", f.items, generic),
      "## SUB_ITEMS\n\n<!-- nf-backlog:sub-items GENERATED — derived from items whose `parent` is ALPHA-100; do not edit by hand. Refresh: backlog-manage `regen-subitems`. -->\n" +
        "- [x] ALPHA-101 — Title ALPHA-101 · app · completed\n- [ ] ALPHA-102 — Title ALPHA-102 · app · draft\n<!-- /nf-backlog:sub-items -->",
    );
    assert.equal(END, "<!-- /nf-backlog:sub-items -->");
    assert.ok(BEGIN_RE.test("<!-- nf-backlog:sub-items GENERATED x -->"));
    assert.equal(renderBody("ALPHA-999", f.items, generic), "_No sub-items._");
    assert.equal(renderBody("ALPHA-100", join(f.dir, "missing"), generic), "_No sub-items._");
  } finally {
    f.done();
  }
});

test("sub-items sort by their number, not by name, and a title comes from the frontmatter, the H1 or the file name", () => {
  const f = folder({
    "ALPHA-010.md": item("ALPHA-010", "draft", "parent: ALPHA-001\n"),
    "ALPHA-002-slug.md": item("ALPHA-002", "draft", "parent: ALPHA-001\n", "Second"),
    "ALPHA-1000.md": item("ALPHA-1000", "draft", "parent: ALPHA-001\n"),
    "ALPHA-999.md": item("ALPHA-999", "draft", "parent: ALPHA-001\n"),
    "ALPHA-003.md": "---\nid: ALPHA-003\ntype: app\nstatus: draft\nparent: ALPHA-001\n---\n# ALPHA-003: From the heading\n",
    "ALPHA-004.md": "---\ntype: app\nparent: ALPHA-001\n---\nbody\n",
    "ALPHA-005.md": item("ALPHA-005", "draft", "parent: ALPHA-009\n"),
    "ALPHA-006.md": item("ALPHA-006", "draft", "parent: null\n"),
  });
  try {
    const kids = listSubItems("ALPHA-001", f.items);
    assert.deepEqual(kids.map((k) => k.id), ["ALPHA-002", "ALPHA-003", "ALPHA-004", "ALPHA-010", "ALPHA-999", "ALPHA-1000"]);
    assert.deepEqual(kids.map((k) => k.title), ["Second", "From the heading", "ALPHA-004", "Title ALPHA-010", "Title ALPHA-999", "Title ALPHA-1000"]);
    assert.deepEqual(kids[2], { id: "ALPHA-004", title: "ALPHA-004", type: "app", status: "?" }, "a missing id and status fall back to the file name and ?");
  } finally {
    f.done();
  }
});

test("a sub-item is ticked when its status is finished; a handoff status counts only with the profile that defines it", () => {
  const statuses = ["completed", "cancelled", "concluded", "delivered", "decided", "retired", "moved", "active", "draft", "blocked", "idea"];
  const files = Object.fromEntries(statuses.map((s, i) => [`ALPHA-${100 + i}.md`, item(`ALPHA-${100 + i}`, s, "parent: ALPHA-001\n")]));
  const f = folder(files);
  try {
    const ticks = (closed) => Object.fromEntries(renderBody("ALPHA-001", f.items, closed).split("\n").map((l) => [l.split(" · ")[2], l.startsWith("- [x]")]));
    for (const s of ["completed", "cancelled", "concluded", "delivered", "decided", "retired"]) assert.equal(ticks(generic)[s], true, s);
    for (const s of ["active", "draft", "blocked", "idea", "moved"]) assert.equal(ticks(generic)[s], false, `${s} (generic rules)`);
    assert.equal(ticks(full).moved, true, "moved, with the profile");
    assert.equal(ticks(full).active, false);
  } finally {
    f.done();
  }
});

test("hasSubItemsSection, extractBody and norm", () => {
  const raw = item("ALPHA-001", "draft").replace("## ACTIVITY_LOG", `## SUB_ITEMS\n\n<!-- nf-backlog:sub-items GENERATED note -->\n- [ ] ALPHA-002 — T · app · draft\n${END}\n\n## ACTIVITY_LOG`);
  assert.equal(hasSubItemsSection(raw), true);
  assert.equal(hasSubItemsSection(item("ALPHA-001", "draft")), false);
  assert.equal(hasSubItemsSection("##  SUB_ITEMS\n"), true);
  assert.equal(extractBody(raw), "\n- [ ] ALPHA-002 — T · app · draft\n");
  assert.equal(extractBody("<!-- nf-backlog:sub-items x -->\nno end"), null);
  assert.equal(extractBody("nothing"), null);
  assert.equal(norm("a  \r\nb\t\r\n\r\n"), "a\nb");
  assert.equal(norm(null), "");
});

test("print: the section on stdout, for a parent id and an items folder; usage and a missing folder are exit 1", () => {
  const f = folder({ "ALPHA-101.md": item("ALPHA-101", "draft", "parent: ALPHA-100\n") });
  try {
    const r = cli(["ALPHA-100", f.items], f.dir);
    assert.equal(r.code, 0);
    assert.equal(r.out, `${renderSection("ALPHA-100", f.items, generic)}\n`);
    assert.equal(cli(["ALPHA-100"], f.dir).out, r.out, "the default items folder is backlog/items from the working folder");
    assert.equal(cli(["--dir", "backlog", "ALPHA-100"], f.dir).out, r.out);
    assert.match(cli(["--dir", "other", "ALPHA-100"], f.dir).out, /_No sub-items\._/, "--dir moves the default folder");
    const none = cli([], f.dir);
    assert.equal(none.code, 1);
    assert.match(none.err, /^usage: render-subitems /);
    assert.equal(cli(["--write"], f.dir).code, 1);
    assert.match(cli(["--write", join(f.dir, "nope.md")], f.dir).err, /cannot read /);
    assert.match(cli(["--all", join(f.dir, "nope")], f.dir).err, /cannot read /);
    assert.equal(cli(["--all", join(f.dir, "nope")], f.dir).code, 1);
  } finally {
    f.done();
  }
});

test("--write inserts before ACTIVITY_LOG, replaces between the sentinels, appends when there is no log, and does not churn", () => {
  const kid = item("ALPHA-101", "completed", "parent: ALPHA-100\n");
  const noLog = "---\nid: ALPHA-103\ntitle: No log\ntype: app\nstatus: draft\n---\n# ALPHA-103: No log\n## DESCRIPTION\nx\n";
  const f = folder({ "ALPHA-100.md": item("ALPHA-100", "draft"), "ALPHA-101.md": kid, "ALPHA-103.md": noLog });
  try {
    const file = join(f.items, "ALPHA-100.md");
    const first = cli(["--write", file], f.dir);
    assert.equal(first.out, "updated ## SUB_ITEMS on ALPHA-100 (ALPHA-100.md)\n");
    const text = readFileSync(file, "utf8");
    assert.ok(text.indexOf("## SUB_ITEMS") < text.indexOf("## ACTIVITY_LOG"), "inserted before the log");
    assert.ok(text.includes(`${END}\n\n## ACTIVITY_LOG`));
    assert.ok(text.includes("- [x] ALPHA-101 — Title ALPHA-101 · app · completed"));
    const again = cli(["--write", file], f.dir);
    assert.equal(again.out, "## SUB_ITEMS on ALPHA-100 already current\n");
    assert.equal(readFileSync(file, "utf8"), text, "no churn");
    writeFileSync(join(f.items, "ALPHA-102.md"), item("ALPHA-102", "draft", "parent: ALPHA-100\n"));
    cli(["--write", file], f.dir);
    const refreshed = readFileSync(file, "utf8");
    assert.ok(refreshed.includes("- [ ] ALPHA-102"), "replaced between the sentinels");
    assert.equal(refreshed.split("## SUB_ITEMS").length, 2, "one section");
    const file3 = join(f.items, "ALPHA-103.md");
    cli(["--write", file3], f.dir);
    assert.ok(readFileSync(file3, "utf8").endsWith(`${END}\n`), "appended when there is no log");
    // a header without sentinels is replaced up to the next heading
    writeFileSync(file, item("ALPHA-100", "draft").replace("## ACTIVITY_LOG", "## SUB_ITEMS\nhand written\n\n## ACTIVITY_LOG"));
    cli(["--write", file], f.dir);
    const fixed = readFileSync(file, "utf8");
    assert.ok(!fixed.includes("hand written") && fixed.includes(END) && fixed.includes("## ACTIVITY_LOG"));
  } finally {
    f.done();
  }
});

test("--all refreshes the parents that already have the section, and never adds one", () => {
  const withBlock = item("ALPHA-100", "draft").replace("## ACTIVITY_LOG", `${renderSection("ALPHA-100", "/nonexistent", generic)}\n\n## ACTIVITY_LOG`);
  const f = folder({ "ALPHA-100.md": withBlock, "ALPHA-101.md": item("ALPHA-101", "draft", "parent: ALPHA-100\n"), "ALPHA-200.md": item("ALPHA-200", "draft"), "ALPHA-201.md": item("ALPHA-201", "draft", "parent: ALPHA-200\n") });
  try {
    const r = cli(["--all"], f.dir);
    assert.equal(r.out, "refreshed ## SUB_ITEMS on: ALPHA-100\n");
    assert.ok(readFileSync(join(f.items, "ALPHA-100.md"), "utf8").includes("- [ ] ALPHA-101"));
    assert.ok(!readFileSync(join(f.items, "ALPHA-200.md"), "utf8").includes("SUB_ITEMS"), "a parent without the section is left alone");
    assert.equal(cli(["--all"], f.dir).out, "all ## SUB_ITEMS sections already current\n");
  } finally {
    f.done();
  }
});

test("--profile makes a handed-off sub-item ticked on the command line", () => {
  const f = folder({ "ALPHA-101.md": item("ALPHA-101", "moved", "parent: ALPHA-100\n") });
  try {
    assert.match(cli(["ALPHA-100", f.items], f.dir).out, /- \[ \] ALPHA-101/);
    assert.match(cli(["--profile", join(here, "fixtures", "profile.json"), "ALPHA-100", f.items], f.dir).out, /- \[x\] ALPHA-101/);
  } finally {
    f.done();
  }
});

test("a section that is current but for its line endings is left alone", () => {
  const f = folder({ "ALPHA-100.md": item("ALPHA-100", "draft"), "ALPHA-101.md": item("ALPHA-101", "draft", "parent: ALPHA-100\n") });
  try {
    const file = join(f.items, "ALPHA-100.md");
    cli(["--write", file], f.dir);
    const crlf = readFileSync(file, "utf8").replace(/\n/g, "\r\n");
    writeFileSync(file, crlf);
    assert.equal(cli(["--write", file], f.dir).out, "## SUB_ITEMS on ALPHA-100 already current\n");
    assert.equal(readFileSync(file, "utf8"), crlf, "not one byte changed");
  } finally {
    f.done();
  }
});
