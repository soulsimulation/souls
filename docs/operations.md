# Operations

How the public site runs: `https://soul.game` on the root-only production host, with immutable assets on
`https://assets.eden.art`. Hosts, SSH users, keys and credentials live in deployment secrets and host settings, never
in the repository.

| Page | For |
|---|---|
| [release](release.md) | Shipping a commit: gate receipt, `ship.sh`, `release.sh`, handover, rollback |
| [runbook](operations/runbook.md) | Day-to-day commands: health, logs, backups, worlds, the legacy stage |
| [disaster recovery](operations/disaster-recovery.md) | A blank host to a serving site |
| [CDN](operations/cdn.md) | `assets.eden.art`: publishing, verification, the uploads Worker |
| [auth](operations/auth.md) | Clerk sign-in and the shared account registry |
| [analytics](operations/analytics.md) | Cookieless visitor counts |

## Services and stages

Each stage is one systemd unit, `sim-worlds@<stage>`, running as the unprivileged `simworlds` user. The unit runs the
keeper (`tools/world-launcher/keeper.mjs`), which holds the stage's port and runs the world launcher from the release
the stage link `/srv/sim-worlds/<stage>` points at. The launcher runs one Souls server process per world on a private
loopback port and proxies HTTP, SSE and WebSocket traffic to it, starting worlds on demand and letting idle ones sleep.

| Stage | Public paths | Settings | Data |
|---|---|---|---|
| `production` | `/`, `/w/<slug>/` | `/etc/sim-worlds/production.conf` | `/srv/sim-worlds-data/production` |
| `legacy` (historical topology) | Not a second stage on the current public host | `/etc/sim-worlds/legacy.conf` | `/srv/sim-worlds-data/legacy` |
| `staging` | none (loopback, dev auth) | `/etc/sim-worlds/staging.conf` | `/srv/sim-worlds-data/staging` |

Each settings file holds one line, `SIM_WORLDS_ARGS=...`: the port, the world port range, data directory, public
origin, auth env file and caps (`--max-worlds`, `--max-running`, `--min-free-mb`, `--world-heap-mb`, `--create-limit`).
`--unload-still 1` lets still worlds leave memory and come back on a request or their alarm
([worlds](architecture/worlds.md), #2299); it stays off (`0`, the default) in production until its proof task has passed.
Their recorded horizons are `<data>/horizons.json`.
At most `--load-parallel` worlds load at once (default 4); the rest wait in order: a Soul's act or a god call, a
visitor's connection, an alarm for a listening agent, a wind-down alarm, then anything else (keep-alive, monitors),
oldest first within each. A request for a world that is unloaded, waiting or loading is held up to `--load-hold-ms`
(default 45,000), then answered `503 world.waking` with `Retry-After`, which the Soul client waits out and asks again.
Declared crawlers and link-preview fetchers never load a world: they get its page (the web build's, with the world's
title and links) and `503 world.unloaded` for anything else. With `--unload-still 1` a visitor's page and the build's
files are served the same way, and the world loads on the page's live connection or first data request (a page hidden
for five minutes closes that connection and opens it again when shown, #2305, unless its God modal is open); nothing loads
at start but what an alarm or a request asks for (`--eager` applies only with `0`), and a handover leaves a still world
with no visitor unloaded instead of moving it (#2304). The loopback `/__sim/healthz` has `loads`: loads running and
waiting, by reason, and the wait of the last 100 (median, 95th percentile, longest).
`tools/world-launcher/deploy/install.sh` writes the production and staging files once and never edits an existing
one. Memory limits are per-stage systemd drop-ins (`sim-worlds@<stage>.service.d/10-memory.conf`).

**Memory for worlds (#2233).** `--worlds-mem-mb` is the memory all of a stage's worlds may use together. A world loads
only while the running worlds' measured memory (Pss, read at most every 30 s) plus a fixed estimate for each world
loading (310 MB for a small world, 650 MB for an Eden-class one, chosen by the template's size: the load peaks #2232 measured) stays under it;
`--min-free-mb` stays a second guard, and `--max-running` no longer limits. To make room the launcher unloads a still
world whose next event is at least 60 s away, then a world with no act and no visitor for 10 minutes (`--idle-ms`), the
one acted in longest ago first; a world someone is acting in or watching is never unloaded. When nothing can go the load
is refused with the retriable `503 world.capacity`, and `/__sim/healthz` carries the host problem code
`worlds.capacity` for 10 minutes. Each world's `state` (`awake`, `still`, `unloaded`, `starting`, `failed`) is in
`/__sim/worlds.json` beside the old `status`; the health page (`/__sim/health?json=1`) adds per world its ticks computed
and jumped in the last hour (from the world's own counters, once it reports them), seconds in memory in 24 h, Pss and
last load reason, and in total the worlds awake, still and unloaded and the memory used against the figure.

One command sets a stage's capacity: `bash install.sh capacity <stage> <GB>`, as root on the host. It rewrites the
memory drop-in and, in `<stage>.conf`, `--worlds-mem-mb`, `--max-running`, `--range` (two ports per world that can run,
above the stage's `--port`; it refuses a range that would reach another stage's ports) and `--max-worlds`, prints
before and after, and takes effect at the next restart. An ordinary release never runs it; `release.sh <stage>
--capacity <GB>` runs it once and restarts. The production host's worlds may use 24 GB of its 31 GB (#2241); the
release owner applies it. What each figure gives (production, `--port 4620`; small and Eden worlds at their settled
memory of 250 and 575 MB, #2240):

| GB | MemoryHigh / Max | `--worlds-mem-mb` | `--max-running` | `--range` | `--max-worlds` | Small worlds settled | Eden-class settled |
| ---: | --- | ---: | ---: | --- | ---: | ---: | ---: |
| 8 | 8G / 10G | 6,144 | 24 | 4621-4668 | 60 | 24 | 10 |
| 16 | 16G / 18G | 14,336 | 57 | 4621-4734 | 114 | 57 | 24 |
| 24 | 24G / 26G | 22,528 | 90 | 4621-4800 | 180 | 90 | 39 |

`--max-worlds` is at least twice `--max-running` (an existing higher value is kept): unloaded worlds cost only disk.

Caddy terminates TLS and sends the canonical root site to production; `souls.game` redirects to `soul.game`.
`sim.eden.art`, the former origin and still the Clerk primary origin, moves to the production host. There it
redirects to `soul.game` with the same path and query (301 for GET and HEAD, 308 otherwise), except `/sign-in`, which
is the launcher's own primary sign-in bridge. Its site file is
[`deploy/caddy/sim-eden-art.caddy`](../tools/world-launcher/deploy/caddy/sim-eden-art.caddy), installed once at cutover;
the release never writes Caddy's configuration. `node tools/world-launcher/deploy/caddy/check-sim-redirect.mjs` checks
it from anywhere ([Clerk satellite](operations/clerk-satellite.md#simedenart-on-the-production-host)).
The canonical worlds are `/w/eden/`, `/w/mars-college-2026/` and `/w/mars-college-2027/`.
Keep the configured asset-serving rules and old world URL aliases intact. The Clerk primary remains on the
eden.art instance: old identity-provider URLs are intentional, not blanket rename targets. After a host reboot,
check that Caddy is active (`systemctl is-active caddy`).

The former `/worlds` production plus `/` legacy topology remains supported by some tools, but is not the current
public deployment. [Release](release.md) identifies the root-only automation gap; do not apply legacy activation
or proxy examples to this host. Internal `sim-*` service and data names remain unchanged.

## Health

- `GET https://soul.game/__sim/healthz`:
  `{ok, service, build, auth, worlds, running, maxWorlds, maxRunning, hostOk, hostCodes?, clientErrorsNew}`. `hostOk`
  and short `hostCodes` are public; the numbers behind them are for loopback requests only.
- `GET /__sim/health`: a health page for site owners (accounts listed in `SIM_SITE_OWNERS`) or loopback; build,
  host, every world, backups, arrivals, new client errors and alerts (`tools/world-launcher/health-dash.mjs`). A signed-in
  site owner can set any world's list picture with the Picture button on its row; the audit log records it as `site-admin`.
- `GET /w/<slug>/healthz` carries `halted` and `glitches`: `{total, byRule: {rule: {rung: n}}}`, every refusal, recovery and halt
  the world has had. It is public, so rule names and counts only. Each glitch also writes one `[world] glitch` line to
  the world's log and one row to its store, with the bodies, the tick and the evidence: `op.mjs glitches --port <port>
  --base / [--world <slug>]` reads those, for sleeping worlds too. The health page shows the counts. A halted world is the
  `halted` problem code, so `hostOk` goes false and `host-health.log` gets its ALERT line; a refusal or recovery raises no alert
  until real numbers set a rate threshold ([#1150](https://github.com/soulsimulation/souls/issues/1150)). A rewind (rung 3), or a stop on the spot that stopped something, is the
  `rewound` problem code, held for two checks so one always sees it: several in a window show as one line with the latest
  count, and it clears on its own. A world with half its ticks faulted over 10 s of world time counts as `halted` too, though
  its clock runs: it refuses acts with `world.step-failing` until the faults fall away, and the glitch rule is `engine.step-failing`.
  The launcher restarts a halted world every time, since a restart boots from its last snapshot and the log; each restart
  counts toward the breaker ([#1326](https://github.com/soulsimulation/souls/issues/1326), [#2133](https://github.com/soulsimulation/souls/issues/2133)).
- **What each halt becomes** ([#1511](https://github.com/soulsimulation/souls/issues/1511); each path is tested in
  `apps/server/src/halt-paths.test.ts`). Every one stops the clock (or, for step-failing, refuses acts) and sets
  `live.json` `halted`, which the launcher's guard acts on. None is silent.

  | Halt (glitch rule) | Where | In the process | Then |
  |---|---|---|---|
  | `durability.clock-frontier`, `engine.unhashable` | `persistClockFrontier` on the tick | the tick throws: the process exits | the launcher restarts it from the log (backoff; 5 failures in 30 min: `held`) |
  | `durability.clock-frontier` | `snapshotFaultedHead` (the throw is not rethrown) | clock stopped, process up, `halted` | the guard restarts it within about a poll (10 s); each restart counts toward the breaker |
  | `durability.repair`, `durability.checkpoint` | `failCheckpoint` | clock stopped, process up, `halted` | as above |
  | `engine.halted` | `haltOnFault` (edge worlds) | clock stopped, process up, `halted` | as above |
  | `engine.step-failing` | steps faulting | clock runs, acts refused, `halted` | as above |

  **A halt that repeats at once:** after 5 restarts in 30 min the breaker holds the world (`held`, last reason `halted`),
  down until an operator resumes it, never a silent loop. The alert is then the only exit, so it has to be loud:
  - the world's `halted` problem code makes `hostOk` false;
  - `host-health.log` gets an ALERT line, and the health page shows the world as `halted`;
  - the off-box watcher (sim-watch) reads `hostOk` and `hostCodes` from `/__sim/healthz` and DMs Gene (`host-health.mjs` header).

  A crash loop ends `held` (down, shown as resting) after 5 failures in 30 min, until it is resumed. Outside the launcher
  (local dev, tests), a halted process stays up with its clock stopped.
- `GET /w/<slug>/healthz` also carries `tickAgeMs` (wall time since the last completed tick), `clockRate` and `baseRate`,
  `stalled` and, while the clock is dilated, `slowed`. A world is `stalled` when its clock owes ticks and the last one is
  older than 2 s, or 10 of its expected tick intervals when it runs at a reduced pace; paused, halted and rate-0 worlds
  never are. `live.json` carries the same as `tick.ageMs`, `stalled` and `slowed`, written by the watchdog thread, so a
  stuck main thread still shows. A stalled world is the `stalled` problem code: `hostOk` goes false and `host-health.log`
  gets its ALERT line, then RECOVERED once it ticks again. It isn't restarted for it. Edge reads say `world.stalled`
  meanwhile and acts are refused with `503 world.stalled` (`docs/architecture/load.md` §3).
- The repair rules are on by default ([#1323](https://github.com/soulsimulation/souls/issues/1323)): a world whose history
  began without them adopts them at its first boot on 0.120.1 or later, logged as one `rules` event, with the line
  `[world] adopted the repair rules at tick <n> (one way)`. **That is one way: once adopted, a world can't boot on 0.120 or
  earlier**, so a rollback past 0.120.1 needs that world's pre-release backup. Leave `SIM_SOULS_REPAIR` unset.
  `SIM_SOULS_REPAIR=0` stops adoption for worlds that haven't adopted, and is ignored, with a warning, for one that has.
  `SIM_SOULS_REPAIR=1` (or `SIM_SHARED_CARRY=1`, which brings repair) bypasses adoption: an old world then refuses to boot, as
  in 0.120, so don't set it on a server with existing worlds.
  Before a release that changes what a first boot adopts, rehearse each world on the host:
  `node tools/world-launcher/deploy/boot-rehearsal.mjs --db <world data>/sim.db --scratch <new empty dir outside it>
  --from-pid <the world's process>` (or `--env-file`/`--env` with the world's settings) boots an online-backup copy with
  this tree's code, adopts, runs `--ticks` (default 1200) and prints one JSON line: adopted or refused and why, running or
  halted, the hashes before and after. The original is opened read-only and the copy is deleted afterwards.
- `GET /w/<slug>/healthz` also carries `api`: per-route server time (queue and handler p50/p99/p99.9, the last 5–10 min and
  since start) for the Soul and god API, by a closed list of route ids. `live.json` carries the same. Each API answer's
  `Server-Timing` adds `launcher;dur` and `upstream;dur` at the launcher. A main-thread stall over 1 s is a timestamped
  `[stall]` line in the world's log. To place a slow answer, see `docs/architecture/load.md` §4 (#1750).
- `sim-worlds-health@<stage>.timer` runs `deploy/host-health.mjs` every 10 minutes: disk, memory, the unit's working
  set against its `MemoryMax`, OOM kills and the last backup. It writes `<data>/host-health.json` and appends an
  ALERT/RECOVERED line to `<data>/host-health.log`; the launcher folds the result into healthz. An external monitor
  can alert on `hostOk`.

## Soul API ceilings

The launcher refuses Soul API traffic past these defaults (`SOUL_CEILINGS` in `tools/world-launcher/flood.mjs`), sized
so 100 Souls behind one address, or under one account, each holding a listen and acting every 10 s, are never refused
(#1949): 600 requests per address in 10 s, 202 requests in flight per address, 200 listens per address, 4 per Soul,
200 per account, and 1,200 heavy (C1/C2) requests per account a minute. The world budget is 200 heavy requests a second.
`node tools/world-launcher/op.mjs set-limits --port <launcher port> --slug <slug> --limits '{...}'` overrides any of
them for one world, at once (`null` restores a default).

## Backups

`sim-worlds-backup@<stage>.timer` runs nightly (`deploy/backup-restic.mjs backup <stage>`). It copies every SQLite
database of the stage with SQLite's online backup API, checks each copy with `PRAGMA quick_check`, adds the registry,
audit log, uploaded assets, old-world fork inputs and the stage's non-secret host settings, and takes one deduplicated
restic snapshot. Retention keeps 7 daily, 4 weekly and 6 monthly snapshots (`SIM_BACKUP_KEEP`), locally and
off-site. Every release also takes its own compact pre-release copy. Commands are in the
[runbook](operations/runbook.md#backups).

### Off-site copy

Production's snapshots are also copied each night to a private S3-compatible bucket the maintainer chose (#557). The
destination and its key pair are the repository secrets `BACKUP_OFFSITE_URL`, `BACKUP_S3_KEY_ID` and
`BACKUP_S3_SECRET`; the `offsite-backup` workflow writes them into the host's `/etc/sim-worlds/backup.env` as
`SIM_BACKUP_OFFSITE`, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (root:simworlds 0640), and the nightly backup then
copies each new snapshot there and applies the same retention. Nobody needs ssh for any of it:

```sh
gh workflow run offsite-backup.yml --ref main                 # write the settings, copy now, check, restore drill
gh workflow run offsite-backup.yml --ref main -f configure=false -f copy=false            # a restore drill only
gh workflow run offsite-backup.yml --ref main -f configure=false -f copy=false -f drill=false -f recovery_key=true
```

The copy step copies without a new local snapshot and deletes nothing, then runs `restic check` on the off-site
repository. The drill restores the latest off-site snapshot into an empty temporary directory on the host (after a
free-disk check, never a production path), quick-checks every database, boots the smallest world from it with fake
minds on a free loopback port, prints its state hash and deletes the directory. The workflow prints counts and sizes
only.

**The recovery key.** The restic password (`/etc/sim-worlds/restic.pass`) lives only on the host, and without a
password the off-site copy cannot be opened. The maintainer keeps his own: a password saved in his password manager
and also stored as the repository secret `BACKUP_RECOVERY_PASSWORD`; the workflow's `recovery_key` step adds it as a
second key of the off-site repository and checks that it opens it. GitHub never shows a secret again, so the password
manager is the copy that counts. To restore after losing the host, put that password in a file and point restic at
the bucket (`RESTIC_REPOSITORY=<the destination>`, `RESTIC_PASSWORD_FILE=<that file>`, the key pair in the
environment), then follow [disaster recovery](operations/disaster-recovery.md#4-data).

Restore drills from the off-site copy: none yet (the first runs when this workflow is first dispatched).

## Logs

- Unit and keeper: `journalctl -u sim-worlds@<stage>`.
- Each world: `<data>/logs/<slug>.log` (rotated by the launcher).
- Handover state: `<data>/keeper.json`.
- Host checks: `<data>/host-health.log`.
- Visitors' page errors: pages post to `/__sim/client-errors`; `node tools/world-launcher/op.mjs client-errors --port
  <port> --base /` summarises them on the current root-only host. Use the actual configured base for other deployments.
- Operator actions: `<data>/audit.jsonl` (`op.mjs audit`).

## Platform feed

Every client pulls site news from `<base>/v1/feed?after=<id>&limit=N` (public, cached 60 s, no credentials). Post from
the host: `op.mjs feed-post --port <port> --base / --kind announcement|release|world|event --title "…" [--body …]
[--url https://…] [--starts-at …] [--replaces <id>]`. `<data>/feed.jsonl` is append-only: correct an item by posting one
that replaces it. `op.mjs feed-stats` prints reads per UTC day by client version (`x-soul-client`); no ids are kept.

## CDN

Reviewed immutable assets (models, textures, the Mars campus, the humanoid kit) are content-addressed objects on
`assets.eden.art`. The web build carries a manifest that maps origin URLs to CDN keys; the client checks length and
SHA-256 and falls back to the origin on any failure. God uploads go through a pull-through Cloudflare Worker on
`assets.eden.art/w/*`. See [CDN](operations/cdn.md).

## Auth

Signed-in actions use Clerk. The launcher reads only the public Clerk settings from the stage's auth env file and all
worlds of a stage share one account registry. See [auth](operations/auth.md).

## Analytics

Page views and three events are counted without cookies and without any query string, hash, Soul id or token.
Automated browsers are not counted. See [analytics](operations/analytics.md).
