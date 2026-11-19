#!/usr/bin/env bash
# O12 (#2807): a world restored from the bucket alone. Four runs, even load twice and uneven load twice: machine-a
# serves the scripted world (1,000 bodies, 9,000 things) under the agents and ships its log (O3); at a random second
# from 30 to 60 it is killed (SIGKILL) and its data folder deleted; machine-b, holding only the build and the bucket,
# runs the one restore command; a returning machine-a is then refused by its epoch. Two processes on this machine
# stand in for two machines over one bucket, a folder store with a cross-process lock: no host, bucket or service is
# touched. Prints the restore table. Each run takes about 60 to 90 s. Runbook: v2/docs/runbook/restore.md.
# Scratch goes to <repo>/.local/o12-restore (override with O12_ROOT).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=${O12_ROOT:-../.local/o12-restore}
cargo build -p ops --release --locked --quiet
BIN=target/release/ops
mkdir -p "$ROOT"
fail=0
printf '| load | seed | kill at (s) | fetch (s) | check (s) | claim (s) | serving after the loss (s) | first new act after the loss (s) | first new viewer file | bytes fetched | records restored | acts | lost window (s) | checkpoint hashes | archive (bytes) | a returning A | bar |\n'
printf '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n'
for load in even uneven; do
  for seed in 1 2; do
    if ! out=$("$BIN" restore "$ROOT/$load-$seed" "$load" "$seed" 2> "$ROOT/last.err"); then fail=1; fi
    row=$(printf '%s\n' "$out" | grep '^|' || true)
    [ -n "$row" ] || row="| $load | $seed | failed: $(tr '\n' ' ' < "$ROOT/last.err") |"
    printf '%s\n' "$row"
    printf '%s\n' "$out" | grep -v '^|' >> "$ROOT/hashes.txt" || true
  done
done
cat "$ROOT/hashes.txt"
exit "$fail"
