# Moving a live world to another machine

Engine v2 O9 (#2828), contract T11 ([durability.md](../durability.md) rules 5 to 9) and the directory (W8). A running
world changes machine with a pause people barely notice, and at no moment has two writers or none. Code:
`v2/crates/supervisor/src/moving.rs` (the steps, the fence, who owns the world after a failure, the history check),
`v2/crates/gatewayd/src/lib.rs` (the gate that holds and releases intents), `v2/tools/ops` (`ops move`, `ops world`
and `o9-move.sh`, the move table and the kill table). It builds on the shipped log
([log-shipping.md](log-shipping.md), O3). Not here: unasked failover, many zones, renting the machine.

## The four steps

1. **Prepare.** The target fetches the newest shipped checkpoint and the pieces after it while the source runs.
   Nothing pauses.
2. **Drain.** The gate holds new intents (they wait; they never fail). The source runs what it was sent, waits for
   it on its disk, acknowledges it, seals and ships its last piece, and moves the directory record's off-machine mark
   to its last record. It reports the exact version it sealed: records, effects (the tree's next sequence), the
   public state hash, and its last tick. From here it writes nothing.
3. **Fence.** The target fetches the pieces after what it prepared and proves it reaches that exact version. Only
   then does the epoch rise, naming the target: W8's claim, compare-and-set on the source's epoch, with the record's
   mark at the sealed record, so the target's claim starts exactly there. A version that differs is `fence-short`;
   a record that moved is `fence-moved`; a claim that went to another is `claimed-by-another`. **Any failure before
   the claim: the source resumes,** paying the ticks it owes.
4. **Resume.** The target opens its own log (its first record is the sealed one), starts its clock at the tick after
   the source's last, and runs every owed tick back to back to reach now ([time.md](../time.md) rule 11). The gate
   points at the new epoch and releases what it held, in order.

**Ownership is the epoch in the directory record, never process order, a lease or a clock.** The number is checked
wherever something is stored: the store refuses a claim from a stale epoch and the source's next write after the
claim (`claim-taken`); the gate never points back at a lower epoch and counts an acknowledgement only from the epoch
the intent was sent under; a world refuses an intent stamped with an epoch it does not hold (`epoch-other`); a piece's
name carries its claim's epoch and token, which only that claim's process drew.

## After a failure

The supervisor reads the record (`supervisor::moving::owner`): whoever the claim in force names owns the world, and
is restarted on its own machine if it died. A source killed before the fence restarts from its own disk and claims
a new epoch; the target, if it lives, is stopped. A target killed before its claim leaves the source owning: the
source resumes. A target killed after its claim restarts from the bucket (everything up to the sealed record) and its
own log after it, and claims a new epoch. A source killed while the fence is in flight is left to the fence: fenced,
the target goes on; unfenced, the source restarts. An intent the dead process was sent and never answered ends
`writer-died`; the agent may send it again.

## Running the drill

From the repository root, with nothing else running on the machine:

```sh
bash v2/tools/ops/o9-move.sh          # the move table, then the kill table (about 12 minutes)
```

Each run starts the source (`machine-a`, the benches' world: 1,000 bodies, 9,000 things, its log and checkpoints
shipped by O3's shipper), sends intents from 1,000 scripted agents through the gate under the `uniform` (even) or
`event` (uneven, 800 present) shape of `tools/bench/capacity/profiles/shapes.json`, moves the world to `machine-b` 30 s
in, and stops at 50 s. Then it checks every acknowledged intent against the bucket (the record it was acknowledged in
holds that body's step at that tick), every intent's end, the ticks both processes ran, and the directory's history
against the bucket's names. One run by hand: `cargo run -p ops --release -- move <root> even 1 [--kill target:fence]`
(from `v2/`); `<root>/conductor.log` has each step's time.

**Two processes on one machine stand in for two machines.** The bucket is a folder store whose conditional writes
hold a lock across processes (`supervisor::folder`); a fleet uses the object store (W8's S3 client). Shown across two
machines when the second machine is on the owner's checklist: run each `ops world` on its own machine against the
object store.

## What would break it quietly

- A target promoted before it reached the sealed version (LiteFS lost data this way): the fence compares records,
  effects and the state hash first.
- A lease or a timeout used as the fence: two machines' clocks and a paused process both lie. Only the record's
  epoch decides, and whoever stores checks it.
- The source restarted while a fence is in flight: two claims race. The conductor waits for the fence's answer.
- Ticks skipped to shorten the pause: the drill checks every tick from 0 runs exactly once.
