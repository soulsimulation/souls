#!/usr/bin/env bash
# O9 (#2828): moving a live world to another machine. Two world processes on this machine stand in for two machines
# (machine-a, machine-b) over one bucket, a folder store with a cross-process lock; no host, bucket or service is
# touched. Prints two tables: four clean moves under 1,000 scripted agents (even and uneven, two repeats each), then
# the kill table (each side killed with SIGKILL as each of the four steps starts). Each run takes about 50 s.
# Runbook: v2/docs/runbook/move-a-world.md. Scratch goes to <repo>/.local/o9-move (override with O9_ROOT).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=${O9_ROOT:-../.local/o9-move}
cargo build -p ops --release --locked --quiet
BIN=target/release/ops
mkdir -p "$ROOT"
fail=0
row() {
  local out
  if ! out=$("$BIN" move "$@" 2> "$ROOT/last.err"); then fail=1; fi
  printf '%s\n' "$(printf '%s\n' "$out" | grep '^|' || printf '| %s | failed: %s |' "$*" "$(tr '\n' ' ' < "$ROOT/last.err")")"
}
printf '| load | seed | intents | held | longest held wait (s) | longest gap between acks (s) | acked by source + target | acked but missing on the target | ends | hold to release | sealed at | owed ticks paid | ticks | epochs in the directory and the bucket | bar |\n'
printf '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n'
for load in even uneven; do
  for seed in 1 2; do
    row "$ROOT/$load-$seed" "$load" "$seed"
  done
done
printf '\n| kill | load | owner after (directory) | serving again after the kill | acked but missing | ends | epochs in the directory and the bucket | bar |\n'
printf '|---|---|---|---|---|---|---|---|\n'
for step in prepare drain fence resume; do
  for side in source target; do
    row "$ROOT/kill-$side-$step" even 3 --kill "$side:$step"
  done
done
exit "$fail"
