# Clerk satellite deployment

A satellite keeps the primary Clerk instance, its publishable key and issuer, and the shared account registry.
Do not replace the issuer with the satellite Frontend API hostname: account identities are bound to the issuer
and subject. Configure and verify the satellite domain and its Clerk DNS/SSL in the Clerk dashboard first.

Start the launcher with both public flags (neither is a secret):

```sh
--public-origin https://souls.game \
--clerk-satellite souls.game \
--clerk-sign-in-url https://sim.eden.art/sign-in
```

The existing authentication env file must list both `https://souls.game` and `https://sim.eden.art` in
`CLERK_AUTHORIZED_PARTIES`. The launcher refuses partial flags, a domain that does not match its public HTTPS
origin, a non-HTTPS primary URL, credentials/query/fragment in the primary URL, or a missing authorized origin.
It passes `CLERK_SATELLITE_DOMAIN` and `CLERK_SIGN_IN_URL` to its children and exposes only the public settings in
`/__sim/worlds.json` and world `/v1/config`. Deployments without flags keep the previous provider behavior.

Both homepage and world clients enable satellite options only at the exact configured satellite origin. Preview
origins remain unsigned and direct sign-in to the canonical site. The sign-in action uses Clerk's
`buildSignInUrl`, including its synchronization parameters and the complete return path, query and pairing fragment.
No simulation events, Soul context, model calls or background workers are added.

## Primary sign-in beside an older app

The primary app needs a sign-in route that allows the satellite return origin. The launcher's standalone
`/__sim/clerk-sign-in` document can be proxied on the primary domain without replacing that domain's existing app.
For example, **inside the primary site's existing Caddy block**, before its catch-all handler:

```caddy
handle /sign-in {
    rewrite * /__sim/clerk-sign-in
    reverse_proxy https://souls.game {
        header_up Host souls.game
    }
}
```

The query string must survive the rewrite. Clerk uses hash routing here, so no `/sign-in/*` subpath proxy is
needed. Before DNS points at the satellite server, use its direct upstream address with TLS server name
`souls.game`, or an authenticated transport to the launcher's loopback port; do not expose its private listener.
Keep this primary route available after cutover while the satellite uses this primary sign-in URL.

The bridge loads Clerk JS major 5 from the configured primary issuer, matching the app's Clerk React major 5.
It initializes only when the browser origin equals the configured primary origin. Query and hash return URLs
must have the exact satellite HTTPS origin; credentials and external destinations are refused before Clerk loads.
Existing primary sessions return immediately; signed-out visitors see Clerk's sign-in form. The return URL keeps
SDK synchronization parameters, world paths and pairing fragments. The page has no-store, no-referrer and
noindex headers, denies framing and supplies a CSP with a hash for its inline bootstrap and Clerk's documented
script hosts, Clerk's blob workers and the primary edge's Cloudflare analytics script. Avoid adding a second, conflicting CSP at the proxy on this route. It never renders or logs tokens.

## Session sync before the world loads

Clerk JS 5 sends a satellite to the primary on load whenever its `__client_uat` cookie is missing or not above 0
(signed out) and the address has no `__clerk_synced`. The world page does this itself, in an inline `<head>` script
in `apps/web/index.html`, before the snapshot prefetch, so a visit boots the world once. If it left it to Clerk, the
page would leave and boot again once Clerk mounted after the arrival card (#1385). The home page (`/`, the world list)
does the same: the launcher writes the public satellite settings (domain and primary sign-in URL only) into its
`<head>` as `window.__soulsHomeAuth` (`homePageHtml` in `tools/world-launcher/clerk-satellite.mjs`), as a world page's
inline config carries them. Without them the list loaded in full, then Clerk synced and it all loaded again. The
script runs only on the configured satellite origin's home and world pages. It never runs for a signed-in cookie, a picture page or a return from the
sync. After a sync that did not come back, it waits a minute before trying again, so a blocked cookie never loops.
The page's referrer is kept in `sessionStorage` across the round trip, so the visitor count still credits the site a
visitor came from (`presyncReferrer` in `visitor-counts.ts`, origin only as for any referrer).

## sim.eden.art on the production host

The old sim.eden.art app is being retired (#1416). Its name moves to the production host, which serves only the
sign-in bridge there and sends everything else permanently to `https://soul.game`, with the same path and query: 301
for GET and HEAD, 308 for other methods, so an old client's POST stays a POST. The site file is
[`tools/world-launcher/deploy/caddy/sim-eden-art.caddy`](../../tools/world-launcher/deploy/caddy/sim-eden-art.caddy).
`/sign-in` is rewritten to the production launcher's own `/__sim/clerk-sign-in`, with the query and the bridge's own
headers intact. The launcher's loopback port is the placeholder `@@PRODUCTION_PORT@@`, never a value in the repository.
It is the `--port` in `/etc/sim-worlds/production.conf`, which the install substitutes.

The release never writes Caddy's configuration. The site file goes in once, at cutover, after a release that carries
it is live:

1. On the production host, as root, install it. Until DNS moves, the site is inert: Caddy can't get a certificate
   for the name yet and retries with back-off, and soul.game and every other site are unaffected.

   ```bash
   bash -s <<'CUTOVER'
   set -uo pipefail
   REL=/srv/sim-worlds/production                     # the live release (0.121 or later)
   SRC="$REL/tools/world-launcher/deploy/caddy/sim-eden-art.caddy"
   SITE=/etc/caddy/sites/sim-eden-art.caddy
   PORT="$(sed -n 's/.*--port \([0-9][0-9]*\).*/\1/p' /etc/sim-worlds/production.conf)"
   [[ "$PORT" =~ ^[0-9]+$ ]] || { echo "no --port in production.conf: stopping, nothing changed"; exit 1; }
   grep -q '^https://sim\.eden\.art {' "$SRC" || { echo "the live release has no sim-eden-art.caddy: ship 0.121 first"; exit 1; }
   grep -qE '^\s*import sites/\*\.caddy' /etc/caddy/Caddyfile || { echo "the Caddyfile does not import sites/*.caddy: stopping, nothing changed"; exit 1; }
   BAK=""
   if [ -e "$SITE" ]; then BAK="$SITE.bak.$(date +%s)"; cp -a "$SITE" "$BAK" || { echo "cannot back up $SITE: stopping, nothing changed"; exit 1; }; fi
   restore() { if [ -n "$BAK" ]; then mv "$BAK" "$SITE"; else rm -f "$SITE"; fi; }
   sed "s/@@PRODUCTION_PORT@@/$PORT/" "$SRC" > "$SITE.new" || { rm -f "$SITE.new"; echo "cannot write the site file: stopping, nothing changed"; exit 1; }
   mv "$SITE.new" "$SITE" || { rm -f "$SITE.new"; echo "cannot install the site file: stopping, nothing changed"; exit 1; }
   if ! caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1; then
     restore; echo "caddy validate failed: the previous state is back and Caddy was NOT reloaded"; caddy validate --config /etc/caddy/Caddyfile; exit 1
   fi
   if ! systemctl reload caddy; then
     restore; echo "caddy reload failed: the previous file is back; run 'systemctl status caddy' and reload again"; exit 1
   fi
   echo "sim.eden.art site installed; Caddy reloaded"
   LOOPBACK=localhost; code="$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: sim.eden.art' -H 'X-Forwarded-Proto: https' "http://$LOOPBACK:$PORT/__sim/clerk-sign-in?redirect_url=https%3A%2F%2Fsoul.game%2F" || true)"
   echo "the launcher's sign-in bridge answers locally: $code (want 200)"
   CUTOVER
   ```

2. Point `sim.eden.art`'s DNS at the production host: the same record type and Cloudflare proxy and SSL mode as
   `soul.game`, or a CNAME to `soul.game`. Caddy then gets the certificate on the first request.
3. From anywhere, run `node tools/world-launcher/deploy/caddy/check-sim-redirect.mjs` until it prints PASS. It checks
   the redirects (same path and query, 301 or 308), the bridge on `/sign-in` (200, no-store, its own CSP) and the
   canonical pages.
4. Walk sign-in on the real URL: signed out on `soul.game`, sign in, return to the same world, reload.
5. Only then back up the old host and shut it down.

`https://sim.eden.art` stays in `CLERK_AUTHORIZED_PARTIES` and in the CDN's CORS origins. Clerk makes the primary
session on this origin, and the bridge runs here. Removing it would break sign-in for every satellite.

## Verify before release

Use an isolated mirror first, then record one uncut real-speed journey on the real satellite: sign in via the
primary route, return to the same world/pairing step, reload, and verify the existing account retains ownership.
Also check an already signed-in primary session, cancellation and an unrelated-origin preview. Unit tests and
synthetic JWT integration prove configuration/identity handling; they do not prove the real Clerk session round
trip. Keep live proof explicitly unverified until this browser journey succeeds.

References: [Clerk satellite domains](https://clerk.com/docs/guides/dashboard/dns-domains/satellite-domains) and
[Clerk CSP](https://clerk.com/docs/guides/secure/best-practices/csp-headers).

## Moving the canonical satellite

Keep the same issuer, publishable key and account registry. For a move from souls.game to soul.game, set
`--public-origin https://soul.game --clerk-satellite soul.game --clerk-legacy-satellites souls.game` and retain
`--clerk-sign-in-url https://sim.eden.art/sign-in`. The legacy list is explicit (at most four hostnames), rejects
URLs, wildcard hosts, the primary and the canonical hostname. The primary bridge allows both exact origins,
then normalizes a permitted legacy return to the canonical domain while retaining its path, query and fragment.
Old Clerk satellites need not remain active for these normalized return links. Existing in-flight Clerk SDK
synchronization still requires real browser verification; synthetic sessions do not establish provider behavior.

A public-only environment file can override `CLERK_AUTHORIZED_PARTIES` with
`https://sim.eden.art,https://souls.game,https://soul.game`. Load that file with a systemd drop-in's additional
`EnvironmentFile=` after the existing production settings file; do not clear the existing directive. Restart the
keeper when changing its environment/arguments. The launcher validates 1–8 exact HTTPS origins and passes only
this public override into its authentication subprocess, creator verifier and both world command types.
Explicit process environment takes precedence over Node's existing `--env-file`. With no override, that file's
behavior is unchanged. The application CLI continues reading issuer/key from the existing auth file by path;
there is no need to inspect, copy or modify that file. Arbitrary parent variables are never inherited.

Configure the new satellite DNS/certificate and the primary redirect settings before activation. Keep old API,
WebSocket, token, god and asset routes directly proxied to the same authority; redirect only browser pages.
Existing auth-bearing requests must never depend on a cross-origin HTTP redirect retaining Authorization.
