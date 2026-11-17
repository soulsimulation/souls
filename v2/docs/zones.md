# Space is zones

Engine v2 T1 (#2642), contract T1 in [TRUNK.md](TRUNK.md). It fixes the three rules that let a world run on more
than one writer later, though every world has one zone today. Nodes and links are T2's ([world-model.md](world-model.md)),
ids are T3's ([ids.md](ids.md)). Code: `v2/crates/replica/src/zones.rs`. Fixtures: `v2/crates/replica/fixtures/zones/`.
Checks: `crates/replica/tests/zones.rs`. Parallel ticking (N17), travel at runtime (X9) and build checks (K14) are not
here.

**The three rules, each as a type or a test.** Previous-tick reads: the type `Prev`, which holds only the previous
tick. Own writes: the type `Own`, which names only its node, and the runner's `write-outside-own`. Paired
transfers: the type `Transfer`, the log records `Leave`, `Arrive`, `Settle` and `Return`, and the transfer tests.

## Zones

1. **A zone is a subtree with one writer and one log.** Its id is its root node's id, and it is in every version
   (T3 rule 8). Every world has one zone today. Each zone writer mints from its own scope: the first zone from the
   world's, every later one from a fresh scope (T3 rule 1). A zone's log replays to exactly the zone. Its start
   record holds everything the zone holds, transfers in flight, arrived transfer ids and origins included, so a
   checkpoint (K5) is a start record. A log that does not start with one is refused as `log-without-start`, and a
   leave that replays to another transfer id as `log-out-of-step`.

## A tick

2. **A system reads the others as of the previous tick and writes only its own node.** It is handed two types:
   `Prev`, the previous tick and nothing else, and `Own`, its own node and nothing else. The wrong access has no
   method. Systems are keyed by the node they write, so a node has one writer. Several skills on one body are
   composed inside that body's one system, in an order of its own (T9). Reading another node costs one tick. A
   same-tick answer (a bout, a handshake) belongs inside one activity node, whose system sees both sides. Never
   add a peek.
3. **The runner checks what the types cannot.** Writes are data (`Write`), as they are when they come from a
   creator's module (T9) or a log, so a write to another node is refused as `write-outside-own`. Each tick runs in
   id order and in reverse, and which runs first alternates with the tick, so state a system keeps between runs
   cannot hide a same-tick read in both directions. A system whose writes differ between the two read something
   this tick wrote, or something outside the world such as a clock, and is refused as `read-same-tick`. Both name
   the system and its node. **The check samples; it is not a wall.** What forbids shared state is K14's build
   check and T9's crate boundary.
4. **A joint activity is a node with one owner,** so it is in the log and survives a restart with its links. The
   skills inside it are handed their intents again (K13) or end by name. A door belongs to one side. A link
   across nodes is owned by one end. The other end's index is derived (T2 rule 8) and never written: writing it
   would be a write outside the system's node.

## Transfers

5. **A change that crosses nodes is a leave and an arrive sharing a transfer id,** minted by the leaving writer
   from its scope. Inside one zone (a pick-up, a walk between rooms), the leave is written in tick n and the arrive
   in tick n+1, in the zone's one log; the arrive ends the flight. Between zones, the leave and the arrive are in
   two logs, and the leaving zone settles once the arrive is durable. The transfer carries the subtree, its root
   first and every parent before its children, and the links whose ends are all in it or are Souls. A leave is not
   a `remove` (T2 rule 3): a link between the subtree and a node that stays is not taken with it. Within one world
   it stays with its owning end, so it travels if the subtree owns it and stays behind if the node that stays does;
   the other end's index is derived. To another world, the leave ends it and lists it in the transfer.
   **Left for N17:** a system cannot yet emit a leave. Here the zone's writer calls `leave` and `arrive_all`; N17
   makes a leave an effect a node's system writes, with the arrive applied by the destination node's system a tick
   later.
6. **A transfer in flight is named state with a restart rule, and always ends.** The leave is written first. A
   transfer stays in flight until it arrives in the same zone, is settled, or is taken back. After a stop, both
   writers replay their logs, and the leaving writer sends every transfer still in flight again. The destination
   applies a transfer id once: a second arrive is skipped and not logged, and a log holding it twice replays to one
   copy. The destination keeps arrived ids for ever (K5 may drop one once the source's settle is acknowledged). So
   a stop anywhere between leave and settle neither loses the subtree nor doubles it. **A refused arrive** is not
   logged at the destination and is answered with its reason. The leaving zone then writes `Return` under the same
   transfer id and puts the subtree back where it stood, or at the zone's root if that node is gone. One refused
   transfer holds up no other: the rest of the tick's arrivals go on.
7. **Arrivals in one tick are applied one after another, in transfer id order,** whatever order they were
   delivered in. A move within one world is not an arrival in T3's sense: every id is kept, so a thing crossing
   back is not renamed. From another lineage (travel, a fork's copy), each id, links' ids included, goes through T3
   rule 6 against the writer's `Held`, which includes the arrivals before it in the same tick. So two arrivals of
   one id never keep that id, and a thing coming home gets a new id carrying its origin, with the carried links
   rewritten to it. An arrival from another world reaches only the world's first zone (`arrive-not-first-zone`
   elsewhere). That zone's `Held` must cover every zone writer's scope in the world (K2 or K5 keeps those bounds),
   or a thing minted by a later zone could come home under its old id. Before an arrive is logged, it is refused
   if its place is gone (`arrive-parent-missing`), if its deepest node would have more than 32 ancestors
   (`arrive-too-deep`: the parent's depth, plus one, plus the subtree's height; depth is zone-local here, and K2
   adds the depth of the zone root's parent), or if T2's commit check fails where it would land, by T2's name
   (`child-not-admitted`, `audience-unknown` and the rest).
8. **Travel between worlds is the same transfer** (X9 builds it). The subtree that leaves carries the body and
   what its Soul owns. Anything else the body holds or wears must be put down first: a leave to another world is
   refused as `leave-holds-unowned`, naming the thing, and writes nothing. Inside one world a zone boundary is
   invisible, so a body walks into the next zone with whatever it holds. X9 must also check an arriving
   transfer's shape: parents before children, and every parent but the root's inside the subtree.

## The fixtures

9. **Two zones of one world,** written as T2's fixtures and passing its check: `zone-a.diag`, a hall where Soul
   100's body holds a cup its Soul owns, beside a crate; `zone-b.diag`, a garden, whose writer has its own scope.

**Open for later tasks.** `Frame.tick` is unsigned here, and T5's ticks are `i64`; one type is chosen before N17
joins them. A fixture writer's minter is rebuilt by minting (`minter_past`); K5 wants `Minter::at` (#2652). T6's
records need a leave, an arrive, a settle and a return of their own; a leave written as a `remove` breaks rule 5.

## What would quietly break this

- **A shared cache, a global or a clock read by a system.** It is a same-tick read the types cannot see. The
  two-order run only samples for it; K14 and T9's crate boundary forbid it.
- **Running the two orders in a fixed order every tick.** A same-tick read whose writer comes first passes for ever.
- **Iterating a hash map in a tick or over arrivals.** The order test passes by luck, and replay differs.
- **A peek: any method that returns this tick's state of another node.** Every later writer split needs it removed.
- **A cross-node change written as one write.** Nodes could never be ticked apart.
- **A leave made final before its arrive is durable.** A crash loses a Soul.
- **A refused arrive with no way back.** The Soul stays in flight for ever.
- **An arrive that does not check its transfer id.** A restart doubles a Soul and what it holds.
- **Arrivals checked against the held ids of the previous tick.** Two arrivals of one id would both keep it.
- **A move within one world treated as an arrival.** Everything crossing back would be renamed.
- **A leave treated as a `remove`.** A Soul walking into the next zone would lose its memberships.
- **Writing the far end's link index directly.** That is a write outside the system's node.
- **A second zone writer minting from the world's scope.** Two writers would give out the same ids.
- **A checkpoint without the transfers in flight or the arrived ids.** It loses one, or doubles one.
- **A body allowed to leave the world holding what its Soul does not own.** Someone else's thing leaves the world.
