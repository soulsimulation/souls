# Moving soul.game off eden.art

The release that moves soul.game's own resources off eden.art: the asset CDN to `cdn.soul.game`, the runtime links
from `sim.eden.art` to `soul.game`, and the worlds' bucket to R2 `soul-game-worlds`. Run by the release owner. The
three parts are independent: each has its own checks and its own rollback, and none needs the others.

Not in this release: sign-in. `sim.eden.art/sign-in` and `clerk.eden.art` stay the Clerk primary until the separate
switch to the soul.game Clerk app ([Clerk satellite](clerk-satellite.md)).

## State on 25 Nov 2026

| Part | State |
|---|---|
| soul.game DNS on Cloudflare | moved (the zone may show Pending for a few hours) |
| `soul-game-assets` holds every CDN object | done: 2,360 objects, 1.38 GB, `verify --deep` passed (every SHA-256 and header read back) |
| `cdn.soul.game` serves the bucket | yes: same bytes, Content-Type, Cache-Control and Content-Encoding as `assets.eden.art` |
| `cdn.soul.game` CORS rule | set: soul.game, souls.game and sim.eden.art allowed, Range preflight answered (step A2) |
| uploads Worker on `cdn.soul.game/w/*` | deployed (step A3) |
| code pointing at `cdn.soul.game` | this pull request, not merged |
| worlds' bucket | still the old provider: 34,183 objects, 6.37 GB under one prefix (part C) |

## A. Asset CDN to cdn.soul.game

Run everything from the main checkout. `move-assets.mjs` reads the old bucket's keys from
`.local/project/team/secrets/eden-assets-r2.env` and the old account from `CF_ACCOUNT_ID` in `deploy.env`, and the new
bucket's from `.local/project/team/secrets/r2-soul-game.env` (`ASSETS_*`, `R2_ENDPOINT`). It never prints a key.

1. **Copy what was published since.** Every object except unlinked `proofs/` (PR proof media, linked only from GitHub)
   keeps its key, bytes and headers. The old bucket is only read.

   ```sh
   node tools/cdn/move-assets.mjs plan            # "to copy 0" when nothing new was published
   node tools/cdn/move-assets.mjs apply           # resumable: run it again after a stop
   node tools/cdn/move-assets.mjs verify --deep   # ends "verify passed"
   ```

2. **CORS on `soul-game-assets`.** `node tools/cdn/move-assets.mjs cors` compares the rules and prints the rule
   `assets.eden.art` answers with today, as dashboard JSON. The bucket tokens may not change bucket settings, so paste
   that JSON in the Cloudflare dashboard: R2 > `soul-game-assets` > Settings > CORS policy (or run `cors --apply`
   with a token that may). Check:

   ```sh
   curl -sI -H 'Origin: https://soul.game' https://cdn.soul.game/readme/v4/hero.webp | grep -i access-control-allow-origin
   ```

   It answers `access-control-allow-origin: https://soul.game`.

3. **The uploads Worker.** Deploy `tools/cdn/worker/god-uploads.js` from this release on the route
   `cdn.soul.game/w/*`, R2 binding `ASSETS` to `soul-game-assets`, failure mode Fail open
   ([tools/cdn/worker/README.md](../../tools/cdn/worker/README.md)). Check:
   `node tools/cdn/worker/verify-worker.mjs --self-test`, then the live check with a god folder,
   `node tools/cdn/worker/verify-worker.mjs --god <god folder>`. Leave the old Worker on `assets.eden.art/w/*` as it
   is, for pages built before this release.

4. **Publisher credentials** (once). New media is published to the new bucket from now on. In the main checkout:

   ```sh
   (umask 077; s=.local/project/team/secrets; awk 'index($0,"ASSETS_ACCESS_KEY_ID=")==1{print "R2_ACCESS_KEY_ID=" substr($0,22)} index($0,"ASSETS_SECRET_ACCESS_KEY=")==1{print "R2_SECRET_ACCESS_KEY=" substr($0,26)}' $s/r2-soul-game.env > $s/soul-game-assets-r2.env)
   grep '^R2_ENDPOINT=' .local/project/team/secrets/r2-soul-game.env | sed 's/^R2_ENDPOINT=/SOULS_ASSETS_R2_ENDPOINT=/' >> deploy.env
   ```

   `tools/proof/upload.mjs` reads the first file by default; `tools/cdn/publish.mjs` and the score publisher read it
   through `EDEN_ASSETS_CREDENTIALS`. Both use `SOULS_ASSETS_R2_ENDPOINT` from `deploy.env`.

5. **Merge, then release.** Merge only after steps 1 to 3 pass: once merged, CI, `pnpm assets:pull` and every
   build load from `cdn.soul.game`. Run step 1 again just before merging. The day's release builds the page with
   `SIM_ASSETS_CDN_ORIGIN` defaulting to `https://cdn.soul.game`. `release.sh` refuses a build that does not name it.

6. **Browser checks**, in a real browser, signed out, on the real URL:
   - Open `https://soul.game/` and `https://soul.game/w/eden`, then open DevTools > Network. Models, textures and
     audio come from `cdn.soul.game` with status 200. No request goes to `assets.eden.art`, and the Console shows no
     CORS error. The world draws and its clock moves.
   - Do the same at phone width, and on `https://soul.game/changelog`, whose journal media load.
   - The scripted check: `node tools/cdn/cdn-walk.mjs .local/cdn-walk https://soul.game/w/eden https://soul.game/w/mars`.
     It fails if a listed asset came from the origin or a CDN request was not 200.

**Rollback.** Revert this pull request's merge commit and release that. `cdnOrigin` still accepts
`https://assets.eden.art`, and the old bucket and its Worker are untouched, so a page built for the old host works as
before. To remove the copy itself: `node tools/cdn/move-assets.mjs undo --yes`. It deletes only the objects `apply`
created that still hold the bytes it wrote. You never need to run it to roll back.

## B. eden.art links in the code

This pull request changes the links that runtime code, configuration, agent instructions and current docs follow:
`assets.eden.art` becomes `cdn.soul.game`, and `sim.eden.art/worlds/w/<slug>` becomes `soul.game/w/<slug>` (the same
mapping `sim-eden-art.caddy` redirects by). They ship in the release of step A5. These stay, and why:

| What | Why it stays |
|---|---|
| `sim-eden-art.caddy`, `check-sim-redirect.mjs` | Old links keep working. The block redirects to soul.game and is the Clerk primary's sign-in bridge |
| `sim.eden.art/sign-in`, `clerk.eden.art`, `clerk-satellite.md`, front-check/standin `PRIMARY` | Clerk primary until the soul.game Clerk app switch |
| `assets.eden.art` in `cdn-assets.ts` `CDN_ORIGINS` and the two changelog pages | Rollback build. `public-journal.json` keeps its old media links |
| `LEGACY_PROOF_CDN` in `tools/proof/acceptance.mjs` | Earlier PRs' proof stays in the old bucket and keeps passing `proof-ok` |
| `sim.eden.art` in the Worker's `APP_ORIGINS` and the CORS rule | A page still open on the old origin |
| `install.sh`, `run-laptop.sh`, launcher and production comments, `ship-dual-stage.sh`, disaster recovery, `tools/blobs` | The retired engine's host and units, kept as history |
| `tools/blobs/cdn-upload.mjs`, `tools/god-skill/scripts/bucket-plan.mjs` | Old one-off tools for the old bucket, not run by any release |
| Test fixtures naming `sim.eden.art`, `tools/parity`, `tools/mars-m2` | Example origins in tests, and captures of the old Eden |
| `CHANGELOG.md`, `changes/`, `tools/changelog/PUBLIC-JOURNAL.md`, `public-journal.json`, dated docs | History |

## C. Worlds' bucket to R2 soul-game-worlds

The tool is `v2/tools/ops/store-switch.sh`, and its page is
[v2/docs/runbook/store-switch.md](../../v2/docs/runbook/store-switch.md), which covers what each step does, what it
prints, the dry run and undo. On the host, `DIRECTORY_STORE_URL` and `SOULS_BACKUP_URL` both name the same bucket and
prefix (`soul-backups/souls-engine-v2`), so they move together. The second pass finds everything already copied.

**`plan` on production, 25 Nov (read only):**

```text
store-switch: no store-copy at /var/lib/souls/oneoff/store-copy (cargo build --release -p ops --bin store-copy; docs: v2/docs/runbook/store-switch.md)
```

It refuses before reading the new store file, as it should. Two prerequisites are missing on the host: the copy
tool is not built there (no cargo on the host), and `souls-alarms` is not installed (no unit; the plan also checks
that it reads `secrets.env`). A read-only listing of the current bucket found 34,183 objects (6.37 GB):

| Prefix | Objects | Size |
|---|---|---|
| `stream-recovery/` | 30,561 | 979 MB |
| `aside/` (world sets put aside by reseeds) | 1,584 | 2.7 GB |
| `h/` (history) | 919 | 849 MB |
| `part/` (log parts) | 881 | 441 MB |
| `ckpt/` (checkpoints) | 166 | 1.37 GB |
| `store/`, `world/`, `world-name/`, `world-list` | 72 | 2 MB |

**Steps:**

1. Build `store-copy` on a Linux x86-64 machine from the release commit (`cargo build --release --locked -p ops --bin
   store-copy` in `v2/`) and copy it to `/var/lib/souls/oneoff/store-copy` (root, 755). Note its SHA-256.
2. `install.sh apply` from the release, which installs `souls-alarms` with its drop-in reading `secrets.env`.
3. From the main checkout: `bash v2/tools/ops/store-new-env.sh plan`, then `bash v2/tools/ops/store-new-env.sh
   apply`. This writes `/etc/souls/store-new.env` (root, 600) from `r2-soul-game.env`'s `WORLDS_*` keys and
   `R2_ENDPOINT`, sent over ssh's stdin. The file reads
   `STORE_BASE=s3:https://<account endpoint>/soul-game-worlds`, the two keys and `AWS_DEFAULT_REGION=auto`.
4. On the host: `bash store-switch.sh plan`. It lists the settings, the 11 worlds in order and the copy's dry-run
   count, and changes nothing.
5. `bash store-switch.sh apply`. The bulk copy runs first, while every world keeps running. Then, one world at a
   time: stop, copy its writes since, start on R2, stay up 15 s or go straight back. Then the directory and alarms.
   It resumes when run again after a stop.
6. `bash store-switch.sh check` ends `check passed`. In a browser: `https://soul.game/` lists the worlds,
   `https://soul.game/w/eden` draws, its clock moves and a Soul's last moves are there. A world that was asleep
   wakes.

**Rollback:** `bash store-switch.sh undo` restores `secrets.env` and restarts each world and service on the old
bucket. It writes to neither bucket. Writes made on R2 in the meantime are not carried back: a world's records ship
again from its own log, but the directory's claims and list rows do not. Remove `store-new.env` with
`bash v2/tools/ops/store-new-env.sh undo`. Old objects are never deleted by the move. Removing them needs Gene's yes,
after R2 has run a release.

### The copy's length, and starting on an empty R2 store

The old provider has been measured at about 1,300 objects an hour, which puts a full copy at about **26 hours**. The
worlds run throughout. Each world is down only for its own final step, seconds to minutes.

**Starting worlds on an empty R2 bucket, with old objects left read-only at the old provider, is not supported.**
`store-switch.sh` always copies before it switches. worldd and the directory read a world's history, checkpoints and
records, and the directory's names, claims and list rows, from the one store their setting names, with no read-through
to a second one. A world started on an empty bucket starts with no stored history and no directory entry. Its local
folder still holds the current state, but a restart on a new machine, a restore or a viewer's stream recovery would
find nothing. In practice that is a reseed of every world.

The trade-off:

| Option | Time | What is lost | Code needed |
|---|---|---|---|
| Full copy (supported, tested by the dry run) | about 26 h of background copy, no outage | nothing | none |
| Copy without `aside/` | about 25 h (it saves 1,584 objects, but 2.7 GB) | the undo of past reseeds | a `--skip` prefix in `store-copy` (about 1 h) |
| Copy without `stream-recovery/` and `aside/` | about 1.6 h (2,038 objects) | **not safe as the engine stands.** A moved world writes a new chain head to the new store, but never uploads again the objects that head names: they are already in its spool's `kept/` (`v2/crates/worldd/src/view_out/backup.rs` `objects()`, `Spool::object`). On a new machine the stream then fails with `stream-recovery-missing` and the world shows no viewers until it is fixed by hand | the same, plus a worldd change: when the store's address changes, queue the live chain's `kept/` objects for upload again |
| Empty R2, old store read-only | minutes | every world's stored history and directory entry; worlds reseeded | not supported |

Recommendation: start the full copy as soon as steps 1 to 3 are done. It needs no new code and no outage, and the
switch completes about a day later. Choose the empty store only if reseeding every world is acceptable.

## Order on the day

1. A1 to A3, then A4.
2. Merge, then the day's release (A5), then the browser checks (A6). Parts A and B ship together.
3. C1 to C3 on any day. Start C5 when there is a day for the copy to run, and run C6 when it ends.
