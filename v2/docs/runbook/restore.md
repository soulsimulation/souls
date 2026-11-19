# Restoring a world from the archive alone

Engine v2 O12 (#2807), contract T11 ([durability.md](../durability.md) rules 1, 3, 5, 7 and 8). A world outlives its
machine with nothing but the bucket and the directory: another machine holding only the build and the bucket's
credentials serves it again, in seconds, with at most 10 s of acknowledged acts lost. Code: `restore_world` in
`v2/tools/ops/src/world.rs` (the command), `v2/tools/ops/src/restore.rs` (`ops restore`, one run of the drill) and
`v2/tools/ops/o12-restore.sh` (the four runs). It reads what O3 ships ([log-shipping.md](log-shipping.md)).

**Step 0, the premise.** The directory is objects in the same bucket (W8), not a service on the lost machine, and the
build and the bucket's credentials come from the deploy, not from the lost machine's disk. A key kept only on the host
opens nothing.

Not here: noticing the loss and failing over unasked; pointing the world's public name at the new machine (the
owner's step, outside the restore's time); what is not in the log (accounts, token hashes, uploads: O20).

## The one command

`ops world target <data folder> <bucket> <t0> <machine> --restore`, on the new machine. So far it restores the drill's
world (O9's `ops world`, below), not a placed world served by `worldd serve`: there is no operator script for that yet,
and the drill runs this command for you.

1. **Fetch:** the directory record, the checkpoint pointer, one checkpoint and the pieces after it, never a world's
   whole life (`shipping::fetch`; each piece's CRC checked, a gap refused). Restore time depends on the checkpoint
   gap, not the world's age.
2. **Check:** the checkpoint's records against their hashes and its tree against its root record's state hashes (K5;
   a checkpoint that fails is refused, never passed over), then the pieces replayed on it.
3. **Raise the epoch:** W8's claim, from the record's mark plus one. From here a returning old writer's record write
   is refused by the store (`claim-taken`), and readers ignore its later pieces (`superseded-epoch`).
4. **Ship again what the claim took over:** the fetched records from the claim's start (or from the piece the pointer
   resumes in, if later) are shipped under the new claim, the last one waiting for the mark, so a reader starting at
   the pointer finds them and the mark moves past them.
5. **Start:** an empty log at the next record, the clock at the tick after the last one a record names, every owed
   tick run back to back to reach now ([time.md](../time.md) rule 11). It prints `restored <records> <bytes fetched>
   <fetch ms> <check ms> <claim ms> <checkpoint hashes equal> <state hash>`, then `claimed` and `serving`; the
   gateway points at the new epoch and releases what it held.

## The drill

```sh
bash v2/tools/ops/o12-restore.sh     # four runs: even load twice, uneven load twice
```

Machine-a serves the scripted world (1,000 bodies, 9,000 things) under the agents through the gate and ships its log
(O3). At a random second from 30 to 60 it is killed (SIGKILL) and its data folder deleted; the clock starts. Machine-b
runs the one command. The clock stops at the first new act acknowledged. Then a returning machine-a is played three
ways: its directory record write on the version it last read, the gateway pointed back at its epoch, and an intent
stamped with its epoch sent to machine-b. Two processes on one machine stand in for two machines over one bucket, a
folder store with a lock (O9's): the drill touches no host, bucket or service. A real scratch bucket instead: never
production's bucket or keys.

The bars, declared before the run: serving within 10 minutes of the loss; at most 10 s of acknowledged acts missing,
counted; the shipped checkpoint's state hashes equal to its root record's; a returning A refused by its epoch, all
three ways. `cargo test -p ops` also checks that the restored state hash equals the lost writer's own at the last
shipped version.

## The first measurement (19 Nov 2026, a laptop, the folder store)

| load | kill at (s) | fetch (s) | check (s) | claim (s) | first new act after the loss (s) | bytes fetched | records restored | acts acked, lost | lost window (s) | checkpoint hashes | archive (bytes) | a returning A | bar |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| even | 39.06 | 0.17 | 0.23 | 0.05 | 0.57 | 4,583,554 | 867 | 6,070, 18 | 0.20 | equal | 13,198,130 | refused three ways | met |
| even | 33.01 | 0.17 | 0.20 | 0.00 | 0.46 | 4,402,441 | 670 | 5,373, 376 | 3.95 | equal | 12,829,463 | refused three ways | met |
| uneven | 40.01 | 0.31 | 0.61 | 0.00 | 0.96 | 4,135,995 | 780 | 2,573, 43 | 0.89 | equal | 8,090,373 | refused three ways | met |
| uneven | 57.01 | 0.41 | 0.45 | 3.67 | 4.68 | 4,217,914 | 943 | 3,326, 286 | 7.50 | equal | 8,265,575 | refused three ways | met |

Bytes fetched are one checkpoint and the pieces after it, about the same in every run whatever the kill second: what
a restore reads does not grow with the world's age. The first new viewer file is not measured: the scripted world
writes no viewer stream.

## What would quietly break this

- **A restore that walks every piece from record 0:** its time grows with the world's age.
- **Claiming without shipping again what the claim took over:** the claim starts at the mark, which O3 moves only for
  an act that cannot be undone, so a reader at the pointer finds no piece under the new epoch and the restored
  history stops there.
- **A gateway that points at whatever serves last:** a returning A would take intents again. It points only up.
- **Credentials or the directory kept only on the world's machine:** the restore has nothing to read.
