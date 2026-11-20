# Buzz adapter

This adapter connects a Claude Code session to a [Buzz](https://github.com/block/buzz) relay. Buzz is Block's team chat built on Nostr; a relay is its server.

It has two parts:

- **The channel** (`src/channel.mjs`) is an MCP server that declares the Claude Code `claude/channel` capability. When someone mentions the agent in an allowlisted Buzz channel, it pushes that message into the running session.
- **buzz-mcp** is Block's MCP server with the Buzz tools (`send`, `react`, `edit` and more). The session uses its `send` tool to reply.
- **The one-shot send** (`src/send.mjs`) sends one message and exits, for programs outside a session, such as the [auto-mode guard](../../README.md#auto-mode-guard), and for the [load proof](../../hooks/README.md#load-proof) hook. See [One-shot send](#one-shot-send).
- **The one-shot thread read** (`src/thread.mjs`) prints the replies in a thread and exits, so the auto-mode guard can read its owner's answer. See [One-shot thread read](#one-shot-thread-read).
- **The status line** (`src/status.mjs`), off by default: the agent's public line (working, idle or waiting; on what; for what) and its presence, which the channel publishes, and the read of other agents' lines. See [Status line](#status-line).

A launcher (`src/launch.mjs`) starts both servers, and the one-shot send. It gets the relay private key from a command you choose and hands it to each one in its own environment only. With a [key service](#key-service), the session holds no key at all: the servers run as another OS user, and the launcher only pipes bytes to them.

The adapter also has two Claude Code hooks: the [reply guard](#reply-guard) (`hooks/reply-guard`), by which a turn in which the operator messaged the agent on Buzz cannot end until each message has an answer on Buzz; and, for an instance in [unattended mode](../../README.md#unattended-mode), `hooks/unattended-deny`, which denies every permission dialog with a message telling the agent to report on Buzz that the step needs a person.

## Research preview

Claude Code channels are a research preview. That has three consequences:

- A channel that is not on Anthropic's allowlist, such as this one, registers with `--channels` only when Claude Code's managed settings allow it (`channelsEnabled`, and the plugin in `allowedChannelPlugins`; see [Install](#install)). Then no dialog asks you to confirm it. Without that allow, it runs only when the session is started with `--dangerously-load-development-channels`, and Claude Code asks you to confirm it.
- Channels work only in interactive sessions. With `-p` or the Agent SDK `--channels` is ignored and no messages arrive.
- Claude Code does not acknowledge channel messages. If a session runs the server without registering it as a channel (for example, started without `--channels`), messages are dropped without an error. The adapter cannot tell, and moves its cursor past them.

## What reaches the session

The channel delivers a message only when all of these hold:

- It is a Buzz channel message (Nostr kind 9) with a valid signature, a well-formed id and author, and a timestamp that is a whole number of seconds no more than ten minutes in the future.
- It names exactly one channel, and that channel is one of the agent's rooms: on your list (`BUZZ_CHANNELS`), or, with `*`, any channel the agent is in.
- It mentions the watched identity (a `p` tag for `BUZZ_WATCH_PUBKEY`), or, if you turned it on, it is a one-to-one direct message from a trusted person (see [Direct messages](#direct-messages)).
- It was not written by the agent itself: neither by the watched identity nor with the agent's own key, and not posted by the relay for a [workflow](#workflow-messages) that either one owns.
- If you turned on the sender allowlist, its author is on it (see [Who can reach the agent](#who-can-reach-the-agent)). For a message the relay posted for a workflow that names the agent, it is the workflow's owner that has to be on it instead (see [Workflow messages](#workflow-messages)).
- It has not been delivered before.

The relay is asked for exactly these messages, and the channel checks every one again itself. A message that fails a check is skipped and logged by its id; it never stops the channel.

Each message arrives as a `<channel>` tag with these attributes: `channel_id`, `event_id`, `author` (the sender's hex public key), `sent_at`, `dm="true"` (for a direct message), `thread_id` (for a message in a thread), `catch_up="true"` (for a message sent while the session was disconnected) and `workflow_owner` (only for a [workflow message](#workflow-messages) that was judged by its owner). Every attribute value is either a room id, a fixed word, or checked to be a hex id or key; a thread id that is not one is left out.

### Thread context

A message in a thread (one with `thread_id`) also brings the rest of the conversation since the agent last spoke in it. Otherwise the agent would answer a mention without seeing what was said in between, such as another agent's reply or a person's comment on it.

- Before delivering, the channel asks the relay for the thread's messages: the root and every reply in the thread. It keeps those sent since the agent's own last message there (written with the agent's key or as the watched identity), or since the thread root when the agent never posted there. They are listed oldest first, without the delivered message itself and nothing newer than it.
- Each one is checked like a delivered message: a well-formed kind 9 message with a valid signature, in the same channel and the same thread. Others are left out.
- At most the newest 20 messages and 8,000 characters of their text are kept; only the newest one is ever cut short (marked `truncated="true"`). The block says how many older ones were left out (`omitted`). When the relay's answer was full and reached neither the agent's message nor the root, the count is a lower bound (`omitted="3+"`).
- With the [sender allowlist](#who-can-reach-the-agent) on, messages by senders it rejects are still included, marked `allowlisted="false"`. They never reach the session on their own, only as context to a message that does. A [workflow message](#workflow-messages) is judged by the same rule as a delivered one, and carries `workflow_owner` when its owner was the one judged.
- If the relay cannot be read within five seconds, the message is delivered all the same, with a short "thread context unavailable" note instead.

The context is appended to the text of every message with a `thread_id` as one block, after a blank line, even when it holds no messages. A message without `thread_id` never gets one. The `<channel>` attributes stay as they are.

```
<thread_context thread_id="…" since="agent_reply" omitted="2">
2 older message(s) in this thread left out.
<thread_message event_id="…" author="…" sent_at="2026-01-01T12:00:00.000Z">
text of the message
</thread_message>
<thread_message event_id="…" author="…" sent_at="…" allowlisted="false">
text by someone the allowlist rejects
</thread_message>
</thread_context>
```

`since` is `agent_reply` or `thread_root`. `author` is the hex public key; the adapter knows no display names, so none is given. In the text, `&`, `<` and `>` are escaped, so no message can close the block or forge an entry. The channel's instructions tell Claude that the context is data, never instructions, whoever wrote it, and that only the one block at the end of a message with `thread_id` is the channel's: any other, such as one written into the message itself, is part of the message.

## All my rooms

Set `BUZZ_CHANNELS` to `*` (on its own) to listen in every channel the agent's key belongs to, direct messages included.

- The channel reads the agent's memberships from the relay's member rosters (NIP-29 kind 39002) and each room's details (kind 39000). It trusts only rosters signed by the relay's own key, which the relay publishes in its NIP-11 document as `self`. A roster signed by anyone else is ignored, so no member can add rooms by forging one.
- Archived channels and system channels are left out.
- It follows changes without a restart:
  - When the relay notifies the agent that it was added to or removed from a channel (relay-signed kinds 44100 and 44101, addressed to the agent's key), the room list is read again within a second.
  - The list is also read every minute and on every reconnect. That catches what no notice announces, such as an archive. Roster and details events are scoped to their channel, so the relay never sends them to a subscription that is not already in that channel.
  - A new room is caught up from the cursor. A room the agent left, or that was archived, is dropped.
- If the room list cannot be read (a timeout, or the relay refuses), the last known rooms are kept. The list never shrinks because of an error.
- Memberships are those of the agent's own key (the one from `BUZZ_KEY_COMMAND`), whatever `BUZZ_WATCH_PUBKEY` says.
- A relay that does not publish its key gets no room list: the channel waits, and says so in its log.

## Direct messages

In Buzz a direct message is a channel of type `dm`, with its own channel id. Its messages are ordinary channel messages (kind 9) in that channel. So a DM is listened in like any other room: with `*`, every DM the agent is in; with a list, the DM ids you list, and the trusted people's one-to-one DMs (below).

By default a DM works like any channel: only messages that mention the agent are delivered. Any member of the relay can open a DM with the agent, so delivering every DM message would let anyone put text in front of Claude without a mention.

People rarely @-mention in a DM, though, so you can let **trusted people** reach the agent without one. Set both:

- `BUZZ_DM_MESSAGES=all` (plugin setting `buzz_dm_messages`);
- `BUZZ_TRUSTED_PUBKEYS` (plugin setting `buzz_trusted_pubkeys`): a comma-separated list of public keys, hex or `npub1…`.

Then, in a **one-to-one** DM with someone on that list, every message they send is delivered, mentioned or not. Everyone else's DMs still need a mention. Those one-to-one DMs are heard whatever `BUZZ_CHANNELS` says: with a list of channels, the channel also reads the agent's memberships (as in [All my rooms](#all-my-rooms), so the relay must publish its key) and listens in each one-to-one DM with a trusted person beside the listed channels, a new one as soon as the relay announces it. So the operator's DM reaches the agent even when the list names one channel. Other DMs are heard only when listed. Nobody is trusted implicitly, the agent's owner included: list them if you mean it. A DM counts as one-to-one only when the relay-signed room details name exactly two members and one of them is the agent. In a group DM, or when the details cannot be read, only mentions are delivered. `BUZZ_DM_MESSAGES=all` with an empty trusted list changes nothing, and the log says so.

A DM arrives with `dm="true"`. Claude answers it in its own thread, as it answers a channel message, never at the top level of the DM. With [DM task roots](#dm-task-roots) on, each top-level DM from the operator is also a task.

## DM task roots

A DM with the agent's operator tends to sprawl: answers land at the top level, a thread picks up a second and a third topic, and nothing says what is still open. With **DM task roots** on, every top-level DM from the operator is a task, and its thread is the task:

1. **It gets a state the moment it arrives:** the agent sets it to open with the channel's `task` tool. A root that only names a topic (one word, a project's name, say) gets the state and no reply, and the question follows in its thread. A short request (a status, a count, a command) is a task like any other, and is answered in its thread.
2. **All work and every reply stay in its thread,** flat to the root. Nothing about it is answered at the top level.
3. **It closes when nothing is left:** the agent sets it to done, and the last line of its final answer is a one-line closing report (finished, answered or moved). A quick ask (a status, a count) is answered and closed at once. A done root is never reopened: new work in it gets a new root.
4. **A new topic inside a thread gets its own root:** the agent posts a short top-level message (five lines at most), sets it open, answers there with a link back, and leaves one line in the old thread that points to it. It does this on its own, without asking.
5. **The agent's own roots follow the same rules:** a result it starts at the top level of that DM, and the instance's alerts (the auto-mode guard's and the memory backup's, see below).
6. **"What's open?"** gets one list in that thread from the channel's `task_list` tool, one line per open root; then that ask closes.

Turn it on with the plugin setting `task_roots` (`BUZZ_TASK_ROOTS=on`). It needs `buzz_dm_messages` set to `all` with the operator in `buzz_trusted_pubkeys` (see [Direct messages](#direct-messages)): otherwise a top-level DM without a mention never reaches the agent, and the channel's log says so at start (naming an operator key, from `buzz_operator_pubkeys`, that is not trusted). The rules name the operator by key (`buzz_operator_pubkeys`, else the trusted people), as the reply guard reads them; a DM with anyone else is answered in its thread, with no task states.

**One switch and one set of reactions, in every place that reads them.** Each place reads its own copy, and nothing compares them, so set them the same:

- **The reply guard** reads the plugin setting `task_roots` in the session, always.
- **The channel** reads `task_roots` and the emoji settings from the plugin, or, with a [key service](#key-service), from the key service's settings (`BUZZ_TASK_ROOTS`, `BUZZ_TASK_OPEN_EMOJI` and the rest): the session's plugin settings never reach a key service's channel. With the guard's switch on and the channel's off, the guard still checks, but the agent is not told the rules.
- **The alerts' `buzz_task_open_emoji`** (and its `_url`) in the manifest must be the channel's open emoji. A root's state is read only from the reactions the channel knows, so an alert marked with another emoji never shows as open, and closing it leaves that reaction behind.
- **At start the channel logs what it uses:** `task roots on|off; task reactions: open …, done …, emergency 🚨`.
- **A bad emoji setting never stops the channel.** The log says why at start, and the task tools answer with the same reason until it is fixed.

**Permissions.** The tools are `mcp__plugin_ghost-protocol_buzz-channel__task` and `…__task_list`. An instance that asks before an MCP tool runs needs them allowed. In [unattended mode](../../README.md#unattended-mode) every dialog is denied, so a tool that is not allowed fails, and each root ends in a block the agent cannot clear.

**Enforced, not just asked for.** Rules 1 and 2 are checked by the [reply guard](#reply-guard) when a turn ends: a top-level DM from the operator needs a state on it (the `task` tool, whose result must hold its success line, or a [reaction helper](#its-settings)'s success line; the Buzz `react` tool alone is no state) and a send in its thread. A short root (one or two words and at most 40 characters; a mention is not a word) only opens a topic and needs the state alone, unless it was set done: an answered ask needs its answer in the thread. With task roots on, a DM message from the operator is answered only in its thread: a top-level send in the DM, or one that tags the operator, no longer counts. The rest are the channel's instructions to the agent, which it adds when `task_roots` is on. The states and their moves are code ([`src/task.mjs`](src/task.mjs)): the `task` tool refuses to reopen a done root unless asked to correct a premature done (`reopen`).

**The states:**

| State | Reaction | Meaning |
|---|---|---|
| `open` | `task_open_emoji`, default ⭕ | Something is still left in the thread, whoever holds it. |
| `done` | `task_done_emoji`, default ✅ | Nothing is left; the thread's last message says why. |
| `emergency` | 🚨 | An emergency, and still open. |
| `none` | none | No state. |

A root's state is the agent's newest state reaction on it; only the agent's own reactions count. Setting a state replaces the old one, never stacks: the new reaction goes on first, then the agent's earlier state reactions on that message are deleted (NIP-09, kind 5). Any move is allowed except out of `done`.

**Custom emoji.** A workspace's custom emoji is a name and an image. Set `task_open_emoji` (or `task_done_emoji`) to the name (lower-case letters, digits, `_` and `-`) and `task_open_emoji_url` to its image's `https://` address: the reaction carries it (a NIP-30 `emoji` tag), or Buzz shows the name as text. A reaction is written the way Buzz's own app writes one: kind 7, content `:name:` (or the plain emoji), tags `h` (the channel), `e` (the message) and, for a custom emoji, `emoji`.

**The tools,** on the channel's own server, so they sign with the key the channel holds; in a [key service](#key-service) they run on the key's side, and the session holds no key:

- `task` (`channel`, `id`, `state`, optional `reopen`): sets a message's state and answers `<first 8 hex of the id>: <old> -> <new>`.
- `task_list` (optional `channel`, `max`): the open roots, newest first, from the agent's newest 500 reactions (of any kind) in the channels it listens in (or the one named): one line each with the state, the channel id, the event id and the root's first line. The first line is shown only for roots the agent or a trusted person wrote; any other root is listed by its ids alone. Every value is held to one line.

**Alerts.** The [auto-mode guard](../../README.md#auto-mode-guard) and the [memory backup](../../README.md#memory-backup) put the open state on each alert they send when their manifest section sets `buzz_task_open_emoji` (and, for a custom emoji, `buzz_task_open_emoji_url`). An all-clear gets none. Setting the state is best effort: a failure is logged, and the alert still counts as sent.

## Who can reach the agent

Without a sender allowlist, anyone who can mention the agent in one of its rooms reaches the session, and the log says so once at start. To limit that to people you name, set either or both of these:

- `BUZZ_ALLOWED_PUBKEYS` (plugin setting `buzz_allowed_pubkeys`): a comma-separated list of public keys, hex or `npub1…`.
- `BUZZ_ALLOWLIST_FILE` (plugin setting `buzz_allowlist_file`): the path to a JSON file of public keys, for a list that changes while the agent runs. A leading `~/` means your home folder.

  ```json
  {
    "entries": [
      { "pubkey": "<64 hex characters or npub1…>" },
      { "pubkey": "<another key>", "label": "any other fields are ignored" }
    ]
  }
  ```

When either is set, a mention or DM is delivered only if its author is in `BUZZ_ALLOWED_PUBKEYS`, in the file, or among the trusted people (`BUZZ_TRUSTED_PUBKEYS`). Everyone else's messages are dropped. The log names each dropped message by its event id and author key, never its text. The other rules in [What reaches the session](#what-reaches-the-session) still apply, so an allowed person still has to mention the agent, except in a trusted one-to-one DM.

- **The file is read again when it changes.** Before each message the channel checks whether the file changed, and reads it again if so. No restart is needed.
- **Replace the file in one step**: write a new file next to it, then rename it over the old one. A half-written file counts as malformed, and messages dropped meanwhile are not delivered later.
- **A dropped message stays dropped.** The channel records its id, so a later catch-up never delivers it, even once its author is allowed. (A key service restarts its channel for each allowlist change, and every restart catches up.) It is recorded only after its signature is checked, so only its real author can put an id there, and a forged copy can never keep the real message out. Dropped ids are kept apart from delivered ones: they never move the cursor and never push a delivered id out, so a flood from someone outside the allowlist cannot make the channel skip or repeat anyone else's messages. They are bounded, 20 per author and 1,000 in all, the oldest going first: past that, a dropped message could come back on a catch-up once its author is allowed. Only a definite refusal is recorded: one made while `BUZZ_ALLOWLIST_FILE` is missing, unreadable, too large or malformed (mid-rewrite, say) only fails closed for now, and a catch-up once the file can be read asks again. And the file is not written for each dropped message, which would let a flood make one write of the whole state file per message: dropped ids are written together, within a second, or at once by the next delivery and when the channel stops; only a crash in that second loses one, which a catch-up then asks about again.
- **Only `pubkey` is read.** Other fields, such as `label` or `description`, are ignored. To remove someone, delete their entry.
- **Problems fail closed, and never stop the channel.** A missing, unreadable or malformed file, or one larger than 1 MB, allows nobody from the file until it is fixed. An entry that is not a valid public key, in the file or in `BUZZ_ALLOWED_PUBKEYS`, is skipped; the log counts skipped entries but never repeats them. Setting a list with no valid key leaves only the trusted people.
- Messages written by the agent itself are never delivered, allowlist or not.
- The allowlist checks the author of a correctly signed message, so nobody can pass it by claiming someone else's key. The one exception is a [workflow message](#workflow-messages), below.

### Workflow messages

A message a Buzz workflow posts is signed by the relay's own key, so its author is the relay and says nothing about who set the workflow up. Without a rule for it, the allowlist would drop every one (unless the relay's key were on it, which would let any workflow in, whoever owns it). The relay stamps the owner on the message, and Block's `buzz-acp` judges such a message by its owner. So does the channel, when all of this holds:

- The relay publishes its key (the `self` field of its NIP-11 document), and it is the message's author. With `*` or direct messages the channel reads that key when it logs in, for the room list; with a list of channels it reads it in the background and never makes the login wait, and tries again at each heartbeat if the read failed. Until the key is known a workflow message is judged by its author, the relay, and that refusal is not kept; when the key arrives, and such a message was held back, the channel asks the relay for the messages since its cursor again (less its two-minute overlap: a workflow message older than that is not asked for again, nor is anything when none was held back). A relay that publishes none gets no special treatment, and the log says so. Anyone can write the stamps below, so a message signed by another key gets none either: it is judged by its author, as always.
- The message is a correctly signed kind 9, with exactly one `["buzz:workflow", "true"]` and exactly one `["buzz:workflow-owner", <public key>]`.
- It has a `["buzz:workflow-mention", <public key>]` for the watched identity (`BUZZ_WATCH_PUBKEY`). The relay writes that stamp only for a name in the owner's own step text, never one that a trigger fills in, so a trigger cannot borrow the owner's standing to wake the agent. A plain `p` tag does not count: the relay also writes one for a name a trigger filled in, and for the owner. The stamp is also what makes the message a mention of the agent.
- Every `buzz:workflow-mention` is one public key, none twice. A stamp that is malformed, doubled or missing voids all of them, and the message is judged by its author, the relay.

Keys are 64 lower-case hex characters. Then the sender allowlist is asked about the owner instead of the author, in all three places that ask it: the delivery, the record of a dropped message, and the `allowlisted` mark in [thread context](#thread-context). The `author` attribute stays the relay's key: it is the real signer. `workflow_owner` is the owner, present only when the owner was judged (so a reader can tell the message was let in through a stamp). The owner scheduled the message; they did not necessarily write every word, since a workflow's trigger can fill in parts of its text. The channel's instructions say so. A workflow the agent itself owns (the owner is the watched identity or the key the channel logs in with) is the agent's own message and is never delivered, allowlist or not, so an agent cannot wake itself through its own workflow; in a thread it ends the context as the agent's own message does. A scheduled self-wake would need that rule lifted. A dropped workflow message is logged with both keys (`author <relay key>, workflow owner <key>`) and is kept, like any dropped message, under the owner: one owner's flood of workflows cannot push out another's.

## Reply guard

The reply guard is a Claude Code Stop hook ([`hooks/reply-guard`](hooks/reply-guard), with its logic in `hooks/reply-guard.py`). The plugin wires it ([`hooks/hooks.json`](../../hooks/hooks.json)), and it is on by default. It enforces one rule: a message from the operator gets its answer on Buzz, where the operator is. A reply in the terminal alone does not reach them.

### What it checks

- **When a turn ends**, it reads the current turn of the session transcript and its own record (below), and nothing else: no relay, no model.
- **The operator's messages:** the channel's own deliveries from the operator. Copies of a `<channel>` tag anywhere else (typed text, tool output, subagents) never count.
- **An answer** is one of these, made after the message arrived and not failed:
  - a Buzz `send` that replies in the message's thread;
  - a `send` that tags the operator in the message's channel (in `mentions`, or in its text as `nostr:npub1…` or `@Name`, outside code);
  - any `send` in the operator's DM;
  - a `react` on the message itself, or the channel's `task` tool on it (a state other than `none`).
  - A `send` with audience `agents` never counts.
- **With [DM task roots](#dm-task-roots) on** (`task_roots`), a DM message from the operator is answered only by a `send` in its thread (or, in a thread, a reaction on it): a tag, `@Name` or a top-level `send` in the DM no longer counts. A top-level DM from the operator needs a state (the `task` tool on it, in its channel, whose result holds its success line, or a reaction helper's success line; the Buzz `react` tool is no state) and a `send` in its thread. A short root (one or two words and at most 40 characters) needs the state alone, unless it was set done. A catch-up root whose thread shows the agent spoke there after it has its answer. The reason names the `task` call, the `send` call, or both, and says to reply to the message itself or its thread's root. The record keeps a `task` call only when its result holds the success line. Channels are unchanged.
- **A catch-up message** also counts as answered when a later message in the same thread shows, by its thread context, that the agent spoke there after it.
- **An unanswered message** blocks the turn from ending, once. The reason names each open message with the `send` call that answers it. The next stop always ends (`stop_hook_active` is the loop valve), and a message still open then is logged as a miss.
- **Messages from anyone else** are never checked.
- **Only the main thread's answers count.** An answer sent by a subagent or a background process does not show in the main transcript, and the record leaves it out too, so the guard blocks that turn once; the next stop ends.
- **Fails open:** any error, a missing python3, or no operator key lets the turn end.

### Its record

Claude Code can write the last tool calls of a turn to the transcript only after its Stop hooks have run. Then a `send` that went through is missing from the file when the guard reads it, and the guard blocked the first stop of the turn even though the operator had the answer: the agent then reacted as well, so the turn cost a second stop and one more model call. In a test of an unattended agent it blocked 9 of the 12 turns examined, and the transcripts show why: each blocked turn had the next model call's request line written before the `send`'s own line, and each turn that passed had them the other way round. Replayed against those transcripts as they stood at Stop time, the guard blocks without the record and passes with it.

So the guard keeps a record of its own:

- **`reply-guard record`** is a PostToolUse hook on the Buzz `send` and `react` tools and the channel's `task` tool. Claude Code runs PostToolUse only for a call that succeeded (a failed call runs PostToolUseFailure instead), and before the next model call, so the record is there before the turn can stop.
- **What it keeps:** one line per call, in `hooks/reply-guard/<session id>.jsonl` in the plugin's data folder: the time, the transcript's size in bytes at that moment, the tool call's id, and what the check needs (the channel, the reply target, the keys the send tags, the operator names it tags as `@Name`, its audience; a reaction's or a task state's event id). Never the message text. Subagents' calls are left out.
- **At Stop:** a recorded call that this turn's transcript does not show counts like one it shows, for a message whose transcript entry ends within the size the record holds: the message was in the transcript, so the agent had seen it, before the call was made. Time cannot say that: a message delivered in the middle of a turn is stamped when it arrives, but the agent sees it only once its entry is written. A record without a size goes by time (the message's entry is older than the record; Claude Code and the hook read the same clock). A call the transcript does show is read from the transcript, which says where in the turn it was and whether it failed. A record left from an earlier turn holds a size from before this turn's messages, so it answers none of them.
- **Its size:** the guard reads the newest 256 KB of a session's record. A record file over 1 MB keeps only its newest 256 KB, and record files untouched for a week are removed when a new session starts one.
- **The log** marks a message answered only through the record with `late=<id>`.

### Its settings

| Plugin setting | Default | Meaning |
|---|---|---|
| `reply_guard` | `on` | `off` turns the guard off, its record too. |
| `buzz_operator_pubkeys` | empty | The operator's public keys, hex or `npub1…`, comma-separated. Empty means the [trusted people](#direct-messages) (`buzz_trusted_pubkeys`). With neither, the guard checks nothing. |
| `buzz_operator_names` | empty | The operator's display names, comma-separated, so that `@Name` in a reply counts as tagging them. The `label` of an operator's key in the [allowlist file](#who-can-reach-the-agent) counts too. |
| `task_roots` | `off` | `on` checks [DM task roots](#dm-task-roots) (the rules above). Set it with the channel's own `task_roots`. |
| `reply_guard_helpers` | empty | Comma-separated names of your own reaction scripts, such as `react.sh`. A Bash call of one, `<helper> <event id> [<state>]` (a state other than `clear`), counts as a reaction to that event. It counts only when its output holds a success line for that id: `<first 8 hex>: <old> -> <new>` or `<first 8 hex>: + <reaction>`. A change to `none` is a removal and does not count. |

Hooks get the plugin's settings as `CLAUDE_PLUGIN_OPTION_<KEY>` environment variables, and only the saved ones; an unset `reply_guard` is on.

### Its log

- One line per decision goes to `hooks/reply-guard.log` in the plugin's data folder; without the plugin, `~/.local/state/ghost-protocol/hooks/`.
- Each line holds ids only, never message text.
- The guard needs python3 3.9 or later.

## Root limit

A channel or a DM reads best as a list of short roots: the reader scrolls the top level, sees many threads on one screen, and opens the one to dive into. One long root fills the screen and pushes the others away. The root limit keeps every top-level post short, for every agent on the plugin, so the rule does not depend on the agent remembering it.

It is a Claude Code PreToolUse hook on the Buzz `send` tool ([`hooks/root-limit`](hooks/root-limit), with its logic in `hooks/root-limit.py`), wired in [`hooks/hooks.json`](../../hooks/hooks.json) and on by default. Its matcher, `^mcp__.*buzz__send$`, also takes the `send` tool of any other MCP server whose name ends in `buzz`; that is harmless, since such a tool would post to Buzz too.

### What it checks

- **A root** is a `send` with a `channel` and no `reply`: a `reply` counts only as a string that is not empty once trimmed, as buzz-mcp reads it. A DM's top level is a root like a channel's. Roots with audience `agents`, and roots a subagent sends, are limited too.
- **A send with neither `channel` nor `reply` is a root too,** measured like any other (fail closed). Under a runtime that threads such a send by its own context, pass `reply` explicitly to post long text.
- **Replies are never limited,** whatever their size, in a channel or a DM.
- **The limit:** at most 5 non-empty lines and at most 400 characters, by default. The text is measured with its leading and trailing whitespace trimmed.
  - A line counts when it holds anything but whitespace. A fenced code block's lines count, the fences included, and so does every row of a markdown table, the separator row included. Every line break Python knows splits lines (`\n`, `\r\n`, U+2028 and the rest).
  - Characters are Unicode code points, not bytes: `é`, `字` and `🙂` are one each. An emoji sequence (a skin tone, a flag, a family joined with zero-width joiners) is several. Line breaks count.
  - A link counts as 20 characters, so a root that links two messages (about 130 characters each) is not refused for its links. That holds for the first three links in a root, each with the `http`, `https` or the chat's own message-link scheme, made only of URL characters (the RFC 3986 set and `%`, so a zero-width space or any other Unicode ends it), and at most 200 characters long. Any other link, and text merely shaped like one (`x://` and a long run of letters), counts in full.
- **Attachments** (`files`) count too. buzz-mcp adds one line to the posted text per file: an image or video (png, jpeg, gif, webp, mp4) shows as media, any other file as a link whose text is its name (up to 255 bytes). So each file counts as one line, and as 20 characters for an image or video (by its name's extension) or as its name's length otherwise. A `files` that is not a list, or an entry that is not a string, counts as the worst case: one line and 255 characters.
- **A root with `path`** (its text read from a file) is refused: the hook does not read the file, so it cannot measure it. The agent posts a short root with `text`, then sends the file in a reply.
- **A longer root is refused,** and nothing is sent. The hook never cuts or rewrites the text. The refusal the agent sees names the limits and the root's own numbers, and says what to do:

  ```
  Root limit: top-level posts are limited to 5 lines and 400 characters so a channel shows many threads on one screen (a link counts as 20 characters; each attached file is a line, and a file that is not an image counts its name). This one has 9 non-empty lines and 812 characters, and nothing was sent. Post a short root (a title and one or two lines), then put the rest in a reply to it (a send with `reply` set to the root's event id). ... Put any `mentions` on the reply that carries the detail, not on the short root, so whoever is woken lands on it. ...
  ```

- **Nothing in the message counts.** The hook reads only the call's `reply`, `channel`, `path` and `text`; words in the text, or extra fields in the call, grant no exception.
- **Fails open:** a missing python3 or the hook's own error lets the send through, as the reply guard lets a turn end; so does input that cannot be read, unless it could name the send tool (a nesting too deep to parse, say, even with the name written in `\u` escapes), which is refused, as is a send that runs the hook out of memory. The nesting is counted in one pass, so no input can run the hook past its timeout that way. The wrapper always exits 0, since an exit 2 from a PreToolUse hook would block every send. **The pass is the exception: it fails closed.** Any error in it (a pass the hook cannot read, a use count it cannot read or write, an `until` that is no real date) is no pass, and the long root is refused.

### Exceptions

Three, all the operator's:

1. **Exempt channels:** `root_limit_exempt` lists the channels whose roots are not limited, for example a channel whose roots are generated boards.
2. **A channel's own limit:** `root_limit_channels` gives single channels their own numbers, as `<channel id>=<lines>:<chars>`.
3. **A one-time pass:** a file only root can write, `/etc/ghost-protocol/root-limit-pass.json`, lets a set number of longer roots through in one channel (or any) until a time:

   ```sh
   sudo install -d -o root -g root -m 755 /etc/ghost-protocol
   printf '%s\n' '{"channel":"<channel id or *>","until":"2026-11-11T18:00:00Z","posts":1}' \
     | sudo tee /etc/ghost-protocol/root-limit-pass.json >/dev/null
   sudo chmod 644 /etc/ghost-protocol/root-limit-pass.json
   ```

   - **Mode 644, so the agent can read it.** The hook runs as the agent's user. A pass it cannot read (`chmod 600`, or a root umask of 077) grants nothing: the long root is refused.

   - It counts only when it is a plain file (no link), owned by root and writable by no group or others, with every folder above it owned by root and writable by no group or others. That is the rule the [key service](#key-service) holds the sender allowlist to.
   - Its path is fixed in the hook, never read from the environment or a setting. On macOS, where `/etc` is a link to `/private/etc`, the hook reads `/private/etc/ghost-protocol/root-limit-pass.json` (the same file); the tests run on Linux only.
   - `until` is UTC, still to come, and at most 24 hours from the moment of the send: a pass written for three days ahead counts only once it is within a day. No file time counts (a hard link or a metadata change could move one). `posts` defaults to 1.
   - Only over-limit roots use it. Each use is counted in the hook's state folder (`hooks/root-limit-pass.used` in the plugin's data folder) by a hash of the pass's bytes: a pass with new words (a new `until`, say) starts a new count, and the same pass written again keeps its count. A pass is used when the hook allows the send, so a send that then fails still counts. Two sends checked at the same moment can both read the count before either writes it, so a one-post pass can let two through then.
   - To end a pass early, remove the file (`sudo rm`).

**What the agent can and cannot change.** The plugin settings live in settings files the agent's own user can write: the user settings and the instance's settings file. So exceptions 1 and 2, and the switch itself, are an honour system, like every other plugin setting: an agent that edits them gets its way from its next start or `/reload-plugins`. The pass is the operator's alone: the agent cannot write a root-owned file in a root-owned folder. It can delete the use count in its own state folder and so use a live pass again until it expires; the expiry bounds that. On a machine where the agent's user has passwordless sudo, nothing on that machine is the operator's alone, as the [auto-mode guard](../../README.md#auto-mode-guard) says too.

### What it does not cover

- **`edit`.** buzz-mcp's `edit` can make a posted root longer. The hook cannot tell from an edit's input whether the message is a root.
- **The one-shot send** (`launch.mjs send`, run through Bash) takes its text on stdin, out of the hook's sight.
- **Alerts** of the auto-mode guard and the memory backup are sent by their systemd units, outside Claude Code.
- **Which attached files are media.** buzz-mcp decides by the file's bytes, which the hook does not read; the hook goes by the name's extension. A file named like an image that is not one shows its name, up to 255 bytes, on its line while the hook counts it as 20; its line still counts.

### Its settings

| Plugin setting | Default | Meaning |
|---|---|---|
| `root_limit` | `on` | `off` turns the limit off. |
| `root_limit_lines` | empty: 5 | The most non-empty lines a root may have. A value that is not a whole number of at least 1 is the default. |
| `root_limit_chars` | empty: 400 | The most characters a root may have, each of its first three links (up to 200 URL characters) counting as 20, and each attached file counted (see above). A value that is not a whole number of at least 1 is the default. |
| `root_limit_exempt` | empty | Comma-separated channel ids (a DM's channel id too) whose roots are not limited. |
| `root_limit_channels` | empty | Comma-separated `<channel id>=<lines>:<chars>`: those channels use these limits instead. An entry that does not parse is ignored, and the log counts it (`bad_limits=`). An exemption wins over a channel's limit. |

A changed setting takes effect when Claude Code next starts, or after `/reload-plugins`.

### Its log

- One line per decision goes to `hooks/root-limit.log` in the plugin's data folder; without the plugin, `~/.local/state/ghost-protocol/hooks/`.
- Each line holds the session's id, the decision and why, the channel id and the numbers (lines, characters, limits), never message text.
- The hook needs python3 3.9 or later.

## One-shot send

```sh
printf '%s' "the text" | BUZZ_RELAY_URL=https://relay.example.com BUZZ_KEY_COMMAND="op read op://vault/item/field" \
    node src/launch.mjs send --channel <channel-id> [--mention <pubkey>]... [--reply <event id>]
```

- **What it sends:** one channel message, the way Buzz's own tools write one: kind 9, an `h` tag naming the channel, a `p` tag per `--mention` (hex or `npub1…`; that is what notifies someone), and an `ms` tag. The text comes on stdin, at most 32 KB.
- **In a thread:** with `--reply <event id>` (a thread root, 64 hex characters) the message goes into that root's thread, with one `e` tag carrying the `reply` marker, as Buzz files a reply to a root.
- **Login:** it answers a NIP-42 challenge whenever one comes. A relay that sends one at once gets the message only after it accepts the login. A relay that sends none within three seconds gets the message without one; if it then refuses it with `auth-required:` and sends its challenge, the send logs in and sends the same message once more. With `BUZZ_AUTH_TAG` set, every login carries the owner's attestation, as the channel's does (see [Logging in through the owner](#logging-in-through-the-owner)).
- **The key:** it comes from `BUZZ_KEY_COMMAND` through the launcher, as for the servers, or, in a [key service](#key-service), from the file descriptor systemd hands `serve send`. It is never printed, and leaves the send's environment once read.
- **Exit 0:** the relay accepted the message, and stdout says `sent <event id>`.
- **Exit 1:** the relay refused the login, closed the connection, could not be reached, or did not answer within `BUZZ_SEND_TIMEOUT_MS` (default 30000).
- **Exit 2:** a usage error, an empty or too long text, or a bad setting (a malformed `BUZZ_AUTH_TAG` among them) or key. Nothing is sent.
- **Exit 3:** the relay refused the message; stderr gives its reason.

## One-shot task

```sh
BUZZ_RELAY_URL=https://relay.example.com BUZZ_KEY_COMMAND="op read op://vault/item/field" \
    node src/launch.mjs task set --channel <channel-id> --id <event-id> --state open|done|emergency|none [--reopen]
node src/launch.mjs task list --channel <channel-id>[,<channel-id>...] [--trusted <pubkey>]... [--max <n>]
```

The [DM task roots](#dm-task-roots) tools for a process outside the session, such as the alert senders: the same states, reactions (`BUZZ_TASK_OPEN_EMOJI`, `BUZZ_TASK_DONE_EMOJI` and their `_URL`s) and moves as the channel's tools ([`src/task-cli.mjs`](src/task-cli.mjs)). `set` prints `<first 8 hex of the id>: <old> -> <new>`, the success line the reply guard reads from a reaction helper, so a helper script can call it. The line is always bare: a note (an earlier reaction that could not be removed) goes to stderr. `list` shows a root's first line only when the agent or a `--trusted` key wrote it. It logs in as the one-shot send does, and the key reaches it the same way; with a key service's socket set it is refused (use the channel's tools). Exit 0: done. Exit 1: the relay refused the login, could not be reached or did not answer within `BUZZ_SEND_TIMEOUT_MS`. Exit 2: usage, or a bad setting, key or argument. Exit 3: the relay refused an event or a read. Exit 4: the move is refused (a done root is never reopened without `--reopen`).

## One-shot thread read

```sh
BUZZ_RELAY_URL=https://relay.example.com BUZZ_KEY_COMMAND="op read op://vault/item/field" \
    node src/launch.mjs thread --channel <channel-id> --root <event id>... [--author <pubkey>] [--since <unix time>]
```

- **What it prints:** one JSON line per reply in the threads of the `--root` events (at most 20), oldest first: `{"id", "pubkey", "created_at", "root", "content"}`, the content cut to 1000 characters.
- **What it checks itself,** whatever the relay's filter did: each reply is a correctly signed kind 9 (the signature is checked here, so `pubkey` is the key that really wrote it), in exactly this channel, a reply in one of those threads and never a root, by `--author` when given, and no older than `--since`. A caller that acts on a reply still checks the author itself; the auto-mode guard does.
- **Login and the key:** as for the send, the key used only for the relay login. It has no key service side and no socket: `serve thread` and a `BUZZ_KEY_SOCKET` session refuse it.
- **Exit 0:** the relay answered, with or without replies. **Exit 1:** the relay refused the login or the request, closed the connection, could not be reached, or did not answer within `BUZZ_SEND_TIMEOUT_MS` (default 30000). **Exit 2:** a usage error, or a bad setting or key. Nothing is printed then.

## Status line

Off by default (`status_line`, `BUZZ_STATUS`). When on, the channel publishes one short public line about the agent, and its presence, to the relay. **This section is the line's one contract:** the channel's `agent_status` tool, the one-shot `status read`, and any other reader follow it.

### The line

A NIP-38 user status: kind 30315, one tag `["d","general"]`, and for working and waiting lines a NIP-40 tag `["expiration","<unix seconds>"]`. The content is one line:

```
<state>[ | task: <text>][ | waits on: <text>]
```

- `state` is `working` (in a turn), `idle`, or `waiting` (no turn, and something awaited). `idle` has neither text. `working` may name a task. `waiting` always names what it waits on, and may name the task.
- Each text is at most 50 characters, and the whole line at most 100 (UTF-16 units, as JavaScript counts): Buzz's app drops a longer status. Longer text is cut and ends with `…`; when the whole line would be too long, the task is cut first. In both texts, line breaks and control characters become spaces, runs of spaces one space, and `|` becomes `/`, so the line parses one way only.
- With no task named, work from a thread in a **public channel** has the task `task <first 8 hex of the thread's root id>`. Work from a **DM or a private channel** has none: the line is plain `working` (or `waiting | waits on: …`) until the agent names the task with its `status` tool. A channel counts as public only when its metadata (kind 39000) carries Buzz's `["public"]` tag, does not also carry `["private"]`, and the room is not a DM (a DM whose metadata says `["public"]` still counts as private); a room whose metadata is missing, or says neither, counts as private. A root the `task` tool opens, but that no delivery from a public channel brought, has no fallback either.
- Examples:
  - `working | task: #42 fix the login timeout`
  - `idle`
  - `waiting | task: update to version 0.16.0 | waits on: the operator's yes`
  - `waiting | waits on: a person to allow a step`
- **Expiry:** a working or waiting line expires 30 minutes after it is sent, and is sent again every 10 minutes while it still holds. When that resend falls due while the connection is down, the same line goes out again at the next login, so a line that still holds never expires. An `idle` line never expires. Buzz's relay does not apply NIP-40 itself, so a reader compares the tag with its own clock: an expired line no longer holds (the agent stopped mid-task). Buzz's app does the same.
- **Presence:** kind 20001, content `online` (no tags, as Buzz's app sends it), at login and every 60 seconds on the channel's own connection; Buzz holds it for 180 seconds. `offline` at a clean stop. Buzz also clears it when the agent's last connection closes.

### What a member can learn

The line and presence are public: every member of the relay can read them, as can anyone they show them to. From them a member learns, for the agent's key:

- whether it is online, and when it was last seen to change state;
- whether it is in a turn (working), idle, or waiting;
- when it named no task and the work came from a public channel, the first 8 hex of that thread's root id (every member can open a public channel, so this names a thread they can already see). Work from a DM or a private channel shows no id: only that the agent is working;
- the words the agent itself gave its `status` tool for its task and what it waits on;
- that a permission dialog was refused (`a person to allow a step`), in unattended mode.

Nothing else goes in. The line is built from fixed words, event ids, and the agent's own `status` words only: the channel passes the publisher a delivered message's root id and whether its room is a public channel, and nothing of its text, sender or channel, and the turn marker's word (`busy`, `idle`), never its prompt id. So a DM's text, or a private channel's, cannot reach the line. `test/status.test.mjs` proves that against the fake relay. The `status` tool's description tells the agent to name a task by its issue id and a few plain words, and never a customer's name, an address, a secret, a path under a customer's tenant, or words from a DM. The tool also refuses, with a one-line answer and no change, words that look like a key (an `nsec1`, `npub1` or other Nostr string, or a run of 64 hex), a token (a run of 32 or more letters, digits and `_-+=` that mixes letters and digits) or a path (any `/` or `\`). It checks the words as given, before cutting, so a cut cannot hide a key.

### When it is sent

- **Inputs, all local:** the turn marker that [`hooks/turn-state`](../../hooks/turn-state) keeps (busy at a turn's start, idle at its end); a message delivered to the session (working at once, with its root); the `task` tool (open sets the root; done or none clears the root's name and wait); the `status` tool; and, in unattended mode, the `status-wait` file that `hooks/unattended-deny` leaves in the instance's state folder when it refuses a dialog of the instance's own claude (waiting for a person, until the next turn starts). The hook makes the same own-claude check as the turn-state hook, so a `claude -p` the agent runs still gets its dialog denied, but leaves no wait.
- **Rate:** a change waits 3 seconds to settle, so a quick turn sends only its result. At most one line every 15 seconds, and none when it is the line already sent.
- **Restart:** the first login sends the current line at once (`idle`, as a fresh session has no turn yet). A later login sends a change, or the same working or waiting line again when its 10-minute resend fell due while the connection was down.

### Where it runs

- Only in the instance's own session: `GP_INSTANCE_NAME` set by [`install/service/start`](../../install/service/start), and the first claude above the channel the one whose pid start wrote to `pane-pid` (as for the session-id and turn-state hooks). A `claude -p` that the agent runs loads its own channel, which publishes nothing. Without `GP_INSTANCE_NAME` the setting has no effect, and the log says so.
- Not with a [key service](#key-service): there the channel runs as the key's user, which cannot read the session's turn marker. The setting has no effect, and the pipe and the log say so.

### Reading lines

The channel's `agent_status` tool (listed when the status line is on, or `status_agents` is set) and the one-shot read return the same rows:

```sh
BUZZ_RELAY_URL=https://relay.example.com BUZZ_KEY_COMMAND="op read op://vault/item/field" \
    node src/launch.mjs status read [--agent <pubkey>]...
```

With no `--agent`, it reads `BUZZ_STATUS_AGENTS` and the key's own. It prints one JSON line per agent:

| Field | Meaning |
|---|---|
| `pubkey` | The agent's key, hex. |
| `name` | Its profile's (kind 0) display name or name, or null. |
| `line` | The newest line as sent, on one line, or null when it never sent one. |
| `state` | `working`, `idle` or `waiting`; `unknown` for a line not in this grammar (`line` keeps it, for a person to read); `none` for no line or an empty one. |
| `task`, `waits_on` | The line's texts, or null. |
| `set_at`, `expires_at` | Unix seconds: when the line was sent, and its expiry (null for none). |
| `expired` | true when `expires_at` has passed by the reader's clock: the line no longer holds. |
| `presence` | `online`, `away`, `offline` (the relay holds none), or `unknown` (the read failed). |

What the read checks itself: each line and profile is correctly signed by the agent it names, a line has one `d` tag, `general`, and no channel, and the newest wins. Presence comes from Buzz's snapshot, `POST /query` with `{"kinds":[20001],"authors":[…]}` signed with NIP-98 (and the owner's tag in `x-auth-tag`, when set): only events signed by the relay's own key (its NIP-11 `self`), one `p` tag each, for an asked agent, count; any other answer makes presence `unknown`. Exit 0: read (a failed presence read too). Exit 1: the relay refused the login, closed the connection, could not be reached, or did not answer within `BUZZ_SEND_TIMEOUT_MS`. Exit 2: usage, or a bad setting, key or argument. Exit 3: the relay refused the read.

## Reconnect and catch-up

- After a dropped connection the channel reconnects with exponential backoff (1 second, doubling, at most 60 seconds, with jitter). A relay behind a proxy or CDN may drop connections now and then (close code 1006); the channel is back within seconds and catches up. The delay starts again from 1 second once a connection has caught up.
- A reconnect that fails is retried the same way, however it fails: a relay that is restarting, a proxy answering 502 or 503 instead of the WebSocket upgrade, a refused connection or a DNS failure. Node.js reports a failed opening handshake with an error event only, never a close event, so the channel treats any error as the end of that connection.
- A connection that has not opened within 15 seconds (`BUZZ_CONNECT_TIMEOUT_MS`) is given up and retried, and so is an open one that has not finished login and catch-up within about a minute.
- Keep-alive works both ways. The relay pings every 30 seconds and closes a connection after three unanswered pings; Node.js answers each ping automatically. The channel also sends a small probe every 30 seconds. If the relay has not answered by the next probe, the connection is treated as dead and replaced. This catches connections that hang without closing, for example after the machine sleeps.
- If the relay closes the subscription after login, the channel reconnects instead of waiting on a dead subscription.
- A connection that is closing but never closes is replaced at the next probe. And a watchdog that runs every 30 seconds for as long as the channel does reconnects whenever there is no connection and no reconnect pending, whatever led there.
- Every connect, drop, failed attempt and reconnect is logged with its reason (see [Log](#log)).
- It keeps a cursor: the id and time of the newest delivered message. On every connection and restart it asks the relay for everything since the cursor, minus two minutes of overlap. It delivers the missed messages oldest first, then live ones.
- It remembers the ids it delivered, so the overlap and any replays are never delivered twice, across reconnects and restarts; and, apart from them, those the sender allowlist dropped, so a dropped message is not delivered later (see above).
- On its very first start it begins at the current time and replays nothing older.

## Log

The channel logs connects, drops, reconnects with their delay, catch-ups, deliveries and skipped messages. Each line goes to two places:

- stderr. Claude Code shows a server's stderr only while it starts, so later lines are not shown there. When nothing reads stderr, lines past a small backlog go to the file only.
- A log file, by default `channel.log` in the state folder: with the plugin, `buzz/state/channel.log` in the plugin's data folder (for Claude Code, under `~/.claude/plugins/data/`). Set `BUZZ_LOG_FILE` to put it elsewhere.

The file is owner-only. At 1 MB it is renamed to `channel.log.1`, replacing the previous one, so at most about 2 MB is kept. Like stderr, it holds ids, public keys, times and reasons, never message text and never key material. If the file cannot be written, the channel says so once on stderr and carries on.

## Install

1. Install the Ghost Protocol plugin (see the [top-level README](../../README.md)). Claude Code asks for the settings in the next section.
2. Build buzz-mcp, which Block does not publish as a package:

   ```sh
   git clone https://github.com/0xnfrith/ghost-protocol
   ghost-protocol/adapters/buzz/scripts/build-buzz-mcp.sh
   ```

   This needs git, Node.js with corepack (or pnpm), and network access to GitHub and npm. `block/buzz-app` asks for Node.js 24; the build also works on Node.js 22, with an engine warning. The channel itself needs Node.js 22 or later. See [buzz-mcp](#buzz-mcp) below.
3. Allow the channel in Claude Code's managed settings: `/etc/claude-code/managed-settings.json` on Linux, `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS. Only an admin can write that file. Add these two keys to it, keeping any others it has:

   ```json
   {
     "channelsEnabled": true,
     "allowedChannelPlugins": [
       { "marketplace": "ghost-protocol", "plugin": "ghost-protocol" }
     ]
   }
   ```

   `allowedChannelPlugins` replaces Anthropic's list of approved channel plugins, so list there any other channel plugin the machine uses too. The installer does not write this file yet.
4. Start a session with the channel:

   ```sh
   claude --channels plugin:ghost-protocol@ghost-protocol
   ```

   No dialog asks you to confirm the channel. A notice under the banner says the channel is registered. An instance's service ([`install/service/start`](../../install/service/start)) starts claude the same way, with `--channels` after the session's own flags. It refuses to start when the managed settings do not allow the channel: `start --dry-run` shows that check, and `start --test` proves the channel registers with no dialog.

The channel installs its own Node.js dependencies (`npm ci` from the lockfile, without install scripts) into this folder the first time it starts.

### Without the plugin

You can run the adapter from a clone instead. Put a `.mcp.json` like this in the folder you start Claude Code from, with the paths changed to your clone:

```json
{
  "mcpServers": {
    "buzz-channel": {
      "command": "node",
      "args": ["/path/to/ghost-protocol/adapters/buzz/src/launch.mjs", "channel"],
      "env": {
        "BUZZ_RELAY_URL": "https://relay.example.com",
        "BUZZ_KEY_COMMAND": "op read op://<vault>/<item>/<field>",
        "BUZZ_CHANNELS": "<channel-id>"
      }
    },
    "buzz": {
      "command": "node",
      "args": ["/path/to/ghost-protocol/adapters/buzz/src/launch.mjs", "buzz-mcp"],
      "env": {
        "BUZZ_RELAY_URL": "https://relay.example.com",
        "BUZZ_KEY_COMMAND": "op read op://<vault>/<item>/<field>"
      }
    }
  }
}
```

Then start the session with `claude --dangerously-load-development-channels server:buzz-channel`, and confirm the development-channel warning. `allowedChannelPlugins` names plugins only, so a server from `.mcp.json` still needs the development flag.

## Settings

The plugin asks for the settings that have a plugin name. The rest are environment variables for unusual setups.

| Plugin setting | Variable | Required | Meaning |
|---|---|---|---|
| `buzz_relay_url` | `BUZZ_RELAY_URL` | yes, without a key service | The relay, as `https://` or `wss://`. |
| `buzz_key_command` | `BUZZ_KEY_COMMAND` | yes, without a key service | A command that prints the agent's relay private key, as 64 hex characters or `nsec1…`. Run with `/bin/sh -c`. With `buzz_key_socket` set, leave it empty. |
| `buzz_key_socket` | `BUZZ_KEY_SOCKET` | no | The folder of a [key service](#key-service)'s sockets, for example `/run/ghost-protocol-key/<instance>`. Empty (the default): the key command above. Set, the session holds no key, and the relay, channels and the other settings below are the key service's. |
| `buzz_channels` | `BUZZ_CHANNELS` | yes, without a key service | Comma-separated channel ids to listen in, or `*` on its own for every channel the agent is in (see [All my rooms](#all-my-rooms)). |
| `buzz_watch_pubkey` | `BUZZ_WATCH_PUBKEY` | no | Whose mentions to deliver, hex or `npub1…`. Defaults to the public key of the agent's key. Messages written by this identity, or with the agent's own key, are never delivered. |
| `buzz_dm_messages` | `BUZZ_DM_MESSAGES` | no | `mentions` (the default): DMs deliver only mentions, as channels do. `all`: in a one-to-one DM with a trusted person, every message they send. |
| `buzz_trusted_pubkeys` | `BUZZ_TRUSTED_PUBKEYS` | no | Comma-separated public keys (hex or `npub1…`) whose one-to-one DMs deliver every message when `BUZZ_DM_MESSAGES` is `all`. Empty by default; nobody is trusted implicitly. |
| `buzz_allowed_pubkeys` | `BUZZ_ALLOWED_PUBKEYS` | no | Comma-separated public keys (hex or `npub1…`) whose messages may reach the agent. Setting this or `BUZZ_ALLOWLIST_FILE` turns on the sender allowlist (see [Who can reach the agent](#who-can-reach-the-agent)). |
| `buzz_allowlist_file` | `BUZZ_ALLOWLIST_FILE` | no | A JSON file of allowed public keys, read again when it changes. |
| `task_roots` | `BUZZ_TASK_ROOTS` | no | `on`: [DM task roots](#dm-task-roots), in the channel's instructions. `off` (the default): no task states (a DM is still answered in its thread). The reply guard reads the same plugin setting; with a key service the channel reads `BUZZ_TASK_ROOTS` from the key service's settings instead, so set both. |
| `task_open_emoji`, `task_done_emoji` | `BUZZ_TASK_OPEN_EMOJI`, `BUZZ_TASK_DONE_EMOJI` | no | The reactions of the open and done states: a plain emoji, or a custom emoji's name. Defaults: ⭕ and ✅. |
| `task_open_emoji_url`, `task_done_emoji_url` | `BUZZ_TASK_OPEN_EMOJI_URL`, `BUZZ_TASK_DONE_EMOJI_URL` | no | A custom emoji's image, `https://`. Empty for a plain emoji. A bad emoji setting turns the task tools off (they answer with the reason, and the log says it at start); the channel keeps running. A plain emoji is no ASCII and no space, at most 64 bytes. |
| `buzz_operator_pubkeys` | `BUZZ_OPERATOR_PUBKEYS` | no | The reply guard's operator (see [its settings](#its-settings)). The channel reads it only to warn at start when task roots are on and an operator key is not trusted. |
| `status_line` | `BUZZ_STATUS` | no | `on`: the [status line](#status-line) and presence. `off` (the default): none. |
| `status_agents` | `BUZZ_STATUS_AGENTS` | no | Comma-separated public keys (hex or `npub1…`) that `agent_status` and `status read` read by default, besides the agent's own. Empty by default. |
| `buzz_mcp_path` | `BUZZ_MCP_PATH` | no | A built `buzz-mcp.mjs` to use instead of the one the build script makes. |
| | `BUZZ_AUTH_TAG` | no | The owner's NIP-OA `auth` tag, as one JSON array: `["auth", "<owner public key, 64 hex>", "<conditions>", "<signature, 128 hex>"]`. When set, the channel and the one-shot send add it to their relay logins (see [Logging in through the owner](#logging-in-through-the-owner)). Unset, the logins are as before. A malformed value stops the channel at start, and the send before it connects (exit 2), with a fixed message. |
| | `BUZZ_STATE_DIR` | no | Where the cursor and the log file are kept. Defaults to the plugin's data folder, or `~/.local/state/ghost-protocol/buzz` without the plugin. |
| | `BUZZ_LOG_FILE` | no | The log file (see [Log](#log)). Defaults to `channel.log` in the state folder. The log also goes to stderr. |
| | `BUZZ_MCP_CACHE` | no | Where the build script puts buzz-mcp and where the launcher looks for it. Defaults to `~/.cache/ghost-protocol/buzz`. |
| | `BUZZ_CATCHUP_MAX_AGE` | no | The oldest message, in seconds, that catch-up replays. Defaults to 86400 (one day). |
| | `BUZZ_ROOMS_REFRESH_MS` | no | How often the room list is read again, besides on a join or removal notice and on reconnect. Defaults to 60000 (one minute). |
| | `BUZZ_BACKOFF_MS`, `BUZZ_BACKOFF_MAX_MS`, `BUZZ_HEARTBEAT_MS` | no | Reconnect, probe and watchdog timing. Defaults: 1000, 60000, 30000. |
| | `BUZZ_CONNECT_TIMEOUT_MS` | no | How long a connection may take to open before it is given up and retried. Defaults to 15000. |
| | `BUZZ_CHANNEL_LOCK` | no | `on`: only one channel listens per cursor (see below). `off` (the default): no lock, as before. |
| | `BUZZ_STATUS_SETTLE_MS`, `BUZZ_STATUS_GAP_MS`, `BUZZ_STATUS_PRESENCE_MS`, `BUZZ_STATUS_POLL_MS` | no | The [status line](#status-line)'s timing, for tests: the settle, the gap between lines, the presence beat, and how often the turn marker is read. Defaults: 3000, 15000, 60000, 1000. |
| | `BUZZ_KEY_SOCKET_WAIT_MS` | no | How long the [pipe](#key-service) keeps trying to reach a key service that has not answered yet. Defaults to 10000. |

buzz-mcp also reads its own variables, which the launcher passes through unchanged: `BUZZ_MCP_ROOT`, the only folder its `path` and `files` arguments may read (default: the session's working folder), `BUZZ_CHANNEL`, the channel its tools default to, and `BUZZ_AUTH_TAG`, the same owner's tag the channel and the one-shot send read. buzz-mcp sends it with each request to the relay, adds it to the events it signs, and its memory tools need it.

Run one session per watched identity. Two sessions with the same settings would share one cursor. To rule that out, set `BUZZ_CHANNEL_LOCK=on`. The channel then holds a lock file beside its cursor (`<cursor file>.lock`) and touches it every second. A second channel with the same cursor waits up to 8 seconds for the first to stop, then refuses (exit 1, and it says so). A lock whose holder was killed goes stale after 5 seconds and is taken over.

### Logging in through the owner

A relay such as Buzz can admit a key that is not a member itself, when the key's owner has signed a NIP-OA attestation for it (an `auth` tag: the owner's public key, a list of conditions such as an expiry, and the owner's signature). On a WebSocket login Buzz reads that attestation from the NIP-42 AUTH event. Without it, such a key is refused: the channel hears nothing (`relay refused AUTH: restricted: not a relay member` in the [log](#log)), and the one-shot send sends nothing (`the relay refused the login: restricted: not a relay member`, exit 1).

- Set `BUZZ_AUTH_TAG` to the tag. The channel and buzz-mcp read it from the environment Claude Code starts in. The one-shot send reads it from its own environment, so whatever runs the send must pass it on. Each of the adapter's three logins then sends it:
  - the channel, as the one `auth` tag of its NIP-42 AUTH event;
  - the [one-shot send](#one-shot-send), the same way, in its own AUTH event;
  - buzz-mcp, as an `x-auth-tag` header on each request to the relay, and as a tag on the events it signs.
- It is not a plugin setting, because it changes whenever the owner signs a new one. For an instance run by [`install/service/start`](../../install/service/start), a credential named `buzz-auth-tag` in the instance's drop-in (`LoadCredential=buzz-auth-tag:<file>`) becomes `BUZZ_AUTH_TAG`. After the owner signs a new tag, replace the file and restart the instance.
- With a [key service](#key-service) this changes: the tag goes to the key service, not to the instance's drop-in, and never into Claude Code's environment, which needs none (`install/service/start` refuses to export it there). Each key unit loads it with `LoadCredential=buzz-auth-tag:<file>`, and `serve` reads it from there; `install/keyservice/setup --tag <file>` installs it. After the owner signs a new tag, replace that file and restart the instance: a pipe cannot hand a running MCP session over to a new server, so the tag is read again only on a new connection.
- The channel and the send check only its shape, with the same code. The relay checks the signature and the conditions, so a tag past its expiry is refused at the next login.
- The tag is public: every login carries it, and buzz-mcp puts it on every event it signs. It is still never repeated in an error message.
- The channel's start line in the log says when it logs in with an owner's attestation, and names the owner's key by its first 12 characters.
- A key that is a relay member itself needs none of this. Leave the setting unset.

## Security

**The private key.**

- The key comes from `BUZZ_KEY_COMMAND`. The launcher keeps the command's output in memory and discards its error output, so a misbehaving command cannot print the key into a log. If `BUZZ_KEY_COMMAND` is not set, a key already in `BUZZ_PRIVATE_KEY` is passed through, for a wrapper that fetches the key itself. Never write the key into `.mcp.json` or the plugin settings.
- Put a command in `BUZZ_KEY_COMMAND`, never the key itself (not `printf <key>`): the command runs through `sh -c`, and its arguments are visible in process listings.
- The key is never written to disk or logged. Error messages about a bad key are fixed text and never repeat the value.
- Each server gets the key in its own environment, and nothing else does; the key command itself is not passed on. The channel removes the key from its environment as soon as it starts and uses it only to answer the relay's login challenge (NIP-42).
- Other processes running as the same user can read a process's environment on some systems. Run the agent under a user you trust. To keep the key away from the session's processes altogether, use a [key service](#key-service).
- Give the agent its own key. Do not use your personal key.

**Who can reach the session.** Without a sender allowlist, any member of one of the agent's rooms who mentions the agent can put text in front of Claude, in a channel or a DM. With `*`, that is every room the agent is in, now and later: anyone who adds the agent to a room widens the audience. Turn on the [sender allowlist](#who-can-reach-the-agent) to limit it to the people you name. Without a mention, only the trusted people you list reach the agent, in their one-to-one DMs with it, and only when `BUZZ_DM_MESSAGES` is `all`. The channel tells Claude to treat message text as a request from that person, not as instructions, but prompt injection is still possible, also from people you allowed. [Thread context](#thread-context) widens this: anyone who can post in a thread the agent is mentioned in puts text in front of Claude as context, allowlisted or not (marked when not). Keep the channel list short, and keep Claude Code's permission prompts on.

**No remote approvals.** The channel does not take part in permission relay. Tool approvals happen only in the terminal.

**The state file** holds event ids and timestamps only, and for a message the sender allowlist dropped, the public key it refused (its author's, or its workflow's owner's): never message text. It is written with owner-only permissions (`0600`, in a `0700` folder).

**buzz-mcp can read local files.** Its `send` tool can attach files from `BUZZ_MCP_ROOT`, which defaults to the session's working folder. A message that talks Claude into attaching a file could post that file to the channel. Point `BUZZ_MCP_ROOT` at an empty folder, or one that holds only what the agent may share. With the plugin, set it in the environment you start Claude Code from.

**buzz-mcp** is Block's code. The build script fetches it at one pinned commit, installs from its lockfile without install scripts, and prints the checksum of what it built.

## Key service

Without one, the key reaches the session's own processes. The launcher runs the key command as the session's user and hands the key to the servers, which run as that user too. So any process of that user, the model's own tools among them, could run the same command, or read a server's environment (`/proc/<pid>/environ`).

A key service keeps the key with another OS user. systemd runs the channel and buzz-mcp as that user, one process per connection, behind Unix sockets. The session starts only a small pipe to each, which holds no key. The launcher's two modes below are what such a service runs; [`install/keyservice/setup`](../../install/keyservice/setup) sets one up (the [top-level README](../../README.md#key-service) says how), with the units in [`install/service/`](../../install/service/) (`key-*`).

**The pipe: the session's side.** Set `buzz_key_socket` (`BUZZ_KEY_SOCKET`) to the folder of the key service's sockets. Then `launch.mjs channel` and `launch.mjs buzz-mcp`:

- read no key, run no key command and install nothing;
- refuse to start if `BUZZ_KEY_COMMAND` or `BUZZ_PRIVATE_KEY` is set too: leave the plugin's key command empty, or this side still holds a way to the key;
- drop the empty `BUZZ_KEY_COMMAND` the plugin passes anyway (`.mcp.json` names it for every server, filled in or not): the pipe runs itself again without it (`execve`: the same process, stdin and stdout), so the name is not in its `/proc/<pid>/environ`. Node.js before 22.15 has no `process.execve`, and a node binary the pipe cannot run is checked first; in both cases the empty name stays, and the pipe says so on stderr. A run again that fails past that check cannot go back: Node.js aborts the process, so the pipe ends and Claude Code sees the server exit;
- connect to `<folder>/channel.sock` or `<folder>/buzz-mcp.sock` and copy bytes both ways. Claude Code sees an ordinary stdio MCP server, the channel's `claude/channel` handshake and its notifications included;
- exit when either side closes: 0 when the session ended, 1 when the key service closed first, so Claude Code shows the server as failed instead of waiting on it;
- keep trying, for up to 10 seconds (`BUZZ_KEY_SOCKET_WAIT_MS`), while the key service has not answered yet, and send what the session sent once more on each new connection. That covers a key service that is restarting, and a channel socket that refuses a second connection while the old channel is still stopping (`MaxConnections=1`). The wait between tries starts at 100 ms and doubles, up to 2 seconds, and the last try is made at the deadline: a restart race clears at once, and a key service that fails every connection is started a handful of times, not fifty. Once the key service has answered, nothing is retried. A socket the session's user may not open fails at once.

**The probe.** `BUZZ_KEY_SOCKET=<folder> launch.mjs probe channel|buzz-mcp` makes one real connection to that socket, as the pipe would: an MCP `initialize`, then the server's answer. It never sends `notifications/initialized`, the end of the handshake, and the channel connects to the relay only after that, so a probed channel never receives a mention and never moves its cursor. It prints one line, the server's name or why there was no answer, and exits 0 only when the server answered (the channel must also declare `claude/channel`). [`install/keyservice/setup`](../../install/keyservice/setup) runs it as the session's user after every install.

The one-shot send has no socket. Run it on the key service's side, as `serve send`. So the [load proof](../../hooks/README.md#load-proof) hook, which sends from the session, writes its file but posts nothing on a session whose key is in a key service.

**Serve: the key service's side.** systemd runs `launch.mjs serve channel|buzz-mcp|send …` as the key's user, with the connection on stdin and stdout. In this order, it:

1. refuses to start if node was given any option but `--disable-sigusr1`, or if `NODE_OPTIONS`, `NODE_PATH`, `NODE_REPL_EXTERNAL_MODULE`, `NODE_COMPILE_CACHE`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `LD_AUDIT`, `OPENSSL_CONF`, `OPENSSL_MODULES` or `OPENSSL_ENGINES` is set (on Linux it also reads the names it started with in `/proc/self/environ`). Each of these can make node, OpenSSL or the loader run other code in the process before the server, where it would see the key: `OPENSSL_CONF`, for one, can name a provider module that node loads at startup;
2. refuses to start if `BUZZ_KEY_COMMAND` or `BUZZ_PRIVATE_KEY` is in its environment;
3. for buzz-mcp, refuses to start without `BUZZ_MCP_PATH` (the build it runs) and `BUZZ_MCP_ROOT`, the only folder its `path` and `files` arguments may read. Without that root, buzz-mcp reads under its working folder, which for a system unit is `/`. The root must be an absolute path to a folder that exists, must not be `/`, and must not hold the key service's state or credentials folders (`BUZZ_STATE_DIR`, `STATE_DIRECTORY`, `CREDENTIALS_DIRECTORY`). The root itself must be owned by the key's user, so a folder of root's such as `/etc`, `/proc` or `/run` never qualifies. Every folder above it must be owned by root or the key's user, and none of them may be writable by its group or by others, sticky or not. buzz-mcp checks a `path` with realpath and then opens it, so anyone who could write in the root could swap a file for a link between the two steps. serve passes the resolved root on to buzz-mcp;
4. refuses to run code that anyone but root can change: the adapter's folder and everything in it, the node binary and the buzz-mcp build, with every folder above them up to `/`. Each must be owned by root and not writable by its group or by others. That rules out a world-writable folder such as `/tmp` anywhere above them, sticky or not: anyone could add a `node_modules` folder there, and Node.js looks for packages in every folder above the code;
5. checks the file descriptor systemd opened for the key, the one named `buzz-key` in `LISTEN_FDNAMES` (`OpenFile=<key file>:buzz-key:read-only`). It must be a regular file, owned by root, with no permission bits for its group or for others. Then it reads the key and closes the descriptor. The descriptors start at 3, `LISTEN_FDS` counts them, and `LISTEN_FDNAMES` should name each one. systemd 255 to 258, under `Accept=yes` with `StandardInput=socket`, pass only the `OpenFile=` files (the connection is on stdin) but leave the connection's name at the head of the list: `LISTEN_FDS=1`, `LISTEN_FDNAMES=connection:buzz-key`, the key at 3. (systemd's own `sd_listen_fds_with_names()` refuses that list; 259 drops the name.) So serve takes either one name for each descriptor, or one name too many when it is `connection`, first, and stdin is a socket. Any other list is refused;
6. reads the owner's tag, if there is one, from the `buzz-auth-tag` credential (`LoadCredential=buzz-auth-tag:<file>`), and checks its shape. A tag with no end date (empty conditions) is fine;
7. sets `BUZZ_PRIVATE_KEY` and `BUZZ_AUTH_TAG` from inside its own process, and runs the server in that same process, with no child process. Once the server has loaded, which is when it reads the key, `BUZZ_PRIVATE_KEY` leaves the process's environment too, so a child process started later would not inherit it.

A variable set from inside a process never shows in its `/proc/<pid>/environ`; one it inherited stays there even after it is deleted. So no environment and no file the key's user can read holds the key: it is only in that process's memory. Serve never installs dependencies, and buzz-mcp stops when its connection closes.

**The key file.** [`src/keyfile.mjs`](src/keyfile.mjs) is how the installer writes it, run as root from the root-owned copy of this adapter: `write <path>` takes the key from stdin (64 hex or `nsec1…`), `generate <path>` makes a new one, and `pubkey <path>` reads one back. Each prints only the public key. A new file is 64 hex characters and a newline, mode 0400, written under a temporary name and linked into place in one step, which fails when the file is already there: a key file is never replaced.

The adapter's own tests run without root, so they set `GP_TEST_SERVE_TRUST_OWN_UID=1`, which makes serve trust files owned by the user it runs as too, and say so on stderr. Under systemd (`INVOCATION_ID` set) serve ignores it and says so, so a unit can never turn it on.

**What the units give it.** For buzz-mcp, the essentials (the channel's are the same with `channel` and `MaxConnections=1`, and without `BUZZ_MCP_ROOT`):

```ini
# <instance>-buzz-mcp.socket
[Socket]
ListenStream=/run/ghost-protocol-key/<instance>/buzz-mcp.sock
Accept=yes
MaxConnections=8
SocketUser=root
SocketGroup=<the session user's group>
SocketMode=0660

# <instance>-buzz-mcp@.service
[Service]
User=<the key's user>
ExecStart=<a root-owned node> --disable-sigusr1 <a root-owned copy of this adapter>/src/launch.mjs serve buzz-mcp
StandardInput=socket
StandardError=journal
OpenFile=<a root-only key file, mode 0400>:buzz-key:read-only
LoadCredential=buzz-auth-tag:<the tag file>
# BUZZ_MCP_ROOT must be set here: a folder only root or the key's user can
# write to, holding nothing else. serve refuses to start buzz-mcp without it.
EnvironmentFile=<a root-owned file with BUZZ_RELAY_URL, BUZZ_MCP_PATH, BUZZ_MCP_ROOT and the rest>
UnsetEnvironment=NODE_OPTIONS NODE_PATH NODE_REPL_EXTERNAL_MODULE NODE_COMPILE_CACHE LD_PRELOAD LD_LIBRARY_PATH LD_AUDIT OPENSSL_CONF OPENSSL_MODULES OPENSSL_ENGINES
WorkingDirectory=<the BUZZ_MCP_ROOT folder>
ProtectSystem=strict
ReadWritePaths=<the state and media folders>
ProtectHome=yes
ProtectProc=invisible
ProcSubset=pid
PrivateTmp=yes
NoNewPrivileges=yes
CapabilityBoundingSet=
LimitCORE=0
UMask=0077
```

The claim that the key is only in the serving process's memory rests on these lines: `ProtectProc=invisible` and `ProtectHome=yes` hide other processes and the session's home; `NoNewPrivileges=yes` and an empty `CapabilityBoundingSet=` keep the process from gaining any privilege; `LimitCORE=0` means a crash writes no core file that holds the key; `UnsetEnvironment=` and `--disable-sigusr1` keep other code and the inspector out of the process; `ProtectSystem=strict` keeps the code read-only even to the key's user.

**A second key: the GitHub App slot.** [`src/github-review.mjs`](src/github-review.mjs) is the key side of another key service socket, `github.sock`: a reviewer's GitHub App key, held the same way (systemd opens it, `OpenFile=…:github-app-key:read-only`; the same refusals before anything runs) but by a user of its own, never the one that runs buzz-mcp, with one fixed action, posting a review. It uses `keyservice.mjs`'s `namedFd`, `keyFdProblem`, `readFd` and `untrustedCode`, and nothing else of the adapter. The [top-level README](../../README.md#the-github-app-slot) says what it does and refuses; [`tools/github-review/`](../../tools/github-review/) is the session's client.

**What changes for the session.**

- Every Buzz tool works as before, through the socket. No tool returns the key, so the model can use the tools but cannot read the key.
- buzz-mcp now reads files on the key service's side: its `path` and `files` arguments see only the key side's `BUZZ_MCP_ROOT`. The model cannot write into that folder itself, and no file elsewhere in the session's home can be sent by path. A file the model wants to send goes through the key side's copy step: the model writes it into its outbox (`/srv/ghost-protocol/<instance>/outbox/`) under a name starting with a dot, then renames it, and the key side ([`install/keyservice/outbox-copy`](../../install/keyservice/outbox-copy)) moves regular files only, opened without following links (`O_NOFOLLOW`), into `BUZZ_MCP_ROOT` (`/srv/ghost-protocol/<instance>/files/`). The model then sends that path.
- `media_get` saves into `/srv/ghost-protocol/<instance>/media/`, which the session's user can read.
- The channel's cursor and log are on the key service's side (its `BUZZ_STATE_DIR`), and its stderr goes to the key unit's journal.
- The owner's tag goes to the key service (see [Logging in through the owner](#logging-in-through-the-owner)).

## buzz-mcp

Block does not publish buzz-mcp as a package, and updates it often. This adapter therefore pins the exact `block/buzz-app` commit it is built from, in [`buzz-mcp.pin`](buzz-mcp.pin).

[`scripts/build-buzz-mcp.sh`](scripts/build-buzz-mcp.sh) fetches `block/buzz-app` at the pinned commit into a cache folder outside this repository and builds buzz-mcp there with `pnpm run buzz-mcp`. It copies the result to `$BUZZ_MCP_CACHE/buzz-mcp.mjs` and records the commit beside it. Running it again with the same pin does nothing; `--force` rebuilds. It prints the commit, path, size and checksum of what it built.

The launcher starts buzz-mcp from that path. It warns on stderr when the built commit does not match the pin.

### Updating buzz-mcp

1. Pick the new `block/buzz-app` commit, and note its full 40-character id.
2. Change the `commit=` line in [`buzz-mcp.pin`](buzz-mcp.pin).
3. Rebuild: `scripts/build-buzz-mcp.sh`. The changed pin makes it rebuild.
4. Run the tests (`npm test` in this folder) and the [live check](#live-check).
5. Open a pull request with the pin change and what you checked.

## Live check

The tests run against a fake relay. Before a release or a buzz-mcp update, also check against a real relay:

1. Use a test channel and an agent key that is a member of it. Point the settings at that channel only.
2. Start a session with the channel (see [Install](#install)).
3. From another account, post a message that mentions the agent. It should appear in the session.
4. Find the channel's process id in its log file (`started (pid …)`) and stop that process. Post two more mentions. Reconnect the server with `/mcp`. Both messages should arrive, marked as catch-up, oldest first, and nothing should arrive twice.
5. Ask the session to answer one message with the buzz-mcp `send` tool. The reply should appear in the channel's thread.

## Limits

- Only channel messages (kind 9): mentions of the watched identity, and, when turned on, every message from a trusted person in a one-to-one DM. Forum posts and comments (kinds 45001 and 45003), edits and reactions are not delivered. Unmentioned thread replies are not delivered on their own; they reach the session only as [thread context](#thread-context) of the next delivered message in that thread.
- Catch-up returns at most 500 messages per connection, and at most one day back by default. When it hits 500, older missed messages are skipped and the log says so.
- Relays apply the `since` filter to live messages as well as stored ones. So a message whose timestamp is more than two minutes older than the newest one already delivered (a sender with a wrong clock) can be missed, connected or not. Before the first delivery there is no overlap at all: anything stamped before the channel first started is missed.
- The key command runs with `/bin/sh`, so the launcher works on macOS and Linux.

## Development

```sh
npm install
npm test
```

`npm test` also runs the reply guard's tests (`test/reply-guard.test.mjs`, which need python3). They feed the hook synthetic transcripts written at test time by `test/fixtures/reply-guard/make-fixtures.py`. `node test/reply-guard-mutants.mjs` runs them against broken copies of the hook, one break each, and every copy must fail; it takes a few minutes and is not part of `npm test`.

`npm test` runs the load proof hook's end-to-end test too (`test/load-proof.test.mjs`: the real hook, run as the instance's own `claude` runs it, and the real one-shot send against the fake relay; it needs bash, jq, git and timeout). `node test/load-proof-mutants.mjs` runs it, and the hook's unit test (`install/test/hook-load-proof.test.sh`), against broken copies of the hook, one break each; every copy must fail, and it takes a few minutes.

`npm test` runs the workflow rule's tests too: `test/workflow-owner-unit.test.mjs` (the stamps, one case at a time, and the three places that ask the allowlist) and `test/workflow-owner.test.mjs` (the real channel against the fake relay, which signs a workflow's message with its own key: delivered and dropped, stamps from another key, a stamp for another agent, no key published or read late, a list of rooms and `*`, thread context, a stamp that is the only mention, a workflow the agent owns, and a refusal kept under the owner). `node test/workflow-owner-mutants.mjs` runs them against broken copies of the code, one break each; every copy must fail, and it takes a few minutes.

`npm test` runs the root limit's tests too (`test/root-limit.test.mjs`, python3): sends under, at and over each limit, replies, DMs, the settings, the exceptions, Unicode, code fences and tables, and that the message cannot exempt itself. The pass's file checks run on the hook's own functions with a temporary folder in root's place, since no test can write the real path. `node test/root-limit-mutants.mjs` runs them against broken copies of the hook, one break each, and every copy must fail; it takes a few minutes and is not part of `npm test`.

The key service's tests (`test/keyservice.test.mjs`) run the pipe, serve and the probe against a stand-in for systemd's socket units. By default it hands the key over as systemd 255 to 258 really do (above); the stand-in can also hand it over as 259 does, or with the connection listed too. `node test/keyservice-mutants.mjs` runs them, and the allowlist's tests, against broken copies of the code, one break each (the file descriptor list, the pipe's waits, the empty key command and a node that cannot run again, the probe, a dropped message recorded, written together, and only when definite); every copy must fail, and it takes a few minutes. The real systemd test is [`install/test/live/keyservice-systemd.sh`](../../install/test/live/keyservice-systemd.sh), for a throwaway machine (the [top-level README](../../README.md#key-service) says how).

The one-shot thread read's tests (`test/thread.test.mjs`) run it against the same fake relay, including a relay that hands over a forged event (the owner's key, another key's signature) and one that ignores the request's filter. The one-shot send's tests (`test/send.test.mjs`) run it against the same fake relay: the message it writes, the login (including a relay that sends its challenge only after the message, and a relay that admits the key only through its owner, with and without `BUZZ_AUTH_TAG`), a malformed tag, a refused message or login, a relay that never answers or is not there, usage errors, and that the key never reaches its output.

The key service's tests (`test/keyservice.test.mjs`) play systemd's part: a Unix socket that starts `launch.mjs serve` per connection, with the key file handed over as a named file descriptor and the tag as a credential. serve trusts only code nobody but root can change, so the tests set `GP_TEST_SERVE_TRUST_OWN_UID=1` and run it from a copy of the adapter and of node in a private folder under your home (removed afterwards), never under `/tmp`. They cover:

- the pipe: both ways, retrying and sending again before the first byte (megabytes included), giving up, refusing a key or key command on its side, and working without dependencies;
- serve's refusals: node options and loader settings, a key in its environment, a missing or wrong descriptor, a key file others can read, a bad key or tag, a missing or unsafe `BUZZ_MCP_ROOT`, and code that anyone but root can change;
- what serve does: reads the key from the descriptor and closes it, keeps it out of `/proc/self/environ`, drops it from `process.env` once the server has loaded, and runs the server in the same process;
- one connection at a time, the real channel end to end through the pipe, and `serve send`.

`test/github-review.test.mjs` covers the GitHub App slot's action offline, with RSA keys made at test time and a stand-in for GitHub on `127.0.0.1` that checks each JWT against the key's public half and records every request. It covers the request's fields, the allowlist before the key or the network, the token's scope (one repo, `pull_requests: write` alone, never `contents`, and one GitHub makes wider refused and revoked), the pull request's head and state, the review pinned to the head, the pull request read again after posting (a head that moved is not ok), the token revoked (by the time limit too, when GitHub never answers), serve's refusals through the socket, the session's client, and the key file (a leftover that is a second name for the live key only removed); and that no answer, ledger line or output holds the key, a JWT or a token. It also holds the review to its limits: a refusal test for each check (`repo`, `event`, `open`, `head`, `hold`, `draft`, `own-pr`, `own-commit`, `public-text`, with each way a fact can be unreadable), each asserting the check's name, the exact clause, no review posted, the token revoked, the ledger naming the check, and that no title, body, address or token is repeated; the order the checks run in; what must still pass (the builders' shared noreply author, a `HOLD:` later in a title, a private repo, `COMMENT` where the settings allow it, exactly 100 commits); a hold or a draft that comes after the post; the settings (the own identities are an App's bot only, `COMMENT` off by default) and the public-text rules file (its shape; each construct Python and JavaScript read differently, one by one; Unicode case folding and code points; a pattern that matches the empty text or backtracks without end; its trust, its size), with `serve` refusing to start without either; and the cut-off on matching (a rule against a long body that would run for tens of seconds is refused within the limit, with no review posted and the token revoked). The rules in the tests are made-up words. The limits that need a pull request's facts cannot be tried over the real systemd socket, because the stand-in for GitHub is refused there by design; `install/test/live/keyservice-systemd.sh` tries the ones that need none (`COMMENT`, the repo list, the settings' files). Its serve tests set `GP_TEST_SERVE_TRUST_OWN_UID=1`, which trusts the user they run as for the code and the key file; `=code` trusts it for the code only, so the key file's owner is checked as in production. `GP_TEST_SERVE_CONNECTION_MS` shortens serve's time limit, only with the stand-in for GitHub. Under systemd the first is ignored and the stand-in refused. `node test/github-review-mutants.mjs` runs it against broken copies of `src/github-review.mjs`, one break each for every guard (the limits' too: each check taken out, its case or its comparison weakened, a fact that cannot be read passed, a title, body or address put into a refusal, the builders' shared noreply author counted as the reviewer's own; each refused construct of the rules and each flag they compile with; the time limit on matching taken out or weakened); every copy must fail, and it takes some half an hour, since the suite runs once for each. With `--applies` it only checks that each break's text is in the code once.

`test/keyfile.test.mjs` covers the key file: hex and nsec keys in, 0400, never replaced, never through a link, a bad key refused without repeating it, a generated key, and that no output holds the key.

With `GP_TEST_BUZZ_MCP` set to a built `buzz-mcp.mjs`, one more test runs the real buzz-mcp under serve: `initialize`, `tools/list`, and a stop at the end of its input. `test/lock.test.mjs` covers `BUZZ_CHANNEL_LOCK`.

The channel's tests start a fake relay (a local websocket server that demands NIP-42 login) and drive the real launcher and channel over MCP stdio. They cover live delivery, filtering, thread context, catch-up after a dropped connection, a relay that rejects or never answers the WebSocket handshake, a relay that stops answering, restarts, and that the key never reaches output, logs or the state file. Unit tests drive the reconnect logic with a scripted socket, one failure at a time: an error with no close event, a connection that never opens, one left closing, a login that never finishes, a silent relay, and the watchdog.
