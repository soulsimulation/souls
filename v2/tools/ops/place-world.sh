#!/usr/bin/env bash
# Places a seeded world on this machine (Engine v2 C1, #3365): `worldd seed` made the folder; this puts it where
# `supervisor launch <name>` finds it and writes what its two units read. Runbook: v2/docs/runbook/place-a-world.md.
#
#   bash place-world.sh <seeded folder> --port <gateway port> [--build <hex>] [--start]
#
# It writes, for the world <name> (its world.json's):
#   /var/lib/souls/worlds/worlds/<name>/          the folder, copied (WORLDS_ROOT=/var/lib/souls/worlds, the unit's)
#   /etc/souls/gateway-<name>.env                 GATEWAYD_ARGS for souls-gateway@<name>: its port, the world's
#                                                 socket, its tokens file (the folder's `tokens`), its build, receipts
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
SRC=${1:-}
[ -n "$SRC" ] && [ -f "$SRC/world.json" ] || die "usage: place-world.sh <seeded folder> --port <n> [--build <hex>] [--start]"
shift
PORT='' BUILD=unpinned START=0
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT=$2; shift 2 ;;
    --build) BUILD=$2; shift 2 ;;
    --start) START=1; shift ;;
    *) die "unknown argument $1" ;;
  esac
done
[[ "$PORT" =~ ^[0-9]+$ ]] || die "--port <n> is needed"
NAME=$(sed -n 's/.*"name": *"\([0-9a-f-]*\)".*/\1/p' "$SRC/world.json")
[[ "$NAME" =~ ^[0-9a-f]{32}-[0-9a-f]{32}-[0-9]+$ ]] || die "world.json names no world"

DATA=/var/lib/souls
WORLD=$DATA/worlds/worlds/$NAME
SOCKET=$DATA/run/$NAME.sock
ENV=/etc/souls/gateway-$NAME.env
UNITS=/etc/systemd/system
DROPIN=$UNITS/worldd@$NAME.service.d/place.conf
WANTS=$UNITS/multi-user.target.wants
LINKS=$DATA/views/w/$NAME

for p in "$WORLD" "$ENV" "$DROPIN"; do
  [ ! -e "$R$p" ] || die "already placed: $p exists"
done

mkdir -p "$R$(dirname "$WORLD")" "$R$DATA/run" "$R/etc/souls" "$R$(dirname "$DROPIN")" "$R$WANTS" "$R$LINKS"
mkdir -p "$R$WORLD"
# The folder as seeded, less a socket a local run left (sockets are not copied) and its stream (rebuilt at each start).
(cd "$SRC" && tar cf - --exclude ./gateway.sock --exclude ./views .) | (cd "$R$WORLD" && tar xf -)
mkdir -p "$R$WORLD/views" "$R$WORLD/history" "$R$WORLD/receipts"
printf 'GATEWAYD_ARGS=--listen 127.0.0.1:%s --world %s --tokens %s --build %s --receipts %s\n' \
  "$PORT" "$SOCKET" "$WORLD/tokens" "$BUILD" "$WORLD/receipts" > "$R$ENV"
printf '# Written by place-world.sh (C1, #3365).\n[Service]\nEnvironment=WORLDD_SOCKET=%s\n' "$SOCKET" > "$R$DROPIN"
ln -s "$UNITS/worldd@.service" "$R$WANTS/worldd@$NAME.service"
ln -s "$UNITS/souls-gateway@.service" "$R$WANTS/souls-gateway@$NAME.service"
ln -s "$WORLD/views" "$R$LINKS/views"
ln -s "$WORLD/history" "$R$LINKS/history"
if [ -z "$R" ] && id souls > /dev/null 2>&1; then
  chown -R souls:souls "$WORLD" "$DATA/run" "$LINKS"
fi
echo "placed $NAME: worldd@$NAME, souls-gateway@$NAME on 127.0.0.1:$PORT, page ?world=$NAME"
if [ "$START" = 1 ]; then
  [ -z "$R" ] || die "--start places on this machine only (PLACE_ROOT is set)"
  systemctl daemon-reload
  systemctl start "worldd@$NAME" "souls-gateway@$NAME"
fi
