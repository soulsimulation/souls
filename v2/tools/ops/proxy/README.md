# The front door (Engine v2 O19, #2830)

The proxy's rules that put the new system behind `soul.game` while today's launcher serves every other world. What
each rule does is in the header of [`soul-game.caddy`](soul-game.caddy).

| File | Installed as | What it is |
|---|---|---|
| `soul-game.caddy` | `/etc/caddy/sites/soul-game.caddy` | `soul.game` after the switch; replaces today's file of that name |
| `souls-game.caddy` | `/etc/caddy/sites/souls-game.caddy` | `souls.game` redirects to `soul.game`, path and query kept |
| `routes.mjs` | run by `souls-routes.timer` | the active map from the directory and trusted placement metadata: `/var/lib/souls-routes/slugs/<slug>` and `sitemap.xml` |
| `souls-routes.service`, `.timer` | `/etc/systemd/system/` | runs `routes.mjs` each minute as `simworlds` |
| `standin.mjs` | not installed | the local stand-in that proves all of this (below) |
| `soul-game-moved.caddy` | `/etc/caddy/sites/soul-game.caddy` | `soul.game` while only some worlds have moved: the live file plus each moved world's paths to its own gatewayd (below) |
| `moved-install.sh` | not installed | installs `soul-game-moved.caddy` over the live file, or undoes it |
| `moved-standin.mjs` | not installed | proves `soul-game-moved.caddy` and `moved-install.sh` on this machine |

Since 0.132 Core (F4) the front door keeps the old home: today's launcher serves `/`, sign-in and account, the site's
own pages and every world's page and client files, a switched world's included (the launcher writes the v2 stream into
that page itself: [`v2/docs/cutover.md`](../../../docs/cutover.md)). Only streams (`/s/*`), a switched world's agent
paths (`/w/<slug>/v2/ws|creator-token|entries`) and pairing (`/pair`, `/v1/pair/*`, `/v1/agent/account`) reach the new
system.

`sim.eden.art` keeps today's `tools/world-launcher/deploy/caddy/sim-eden-art.caddy` (it redirects and keeps the
sign-in bridge); `cdn-trust.snippet` stays in the global options.

## Prove it locally

Needs `caddy` on the path, a built `apps/web` (it holds the pairing card, `pair.html`) and the install's page folder
(the body files, `node v2/tools/ops/release/bodies.ts --from <prepared body assets> --out <folder>`):

```sh
BRAIN_MODE=fake node v2/tools/ops/proxy/standin.mjs --web <folder> --today-web apps/web/dist
```

It runs `front-check.mjs` with everything up (every point), then with today's launcher stopped (the poster, the stream,
the gateway and pairing), then once with the two systems' worlds swapped, which must fail. Exit 0 when all three come out as they should.

## While only some worlds have moved (24 Nov 2026)

Production's front door was the live 0.131 F0 file (`/s/*` to the viewers' origin, everything else to today's
launcher), so a Soul could not pair with a world that had moved: `node eden.mjs pair https://soul.game/w/eden/` failed
`pair-world-routing`. [`soul-game-moved.caddy`](soul-game-moved.caddy) is that live file plus, for each moved world, the
bootstrap (to 7320) and the agent paths (`v2/ws`, `creator-token`, `entries`, uploads) straight to **that world's own
gatewayd** with `/w/<slug>` stripped, and, for everyone, the site-level pairing paths (`/pair`, `/v1/pair/*`,
`/v1/agent/account[/*]`, to the directory and the release's card); today's client pairs at `/w/<slug>/v1/agent/pair`,
which stays with the launcher. The agents' relay (`souls-agents`) is not used: production runs none, and 7330 is
Eden's gatewayd.

The moved worlds are the `import moved-world <slug> <port>` lines in its site block, one per world, `<port>` being the
port of that world's `gateway` in `/var/lib/souls/routes/worlds.json`. To move another world, add its line
(`bash moved-install.sh lines` prints the line for every canonical world in that file) and install again.

The release owner, on the production host, from a copy of this folder (a checkout, or the live release once it
carries it):

```bash
sudo bash moved-install.sh install   # back up, write, caddy validate, reload, check from loopback; undoes itself on a failure
sudo bash moved-install.sh undo      # the original /etc/caddy/soul-game.caddy.before-moved back, validated, reloaded
```

It reads the launcher's port and `trusted_proxies` from the original file, and stops with nothing changed unless the
directory answers its pairing card, and for each line worlds.json names that port as the world's gateway, the gatewayd
there opens `/v2/ws` (101) and the world's bootstrap comes from the viewers' origin (`canonical: true`), and the
release's `pair.html` is there. After the reload it checks each world's bootstrap (200) and `/w/<slug>/v2/ws` (101)
through the front door. Each install also keeps the file it replaced as `/etc/caddy/soul-game.caddy.before-last-install`.
The undo in one line, without the script: `sudo cp -a /etc/caddy/soul-game.caddy.before-moved /etc/caddy/sites/soul-game.caddy && sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`.

Prove it locally (fake minds; caddy on the path; `cargo build -p directoryd -p gatewayd -p worldd -p testworld` and
replica's package in `target/wasm-load/pkg`, or `DIRECTORYD=...` and `SOULS_REPLICA_PKG=...`):

```sh
node v2/tools/ops/proxy/moved-standin.mjs
```

It runs a scratch Caddy with a live-shaped file in front of two real new-engine worlds, `eden` and `hamlet`, each with
its own gatewayd, and a stand-in for today's launcher; the install's front-door checks go over HTTPS with HTTP/2, as against soul.game. It shows production's two faults (`pair-world-routing`, then
#4520's file answering `/w/eden/v2/ws` 404), that a line sending hamlet to Eden's gatewayd is refused, and then, after
`install`: for each world a fresh `eden.mjs pair` approved through the front door, its socket opening (101), and
`act life:join` answered with its receipt, recorded by that world's gatewayd and not the other's; an old world's page,
pairing, bootstrap and v2 paths, and Eden's page and `/v1/config`, still on the launcher; `undo` putting the live
file back; and a file that fails `caddy validate` never installed.

## Switch (the release owner, on the production host, as root)

Preconditions: a release carrying this folder is live at `/srv/sim-worlds/production`; the new system is installed
(O17) with `souls-directory`, `souls-origin` and `souls-agents` running and the directory listing the worlds that move.

```bash
bash -s <<'SWITCH'
set -uo pipefail
SRC=/srv/sim-worlds/production/v2/tools/ops/proxy
PORT="$(sed -n 's/.*--port \([0-9][0-9]*\).*/\1/p' /etc/sim-worlds/production.conf)"
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "no --port in production.conf: stopping, nothing changed"; exit 1; }
[ -f "$SRC/soul-game.caddy" ] || { echo "the live release has no $SRC: ship it first"; exit 1; }
curl -fsS http://localhost:7310/v1/worlds >/dev/null || { echo "the directory does not answer: stopping, nothing changed"; exit 1; }
systemctl is-active --quiet souls-agents.service || { echo "souls-agents (the agents' relay) is not running: start it first, nothing changed"; exit 1; }
cp -a /etc/caddy/sites/soul-game.caddy /etc/caddy/soul-game.caddy.before-o19
sed "s/@@PRODUCTION_PORT@@/$PORT/g" "$SRC/souls-routes.service" > /etc/systemd/system/souls-routes.service
cp "$SRC/souls-routes.timer" /etc/systemd/system/souls-routes.timer
systemctl daemon-reload && systemctl start souls-routes.service || { echo "the map was not made: stopping, Caddy unchanged"; exit 1; }
sed "s/@@PRODUCTION_PORT@@/$PORT/g" "$SRC/soul-game.caddy" > /etc/caddy/sites/soul-game.caddy
cp "$SRC/souls-game.caddy" /etc/caddy/sites/souls-game.caddy
if ! caddy validate --config /etc/caddy/Caddyfile; then
  cp -a /etc/caddy/soul-game.caddy.before-o19 /etc/caddy/sites/soul-game.caddy; rm -f /etc/caddy/sites/souls-game.caddy
  echo "caddy validate failed: today's file is back and Caddy was NOT reloaded"; exit 1
fi
systemctl reload caddy && systemctl enable --now souls-routes.timer && echo "switched; Caddy reloaded"
SWITCH
```

Then, from outside (any machine with a checkout), with a world that moved and one that did not:

```sh
node v2/tools/ops/front-check.mjs --v2 eden --today mars-college-2027 --alias eden-2026=eden
```

## Switch back

```bash
bash -s <<'BACK'
set -uo pipefail
[ -f /etc/caddy/soul-game.caddy.before-o19 ] || { echo "no saved file: nothing to switch back to"; exit 1; }
cp -a /etc/caddy/soul-game.caddy.before-o19 /etc/caddy/sites/soul-game.caddy
rm -f /etc/caddy/sites/souls-game.caddy
caddy validate --config /etc/caddy/Caddyfile || { echo "caddy validate failed: Caddy was NOT reloaded"; exit 1; }
systemctl reload caddy && systemctl disable --now souls-routes.timer && echo "switched back; Caddy reloaded"
BACK
```

The map in `/var/lib/souls-routes` is kept (it holds no data); today's file never reads it.

**Temporary drop-in, 0.131 only:** before 0.131.1, `routes.mjs` (and `cutover/state.mjs`) exited 0 without running when
started through `/srv/sim-worlds/production`, a link to the live release, so the host was given
`/etc/systemd/system/souls-routes.service.d/10-realpath.conf`. Once a release with `tools/lib/is-main.mjs` is live,
remove it: `rm /etc/systemd/system/souls-routes.service.d/10-realpath.conf && systemctl daemon-reload && systemctl
start souls-routes.service && journalctl -u souls-routes -n 1 -o cat` prints `routes: <n> slugs …`.

## World gateway/bootstrap metadata (O19b)

The origin reads `SOULS_WORLD_ROUTES`, default `/var/lib/souls/routes/worlds.json`. This is trusted writable
placement metadata, owned and writable only by the placement/operator account. Published mode0644 permits both
the origin and the existing route-generator account to read it; the update lock is mode0700. It contains no session
or signing keys. Public requests cannot update it. Each entry in `schema: "souls/world-routes/1"`, `worlds` is:

```json
{"eden":{"gateway":"<native gateway HTTP loopback origin>","stream":"/s/<stream directory>/","history":"/s/<history directory>/","canonical":false}}
```

The file's `worlds` object supports any number of validated slugs. Gateway origins must be HTTP loopback origins,
with no credentials, path, query or fragment. Stream/history are public `/s/` paths; bootstrap never exposes native
addresses. The agents' relay (`v2/tools/origin/agents.mjs`, unit `souls-agents` on 7330, #4152) relays exactly the mapped
WebSocket, creator-token and entries exchanges; the front door sends those paths to it, never to the viewers' origin,
so a viewer join wave that saturates or restarts the origin drops no agent. (The origin keeps the same relay for local
tools that run it alone.) It forwards the original bearer
and browser Origin, never an identity header; foreign Origin and public-address test bearers are refused.

`/preview/w/eden/` loads the built viewer and fetches its own `v1/bootstrap`, with no manual query. Its creator panel
is `/preview/w/eden/src/panel/`. Canonical paths have the same shape without `/preview`. The built pairing card is
`/pair?code=…`, and its module comes from the built assets; pairing API calls stay with the directory. Account and
world-management pages remain under `/src/account/` and `/src/worlds/`.

`canonical` defaults to **false**. Preview bootstrap/relay is available for mapped worlds; canonical bootstrap/relay
also requires `canonical: true`. The slug generator additionally requires that the directory lists that world.
Thus installing preview routes must not activate Eden's canonical page. Do not add canonical slug files by hand.

Placement (W3b) and cutover (O19c) must both import `updateWorldRoute` from `route-config.mjs` and use this operation:

```js
await updateWorldRoute(file, world, { gateway, stream, history, canonical });
```

It obtains an exclusive per-file directory lock, reads the latest file, patches only the named world's supplied
fields, validates the complete result, fsyncs and atomically renames it. Concurrent updates preserve unrelated
worlds and fields. A busy/stale lock refuses by name after five seconds; never delete another live writer's lock.
The origin never writes. A newly public world's placement publishes `canonical: true`; Eden's preview publishes
`false`. A failed metadata validation leaves the prior file intact.

**Cutover handoff to O19c:** update only Eden's activation using this writer, then synchronously run the same
`routes.mjs` service to refresh canonical membership before confirming the switch. Its timer reads the same file,
so it must preserve the chosen activation. Undo patches Eden back to its prior activation and synchronously refreshes
the slug map, preserving worlds created meanwhile. Save the prior Eden entry/activation, not a whole-map snapshot
that could erase post-switch worlds. Remove preview exposure only after the release owner completes its required
walks. The existing SWITCH/BACK scripts above need O19c's activation integration before release use; O19b does not
perform or modify the cutover.
