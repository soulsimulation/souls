#!/usr/bin/env bash
# The limits run's kit (0.133 P3): what limits.sh needs that is not in a checkout, built on a build machine and
# unpacked into a checkout of the same commit on the machine measured (which needs no Rust toolchain). From the root of
# a checkout of the commit under test, on Linux x86-64 with rustup and Node 22.18 or later:
#
#   v2/tools/bench/stage2a/kit.sh <Eden's facts file> <kit.tar.gz>
#
# It builds the release worldd, gatewayd and driver and replica's wasm-bindgen package (the wasm-bindgen command of
# the version Cargo.lock names, installed under v2/target/tools, as v2/tools/ci.sh does), and packs them with the facts
# at the paths limits.sh reads by default: v2/target/release/{worldd,gatewayd,driver}, v2/target/wasm-load/pkg and
# .local/eden.facts.json. Unpack it at the checkout's root: `tar -xzf <kit.tar.gz>`.
set -euo pipefail
FACTS=$(cd "$(dirname "${1:?Eden facts file}")" && pwd)/$(basename "$1")
KIT=$(cd "$(dirname "${2:?kit.tar.gz}")" && pwd)/$(basename "$2")
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
T=${CARGO_TARGET_DIR:-$ROOT/v2/target}
cd "$ROOT/v2"
cargo build --release --locked -q -p worldd -p gatewayd -p driver
v=$(sed -n '/^name = "wasm-bindgen"$/{n;s/^version = "\(.*\)"$/\1/p;}' Cargo.lock)
rustup target list --installed | grep -q '^wasm32-unknown-unknown$' || rustup target add wasm32-unknown-unknown
[ "$("$T/tools/bin/wasm-bindgen" --version 2> /dev/null)" = "wasm-bindgen $v" ] || cargo install wasm-bindgen-cli --version "$v" --locked --root "$T/tools" --quiet
cargo build -p replica --release --target wasm32-unknown-unknown --locked -q
"$T/tools/bin/wasm-bindgen" --target web --out-dir "$T/wasm-load/pkg" "$T/wasm32-unknown-unknown/release/replica.wasm"
S=$(mktemp -d)
trap 'rm -rf "$S"' EXIT
mkdir -p "$S/v2/target/release" "$S/v2/target/wasm-load" "$S/.local"
cp "$T/release/"{worldd,gatewayd,driver} "$S/v2/target/release/"
cp -R "$T/wasm-load/pkg" "$S/v2/target/wasm-load/"
cp "$FACTS" "$S/.local/eden.facts.json"
git -C "$ROOT" rev-parse HEAD > "$S/.local/limits-kit-commit"
tar -czf "$KIT" -C "$S" v2 .local
echo "kit: $KIT ($(du -h "$KIT" | cut -f1)), commit $(cut -c1-9 "$S/.local/limits-kit-commit")"
