# Visitor analytics

The web app counts visitors with [GoatCounter](https://www.goatcounter.com). No GoatCounter script is loaded:
`apps/web/src/visitor-counts.ts` sends GoatCounter's own count requests itself, so the page runs no third-party code.
Counting is cookieless and sends nothing personal.

## What is counted

| Count | Sent as |
|---|---|
| A world page view | path `/w/<slug>`, whatever the base (`/worlds` or root) |
| The world list | path `/` |
| Referrer | another site's origin only; one of the site's own pages as its counted path. A signed-out visit that goes through the Clerk session sync first keeps the referrer it arrived with (#1385). |
| Screen | its width only (GoatCounter's phone/tablet/desktop split) |
| `enter world <slug>` | event, once the arrival card is gone (or the first live frame is drawn) |
| `soul paired` | event, once per approval of a Soul for an agent |
| `god connected` | event, when a world's god is approved |

A count never carries a query string, a hash fragment, a Soul id, a pairing or window code, or a token. Events have
fixed names. Each request goes out with `sendBeacon`, falling back to an image with `referrerPolicy = 'no-referrer'`.

## What is not counted

- Local and private hosts: `localhost`, `*.localhost`, `.test`, `.local`, `.internal`, `.lan`, `.home.arpa`,
  Tailscale MagicDNS names, loopback, private, link-local and CGNAT addresses. So dev servers, tests and e2e runs never count.
- Automated browsers: `navigator.webdriver` is true for every Playwright run, including the release probe, walks,
  poster, stall and cdn-walk.
- Screenshot looks: any URL with `?shot`.
- A browser that set `localStorage.skipgc = 't'` (GoatCounter's own opt-out).
- A build with `SIM_GOATCOUNTER=off`.

## Configuration

`SIM_GOATCOUNTER` is read at build time (`apps/web/vite.config.ts`). It is a GoatCounter site code (counts go to
`https://<code>.goatcounter.com/count`), a full `http(s)` count URL for a self-hosted counter, or `off` / `0` / empty
to disable counting. Without it the build uses the site's default code from `vite.config.ts`. `release.sh` passes it
through, so a release can override it.

## Content-Security-Policy

World pages currently send only `Content-Security-Policy: frame-ancestors 'none'` (`apps/server/src/http.ts`). If a
fetch or image directive (`connect-src`, `img-src`, `default-src`) is ever added, it must allow the counter origin,
or the counts stop silently.

Tests: `apps/web/src/visitor-counts.test.ts`.

# Daily usage table

Visitor counts say who looked. The usage table says which accounts and Souls acted, across every world, by UTC day.
It is operator data: it lives in `<data>/usage.sqlite` on the launcher's host and nothing in it is published.

`tools/world-launcher/usage.mjs` runs in a child process of the launcher, 30 seconds after the launcher starts and
then every hour. It rolls up every day since the last one it rolled up (at most 31 days back) through yesterday,
opening each world's `sim.db` read-only:

| Table | One row per | Holds |
|---|---|---|
| `usage_daily` | day, world, Soul | owning account id, acts (`edge_receipts_v1`), refusals (`edge_refusals_v1`), requests and the client of the latest one (`edge_clients_v1`), first and last activity |
| `usage_refusals` | day, world, refusal code | how many |
| `usage_worlds` | day, world | `read`, or `skipped` with the reason |

A world whose database is busy or missing is tried three times, two seconds apart; if it is still unreadable it is
marked `skipped` for that day and gets no rows, never zeros. Rolling a day up again replaces that day's rows, and a
good earlier read stands if a later one fails. Only the account id already stored with each Soul is kept: no token,
email, name or text.

`node tools/world-launcher/op.mjs usage --port <launcher port> [--days N]` (loopback only, `GET /__sim/usage`) prints,
for each of the last N rolled-up days (default 7): active accounts, new and returning accounts, active Souls, acts,
refusals with the top five codes, Souls by client version and any world skipped; then each account active in that
span with its first and last day seen and days active. Worlds flagged as test worlds in the registry are left out. A
visitor who only watched is not counted.

To roll one day up by hand: `node tools/world-launcher/usage.mjs --data <launcher data dir> --day YYYY-MM-DD`.

Tests: `tools/world-launcher/usage.test.mjs`.
