#!/usr/bin/env bash
# A live arm of Soul Runs specs, one run at a time (#1098). Called by run-replay.sh when PLAYTEST_SPECS is set.
#   run-specs.sh <server-root> <out-dir> <repeats> <spec.json>...
# Order: every spec, then every spec again (1, 3, 4, 1, 3, 4). Before each run it waits for the 5-minute load to drop under 8 (PLAYTEST_LOAD_MAX).
# Stops: SIGINT to a run whose world reaches $1; no further run once the arm reaches $4; the arm stops if the first card isn't
# predeclared. PLAYTEST_WORLD_MAX_USD can lower the $1, and a value above it is refused (exit 2). A world's own cap is its cast's rails.worldBudgetUsd. Everything lands in <out-dir>/arm.log.
set -uo pipefail
SERVER="$1"; OUT="$2"; REPEATS="$3"; shift 3
WORLD_MAX="${PLAYTEST_WORLD_MAX_USD:-1}"; ARM_MAX="${PLAYTEST_ARM_MAX_USD:-4}"; LOAD_MAX="${PLAYTEST_LOAD_MAX:-8}"
# the environment may lower the per-world stop, never raise it: $1 per world per rolling 24 h (AGENTS.md)
node -e 'const v=Number(process.argv[1]);process.exit(process.argv[1]!==""&&v>0&&v<=1?0:1)' "$WORLD_MAX" || { echo "PLAYTEST_WORLD_MAX_USD=$WORLD_MAX refused: the per-world stop can be lowered, never set above \$1" >&2; exit 2; }
L="$OUT/arm.log"; arm=0; first=1
note() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$L" >&2; }
over() { node -e 'process.exit(Number(process.argv[1])>=Number(process.argv[2])?0:1)' "$1" "$2"; }
load5() { cut -d' ' -f2 /proc/loadavg 2>/dev/null || sysctl -n vm.loadavg | awk '{print $3}'; }
note "arm start tools $(git rev-parse --short=9 HEAD) server $(git -C "$SERVER" rev-parse --short=9 HEAD) specs: $*"
for ((rep = 1; rep <= REPEATS; rep++)); do
  for spec in "$@"; do
    name="$(basename "$spec" .json)-r$rep"; run="$OUT/$name"
    [ -e "$run" ] && { note "exists, skipped: $name"; arm=$(node -e 'console.log((Number(process.argv[1])+Number(process.argv[2])).toFixed(4))' "$arm" "$(node tools/playtest/runs/spend.mjs "$run")"); first=0; continue; }
    if over "$arm" "$ARM_MAX"; then note "arm at \$$arm, past \$$ARM_MAX: no further run"; exit 6; fi
    until node -e 'process.exit(Number(process.argv[1])<Number(process.argv[2])?0:1)' "$(load5)" "$LOAD_MAX"; do sleep 15; done
    note "start $name load $(load5)"
    node tools/playtest/runs/run.mjs start "$spec" --server-root "$SERVER" --out "$run" ${PLAYTEST_RUN_FLAGS:-} > "$OUT/$name.log" 2>&1 &
    pid=$!; hit=0
    while kill -0 "$pid" 2>/dev/null; do
      c="$(node tools/playtest/runs/spend.mjs "$run" 2>/dev/null || echo 0)"
      if over "$c" "$WORLD_MAX"; then hit=1; note "world at \$$c: SIGINT $name"; kill -INT "$pid"; break; fi
      sleep 3
    done
    wait "$pid"; rc=$?
    node tools/playtest/runs/run.mjs evaluate "$run" > "$OUT/$name.eval.json" 2> "$OUT/$name.eval.err"
    c="$(node tools/playtest/runs/spend.mjs "$run")"; arm=$(node -e 'console.log((Number(process.argv[1])+Number(process.argv[2])).toFixed(4))' "$arm" "$c")
    card="$(ls -d "$run"/evaluations/*/ 2>/dev/null | tail -1)"
    pre="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1]+"scorecard.json","utf8")).scorer?.predeclared)}catch{console.log("none")}' "$card")"
    note "end $name rc=$rc spend=$c arm=$arm dollarHit=$hit predeclared=$pre"
    if [ "$first" = 1 ] && [ "$pre" != true ]; then note "first card isn't predeclared: stopped"; exit 5; fi
    first=0
  done
done
note "arm end, spent \$$arm"
