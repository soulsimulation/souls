#!/usr/bin/env bash
# Deploy the installed worldd to one world (O7): rehearse, canary, roll back by itself on a fault. The build is the
# install's /usr/local/lib/souls/worldd, staged under $WORLDS_ROOT/builds/<its hash>/; the probe is the install's
# /etc/souls/probe.intent; the build it leaves is read from the running process, and kept for world-rollback.sh.
. "$(dirname "$0")/world-lib.sh"
world_arg "${1:-}" "deploy the installed worldd to the world; it rolls back by itself on a fault"
PROBE=/etc/souls/probe.intent
new=$("$LIB/supervisor" hash "$LIB/worldd")
pid=$(systemctl show -p MainPID --value "worldd@$WORLD")
old=$(basename "$(dirname "$(readlink "/proc/$pid/exe" 2>/dev/null || echo none/none)")")
if [[ ! "$old" =~ ^[0-9a-f]+$ ]]; then echo "the world is not running a staged build; start it first" >&2; exit 2; fi
if [[ "$new" == "$old" ]]; then echo "the world already runs $new: nothing to deploy"; exit 0; fi
[[ -r $PROBE ]] || { echo "no probe at $PROBE: the install has none yet" >&2; exit 2; }
run install -D -m 755 "$LIB/worldd" "$WORLDS_ROOT/builds/$new/worldd"
run mkdir -p "$WORLDS_ROOT/deploys"
[[ "${SOULS_OPS_DRY:-}" == 1 ]] || echo "$old $new" > "$WORLDS_ROOT/deploys/$WORLD"
undo "bash v2/tools/ops/world-rollback.sh $WORLD   (from $new back to $old)"
run "$LIB/deploy" "$WORLD" "$new" --probe "$PROBE"
