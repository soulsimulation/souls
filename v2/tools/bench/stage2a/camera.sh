#!/usr/bin/env bash
# Stage 2a's camera world (#4154): Eden with N test Souls behind the whole local stack (`v2/tools/dev/run.sh`: the
# world, its gateway, the directory, the viewers' origin and the v2 page, on loopback), driven by the driver with the
# real Soul Actions mix for the seconds given, so a browser can film the world at that load. The v2 page here is used
# as a camera for the measurement, not as the product page.
#
#   v2/tools/bench/stage2a/camera.sh <n> <seconds> [port] [folder]
#
# Needs what run.sh needs (caddy, node), the release worldd, gatewayd, directoryd, testworld and driver in
# $CARGO_TARGET_DIR/release, and Eden's facts at $EDEN_FACTS (default $FARM_DATA/eden-2026-current.facts.json).
# Prints `ready <url>` once the page is up, then the driver's report when the load ends, then stops everything.
set -u
N=$1 SECS=$2 PORT=${3:-7600}
V2=$(cd "$(dirname "$0")/../../.." && pwd)
B=${CARGO_TARGET_DIR:-$V2/target}/release
FACTS=${EDEN_FACTS:-$FARM_DATA/eden-2026-current.facts.json}
DIR=${4:-${WORLD_ROOT:-/dev/shm}/stage2a-camera}
rm -rf "$DIR"; mkdir -p "$DIR/entries" "$DIR/run"
cp -r "$V2/../content/kinds/." "$DIR/entries/"
CREATOR=$(printf 'd0%.0s' $(seq 16))-1
"$B/worldd" seed --facts "$FACTS" --dir "$DIR/world" --entries "$DIR/entries" --souls "$N" --creator "$CREATOR" \
  > "$DIR/seed.log" 2>&1 || { echo "seed failed: $(tail -n 3 "$DIR/seed.log")"; exit 1; }
od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$DIR/view.key"
# The directory rewrites the gateway's tokens file with what it has paired: the seeded test Souls' lines go back in
# once the stack is up (the gateway reads the file again every 2 s).
cp "$DIR/world/tokens" "$DIR/tokens.seeded"
V2_BIN=$B "$V2/tools/dev/run.sh" --port "$PORT" --dir "$DIR" > "$DIR/stack.log" 2>&1 &
STACK=$!
for _ in $(seq 1 900); do grep -q '^ready' "$DIR/stack.log" && break; kill -0 "$STACK" 2> /dev/null || break; sleep 1; done
grep '^ready' "$DIR/stack.log" || { echo "the stack did not start:"; tail -n 20 "$DIR/stack.log"; exit 1; }
grep -v '^#' "$DIR/tokens.seeded" >> "$DIR/world/tokens"
sleep 3
STREAM=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).stream' "$DIR/world/views/world.json")
node "$V2/tools/driver/loads.mjs" "mix-$N-uneven-every4" --seconds "$SECS" --seed 1 --out "$DIR/schedule.txt"
"$B/driver" --schedule "$DIR/schedule.txt" --dir "$DIR/run" --tokens "$DIR/world/souls.tokens" \
  --remote "ws://127.0.0.1:$((PORT + 2))" --speech --stream "http://127.0.0.1:$((PORT + 3))/w/dev/${STREAM#/}" \
  > "$DIR/driver.out" 2>&1
grep -E '^(Visible|Stuck|Acts)' "$DIR/driver.out" | cut -c1-300
kill "$STACK"; wait "$STACK" 2> /dev/null
