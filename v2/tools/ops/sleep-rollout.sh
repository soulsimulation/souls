#!/usr/bin/env bash
# Turn sleep and wake (O2, #2731; 0.133 done-when #4) on for one world at a time, and off again.
#
# WHAT THIS DOES, in plain words. A world with sleep on leaves the machine after a quiet minute with nothing due, and is
# started again before its next due change or as soon as an intent comes for it; on waking it catches up to now
# exactly (world time never stops). Three things make that so, and production has none of them yet:
#   - the machine's alarm daemon, souls-alarms.service (installed and started by install.sh apply, once per machine);
#   - SOULS_SLEEP=1 in the world's unit, so `supervisor launch` runs worldd serve with --sleep (a drop-in,
#     worldd@<world>.service.d/60-sleep.conf, for that world alone);
#   - its gateway started with --wake <alarm socket> --world-name <world>, so an intent for it while it sleeps is held
#     and the daemon asked to wake it (worlds placed before 0.133 lack it; place-world.sh adds it to new ones).
# `apply <world>` checks the daemon is healthy (installing it first with --from <bundle> when it is not installed),
# backs up the world's gateway settings under /etc/souls/sleep-rollout/<world>/<time>/, writes the drop-in, adds
# --wake, then restarts the gateway and then the world and checks both stay up. A step that fails is undone at once.
# `undo <world>` puts the backed-up settings back, removes the drop-in and restarts the gateway and the world: the
# world is always on again (a sleeping one is started). The alarm daemon stays installed (other worlds may sleep; with
# none asleep it only waits), and an alarm it holds for a world that is up is harmless: its wake finds it running.
#
#   bash sleep-rollout.sh plan [<world>]                 every placed world's state, and what apply would change
#   bash sleep-rollout.sh apply <world> [--from <bundle>] as root: sleep on for that world; refuses, changing nothing,
#                                                        when the alarm daemon is not healthy
#   bash sleep-rollout.sh check                          the alarm daemon and every world: exit 1 when a world with
#                                                        sleep on is half set, down and not asleep, or has no daemon
#   bash sleep-rollout.sh undo <world>                   as root: the last apply for that world backwards
#
# <world> is the placed instance (<lineage>-<zone>-<n>) or its slug in the authority map
# (/etc/souls/placement-data/authority.json). Runbook: v2/docs/runbook/sleep-and-wake.md. ROLLOUT_* stand in for the
# host's folders, systemd and the install in the local run (v2/tools/ops/tests/sleep-rollout-e2e.sh).
set -euo pipefail

ETC=${ROLLOUT_ETC:-/etc/souls}
DATA=${ROLLOUT_DATA:-/var/lib/souls}
UNITS=${ROLLOUT_UNITS:-/etc/systemd/system}
SYSTEMCTL=${ROLLOUT_SYSTEMCTL:-systemctl}
START_S=${ROLLOUT_START_S:-90}
STEADY_S=${ROLLOUT_STEADY_S:-10}
SOCK=$DATA/worlds/alarms.sock
WORLDS=$DATA/worlds/worlds
STATE=$ETC/sleep-rollout
AUTHORITY=$ETC/placement-data/authority.json
ALARMS=souls-alarms.service
DROPIN=60-sleep.conf
INSTANCE='^[0-9a-f]{32}-[0-9a-f]{32}-[0-9]+$'

die() {
  echo "sleep-rollout: $*" >&2
  exit 2
}
say() { echo "sleep-rollout: $*"; }

as_root() { [ -n "${ROLLOUT_ETC:-}" ] || [ "$(id -u)" = 0 ] || die "$1 runs as root on the host"; }

# The instance a name means: an instance as it is, or a slug through the authority map.
resolve() {
  local w=$1 i
  if [[ "$w" =~ $INSTANCE ]]; then echo "$w"; return 0; fi
  [ -r "$AUTHORITY" ] || die "$w is not a world instance and there is no $AUTHORITY to look its slug up in"
  i=$(node -e 'const a = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const w = (a.worlds ?? {})[process.argv[2]];
    process.stdout.write(typeof w === "string" ? w : (w?.instance ?? ""))' "$AUTHORITY" "$w" 2> /dev/null || true)
  [[ "$i" =~ $INSTANCE ]] || die "no placed world named $w in $AUTHORITY"
  echo "$i"
}

envfile() { echo "$ETC/gateway-$1.env"; }
dropin() { echo "$UNITS/worldd@$1.service.d/$DROPIN"; }
placed() {
  local w
  for w in $(ls "$WORLDS" 2> /dev/null | sort); do
    [[ "$w" =~ $INSTANCE ]] && [ -f "$(envfile "$w")" ] && echo "$w"
  done
  return 0
}
has_wake() { grep -q -- '--wake ' "$(envfile "$1")"; }
has_dropin() { [ -f "$(dropin "$1")" ]; }
# sleep, always-on, or half (one of the two set): what this machine runs the world with.
mode() {
  if has_dropin "$1" && has_wake "$1"; then echo sleep
  elif has_dropin "$1"; then echo "half (SOULS_SLEEP=1 but its gateway has no --wake: an intent cannot wake it)"
  else echo always-on; fi
}
# awake, asleep (exited 75 with its alarm set) or down.
state() {
  local u=worldd@$1.service s
  if $SYSTEMCTL is-active --quiet "$u"; then echo awake; return 0; fi
  s=$($SYSTEMCTL show -p ExecMainStatus --value "$u" 2> /dev/null || true)
  if [ "$s" = 75 ]; then echo asleep; else echo "down (last exit ${s:-unknown})"; fi
}

# The daemon is healthy when its unit is installed and active, has not restarted over two seconds, and its socket is
# there, group-writable (a world and a gateway, both the user souls, reach it) and answers.
alarms_problem() {
  local n1 n2 mode reply
  [ -f "$UNITS/$ALARMS" ] || { echo "not installed"; return 0; }
  $SYSTEMCTL is-active --quiet "$ALARMS" || { echo "not active"; return 0; }
  n1=$($SYSTEMCTL show -p NRestarts --value "$ALARMS" 2> /dev/null || true)
  sleep 2
  n2=$($SYSTEMCTL show -p NRestarts --value "$ALARMS" 2> /dev/null || true)
  [ "$n1" = "$n2" ] && $SYSTEMCTL is-active --quiet "$ALARMS" || { echo "restarting (NRestarts $n1 then $n2)"; return 0; }
  [ -S "$SOCK" ] || { echo "no socket at $SOCK"; return 0; }
  mode=$(stat -c %a "$SOCK" 2> /dev/null || stat -f %Lp "$SOCK")
  [ $((8#$mode & 8#020)) -ne 0 ] || { echo "its socket is mode $mode, not group-writable"; return 0; }
  # Any line it does not read is answered `no unread ...` and changes nothing: an answer is a daemon listening.
  reply=$(python3 -c 'import socket, sys
s = socket.socket(socket.AF_UNIX); s.settimeout(3); s.connect(sys.argv[1]); s.sendall(b"probe\n")
print(s.recv(200).decode().strip())' "$SOCK" 2> /dev/null || true)
  case $reply in "no unread"*) ;; *) echo "its socket does not answer"; return 0 ;; esac
  return 0
}

# Up within START_S and then for STEADY_S seconds on end.
healthy() {
  local u=$1 t=0 steady=0
  while [ $t -lt $((START_S + STEADY_S)) ]; do
    if $SYSTEMCTL is-active --quiet "$u"; then steady=$((steady + 1)); else
      steady=0
      [ $t -lt "$START_S" ] || return 1
    fi
    [ $steady -lt "$STEADY_S" ] || return 0
    sleep 1
    t=$((t + 1))
  done
  return 1
}

restart_both() {
  local w=$1
  $SYSTEMCTL daemon-reload
  $SYSTEMCTL restart "souls-gateway@$w.service" && healthy "souls-gateway@$w.service" || { say "souls-gateway@$w did not stay up"; return 1; }
  $SYSTEMCTL restart "worldd@$w.service" && healthy "worldd@$w.service" || { say "worldd@$w did not stay up"; return 1; }
}

backup_of() { ls -d "$STATE/$1"/[0-9]* 2> /dev/null | grep -v '\.undone$' | sort | tail -1; }

put_back() {
  local w=$1 b=$2
  cp -p "$b/gateway.env" "$(envfile "$w")"
  rm -f "$(dropin "$w")"
  rmdir "$(dirname "$(dropin "$w")")" 2> /dev/null || true
  if [ -f "$b/dropin" ]; then mkdir -p "$(dirname "$(dropin "$w")")" && cp -p "$b/dropin" "$(dropin "$w")"; fi
}

cmd_plan() {
  local only=${1:-} w p
  p=$(alarms_problem)
  say "alarm daemon: ${p:-healthy}"
  [ -n "$only" ] && only=$(resolve "$only")
  for w in $(placed); do
    [ -z "$only" ] || [ "$w" = "$only" ] || continue
    say "world $w: $(mode "$w"), $(state "$w")"
  done
  [ -n "$only" ] || return 0
  [ -f "$(envfile "$only")" ] || die "$only is not placed on this machine"
  if [ "$(mode "$only")" = sleep ]; then say "apply $only would change nothing: sleep is on"; return 0; fi
  [ "$p" != "not installed" ] || say "apply would install the alarm daemon (install.sh apply --from <bundle>) and start it"
  say "apply would back up $(envfile "$only") under $STATE/$only/<time>/"
  has_dropin "$only" || say "apply would write $(dropin "$only") (SOULS_SLEEP=1)"
  has_wake "$only" || say "apply would add --wake $SOCK --world-name $only to its GATEWAYD_ARGS"
  say "apply would restart souls-gateway@$only, then worldd@$only (it resumes from its checkpoint and catches up)"
}

cmd_apply() {
  local w=$1 from=${2:-} p b e
  as_root apply
  [ -f "$(envfile "$w")" ] && [ -d "$WORLDS/$w" ] || die "$w is not placed on this machine"
  grep -q '^GATEWAYD_ARGS=' "$(envfile "$w")" || die "$(envfile "$w") has no GATEWAYD_ARGS line"
  if [ ! -f "$UNITS/$ALARMS" ]; then
    if [ -n "${ROLLOUT_INSTALL:-}" ]; then $ROLLOUT_INSTALL
    elif [ -n "$from" ]; then bash "$from/install.sh" apply --from "$from"
    else die "the alarm daemon is not installed: pass --from <the release's bundle> (install.sh apply), or run the install first; nothing changed"; fi
    for _ in $(seq 10); do [ -S "$SOCK" ] && break; sleep 1; done
  fi
  p=$(alarms_problem)
  [ -z "$p" ] || die "the alarm daemon is not healthy ($p): refusing, nothing changed for $w"
  if [ "$(mode "$w")" = sleep ]; then say "world $w: sleep is already on; nothing changed"; return 0; fi
  b=$STATE/$w/$(date -u +%Y%m%dT%H%M%SZ)
  mkdir -p "$b"
  chmod 700 "$STATE"
  cp -p "$(envfile "$w")" "$b/gateway.env"
  if has_dropin "$w"; then cp -p "$(dropin "$w")" "$b/dropin"; fi
  say "world $w: settings backed up in $b"
  mkdir -p "$(dirname "$(dropin "$w")")"
  printf '# Written by sleep-rollout.sh (O2, #2731): the world sleeps when quiet. Undo: sleep-rollout.sh undo %s\n[Service]\nEnvironment=SOULS_SLEEP=1\n' "$w" > "$(dropin "$w")"
  chmod 644 "$(dropin "$w")"
  if ! has_wake "$w"; then
    e=$(envfile "$w")
    cp -p "$e" "$e.rollout"
    sed "s|^GATEWAYD_ARGS=.*|& --wake $SOCK --world-name $w|" "$e" > "$e.rollout"
    mv "$e.rollout" "$e"
  fi
  say "world $w: SOULS_SLEEP=1 and --wake set; restarting its gateway, then the world"
  if ! restart_both "$w"; then
    say "world $w: putting its settings back"
    put_back "$w" "$b"
    mv "$b" "$b.undone"
    restart_both "$w" && die "world $w: apply failed and was undone; the world is always on" \
      || die "world $w: apply failed and its settings are back, but it is NOT up: see 'supervisor health $w'"
  fi
  say "world $w: sleep on; it sleeps after a quiet minute with nothing due (bash sleep-rollout.sh check)"
}

cmd_undo() {
  local w=$1 b
  as_root undo
  b=$(backup_of "$w")
  [ -n "$b" ] || die "no backup for $w under $STATE/$w: nothing to undo"
  put_back "$w" "$b"
  say "world $w: settings from $b put back; restarting its gateway, then the world"
  restart_both "$w" || die "world $w: settings are back, but it is NOT up: see 'supervisor health $w'"
  mv "$b" "$b.undone"
  say "world $w: always on again"
}

cmd_check() {
  local p w m s bad=0 any=0
  p=$(alarms_problem)
  say "alarm daemon: ${p:-healthy}"
  for w in $(placed); do
    m=$(mode "$w")
    s=$(state "$w")
    say "world $w: $m, $s"
    case $m in
      sleep)
        any=1
        $SYSTEMCTL is-active --quiet "souls-gateway@$w.service" || { say "  its gateway is not active: an intent cannot reach it"; bad=1; }
        case $s in awake | asleep) ;; *) bad=1 ;; esac
        ;;
      always-on) [ "$s" = awake ] || bad=1 ;;
      *) bad=1 ;;
    esac
  done
  if [ "$any" = 1 ] && [ -n "$p" ]; then say "  a world has sleep on and the alarm daemon is not healthy: no wake would come"; bad=1; fi
  return $bad
}

case ${1:-} in
  plan) cmd_plan "${2:-}" ;;
  apply)
    [ -n "${2:-}" ] || die "apply <world> [--from <bundle>]"
    w=$(resolve "$2")
    from=''
    [ "${3:-}" != --from ] || from=${4:?--from <bundle>}
    cmd_apply "$w" "$from"
    ;;
  undo)
    [ -n "${2:-}" ] || die "undo <world>"
    cmd_undo "$(resolve "$2")"
    ;;
  check) cmd_check ;;
  *) die "use plan [<world>] | apply <world> [--from <bundle>] | check | undo <world>" ;;
esac
