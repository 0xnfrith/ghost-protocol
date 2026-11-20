#!/usr/bin/env bash
# blackout.test.sh: the blackout tool's own tests (tools/blackout/test/),
# run here so the installer's CI runs them too. Each group skips when what
# it needs is missing: python3 for all of them, ImageMagick for redact and
# crop, and Tesseract for the end-to-end leak check. Every test image is
# made by the test, with invented text; no real screenshot is used.
set -u
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"

if ! command -v python3 >/dev/null 2>&1; then
    echo "SKIP  the blackout tool's tests (no python3 here)"
    echo
    echo "0 passed, 0 failed"
    exit 0
fi
# -I: ignore PYTHON* settings and the user's site folder; -B: no bytecode.
exec python3 -I -B "$SRC/tools/blackout/test/test_blackout.py"
