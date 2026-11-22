#!/usr/bin/env bash
# Builds the chess-move check to ../chess-move.wasm (Engine v2 F8, #2823) on v2's pinned toolchain, with a 16 KiB
# stack so its memory fits the hatch's limit. The hatch test names the module by the hash of the committed bytes.
set -euo pipefail
cd "$(dirname "$0")"
RUSTFLAGS="-C link-arg=-zstack-size=16384" cargo build --release --target wasm32-unknown-unknown \
  --target-dir ../../../../../target/chess-move --quiet
cp ../../../../../target/chess-move/wasm32-unknown-unknown/release/chess_move.wasm ../chess-move.wasm
wc -c ../chess-move.wasm
