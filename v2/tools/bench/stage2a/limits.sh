#!/usr/bin/env bash
# The limits run (0.133 P3): a throwaway Eden on the new engine with N agents (fake minds: the driver's scripted mix,
# no model) and M viewers, N stepped up the ladder in even and uneven load, each rung judged against the fixed limits
# (limits.mjs), one table at the end. Each rung is stage 2a's (rung.sh: `worldd seed` and `worldd serve`, its
# gatewayd and the viewers' origin on ports the kernel picks on loopback, in a folder of its own, stopped by pid),
# with the viewers bench's readers as its viewers (viewers.mjs). It never touches a served world: it reads and writes
# only under OUT (and WORLD_ROOT), and refuses a folder under /var/lib/souls or /etc/souls.
#
#   v2/tools/bench/stage2a/limits.sh [counts, default "100 250 500 750 1000"]
#
# Env (defaults in brackets):
#   SECS [600]           seconds of load a rung; REPEATS [2] repeats a rung; ARMS ["even uneven"]; RATE [every4]
#                        (the mix's rate: every4, burst or gene17, loads.mjs RATES);
#   VIEWERS [500]        viewers on every rung (viewers.mjs: even arrive over 30 s; uneven in a wave, and a second);
#   WORLD_CPUS [all]     taskset list for worldd, gatewayd and the origin; DRIVER_CPUS [the last core] the driver's;
#                        VIEWER_CPUS [DRIVER_CPUS] the viewers'. On a machine that serves worlds, leave WORLD_CPUS all;
#   STOP [1]             stop climbing after the first count on which a limit gave way (0: run every count);
#   MEM_LIMIT_MB [unset] judge the rung's processes' memory together against this;
#   OUT [$FARM_DATA or .local, /limits-<UTC time>]  the rungs' folders (keep it short: a socket path is at most 107
#                        bytes); EDEN_FACTS, CARGO_TARGET_DIR, REPLICA_PKG and WORLD_ROOT pass through to rung.sh.
# Needs the release worldd, gatewayd and driver, replica's wasm-bindgen package, Node 22.18 or later, taskset and
# Eden's facts (box.sh's list). Prints each rung's line as it ends, then the table, the run's time and each rung's.
set -u
COUNTS=${1:-100 250 500 750 1000}
HERE=$(cd "$(dirname "$0")" && pwd)
export SECS=${SECS:-600} VIEWERS=${VIEWERS:-500} DRIVER_CPUS=${DRIVER_CPUS:-$(($(nproc) - 1))}
REPEATS=${REPEATS:-2} ARMS=${ARMS:-even uneven} RATE=${RATE:-every4}
OUT=${OUT:-${FARM_DATA:-$HERE/../../../../.local}/limits-$(date -u +%m%d%H%M)}
case "$(realpath -m "$OUT")/" in
  /var/lib/souls/* | /etc/souls/*) echo "limits.sh: refusing OUT under /var/lib/souls or /etc/souls" >&2; exit 2 ;;
esac
for c in node taskset; do command -v "$c" > /dev/null || { echo "limits.sh: $c is not on PATH" >&2; exit 2; }; done
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' \
  || { echo "limits.sh: Node 22.18 or later (the viewers import the page's TypeScript)" >&2; exit 2; }
mkdir -p "$OUT"
[ ${#OUT} -le 50 ] || echo "limits.sh: OUT is ${#OUT} bytes; a socket path under it may pass 107 bytes (keep OUT short)" >&2
# A stopped run stops its rung, whose own trap stops the rung's processes by pid.
RP=
trap '[ -n "$RP" ] && kill "$RP" 2> /dev/null; wait; exit 143' INT TERM HUP
START=$(date +%s)
echo "limits: counts $COUNTS; arms $ARMS; rate $RATE; $SECS s a rung, $REPEATS repeats; $VIEWERS viewers; world on ${WORLD_CPUS:-all}, driver on $DRIVER_CPUS; $(nproc) cores, load $(cut -d' ' -f1-3 /proc/loadavg)" | tee "$OUT/run.txt"
DIRS=()
for n in $COUNTS; do
  AT=()
  for k in $(seq 1 "$REPEATS"); do
    for arm in $ARMS; do
      D=$OUT/$n-$arm-$RATE-r$k
      T0=$(date +%s)
      bash "$HERE/rung.sh" "$n" "$arm" "$RATE" "${WORLD_CPUS:-all}" "$SECS" "$D" > "$D.log" 2>&1 &
      RP=$!
      wait "$RP" || mkdir -p "$D"
      RP=
      MISSED=$(node "$HERE/limits.mjs" --check "$D" | sed 's/^gave way [^:]*: //' | paste -sd';' -)
      echo "rung $n $arm $RATE r$k: $(($(date +%s) - T0)) s; ${MISSED:-held}" | tee -a "$OUT/run.txt"
      AT+=("$D") DIRS+=("$D")
    done
  done
  if [ "${STOP:-1}" != 0 ] && ! node "$HERE/limits.mjs" --check "${AT[@]}" > /dev/null; then
    echo "limits: a limit gave way at $n agents; the ladder stops here (STOP=0 runs every count)" | tee -a "$OUT/run.txt"
    break
  fi
done
echo
node "$HERE/limits.mjs" --label "limits run, $(nproc) cores, world on ${WORLD_CPUS:-all}, $SECS s a rung, $VIEWERS viewers" "${DIRS[@]}" | tee "$OUT/table.md"
echo
echo "limits: $(( ($(date +%s) - START) / 60 )) min for ${#DIRS[@]} rungs; folders in $OUT" | tee -a "$OUT/run.txt"
