#!/usr/bin/env bash
# O2's runs (Engine v2 O2, #2731): 100 worlds asleep, woken by their alarms. Each world is the stand-in world
# (`examples/sleeper.rs`) installed as a build and pinned, so the real unit (worldd@.service), launcher and alarm
# daemon (souls-alarms.service) run it. Run as root on a disposable Linux machine, as the O1 runs
# (v2/tools/ops/o1-lib.sh): O1_BIN=<cargo target folder with release/supervisor and release/examples/sleeper>.
#
#   sleep-and-wake.sh quiet    A1 + A2 spread: all asleep 10 minutes (no world process, the daemon's processor time),
#                              then 100 alarms 1 s apart; each due change's lag
#   sleep-and-wake.sh burst    A2: 100 due in one second
#   sleep-and-wake.sh kill     A3: as burst, the daemon killed (SIGKILL) mid-sleep
#   sleep-and-wake.sh intent   A4, the world's half: 10 asleep with nothing due, each asked to wake, until it serves
#   sleep-and-wake.sh arm      A3 reboot, first half: 100 asleep, due 180 s on; then reboot the machine
#   sleep-and-wake.sh check    A3 reboot, second half: waits for the due times and reports
#
# Prints one row per run; exits non-zero when a row misses its bar. Nothing it prints names the machine.
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../../tools/ops/o1-lib.sh"
o1_check
SLEEPER=$O1_BIN/release/examples/sleeper
N=${O2_WORLDS:-100}
QUIET=${O2_QUIET:-600}
STATE=/var/tmp/souls-o2-run

now_us() { echo $(( $(date +%s%N) / 1000 )); }
name() { printf '%032x-%s1-0' "$1" "$(printf '0%.0s' $(seq 31))"; }
asleep() { grep -c . "$O1_ROOT/directory/alarms/local" 2> /dev/null || echo 0; }

# Installs everything, gives world k the due time $1 + k * $2 µs, starts all and waits until all are asleep.
arm() {
  systemctl stop souls-alarms.service 2> /dev/null || true
  o1_setup
  install -m 644 "$O1_HERE/units/souls-alarms.service" "$UNITS/souls-alarms.service"
  mkdir -p "$UNITS/souls-alarms.service.d"
  printf '[Service]\nEnvironment=WORLDS_ROOT=%s\n' "$O1_ROOT" > "$UNITS/souls-alarms.service.d/o2-run.conf"
  systemctl daemon-reload
  systemctl enable souls-alarms.service 2> /dev/null
  systemctl restart souls-alarms.service
  h=$(o1_add_build "$SLEEPER")
  for k in $(seq 0 $((N - 1))); do
    w=$(name "$k")
    o1_pin "$w" "$h"
    mkdir -p "$O1_ROOT/worlds/$w"
    echo $(( $1 + k * $2 )) > "$O1_ROOT/worlds/$w/due"
    systemctl start --no-block "worldd@$w"
  done
  until [ "$(asleep)" -ge "$N" ]; do sleep 0.2; done
  until [ -z "$(pgrep -f "$O1_ROOT/builds")" ]; do sleep 0.2; done
  mkdir -p "$STATE" && echo "$1 $2" > "$STATE/armed"
}

# Waits until every world committed its due change, then prints: commits, the longest lag, how many within 1 s.
report() {
  local label=$1 limit=$(( $(cut -d' ' -f1 "$STATE/armed") + N * $(cut -d' ' -f2 "$STATE/armed") + 60000000 ))
  while [ "$(cat "$O1_ROOT"/worlds/*/commits 2> /dev/null | grep -c .)" -lt "$N" ] && [ "$(now_us)" -lt "$limit" ]; do
    sleep 1
  done
  cat "$O1_ROOT"/worlds/*/commits | awk -v label="$label" -v n="$N" '
    {lag = ($2 - $1) / 1e6; if (lag > max) max = lag; if (lag <= 1) ok++; c++}
    END {printf "| %s | %d of %d | %.3f | %d |\n", label, c, n, max, ok; exit !(c == n && ok == n)}'
}

case "${1:-}" in
  quiet)
    for rep in $(seq "$O1_REPEATS"); do
      arm $(( $(now_us) + (QUIET + 60) * 1000000 )) 1000000
      pid=$(systemctl show -p MainPID --value souls-alarms)
      t0=$(awk '{print $14 + $15}' "/proc/$pid/stat")
      starts0=$(cat "$O1_ROOT"/health/*.log | grep -c ' start')
      seen=0
      for _ in $(seq $((QUIET / 10))); do
        sleep 10
        seen=$(( seen + $(pgrep -fc "$O1_ROOT/builds" || true) ))
      done
      t1=$(awk '{print $14 + $15}' "/proc/$pid/stat")
      starts1=$(cat "$O1_ROOT"/health/*.log | grep -c ' start')
      cpu=$(awk -v d=$((t1 - t0)) -v hz="$(getconf CLK_TCK)" -v s="$QUIET" 'BEGIN {printf "%.4f", 100 * d / hz / s}')
      printf '| quiet %d | %d s | world processes seen %d, starts %d | daemon %s %% of a core |\n' \
        "$rep" "$QUIET" "$seen" $((starts1 - starts0)) "$cpu"
      awk -v c="$cpu" -v s="$seen" -v d=$((starts1 - starts0)) 'BEGIN {exit !(c < 0.5 && s == 0 && d == 0)}' || exit 1
      report "spread $rep" || exit 1
    done
    ;;
  burst | kill)
    for rep in $(seq "$O1_REPEATS"); do
      arm $(( $(now_us) + 90000000 )) 10000
      if [ "$1" = kill ]; then
        sleep 20
        systemctl kill -s KILL souls-alarms.service
        sleep 1
        echo "daemon killed; restarted: $(systemctl is-active souls-alarms.service)"
      fi
      report "$1 $rep" || exit 1
    done
    ;;
  intent)
    # A4's world half: the gateway's `wake <world>` to a world asleep with nothing due, until it serves (its
    # ExecStartPost `ready` line in the restart record). The gateway's half is its test
    # (o2_an_intent_wakes_a_sleeping_world_and_a_reader_does_not).
    for rep in $(seq "$O1_REPEATS"); do
      arm $(( $(now_us) + 62000000 )) 10000
      report "woken by alarm $rep" > /dev/null
      until [ -z "$(pgrep -f "$O1_ROOT/builds")" ]; do sleep 0.2; done
      worst=0
      for k in $(seq 0 9); do
        w=$(name "$k")
        before=$(grep -c ' ready' "$O1_ROOT/health/$w.log")
        t0=$(( $(now_us) / 1000 ))
        WORLDS_ROOT=$O1_ROOT "$SUP" wake "$w"
        until [ "$(grep -c ' ready' "$O1_ROOT/health/$w.log")" -gt "$before" ]; do sleep 0.01; done
        t1=$(grep ' ready' "$O1_ROOT/health/$w.log" | tail -1 | cut -d' ' -f1)
        [ $((t1 - t0)) -gt "$worst" ] && worst=$((t1 - t0))
      done
      printf '| intent %d | 10 worlds asleep, woken by wake | longest to serving %d ms |\n' "$rep" "$worst"
      [ "$worst" -lt 3000 ] || exit 1
    done
    ;;
  arm)
    arm $(( $(now_us) + 180000000 )) 10000
    echo "armed: 100 asleep, due 180 s on; reboot the machine now, then run: $0 check"
    ;;
  check)
    report "after reboot"
    ;;
  *)
    echo "usage: $0 quiet|burst|kill|intent|arm|check" >&2
    exit 2
    ;;
esac
