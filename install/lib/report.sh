# shellcheck shell=bash
# report.sh: the results table. Each step records one line:
#   OK    checked, nothing needed doing
#   DONE  changed something
#   PLAN  a dry run would change it, or a later PR builds it
#   SKIP  not run (a later PR builds it)
#   FAIL  failed; the run stops
# Sourced by install/install only.

RESULTS=""

record() {   # status step detail
    RESULTS="${RESULTS}$1|$2|$3
"
}

# Print the table. Sets REPORT_FAILS to the number of FAIL lines.
report_print() {
    local st nm detail
    REPORT_FAILS=0
    if [ "$DRY_RUN" = "1" ]; then
        heading "summary (dry run: PLAN = would change; nothing was changed)"
    else
        heading "summary"
    fi
    while IFS='|' read -r st nm detail; do
        [ -n "$st" ] || continue
        printf '  %-5s %-9s %s\n' "$st" "$nm" "$detail"
        if [ "$st" = "FAIL" ]; then REPORT_FAILS=$((REPORT_FAILS + 1)); fi
    done <<EOF
$RESULTS
EOF
}
