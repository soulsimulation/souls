#!/usr/bin/env bash
# Start any moved world fresh from its own kept facts, on a release's build, under the same world name (0.133).
# reseed-eden.sh does this for Eden alone (the world in cutover.env) as a release step; this takes the world by name,
# for a world whose import changed (Chiba's entrance in mars-college-2026, 0.133). Re-seeding a world needs Gene's yes.
#
# WHAT THIS DOES, in plain words. A world's tree is built from its log, seeded once from its facts, so an importer fix
# reaches it only through a fresh seed. It:
#   - stops the world and its gateway;
#   - MOVES the world's folder to /var/lib/souls/worlds/aside/ (renamed, nothing deleted);
#   - MOVES this world's objects in the directory's bucket (its record, checkpoints, shipped log parts, stream recovery
#     and history; only this world's keys) under aside/<time>/ in the same bucket. Each object is copied, read back and
#     compared (length and SHA-256) before any original is deleted, and no original is deleted until every copy checks.
#     Nothing else in the bucket is touched: not accounts, not Souls, not other worlds;
#   - seeds a fresh world from the same facts with the release's build (its creator, entry point and bodies kept), puts
#     it where the old one was, pins that build and starts the gateway, and the world again if it was running.
# The release's build may be the one the world is pinned to already: that is the case for an importer fix that
# shipped with it.
# Undo: reseed-eden-undo.sh <time> (it reads the world from the reseed's receipt; printed at the end).
#
#   bash reseed-world.sh <world> <sha> check                  reads and prints every value; changes nothing
#   bash reseed-world.sh <world> <sha> run                    the check, then the steps above
#   bash reseed-world.sh <world> <sha> resume <time> check    for a run that stopped: which steps are done
#   bash reseed-world.sh <world> <sha> resume <time> run      the steps not yet done, in order (a copy already made in
#                                                             the bucket with the same bytes counts as made; one with
#                                                             other bytes refuses)
#
# <world> is the world's name, its folder under /var/lib/souls/worlds/worlds/ (<32 hex>-<32 hex>-<n>). <sha> is the
# release's full commit: its build is the worldd its staged manifest names (/var/lib/souls/releases/<sha>/
# manifest.json; a release-v2 dry run stages it), with its own world-aside in bin/ and its kinds in reseed/kinds. Root
# on the production host. RESEED_* stand in for the host's folders in a test (reseed-world.test.mjs).
set -euo pipefail

DATA=${RESEED_DATA:-/var/lib/souls}
ETC=${RESEED_ETC:-/etc/souls}
LIB=${RESEED_LIB:-/usr/local/lib/souls}
ROOT=$DATA/worlds

die() {
  echo "reseed-world: refused: $*" >&2
  exit 1
}
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
# A store call that can fail for a dropped connection: tried again after 2, 4, 8 and 16 s before the reseed refuses.
# Only calls that are safe to repeat (a read, or setting the pin to the same build) go through it.
patient() {
  local wait
  for wait in 2 4 8 16; do
    "$@" && return 0
    echo "reseed-world: '$1 ${2:-}' failed; trying again in $wait s" >&2
    sleep "$wait"
  done
  "$@"
}
usage() {
  sed -n 2,31p "$0"
  exit 2
}
RESUME=''
WORLD=${1:-}
SHA=${2:-}
[[ "$WORLD" =~ ^[0-9a-f]{32}-[0-9a-f]{32}-[0-9]+$ ]] && [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || usage
case ${3:-} in
  check | run) ACT=$3 ;;
  resume)
    RESUME=${4:-} ACT=${5:-}
    [[ "$RESUME" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && { [ "$ACT" = check ] || [ "$ACT" = run ]; } || die "<world> <sha> resume <time> check|run"
    ;;
  *) usage ;;
esac
[ -n "${RESEED_DATA:-}" ] || [ "$(id -u)" = 0 ] || die "run as root"

# The bucket: the one deploy and worldd@ read (release.sh's directory_env).
if [ -f "$ETC/directory.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$ETC/directory.env"
  set +a
fi
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
export WORLDS_ROOT=$ROOT

OLD_DIR=$ROOT/worlds/$WORLD
REL=$DATA/releases/$SHA
[ -f "$REL/manifest.json" ] || die "release $SHA is not staged ($REL/manifest.json): a release-v2 dry run stages it"
[ "$(sed -n 's/^{"commit":"\([0-9a-f]\{40\}\)".*/\1/p' "$REL/manifest.json")" = "$SHA" ] || die "$REL/manifest.json is not release $SHA's"
NEW=$(sed -n 's/^{"name":"worldd","hash":"\(1220[0-9a-f]\{64\}\)".*/\1/p' "$REL/manifest.json")
VERSION=$(sed -n 's/^{"commit":"[0-9a-f]\{40\}","version":"\([0-9.]*\)".*/\1/p' "$REL/manifest.json")
[ -n "$VERSION" ] || die "no version in $REL/manifest.json"
[ -n "$NEW" ] || die "no worldd in $REL/manifest.json"
NEW_WORLDD=$ROOT/builds/$NEW/worldd
[ -x "$NEW_WORLDD" ] && [ "$("$LIB/supervisor" hash "$NEW_WORLDD")" = "$NEW" ] || die "$NEW_WORLDD is missing or not $NEW"
# The release's own world-aside and kinds (a release staged from 0.133 on carries both).
TOOL=${RESEED_TOOL:-$REL/bin/world-aside}
ENTRIES=${RESEED_ENTRIES:-$REL/reseed/kinds}
[ -x "$TOOL" ] || die "world-aside is not at $TOOL (a release staged before 0.133 carries none)"
KINDS=$(grep -rl '"format": *"souls-entry/1"' "$ENTRIES" 2> /dev/null | wc -l | tr -d ' ')
[ "$KINDS" -gt 0 ] || die "no kind entries under $ENTRIES"
PINNED=$(patient "$REL/bin/deploy" pinned "$WORLD") || die "the world's pin could not be read"

if [ -n "$RESUME" ]; then
  STAMP=$RESUME
  RECEIPT=$ROOT/aside/$WORLD-$STAMP.reseed
  [ -f "$RECEIPT" ] || die "no reseed $STAMP of $WORLD to resume ($RECEIPT)"
  ! grep -q '^undone=' "$RECEIPT" || die "reseed $STAMP was undone: start a fresh reseed instead"
  OLD=$(sed -n 's/^old=//p' "$RECEIPT")
  [ "$(sed -n 's/^new=//p' "$RECEIPT")" = "$NEW" ] || die "reseed $STAMP was for another build"
  RUNNING=$(sed -n 's/^running=//p' "$RECEIPT")
else
  # A fresh reseed only with no earlier reseed of this world to this build left un-undone: that is one to resume, not
  # to start again (0.133 R13). Every reseed writes its receipt before it changes anything.
  for r in "$ROOT"/aside/"$WORLD"-*.reseed; do
    [ -f "$r" ] || continue
    if [ "$(sed -n 's/^new=//p' "$r")" = "$NEW" ] && ! grep -q '^undone=' "$r"; then
      l=$(sed -n 's/^label=//p' "$r")
      die "reseed $l to this build is not undone: resume it ($0 $WORLD $SHA resume $l check), or undo it first"
    fi
  done
  STAMP=${RESEED_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
  RECEIPT=$ROOT/aside/$WORLD-$STAMP.reseed
  OLD=$PINNED
  RUNNING=no
  [ "$(systemctl is-active "worldd@$WORLD" || true)" = active ] && RUNNING=yes
fi
[[ "$OLD" =~ ^1220[0-9a-f]{64}$ ]] || die "the world's pin '$OLD' is no build"
ASIDE_DIR=$ROOT/aside/$WORLD-$STAMP
SEED_DIR=$ROOT/aside/.seed-$WORLD-$STAMP
# Where the old world's facts and world.json are now: still in place, or already aside.
SRC_DIR=$OLD_DIR
[ -d "$ASIDE_DIR" ] && SRC_DIR=$ASIDE_DIR
[ -f "$SRC_DIR/facts.json" ] && [ -f "$SRC_DIR/world.json" ] || die "$SRC_DIR has no facts.json or world.json"
CREATOR=$(sed -n 's/.*"creator": *"\([0-9a-f]\{32\}-[0-9]*\)".*/\1/p' "$SRC_DIR/world.json")
ENTRY=$(sed -n 's/.*"entry": *\[\(-\{0,1\}[0-9]*\), *\(-\{0,1\}[0-9]*\)\].*/\1 \2/p' "$SRC_DIR/world.json")
[ -n "$ENTRY" ] || ENTRY="0 0"
AT=$(awk -v e="$ENTRY" 'BEGIN { split(e, p, " "); printf "%.3f,%.3f", p[1] / 1000, p[2] / 1000 }')
# The place its Souls arrive at, when world.json names one (`worldd arrival`): kept by the fresh seed.
ARRIVAL=$(sed -n 's/.*"arrival": *"\([A-Za-z0-9_.:-]*\)".*/\1/p' "$SRC_DIR/world.json")
if grep -q '"arrival"' "$SRC_DIR/world.json" && [ -z "$ARRIVAL" ]; then die "world.json names an arrival place this cannot read"; fi
BODIES=''
[ -f "$SRC_DIR/bodies.json" ] && BODIES=bodies.json
if [ -n "${DIRECTORY_STORE_URL:-}${DIRECTORY_STORE_ENDPOINT:-}" ]; then STORE_WHAT="the directory's bucket (DIRECTORY_STORE_*)"; else STORE_WHAT="the folder $ROOT/directory"; fi
count() { "$TOOL" "$WORLD" "$@" --dry-run | sed -n 's/^dry run: \([0-9]*\) objects.*/\1/p'; }
IN_PLACE=$(count --label "$STAMP")
COPIED=0
[ -z "$RESUME" ] || COPIED=$(count --back "$STAMP")

# Which steps are done (a fresh run: none).
done1=no done2=no done3=no done5=no
if [ -n "$RESUME" ]; then
  [ "$(systemctl is-active "worldd@$WORLD" || true)" != active ] && done1=yes
  [ -d "$ASIDE_DIR" ] && done2=yes
  if grep -qx 'bucket=moved' "$RECEIPT" || { [ "$IN_PLACE" = 0 ] && [ "$COPIED" -gt 0 ]; }; then done3=yes; fi
  [ "$done2" = yes ] && [ -f "$OLD_DIR/world.json" ] && done5=yes
else
  [ ! -e "$ASIDE_DIR" ] && [ ! -e "$SEED_DIR" ] && [ ! -e "$RECEIPT" ] || die "$ASIDE_DIR, $SEED_DIR or $RECEIPT exists: resume it instead"
  [ -d "$OLD_DIR" ] || die "no world folder at $OLD_DIR"
fi

echo "reseed-world: world            $WORLD"
echo "reseed-world: label            $STAMP$([ -n "$RESUME" ] && echo ' (resuming)')"
echo "reseed-world: its folder       $([ "$done2" = yes ] && echo "aside at $ASIDE_DIR" || echo "$OLD_DIR ($(du -sh "$OLD_DIR" | cut -f1)), moves to $ASIDE_DIR")"
echo "reseed-world: pinned now       $PINNED"
echo "reseed-world: the old build    $OLD"
echo "reseed-world: the release      $VERSION at $SHA, its worldd $NEW$([ "$OLD" = "$NEW" ] && echo ' (the build it is on)')"
echo "reseed-world: store            $STORE_WHAT"
echo "reseed-world: world-aside      $TOOL"
echo "reseed-world: facts            $SRC_DIR/facts.json, sha256 $(sha256 "$SRC_DIR/facts.json")"
echo "reseed-world: kind entries     $ENTRIES ($KINDS entries)"
# whether it has one, not its account id: this line may reach a public log
echo "reseed-world: creator          $([ -n "$CREATOR" ] && echo "kept (from world.json)" || echo none)"
echo "reseed-world: entry point      $AT m"
echo "reseed-world: arrival place    ${ARRIVAL:-none (the entry point)}"
echo "reseed-world: bodies           ${BODIES:-none}"
echo "reseed-world: units            worldd@ $(systemctl is-active "worldd@$WORLD" || true), souls-gateway@ $(systemctl is-active "souls-gateway@$WORLD" || true); at the end the gateway starts$([ "$RUNNING" = yes ] && echo ', and the world (it was running)')"
echo "reseed-world: bucket           $IN_PLACE of the world's objects at their keys; $COPIED already copied under aside/$STAMP/"
if [ -n "$RESUME" ]; then
  echo "reseed-world: steps done       1 stop: $done1; 2 folder aside: $done2; 3 bucket aside: $done3; 4-5 fresh seed in place: $done5; 6 pin and 7 start: at the end"
fi
[ "$ACT" = run ] || {
  echo "reseed-world: check only; nothing changed"
  exit 0
}

echo "reseed-world: 1. stop the world and its gateway"
mkdir -p "$ROOT/aside"
[ -f "$RECEIPT" ] || printf 'world=%s\nold=%s\nnew=%s\nlabel=%s\nrunning=%s\n' "$WORLD" "$OLD" "$NEW" "$STAMP" "$RUNNING" > "$RECEIPT"
systemctl stop "souls-gateway@$WORLD" "worldd@$WORLD"
if [ "$done2" = yes ]; then echo "reseed-world: 2. the folder: already aside"; else
  echo "reseed-world: 2. the folder aside: $ASIDE_DIR"
  mv "$OLD_DIR" "$ASIDE_DIR"
fi
if [ "$done3" = yes ]; then echo "reseed-world: 3. the bucket objects: already aside"; else
  echo "reseed-world: 3. the bucket objects aside: aside/$STAMP/"
  "$TOOL" "$WORLD" --label "$STAMP" || die "the bucket move refused (no original deleted); resume: bash $0 $WORLD $SHA resume $STAMP check"
fi
grep -qx 'bucket=moved' "$RECEIPT" || echo 'bucket=moved' >> "$RECEIPT"
if [ "$done5" = yes ]; then echo "reseed-world: 4-5. the fresh seed: already in place"; else
  echo "reseed-world: 4. a fresh seed with the release's build"
  if [ -e "$SEED_DIR" ]; then mv "$SEED_DIR" "$SEED_DIR.stopped-$(date -u +%Y%m%dT%H%M%SZ)"; fi
  args=(seed --facts "$ASIDE_DIR/facts.json" --dir "$SEED_DIR" --entries "$ENTRIES" --souls 0 --at "$AT")
  if [ -n "$CREATOR" ]; then args+=(--creator "$CREATOR"); fi
  if [ -n "$ARRIVAL" ]; then args+=(--arrival "$ARRIVAL"); fi
  if [ -n "$BODIES" ]; then args+=(--bodies "$ASIDE_DIR/bodies.json"); fi
  SEEDED=$("$NEW_WORLDD" "${args[@]}" | sed -n 's/^seeded //p')
  [ "$SEEDED" = "$WORLD" ] || die "the seed is '$SEEDED', not $WORLD (left at $SEED_DIR); undo: bash $(dirname "$0")/reseed-eden-undo.sh $STAMP check"
  echo "reseed-world: 5. the fresh folder in place"
  mv "$SEED_DIR" "$OLD_DIR"
  mkdir -p "$OLD_DIR/views" "$OLD_DIR/history" "$OLD_DIR/receipts"
  if [ -z "${RESEED_DATA:-}" ] && id souls > /dev/null 2>&1; then chown -R souls:souls "$OLD_DIR"; fi
fi
echo "reseed-world: 6. pin the release's build"
patient "$LIB/supervisor" pin "$WORLD" "$NEW" || die "the pin refused; resume: bash $0 $WORLD $SHA resume $STAMP check"
[ "$(patient "$REL/bin/deploy" pinned "$WORLD")" = "$NEW" ] || die "the pin did not take"
if [ "$RUNNING" = yes ]; then
  echo "reseed-world: 7. start the world and its gateway"
  systemctl start "worldd@$WORLD" "souls-gateway@$WORLD"
else
  echo "reseed-world: 7. start the gateway; the world was not running, and stays stopped"
  systemctl start "souls-gateway@$WORLD"
fi
echo "reseed-world: done: $WORLD is fresh from its facts, pinned to ${NEW:0:16}…"
echo "reseed-world: undo: bash $(dirname "$0")/reseed-eden-undo.sh $STAMP check, then run"
