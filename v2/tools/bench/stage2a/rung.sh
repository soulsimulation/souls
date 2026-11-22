#!/usr/bin/env bash
# One rung of stage 2a's ladder (#4154): Eden with N test Souls under `worldd serve`, its gatewayd and the viewers'
# origin (tools/origin/origin.mjs) over the world's public stream, driven by the driver with the real Soul Actions mix
# (loads.mjs `mix-<n>-<even|uneven>-<every4|burst>`), act wait read to the public stream (--stream), on Linux.
#
#   v2/tools/bench/stage2a/rung.sh <n> <even|uneven> <every4|burst> <world cpus|all> [seconds] [out folder]
#
# <world cpus> (taskset's list, e.g. 16-23) holds every world process (worldd, gatewayd, the origin); `all` leaves
# them on every core. The driver runs on DRIVER_CPUS (default 40-47), apart from them. Needs: the release worldd,
# gatewayd and driver in $CARGO_TARGET_DIR/release, node, and Eden's facts at $EDEN_FACTS (default
# $FARM_DATA/eden-2026-current.facts.json). Fake minds only: no model runs, nothing leaves loopback.
# Prints the analyser's summary (analyze.mjs) and leaves the run in the out folder.
set -u
N=$1 ARM=$2 RATE=$3 CPUS=$4 SECS=${5:-120}
V2=$(cd "$(dirname "$0")/../../.." && pwd)
B=${CARGO_TARGET_DIR:-$V2/target}/release
FACTS=${EDEN_FACTS:-$FARM_DATA/eden-2026-current.facts.json}
DRIVER_CPUS=${DRIVER_CPUS:-40-47}
D=${6:-${FARM_DATA:-$V2/../.local}/stage2a/$N-$ARM-$RATE-$CPUS}
E=$(dirname "$D")/entries
rm -rf "$D"; mkdir -p "$D/run" "$E"
[ -f "$E/ok" ] || { cp -r "$V2/../content/kinds/." "$E/"; touch "$E/ok"; }
pin() { if [ "$CPUS" = all ]; then "$@"; else taskset -c "$CPUS" "$@"; fi; }
cat /proc/loadavg > "$D/loadavg.before"

"$B/worldd" seed --facts "$FACTS" --dir "$D/w" --entries "$E" --souls "$N" > "$D/seed.log" 2>&1 \
  || { echo "seed failed"; tail "$D/seed.log"; exit 1; }
pin "$B/worldd" serve --dir "$D/w" --socket "$D/w.sock" > "$D/worldd.log" 2>&1 &
WP=$!
for _ in $(seq 1 120); do [ -S "$D/w.sock" ] && [ -f "$D/w/views/world.json" ] && break; sleep 1; done
sleep 2
pin "$B/gatewayd" --listen 127.0.0.1:0 --world "$D/w.sock" --tokens "$D/w/tokens" --build 1220 \
  --entries "$D/w/entries" > "$D/gw.log" 2>&1 &
GP=$!
for _ in $(seq 1 60); do grep -q '^listening' "$D/gw.log" && break; sleep 1; done
ADDR=$(sed -n 's/^listening //p' "$D/gw.log" | head -1)
# The viewers' origin over the world's folder; the stream's path is the one world.json names.
pin env ORIGIN_PROCESSES=1 node "$V2/tools/origin/origin.mjs" "$D/w" 0 127.0.0.1 > "$D/origin.log" 2>&1 &
OP=$!
for _ in $(seq 1 60); do grep -q '^origin' "$D/origin.log" && break; sleep 1; done
OPORT=$(sed -n 's/^origin \([0-9]*\).*/\1/p' "$D/origin.log" | head -1)
STREAM=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stream' "$D/w/views/world.json")
STREAM_URL="http://127.0.0.1:$OPORT/${STREAM#/}"
[ "${STREAM_URL%/}" = "$STREAM_URL" ] && STREAM_URL="$STREAM_URL/"
echo "rung $N $ARM $RATE cpus=$CPUS: world $WP gateway $GP ($ADDR) origin $OP ($STREAM_URL)"

node "$V2/tools/driver/loads.mjs" "mix-$N-$ARM-$RATE" --seconds "$SECS" --seed 1 --out "$D/schedule.txt" > "$D/loads.log" 2>&1
# Every 5 s: each process's cores and memory, and the world's health (ticks, phases).
cat > "$D/sampler.cjs" << 'JS'
const fs = require('fs'); const [wp, gp, op, wd, out] = process.argv.slice(2);
const cpu = (p) => { try { const s = fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' '); return (+s[11] + +s[12]) / 100; } catch { return null; } };
const kids = (p) => { try { return fs.readFileSync(`/proc/${p}/task/${p}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); } catch { return []; } };
const tree = (p) => [p, ...kids(p).flatMap(tree)];
const rss = (p) => { try { return +fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]; } catch { return 0; } };
const sum = (f, p) => tree(p).reduce((s, q) => s + (f(q) || 0), 0);
setInterval(() => { let h = null; try { h = JSON.parse(fs.readFileSync(wd + '/health.json', 'utf8')); } catch {}
  fs.appendFileSync(out, JSON.stringify({ t: Date.now() / 1000, wcpu: cpu(wp), gcpu: cpu(gp), ocpu: sum(cpu, op), wrss: rss(wp), grss: rss(gp), orss: sum(rss, op), h }) + '\n'); }, 5000);
JS
node "$D/sampler.cjs" "$WP" "$GP" "$OP" "$D/w" "$D/samples.jsonl" &
SP=$!
sleep 1
date +%s > "$D/win.txt"
taskset -c "$DRIVER_CPUS" "$B/driver" --schedule "$D/schedule.txt" --dir "$D/run" --tokens "$D/w/souls.tokens" \
  --remote "ws://$ADDR" --speech --stream "$STREAM_URL" > "$D/driver.out" 2>&1
echo "driver exit $?" >> "$D/driver.out"
date +%s >> "$D/win.txt"
sleep 5
kill "$SP" 2> /dev/null
cp "$D/w/health.json" "$D/health.final.json" 2> /dev/null
kill "$GP" "$OP" "$WP" 2> /dev/null
wait 2> /dev/null
node "$V2/tools/bench/stage2a/analyze.mjs" "$D"
