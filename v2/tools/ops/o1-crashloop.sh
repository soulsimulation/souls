#!/usr/bin/env bash
# O1 A3 and A4 (#2730): world A fails at start 20 times. Its pin names a build that is not on the machine, so each
# start fails `build.missing`. It is retried every time with no gap over 30 s, is never left stopped, is named
# `restart-loop` in the supervisor's health record (with its count and last exit) while it fails, and serves within
# 30 s of the build being put on the machine. Gaps are read from the restart record (exit to the next start). See
# o1-lib.sh for how to run it.
source "$(dirname "$0")/o1-lib.sh"
o1_check
FAILS=${O1_FAILS:-20}
fail=0
printf '| repeat | failed starts | longest gap exit to next start (s) | states seen | health while failing | serves after the fix (s) |\n'
printf '|---|---|---|---|---|---|\n'
for rep in $(seq "$O1_REPEATS"); do
  o1_setup
  A=$(o1_world a)
  rel=$("$SUP" hash "$O1_BIN/release/worldd")
  o1_pin "$A" "$rel"
  log="$O1_ROOT/health/$A.log"
  systemctl start --no-block "worldd@$A"
  until [ -f "$log" ]; do sleep 0.1; done
  states=""
  while [ "$(awk '$2 == "exit" {n++} END {print n + 0}' "$log")" -lt "$FAILS" ]; do
    s=$(o1_prop "$A" ActiveState)/$(o1_prop "$A" SubState)
    case " $states " in *" $s "*) ;; *) states="$states $s" ;; esac
    sleep 1
  done
  health=$(WORLDS_ROOT=$O1_ROOT "$SUP" health "$A")
  fix=$(date +%s%3N)
  o1_add_build "$O1_BIN/release/worldd" > /dev/null
  until grep -q ' ready' "$log"; do
    s=$(o1_prop "$A" ActiveState)/$(o1_prop "$A" SubState)
    case " $states " in *" $s "*) ;; *) states="$states $s" ;; esac
    sleep 0.2
  done
  ready=$(awk '$2 == "ready" {print $1; exit}' "$log")
  serves=$(awk -v a="$fix" -v b="$ready" 'BEGIN {printf "%.1f", (b - a) / 1000}')
  # Each exit followed by a start; the longest wait between them.
  read -r fails gap retried < <(awk '$2 == "exit" {n++; e = $1; pending = 1}
    $2 == "start" && pending {g = ($1 - e) / 1000; if (g > max) max = g; pending = 0; r++}
    END {printf "%d %.1f %d\n", n, max, r}' "$log")
  hstate=$(sed -n 's/.*"state":"\([^"]*\)".*/\1/p' <<< "$health")
  hcount=$(sed -n 's/.*"count":\([0-9]*\).*/\1/p' <<< "$health")
  hexit=$(sed -n 's/.*"last_exit":"\([^"]*\)".*/\1/p' <<< "$health")
  printf '| %s | %s, %s retried | %s | %s | %s, count %s, last exit %s | %s |\n' "$rep" "$fails" "$retried" "$gap" \
    "${states# }" "$hstate" "$hcount" "$hexit" "$serves"
  awk -v g="$gap" -v s="$serves" 'BEGIN {exit !(g <= 30 && s <= 30)}' || fail=1
  [ "$retried" -ge "$fails" ] && [ "$fails" -ge "$FAILS" ] || fail=1
  [ "$hstate" = restart-loop ] && [ -n "$hcount" ] && [[ "$hexit" == build.missing* ]] || fail=1
  case "$states" in *failed* | *inactive*) fail=1 ;; esac
done
o1_cleanup
exit $fail
