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
#   bash store-switch.sh check                      each store unit's effective store against secrets.env, and a probe
#                                                   write, read and delete under probe/store-switch/ in each bucket
#   bash store-switch.sh undo                       the last apply backwards: each world, then the services, back on the
#                                                   backed-up settings, with what they wrote meanwhile copied back
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

# <from> <to> [--world <w>]...: each bucket setting, checked by count and size. Its manifest in $MANIFESTS (each key's
# target ETag as last written) keeps what a moved world has written at the target since from being copied over.
copy_all() {
  local from=$1 to=$2 n
  shift 2
  for n in $(buckets "$from"); do
    "$COPY" copy --from "$from" --to "$to" --setting "$n" ${MANIFESTS:+--manifest "$MANIFESTS/manifest.$n"} "$@"
  done
}

dropin() { echo "$UNITS/worldd@$1.service.d/$DROPIN"; }

# One world onto the store `to` names: stopped, its writes since copied, pointed there, started, checked.
switch_world() {
  local w=$1 from=$2 to=$3 store=$4 d
  d=$(dropin "$w")
  say "world $w: stopping"
  $SYSTEMCTL stop "worldd@$w.service"
  copy_all "$from" "$to" --world "$w"
  mkdir -p "$(dirname "$d")"
  printf '# store-switch.sh (0.133 ST2): this world alone on the store it moves to, until the move ends.\n[Service]\nEnvironmentFile=%s\n' "$store" > "$d.tmp"
  chmod 644 "$d.tmp"
  mv "$d.tmp" "$d"
  $SYSTEMCTL daemon-reload
  $SYSTEMCTL start "worldd@$w.service"
  if healthy "worldd@$w.service"; then
    say "world $w: up on the store it moves to"
    return 0
  fi
  say "world $w: did not stay up on the store it moves to; switching it back now"
  $SYSTEMCTL stop "worldd@$w.service"
  rm -f "$d"
  $SYSTEMCTL daemon-reload
  $SYSTEMCTL start "worldd@$w.service"
  healthy "worldd@$w.service" && say "world $w: up again on the store it was on" || say "world $w: NOT up on either store: see 'supervisor health $w'"
  return 1
}

# The move from the settings `from` to `to`, its working files in `run`; resumes a stopped run.
move() {
  local from=$1 to=$2 run=$3 w u
  MANIFESTS=$run
  store_only "$to" > "$run/store.env"
  say "copying every object to the store it moves to (the one it leaves is only read)"
  copy_all "$from" "$to"
  for w in $(worlds); do
    if grep -qxF "$w" "$run/worlds" 2> /dev/null; then
      say "world $w: already moved"
      continue
    fi
    switch_world "$w" "$from" "$to" "$run/store.env" || die "stopped at world $w (switched back). The worlds listed in $run/worlds are on the store it moves to: run the same command again to go on, or undo"
    echo "$w" >> "$run/worlds"
  done
  say "stopping ${SERVICES[*]}; copying what they wrote since"
  for u in "${SERVICES[@]}"; do $SYSTEMCTL stop "$u.service"; done
  copy_all "$from" "$to"
  install -m 600 "$to" "$SECRETS.next"
  mv "$SECRETS.next" "$SECRETS"
  for w in $(cat "$run/worlds" 2> /dev/null); do rm -f "$(dropin "$w")"; done
  $SYSTEMCTL daemon-reload
  for u in "${SERVICES[@]}"; do
    $SYSTEMCTL start "$u.service"
    healthy "$u.service" || die "$u did not stay up on the new settings: run undo"
  done
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

undo() {
  local run w back
  if [ -L "$STATE/current" ]; then
    # A move that stopped partway: its worlds back, with what they wrote meanwhile; secrets.env never changed.
    run=$(cd "$STATE/current" && pwd)
    back=$run/undo
    mkdir -p -m 700 "$back"
    MANIFESTS=$back
    for w in $(cat "$run/worlds" 2> /dev/null); do
      say "world $w: stopping"
      $SYSTEMCTL stop "worldd@$w.service"
      copy_all "$run/secrets.env.after" "$run/secrets.env.before" --world "$w"
      rm -f "$(dropin "$w")"
      $SYSTEMCTL daemon-reload
      $SYSTEMCTL start "worldd@$w.service"
      healthy "worldd@$w.service" || die "world $w did not stay up on the old store: see 'supervisor health $w'"
    done
    rm "$STATE/current"
    say "undone: every world back on the settings in $run/secrets.env.before"
    return
  fi
  [ -L "$STATE/last" ] || die "no move to undo"
  run=$(cd "$STATE/last" && pwd)
  cmp -s "$SECRETS" "$run/secrets.env.after" || die "secrets.env is not what the last move installed: restore $run/secrets.env.before by hand"
  back=$run/undo
  mkdir -p -m 700 "$back"
  rm -f "$back/worlds" "$back"/manifest.*
  move "$run/secrets.env.after" "$run/secrets.env.before" "$back"
  [ ! -f "$run/directory.env.before" ] || install -m "$(stat -c %a "$run/directory.env.before" 2> /dev/null || stat -f %Lp "$run/directory.env.before")" "$run/directory.env.before" "$ETC/directory.env"
  rm "$STATE/last"
  say "undone: secrets.env is $run/secrets.env.before again"
}

check() {
  local u n want got bad=0 env w units
  [ -r "$SECRETS" ] || die "no $SECRETS"
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
  for n in $(buckets "$SECRETS"); do "$COPY" probe --settings "$SECRETS" --setting "$n" || bad=1; done
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
