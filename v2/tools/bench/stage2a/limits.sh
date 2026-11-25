#!/usr/bin/env bash
# The limits run (0.133 P3): a throwaway Eden on the new engine with N agents (fake minds: the driver's scripted mix,
# no model) and M viewers, N stepped up the ladder in even and uneven load, each rung judged against the fixed limits
# (limits.mjs), one table at the end. Each rung is stage 2a's (rung.sh: `worldd seed` and `worldd serve`, its
# gatewayd and the viewers' origin on ports the kernel picks on loopback, in a folder of its own, stopped by pid),
# with the viewers bench's readers as its viewers (viewers.mjs). It never touches a served world: it reads and writes
# only under OUT (and WORLD_ROOT), and refuses a folder under /var/lib/souls or /etc/souls.
#
# With GATEWAY set, the production run (served.sh): no throwaway world. The load runs on this (the build) machine
# against the served Eden, beside every other world on its machine, as marked test Souls (TOKENS_FILE, from
# `test-soul pair`). Before each rung the guard's preflight (guard.mjs) refuses unless Eden is running, on time and has
# memory headroom; during it, the guard stops the load when Eden's ticks on time fall below 95 % or its or the slice's
# memory passes 85 %, and the run stops there. Counts default to M (500), VIEWERS to Q (100): 0.133's "Needs Gene" 3.
#
#   v2/tools/bench/stage2a/limits.sh [counts, default "100 250 500 750 1000", served "500"]
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
#                        bytes); EDEN_FACTS [.local/eden.facts.json, as kit.sh unpacks it], CARGO_TARGET_DIR,
#                        REPLICA_PKG and WORLD_ROOT pass through to rung.sh.
#   GATEWAY, TOKENS_FILE, PROBE, STREAM, VIEWER_URL  the served run's (served.sh, guard.mjs; runbook limits-run.md).
# Needs the release worldd, gatewayd and driver, replica's wasm-bindgen package and Eden's facts (kit.sh builds and
# packs them), Node 22.18 or later and taskset. Prints each rung's line as it ends, then the table, the run's time and each rung's.
set -u
SERVED=${GATEWAY:+1}
if [ -n "$SERVED" ]; then COUNTS=${1:-500} VIEWERS=${VIEWERS:-100}; else COUNTS=${1:-100 250 500 750 1000}; fi
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
[ -n "${EDEN_FACTS:-}" ] || [ ! -f "$ROOT/.local/eden.facts.json" ] || export EDEN_FACTS=$ROOT/.local/eden.facts.json
if [ -f "$ROOT/.local/limits-kit-commit" ] && [ "$(cat "$ROOT/.local/limits-kit-commit")" != "$(git -C "$ROOT" rev-parse HEAD 2> /dev/null)" ]; then
  echo "limits.sh: the kit was built from $(cut -c1-9 "$ROOT/.local/limits-kit-commit"), the checkout is another commit" >&2
fi
export SECS=${SECS:-600} VIEWERS=${VIEWERS:-500} DRIVER_CPUS=${DRIVER_CPUS:-$(($(nproc) - 1))}
REPEATS=${REPEATS:-2} ARMS=${ARMS:-even uneven} RATE=${RATE:-every4}
OUT=${OUT:-${FARM_DATA:-$ROOT/.local}/limits-$(date -u +%m%d%H%M)}
case "$(realpath -m "$OUT")/" in
  /var/lib/souls/* | /etc/souls/*) echo "limits.sh: refusing OUT under /var/lib/souls or /etc/souls" >&2; exit 2 ;;
esac
for c in node taskset; do command -v "$c" > /dev/null || { echo "limits.sh: $c is not on PATH" >&2; exit 2; }; done
node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' \
  || { echo "limits.sh: Node 22.18 or later (the viewers import the page's TypeScript)" >&2; exit 2; }
mkdir -p "$OUT"
if [ -n "$SERVED" ]; then
  for v in TOKENS_FILE PROBE STREAM; do [ -n "${!v:-}" ] || { echo "limits.sh: $v is not set (the served run)" >&2; exit 2; }; done
  [ -f "$TOKENS_FILE" ] || { echo "limits.sh: no TOKENS_FILE" >&2; exit 2; }
  [ "$VIEWERS" = 0 ] || [ -n "${VIEWER_URL:-}" ] || { echo "limits.sh: VIEWER_URL is not set (or VIEWERS=0)" >&2; exit 2; }
  export GATEWAY TOKENS_FILE PROBE STREAM VIEWER_URL
fi
[ ${#OUT} -le 50 ] || echo "limits.sh: OUT is ${#OUT} bytes; a socket path under it may pass 107 bytes (keep OUT short)" >&2
# A stopped run stops its rung, whose own trap stops the rung's processes by pid.
RP=
trap '[ -n "$RP" ] && kill "$RP" 2> /dev/null; wait; exit 143' INT TERM HUP
START=$(date +%s)
WHERE="world on ${WORLD_CPUS:-all}"
[ -z "$SERVED" ] || WHERE="the served Eden"
echo "limits: counts $COUNTS; arms $ARMS; rate $RATE; $SECS s a rung, $REPEATS repeats; $VIEWERS viewers; $WHERE, driver on $DRIVER_CPUS; $(nproc) cores, load $(cut -d' ' -f1-3 /proc/loadavg)" | tee "$OUT/run.txt"
DIRS=() HALT=
for n in $COUNTS; do
  AT=()
  for k in $(seq 1 "$REPEATS"); do
    for arm in $ARMS; do
      D=$OUT/$n-$arm-$RATE-r$k
      T0=$(date +%s)
      if [ -n "$SERVED" ]; then
        # Each rung starts only from a healthy Eden with memory to spare; the run ends at the first refusal.
        node "$HERE/guard.mjs" preflight --probe "$PROBE" --gateway "$GATEWAY" --stream "$STREAM" ${VIEWER_URL:+--viewers "$VIEWER_URL"} 2>&1 | tee -a "$OUT/run.txt"
        [ "${PIPESTATUS[0]}" = 0 ] || { HALT="the preflight refused rung $n $arm r$k"; break 3; }
        bash "$HERE/served.sh" "$n" "$arm" "$RATE" "$SECS" "$D" > "$D.log" 2>&1 &
      else
        bash "$HERE/rung.sh" "$n" "$arm" "$RATE" "${WORLD_CPUS:-all}" "$SECS" "$D" > "$D.log" 2>&1 &
      fi
      RP=$!
      wait "$RP" || mkdir -p "$D"
      RP=
      MISSED=$(node "$HERE/limits.mjs" --check "$D" | sed 's/^gave way [^:]*: //' | paste -sd';' -)
      echo "rung $n $arm $RATE r$k: $(($(date +%s) - T0)) s; ${MISSED:-held}" | tee -a "$OUT/run.txt"
      AT+=("$D") DIRS+=("$D")
      [ ! -f "$D/abort.txt" ] || { HALT="the guard stopped rung $n $arm r$k: $(cat "$D/abort.txt")"; break 3; }
    done
  done
  if [ "${STOP:-1}" != 0 ] && ! node "$HERE/limits.mjs" --check "${AT[@]}" > /dev/null; then
    echo "limits: a limit gave way at $n agents; the ladder stops here (STOP=0 runs every count)" | tee -a "$OUT/run.txt"
    break
  fi
done
[ -z "$HALT" ] || echo "limits: the run stops: $HALT" | tee -a "$OUT/run.txt"
echo
[ ${#DIRS[@]} = 0 ] || node "$HERE/limits.mjs" --label "limits run, $(nproc) cores, $WHERE, $SECS s a rung, $VIEWERS viewers" "${DIRS[@]}" | tee "$OUT/table.md"
echo
echo "limits: $(( ($(date +%s) - START) / 60 )) min for ${#DIRS[@]} rungs; folders in $OUT" | tee -a "$OUT/run.txt"
[ -z "$HALT" ] || exit 4
