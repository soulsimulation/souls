#!/usr/bin/env bash
# 0.132: start Eden's new-engine world fresh, on today's build, under the same world name.
#
# WHAT THIS DOES, in plain words. Today's build (0.132, 2d90b525d5d8) cannot read the Eden store the 22 Nov build wrote
# (its first record names another header), so the release refused to move it. This gives Eden a fresh start from the
# same import instead. It:
#   - stops Eden's new-engine world and its gateway (Eden's page is still served by the old engine until
#     switch-eden.sh, so visitors see no change);
#   - MOVES the world's folder to /var/lib/souls/worlds/aside/ (renamed, nothing deleted);
#   - MOVES this world's objects in the directory's bucket (its record, checkpoints, shipped log parts, stream recovery
#     and history; only this world's keys) under aside/<time>/ in the same bucket. Each object is copied, read back and
#     compared (length and SHA-256) before any original is deleted, and no original is deleted until every copy checks.
#     Nothing else in the bucket is touched: not accounts, not Souls, not the name "eden", not other worlds;
#   - seeds a fresh world from the same facts with today's build, puts it where the old one was, pins today's build and
#     starts the gateway. The world itself stays stopped: release-v2 starts it.
# Undo: reseed-eden-undo.sh <time> (printed at the end).
#
#   bash reseed-eden.sh check     reads and prints every value; changes nothing
#   bash reseed-eden.sh run       the check, then the steps above
#
# Root on the production host, with the release staged (release-v2's failed run staged it) and the one-off
# `world-aside` (v2/tools/ops/src/world_aside.rs) at /var/lib/souls/oneoff/world-aside. RESEED_* stand in for the
# host's folders in a test.
set -euo pipefail

SHA=2d90b525d5d82f3626f6d6c3cbd67810133bdd0f
ASIDE_TOOL_SHA256=${RESEED_TOOL_SHA256:-2c2ba77145c024d9741d855ec79d40168b0eb98c6c5a208f99bcbed411015892}
DATA=${RESEED_DATA:-/var/lib/souls}
ETC=${RESEED_ETC:-/etc/souls}
LIB=${RESEED_LIB:-/usr/local/lib/souls}
LIVE=${RESEED_LIVE:-/srv/sim-worlds/production}
ENTRIES=${RESEED_ENTRIES:-$LIVE/content/kinds}
TOOL=${RESEED_TOOL:-$DATA/oneoff/world-aside}
ROOT=$DATA/worlds

die() {
  echo "reseed: refused: $*" >&2
  exit 1
}
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
mode=${1:-}
[ "$mode" = check ] || [ "$mode" = run ] || {
  sed -n 2,24p "$0"
  exit 2
}
[ -n "${RESEED_DATA:-}" ] || [ "$(id -u)" = 0 ] || die "run as root"

# The bucket: the one deploy and worldd@ read (release.sh's directory_env).
if [ -r "$ETC/secrets.env" ]; then
  while IFS='=' read -r k v; do
    k=${k#export }
    case $k in
      DIRECTORY_STORE_* | AWS_ACCESS_KEY_ID | AWS_SECRET_ACCESS_KEY | AWS_DEFAULT_REGION)
        v=${v%\"} v=${v#\"} v=${v%\'} v=${v#\'}
        export "$k=$v"
        ;;
    esac
  done < "$ETC/secrets.env"
fi
if [ -f "$ETC/directory.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ETC/directory.env"
  set +a
fi
export WORLDS_ROOT=$ROOT

WORLD=$(sed -n 's/^WORLD="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$ETC/cutover.env")
[[ "$WORLD" =~ ^[0-9a-f]{32}-[0-9a-f]{32}-[0-9]+$ ]] || die "no world name in $ETC/cutover.env"
OLD_DIR=$ROOT/worlds/$WORLD
REL=$DATA/releases/$SHA
[ -f "$REL/manifest.json" ] || die "release $SHA is not staged ($REL/manifest.json)"
NEW=$(sed -n 's/^{"name":"worldd","hash":"\(1220[0-9a-f]\{64\}\)".*/\1/p' "$REL/manifest.json")
[ -n "$NEW" ] || die "no worldd in $REL/manifest.json"
NEW_WORLDD=$ROOT/builds/$NEW/worldd
[ -x "$NEW_WORLDD" ] && [ "$("$LIB/supervisor" hash "$NEW_WORLDD")" = "$NEW" ] || die "$NEW_WORLDD is missing or not $NEW"
OLD=$("$REL/bin/deploy" pinned "$WORLD") || die "the world's pin could not be read"
[ -f "$OLD_DIR/facts.json" ] && [ -f "$OLD_DIR/world.json" ] || die "$OLD_DIR has no facts.json or world.json"
[ -x "$TOOL" ] || die "the one-off tool is not at $TOOL"
[ "$(sha256 "$TOOL")" = "$ASIDE_TOOL_SHA256" ] || die "$TOOL is not the reviewed build (sha256 $(sha256 "$TOOL"), expected $ASIDE_TOOL_SHA256)"
KINDS=$(grep -rl '"format": *"souls-entry/1"' "$ENTRIES" 2> /dev/null | wc -l | tr -d ' ')
[ "$KINDS" -gt 0 ] || die "no kind entries under $ENTRIES"
CREATOR=$(sed -n 's/.*"creator": *"\([0-9a-f]\{32\}-[0-9]*\)".*/\1/p' "$OLD_DIR/world.json")
ENTRY=$(sed -n 's/.*"entry": *\[\(-\{0,1\}[0-9]*\), *\(-\{0,1\}[0-9]*\)\].*/\1 \2/p' "$OLD_DIR/world.json")
[ -n "$ENTRY" ] || ENTRY="0 0"
AT=$(awk -v e="$ENTRY" 'BEGIN { split(e, p, " "); printf "%.3f,%.3f", p[1] / 1000, p[2] / 1000 }')
BODIES=''
[ -f "$OLD_DIR/bodies.json" ] && BODIES=$OLD_DIR/bodies.json
STAMP=${RESEED_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
ASIDE_DIR=$ROOT/aside/$WORLD-$STAMP
SEED_DIR=$ROOT/aside/.seed-$WORLD-$STAMP
if [ -n "${DIRECTORY_STORE_URL:-}${DIRECTORY_STORE_ENDPOINT:-}" ]; then STORE_WHAT="the directory's bucket (DIRECTORY_STORE_*)"; else STORE_WHAT="the folder $ROOT/directory"; fi

echo "reseed: world            $WORLD"
echo "reseed: its folder       $OLD_DIR ($(du -sh "$OLD_DIR" | cut -f1)), moves to $ASIDE_DIR"
echo "reseed: pinned now       $OLD"
echo "reseed: today's build    $NEW (release $SHA)"
echo "reseed: store            $STORE_WHAT"
echo "reseed: one-off tool     $TOOL, sha256 $ASIDE_TOOL_SHA256 (checked)"
echo "reseed: facts            $OLD_DIR/facts.json, sha256 $(sha256 "$OLD_DIR/facts.json")"
echo "reseed: kind entries     $ENTRIES ($KINDS entries)"
echo "reseed: creator          ${CREATOR:-none}"
echo "reseed: entry point      $AT m"
echo "reseed: bodies           ${BODIES:-none}"
echo "reseed: units            worldd@ $(systemctl is-active "worldd@$WORLD" || true), souls-gateway@ $(systemctl is-active "souls-gateway@$WORLD" || true)"
echo "reseed: label            $STAMP"
echo "reseed: the bucket objects that would move (the last lines of the tool's dry run):"
"$TOOL" "$WORLD" --label "$STAMP" --dry-run | tail -6 | sed 's/^/  /'
[ ! -e "$ASIDE_DIR" ] && [ ! -e "$SEED_DIR" ] || die "$ASIDE_DIR or $SEED_DIR exists"
[ "$mode" = run ] || {
  echo "reseed: check only; nothing changed"
  exit 0
}

echo "reseed: 1. stop the world and its gateway"
systemctl stop "souls-gateway@$WORLD" "worldd@$WORLD"
mkdir -p "$ROOT/aside"
printf 'world=%s\nold=%s\nnew=%s\nlabel=%s\n' "$WORLD" "$OLD" "$NEW" "$STAMP" > "$ROOT/aside/$WORLD-$STAMP.reseed"
echo "reseed: 2. the folder aside: $ASIDE_DIR"
mv "$OLD_DIR" "$ASIDE_DIR"
echo "reseed: 3. the bucket objects aside: aside/$STAMP/"
"$TOOL" "$WORLD" --label "$STAMP" || die "the bucket move refused (no original deleted); undo: bash $(dirname "$0")/reseed-eden-undo.sh $STAMP"
echo "reseed: 4. a fresh seed with today's build"
args=(seed --facts "$ASIDE_DIR/facts.json" --dir "$SEED_DIR" --entries "$ENTRIES" --souls 0 --at "$AT")
if [ -n "$CREATOR" ]; then args+=(--creator "$CREATOR"); fi
if [ -n "$BODIES" ]; then args+=(--bodies "$ASIDE_DIR/bodies.json"); fi
SEEDED=$("$NEW_WORLDD" "${args[@]}" | sed -n 's/^seeded //p')
[ "$SEEDED" = "$WORLD" ] || die "the seed is '$SEEDED', not $WORLD (left at $SEED_DIR); undo: bash $(dirname "$0")/reseed-eden-undo.sh $STAMP"
echo "reseed: 5. the fresh folder in place"
mv "$SEED_DIR" "$OLD_DIR"
mkdir -p "$OLD_DIR/views" "$OLD_DIR/history" "$OLD_DIR/receipts"
if [ -z "${RESEED_DATA:-}" ] && id souls > /dev/null 2>&1; then chown -R souls:souls "$OLD_DIR"; fi
echo "reseed: 6. pin today's build"
"$LIB/supervisor" pin "$WORLD" "$NEW"
[ "$("$REL/bin/deploy" pinned "$WORLD")" = "$NEW" ] || die "the pin did not take"
echo "reseed: 7. start the gateway; the world stays stopped until release-v2 starts it"
systemctl start "souls-gateway@$WORLD"
echo "reseed: done: $WORLD is fresh, pinned to ${NEW:0:16}…, its world stopped, its gateway started"
echo "reseed: next, release-v2 again:"
echo "  gh workflow run release-v2.yml --ref main -f version=0.132 -f sha=$SHA -f dry_run=false -f target=production"
echo "reseed: undo: bash $(dirname "$0")/reseed-eden-undo.sh $STAMP"
