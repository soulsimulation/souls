#!/usr/bin/env bash
# Places a seeded world on this machine (Engine v2 C1, #3365): `worldd seed` made the folder; this puts it where
# `supervisor launch <name>` finds it and writes what its two units read. Runbook: v2/docs/runbook/install.md.
#
#   bash place-world.sh <seeded folder> --port <gateway port> [--build <hex>] [--start]
#   (W3b's placement adds --configuration-only --instance --creator --directory, and --folder-store when the
#   directory's store is its folder rather than a bucket)
#
# It writes, for the world <name> (its world.json's):
#   /var/lib/souls/worlds/worlds/<name>/          the folder, copied (WORLDS_ROOT=/var/lib/souls/worlds, the unit's)
#   /etc/souls/gateway-<name>.env                 GATEWAYD_ARGS for souls-gateway@<name>: its port, the world's
#                                                 socket, its tokens file (the folder's `tokens`), its build, receipts,
#                                                 and its kind entries (the folder's `entries`, served to its paired
#                                                 clients at /v2/entries, #3760; gatewayd refuses to start without one),
#                                                 and the alarm daemon's socket to wake it by (--wake, O2), and the
#                                                 install's view key (--view-key /etc/souls/view.key, made here once
#                                                 when absent), which checks a signed-in page's view token, and
#                                                 the world's uploads folder (--uploads <folder>/uploads, #1960), where
#                                                 its creator's checked models and pictures are kept and served by hash
#   /etc/systemd/system/worldd@<name>.service.d/place.conf   WORLDD_SOCKET, the socket worldd serve binds
#   /etc/systemd/system/multi-user.target.wants/{worldd,souls-gateway}@<name>.service   the instances, enabled
#   /var/lib/souls/views/w/<name>/{views,history}  links the origin serves, so the page's ?world=<name> finds them
# It refuses, changing nothing, when the world is already placed. With --start (as root, PLACE_ROOT unset) it runs
# `systemctl daemon-reload` and starts both units; otherwise it starts nothing.
#
# PLACE_ROOT=<folder> stands in for / (the test places into an empty folder and starts nothing).
set -euo pipefail

die() {
  echo "place-world: $*" >&2
  exit 2
}

R=${PLACE_ROOT:-}
SRC='' NAME='' CREATOR='' PORT='' BUILD=unpinned START=0 RESUME=0 DIRECTORY=''
DATA_ONLY=0 CONFIG_ONLY=0 FOLDER_STORE=0
if [ "${1:-}" = --configuration-only ]; then CONFIG_ONLY=1; shift
else SRC=${1:-}; [ -n "$SRC" ] || die "a seeded folder is needed"; shift; fi
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT=$2; shift 2 ;;
    --build) BUILD=$2; shift 2 ;;
    --start) START=1; shift ;;
    --resume) RESUME=1; shift ;;
    --data-only) DATA_ONLY=1; shift ;;
    --instance) NAME=$2; shift 2 ;;
    --creator) CREATOR=$2; shift 2 ;;
    --directory) DIRECTORY=$2; shift 2 ;;
    --folder-store) FOLDER_STORE=1; shift ;;
    *) die "unknown argument $1" ;;
  esac
done
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "--port <n> is needed"
[[ "$BUILD" = unpinned || "$BUILD" =~ ^1220[0-9a-f]{64}$ ]] || die "--build is a pinned build hash"
if [ -n "$DIRECTORY" ]; then [[ "$DIRECTORY" =~ ^(127\.0\.0\.1|localhost):[0-9]+$ ]] || die "--directory is the installed loopback directory"; fi
[ "$CONFIG_ONLY" = 0 ] || [ "$DATA_ONLY" = 0 ] || die "placement modes conflict"
[ "$DATA_ONLY" = 0 ] || [ "$START" = 0 ] || die "data placement does not start units"
if [ "$CONFIG_ONLY" = 0 ]; then
  [ -f "$SRC/world.json" ] && [ ! -L "$SRC/world.json" ] || die "the source has no regular world.json"
  NAME=$(sed -n 's/.*"name": *"\([0-9a-f-]*\)".*/\1/p' "$SRC/world.json")
  if [ -n "$DIRECTORY" ]; then CREATOR=$(sed -n 's/.*"creator": *"\([0-9a-f-]*\)".*/\1/p' "$SRC/world.json"); fi
fi
[[ "$NAME" =~ ^[0-9a-f]{32}-[0-9a-f]{32}-[0-9]+$ ]] || die "no valid world instance"
if [ -n "$DIRECTORY" ]; then [[ "$CREATOR" =~ ^[0-9a-f]{32}-[0-9]+$ ]] || die "no valid world creator"; fi
DATA=/var/lib/souls
WORLD=$DATA/worlds/worlds/$NAME
SOCKET=$DATA/run/$NAME.sock
ENV=/etc/souls/gateway-$NAME.env
UNITS=/etc/systemd/system
DROPIN=$UNITS/worldd@$NAME.service.d/place.conf
WANTS=$UNITS/multi-user.target.wants
LINKS=$DATA/views/w/$NAME

if [ "$CONFIG_ONLY" = 0 ]; then
  [ ! -L "$R$WORLD" ] || die "world placement path is a symlink"
  if [ "$RESUME" = 0 ]; then [ ! -e "$R$WORLD" ] || die "already placed: world exists"; fi
  mkdir -p "$R$(dirname "$WORLD")" "$R$DATA/run" "$R$LINKS"
  if [ ! -e "$R$WORLD" ]; then
    # An interrupted copy is never served. Existing live world data is never overwritten during resume.
    STAGING=$(mktemp -d "$R$(dirname "$WORLD")/.placing-$NAME.XXXXXX")
    (cd "$SRC" && tar cf - --exclude ./gateway.sock --exclude ./views .) | (cd "$STAGING" && tar xf -)
    mv "$STAGING" "$R$WORLD"
  else
    for f in world.json facts.json boot; do
      if [ -f "$SRC/$f" ]; then cmp -s "$SRC/$f" "$R$WORLD/$f" || die "placed identity or public support differs"; fi
    done
  fi
  mkdir -p "$R$WORLD/views" "$R$WORLD/history" "$R$WORLD/receipts" "$R$WORLD/uploads"
  link() { if [ -L "$2" ]; then [ "$(readlink "$2")" = "$1" ] || die "placement link differs"; elif [ -e "$2" ]; then die "placement link is occupied"; else ln -s "$1" "$2"; fi; }
  link "$WORLD/views" "$R$LINKS/views"
  link "$WORLD/history" "$R$LINKS/history"
  if [ "$DATA_ONLY" = 0 ] && [ -z "$R" ] && id souls > /dev/null 2>&1; then chown -R souls:souls "$WORLD" "$DATA/run" "$LINKS"; fi
fi
if [ "$DATA_ONLY" = 0 ]; then
  # Configuration-only never reads or mutates DATA. Every identity above comes from the protected descriptor.
  for p in "$ENV" "$DROPIN"; do
    [ ! -L "$R$p" ] || die "unit configuration path is a symlink"
    if [ "$RESUME" = 0 ]; then [ ! -e "$R$p" ] || die "already placed: unit configuration exists"; fi
  done
  mkdir -p "$R/etc/souls" "$R$(dirname "$DROPIN")" "$R$WANTS"
  EXCHANGE=''; STORE=''
  # The world's store is the directory's (#1960 B7): with a bucket, the DIRECTORY_STORE_URL the install drop-in's
  # secrets file gives every worldd@; only a machine whose directory keeps a folder (--folder-store) names that folder.
  if [ -n "$DIRECTORY" ]; then EXCHANGE=" --creator $CREATOR --directory $DIRECTORY --creator-authority-required"; fi
  if [ -n "$DIRECTORY" ] && [ "$FOLDER_STORE" = 1 ]; then STORE=$(printf '\nEnvironment=WORLDD_STORE=%s' "$DATA/worlds/directory"); fi
  # --wake (O2, 0.133 S3b): an intent for the world while it sleeps is held and the alarm daemon asked to wake it.
  # --view-key (V13b): the directory's key for the page's view tokens (install.sh writes it once; made here too when
  # absent, so the gateway always starts); last, as the release owner appended it on soul.game (24 Nov).
  # --uploads (#1960): the creator's uploads, kept in the world's folder (the gateway makes it if missing; its checker
  # is the install's assets-check beside gatewayd); after the view key, as existing worlds' files gain it by hand.
  VIEW_KEY=/etc/souls/view.key
  if [ ! -e "$R$VIEW_KEY" ]; then
    (umask 077; od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > "$R$VIEW_KEY")
    if [ -z "$R" ] && getent group souls > /dev/null 2>&1; then chown root:souls "$VIEW_KEY"; fi
    chmod 640 "$R$VIEW_KEY"
  fi
  ENV_TEXT=$(printf 'GATEWAYD_ARGS=--listen 127.0.0.1:%s --world %s --tokens %s --build %s --receipts %s --entries %s --wake %s --world-name %s%s --view-key %s --uploads %s' "$PORT" "$SOCKET" "$WORLD/tokens" "$BUILD" "$WORLD/receipts" "$WORLD/entries" "$DATA/worlds/alarms.sock" "$NAME" "$EXCHANGE" "$VIEW_KEY" "$WORLD/uploads")
  DROP_TEXT=$(printf '# Written by place-world.sh (C1, #3365).\n[Service]\nEnvironment=WORLDD_SOCKET=%s%s' "$SOCKET" "$STORE")
  if [ -e "$R$ENV" ]; then [ "$(cat "$R$ENV")" = "$ENV_TEXT" ] || die "gateway configuration differs"; else printf '%s\n' "$ENV_TEXT" > "$R$ENV"; fi
  if [ -e "$R$DROPIN" ]; then [ "$(cat "$R$DROPIN")" = "$DROP_TEXT" ] || die "world configuration differs"; else printf '%s\n' "$DROP_TEXT" > "$R$DROPIN"; fi
  unit_link() { if [ -L "$2" ]; then [ "$(readlink "$2")" = "$1" ] || die "unit link differs"; elif [ -e "$2" ]; then die "unit link occupied"; else ln -s "$1" "$2"; fi; }
  unit_link "$UNITS/worldd@.service" "$R$WANTS/worldd@$NAME.service"
  unit_link "$UNITS/souls-gateway@.service" "$R$WANTS/souls-gateway@$NAME.service"
fi
echo "placed $NAME: worldd@$NAME, souls-gateway@$NAME"
if [ "$START" = 1 ]; then
  [ -z "$R" ] || die "--start places on this machine only"
  systemctl daemon-reload
  systemctl start "worldd@$NAME" "souls-gateway@$NAME"
fi
