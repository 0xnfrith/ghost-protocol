# Backlog schema

The data model for the backlog: **item**, **arc** and **initiative**, plus the **inbox**. The skills and the
validator treat this file as the source of truth for fields, statuses and sections. The schema lives **in the
plugin** and changes by an ordinary commit: `git log schema/` is the improvement trail.

A backlog is a folder of markdown files. Which folder, which item id prefix and which names count as the
operator are settings; the record format is not. That split is invariant I-1 (`../INVARIANTS.md`).

## Settings

Four plugin settings reach every tool in this folder (`config.mjs`). Unset and empty both mean the default.

| Setting | Default | Meaning |
|---------|---------|---------|
| `backlog_prefix` | `BL` | The item id prefix: 2 to 12 capital letters, and not `ARC` or `INIT`. Items are `PREFIX-NNN`. This file writes it as `PREFIX`. |
| `backlog_dir` | `backlog` | The data folder, relative to the repository root: 1 to 3 path segments of letters, digits, `.`, `_` and `-`, none of them `.` or `..`. This file writes it as `backlog/`. |
| `backlog_operator_names` | empty | Comma-separated names the operator goes by, at most 8. The word `operator` always counts. A name starts with an ASCII letter, ends with an ASCII letter or digit, is at most 40 characters, and holds only letters, digits, space, `.`, `'` and `-` between. |
| `backlog_profile` | empty | The absolute path of a profile file that adds record types and rules (see **Profiles**). |

Where a tool reads a setting from, first match wins: a flag (`--prefix`, `--dir`, `--operator-names`,
`--profile`); a `BACKLOG_<NAME>` environment variable, for CI; `CLAUDE_PLUGIN_OPTION_BACKLOG_<NAME>`, which Claude
Code exports to the plugin's hooks; the plugin's entry under `pluginConfigs` in the user's `settings.json`; then
the default. A bad value is never a reason to block a record write: it is dropped, and the validator adds one
non-blocking line naming the setting.

## File layout

```
backlog/                       the data folder (backlog_dir)
  inbox.md                     capture target: dated bullets, NOT validated
  items/PREFIX-001-some-slug.md
  arcs/ARC-001-some-slug.md
  initiatives/INIT-001.md
  sessions/2026-01-31-some-slug.md
```

Record file names are `{ID}.md` or `{ID}-{kebab-slug}.md`; a short descriptive suffix is encouraged for
greppability. The id in the frontmatter is authoritative; the file name suffix is cosmetic. Ids are sequential and
zero-padded to at least three digits (`PREFIX-007`, `PREFIX-1024`). A provisional id is `PREFIX-tmp-<8 hex>`,
globally unique, to be replaced by a sequential one later. Session notes are `YYYY-MM-DD-slug.md`.

**Which files the validator judges.** Inside the data folder, the folder decides: a file in `items/`, `arcs/`,
`initiatives/` or `sessions/` is judged as that kind of record, and any other file there (`inbox.md`,
`searches/`, `attachments/`, `references/`, the folder's root) is not a record and passes silently. `inbox.md`,
`CLAUDE.md` and `README.md` are never judged. Outside the data folder (a scratch copy, a staged temp file, an
export) the record's own id decides: an `id` (or, without one, a file name) starting with the item prefix,
`ARC-` or `INIT-` is judged as an item, arc or initiative, provisional `-tmp-<hex>` ids included; a file with no
such id but a `start_ts` or `cwd` frontmatter key is judged as a session record; a file with none of those
passes silently. A copy judged this way skips the checks that read its sibling files (duplicate id, dangling
`parent`, `## SUB_ITEMS` drift, the status move), because it has no `items/` folder beside it. The hooks
validate only files in the four record folders; this matters when an agent validates a copy by hand.

**What a record looks like.** Every record is a markdown file: YAML frontmatter between `---` lines, one
`key: value` per line; an `# {ID}: {title}` H1; then named `## UPPER_SNAKE` section blocks. Values may be bare
or quoted, lists are inline (`[a, b]`), and every reader parses the frontmatter with the same line pattern
(`^([A-Za-z_][\w-]*):\s*(.*)$`) and never reserializes it: the tools rewrite only the lines they edit. A block
style YAML list is invisible to that parser and passes untouched. Records are never deleted; they are closed
with a finished status.

**The record rules live in one module: `schema/record-rules.mjs`.** It holds the status values of every type,
arc and initiative, the finished set, the legal moves between statuses, and what "waiting on the operator" means
across `owner`, `waiting_on`, `blocked_on` and `waiting_since`. The validator, `render-subitems.mjs` and the
record tool read it; none keeps a copy of its own. This file states the same rules in prose: change the two
together, in one commit. Every reader also takes one meaning of "empty" from it: a field is empty when it is
absent, `null`, `~`, or an empty string, quoted (`""`, `''`) or not.

**What the validator blocks and what it warns on.** The validator gates by exit code: `2` = BLOCK (the message is
shown to the agent, which fixes the record), `0` = clean, anything else = non-blocking WARN.

| BLOCK (exit 2) | WARN (exit 1) |
|----------------|---------------|
| a missing `id`, `title`, `created` or `updated`; a missing or unknown `type`; a missing or invalid `status` | a finished record that still carries `next_action` or `waiting_on` |
| a missing required field or section of the type | a `waiting_since` on a record that waits on nothing |
| `active` without `next_action`; `blocked` without `blocked_on`; an `idea` with a `next_action` or a wait | a status move the table does not allow, seen against git HEAD |
| the `decision` and `chore` rules (below) | a `next_action` over 300 characters (600 without `owner`) |
| a `recordings` entry that is not `scheme:id` | an `id` carried by two files |
| `wake_when` without `review_after` | a `parent` that points at no item |
| a profile's rules (see **Profiles**) | a stale `## SUB_ITEMS` section, on the parent or on a sub-item |
| a session record without `date`, `cwd` or `start_ts` | a bad setting; a profile that cannot be read (the record is then not judged at all) |

## The inbox

`backlog/inbox.md` is the zero-friction capture target. Each entry is one dated bullet: `- YYYY-MM-DD: <thought>`.
No ids, no frontmatter, no validation: friction-free capture is the point. Lines leave the inbox only via
**clarify** (`backlog-manage`): graduated into a typed item, or deleted as not actionable. The inbox is the one
file in the data folder where deleting lines is normal.

---

## Item

The unit of work. `type` is the discriminator: it selects the status set and the section list. Common
frontmatter applies to every item; each variant adds its own fields. The validator requires `id`, `title`, `type`,
`status`, `created` and `updated` on every item; the other fields below are convention, or conditional as stated,
and are never judged on their own.

### Common frontmatter

| Field | Type | Null? | Notes |
|-------|------|-------|-------|
| `id` | string | no | `PREFIX-NNN` |
| `title` | string | no | one line |
| `type` | enum | no | one of the variants below, or one a profile adds |
| `priority` | enum | no | `critical` \| `high` \| `medium` \| `low` |
| `complexity` | enum | yes | `trivial` \| `low` \| `medium` \| `high` \| `epic` |
| `created` | date | no | `YYYY-MM-DD` |
| `updated` | date | no | `YYYY-MM-DD`, bumped on every write. **Carve-out:** a bulk *additive* migration (one that adds an absent field and appends an `ACTIVITY_LOG` line across many records, changing no record's meaning) may leave `updated` untouched, so it keeps working as the last-semantic-change date that staleness sweeps read. Not validator-enforced: `updated` is required to be present, never checked against the file's mtime. |
| `tags` | list[string] | yes | free-form labels |
| `sessions` | list[string] | yes | optional links to working-session notes |
| `arc_ref` | string | yes | the arc's id, e.g. `ARC-003`. Legacy records may wrap it in a markdown link: extract the bare id when reading. |
| `parent` | string | yes | the **parent item's** id, e.g. `PREFIX-189`, set when this item is a *sub-item* (sub-task) of another item. Bare id. **Sub-item membership is derived, not stored** (like `arc_ref`): the parent carries no authoritative child list; "sub-items of `PREFIX-189`" means all items whose `parent` is `PREFIX-189`. Write-once at creation; never edited when sub-items are added or closed. The validator **warns (never blocks)** if `parent` points at an id no item carries (see **Sub-items** below). A parent may *optionally* carry a generated `## SUB_ITEMS` section that projects this derived membership into its body for human reading: a read-only cache, never a second source of truth (see **The `## SUB_ITEMS` projection** below). |
| `next_action` | string | conditional | the next physical action. **Must be non-null while `status: active`**: an active item with no next action is the definition of stuck. |
| `blocked_on` | string | conditional | who or what you are waiting on. **Required while `status: blocked`.** |
| `waiting_since` | date | yes | the date a wait began: set on entering one (`blocked`, or `waiting_on` set), cleared (null) when it ends. **WARN** on a record that waits on nothing (see **Who holds the ball** below). |
| `review_after` | date | yes | tickler, meaningful on `deferred` and `idea`: "wake me on this date". NOT a deadline. |
| `external_ref` | string | yes | scheme-prefixed pointer to an external system, for a record that stays the home of its work, e.g. `gh:owner/repo#12`. |
| `recordings` | list[string] | yes | scheme-prefixed pointers to the meeting recordings that shaped this record, each `<scheme>:<id>`, e.g. `fathom:123456789`. The scheme set is **open**; the validator checks only the `scheme:id` *shape*, never the scheme itself (an unknown scheme must never block a write). **Append-only accumulating list**: a record collects the calls that shaped it over time; append new entries, never rewrite or drop old ones. Pointer-only: the recording stays in its source system; nothing is copied into the repo. Also valid on **arcs** (below): an arc-scoped call with no natural item home lands on the arc. |
| `deadline_date` | date | yes | only for real external deadlines (contracts, filings, events) |
| `deadline_reason` | string | yes | why the deadline matters |
| `owner` | string | yes | **who must act next**: `operator`, one of the operator's names, or an agent's display name (e.g. `Operator #1`). Free string. **Absent or null means the item is the operator's.** |
| `waiting_on` | string | yes | **the person, PR link or issue link the item is waiting on**, read before `blocked_on`. `operator` is the canonical value for "waiting on the operator"; otherwise a name (`Sam`), a bare PR or issue link, or a vendor. `blocked_on` remains the required human-readable *reason* while `blocked`; `waiting_on` is the machine-readable *party*. Must be null on `idea` (an uncommitted idea waits on nothing). |
| `wake_when` | string | yes | **the human-readable condition that should wake this record**: free text, e.g. `"first customer signs"`, `"10 paying customers"`. **Nothing reads or evaluates it**: no tool watches for the condition. It exists so a human or agent skimming a tabled record knows *what* it is waiting for, not just *until when*. **Conditional rule (BLOCK): a record carrying `wake_when` must also carry `review_after`**: the date is the actual safety net, so a condition that never fires still gets revisited. Introduced for `decision` records but valid on any item. |

> **Two advisory warnings.** A `next_action` longer than **300 characters** WARNs on a record that carries
> `owner`, and **600** on a record without it, so older records stay quiet (a next action is one physical
> action, not a desk dump); and an `id` carried by **two files** in the same directory WARNs. Neither blocks.

> **Who holds the ball.** Four fields say whose move it is, read the same way by every tool
> (`schema/record-rules.mjs`):
>
> - **`owner`**: who acts next. Absent or null means the operator. It names the operator only as exactly
>   `operator` or one of the names in `backlog_operator_names` (any case), never an agent such as `Operator #1`.
> - **`waiting_on`**: the party the record waits on, read first. `operator` is the canonical value for the
>   operator.
> - **`blocked_on`**: the reason while `blocked`, and the waiting party only when `waiting_on` is null (the legacy
>   rule, for records written before `waiting_on`).
> - **`waiting_since`**: the date the wait began. A record **waits** when it is `blocked` or carries `waiting_on`;
>   on any other record the date is a leftover and the validator **WARNs**. A block older than 30 days is for the
>   operator to chase or release.
>
> A record **waits on the operator** when its waiting party names them: it starts with the word `operator` or one
> of the operator's names, as a whole word (so `Sam, verdict on the cut` and `Sam's design rulings` count when
> `Sam` is a configured name), but not when the word names an agent (`Operator #3 ...`: a `#` after the word
> marks an agent). A live record is **on the operator's desk** when they own it **or** it waits on them. The one
> exception is `blocked` work: a block is about its waiting party, so a block they own that waits on a third
> party is in flight. Only live records are placed this way (active and blocked work, an open decision, a due
> chore); a deferred, scoped, draft or idea record is placed by its status, whatever it waits on.

> **Sub-items (`parent`).** Any item may be a *sub-item* of another by carrying `parent: <PREFIX-NNN>` (a bare
> item id). A sub-item is a **full, first-class item**: its own id, its own `type` (chosen to fit the sub-task),
> its own sections, status and lifecycle; **not** a checklist line. The upward `parent` pointer is the only thing
> that marks it. **Membership is derived, not stored**, exactly like `arc_ref`: the parent holds no child list, so
> "sub-items of `PREFIX-189`" means every item whose `parent` is `PREFIX-189`. Storing the edge once, on the child,
> pointing up, keeps it write-once (set at creation, never touched when sub-items are added, closed or
> renumbered) and avoids the two-sided drift a parent-held child list invites. Nesting is permitted (a sub-item
> may itself carry a `parent`); keep it shallow by convention. Optional and tolerated: items without it validate
> fine.
>
> **Referential check (WARN, never BLOCK).** When `parent` is set, the validator checks that an item with that id
> exists in `items/`; a dangling `parent` (a typo, or a parent that was renumbered) yields a **non-blocking
> warning**: the write always succeeds. The pointer is advisory metadata, not a structural requirement: blocking
> on it would punish the legitimate case where a parent is created moments after its child, and a hard block on a
> typo'd reference is heavier than the cost of a dangling edge (the worst case is a sub-item that does not fold
> under a real parent: visible, not corrupting). **Parent-aware tooling:** the skills treat a parent and its
> sub-items as one unit when counting work in flight (a sub-item, any item with a non-null `parent`, does not
> inflate the active count), and show sub-items nested under their parent.
>
> **The `## SUB_ITEMS` projection (optional, generated, human-viewing only).** A parent may *opt in* to a
> `## SUB_ITEMS` section in its body that lists its sub-items inline, so the relationship is visible when reading
> the raw file (in an editor, on a code host) without running a query. This does **not** reintroduce the rejected
> parent-held child list: it is a **materialized view**, not a stored edge. The authority is still the children's
> upward `parent`; the section is a *cache* of the same derivation the inspect skill computes: read-only, never a
> source of truth. The rules that keep it from drifting:
>
> - **Single writer.** The section is **generated only**, by `schema/render-subitems.mjs`: the one renderer shared
>   by the writer (`backlog-manage`) and the drift check (`schema/validate.mjs`), so the two can never disagree.
>   Never hand-author or hand-edit the body.
> - **Sentinel-fenced and deterministic.** The generated body sits between `<!-- nf-backlog:sub-items ... -->` and
>   `<!-- /nf-backlog:sub-items -->` (byte for byte; stored inside records), one child per line, sorted by numeric
>   id (`- [x] PREFIX-NNN — title · type · status`; the box is ticked for a closed sub-item, any status in the
>   finished set). With no sub-items the body is `_No sub-items._`. Deterministic rendering keeps diffs and
>   parallel merges trivial.
> - **Maintained at the write path.** `backlog-manage` regenerates the affected parent's section whenever it
>   creates or closes a sub-item, and offers `regen-subitems <ID>` and `--all` to refresh on demand. `--all`
>   refreshes only parents that *already* carry the section; it never blanket-adds one (opt-in stays opt-in).
> - **Drift is a WARN, never a BLOCK.** When a parent's section no longer matches the live derivation (a child was
>   added or closed without a regen, or a fork edited it), the validator emits a **non-blocking warning** pointing
>   at `regen-subitems`, exactly like the dangling-`parent` warning. A stale cache is visible, not corrupting; the
>   derived membership is always the truth. The check fires whether the parent itself was saved (its section is
>   checked directly) or a sub-item was saved (its parent's section is checked).
> - **Placement.** Written just before `## ACTIVITY_LOG`. It is an *extra, tolerated* section (below): not in any
>   type's required list, valid on any parent, and items without it validate fine.

### Variants

Each variant is a `status` enum plus an ordered section list. The common finished statuses are `completed` (or
`concluded` or `delivered`) and `cancelled`; `deferred` pauses work and is not finished. Every *work* variant
also opens with `idea`, the pre-commitment state (see **The `idea` status** below). The two non-work variants have
their own small status sets: `decision` (`open`, then `decided` or `cancelled`) and `chore` (`active` and
`paused`, then `retired`); their finished statuses are `decided`, `cancelled` and `retired`. A profile may add
types and statuses (see **Profiles**).

**The finished set** is exactly `completed`, `concluded`, `delivered`, `cancelled`, `decided` and `retired`, plus
the handoff status a profile names, for every reader: a parent's `## SUB_ITEMS` ticks a finished record, and no
tool chases it. **A finished record carries no `next_action` and no `waiting_on`**: finished work has no next
action and waits on no one. The validator **WARNs** on either (it does not block, so a record written before the
rule is never stopped); the record tool refuses to write one. A handed-off record is held tighter (see
**Profiles**). It is one rule (`terminalLeftovers` in `schema/record-rules.mjs`), so each field is reported once.

| Type | Status values | Sections (in order) | Extra fields |
|------|---------------|---------------------|--------------|
| `app` | idea, draft, scoped, active, blocked, completed, deferred, cancelled | DESCRIPTION, CURRENT_STATE, REQUIREMENTS, DOD, UAT, DEPLOYMENT, REFERENCES, ACTIVITY_LOG | none |
| `infra` | idea, draft, scoped, active, blocked, completed, deferred, cancelled | DESCRIPTION, CURRENT_STATE, REQUIREMENTS, ARCHITECTURE, IMPLEMENTATION, REFERENCES, ACTIVITY_LOG | none |
| `plugin` | idea, draft, scoped, active, blocked, completed, deferred, cancelled | DESCRIPTION, CURRENT_STATE, REQUIREMENTS, PLUGIN_SURFACE, ARCHITECTURE, DISTRIBUTION, CLIENT_CONTEXT, DOD, UAT, REFERENCES, ACTIVITY_LOG | none |
| `personal-ops` | idea, draft, active, blocked, completed, deferred, cancelled | DESCRIPTION, REQUIREMENTS, CONTACTS, DELIVERABLES, REFERENCES, ACTIVITY_LOG | none |
| `research` | idea, draft, active, blocked, concluded, deferred, cancelled | DESCRIPTION, CURRENT_STATE, HYPOTHESIS, FINDINGS, REFERENCES, ACTIVITY_LOG | none |
| `decision` | open, decided, cancelled | CONTEXT, OPTIONS, RECOMMENDATION, OUTCOME, REFERENCES, ACTIVITY_LOG | `question` (string, required); `options` (list[string], nullable); `recommendation` (string, nullable); `source` (string, nullable); `decided` + `decided_on` (required when `decided`, null while `open`): see **`decision`** below |
| `chore` | active, paused, retired | DESCRIPTION, PROCEDURE, REFERENCES, ACTIVITY_LOG | `cadence` + `next_due` (required while `active`); `last_done` (date, nullable): see **`chore`** below |

> **`decision`: a question sitting on someone's desk.** Many open matters are ad-hoc decisions that live only in
> chat. A decision record must be **cheap to mint from a chat message**: the `question` plus a `source` link is
> a complete record; everything else is nullable.
>
> | Field | Type | Null? | Rule |
> |---|---|---|---|
> | `question` | string | no | the one-line question being decided |
> | `options` | list[string] | yes | short option labels, inline form `[shared, dedicated]`; elaborate them in `## OPTIONS` |
> | `recommendation` | string | yes | the recommended option, one line |
> | `source` | string | yes | where the question came from: a bare chat-message link, a PR or issue link, a doc path |
> | `decided` | string | conditional | the chosen option: **required when `status: decided`**; **must be null while `open`** |
> | `decided_on` | date | conditional | **required when `status: decided`**; **must be null while `open`** |
>
> A decision tabled behind a *condition* rather than a date carries `wake_when` (the condition, free text)
> **paired with `review_after`** (the date that wakes it anyway); see `wake_when` in **Common frontmatter**. The
> pairing is enforced: `wake_when` without `review_after` is a block, because an unwatched condition is not a
> tickler. `options`, when set, must be an inline list (`[a, b]`).
>
> Statuses: `open`, then `decided` (finished) or `cancelled` (finished; the question dissolved). There is no
> `idea`, `draft` or `active` on a decision: it is open or it is not. `next_action` is never required (the next
> action *is* the answer); `blocked_on` is not used: to park a decision, set `review_after` (tabled until a date)
> or `waiting_on` (tabled behind a person or PR). `deadline_date` applies when the world imposes one. `owner` says
> whose decision it is: absent means the operator's. Link a decision to the work it gates with `parent` and/or
> `arc_ref` (derived membership, like any item). Sections: `CONTEXT` (why the question exists), `OPTIONS` (the
> choices, with trade-offs), `RECOMMENDATION` (the take and why), `OUTCOME` (filled at `decided`: what was chosen
> and what it triggered), `REFERENCES`, `ACTIVITY_LOG`. The rule a decision produces lives in doctrine or core
> memory afterwards: a decided decision is history, not a standing rule.

> **`chore`: recurring upkeep.** Maintenance that would otherwise have no home (reboots, roster clean-ups, key
> banking, worktree reaps): one record that recurs, not a new item per occurrence.
>
> | Field | Type | Null? | Rule |
> |---|---|---|---|
> | `cadence` | string | conditional | `daily` \| `weekly` \| `monthly` \| `quarterly` \| `yearly` \| `every N days` / `weeks` / `months` \| `once`. **Required while `active`.** The validator checks the shape. |
> | `last_done` | date | yes | the last completion |
> | `next_due` | date | conditional | **required while `active`**: a reader needs it to know when the chore is due |
>
> Statuses: `active` (recurring), `paused` (tabled), `retired` (finished). Doing a chore means appending an
> `ACTIVITY_LOG` line, setting `last_done`, and advancing `next_due` by `cadence` (`backlog-manage` computes it).
> `once` is for a one-shot task that is upkeep rather than a project ("remove the retired relay member"): retire
> it after the single run. `next_action` is not required (the procedure is the action). Sections: `DESCRIPTION`,
> `PROCEDURE` (the exact steps; a chore is only worth tracking if a memoryless session can run it from the
> record), `REFERENCES`, `ACTIVITY_LOG`.

### The `idea` status

`idea` means **captured with structure, never committed**: a thought worth a full record (type, sections,
`arc_ref`, recordings) that may never be done. The commitment boundary is `idea` to `draft`. Contrast with
`deferred`: a deferred item **was committed, then parked**; an idea was never committed at all, and that
boundary is what keeps both statuses honest. Never launder shelved committed work back into the idea pool:
`scoped`, `active` or `blocked` work being put down is `deferred`, and reopening a finished item goes through
`draft`.

Legal moves for `idea` (the full table is **Legal moves** below):

- **creation to `idea`**: the clarify flow's graduation target for someday/maybe thoughts.
- **`draft` to `idea`**: demotion, admitting an item was parked, never committed.
- **`idea` to `draft` or `scoped`**: the commitment act. Retype here if the capture-time type was wrong (type is
  *provisional* at `idea`, so cheap to change).
- **`idea` to `active`**: allowed but discouraged; it requires `next_action` in the same write, and normally
  passes through `draft`.
- **`idea` to `cancelled`**: discard (records are never deleted).

Field rules at `idea` (validator-enforced): `next_action` **must be null**, the mirror image of the `active`
rule: an idea with a next action is a committed item in denial. `blocked_on`, `waiting_since` and `waiting_on`
must be null: an uncommitted idea waits on nothing. `review_after` is allowed (the resurface tickler).

Tooling semantics: `idea` items are **excluded from work-in-flight counts and from chasing** (like `deferred`);
arc views show them in a separate **idea pool** bucket; the weekly review sweeps the pool (promote, keep or cancel
each). Rule of thumb at capture: **no type yet means an inbox bullet; typed but uncommitted means an `idea` item.**

> **`plugin` is the unit for a Claude Code plugin.** Use it when the thing being built or changed *is* a plugin.
> The fixed layout (`PLUGIN_SURFACE`, what it exposes; `DISTRIBUTION`, how it ships; then `DOD` and `UAT`) is the
> muscle-memory scan: the same sections in the same order on every plugin item. `CLIENT_CONTEXT` is **nullable**:
> it stays `null` for internal tooling and is filled only when the plugin is built for someone else. Prefer
> `plugin` over `infra` whenever the deliverable is a plugin.
>
> Every section listed for a type is written as a `## SECTION` header when the record is created; sections that do
> not yet apply carry a `null` or empty body rather than being omitted. The validator checks header *presence*,
> not body content.
>
> **Extra sections are tolerated.** The validator checks only that a type's *required* sections are present; it
> never rejects an *unknown* one, so a type may carry an optional appended section (a kaizen trail, for one:
> `## FRICTION`, `## CHANGE`, `## OUTCOME` on any type, with the improvement items tagged `kaizen`).
> `## SUB_ITEMS` on a parent item is the one extra section that *is* checked, but only with a **non-blocking drift
> warning** (the body must match what `schema/render-subitems.mjs` produces); an item without the section is
> never asked to grow one.
>
> When reading older records, treat an unrecognized `status` (or an older record shape) as opaque legacy: display
> it, don't reject it. Validation only applies when *writing*.

### Legal moves

A **move** is a change of `status` in one write; a new record may start at any status of its type. The legal moves
are the table `moves` in `schema/record-rules.mjs`, per family:

| From | May move to |
|------|-------------|
| `idea` | `draft`, `scoped`, `active` (discouraged), `cancelled` |
| `draft` | `idea` (the one demotion), `scoped`, `active`, `blocked`, `deferred`, any finished status |
| `scoped`, `active`, `blocked`, `deferred` | each other, `draft`, any finished status; never `idea` |
| `completed`, `concluded`, `delivered`, `cancelled` | `draft` (the reopen), or another of these four (correcting how it closed) |
| decision `open` | `decided`, `cancelled` |
| decision `decided`, `cancelled` | `open` (the reopen; a decision has no draft), or each other |
| chore `active`, `paused` | each other, `retired` |
| chore `retired` | `active` or `paused` (the reopen) |

"Any finished status" means the ones the record's type has. A type that lacks a status never reaches it (the
status rule refuses it). A profile can add moves (see **Profiles**).

**The validator judges a move when it can see one (WARN, never BLOCK).** It compares the record with its copy at
git HEAD (`git show HEAD:./<file>`, from the record's own folder) and warns on a move the table does not allow,
naming the legal ones. It judges nothing when there is no "before": outside a git work tree, a record new since
HEAD, a retype whose old status the new type lacks, or git failing. So an edit in a worktree is judged until it
is committed, the record tool gets the verdict before it commits, and CI's check of a records pull request (where
HEAD is the merge commit) judges nothing. It is a **local-only** check, and the warning says so: it sees the last
commit and the file on disk, not each write, so two legal edits made before one commit (`active` to `completed`
to `draft`) read as one move (`active` to `draft`) and may warn.

### Section meanings

| Section | What goes in it | Keep out |
|---------|-----------------|----------|
| DESCRIPTION | what this item is, why it exists, problem context | status updates, history, requirements |
| CURRENT_STATE | snapshot of what exists before this work changes it; audits, inventories | target state, historical changes |
| REQUIREMENTS | constraints, prerequisites, guardrails, acceptance criteria | design rationale, status history |
| DOD | testable exit conditions, definition of done | constraints (to REQUIREMENTS) |
| ARCHITECTURE | design decisions, rationale, target state, conventions | execution steps (to IMPLEMENTATION) |
| IMPLEMENTATION | execution plan, step-by-step procedures, rollout sequence | design rationale (to ARCHITECTURE) |
| PLUGIN_SURFACE | `plugin` only: the surface the plugin exposes (skills or commands, MCP tools, hooks, agents, and any reference docs the skills read) | how it ships (to DISTRIBUTION); design rationale (to ARCHITECTURE) |
| UAT | `app`, `plugin`: user-acceptance scenarios and their results | implementation detail |
| DEPLOYMENT | `app` only: release and rollout steps and deployment status | design rationale (to ARCHITECTURE) |
| DISTRIBUTION | `plugin` only: how it ships (marketplace, install path, release status) | the exposed surface (to PLUGIN_SURFACE); design rationale (to ARCHITECTURE) |
| CLIENT_CONTEXT | `plugin` (nullable: `null` for internal plugins): relationship state, terms, stakeholders and agreements when the plugin is built for someone else | internal technical detail |
| DELIVERABLES | milestones, deliverable tracking, work-item status | requirements, historical narrative |
| CONTACTS | people and entities involved, contact details, roles | relationship narrative (to ACTIVITY_LOG) |
| HYPOTHESIS | what you are trying to learn or prove, research questions | findings, conclusions |
| FINDINGS | what you learned, conclusions, evidence | the hypothesis itself |
| CONTEXT | `decision` only: why the question exists, what it gates, what is known | the options themselves (to OPTIONS) |
| OPTIONS | `decision` only: each choice with its trade-offs | the recommendation (to RECOMMENDATION) |
| RECOMMENDATION | `decision` only: the recommended option and the one-paragraph why | the outcome (to OUTCOME) |
| PROCEDURE | `chore` only: the exact steps a memoryless session runs to do the chore | why the chore exists (to DESCRIPTION) |
| FRICTION | tolerated kaizen extra (any type): the dated observation that something about how the work works hurt | the fix (to CHANGE) |
| CHANGE | tolerated kaizen extra (any type): the adjustment to the standard, a schema or skill commit, a convention | speculation about outcomes (to OUTCOME) |
| OUTCOME | tolerated kaizen extra (any type): did the change help? Filled in at a later review, not at creation. **Required on `decision`**: what was chosen and what it triggered, filled at `decided` | the change itself |
| REFERENCES | links to artifacts, file paths, URLs, related items | substantive content |
| ACTIVITY_LOG | dated, append-only history of actions, decisions and handoff context | evergreen content, requirements |

`ACTIVITY_LOG` is **append-only** and **non-null** on every item. Each entry is a dated bullet:
`- YYYY-MM-DD: what changed and why.` Never edit or remove past entries; when a fact becomes stale, append a new
entry. This is how context survives across sessions. Reflection answers at close land here too, prefixed:
`- YYYY-MM-DD: hansei: <answer>`.

### Item size and the end condition (the item-versus-arc rule)

An item is work **one owner can finish and check off in one sentence**.

**The one-sentence test.** Can you finish "this item is done when ___" with a sentence that is true all at once,
not a sentence that is only true *once its sub-items are true*? If the item's honest definition of done is really
"when PREFIX-A, PREFIX-B and PREFIX-C are all done," the record is not item-sized: it is an **arc** (below) or it
should be **cancelled**. The test is about the *parent record's own* definition of done, not about whether it
happens to have children: a small, finishable sub-item of a finishable parent (see **Sub-items (`parent`)**
above) stays a perfectly legitimate item.

**Migration is lazy, never a sweep.** Existing records are not retroactively resized on the strength of this rule
alone. A record that predates the rule is re-judged against the test only the next time it is *touched* (a status
change, a sweep batch reviewing it, or a sub-item being minted under it), and at that moment it is split into a
real item and an arc, converted outright to an arc, or cancelled, in the **same write** that touched it (see
`backlog-manage`'s "Updating entities"). New records must pass the test at creation.

**Not validator-enforced.** The validator carries no check for this: there is no frontmatter shape that
mechanically distinguishes an umbrella-shaped record from a well-scoped one, so the test stays a judgment call,
applied at creation and on touch, not a blocking rule.

---

## Arc

A long-running thread that groups items toward one objective. **Arc membership is derived, not stored**: an arc
carries no item list; "items in ARC-003" means all items whose `arc_ref` is `ARC-003`.

### Frontmatter

| Field | Type | Null? | Notes |
|-------|------|-------|-------|
| `id` | string | no | `ARC-NNN` |
| `title` | string | no | |
| `status` | enum | no | `active` \| `paused` \| `completed` \| `cancelled` |
| `created` | date | no | |
| `updated` | date | no | |
| `tags` | list[string] | yes | |
| `recordings` | list[string] | yes | scheme-prefixed meeting-recording pointers: the same field, format and append-only discipline as on items (see **Common frontmatter** above). Carried directly on the arc for arc-scoped calls with no natural item home. |

### Sections

| Section | Required? | Contents |
|---------|-----------|----------|
| OBJECTIVE | yes | what "done" looks like: one clear statement of the goal |
| SUCCESS_CRITERIA | yes | measurable, yes/no-testable criteria for completion |
| CONTEXT | no | strategic background, why this arc exists |
| ACTIVITY_LOG | yes | dated, append-only arc-level events |

An arc must have a real OBJECTIVE and at least one SUCCESS_CRITERIA before it is created: if you cannot
articulate them, the arc is not ready.

**The system arc.** One standing arc, created once by convention, can hold the Kaizen trail: its OBJECTIVE is the
continuous improvement of the system that runs the operator's work; improvement items (tag them `kaizen`) point
at it. Its derived member list is the compounding improvement view.

---

## Initiative

A time-boxed commitment that pulls together items and arcs. Unlike arcs, an initiative **stores explicit
membership** (`items` and `arcs` ref lists). **Only one initiative may be `active` at a time** (one-piece flow at
the commitment level); that is a convention the skills keep, not a validator check.

### Frontmatter

| Field | Type | Null? | Notes |
|-------|------|-------|-------|
| `id` | string | no | `INIT-NNN` |
| `title` | string | no | |
| `status` | enum | no | `draft` \| `active` \| `completed` \| `cancelled` |
| `created` | date | no | |
| `updated` | date | no | |
| `tags` | list[string] | yes | |
| `items` | list[string] | yes | item ids in this initiative |
| `arcs` | list[string] | yes | arc ids in this initiative |

### Sections

| Section | Required? | Contents |
|---------|-----------|----------|
| GOALS | yes | what success looks like, higher-level than any single item |
| RATIONALE | no | why this initiative now, what is driving the commitment |
| ACTIVITY_LOG | yes | dated, append-only initiative-level events |

## Session record

Session records live in `sessions/` beside the record directories: one markdown file per *engagement*
(`{YYYY-MM-DD}-{slug}.md`), a durable, queryable note of what happened. A session file is a plain record, not a
lifecycle artifact: no `status` field to flip, no continuation machinery. This plugin has no writer for them; a
person or another tool keeps them, and the validator judges only the three required fields.

### Frontmatter

```yaml
date: 2026-08-31                      # required
start_ts: 2026-08-31T13:31:00+07:00   # required, ISO8601 with offset
cwd: /home/operator/repo              # required: where the session ran
title: ...                            # optional: short engagement title
```

`start_ts` and `cwd` are descriptive record metadata (when and where the work happened), not lookup or lifecycle
keys. Additional fields are permitted and ignored by the validator (a list of the items the session worked, for
one); keep the ones that make the record queryable.

### Sections

Body sections are prose (Title-case) and deliberately unschema'd: capture what makes the engagement durable, what
happened (Summary), Decisions (with the one-line why), Files Touched, and the external side effects of the work
(messages sent, writes to other systems, posts), the record that is often their only durable trace. Time-by-arc
and by-initiative rollups are pure frontmatter scans over this folder.

---

## Profiles

A host whose store carries more than the generic types above (types of its own, a status that hands a record off
to another tracker, a field some type needs) says so in a **profile**, a JSON file named by the `backlog_profile`
setting (`profile.mjs` reads and checks it). A profile can only **add**: it adds types, appends statuses to
generic types, and switches on named rules. It cannot redefine or remove a generic type, and it holds no message
text: the validator's messages are the core's own, with the type, field and status filled in. Unknown keys are
refused, the file may be at most 256 KB, and a profile that does not pass is not used: the validator then
judges no record and says why in one non-blocking line (exit 1), rather than judge records wrongly.

```json
{
  "version": 1,
  "typeOrder": ["app", "infra", "plugin", "vendor", "personal-ops", "desk", "research", "decision", "chore"],
  "types": {
    "vendor": {
      "family": "work",
      "statuses": ["idea", "draft", "scoped", "active", "blocked", "completed", "deferred", "cancelled", "moved"],
      "sections": ["DESCRIPTION", "REFERENCES", "ACTIVITY_LOG"]
    },
    "desk": {
      "family": "work",
      "statuses": ["idea", "draft", "scoped", "active", "blocked", "completed", "deferred", "cancelled", "open", "decided"],
      "sections": ["REFERENCES", "ACTIVITY_LOG"],
      "sectionsAnyOf": [["DESCRIPTION", "CONTEXT"]],
      "fields": [],
      "decisionStatuses": ["open", "decided"],
      "extraMoves": { "open": ["active"] }
    }
  },
  "extend": { "app": { "statuses": ["moved"] }, "decision": { "statuses": ["moved"] } },
  "knownKeys": ["vendor", "vendor_emails"],
  "requireWhen": [{ "type": "vendor", "field": "vendor", "exceptStatuses": ["idea", "draft"] }],
  "handoff": { "status": "moved", "field": "tracker_ref", "pattern": "^[A-Za-z][A-Za-z0-9]*-\\d+$" }
}
```

| Key | What it does |
|-----|--------------|
| `version` | Must be `1`. |
| `types` | New types, at most 40. The name is lower-case letters, digits and `-`, and not a generic type's. Each has a `family` (`work`, `decision` or `chore`; the family selects the legal-move table and the rules), `statuses` (at least one, in the order messages list them), `sections` (required, in order), optional `sectionsAnyOf`, `fields`, `decisionStatuses` and `extraMoves`. |
| `types.<name>.sectionsAnyOf` | A list of groups of at least two section names; from each group at least one section is required (`DESCRIPTION` or `CONTEXT`, for a type that may begin as a decision). |
| `types.<name>.fields` | Frontmatter fields the type must set (non-null). |
| `types.<name>.decisionStatuses` | For a `work` type only: statuses at which the record acts as a decision. At those statuses the decision rules apply (`question` is required; `decided` needs `decided` and `decided_on`; `open` needs both null; `options` is an inline list) and the decision move table is used. Each must be one of the type's statuses. |
| `types.<name>.extraMoves` | Moves beyond the family's table, `{ "<from>": ["<to>", ...] }`, appended after the table's own list for that status. Every status named must be one of the type's. |
| `extend` | Statuses appended after a generic type's own list (`{ "app": { "statuses": ["moved"] } }`); a status the type already has is refused. Only generic types can be extended. |
| `knownKeys` | More frontmatter keys the record tool accepts with `--set`, besides the generic ones. The validator never judges an unknown key. |
| `requireWhen` | `[{ "type", "field", "exceptStatuses" }]`: a record of that work type must carry a non-null `field` at every status except the listed ones ("once past `draft`"). The type must be a work type; a profile that names another family is refused. |
| `typeOrder` | Only orders the type list in the "expected one of" message; types it leaves out follow in the default order (generic types, then the profile's in file order). Optional. |
| `handoff` | Turns on the rules for a record whose work went on in another tracker (below). |

**`handoff`: the record lives elsewhere now.** `{ "status", "field", "pattern" }` names the status (a new word,
not a generic status, and listed by at least one type the profile adds or one `extend`), the pointer field, and a
regular expression (at most 200 characters, and it must compile) the pointer must match. With it:

- The status is **finished** and **frozen**: a record at it moves nowhere, and any live work status
  (`idea`, `draft`, `scoped`, `active`, `blocked`, `deferred`) and a decision's `open` may move to it, where the
  type's own status list has it. A finished record never moves to it.
- **BLOCK: the handoff status requires the pointer field**, and the pointer must match the pattern.
- **BLOCK: the pointer field is refused on any record that is not at the handoff status**, items in any other
  status and every arc and initiative (they never reach it). A record that stays home and merely points at an
  external system uses `external_ref`.
- **BLOCK: a handed-off record carries nothing live:** `next_action`, `waiting_on`, `blocked_on` and
  `waiting_since` are null (the other finished statuses only WARN on the first two).
- **BLOCK: a handed-off record's `ACTIVITY_LOG` names the pointer** as a whole identifier (`ABC-12`, not
  `ABC-120`), normally the line that records the handoff with its link. It is the pointer from the frozen record
  to where the work went.
- **Frozen after the handoff.** The record is history from that write on: further work, comments and status live
  in the other tracker. A status change away from it is not a legal move, so the validator **WARNs** on one it can
  see (see **Legal moves**). The plugin's tools never call the tracker (I-15 in `../INVARIANTS.md`).
