#!/usr/bin/env bash
# Move the new engine's worlds' bucket to another provider (0.133 ST2: Cloudflare R2), one world at a time.
#
# WHAT THIS DOES, in plain words. The new engine keeps its worlds' history, checkpoints, records and the directory in a
# bucket (DIRECTORY_STORE_URL in /etc/souls/secrets.env), and its sealed store backups in another setting of the same
# form (SOULS_BACKUP_URL); both use the keys AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY there, so they move together.
# The new store is one value, STORE_BASE (s3:https://<host>/<bucket>), in a root-only file with its keys; each setting
# keeps its own prefix under it. `apply`:
#   - backs up secrets.env (and directory.env) under /etc/souls/store-switch/<time>/;
#   - copies every object each setting names to the new bucket (resumable: an object already there with the same bytes
#     counts as made), then checks the count and size; the old bucket is only read, never written or deleted;
#   - for each world, one at a time: stops it, copies what it wrote since, points that world alone at the new store (a
#     drop-in, worldd@<world>.service.d/50-store-switch.conf), starts it and checks it stays up; a world that does not
#     come back is switched back at once (drop-in removed, started on the old store) and the run stops there;
#   - then stops the directory and the alarm daemon, copies what they wrote since, installs the new secrets.env, removes
#     the drop-ins (every unit now reads the new store from secrets.env) and starts them again.
# Between a world's switch and the last step the directory still reads the old store: for those minutes a switched
# world's sleep alarm and list row are seen late. Nothing is deleted anywhere.
#
#   bash store-switch.sh plan  [<new store file>]   what would change, and the copy's counts; changes nothing
#   bash store-switch.sh apply [<new store file>]   the steps above; run again after a stop, it resumes
#   bash store-switch.sh check                      each store unit's effective store against secrets.env, and, when
#                                                   a move installed it, a probe write, read and delete in each bucket
#   bash store-switch.sh undo                       the last apply backwards: the backed-up settings first, then each
#                                                   world and every service restarted on them; writes to no bucket
#
# The new store file (default /etc/souls/store-new.env, root, mode 600) holds STORE_BASE, AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY and optionally AWS_DEFAULT_REGION (R2's `auto` when absent). Keys are read from files by path
# and never printed or put on a command line; neither is a store's host. Root on the production host. The copy tool is
# `store-copy` (v2/tools/ops/src/store_copy.rs), built by the release owner and placed at SWITCH_COPY. SWITCH_* stand in
# for the host's folders and systemd in a test (v2/tools/ops/tests/store-switch-dry-run.sh).
set -euo pipefail
umask 077

ETC=${SWITCH_ETC:-/etc/souls}
DATA=${SWITCH_DATA:-/var/lib/souls}
UNITS=${SWITCH_UNITS:-/etc/systemd/system}
COPY=${SWITCH_COPY:-$DATA/oneoff/store-copy}
SYSTEMCTL=${SWITCH_SYSTEMCTL:-systemctl}
START_S=${SWITCH_START_S:-90}
STEADY_S=${SWITCH_STEADY_S:-15}
STATE=$ETC/store-switch
SECRETS=$ETC/secrets.env
WORLDS=$DATA/worlds/worlds
NAMES=(DIRECTORY_STORE_URL SOULS_BACKUP_URL WORLDD_STORE)
SERVICES=(souls-directory souls-alarms)
DROPIN=50-store-switch.conf
MANIFESTS=

die() {
  echo "store-switch: $*" >&2
  exit 2
}
say() { echo "store-switch: $*"; }

# A setting's value in a settings file, on stdout for a caller's variable; never echoed by this script.
value() { awk -v k="$1" '{ sub(/^export /, "") } index($0, k "=") == 1 { v = substr($0, length(k) + 2); gsub(/^["\047]|["\047]$/, "", v); print v; exit }' "$2"; }
named() { [ -n "$(value "$1" "$2")" ]; }
# The bucket settings a file names (a folder store, folder:<path> or a bare path, is not moved).
buckets() {
  local n v
  for n in "${NAMES[@]}"; do
    v=$(value "$n" "$1")
    case $v in s3:* | http://* | https://*) echo "$n" ;; esac
  done
}

private_file() {
  local f=$1 mode owner
  [ -f "$f" ] || die "no $f"
  mode=$(stat -c %a "$f" 2> /dev/null || stat -f %Lp "$f")
  owner=$(stat -c %u "$f" 2> /dev/null || stat -f %u "$f")
  [ "$mode" = 600 ] && [ "$owner" = "$(id -u)" ] || die "$f must be mode 600 and owned by $(id -un)"
}

# The settings file the move goes to: secrets.env with each bucket setting rewritten to STORE_BASE plus its own
# prefix, and the new keys and region in place of the old ones. Values pass through awk's files only.
compose() {
  local cur=$1 new=$2
  awk -v names="${NAMES[*]}" '
    function val(line) { sub(/^export /, "", line); line = substr(line, index(line, "=") + 1); gsub(/^["\047]|["\047]$/, "", line); return line }
    function key(line) { sub(/^export /, "", line); return substr(line, 1, index(line, "=") - 1) }
    BEGIN { n = split(names, list, " "); for (i = 1; i <= n; i++) store[list[i]] = 1 }
    FNR == NR { k = key($0); if (k == "STORE_BASE" || k == "AWS_ACCESS_KEY_ID" || k == "AWS_SECRET_ACCESS_KEY" || k == "AWS_DEFAULT_REGION") nw[k] = val($0); next }
    {
      k = key($0)
      if (k == "AWS_ACCESS_KEY_ID" || k == "AWS_SECRET_ACCESS_KEY" || k == "AWS_DEFAULT_REGION") next
      if (k in store) {
        v = val($0)
        if (v ~ /^(s3:)?https?:\/\//) {
          sub(/^s3:/, "", v); sub(/^https?:\/\//, "", v)
          c = split(v, part, "/"); prefix = ""
          for (i = 3; i <= c; i++) if (part[i] != "") prefix = prefix "/" part[i]
          print k "=" nw["STORE_BASE"] prefix; next
        }
      }
      print
    }
    END {
      print "AWS_ACCESS_KEY_ID=" nw["AWS_ACCESS_KEY_ID"]
      print "AWS_SECRET_ACCESS_KEY=" nw["AWS_SECRET_ACCESS_KEY"]
      print "AWS_DEFAULT_REGION=" (("AWS_DEFAULT_REGION" in nw) ? nw["AWS_DEFAULT_REGION"] : "auto")
    }' "$new" "$cur"
}

# Only the store's lines of a settings file: what a world's drop-in loads over secrets.env.
store_only() { grep -E "^(export )?(DIRECTORY_STORE_[A-Z_]+|SOULS_BACKUP_URL|WORLDD_STORE|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|AWS_DEFAULT_REGION)=" "$1" || true; }

check_new() {
  local new=$1 base
  private_file "$new"
  base=$(value STORE_BASE "$new")
  [[ "$base" =~ ^s3:https?://[^/@]+/[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || die "STORE_BASE in $new is s3:https://<host>/<bucket>, no prefix, no key"
  named AWS_ACCESS_KEY_ID "$new" && named AWS_SECRET_ACCESS_KEY "$new" || die "$new has no AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY"
}

check_current() {
  local u first
  [ -r "$SECRETS" ] || die "no $SECRETS"
  [ -n "$(buckets "$SECRETS")" ] || die "$SECRETS names no bucket (${NAMES[*]})"
  ! named DIRECTORY_STORE_ENDPOINT "$SECRETS" || die "$SECRETS uses DIRECTORY_STORE_ENDPOINT: put the store in DIRECTORY_STORE_URL's one-value form first"
  if [ -f "$ETC/directory.env" ] && [ -n "$(store_only "$ETC/directory.env")" ]; then
    die "$ETC/directory.env names store settings: the store is set in $SECRETS only (remove them there first)"
  fi
  [ -x "$COPY" ] || die "no store-copy at $COPY (cargo build --release -p ops --bin store-copy; docs: v2/docs/runbook/store-switch.md)"
  first=$(worlds | sed -n 1p)
  for u in "${SERVICES[@]}" ${first:+"worldd@$first"}; do
    $SYSTEMCTL show -p EnvironmentFiles --value "$u.service" | grep -qF "$SECRETS" || die "$u does not read $SECRETS (install.sh apply puts it in its drop-in)"
  done
}

# Every world folder whose unit runs, in order.
worlds() {
  local w
  for w in $(ls "$WORLDS" 2> /dev/null | sort); do
    [[ "$w" =~ ^[0-9a-f]{32}-[0-9a-f]{32}-[0-9]+$ ]] || continue
    $SYSTEMCTL is-active --quiet "worldd@$w.service" && echo "$w"
  done
  return 0
}

# Up within START_S and then for STEADY_S seconds on end: a world that restarts in that time is not up.
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

# <from> <to> [--world <w>]...: each bucket setting, checked by count and size; fails on the first that fails. Its
# manifest in $MANIFESTS (each key's target ETag as last written) keeps what a moved world has written at the target
# since from being copied over. Every step in the functions below checks its own status: they run under `if` and
# `||`, where `set -e` does not stop them.
copy_all() {
  local from=$1 to=$2 n names
  shift 2
  names=$(buckets "$from") || return 1
  for n in $names; do
    "$COPY" copy --from "$from" --to "$to" --setting "$n" ${MANIFESTS:+--manifest "$MANIFESTS/manifest.$n"} "$@" || return 1
  done
  return 0
}

dropin() { echo "$UNITS/worldd@$1.service.d/$DROPIN"; }

# A world back on the store it was on: its drop-in removed, started, checked. Says which.
back_on_old() {
  local w=$1
  $SYSTEMCTL stop "worldd@$w.service" || true
  rm -f "$(dropin "$w")"
  $SYSTEMCTL daemon-reload || say "world $w: daemon-reload failed"
  if $SYSTEMCTL start "worldd@$w.service" && healthy "worldd@$w.service"; then
    say "world $w: up again on the store it was on"
  else
    say "world $w: NOT up on either store: see 'supervisor health $w'"
  fi
}

# One world onto the store `to` names: stopped, its writes since copied, pointed there, started, checked. Any step
# that fails switches it back at once and returns 1.
switch_world() {
  local w=$1 from=$2 to=$3 store=$4 d
  d=$(dropin "$w")
  say "world $w: stopping"
  if ! $SYSTEMCTL stop "worldd@$w.service"; then
    say "world $w: did not stop; starting it again where it was"
    back_on_old "$w"
    return 1
  fi
  if ! copy_all "$from" "$to" --world "$w"; then
    say "world $w: the copy of its writes failed; switching it back now (it never ran on the store it moves to)"
    back_on_old "$w"
    return 1
  fi
  if ! { mkdir -p "$(dirname "$d")" &&
    printf '# store-switch.sh (0.133 ST2): this world alone on the store it moves to, until the move ends.\n[Service]\nEnvironmentFile=%s\n' "$store" > "$d.tmp" &&
    chmod 644 "$d.tmp" && mv "$d.tmp" "$d" && $SYSTEMCTL daemon-reload; }; then
    say "world $w: its drop-in could not be written; switching it back now"
    rm -f "$d.tmp"
    back_on_old "$w"
    return 1
  fi
  if $SYSTEMCTL start "worldd@$w.service" && healthy "worldd@$w.service"; then
    say "world $w: up on the store it moves to"
    return 0
  fi
  say "world $w: did not stay up on the store it moves to; switching it back now"
  back_on_old "$w"
  return 1
}

# Starts each of SERVICES, checked; prints and returns 1 if any is not up, having tried them all.
start_services() {
  local u bad=0
  for u in "${SERVICES[@]}"; do
    if $SYSTEMCTL start "$u.service" && healthy "$u.service"; then say "$u: up"; else
      say "$u: NOT up"
      bad=1
    fi
  done
  return $bad
}

# The move from the settings `from` to `to`, its working files in `run`; resumes a stopped run. A failed step stops
# it with every unit running: a world switched back, or the services started again on the settings they had; a
# service that does not come up on the new settings undoes the whole move at once.
move() {
  local from=$1 to=$2 run=$3 w u
  MANIFESTS=$run
  store_only "$to" > "$run/store.env" || die "cannot write $run/store.env"
  say "copying every object to the store it moves to (the one it leaves is only read)"
  copy_all "$from" "$to" || die "the copy failed; no world was switched: run the same command again to resume"
  for w in $(worlds); do
    if grep -qxF "$w" "$run/worlds" 2> /dev/null; then
      say "world $w: already moved"
      continue
    fi
    if ! switch_world "$w" "$from" "$to" "$run/store.env"; then
      die "stopped at world $w (switched back). The worlds listed in $run/worlds are on the store it moves to: run the same command again to go on, or undo"
    fi
    echo "$w" >> "$run/worlds" || die "cannot record world $w in $run/worlds: undo"
  done
  say "stopping ${SERVICES[*]}; copying what they wrote since"
  for u in "${SERVICES[@]}"; do
    if ! $SYSTEMCTL stop "$u.service"; then
      start_services || true
      die "$u did not stop; the services run on the settings they had. Run the same command again, or undo"
    fi
  done
  if ! copy_all "$from" "$to"; then
    start_services || true
    die "the last copy failed; the services run on the settings they had. Run the same command again, or undo"
  fi
  if ! { install -m 600 "$to" "$SECRETS.next" && mv "$SECRETS.next" "$SECRETS"; }; then
    start_services || true
    die "secrets.env could not be written; the services run on the settings they had. Run the same command again, or undo"
  fi
  for w in $(cat "$run/worlds" 2> /dev/null); do rm -f "$(dropin "$w")"; done
  $SYSTEMCTL daemon-reload || say "daemon-reload failed"
  if ! start_services; then
    say "a service did not come up on the new settings: undoing the move now"
    undo
    die "the move was undone: every unit is back on the settings it had"
  fi
  say "secrets.env names the store it moved to; every world and service reads it"
}

plan() {
  local new=$1 n w
  check_current
  check_new "$new"
  say "plan (nothing changes):"
  echo "  the new store: one value, STORE_BASE in $new (bucket $(value STORE_BASE "$new" | sed 's|.*/||')); keys from that file"
  for n in $(buckets "$SECRETS"); do echo "  $n: to the new bucket, its own prefix kept"; done
  echo "  AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_DEFAULT_REGION: the new file's (region absent: auto)"
  echo "  backup of secrets.env (and directory.env) under $STATE/<time>/"
  echo "  worlds, one at a time (stop, copy its writes, drop-in, start, $STEADY_S s up or switched back):"
  for w in $(worlds); do echo "    worldd@$w"; done
  echo "  then: ${SERVICES[*]} stopped, last copy, secrets.env installed, drop-ins removed, started"
  local tmp
  tmp=$(mktemp "$ETC/.store-switch.XXXXXX")
  compose "$SECRETS" "$new" > "$tmp"
  copy_all "$SECRETS" "$tmp" --dry-run || true
  rm -f "$tmp"
}

apply() {
  local new=$1 run t
  check_current
  mkdir -p "$STATE"
  chmod 700 "$STATE"
  if [ -L "$STATE/current" ]; then
    run=$(cd "$STATE/current" && pwd)
    say "resuming the move in $run"
  else
    check_new "$new"
    t=$(date -u +%Y%m%dT%H%M%SZ)
    run=$STATE/$t
    mkdir -m 700 "$run"
    cp -p "$SECRETS" "$run/secrets.env.before"
    [ ! -f "$ETC/directory.env" ] || cp -p "$ETC/directory.env" "$run/directory.env.before"
    compose "$SECRETS" "$new" > "$run/secrets.env.after"
    ln -s "$t" "$STATE/current"
    say "backed up secrets.env to $run/secrets.env.before"
  fi
  move "$run/secrets.env.before" "$run/secrets.env.after" "$run"
  rm "$STATE/current"
  ln -sfn "$(basename "$run")" "$STATE/last"
  say "done. Check: bash $0 check. Undo: bash $0 undo"
}

# The last move, or one that stopped partway, backwards. It writes nothing to either bucket: the settings first
# (secrets.env and directory.env from the backup, every move drop-in removed), then each world that ran on the store
# moved to is restarted on them, one at a time, then every service. A unit that does not come up is reported and
# the rest still go on; the move's record stays, so undo can be run again. A world's records written since the move
# ship again from its own log to the store it is back on.
undo() {
  local run link w u failed=() list d
  if [ -L "$STATE/current" ]; then link=current; elif [ -L "$STATE/last" ]; then link=last; else die "no move to undo"; fi
  run=$(cd "$STATE/$link" && pwd)
  if ! cmp -s "$SECRETS" "$run/secrets.env.after" && ! cmp -s "$SECRETS" "$run/secrets.env.before"; then
    die "secrets.env is neither the move's nor the backup: restore $run/secrets.env.before by hand"
  fi
  # 1. The settings, before any unit is touched.
  if ! cmp -s "$SECRETS" "$run/secrets.env.before"; then
    { install -m 600 "$run/secrets.env.before" "$SECRETS.next" && mv "$SECRETS.next" "$SECRETS"; } || die "secrets.env could not be restored; no unit was touched"
  fi
  if [ -f "$run/directory.env.before" ]; then
    cp -p "$run/directory.env.before" "$ETC/directory.env" || die "directory.env could not be restored; no unit was touched"
  fi
  for d in "$UNITS"/worldd@*.service.d/"$DROPIN"; do [ ! -f "$d" ] || rm -f "$d" || die "cannot remove $d"; done
  $SYSTEMCTL daemon-reload || failed+=(daemon-reload)
  say "settings restored from $run/secrets.env.before"
  # 2. The worlds that read the store moved to: the moved ones, and after a finished move every running world.
  list=$(cat "$run/worlds" 2> /dev/null || true)
  [ "$link" = current ] || list=$(printf '%s\n%s\n' "$list" "$(worlds)")
  for w in $(printf '%s\n' "$list" | sed '/^$/d' | sort -u); do
    if $SYSTEMCTL restart "worldd@$w.service" && healthy "worldd@$w.service"; then say "world $w: up on the settings it had"; else
      say "world $w: NOT up: see 'supervisor health $w'"
      failed+=("worldd@$w")
    fi
  done
  # 3. Every service, started whatever state a stopped move left it in.
  for u in "${SERVICES[@]}"; do
    if $SYSTEMCTL restart "$u.service" && healthy "$u.service"; then say "$u: up on the settings it had"; else
      say "$u: NOT up"
      failed+=("$u")
    fi
  done
  if [ ${#failed[@]} -gt 0 ]; then
    say "undo: the settings are restored, but these are not up: ${failed[*]}. Fix them, then run undo again"
    exit 1
  fi
  rm -f "$STATE/$link"
  say "undone: every unit runs on $run/secrets.env.before"
}

check() {
  local u n want got bad=0 env w units moved=0
  [ -r "$SECRETS" ] || die "no $SECRETS"
  [ -L "$STATE/last" ] && cmp -s "$SECRETS" "$STATE/last/secrets.env.after" && moved=1
  units=("${SERVICES[@]}")
  for w in $(worlds); do units+=("worldd@$w"); done
  for u in "${units[@]}"; do
    if [ -n "${SWITCH_UNIT_ENV:-}" ]; then env=$($SWITCH_UNIT_ENV "$u"); else
      env=$(tr '\0' '\n' < "/proc/$($SYSTEMCTL show -p MainPID --value "$u.service")/environ" 2> /dev/null || true)
    fi
    for n in $(buckets "$SECRETS"); do
      want=$(value "$n" "$SECRETS")
      got=$(printf '%s\n' "$env" | value "$n" /dev/stdin)
      # A unit's own copy of the setting; worldd takes WORLDD_STORE first, so an unset one there is no store of its own.
      if [ -z "$got" ] && [ "$n" != DIRECTORY_STORE_URL ]; then continue; fi
      if [ "$got" = "$want" ]; then echo "  $u: $n is secrets.env's"; else
        echo "  $u: $n is NOT secrets.env's"
        bad=1
      fi
    done
  done
  for w in $(worlds); do [ ! -f "$(dropin "$w")" ] || { echo "  worldd@$w: still has the move's drop-in"; bad=1; }; done
  # The probe writes, so only in the bucket a move installed; the store from before a move is never written here.
  if [ "$moved" = 1 ]; then
    for n in $(buckets "$SECRETS"); do "$COPY" probe --settings "$SECRETS" --setting "$n" || bad=1; done
  else
    echo "  probe skipped: secrets.env names the store from before any move, which check never writes"
  fi
  [ "$bad" = 0 ] && say "check passed" && return 0
  say "check found the differences above"
  return 1
}

[ -n "${SWITCH_ETC:-}" ] || [ "$(id -u)" = 0 ] || die "run as root"
case ${1:-} in
  plan) plan "${2:-$ETC/store-new.env}" ;;
  apply) apply "${2:-$ETC/store-new.env}" ;;
  check) check ;;
  undo) undo ;;
  *)
    sed -n 2,31p "$0"
    exit 2
    ;;
esac
