#!/usr/bin/env bash
# O1 A2 (#2730): two worlds on one machine run two builds (a release and a debug worldd), each started from the pin in
# its directory record, and each reports that hash: in its journal ("build: <hash>"), in its unit's status
# (STATUS=build <hash>), and by the file its process runs. See o1-lib.sh for how to run it.
source "$(dirname "$0")/o1-lib.sh"
o1_check
fail=0
printf '| repeat | world | pinned build | journal says | unit status says | process runs | match |\n'
printf '|---|---|---|---|---|---|---|\n'
for rep in $(seq "$O1_REPEATS"); do
  o1_setup
  rel=$(o1_add_build "$O1_BIN/release/worldd")
  dbg=$(o1_add_build "$O1_BIN/debug/worldd")
  A=$(o1_world a) B=$(o1_world b)
  o1_pin "$A" "$rel"
  o1_pin "$B" "$dbg"
  t0=$(o1_now)
  systemctl start "worldd@$A" "worldd@$B"
  sleep 2
  for pair in "A $A $rel" "B $B $dbg"; do
    set -- $pair
    said=$(journalctl -q -u "worldd@$2.service" -o cat --since "@$t0" --no-pager | sed -n 's/^build: //p' | tail -1)
    status=$(o1_prop "$2" StatusText | sed -n 's/^build //p')
    runs=$(basename "$(dirname "$(readlink "/proc/$(o1_prop "$2" MainPID)/exe")")")
    ok=no
    [ "$said" = "$3" ] && [ "$status" = "$3" ] && [ "$runs" = "$3" ] && ok=yes
    [ $ok = yes ] || fail=1
    printf '| %s | %s | %s… | %s… | %s… | builds/%s…/worldd | %s |\n' "$rep" "$1" "${3:0:16}" "${said:0:16}" \
      "${status:0:16}" "${runs:0:16}" "$ok"
  done
  [ "$rel" != "$dbg" ] || fail=1
done
o1_cleanup
exit $fail
