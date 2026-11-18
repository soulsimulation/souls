# The front door (Engine v2 O19, #2830)

The proxy's rules that put the new system behind `soul.game` while today's launcher serves every other world. What
each rule does is in the header of [`soul-game.caddy`](soul-game.caddy).

| File | Installed as | What it is |
|---|---|---|
| `soul-game.caddy` | `/etc/caddy/sites/soul-game.caddy` | `soul.game` after the switch; replaces today's file of that name |
| `souls-game.caddy` | `/etc/caddy/sites/souls-game.caddy` | `souls.game` redirects to `soul.game`, path and query kept |
| `routes.mjs` | run by `souls-routes.timer` | the map from the directory: `/var/lib/souls-routes/slugs/<slug>` and `sitemap.xml` |
| `souls-routes.service`, `.timer` | `/etc/systemd/system/` | runs `routes.mjs` each minute as `simworlds` |
| `standin.mjs` | not installed | the local stand-in that proves all of this (below) |

`sim.eden.art` keeps today's `tools/world-launcher/deploy/caddy/sim-eden-art.caddy` (it redirects and keeps the
sign-in bridge); `cdn-trust.snippet` stays in the global options.

## Prove it locally

Needs `caddy` on the path, a built `v2/web` (`npx vite build` in `v2/web`) and a built `apps/web`:

```sh
BRAIN_MODE=fake node v2/tools/ops/proxy/standin.mjs --web v2/web/dist --today-web apps/web/dist
```

It runs `front-check.mjs` with everything up (every point), then with today's launcher stopped (the poster), then once
with the two systems' worlds swapped, which must fail. Exit 0 when all three come out as they should.

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
