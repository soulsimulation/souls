#!/usr/bin/env bash
# #4013 A2: a world whose load is held for 90 s starts under the installed worldd@.service, whose TimeoutStartSec
# stays 30 s, because worldd says EXTEND_TIMEOUT_USEC each time it makes progress; a world frozen while it loads (no
# progress) is still ended by that timeout.
#
# Runs as an unprivileged user with a user systemd manager (systemd 236 or later, for EXTEND_TIMEOUT_USEC), on Linux:
# it installs the repo's worldd@.service as a user unit, unchanged, with a drop-in that only says what to run (this
# world folder, no supervisor, no restart). Build first, from v2/:
#   cargo build --release -p worldd --features hold-load && cargo build --release -p testworld
#   X5_BIN=<that cargo target folder> bash tools/ops/x5-start-progress.sh
# Prints one row per case and exits non-zero when a row misses its bar. Nothing it prints names the machine.

set -euo pipefail
: "${X5_BIN:?set X5_BIN to a cargo target folder with release/worldd (--features hold-load) and release/testworld}"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../../.." && pwd)
UNITS=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
[ -e "$UNITS/worldd@.service" ] && { echo "x5: a user worldd@.service is already installed; not touching it" >&2; exit 2; }
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/x5.XXXXXX")
FAIL=0

cleanup() {
  local w
  for w in x5held x5frozen; do
    systemctl --user stop "worldd@$w.service" 2> /dev/null || true
    systemctl --user reset-failed "worldd@$w.service" 2> /dev/null || true
    rm -rf "$UNITS/worldd@$w.service.d"
  done
  rm -rf "$UNITS/worldd@.service" "$ROOT"
  systemctl --user daemon-reload
}
trap cleanup EXIT

# A world folder from N2's test world, as tests/serve.rs seeds one.
"$X5_BIN/release/testworld" --seed 1 --things 0 --out "$ROOT" > /dev/null
"$X5_BIN/release/worldd" seed --facts "$ROOT/testworld-s1-t0.facts.json" --dir "$ROOT/w" \
  --entries "$REPO/content/kinds/doors" --souls 1 --at -40,30 > /dev/null

mkdir -p "$UNITS"
install -m 644 "$HERE/units/worldd@.service" "$UNITS/worldd@.service"

# One world, $1, its load held $2 s: a copy of the seeded folder, run by the unit with only what to run replaced.
world() {
  cp -r "$ROOT/w" "$ROOT/$1"
  mkdir -p "$UNITS/worldd@$1.service.d"
  printf '[Service]\nExecStart=\nExecStart=%s serve --dir %s\nExecStartPost=\nExecStopPost=\nRestart=no\nEnvironment=WORLDD_HOLD_LOAD_S=%s\n' \
    "$X5_BIN/release/worldd" "$ROOT/$1" "$2" > "$UNITS/worldd@$1.service.d/x5.conf"
  systemctl --user daemon-reload
}

prop() { systemctl --user show -p "$2" --value "worldd@$1.service"; }
row() {
  printf '%-34s %-10s %-9s %-8s %s\n' "$1" "$2" "$3" "$4" "$5"
  [ "$5" = pass ] || FAIL=1
}

printf '%-34s %-10s %-9s %-8s %s\n' case seconds state result bar

# 1. Held 90 s with progress: the start waits for READY=1 and the world runs.
world x5held 90
t0=$(date +%s.%N)
systemctl --user start worldd@x5held.service || true
t1=$(date +%s.%N)
s=$(awk -v a="$t0" -v b="$t1" 'BEGIN {printf "%.1f", b - a}')
state=$(prop x5held ActiveState)/$(prop x5held SubState)
result=$(prop x5held Result)
bar=fail
if [ "$state" = active/running ] && awk -v s="$s" 'BEGIN {exit !(s >= 90)}'; then bar=pass; fi
row "held 90 s, progress: starts" "$s" "$state" "$result" "$bar"
echo "unit TimeoutStartSec: $(prop x5held TimeoutStartUSec)"
systemctl --user stop worldd@x5held.service

# 2. The same world frozen 2 s into its load (SIGSTOP: no progress): the start is ended about 30 s after its last notice.
world x5frozen 90
t0=$(date +%s.%N)
systemctl --user start --no-block worldd@x5frozen.service
sleep 2
kill -STOP "$(prop x5frozen MainPID)"
while [ "$(prop x5frozen ActiveState)" = activating ]; do sleep 0.2; done
t1=$(date +%s.%N)
s=$(awk -v a="$t0" -v b="$t1" 'BEGIN {printf "%.1f", b - a}')
state=$(prop x5frozen ActiveState)/$(prop x5frozen SubState)
result=$(prop x5frozen Result)
bar=fail
if [ "$result" = timeout ] && awk -v s="$s" 'BEGIN {exit !(s >= 30 && s < 40)}'; then bar=pass; fi
row "frozen at 2 s, no progress: ended" "$s" "$state" "$result" "$bar"

exit $FAIL
