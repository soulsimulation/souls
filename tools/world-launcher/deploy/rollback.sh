#!/usr/bin/env bash
# The code-only rollback of a root release, exactly ship.sh's ROLLBACK.txt, for an operator without ssh (#1438): rollback.yml
# runs it in the production environment. It moves the stage link back with the previous release's own activate.sh --reload
# and then requires public healthz on that build with every registered world. It never touches a backup, a database, the
# registry, auth or host settings, and it deletes nothing.
#
#   tools/world-launcher/deploy/rollback.sh --build <we-previous> --from <we-candidate> [--dry-run]
#     --build  the build to go back to: must be the host's production.previous, with a staged release directory
#     --from   the build that is live now (the release being rolled back); anything else on the host refuses
#     --dry-run  reads the host and prints what it would do; changes nothing
# Exit: 0 healthz names --build with every world; 80 a guard refused, nothing changed; 81 the activation failed (activate.sh
# may have restored --from itself: read healthz); 82 healthz is wrong after the rollback.
# The host comes from the environment or an untracked deploy.env, as for ship.sh; nothing here prints it.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/deploy-env.sh"
ORIGIN="${SHIP_ORIGIN:-https://soul.game}"; HOST_ROOT="${SHIP_HOST_ROOT:-/srv/sim-worlds}"; HOST_DATA="${SHIP_HOST_DATA:-/srv/sim-worlds-data/production}"
SSH="${SHIP_SSH:-ssh}"; CURL="${SHIP_CURL:-curl}"; OUT="${SHIP_OUT_ROOT:-${TMPDIR:-/tmp}}/rollback"
BUILD=""; FROM=""; DRY=0
while [ $# -gt 0 ]; do case "$1" in --build) BUILD="${2:-}"; shift;; --from) FROM="${2:-}"; shift;; --dry-run) DRY=1;; *) sed -n '7,13p' "$0"; exit 2;; esac; shift; done
[[ "$BUILD" =~ ^we-[0-9a-f]{12}$ ]] && [[ "$FROM" =~ ^we-[0-9a-f]{12}$ ]] && [ "$BUILD" != "$FROM" ] || { echo "--build and --from: two different we-<12 hex> builds"; exit 2; }
HOST="$(deploy_target 2>/dev/null)" || { echo "REFUSED: SIM_DEPLOY_HOST is not set"; exit 80; }
rsh() { "$SSH" -o BatchMode=yes -o ConnectTimeout=20 "$HOST" "$@"; }
mkdir -p "$OUT"

# read-only: the stage link, the previous link, the candidate's BUILD file, the number of registered worlds
STATE="$(rsh "set -e; b(){ basename \"\$(readlink \"\$1\" 2>/dev/null || echo none)\"; }; echo \"\$(b $HOST_ROOT/production) \$(b $HOST_ROOT/production.previous) \$(cat $HOST_ROOT/releases/$BUILD/BUILD 2>/dev/null || echo none) \$(node -p 'JSON.parse(require(\"fs\").readFileSync(process.argv[1])).worlds.length' $HOST_DATA/worlds.json)\"")" \
  || { echo "REFUSED: cannot read the host"; exit 80; }
read -r LIVE PREV STAGED WORLDS <<< "$STATE"
echo "host: live $LIVE, previous $PREV, $BUILD staged as ${STAGED}, $WORLDS worlds"
[[ "$WORLDS" =~ ^[1-9][0-9]*$ ]] || { echo "REFUSED: the host's world count is not a number ($WORLDS); nothing changed"; exit 80; }
health() {
  "$CURL" -fsS --max-time 30 "$ORIGIN/__sim/healthz" > "$OUT/health.json" || { echo "public healthz did not answer"; return 1; }
  node "$HERE/ship/root-release.mjs" health "$OUT/health.json" "$BUILD" "$WORLDS"
}
if [ "$LIVE" = "$BUILD" ]; then
  echo "already on $BUILD: verifying only, nothing changes"
  health && exit 0 || exit 82
fi
[ "$LIVE" = "$FROM" ] || { echo "REFUSED: the live build is $LIVE, not $FROM; nothing changed"; exit 80; }
[ "$PREV" = "$BUILD" ] || { echo "REFUSED: the host's previous build is $PREV, not $BUILD; nothing changed"; exit 80; }
[ "$STAGED" = "$BUILD" ] || { echo "REFUSED: $HOST_ROOT/releases/$BUILD is not a staged $BUILD; nothing changed"; exit 80; }
CMD="bash $HOST_ROOT/releases/$BUILD/tools/world-launcher/deploy/activate.sh production $HOST_ROOT/releases/$BUILD --reload"
echo "+ $CMD"
[ "$DRY" = 1 ] && { echo "DRY RUN: nothing changed"; exit 0; }
rsh "$CMD" || { echo "the activation of $BUILD failed; activate.sh may have restored $FROM: read healthz"; health; exit 81; }
health || { echo "healthz is wrong after the rollback"; exit 82; }
echo "ROLLED BACK: $FROM -> $BUILD, healthz names $BUILD with $WORLDS worlds"
