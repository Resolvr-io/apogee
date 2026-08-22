#!/usr/bin/env bash
set -euo pipefail

# Deterministic release zip — ONE recipe, called by both `pnpm zip` (local) and
# .github/workflows/release.yml.
#
# Why it's shared: the release publishes a SHA-256, and the first thing anyone
# verifying it does is rebuild from the tagged commit and compare. If the local
# and CI recipes differ at all — entry order, timestamps, directory entries —
# the digests disagree and the checksum is worse than useless, because it looks
# like tampering.
#
# Usage: build-release-zip.sh <output-zip> [source-epoch]
#   source-epoch defaults to the current HEAD's commit time.

OUT="${1:?usage: build-release-zip.sh <output-zip> [source-epoch]}"
EPOCH="${2:-$(git log -1 --format=%ct)}"

mkdir -p "$(dirname "$OUT")"
OUT_ABS="$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")"
rm -f "$OUT_ABS"

# zip stores a per-file mtime, so the same tree yields different bytes on every
# build unless they're pinned. Info-ZIP does not read SOURCE_DATE_EPOCH itself,
# which is why this is an explicit touch rather than just exporting the var.
# GNU date first (CI is ubuntu-latest), BSD date second (a maintainer's mac) —
# the two spell the same operation incompatibly.
if ! TOUCH_TS="$(date -u -d "@${EPOCH}" +%Y%m%d%H%M.%S 2>/dev/null)"; then
  TOUCH_TS="$(date -u -r "${EPOCH}" +%Y%m%d%H%M.%S)"
fi
find dist -exec touch -t "$TOUCH_TS" {} +

# A sorted file list, not `zip -r`: -r walks in filesystem order, which is not
# stable across machines. `find -type f` also emits no directory entries, so
# the archive has none — unzip and the Chrome Web Store both create parents
# implicitly, so this is safe, but it IS a change in artifact contents worth
# knowing before anyone "restores" -r and silently breaks the digest.
(cd dist && find . -type f ! -name '*.DS_Store' | LC_ALL=C sort | zip -X "$OUT_ABS" -@)

echo "Wrote $OUT_ABS"
unzip -l "$OUT_ABS" | tail -3
