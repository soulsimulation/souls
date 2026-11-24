#!/usr/bin/env bash
# sleep-rollout.sh end to end, on this machine: two worlds placed as production has them today (always on, gateways
# without --wake, no alarm daemon). World A is imported Eden with 3 Souls (the slowest start we ship), world B a small
# test world. The release owner's steps are run as on the host: plan, apply A (refused while the alarm daemon is not
# healthy, then done), check, undo A. In between: A sleeps after a quiet minute, a test Soul's intent (one of its
# seeded Souls, signed in at A's gateway through the driver) wakes it and is answered, its clock after the wake is the
# same mapping of wall time as before the sleep, a viewer reading its pointer while it sleeps plays a still world
# with no stall notice (the old page's own code, apps/web/src/v2-engine/bridge.ts), B never sleeps, and after undo A
# stays up through a quiet spell. systemd's part is played by a `systemctl` here that starts each unit with the
# environment its drop-ins and EnvironmentFile give at that start, restarts it unless it exits 75, and wakes a world
# through SUPERVISOR_WAKE. Never touches a production machine; everything is under .local/ (sockets through a short
# link in the temporary folder: a socket path is at most 104 bytes).
#
#   bash v2/tools/ops/tests/sleep-rollout-e2e.sh [--keep]
#
# Needs, from v2/: cargo build --release -p worldd -p gatewayd -p supervisor -p driver -p testworld, and the Eden facts
# (node v2/tools/import-eden/export/export.ts --out <file>) at SLEEP_E2E_FACTS (default .local/s3b/eden-2026.facts.json).
# Exit 0 when every step comes out as it should. It prints the measured wake (intent sent to its receipt).
set -euo pipefail

repo=$(cd "$(dirname "$0")/../../../.." && pwd)
t=${CARGO_TARGET_DIR:-$repo/v2/target}/release
FACTS=${SLEEP_E2E_FACTS:-$repo/.local/s3b/eden-2026.facts.json}
ACT_AT=${SLEEP_E2E_ACT_AT:-150}
for b in worldd gatewayd supervisor driver testworld; do [ -x "$t/$b" ] || {
  echo "e2e: no $t/$b (see the top of $0)" >&2
  exit 2
}; done
[ -f "$FACTS" ] || { echo "e2e: no Eden facts at $FACTS (see the top of $0)" >&2; exit 2; }
mkdir -p "$repo/.local"
D=$(mktemp -d "$repo/.local/sleep-rollout-XXXXXX")
D=$(cd "$D" && pwd)
L=$(mktemp -u /tmp/sr.XXXXXX)
mkdir -p "$D"/{etc,data/run,data/worlds/worlds,data/t,systemd,units,shim,seed,driver}
ln -s "$D/data" "$L"
pass=0 fail=0
ok() { echo "PASS: $*"; pass=$((pass + 1)); }
no() { echo "FAIL: $*"; fail=$((fail + 1)); }
note() { echo "  $*"; }

finish() {
  local f
  touch "$D/down"
  for f in "$D"/units/*.loop "$D"/units/*.pid "$D/driver.pid"; do [ -f "$f" ] && kill "$(cat "$f")" 2> /dev/null || true; done
  rm -f "$L"
  if [ "${KEEP:-}" != --keep ]; then rm -rf "$D"; else echo "kept $D"; fi
}
KEEP=${1:-}
trap finish EXIT

# systemd's part. A unit is a loop: its command started with the environment of this start (worldd@'s Environment=
# lines from its drop-ins, a gateway's EnvironmentFile), restarted 100 ms after it ends, unless it exits 75 (a world
# asleep: RestartPreventExitStatus=75, SuccessExitStatus=75). `show` answers ExecMainStatus and NRestarts.
cat > "$D/shim/systemctl" << 'EOF'
#!/usr/bin/env bash
set -u
D=$SLEEP_E2E
u=
for a in "$@"; do case $a in *.service) u=${a%.service} ;; esac; done
echo "$(date -u +%T) systemctl $*" >> "$D/units/systemctl.log"
pid() { cat "$D/units/$u.pid" 2> /dev/null || true; }
alive() { p=$(pid); [ -n "$p" ] && kill -0 "$p" 2> /dev/null; }
case $1 in
  daemon-reload) ;;
  is-active) alive ;;
  show)
    case $3 in
      ExecMainStatus) cat "$D/units/$u.status" 2> /dev/null || echo 0 ;;
      NRestarts) cat "$D/units/$u.restarts" 2> /dev/null || echo 0 ;;
    esac
    ;;
  stop)
    [ -f "$D/units/$u.loop" ] && kill "$(cat "$D/units/$u.loop")" 2> /dev/null
    p=$(pid); [ -z "$p" ] || { kill "$p" 2> /dev/null; for _ in $(seq 100); do kill -0 "$p" 2> /dev/null || break; sleep 0.1; done; kill -9 "$p" 2> /dev/null; }
    rm -f "$D/units/$u.loop" "$D/units/$u.pid"
    ;;
  restart) "$0" stop "$u.service"; exec "$0" start "$u.service" ;;
  start)
    l=$(cat "$D/units/$u.loop" 2> /dev/null || true)
    if [ -n "$l" ] && kill -0 "$l" 2> /dev/null; then exit 0; fi
    nohup bash -c '
      D=$1 u=$2
      t=${u%%@*} i=${u#*@}
      n=0
      while [ ! -f "$D/down" ]; do
        (
          set -a
          case $t in
            worldd) for f in "$SLEEP_E2E_UNITS/worldd@.service.d"/*.conf "$SLEEP_E2E_UNITS/worldd@$i.service.d"/*.conf; do
                [ -f "$f" ] && eval "$(sed -n "s/^Environment=//p" "$f")"; done ;;
            souls-gateway) GATEWAYD_ARGS=$(sed -n "s/^GATEWAYD_ARGS=//p" "$SLEEP_E2E_ETC/gateway-$i.env") ;;
          esac
          set +a
          echo "$(date -u +%T.%N) start SOULS_SLEEP=${SOULS_SLEEP:-unset} GATEWAYD_ARGS=${GATEWAYD_ARGS:-}"
          umask 0007
          exec bash -c "exec $(sed "s/%i/$i/g" "$D/units/$t.cmd")"
        ) >> "$D/units/$u.out" 2>&1 &
        echo $! > "$D/units/$u.pid"
        s=0; wait $! || s=$?
        echo "$s" > "$D/units/$u.status"
        [ "$t" = worldd ] && [ "$s" = 75 ] && { rm -f "$D/units/$u.loop"; exit 0; }
        n=$((n + 1)); echo $n > "$D/units/$u.restarts"
        sleep 0.1
      done' _ "$D" "$u" > /dev/null 2>&1 &
    echo $! > "$D/units/$u.loop"
    ;;
  *) exit 1 ;;
esac
EOF
printf '#!/usr/bin/env bash\nexec "%s" start "worldd@$1.service"\n' "$D/shim/systemctl" > "$D/shim/wake"
# The install's part for the alarm daemon (install.sh apply writes the unit and starts it); `broken` writes the unit
# and does not start it, the case the rollout must refuse.
cat > "$D/shim/install" << EOF
#!/usr/bin/env bash
echo "# the e2e's stand-in" > "$D/systemd/souls-alarms.service"
[ "\$1" = broken ] || "$D/shim/systemctl" start souls-alarms.service
EOF
chmod 755 "$D/shim/systemctl" "$D/shim/wake" "$D/shim/install"
echo "env WORLDS_ROOT=$L/worlds $t/supervisor launch %i" > "$D/units/worldd.cmd"
echo "$t/gatewayd \$GATEWAYD_ARGS" > "$D/units/souls-gateway.cmd"
echo "env WORLDS_ROOT=$L/worlds SUPERVISOR_WAKE=$D/shim/wake $t/supervisor alarms" > "$D/units/souls-alarms.cmd"

export SLEEP_E2E=$D SLEEP_E2E_UNITS=$D/systemd SLEEP_E2E_ETC=$D/etc
export ROLLOUT_ETC=$D/etc ROLLOUT_DATA=$L ROLLOUT_UNITS=$D/systemd ROLLOUT_SYSTEMCTL=$D/shim/systemctl
export ROLLOUT_START_S=60 ROLLOUT_STEADY_S=5
SYS=$D/shim/systemctl
RO="bash $repo/v2/tools/ops/sleep-rollout.sh"

# Two worlds, seeded, pinned on one build and placed as place-world.sh placed them before 0.133 (no --wake).
"$t/testworld" --out "$D/seed" > /dev/null
small=$(ls "$D/seed"/*.facts.json | head -1)
printf '#!/bin/sh\nexec "%s" "$@"\n' "$t/worldd" > "$D/seed/build"
chmod 755 "$D/seed/build"
h=$("$t/supervisor" hash "$D/seed/build")
mkdir -p "$D/data/worlds/builds/$h"
install -m 755 "$D/seed/build" "$D/data/worlds/builds/$h/worldd"
place() { # <letter> <facts> <souls> <port>: the world's name
  local i=$1 name W
  sed "1s/^{/{\"world\":\"sleep-rollout-e2e-$i\",/" "$2" > "$D/seed/facts-$i.json"
  "$t/worldd" seed --facts "$D/seed/facts-$i.json" --dir "$D/seed/$i" --souls "$3" > "$D/seed/$i.log" 2>&1
  name=$(sed -n 's/.*"name": *"\([0-9a-f-]*\)".*/\1/p' "$D/seed/$i/world.json")
  W=$D/data/worlds/worlds/$name
  mkdir -p "$W"
  (cd "$D/seed/$i" && tar cf - .) | (cd "$W" && tar xf -)
  mkdir -p "$W/receipts"
  mkdir -p "$D/data/t/$i" && cp "$W/tokens" "$D/data/t/$i/tokens" # its own folder: the control socket goes beside it
  WORLDS_ROOT=$L/worlds "$t/supervisor" pin "$name" "$h" > /dev/null
  mkdir -p "$D/systemd/worldd@$name.service.d"
  printf '[Service]\nEnvironment=WORLDD_SOCKET=%s\n' "$L/run/$i.sock" > "$D/systemd/worldd@$name.service.d/place.conf"
  # No --entries: a seeded folder's entries are empty, and the gateway refuses an empty one (#3760).
  printf 'GATEWAYD_ARGS=--listen 127.0.0.1:%s --world %s --tokens %s --build 1220 --receipts %s\n' "$4" "$L/run/$i.sock" \
    "$L/t/$i/tokens" "$L/worlds/worlds/$name/receipts" > "$D/etc/gateway-$name.env"
  echo "$name"
}
PA=$((47000 + RANDOM % 1000)) PB=$((48000 + RANDOM % 1000))
A=$(place a "$FACTS" 3 "$PA")
B=$(place b "$small" 1 "$PB")
cp "$D/etc/gateway-$A.env" "$D/gateway-A.before"
WA=$D/data/worlds/worlds/$A WB=$D/data/worlds/worlds/$B
note "world A $A (Eden, 3 Souls), world B $B (test world)"
for w in "$A" "$B"; do $SYS start "worldd@$w.service"; $SYS start "souls-gateway@$w.service"; done
serving() { for _ in $(seq 600); do [ "$(grep -c '^listening ' "$D/units/worldd@$1.out" 2> /dev/null)" -ge "${2:-1}" ] && return 0; sleep 0.1; done; return 1; }
serving "$A" && serving "$B" && ok "both worlds serve, always on" || no "a world did not start"
sleep 2
$SYS is-active --quiet "souls-gateway@$A.service" && $SYS is-active --quiet "souls-gateway@$B.service" && ok "both gateways up" || no "a gateway is down: $(tail -1 "$D/units/souls-gateway@$A.out")"

# The pointer a viewer reads: the world's public stream (views/world.json names it), as JSON.
POINTER_JS=$repo/v2/tools/ops/tests/sleep-viewer.mjs
pointer() { node "$POINTER_JS" pointer "$1"; }

echo "--- plan"
out=$($RO plan "$A" 2>&1) && ok "plan ran" || no "plan: $out"
echo "$out"
grep -q "alarm daemon: not installed" <<< "$out" && grep -q "world $A: always-on, awake" <<< "$out" && ok "plan: no alarm daemon, A always on" || no "plan's state"
cmp -s "$D/etc/gateway-$A.env" "$D/gateway-A.before" && [ ! -e "$D/systemd/souls-alarms.service" ] && ok "plan changed nothing" || no "plan changed something"

echo "--- apply A while the alarm daemon is installed but not running"
out=$(ROLLOUT_INSTALL="$D/shim/install broken" $RO apply "$A" 2>&1) && no "apply went on without a healthy daemon" || ok "apply refused: $(tail -1 <<< "$out")"
cmp -s "$D/etc/gateway-$A.env" "$D/gateway-A.before" && [ ! -e "$D/systemd/worldd@$A.service.d/60-sleep.conf" ] && ok "the refusal changed nothing of A's" || no "the refusal changed A's settings"

echo "--- apply A"
rm -f "$D/systemd/souls-alarms.service"
out=$(ROLLOUT_INSTALL="$D/shim/install" $RO apply "$A" 2>&1) && ok "apply A" || no "apply A failed"
echo "$out"
grep -q "Environment=SOULS_SLEEP=1" "$D/systemd/worldd@$A.service.d/60-sleep.conf" && grep -q -- "--wake $L/worlds/alarms.sock --world-name $A" "$D/etc/gateway-$A.env" && ok "A: SOULS_SLEEP=1 and --wake set" || no "A's settings"
[ ! -e "$D/systemd/worldd@$B.service.d/60-sleep.conf" ] && ! grep -q -- --wake "$D/etc/gateway-$B.env" && ok "B untouched" || no "B was changed"
grep -q "start SOULS_SLEEP=1" "$D/units/worldd@$A.out" && ok "A restarted with SOULS_SLEEP=1" || no "A did not restart with SOULS_SLEEP=1"
out=$($RO apply "$A" 2>&1) && grep -q "already on" <<< "$out" && ok "apply again changes nothing" || no "second apply: $out"
out=$($RO check 2>&1) && ok "check passes" || no "check failed"
echo "$out"
serving "$A" 2 || no "A did not serve after its restart"
woke_at=$(date +%s)

# The test Soul: A's first seeded Soul, signed in at A's gateway by the driver, one say at ACT_AT s (a say needs no
# entry; a seeded folder has none, so a gesture would stand in as a walk to any node).
printf '# sleep-rollout e2e: one say at %s s\n%s 0 say eden:say\n' "$ACT_AT" "$((ACT_AT * 1000))" > "$D/schedule.txt"
"$t/driver" --schedule "$D/schedule.txt" --dir "$D/driver" --tokens "$WA/souls.tokens" --remote "ws://127.0.0.1:$PA" --speech > "$D/driver.out" 2>&1 &
echo $! > "$D/driver.pid"

echo "--- A goes quiet"
asleep=''
for _ in $(seq $((ACT_AT - 5))); do grep -q '^asleep: next due' "$D/units/worldd@$A.out" && { asleep=1; break; }; sleep 1; done
if [ -n "$asleep" ]; then
  ok "A went to sleep $(($(date +%s) - woke_at)) s after its restart: $(grep '^asleep' "$D/units/worldd@$A.out" | tail -1)"
else no "A did not sleep before the wave"; fi
sleep 1
[ "$($SYS show -p ExecMainStatus --value "worldd@$A.service")" = 75 ] && ! $SYS is-active --quiet "worldd@$A.service" && ok "A's process is gone (exit 75), not restarted" || no "A's unit is not asleep"
out=$($RO check 2>&1) && grep -q "world $A: sleep, asleep" <<< "$out" && ok "check: A asleep, still passes" || no "check while asleep: $out"
grep -q "$A" "$D/data/worlds/directory/alarms/local" && ok "A's alarm is in the directory: due $(awk -v w="$A" '$1 == w { print $2 }' "$D/data/worlds/directory/alarms/local")" || no "no alarm for A"
asleep_ptr=$(pointer "$WA")
note "pointer at sleep: $asleep_ptr"
node "$POINTER_JS" view "$WA" 15 > "$D/viewer.out" 2>&1 && ok "viewer: $(tail -1 "$D/viewer.out")" || { no "viewer: $(tail -3 "$D/viewer.out")"; }
[ "$(pointer "$WA")" = "$asleep_ptr" ] && ok "A's pointer did not change while it slept (a viewer's read woke nothing)" || no "A's pointer changed while asleep"

echo "--- the test Soul's intent wakes A"
wait "$(cat "$D/driver.pid")" || true
rm -f "$D/driver.pid"
grep -E 'Acts:|receipts' "$D/driver.out" | head -3 | sed 's/^/  /'
lat=$(node -e 'const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const m = (r.perMinute ?? []).find((x) => x.receipts > 0); process.stdout.write(m ? String(m.latencyP50Ms) : "")' "$D/driver/report.json" 2> /dev/null || true)
if [ -n "$lat" ]; then
  awk -v l="$lat" 'BEGIN { exit !(l < 3000) }' && ok "the say was answered with a receipt ${lat} ms after it was sent, A asleep (bar 3000 ms)" || no "the say's receipt took ${lat} ms (bar 3000 ms)"
else no "no receipt for the say (driver.out: $(tail -2 "$D/driver.out"))"; fi
echo "$lat" > "$D/wake-ms"
[ "$(grep -c '^listening ' "$D/units/worldd@$A.out")" -ge 3 ] && ok "A was started by the alarm daemon for the intent" || no "A was not woken"
sleep 3
woke_ptr=$(pointer "$WA")
note "pointer after the wake: $woke_ptr"
node "$POINTER_JS" catchup "$asleep_ptr" "$woke_ptr" > "$D/catchup.out" 2>&1 && ok "catch-up: $(cat "$D/catchup.out")" || no "catch-up: $(cat "$D/catchup.out")"

echo "--- undo A"
out=$($RO undo "$A" 2>&1) && ok "undo A" || no "undo A failed: $out"
echo "$out"
cmp -s "$D/etc/gateway-$A.env" "$D/gateway-A.before" && [ ! -e "$D/systemd/worldd@$A.service.d/60-sleep.conf" ] && ok "A's settings are as before apply" || no "A's settings differ after undo"
n_asleep=$(grep -c '^asleep' "$D/units/worldd@$A.out")
$SYS is-active --quiet "worldd@$A.service" && ok "A is up after undo" || no "A is not up after undo"
note "waiting 90 s: a quiet minute with nothing due, A must stay up"
sleep 90
[ "$(grep -c '^asleep' "$D/units/worldd@$A.out")" = "$n_asleep" ] && $SYS is-active --quiet "worldd@$A.service" && ok "A stayed up through 90 quiet seconds: always on again" || no "A slept after undo"
tail -1 "$D/units/worldd@$A.out" | grep -q "SOULS_SLEEP=unset" || grep "start SOULS" "$D/units/worldd@$A.out" | tail -1 | grep -q "SOULS_SLEEP=unset" && ok "A's last start had no SOULS_SLEEP" || no "A's last start still had SOULS_SLEEP"
! grep -q '^asleep' "$D/units/worldd@$B.out" && $SYS is-active --quiet "worldd@$B.service" && [ "$(grep -c '^listening ' "$D/units/worldd@$B.out")" = 1 ] && ok "B served the whole run without a sleep or a restart" || no "B slept or restarted"
out=$($RO check 2>&1) && grep -q "world $A: always-on, awake" <<< "$out" && ok "check after undo: A always on" || no "check after undo: $out"

echo
echo "e2e: $pass passed, $fail failed; wake (intent sent to receipt): ${lat:-none} ms"
[ "$fail" = 0 ]
