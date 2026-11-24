#!/usr/bin/env bash
# One rung of the limits run against a served Eden (0.133 P3): the driver signs in marked test Souls at Eden's own
# gateway and sends the Soul Actions mix as them (loads.mjs `mix-<n>-<arm>-<rate>`, fake minds), m viewers read
# Eden's public stream through the front door, and the guard (guard.mjs watch) samples Eden on its machine and stops
# the load if Eden's ticks on time or memory pass its bars. Starts no world; every process it starts is stopped by pid.
#
#   v2/tools/bench/stage2a/served.sh <n> <even|uneven> <every4|burst|gene17> <seconds> <out folder>
#
# Env: GATEWAY (ws://host:port the driver reaches Eden's gatewayd on), TOKENS_FILE (test-soul pair's file, n lines or
# more), PROBE (the command printing guard.mjs probe's lines), STREAM (Eden's stream folder for the driver's stream
# reader, http://), VIEWERS [0] and VIEWER_URL (the stream folder the viewers read, e.g. the front door's https URL),
# DRIVER_CPUS and VIEWER_CPUS [DRIVER_CPUS] (taskset lists on the load machine), CARGO_TARGET_DIR, REPLICA_PKG.
# Leaves the rung's folder as rung.sh does (analyze.mjs reads it), and abort.txt when the guard stopped the load.
set -u
N=$1 ARM=$2 RATE=$3 SECS=$4 D=$5
V2=$(cd "$(dirname "$0")/../../.." && pwd)
B=${CARGO_TARGET_DIR:-$V2/target}/release
for v in GATEWAY TOKENS_FILE PROBE STREAM DRIVER_CPUS; do [ -n "${!v:-}" ] || { echo "served.sh: $v is not set" >&2; exit 2; }; done
rm -rf "$D"; mkdir -p "$D/run"
cat /proc/loadavg > "$D/loadavg.before"
GP= VP= DP=
stop_all() { for p in $DP $VP $GP; do kill "$p" 2> /dev/null; done; }
trap stop_all EXIT
trap 'exit 143' INT TERM HUP

node "$V2/tools/driver/loads.mjs" "mix-$N-$ARM-$RATE" --seconds "$SECS" --seed 1 --out "$D/schedule.txt" > "$D/loads.log" 2>&1
node "$V2/tools/bench/stage2a/guard.mjs" watch --probe "$PROBE" --samples "$D/samples.jsonl" --pids "$D/pids" \
  --abort "$D/abort.txt" > "$D/guard.log" 2>&1 &
GP=$!
if [ "${VIEWERS:-0}" -gt 0 ]; then
  U=${VIEWER_URL:?VIEWER_URL is not set}
  [ "${U%/}" = "$U" ] && U="$U/"
  BASE=$(node -p 'new URL("/", process.argv[1]).href' "$U")
  taskset -c "${VIEWER_CPUS:-$DRIVER_CPUS}" node "$V2/tools/bench/stage2a/viewers.mjs" "$BASE" "${U#"$BASE"}" \
    "${REPLICA_PKG:-$B/../wasm-load/pkg}" "$VIEWERS" "$ARM" "$SECS" "$D/win.txt" "$D" > "$D/viewers.log" 2>&1 &
  VP=$!
fi
sleep 1
date +%s > "$D/win.txt"
taskset -c "$DRIVER_CPUS" "$B/driver" --schedule "$D/schedule.txt" --dir "$D/run" --tokens "$TOKENS_FILE" \
  --remote "$GATEWAY" --speech --stream "$STREAM" > "$D/driver.out" 2>&1 &
DP=$!
echo "$DP $VP" > "$D/pids"
echo "rung $N $ARM $RATE served: driver $DP viewers ${VP:--} guard $GP"
wait "$DP"
echo "driver exit $?" >> "$D/driver.out"
DP=
date +%s >> "$D/win.txt"
sleep 5
if [ -n "$VP" ]; then kill -TERM "$VP" 2> /dev/null; wait "$VP" 2> /dev/null; fi
kill "$GP" 2> /dev/null; wait "$GP" 2> /dev/null
VP= GP=
[ -f "$D/abort.txt" ] && echo "aborted: $(cat "$D/abort.txt")"
node "$V2/tools/bench/stage2a/analyze.mjs" "$D"
