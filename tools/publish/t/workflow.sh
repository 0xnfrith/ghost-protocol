#!/usr/bin/env bash
# shellcheck disable=SC2016 # the workflow's ${{ }} expressions are compared as text
# .github/workflows/publish.yml: its two publish steps, the staging copy and the public repository. Each gets only its own
# credential and target, skips with a notice when either is not set, and the public step still runs when the staging one failed.
# The steps' scripts are run here as written in the file, against a stand-in tools/publish/ci/run.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

WF=${PUBLISH_WORKFLOW:-$ROOT/.github/workflows/publish.yml}
STAGING_STEP="tools/publish/ci/run, the staging copy"
PUBLIC_STEP="tools/publish/ci/run, the public repository"

block() { # step name: that step's lines, from its "- name:" to the next step
  awk -v n="      - name: $1" '$0 == n { f = 1; print; next } f && /^      - / { f = 0 } f' "$WF"
}
body() { # step name: its run script, unindented
  block "$1" | awk '/^        run: \|$/ { f = 1; next } f && /^        [^ ]/ { f = 0 } f { sub(/^          /, ""); print }'
}
field() { # step name, key: the value of that key of the step (eight spaces in), or of an env entry (ten)
  block "$1" | sed -n "s/^ \{8,10\}$2: //p"
}

check_eq "staging step: there" "$(block "$STAGING_STEP" | head -1)" "      - name: $STAGING_STEP"
check_eq "public step: there" "$(block "$PUBLIC_STEP" | head -1)" "      - name: $PUBLIC_STEP"
check_eq "public step: after the staging step" \
  "$(grep -n -e "- name: $STAGING_STEP\$" -e "- name: $PUBLIC_STEP\$" "$WF" | cut -d: -f2- | sed 's/^ *- name: //' | tr '\n' '|')" \
  "$STAGING_STEP|$PUBLIC_STEP|"
check_eq "staging step: its credential" "$(field "$STAGING_STEP" GP_PUBLISH_TOKEN)" '${{ secrets.GP_PUBLISH_TOKEN }}'
check_eq "staging step: its target" "$(field "$STAGING_STEP" GP_PUBLISH_REPO)" '${{ vars.GP_PUBLISH_REPO }}'
check_eq "public step: its credential" "$(field "$PUBLIC_STEP" GP_PUBLISH_TOKEN)" '${{ secrets.GP_PUBLISH_TOKEN_PUBLIC }}'
check_eq "public step: its target" "$(field "$PUBLIC_STEP" GP_PUBLISH_REPO)" '${{ vars.GP_PUBLISH_REPO_PUBLIC }}'
check_eq "each credential is named once in the file" \
  "$(grep -c 'secrets\.GP_PUBLISH_TOKEN }}' "$WF") $(grep -c 'secrets\.GP_PUBLISH_TOKEN_PUBLIC }}' "$WF") $(grep -c 'secrets\.' "$WF")" "1 1 2"
check_eq "staging step: its id" "$(field "$STAGING_STEP" id)" "staging"
check_eq "public step: runs when the staging step failed, not when an earlier step did, never when cancelled" \
  "$(field "$PUBLIC_STEP" if)" "\${{ !cancelled() && (success() || steps.staging.outcome == 'failure') }}"
check_eq "staging step: no condition (runs when the steps before it passed)" "$(field "$STAGING_STEP" if)" ""

# Run each step's script in a scratch tree, as the runner would (bash -e, from the checkout's root).
run_step() { # step name, tree, then env assignments: prints "rc=<n>" and the output
  local name=$1 dir=$2 rc=0 out
  shift 2
  out=$(cd "$dir" && env -u GP_PUBLISH_TOKEN -u GP_PUBLISH_REPO "$@" bash -e -c "$(body "$name")" 2>&1) || rc=$?
  printf 'rc=%s\n%s\n' "$rc" "$out"
}
EMPTY=$T/empty-tree
mkdir -p "$EMPTY"
TREE=$T/tree
mkdir -p "$TREE/tools/publish/ci"
cat >"$TREE/tools/publish/ci/run" <<STUB
#!/usr/bin/env bash
echo "ci/run called for \$GP_PUBLISH_REPO" >>"$T/calls"
STUB
chmod +x "$TREE/tools/publish/ci/run"
calls() { if [ -f "$T/calls" ]; then cat "$T/calls"; rm -f "$T/calls"; else echo none; fi; }

for s in "$STAGING_STEP" "$PUBLIC_STEP"; do
  case $s in *public*) w=public ;; *) w=staging ;; esac
  check "$w: the script is there" test -n "$(body "$s")"

  out=$(run_step "$s" "$EMPTY" GP_PUBLISH_TOKEN=t GP_PUBLISH_REPO=o/r)
  check_eq "$w: no ci/run in the tree: passes" "$(head -1 <<<"$out")" "rc=0"
  check "$w: no ci/run in the tree: a notice" grep -q '^::notice title=Nothing published' <<<"$out"

  for e in "" "GP_PUBLISH_TOKEN=t" "GP_PUBLISH_REPO=o/r"; do
    # shellcheck disable=SC2086 # $e is one assignment or none
    out=$(run_step "$s" "$TREE" $e)
    check_eq "$w: only '${e:-nothing}' set: passes" "$(head -1 <<<"$out")" "rc=0"
    check "$w: only '${e:-nothing}' set: a notice" grep -q '^::notice title=Nothing published' <<<"$out"
    check_eq "$w: only '${e:-nothing}' set: ci/run not called" "$(calls)" "none"
  done

  out=$(run_step "$s" "$TREE" GP_PUBLISH_TOKEN=t GP_PUBLISH_REPO=o/$w)
  check_eq "$w: both set: passes" "$(head -1 <<<"$out")" "rc=0"
  check_eq "$w: both set: ci/run called for its target" "$(calls)" "ci/run called for o/$w"
done
check "public: the notice names the public secret and variable" \
  grep -q 'GP_PUBLISH_TOKEN_PUBLIC (in the publish environment) or GP_PUBLISH_REPO_PUBLIC is not set' <<<"$(body "$PUBLIC_STEP")"

chmod -x "$TREE/tools/publish/ci/run"
out=$(run_step "$PUBLIC_STEP" "$TREE" GP_PUBLISH_TOKEN=t GP_PUBLISH_REPO=o/r)
check_eq "public: ci/run not executable: fails" "$(head -1 <<<"$out")" "rc=1"
check_eq "public: ci/run not executable: not called" "$(calls)" "none"

done_tests
