#!/usr/bin/env bash
# Send to first answer for acts that start a walk and acts that do not (W11, #4087), through a served world's real
# gateway, with the load driver's remote mode (v2/tools/driver/README.md, #4066, #4071). One world per call:
# `worldd seed` on the given facts and entries, `worldd serve`, `gatewayd` on a loopback port of its own, then two
# driver runs of 20 agents each, one act an agent, 2 s apart: `walk` (each Soul walks to a thing with a seat) and
# `say` (no walk). Each run's report.json holds the first answers' p50 and p99 (of 20, the longest) per minute.
#
#   v2/tools/bench/walk-accept/run.sh <facts.json> <entries folder> <out folder> [--at <x>,<z>]
#
# Needs release builds of worldd, gatewayd and driver in BIN (default v2/target/release), the driver with its remote
# mode and targets (#4066, #4071). Fake minds: the engine runs none. Local only: loopback, its own folder.
set -euo pipefail
V2=$(cd "$(dirname "$0")/../../.." && pwd)
FACTS=$1 ENTRIES=$2 OUT=$3
shift 3
AT=0,0
[ "${1:-}" = --at ] && AT=$2
BIN=${BIN:-$V2/target/release}
N=20
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
rm -rf "$OUT/w" "$OUT/walk" "$OUT/say"
"$BIN/worldd" seed --facts "$FACTS" --dir "$OUT/w" --souls "$N" --at "$AT" --entries "$ENTRIES" > "$OUT/seed.log" 2>&1
PIDS=()
trap '[ ${#PIDS[@]} -eq 0 ] || kill "${PIDS[@]}" 2> /dev/null || true; wait 2> /dev/null || true' EXIT
"$BIN/worldd" serve --dir "$OUT/w" --socket "$OUT/w.sock" > "$OUT/worldd.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 600); do [ -S "$OUT/w.sock" ] && break; sleep 0.1; done
"$BIN/gatewayd" --listen 127.0.0.1:0 --world "$OUT/w.sock" --tokens "$OUT/w/tokens" --build 1220 \
  --entries "$OUT/w/entries" > "$OUT/gatewayd.out" 2> "$OUT/gatewayd.log" &
PIDS+=($!)
for _ in $(seq 600); do grep -q '^listening' "$OUT/gatewayd.out" 2> /dev/null && break; sleep 0.1; done
ADDR=$(sed -n 's/^listening //p' "$OUT/gatewayd.out" | head -n 1)
[ -n "$ADDR" ] || { echo "gatewayd did not listen" >&2; exit 1; }
for kind in walk say; do
  mkdir -p "$OUT/$kind"
  {
    echo "# w11 $kind: $N agents, one $kind each, 2 s apart"
    for i in $(seq 0 $((N - 1))); do echo "$((2000 + i * 2000)) $i $kind eden:$kind"; done
  } > "$OUT/$kind/schedule.txt"
  "$BIN/driver" --schedule "$OUT/$kind/schedule.txt" --dir "$OUT/$kind/run" --tokens "$OUT/w/souls.tokens" \
    --remote "ws://$ADDR" --speech > "$OUT/$kind/driver.out" 2>&1
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const m = r.perMinute ?? [];
    console.log(process.argv[2], JSON.stringify({ answers: r.answers, refusedBy: r.refusedBy, standIns: r.standIns,
      perMinute: m.map((x) => ({ answered: x.answered, p50: x.latencyP50Ms, p99: x.latencyP99Ms, errors: x.errors })) }));
  ' "$OUT/$kind/run/report.json" "$kind"
done
