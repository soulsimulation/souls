#!/usr/bin/env bash
# O20 (#2812): what is not in the log is backed up and comes back. Two runs (seeds 1 and 2): machine-a keeps the account
# store, pairing and its tokens file and a world's text store (words, uploads, the removal list), writing to each under
# its owner's code and shipping them to a folder store standing in for the offsite bucket; at a random second from 280
# to 560 (after the first full copy at 270 s, up to one whole interval past it) it is killed (SIGKILL) and its data
# folder deleted; machine-b, holding only the bucket and the recovery passphrase, restores and checks every acknowledged
# write. No host, bucket or service is touched. Each run takes up to about 10 minutes. Runbook:
# v2/docs/runbook/restore-stores.md.
# Scratch goes to <repo>/.local/o20-drill (override with O20_ROOT).
set -euo pipefail
cd "$(dirname "$0")/../../.."
ROOT=${O20_ROOT:-../.local/o20-drill}
cargo build -p backup --release --locked --quiet
mkdir -p "$ROOT"
fail=0
for seed in 1 2; do
  target/release/o20-drill "$ROOT/run-$seed" "$seed" || fail=1
done
exit "$fail"
