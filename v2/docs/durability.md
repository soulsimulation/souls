# Durability, one writer, and the directory

Engine v2 T11 (#2665), contract T11 in [TRUNK.md](TRUNK.md). It fixes when an effect counts as durable (twice), how
one writer per zone is enforced, and what the directory records. Code: `v2/crates/replica/src/durability.rs`, all of
it fakes in memory. Fixture: `v2/crates/replica/fixtures/durability/record.diag`. Checks:
`crates/replica/tests/durability.rs`. The real log, shipping and directory (K4, O3, W8), checkpoints (K5) and pinning
and rolling builds (O1, O7) are not here.

## Durable twice

1. **An effect is durable twice:** on the machine's disk, and off the machine. Acts are acknowledged at the first.
   The off-machine mark, in the world's directory record (rule 9), names the last sequence stored off the machine.
2. **What cannot be undone waits for the second.** That is travel between worlds, and anything the owner names
   later. A swap of things or amounts has no stakes and is acknowledged at the first point.
3. **A machine that dies takes with it only what is past the mark.** A new writer on another machine takes over at
   the mark (rule 5), so acts acknowledged on the old disk after it are lost unless that disk comes back (O lane's
   recovery). Shipping often keeps that window small; what cannot be undone is never in it.

## One writer per zone

4. **One writer per zone, by an epoch:** a number in the zone's directory record that only grows. A world has one
   zone today.
5. **A claim is a conditional write.** A writer reads the record and writes it back with the next epoch, its machine
   and the sequence it takes over at (the mark plus one), on condition that the record is the version it read. Of two
   writers that start at once, the store lets exactly one through; the other is refused (`precondition-failed`,
   HTTP 412).
6. **A lease is for liveness, never for safety.** It is measured as elapsed time on the writer's own machine, never by
   comparing clocks across machines. A writer past its lease acknowledges nothing more. Another machine claims only
   after the record's mark has not moved for a lease; the claim itself is what makes it safe.
7. **The store refuses a stale writer, not the writer itself.** The stores are asked for only two conditions, which
   S3 and R2 both offer atomically: create if absent (`If-None-Match: *`) and replace if unchanged (`If-Match`). There
   is no plain write. A writer whose epoch was taken, a paused one that resumes included, may still write to its own
   disk, but its next move of the mark is a conditional write on the version it last wrote, and the store refuses it.
   It acknowledges nothing after its lease lapses, and what waits for the mark is never acknowledged.
8. **Parts are named by zone, epoch and sequence, and created only.** A new epoch records the sequence where it took
   over; a part of an older epoch at or after it is ignored by every reader, by name (`superseded-epoch`). A disk
   refuses a write of an epoch lower than one it has seen (`epoch-stale`). Other S3-compatible stores must be tested
   for both conditions before use.

## The directory

9. **A world's directory record** is the object `world/<zone>`, `{1: zone, 2: where it runs, 3: epoch, 4: from
   sequence, 5: off-machine mark, 6: when it must wake, 7: pinned build}`:
   - **where it runs:** the machine, by a name (never a host or an address in anything published);
   - **its epoch,** and the sequence it took over at;
   - **the off-machine mark;**
   - **when it must wake:** real time in microseconds since 1970, left out while it is awake;
   - **its pinned build:** the hash of the build that runs it, which a client's checker is loaded by (T10 rule 13).
10. **Every field changes only by a conditional write on the version read,** the pinned build and the wake included,
    so a build change and a claim cannot both win: the loser reads again. A record is created once.
11. **Per Soul, the directory records where it is:** `soul/<soul>`, `{1: soul, 2: lineage of its world, 3: zone}`,
    changed the same way when a Soul travels (T1).
12. **The directory's truth is a few small objects in the object store,** each written conditionally; machines keep
    a cached copy; there is no other database.
13. **Checkpoints are taken by amount of log,** so restart time does not grow with the world (K5 builds it).

**Step 0, the paused writer as a timeline** (`a2_...`): a holds epoch 1, writes 0 to 2 and ships them (mark 2); a
pauses past its lease; b claims epoch 2 from sequence 3, writes 3 and ships it (mark 3); a resumes and writes 3 to its
own disk, unacknowledged; a ships, and the store refuses the mark (`precondition-failed`); a reader keeps epoch 1's 0
to 2 and epoch 2's 3, and ignores epoch 1's 3 as `superseded-epoch`. The modelled store refuses the stale writer.

## What would quietly break this

- **A lock or a lease alone.** A paused holder wakes and writes; only the store's check of the version stops it.
- **A plain write to the record,** for the build, the wake or the mark. It can undo a claim made in between.
- **Comparing clocks across machines** for a lease. Clocks drift; only elapsed time on one machine is measured.
- **Acknowledging travel at the disk.** A dead machine loses a Soul between worlds.
- **A part name without its epoch, or a part replaced.** Two writers' parts would mix, or a stale one overwrite.
- **Reading a stale epoch's parts past the takeover.** A world would have two histories.
- **A store that ignores the conditions.** Test each S3-compatible store; one that accepts a stale `If-Match` lets
  two writers write.
- **Checkpoints by time rather than by amount of log.** A busy world's restart grows without bound.
