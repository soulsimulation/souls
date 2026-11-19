#!/usr/bin/env bash
# A world's health record (O1): state, starts in five minutes, failures, last exit, next try.
. "$(dirname "$0")/world-lib.sh"
world_arg "${1:-}" "print the world's health record; changes nothing"
run "$LIB/supervisor" health "$WORLD"
undo "nothing to undo: this only reads"
