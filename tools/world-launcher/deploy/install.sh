#!/usr/bin/env bash
# One-time, idempotent setup of the world launcher on eden2. Run as root ON THE BOX:
#   bash install.sh            (release.sh copies it to /srv/sim-worlds/install.sh and runs it)
# Creates the unprivileged user, its dirs, the systemd unit and per-stage settings. It never starts
# anything, never edits an existing settings file, and never touches /opt/eden3, the sim or mars users,
# the existing release's /srv/sim and /srv/sim-data*, Caddy, DNS or the firewall.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"

# #2233 A5: `bash install.sh capacity <stage> <GB>` sets how much memory a stage's worlds may use, and nothing else. Run only
# by name (an ordinary release never runs it; release.sh --capacity <GB> calls it once). It rewrites the stage's memory
# drop-in (MemoryHigh at the figure, MemoryMax 2 GB above) and, in <stage>.conf, --worlds-mem-mb (2 GB below the figure),
# --max-running (the worlds that fit at a small world's settled memory), a --range of two ports per such world above the
# stage's --port, and --max-worlds (at least twice --max-running), then prints what it changed. It takes effect at the
# stage's next restart. SIM_ETC and SIM_UNIT_DIR point it at a scratch copy (no daemon-reload then).
if [ "${1:-}" = capacity ]; then
  STAGE="${2:-}"; GB="${3:-}"
  case "$STAGE" in staging|production) ;; *) echo "usage: $0 capacity <staging|production> <GB>"; exit 2;; esac
  [[ "$GB" =~ ^[0-9]+$ ]] && [ "$GB" -ge 4 ] || { echo "capacity: <GB> must be a whole number, at least 4 (got '$GB')"; exit 2; }
  ETC="${SIM_ETC:-/etc/sim-worlds}"; UNITS="${SIM_UNIT_DIR:-/etc/systemd/system}"
  CONF="$ETC/$STAGE.conf"; DROP="$UNITS/sim-worlds@$STAGE.service.d/10-memory.conf"
  [ -f "$CONF" ] || { echo "capacity: no $CONF (run install.sh first)"; exit 1; }
  SMALL_SETTLED_MB=250   # a small world's settled memory (Pss), measured in #2240
  MEM=$(( (GB - 2) * 1024 )); RUN=$(( MEM / SMALL_SETTLED_MB ))
  ARGS="$(sed -n 's/^SIM_WORLDS_ARGS=//p' "$CONF")"
  get_arg() { printf '%s\n' "$ARGS" | sed -nE "s/(^|.* )--$1 ([^ ]+).*/\2/p"; }
  set_arg() { if [ -n "$(get_arg "$1")" ]; then ARGS="$(printf '%s\n' "$ARGS" | sed -E "s/(^| )--$1 [^ ]+/\1--$1 $2/")"; else ARGS="$ARGS --$1 $2"; fi; }
  PORT="$(get_arg port)"; [[ "$PORT" =~ ^[0-9]+$ ]] || { echo "capacity: $CONF has no --port"; exit 1; }
  LO=$(( PORT + 1 )); HI=$(( PORT + 2 * RUN ))
  # never into another stage's port or ports
  for other in "$ETC"/*.conf; do
    [ "$other" = "$CONF" ] && continue
    oa="$(sed -n 's/^SIM_WORLDS_ARGS=//p' "$other")"; [ -n "$oa" ] || continue
    op="$(printf '%s\n' "$oa" | sed -nE 's/(^|.* )--port ([0-9]+).*/\2/p')"; orange="$(printf '%s\n' "$oa" | sed -nE 's/(^|.* )--range ([0-9]+-[0-9]+).*/\2/p')"
    olo="${orange%-*}"; ohi="${orange#*-}"; [ -n "$orange" ] || { olo="$op"; ohi="$op"; }
    [ -n "$op" ] && [ "$op" -lt "${olo:-$op}" ] && olo="$op"; [ -n "$op" ] && [ "$op" -gt "${ohi:-$op}" ] && ohi="$op"
    if [ -n "$olo" ] && [ "$HI" -ge "$olo" ] && [ "$PORT" -le "$ohi" ]; then echo "capacity: ports $PORT-$HI would overlap $(basename "$other" .conf)'s $olo-$ohi; nothing changed"; exit 1; fi
  done
  OLDWORLDS="$(get_arg max-worlds)"; WORLDS=$(( 2 * RUN )); [ -n "$OLDWORLDS" ] && [ "$OLDWORLDS" -gt "$WORLDS" ] && WORLDS="$OLDWORLDS"
  BEFORE="$ARGS"; OLDDROP="$(cat "$DROP" 2>/dev/null || echo '(none)')"
  set_arg worlds-mem-mb "$MEM"; set_arg max-running "$RUN"; set_arg max-worlds "$WORLDS"; set_arg range "$LO-$HI"
  TMP="$(mktemp)"; sed "s|^SIM_WORLDS_ARGS=.*|SIM_WORLDS_ARGS=$ARGS|" "$CONF" > "$TMP"; cat "$TMP" > "$CONF"; rm -f "$TMP"   # (cat: the file keeps its owner and mode)
  install -d "$(dirname "$DROP")"; printf '[Service]\nMemoryHigh=%sG\nMemoryMax=%sG\n' "$GB" "$(( GB + 2 ))" > "$DROP"
  echo "capacity $STAGE: worlds may use $GB GB"
  echo "  $DROP"; printf '%s\n' "$OLDDROP" | sed 's/^/    was  /'; sed 's/^/    now  /' "$DROP"
  echo "  $CONF SIM_WORLDS_ARGS"; echo "    was  $BEFORE"; echo "    now  $ARGS"
  echo "  --worlds-mem-mb $MEM, --max-running $RUN, --max-worlds $WORLDS, --range $LO-$HI ($(( 2 * RUN )) ports: two per world)"
  [ -n "${SIM_UNIT_DIR:-}" ] || systemctl daemon-reload
  echo "takes effect at the next restart of sim-worlds@$STAGE (release.sh --capacity restarts it)"
  exit 0
fi

UNIT_SRC="${UNIT_SRC:-$HERE/sim-worlds@.service}"

id simworlds >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/simworlds --shell /usr/sbin/nologin simworlds
install -d -o simworlds -g simworlds -m 750 /srv/sim-worlds /srv/sim-worlds/releases
install -d -o simworlds -g simworlds -m 750 /srv/sim-worlds-data /srv/sim-worlds-data/staging /srv/sim-worlds-data/production
install -d -o root -g simworlds -m 750 /etc/sim-worlds

# Per-stage settings: ports and caps only (no secrets). Existing files are kept as they are.
# eden2 (cpx42): 16 GB RAM, ~10 GB available with eden3 + the existing Sim release running; a new world's
# server idles at ~250-350 MB RSS. Production: 24 running worlds in a 6 GB cgroup (~250 MB each), 60
# registered (sleeping worlds cost only disk), and no world boots while the host has under 2.5 GB free.
# Staging: small, for the rehearsal party; stop it when production is live.
# Heap: --world-heap-mb is only the default (1536 MB); a world's registry entry `worldHeapMb` wins (op.mjs set-heap) and
# Eden-2026-class worlds get 2048 MB (registry.mjs worldHeapMb; LOAD-CONTRACT §4). The old launcher-wide cap was too small for Eden 2026 (10-31).
if [ ! -f /etc/sim-worlds/staging.conf ]; then
  cat > /etc/sim-worlds/staging.conf <<'CONF'
# sim-worlds@staging: localhost only, dev auth (staging check before the account provider is merged).
SIM_WORLDS_ARGS=--base /worlds --port 4600 --range 4601-4619 --data /srv/sim-worlds-data/staging --dev-auth --max-worlds 20 --max-running 8 --min-free-mb 2500 --world-heap-mb 1536 --create-limit 20 --mars-web /srv/sim-worlds/staging/mars-web --eager 2
CONF
fi
if [ ! -f /etc/sim-worlds/production.conf ]; then
  cat > /etc/sim-worlds/production.conf <<'CONF'
# sim-worlds@production: behind Caddy on https://sim.eden.art for /worlds* only (one prefix; nothing else of the origin).
# /etc/sim-worlds/production-auth.env is a PLACEHOLDER path: Codex or Gene provisions it (CLERK_PUBLISHABLE_KEY,
# CLERK_ISSUER_URL=https://clerk.eden.art, CLERK_AUTHORIZED_PARTIES=https://sim.eden.art; no secret key). Each world's node
# loads it by path (--env-file); the launcher only reads the publishable key and issuer. Never copied from /opt/eden3.
SIM_WORLDS_ARGS=--base /worlds --port 4620 --range 4621-4659 --data /srv/sim-worlds-data/production --public-origin https://sim.eden.art --auth-env /etc/sim-worlds/production-auth.env --max-worlds 60 --max-running 24 --min-free-mb 2500 --world-heap-mb 1536 --create-limit 6 --mars-web /srv/sim-worlds/production/mars-web --eager 4
CONF
fi
chown root:simworlds /etc/sim-worlds/*.conf && chmod 640 /etc/sim-worlds/*.conf
# The Soul CLI 1.9 and its guides ship inside each release (tools/world-launcher/soul/, pinned by sha in SOURCES.json),
# so no --soul-* flags are needed. Nightly backup destination (restic repository /srv/sim-worlds-backups/restic: created once
# by hand with `restic init`, never here, so a missing disk can't start an empty one; settings in /etc/sim-worlds/backup.env,
# see backup.env.example; its password /etc/sim-worlds/restic.pass root:simworlds 0640 is provisioned once, never by this script):
install -d -o simworlds -g simworlds -m 750 /srv/sim-worlds-backups

install -m 644 "$UNIT_SRC" /etc/systemd/system/sim-worlds@.service
# Memory budget per stage: written once, never overwritten (release.sh runs this on every release; an operator's raise,
# e.g. production 8G/9G on 2026-10-17, must survive it). legacy = the three original worlds.
mem() { local d=/etc/systemd/system/sim-worlds@$1.service.d; install -d "$d"; [ -f "$d/10-memory.conf" ] || printf '[Service]\nMemoryHigh=%s\nMemoryMax=%s\n' "$2" "$3" > "$d/10-memory.conf"; }
mem staging 2500M 3G; mem production 8G 9G
install -m 644 "$HERE/sim-worlds-backup@.service" /etc/systemd/system/sim-worlds-backup@.service
install -m 644 "$HERE/sim-worlds-backup@.timer" /etc/systemd/system/sim-worlds-backup@.timer
install -m 644 "$HERE/sim-worlds-health@.service" /etc/systemd/system/sim-worlds-health@.service
install -m 644 "$HERE/sim-worlds-health@.timer" /etc/systemd/system/sim-worlds-health@.timer
systemctl daemon-reload
echo "installed: user simworlds, /srv/sim-worlds{,-data}, /etc/sim-worlds/{staging,production}.conf, sim-worlds@.service, sim-worlds-{backup,health}@.{service,timer} (nothing started)"
