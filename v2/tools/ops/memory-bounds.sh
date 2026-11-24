#!/usr/bin/env bash
# Memory bounds per world (24 Nov incident: one souls.slice cap of 3 GB, a fourth world started, and the slice's OOM
# killer ended Eden). Puts the repo's souls.slice (MemoryMax 18G, MemoryLow 2G) and each listed world's limits.conf
# (world-limits.json through world-limits.mjs: Eden MemoryMax 4G, MemoryLow 2G) on this machine and applies them live.
# It restarts and stops nothing: daemon-reload, then `systemctl set-property --runtime` on the slice and the listed
# worlds. Every other world keeps worldd@'s MemoryMax=2G. MemoryHigh stays infinity (below MemoryMax with no swap it
# holds a leaking world slow instead of restarting it: v2/docs/runbook/world-restarting.md). It touches only
# souls.slice, worldd@ drop-ins and their set-property files. Run from a repo checkout on the machine, as root:
#
#   bash memory-bounds.sh plan           prints what apply would change, changes nothing
#   bash memory-bounds.sh apply          backs up, installs, daemon-reload, applies live; prints the backup and undo
#   bash memory-bounds.sh check          reads the effective values back (systemd and the cgroup files); exit 1 if off
#   bash memory-bounds.sh undo <backup>  puts the backed-up files back, drops the live values, daemon-reload
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
UNITS=/etc/systemd/system
CONTROL=/etc/systemd/system.control/souls.slice.d
RUNCTL=/run/systemd/system.control
CONFIG=$HERE/units/world-limits.json
BACKUPS=/etc/souls/backup
CG=/sys/fs/cgroup/souls.slice
die() {
  echo "memory-bounds: $*" >&2
  exit 2
}
# The slice's wanted values, from the repo's unit file.
want() { sed -n "s/^$1=//p" "$HERE/units/souls.slice"; }
SLICE_PROPS=("MemoryMax=$(want MemoryMax)" "MemoryLow=$(want MemoryLow)")
# One line per listed world placed here: `worldd@<instance>.service MemoryMax=4G MemoryLow=2G`.
worlds() { node "$HERE/world-limits.mjs" props --config "$CONFIG"; }
bytes() { numfmt --from=iec "$1"; }
# Refuses a live MemoryMax under 1.25 x what the unit uses now: it would end the world on the spot.
fits() {
  local cur
  cur=$(systemctl show "$1" -p MemoryCurrent --value)
  [[ $cur =~ ^[0-9]+$ ]] || return 0 # not running
  ((cur * 5 / 4 < $(bytes "$2"))) || die "$1 uses $cur bytes now; MemoryMax=$2 would end it"
}

case ${1:-plan} in
  plan)
    diff -q "$HERE/units/souls.slice" "$UNITS/souls.slice" > /dev/null 2>&1 || echo "would install $UNITS/souls.slice"
    for f in "$CONTROL"/*.conf; do [ ! -e "$f" ] || echo "would move aside $f (a set-property file; it overrides the unit file)"; done
    node "$HERE/world-limits.mjs" plan --config "$CONFIG" | sed 's/^/would /'
    echo "would systemctl daemon-reload"
    echo "would set live: souls.slice ${SLICE_PROPS[*]}"
    worlds | sed 's/^/would set live: /'
    ;;
  apply)
    [ "$(id -u)" = 0 ] || die "apply runs as root"
    command -v node > /dev/null || die "needs node"
    fits souls.slice "$(want MemoryMax)"
    while read -r unit props; do
      for p in $props; do case $p in MemoryMax=*) fits "$unit" "${p#MemoryMax=}" ;; esac; done
    done < <(worlds)
    B=$BACKUPS/memory-bounds-$(date -u +%Y%m%dT%H%M%SZ)
    install -d -m 700 "$B"
    # The backup: every file this replaces or moves aside, at its own path under $B, and the list of files it adds.
    cp -a --parents "$UNITS/souls.slice" "$B/"
    [ ! -d "$CONTROL" ] || cp -a --parents "$CONTROL" "$B/"
    for d in "$UNITS"/worldd@*.service.d; do [ ! -e "$d/limits.conf" ] || cp -a --parents "$d/limits.conf" "$B/"; done
    node "$HERE/world-limits.mjs" plan --config "$CONFIG" | awk '$1 == "file" && !seen[$2]++ { print $2 }' |
      while read -r f; do [ -e "$f" ] || echo "$f"; done > "$B/added"
    install -m 644 "$HERE/units/souls.slice" "$UNITS/souls.slice"
    rm -f "$CONTROL"/*.conf
    node "$HERE/world-limits.mjs" apply --config "$CONFIG"
    systemctl daemon-reload
    systemctl set-property --runtime souls.slice "${SLICE_PROPS[@]}"
    echo "live: souls.slice ${SLICE_PROPS[*]}"
    while read -r unit props; do
      # shellcheck disable=SC2086 # props is Key=Value words
      systemctl set-property --runtime "$unit" $props
      echo "live: $unit $props"
    done < <(worlds)
    echo "backup: $B"
    echo "undo:   bash $HERE/memory-bounds.sh undo $B"
    ;;
  check)
    bad=0
    # A unit, its cgroup folder, then the wanted Key=Value pairs: systemd's value and the kernel's must both match.
    row() {
      local unit=$1 dir=$2 kv k v got cg s
      shift 2
      for kv in "$@"; do
        k=${kv%%=*} v=$(bytes "${kv#*=}")
        got=$(systemctl show "$unit" -p "$k" --value)
        case $k in
          MemoryMax) cg=$(cat "$dir/memory.max" 2> /dev/null || echo -) ;;
          MemoryLow) cg=$(cat "$dir/memory.low" 2> /dev/null || echo -) ;;
        esac
        if [ "$got" = "$v" ] && { [ "$cg" = "$v" ] || [ "$cg" = - ]; }; then s=ok; else s=OFF bad=1; fi
        printf '%-4s %s %s systemd=%s cgroup=%s want=%s\n' "$s" "$unit" "$k" "$got" "$cg" "$v"
      done
    }
    row souls.slice "$CG" "${SLICE_PROPS[@]}"
    listed=" "
    while read -r unit props; do
      listed+="$unit "
      # shellcheck disable=SC2086
      row "$unit" "$CG/$unit" $props
    done < <(worlds)
    # Every other running world: the unit's own 2G (cgroup "-" means not running).
    for unit in $(systemctl list-units --no-legend --plain 'worldd@*' | awk '{ print $1 }'); do
      [[ $listed == *" $unit "* ]] || row "$unit" "$CG/$unit" MemoryMax=2G
    done
    for f in "$CONTROL"/*.conf; do [ ! -e "$f" ] || { echo "OFF  $f overrides the unit file" && bad=1; }; done
    exit $bad
    ;;
  undo)
    [ "$(id -u)" = 0 ] || die "undo runs as root"
    B=${2:?undo <backup folder>}
    [ -f "$B$UNITS/souls.slice" ] && [ -f "$B/added" ] || die "$B is not a memory-bounds backup"
    while read -r f; do rm -f "$f"; done < "$B/added"
    cp -a "$B/etc/." /etc/
    rm -f "$RUNCTL"/souls.slice.d/50-Memory*.conf "$RUNCTL"/worldd@*.service.d/50-Memory*.conf
    systemctl daemon-reload
    echo "restored from $B; daemon-reload applies the restored values to running units, and nothing restarted"
    ;;
  *) die "plan | apply | check | undo <backup>" ;;
esac
