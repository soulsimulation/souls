#!/usr/bin/env bash
# O3 A1 to A3 (#2732): ten kills, five under the even load shape and five under the uneven one. Each run starts the
# scripted world shipping its log (`archive ship`), kills it with SIGKILL at a random second, destroys its data folder,
# and rebuilds the world from the bucket alone (`archive rebuild`): one checkpoint and the pieces after it, the acts
# it holds checked against the driver's receipts, the acts lost and how long before the kill they were acknowledged,
# and the ledger of acts that cannot be undone. Prints the kill table. Runbook: v2/docs/runbook/log-shipping.md.
#
# Needs an S3-compatible store in ARCHIVE_STORE_ENDPOINT, _BUCKET, _ACCESS_KEY_ID, _SECRET_ACCESS_KEY (and _REGION):
# a local stand-in or a scratch bucket, never production's. Each run writes under its own prefix (o3/<stamp>/<run>/).
# Run from anywhere; scratch goes to <repo>/.local/o3-kill (override with O3_ROOT). O3_KILL_LEAST and O3_KILL_MOST
# bound the kill second (default 30 to 90).
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${ARCHIVE_STORE_ENDPOINT:?set ARCHIVE_STORE_ENDPOINT to a local stand-in or a scratch bucket}"
ROOT=${O3_ROOT:-../.local/o3-kill}
LEAST=${O3_KILL_LEAST:-30}
MOST=${O3_KILL_MOST:-90}
STAMP=$(date +%s)
cargo build -p archive --release --locked --quiet
BIN=target/release/archive
mkdir -p "$ROOT"
fail=0
printf '| run | load | kill (s) | checkpoint record | rebuilt through record | acts rebuilt | receipts below (acked + held) | equal | acts lost | lost window (s) | irreversible acked | past the mark | bar |\n'
printf '|---|---|---|---|---|---|---|---|---|---|---|---|---|\n'
for run in $(seq 10); do
  load=even
  [ "$run" -gt 5 ] && load=uneven
  kill_at=$((LEAST + RANDOM % (MOST - LEAST + 1)))
  data="$ROOT/run-$run/data"
  receipts="$ROOT/run-$run/receipts.txt"
  rm -rf "$ROOT/run-$run"
  mkdir -p "$ROOT/run-$run"
  export ARCHIVE_STORE_PREFIX="o3/$STAMP/$run/"
  "$BIN" ship "$data" "$receipts" "$load" 0 "$run" > "$ROOT/run-$run/ship.log" 2>&1 &
  pid=$!
  sleep "$kill_at"
  kill -9 "$pid"
  wait "$pid" 2> /dev/null || true
  rm -rf "$data"
  row=$("$BIN" rebuild "$receipts" "$kill_at" 2> "$ROOT/run-$run/rebuild.err" | tee "$ROOT/run-$run/rebuild.log" | grep '^|' || true)
  if [ -z "$row" ]; then
    row="| $load | $kill_at | rebuild failed: $(tr '\n' ' ' < "$ROOT/run-$run/rebuild.err") |"
  fi
  case "$row" in *"| MET |") ;; *) fail=1 ;; esac
  printf '| %s %s\n' "$run" "$row"
done
exit "$fail"
