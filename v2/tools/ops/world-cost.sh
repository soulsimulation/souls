#!/usr/bin/env bash
# What a world costs today so far (O11): its row, the machine's unused share and the machine.
. "$(dirname "$0")/world-lib.sh"
world_arg "${1:-}" "print the world's cost today so far; changes nothing"
if [[ "${SOULS_OPS_DRY:-}" == 1 ]]; then run node "$HERE/cost/cost.mjs" page "$WORLDS_ROOT"; else
  node "$HERE/cost/cost.mjs" page "$WORLDS_ROOT" | grep -E "^($WORLD|unused|machine|check)[[:space:]]" || true
fi
undo "nothing to undo: this only reads (it rewrites $WORLDS_ROOT/health/cost.html)"
