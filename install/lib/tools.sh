# shellcheck shell=bash
# tools.sh: step 17, the tools the plugin's agents use. Read-only: it runs
# each tool's own check, which prints what is missing and the line that
# installs it. It never installs anything, and a missing tool never stops
# the run (it is recorded as SKIP). A dry run checks the same way.
# Sourced by install/install only.

# The blackout agent (agents/blackout.md): Python 3, ImageMagick and
# Tesseract, at the minimum versions in pins.env (BLACKOUT_*_MIN_VERSION).
tools_blackout() {
    local py out rc missing state
    py="$(command -v python3 2>/dev/null || true)"
    if [ -z "$py" ]; then
        warn "the blackout agent's tool needs python3 (${BLACKOUT_PYTHON_MIN_VERSION:-3.9} or newer), which is missing"
        record SKIP tools "blackout: python3 missing; the agent cannot run until it is installed"
        return 0
    fi
    # -I: ignore PYTHON* settings and the user's site folder; -B: write no
    # bytecode next to the tool.
    out="$("$py" -I -B "$GP_DIR/tools/blackout/blackout.py" doctor --pins "$(pins_file 2>/dev/null)" 2>&1)"
    rc=$?
    [ -z "$out" ] || printf '%s\n' "$out" | sed 's/^/  /'
    missing="$(printf '%s\n' "$out" | awk '$1 == "missing" || $1 == "too-old" { sub(":", "", $2); printf "%s%s", sep, $2; sep = ", " }')"
    # Exit 1 with no tool named is not the check's answer (for example, a
    # python3 that is only a stand-in asking for the developer tools).
    state="$rc"
    if [ "$rc" = "1" ] && [ -z "$missing" ]; then state=other; fi
    case "$state" in
        0)
            record OK tools "blackout: python3, ImageMagick and Tesseract present" ;;
        1)
            warn "the blackout agent's tools are missing or too old: $missing (install line above)"
            record SKIP tools "blackout: missing or too old: $missing; install them, then run blackout.py doctor" ;;
        *)
            warn "the blackout tool's check did not run (exit $rc)"
            record SKIP tools "blackout: its check did not run (exit $rc)" ;;
    esac
    return 0
}

step_tools() {
    heading "17. tools"
    tools_blackout
    return 0
}
