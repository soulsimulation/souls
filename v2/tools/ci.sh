#!/usr/bin/env bash
# CI's `v2` job (.github/workflows/ci.yml, K15 #2637): builds and tests the v2 Rust workspace on the toolchain
# v2/rust-toolchain.toml pins. Later tasks add their steps here, not new jobs. Runs from any directory.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --workspace --locked
cargo test --workspace --locked
