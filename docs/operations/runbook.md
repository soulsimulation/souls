# Runbook

Current production is root-only `https://soul.game`; internal service/data names are unchanged. Legacy-stage
sections describe the former deployment and do not apply to the current public host. Check the release owner’s
approved runsheet before any mutation; see [release topology](../release.md#current-production-topology).

Commands for the running site. They run on the production host as root unless noted; from elsewhere, prefix them
with `ssh "$SIM_DEPLOY_USER@$SIM_DEPLOY_HOST"` (the same target the release scripts read from `deploy.env`). Stage names, paths and units are
described in [operations](../operations.md); releases are in [release](../release.md).

Paths below use the stage's release link, so they always run the live code:

```sh
R=/srv/sim-worlds/production
P=$(sed -n 's/.*--port \([0-9]*\).*/\1/p' /etc/sim-worlds/production.conf)
```

## Health

```sh
curl -fsS https://soul.game/__sim/healthz           # public: build, worlds, running, hostOk
curl -fsS http://127.0.0.1:$P/__sim/healthz            # loopback: also the host numbers
curl -fsS http://127.0.0.1:$P/w/<slug>/healthz         # one world
systemctl is-active sim-worlds@production caddy
systemctl list-timers 'sim-worlds-*'
```

A single response proves reachability only; repeat a world's healthz after a short interval to see its clock advance.
`hostOk: false` comes with short `hostCodes`; the details are in `<data>/host-health.json` and `host-health.log`.
The site owners' page is `https://soul.game/__sim/health`.

## Logs

```sh
journalctl -u sim-worlds@production -n 200 --no-pager          # keeper and launcher
tail -n 100 /srv/sim-worlds-data/production/logs/<slug>.log    # one world
cat /srv/sim-worlds-data/production/keeper.json                # active build, last handover per world
node $R/tools/world-launcher/op.mjs client-errors --port $P --base / [--world <slug>]
node $R/tools/world-launcher/op.mjs audit --port $P --base / [--slug <slug>]
```

## Restarting

- `systemctl reload sim-worlds@<stage>` hands every running world over to a fresh launcher from the current release
  without closing the port (see [release](../release.md#activation-and-handover)).
- `systemctl restart sim-worlds@<stage>` restarts everything; needed after changing the unit or the stage's settings
  file. Each world saves a snapshot on SIGTERM and resumes from it.
- Pairing codes and pending approvals are held in memory; after a restart an agent may need to retry them.

## World operations

`tools/world-launcher/op.mjs` talks to the launcher on loopback only (anything arriving through the reverse proxy is
refused). Every call is an audit row.

| Command | Effect |
|---|---|
| `create-world --name <n> --template <t> (--owner <account> \| --owner-of <slug>) [--slug] [--unlisted]` | A world born owned by an existing account |
| `set-unlisted --slug <s> --unlisted true\|false` | Hide from or show in the public list (still served at its URL) |
| `set-claimable --slug <s> --claimable false` | A world without a god that nobody may claim |
| `archive-world --slug <s> [--reason]` / `list-archive` / `restore-world --id <id>` | Stop and move a world to `<data>/archive/`, or put it back; nothing is deleted |
| `register-fork` / `remove-fork` | Serve or stop an old-world fork (legacy stage) |
| `set-test`, `soul-*`, `god-pending`, `god-approve` | TEST Souls and the probe god on worlds flagged test only |

All take `--port <port>` and `--base /` for production (no `--base` on legacy).

A moved world's static views (`v2-switch.mjs --static`) go in `/srv/sim-worlds-data/production/<slug>-static`, the
one folder the launcher unit lets it write; the switch refuses any other system folder (`v2-switch.static-not-writable`).
The log line `cutover: <slug>'s static views held in memory ... cutover.static-unwritable` means a binding names a folder
the launcher cannot write: the page still works from memory; switch again with the right `--static`.

### Pausing uploads or new worlds

Two site switches stop the two things that can fill the machine, at once and without a release (#2540). They are kept
in `<data>/worlds.json` (`site`), so they survive a restart and go into the backup; each change is an audit row.

```sh
node $R/tools/world-launcher/op.mjs set-site --port $P --base / --uploads off     # god assets, art media, bodies, world thumbnails
node $R/tools/world-launcher/op.mjs set-site --port $P --base / --creation off    # POST /__sim/worlds
node $R/tools/world-launcher/op.mjs set-site --port $P --base / --uploads on --creation on
curl -fsS http://127.0.0.1:$P/__sim/healthz | grep -o '"site":{[^}]*}'        # both switches
```

Off, a `POST` to an upload route is answered by the launcher `503 site.uploads-paused`, and a new world
`503 site.creation-paused`, each with `Retry-After: 600` and a plain message, so a god's build stops with a named,
retriable code. Reads of assets, art and thumbnails, acts, viewing and existing worlds are never refused. Sign-ups are
not paused here: pause them in the sign-in provider's dashboard ([auth](auth.md)).

## Backups

Nightly at 03:30 UTC `sim-worlds-backup@<stage>.service` runs `deploy/backup-restic.mjs backup <stage>` as
`simworlds`:

1. Copies `accounts.sqlite`, `forks/accounts.sqlite` and every `worlds/<slug>/sim.db` with SQLite's online backup API
   (consistent while worlds write) and runs `PRAGMA quick_check` on each copy.
2. Adds `worlds.json`, `audit.jsonl`, the uploaded assets in `worlds/assets`, the fork inputs (`forks/descriptors`,
   `forks/artifacts`) and an allowlist of the stage's non-secret host settings under `host-config/` (its
   `<stage>.conf`, memory drop-in, Caddy site and blobs snippet). Only new or changed files are copied into the
   staging mirror.
3. Takes one restic snapshot of the mirror, tagged with the stage.
4. Applies retention with `forget --prune` (`SIM_BACKUP_KEEP`, default 7 daily, 4 weekly, 6 monthly; `off` deletes
   nothing), then `check` reads a seventh of the data, so all of it is read once a week.
5. Copies the new snapshots to `SIM_BACKUP_OFFSITE` and applies the same retention there, when that is set.

The nightly retention has two rules, one per group of snapshots: the nightly rule above, and the newest 24 hourly
snapshots ([hourly run](#hourly-run)); the nightly rule never removes an hourly snapshot.

The run exits 1 if any database fails its check (the others are still snapshotted); host-health then reports it.
Until restic is set up (no binary, password file or repository) it falls back to dated full copies
(`deploy/backup.mjs`) and says so. The script never creates a repository: create it once with `restic init`.

Settings are in `/etc/sim-worlds/backup.env` (template: `deploy/backup.env.example`; every key has a default). The
repository password file (`RESTIC_PASSWORD_FILE`) is root:simworlds 0640 and must also be kept off the host: without it
the backups cannot be read.

```sh
set -a; . /etc/sim-worlds/backup.env; set +a
node $R/tools/world-launcher/deploy/backup-restic.mjs list [<stage>]
node $R/tools/world-launcher/deploy/backup-restic.mjs restore <stage> <latest|YYYY-MM-DD|id> <empty dir>
```

`restore <stage> YYYY-MM-DD` picks that day's newest snapshot, which may be an hourly one; to get that night's nightly
snapshot, use its id from `list`.

Restore refuses a non-empty directory, lays it out like `/srv/sim-worlds-data/<stage>` and quick-checks every
database (exit 1 if any is bad). To boot one restored world on any machine:

```sh
ENABLE_WORLD_ENGINE=1 SOUL_LIFECYCLE=1 node tools/god-skill/dev-world.mjs <slug> <port> --data <dir>/worlds/<slug>
```

`SOUL_LIFECYCLE=1` is what the launcher sets; without it a production world's history refuses the engine.

To put a world's data back live: stop the stage, move the world's `sim.db` aside (keep it), copy the restored one in,
delete the world's `snapshot-epoch` (so the edge never serves the pre-restore snapshot, `apps/server/src/edge-snapshot.ts`),
`chown simworlds:simworlds`, start the stage. The same goes for a `sim.db` taken from a release backup or an hourly
`backup-*.db` copy: delete `snapshot-epoch` whenever an older `sim.db` goes back live. Restoring data discards events accepted since the snapshot, so do it only
for real data loss. Tests: `node --test tools/world-launcher/backup-restic.test.mjs` (skips without restic).

**CDN purges** (behind the CDN, [cache rule](cdn.md#the-cache-rule)): parts, uploads and art are immutable for a year at
the edge, and the origin's later refusal never reaches copies already there. Purge by prefix `soul.game/w/<slug>/` where
the plan has it, otherwise purge everything:

- **When moderation vetoes a file**, purge its URLs (`/w/<slug>/assets/<sha>.<ext>`, `/w/<slug>/art/<sha>.<ext>`) and
  that world's parts and snapshot.
- **After a restore** of a world's data, purge that world: its snapshot key can repeat a key the edge already holds for
  other contents.

### Hourly run

`sim-worlds-backup-hourly@<stage>.service` runs `deploy/backup-restic.mjs backup-hourly <stage>` at minute 15 of each
hour, once its timer is enabled. It uses the same settings file and staging mirror as the nightly run, and both run
under one lock (`flock /srv/sim-worlds-backups/.lock-<stage>`), so they never overlap. Each run:

1. Skips each database whose file and write-ahead log are no newer than its copy in the mirror (a copy's time is when
   it began, so a write during a copy is caught the next hour), and copies and quick-checks the others.
2. Refreshes the small files, uploads and host settings as the nightly run does.
3. Takes one snapshot tagged `<stage>,hourly` (every database, so it restores the whole stage) and copies it to
   `SIM_BACKUP_OFFSITE`. No forget, prune or check: the nightly run keeps the newest 24 hourly snapshots
   (`SIM_BACKUP_KEEP_HOURLY`, default `--keep-hourly 24`) and checks the repository.

It never falls back to dated copies: without restic set up it exits 1. Its result is in `<data>/backup-hourly-last.json`
(the nightly one stays in `backup-last.json`). To enable it (the maintainer, once; `install.sh` never does):

```sh
systemctl enable --now sim-worlds-backup-hourly@production.timer
systemctl start sim-worlds-backup-hourly@production.service    # one run now
journalctl -u sim-worlds-backup-hourly@production -n 5          # "N/N changed databases ok (quick_check), M unchanged skipped"
```

To restore from an hourly snapshot, list them (hourly ones carry the `hourly` tag) and restore one by id, or `latest`,
into an empty directory, locally or from the off-site copy:

```sh
set -a; . /etc/sim-worlds/backup.env; set +a
node $R/tools/world-launcher/deploy/backup-restic.mjs list production            # <id>  <time>Z  <host>  production,hourly  ...
node $R/tools/world-launcher/deploy/backup-restic.mjs restore production <id> <empty dir>
RESTIC_REPOSITORY="$SIM_BACKUP_OFFSITE" node $R/tools/world-launcher/deploy/backup-restic.mjs restore production latest <empty dir>
```

Then boot one world from it as above. Tests: `node --test tools/world-launcher/backup-hourly.test.mjs` (a local
directory stands in for the off-site bucket; skips without restic).

Release backups (`ship.sh` step `backup`) are separate: row-verified compact copies in
`/srv/sim-worlds-data/release-backups/pre-r<label>-<stage>-<date>-<time>-XXXXXX` (a random six-character suffix; older
copies have none). `deploy/retention.sh` lists and prunes old ones, newest first by the date and time in the name, dry
run by default ([release](../release.md#retention)).

## Legacy stage

The legacy stage serves the three original worlds (`eden`, `mars`, `littlemartians`) at `/w/<key>` and the root web
build's world list at `/`, on the current release. Its launcher runs with `--old-worlds-root`: only old-world forks
(`tools/world-launcher/fork-world.mjs`), root paths routed as the original site had them, and no world creation
(`--create-limit 0`). Unit `sim-worlds@legacy`, settings `/etc/sim-worlds/legacy.conf`, data
`/srv/sim-worlds-data/legacy` (`worlds/<key>/sim.db`, `forks/{descriptors,artifacts,accounts.sqlite}`).

- **Releases:** `release.sh legacy` uploads `we-<sha12>-root` with `FILES.sha256` and never activates it; `ship.sh`
  activates it after production. By hand:

  ```sh
  L=/srv/sim-old/releases/we-<sha12>-root
  (cd $L && sha256sum -c --quiet FILES.sha256) && bash $L/tools/world-launcher/deploy/activate.sh legacy $L --reload
  ```

  Do not move the stage link yourself; activate.sh records `legacy.previous` for its rollback.
- **Stage settings:** `/etc/sim-worlds/legacy.conf` and the legacy memory drop-in come back with every snapshot in
  `host-config/` ([disaster recovery](disaster-recovery.md#3-secrets-and-settings)). The stage's world forks are
  registered once and are not claimable; releases never re-register them.
- **Redirect switch** (off by default): `<data>/redirects.json`, re-read when it changes
  (`tools/world-launcher/redirects.mjs` documents the format): `enabled`, an optional `home` for `/`, and a target path
  per original world. Only page loads of `/`, `/w/<key>` and `/w/<key>/` get a 302; agents, the API and live viewers
  keep the original world, and `?stay=1` always opens it. Check that each target answers 200 before turning it on.

## After a reboot

Check `systemctl is-active caddy sim-worlds@production sim-worlds@legacy` and the timers. Caddy can start before the
network it binds to is ready on a host that also runs Docker; restart it if it is not active.
