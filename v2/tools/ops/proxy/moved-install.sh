#!/usr/bin/env bash
# Installs soul-game-moved.caddy (beside this file) as the live soul.game front door, or puts the previous file back.
# The release owner runs it on the production host, as root, from a copy of this folder (a checkout or the live release):
#
#   bash moved-install.sh lines          # the right line for every world in worlds.json, and whether its bootstrap moves
#   sudo bash moved-install.sh install   # check, back up, write, validate, reload, check through the front door; undoes itself on a failure
#   sudo bash moved-install.sh undo      # the original file back (no moved world), validated, reloaded
#
# install, step by step; it stops with nothing changed at the first failed check:
#   1. reads today's launcher port and trusted_proxies from the original file (the live one at the first install);
#   2. checks on loopback: the directory's pairing card; for each `import moved-world|moved-gateway <slug> <port>` line,
#      that worlds.json names the loopback gateway on <port> for that world, that the line's kind matches the world's
#      `canonical` (moved-world for a canonical world, moved-gateway for any other), that the gatewayd there opens
#      /v2/ws (101), and for a moved-world line that the viewers' origin gives the bootstrap; and the pairing card file;
#      and it loads each moved world's page config through the front door as it is now (window.__simConfig);
#   3. keeps the file it replaces as /etc/caddy/soul-game.caddy.before-last-install, and the first original as
#      /etc/caddy/soul-game.caddy.before-moved (both outside sites/, so Caddy never imports them);
#   4. writes the new file, runs `caddy validate`; on a failure puts the replaced file back and does not reload;
#   5. reloads Caddy, then through the front door: each moved world's /w/<slug>/v2/ws opens (101); a moved-world's
#      bootstrap comes from the new system and a moved-gateway's from the launcher; each page config that loaded
#      before still loads, for its own world; an unmoved world's path and / reach the launcher. On a failure it puts
#      the replaced file back and reloads again.
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
PREVIOUS="${PREVIOUS:-$ETC/soul-game.caddy.before-last-install}"
CADDY="${CADDY:-caddy}"
RELOAD="${RELOAD:-systemctl reload caddy}"
SITE="${SITE:-https://soul.game}"
SITE_LINE="${SITE_LINE:-$SITE}"   # the installed site block's addresses
# Trust for the front-door checks: the system's, unless CURL_CA names a CA file (the stand-in's local CA)
CA=(); [ -n "${CURL_CA:-}" ] && CA=(--cacert "$CURL_CA")
DIRECTORY="${DIRECTORY:-localhost:7310}"
ORIGIN="${ORIGIN:-localhost:7320}"
ROUTES="${ROUTES:-/var/lib/souls/routes/worlds.json}"
WEB="${WEB:-/srv/sim-worlds/production/apps/web/dist}"
# How this host reaches its own front door: https://soul.game through loopback, unless FRONT names another address.
FRONT="${FRONT:-}"
OLD_WORLD="${OLD_WORLD:-no-such-moved-world}"

say() { echo "moved-install: $*"; }
validate() { "$CADDY" validate --config "$ETC/Caddyfile" --adapter caddyfile >/dev/null 2>&1 || "$CADDY" validate --config "$ETC/Caddyfile" --adapter caddyfile; }
via() { # curl <args...> <path> through the front door
  local path="${*: -1}"; set -- "${@:1:$#-1}"
  if [ -n "$FRONT" ]; then curl -s ${CA[@]+"${CA[@]}"} "$@" "$FRONT$path"
  else curl -s ${CA[@]+"${CA[@]}"} "$@" --resolve "${SITE#https://}:443:127.0.0.1" "$SITE$path"; fi
}
front() { # GET <path> through the front door; prints the status, then the X-Souls-System header's value
  via -o /dev/null -D - --max-time 10 "$1" | tr -d '\r' | awk 'NR==1{s=$2} tolower($1)=="x-souls-system:"{h=$2} END{print s" "(h?h:"today")}'
}
key() { openssl rand -base64 16; }   # a fresh Sec-WebSocket-Key for each request
upgrade() { # the status a WebSocket upgrade of <url> gets (101 when a socket opens); curl then waits, so it is cut at 3 s.
  # HTTP/1.1 always: over https curl would negotiate HTTP/2, where an Upgrade request is invalid (400, 24 Nov)
  curl -s ${CA[@]+"${CA[@]}"} --http1.1 -o /dev/null -w '%{http_code}' --max-time 3 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
    -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $(key)" "$@" || true
}
front_upgrade() { if [ -n "$FRONT" ]; then upgrade "$FRONT$1"; else upgrade --resolve "${SITE#https://}:443:127.0.0.1" "$SITE$1"; fi; }
route_of() { # "<gateway> <canonical true|false>" for world <slug> in worlds.json; nothing when it is not there or archived
  node -e 'const w=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).worlds?.[process.argv[2]]; if (w && !w.archived) console.log(`${w.gateway} ${w.canonical === true}`)' "$ROUTES" "$1"
}
page() { # the page config world <slug>'s page carries (what the browser opens it with): "ok" or why not
  via -H 'Accept: text/html' --max-time 15 "/w/$1/" | node -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      const m = /<script>window\.__simConfig=(\{.*?\})<\/script>/s.exec(s), w = process.argv[1];
      let c; try { c = m && JSON.parse(m[1]); } catch { c = null; }
      if (!c) return console.log("no page config");
      if (c.worldKey !== w || typeof c.worldId !== "string" || !c.worldId || c.worldPath !== `/w/${w}`) return console.log(`another world: ${c.worldKey} ${c.worldPath}`);
      console.log("ok");
    });' "$1"
}
restore() { cp -a "$1" "$LIVE" && say "$1 is back at $LIVE"; }

case "${1:-}" in
install)
  [ -f "$SRC" ] || { say "no $SRC: nothing changed"; exit 1; }
  [ -f "$LIVE" ] || { say "no live $LIVE: nothing changed"; exit 1; }
  [ -f "$ROUTES" ] || { say "no $ROUTES: nothing changed"; exit 1; }
  from="$LIVE"; [ -f "$SAVED" ] && from="$SAVED"
  PORT="$(grep -m1 -o 'reverse_proxy 127\.0\.0\.1:[0-9][0-9]* {' "$from" | sed 's/.*:\([0-9]*\) {/\1/')"
  PROXIES="$(sed -n 's/^[[:space:]]*trusted_proxies[[:space:]]\{1,\}\(.*[^[:space:]]\)[[:space:]]*$/\1/p' "$from" | head -1)"
  [[ "$PORT" =~ ^[0-9]+$ ]] || { say "no launcher port (reverse_proxy 127.0.0.1:<port> {) in $from: nothing changed"; exit 1; }
  [ -n "$PROXIES" ] || { say "no trusted_proxies in $from: nothing changed"; exit 1; }
  LINES="$(sed -nE 's/^[[:space:]]*import moved-(world|gateway) ([a-z0-9][a-z0-9-]*) ([0-9]+)[[:space:]]*$/\1 \2 \3/p' "$SRC")"
  [ -n "$LINES" ] || { say "no 'import moved-world|moved-gateway <slug> <port>' line in $SRC: nothing changed"; exit 1; }
  say "launcher port $PORT, trusted proxies '$PROXIES', moved worlds: $(echo "$LINES" | cut -d' ' -f2 | tr '\n' ' ')"
  curl -fsS --max-time 10 -o /dev/null "http://$DIRECTORY/pair" || { say "the directory ($DIRECTORY) does not answer its pairing card: nothing changed"; exit 1; }
  BEFORE=""
  while read -r kind w p; do
    read -r g canonical <<< "$(route_of "$w")"
    [ "$g" = "http://127.0.0.1:$p" ] || [ "$g" = "http://localhost:$p" ] \
      || { say "$w: the line says gatewayd on port $p, but $ROUTES says '${g:-no such world}': fix the line (\`bash moved-install.sh lines\`); nothing changed"; exit 1; }
    want=gateway; [ "$canonical" = true ] && want=world
    [ "$kind" = "$want" ] || { say "$w: canonical is $canonical in $ROUTES, so its line is 'import moved-$want $w $p', not moved-$kind (\`bash moved-install.sh lines\`); nothing changed"; exit 1; }
    code="$(upgrade "http://127.0.0.1:$p/v2/ws")"
    [ "$code" = 101 ] || { say "$w: its gatewayd on port $p does not open /v2/ws (got '$code', 101 expected): nothing changed"; exit 1; }
    if [ "$kind" = world ]; then
      curl -fsS --max-time 10 -H "Host: ${SITE#*://}" "http://$ORIGIN/w/$w/v1/bootstrap" | grep -q "\"gateway\":\"/w/$w/v2/ws\"" \
        || { say "$w: the viewers' origin ($ORIGIN) gives no bootstrap: nothing changed"; exit 1; }
    fi
    pg="$(page "$w")"; [ "$pg" = ok ] && BEFORE="$BEFORE $w"
    say "$w: gatewayd on port $p opens /v2/ws (101); bootstrap $([ "$kind" = world ] && echo 'moves (canonical)' || echo 'stays on the launcher (not canonical)'); page config now: $pg"
  done <<< "$LINES"
  [ -f "$WEB/pair.html" ] || { say "no pairing card at $WEB/pair.html: nothing changed"; exit 1; }
  cp -a "$LIVE" "$PREVIOUS" || { say "could not save $LIVE: nothing changed"; exit 1; }
  if [ -f "$SAVED" ]; then say "the replaced file is $PREVIOUS; the original stays $SAVED"; else cp -a "$LIVE" "$SAVED" || { say "could not save $LIVE: nothing changed"; exit 1; }; say "saved $LIVE as $SAVED"; fi
  # values go into directives only, never into the comments
  sed -e "/^[[:space:]]*#/!s|@@LAUNCHER_PORT@@|$PORT|g" -e "/^[[:space:]]*#/!s|@@TRUSTED_PROXIES@@|$PROXIES|g" \
      -e "/^[[:space:]]*#/!s|localhost:7310|$DIRECTORY|g" -e "/^[[:space:]]*#/!s|localhost:7320|$ORIGIN|g" \
      -e "s|/srv/sim-worlds/production/apps/web/dist|$WEB|g" -e "s|^https://soul.game {|$SITE_LINE {|" "$SRC" > "$LIVE.new" \
    && mv "$LIVE.new" "$LIVE" || { restore "$PREVIOUS"; say "could not write $LIVE: Caddy NOT reloaded"; exit 1; }
  if ! validate; then restore "$PREVIOUS"; say "caddy validate failed: the replaced file is back, Caddy NOT reloaded"; exit 1; fi
  $RELOAD || { restore "$PREVIOUS"; $RELOAD; say "the reload failed: the replaced file is back"; exit 1; }
  sleep 1
  bad=0
  while read -r kind w p; do
    r="$(front_upgrade "/w/$w/v2/ws")"; say "front door /w/$w/v2/ws: $r"; [ "$r" = 101 ] || bad=1
    r="$(front "/w/$w/v1/bootstrap")"
    if [ "$kind" = world ]; then say "front door /w/$w/v1/bootstrap: $r"; [ "$r" = "200 v2" ] || bad=1
    else say "front door /w/$w/v1/bootstrap (not canonical): $r"; [ "${r#* }" = today ] || bad=1; fi
    pg="$(page "$w")"; say "front door /w/$w/ page config: $pg"
    case " $BEFORE " in *" $w "*) [ "$pg" = ok ] || bad=1 ;; *) [ "$pg" = ok ] || say "$w: its page did not load before this install either; not this file's doing" ;; esac
  done <<< "$LINES"
  r="$(front "/w/$OLD_WORLD/v1/bootstrap")"; say "front door /w/$OLD_WORLD/v1/bootstrap (not moved): $r"; [ "${r#* }" = today ] || bad=1
  r="$(front "/")"; say "front door /: $r"; [ "${r#* }" = today ] || bad=1
  if [ "$bad" = 1 ]; then restore "$PREVIOUS"; $RELOAD; say "the front door did not answer as it should: the replaced file is back and reloaded"; exit 1; fi
  say "installed; back one install: restore $PREVIOUS; to the original: sudo bash $here/moved-install.sh undo"
  ;;
undo)
  [ -f "$SAVED" ] || { say "no saved file $SAVED: nothing to undo"; exit 1; }
  restore "$SAVED" || exit 1
  validate || { say "caddy validate failed on the saved file: Caddy NOT reloaded"; exit 1; }
  $RELOAD && say "undone; Caddy reloaded"
  ;;
lines)
  node -e 'for (const [w, e] of Object.entries(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).worlds ?? {})) {
    if (e.archived) continue;
    const port = new URL(e.gateway).port, c = e.canonical === true;
    console.log(`  # ${w}: bootstrap ${c ? "moves (canonical)" : "stays on the launcher (not canonical)"}\n  import moved-${c ? "world" : "gateway"} ${w} ${port}`);
  }' "$ROUTES"
  ;;
*) echo "usage: moved-install.sh install|undo|lines" >&2; exit 2 ;;
esac
