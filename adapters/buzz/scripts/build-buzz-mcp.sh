#!/bin/sh
# Builds Block's buzz-mcp (the Buzz tools as a stdio MCP server) at exactly
# the block/buzz-app commit named in buzz-mcp.pin, and puts the result where
# launch.mjs looks for it:
#
#   $BUZZ_MCP_CACHE/buzz-mcp.mjs      the built server
#   $BUZZ_MCP_CACHE/buzz-mcp.commit   the commit it was built from
#
# BUZZ_MCP_CACHE defaults to ${XDG_CACHE_HOME:-$HOME/.cache}/ghost-protocol/buzz.
# Everything (the buzz-app checkout, its package store) stays inside that
# directory. Running it again with the same pin does nothing. Pass --force to
# rebuild anyway.
#
# Needs: git, Node.js with corepack (or pnpm), network access to GitHub and npm.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
pin_file="$here/buzz-mcp.pin"
repo=$(sed -n 's/^repo=//p' "$pin_file")
pin=$(sed -n 's/^commit=//p' "$pin_file")
case "$pin" in
*[!0-9a-f]* | "") echo "build-buzz-mcp: buzz-mcp.pin has no valid commit= line" >&2; exit 1 ;;
esac
[ ${#pin} -eq 40 ] || { echo "build-buzz-mcp: the pinned commit must be a full 40-character id" >&2; exit 1; }

cache=${BUZZ_MCP_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/ghost-protocol/buzz}
src="$cache/buzz-app"
out="$cache/buzz-mcp.mjs"
stamp="$cache/buzz-mcp.commit"

if [ "${1:-}" != "--force" ] && [ -f "$out" ] && [ "$(cat "$stamp" 2>/dev/null)" = "$pin" ]; then
	echo "buzz-mcp is already built from $repo at $pin"
	echo "  $out"
	exit 0
fi

mkdir -p "$cache"
if [ ! -d "$src/.git" ]; then
	git init --quiet "$src"
	git -C "$src" remote add origin "$repo"
fi
git -C "$src" remote set-url origin "$repo"
echo "fetching $repo at $pin"
git -C "$src" fetch --quiet --depth 1 origin "$pin"
git -C "$src" checkout --quiet --force --detach FETCH_HEAD
head=$(git -C "$src" rev-parse HEAD)
[ "$head" = "$pin" ] || { echo "build-buzz-mcp: checked out $head, expected $pin" >&2; exit 1; }

# buzz-app names its pnpm version in package.json; corepack runs exactly that one.
if command -v corepack >/dev/null 2>&1; then
	pnpm="corepack pnpm"
else
	pnpm="pnpm"
fi
echo "installing buzz-app dependencies (store: $cache/pnpm-store)"
(cd "$src" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 $pnpm install --frozen-lockfile --ignore-scripts --store-dir "$cache/pnpm-store")
echo "building buzz-mcp"
(cd "$src" && COREPACK_ENABLE_DOWNLOAD_PROMPT=0 $pnpm run buzz-mcp)

built="$src/dist-buzz-mcp/buzz-mcp.mjs"
[ -f "$built" ] || { echo "build-buzz-mcp: the build did not produce $built" >&2; exit 1; }
cp "$built" "$out.tmp"
mv "$out.tmp" "$out"
printf '%s\n' "$pin" >"$stamp"

size=$(wc -c <"$out" | tr -d ' ')
if command -v shasum >/dev/null 2>&1; then
	sum=$(shasum -a 256 "$out" | cut -d' ' -f1)
else
	sum=$(sha256sum "$out" | cut -d' ' -f1)
fi
echo "built buzz-mcp from $repo at $pin"
echo "  $out ($size bytes, sha256 $sum)"
