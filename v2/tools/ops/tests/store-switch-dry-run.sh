#!/usr/bin/env bash
# store-switch.sh's dry run (0.133 ST2): two local worlds, seeded and served by `worldd serve` under the supervisor,
# their history, records and backups in one local S3 stand-in (the old provider), moved to a second stand-in (the new
# one) by store-switch.sh plan, apply, check and undo as the release owner runs them on the host. systemd's part is
# played by a `systemctl` here that reads each unit's EnvironmentFile= lines (the unit's, then its drop-ins', in
# order) at every start. Never touches a production machine; everything is under .local/ and in memory.
#
#   bash v2/tools/ops/tests/store-switch-dry-run.sh [--keep]
#
# Needs the debug builds: cargo build -p worldd -p supervisor -p testworld, cargo build -p ops --bin store-copy and
# cargo build -p directoryd --example stand-in (from v2/). Exit 0 when every step comes out as it should.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../../../.." && pwd)
t=${CARGO_TARGET_DIR:-$repo/v2/target}/debug
for b in worldd supervisor testworld store-copy examples/stand-in; do [ -x "$t/$b" ] || {
  echo "dry run: no $t/$b (see the top of $0)" >&2
  exit 2
}; done
mkdir -p "$repo/.local"
D=$(mktemp -d "$repo/.local/store-switch-XXXXXX")
D=$(cd "$D" && pwd)
mkdir -p "$D"/{etc,data/run,data/worlds/worlds,data/oneoff,units,systemd,shim,seed}
pass=0 fail=0
ok() {
  echo "PASS: $*"
  pass=$((pass + 1))
}
no() {
  echo "FAIL: $*"
  fail=$((fail + 1))
}

# The two providers: one stand-in process, two stand-ins in it, until its input closes.
mkfifo "$D/stand-in.in"
"$t/examples/stand-in" 2 < "$D/stand-in.in" > "$D/stand-in.out" &
SI=$!
exec 9> "$D/stand-in.in"
for _ in $(seq 100); do [ "$(grep -c '^stand-in' "$D/stand-in.out" 2> /dev/null)" = 2 ] && break; sleep 0.1; done
OLD=$(sed -n 's/^stand-in 0 //p' "$D/stand-in.out")
NEW=$(sed -n 's/^stand-in 1 //p' "$D/stand-in.out")
finish() {
  local f
  touch "$D/down"
  for f in "$D"/units/*.loop "$D"/units/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2> /dev/null || true; done
  exec 9>&- || true
  wait "$SI" 2> /dev/null || true
  if [ "${1:-}" != --keep ]; then rm -rf "$D"; else echo "kept $D"; fi
}
trap 'finish "${KEEP:-}"' EXIT
[ "${1:-}" = --keep ] && KEEP=--keep

# The host's settings: today's store (the old provider) in secrets.env, its keys, the backups' key; the new store's
# file, root-only as on the host (here, this user's, mode 600).
printf 'dry-run passphrase, never a real key\n' > "$D/etc/backup.key"
cat > "$D/etc/secrets.env" << EOF
# Secrets for Engine v2's programs (the dry run's).
DIRECTORY_STORE_URL=$OLD/souls-old/v2
SOULS_BACKUP_URL=$OLD/souls-old/backups
AWS_ACCESS_KEY_ID=stand-in-key
AWS_SECRET_ACCESS_KEY=old-provider-secret
AWS_DEFAULT_REGION=us-east-1
SOULS_BACKUP_KEY_FILE=$D/etc/backup.key
SOULS_BACKUP_SHIP_S=2
EOF
chmod 600 "$D/etc/secrets.env"
cat > "$D/etc/store-new.env" << EOF
STORE_BASE=$NEW/soul-game-worlds
AWS_ACCESS_KEY_ID=stand-in-key
AWS_SECRET_ACCESS_KEY=new-provider-secret
EOF
chmod 600 "$D/etc/store-new.env"
cat > "$D/data/oneoff/store-copy" << EOF
#!/usr/bin/env bash
echo "\$*" >> "$D/copy.log"
case " \$* " in *" --world \$(cat "$D/fail-copy" 2> /dev/null) "*) echo "store-copy: planted failure" >&2; exit 1 ;; esac
exec "$t/store-copy" "\$@"
EOF
chmod 755 "$D/data/oneoff/store-copy"

# systemd's part: a unit is a loop that starts its command again 100 ms after it ends, with the environment its
# EnvironmentFile= lines give at that start (the unit's own list, then each drop-in's, as systemd orders them).
cat > "$D/shim/systemctl" << 'EOF'
#!/usr/bin/env bash
set -u
D=$SWITCH_DRY
for a in "$@"; do case $a in *.service) u=${a%.service} ;; esac; done
echo "$(date -u +%T) systemctl $*" >> "$D/units/systemctl.log"
files() {
  local t=${u%%@*} f
  [ "$t" = "$u" ] || t="$t@"
  cat "$D/units/$t.envfiles"
  for f in "$SWITCH_UNITS/$t.service.d"/*.conf "$SWITCH_UNITS/$u.service.d"/*.conf; do
    [ -f "$f" ] && sed -n 's/^EnvironmentFile=-\{0,1\}//p' "$f"
  done
  return 0
}
pid() { cat "$D/units/$u.pid" 2> /dev/null || true; }
case $1 in
  daemon-reload) ;;
  show) files | tr '\n' ' ' ;;
  is-active) p=$(pid); [ -n "$p" ] && kill -0 "$p" 2> /dev/null ;;
  stop)
    [ -f "$D/units/$u.loop" ] && kill "$(cat "$D/units/$u.loop")" 2> /dev/null
    p=$(pid); [ -z "$p" ] || { kill "$p" 2> /dev/null; for _ in $(seq 150); do kill -0 "$p" 2> /dev/null || break; sleep 0.1; done; kill -9 "$p" 2> /dev/null; }
    rm -f "$D/units/$u.loop" "$D/units/$u.pid"
    ;;
  restart)
    "$0" stop "$u.service"
    exec "$0" start "$u.service"
    ;;
  start)
    t=${u%%@*} i=${u#*@}
    [ "$t" = "$u" ] && i=
    [ "$t" = "$u" ] || t="$t@"
    cmd=$(sed "s/%i/$i/g" "$D/units/$t.cmd")
    nohup bash -c '
      D=$1 u=$2 cmd=$3; shift 3
      cd "$D/data/worlds"
      while [ ! -f "$D/down" ]; do
        (
          set -a
          for f in "$@"; do [ -f "$f" ] && . "$f"; done
          set +a
          env | grep -E "^(DIRECTORY_STORE_|SOULS_BACKUP_URL|WORLDD_STORE|AWS_)" > "$D/units/$u.env"
          # The planted fault: a unit whose store is the one named in fail-on exits at once.
          if [ -f "$D/fail-on" ] && grep -qF "$(cat "$D/fail-on")" "$D/units/$u.env"; then exit 1; fi
          # And a unit named in fail-unit exits at once, whatever its store.
          if [ -f "$D/fail-unit" ] && [ "$(cat "$D/fail-unit")" = "$u" ]; then exit 1; fi
          exec bash -c "exec $cmd"
        ) >> "$D/units/$u.out" 2>&1 &
        echo $! > "$D/units/$u.pid"
        wait $! || true
        sleep 0.1
      done' _ "$D" "$u" "$cmd" $(files) > /dev/null 2>&1 &
    echo $! > "$D/units/$u.loop"
    ;;
  *) exit 1 ;;
esac
EOF
chmod 755 "$D/shim/systemctl"
# The units as the install writes them: worldd@ reads directory.env, then the install's drop-in secrets.env; the
# alarm daemon the same (its drop-in, 0.133 ST2); the directory secrets.env (here a stand-in process that only holds
# its environment: the dry run needs no sign-in).
echo "$D/etc/directory.env" > "$D/units/worldd@.envfiles"
echo "$D/etc/directory.env" > "$D/units/souls-alarms.envfiles"
echo "$D/etc/secrets.env" > "$D/units/souls-directory.envfiles"
mkdir -p "$D/systemd/worldd@.service.d" "$D/systemd/souls-alarms.service.d"
printf '[Service]\nEnvironmentFile=-%s\n' "$D/etc/secrets.env" > "$D/systemd/worldd@.service.d/10-install.conf"
printf '[Service]\nEnvironmentFile=-%s\n' "$D/etc/secrets.env" > "$D/systemd/souls-alarms.service.d/10-install.conf"
echo "env WORLDS_ROOT=. WORLDD_SOCKET=../run/%i.sock $t/supervisor launch %i" > "$D/units/worldd@.cmd"
echo "env WORLDS_ROOT=. SUPERVISOR_WAKE=/usr/bin/true $t/supervisor alarms" > "$D/units/souls-alarms.cmd"
echo "sleep 86400" > "$D/units/souls-directory.cmd"

export SWITCH_DRY=$D SWITCH_ETC=$D/etc SWITCH_DATA=$D/data SWITCH_UNITS=$D/systemd SWITCH_SYSTEMCTL=$D/shim/systemctl
export D SWITCH_START_S=30 SWITCH_STEADY_S=5 SWITCH_UNIT_ENV="cat_env"
cat_env() { cat "$D/units/$1.env" 2> /dev/null; }
export -f cat_env
SW="bash $repo/v2/tools/ops/store-switch.sh"
SYS=$D/shim/systemctl

# Two worlds from one facts file (its `world` names each one's lineage), pinned on one build, in the old store.
"$t/testworld" --out "$D/seed" > /dev/null
facts=$(ls "$D/seed"/*.facts.json | head -1)
printf '#!/bin/sh\nexec "%s" "$@"\n' "$t/worldd" > "$D/seed/build"
chmod 755 "$D/seed/build"
h=$("$t/supervisor" hash "$D/seed/build")
mkdir -p "$D/data/worlds/builds/$h"
install -m 755 "$D/seed/build" "$D/data/worlds/builds/$h/worldd"
NAMES=()
for i in a b; do
  sed "1s/^{/{\"world\":\"store-switch-dry-$i\",/" "$facts" > "$D/seed/facts-$i.json"
  "$t/worldd" seed --facts "$D/seed/facts-$i.json" --dir "$D/seed/$i" --souls 1 > /dev/null
  name=$(sed -n 's/.*"name": *"\([0-9a-f-]*\)".*/\1/p' "$D/seed/$i/world.json")
  mkdir -p "$D/data/worlds/worlds/$name"
  (cd "$D/seed/$i" && tar cf - .) | (cd "$D/data/worlds/worlds/$name" && tar xf -)
  (cd "$D/data/worlds" && set -a && . "$D/etc/secrets.env" && set +a && WORLDS_ROOT=. "$t/supervisor" pin "$name" "$h" > /dev/null)
  NAMES+=("$name")
done
for u in souls-directory souls-alarms "worldd@${NAMES[0]}" "worldd@${NAMES[1]}"; do $SYS start "$u.service"; done
up() { for _ in $(seq 600); do grep -q "listening " "$D/units/worldd@$1.out" 2> /dev/null && return 0; sleep 0.1; done; return 1; }
for w in "${NAMES[@]}"; do up "$w" && ok "world ${w:0:12}… serves on the old store" || no "world ${w:0:12}… did not start"; done
sleep 8 # history and backups ship (SOULS_BACKUP_SHIP_S=2; the history every 5 s)

# What each provider holds, by prefix: read through store-copy's dry run against an empty-looking third file is not
# possible without listing, so count the objects through a settings file per bucket and store-copy's probe-free dry run.
count() { # <settings> <setting>: the objects that setting's bucket holds
  "$t/store-copy" copy --from "$1" --to "$1" --setting "$2" --dry-run | sed -n 's/.*source \([0-9]*\) objects.*/\1/p'
}
old_v2=$(count "$D/etc/secrets.env" DIRECTORY_STORE_URL)
old_bk=$(count "$D/etc/secrets.env" SOULS_BACKUP_URL)
[ "${old_v2:-0}" -gt 0 ] && [ "${old_bk:-0}" -gt 0 ] && ok "the old store holds $old_v2 objects under the worlds' setting, $old_bk under the backups'" || no "the old store is empty ($old_v2, $old_bk)"
cp "$D/etc/secrets.env" "$D/secrets.before"

echo "--- plan"
plan=$($SW plan 2>&1) && ok "plan ran" || no "plan: $plan"
echo "$plan"
cmp -s "$D/etc/secrets.env" "$D/secrets.before" && ok "plan changed nothing" || no "plan changed secrets.env"
if printf '%s' "$plan" | grep -qE 'old-provider-secret|new-provider-secret|127\.0\.0\.1'; then no "plan printed a key or a host"; else ok "plan printed no key and no host"; fi

echo "--- apply"
t0=$(date +%s)
out=$($SW apply 2>&1) && ok "apply ran ($(($(date +%s) - t0)) s)" || no "apply: $out"
echo "$out"
if printf '%s' "$out" | grep -qE 'old-provider-secret|new-provider-secret|127\.0\.0\.1'; then no "apply printed a key or a host"; else ok "apply printed no key and no host"; fi
grep -q "^DIRECTORY_STORE_URL=$NEW/soul-game-worlds/v2$" "$D/etc/secrets.env" && grep -q "^SOULS_BACKUP_URL=$NEW/soul-game-worlds/backups$" "$D/etc/secrets.env" &&
  grep -qx "AWS_DEFAULT_REGION=auto" "$D/etc/secrets.env" && grep -q "^SOULS_BACKUP_KEY_FILE=" "$D/etc/secrets.env" &&
  ok "secrets.env names the new bucket, each prefix kept, the new keys, region auto, other lines kept" || no "secrets.env after apply is not as composed"
cmp -s "$D/etc/store-switch/last/secrets.env.before" "$D/secrets.before" && ok "the backup is today's secrets.env" || no "no backup"
for w in "${NAMES[@]}"; do
  [ ! -f "$D/systemd/worldd@$w.service.d/50-store-switch.conf" ] && $SYS is-active --quiet "worldd@$w.service" &&
    grep -q "^DIRECTORY_STORE_URL=$NEW/" "$D/units/worldd@$w.env" && ok "world ${w:0:12}… runs on the new store, no drop-in left" || no "world ${w:0:12}… not on the new store"
done
grep -q "^DIRECTORY_STORE_URL=$NEW/" "$D/units/souls-alarms.env" && ok "the alarm daemon reads the new store" || no "alarms not on the new store"
grep -c 'systemctl stop worldd@' "$D/units/systemctl.log" | grep -qx 2 && ok "each world stopped once, one at a time" || no "world stops: $(grep -c 'stop worldd@' "$D/units/systemctl.log")"
# The old bucket: nothing deleted (at least the objects it had before), and nothing writes to it once the move ends
# (the worlds wrote to it until each one moved; the move itself only reads it).
now_old=$(count "$D/secrets.before" DIRECTORY_STORE_URL)
sleep 6
later_old=$(count "$D/secrets.before" DIRECTORY_STORE_URL)
[ "$now_old" -ge "$old_v2" ] && [ "$later_old" = "$now_old" ] && ok "the old bucket: nothing deleted ($old_v2 before, $now_old after), nothing written once moved ($later_old 6 s later)" || no "the old bucket: $old_v2, $now_old, $later_old"
new_v2=$(count "$D/etc/secrets.env" DIRECTORY_STORE_URL)
[ "$new_v2" -ge "$old_v2" ] && ok "the new bucket holds $new_v2 objects (the copy, and what the worlds wrote since)" || no "new bucket $new_v2 < $old_v2"

echo "--- check"
out=$($SW check 2>&1) && ok "check passed" || no "check: $out"
echo "$out"

echo "--- chains"
# Each world sends its whole stream chain to the new store (worldd, a store moved), with SWITCH_SKIP too.
for _ in $(seq 1 30); do out=$($SW chains 2>&1) && break || sleep 1; done
printf '%s\n' "$out" | grep -q 'chains complete' && ok "every world's stream chain is in the new store${SWITCH_SKIP:+ (SWITCH_SKIP $SWITCH_SKIP)}" || no "chains: $out"

echo "--- undo, with the directory planted to fail at its start"
echo souls-directory > "$D/fail-unit"
calls=$(wc -l < "$D/copy.log")
out=$($SW undo 2>&1) && no "undo said it was done with the directory down" || ok "undo failed, and said so"
echo "$out"
printf '%s' "$out" | grep -q "souls-directory: NOT up" && printf '%s' "$out" | grep -q "the settings are restored, but these are not up: souls-directory" &&
  ! printf '%s' "$out" | grep -q "^store-switch: undone" && ok "undo named the unit not up and did not say undone" || no "undo's report"
cmp -s "$D/etc/secrets.env" "$D/secrets.before" && ok "the settings were restored first" || no "secrets.env not restored"
$SYS is-active --quiet souls-alarms.service && grep -q "^DIRECTORY_STORE_URL=$OLD/" "$D/units/souls-alarms.env" && ok "the alarm daemon was still started, on the old store" || no "alarms not up after a failed undo"
rm -f "$D/fail-unit"
out=$($SW undo 2>&1) && ok "undo run again finished" || no "undo again: $out"
echo "$out"
$SYS is-active --quiet souls-directory.service && grep -q "^DIRECTORY_STORE_URL=$OLD/" "$D/units/souls-directory.env" && ok "the directory is up on the old store" || no "directory not up"
[ "$(wc -l < "$D/copy.log")" = "$calls" ] && ok "undo called the copy tool not once: it writes to no bucket" || no "undo copied: $(tail -n +$((calls + 1)) "$D/copy.log")"
for w in "${NAMES[@]}"; do
  $SYS is-active --quiet "worldd@$w.service" && grep -q "^DIRECTORY_STORE_URL=$OLD/" "$D/units/worldd@$w.env" && ok "world ${w:0:12}… back on the old store" || no "world ${w:0:12}… not back"
done
calls=$(wc -l < "$D/copy.log")
out=$($SW check 2>&1) && ok "check passes after undo" || no "check after undo: $out"
printf '%s' "$out" | grep -q "probe skipped" && [ "$(wc -l < "$D/copy.log")" = "$calls" ] && ok "check after undo probed nothing: it never writes to the old bucket" || no "check after undo wrote"

# A world whose copy fails mid-move: the run stops there, that world back on the old store at once; the world before
# it stays moved, and undo brings it back.
echo "--- the second world's copy fails"
echo "${NAMES[1]}" > "$D/fail-copy"
out=$($SW apply 2>&1) && no "apply went through a failed copy" || true
echo "$out" | tail -6
rm -f "$D/fail-copy"
printf '%s' "$out" | grep -q "world ${NAMES[1]}: the copy of its writes failed; switching it back now" && printf '%s' "$out" | grep -q "stopped at world ${NAMES[1]}" &&
  ok "the failed copy was caught and the run stopped at that world" || no "the failed copy was not caught"
w=${NAMES[1]}
[ ! -f "$D/systemd/worldd@$w.service.d/50-store-switch.conf" ] && $SYS is-active --quiet "worldd@$w.service" && grep -q "^DIRECTORY_STORE_URL=$OLD/" "$D/units/worldd@$w.env" &&
  ok "world ${w:0:12}… is up on the old store, never started on the new one" || no "world ${w:0:12}… after the failed copy"
grep -q "^DIRECTORY_STORE_URL=$NEW/" "$D/units/worldd@${NAMES[0]}.env" && ok "the world before it stays moved" || no "the first world"
cmp -s "$D/etc/secrets.env" "$D/secrets.before" && ok "secrets.env unchanged" || no "secrets.env changed"
# The stopped run resumed to the end: `last` names that run's folder (not `current`, which the end removes), so check
# probes the bucket it moved to and undo finds the run.
out=$($SW apply 2>&1) && ok "the stopped run resumed to the end" || no "resume: $out"
[ -e "$D/etc/store-switch/last" ] && [ "$(readlink "$D/etc/store-switch/last")" != current ] && ok "last names the resumed run" || no "last after a resume: $(readlink "$D/etc/store-switch/last")"
out=$($SW check 2>&1) && printf '%s' "$out" | grep -q 'probe write, read back, delete and empty listing: ok' && ok "check after the resume probes the new bucket" || no "check after the resume: $out"
out=$($SW undo 2>&1) && ok "undo of the resumed run ran" || no "undo of the resumed run: $out"
for w in "${NAMES[@]}"; do
  $SYS is-active --quiet "worldd@$w.service" && grep -q "^DIRECTORY_STORE_URL=$OLD/" "$D/units/worldd@$w.env" && ok "world ${w:0:12}… back on the old store" || no "world ${w:0:12}… not back"
done

# A world that does not come back on the new store is switched back at once (a planted fault: a world unit whose
# store is the new bucket exits at start), and the run stops there.
echo "--- a world that fails on the new store"
echo "$NEW/" > "$D/fail-on"
out=$($SW apply 2>&1) && no "apply went through a world that does not start" || true
echo "$out" | tail -5
printf '%s' "$out" | grep -q "switching it back now" && printf '%s' "$out" | grep -q "up again on the store it was on" &&
  ok "the first world was switched back at once and the run stopped" || no "no switch back"
rm -f "$D/fail-on"
for w in "${NAMES[@]}"; do
  [ ! -f "$D/systemd/worldd@$w.service.d/50-store-switch.conf" ] && $SYS is-active --quiet "worldd@$w.service" && ok "world ${w:0:12}… still up on the old store" || no "world ${w:0:12}… not up"
done
cmp -s "$D/etc/secrets.env" "$D/secrets.before" && ok "secrets.env unchanged" || no "secrets.env changed"
out=$($SW undo 2>&1) && ok "undo of the stopped run ran" || no "undo of the stopped run: $out"

echo "dry run: $pass passed, $fail failed"
[ "$fail" = 0 ]
