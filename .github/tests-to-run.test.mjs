// The script that picks which test workflows a change calls (.github/tests-to-run.sh), run in made-up git repositories with the real
// list of rows. The `changes` job of tests.yml runs this test before it runs the script. Run by hand: node --test .github/tests-to-run.test.mjs
// ROWS below is the list of rows the script must print, in its order: a row added to the script is added here too.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "tests-to-run.sh");
const ROWS = ["install-test", "blackout-test", "adapter-tests", "rollout-check-test", "backlog-test", "tool-tests", "evals", "gates"];
const ZERO = "0".repeat(40);

// A throwaway repository. `commit(files, deleted)` writes and deletes files and returns the new commit.
const repository = () => {
  const dir = mkdtempSync(join(tmpdir(), "tests-to-run-"));
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "-q", "--initial-branch=main");
  const commit = (files = {}, deleted = []) => {
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true });
      writeFileSync(join(dir, name), text);
    }
    for (const name of deleted) git("rm", "-q", "--", name);
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "change");
    return git("rev-parse", "HEAD");
  };
  return { dir, git, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
};

// Runs the script in `dir` and returns its exit status, its log, and the outputs it wrote, as an object.
const run = (dir, EVENT, BASE, HEAD) => {
  const out = join(dir, "..", `${dir.split("/").pop()}.output`);
  writeFileSync(out, "");
  const result = spawnSync("bash", [script], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, EVENT, BASE, HEAD, GITHUB_OUTPUT: out } });
  const outputs = Object.fromEntries(readFileSync(out, "utf8").split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
  rmSync(out, { force: true });
  return { status: result.status, log: result.stdout + result.stderr, outputs };
};

// The rows that run, from a successful run; also checks every row is there, once, as true or false, and `rows` names them all.
const running = (result) => {
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(Object.keys(result.outputs).sort(), [...ROWS, "rows"].sort(), result.log);
  assert.deepEqual(result.outputs.rows.split(" "), ROWS);
  for (const name of ROWS) assert.match(result.outputs[name], /^(true|false)$/);
  return ROWS.filter((name) => result.outputs[name] === "true");
};

const base = {
  "README.md": "readme\n",
  "VOCABULARY.md": "words\n",
  "docs/layout.md": "layout\n",
  "install/install": "installer\n",
  "hooks/time-stamp": "hook\n",
  "adapters/buzz/index.ts": "adapter\n",
  "tools/blackout/blackout.py": "blackout\n",
  "tools/ruleset/ruleset": "ruleset\n",
  ".github/workflows/tests.yml": "name: Tests\n",
};

// One pull request: a base commit with `base`, then a head commit with `files` and `deleted`. Returns the rows that run (or the result).
const pullRequest = (files, deleted = [], raw = false) => {
  const repo = repository();
  try {
    const before = repo.commit(base);
    const after = repo.commit(files, deleted);
    const result = run(repo.dir, "pull_request", before, after);
    return raw ? result : running(result);
  } finally {
    repo.done();
  }
};

test("a docs-only change calls only the gates (the secret scan and the tree scan)", () => {
  assert.deepEqual(pullRequest({ "docs/layout.md": "changed\n" }), ["gates"]);
  assert.deepEqual(pullRequest({ "docs/new.md": "new\n" }), ["gates"]);
});

test("an empty change still calls the gates, and nothing else", () => {
  assert.deepEqual(pullRequest({}), ["gates"]);
  const repo = repository();
  try {
    const before = repo.commit(base);
    const after = repo.commit();
    assert.deepEqual(running(run(repo.dir, "push", before, after)), ["gates"]);
  } finally {
    repo.done();
  }
});

test("a change to one part calls only the tests that read it, and the gates", () => {
  assert.deepEqual(pullRequest({ "tools/blackout/blackout.py": "changed\n" }), ["install-test", "blackout-test", "tool-tests", "gates"]);
  assert.deepEqual(pullRequest({ "adapters/buzz/index.ts": "changed\n" }), ["install-test", "adapter-tests", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "hooks/load-proof": "changed\n" }), ["install-test", "adapter-tests", "rollout-check-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "hooks/lib/hook.sh": "changed\n" }), ["install-test", "adapter-tests", "rollout-check-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "install/lib/instance.sh": "changed\n" }), ["install-test", "adapter-tests", "rollout-check-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "hooks/session-id": "changed\n" }), ["install-test", "rollout-check-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "install/install": "changed\n" }), ["install-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "tools/ruleset/ruleset": "changed\n" }), ["install-test", "tool-tests", "gates"]);
  assert.deepEqual(pullRequest({ "README.md": "changed\n" }), ["install-test", "gates"]);
  assert.deepEqual(pullRequest({ "VOCABULARY.md": "changed\n" }), ["install-test", "gates"]);
  assert.deepEqual(pullRequest({}, ["VOCABULARY.md"]), ["install-test", "gates"]);
  assert.deepEqual(pullRequest({ ".claude-plugin/plugin.json": "{}\n" }), ["install-test", "backlog-test", "evals", "gates"]);
});

test("the tests found by name run for the tools, the image, what the image carries, and the persona", () => {
  assert.deepEqual(pullRequest({ "tools/release/release": "x\n" }), ["install-test", "tool-tests", "gates"]);
  assert.deepEqual(pullRequest({ "tools/publish/test": "x\n" }), ["install-test", "tool-tests", "gates"]);
  assert.deepEqual(pullRequest({ "docker/Dockerfile": "x\n" }), ["tool-tests", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "docker/test": "x\n" }), ["tool-tests", "evals", "gates"]);
  assert.deepEqual(pullRequest({ ".dockerignore": "x\n" }), ["tool-tests", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "LICENSE": "x\n" }), ["tool-tests", "gates"]);
  assert.deepEqual(pullRequest({ "NOTICE": "x\n" }), ["tool-tests", "gates"]);
  assert.deepEqual(pullRequest({ "persona/agent.md": "x\n" }), ["tool-tests", "evals", "gates"]);
});

test("the evals run for what the agent runs, and for the evals themselves; not for the docs, the backlog or the tools", () => {
  assert.deepEqual(pullRequest({ "evals/run": "x\n" }), ["evals", "gates"]);
  assert.deepEqual(pullRequest({ "evals/ci/run": "x\n" }), ["evals", "gates"]);
  assert.deepEqual(pullRequest({ ".mcp.json": "{}\n" }), ["install-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "adapters/buzz/hooks/reply-guard": "x\n" }), ["install-test", "adapter-tests", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "hooks/time-stamp": "changed\n" }), ["install-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "docs/layout.md": "changed\n" }), ["gates"]);
  assert.deepEqual(pullRequest({ "backlog/schema/validate.mjs": "x\n" }), ["backlog-test", "gates"]);
  assert.deepEqual(pullRequest({ "tools/blackout/blackout.py": "x\n" }), ["install-test", "blackout-test", "tool-tests", "gates"]);
  assert.deepEqual(pullRequest({ ".claude-plugin/marketplace.json": "{}\n" }), ["install-test", "gates"]);
});

test("the backlog's tests run for the backlog, and for the manifest that declares its settings", () => {
  assert.deepEqual(pullRequest({ "backlog/schema/validate.mjs": "x\n" }), ["backlog-test", "gates"]);
  assert.deepEqual(pullRequest({ "backlog/test/fixtures/profile.json": "{}\n" }), ["backlog-test", "gates"]);
  assert.deepEqual(pullRequest({ ".claude-plugin/marketplace.json": "{}\n" }), ["install-test", "gates"], "the marketplace file does not call them");
});

test("the rollout check's tests run for the tool, and for the hooks they run", () => {
  assert.deepEqual(pullRequest({ "tools/rollout-check/lib.mjs": "x\n" }), ["install-test", "rollout-check-test", "tool-tests", "gates"]);
  assert.deepEqual(pullRequest({ "hooks/session-id": "changed\n" }), ["install-test", "rollout-check-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "hooks/turn-state": "changed\n" }), ["install-test", "rollout-check-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "hooks/load-proof": "new\n" }), ["install-test", "adapter-tests", "rollout-check-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "hooks/lib/own-claude.sh": "new\n" }), ["install-test", "adapter-tests", "rollout-check-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "install/test/fixtures/manifests/good-v1.toml": "new\n" }), ["install-test", "adapter-tests", "rollout-check-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "hooks/time-stamp": "changed\n" }), ["install-test", "evals", "gates"], "a hook it does not read does not call them");
});

test("a name git would quote (non-ASCII, a quote, a backslash, a newline) still calls its tests", () => {
  assert.deepEqual(pullRequest({ "tools/blackout/café.py": "x\n" }), ["install-test", "blackout-test", "tool-tests", "gates"]);
  assert.deepEqual(pullRequest({ 'adapters/buzz/a "quoted" name.ts': "x\n" }), ["install-test", "adapter-tests", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "hooks/back\\slash": "x\n" }), ["install-test", "evals", "gates"]);
  assert.deepEqual(pullRequest({ "docs/new\nline.md": "x\n" }), ["gates"]);
});

test("a file is matched as a folder or as itself, never as a prefix of another name", () => {
  const result = pullRequest({ "README.md.orig": "x\n", "toolsx/a": "x\n", "LICENSE.txt": "x\n", "evalsx/a": "x\n" }, [], true);
  assert.notEqual(result.status, 0, result.log);
  assert.match(result.log, /::error::LICENSE\.txt changed, but no test workflow reads it/);
  assert.match(result.log, /::error::evalsx\/a changed, but no test workflow reads it/);
  assert.match(result.log, /::error::README\.md\.orig changed, but no test workflow reads it/);
  assert.match(result.log, /::error::toolsx\/a changed, but no test workflow reads it/);
});

test("any change under .github/ calls every test workflow", () => {
  assert.deepEqual(pullRequest({ ".github/tests-to-run.sh": "x\n" }), ROWS);
  assert.deepEqual(pullRequest({ ".github/workflows/tests.yml": "changed\n" }), ROWS);
  assert.deepEqual(pullRequest({}, [".github/workflows/tests.yml"]), ROWS);
});

test("a moved file calls the tests of the place it left (no rename detection)", () => {
  assert.deepEqual(pullRequest({ "docs/blackout.py": "blackout\n" }, ["tools/blackout/blackout.py"]), ["install-test", "blackout-test", "tool-tests", "gates"]);
});

test("a path no row names fails, and says which; a path no test reads on purpose does not", () => {
  const result = pullRequest({ "COPYING": "x\n", "examples/a.sh": "x\n", "hooks/x": "x\n" }, [], true);
  assert.notEqual(result.status, 0, result.log);
  assert.match(result.log, /::error::COPYING changed, but no test workflow reads it/);
  assert.match(result.log, /::error::examples\/a\.sh changed, but no test workflow reads it/);
  assert.doesNotMatch(result.log, /hooks\/x changed/);
  assert.deepEqual(result.outputs, {}, "no output when it fails");
  // Deleting a file that no row names is not a change to test.
  const repo = repository();
  try {
    const before = repo.commit({ ...base, "old/notes.txt": "x\n" });
    const after = repo.commit({}, ["old/notes.txt"]);
    assert.deepEqual(running(run(repo.dir, "pull_request", before, after)), ["gates"]);
  } finally {
    repo.done();
  }
});

test("a pull request is read from its merge base, as GitHub lists its files: a later change to the base is not in it", () => {
  const repo = repository();
  try {
    const start = repo.commit(base);
    repo.git("checkout", "-q", "-b", "topic");
    const head = repo.commit({ "docs/layout.md": "topic\n" });
    repo.git("checkout", "-q", "main");
    const main = repo.commit({ "install/install": "main moved on\n" });
    assert.deepEqual(running(run(repo.dir, "pull_request", main, head)), ["gates"]);
    assert.deepEqual(running(run(repo.dir, "pull_request", start, head)), ["gates"]);
  } finally {
    repo.done();
  }
});

test("a push and a merge group are read from their base to their commit; a base that is not there calls everything", () => {
  const repo = repository();
  try {
    const before = repo.commit(base);
    const after = repo.commit({ "adapters/buzz/index.ts": "changed\n" });
    assert.deepEqual(running(run(repo.dir, "push", before, after)), ["install-test", "adapter-tests", "evals", "gates"]);
    assert.deepEqual(running(run(repo.dir, "merge_group", before, after)), ["install-test", "adapter-tests", "evals", "gates"]);
    assert.deepEqual(running(run(repo.dir, "push", ZERO, after)), ROWS);
    assert.deepEqual(running(run(repo.dir, "push", "1234567890123456789012345678901234567890", after)), ROWS);
    assert.deepEqual(running(run(repo.dir, "pull_request", "1234567890123456789012345678901234567890", after)), ROWS);
  } finally {
    repo.done();
  }
});

test("a run by hand calls every test workflow", () => {
  const repo = repository();
  try {
    repo.commit(base);
    assert.deepEqual(running(run(repo.dir, "workflow_dispatch", "", "")), ROWS);
  } finally {
    repo.done();
  }
});
