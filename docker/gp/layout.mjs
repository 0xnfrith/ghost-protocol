// The data volume's layout. Everything an agent keeps lives in /data, its HOME:
//   .gp/agent.key          the agent's relay secret key (0600; never printed)
//   .gp/config.json        name, slug, relay_url, owner: what init was given
//   .gp/auth-tag           the owner's NIP-OA tag, one line of JSON (public)
//   .gp/claude-token       a Claude setup token, when signed in with one (0600)
//   .gp/persona.md         the persona, made from the image's persona/agent.md
//   .gp/agent-state        what the entrypoint is doing: needs-claude, starting, running, error
//   .gp/buzz/              the Buzz channel's state and log (BUZZ_STATE_DIR)
//   .gp/relay-check.json   gp status's own relay login, at most once a minute
//   .gp/update-available.json  {version}: a newer version is out (gp update offer)
//   .gp/update-request.json    {action, from, to, at}: an update or way back asked for
//   .gp/update-state.json      {state: updating, action, from, to, at}: under way
//   .gp/previous-version       the version before the last update (the way back)
//   .gp/updater-seen           when the update helper last polled (ISO time)
//   .gp/handoff.json           how the last update or way back went, for the agent
//   .gp/update-asked.json      the versions the agent was asked about (once each)
//   .gp/note-pending.json      the note last typed into claude, until a turn took it (watch.mjs)
//   .gp/profile.json           the agent's profile the relay last took (gp profile)
//   .gp/claude-defaults.json   the Claude Code settings the image set once (model, effort), and those it found set or the owner picked
//   .gp/claude-md.json         the sha256 of the CLAUDE.md the image last wrote in the home
//   work/                  the workspace root, in GHOST Protocol's layout (docs/layout.md):
//   work/agent/            the instance's home, a git checkout with its manifest and a CLAUDE.md
//   work/repos/, worktrees/, media/, desk/, scratch/   the layout's shared folders
//   .config/ghost-protocol/agent.json   the instance's settings file (start's GP_SETTINGS)
//   .local/state/ghost-protocol/agent/  start's own state (session id, turn, pane)
import { join } from "node:path";

export const DATA = process.env.GP_DATA || "/data";
export const GPDIR = join(DATA, ".gp");
export const NAME = "agent";
export const ROOT = join(DATA, "work");
export const L = {
  key: join(GPDIR, "agent.key"),
  config: join(GPDIR, "config.json"),
  tag: join(GPDIR, "auth-tag"),
  token: join(GPDIR, "claude-token"),
  persona: join(GPDIR, "persona.md"),
  agentState: join(GPDIR, "agent-state"),
  buzz: join(GPDIR, "buzz"),
  channelLog: join(GPDIR, "buzz", "channel.log"),
  relayCheck: join(GPDIR, "relay-check.json"),
  updateAvailable: join(GPDIR, "update-available.json"),
  releaseImages: join(GPDIR, "release-images.json"),
  updateState: join(GPDIR, "update-state.json"),
  updateRequest: join(GPDIR, "update-request.json"),
  updaterSeen: join(GPDIR, "updater-seen"),
  handoff: join(GPDIR, "handoff.json"),
  updateAsked: join(GPDIR, "update-asked.json"),
  notePending: join(GPDIR, "note-pending.json"),
  previousVersion: join(GPDIR, "previous-version"),
  profile: join(GPDIR, "profile.json"),
  claudeDefaults: join(GPDIR, "claude-defaults.json"),
  claudeMdState: join(GPDIR, "claude-md.json"),
  home: join(ROOT, NAME),
  claudeMd: join(ROOT, NAME, "CLAUDE.md"),
  manifest: join(ROOT, NAME, ".ghost-protocol", "instance.toml"),
  settings: join(DATA, ".config", "ghost-protocol", `${NAME}.json`),
  startState: join(DATA, ".local", "state", "ghost-protocol", NAME),
  claudeJson: join(DATA, ".claude.json"),
  // Claude Code's transcripts of the instance's home (its project folder: the path, every other character as -).
  transcripts: join(DATA, ".claude", "projects", join(ROOT, NAME).replace(/[^A-Za-z0-9]/g, "-")),
  claudeSettings: join(DATA, ".claude", "settings.json"),
  claudeCredentials: join(DATA, ".claude", ".credentials.json"),
};
export const PLUGIN_ID = "ghost-protocol@ghost-protocol";
