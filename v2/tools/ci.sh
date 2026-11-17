#!/usr/bin/env bash
# CI's `v2` job (.github/workflows/ci.yml, K15 #2637): checks the v2 Rust workspace on the toolchain
# v2/rust-toolchain.toml pins: format, Clippy with warnings as errors, tests, replica's WASM build, and the load tests
# that call it in Node and in a headless browser (K1, #2638). Later tasks add their steps here, not new jobs.
# Needs node and Chrome or Chromium (or $CHROME) on PATH, as ubuntu-latest has. Runs from any directory.
set -euo pipefail
cd "$(dirname "$0")/.."

step() {
  local name=$1 start=$SECONDS
  shift
  echo "::group::v2: $name"
  "$@"
  echo "::endgroup::"
  echo "v2: $name took $((SECONDS - start)) s"
}

# The pinned toolchain's components and WASM target, when the install left them out (no-ops otherwise).
step toolchain bash -c 'rustup component add rustfmt clippy && rustup target add wasm32-unknown-unknown'

step format cargo fmt --all --check
step lints cargo clippy --workspace --all-targets --locked -- -D warnings
# replica's WASM-only code (the wasm-bindgen export) is linted on its own target too.
step lints-wasm cargo clippy -p replica --target wasm32-unknown-unknown --locked -- -D warnings
step tests cargo test --workspace --locked

# The WASM build: one artifact (wasm-bindgen --target web) that Node loads with initSync and a page with init().
# The command's version is the wasm-bindgen crate's in Cargo.lock; it is installed under target/, which CI caches.
bindgen_version=$(sed -n '/^name = "wasm-bindgen"$/{n;s/^version = "\(.*\)"$/\1/p;}' Cargo.lock)
step wasm-bindgen-cli cargo install wasm-bindgen-cli --version "$bindgen_version" --locked --root target/tools --quiet
step wasm-build cargo build -p replica --release --target wasm32-unknown-unknown --locked
step wasm-bindgen target/tools/bin/wasm-bindgen --target web --out-dir target/wasm-load/pkg \
  target/wasm32-unknown-unknown/release/replica.wasm

# The same exported function, natively, in Node and in a headless browser.
input=2638
native=$(cargo run -p wasm-load --locked --quiet -- "$input")
echo "native: load_probe($input) = $native"
step load-node node tools/wasm-load/node.mjs target/wasm-load/pkg "$input" "$native"
step load-browser node tools/wasm-load/browser.mjs target/wasm-load/pkg "$input" "$native"

# The encoding vectors (T0, #2639) through the same WASM build and the cborg library, in Node. The native build runs
# them in `cargo test` (crates/replica/tests/encoding.rs).
step encoding-vectors bash -c 'npm ci --prefix tools/encoding-vectors --no-audit --no-fund &&
  node tools/encoding-vectors/run.mjs target/wasm-load/pkg crates/replica/fixtures/encoding'
