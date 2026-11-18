# Shared by the three O1 runs (Engine v2 O1, #2730): o1-leak.sh, o1-builds.sh, o1-crashloop.sh.
#
# Run them as root on a disposable Linux machine with cgroup v2 and systemd 254 or later (RestartSteps), never on one
# that runs worlds: they install worldd@.service and the supervisor, and stop every worldd@ unit when they end.
#   O1_BIN=<cargo target folder holding release/worldd, release/supervisor and debug/worldd> bash v2/tools/ops/o1-leak.sh
# Each prints one row per repeat and exits non-zero when a row misses its bar. Nothing they print names the machine.

set -euo pipefail
: "${O1_BIN:?set O1_BIN to a cargo target folder with release/worldd, release/supervisor and debug/worldd}"
O1_ROOT=${O1_ROOT:-/var/tmp/souls-o1}
O1_REPEATS=${O1_REPEATS:-2}
O1_HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SUP=/usr/local/lib/souls/supervisor
UNITS=/etc/systemd/system

o1_check() {
  [ "$(id -u)" = 0 ] || { echo "o1: run as root" >&2; exit 2; }
  [ "$(stat -fc %T /sys/fs/cgroup)" = cgroup2fs ] || { echo "o1: needs cgroup v2" >&2; exit 2; }
  local v
  v=$(systemctl --version | awk 'NR==1 {print $2}')
  [ "$v" -ge 254 ] || { echo "o1: needs systemd 254 or later (RestartSteps), found $v" >&2; exit 2; }
}

# Stops every world, removes what a run installed, and starts from an empty folder with the unit installed.
o1_setup() {
  o1_cleanup
  mkdir -p "$O1_ROOT" /usr/local/lib/souls "$UNITS/worldd@.service.d"
  install -m 755 "$O1_BIN/release/supervisor" "$SUP"
  install -m 644 "$O1_HERE/units/worldd@.service" "$UNITS/worldd@.service"
  printf '[Service]\nEnvironment=WORLDS_ROOT=%s\n' "$O1_ROOT" > "$UNITS/worldd@.service.d/o1-run.conf"
  systemctl daemon-reload
}

o1_cleanup() {
  systemctl stop 'worldd@*' 2>/dev/null || true
  systemctl reset-failed 'worldd@*' 2>/dev/null || true
  rm -rf "$UNITS"/worldd@*.service.d "$UNITS/worldd@.service" "$O1_ROOT"
  systemctl daemon-reload
}

# A world's name from one hex letter: <lineage>-<zone scope>-0.
o1_world() {
  printf '%s-%s-0' "$(printf "$1%.0s" $(seq 32))" "$(printf '0%.0s' $(seq 31))1"
}

# Puts a worldd file on the machine as a build; prints its hash.
o1_add_build() {
  local h
  h=$("$SUP" hash "$1")
  mkdir -p "$O1_ROOT/builds/$h"
  install -m 755 "$1" "$O1_ROOT/builds/$h/worldd"
  echo "$h"
}

o1_pin() { WORLDS_ROOT=$O1_ROOT "$SUP" pin "$1" "$2"; }

# Per-world limits, in the world's own drop-in.
o1_limits() {
  mkdir -p "$UNITS/worldd@$1.service.d"
  printf '[Service]\nMemoryHigh=%s\nMemoryMax=%s\n' "$2" "$3" > "$UNITS/worldd@$1.service.d/limits.conf"
  systemctl daemon-reload
}

o1_now() { date +%s.%N; }

# Times (Unix seconds) of a unit's journal lines matching an extended regex, from $2 to $3. Only times are printed.
o1_times() {
  journalctl -q -u "worldd@$1.service" -o short-unix --since "@$2" --until "@$3" --no-pager |
    awk -v re="$4" '$0 ~ re {print $1}'
}

# The 99th percentile of the gaps between consecutive times on stdin, in ms.
o1_p99_gap() {
  awk 'NR > 1 {print ($1 - prev) * 1000} {prev = $1}' | sort -n |
    awk '{v[NR] = $1} END {if (NR == 0) {print "nan"; exit} k = int(NR * 0.99); if (k < 1) k = 1; printf "%.1f\n", v[k]}'
}

o1_prop() { systemctl show -p "$2" --value "worldd@$1.service"; }
