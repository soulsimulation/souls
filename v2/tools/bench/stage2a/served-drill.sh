#!/usr/bin/env bash
# The served limits run's drill (0.133 P3), on a Linux machine that serves nothing: a stand-in for the production
# machine (a seeded Eden under `worldd serve`, its gatewayd and the viewers' origin on loopback; the worlds root's
# supervisor records, a second world asleep, and a stand-in cgroup tree whose Eden memory follows worldd's resident
# memory against a 4G MemoryMax, the slice against 14G), then limits.sh's served run against it, with guard.mjs probe
# as the PROBE. DRILL_ABORT_AT=<s> sets Eden's memory to 90 % of its MemoryMax that many seconds into the load, so the
# guard must stop it. Everything lives under OUT and is stopped by pid.
#
#   v2/tools/bench/stage2a/served-drill.sh [counts, default "100"]
#
# Env: SECS [120], REPEATS [1], VIEWERS [50], DRIVER_CPUS, DRILL_ABORT_AT, EDEN_FACTS, CARGO_TARGET_DIR, OUT.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
V2=$(cd "$HERE/../../.." && pwd)
B=${CARGO_TARGET_DIR:-$V2/target}/release
FACTS=${EDEN_FACTS:-$V2/../.local/eden.facts.json}
OUT=${OUT:-$V2/../.local/drill-$(date -u +%H%M%S)}
ID=ed-e0-1 N=$(echo "${1:-100}" | tr ' ' '\n' | sort -n | tail -1)
R=$OUT/root W=$OUT/root/worlds/$ID CG=$OUT/cg
mkdir -p "$W" "$R/health" "$CG/souls.slice/worldd@$ID.service" "$OUT/e"
cp -r "$V2/../content/kinds/." "$OUT/e/"
WP= GP= OP= MP=
trap 'for p in $MP $OP $GP $WP; do kill "$p" 2> /dev/null; done' EXIT
trap 'exit 143' INT TERM HUP
"$B/worldd" seed --facts "$FACTS" --dir "$W" --entries "$OUT/e" --souls "$N" > "$OUT/seed.log" 2>&1 || { tail "$OUT/seed.log"; exit 1; }
"$B/worldd" serve --dir "$W" --socket "$OUT/w.sock" > "$OUT/worldd.log" 2>&1 &
WP=$!
for _ in $(seq 1 120); do [ -S "$OUT/w.sock" ] && [ -f "$W/views/world.json" ] && [ -f "$W/health.json" ] && break; sleep 1; done
"$B/gatewayd" --listen 127.0.0.1:0 --world "$OUT/w.sock" --tokens "$W/tokens" --build 1220 --entries "$W/entries" > "$OUT/gw.log" 2>&1 &
GP=$!
for _ in $(seq 1 60); do grep -q '^listening' "$OUT/gw.log" && break; sleep 1; done
ADDR=$(sed -n 's/^listening //p' "$OUT/gw.log" | head -1)
ORIGIN_PROCESSES=1 node "$V2/tools/origin/origin.mjs" "$W" 0 127.0.0.1 > "$OUT/origin.log" 2>&1 &
OP=$!
for _ in $(seq 1 60); do grep -q '^origin' "$OUT/origin.log" && break; sleep 1; done
OPORT=$(sed -n 's/^origin \([0-9]*\).*/\1/p' "$OUT/origin.log" | head -1)
S=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stream.replace(/^\/|\/$/g, "")' "$W/views/world.json")
echo '{"state":"running"}' > "$R/health/$ID.json"
echo '{"state":"asleep"}' > "$R/health/a0-b0-2.json"
echo $((4 * 2 ** 30)) > "$CG/souls.slice/worldd@$ID.service/memory.max"
echo $((14 * 2 ** 30)) > "$CG/souls.slice/memory.max"
# The stand-in's memory: worldd's resident memory, the slice 1 GB more; 90 % of 4G from DRILL_ABORT_AT into the load.
(
  while :; do
    kb=$(sed -n 's/^VmRSS:\s*\([0-9]*\).*/\1/p' "/proc/$WP/status" 2> /dev/null)
    e=$((${kb:-0} * 1024))
    if [ -n "${DRILL_ABORT_AT:-}" ] && L=$(ls "$OUT"/limits/*/win.txt 2> /dev/null | tail -1) && [ -n "$L" ] &&
      [ $(($(date +%s) - $(head -1 "$L"))) -ge "$DRILL_ABORT_AT" ]; then e=$((4 * 2 ** 30 * 9 / 10)); fi
    echo "$e" > "$CG/souls.slice/worldd@$ID.service/memory.current"
    echo $((e + 2 ** 30)) > "$CG/souls.slice/memory.current"
    sleep 2
  done
) &
MP=$!
sleep 3
echo "drill: stand-in Eden $WP, gateway $GP ($ADDR), origin $OP ($OPORT), stream /$S/"
OUT=$OUT/limits SECS=${SECS:-120} REPEATS=${REPEATS:-1} VIEWERS=${VIEWERS:-50} \
  GATEWAY="ws://$ADDR" TOKENS_FILE="$W/souls.tokens" STREAM="http://127.0.0.1:$OPORT/$S/" VIEWER_URL="http://127.0.0.1:$OPORT/$S/" \
  PROBE="node $HERE/guard.mjs probe --root $R --cgroup $CG --instance $ID --every 5" \
  bash "$HERE/limits.sh" "${1:-100}"
echo "drill: limits.sh exit $?"
