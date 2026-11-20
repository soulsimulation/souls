# What is not in the log: backed up, and restored

Engine v2 O20 (#2812). A world's log reaches the bucket as O3's pieces and comes back with O12's restore
([restore.md](restore.md)). Everything else a machine keeps (accounts, pairings and their token hashes, the owner's
mailbox, words, removals, uploads) is listed in `v2/tools/ops/stores.json`, shipped to the same bucket and restored
from it alone. Code: `v2/crates/directoryd/src/backup.rs` (the list, the copies, the shipper) and
`v2/tools/ops/backup/` (the restore and the drill).

## The stores (Step 0)

Each has one owning program; the list says how each is copied.

| store | owner | path under the data folder | copy | ships |
|---|---|---|---|---|
| accounts (W1); the owner's mailbox (R13, #2753) and the prayers to a world's creator (G11, #3335) are tables in it | directoryd | `directory/accounts.sqlite` | SQLite's online backup, through the owner (it holds the file exclusively: `Store::backup`) | each 270 s, when changed |
| pairing, with each paired Soul's token hash (W2) | directoryd | `directory/pairing.sqlite` | SQLite's online backup | each 270 s, when changed |
| the gateway's tokens file (W2) | directoryd | `directory/gateway-tokens` | as it is (written whole, renamed) | each 270 s, when changed |
| words and uploads: the text store (K16, V1b) | worldd | `worlds/<world>/log.text/` | `text`, then `uploads/`, then `removed`, in that order | each 270 s, when changed |
| the removal list (K16) | worldd | `worlds/<world>/log.text/removed` | as it is (append-only); the longer copy wins | within a second of a change |
| usage, health history (O21) | ops | `ops/usage.sqlite`, `ops/health-history/` | online backup; every file | each 270 s, when changed |

The log and its checkpoints are listed too, as `o3`: O3 ships them. A task that adds a store adds a line;
`cargo test -p backup` makes a data folder with every program's own open calls and fails on any file no line covers.

**The copy.** SQLite's online backup, never a file copy. Each copy is sealed (AES-256-GCM, the object's key bound
in) under a key derived from the recovery passphrase, and put at `store/<name>` (a world's at
`store/worlds/<world>/<name>`) in the world's bucket, beside O3's `part/` pieces. The bucket holds the newest copy of
each store. The shape is today's offsite target's: an S3-compatible bucket and its key pair
(`BACKUP_OFFSITE_URL`, `BACKUP_S3_KEY_ID`, `BACKUP_S3_SECRET`; W8's S3 client reads them as `DIRECTORY_STORE_*`).

**The recovery key** is a passphrase kept off the machine: the maintainer's password manager and the repository
secret `BACKUP_RECOVERY_PASSWORD`, as today's ([operations.md](../../../docs/operations.md#off-site-copy)). A
machine that ships holds a file with it (`SOULS_BACKUP_KEY_FILE`, root only); a machine that restores is given it
from the secret, never from the lost machine's disk.

**Erased words in the bucket.** An erasure ships within a second (the removal list), and a restore opens the text
store, which finishes every erasure the list names (K16 rule 6) before anything reads it. The words' own copy in
the bucket still holds an erased sentence until the next copy of the text store replaces it: at most 270 s after
the erasure, plus however long the bucket keeps a replaced object if versioning is on (keep it off, or expire
replaced objects within a day).

## Restoring

O12's one command ([restore.md](restore.md#the-one-command)) restores a world's own stores as part of its fetch step
(`backup::restore_world`, the key from `SOULS_BACKUP_KEY_FILE`; a world with no copies in the bucket needs no key).
The directory's stores are restored by `backup::restore` with the machine's data folder as the root, before
directoryd starts. Restoring a text store ends by opening it, which applies its removal list again. The loss bar: at
most five minutes of writes, counted.

## The programs ship their own stores (O20b, #3523)

`worldd serve` keeps its words in `<world folder>/log.text/` and ships them, keyed by the world's lineage as O12's
restore reads them. directoryd ships the stores it was started with (`--store`, `--pairing`, `--gateway-tokens`, at
whatever paths they are given) and hands over the account store's copy itself. Each runs the shipper on a thread of
its own, once a second, never on the tick. The list, the seal and the shipper live in `directoryd::backup`; the
restore stays in `v2/tools/ops/backup/`.

| setting | what |
|---|---|
| `SOULS_BACKUP_URL` | the bucket: `s3:https://<host>/<bucket>[/<prefix>]`, the form of `BACKUP_OFFSITE_URL`, or `folder:<path>`, a folder standing in for it |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (`AWS_DEFAULT_REGION`, default `auto`) | the bucket's keys, as the host's backup settings hold them |
| `SOULS_BACKUP_KEY_FILE` | the recovery passphrase's file (root only) |
| `SOULS_BACKUP_SHIP_S` | a drill's or a test's shorter interval; never longer than the list's |

Each program says once at start what it ships and where (`<program>: backup: shipping text, removals to the offsite
bucket`), or `<program>: backup: no bucket (SOULS_BACKUP_URL is not set); its stores are not shipped`, and then
runs as before. A bucket set without a key file refuses the start. A copy that fails is said once and retried each
second (`backup: not shipped, ...`), and `backup: shipping again` follows when it goes through.

Not yet: O20's drill still runs its own stand-in machine-a. The next step is to make machine-a start `directoryd
--test-sign-in --pairing ... --gateway-tokens ...` and `worldd serve` on a seeded world, with `SOULS_BACKUP_URL=folder:
<bucket>`, and to write through them: sign-ins and pairings over HTTP, words over the world's socket. The tests
`cargo test -p directoryd --test backup` and `cargo test -p worldd --test serve o20b` show that both programs ship and
that the copies read back.

## The drill

```sh
bash v2/tools/ops/backup/o20-drill.sh     # two runs, seeds 1 and 2
```

Machine-a keeps the account store, pairing and its tokens file and a world's text store, each opened by its owner's
code. It signs a person in each second, pairs an agent each 5 s, says a sentence each quarter second, erases one
each 3 s and uploads a file each 10 s, printing each write once acknowledged, and ships the listed stores to a
folder store standing in for the offsite bucket. At a random second from 280 to 560 (after the first full copy at
270 s, up to one whole interval past it) it is killed (SIGKILL) and its data folder deleted. Machine-b, holding only
the bucket and the passphrase, restores, then checks every acknowledged write with the owners' code: an account
signs in as itself; a paired agent's token is accepted by the gateway's tokens file with no new approval; a sentence
reads; an erased one is refused `removed`; an upload's bytes have the hash acknowledged. It counts every write that
did not come back and the oldest one's age at the loss. No host, bucket or service is touched; a real scratch bucket
instead, never production's bucket or keys.

## The first measurement (19 Nov 2026, a laptop, the folder store)

| seed | kill at (s) | restore (ms) | bytes restored | accounts sign in | agents reconnect | sentences read | erased stay erased | uploads by hash | writes acked | writes lost | lost window (s) | bar |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 341 | 190 | 383,452 | 243/308 | 49/62 | 874/1,129 | 102/102 | 24/30 | 1,733 | 339 | 70.61 | met |
| 2 | 319 | 414 | 372,691 | 239/284 | 48/57 | 866/1,041 | 94/94 | 23/28 | 1,598 | 234 | 48.93 | met |

Every write lost was acknowledged after the last copy of its store (70.65 s and 48.96 s before the loss); every
write before it came back. No file on machine-b fell outside the list. The removal list shipped 103 and 95 times, its
last copy 1.05 s and 2.43 s before the loss, and no erased sentence read again.

## Created-world placement and authority (W3b)

`world-directory` backs up the durable create intents, immutable name/creator records, world claims and list under
`worlds/directory/`. `placement-backup` copies the private data-only receipt/authority mirror under
`directory/placement-backup/`. Each placed world's token hashes and K10 notices are covered alongside its own log;
the pairing SQL contains the authoritative per-world grants, devices and hashes, and republishes these derived files
when directoryd starts. No placement mirror contains raw tokens.

Restore the directory/pairing and world stores first and preserve the original placed instance, lineage and zone.
Restore the known trusted installed configuration/catalogue separately under root ownership; do not copy a writable
mirror wholesale into the protected live registry. For each restored request, enqueue only its original 64-hex
request identity in the fixed placement inbox. The same initializer compares the mirror receipt to the durable
request, immutable name, creator, template lineage and trusted catalogue/build. It restores only that verified
identity's bounded port, configures the existing units, probes native and advancing public stream readiness, installs
only that world's authority row, refreshes routing and writes a new protected ready receipt. A mismatch refuses;
existing world data is retained. Imported aliases remain explicit operator configuration.

This also recovers an interrupted placement with the same request identity. A partial fork without its complete
serving metadata is retained and named `placement-fork-incomplete`; it requires operator inspection rather than an
automatic destructive refork. A route refresh failure leaves the protected request pending and can be retried without
replacing its world or touching another route, including preview Eden.
