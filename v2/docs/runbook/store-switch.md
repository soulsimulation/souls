# Move the worlds' bucket to another provider

0.133 ST2. The new engine keeps each world's history, checkpoints, log parts, stream recovery and record, and the
directory's names, claims and alarms, in one bucket; its sealed store backups go to a second setting of the same form.
ST1 measured Cloudflare R2 from the production host clean (no call over 5 s in 495) where today's provider stalled
(writes of 29 s, deletes of 50 s, one 77 s timeout). This page moves both settings to R2, one world at a time, and
back. It waits on Gene's yes; nothing here runs until then.

## Where the store is set: one value, one place

`/etc/souls/secrets.env` (root, 600) is the only place the store is set, and every program that reads the store
reads it from there:

| Reader | How it gets secrets.env |
|---|---|
| `souls-directory` (directoryd) | the unit's `EnvironmentFile=` |
| every `worldd@<world>` (supervisor launch, worldd serve) | the install's drop-in `10-install.conf`, read after the unit's `directory.env`, so it wins |
| `souls-alarms` (supervisor alarms) | its install drop-in (from 0.133 ST2; before, it read only `directory.env`) |
| `souls-place` (place-created-world.mjs) | reads the file itself |
| release.sh, reseed-eden.sh, reseed-eden-undo.sh, cutover.sh | read its store lines after `directory.env`, as systemd does |

The settings, each in the offsite form `s3:https://<host>/<bucket>[/<prefix>]` (one value holds the endpoint, the
bucket and the prefix), with the keys beside them:

- `DIRECTORY_STORE_URL`: the worlds' and the directory's store (worldd takes it when `--store` and `WORLDD_STORE`
  are unset).
- `SOULS_BACKUP_URL`: the sealed store backups (O20b).
- `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`: the keys of both. Shared keys are why the two settings move together.
- `AWS_DEFAULT_REGION`: R2's is `auto`, the default; the move writes `auto` unless the new store's file names another.

Every store client is built by one function over these settings (`S3::from_vars` and `S3::from_url` in
`v2/crates/directoryd/src/directory/s3.rs`; `Bucket::parse` for worldd and the backups). No store setting belongs in
`directory.env`; `store-switch.sh` refuses while one is there. The page's stream (`/s/*`) is served by the origin on
soul.game itself, so its host is not a store setting and does not change. No eden.art host is added.

**The new bucket: `soul-game-worlds`** on the soul.game Cloudflare account, with an R2 API token scoped to that bucket
alone (object read and write). Creating it and the token is the release owner's step after Gene's yes.

## Before: the release owner's steps (after Gene's yes)

1. Create the R2 bucket `soul-game-worlds` and a token for it alone (object read and write).
2. On the production host, write `/etc/souls/store-new.env` (root, mode 600) with three lines: `STORE_BASE=` the
   bucket's `s3:https://<account>.r2.cloudflarestorage.com/soul-game-worlds` (no prefix: each setting keeps its own),
   `AWS_ACCESS_KEY_ID=` and `AWS_SECRET_ACCESS_KEY=` the token's. Write it with an editor, never with the key on a
   command line.
3. Build the copy tool from the release's commit, `cargo build --release --locked -p ops --bin store-copy` in `v2/`,
   and put it at `/var/lib/souls/oneoff/store-copy` (root, 755), its SHA-256 noted in the release record.
4. Run the install from this release (`install.sh apply`). Production has no `souls-alarms` unit yet: this step
   installs the alarm daemon for the first time (enables and starts it), with its drop-in reading secrets.env. The plan
   refuses until it does.

## Commands

```sh
bash v2/tools/ops/store-switch.sh plan     # what changes, and how many objects the copy moves; changes nothing
bash v2/tools/ops/store-switch.sh apply    # the move; run again after a stop and it resumes
bash v2/tools/ops/store-switch.sh check    # each store unit's store against secrets.env, and a probe in each bucket
bash v2/tools/ops/store-switch.sh undo     # the last move backwards
```

`apply`, in order:

1. Backs up `secrets.env` (and `directory.env`) under `/etc/souls/store-switch/<time>/` (root, 700), and writes the
   settings it moves to beside it: each bucket setting on the new bucket with its prefix kept, the new keys, region `auto`.
2. Copies every object of each setting to the new bucket, the old one only read: an object already there with the same
   length and ETag (or the same SHA-256) counts as made, so a stopped copy resumes. Each key's ETag as written is kept in
   a manifest, so a later pass never copies an old version over what a moved world has since written in the new
   bucket (`newer there and kept`). Then it prints the source's count and bytes against what the new bucket holds of
   the same keys, and stops on any difference.
3. For each running world, one at a time: stops it, copies its own keys written since, points that world alone at the
   new store (`worldd@<world>.service.d/50-store-switch.conf`), starts it and waits for it to stay up 15 s. A world that
   does not is switched back at once (the drop-in removed, started on the old store) and the run stops there.
4. Stops `souls-directory` and `souls-alarms`, copies what they wrote since, installs the new `secrets.env`, removes the
   drop-ins and starts both again.

From a world's switch until step 4, the directory still reads the old store: a switched world's sleep alarm or list
row reaches it at step 4 (minutes). Worlds keep their own clocks and logs throughout; each is down only for its stop,
copy and start. A world's history keeps going: the new bucket holds its marks, and worldd learns a store moved by its
address rather than fencing on it.

**The old bucket is never written or deleted by the move**: the old system's backups stay where they are. Remove the
new engine's objects there only after Gene's yes, once the new bucket has run a release.

## What you see

`plan` lists the settings by name, the bucket name, the worlds in order and a dry-run count, `store-copy: <setting>
(every key): dry run: source N objects, B bytes; ...`. `apply` prints per setting `source N objects, B bytes; target
holds N of them, B bytes (...): count and size match`, then `world <name>: up on the store it moves to` per world, and
ends `secrets.env names the store it moved to; every world and service reads it`. `check` prints `<unit>: <setting> is
secrets.env's` for each, a `probe write, read back, delete and empty listing: ok` per bucket, and `check passed`.
No line names a host, a bucket's address or a key.

Every step checks its own result. A world whose stop, copy, drop-in or start fails is switched back at once and the
run stops there, every unit running. A failed last copy starts the services again on the settings they had. A service
that does not come up on the new settings undoes the whole move at once.

## Undo

`undo` writes to no bucket. It restores the settings first: the backed-up `secrets.env` and `directory.env`, and every
move drop-in removed. Then it restarts each world that read the store moved to (after a finished move, every running
world; after a run that stopped, the worlds it moved), one at a time, and then every service, whatever state a stopped
run left it in. A unit that does not come up is named and the rest still go on; undo then ends with `the settings are
restored, but these are not up: ...` and exit 1, and keeps the move's record so it can be run again. Only when every
unit is up does it print `undone`. A world's records written to the new bucket meanwhile ship again from its own log
to the old one; the directory's writes there (claims, list rows) are not carried back. `check` writes only to a
bucket a move installed: after an undo it reads, and skips the probe.

## The dry run

`bash v2/tools/ops/tests/store-switch-dry-run.sh` (after the builds its first lines name) does all of this on this
machine: two worlds seeded and served by `worldd serve` under the supervisor, their store in one local S3 stand-in
(the old provider) and moved to a second (the new), with a `systemctl` that reads each unit's environment files at
each start as systemd does. It checks the plan changes nothing, each world and the alarm daemon run on the new store
after apply, the old bucket's objects are unchanged, check passes, undo brings both back, and a world planted to fail
on the new store, and one whose copy fails mid-move, are each switched back at once. An undo with a service planted to
fail restores the settings first, starts the rest, says which unit is not up and does not say `undone`; neither undo
nor check after it calls the copy tool.
