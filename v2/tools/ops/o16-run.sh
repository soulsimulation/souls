#!/usr/bin/env bash
# O16 (#2809): the gateway upgraded, then killed, under 1,000 scripted agents of the shared uneven shape. One world
# (`worldd gateway-link`), its gateway and one client per agent; the gateway is upgraded at 20 s and killed at 40 s.
# Prints each event's row and the intents' row. Runbook: v2/docs/runbook/gateway-upgrade.md. Never on a machine that
# serves worlds. Scratch goes to <repo>/.local/o16-run (override with O16_ROOT).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=${O16_ROOT:-../.local/o16-run}
cargo build --release --locked --quiet -p ops -p worldd -p gatewayd
ulimit -n 8192
mkdir -p "$ROOT"
node tools/driver/loads.mjs target --agents 1000 --seconds 60 --seed 1 --out "$ROOT/schedule.txt"
target/release/o16-run --dir "$ROOT/run" --schedule "$ROOT/schedule.txt"
