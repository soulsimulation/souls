#!/usr/bin/env bash
# The cut-over (Engine v2 X7, #2836): Eden moves behind the same public name to the new engine, and comes back, each
# by one command, run as root on the production host from the live release. Procedure and declaration:
# v2/docs/cutover.md.
#
#   bash cutover.sh check     the preconditions only; changes nothing
#   bash cutover.sh switch    check, then: today's feed items into the new system's news, O19's front door (the
#                             SWITCH script in v2/tools/ops/proxy/README.md, run as written), the record
#   bash cutover.sh back      O19's BACK script, the record, and the count of accounts and Souls made since the switch
#
# The switch changes the proxy's site files, the front door's map and its timer, and nothing else: no DNS, no world,
# no store. The rollback is the front door pointing back at today's system, which kept running; the new system keeps
# running too, untouched, and what it holds returns at the next switch. Each step it takes is a line in
# /var/lib/souls/cutover/log.jsonl, the cut-over's history.
#
# /etc/souls/cutover.env names the world that moves: SLUG (its public slug, default eden) and WORLD (the new system's
# world, as `place-world.sh` placed it). CUTOVER_ROOT=<folder> stands in for / and CUTOVER_DIRECTORY for the
# directory's address on a scratch host (rehearse.mjs); otherwise both are production's.
set -uo pipefail

R=${CUTOVER_ROOT:-}
DIRECTORY=${CUTOVER_DIRECTORY:-http://localhost:7310}
RELEASE=$R/srv/sim-worlds/production
PROXY=$RELEASE/v2/tools/ops/proxy
HERE=$(cd "$(dirname "$0")" && pwd)
LOG=$R/var/lib/souls/cutover/log.jsonl
NEWS=$R/var/lib/souls/news.jsonl
SUN_PATH=108   # Linux's sockaddr_un: a socket path is at most 107 bytes and its NUL

die() {
  echo "cutover: $*" >&2
  exit 1
}

# The README's script `name`, as root runs it on production; on a scratch host with its folders and directory.
o19() {
  local body
  body=$(awk -v n="$1" '$0 == "bash -s <<'"'"'" n "'"'"'" {on = 1; next} on && $0 == n {exit} on' "$PROXY/README.md")
  [ -n "$body" ] || die "the live release's proxy README has no $1 script: ship a release that carries O19"
  if [ "$1" = SWITCH ]; then
    # State.prepare fsyncs the first backup; retrying the reviewed script must not overwrite it.
    body=${body/'cp -a /etc/caddy/sites/soul-game.caddy /etc/caddy/soul-game.caddy.before-o19'/'[ -f /etc/caddy/soul-game.caddy.before-o19 ] || cp -a /etc/caddy/sites/soul-game.caddy /etc/caddy/soul-game.caddy.before-o19'}
  fi
  if [ -n "$R" ]; then
    body=${body//\/etc\//$R/etc/}
    body=${body//\/srv\/sim-worlds\/production/$RELEASE}
    body=${body//localhost:7310/${DIRECTORY#http://}}
  fi
  bash -s <<< "$body"
}

settings() {
  local f
  [ -f "$R/etc/souls/cutover.env" ] || die "no /etc/souls/cutover.env: write SLUG=eden and WORLD=<the new system's Eden> (cutover.md)"
  # shellcheck disable=SC1091 # the host's file, two names
  . "$R/etc/souls/cutover.env"
  SLUG=${SLUG:-eden}
  WORLD=${WORLD:-}
  [[ "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "cutover.env: SLUG is a slug"
  [[ "$WORLD" =~ ^[0-9a-f]{32}-[0-9a-f]{32}-[0-9]+$ ]] || die "cutover.env: WORLD is a placed world's name"
  for f in secrets.env directory.env; do [ -f "$R/etc/souls/$f" ] && SETTINGS+=("$R/etc/souls/$f"); done
}
SETTINGS=()

# Is NAME set (non-empty) in the new system's settings files? Values are never printed.
named() { [ ${#SETTINGS[@]} -gt 0 ] && grep -Eq "^(export )?$1=.+" "${SETTINGS[@]}"; }

# Every precondition, each refusal by name; nothing is changed.
check() {
  local bad=0 sock n tokens
  no() {
    echo "  refused: $*"
    bad=1
  }
  echo "cutover: check for $SLUG (the new system's world ${WORLD:0:12}…)"
  [ -n "$R" ] || [ "$(id -u)" = 0 ] || no "run it as root"
  [ -f "$PROXY/soul-game.caddy" ] && [ -f "$PROXY/README.md" ] || no "the live release carries no front door ($PROXY)"
  curl -fsS --max-time 5 "$DIRECTORY/v1/worlds" 2> /dev/null | grep -q "\"name\": *\"$SLUG\"" || no "the directory does not list $SLUG"
  systemctl is-active --quiet "worldd@$WORLD.service" || no "worldd@<world> is not running"
  systemctl is-active --quiet "souls-gateway@$WORLD.service" || no "souls-gateway@<world> is not running"
  # The front door sends agents' sockets to the agents' relay (#4152): without it, agents get 502 after the reload.
  systemctl is-active --quiet souls-agents.service || no "souls-agents (the agents' relay, 7330) is not running"
  sock=$(sed -n 's/^Environment=WORLDD_SOCKET=//p' "$R/etc/systemd/system/worldd@$WORLD.service.d/place.conf" 2> /dev/null)
  if [ -z "$sock" ]; then no "the world is not placed (no WORLDD_SOCKET in its place.conf)"; else
    n=$(printf %s "$sock" | wc -c | tr -d ' ')
    [ "$n" -lt "$SUN_PATH" ] || no "its socket path is $n bytes, Linux takes at most $((SUN_PATH - 1))"
    echo "  socket path: $n bytes of $((SUN_PATH - 1))"
  fi
  # W11b (#3558): worldd serve reads tokens.souls (retires and names from the owner's page) in its world folder, which
  # the directory writes beside the gateway's tokens file it is given.
  tokens=/var/lib/souls/worlds/worlds/$WORLD/tokens
  n=$(sed -n 's/.*--gateway-tokens \([^ "]*\).*/\1/p' "$R/etc/souls/directory.args" 2> /dev/null)
  [ "$n" = "$tokens" ] || no "the directory's --gateway-tokens is not the world folder's tokens file, so worldd serve never sees tokens.souls (set it in directory.args, or start worldd serve with --directory <that file>)"
  [ -f "$R$tokens" ] || no "the world folder has no tokens file"
  for n in SOULS_BACKUP_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY SOULS_BACKUP_KEY_FILE; do named "$n" || no "$n is not set in /etc/souls/secrets.env"; done
  named DIRECTORY_STORE_URL || named WORLDD_STORE || no "neither DIRECTORY_STORE_URL nor WORLDD_STORE is set: the world's history would ship nowhere"
  grep -qFx 'cp -a /etc/caddy/sites/soul-game.caddy /etc/caddy/soul-game.caddy.before-o19' "$PROXY/README.md" || no "the reviewed front-door backup seam changed"
  [ "$bad" = 0 ] && echo "cutover: check passed" && return 0
  echo "cutover: check refused; nothing changed"
  return 1
}

# Today's feed items (its notice of the move among them) into the new system's news, each line once.
news() {
  local data feed added=0 l
  data=$(sed -n 's/.*--data \([^ "]*\).*/\1/p' "$R/etc/sim-worlds/production.conf" 2> /dev/null)
  feed=$R$data/feed.jsonl
  [ -n "$data" ] && [ -f "$feed" ] || {
    echo "  news: today's feed has no items to carry"
    return 0
  }
  mkdir -p "$(dirname "$NEWS")" && touch "$NEWS"
  while IFS= read -r l; do
    [ -n "$l" ] || continue
    grep -qxF -- "$l" "$NEWS" || {
      printf '%s\n' "$l" >> "$NEWS"
      added=$((added + 1))
    }
  done < "$feed"
  chown souls:souls "$NEWS" 2> /dev/null || true
  echo "  news: $added of today's feed items carried into the new system's news"
}

quiesce_routes() {
  local unit
  for unit in souls-routes.timer souls-routes.service; do
    if systemctl cat "$unit" > /dev/null 2>&1; then systemctl stop "$unit" || return 1; fi
  done
}

cmd=${1:-}
settings
export SLUG WORLD
case $cmd in
  check|switch|back) node "$HERE/state.mjs" "$cmd" "$0" ;;
  __check) check ;;
  __news) news ;;
  __switch-route)
    quiesce_routes || die "cannot quiesce the route writer; old writes remain fenced"
    o19 SWITCH || exit 1
    [ -f "$R/var/lib/souls-routes/slugs/$SLUG" ] || die "the switched map does not contain the world; old writes remain fenced"
    ;;
  __back-route)
    quiesce_routes || die "cannot quiesce the route writer; old writes remain fenced"
    o19 BACK || exit 1
    quiesce_routes || die "cannot confirm the route writer stopped; old writes remain fenced"
    cmp -s "$R/etc/caddy/sites/soul-game.caddy" "$R/etc/caddy/soul-game.caddy.before-o19" || die "old proxy file not restored; old writes remain fenced"
    rm -f "$R/var/lib/souls-routes/slugs/$SLUG"
    ;;
  __count)
    since=$(sed -n 's/.*"step":"switched","at":"\([^"]*\)".*/\1/p' "$LOG" | tail -1)
    [ -z "$since" ] || node "$HERE/count.mjs" --since "$since" --args "$R/etc/souls/directory.args"
    ;;
  *) die "check|switch|back (see the top of $0)" ;;
esac
