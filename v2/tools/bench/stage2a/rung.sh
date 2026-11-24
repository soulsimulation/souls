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
#
# VIEWERS=<m> (0.133 P3) adds m viewers on the world's public stream while the agents act (viewers.mjs; its arm is
# this rung's), on VIEWER_CPUS (default DRIVER_CPUS); they need replica's wasm-bindgen package at REPLICA_PKG
# (default $CARGO_TARGET_DIR/wasm-load/pkg). The rung's own processes are stopped by pid when it ends or is stopped,
# and it refuses a folder under /var/lib/souls or /etc/souls (a served machine's worlds).
set -u
N=$1 ARM=$2 RATE=$3 CPUS=$4 SECS=${5:-120}
V2=$(cd "$(dirname "$0")/../../.." && pwd)
B=${CARGO_TARGET_DIR:-$V2/target}/release
FACTS=${EDEN_FACTS:-$FARM_DATA/eden-2026-current.facts.json}
DRIVER_CPUS=${DRIVER_CPUS:-40-47}
D=${6:-${FARM_DATA:-$V2/../.local}/stage2a/$N-$ARM-$RATE-$CPUS}
E=$(dirname "$D")/entries
case "$(realpath -m "$D")/ $(realpath -m "${WORLD_ROOT:-/nonexistent}")/" in
  */var/lib/souls/* | */etc/souls/*) echo "rung.sh: refusing a folder under /var/lib/souls or /etc/souls" >&2; exit 2 ;;
esac
# The world's folder: in the run's folder, or with WORLD_ROOT (e.g. /dev/shm) on a disk of its own, removed after the
# run. On a shared machine whose disk another job saturates, the log's sync is that job's cost, not this load's.
W=${WORLD_ROOT:+$WORLD_ROOT/stage2a-$N-$ARM-$RATE-${CPUS//,/_}}
W=${W:-$D}/w
rm -rf "$D" "$(dirname "$W")"; mkdir -p "$D/run" "$E" "$(dirname "$W")"
[ -f "$E/ok" ] || { cp -r "$V2/../content/kinds/." "$E/"; touch "$E/ok"; }
# Run in the background (`pin ... &`), so `exec`: the background job's pid is the program's own.
pin() { if [ "$CPUS" = all ]; then exec "$@"; else exec taskset -c "$CPUS" "$@"; fi; }
cat /proc/loadavg > "$D/loadavg.before"
# Stopped or not, the rung's own processes end with it, by pid (never by name: other runs use the same programs).
SP= VP= GP= OP= WP= TP=
stop_all() { for p in $SP $VP $GP $OP $TP $WP; do kill "$p" 2> /dev/null; done; }
trap stop_all EXIT
trap 'exit 143' INT TERM HUP
echo "world folder: ${WORLD_ROOT:-run folder}" > "$D/world-root.txt"

"$B/worldd" seed --facts "$FACTS" --dir "$W" --entries "$E" --souls "${N%%x*}" > "$D/seed.log" 2>&1 \
  || { echo "seed failed"; tail "$D/seed.log"; exit 1; }
# SYNC_TRACE=1: the world under strace, every fsync and fdatasync of every thread written with its time
# (syncs.txt), to count disk syncs a second against acts a second. strace is the world's parent then, so the
# sampler and the stop find worldd as its child.
if [ "${SYNC_TRACE:-0}" = 1 ]; then
  pin strace -f -qq --seccomp-bpf -e trace=fsync,fdatasync,sync_file_range,syncfs -ttt -o "$D/syncs.txt" \
    "$B/worldd" serve --dir "$W" --socket "$W.sock" > "$D/worldd.log" 2>&1 &
  TP=$!
  for _ in $(seq 1 50); do WP=$(pgrep -P "$TP" -n) && break; sleep 0.1; done
else
  pin "$B/worldd" serve --dir "$W" --socket "$W.sock" > "$D/worldd.log" 2>&1 &
  WP=$!
fi
for _ in $(seq 1 120); do [ -S "$W.sock" ] && [ -f "$W/views/world.json" ] && break; sleep 1; done
sleep 2
pin "$B/gatewayd" --listen 127.0.0.1:0 --world "$W.sock" --tokens "$W/tokens" --build 1220 \
  --entries "$W/entries" > "$D/gw.log" 2>&1 &
GP=$!
for _ in $(seq 1 60); do grep -q '^listening' "$D/gw.log" && break; sleep 1; done
ADDR=$(sed -n 's/^listening //p' "$D/gw.log" | head -1)
# The viewers' origin over the world's folder; the stream's path is the one world.json names.
pin env ORIGIN_PROCESSES=1 node "$V2/tools/origin/origin.mjs" "$W" 0 127.0.0.1 > "$D/origin.log" 2>&1 &
OP=$!
for _ in $(seq 1 60); do grep -q '^origin' "$D/origin.log" && break; sleep 1; done
OPORT=$(sed -n 's/^origin \([0-9]*\).*/\1/p' "$D/origin.log" | head -1)
STREAM=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stream' "$W/views/world.json")
STREAM_URL="http://127.0.0.1:$OPORT/${STREAM#/}"
[ "${STREAM_URL%/}" = "$STREAM_URL" ] && STREAM_URL="$STREAM_URL/"
echo "rung $N $ARM $RATE cpus=$CPUS: world $WP gateway $GP ($ADDR) origin $OP ($STREAM_URL)"
if [ "${VIEWERS:-0}" -gt 0 ]; then
  taskset -c "${VIEWER_CPUS:-$DRIVER_CPUS}" node "$V2/tools/bench/stage2a/viewers.mjs" "http://127.0.0.1:$OPORT/" "${STREAM_URL#*://*/}" \
    "${REPLICA_PKG:-$B/../wasm-load/pkg}" "$VIEWERS" "$ARM" "$SECS" "$D/win.txt" "$D" > "$D/viewers.log" 2>&1 &
  VP=$!
fi

node "$V2/tools/driver/loads.mjs" "mix-$N-$ARM-$RATE" --seconds "$SECS" --seed 1 --out "$D/schedule.txt" > "$D/loads.log" 2>&1
# Every 5 s: each process's cores and memory, and the world's health (ticks, phases).
cat > "$D/sampler.cjs" << 'JS'
const fs = require('fs'); const [wp, gp, op, wd, out] = process.argv.slice(2);
const cpu = (p) => { try { const s = fs.readFileSync(`/proc/${p}/stat`, 'utf8').split(') ')[1].split(' '); return (+s[11] + +s[12]) / 100; } catch { return null; } };
const kids = (p) => { try { return fs.readFileSync(`/proc/${p}/task/${p}/children`, 'utf8').trim().split(/\s+/).filter(Boolean); } catch { return []; } };
const tree = (p) => [p, ...kids(p).flatMap(tree)];
const rss = (p) => { try { return +fs.readFileSync(`/proc/${p}/status`, 'utf8').match(/VmRSS:\s+(\d+)/)[1]; } catch { return 0; } };
const sum = (f, p) => tree(p).reduce((s, q) => s + (f(q) || 0), 0);
// The world's threads by name, their processor seconds summed: which one a profile is bound by.
const threads = (p) => { const o = {}; try { for (const t of fs.readdirSync(`/proc/${p}/task`)) { try { const st = fs.readFileSync(`/proc/${p}/task/${t}/stat`, 'utf8'); const name = st.slice(st.indexOf('(') + 1, st.lastIndexOf(')')); const f = st.slice(st.lastIndexOf(')') + 2).split(' '); o[name] = (o[name] ?? 0) + (+f[11] + +f[12]) / 100; } catch {} } } catch {} return o; };
setInterval(() => { let h = null; try { h = JSON.parse(fs.readFileSync(wd + '/health.json', 'utf8')); } catch {}
  fs.appendFileSync(out, JSON.stringify({ t: Date.now() / 1000, wcpu: cpu(wp), gcpu: cpu(gp), ocpu: sum(cpu, op), wrss: rss(wp), grss: rss(gp), orss: sum(rss, op), wthreads: threads(wp), gthreads: threads(gp), h }) + '\n'); }, 5000);
JS
node "$D/sampler.cjs" "$WP" "$GP" "$OP" "$W" "$D/samples.jsonl" &
SP=$!
sleep 1
date +%s > "$D/win.txt"
taskset -c "$DRIVER_CPUS" "$B/driver" --schedule "$D/schedule.txt" --dir "$D/run" --tokens "$W/souls.tokens" \
  --remote "ws://$ADDR" --speech --stream "$STREAM_URL" > "$D/driver.out" 2>&1
echo "driver exit $?" >> "$D/driver.out"
date +%s >> "$D/win.txt"
sleep 5
kill "$SP" 2> /dev/null
if [ -n "$VP" ]; then kill -TERM "$VP" 2> /dev/null; wait "$VP" 2> /dev/null; fi
cp "$W/health.json" "$D/health.final.json" 2> /dev/null
kill "$GP" "$OP" "$WP" 2> /dev/null
wait "$GP" "$OP" $TP 2> /dev/null; while kill -0 "$WP" 2> /dev/null; do sleep 0.2; done
SP= VP= GP= OP= WP= TP=
# The world's folder (a few hundred MB at 500 Souls) goes once measured, unless KEEP_WORLD=1: a ladder on a disk
# would otherwise fill it (a full disk ends the world's log: `log-failed`, every act after it refused).
du -sh "$W" > "$D/world-size.txt" 2>&1
if [ "${KEEP_WORLD:-0}" != 1 ]; then rm -rf "$W"; [ -n "${WORLD_ROOT:-}" ] && rm -rf "$(dirname "$W")"; fi
node "$V2/tools/bench/stage2a/analyze.mjs" "$D"
