# The archive and history bundles

Engine v2 V3 (#2712), contract T7 in [TRUNK.md](TRUNK.md): the log is what is kept for ever, and everything else is
a view of it. This page fixes how the sealed log becomes objects in a private bucket, how the public history a
browser plays is packed from them, and what that costs in object writes. Code: `v2/tools/archive` (packer, restore
tool, write count) and `v2/crates/replica/src/history` (the bundle and day-index formats). Checks:
`v2/tools/archive/tests/archive.rs`. Not here: ten-second shipping (O3), serving a restored world (O12), seeking
(V4), removal (W7), the corpus check (V18).

## The objects

All keys are under the world's prefix. Every value is T0's deterministic CBOR ([encoding.md](encoding.md)); a key or
a store path inside a value is a byte string, since text in v2 is always a name.

| Key | Holds | Written |
|---|---|---|
| `archive/obj/<epoch>-<first record>` | An **archive object**: deflate (RFC 1951) of `{1: format, 2: T6 header bytes, 3: first record, 4: [record, ...]}`, then the CRC-32C of the compressed bytes, little-endian | Once, create-only (`If-None-Match: *`); never changed |
| `archive/day/<day>` | A **manifest**: `{1: format, 2: world day, 3: [[key, epoch, first record, records, SHA-256], ...], 4: previous day's manifest}` | Each time its day gains an object, over the version it read (`If-Match`) |
| `archive/head` | The **head**: `{1: format, 2: root id, 3: root kind, 4: newest manifest}` | When a new day's first object is written |
| `bundles/<day>/<start µs>` | A **bundle**: `{1: format, 2: header hash, 3: start µs, 4: length µs, 5: snapshot, 6: view}` | Once, create-only, when its window closes |
| `bundles/<day>/index` | A **day index**: `{1: format, 2: day, 3: [[start µs, key, SHA-256], ...]}` | When the day closes, and at shutdown |

1. **Records are K4's, as stored:** each is one tick's T6 part, which names its header by hash
   ([effects.md](effects.md) rule 7). K4's log file holds the epoch and its salt, not the T6 header, so each object
   carries the header's stored bytes once: an object is read and replayed with nothing else.
2. **An object closes** at 64 MiB of records (some minutes of the busy load below), when a record falls in a new world
   day, or at shutdown. A packer that starts on a world already archived reads the head and the newest manifest and
   goes on after its newest object of this epoch; records it already holds are passed over, and a gap is refused.
3. **The packer runs off the clock thread** (`Archiver::spawn`), handed each record once it is under K4's durable
   mark, as R3's view tier is. The objects are the archive; manifests, head, bundles and indexes can all be made
   again from them.
4. **Restore** reads the head, follows the manifests back to the first day, fetches every object, checks its SHA-256
   against its manifest and its CRC-32C, checks that records run on without a gap in each epoch, starts the tree at
   the root the head names, and replays every record with K5's `replay`. No local file is read.

## Bundles

5. **The history level** is the root's public view at R3's `sampled` level (T7 rule 3: a moving node's samples
   thinned to one a world second). R3 builds no separate history level, so bundles pack this view as it arrives.
   Size at the `record` load (100 bodies moving, ten steps a tick): 30,000 records and 5.4 MB a five-minute bundle,
   one record per moving body a second, about 180 bytes each, uncompressed (18 kB a world second; compression in
   transit is V1's).
6. **A bundle is five minutes of world time** (windows on five-minute boundaries), with the public snapshot at its
   start: `{1: [[id, node], ...], 2: [[id, link], ...]}` in T6's state layout, nodes and links whose audience is
   everyone, every reference passed through the redaction list. A window with no public record writes no bundle, so
   **a still world writes nothing.** A bundle is a view: its format may change, and bundles are made again from the
   archive (`rebuild_bundles`); the archive's format is the one kept.
7. **No words.** A record holds text by reference only (`{21: id}`, T8 and K4), so objects and bundles do too. Words
   reach a viewer beside a reference, at delivery ([audience.md](audience.md) rule 8), never from history. The check
   decodes every object, record and bundle, refuses a reference with words beside it, and searches the bytes for every
   word the world's text store holds.

## The write sum

R2 charges $4.50 a million writes (class A operations;
[V-viewers-and-history.md](tranche/V-viewers-and-history.md), Fact 2). $2 is 444,444 writes a month. O3's designed
shipping, one write each ten seconds, is 259,200 ($1.17), which leaves about 185,000 for everything here.

Counted by `cargo run -p archive --release -- count` (W8's in-memory store), on the busiest scripted load there is
(I10's driver, #2693, is not merged): the benches' world of 1,000 bodies and 10,000 things, with K5's restart load,
100 bodies taking a step each 50 ms tick and one of them speaking every minute. The busy hour is scaled by 720 hours;
the quiet world, one act an hour, is counted over a day (its objects close by the day) and scaled by 30, with O3's
ships counted as each ten seconds in which it made records. Both runs include building the world and a closing
flush, so both overstate.

| World | Counted | A month | O3 | Writes a month | Cost |
|---|---|---|---|---|---|
| Busy | an hour: 19 objects, 19 manifests, 1 head, 12 bundles, 1 index = 52 | 37,440 | 259,200 | 296,640 | $1.335 |
| Quiet | a day: 2 objects, 2 manifests, 2 heads, 25 bundles, 2 indexes = 33 | 990 | 750 (25 a day) | 1,740 | $0.0078 |
| Still | 0 | 0 | 0 | 0 | $0 |

What a busy hour writes: objects (one per 64 MiB of records), a manifest rewrite per object, twelve bundles, a day
index at the day's close, and a head per day.

## Running it against a store

`record` and `restore` take the store from `ARCHIVE_STORE_ENDPOINT`, `_BUCKET`, `_REGION` (default `auto`),
`_ACCESS_KEY_ID`, `_SECRET_ACCESS_KEY` and `_PREFIX`: W8's S3 client, path-style, SigV4. Use a local S3-compatible
stand-in or a scratch bucket, never production's. From `v2/`:

```sh
cargo run -p archive --release -- record ../.local/archive-run/world   # prints "recorded state hash=..."
rm -rf ../.local/archive-run/world                                     # the local disk wiped
cargo run -p archive --release -- restore <recorded state hash>        # the restore log, both hashes, bundles
```

## The corpus

`v2/tools/corpus/entries/1` is entry one of V18's recording corpus: one archive object (`segment.hex`) and one bundle
(`bundle.hex`) as hex text (the path guard refuses binary files), and `entry.txt` naming the build, the schema's
hash, the kinds (pinned by hash in their names), the root, the state hash the object replays to and the bundle's
SHA-256. Written by `cargo run -p archive -- corpus <dir>` from a scripted world; decoded by the test above.
