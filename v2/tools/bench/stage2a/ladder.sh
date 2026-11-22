#!/usr/bin/env bash
# Stage 2a's ladder (#4154): rung.sh for each agent count, arm and rate on one CPU arm, then the tables.
#
#   v2/tools/bench/stage2a/ladder.sh <world cpus|all> <seconds> <counts, e.g. "500 350 200 100"> [rates] [arms]
#
# The rung folders are $FARM_DATA/stage2a/<n>-<arm>-<rate>-<cpus>; WORLD_ROOT and DRIVER_CPUS pass through to rung.sh.
set -u
CPUS=$1 SECS=$2 COUNTS=$3 RATES=${4:-every4 burst} ARMS=${5:-even uneven}
HERE=$(cd "$(dirname "$0")" && pwd)
DIRS=()
for n in $COUNTS; do
  for rate in $RATES; do
    for arm in $ARMS; do
      echo "== $(date -u +%H:%M:%S) rung $n $arm $rate on $CPUS; load $(cut -d' ' -f1-3 /proc/loadavg)"
      bash "$HERE/rung.sh" "$n" "$arm" "$rate" "$CPUS" "$SECS" > /dev/null 2>&1
      D=${FARM_DATA:-$HERE/../../../../.local}/stage2a/$n-$arm-$rate-$CPUS
      DIRS+=("$D")
      grep -E '^(Visible|Stuck|Acts)' "$D/driver.out" | cut -c1-300
    done
  done
done
node "$HERE/analyze.mjs" --table "${DIRS[@]}"
