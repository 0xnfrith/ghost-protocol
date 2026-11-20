#!/usr/bin/env bash
# tools.test.sh: step 17, the check of the tools the plugin's agents use (the
# blackout agent: python3, ImageMagick and Tesseract), with stand-ins for
# magick and tesseract. The step only reads: a tool that is missing or too
# old is a SKIP with the line that installs it, and the run goes on.
set -u
# shellcheck source=lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

I=(--instance example/instance --yes)

# Most cases need a python3 that runs inside the sandbox.
PY=1
t_new
if ! t_tool python3 || ! t_env python3 -c 'pass' >/dev/null 2>&1; then
    PY=0
    echo "SKIP  the cases that need python3 (none runs in the sandbox here)"
fi

fresh() {   # imagemagick-version tesseract-version (empty: that tool is missing)
    t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
    t_tool python3
    if [ -n "$1" ]; then t_stub magick; echo "$1" >"$T/state/magick.version"; fi
    if [ -n "$2" ]; then t_stub tesseract; echo "$2" >"$T/state/tesseract.version"; fi
}
# The step only asks for versions and languages.
only_reads() {
    ! grep -E '^(magick|tesseract) ' "$T/state/calls" \
        | grep -qvE '^(magick -version|tesseract --version|tesseract --list-langs) '
}

if [ "$PY" = "1" ]; then
    # 1. Everything present: OK.
    fresh 7.1.1-40 5.3.4
    t_install "${I[@]}"
    check "all present: exit 0" rc_is 0
    check "all present: recorded as OK" out_has 'OK +tools +blackout: python3, ImageMagick and Tesseract present'
    check "all present: it prints each version" out_has 'ok +tesseract: 5\.3\.4'
    check "all present: it only asked for versions" only_reads

    # 2. No Tesseract: a SKIP with the install line; the run still succeeds.
    fresh 7.1.1-40 ""
    t_install "${I[@]}"
    check "no tesseract: exit 0 (a missing tool never stops the run)" rc_is 0
    check "no tesseract: recorded as SKIP, naming it" out_has 'SKIP +tools +blackout: missing or too old: tesseract;'
    check "no tesseract: it says what is missing" out_has 'missing +tesseract: the OCR leak check needs it'
    check "no tesseract: it prints the install line" out_has '^  install: '
    check "no tesseract: a warning names it" out_has "WARNING: the blackout agent's tools are missing or too old: tesseract"

    # 3. Both too old.
    fresh 6.9.8-10 3.05.02
    t_install "${I[@]}"
    check "too old: exit 0" rc_is 0
    check "too old: both are named" out_has 'SKIP +tools +blackout: missing or too old: imagemagick, tesseract;'
    check "too old: the ImageMagick line says so" out_has 'too-old +imagemagick: 6\.9\.8-10; needs 6\.9\.10 or newer'

    # 4. Tesseract without its English data.
    fresh 7.1.1-40 5.3.4
    touch "$T/state/tesseract.nolang"
    t_install "${I[@]}"
    check "no English data: recorded as SKIP" out_has 'SKIP +tools +blackout: missing or too old: tesseract;'
    check "no English data: it says so" out_has 'has no English data'

    # 5. A dry run checks the same way and changes nothing.
    fresh 7.1.1-40 5.3.4
    t_snapshot >"$T/before"
    t_install "${I[@]}" --dry-run
    t_snapshot >"$T/after"
    check "dry run: exit 0" rc_is 0
    check "dry run: the same check, recorded as OK" out_has 'OK +tools +blackout:'
    check "dry run: HOME is unchanged" cmp -s "$T/before" "$T/after"
    check "dry run: it only asked for versions" only_reads
fi

# 6. No python3 at all: a SKIP that says so.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
t_install "${I[@]}"
check "no python3: exit 0" rc_is 0
check "no python3: recorded as SKIP" out_has 'SKIP +tools +blackout: python3 missing'

# 7. A python3 that exits 1 without naming a tool (a stand-in that only asks
#    for the developer tools): "did not run", never an empty missing list.
t_new; t_std_env; t_make_instance "$FIX/manifests/good.toml"
printf '#!/bin/sh\necho "python3: the developer tools are not installed" >&2\nexit 1\n' >"$T/stubs/python3"
chmod +x "$T/stubs/python3"
t_install "${I[@]}"
check "python3 stand-in: exit 0" rc_is 0
check "python3 stand-in: recorded as did not run" out_has 'SKIP +tools +blackout: its check did not run \(exit 1\)'
check "python3 stand-in: no empty missing list" out_lacks 'missing or too old: ;'

finish_tests
