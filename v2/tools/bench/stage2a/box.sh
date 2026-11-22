#!/usr/bin/env bash
# Stage 2a on a fresh Linux box (#4154): one command that builds what the ladder runs and runs it, for the deciding
# runs on a quiet, dedicated machine (two repeats per arm). From the root of a checkout of the build under test:
#
#   v2/tools/bench/stage2a/box.sh <Eden's facts file> [counts, default "100 200 350 500"] [seconds, default 120]
#
# The box needs: Linux x86-64; git, a C toolchain (build-essential) and rustup (the toolchain in
# v2/rust-toolchain.toml installs itself on the first cargo call); Node 22 or later; util-linux's taskset; about
# 4 GB of memory and 10 GB of disk. Eden's facts file is not in the repository: copy it to the box (on the farm it is
# $FARM_DATA/eden-2026-current.facts.json). Nothing leaves loopback, no model runs (the engine has no mind), and no
# production data or service is touched.
#
# Arms (env): WORLD_CPUS (default `all`: every core) holds worldd, gatewayd and the viewers' origin; DRIVER_CPUS
# (default the last core) the driver, whose own cost is about 0.05 of a core at 500 agents. For an 8-core arm on a
# 16-core box: WORLD_CPUS=0-7 DRIVER_CPUS=15. REPEATS (default 2), RATES (default "every4 burst"), ARMS (default
# "even uneven"). The world's folder is on the box's disk (its log syncs as a production world's does); WORLD_ROOT
# moves it (e.g. /dev/shm). The rungs go to OUT (default .local/stage2a); the tables print at the end.
set -euo pipefail
FACTS=$(cd "$(dirname "${1:?Eden facts file}")" && pwd)/$(basename "$1")
COUNTS=${2:-100 200 350 500} SECS=${3:-120}
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
export CARGO_TARGET_DIR=${CARGO_TARGET_DIR:-$ROOT/v2/target}
export EDEN_FACTS=$FACTS OUT=${OUT:-$ROOT/.local/stage2a} REPEATS=${REPEATS:-2}
export DRIVER_CPUS=${DRIVER_CPUS:-$(($(nproc) - 1))}
for c in cargo node taskset; do command -v "$c" > /dev/null || { echo "box.sh: $c is not on PATH" >&2; exit 2; }; done
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "box.sh: Node 22 or later" >&2; exit 2; }
mkdir -p "$OUT"
(cd "$ROOT/v2" && cargo build --release --locked -p worldd -p gatewayd -p driver)
{ echo "box: $(nproc) cores, $(free -g | awk '/Mem:/ {print $2}') GB, $(uname -r), commit $(git -C "$ROOT" rev-parse --short HEAD)"
  echo "arms: world ${WORLD_CPUS:-all}, driver $DRIVER_CPUS, repeats $REPEATS, $SECS s a rung"; } | tee "$OUT.box.txt"
LABEL=${LABEL:-"stage 2a, dedicated box ($(nproc) cores), world on ${WORLD_CPUS:-all}"} \
  bash "$ROOT/v2/tools/bench/stage2a/ladder.sh" "${WORLD_CPUS:-all}" "$SECS" "$COUNTS" "${RATES:-every4 burst}" "${ARMS:-even uneven}"
