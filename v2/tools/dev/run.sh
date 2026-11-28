#!/usr/bin/env bash
# One command for a local world of the new engine (V3, #4039): N2's test world served by `worldd`, its gateway
# (`gatewayd`), the directory with the dev sign-in (`directoryd --test-sign-in`), the viewers' origin
# (`tools/origin/origin.mjs`) and the page (`v2/web`, built from this checkout), behind the front door's own routing
# (`tools/ops/proxy/soul-game.caddy`, its addresses replaced), all on loopback. No model runs: the engine has no mind.
#
#   v2/tools/dev/run.sh [--port <n>] [--dir <folder>] [--host <name>] [--facts <file>]
#
# It prints `ready <url>` and runs until it is stopped (Ctrl-C or SIGTERM), which stops everything it started.
#
#   --port  the page's port (default 7400); the directory, the gateway and the origin take the next three.
#   --dir   everything the run writes (default <repo>/.local/v2-dev): the world's folder, the accounts, the logs
#           (`logs/`). A folder that already holds a world serves it again; a new folder seeds a new world.
#   --host  the page's host (default 127.0.0.1). The dev sign-in is for loopback only: with any other host the
#           directory refuses to start and so does this command, before anything listens.
#   --facts a world's facts (`v2/tools/import-eden/export/export.ts --template <file>`) to seed instead of N2's test
#           world, with every entry in content/kinds. Read only when the folder holds no world yet.
#   --bodies the world's body catalogue (`souls/bodies/1`, a placed world's bodies.json) to seed it with. Read only when
#           the folder holds no world yet.
#
# The world is at <url>/w/dev/ and, signed in as the test person Ada, its creator, at <url>/w/dev/?as=Ada (any other
# name is a test person who owns nothing). V2_SEED_SOULS=<n> seeds n test Souls on its open ground (a viewer bench's
# bodies; default 0). Otherwise no Soul stands in it until one joins: a client pairs against the directory
# (port + 1) and a test person approves, as client/served/e2e/world.test.mjs does.
#
# What it needs: `caddy` and `node` on PATH (CADDY names another caddy). What is missing it builds, as `tools/ci.sh`
# does: the four programs (`cargo build`, into target/debug), replica's WASM package (target/wasm-load/pkg) and the
# page (`vite build`, each start, so the page is this checkout's). Prebuilt instead: V2_BIN names the folder holding
# worldd, gatewayd, directoryd, testworld and assets-check (the gateway's uploads checker); V2_REPLICA_PKG the WASM package; V2_WEB a built page (its `dist`).
# Local only: loopback ports, its own folder, never a production world or its data.
set -euo pipefail
V2=$(cd "$(dirname "$0")/../.." && pwd)
PORT=7400 HOST=127.0.0.1 DIR=$V2/../.local/v2-dev FACTS= BODIES=
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT=$2; shift 2 ;;
    --dir) DIR=$2; shift 2 ;;
    --host) HOST=$2; shift 2 ;;
    --facts) FACTS=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2 ;;
    --bodies) BODIES=$(cd "$(dirname "$2")" && pwd)/$(basename "$2"); shift 2 ;;
    *) sed -n '2,29p' "$0" >&2; exit 2 ;;
  esac
done
die() { echo "run.sh: $*" >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65532 ] || die "--port is a number from 1024 to 65532"
CADDY=${CADDY:-caddy}
command -v "$CADDY" > /dev/null || die "caddy is not on PATH (CADDY names another)"
command -v node > /dev/null || die "node is not on PATH"
mkdir -p "$DIR/logs"
DIR=$(cd "$DIR" && pwd)
BASE=http://$HOST:$PORT
# The address people reach the world at (the pairing link the directory gives): this run's page, or V2_PUBLIC_URL, a
# front door in front of it (tools/playtest/arena/new-engine/old-page.mjs), as soul.game is the directory's on the host.
PUBLIC=${V2_PUBLIC_URL:-$BASE}
DIRECTORY=127.0.0.1:$((PORT + 1)) GATEWAY=127.0.0.1:$((PORT + 2)) ORIGIN=127.0.0.1:$((PORT + 3))

# What is missing is built, as tools/ci.sh builds it.
TARGET=${CARGO_TARGET_DIR:-$V2/target}
BIN=${V2_BIN:-$TARGET/debug}
PKG=${V2_REPLICA_PKG:-$TARGET/wasm-load/pkg}
for b in worldd gatewayd directoryd testworld assets-check; do
  [ -x "$BIN/$b" ] && continue
  [ -z "${V2_BIN:-}" ] || die "V2_BIN has no $b"
  # Two builds: `--bin` narrows a build to that binary alone, so one command with it would build only assets-check.
  (cd "$V2" && cargo build --locked -p worldd -p gatewayd -p directoryd -p testworld && cargo build --locked -p assets --bin assets-check)
  break
done
if [ ! -f "$PKG/replica.js" ]; then
  [ -z "${V2_REPLICA_PKG:-}" ] || die "V2_REPLICA_PKG has no replica.js"
  (cd "$V2" &&
    cargo install wasm-bindgen-cli --locked --root "$TARGET/tools" --quiet \
      --version "$(sed -n '/^name = "wasm-bindgen"$/{n;s/^version = "\(.*\)"$/\1/p;}' Cargo.lock)" &&
    cargo build -p replica --release --target wasm32-unknown-unknown --locked --features vectors &&
    "$TARGET/tools/bin/wasm-bindgen" --target web --out-dir "$PKG" "$TARGET/wasm32-unknown-unknown/release/replica.wasm")
fi
WEB=${V2_WEB:-$V2/web/dist}
if [ -z "${V2_WEB:-}" ]; then
  [ -d "$V2/web/node_modules" ] || npm ci --prefix "$V2/web" --no-audit --no-fund
  (cd "$V2/web" && V2_REPLICA_PKG=$PKG npx vite build --logLevel warn)
fi
[ -f "$WEB/index.html" ] || die "no built page in $WEB"

cd "$DIR"

PIDS=() NAMES=()
stop() {
  trap - EXIT INT TERM
  [ ${#PIDS[@]} -eq 0 ] || kill "${PIDS[@]}" 2> /dev/null || true
  wait 2> /dev/null || true
}
trap stop EXIT
trap 'exit 0' INT TERM
# start <name> <command...>: in the background, its output in logs/<name>.log.
start() {
  local name=$1
  shift
  "$@" > "logs/$name.log" 2>&1 &
  PIDS+=($!) NAMES+=("$name")
}
# until_ready <name> <test command...>: waits up to 60 s; a program that ended is reported with its last lines.
until_ready() {
  local name=$1 pid=${PIDS[${#PIDS[@]} - 1]}
  shift
  for _ in $(seq 600); do
    "$@" > /dev/null 2>&1 && return 0
    kill -0 "$pid" 2> /dev/null || die "$name did not start: $(tail -n 3 "logs/$name.log")"
    sleep 0.1
  done
  die "$name was not ready in 60 s: $(tail -n 3 "logs/$name.log")"
}

# The world: N2's test world and the body's family from the repository's own entries, its creator the test person
# Ada. Seeded once per folder. The gateway's session exchange compares a session's principal with the world's creator
# (gatewayd `creator.rs`), and the directory makes Ada's principal, at random, on her first sign-in: so the directory
# signs her in once here, and the world is seeded with that principal (`creator`, kept beside it).
if [ ! -f world/world.json ]; then
  mkdir -p seed/entries
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > view.key
  start directoryd "$BIN/directoryd" --listen "$DIRECTORY" --public-url "$PUBLIC" --store "$DIR/accounts.sqlite" \
    --pairing "$DIR/pairing.sqlite" --gateway-tokens "$DIR/seed/tokens" --view-key "$DIR/view.key" --test-sign-in
  until_ready directoryd grep -q '^listening' logs/directoryd.log
  node -e 'fetch(process.argv[1], { method: "POST", headers: { "content-type": "application/json" }, body: "{\"name\":\"Ada\"}" })
    .then((r) => r.json()).then((b) => console.log(b.principal.replace(":", "-")))' "http://$DIRECTORY/v1/account/test-sign-in" > creator
  kill "${PIDS[0]}" && wait "${PIDS[0]}" 2> /dev/null || true
  PIDS=() NAMES=()
  grep -Eq '^[0-9a-f]{32}-[0-9]+$' creator || die "the directory gave Ada no principal: $(tail -n 3 logs/directoryd.log)"
  if [ -n "$FACTS" ]; then
    cp -R "$V2/../content/kinds/." seed/entries/ && cp "$FACTS" seed/world.facts.json
  else
    "$BIN/testworld" --seed 1 --things 0 --out seed > logs/seed.log && mv seed/testworld-s1-t0.facts.json seed/world.facts.json
    cp "$V2/../content/kinds/body/humanoid.json" seed/entries/
  fi
  "$BIN/worldd" seed --facts seed/world.facts.json --dir world --souls "${V2_SEED_SOULS:-0}" --at 0,0 --entries seed/entries \
    --creator "$(cat creator)" ${BODIES:+--bodies "$BODIES"} >> logs/seed.log 2>&1 || die "worldd seed failed: $(tail -n 3 logs/seed.log)"
fi
[ -f creator ] || die "$DIR holds a world seeded before its creator was Ada's principal: use a new --dir"
CREATOR=$(cat creator)
# The owner's messages (R13): the directory keeps them, the gateway gives them to the Souls' sockets, sharing a key.
[ -f mailbox.key ] || od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > mailbox.key

# The directory first: with the dev sign-in it refuses a page address that is not loopback, and nothing else starts.
start directoryd "$BIN/directoryd" --listen "$DIRECTORY" --public-url "$PUBLIC" --store "$DIR/accounts.sqlite" \
  --pairing "$DIR/pairing.sqlite" --gateway-tokens "$DIR/world/tokens" --view-key "$DIR/view.key" \
  --test-sign-in --test-own "Ada=creator-$CREATOR" --mailbox-key "$DIR/mailbox.key"
until_ready directoryd grep -q '^listening' logs/directoryd.log

# The world's folder and socket by their full paths: a `pkill -f` aimed at another run's world then cannot match this
# one (the same relative words in every run's command line let one run's cleanup stop every local world).
rm -f w.sock
start worldd "$BIN/worldd" serve --dir "$DIR/world" --socket "$DIR/w.sock"
until_ready worldd test -S w.sock -a -f world/views/world.json
start gatewayd "$BIN/gatewayd" --listen "$GATEWAY" --world "$DIR/w.sock" --tokens world/tokens --build "1220$(printf '%064d' 0)" \
  --entries world/entries --view-key view.key --creator "$CREATOR" --directory "$DIRECTORY" --mailbox "$DIRECTORY" --mailbox-key mailbox.key \
  --uploads world/uploads
until_ready gatewayd grep -Fqx -e "listening $GATEWAY" -e "gatewayd: listening $GATEWAY" logs/gatewayd.log

# The origin serves the world's stream and history as a placed world's (place-world.sh's links), and routes the
# world's name to its gateway (world-routes.mjs). No provider is configured, so the page signs in with `as=`.
mkdir -p public/w/dev slugs
ln -sfn "$DIR/world/views" public/w/dev/views
ln -sfn "$DIR/world/history" public/w/dev/history
: > slugs/dev
STREAM=$(node -p 'JSON.parse(require("fs").readFileSync("world/views/world.json", "utf8")).stream')
cat > routes.json << JSON
{"schema": "souls/world-routes/1", "worlds": {"dev": {"gateway": "http://$GATEWAY", "stream": "/s/w/dev/${STREAM%/}/",
  "history": "/s/w/dev/history/", "canonical": true}}}
JSON
start origin env -u AUTH_PROVIDER SOULS_WEB="$WEB" SOULS_DATA="$DIR" SOULS_WORLD_ROUTES="$DIR/routes.json" \
  node "$V2/tools/origin/origin.mjs" "$DIR/public" "${ORIGIN#*:}" 127.0.0.1
until_ready origin grep -q '^origin' logs/origin.log

# The page: the front door's own routes, with this run's addresses and folders in place of the install's.
{
  printf '{\n\tadmin off\n\tauto_https off\n\tpersist_config off\n\tdefault_bind 127.0.0.1\n\tstorage file_system "%s"\n}\n' "$DIR/caddy"
  sed -e "s|https://soul.game|$BASE|" -e "s|/usr/local/lib/souls/web|$WEB|g" \
    -e "s|/var/lib/souls-routes/slugs|$DIR/slugs|g" -e "s|/var/lib/souls-routes|$DIR/routes|g" \
    -e "s|/var/lib/souls/models|$DIR/models|g" -e "s|localhost:7310|$DIRECTORY|g" -e "s|localhost:7320|$ORIGIN|g" -e "s|localhost:7330|$ORIGIN|g" \
    -e "s|localhost:@@PRODUCTION_PORT@@|$ORIGIN|g" -e "s|/srv/sim-worlds/production/apps/web|$V2/../apps/web|g" "$V2/tools/ops/proxy/soul-game.caddy"
} > Caddyfile
start caddy env XDG_CONFIG_HOME="$DIR/caddy" XDG_DATA_HOME="$DIR/caddy" "$CADDY" run --adapter caddyfile --config Caddyfile
until_ready caddy node -e 'fetch(process.argv[1]).then(async (r) => process.exit(r.ok && (await r.json()).world === "dev" ? 0 : 1), () => process.exit(1))' \
  "$BASE/w/dev/v1/bootstrap"

echo "ready $BASE"
echo "world $BASE/w/dev/   signed in as Ada: $BASE/w/dev/?as=Ada   logs: $DIR/logs"
# A program that ends is named with its exit status, here and at the end of its own log (128+n: signal n; 143 is a
# SIGTERM from outside this run, which a world server answers with no line of its own).
while sleep 1; do
  for k in "${!PIDS[@]}"; do
    kill -0 "${PIDS[$k]}" 2> /dev/null && continue
    status=0
    wait "${PIDS[$k]}" || status=$?
    echo "run.sh: ${NAMES[$k]} ended with exit status $status at $(date -u +%FT%TZ)" >> "logs/${NAMES[$k]}.log"
    die "${NAMES[$k]} ended with exit status $status (128+n: signal n); see $DIR/logs"
  done
done
