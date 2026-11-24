#!/usr/bin/env bash
# Which test workflows a change calls: the `changes` job of tests.yml runs it, and .github/tests-to-run.test.mjs tests it in made-up
# repositories. Run from the root of the repository whose change it reads.
#
# Reads EVENT (the event's name), BASE and HEAD (commits) from the environment:
#   pull_request   the files GitHub lists as changed: `git diff BASE...HEAD`, from their merge base
#   push           `git diff BASE HEAD`, the commit before the push and the commit pushed
#   merge_group    `git diff BASE HEAD`, the group's base and the group's commit
#   anything else  (a run by hand) every test workflow
# A change to any file under .github/ calls every test workflow: this script decides what runs, and install-test checks the workflows
# and the list of required checks. So does a BASE or HEAD that is not in the history (a force push, say).
#
# Appends to $GITHUB_OUTPUT one line per row below, `<name>=true` or `<name>=false`, and `rows=<every name>`, which `all-tests`
# compares with its jobs. Writes a table to $GITHUB_STEP_SUMMARY when that is set. Fails, and writes no output, when a file the change
# adds or edits is named by no row and is not in the list of paths that no test reads.
set -euo pipefail

# The test workflows: the output (and job) name in tests.yml, then the paths whose changes call it. A path ending in / is a folder,
# any other path is one file, and * calls the row on every run, whatever changed (an empty change too).
#   install-test   the installer, the hooks, the adapter's hooks, the tools, the status line and the plugin; its tests read README.md
#                  and .claude-plugin/, copy the whole tracked tree into the repositories they install from, and commit to that
#                  copy's VOCABULARY.md (keyservice.test.sh)
#   adapter-tests  the Buzz adapter; its load-proof test also runs the load-proof hook, which sources hooks/lib/ and install/lib/,
#                  against the fake relay, with a manifest fixture
#   rollout-check-test  the rollout check and, because its tests run the hooks that keep the session id and the turn marker and write
#                  the proof (and the manifests they read), those hooks
#   backlog-test   the backlog (backlog/), and the plugin manifest, whose settings its tests hold against the settings reader
#   tool-tests     the tests that live beside what they test, found by name: every tools/<name>/test that is a file, and
#                  docker/test. docker/test builds the image, which carries LICENSE, NOTICE and persona/; .dockerignore decides
#                  what goes into it
#                  (tools/release/t/quickstart.sh reads AGENTS.md, README.md and docs/quick-start.md)
#   evals          the evals of a real agent (evals/ci/run): what the agent runs, the adapter, the hooks, the installer, the
#                  image, the plugin manifest and its MCP settings, and the persona, and the evals themselves
#   gates          the secret scan of every commit, and the scan of the tree for internal names, stray keys and email addresses:
#                  a change anywhere can add either, so every run calls them
rows=(
  "install-test   .claude-plugin/ .gitignore .mcp.json README.md VOCABULARY.md adapters/ agents/ hooks/ install/ statusline/ tools/"
  "blackout-test  tools/blackout/"
  "adapter-tests  adapters/buzz/ hooks/load-proof hooks/lib/ install/lib/ install/test/fixtures/manifests/good-v1.toml"
  "rollout-check-test  tools/rollout-check/ hooks/session-id hooks/turn-state hooks/load-proof hooks/lib/ install/lib/ install/test/fixtures/manifests/"
  "backlog-test   backlog/ .claude-plugin/plugin.json"
  "tool-tests     tools/ docker/ .dockerignore LICENSE NOTICE persona/ AGENTS.md README.md docs/quick-start.md"
  "evals          adapters/ hooks/ install/ docker/ .dockerignore .claude-plugin/plugin.json .mcp.json persona/ evals/"
  "gates          *"
)
# The paths that no test reads, on purpose (the gates still scan them):
#   docs/  the specs, read by people (except docs/quick-start.md, read by tools/release/t/quickstart.sh)
untested=(docs/)

: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is not set}"
summary=${GITHUB_STEP_SUMMARY:-/dev/null}
zero=0000000000000000000000000000000000000000
have() { [ -n "$1" ] && [ "$1" != "$zero" ] && git cat-file -e "$1^{commit}" 2>/dev/null; }
# A file name as it is shown in the log and the table: one line, and no | to break a table row.
shown() { local s=${1//$'\n'/ }; printf '%s' "${s//|/\\|}"; }
# Whether file $1 is under path $2: a folder (ending in /) as a prefix, a file exactly, and * every file.
under() {
  case $2 in
    '*') return 0 ;;
    */) [[ $1 == "$2"* ]] ;;
    *) [ "$1" = "$2" ] ;;
  esac
}

everything=""
range=()
case "${EVENT:-}" in
  pull_request)
    if have "${BASE:-}" && have "${HEAD:-}" && git merge-base "$BASE" "$HEAD" >/dev/null 2>&1; then
      range=("$BASE...$HEAD")
    else
      everything="the base or the head of the pull request is not in the history"
    fi ;;
  push | merge_group)
    if have "${BASE:-}" && have "${HEAD:-}"; then
      range=("$BASE" "$HEAD")
    else
      everything="the commit before the change is not in the history"
    fi ;;
  *) everything="run by hand (${EVENT:-no event})" ;;
esac

# The changed files, NUL-separated (-z), so that no name is quoted: without -z, git quotes a name with a non-ASCII character, a " or
# a \, and the quoted name would match no path. --no-renames lists a moved file at both its old and its new place.
files=()
kept=() # the changed files that are still there after the change (not deleted)
if [ ${#range[@]} -gt 0 ]; then
  list=$(mktemp)
  trap 'rm -f "$list"' EXIT
  git diff -z --no-renames --name-only "${range[@]}" >"$list"
  while IFS= read -r -d '' file; do files+=("$file"); done <"$list"
  git diff -z --no-renames --name-only --diff-filter=d "${range[@]}" >"$list"
  while IFS= read -r -d '' file; do kept+=("$file"); done <"$list"
fi

for file in "${files[@]}"; do
  if [[ $file == .github/* ]]; then
    everything="a file under .github/ changed ($(shown "$file"))"
    break
  fi
done

# A file that only the every-change row names, and that is not in `untested`, would never be tested: fail, and say which. Files
# under .github/ call everything, so they are always tested.
missing=()
for file in "${kept[@]}"; do
  [[ $file != .github/* ]] || continue
  known=false
  for row in "${rows[@]}"; do
    read -r -a fields <<<"$row"
    for path in "${fields[@]:1}"; do
      if [ "$path" != '*' ] && under "$file" "$path"; then known=true; fi
    done
  done
  for path in "${untested[@]}"; do if under "$file" "$path"; then known=true; fi; done
  $known || missing+=("$file")
done
if [ ${#missing[@]} -gt 0 ]; then
  for file in "${missing[@]}"; do
    echo "::error::$(shown "$file") changed, but no test workflow reads it: add its path to the row of .github/tests-to-run.sh whose tests read it, or to the list of paths no test reads there, with the reason."
  done
  exit 1
fi

{
  echo "### Which tests apply"
  echo
  if [ -n "$everything" ]; then echo "All of them: $everything."; else echo "${#files[@]} files changed."; fi
  echo
  echo "| Tests | Run | Because of |"
  echo "| --- | --- | --- |"
} >>"$summary"
if [ -n "$everything" ]; then echo "All of them: $everything."; else echo "${#files[@]} files changed."; fi

names=()
out=""
for row in "${rows[@]}"; do
  read -r -a fields <<<"$row"
  name=${fields[0]}
  names+=("$name")
  run=false
  why=""
  if [ -n "$everything" ]; then
    run=true
    why=$everything
  elif [[ " ${fields[*]:1} " == *" * "* ]]; then
    run=true
    why="every run"
  else
    for path in "${fields[@]:1}"; do
      for file in "${files[@]}"; do
        if under "$file" "$path"; then
          run=true
          why=$(shown "$file")
          break 2
        fi
      done
    done
  fi
  out+="$name=$run"$'\n'
  echo "| $name | $run | $why |" >>"$summary"
  echo "$name: $run${why:+ ($why)}"
done
out+="rows=${names[*]}"$'\n'
printf '%s' "$out" >>"$GITHUB_OUTPUT"
