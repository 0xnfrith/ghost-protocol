# Invariants

Rules this backlog must keep honoring no matter how it evolves. Each one exists because a real design decision (or
a real failure) taught it. **A change that conflicts with an invariant does not silently break it: either the
change is reshaped to honor it, or the invariant is consciously revised here, with a dated entry explaining what
changed and why.**

**This port reverses I-1 on purpose.** The plugin this backlog comes from ran exactly one system, with its slug
and data folder hardcoded. Here the id prefix, the data folder, the operator's names and a profile of extra
record types are settings, so any Ghost Protocol agent can have a backlog. The record format stays fixed (I-1
below). The numbers I-1 to I-20 are kept from the source, so a reader who knows one can find the other; an
invariant that does not apply here is marked.

Format: `I-N`, statement, origin.

- **I-1 — The slug and the data folder are settings; the record format is not.** The item id prefix, the data
  folder, the operator's names and a profile file that adds record types are plugin settings (`schema/config.mjs`,
  `schema/profile.mjs`). The file names, the frontmatter shape, the form of a section header, the sentinels and
  the validator's exit codes are fixed, so one store keeps validating under whichever settings an instance runs.
  The types and their sections come from the core table and the profile. *Origin: ported from a plugin whose I-1
  said "one system, hardcoded"; reversed on purpose.*

- **I-2 — The *store* is plain markdown in git; there is no database *of record*.** Items, arcs and initiatives
  are `.md` files with YAML frontmatter under the data folder. The filesystem is the source of truth; `git log` is
  the audit trail; the records are readable with your own eyes. No SaaS, no account, no index that can drift from
  the files. This governs the **store**: where records and their truth live. It does **not** forbid an external
  service on the *write path* that holds no records (see I-17, the id allocator): such a service is a coordination
  aid, never a source of truth, and the store stays reconstructable from the files alone. *Origin: founding shape.*

- **I-3 — The schema lives in the plugin and changes by ordinary commit.** `schema/schema.md` is the authority for
  fields, sections, status sets and the conditional rules. There is **no** separate schema-revision number,
  template or migration step: `git log schema/` is the schema's entire history. *Origin: removed a
  consumer-owned template and schema-revision system in favor of plain commits.*

- **I-4 — `schema/schema.md` and `schema/validate.mjs` change together, in one commit.** The prose schema and the
  executable checker mirror each other; the validator's job is to enforce exactly what the prose declares. Editing
  one without the other is the drift this rule forbids. Anything the validator imports (`record-rules.mjs`,
  `render-subitems.mjs`, `config.mjs`, `profile.mjs`) lives in `schema/` and moves with them. *Origin: stated in
  the validator's header; honored on every schema change.*

- **I-5 — The validator gates by exit code: `2` = BLOCK, `0` = clean, anything else = non-blocking WARN.** A block
  prints a fix message shown to the agent, which corrects the record; a warning is surfaced as context and never
  stops the write. The hooks wrap this contract and never invent a different one. The warning line (`⚠ <file> is
  valid, with a non-blocking warning:`) is matched byte for byte by a records repository's CI, which tells a WARN
  from a crash by it: keep it, or change both together. *Origin: the validator's contract.*

- **I-6 — GTD discipline is enforced, not advised.** An `active` item must carry a non-null `next_action`; a
  `blocked` item must carry `blocked_on` (and set `waiting_since`). These are hard blocks (exit 2), because an
  active item with no next action is the definition of stuck. The discipline lives in the validator, not in a
  skill's good intentions. *Origin: the GTD redesign.*

- **I-7 — Records are never physically deleted.** To retire something, close it with a finished status
  (`completed`, `concluded`, `delivered`, `cancelled`, `decided`, `retired`; `deferred` to pause). "Delete X"
  becomes "close X", with the reason logged. The inbox is the sole exception (see I-12). A record handed off to
  another tracker (a profile's `handoff`) is not deleted either: it is closed with the handoff status and stays as
  history. The finished set is the one in `schema/record-rules.mjs`, and nowhere else (see I-20). *Origin: the
  `backlog-manage` closing rule.*

- **I-8 — `ACTIVITY_LOG` is append-only.** Never edit or remove a past entry; when a fact goes stale, append a new
  dated entry. The log is how a fresh, memoryless session reconstructs not just where an item stands but how it
  got there. Sessions are disposable; the trail is not. *Origin: the session-trail design.*

- **I-9 — Relationships are a single edge, stored once on the pointing record, and membership is derived: never a
  stored two-sided list.** `arc_ref` (item to arc) and `parent` (child to parent) are written once on the
  child or member; "items in `ARC-X`" and "sub-items of `PREFIX-Y`" are computed by scanning for the pointer. A
  parent or arc holds **no** maintained child list: that is what avoids the two-sided drift a denormalized list
  invites (a lesson learned from parallel forks drifting apart). *Origin: the arc design; reaffirmed for `parent`.*

- **I-10 — A dangling reference is a WARN, never a BLOCK.** A `parent` (or `arc_ref`) pointing at an id no record
  carries yields a non-blocking warning; the write always succeeds. The pointer is advisory metadata: blocking it
  would punish the legitimate parent-created-moments-after-child case, and a typo's worst outcome is a sub-item
  that does not fold (visible, not corrupting). *Origin: the `parent` referential check.*

- **I-11 — Reads and writes are separate skills; a read never mutates a store.** `backlog-inspect` is every read
  (read-only), `backlog-manage` is every write, `backlog-capture` is zero-friction inbox capture, and
  `backlog-review` is the GTD and Kaizen ritual. The split mirrors the distinct moments a session starts.
  *Origin: the founding inspect/manage split, extended with capture and review.*

- **I-12 — Capture is zero-friction; structure is added at clarify, not at capture.** The inbox takes a raw dated
  line with no interview: no id, no type, no questions. Type, fields and sections are decided only when a line
  graduates into an item at clarify time. The inbox is the one file where deleting lines is normal (a handled
  line is removed). *Origin: the GTD inbox and `backlog-capture`.*

- **I-13 — A sub-item is a first-class item linked by one upward `parent`, not a checklist line.** A sub-task is a
  normal item with its own `type` (chosen to fit the work), its own sections, status and lifecycle; the only thing
  that marks it is `parent: PREFIX-NNN`. Nesting is permitted; keep it shallow by convention. *Origin: blessing
  the `parent` field.*

- **I-14 — An optional projection of a derived relationship is a materialized view: generated, single-writer,
  read-only, WARN-on-drift; never a second source of truth.** When the system wants a human-readable denormalized
  view of something I-9 keeps derived, it is rendered by one canonical generator (shared by the writer and the
  validator so they cannot disagree), fenced as machine-owned, never hand-edited, and its staleness is a
  non-blocking warning, because the derived membership is always the truth and a stale cache is visible, not
  corrupting. The first instance is the `## SUB_ITEMS` section (rendered by `schema/render-subitems.mjs`). This is
  how the backlog gets a denormalized view *without* reintroducing the two-sided drift I-9 forbids. *Origin: the
  `## SUB_ITEMS` projection.*

- **I-15 — A record handed off to another tracker is frozen history, and the plugin's tools never call that
  tracker.** A profile's `handoff` names a status, a pointer field and the pointer's shape. A record at that status
  is finished and frozen: it carries nothing live, names the pointer in its `ACTIVITY_LOG`, and moves nowhere; from
  then on the work, and the truth about it, live in the other tracker, and nothing is mirrored back. A fact lives in
  one of the two stores, never both. The validator, the renderer, the hooks and the scripts hold no tracker key and
  make no tracker call; an agent writes the other tracker through its own connector. A record that stays home and
  merely points elsewhere uses `external_ref`. Without a profile there is no handoff status and the rule never
  applies. *Origin: the host's split of work between this backlog and an issue tracker, generalized into the
  profile.*

- **I-16 — The Stop hook is an integrity backstop, never a nag.** A record written outside Edit and Write (a Bash
  heredoc, a script, an MCP writer) bypasses the PostToolUse validator, so the Stop hook re-validates this
  session's touched records at the end of the turn and blocks only on a real violation. The hooks are silent on
  the happy path. *Origin: the Stop hook backstop.*

- **I-17 — Ids come from one coordinator per store, never from an uncoordinated scan.** A naive "scan the folder
  for the max and add one" has no coordination: two parallel worktrees or sessions read their own snapshot,
  compute the same next number, and both write it, a silent collision. So sequential ids are minted by one
  coordinator per store: by default a lock-protected counter shared by every worktree of a clone, or a configured
  command (an id service, say). A coordinator holds **no** records, so I-2 holds: the markdown files remain the
  only source of truth and the coordinator is read only on the *write* path. The counter is a high-water mark: safe
  ahead of the files (harmless gaps), never behind, and an allocator refuses to write rather than collide with an
  id that already exists on disk or on the default branch. A provisional `PREFIX-tmp-<8 hex>` id is
  collision-free by construction and is graduated to a sequential one later. The allocator arrives in a later
  change; until it does, an id is chosen by hand and the validator's duplicate-id warning is the net. *Origin:
  local-scan collisions that recurred.*

- **I-18 — A hook's stdout is deterministic status, never a directive that steers the model into running a
  skill.** PostToolUse and Stop hooks report state and enforce integrity (the validator); they do not inject "now
  go invoke skill X" instructions into the model's context. Auto-invocation of a skill, when wanted, is the
  *host's* responsibility (a standing instruction in the host's own instructions file), not the plugin hook's: a
  plugin cannot see or control a consumer's instructions, so it stays on the deterministic side of that line. The
  narrow boundary proved durable even though the timing of earlier nudges did not. **Revisable** like every
  invariant here: if a future model-steering hook mechanism proves reliable, revise this with a dated entry.
  *Origin: retiring a session-start nudge after its policy had flipped more than once.*

- **I-19 — Reconciliation verifies against the store it is about to write, and runs as a scheduled out-of-session
  job, never as a discretionary step inside live sessions.** *(RETIRED. Its subject, a session janitor that
  reconciled a session ledger and a calendar against session files, does not exist in this plugin. Kept here
  because the underlying principle is durable and generalizes past sessions: a reconciler verifies against the
  store it is about to write, "absent from one snapshot of main" is never evidence of absence, and a sweep over
  shared external state belongs to one scheduled owner per cycle, not to N uncoordinated live sessions. Reinstate
  under a new subject if a future reconciler needs it.)* *Origin: duplicate calendar events created by two
  in-session sweeps.*

- **I-20 — The record rules are defined once, in `schema/record-rules.mjs`, and every reader imports them.** The
  status values of every type, arc and initiative, the finished set, the fields a finished record must clear, the
  legal moves between statuses, and what "waiting on the operator" means (`owner`, `waiting_on`, `blocked_on`,
  `waiting_since`) live in that one module, built once from the core table, the operator's names and the profile
  (`createRules`). `schema/validate.mjs`, `schema/render-subitems.mjs` and `scripts/record-edit.mjs` import it; no
  reader keeps a copy of its own. It sits in `schema/` because the validator and all it imports must (a records
  repository's CI checks out only that folder), and it changes with `schema/schema.md` in one commit, like the
  validator (I-4). A move check needs a "before": the validator compares with the record's copy at git HEAD and
  only WARNs, so a record is never blocked for how it got to its status. *Origin: a review of the record state
  machines, when several readers each held their own copy of the rules and the copies drifted: the finished set
  had different members in different readers.*
