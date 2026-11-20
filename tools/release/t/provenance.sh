#!/usr/bin/env bash
# NOTICE and docs/provenance.md against the tree: NOTICE names the pinned buzz-mcp commit and every package bundled into it, the
# provenance note lists the same packages, and the adapter's licence counts in the note are the lockfile's. No network, no secret.
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
pass=0
fail=0
check() {
  local n=$1
  shift
  if "$@" >/dev/null 2>&1; then pass=$((pass + 1)); echo "ok    $n"; else fail=$((fail + 1)); echo "FAIL  $n"; fi
}
NOTICE=$ROOT/NOTICE
NOTE=$ROOT/docs/provenance.md
pin=$(sed -n 's/^commit=//p' "$ROOT/adapters/buzz/buzz-mcp.pin")
check "the pin is a full commit id" bash -c "[[ '$pin' =~ ^[0-9a-f]{40}\$ ]]"
check "NOTICE names the pinned commit" grep -qF "$pin" "$NOTICE"
check "NOTICE does not say the upstream has no notice file" bash -c "! grep -qi 'has no NOTICE file' '$NOTICE'"
check "NOTICE quotes the upstream's attribution" grep -q 'Apache-2.0 license is preserved' "$NOTICE"
check "NOTICE has the Apache License text" grep -q 'TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION' "$NOTICE"
check "NOTICE has the MIT License text" grep -q 'Permission is hereby granted, free of charge' "$NOTICE"
for p in "@modelcontextprotocol/server" "@noble/ciphers" "@noble/curves" "@noble/hashes" "@scure/base" "nostr-tools" "zod"; do
  check "NOTICE names $p" grep -qF -- "  $p " "$NOTICE"
  check "the note lists $p" grep -qF -- "\`$p\`" "$NOTE"
done
check "NOTICE has the copyright lines (noble, zod)" bash -c "grep -q 'Copyright (c) 2022 Paul Miller' '$NOTICE' && grep -q 'Copyright (c) 2025 Colin McDonnell' '$NOTICE'"

# The licence counts in the note are the lockfile's, for the packages that are not development-only.
if command -v node >/dev/null; then
  counts=$(node -e '
    const l = JSON.parse(require("fs").readFileSync(process.argv[1]));
    const c = {}; let n = 0;
    for (const [k, v] of Object.entries(l.packages)) { if (!k || v.dev) continue; n++; c[v.license] = (c[v.license] || 0) + 1; }
    console.log(n + " " + ["MIT", "ISC", "BSD-3-Clause", "BSD-2-Clause", "Unlicense"].map((x) => c[x] || 0).join(" ") + " " + Object.keys(c).length);
  ' "$ROOT/adapters/buzz/package-lock.json")
  read -r n mit isc bsd3 bsd2 un kinds <<<"$counts"
  check "the lockfile has only those five licences" test "$kinds" = 5
  check "the note says $n packages" grep -qF "$n packages" "$NOTE"
  check "the note's counts are the lockfile's" grep -qF "MIT ($mit), ISC ($isc), BSD-3-Clause ($bsd3), BSD-2-Clause ($bsd2), Unlicense ($un" "$NOTE"
fi

echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
