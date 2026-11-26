#!/usr/bin/env bash
# Start Eden's new-engine world fresh, on a release's build, under the same world name (0.132, 0.132.1).
#
# WHAT THIS DOES, in plain words. A new build may not read the Eden store an older build wrote (its first record names
# another header), and then the release refuses to move it. This gives Eden a fresh start from the same import on the
# release's build instead. It:
#   - stops Eden's new-engine world and its gateway (Eden's page is still served by the old engine until
#     switch-eden.sh, so visitors see no change);
#   - MOVES the world's folder to /var/lib/souls/worlds/aside/ (renamed, nothing deleted);
#   - seeds a fresh world from the same facts with the release's build (and Eden's stock the release carries, #4837)
#     on a fresh STORE GENERATION (#4954): its folder's `generation` file names <time>, so its own objects in the
#     directory's bucket (record, checkpoints, log parts, stream recovery, history) go under g/<time>/. Nothing in the
#     bucket moves or is written for the old world: its objects stay at their keys, which the old folder, set aside,
#     still names. (Before #4954 a reseed copied every one of them aside first: about 36,500 for Eden, hours on a slow
#     store, with the world down meanwhile.)
#   - puts the fresh folder where the old one was, pins that build in its own record and starts the gateway. The world
#     itself stays stopped: release-v2 starts it.
# The installed supervisor (the launcher every world's unit runs) and the release's worldd and deploy must read the
# `generation` file; the check refuses otherwise. A world on a fresh generation must not be rolled back to a build that
# predates it: such a build reads the old world's record and ships nothing.
# Back in time on the fresh world starts at the reseed; the old world's history stays whole where it was and comes back
# with the undo. Undo: reseed-eden-undo.sh <time> (printed at the end): the old folder back, nothing moved in the store.
#
#   bash reseed-eden.sh <sha> check                  reads and prints every value; changes nothing
#   bash reseed-eden.sh <sha> run                    the check, then the steps above
#   bash reseed-eden.sh <sha> resume <time> check    for a run that stopped: which steps are done; changes nothing
#   bash reseed-eden.sh <sha> resume <time> run      the steps not yet done, in order
#
# <sha> is the release's full commit: its build is the worldd its staged manifest names
# (/var/lib/souls/releases/<sha>/manifest.json; a release-v2 dry run stages it). Root on the production host, with
# that release staged; it seeds with the kinds the release carries (reseed/kinds: content/kinds at its commit), else
# the live old page's content/kinds. release-v2 runs it as a step (input reseed; release.sh reseed). Store calls that
# fail for a dropped connection or a 5xx are tried again with back-off (0.133 R13). RESEED_* stand in for the host's
# folders in a test.
set -euo pipefail

DATA=${RESEED_DATA:-/var/lib/souls}
ETC=${RESEED_ETC:-/etc/souls}
LIB=${RESEED_LIB:-/usr/local/lib/souls}
LIVE=${RESEED_LIVE:-/srv/sim-worlds/production}
ROOT=$DATA/worlds

die() {
  echo "reseed: refused: $*" >&2
  exit 1
}
sha256() { if command -v sha256sum > /dev/null; then sha256sum "$1" | cut -c1-64; else shasum -a 256 "$1" | cut -c1-64; fi; }
# A store call that can fail for a dropped connection: tried again after 2, 4, 8 and 16 s before the reseed refuses.
# Only calls that are safe to repeat (a read, or setting the pin to the same build) go through it.
patient() {
  local wait
  for wait in 2 4 8 16; do
    "$@" && return 0
    echo "reseed: '$1 ${2:-}' failed; trying again in $wait s" >&2
    sleep "$wait"
  done
  "$@"
}
RESUME=''
SHA=${1:-}
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || {
  sed -n 2,34p "$0"
  exit 2
}
case ${2:-} in
  check | run) ACT=$2 ;;
  resume)
    RESUME=${3:-} ACT=${4:-}
    [[ "$RESUME" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && { [ "$ACT" = check ] || [ "$ACT" = run ]; } || die "<sha> resume <time> check|run"
    ;;
  *)
    sed -n 2,34p "$0"
    exit 2
    ;;
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

WORLD=$(sed -n 's/^WORLD="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "$ETC/cutover.env")
[[ "$WORLD" =~ ^[0-9a-f]{32}-[0-9a-f]{32}-[0-9]+$ ]] || die "no world name in $ETC/cutover.env"
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
# The release's own kinds when it carries them (staged from 0.133 on), else the live old page's.
if [ -n "${RESEED_ENTRIES:-}" ]; then ENTRIES=$RESEED_ENTRIES; elif [ -d "$REL/reseed/kinds" ]; then ENTRIES=$REL/reseed/kinds; else ENTRIES=$LIVE/content/kinds; fi
# A fresh world's own objects go under its store generation (#4954): every program that reads its record must read the
# folder's `generation` file. The installed launcher says its world's generation; the release's worldd and deploy carry
# the refusal a bad file gets (a build before #4954 has neither, and would read the old world's record).
"$LIB/supervisor" generation "$WORLD" > /dev/null 2>&1 || die "the installed supervisor ($LIB/supervisor) reads no store generation (#4954): install-v2 from a commit that carries it, then reseed"
for b in "$NEW_WORLDD" "$REL/bin/deploy"; do
  grep -qa 'generation-bad: ' "$b" || die "$b reads no store generation (#4954): reseed with a release that carries it"
done
# `|| true` in a probe: under pipefail one that finds nothing (or a seed that fails) would end the script before its
# refusal says why (#4954).
KINDS=$({ grep -rl '"format": *"souls-entry/1"' "$ENTRIES" 2> /dev/null || true; } | wc -l | tr -d ' ')
[ "$KINDS" -gt 0 ] || die "no kind entries under $ENTRIES"
PINNED=$(patient "$REL/bin/deploy" pinned "$WORLD") || die "the world's pin could not be read"

if [ -n "$RESUME" ]; then
  STAMP=$RESUME
  RECEIPT=$ROOT/aside/$WORLD-$STAMP.reseed
  [ -f "$RECEIPT" ] || die "no reseed $STAMP to resume ($RECEIPT)"
  ! grep -q '^undone=' "$RECEIPT" || die "reseed $STAMP was undone: start a fresh reseed instead"
  grep -qx "store=g/$STAMP/" "$RECEIPT" || die "reseed $STAMP moved its store objects aside (a reseed before #4954): finish or undo it with the release it ran with"
  OLD=$(sed -n 's/^old=//p' "$RECEIPT")
  [ "$(sed -n 's/^new=//p' "$RECEIPT")" = "$NEW" ] || die "reseed $STAMP was for another build"
else
  # A fresh reseed only from a world not yet on this build, and with no earlier reseed to this build left un-undone:
  # either of those is a reseed to resume, not to start again (0.133 R13).
  for r in "$ROOT"/aside/"$WORLD"-*.reseed; do
    [ -f "$r" ] || continue
    if [ "$(sed -n 's/^new=//p' "$r")" = "$NEW" ] && ! grep -q '^undone=' "$r"; then
      l=$(sed -n 's/^label=//p' "$r")
      die "reseed $l to this build is not undone: resume it (reseed=$l; by hand: $0 $SHA resume $l check), or undo it first"
    fi
  done
  [ "$PINNED" != "$NEW" ] || die "the world is already pinned to this build ($NEW): nothing to reseed fresh; resume a reseed that stopped with its label"
  STAMP=${RESEED_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
  RECEIPT=$ROOT/aside/$WORLD-$STAMP.reseed
  OLD=$PINNED
fi
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
# Eden's stock and the libraries it draws (#4837): the release's (reseed/stock: stock.json and library/, as a world
# folder keeps them), else the world's own kept copy, else none (a take then carries no title).
STOCK=''
if [ -f "$REL/reseed/stock/stock.json" ]; then STOCK=$REL/reseed/stock/stock.json; elif [ -f "$SRC_DIR/stock.json" ]; then STOCK=kept; fi
if [ -n "${DIRECTORY_STORE_URL:-}${DIRECTORY_STORE_ENDPOINT:-}" ]; then STORE_WHAT="the directory's bucket (DIRECTORY_STORE_*)"; else STORE_WHAT="the folder $ROOT/directory"; fi
# The old world's store generation: the old folder's file (aside once step 2 ran), none for the keys as they are.
OLD_GEN=none
[ ! -f "$SRC_DIR/generation" ] || OLD_GEN=$(tr -d '[:space:]' < "$SRC_DIR/generation")

# Which steps are done (a fresh run: none).
done1=no done2=no done5=no done6=no
if [ -n "$RESUME" ]; then
  [ "$(systemctl is-active "worldd@$WORLD" || true)" != active ] && done1=yes
  [ -d "$ASIDE_DIR" ] && done2=yes
  [ "$done2" = yes ] && [ -f "$OLD_DIR/world.json" ] && [ "$(cat "$OLD_DIR/generation" 2> /dev/null)" = "$STAMP" ] && done5=yes
  [ "$done5" = yes ] && [ "$PINNED" = "$NEW" ] && done6=yes
else
  [ ! -e "$ASIDE_DIR" ] && [ ! -e "$SEED_DIR" ] && [ ! -e "$RECEIPT" ] || die "$ASIDE_DIR, $SEED_DIR or $RECEIPT exists: resume it instead"
  [ -d "$OLD_DIR" ] || die "no world folder at $OLD_DIR"
fi

echo "reseed: world            $WORLD"
echo "reseed: label            $STAMP$([ -n "$RESUME" ] && echo ' (resuming)')"
echo "reseed: its folder       $([ "$done2" = yes ] && echo "aside at $ASIDE_DIR" || echo "$OLD_DIR ($(du -sh "$OLD_DIR" | cut -f1)), moves to $ASIDE_DIR")"
echo "reseed: pinned now       $PINNED"
echo "reseed: the old build    $OLD"
echo "reseed: the release      $VERSION at $SHA, its worldd $NEW"
echo "reseed: store            $STORE_WHAT"
echo "reseed: facts            $SRC_DIR/facts.json, sha256 $(sha256 "$SRC_DIR/facts.json")"
echo "reseed: kind entries     $ENTRIES ($KINDS entries)"
# whether it has one, not its account id: this line reaches the release's public log
echo "reseed: creator          $([ -n "$CREATOR" ] && echo "kept (from world.json)" || echo none)"
echo "reseed: entry point      $AT m"
echo "reseed: arrival place    ${ARRIVAL:-none (the entry point)}"
echo "reseed: bodies           ${BODIES:-none}"
echo "reseed: stock            $([ "$STOCK" = kept ] && echo "the world's own (stock.json, library/)" || echo "${STOCK:-none}")"
echo "reseed: units            worldd@ $(systemctl is-active "worldd@$WORLD" || true), souls-gateway@ $(systemctl is-active "souls-gateway@$WORLD" || true)"
echo "reseed: generation       the fresh world's objects under g/$STAMP/; the old world's ($([ "$OLD_GEN" = none ] && echo 'at their keys' || echo "under g/$OLD_GEN/")) stay where they are: none moves"
if [ -n "$RESUME" ]; then
  echo "reseed: steps done       1 stop: $done1; 2 folder aside: $done2; 3-5 fresh seed in place on g/$STAMP/: $done5; 6 pin: $done6; 7 gateway: started at the end"
fi
[ "$ACT" = run ] || {
  echo "reseed: check only; nothing changed"
  exit 0
}

echo "reseed: 1. stop the world and its gateway"
systemctl stop "souls-gateway@$WORLD" "worldd@$WORLD"
mkdir -p "$ROOT/aside"
[ -f "$RECEIPT" ] || printf 'world=%s\nold=%s\nnew=%s\nlabel=%s\nstore=g/%s/\n' "$WORLD" "$OLD" "$NEW" "$STAMP" "$STAMP" > "$RECEIPT"
if [ "$done2" = yes ]; then echo "reseed: 2. the folder: already aside"; else
  echo "reseed: 2. the folder aside: $ASIDE_DIR"
  mv "$OLD_DIR" "$ASIDE_DIR"
fi
echo "reseed: 3. the store: nothing moves; the fresh world's own objects go under g/$STAMP/"
if [ "$done5" = yes ]; then echo "reseed: 4-5. the fresh seed: already in place"; else
  echo "reseed: 4. a fresh seed with the release's build"
  if [ -e "$SEED_DIR" ]; then mv "$SEED_DIR" "$SEED_DIR.stopped-$(date -u +%Y%m%dT%H%M%SZ)"; fi
  args=(seed --facts "$ASIDE_DIR/facts.json" --dir "$SEED_DIR" --entries "$ENTRIES" --souls 0 --at "$AT")
  if [ -n "$CREATOR" ]; then args+=(--creator "$CREATOR"); fi
  if [ -n "$ARRIVAL" ]; then args+=(--arrival "$ARRIVAL"); fi
  if [ -n "$BODIES" ]; then args+=(--bodies "$ASIDE_DIR/bodies.json"); fi
  if [ "$STOCK" = kept ]; then args+=(--stock "$ASIDE_DIR/stock.json"); elif [ -n "$STOCK" ]; then args+=(--stock "$STOCK"); fi
  SEEDED=$({ "$NEW_WORLDD" "${args[@]}" || true; } | sed -n 's/^seeded //p')
  [ "$SEEDED" = "$WORLD" ] || die "the seed is '$SEEDED', not $WORLD (left at $SEED_DIR); undo: bash $(dirname "$0")/reseed-eden-undo.sh $STAMP check"
  echo "reseed: 5. the fresh folder in place, on store generation g/$STAMP/"
  echo "$STAMP" > "$SEED_DIR/generation"
  mv "$SEED_DIR" "$OLD_DIR"
  mkdir -p "$OLD_DIR/views" "$OLD_DIR/history" "$OLD_DIR/receipts"
  if [ -z "${RESEED_DATA:-}" ] && id souls > /dev/null 2>&1; then chown -R souls:souls "$OLD_DIR"; fi
fi
echo "reseed: 6. pin the release's build"
patient "$LIB/supervisor" pin "$WORLD" "$NEW" || die "the pin refused; resume: bash $0 $SHA resume $STAMP check"
[ "$(patient "$REL/bin/deploy" pinned "$WORLD")" = "$NEW" ] || die "the pin did not take"
echo "reseed: 7. start the gateway; the world stays stopped until release-v2 starts it"
systemctl start "souls-gateway@$WORLD"
echo "reseed: done: $WORLD is fresh, pinned to ${NEW:0:16}…, its world stopped, its gateway started"
echo "reseed: next, release-v2 moves it (within release.yml's run, the next step does)"
echo "reseed: undo: gh workflow run rollback-v2.yml --ref main -f target=production -f reseed=$STAMP"
echo "reseed: (on the host: bash $(dirname "$0")/reseed-eden-undo.sh $STAMP check)"
