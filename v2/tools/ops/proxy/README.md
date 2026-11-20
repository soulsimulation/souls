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

The site's own pages (`/changelog`, `/changelog.md`, `/v1/feed`, `/ops`) go to the viewers' origin, which serves them
from the page's files and the release's `news.jsonl` (`v2/tools/origin/site.mjs`, O23).

`sim.eden.art` keeps today's `tools/world-launcher/deploy/caddy/sim-eden-art.caddy` (it redirects and keeps the
sign-in bridge); `cdn-trust.snippet` stays in the global options.

## Prove it locally

Needs `caddy` on the path, a built `v2/web` (`npx vite build` in `v2/web`) and a built `apps/web`:

```sh
BRAIN_MODE=fake node v2/tools/ops/proxy/standin.mjs --web v2/web/dist --today-web apps/web/dist
```

It runs `front-check.mjs` with everything up (every point), then with today's launcher stopped (the poster and the site's
pages), then once with the two systems' worlds swapped, which must fail. Exit 0 when all three come out as they should.

## Switch (the release owner, on the production host, as root)

Preconditions: a release carrying this folder is live at `/srv/sim-worlds/production`; the new system is installed
(O17) with `souls-directory` and `souls-origin` running and the directory listing the worlds that move.

```bash
bash -s <<'SWITCH'
set -uo pipefail
SRC=/srv/sim-worlds/production/v2/tools/ops/proxy
PORT="$(sed -n 's/.*--port \([0-9][0-9]*\).*/\1/p' /etc/sim-worlds/production.conf)"
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "no --port in production.conf: stopping, nothing changed"; exit 1; }
[ -f "$SRC/soul-game.caddy" ] || { echo "the live release has no $SRC: ship it first"; exit 1; }
curl -fsS http://localhost:7310/v1/worlds >/dev/null || { echo "the directory does not answer: stopping, nothing changed"; exit 1; }
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
addresses. Origin relays exactly the mapped WebSocket and creator-token exchange. It forwards the original bearer
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
