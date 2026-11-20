// The one-shot task tool: sets one task root's state, or lists the open
// ones, then exits. Started by the launcher (`node launch.mjs task …`), which
// runs BUZZ_KEY_COMMAND and hands the key over in BUZZ_PRIVATE_KEY, in this
// process's environment only, as for the one-shot send.
//
//   node launch.mjs task set --channel <channel-id> --id <event-id> --state open|done|emergency|none [--reopen]
//   node launch.mjs task list --channel <channel-id>[,<channel-id>...] [--trusted <pubkey>]... [--max <n>]
//
// The states, their reactions (BUZZ_TASK_OPEN_EMOJI, BUZZ_TASK_DONE_EMOJI and
// their _URL settings) and the moves are src/task.mjs's. `set` prints one
// line, "<first 8 hex of the id>: <old state> -> <new state>", the success
// line the reply guard reads from a reaction helper, always bare: a note
// (an earlier reaction that could not be removed) goes to stderr. `list` prints one line
// per open root, newest first (src/task.mjs, listText); a root's first line
// is shown only when the agent or a --trusted key wrote it.
//
// Exit 0: done. Exit 1: the relay refused the login, closed the connection,
// could not be reached, or did not answer within BUZZ_SEND_TIMEOUT_MS
// (default 30000). Exit 2: usage, or a bad setting, key or argument. Exit 3:
// the relay refused an event or a read (its reason on stderr). Exit 4: the
// move is refused (a done root is never reopened without --reopen). stderr
// says why in fixed words or the relay's own reason, never with the key.
import { ConfigError, parseAuthTag, parsePublicKey, parseSecretKey, publicKeyOf, relaySocketUrl, setting } from "./config.mjs";
import { RelayClient, RelayError } from "./client.mjs";
import { listTasks, listText, setTask, STATES, TaskError, taskForms } from "./task.mjs";

const say = (message) => process.stderr.write(`buzz task: ${message}\n`);
const USAGE =
  "usage: task set --channel <channel-id> --id <event-id> --state open|done|emergency|none [--reopen], or task list --channel <channel-id>[,<channel-id>...] [--trusted <pubkey>]... [--max <n>]";

function quit(code, message) {
  if (message) say(message);
  process.exit(code);
}

function args(argv) {
  const [action, ...rest] = argv;
  if (action !== "set" && action !== "list") quit(2, USAGE);
  const o = { action, channels: [], trusted: [], reopen: false, max: 20 };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === "--reopen" && action === "set") {
      o.reopen = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) quit(2, flag.startsWith("--") ? `${flag} needs a value` : USAGE);
    if (flag === "--channel") o.channels.push(...value.split(",").filter(Boolean));
    else if (flag === "--id" && action === "set") o.id = value;
    else if (flag === "--state" && action === "set") o.state = value;
    else if (flag === "--trusted" && action === "list") {
      try {
        o.trusted.push(parsePublicKey(value, "--trusted"));
      } catch (err) {
        quit(2, err instanceof ConfigError ? err.message : "--trusted is not a public key");
      }
    } else if (flag === "--max" && action === "list") {
      o.max = Number(value);
      if (!Number.isSafeInteger(o.max) || o.max < 1 || o.max > 200) quit(2, "--max must be a whole number from 1 to 200");
    } else quit(2, USAGE);
    i += 1;
  }
  if (!o.channels.length) quit(2, "--channel is required");
  if (action === "set") {
    if (o.channels.length !== 1) quit(2, "set takes one --channel");
    if (!o.id) quit(2, "--id is required");
    if (!STATES.includes(o.state)) quit(2, "--state must be open, done, emergency or none");
  }
  return o;
}

const o = args(process.argv.slice(2));
let secret;
try {
  secret = parseSecretKey(process.env.BUZZ_PRIVATE_KEY);
} catch (err) {
  quit(2, err instanceof ConfigError ? err.message : "could not read the private key");
}
delete process.env.BUZZ_PRIVATE_KEY;
let url;
let authTag;
let forms;
try {
  const raw = setting(process.env, "BUZZ_RELAY_URL");
  if (!raw) throw new ConfigError("set BUZZ_RELAY_URL");
  url = relaySocketUrl(raw);
  authTag = parseAuthTag(process.env, publicKeyOf(secret));
  forms = taskForms(process.env);
} catch (err) {
  quit(2, err instanceof ConfigError ? err.message : "a setting is not usable");
}
const timeoutMs = Number.parseInt(setting(process.env, "BUZZ_SEND_TIMEOUT_MS") ?? "30000", 10);
const self = publicKeyOf(secret);
const client = new RelayClient({ url, secret, authTag, timeoutMs: Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000 });

try {
  await client.open();
  if (o.action === "set") {
    const r = await setTask(client, { channel: o.channels[0], id: o.id, state: o.state, reopen: o.reopen, self, forms });
    process.stdout.write(`${r.line}\n`);
    if (r.note) say(r.note);
  } else {
    const r = await listTasks(client, { channels: o.channels, self, forms, trusted: o.trusted });
    process.stdout.write(`${listText(r, { max: o.max, forms })}\n`);
  }
  client.close();
  process.exit(0);
} catch (err) {
  client.close();
  if (err instanceof TaskError) quit(err.message.startsWith("this root is done") ? 4 : 2, err.message);
  if (err instanceof RelayError) quit(err.message.startsWith("the relay refused the event") || err.message.startsWith("the relay refused the read") ? 3 : 1, err.message);
  quit(1, "could not reach the relay");
}
