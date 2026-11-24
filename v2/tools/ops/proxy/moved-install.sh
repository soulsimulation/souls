#!/usr/bin/env bash
# Installs soul-game-moved.caddy (beside this file) as the live soul.game front door, or puts the previous file back.
# The release owner runs it on the production host, as root, from a copy of this folder (a checkout or the live release):
#
#   sudo bash moved-install.sh install   # back up, write, validate, reload, check from loopback; undoes itself on a failure
#   sudo bash moved-install.sh undo      # the saved file back, validated, reloaded
#
# install, step by step; it stops with nothing changed at the first failed check:
#   1. reads today's launcher port and trusted_proxies from the live /etc/caddy/sites/soul-game.caddy;
#   2. checks the new system answers on loopback: the directory's pairing, each moved world's bootstrap at the viewers' origin,
#      the agents' relay, and the pairing card in the live release's web build;
#   3. copies the live file to /etc/caddy/soul-game.caddy.before-moved (outside sites/, so Caddy never imports it),
#      unless a copy is already there (a second install, say after W4 adds worlds, keeps the first original);
#   4. writes the new file, runs `caddy validate`; on a failure puts the saved file back and does not reload;
#   5. reloads Caddy, then asks the front door on this host for each moved world's bootstrap and an old world's page;
#      on a failure puts the saved file back and reloads again.
# The one-line undo, if this script is not at hand:
#   sudo cp -a /etc/caddy/soul-game.caddy.before-moved /etc/caddy/sites/soul-game.caddy && sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
#
# Every path and address below has the production default; moved-standin.mjs overrides them to run this same script
# against a scratch Caddy on this machine. Fake minds and scratch folders only there; nothing here reads a secret.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${SRC:-$here/soul-game-moved.caddy}"
ETC="${ETC:-/etc/caddy}"
LIVE="$ETC/sites/soul-game.caddy"
SAVED="${SAVED:-$ETC/soul-game.caddy.before-moved}"
CADDY="${CADDY:-caddy}"
RELOAD="${RELOAD:-systemctl reload caddy}"
SITE="${SITE:-https://soul.game}"
DIRECTORY="${DIRECTORY:-localhost:7310}"
ORIGIN="${ORIGIN:-localhost:7320}"
AGENTS="${AGENTS:-localhost:7330}"
WEB="${WEB:-/srv/sim-worlds/production/apps/web/dist}"
# How this host reaches its own front door: https://soul.game through loopback, unless FRONT names another address.
FRONT="${FRONT:-}"
OLD_WORLD="${OLD_WORLD:-mars-college-2027}"

say() { echo "moved-install: $*"; }
validate() { "$CADDY" validate --config "$ETC/Caddyfile" --adapter caddyfile >/dev/null 2>&1 || "$CADDY" validate --config "$ETC/Caddyfile" --adapter caddyfile; }
front() { # GET <path> through the front door; prints the status, then the X-Souls-System header's value
  local url
  if [ -n "$FRONT" ]; then url="$FRONT$1"; curl -s -o /dev/null -D - --max-time 10 "$url"
  else curl -s -o /dev/null -D - --max-time 10 --resolve "${SITE#https://}:443:127.0.0.1" "$SITE$1"; fi \
    | tr -d '\r' | awk 'NR==1{s=$2} tolower($1)=="x-souls-system:"{h=$2} END{print s" "(h?h:"today")}'
}
restore() { cp -a "$SAVED" "$LIVE" && say "the saved file is back at $LIVE"; }

case "${1:-}" in
install)
  [ -f "$SRC" ] || { say "no $SRC: nothing changed"; exit 1; }
  [ -f "$LIVE" ] || { say "no live $LIVE: nothing changed"; exit 1; }
  from="$LIVE"; [ -f "$SAVED" ] && from="$SAVED"
  PORT="$(grep -m1 -o 'reverse_proxy 127\.0\.0\.1:[0-9][0-9]* {' "$from" | sed 's/.*:\([0-9]*\) {/\1/')"
  PROXIES="$(sed -n 's/^[[:space:]]*trusted_proxies[[:space:]]\{1,\}\(.*[^[:space:]]\)[[:space:]]*$/\1/p' "$from" | head -1)"
  [[ "$PORT" =~ ^[0-9]+$ ]] || { say "no launcher port (reverse_proxy 127.0.0.1:<port> {) in $from: nothing changed"; exit 1; }
  [ -n "$PROXIES" ] || { say "no trusted_proxies in $from: nothing changed"; exit 1; }
  MOVED="$(sed -n 's/^[[:space:]]*@moved path_regexp moved \^\/w\/(\([a-z0-9|-]*\))\/.*/\1/p' "$SRC")"
  [ -n "$MOVED" ] || { say "no @moved list in $SRC: nothing changed"; exit 1; }
  say "launcher port $PORT, trusted proxies '$PROXIES', moved worlds: ${MOVED//|/ }"
  curl -fsS --max-time 10 -o /dev/null "http://$DIRECTORY/pair" || { say "the directory ($DIRECTORY) does not answer its pairing card: nothing changed"; exit 1; }
  for w in ${MOVED//|/ }; do
    curl -fsS --max-time 10 -H "Host: ${SITE#*://}" "http://$ORIGIN/w/$w/v1/bootstrap" | grep -q "\"gateway\":\"/w/$w/v2/ws\"" \
      || { say "the viewers' origin ($ORIGIN) gives no bootstrap for $w (is it canonical in the routes file?): nothing changed"; exit 1; }
  done
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$AGENTS/")"
  [ "$code" = 404 ] || { say "the agents' relay ($AGENTS) does not answer (got '$code', a 404 expected): nothing changed"; exit 1; }
  [ -f "$WEB/pair.html" ] || { say "no pairing card at $WEB/pair.html: nothing changed"; exit 1; }
  if [ -f "$SAVED" ]; then say "keeping the first saved file $SAVED"; else cp -a "$LIVE" "$SAVED" || { say "could not save $LIVE: nothing changed"; exit 1; }; say "saved $LIVE as $SAVED"; fi
  sed -e "s|@@LAUNCHER_PORT@@|$PORT|g" -e "s|@@TRUSTED_PROXIES@@|$PROXIES|g" \
      -e "s|localhost:7310|$DIRECTORY|g" -e "s|localhost:7320|$ORIGIN|g" -e "s|localhost:7330|$AGENTS|g" \
      -e "s|/srv/sim-worlds/production/apps/web/dist|$WEB|g" -e "s|^https://soul.game {|$SITE {|" "$SRC" > "$LIVE.new" \
    && mv "$LIVE.new" "$LIVE" || { restore; say "could not write $LIVE: Caddy NOT reloaded"; exit 1; }
  if ! validate; then restore; say "caddy validate failed: the saved file is back, Caddy NOT reloaded"; exit 1; fi
  $RELOAD || { restore; $RELOAD; say "the reload failed: the saved file is back"; exit 1; }
  sleep 1
  bad=0
  for w in ${MOVED//|/ }; do r="$(front "/w/$w/v1/bootstrap")"; say "front door /w/$w/v1/bootstrap: $r"; [ "$r" = "200 v2" ] || bad=1; done
  r="$(front "/w/$OLD_WORLD/v1/bootstrap")"; say "front door /w/$OLD_WORLD/v1/bootstrap (not moved): $r"; [ "${r#* }" = today ] || bad=1
  r="$(front "/")"; say "front door /: $r"; [ "${r#* }" = today ] || bad=1
  if [ "$bad" = 1 ]; then restore; $RELOAD; say "the front door did not answer as it should: the saved file is back and reloaded"; exit 1; fi
  say "installed; undo: sudo bash $here/moved-install.sh undo"
  ;;
undo)
  [ -f "$SAVED" ] || { say "no saved file $SAVED: nothing to undo"; exit 1; }
  restore || exit 1
  validate || { say "caddy validate failed on the saved file: Caddy NOT reloaded"; exit 1; }
  $RELOAD && say "undone; Caddy reloaded"
  ;;
*) echo "usage: moved-install.sh install|undo" >&2; exit 2 ;;
esac
