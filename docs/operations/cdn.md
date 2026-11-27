# Asset CDN

`https://cdn.soul.game` is a Cloudflare R2 bucket (`soul-game-assets`, on soul.game's Cloudflare account) on a custom
domain. It holds immutable, content-addressed copies of assets the origin (`soul.game`) already serves publicly, so they
load from the nearest edge. The origin always remains the fallback. Until the move to soul.game the same keys were
served from `https://assets.eden.art` (bucket `eden-assets`); that bucket is kept read-only, so old proof and journal
links still answer, and nothing writes to it any more.

## Keys

| Key | Holds |
|---|---|
| `assets/<sha[0:2]>/<sha>.<ext>` | The file's bytes (identity encoding) |
| `assets/br/<sha[0:2]>/<sha>.<ext>` | The file stored as quality-11 brotli with `Content-Encoding: br` |
| `assets/w/<world>/<sha>.<ext>` | A world-scoped copy, mapped only on that world's own page |
| `w/<slug>/assets/<sha>.<ext>` | A god upload, written only by the uploads Worker |
| `assets/replica/<version>/replica.js`, `…/replica_bg.wasm` | The new engine's replica as the launcher serves it, by its version ([first load](#a-new-viewers-first-load)) |
| `assets/app/<name>-<hash>.<ext>` | A file of a web build's `assets/` folder, under its own built name |
| `assets/app/sets/<set>.json` | The marker of one web build: every file of it is stored. Written last |

`<sha>` is the SHA-256 of the decoded file. Objects are written once (`If-None-Match: *`) with
`Cache-Control: public, max-age=31536000, immutable` and are never overwritten. A changed file is a new key.

## What goes on the CDN

An immutable file the origin already serves publicly goes on the CDN when it loads faster from there. Rights stay with
their holders: the CDN is a transport, not a licence. The records that admit a file are checked in:

| Record | Covers |
|---|---|
| Licence sources CSV (`DEFAULT_SOURCES` in `inventory.mjs`) + `approved-derivatives.json` | CC0 and own-work models and their derived LOD meshes, pinned by SHA and bytes; under `generated`, the models Engine v2's bake draws from this repository's own builders (`v2/tools/import-eden/README.md`) |
| `served-public.json` (`served-public.mjs --write`; without `--write` it checks the file is current) | Every file of the server's core asset set that `GET /assets/<sha>` serves, the `/modular` set, with each index's licence text kept |
| `served-blobs.json` | The `/blobs/assets/<sha>` files the client names (a test fails when a literal in `apps/web/src` has no record) |
| `world-scoped.json` | Per-world files, with their world, served URL and authorisation, used only under `assets/w/<world>/` |

A release's own script and style files, and the replica, are copied after the release, from the live origin
([first load](#a-new-viewers-first-load)); the page uses the copies once the launcher has seen them. Compressible objects (GLB, bin, HDR, EXR) are stored precompressed when brotli saves at least 3%; Cloudflare
decodes a stored br body for a client that does not accept br. Never set `Cache-Control: no-transform` on them.

## Repository media

Git holds no binary media. `tools/assets/manifest.json` lists every media file by repository path with its SHA-256,
size and CDN URL, and `pnpm assets:pull` puts each one back at its path (`pnpm assets:check` verifies without
network). Tests, the web build and the release check or pull it themselves; see `tools/assets/README.md`. These
pull-only objects are published with `publish.mjs --repo-media`, validated against the asset manifest instead of the
licence records, and never enter the client `cdn-manifest.json`.

## Origin answers the edge keeps briefly

Two origin answers are the same for every caller without a token and change often:

| Path | Served by | Varies by |
|---|---|---|
| `/__sim/worlds.json` | the launcher | nothing per caller |
| `/w/<slug>/v1/config` | the world (`apps/server/src/http.ts`) | the host the caller reached (part of the edge's key) |

Requests without an `Authorization` header get `Cloudflare-CDN-Cache-Control: max-age=5, stale-while-revalidate=30`:
the edge keeps the answer 5 s and serves it stale for up to 30 s while it asks again. A plain `s-maxage` would turn
the revalidation off. The browser still gets the origin's `Cache-Control` (`no-store` for the world list). A request
with `Authorization` never gets the header. The cache rule for these two paths is "eligible for cache, respect the
origin's headers", applied only to requests without `Authorization`. Add them to the rule set with the hashed and
stable classes.

The world page itself is not edge-cached. The launcher keeps it for 2 s
([load contract §2](../architecture/load.md#2-request-classes)), so a burst of arrivals costs the world one page
build every 2 s.

## The client

The web build carries `apps/web/src/cdn-manifest.json`, which maps origin URLs (in both the root and `/worlds`
namespaces, with exact version queries) to keys:

```json
{"version":1,"assets":{"/world-assets/core-assets/packs/example.glb":{"key":"assets/aa/<sha>.glb","sha256":"<sha>","bytes":123,"licence":"CC0-1.0"}}}
```

`cdnRoute` in `apps/web/src/cdn-assets.ts` resolves each request; GLBs download in a worker
(`apps/web/src/gen-mesh/asset-fetch.ts`). The client fetches the CDN copy without credentials or referrer, checks the
exact length and SHA-256 of the decoded body, and on any error, timeout (12 s of body idle) or mismatch retries the
original URL. Unlisted, missing and invalid entries stay on the origin. `window.__assetWorker.cdn` counts CDN
deliveries.

The switch is build-time: `SIM_ASSETS_CDN_ENABLED=1` (off when absent in a plain `vite build`; `release.sh` defaults it
on and fails a build without the origin or the manifest). `SIM_ASSETS_CDN_ORIGIN` defaults to
`https://cdn.soul.game`; the client accepts only that origin, the former `https://assets.eden.art` (so a rollback
build can name it) or a loopback `http` origin for tests.

## Publishing

`tools/cdn/publish.mjs` uses Node's built-in fetch and crypto. The dry run uses no network and no credentials:

```sh
node tools/cdn/publish.mjs --dry-run --out <dir>/cdn-plan.json --manifest <dir>/cdn-manifest.json
```

The plan records each object's path, bytes, SHA-256, licence evidence, encoding and encoded hash, plus excluded files
and totals. It inventories `mars/viewer/public`, the Mars web overlay, `worlds/` and `apps/web/public`. Hidden
entries, secret-named files, nested symlinks and `node_modules` are never opened. Brotli output is cached in
`$EDEN_CDN_BR_CACHE` (default a temp directory). `--identity` writes an identity-only plan; `--base <manifest>` keeps
that manifest's world-scoped section.

Uploading needs `CF_ACCOUNT_ID` (the Cloudflare account that owns the R2 bucket), from the environment or the
untracked `deploy.env` (template [`deploy.env.example`](../../deploy.env.example)), and the R2 credentials file named
by `EDEN_ASSETS_CREDENTIALS`, which the upload tools read from the environment only. A real `--apply` without the
account id stops before any request.
The variable holds the absolute path of a single-link regular file owned by the current user, mode 0600, containing exactly `R2_ACCESS_KEY_ID=...` and `R2_SECRET_ACCESS_KEY=...`.
Nothing else (environment keys, `~/.aws`, rclone config) is read. In CI, write the secret to a temporary 0600 file
and point the variable at it. `tools/cdn/install-key.py <path>` creates such a file from hidden
prompts without echoing the values.

```sh
# 1. one object first, then prove it live
EDEN_ASSETS_CREDENTIALS=<file> node tools/cdn/publish.mjs --apply --plan <plan> --only <key> --receipt <new>/receipt-test.json
node tools/cdn/verify.mjs https://cdn.soul.game <plan> --key <key> --out <new>/proof-test.json
# 2. the whole plan (existing objects are verified and skipped), then a cache proof
EDEN_ASSETS_CREDENTIALS=<file> node tools/cdn/publish.mjs --apply --plan <plan> --receipt <new>/receipt.json
node tools/cdn/verify.mjs https://cdn.soul.game <plan> --key <k1>,<k2>,<k3> --out <new>/proof.json
```

Before any network access every object is rehashed and its licence evidence revalidated. Publishing always uses the
default licence sources (`--sources` is dry-run only). HEAD precedes PUT; existing objects must have matching
metadata or the run stops without overwriting; every uploaded or skipped object is read back through the
authenticated endpoint and its bytes verified. Receipts hold keys, hashes and dispositions, never credentials. The
`--receipt` and `--out` paths are reserved with exclusive creation, so use a new path per attempt; a partial run can
be repeated safely.

The publisher never uploads the manifest. Commit the new `apps/web/src/cdn-manifest.json` and ship it with the web
build after its objects are verified. Rolling back is shipping the previous manifest; unreferenced objects are inert.

### World-scoped objects

```sh
node tools/cdn/world-scoped.mjs plan --out <dir>/plan.json                          # dry run
node tools/cdn/world-scoped.mjs evidence --plan <dir>/plan.json --out <dir>/evidence.json   # public GETs; must say ok:true
EDEN_ASSETS_CREDENTIALS=<file> node tools/cdn/world-scoped.mjs apply --plan <dir>/plan.json --receipt <dir>/receipt.json
node tools/cdn/world-scoped.mjs manifest --receipt <dir>/receipt.json --base apps/web/src/cdn-manifest.json
```

`apply` re-fetches each served URL and uploads exactly those bytes; a path that no longer serves the recorded bytes
is skipped. `manifest` merges only receipt-verified paths into the manifest's `worlds` section.

## Verifying

- `node tools/cdn/verify.mjs <cdn origin> <plan> [--key a,b] [--sample N] [--allow-warm] --out <file>`: no
  credentials. For each object: a first GET that must MISS, a second that must HIT with an `Age`, CORS for the app
  origin, MIME type, the immutable cache policy, ETag and the decoded SHA-256. A `br` key is also fetched with
  Chrome's `Accept-Encoding` (must stay br), identity and gzip (must arrive decoded). `--allow-warm` labels a recheck
  of an already warm object.
- `node tools/cdn/cdn-walk.mjs <outDir> <url>... [--manifest <file>] [--wait <ms>] [--devices desktop1,phone2]`: the
  release's runtime check. Playwright Chromium, desktop and phone, asset worker on. It fails when the origin answers an asset
  the manifest maps, a CDN request is not 200, a `br` object arrives without `Content-Encoding: br`, the worker
  delivered GLBs but none from the CDN, a god upload came from the origin without a Worker request first, or a
  same-origin immutable response lacks a long-lived cache policy (`origin-cache.mjs`).
- Local tests (no credentials or network): `node --test tools/cdn/cdn.test.mjs tools/cdn/manifest-integrity.test.mjs
  tools/cdn/world-scoped.test.mjs tools/cdn/origin-cache.test.mjs` and `python3 -B tools/cdn/install_key_test.py`.
  `manifest-integrity.test.mjs` checks every manifest alias against the repository files.
- Local browser proofs against stand-ins: `tools/cdn/browser-proof.mjs serve|check` (CDN delivery, a closed CDN and
  corrupt bodies falling back to the origin, at dpr 1 and 2) and `tools/cdn/world-scoped-proof.mjs`; their headers
  give the exact commands.

## The uploads Worker

`tools/cdn/worker/god-uploads.js` is a Cloudflare Worker (one ES module, no imports, no secrets) on the route
`cdn.soul.game/w/*`. It serves exactly `GET /w/<slug>/assets/<sha256>.<ext>` (`glb`, `png`, `jpg`, `json`):

- **R2 hit:** the stored object with the CDN headers (immutable, Content-Type, CORS matching the exact allowed requesting origin,
  `Content-Encoding: br` when stored so, ETag `"<sha>"`), also kept in the edge cache.
- **Miss:** it fetches the god world's own route `https://soul.game/w/<slug>/assets/<sha>.<ext>`, hashes the
  body while reading it (32 MiB cap), and stores and returns it only when the digest equals the path's sha. The R2
  write completes before the 200, so `x-eden-cdn: miss` means stored.
- **Refusals** (`no-store`, `x-eden-cdn: refused:<reason>`): a malformed path or a query is 400, origin 404 is 404, a
  hash mismatch, redirect, other origin status or oversize body is 502. Nothing refused is stored.

The root launcher retains old slug aliases, so existing upload keys continue to resolve without rewriting objects.
CORS permits exactly `https://soul.game`, `https://souls.game` and `https://sim.eden.art`, including cached responses, errors, HEAD,
OPTIONS and 304. Unknown or absent origins receive no allow-origin header; responses vary on Origin.

The client routes a god upload to the Worker only when the world's snapshot gives its size, so the same length and
SHA checks apply. `SIM_GOD_UPLOADS_CDN=0` at build time turns that off; a visitor can add `?godcdn=0`.

**Deploying** (authorized Cloudflare CLI or dashboard, preserving the existing Worker configuration):

| Setting | Value |
|---|---|
| Script | `tools/cdn/worker/god-uploads.js` |
| Compatibility date | `2026-10-01` or later, no flags |
| R2 binding | variable `ASSETS` → the bucket behind `cdn.soul.game` (`soul-game-assets`) |
| Route | `cdn.soul.game/w/*`, failure mode **Fail open** |
| workers.dev and preview URLs | disabled (the route is the only entry point) |
| Variables and secrets | none |

Add no other route: published keys all start with `assets/`, and the Worker writes only under `w/`, so the two cannot
collide. The Worker sets its own CORS headers, but the static asset bucket has a separate CORS rule: retain the
old origin and add the exact new origin there too. Activate the root upstream and aliases before switching the
Worker. See the [cutover order, verification and fallback runbook](../../tools/cdn/worker/README.md).

**Proving it:** `node tools/cdn/worker/verify-worker.mjs --god <god folder of a scratch world> --out <receipt>`
uploads one fresh GLB and checks the origin route, HEAD before any GET is 404, the first GET is a verified `miss`, an
immediate HEAD is `hit`, a second GET is `hit` or `edge`, the refusals above, and that a published `assets/` key still
answers from R2. It also checks both allowed browser origins and an unknown origin after warming the cache.
The god folder may name either allowed site with `/w/<slug>/` or `/worlds/w/<slug>/`. `--self-test` runs the same checks against loopback stand-ins. Unit tests:
`node --test tools/cdn/worker/god-uploads.test.mjs`.

| Symptom | Cause |
|---|---|
| Every `/w/` request is a 404 page without `x-eden-cdn` | The route is missing |
| `refused:binding` (500) | The `ASSETS` binding is missing or misnamed |
| `refused:origin-403` / `origin-503` | The origin's WAF or bot rules refused the Worker (user agent `eden-assets-pull/1`) |
| `miss-unstored` | The R2 write failed; the client still got verified bytes; see the Worker logs |

**Rollback:** delete the route. Clients get a 404 from the bucket and fall back to the origin. Objects under `w/` are
inert and may stay.

## The stream hostname

A world's live stream (`/s/*`: its pointer, bundle headers, baselines and parts) is public, the same for every viewer,
and already sent with cache headers: parts, baselines and headers `immutable` for a year, the pointer `max-age=1`,
a missing file or a query string `no-store` ([viewer cache](../../v2/docs/viewer-cache.md)). The `soul.game` record is
DNS only, so without this every viewer's reads reach the host: about 6 requests a second (the page reads the pointer
every 250 ms, plus 2 parts), 14 to 16 kB a second, and 9 to 13.5 MB to join. On the viewers bench (#4159) the origin
answered 34,000 requests and 333 MB a second at 5,000 viewers, and 215 reads timed out.

`https://stream.soul.game` is a proxied record in the `soul.game` zone whose only paths are the stream's. Its cache
rule keeps each file at the edge for as long as the origin's header says, so a location sends the host about one
pointer read and two parts a second however many viewers it serves (with Tiered Cache, about that many in all). The
page reads there only when the world's cutover binding names it (`v2StreamOrigin`, read again within a second, no
restart); a visitor can add `?streamcdn=0` to read from `soul.game` itself. The history (`v2History`) stays on
`soul.game`.

| Part | Where |
|---|---|
| The page reads its stream from the named origin, and only `https://stream.soul.game` | `apps/web/src/v2-engine/stream-cdn.ts` |
| The launcher writes `v2StreamOrigin` into the routed page | `tools/world-launcher/cutover.mjs` (`v2Fields`), switched by `stream-cdn-switch.mjs` |
| The host: `/s/*` to the viewers' origin (7320) with `Access-Control-Allow-Origin: *`, a preflight answered, no cookie, anything else a `no-store` 404 | `v2/tools/ops/proxy/stream-soul-game.caddy` (its test runs it in a real Caddy) |

**Why not a Worker on `cdn.soul.game/s/*`:** a Worker runs on every request it routes, before the cache, and is
billed per request (the free plan stops at 100,000 a day). At 5,000 viewers the page makes about 30,000 requests a
second, about 78 billion a month. A cache rule on a proxied record costs nothing per request. `cdn.soul.game` itself is
the R2 bucket's custom domain and cannot send a path to the host without a Worker or an origin rule.

**Steps, in this order.** Nothing changes for a viewer until the last one. The page and launcher parts ship in a release
first; until then the binding field is ignored.

1. Gene, Cloudflare dashboard, zone `soul.game`, **DNS**, **Records**, **Add record**: Type `CNAME`, Name `stream`,
   Target `soul.game`, Proxy status **DNS only** for now, TTL Auto. **Save**.
2. Release owner, on the production host, once a release that carries the site file is live:

   ```bash
   sudo cp /srv/sim-worlds/production/v2/tools/ops/proxy/stream-soul-game.caddy /etc/caddy/sites/stream-soul-game.caddy
   sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
   ```

   Caddy gets the name's certificate while the record is still DNS only. Check from any computer:
   `curl -s -o /dev/null -w '%{http_code}\n' https://stream.soul.game/s/check` prints `404`.
3. Gene: set the `stream` record to **Proxied**. Then **Caching**, **Cache Rules**, **Create rule**: name `souls stream`,
   **Custom filter expression**, **Edit expression**: `(http.host eq "stream.soul.game")`. Cache eligibility
   **Eligible for cache**; Edge TTL **Use cache-control header if present, bypass cache if not**; Browser TTL
   **Respect origin TTL**; cache key default. **Deploy**. Optional and free: **Caching**, **Tiered Cache**, **Smart
   Tiered Cache Topology** on. Make sure no bot challenge, Browser Integrity Check or Rocket Loader applies to this name.
4. Check from any computer (public reads only):

   ```bash
   S=$(curl -s https://soul.game/w/eden/ | grep -o '"v2Stream":"[^"]*"' | cut -d'"' -f4)
   for i in 1 2; do curl -s -o /dev/null -D - -H 'cache-control: no-cache' -H 'pragma: no-cache' "https://stream.soul.game${S}pointer" | grep -iE '^(HTTP/|cf-cache-status:|cache-control:|age:|access-control-allow-origin:)'; sleep 0.3; done
   curl -s -o /dev/null -D - "https://stream.soul.game${S}99999999" | grep -iE '^(HTTP/|cf-cache-status:|cache-control:)'
   ```

   Expected: both pointer reads `HTTP/2 200`, `cache-control: public, max-age=1, no-transform`,
   `access-control-allow-origin: *`, the second with `cf-cache-status: HIT` (the first `MISS`, `HIT` or `EXPIRED`) even
   though it asked `no-cache`, as a browser's stream reader does. The last is `HTTP/2 404`, `cache-control: no-store`,
   never `HIT`. `DYNAMIC` means the rule is missing; a `403` means a challenge is in the way.
5. Release owner: turn it on for a world, on the production host:
   `sudo node /srv/sim-worlds/production/tools/world-launcher/stream-cdn-switch.mjs eden on`. Open
   `https://soul.game/w/eden/` in a browser: in DevTools, Network, filtered on `stream.soul.game`, the pointer and the
   parts answer `200` with `cf-cache-status: HIT` once warm, and the world moves.

**Measured through the real CDN (#4985, 27 Nov 2026).** Remote readers (the page's stream worker without the
drawing, asking `br, gzip` as a browser does) on Modal machines of 250 readers each, which Cloudflare's anycast spread
over 6 to 10 edge locations on three continents, read Eden through `stream.soul.game` at 1,000, 2,500 and 5,000, each
even (arrivals over 30 s, then held) and uneven (one join wave within 5 s, a churn wave of a quarter at the middle,
2 % slow readers), two repeats. Up to 5,000 even and 2,500 uneven, the edges answered up to 20,000 requests a second
at a 99.97 to 99.99 % hit ratio, first picture p95 under 3 s, and the origin host saw what it sees with no viewers:
about 6 requests a second, under 0.01 of a core for the origin, the host near 7 % busy, Eden at 20 ticks a second with
no tick over budget. To join, a reader downloads about 1.27 MB (the baseline 1.12 MB as br) against 9.2 MB without
compression. **What breaks first is Cloudflare's security, not the host:** 5,000 readers joining within 5 s get
"Sorry, you have been blocked" (403) on every read within 10 s and for the rest of the arm, from 20 machines and from
100; the host and Eden saw nothing. Which rule fires is in the dashboard's Security Events for `stream.soul.game`.
The rerun: `REMOTE_PKG=<the world's replica package> modal run tools/bench/capacity/viewers/v2-remote-modal.py
--base https://stream.soul.game --stream <v2Stream> --viewers 5000 --arm uneven --per-share 250 --slow 100 --out
<file>`, then `node tools/bench/capacity/viewers/v2-remote-report.mjs <file>`. The per-arm table is on #4985.

**Rollback:** `sudo node /srv/sim-worlds/production/tools/world-launcher/stream-cdn-switch.mjs eden off` (pages loaded
after it read `soul.game/s/` again; an open page reads the CDN until it reloads). If the CDN itself is wrong, also set
the record to DNS only. The site file can stay.

## A new viewer's first load

The `soul.game` record is DNS only, so whatever the page asks `soul.game` for comes from the host, once per new
viewer. On 27 Nov 2026 one cold load of `https://soul.game/w/eden/` (Playwright Chromium, empty profile, 30 s) asked
the host for 78 files and 2.49 MB: the page's scripts and styles (46 files, 1.33 MB), the replica (0.69 MB), the
world's snapshot (0.32 MB), three data files (0.12 MB) and small API reads. The stream and the models already came
from edges. A join wave of 4,000 would have moved 10 GB from the host.

Two of those are immutable and the same for everyone, so they are copied to the asset CDN and loaded from there:

| What | On the CDN | How the page comes to load it there |
|---|---|---|
| The replica (`replica.js` and the `replica_bg.wasm` beside it) | `assets/replica/<version>/`, the launcher's own version (16 hex of sha256 over both files) | The launcher adds `v2ReplicaCdn` to the page's config. index.html's head script checks it is this CDN's address for the version `v2Replica` names, fetches it and leaves `<cdn address>#<origin path>` for the stream worker, which loads the CDN's copy, or the origin's when that does not load |
| The web build's own files (everything in its `assets/` folder: scripts, styles, data, images, sounds) | `assets/app/<name>`, and `assets/app/sets/<set>.json` once all of one build's files are stored | The launcher adds `appCdn` to the page's config. index.html's loader asks for both phases' files there by name. The built code names its files by where it was loaded from, so everything they load follows. A worker cannot be started from another origin, so the loader starts each from a same-origin blob that imports the worker's file from the CDN |

What stays on the host per new viewer: the page itself (no-cache, kept 2 s by the launcher), `main-*.css` (the page
links it before any script runs), the world's snapshot and small API reads, and `bodies.json`. Measured in a real
browser on a build of this change, with the CDN's copy of the build's files answered from the same build: 20 files and
0.36 MB from the host, 0.32 MB of it the snapshot.

**The page is never sent to a copy that is not there.** The world's cutover binding names the CDN (`firstLoadOrigin`),
and the launcher then looks there itself, once a minute until it finds them: a `HEAD` of both replica files of its
version, and of the marker of its own build's file set (`tools/world-launcher/app-files.mjs`: the set id is a hash
over every file name and sha256 in its `assets/` folder). Only then does it name the copy to pages. After a release,
until the mirror below has run, pages load the host's files exactly as before. A build whose `assets/` folder holds
anything that cannot be copied by name (a subfolder, a file without a content hash) has no set and stays on the host.

**The page still arrives when the CDN does not answer.** An entry script that does not load from the CDN reloads the
page once with `?appcdn=0`, which loads the host's files; the stream worker loads the host's replica when the CDN's
does not load. A visitor can add `?appcdn=0` or `?replicacdn=0` to ask for the host's copies.

| Part | Where |
|---|---|
| Copies the replica and the build's files from the live origin to the CDN, verified | `tools/cdn/mirror-first-load.mjs` |
| Lists the build's files and their set id at `/__sim/app-files.json` | `tools/world-launcher/app-files.mjs`, `launcher.mjs` |
| Looks for the copies and writes `v2ReplicaCdn` and `appCdn` into a routed world's page | `tools/world-launcher/cutover.mjs` (`edgeLook`, `v2Fields`), switched by `stream-cdn-switch.mjs --first-load` |
| The replica: the head script's decision, the worker's fallback | `apps/web/src/v2-engine/replica-cdn.ts`, `snapshot-prefetch.ts`, `v2-engine/replica-served.ts` |
| The build's files: the loader's choice, its `Worker` wrapper and its reload | `apps/web/src/app-cdn.ts`, `phased-entry.ts`; `builtUrl` in `apps/web/vite.config.ts` |
| The gauge: what one cold load asks each host for | `tools/cdn/first-load.mjs` |

**Steps.** No Cloudflare setting changes: `cdn.soul.game` already keeps what the bucket serves, and the bucket's CORS
rule already lets `https://soul.game` read it.

1. Release owner, once, on the production host, after a release that carries this is live:
   `sudo node /srv/sim-worlds/production/tools/world-launcher/stream-cdn-switch.mjs --first-load eden on`
   (`off` turns it back; pages loaded after that load the host's files). Worlds with no old twin follow the first
   binding's setting.
2. Release owner, after every release, from a checkout with the R2 credentials (see Publishing):

   ```sh
   EDEN_ASSETS_CREDENTIALS=<file> node tools/cdn/mirror-first-load.mjs https://soul.game/w/eden/ --apply --out <new>/first-load-receipt.json
   ```

   It reads the page, the replica and the listed files from the live origin (about 160 requests, once), stores what
   the CDN does not have yet (a file whose name did not change since the last release is found, not stored again),
   writes the marker last, and reads every copy back through `cdn.soul.game` as a browser on `soul.game` gets it.
   Without `--apply` it only reads the origin and prints the plan; `--check` reads the CDN's copies without
   credentials. Within a minute the launcher names the copies to new pages.
3. Check with one cold load: `node tools/cdn/first-load.mjs <outDir> https://soul.game/w/eden/`. `byClass` should
   show no `replica` and one `bundles` file (the style sheet) on `soul.game`, and `totals.host.bytes` near 0.36 MB.

**Not on the CDN, and why.** The page (it carries the world's live config). `main-*.css` (0.014 MB; the page's first
paint waits for it, and it is linked before the loader runs). The world's snapshot (0.32 MB, the largest thing left):
it is an API answer of the old world's views, public but not immutable, and needs the `soul.game` record or a second
proxied name to be kept at an edge ([the site behind the CDN](#the-site-behind-the-cdn)). The home page's own code:
its config is not written by the cutover binding, so it loads from the host.

Tests: `node --test tools/cdn/mirror-first-load.test.mjs tools/cdn/first-load.test.mjs tools/world-launcher/app-files.test.mjs
tools/world-launcher/cutover.test.mjs apps/web/src/v2-engine/replica-cdn.test.ts apps/web/src/phased-entry.test.ts`.

## The site behind the CDN

The launcher and the worlds key every per-address limit on the first `X-Forwarded-For` entry. With the site record
proxied, Caddy's default would keep what the CDN sent and append, and the CDN appends to whatever the visitor sent, so
the first entry would be the visitor's own text; and without trusted-proxy settings every viewer would come from a
CDN address and be refused at the per-address ceiling. Two files in `tools/world-launcher/deploy/caddy/` fix that:

| File | Installed as | Does |
|---|---|---|
| `cdn-trust.snippet` | `/etc/caddy/cdn-trust.snippet`, imported **inside** the Caddyfile's global options | Trusts `CF-Connecting-IP` only from Cloudflare's published ranges (static, on one line: Caddy silently drops ranges written in a block) |
| `soul-game.caddy` | `/etc/caddy/sites/soul-game.caddy` | Proxies `https://soul.game` to the production port with `X-Forwarded-For` replaced by exactly `{client_ip}` |

`{client_ip}` is the `CF-Connecting-IP` value for a peer in those ranges and the TCP peer for anyone else (or when the
header is missing or not an address), so the launcher always sees one entry, never an empty one. The trust applies to
every site on the host, but only to requests from CDN addresses. `GET /__sim/whoami` answers `{address}`, the address
the launcher keyed that request on (an entry that is not an address answers `null`).

**When the launcher cannot answer** (stopped, restarting, a release), the CDN cannot cover for it: `stale-if-error` is
ignored for the page's `no-cache`, and the CDN's always-online feature fires only when the origin is unreachable, not on
a 502. So the site file replaces Caddy's own 502, 503 or 504 with `poster.html`, read from the live release
(`/srv/sim-worlds/production/tools/world-launcher/deploy/caddy/`, so nothing extra is installed): "Back in a moment"
and a reload after a random 3 to 8 s, so visitors who waited together come back spread out, and the world once the
launcher answers. It is sent as `503` with `Retry-After: 5` and `no-store`, so neither the edge nor a crawler keeps it.
Only a `GET` that accepts HTML outside `/__sim/`, `/v1/` and `/w/<world>/v1/` gets it: agents, API calls, health checks
and WebSockets keep the real status, and a status the launcher itself sends is never replaced. It shows no world
picture: the picture's URL carries its hash and the launcher applies moderation vetoes when it serves one (the files
stay on disk), so neither Caddy nor a static page can choose it safely while the launcher is down. It does not cover
the machine itself being down. Test: `node --test tools/world-launcher/deploy/caddy/poster.test.mjs` (needs `caddy`).

`node tools/world-launcher/deploy/caddy/check-soul-game.mjs [--origin https://soul.game] [--world eden]`, with
`SOUL_CHECK_TOKEN` set to a scratch Soul's token in the environment, checks from outside: `address` (whoami equals
the `ip=` line of `/cdn-cgi/trace` on the same name), `forged` (the same with a forged `X-Forwarded-For`), `viewer`
(a viewer WebSocket gets its welcome), `agent` (a request with no browser headers to `/__sim/healthz` and a token-less
`POST /w/<world>/v1/edge/act` get the launcher's JSON, not a challenge), `events` (the first event of
`/w/<world>/v1/edge/events` within 5 s), `ranges` (the snippet's ranges equal the published lists) and `cache` (the
cache rule below: the world page's script bundle, its first snapshot part, a release-stable file, `--stable`, default
`/mars-assets/draco/draco_decoder.wasm`, and the snapshot under the page's own key, each requested twice with the
second a `HIT`; the snapshot under a stale key is `no-store` and never a hit). It prints each problem and PASS or FAIL;
`--points cache` runs one point. Edge caches are per site, so a hit here says nothing about other locations. Tests:
`node --test tools/world-launcher/check-soul-game.test.mjs` (A1/A2 need `caddy` on `PATH` or in `$CADDY`) and
`node --test tools/cdn/origin-cache.test.mjs` (the rule, and the `cache` point through a stand-in CDN).

### The cache rule

A CDN caches by file extension by default and never JSON or extension-less paths, so the content-addressed parts,
profile photos and the snapshot would read `DYNAMIC`, and the release's `cdn-walk` fails any hashed or release-stable
response that does (`tools/cdn/origin-cache.mjs`). One cache rule in the `soul.game` zone fixes that. Its paths are
`CDN_CACHE_RULE` in `origin-cache.mjs`, derived from the same classes the release checks plus the keyed snapshot; the
test checks that this page carries `cdnRuleExpression()` exactly:

```
http.host eq "soul.game" and ((http.request.uri.path strict wildcard "/w/*/v1/world/part/*" or http.request.uri.path strict wildcard "/w/*/v1/souls/*/profile-photo/*" or http.request.uri.path strict wildcard "/w/*/v1/world/snapshot") or ((http.request.uri.path strict wildcard "/assets/*" or http.request.uri.path strict wildcard "/w/*/assets/*" or http.request.uri.path strict wildcard "/w/*/art/*" or http.request.uri.path strict wildcard "/modular/*" or http.request.uri.path strict wildcard "/mars-assets/*" or http.request.uri.path strict wildcard "/world-assets/*" or http.request.uri.path strict wildcard "*.wasm" or http.request.uri.path strict wildcard "*.woff" or http.request.uri.path strict wildcard "*.woff2" or http.request.uri.path strict wildcard "*.ttf" or http.request.uri.path strict wildcard "*.otf") and not http.request.uri.path contains "/v1/" and not http.request.uri.path contains "/__sim/"))
```

| Setting | Value |
|---|---|
| Cache eligibility | Eligible for cache |
| Edge TTL | Use cache-control header if present, bypass cache if not |
| Browser TTL | Respect origin TTL |
| Cache key | The default (the query string is part of it: the snapshot's `v=` key is) |

The rule only makes these paths eligible; the origin's `Cache-Control` decides. Bundles, stored objects, parts, art and
photos are `immutable` for a year, release-stable files keep an hour or more, and the snapshot is
`public, max-age=0, s-maxage=86400` only when `?v=` is the world's current key (`apps/server/src/edge-snapshot.ts`),
`no-store` otherwise, so a stale or invented key never enters the cache. A `no-store`, `private` or header-less answer
on an eligible path is never kept. No path that can answer per user is eligible: the static patterns never match under
`/v1/` or `/__sim/`, and the three API reads are public by design (moderation-filtered, no auth read). The page,
`/v1/config` and the world list stay outside it. Add no rule that bypasses everything else: other paths keep the CDN's
default, which also respects the origin's headers.

### Hands-on steps, in this order

The release never writes Caddy's configuration. Do these once, after a release that carries both files is live.

1. **Install the site file and the snippet** on the production host, as root. The live `https://soul.game` block
   must be in no other site file (Caddy refuses a site defined twice): if it is, first move every other handler it
   has into `soul-game.caddy` in a reviewed change, then delete that block in the same step as the install. First
   put the import inside the global options of `/etc/caddy/Caddyfile` by hand, so it reads:

   ```caddy
   {
   	admin 127.0.0.1:2019
   	import cdn-trust.snippet
   }
   import sites/*.caddy
   ```

   Then:

   ```bash
   bash -s <<'INSTALL'
   set -uo pipefail
   SRC=/srv/sim-worlds/production/tools/world-launcher/deploy/caddy
   PORT="$(sed -n 's/.*--port \([0-9][0-9]*\).*/\1/p' /etc/sim-worlds/production.conf)"
   [[ "$PORT" =~ ^[0-9]+$ ]] || { echo "no --port in production.conf: stopping, nothing changed"; exit 1; }
   [ -f "$SRC/soul-game.caddy" ] && [ -f "$SRC/cdn-trust.snippet" ] || { echo "the live release has no soul-game.caddy: ship it first"; exit 1; }
   grep -lE '^https://soul\.game[ ,{]' /etc/caddy/sites/*.caddy | grep -v '/soul-game\.caddy$' && { echo "soul.game is still defined above: move it first"; exit 1; }
   grep -qE '^\s*import cdn-trust\.snippet' /etc/caddy/Caddyfile || { echo "the Caddyfile's global options do not import cdn-trust.snippet: stopping, nothing changed"; exit 1; }
   for f in /etc/caddy/sites/soul-game.caddy /etc/caddy/cdn-trust.snippet; do [ -e "$f" ] && cp -a "$f" "$f.bak.$(date +%s)"; done
   sed "s/@@PRODUCTION_PORT@@/$PORT/g" "$SRC/soul-game.caddy" > /etc/caddy/sites/soul-game.caddy
   cp "$SRC/cdn-trust.snippet" /etc/caddy/cdn-trust.snippet
   caddy validate --config /etc/caddy/Caddyfile || { echo "caddy validate failed: restore the .bak files; Caddy was NOT reloaded"; exit 1; }
   systemctl reload caddy && echo "installed; Caddy reloaded"
   INSTALL
   ```

   Before the record is proxied, the check fails only `address` (no trace page yet) and `cache` (no cache status);
   `forged` must already pass.
2. **Turn off bot challenges and script rewriting** in the CDN zone: no Bot Fight Mode, managed challenge, Browser
   Integrity Check or challenge rule on `/v1/*`, `/w/*/v1/*`, `/__sim/*` or the page, and no Rocket Loader, Email
   Obfuscation, minification or injected scripts on any path. Agents' command-line clients, the release's health
   checks, the walk and eyes runners and the off-box watcher are not browsers, and the page depends on its inline
   script order.
3. **Keep the sign-in records unproxied** (DNS only): Clerk's records for the domain must answer from Clerk.
4. **TLS mode Full (strict)**: the CDN connects to the origin over HTTPS and checks Caddy's certificate.
5. **Switch the `soul.game` record to proxied, together with [the cache rule](#the-cache-rule)** (never one without
   the other: without the rule the next release's `cdn-walk` fails).
6. **Soak**: run `check-soul-game.mjs` from outside until it prints PASS, then keep it and the release's health checks
   running through a busy period. The CDN restarts sockets without notice, so viewer bars are measured at the origin.
7. **Last, restrict the firewall** so ports 80 and 443 accept only the ranges in `cdn-trust.snippet`. Leave SSH as it
   is.

The deploy and backup workflows reach the host by `SIM_DEPLOY_HOST`: it must stay a name that is not proxied (or
the address), since the CDN carries only HTTP(S).

**Rollback** is the DNS switch: set the `soul.game` record back to DNS only (if step 7 is done, first reopen 80 and
443 to everyone). The site file and snippet can stay: for a peer outside the CDN ranges `{client_ip}` is the peer
itself, which is what the launcher saw before.
