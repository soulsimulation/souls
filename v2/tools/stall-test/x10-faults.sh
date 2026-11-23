#!/usr/bin/env bash
# X10 (#4019): the fault pass on a served world. Each arm seeds the Eden slice (`tools/driver/slice.mjs`) with 50 test
# Souls, serves it (`worldd serve` and its own gatewayd, fake minds: the agents are the driver's, scripted), runs the
# 50-agent uneven load (`ladder-50-uneven`) through the driver as clients that come back after a lost socket
# (`--reconnect`), injects one fault, and prints one row of the fault table (`x10-check`):
#
#   kill     the world SIGKILLed at the fault second, started again 1 s later (its unit's restart)
#   gateway  the gateway restarted (SIGTERM, as `systemctl restart` sends it), started again on its port 1 s later
#   drop     20 % of the agents close their sockets at the fault second and come back 20 s later
#   slow     50 viewers follow the Souls' bodies, 10 % of them reading a frame every 2 s, for the whole run
#
# Build first (from v2/): cargo build --release -p gatewayd -p worldd -p testworld -p driver -p stall-test.
# Run from anywhere: tools/stall-test/x10-faults.sh [arm ...]. Scratch goes to <repo>/.local/x10 (X10_ROOT); the run
# is X10_SECONDS long (default 180) and the fault comes at X10_AT s of the driver's clock (default 60; the drop at
# X10_DROP_AT, default 120, once the late arrivals are in: an agent drops only if it is there at the drop). Local
# only: loopback ports, temporary folders, never a production world.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(mkdir -p "${X10_ROOT:-../.local/x10}" && cd "${X10_ROOT:-../.local/x10}" && pwd)
SECONDS_RUN=${X10_SECONDS:-180}
AT=${X10_AT:-60}
DROP_AT=${X10_DROP_AT:-120}
PORT=${X10_PORT:-47019}
BIN=${CARGO_TARGET_DIR:-$(pwd)/target}/release
ARMS=("$@")
[ ${#ARMS[@]} -eq 0 ] && ARMS=(kill gateway drop slow)

ms() { date +%s%3N; }
gone() { while kill -0 "$1" 2> /dev/null; do sleep 0.05; done; }
rss() { ps -o rss= -p "$1" 2> /dev/null | tr -d ' ' || true; }

base=$ROOT/base
if [ ! -f "$base/slice.facts.json" ]; then
  mkdir -p "$base"
  "$BIN/testworld" --seed 1 --things 0 --out "$base" > /dev/null
  node tools/driver/slice.mjs --facts "$base/testworld-s1-t0.facts.json" --out "$base" > /dev/null
fi

printf '| fault | events (from the fault) | agents timed | recovery p50 ms | slowest ms | never back | acked | acked and lost | duplicate receipts | stuck | memory before/peak/end | bar |\n'
printf '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|\n'
fail=0
for arm in "${ARMS[@]}"; do
  d=$ROOT/$arm
  rm -rf "$d"
  mkdir -p "$d"
  "$BIN/worldd" seed --facts "$base/slice.facts.json" --dir "$d/w" --souls 50 --at 0,0 --entries "$base/entries" \
    > "$d/seed.log" 2>&1
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$d/view.key"
  serve() { "$BIN/worldd" serve --dir "$d/w" --socket "$d/w.sock" >> "$d/worldd.log" 2>&1 & echo $!; }
  gateway() {
    "$BIN/gatewayd" --listen "127.0.0.1:$PORT" --world "$d/w.sock" --tokens "$d/w/tokens" --build 1220 \
      --entries "$d/w/entries" --view-key "$d/view.key" >> "$d/gatewayd.log" 2>&1 &
    echo $!
  }
  wpid=$(serve)
  for _ in $(seq 100); do [ -S "$d/w.sock" ] && break; sleep 0.1; done
  gpid=$(gateway)
  for _ in $(seq 100); do grep -q '^listening' "$d/gatewayd.log" 2> /dev/null && break; sleep 0.1; done
  node tools/driver/loads.mjs ladder-50-uneven --seconds "$SECONDS_RUN" --seed 1 --out "$d/schedule.txt" > /dev/null
  flags=(--reconnect --trace "$d/trace.txt")
  [ "$arm" = drop ] && flags+=(--drop "0.2@$DROP_AT+20")
  [ "$arm" = slow ] && flags+=(--viewers 50@0.1 --view-key "$d/view.key" --slow-read-ms 2000)
  "$BIN/driver" --schedule "$d/schedule.txt" --dir "$d/run" --tokens "$d/w/souls.tokens" \
    --remote "ws://127.0.0.1:$PORT" "${flags[@]}" > "$d/driver.out" 2>&1 &
  dpid=$!
  # Memory every 2 s, for as long as the driver runs.
  (while kill -0 "$dpid" 2> /dev/null; do
    echo "$(ms) $(rss "$(cat "$d/wpid" 2> /dev/null || echo 0)") $(rss "$(cat "$d/gpid" 2> /dev/null || echo 0)")"
    sleep 2
  done) > "$d/rss.txt" &
  echo "$wpid" > "$d/wpid"
  echo "$gpid" > "$d/gpid"
  # The driver's clock starts once every agent is signed in and the targets are read.
  for _ in $(seq 600); do grep -q '^targets:' "$d/driver.out" 2> /dev/null && break; sleep 0.1; done
  if [ "$arm" = drop ]; then sleep "$DROP_AT"; else sleep "$AT"; fi
  : > "$d/events.txt"
  case $arm in
    kill)
      kill -9 "$wpid"
      echo "$(ms) kill" >> "$d/events.txt"
      gone "$wpid"
      sleep 1
      wpid=$(serve)
      echo "$wpid" > "$d/wpid"
      echo "$(ms) started" >> "$d/events.txt"
      for _ in $(seq 600); do [ -S "$d/w.sock" ] && break; sleep 0.1; done
      ;;
    gateway)
      kill -TERM "$gpid"
      echo "$(ms) sigterm" >> "$d/events.txt"
      gone "$gpid"
      echo "$(ms) exited" >> "$d/events.txt"
      sleep 1
      gpid=$(gateway)
      echo "$gpid" > "$d/gpid"
      echo "$(ms) started" >> "$d/events.txt"
      ;;
    drop) echo "$(ms) drop" >> "$d/events.txt" ;;
    *) echo "$(ms) $arm" >> "$d/events.txt" ;;
  esac
  wait "$dpid" || true
  kill -TERM "$gpid" "$wpid" 2> /dev/null || true
  wait 2> /dev/null || true
  row=$("$BIN/x10-check" --fault "$arm" --trace "$d/trace.txt" --log "$d/w/log" --events "$d/events.txt" \
    --rss "$d/rss.txt" 2> "$d/check.err") || fail=1
  echo "$row"
done
for arm in "${ARMS[@]}"; do
  echo
  echo "## $arm"
  cat "$ROOT/$arm/check.err"
  grep -E '^Acts:|faults:|viewer |minute ' "$ROOT/$arm/driver.out" || true
done
exit "$fail"
