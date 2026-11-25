# God upload CDN

`god-uploads.js` is the module Worker for `cdn.soul.game/w/*` (route on the soul.game zone), with the R2 binding
`ASSETS` → bucket `soul-game-assets`. It pulls cache misses from `https://soul.game/w/<slug>/assets/<sha>.<ext>`, verifies the SHA-256 and size, then stores
at the unchanged `w/<slug>/assets/<sha>.<ext>` key. Old slug keys remain valid: the root launcher must retain those
slug aliases. Never redirect authenticated agent APIs across origins as a substitute for launcher aliases.

## Cutover order

1. Deploy the root launcher and migrate its registry with the documented aliases. Verify upload routes at both
   canonical and old slugs reach the same world. The new Worker requires this upstream before serving cache misses.
2. In the static asset bucket's (`soul-game-assets`) CORS rule, allow exactly `https://soul.game`, `https://souls.game` and `https://sim.eden.art`.
   Retain its methods and exposed headers; do not replace unrelated rules or use a wildcard. This bucket rule is
   separate from Worker CORS. Check a known static object with each Origin header.
3. Record the current Worker version and deployed route/bindings. Deploy this module as a Worker on soul.game's
   account with the route `cdn.soul.game/w/*` (fail open) and the binding `ASSETS` → `soul-game-assets`, using the
   authorized Cloudflare CLI or dashboard. The old Worker on `assets.eden.art/w/*` stays as it is until that bucket is retired. Account IDs, credentials,
   deployment config and receipts belong in private operational records, not this repository.
4. Run the verifier against an authorized scratch god folder. It uploads one fresh small GLB but does not place
   or define it in the world. The folder can name any allowed app origin and `/w/<slug>/` or `/worlds/w/<slug>/`.
   The verifier exercises miss, immediate R2 hit, cache hits, hash refusal and exact CORS for all three origins.

```sh
node --test tools/cdn/worker/god-uploads.test.mjs
node tools/cdn/worker/verify-worker.mjs --self-test --out .local/cdn-self-test.json
node tools/cdn/worker/verify-worker.mjs --god /path/to/authorized/scratch-god --out .local/cdn-live.json
```

Walk the real client on all three origins and check static and uploaded assets render without CORS failures. A loopback
receipt proves the handler contract; it does not prove the Cloudflare deployment or a browser's live rendering.
The Worker grants CORS only to the three exact origins, including on OPTIONS, HEAD, 304, errors and cached replies.
No Origin or any other Origin gets no allow-origin header. Cached bytes are shared, but responses bind CORS to the
current request and vary on Origin.

## Temporary origin-only release

If external CDN configuration cannot be completed, build the release with `SIM_GOD_UPLOADS_CDN=0` to serve uploads
from the world origin. If static bucket CORS is also unavailable, use `SIM_ASSETS_CDN_ENABLED=0`. These are build
settings, so changing them after a build does not alter the shipped app. A prebuilt artifact must match the settings.
Record the fallback in the release receipt and verify origin asset rendering. Re-enable only in a newly built,
verified release. To roll back the Worker, restore the recorded version; its upstream URL must still reach the
active world authority.

The pull-through upstream is soul.game itself: souls.game and sim.eden.art redirect every request there, and the
Worker refuses a redirect, so it must never name either. Verify both fresh and cached responses after the bucket's
CORS rule is set; stale CDN headers may require a targeted cache purge.
