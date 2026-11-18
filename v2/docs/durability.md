# Durability, one writer, and the directory

Engine v2 T11 (#2665), contract T11 in [TRUNK.md](TRUNK.md). It fixes when an effect counts as durable (twice), how
one writer per zone is enforced, and what the directory records. Code: `v2/crates/replica/src/durability.rs`, all of
it fakes in memory. Fixture: `v2/crates/replica/fixtures/durability/record.diag`. Checks:
`crates/replica/tests/durability.rs`. The real log, shipping and directory (K4, O3, W8), checkpoints (K5) and pinning
and rolling builds (O1, O7) are not here.

## Durable twice

1. **An effect is durable twice:** on the machine's disk, and off the machine. Acts are acknowledged at the first.
   The off-machine mark, in the world's directory record (rule 9), names the last sequence stored off the machine.
2. **What cannot be undone waits for the second.** That is travel between worlds, and anything the owner names later
   (the final audit's ruling on TRUNK's "anything with stakes"). A swap of things or amounts has no stakes and is
   acknowledged at the first point.
3. **What a takeover loses, exactly:** acts acknowledged on a writer's disk after the mark, when another claim takes
   the zone over at the mark (rule 5). That holds for a writer that died and for one that only paused past its
   lease, and those acts stay lost if the old disk comes back, since the new claim holds those sequences (rule 8). A
   process that restarts has lost its token, so it claims again and loses the same. The window is at most what a
   writer acknowledges between ships, within its lease; shipping often keeps it small, and what cannot be undone is
   never in it.

## One writer per zone

4. **One writer per zone, by an epoch:** a number in the zone's directory record that only grows. A world has one
   zone today.
5. **A claim is a conditional write.** A writer reads the record and writes it back with a new takeover, `[epoch,
   from, machine, token]`: the next epoch, the mark plus one, its machine, and a token, on condition that the record
   is the version it read. The token is 16 bytes the claimant draws from the operating system's random source at each
   claim, like a T3 scope, never from the world's random numbers (the fake reads `/dev/urandom`; only servers claim).
   The token names the claim; the machine is only where it runs, so two processes on one machine, or one machine
   claiming again, are two claims. Of two writers that start at once, the store lets exactly one through; the other
   is refused (`precondition-failed`, HTTP 412). A machine that claims again keeps nothing on its disk at or after its
   new takeover.
6. **A lease is for liveness, never for safety.** It is elapsed time on the writer's own machine, never a comparison
   of clocks across machines, counted from when its last renewing write was sent. A writer renews by moving the mark,
   or, with nothing new, by rewriting the record (a heartbeat, which changes its bytes: rule 10). Past its lease it
   acknowledges nothing. Another machine claims only after the record's version has not changed for a lease; the
   claim itself is what makes it safe.
7. **The store refuses a stale writer's record write.** The stores are asked for only two conditions, which S3 and R2
   both offer atomically: create if absent (`If-None-Match: *`) and replace if unchanged (`If-Match`). There is no
   plain write. A writer whose claim was taken, a paused one that resumes included, may still write to its own disk,
   and the store accepts the parts it creates under its own claim's token, but its move of the mark is refused: it
   writes the record on condition of the version it read, and only while the claim in force there carries its token.
   So it acknowledges nothing that waits for the mark, and readers ignore its parts (rule 8). A writer refused because
   another field changed between its read and its write (a build pinned) reads again and retries while its claim is
   still in force.
8. **Parts are named `part/<lineage>/<zone>/<epoch>/<token>/<sequence>`, and created only:** the token in hex, the
   numbers as 20 digits, and no machine name, so no name a machine chooses can break a key. Only the claim that drew
   a token makes parts under it, so a name already there under one's own token, holding the same bytes, is one's own
   earlier ship, retried; a create refused for any other reason (the same name with other bytes) stops the ship
   (`part-exists`). The record keeps every takeover since the last checkpoint. K5 trims them there, and must keep
   the takeover in force at the checkpoint's sequence and every one after it. A reader keeps a part only if its claim
   (epoch and token) is the one in force at its sequence (the last takeover at or before it) and it is at or before
   the mark; any other is ignored by name, `superseded-epoch` or `past-the-mark`. A key under the zone's prefix that
   is not a part's name is named in the reader's result (`unreadable`), never skipped. A disk refuses a write of an
   epoch lower than one it has seen (`epoch-stale`). Other S3-compatible stores must be tested for both conditions
   before use.

## The directory

9. **A world's directory record** is the object `world/<lineage>/<zone>`, `{1: lineage, 2: zone, 3: where it runs,
   4: epoch, 5: takeovers, 6: off-machine mark, 7: when it must wake, 8: pinned build, 9: writes}`:
   - **where it runs:** the machine, by a name (never a host or an address in anything published);
   - **its epoch,** with 3 and 4 repeating the last takeover (`record-inconsistent` otherwise);
   - **the takeovers:** `[[epoch, from, machine, token], ...]` since the last checkpoint;
   - **the off-machine mark;**
   - **when it must wake:** real time in microseconds since 1970, left out while it is awake;
   - **its pinned build:** the hash of the build that runs it, which a client's checker is loaded by (T10 rule 13);
   - **its writes:** how many times the record has been written, one more at every write.

   A fork keeps its parent's ids (T3), so the lineage is in every key: a fork's record and parts sit beside its
   parent's. The zone is in every key whole, its scope in hex and its counter.
10. **Every field changes only by a conditional write on the version read,** the pinned build and the wake included,
    so a build change and a claim cannot both win: the loser reads again. A record is created once. A real store's
    version is an ETag, a hash of the content; that serves because every write adds one to field 9, so no write
    leaves the bytes as they were, a heartbeat included, and no version repeats.
11. **Per Soul, the directory records where it is:** `soul/<soul>`, `{1: soul, 2: lineage of its world, 3: zone}`,
    changed the same way when a Soul travels (T1).
12. **The directory's truth is a few small objects in the object store,** each written conditionally; machines keep
    a cached copy; there is no other database.
13. **Checkpoints are taken by amount of log,** so restart time does not grow with the world. K5 builds them in
    `v2/crates/sim/src/checkpoint/`: one file per checkpoint, the last two kept, the log never cut; the hashes in
    `v2/crates/replica/src/tree/seal.rs`. Trimming the takeovers (rule 8) waits for the real directory (W8).

**Step 0, the paused writer as a timeline** (`a2_...`): a holds epoch 1, writes 0 to 2 and ships them (mark 2); a
pauses past its lease; b claims epoch 2 from sequence 3, writes 3 and ships it (mark 3); a resumes and writes 3 to its
own disk, unacknowledged; a ships, and the store refuses the mark (`precondition-failed`); a reader keeps epoch 1's 0
to 2 and epoch 2's 3, and ignores epoch 1's 3 as `superseded-epoch`; c then claims epoch 3, and the reader keeps and
ignores the same. The modelled store refuses the stale writer.

## What would quietly break this

- **A lock or a lease alone.** A paused holder wakes and writes; only the store's check of the version stops it.
- **A plain write to the record,** for the build, the wake or the mark. It can undo a claim made in between.
- **Only the latest takeover in the record.** A third claim would bring a stale writer's parts back into history.
- **A key without the lineage.** A fork's record and parts would collide with its parent's.
- **A claim known by its machine.** A second process on the same machine that ignores its refusal passes the check,
  and both acknowledge travel at one sequence. Only a token drawn per claim tells them apart.
- **A part taken as one's own because its name exists,** with other bytes, or a part name without its claim's token.
  Two writers' parts would mix, and travel would be acknowledged on another writer's part.
- **A free-form name in a part's key.** A machine named with a `/` makes its parts unreadable; a reader that skips
  such keys loses history silently.
- **A record write conditional on an older version than the one it read from,** or a checkpoint that trims the
  takeover in force at its sequence. The first is refused needlessly; the second lets a stale writer's parts back
  into history.
- **A heartbeat that writes back the bytes it read.** A real store's ETag would not change, and a waiting machine
  would take over a healthy writer every lease, losing what it acknowledged after the mark.
- **Comparing clocks across machines** for a lease, or counting it from the reply. A stale writer acknowledges late.
- **Acknowledging travel at the disk.** A dead machine loses a Soul between worlds.
- **A store that ignores the conditions.** Test each S3-compatible store; one that accepts a stale `If-Match` lets
  two writers write.
- **Checkpoints by time rather than by amount of log.** A busy world's restart grows without bound.
