#!/usr/bin/env bash
# Restart every world's gateway on this machine onto the install's gatewayd (/usr/local/lib/souls/gatewayd), one at a
# time (O16): agents reconnect and lose nothing. Refused, gateway-upgrade.world-deploying, while a world deploys.
# Runbook: v2/docs/runbook/gateway-upgrade.md.
. "$(dirname "$0")/world-lib.sh"
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  echo "usage: bash v2/tools/ops/gateway-upgrade.sh   (restart every world's gateway onto the installed gatewayd)"
  exit 0
fi
worlds=()
for d in "$WORLDS_ROOT"/worlds/*/; do [[ -d $d ]] && worlds+=("$(basename "$d")"); done
((${#worlds[@]})) || { echo "no world on this machine under $WORLDS_ROOT/worlds" >&2; exit 2; }
undo "put the old bundle back with install.sh apply, then bash v2/tools/ops/gateway-upgrade.sh again"
run "$LIB/gateway-upgrade" "$LIB/gatewayd" "${worlds[@]}" --lib "$LIB"
