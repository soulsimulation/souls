# Shipping the log off the machine

Engine v2 O3 (#2732), contract T11 ([durability.md](../durability.md) rules 1, 2, 8 and 9). Every sealed piece of a
world's log reaches the bucket within seconds, and the world knows exactly how far. Code:
`v2/crates/worldd/src/shipping.rs` (the shipper, its marks and gauges, and a rebuild's fetch); the drill and the count
are `v2/tools/ops/src/drill.rs`; the ten-kill test is `v2/tools/ops/o3-kill.sh`. Not here: an unreachable bucket
(O10), the operator's restore command, the epoch raise and the restore gate (O12).

**A real world** (O3b, #3458): `worldd serve --dir <world> --store <folder> [--machine <name>]` (or `$WORLDD_STORE`,
`$WORLDD_MACHINE`) claims its world in O9's folder store and ships each record and checkpoint under that claim; each
start claims again (`shipping::take_over`, as `ops world --restart`) and ships from the mark plus one, so the history
read from record 0 holds every record once, in order (`crates/worldd/tests/serve.rs`, three SIGKILLs). It also
archives its history (V3) under `h/<world>/<lineage>/`, which the page's history plays
(`v2/tools/ops/o3b-history.mjs`), with the open day's event index written as it stands every 5 s, and names it in
`views/world.json` (`"history": "../../s/h/<world>/<lineage>/"`), where pairing finds it for a Soul's `history`
(R16b, #3480). Without a store it ships nothing, as before.

## What it does

- **A shipper thread per world,** off the clock thread. It is handed each record once it is on the disk (K4's
  durable mark), with its acts and whether one of them cannot be undone. The clock thread never waits on it; world
  time never stops while shipping.
- **A piece seals** when its oldest record has waited 10 s less the slowest of the last 16 uploads and 0.1 s (two
  polls of 50 ms: the hand-over and the look), at 8 MiB, or at once when a record holds an act that cannot be undone.
  So no acknowledged act is older than 10 s when its piece lands, a busy world uploads a piece about every 10 s, and
  **a world with no new records uploads nothing.**
- **A piece is one object,** created only (`If-None-Match: *`), at T11's part name
  `part/<lineage>/<zone>/<epoch>/<token>/<record>`, its sequence the log record it starts at: `{1: format, 2: T6
  header bytes, 3: first record, 4: [record, ...]}`, then its CRC-32C, little-endian. A retry that finds its own bytes
  under the name goes on; other bytes there stop the ship (`part-exists`).
- **Two marks.** `landed`: records in the bucket, moved on the provider's success. `recorded`: the directory record's
  mark (`world/<lineage>/<zone>`, field 6), moved by W8's `Directory::ship` when a landed record holds an act that
  cannot be undone, and each time the checkpoint pointer moves (O3b, #3458), to the last record landed. Such an act
  is acknowledged only below `recorded`. Moving the record at every piece would double the uploads (518,400 a month,
  $2.33), so it moves only when something waits on it or a checkpoint ships (at most one each ten minutes). Since it
  follows the pointer, a takeover (`from` = mark + 1) never starts before the pointer, and a reader from record 0
  reads the lost writer's pieces up to it.
- **A takeover that landed nothing** (a restore or a restart that died after its claim and before its first upload)
  cuts nothing: a reader at its `from` finds no piece of it there and reads the claim before it
  (`shipping::piece_at`), so the next takeover keeps the records past the mark.
- **Checkpoints:** K5 writes each checkpoint as one file, so it ships as one object, at
  `ckpt/<lineage>/<zone>/<epoch>/<token>/<record>`: the newest whose records are all landed, at most one each ten
  minutes, then the pointer `ckpt/<lineage>/<zone>/newest`, `{1: format, 2: checkpoint key, 3: its record, 4: the
  first record of the piece the log resumes in}`, replaced on its ETag. A rebuild reads the directory record, the
  pointer, one checkpoint and the pieces from the one holding its record, never a world's whole life.
- **Two gauges** (`Mark::gauges`): seconds the oldest record not yet off the machine has waited, and its acts.
- **The bucket is private.** Pieces, checkpoints and the pointer sit beside V3's packed objects
  ([archive.md](../archive.md)) in the same bucket and are never served.

## What it costs

R2 charges $4.50 a million writes. `cargo run -p ops --release -- ship-count <dir>` (from `v2/`) runs V3's busy
hour (100 of 1,000 bodies stepping each 50 ms tick) on a fake clock through the shipper, V3's archiver and K5's
checkpoints (each 8 MiB of log) into the in-memory store, and scales the hour by 720:

| Writes | An hour | A month | Cost |
|---|---|---|---|
| Pieces | 362 | 260,640 | $1.173 |
| Checkpoints and pointers | 6 + 6 | 8,640 | $0.039 |
| V3's objects, manifests, head, bundles, index | 52 | 37,440 | $0.168 |
| Directory marks (no act with stakes in the busy load) | 0 | 0 | $0 |
| Together | 426 | 306,720 | $1.380 |

Each act that cannot be undone adds at most one directory write, and none when its piece also carries another. A
seal age of 5 s doubles the pieces; a checkpoint shipped at each of K5's checkpoints (about 150 an hour here) would
add $0.97 a month, so they are thinned to one each ten minutes.

## Running the drill

Against a local S3-compatible stand-in, from the repository root (moto 5.1.22 in a venv under `.local/`):

```sh
python3 -m venv .local/o3-venv && .local/o3-venv/bin/pip install 'moto[server]==5.1.22'
.local/o3-venv/bin/moto_server -p 5733 &
# ARCHIVE_STORE_ENDPOINT: the stand-in's address on this machine (http, port 5733).
curl -X PUT "$ARCHIVE_STORE_ENDPOINT/o3-drill"
export ARCHIVE_STORE_BUCKET=o3-drill ARCHIVE_STORE_REGION=us-east-1 \
  ARCHIVE_STORE_ACCESS_KEY_ID=test ARCHIVE_STORE_SECRET_ACCESS_KEY=test
bash v2/tools/ops/o3-kill.sh                     # the ten-kill table
```

Each run starts the benches' world (1,000 bodies, 9,000 things) acting in real time under the `uniform` (even) or
`event` (uneven) shape of `tools/bench/capacity/profiles/shapes.json`, its log and checkpoints in a data folder,
kills it with SIGKILL at a random second from 30 to 90, deletes the data folder, and rebuilds the world from the
bucket alone. The driver writes its receipts outside the data folder as it sends each acknowledgement. A row is met
when the acts rebuilt equal the receipts below the rebuilt record (acknowledged at the disk, plus those held for the
mark), the acts lost were all acknowledged within 10 s of the kill, and no act that cannot be undone was
acknowledged at or past the directory's mark or is missing from the rebuild.

A still world: `ops ship <dir> <receipts> still 660` prints the uploads from one minute in (the build shipped) to
the end.

A scratch bucket instead of moto: the same commands with its endpoint, region and a scratch key. Never production's
bucket or keys.

## What would quietly break this

- **Shipping from the clock thread,** or a clock thread that waits for an upload: world time stops while the bucket
  is slow.
- **A seal age of a fixed 10 s:** the upload's own time pushes the oldest act past the loss bar.
- **Releasing an act that cannot be undone on `landed`:** a takeover from the record's older mark rolls it back.
- **Moving the directory record at every piece:** twice the writes, over the $2 bar.
- **A checkpoint pointer naming a checkpoint whose records are not all landed:** a rebuild replays from a hole.
- **A plain write to a piece's name:** a stale writer could replace history; pieces are created only.
- **A rebuild that walks every piece from record 0:** restore time grows with the world's age.
