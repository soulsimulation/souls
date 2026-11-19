#!/usr/bin/env bash
# Deploy the installed worldd to one world (O7): rehearse, canary, roll back by itself on a fault. The build is the
# install's /usr/local/lib/souls/worldd, staged under $WORLDS_ROOT/builds/<its hash>/; the probe is a sync ask that
# needs no body, so no one's Soul is driven (O18c); the build it leaves is the world's pin, kept for world-rollback.sh.
. "$(dirname "$0")/world-lib.sh"
world_arg "${1:-}" "deploy the installed worldd to the world; it rolls back by itself on a fault"
new=$("$LIB/supervisor" hash "$LIB/worldd")
old=$("$LIB/deploy" pinned "$WORLD") || { echo "the world has no pinned build; place and start it first" >&2; exit 2; }
if [[ "$new" == "$old" ]]; then echo "the world already runs $new: nothing to deploy"; exit 0; fi
run install -d "$WORLDS_ROOT/builds/$new"
run install -m 755 "$LIB/worldd" "$WORLDS_ROOT/builds/$new/worldd"
run mkdir -p "$WORLDS_ROOT/deploys"
[[ "${SOULS_OPS_DRY:-}" == 1 ]] || echo "$old $new" > "$WORLDS_ROOT/deploys/$WORLD"
undo "bash v2/tools/ops/world-rollback.sh $WORLD   (from $new back to $old)"
run "$LIB/deploy" "$WORLD" "$new"
