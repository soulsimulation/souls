# Shared by the runbook's world-*.sh wrappers (Engine v2 O13, #2829; v2/docs/runbook/README.md). Each wrapper takes
# only a world's name, calls the installed tool and prints the exact undo command. SOULS_OPS_DRY=1 prints each
# command instead of running it.
set -euo pipefail
LIB=/usr/local/lib/souls
export WORLDS_ROOT=${WORLDS_ROOT:-/var/lib/souls/worlds}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

usage() { echo "usage: bash v2/tools/ops/$(basename "$0") <world>   ($1)"; }
world_arg() {
  if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then usage "$2"; exit 0; fi
  if [[ ! "${1:-}" =~ ^[0-9a-f]+-[0-9a-f]+-[0-9]+$ ]]; then
    usage "$2" >&2; echo "a world's name is <lineage hex>-<zone scope hex>-<zone counter>; list them: supervisor health" >&2
    exit 2
  fi
  WORLD=$1
}
run() { if [[ "${SOULS_OPS_DRY:-}" == 1 ]]; then echo "would run: $*"; else "$@"; fi; }
undo() { echo "undo: $*"; }
