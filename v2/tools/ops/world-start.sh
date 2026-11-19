#!/usr/bin/env bash
# Start a world's process; it runs its pinned build and catches up the ticks it owes.
. "$(dirname "$0")/world-lib.sh"
world_arg "${1:-}" "start the world's process on its pinned build"
run systemctl start "worldd@$WORLD"
undo "bash v2/tools/ops/world-stop.sh $WORLD"
