#!/usr/bin/env bash
# A planned stop: the world's process ends, its data stays, no alert is sent (a stopped world is healthy).
. "$(dirname "$0")/world-lib.sh"
world_arg "${1:-}" "stop the world's process; its data stays"
run systemctl stop "worldd@$WORLD"
undo "bash v2/tools/ops/world-start.sh $WORLD"
