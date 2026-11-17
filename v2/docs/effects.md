# Effects

Engine v2 T6 (#2645), contract T6 in [TRUNK.md](TRUNK.md). It fixes the shape of every byte of history: a generic
change any future viewer can apply, a named event saying what it meant, the envelope, the header a bundle's parts
name, and the bytes. Code: `v2/crates/replica/src/effects.rs`. Fixtures: `v2/crates/replica/fixtures/effects/`.
Checks: `crates/replica/tests/effects.rs` natively, and the `effects-goldens` step of `v2/tools/ci.sh` for the WASM
build. The encoding (T0, [encoding.md](encoding.md)), writing the log (K4), applying and querying at speed (R1) and
views (T7) are not here.

## An effect

1. **An effect is one record holding both layers:** `{1: sequence, 2: at, 3: cause, 4: actor, 5: audience, 6: node,
   7: changes, 8: events}`. Fields 1 to 6 are the envelope, 7 the generic changes, 8 the named events (left out when
   there are none). One record, not two linked ones: the meaning cannot lose its changes.
2. **Its generic changes apply in order, all or none,** and so does a part: one refusal leaves the state as it was,
   and every refusal has a name (`node-missing`, `parent-missing`, `id-duplicate`, `frame-mismatch`, `tree-cycle`,
   `depth-over-limit`, `link-missing`, `link-owner-not-node`, `kind-not-in-header`, `header-mismatch`,
   `sequence-gap`, `change-unknown`, `int-out-of-range`, `name-not-pinned`, `text-not-a-name`, `not-a-record`,
   `encoding`).
3. **The generic changes are a closed list of seven** (`Change`), each `{1: number, ...}`:
   1. create `{2: node, 3: kind (pinned), 4: pose, 5: audience, 6: fields}`; the pose's frame is the new parent and
      slot, and the audience is fixed for the node's life.
   2. remove `{2: node}`: the node, its subtree and every link with an end in them
      ([world-model.md](world-model.md) rule 3).
   3. reparent `{2: node, 3: old frame, 4: pose}`: the old parent and slot (`[node]` or `[node, slot]`), and the pose
      in the new frame, which is the new parent and slot. A node not where the old frame says is `frame-mismatch`.
   4. set a field `{2: node, 3: field number, 4: value, 5: by}`. `by`, when the value is an amount moved, is the
      signed amount (SA-F2b): kept, never needed to apply.
   5. link `{2: link, 3: type, 4: [end, end], 5: owning end (0 or 1), 6: audience}` (world-model.md rule 7).
   6. unlink `{2: link}`.
   7. a motion sample `{2: sample}`: T4's hand-off record exactly as T4 writes it ([pose.md](pose.md) rule 13). Its
      pose is in the node's own frame; a sample in another frame is `frame-mismatch` (a new frame is a reparent).

   A change number this build does not know is refused (`change-unknown`), never skipped: skipping would leave a
   different state. Adding an eighth is a new schema.
4. **A named event is a name and numbered fields:** `{1: name, 2: fields, 3: [index of a change it explains, ...]}`.
   It adds no state. Stripping every named event from a part leaves the same state hash. A state change reachable
   only through a named event would break every future viewer.
5. **Applying needs no kinds.** A create's kind must be one the header pins (`kind-not-in-header`), but nothing in a
   kind's definition is read to apply. A viewer with the log and no kinds rebuilds the same state.
6. **The envelope:** the sequence (the effect's place in its zone's log, [ids.md](ids.md) rule 8; a part's effects
   follow the state's last one by one, else `sequence-gap`), the world time in T5's microseconds
   ([time.md](time.md)), the cause (`{1: 1, 2: intent id}`, `{1: 2, 2: earlier sequence}` or `{1: 3}` the world),
   the actor (`{1: 1, 2: Soul id}`, `{1: 2, 2: principal id}` a creator, or `{1: 3}` the world), the audience
   (`{1: 1}` everyone or `{1: 2, 2: audience id}`, T8) and the node whose system wrote it (for a link, the owning
   end's node). A creator is named by a principal id, never an account id (T8). A creator driving a body the world
   owns is the actor, not the world.

## Bundles, headers and bytes

7. **A header is written once per bundle; each part names it by hash.** A header is `{1: build, 2: schema, 3: lineage,
   4: zone, 5: epoch, 6: [kind, ...], 7: [move revision, ...]}`: the build and the schema by hash, the zone's lineage
   (its scope), zone (its root's id) and writer's epoch, and the kinds and moves its effects rest on, pinned. The
   schema hash is `souls/schema/1` over `effects.rs` `schema()`, the field numbers this page fixes. A part is
   `{1: header hash, 2: [effect, ...]}`; the hash is `souls/header/1` over the header's stored bytes. A part naming
   another header is `header-mismatch`.
8. **Records keep what they do not know, and hashes are over stored bytes.** A record read by this build keeps every
   field number it does not know, and an event's name is not looked up, so a part from a later schema re-encodes to
   exactly the bytes it was read from. A header's and a part's hashes are taken over those stored bytes, never over a
   re-encoding. Small closed values (a cause, an actor, an audience, a motion sample, T4's records) have no room for
   later fields and refuse them as `not-a-record`.
9. **Numbers are integers in stated units and frames:** positions, velocities and orientations in T4's units and in
   the frame the record names, times in T5's microseconds, amounts as the kind states. T0's profile refuses every
   float ([encoding.md](encoding.md) rule 2). An integer the profile holds beyond signed 64 bits is refused
   (`int-out-of-range`), never cast. A float that only decides which effect is written breaks this rule as much as
   one in the record.
10. **No free text.** Every text item in a part is a name, `namespace:name`, lower case, optionally pinned as
    `namespace:name@1220<64 hex digits>`; anything else is `text-not-a-name`. Words that once reach the log can
    never be taken back: an effect holds a reference (T8), never words.

## State and the fixtures

11. **The state the fixtures hash** is one profile value, `{1: next sequence, 2: [[id, node], ...], 3: [[id, link],
    ...]}` in id order, a node `{1: kind, 2: parent, 3: slot, 4: audience, 5: fields, 6: place, 7: motion}` and a
    link `{1: type, 2: ends, 3: owning end, 4: audience}`. Its hash is `souls/fixture/1` over those bytes. A world's
    public and private state hashes are K5's node tree ([ids.md](ids.md) rule 11), not this.
12. **The fixtures** are CBOR diagnostic text with `#` comments: `header.diag`, `0-base.diag` (a small world built by
    generic changes), one fixture per generic change (`1-create` to `7-motion`, each applied to the base alone, each
    with a named event) and `8-future.diag`: `4-set` as a later schema might write it, with unknown field numbers in
    the effect, a change and an event, and an event name this build has never seen. It is applied, re-encodes to its
    own bytes and leaves `4-set`'s state hash. `goldens.txt` holds, as hex, each part's bytes and its state hash
    with and without named events; the native and the WASM builds must give it exactly.
13. **Step 0:** T4's hand-off record decodes and encodes to the same bytes through T0's profile, holds no float, and
    reads as a motion sample that writes back to the same bytes.

## What would quietly break this

- **Re-encoding before hashing.** A build that drops fields it does not know gives different bytes and a different
  hash for the same history; Protocol Buffers' bytes are not canonical for this reason.
- **Skipping a change this build does not know.** Its state would differ from a newer viewer's, silently.
- **State that only a named event carries,** or an apply that reads an event's name. Strip the events and the world
  changes.
- **Reading a kind's definition to apply.** Old logs would then need old kinds forever, and a changed kind would
  change history.
- **A float anywhere that decides an effect,** including one that never reaches the log. Native and WASM differ.
- **Free text in a field,** a name or an event. It cannot be erased (T8).
- **An account id as an actor,** or the world as the actor of a creator's act.
- **A part without its header's hash,** or a header written per part. Parts would read against the wrong kinds.
