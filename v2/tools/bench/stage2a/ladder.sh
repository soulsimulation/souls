#!/usr/bin/env bash
# Stage 2a's ladder (#4154): rung.sh for each agent count, rate, arm and repeat on one CPU arm, then the tables.
#
#   v2/tools/bench/stage2a/ladder.sh <world cpus|all> <seconds> <counts, e.g. "500 350 200 100"> [rates] [arms]
#
# Env: REPEATS (default 1; the deciding runs use 2), LABEL (the tables' heading, e.g. "SMOKE: shared machine"), OUT
# (the folder the rungs go in, default $FARM_DATA/stage2a or .local/stage2a). WORLD_ROOT and DRIVER_CPUS pass
# through to rung.sh. Rung folders: <OUT>/<n>-<arm>-<rate>-<cpus>-r<k>.
set -u
CPUS=$1 SECS=$2 COUNTS=$3 RATES=${4:-every4 burst} ARMS=${5:-even uneven}
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-${FARM_DATA:-$HERE/../../../../.local}/stage2a}
mkdir -p "$OUT"
DIRS=()
for n in $COUNTS; do
  for rate in $RATES; do
    for arm in $ARMS; do
      for k in $(seq 1 "${REPEATS:-1}"); do
        D=$OUT/$n-$arm-$rate-${CPUS//,/_}-r$k
        echo "== $(date -u +%H:%M:%S) rung $n $arm $rate on $CPUS, repeat $k; load $(cut -d' ' -f1-3 /proc/loadavg)"
        bash "$HERE/rung.sh" "$n" "$arm" "$rate" "$CPUS" "$SECS" "$D" > "$D.log" 2>&1 || mkdir -p "$D"
        DIRS+=("$D")
        grep -E '^(Visible|Stuck|Acts)' "$D/driver.out" 2> /dev/null | cut -c1-300
      done
    done
  done
done
node "$HERE/analyze.mjs" --table --label "${LABEL:-stage 2a ladder, world on $CPUS}" "${DIRS[@]}"
