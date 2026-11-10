#!/usr/bin/env bash
# publish-copy.sh <out-dir> <dest-dir> [--scrub]: copies a run's results into the folder that is committed to playtest-results,
# then scrubs (spec arms: --scrub, publish-scrub.mjs) and guards (secret-guard.sh) that copy only. The run's own folder is never
# changed, so what retention keeps (world data, seat folders) survives publishing (#1311).
# Exit 0: <dest-dir> is ready to commit. 7: the scrub failed. 3: the guard found a token-shaped string or couldn't scan; the
# offending file names (never their contents) are printed. On 3 or 7, <dest-dir> is removed so nothing of it is committed.
set -uo pipefail
OUT="${1:-}"; DEST="${2:-}"; SCRUB="${3:-}"; HERE="$(cd "$(dirname "$0")" && pwd)"
[ -n "$OUT" ] && [ -d "$OUT" ] || { echo "usage: publish-copy.sh <out-dir> <dest-dir> [--scrub]" >&2; exit 2; }
case "$DEST" in ""|/|.|..) echo "refusing dest-dir '$DEST'" >&2; exit 2 ;; esac
[ "$(cd "$OUT" && pwd -P)" != "$(mkdir -p "$DEST" && cd "$DEST" && pwd -P)" ] || { echo "dest-dir is the run's own folder" >&2; exit 2; }
drop() { rm -rf "$DEST"; }
rsync -a --delete --exclude '.cloud-times' "$OUT/" "$DEST/" 2>/dev/null || { drop; mkdir -p "$DEST"; cp -a "$OUT/." "$DEST/" && rm -f "$DEST/.cloud-times" || { drop; exit 7; }; }
if [ "$SCRUB" = "--scrub" ]; then node "$HERE/publish-scrub.mjs" "$DEST" >&2 || { drop; exit 7; }; fi
HITS="$(bash "$HERE/secret-guard.sh" "$DEST" 2>/dev/null)"; rc=$?
if [ "$rc" -ne 0 ]; then printf '%s\n' "$HITS" | sed "s#^$DEST/##"; drop; exit 3; fi
# GitHub refuses files over 100 MB: leave those out and list them
find "$DEST" -type f -size +95M -print -delete | sed "s#^$DEST/##" > "$DEST/OMITTED-LARGE-FILES.txt" || true
[ -s "$DEST/OMITTED-LARGE-FILES.txt" ] || rm -f "$DEST/OMITTED-LARGE-FILES.txt"
exit 0
