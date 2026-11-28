#!/usr/bin/env bash
# A day's soak (Engine v2 O6, #2803): one world of Eden's content under `worldd serve` and its gatewayd, driven by the
# driver (I10) at 1,000 agents for HOURS hours, the load alternating hourly between uneven (`target`) and even
# (`target-even`), with sampler.mjs writing one line a minute. Linux only; fake minds (the engine has none); nothing
# leaves loopback; no production data. Started detached so it outlives the session that starts it:
#
#   systemd-run --user --unit souls-soak-<name> --setenv=PATH="$PATH" \
#     bash v2/tools/soak/soak.sh <run folder> <Eden facts file>
#
# Env: HOURS (default 24), AGENTS (default 1000), SEED (default 1), WORLD_CPUS (default 36-46), DRIVER_CPUS (default
# 47), BIN (the folder holding release worldd, gatewayd and driver; default <run folder>/bin), MALLOC_ARENA_MAX
# (default 2, passed to the world and the gateway), MIN_FREE_GB (default 20: below it the run stops, saying so),
# SLOT_LOCK (a farm slot folder this run holds while it runs, e.g. the farm's locks/slot4).
#
# Stop it: `touch <run folder>/STOP` (the sampler and the driver stop within a minute) or `systemctl --user stop
# <unit>`. Every process it starts ends with it, by pid. After the last hour it kills the world with SIGKILL and
# times the restart (restart.txt): kill to the world's socket answering and its health saying it serves.
# Read it: `node v2/tools/soak/collect.mjs <run folder>`.
set -u
D=$(realpath -m "${1:?run folder}") FACTS=$(realpath "${2:?Eden facts file}")
HERE=$(cd "$(dirname "$0")" && pwd) V2=$(cd "$(dirname "$0")/../.." && pwd)
B=${BIN:-$D/bin} HOURS=${HOURS:-24} AGENTS=${AGENTS:-1000} SEED=${SEED:-1}
WORLD_CPUS=${WORLD_CPUS:-36-46} DRIVER_CPUS=${DRIVER_CPUS:-47}
export MALLOC_ARENA_MAX=${MALLOC_ARENA_MAX:-2}
case "$D/" in */var/lib/souls/* | */etc/souls/*) echo "soak: refusing a served machine's folder" >&2; exit 2 ;; esac
W=$D/w E=$D/entries
mkdir -p "$D/runs" "$E"
log() { echo "$(date -u +%FT%TZ) $*" | tee -a "$D/soak.log"; }
WP= GP= SP= DP=
stop_all() { for p in $DP $SP $GP $WP; do kill "$p" 2> /dev/null; done; [ -z "${SLOT_LOCK:-}" ] || rm -rf "$SLOT_LOCK"; }
trap stop_all EXIT
trap 'log "stopped by signal"; exit 143' INT TERM HUP
if [ -n "${SLOT_LOCK:-}" ]; then
  mkdir "$SLOT_LOCK" 2> /dev/null || { echo "soak: $SLOT_LOCK is held" >&2; exit 2; }
  echo $$ > "$SLOT_LOCK/pid"; echo "soak $(basename "$D") $(date -Is)" > "$SLOT_LOCK/job"
fi
rm -f "$D/STOP"
{ echo "commit $(git -C "$V2" rev-parse HEAD 2> /dev/null || echo unknown)"; echo "worldd $(sha256sum "$B/worldd" | cut -c1-16)"
  echo "hours $HOURS agents $AGENTS seed $SEED world_cpus $WORLD_CPUS driver_cpus $DRIVER_CPUS MALLOC_ARENA_MAX $MALLOC_ARENA_MAX"
  echo "cores $(nproc) mem $(free -g | awk '/Mem:/ {print $2}') GB kernel $(uname -r)"; } > "$D/declared.txt"

[ -f "$E/ok" ] || { cp -r "$V2/../content/kinds/." "$E/"; touch "$E/ok"; }
if [ ! -f "$W/views/world.json" ]; then
  log "seeding $AGENTS Souls on $(basename "$FACTS")"
  "$B/worldd" seed --facts "$FACTS" --dir "$W" --entries "$E" --souls "$AGENTS" > "$D/seed.log" 2>&1 || { log "seed failed"; exit 1; }
fi
for arm in uneven even; do
  load=target; [ "$arm" = even ] && load=target-even
  node "$V2/tools/driver/loads.mjs" "$load" --agents "$AGENTS" --seconds 3600 --seed "$SEED" --out "$D/schedule-$arm.txt" > /dev/null
  log "schedule $arm: $(head -1 "$D/schedule-$arm.txt" | cut -c1-220)"
done

start_world() {
  taskset -c "$WORLD_CPUS" "$B/worldd" serve --dir "$W" --socket "$W.sock" >> "$D/worldd.log" 2>&1 &
  WP=$!
  for _ in $(seq 1 600); do [ -S "$W.sock" ] && grep -q '"at_unix_ms"' "$W/health.json" 2> /dev/null && break; sleep 0.05; done
}
start_gateway() {
  : > "$D/gw.log"
  taskset -c "$WORLD_CPUS" "$B/gatewayd" --listen 127.0.0.1:0 --world "$W.sock" --tokens "$W/tokens" --build 1220 \
    --entries "$W/entries" >> "$D/gw.log" 2>&1 &
  GP=$!
  for _ in $(seq 1 60); do grep -q '^listening' "$D/gw.log" && break; sleep 1; done
  ADDR=$(sed -n 's/^listening //p' "$D/gw.log" | head -1)
}
start_world; start_gateway
log "world $WP gateway $GP ($ADDR)"
echo "$WP $GP" > "$D/pids.txt"
node "$HERE/sampler.mjs" "$D" "$W" "$WP" "$GP" >> "$D/sampler.log" 2>&1 &
SP=$!
T0=$(date +%s); echo "$T0" > "$D/start.txt"
for h in $(seq 0 $((HOURS - 1))); do
  [ -f "$D/STOP" ] && { log "STOP file: stopping before hour $h"; break; }
  free=$(df -BG --output=avail "$D" | tail -1 | tr -dc 0-9)
  [ "$free" -lt "${MIN_FREE_GB:-20}" ] && { log "disk: ${free} GB free, under ${MIN_FREE_GB:-20}; stopping"; break; }
  kill -0 "$WP" 2> /dev/null || { log "world exited before hour $h"; break; }
  arm=uneven; [ $((h % 2)) = 1 ] && arm=even
  R=$D/runs/h$(printf %02d "$h")-$arm; mkdir -p "$R"
  # The hour starts at its due time, so a slow drain never shifts the hours against the minute file.
  due=$((T0 + h * 3600)); now=$(date +%s); [ "$now" -lt "$due" ] && sleep $((due - now))
  echo "$h $arm $(date +%s)" >> "$D/hours.txt"
  log "hour $h: $arm"
  # 3,540 s of acts and the driver's 15 s drain fit in the hour.
  head -1 "$D/schedule-$arm.txt" > "$R/schedule.txt"
  awk 'NR > 1 && $1 < 3540000' "$D/schedule-$arm.txt" >> "$R/schedule.txt"
  taskset -c "$DRIVER_CPUS" "$B/driver" --schedule "$R/schedule.txt" --dir "$R" --tokens "$W/souls.tokens" \
    --remote "ws://$ADDR" > "$R/driver.out" 2>&1 &
  DP=$!
  while kill -0 "$DP" 2> /dev/null; do
    [ -f "$D/STOP" ] && { kill "$DP"; log "STOP file: driver stopped in hour $h"; }
    sleep 10
  done
  wait "$DP"; echo "driver exit $?" >> "$R/driver.out"; DP=
  grep -E '^Acts' "$R/driver.out" | cut -c1-200 | while read -r l; do log "hour $h: $l"; done
done
if [ ! -f "$D/STOP" ] && kill -0 "$WP" 2> /dev/null; then
  # The restart: SIGKILL the world, start it again on its folder, time until its socket answers and its health is new.
  k=$(date +%s.%N); kill -9 "$WP"; wait "$WP" 2> /dev/null; rm -f "$W.sock"
  start_world; r=$(date +%s.%N); echo "$WP $GP" > "$D/pids.txt"
  log "restart: killed at $k, serving after $(echo "$r - $k" | bc) s"
  echo "killed $k serving $r seconds $(echo "$r - $k" | bc)" > "$D/restart.txt"
fi
sleep 65
log "soak ended"
