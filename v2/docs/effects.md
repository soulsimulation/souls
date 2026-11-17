# Effects

Engine v2 T6 (#2645), contract T6 in [TRUNK.md](TRUNK.md). It fixes the shape of every byte of history: a generic
change any future viewer can apply, a named event saying what it meant, the envelope, T1's transfer records, T5's time
records and timers, the header a bundle's parts name, and the bytes. Code: `v2/crates/replica/src/effects.rs`.
Fixtures: `v2/crates/replica/fixtures/effects/`. Checks: `crates/replica/tests/effects.rs` natively, and the
`effects-goldens` step of `v2/tools/ci.sh` for the WASM build. The encoding (T0, [encoding.md](encoding.md)), writing
the log (K4), the in-memory tree (K2), applying and querying at speed (R1) and views (T7) are not here.

## An entry

1. **A log entry is one record holding both layers:** `{1: sequence, 2: at, 3: cause, 4: actor, 5: audience, 6: node,
   then one body, 8: events}`. Fields 1 to 6 are the envelope and 8 the named events (left out when there are none).
   The body is exactly one of `7: [change, ...]` (an entry with changes is an effect), `9: transfer record` (rule 14),
   `10: [time effect, ...]` (rule 16) or `11: [timer, ...]` (rule 15). One record, not two linked ones: the meaning
   cannot lose its changes.
2. **An entry applies in order, all or none,** and so does a part: one refusal leaves the state as it was, and every
   refusal has a name (`node-missing`, `not-own-node`, `crosses-nodes`, `audience-mismatch`, `parent-missing`,
   `id-duplicate`, `frame-mismatch`, `tree-cycle`, `depth-over-limit`, `remove-root`, `link-missing`,
   `link-owner-not-node`, `kind-not-in-header`, `transfer-missing`, `arrive-not-here`, `arrive-parent-missing`,
   `timer-missing`, `header-mismatch`, `schema-unknown`, `sequence-gap`, `change-unknown`, `record-unknown`,
   `int-out-of-range`, `not-canonical`, `name-not-pinned`, `text-not-a-name`, `not-a-record`, `encoding`, and T4's
   pose refusals such as `island-reserved` and `orientation-not-canonical`).
3. **The generic changes are a closed list of seven** (`Change`), each `{1: number, ...}`:
   1. create `{2: node, 3: kind (pinned), 4: pose, 5: audience, 6: fields}`; the pose's frame is the new parent and
      slot, and the audience is fixed for the node's life.
   2. remove `{2: node}`: the node, its subtree and every link with an end in them
      ([world-model.md](world-model.md) rule 3). The zone's root is never removed (`remove-root`).
   3. reparent `{2: node, 3: old frame, 4: pose}`: from one slot (`[node]` or `[node, slot]`) to another of the
      same parent, the pose's frame. A new parent is a crossing, a leave and an arrive (rule 14), refused here as
      `crosses-nodes`. A reparent clears the node's motion; a node still moving writes a motion sample after it.
   4. set a field `{2: node, 3: field number, 4: value, 5: by}`. `by`, when the value is an amount moved, is the
      signed amount (SA-F2b): kept, never needed to apply. That amounts moved sum to zero is a commit's check (K2 or
      the F lane), not apply's: one pour is two effects (rule 6), each with its own `by`.
   5. link `{2: link, 3: type, 4: [end, end], 5: owning end (0 or 1), 6: audience}` (world-model.md rule 7).
   6. unlink `{2: link}`.
   7. a motion sample `{2: sample}`: T4's hand-off record, read by T4's own reader (`HandOff::from_value`,
      [pose.md](pose.md) rule 13): an island owner is refused, and so is any byte form T4 would not write. Its pose
      is in the node's own frame; a sample in another frame is `frame-mismatch`.

   A change number this build does not know is refused (`change-unknown`), never skipped: skipping would leave a
   different state. Adding an eighth is a new schema.
4. **A named event is a name and numbered fields:** `{1: name, 2: fields, 3: [index of a change it explains, ...]}`.
   It adds no state. Stripping every named event from a part leaves the same state hash. A state change reachable
   only through a named event would break every future viewer.
5. **Applying needs no kinds.** A create's kind must be one the header pins (`kind-not-in-header`), but nothing in a
   kind's definition is read to apply. A viewer with the log and no kinds rebuilds the same state.
6. **The envelope, and an entry writes only its own node.** The envelope is the sequence, the world time in T5's
   microseconds ([time.md](time.md)), the cause (`{1: 1, 2: intent id}`, `{1: 2, 2: earlier sequence}` or `{1: 3}`
   the world), the actor (`{1: 1, 2: Soul id}`, `{1: 2, 2: principal id}` a creator, or `{1: 3}` the world), the
   audience (`{1: 1}` everyone or `{1: 2, 2: audience id}`, T8) and the node whose system wrote it. **The log is
   ordered by sequence alone** ([ids.md](ids.md) rule 8): a part's entries follow the state's last one by one, else
   `sequence-gap`, and world times inside a tick need not rise with it (time.md rule 9). **Each entry writes only its
   node** (zones.md rule 2): every change's node is the envelope's node or one the same entry created under it
   (`not-own-node`), and the envelope's node exists (`node-missing`). A create's node is its parent; a link's is its
   owning end. A change that crosses nodes is a leave and an arrive (rule 14). **What an entry changes lies within its
   audience:** every node or link it creates, changes, moves or sends, and every timer's node, has the envelope's
   audience (`audience-mismatch`); a change for another audience is an entry of its own. A creator is named by a principal id,
   never an account id (T8). A creator driving a body the world owns is the actor, not the world.

## Bundles, headers and bytes

7. **A header is written once per bundle; each part names it by hash.** A header is `{1: build, 2: schema, 3: lineage,
   4: zone, 5: epoch, 6: [kind, ...], 7: [move revision, ...]}`: the build and the schema by hash, the lineage of the
   world or fork (ids.md rule 8, not the zone writer's minting scope), the zone (its root's id), the writer's epoch,
   and the kinds and moves its entries rest on, pinned. The schema hash is `souls/schema/1` over `effects.rs`
   `schema()`: each change's and record's number, name, required fields and apply revision. A header naming any other
   schema is refused (`schema-unknown`). A part is `{1: header hash, 2: [entry, ...]}`; the hash is `souls/header/1`
   over the header's stored bytes. A part naming another header is `header-mismatch`.
8. **Records keep what they do not know, and hashes are over stored bytes.** A record read by this build keeps every
   field number it does not know, and an event's name is not looked up, so a part from a later build re-encodes to
   exactly the bytes it was read from. **A later field on a known change never changes how it applies;** a change
   whose meaning changes gets a new apply revision, and so a new schema. A default is left out, never written empty:
   `2: {}` and `3: []` in an event, `8: []` on an entry and `3: []` on an arrive are `not-canonical`. A header's and a
   part's hashes are taken over the stored bytes, never over a re-encoding. Small closed values (a cause, an actor,
   an audience, T4's and T5's records, transfer records, timers) have no room for later fields and refuse them.
9. **Numbers are integers in stated units and frames:** positions, velocities and orientations in T4's units and in
   the frame the record names, times in T5's microseconds, amounts as the kind states. T0's profile refuses every
   float ([encoding.md](encoding.md) rule 2). Every integer an entry carries is a signed 64-bit integer, set values
   and create and event fields included, or it is refused (`int-out-of-range`), never cast; only field numbers,
   sequences, epochs, slots and id counters are unsigned. A float that only decides which entry is written breaks
   this rule as much as one in the record.
10. **No free text.** Every text item in a part is a name, `namespace:name`, lower case, optionally pinned as
    `namespace:name@1220<64 hex digits>`; anything else is `text-not-a-name`. Words that once reach the log can
    never be taken back: an entry holds a reference (T8), never words. A return's reason is a name too.

## State and the fixtures

11. **`effects::State` is a test harness, the fixtures' reference apply, and nothing else.** K2 (#2646) owns the one
    in-memory tree: it implements these changes and records with T2's index and checks, and the fixtures' state
    hashes must come out the same through it. The harness's state is one profile value, `{1: next sequence, 2: [[id,
    node], ...], 3: [[id, link], ...], 4: in flight, 5: arrived transfer ids, 6: timers, 7: time effects}` (4 to 7
    when not empty), and its hash is `souls/fixture/1` over those bytes. A world's public and private state hashes
    are K5's node tree ([ids.md](ids.md) rule 11), not this.
12. **The fixtures** are CBOR diagnostic text with `#` comments: `header.diag`; `0-base.diag` (time records, then a
    creator's entry that creates a small world under the root); one fixture per generic change (`1-create` to
    `7-motion`, each applied to the base alone, each its node's own entry); `8-future.diag`, `4-set` as a later
    build might write it, with unknown field numbers in an entry, a change and an event and an event name this build
    has never seen, which applies, re-encodes to its own bytes and leaves `4-set`'s state hash; `9-transfer` (the cup
    put down on the crate: a leave and an arrive), `10-timer` (two timers set, one cleared) and `11-away` (a leave to
    another zone returned, a leave settled, and an arrive carrying a key from another zone). `goldens.txt` holds, as
    hex, each part's bytes and its state hash with and without named events; the native and the WASM builds must give
    it exactly.
13. **Step 0:** T4's hand-off record decodes and encodes to the same bytes through T0's profile, holds no float, and
    reads through T4's reader as a motion sample that writes back to the same bytes.

## Transfers, timers and time

14. **T1's transfer records are their own record type** (`TransferRec`, body 9), keyed by the transfer's id, as
    `zones.rs` defines them (zones.md rules 5 and 6), not generic changes: the closed list stays seven.
    - leave `{1: 1, 2: transfer, 3: node, 4: lineage, 5: zone, 6: pose}`: the node's own entry. The node and its
      subtree, with the links their ends own, go into flight, bound for that world and zone at that pose, whose frame
      is the new parent and slot. The root never leaves.
    - arrive `{1: 2, 2: transfer, 3: [create or link, ...]}`: the entry of the node it arrives under. Inside one zone
      (a leave in tick n, the arrive in tick n+1) it carries nothing and ends the flight, under the leave's pose, or
      is `arrive-parent-missing`. From another zone it carries the subtree, root first, as creates and links, under
      rule 6. A transfer id arrives once: a second arrive changes nothing.
    - settle `{1: 3, 2: transfer}`: the other zone's arrive is durable; the subtree is gone from here.
    - return `{1: 4, 2: transfer, 3: reason}`: that arrive was refused, for the named reason; the subtree is back
      where it stood. Settle and return are the entries of the node the subtree left.
15. **A pending timer is state, written by a timer record** (body 11), never only by an event: set `{1: 1, 2: timer,
    3: due, 4: name}` (due at a world time in T5's microseconds; the name says what it is for) and clear `{1: 2,
    2: timer}` (fired or cancelled), both by the entry of the node that owns it. It survives a restart and an idle
    catch-up because it is in the state, and stripping events leaves it.
16. **T5's time effects are a record of their own** (body 10), each exactly as time.md rule 8 writes it, never a
    `set` on the root's field numbers. They are the zone root's entries, for everyone.

## Mapping SA-F2b

SA-F2b's results reach this layer through an adapter, not unchanged: field names become field numbers, receipt ids
become T3 ids, link keys become link ids, and a `Place` becomes a frame and a pose from E4. SA-F2b is being changed
separately so that its values sit inside T0's profile (no booleans, nulls or text values) and its event names are
qualified by the kind's namespace.

## What would quietly break this

- **Re-encoding before hashing.** A build that drops fields it does not know gives different bytes and a different
  hash for the same history; Protocol Buffers' bytes are not canonical for this reason.
- **Skipping a change or record this build does not know.** Its state would differ from a newer viewer's, silently.
- **A later field that changes how a known change applies.** Old builds would apply it the old way, with no error.
- **State that only a named event carries,** or an apply that reads an event's name. Strip the events and the world
  changes. A timer held only in an event is the same fault.
- **An entry that writes another node,** or a crossing written as one change. Two systems would race for one node,
  and a split writer would lose the change.
- **An entry's audience narrower or wider than what it changes.** A view filtered by it shows a private node to
  everyone, or hides a public change.
- **Reading a kind's definition to apply.** Old logs would then need old kinds forever, and a changed kind would
  change history.
- **A float anywhere that decides an entry,** including one that never reaches the log. Native and WASM differ.
- **Free text in a field,** a name, a reason or an event. It cannot be erased (T8). Text stored as bytes gets past
  rule 10; only K3's field types can stop it.
- **An account id as an actor,** or the world as the actor of a creator's act.
- **A part without its header's hash,** or a header written per part. Parts would read against the wrong kinds.
- **A second tree container** built from this harness. K2 owns the tree; a copy would drift from it.
