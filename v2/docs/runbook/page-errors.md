# Page errors: what goes wrong in visitors' pages

Engine v2 O25 (#3336). What a real visitor's page hits reaches the operator, counted, scrubbed and bounded, as it does
today (`apps/web/src/client-errors.ts` and the launcher's `client-errors.mjs`, carried over with their limits).

## The three parts

- **The beacon, in the page:** `v2/web/src/report/beacon.ts`, imported first by `draw/main.ts`. It reports a JS
  exception (`js`), an unhandled rejection (`rej`), a lost WebGL context (`gl`), an asset that failed (`asset`: the
  models' index or a model file, `things/models.ts`; the crowd's bodies, `draw/main.ts`; `res`: a script or image
  element), a stream part that failed three times in a row (`stream`, `source/stream.ts`, in place of today's `ws` and
  `storm`), and an arrival that never finished (`arrival`: no first live frame 60 s after the stream started). One
  report per kind per page (repeats add to its count, sent when the page is hidden), at most 12 a page, sent 3 s after
  the first. It is on when the page build is named (`V2_BUILD` at `vite build`), or with `?errors=1`; `?errors=0`
  turns it off. It never throws and never delays arrival.
- **The service:** `v2/tools/page-errors/serve.mjs`, the unit `v2/tools/ops/units/page-errors.service`, on loopback
  port 7330 behind the front door's route for `/__sim/client-errors`. A POST stores; 429 past the limits, and nothing
  stored. It scrubs every text again: no query strings, quoted text, tokens, ids, emails, addresses or title-case words
  that may be a Soul's name reach disk. The data folder (`/var/lib/souls/page-errors`) holds `agg.json` (the table of
  kinds, at most 500), `events.jsonl` and one rotated file (at most 512 KB together), and `health.json`.
- **The watcher's rule:** the look on the machine (`v2/tools/ops/watch/look.mjs`) carries `health.json`'s new kinds;
  the watcher (`watch.mjs`) sends one message for each kind new since the page build went live, and nothing while it
  stays listed. A new release starts the list again. See [alerts.md](alerts.md).

## Read the summary

On the machine itself (the summary is answered only to loopback, never through the proxy):

```text
curl -s http://127.0.0.1:7330/__sim/client-errors | jq '{build, since, kinds, newSinceRelease, top: [.top[] | {kind, message, source, count, visitors, browsers, builds, new}]}'
```

`?limit=<n>` (default 50) and `?world=<id>` narrow it. Each row of `top` is one kind of error: its `kind`, scrubbed
`message` and `source` (the script, or an asset's path without its query), `count`, distinct `visitors` (per UTC day,
from a hash salted per day and kept in memory only), `browsers` (`chrome/desktop`, `safari/phone`, …), `builds`,
`worlds`, first and last seen, and `new` (first seen since the build went live). `arrivals` is the last 24 h of
pages that did arrive: count and p50/p90 ms per world. `stats` counts refusals (`rate`, `size`, `bad`).

`cat /var/lib/souls/page-errors/health.json` shows what the watcher reads: the live build, `newSinceRelease`, and the
new kinds' fingerprints and texts.

## Release

Set the new page build in `/etc/souls/page-errors.env` (`SOULS_BUILD=<the V2_BUILD the page was built with>`) and
restart the unit: kinds seen before stay old, and `newSinceRelease` starts at zero.
