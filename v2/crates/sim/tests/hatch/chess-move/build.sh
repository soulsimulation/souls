#!/usr/bin/env bash
# Builds the chess table's rules (Engine v2 F8, #2823; #3713) on v2's pinned toolchain, with a 16 KiB stack so its
# memory fits the hatch's limit, to the module the kit ships beside the table's entry
# (content/kinds/games/chess_table.wasm). The entry and the hatch test name it by the hash of the committed bytes.
set -euo pipefail
cd "$(dirname "$0")"
RUSTFLAGS="-C link-arg=-zstack-size=16384" cargo build --release --target wasm32-unknown-unknown \
  --target-dir ../../../../../target/chess-move --quiet
out=../../../../../../content/kinds/games/chess_table.wasm
cp ../../../../../target/chess-move/wasm32-unknown-unknown/release/chess_move.wasm "$out"
wc -c "$out"
sha256sum "$out" 2>/dev/null || shasum -a 256 "$out"
