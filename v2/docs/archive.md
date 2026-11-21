# The archive and history bundles

Engine v2 V3 (#2712), contract T7 in [TRUNK.md](TRUNK.md): the log is what is kept for ever, and everything else is
a view of it. This page fixes how the sealed log becomes objects in a private bucket, how the public history a
browser plays is packed from them, and what that costs in object writes. Code: `v2/tools/archive` (packer, restore
tool, write count) and `v2/crates/replica/src/history` (the bundle and day-index formats). Checks:
`v2/tools/archive/tests/archive.rs`. Seeking, the event index and the coarse levels are V4's (#2713), below; checks
`v2/tools/archive/tests/seek.rs`. The page's history, scrub bar and links to a moment are V9's (#2719,
`v2/web/src/history`); `cargo run -p archive -- pack` archives a stream-check run's log into a folder it serves. Not
here: ten-second shipping (O3), serving a restored world (O12), search by Soul (W6), removal (W7), the corpus check
(V18).

## Forked worlds and checkpoint-based archives

A filtered fork starts with a real K5 checkpoint, often at a high effect sequence and with a pinned root other than
`souls:place`. Its archive does not pretend to start at sequence zero. On first publication, the server captures
its original sealed record-zero fork checkpoint before pruning can start. It validates CRC, hashes, full header
identity and definition pins, the exact initial K4 boundary, and canonical replay agreement with the newest engine
checkpoint and complete log. Missing required original source refuses by name; the engine still restores its newest
checkpoint. Those exact original bytes are stored privately as `archive/base/<SHA-256>`. The head's optional field
5 binds that object. A legacy constructor explicitly refuses a based head; legacy heads and format-1 bundles
retain their existing encoding and aligned windows.

For a based head, record numbers are physical K4 record numbers. Validated K12 input records are retained alongside
the original Parts, and replay skips inputs using the existing canonical replay rule. A missing local prefix may
be recovered only from validated O3 shipping records with their actual takeover boundaries. Missing source or a
changed duplicate is refused by name. Restart always uses the original archived base, even when the engine has a
newer ordinary checkpoint. Store-only restore needs the private base, manifests and objects, not the local world.

Based objects use `archive/obj/<epoch>-<first>-<SHA-256>`. Each closed range has an immutable manifest at
`archive/range/<epoch>-<first>-<object SHA-256>`, linked to its predecessor; only the head advances with CAS.
Header, base, ranges and source objects are create-only and an existing key is accepted only for identical bytes.
This prevents a crash between object publication and head CAS from overwriting source on retry.

Based public bundles use additive format 2: format-1 fields 2–6 retain their header/start/length/live snapshot/view
meaning, and field 7 carries an authorized observation chain. Its version-1 fields are: header hash (2), initial
public projection (3), physical record/effect-offset cursor (4), rows (5), terminal projection digest (6), terminal
cursor (7), and original private-base digest (8). Each row binds the genuine physical cursor, effect sequence and
world time, prior/result public digests, and the existing public projection delta. The producer validates each
whole canonical Part first. The bundler keeps the scrubbed public projection row by row with each row's encoding,
remakes only the rows an entry can touch (its nodes, links and timers, a flight's, and the links and timers of a node
that comes, goes or flies) and puts digests and window baselines together from those rows; it never projects the
whole state per entry (#3755). The projection retains authorized carry/flight state and real opaque parent references;
it never publishes private flight identity, private arrived bookkeeping or private fields. References and genuine
Sampled records are scrubbed before hashing. A private-only change emits no observation row or private timestamp. The same existing
text Store is opened once before archive replay; its current redaction list is checked at each publication boundary.
A changed list rebuilds only derived public bundles/indices from the original private base and records, using new
hash-addressed bundle keys. Store-only rebuild accepts that same authoritative list; no removal metadata is added
to the archive and immutable cached objects are never rewritten.

The reader validates the whole observation chain, keeps carry context internally across Return/Settle/Arrive and
idempotent arrivals, and returns the same live public history state and sampled-motion API as before. Its hash is
of that returned state. The native reader and the existing WASM `historyAt` caller use the same `state_at` path;
there is no second transfer or movement implementation.

Based windows are rolling sixty-second windows anchored at the first genuine public observation, so an initial
observation at 59.5 seconds belongs to [59.5,119.5), not an overlapping shortened aligned window. A seek before that
observation returns `history-none`; the existing previous-day search covers windows crossing midnight. Bundles
are immutable at `bundles/<day>/<start>-<SHA-256>`. Extending an open window produces a new key and CAS-replaces only
that start's row in the day index. Older cached indices still name exact unchanged bytes. Replaying the same base
and source rebuilds the same bundle and event/count index hashes.

The server mirrors only the validated header, bundles, bundle day indices, and `history/everyone` event/count
objects into the existing world `history/` export, using atomic writes and refusing symlink traversal. The public
pointer names `history/`, resolved by the existing configured world history URL. Private base, checkpoint, source,
range, head and input objects remain private. This export does not add a proxy route or a storage lifecycle.

## The objects

All keys are under the world's prefix. Every value is T0's deterministic CBOR ([encoding.md](encoding.md)); a key or
a store path inside a value is a byte string, since text in v2 is always a name.

| Key | Holds | Written |
|---|---|---|
| `archive/obj/<epoch>-<first record>` | An **archive object**: deflate (RFC 1951) of `{1: format, 2: T6 header bytes, 3: first record, 4: [record, ...]}`, then the CRC-32C of the compressed bytes, little-endian | Once, create-only (`If-None-Match: *`); never changed |
| `archive/day/<day>` | A **manifest**: `{1: format, 2: world day, 3: [[key, epoch, first record, records, SHA-256], ...], 4: previous day's manifest}` | Each time its day gains an object, over the version it read (`If-Match`) |
| `archive/head` | The **head**: `{1: format, 2: root id, 3: root kind, 4: newest manifest}` | When a new day's first object is written |
| `bundles/<day>/<start µs>` | A **bundle**, deflated (RFC 1951): `{1: format, 2: header hash, 3: start µs, 4: length µs, 5: snapshot, 6: view}` | Once, create-only, when its window closes |
| `bundles/<day>/index` | A **day index**: `{1: format, 2: day, 3: [[start µs, key, SHA-256 before deflate], ...]}` | When the day closes, and at shutdown |
| `history/everyone/events/<day>` | A **day of the event index** (V4): `{1: format, 2: day, 4: [kind, ...], 5: [[at µs, kind number, node, actor], ...], 6: [split hour, ...]}`, the rows of its hours that have no object of their own | When a later day's event arrives, and at shutdown |
| `history/everyone/events/<day>/<hour>` | An **hour of the event index** (V4), an hour of 1,000 events or more: as a day's, with `3: hour` | When a later hour's event arrives, and at shutdown |
| `history/everyone/counts/day/<day>` | A **day's counts** (V4): `{1: format, 2: 1, 3: day, 4: [kind, ...], 5: [[ten-minute slot, kind number, count], ...]}` | When a later day's event arrives, and at shutdown |
| `history/everyone/counts/year/<year>` | A **year's counts** (V4), 365 world days: as a day's, `2: 2`, a slot a day | With each day's counts |

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
   Size at the `record` load (100 bodies moving, ten steps a tick): 6,000 records and 1.1 MB a one-minute bundle,
   one record per moving body a second, about 180 bytes each, before deflate (18 kB a world second).
6. **A bundle is one minute of world time** (windows on minute boundaries; five until V4, which shortened them so a
   seek fetches at most a minute of view, rule 13), with the public snapshot at its
   start: `{1: [[id, node], ...], 2: [[id, link], ...]}` in T6's state layout, nodes and links whose audience is
   everyone, every reference passed through the redaction list. A window with no public record writes no bundle, so
   **a still world writes nothing.** A bundle is a view: its format may change, and bundles are made again from the
   archive (`rebuild_bundles`); the archive's format is the one kept. **A bundle is stored deflated** (#3284,
   `bundle_stored`): its snapshot repeats in every bundle and is most of a quiet minute's bytes, and deflates to about
   a twentieth. The day index names the SHA-256 of the bytes before deflate, so a reader inflates (to a limit) and
   then checks, and a bundle made again is equal by what it holds, not by how it was compressed. Measured below
   (rule 14).
7. **No words.** A record holds text by reference only (`{21: id}`, T8 and K4), so objects and bundles do too. Words
   reach a viewer beside a reference, at delivery ([audience.md](audience.md) rule 8), never from history. The check
   decodes every object, record and bundle, refuses a reference with words beside it, and searches the bytes for every
   word the world's text store holds.

## Seeking, the event index and the coarse levels

8. **A seek** (`archive::seek`, applied by `replica::history::seek::state_at`, which builds for WASM) gives the public
   state at world time `t`: it reads the day's bundle index, takes the last bundle that starts at or before `t` (a
   day with none sends it to the day before, back to a year), inflates it, checks it by the SHA-256 the index names,
   and applies the bundle's records up to `t` on its snapshot. Two requests, nothing kept between seeks. The state is
   the history level's: motion samples less than a second apart are thinned (rule 5).
9. **The event index** is a view, keyed by audience; only the public audience's (`everyone`) is built. Each public
   named event (T6) is a row `[time, kind, node, actor]`, the kind being the event's name and the actor `[1, Soul]`,
   `[2, creator]` (a principal id, never an account id) or `[3]` the world. No fields, so no text reference and no
   words. An effect for another audience, or whose node or actor is redacted, gives no row. It is split by hour: an
   hour of 1,000 events or more is an object of its own, and a day's object holds the rest and names those hours, so
   a quiet world writes one object a day for it and a busy one an object an hour.
10. **The coarse levels** count those events by kind: per ten minutes for a day (144 slots) and per day for a year of
    365 world days. A day's timeline is drawn from its counts; scrubbing reads them while the handle moves and seeks
    on release (V9).
11. **All of it is made again** from the archive (`rebuild_views`), equal by SHA-256 to what the archiver stored.
12. **Measured** by `cargo run -p archive --release -- seek` (`seek_bench.rs`), a world of 1,000 bodies and 9,000
    things recorded for a world day into W8's in-memory store: in the first minute of each hour every body moves
    (the busiest load: 1,000 samples a world second at the history level), the rest of the hour ten bodies step each
    ten seconds, and a Soul speaks each minute. The reference link, declared before the run: 20 Mbit/s, 50 ms a round
    trip, two round trips to open the connection and one a request, no cache; a bundle goes as stored (deflated) and a
    day index deflated in transit, as V1's compression carries it; the apply, inflating included, is timed natively
    on a laptop.

    | 100 seeks, cold | Ready to draw p50 / p95 / max | Bytes a seek on the wire, mean / p95 (stored p95) | Apply p95 |
    |---|---|---|---|
    | Random moments of the day | 0.359 / 0.370 / 1.051 s | 218,762 / 211,024 (286,598) | 0.086 s |
    | Random moments of its busy minutes | 1.047 / 1.243 / 1.537 s | 991,004 / 989,738 (1,065,312) | 0.637 s |

    Step 0 at the busy load: a one-minute bundle is 13,198,180 bytes before deflate (snapshot 2,887,769 of 11,101
    public nodes; view 10,310,411, 60,000 records), 909,423 stored and on the wire (its snapshot alone 148,575). Index sizes for that day: the event index
    73,127 bytes in one object (1,439 events, 51 bytes each), the ten-minute counts 719 bytes, the bundles' day
    index 136,517 bytes. A day's timeline reads 719 bytes, or 73,846 with every event as a marker. A modelled year at
    this load: event index 26.7 MB, day counts 0.26 MB, year counts at most 10 kB, bundles' day indexes 49.8 MB. At
    the target's 5,000 acts a minute, each a named event: 366 MB of event index a day (15 MB an hour), 133.6 GB a year;
    a day's counts stay at 144 slots a kind, so the timeline does not grow with the acts.
13. **Why one minute, not five with ten-second ranges:** at the busiest load the view grows 172 kB a world second
    (10.3 MB a one-minute bundle, before deflate) and the snapshot is 2.9 MB; a seek into a five-minute bundle through
    ranges reads on average 150 s of view, over 25 MB. One-minute bundles cost 34,560 more writes a busy month
    (below) and need no range support from the cache.
14. **Stored bytes** (#3284), from the same run: each bundle deflated at rest against its bytes before deflate, as V3
    and V4 stored them.

    | Bundles of the busy day | Bundles | Before (CBOR) | Stored (deflated) | Share |
    |---|---|---|---|---|
    | Quiet minutes | 1,416 | 4,109,292,922 | 212,447,766 | 0.052 |
    | Busy minutes (every body moving) | 24 | 327,703,120 | 22,352,933 | 0.068 |
    | The day | 1,440 | 4,436,996,042 | 234,800,699 | 0.053 |
    | A modelled year (365 such days) | | 1,620 GB | 86 GB | |

    Deflating runs in the packer, off the clock thread (rule 3); a seek inflates in its apply (rule 12). Writes are
    unchanged: one put a bundle.

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
| Busy | an hour: 19 objects, 19 manifests, 1 head, 60 bundles, 1 index, 3 event index and counts = 103 | 74,160 | 259,200 | 333,360 | $1.500 |
| Quiet | a day: 2 objects, 2 manifests, 2 heads, 25 bundles, 2 indexes, 6 event index and counts = 39 | 1,170 | 750 (25 a day) | 1,920 | $0.0086 |
| Still | 0 | 0 | 0 | 0 | $0 |

What a busy hour writes: objects (one per 64 MiB of records), a manifest rewrite per object, sixty one-minute bundles
(twelve five-minute ones until V4), a day index at the day's close, a head per day, and V4's event index and counts
(an object a day, or an hour once an hour has 1,000 events, and the day's and the year's counts).

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
