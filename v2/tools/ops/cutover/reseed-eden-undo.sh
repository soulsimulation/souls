#!/usr/bin/env bash
# 0.132: undo reseed-eden.sh <time>: Eden's new-engine world back to the folder, bucket objects and pin it had, from
# wherever that reseed stopped.
#
# In plain words: it stops the world and its gateway. If the reseed moved the world's bucket objects aside, it sets the
# fresh world's objects aside in their turn and moves the old ones back (each object copied, read back and compared
# before its original is deleted). If the reseed stopped before that move finished, the old objects never left their
# keys and are left as they are; any copies it made stay under aside/<time>/. It puts the old folder back (the fresh
# one, if any, goes aside), pins the build the world had and starts both. Nothing is deleted without a verified copy.
# Release-v2 must not run while this runs.
#
#   bash reseed-eden-undo.sh <time> check    reads and prints every value and what it would do; changes nothing
#   bash reseed-eden-undo.sh <time> run      the check, then the steps above
#
# <time> is the label reseed-eden.sh printed (YYYYMMDDTHHMMSSZ). Root on the production host. rollback-v2.yml runs it
# (input reseed) with the world-aside of the release the reseed moved Eden to (release.sh reseed-undo).
set -euo pipefail

DATA=${RESEED_DATA:-/var/lib/souls}
ETC=${RESEED_ETC:-/etc/souls}
LIB=${RESEED_LIB:-/usr/local/lib/souls}
TOOL=${RESEED_TOOL:-$DATA/oneoff/world-aside}
ROOT=$DATA/worlds

die() {
  echo "reseed-undo: refused: $*" >&2
  exit 1
}
# A store call that can fail for a dropped connection, tried again after 2, 4, 8 and 16 s (0.133 R13); world-aside
# retries its own calls.
patient() {
  local wait
  for wait in 2 4 8 16; do
    "$@" && return 0
    echo "reseed-undo: '$1 ${2:-}' failed; trying again in $wait s" >&2
    sleep "$wait"
  done
  "$@"
}
STAMP=${1:-}
mode=${2:-}
[[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && { [ "$mode" = check ] || [ "$mode" = run ]; } || {
  sed -n 2,16p "$0"
  exit 2
}
[ -n "${RESEED_DATA:-}" ] || [ "$(id -u)" = 0 ] || die "run as root"
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

RECEIPT=$(ls "$ROOT"/aside/*-"$STAMP".reseed 2> /dev/null | head -1)
[ -f "$RECEIPT" ] || die "no reseed receipt for $STAMP in $ROOT/aside"
WORLD=$(sed -n 's/^world=//p' "$RECEIPT")
OLD=$(sed -n 's/^old=//p' "$RECEIPT")
[[ "$WORLD" =~ ^[0-9a-f]{32}-[0-9a-f]{32}-[0-9]+$ ]] && [[ "$OLD" =~ ^1220[0-9a-f]{64}$ ]] || die "the receipt $RECEIPT is not whole"
[ -f "$ROOT/builds/$OLD/worldd" ] || die "the old build $OLD is not on this machine"
[ -x "$TOOL" ] || die "world-aside is not at $TOOL"
ASIDE_DIR=$ROOT/aside/$WORLD-$STAMP
FRESH=$STAMP-fresh
FRESH_DIR=$ROOT/aside/$WORLD-$FRESH
LIVE_DIR=$ROOT/worlds/$WORLD
[ ! -e "$FRESH_DIR" ] || die "$FRESH_DIR exists"
count() { "$TOOL" "$WORLD" "$@" --dry-run | sed -n 's/^dry run: \([0-9]*\) objects.*/\1/p'; }
IN_PLACE=$(count --label "$FRESH")
COPIED=$(count --back "$STAMP")
MOVED=no
if grep -qx 'bucket=moved' "$RECEIPT" || { [ "$IN_PLACE" = 0 ] && [ "$COPIED" -gt 0 ]; }; then MOVED=yes; fi
if [ -d "$ASIDE_DIR" ]; then
  FOLDER="the old folder $ASIDE_DIR back to $LIVE_DIR"
  if [ -e "$LIVE_DIR" ]; then FOLDER="$FOLDER; the fresh one to $FRESH_DIR"; fi
else
  [ -d "$LIVE_DIR" ] || die "no world folder at $ASIDE_DIR or $LIVE_DIR"
  FOLDER="none: the old folder never left $LIVE_DIR"
fi

echo "reseed-undo: world          $WORLD"
echo "reseed-undo: label          $STAMP"
echo "reseed-undo: folders        $FOLDER"
echo "reseed-undo: bucket         $IN_PLACE of the world's objects at their keys; $COPIED under aside/$STAMP/"
if [ "$MOVED" = yes ]; then
  echo "reseed-undo: bucket move    the reseed moved them: the $IN_PLACE at their keys (the fresh world's) go to aside/$FRESH/, the $COPIED come back"
else
  echo "reseed-undo: bucket move    none: the reseed's move did not finish, so the $IN_PLACE at their keys are the old world's and stay; the $COPIED copies stay under aside/$STAMP/"
fi
echo "reseed-undo: pin            $OLD"
echo "reseed-undo: units          worldd@ $(systemctl is-active "worldd@$WORLD" || true), souls-gateway@ $(systemctl is-active "souls-gateway@$WORLD" || true); both started at the end"
[ "$mode" = run ] || {
  echo "reseed-undo: check only; nothing changed"
  exit 0
}

echo "reseed-undo: 1. stop the world and its gateway"
systemctl stop "souls-gateway@$WORLD" "worldd@$WORLD"
if [ "$MOVED" = yes ]; then
  echo "reseed-undo: 2. the fresh world's bucket objects aside, the old world's back"
  "$TOOL" "$WORLD" --label "$FRESH"
  "$TOOL" "$WORLD" --back "$STAMP"
else
  echo "reseed-undo: 2. the bucket: the old world's objects never left; nothing to move"
fi
if [ -d "$ASIDE_DIR" ]; then
  echo "reseed-undo: 3. the old folder back"
  if [ -e "$LIVE_DIR" ]; then mv "$LIVE_DIR" "$FRESH_DIR"; fi
  mv "$ASIDE_DIR" "$LIVE_DIR"
else
  echo "reseed-undo: 3. the folder: never moved"
fi
echo "reseed-undo: 4. pin the old build"
patient "$LIB/supervisor" pin "$WORLD" "$OLD"
echo "reseed-undo: 5. start the world and its gateway"
systemctl start "worldd@$WORLD" "souls-gateway@$WORLD"
echo "undone=$(date -u +%Y%m%dT%H%M%SZ)" >> "$RECEIPT"
echo "reseed-undo: done: $WORLD is back on its old folder, objects and build ${OLD:0:16}…"
