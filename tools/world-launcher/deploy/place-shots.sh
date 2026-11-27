#!/usr/bin/env bash
# Explore's kept place pictures for every moved world, drawn on this machine's GPU from the public pages and copied to
# the host's launcher data (<data>/place-shots/<slug>/, which the launcher serves: tools/world-launcher/place-shots.mjs).
# Run at release, after the release is live (the page must offer ?placeShots=1, #4792). Idempotent: the host's kept
# pictures are fetched first and only places with no current picture are drawn; files go up before their index.
#
#   tools/world-launcher/deploy/place-shots.sh [--dry-run] [--slugs eden,verdelis-eden] [--dest <local folder>]
#     --dry-run  lists the moved worlds and how many places each would draw; draws nothing, writes nothing on the host
#     --slugs    these worlds only (default: every world soul.game's /__sim/worlds.json lists with engine "new")
#     --dest     copy into this local folder instead of the host (a test, or a host folder mounted here)
#
# The host comes from SIM_DEPLOY_HOST (environment or the untracked deploy.env, as ship.sh); never write it into a
# public record. PLACE_SHOTS_ORIGIN (default https://soul.game), SHIP_HOST_DATA (default /srv/sim-worlds-data/production)
# and PLACE_SHOTS_CACHE (default .local/place-shots) override the rest.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../../.." && pwd)"
. "$HERE/deploy-env.sh"
ORIGIN="${PLACE_SHOTS_ORIGIN:-https://soul.game}"; HOST_DATA="${SHIP_HOST_DATA:-/srv/sim-worlds-data/production}"
CACHE="${PLACE_SHOTS_CACHE:-$ROOT/.local/place-shots}"; SSH="${SHIP_SSH:-ssh}"; RSYNC="${SHIP_RSYNC:-rsync}"
DRAW="${PLACE_SHOTS_DRAW:-node $ROOT/tools/world-launcher/place-shots.mjs}"   # a test's seam (tools/world-launcher/place-shots-release.test.mjs)
DRY=0; SLUGS=""; DEST=""
while [ $# -gt 0 ]; do case "$1" in
  --dry-run) DRY=1;; --slugs) SLUGS="${2:-}"; shift;; --dest) DEST="${2:-}"; shift;;
  *) sed -n '7,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2;; esac; shift; done
[[ -z "$SLUGS" || "$SLUGS" =~ ^[a-z0-9][a-z0-9-]*(,[a-z0-9][a-z0-9-]*)*$ ]] || { echo "--slugs: world slugs, comma-separated"; exit 2; }

if [ -z "$SLUGS" ]; then
  SLUGS="$(curl -fsS --max-time 30 "$ORIGIN/__sim/worlds.json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const w=JSON.parse(d).worlds??[];console.log(w.filter(x=>x.engine==="new"&&/^[a-z0-9][a-z0-9-]*$/.test(x.slug)).map(x=>x.slug).join(","))})')" \
    || { echo "cannot read $ORIGIN/__sim/worlds.json"; exit 1; }
  [ -n "$SLUGS" ] || { echo "no moved worlds listed at $ORIGIN"; exit 1; }
fi
HOST=""
if [ -z "$DEST" ] && [ "$DRY" = 0 ]; then HOST="$(deploy_target)" || exit 2; fi
rsh() { "$SSH" -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "$@"; }
# from / to: the host's folder for a world, over ssh, or the --dest folder
remote() { if [ -n "$DEST" ]; then echo "$DEST/$1/"; else echo "$HOST:$HOST_DATA/place-shots/$1/"; fi; }
RSH=(-e "$SSH -o BatchMode=yes -o ConnectTimeout=20")

FAILED=""
for slug in ${SLUGS//,/ }; do
  local_dir="$CACHE/$slug"; mkdir -p "$local_dir"
  echo "== $slug"
  if [ "$DRY" = 0 ]; then
    # what the host keeps already (nothing on a first run)
    if [ -n "$DEST" ]; then mkdir -p "$DEST/$slug"; else rsh "mkdir -p '$HOST_DATA/place-shots/$slug'" || { FAILED="$FAILED $slug"; continue; }; fi
    "$RSYNC" -a "${RSH[@]}" "$(remote "$slug")" "$local_dir/" || { echo "   cannot read the host's pictures"; FAILED="$FAILED $slug"; continue; }
  fi
  plan=(); [ "$DRY" = 1 ] && plan=(--plan)
  $DRAW --page "$ORIGIN/w/$slug/" --out "$local_dir" ${plan[@]+"${plan[@]}"} > "$CACHE/$slug.log" 2>&1; rc=$?
  grep -v '^  ' "$CACHE/$slug.log" | sed 's/^/   /'   # one line per place stays in the log
  [ "$rc" = 0 ] || { echo "   drawing failed ($CACHE/$slug.log)"; FAILED="$FAILED $slug"; continue; }
  [ "$DRY" = 1 ] && continue
  # pictures first, then the index that names them: a visitor never gets a name with no file. Never this machine's owner:
  # the folder stays the launcher's, so its own drawing runs (place-shots.mjs placeShotKeeper) can still write there
  "$RSYNC" -a --no-owner --no-group --chmod=D755,F644 --exclude index.json --exclude '*.tmp' "${RSH[@]}" "$local_dir/" "$(remote "$slug")" \
    && "$RSYNC" -a --no-owner --no-group --chmod=F644 "${RSH[@]}" "$local_dir/index.json" "$(remote "$slug")" \
    || { echo "   copy to the host failed"; FAILED="$FAILED $slug"; continue; }
  echo "   kept on the host: $(ls "$local_dir" | grep -c '\.webp$') pictures"
done
[ -z "$FAILED" ] || { echo "failed:$FAILED"; exit 1; }
echo "done"
