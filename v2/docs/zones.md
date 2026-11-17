# Space is zones

Engine v2 T1 (#2642), contract T1 in [TRUNK.md](TRUNK.md). It fixes the three rules that let a world run on more
than one writer later, though every world has one zone today. Nodes and links are T2's ([world-model.md](world-model.md)),
ids are T3's ([ids.md](ids.md)). Code: `v2/crates/replica/src/zones.rs`. Fixtures: `v2/crates/replica/fixtures/zones/`.
Checks: `crates/replica/tests/zones.rs`. Parallel ticking (N17), travel at runtime (X9) and build checks (K14) are not
here.

**The three rules, each as a type or a test.** Previous-tick reads: the type `Prev`, which holds only the previous
tick. Own writes: the type `Own`, which names only its node, and the runner's `write-outside-own`. Paired
transfers: the type `Transfer`, the log records `Leave`, `Arrive` and `Settle`, and the three transfer tests.

## Zones

1. **A zone is a subtree with one writer and one log.** Its id is its root node's id, and it is in every version
   (T3 rule 8). Every world has one zone today. Each zone writer mints from its own scope: the first zone from the
   world's, every later one from a fresh scope (T3 rule 1). A zone's log replays to exactly the zone. A log that
   does not start with its start record is refused as `log-without-start`, and a leave that replays to another
   transfer id as `log-out-of-step`.

## A tick

2. **A system reads the others as of the previous tick and writes only its own node.** It is handed two types:
   `Prev`, the previous tick and nothing else, and `Own`, its own node and nothing else. The wrong access has no
   method. Systems are keyed by the node they write, so a node has one writer. Reading another node costs one tick.
   A same-tick answer (a bout, a handshake) belongs inside one activity node, whose system sees both sides. Never
   add a peek.
3. **The runner checks what the types cannot.** Writes are data (`Write`), as they are when they come from a
   creator's module (T9) or a log, so a write to another node is refused as `write-outside-own`. The check runs
   each tick in id order and in reverse. A system whose writes differ between the two read something this tick
   wrote, or something outside the world such as a clock, and is refused as `read-same-tick`. Both name the
   system and its node.
4. **A joint activity is a node with one owner,** so it is in the log and survives a restart with its links. The
   skills inside it are handed their intents again (K13) or end by name. A door belongs to one side. A link
   across nodes is owned by one end. The other end's index is derived (T2 rule 8) and never written: writing it
   would be a write outside the system's node.

## Transfers

5. **A change that crosses zones is a leave and an arrive sharing a transfer id,** minted by the leaving writer
   from its scope. The transfer carries the subtree, its root first and every parent before its children, and the
   links whose ends are all in it or are Souls. A leave is not a `remove` (T2 rule 3): a link between the subtree
   and a node that stays is not taken with it. Within one world it stays with its owning end, so it travels if the
   subtree owns it and stays behind if the node that stays does; the other end's index is derived. To another
   world, the leave ends it and lists it in the transfer.
6. **A transfer in flight is named state with a restart rule.** The leave is written to the leaving zone's log
   first. The transfer stays in flight there until the destination's arrive is durable; then the leaving zone
   writes `Settle`. After a stop, both writers replay their logs, and the leaving writer sends every transfer
   still in flight again. The destination applies a transfer id once: a second arrive is skipped and not logged,
   and a log holding it twice replays to one copy. So a stop anywhere between leave and settle neither loses the
   subtree (the leave is durable) nor doubles it.
7. **Arrivals in one tick are applied one after another, in transfer id order,** whatever order they were
   delivered in. A move between zones of one world is not an arrival in T3's sense: every id is kept, so a thing
   crossing back is not renamed. From another lineage (travel, a fork's copy), each id, links' ids included, goes
   through T3 rule 6 against the writer's `Held`, which includes the arrivals before it in the same tick. So two
   arrivals of one id never keep that id, and a thing coming home gets a new id carrying its origin, with the
   carried links rewritten to it. Arrivals from another world are applied by the world's first zone, whose writer
   keeps the world's `Held`. An arrive whose deepest node would have more than 32 ancestors (T2 rule 6: the
   parent's depth, plus one, plus the subtree's height) is refused as `arrive-too-deep` before it is logged, and
   the transfer stays in flight.
8. **Travel between worlds is the same transfer** (X9 builds it). The subtree that leaves carries the body and
   what its Soul owns. Anything else the body holds or wears must be put down first: the leave is refused as
   `leave-holds-unowned`, naming the thing, and writes nothing.

## The fixtures

9. **Two zones of one world,** written as T2's fixtures and passing its check: `zone-a.diag`, a hall where Soul
   100's body holds a cup its Soul owns, beside a crate; `zone-b.diag`, a garden, whose writer has its own scope.

## What would quietly break this

- **A shared cache, a global or a clock read by a system.** It is a same-tick read the types cannot see; only the
  two-order run catches it.
- **Iterating a hash map in a tick or over arrivals.** The order test passes by luck, and replay differs.
- **A peek: any method that returns this tick's state of another node.** Every later writer split needs it removed.
- **A leave made final before its arrive is durable.** A crash loses a Soul.
- **An arrive that does not check its transfer id.** A restart doubles a Soul and what it holds.
- **Arrivals checked against the held ids of the previous tick.** Two arrivals of one id would both keep it.
- **A move between zones of one world treated as an arrival.** Everything crossing back would be renamed.
- **A leave treated as a `remove`.** A Soul walking into the next zone would lose its memberships.
- **Writing the far end's link index directly.** That is a write outside the system's node.
- **A second zone writer minting from the world's scope.** Two writers would give out the same ids.
- **A body allowed to leave holding what its Soul does not own.** Someone else's thing leaves the world.
