#!/usr/bin/env bash
# Take a world back to the build its last world-deploy.sh left (O7). Code rolls back, data never: refused
# rollback.schema-unread when the old build cannot read what the new one wrote.
. "$(dirname "$0")/world-lib.sh"
world_arg "${1:-}" "roll the world back to the build its last deploy left"
rec="$WORLDS_ROOT/deploys/$WORLD"
[[ -r $rec ]] || { echo "no deploy recorded for $WORLD in $rec: nothing to roll back" >&2; exit 2; }
read -r old new < "$rec"
undo "bash v2/tools/ops/world-deploy.sh $WORLD   (from $old to $new again)"
run "$LIB/deploy" rollback "$WORLD" "$old" --from "$new" --probe /etc/souls/probe.intent
