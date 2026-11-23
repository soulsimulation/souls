#!/usr/bin/env bash
# 0.132: undo reseed-eden.sh <label>: Eden's new-engine world back to the folder, bucket objects and pin it had.
#
# In plain words: it stops the world and its gateway; sets the fresh world's folder and bucket objects aside in their
# turn (the same way: renamed, and each object copied, read back and compared before its original is deleted); moves
# the old folder and the old bucket objects back; pins the build the world had; and starts both. Nothing is deleted
# without a verified copy. Release-v2 must not run while this runs.
#
#   bash reseed-eden-undo.sh <label> check    reads and prints every value; changes nothing
#   bash reseed-eden-undo.sh <label> run      the check, then the steps above
#
# <label> is the one reseed-eden.sh printed (its time, YYYYMMDDTHHMMSSZ). Root on the production host.
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
STAMP=${1:-}
mode=${2:-}
[[ "$STAMP" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] && { [ "$mode" = check ] || [ "$mode" = run ]; } || {
  sed -n 2,13p "$0"
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
ASIDE_DIR=$ROOT/aside/$WORLD-$STAMP
FRESH=$STAMP-fresh
FRESH_DIR=$ROOT/aside/$WORLD-$FRESH
LIVE_DIR=$ROOT/worlds/$WORLD
[ -d "$ASIDE_DIR" ] || die "the old folder is not at $ASIDE_DIR"
[ ! -e "$FRESH_DIR" ] || die "$FRESH_DIR exists"
[ -x "$TOOL" ] || die "the one-off tool is not at $TOOL"

echo "reseed-undo: world          $WORLD"
echo "reseed-undo: old folder     $ASIDE_DIR -> $LIVE_DIR"
echo "reseed-undo: fresh folder   $([ -e "$LIVE_DIR" ] && echo "$LIVE_DIR -> $FRESH_DIR" || echo none)"
echo "reseed-undo: pin            back to $OLD"
echo "reseed-undo: the fresh world's bucket objects that would go aside (aside/$FRESH/):"
"$TOOL" "$WORLD" --label "$FRESH" --dry-run | tail -3 | sed 's/^/  /'
echo "reseed-undo: the old world's bucket objects that would come back (from aside/$STAMP/):"
"$TOOL" "$WORLD" --back "$STAMP" --dry-run | tail -3 | sed 's/^/  /'
[ "$mode" = run ] || {
  echo "reseed-undo: check only; nothing changed"
  exit 0
}

echo "reseed-undo: 1. stop the world and its gateway"
systemctl stop "souls-gateway@$WORLD" "worldd@$WORLD"
echo "reseed-undo: 2. the fresh world aside"
if [ -e "$LIVE_DIR" ]; then mv "$LIVE_DIR" "$FRESH_DIR"; fi
"$TOOL" "$WORLD" --label "$FRESH"
echo "reseed-undo: 3. the old world back"
"$TOOL" "$WORLD" --back "$STAMP"
mv "$ASIDE_DIR" "$LIVE_DIR"
echo "reseed-undo: 4. pin the old build"
"$LIB/supervisor" pin "$WORLD" "$OLD"
echo "reseed-undo: 5. start the world and its gateway"
systemctl start "worldd@$WORLD" "souls-gateway@$WORLD"
echo "reseed-undo: done: $WORLD is back on its old folder, objects and build ${OLD:0:16}…; the fresh one is at $FRESH_DIR and aside/$FRESH/"
