#!/usr/bin/env bash
# O1 A1 (#2730): three worlds on one machine; a planted leak takes A past its memory limit. A serves again within 2 s;
# B and C never restart and keep their tick 99th percentile within 10 % of before. See o1-lib.sh for how to run it.
#
# The leak: A runs a "leak build", a worldd that, once armed (state/leak-now), starts a helper in A's cgroup that
# grows anonymous memory without end (`tail /dev/zero`). It leaks once per run (state/leaked), so the restarted A
# serves. "Serves again" is from the unit's first failure line to the next "Started" (systemd logs it on READY=1).
# A tick's gap is the time between two of a world's tick lines in the journal: 50 ms at 20 ticks a second.
source "$(dirname "$0")/o1-lib.sh"
o1_check
HIGH=${O1_LEAK_HIGH:-infinity}
MAX=${O1_LEAK_MAX:-256M}
WINDOW=${O1_WINDOW:-10}
fail=0
printf '| repeat | A limit | A exit | A serves again (s) | B restarts | B p99 before/during (ms) | C restarts | C p99 before/during (ms) |\n'
printf '|---|---|---|---|---|---|---|---|\n'
for rep in $(seq "$O1_REPEATS"); do
  o1_setup
  rel=$(o1_add_build "$O1_BIN/release/worldd")
  cat > "$O1_ROOT/leak-worldd" <<EOF
#!/bin/sh
# O1's leak build: worldd, with a leak in its cgroup once state/leak-now appears.
s=\$2
if [ ! -e "\$s/leaked" ]; then
  ( while [ ! -e "\$s/leak-now" ]; do sleep 0.05; done; touch "\$s/leaked"; exec tail /dev/zero ) &
fi
exec $O1_ROOT/builds/$rel/worldd "\$@"
EOF
  leak=$(o1_add_build "$O1_ROOT/leak-worldd")
  A=$(o1_world a) B=$(o1_world b) C=$(o1_world c)
  o1_pin "$A" "$leak"
  o1_pin "$B" "$rel"
  o1_pin "$C" "$rel"
  o1_limits "$A" "$HIGH" "$MAX"
  systemctl start "worldd@$A" "worldd@$B" "worldd@$C"
  pidB=$(o1_prop "$B" MainPID) pidC=$(o1_prop "$C" MainPID)
  sleep $((WINDOW + 2))
  t0=$(o1_now)
  touch "$O1_ROOT/worlds/$A/leak-now"
  sleep "$WINDOW"
  t1=$(o1_now)
  sleep 1
  fail_at=$(o1_times "$A" "$t0" "$t1" 'OOM killer|Main process exited|Watchdog timeout|Failed with result' | head -1)
  ready_at=""
  [ -n "$fail_at" ] && ready_at=$(o1_times "$A" "$fail_at" "$t1" 'Started ' | head -1)
  serves=$([ -n "$ready_at" ] && awk -v a="$fail_at" -v b="$ready_at" 'BEGIN {printf "%.3f", b - a}' || echo none)
  exitA=$(WORLDS_ROOT=$O1_ROOT "$SUP" health "$A" | sed -n 's/.*"last_exit":"\([^"]*\)".*/\1/p')
  row="| $rep | $HIGH/$MAX | ${exitA:-none} | $serves |"
  t_before=$(awk -v t="$t0" -v w="$WINDOW" 'BEGIN {printf "%.6f", t - w}')
  for w in "$B" "$C"; do
    restarts=$(o1_prop "$w" NRestarts)
    pid0=$([ "$w" = "$B" ] && echo "$pidB" || echo "$pidC")
    [ "$(o1_prop "$w" MainPID)" = "$pid0" ] || restarts="$restarts (new process)"
    before=$(o1_times "$w" "$t_before" "$t0" ': tick [0-9]+ ' | o1_p99_gap)
    during=$(o1_times "$w" "$t0" "$t1" ': tick [0-9]+ ' | o1_p99_gap)
    row="$row $restarts | $before / $during |"
    awk -v b="$before" -v d="$during" 'BEGIN {exit !(d <= b * 1.10)}' || fail=1
    [ "$restarts" = 0 ] || fail=1
  done
  echo "$row"
  awk -v s="$serves" 'BEGIN {exit !(s != "none" && s <= 2)}' || fail=1
done
o1_cleanup
exit $fail
