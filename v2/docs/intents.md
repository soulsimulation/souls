# Intents and the protocol

Engine v2 T10 (#2664), contract T10 in [TRUNK.md](TRUNK.md). It fixes the intent envelope, the two ways an intent is
answered, the closed list of orders, and how protocol and checker versions are named. Code:
`v2/crates/replica/src/intents.rs`. Fixtures: `v2/crates/replica/fixtures/intents/` (one per kind, and
`goldens.txt`, their bytes as hex). Checks: `crates/replica/tests/intents.rs` natively and the `intents-goldens` step
of `v2/tools/ci.sh` for the WASM build. Sockets and tokens (I1), checking (I2, I3), receipts and orders at runtime (I4,
B7) and plans and schedules (the client's: I9, R15) are not here.

## The envelope

1. **An intent is what an agent asks; the engine performs the motion.** The zone's writer mints an id for each intent
   it reads, from its own scope (T3 rule 1), and every effect the intent causes names that id as its cause (T6 rule
   6, cause 1). The intent is kept in the log as received, with its id, in an entry body of its own that I4 and K4
   add to T6's schema (T6 rule 3: a new record is a new schema); that is how an order is in the log and survives a
   restart. Words in it are references (T8), never words.
2. **An intent is `{1: actor, 2: verb, 3: target, 4: parameters, 5: sequence, 6: basis, 7: expiry, 8: resources, 9:
   fallbacks, 10: replaces, 11: body, 12: reflex}`.** 3, 4, 8, 9, 10, 11 and 12 are left out when empty, never written
   empty (`not-canonical`), and an intent re-encodes to exactly its own bytes. Any other field is refused
   (`intent-not-a-record`): there is no field for a start time or a condition, and a new field is a new protocol
   version. Field 12 (protocol 2, #3764) is `1` on an intent the Soul's client sent on its own standing consent (an
   R9 reflex), and left out on its agent's act; any other value is refused (`intent-not-a-record`). A reflex is not
   the agent acting: it neither keeps a body from going idle nor wakes it (`Intent::agent_act`, the wind-down rule,
   B16). The world keeps the marker with the intent in the log, so a replay reads the same.
3. **What each field holds.** The actor is a Soul or a creator's principal id (T6); a creator driving a body the
   world owns is the actor, with the creator's own sequence, and field 11 names that body; it is there exactly when
   the actor is a creator, an edit excepted (rule 15) (`creator-without-body`, `body-not-a-creators`). **Field 11 is proposed here for the
   owner's decision at the trunk stop:** the issue's field list has no place for the body, and lane I's I13 hands
   back without one (`v2/docs/tranche/I-R-intents-and-replica.md`, "Could not resolve" 2). The sequence is per actor
   and never reused, so a reconnect never repeats an act. The basis is the version it was decided against (T3:
   lineage, zone, epoch, sequence). The expiry is in world time (T5), never the client's clock. The target is a node,
   or a selector from a closed list that the engine binds at commit and records as its choice: the first, any free
   slot of a kind in a node with its binding rule as a field (`replica::selector`, I5); the second, a described spot
   (`replica::select`, E2): a pick among things or free slots, or a point on one node's shape, in ten relations.
   A walk or a sit aimed at a described spot is resolved by a checker on its copy, the client's answer at that
   version, and bound once when the act commits; a spot with no answer is refused by its name (`spot.no-front`).
   Resources are T9's claims (`{1: 1 all, 2 one or 3 named, 2: class or name}`). Parameters are the form's arguments;
   none may be a time or a condition, the one exception being a move's next beat (rule 9).
4. **An intent's kind is its verb.** A form's verb (`namespace:form`) is a checked act. The engine's own verbs are
   `souls:move` (a move inside a joint activity), `souls:cancel`, `souls:edit` (a creator's edit, rule 15) and the
   orders; any other `souls:` verb is refused (`order-unknown`). Follow and queue need a target (`order-without-target`); naming the act at a queue's head is
   optional, and B7 says what a bare queue does.

## Orders, and what the engine never holds

5. **The orders are a closed list of four:** ranked fallbacks (any act's field 9), a held stance (`souls:hold`, its
   stance a parameter), follow (`souls:follow`, its target) and standing in a queue (`souls:queue`, its target, and
   the act taken at its head as a parameter: "queue for this seat and sit"). Each expires, can be cancelled, and is
   recorded as the agent's; an order is in the log, so it survives a restart.
6. **Fallbacks are ranked and bounded:** at most 4, each another act `{2: verb, 3: target, 4: parameters, 8:
   resources}`, carried by an act only and tried by the engine, in order, when the one before is refused at commit
   (`fallbacks-too-many`, `fallback-not-an-act`, `fallbacks-not-on-an-act`). A client's own retries (SA-C8, #2989,
   after a refusal or an act that ends failed) are new intents with new sequences; one intent is never retried by
   both.
7. **Nothing waits for a time or a condition.** Standing in a queue is a body in line taking its turn. When to act is
   the agent's: its client schedules itself from the clocks, calendars and timetables the world publishes (R15).
   Standing consent ("I accept high fives") is a rule in the Soul's own client, never an order the engine holds; it
   works only while the owner's machine is on. The one exception is the world's own: a body silent for an hour is
   wound down (B16), as a record whose actor is the world, not as an intent.

## Answers

8. **A checked act gets a receipt or a refusal.** A receipt is `{1: actor, 2: sequence, 3: 1, 4: intent id, 5: [log
   sequence, ...], 6: {name: id}}`, naming the entries that carried it out (one act may be several, since each entry
   writes one node); 6 is an edit's (rule 15), left out when empty. A refusal is `{.., 3: 2, 4: reason, 5: version
   now, 6: [node, ...], 7: operation}`, naming what changed since its basis (6 left out when empty) and, for an
   edit, the operation that failed by its place in the batch (7 left out when none). Bytes refused before an actor and a sequence are read get `{3: 5, 4: reason}`. How an act
   ends later (done, failed, timed out) is I4's. A form's act is due by its run's start plus its steps' own time (its
   walk, moves and pauses, C20), and a walk's by its planned route's time from when it is planned (C29). Either is
   answered in progress in the tick its run starts or its route is planned, `{.., 3: 3, 4: intent id, 5: µs left}`
   (W11, #4087: not at the deadline it got on arrival), and its receipt or refusal follows by its own deadline.
9. **A move inside a joint activity is accepted, then resolved:** `{.., 3: 3, 4: intent id}`, then `{.., 3: 4, 4:
   outcome}`; a miss is an outcome, not a refusal. Its parameter may name one of the activity's next beats, at most
   about two seconds ahead (B8): a parameter of a move already accepted, not an order waiting on the world.
10. **A cancel ends and a replace supersedes the actor's own earlier intent,** named by its sequence in field 10. A
    cancel without it is refused (`cancel-without-replaces`), and so is one that carries anything else
    (`cancel-not-bare`).
    An answer's frame `{1: version, 2: answer}` may carry one optional field, 3: where the act's time went, in µs
    between stamps of one machine's steady clock (O4, #2694; `replica::intents::ANSWER_TIMES`). It is added as the
    answer leaves, so the logged answer never holds it.
11. **A size limit applies before parsing:** an intent over 4,096 bytes is refused (`intent-too-large`) before any
    byte is read as CBOR.

An activity offer or proposal carries its kind in parameter 1 as `[plain name, binary SHA-256 multihash]`.
The client splits a pinned name there, preserving its exact revision while keeping the 64-byte text limit, as an
edit does below. Roles remain names. Ordinary short activity-kind names remain accepted. The client validates its
completed intent with the same form decoder as the gateway before sending it.

## Versions and the checker

12. **The first frame each way never changes:** `{1: protocol version, 2: build hash}`, and, from a world that cannot
    speak the client's version, `3: {1: "souls:protocol-version", 2: client's version, 3: world's version}`. A
    version refusal uses that frame only, so a client of any version reads a refusal from any later world; the reader
    keeps field 3's name, and its versions when there. A frame over 256 bytes is refused before parsing. The goldens
    hold a client's frame and a version refusal, from both builds. The build hash is the world's pinned build, a
    field of its directory record (T11). This protocol is version 2 (1 had no field 12).
13. **The checker is `replica` as WASM, verified by hash, run with no imports.** The checker artifact is `replica`
    built for `wasm32-unknown-unknown` with the `checker` feature, which leaves out every wasm-bindgen export, so the
    module imports nothing; the build hash is the SHA-256 multihash of that `.wasm` file's bytes (what `sha256sum`
    gives, `1220` and 64 hex digits). A client loads it only when that hash is the one asked for
    (`checker-not-the-build`), and only a WASM module (`checker-not-wasm`) with no import entries
    (`checker-has-imports`). The `checker-artifact` step of `v2/tools/ci.sh` builds it and loads it by its hash. Its
    checking exports are I2's.
14. **The fixtures** are one intent per kind (a checked act, a move, ranked fallbacks, a held stance, follow,
    standing in a queue, a cancel, a replace, an edit, a reflex), as diagnostic notation. `goldens.txt` holds each one's kind and bytes;
    the native and the WASM builds must give it exactly.

## Edits

15. **An edit is a creator's batch under one cause** (Engine v2 G1b, #3362; the batch and its checks are G1's,
    `replica::edit`, committed by `sim::edit`). Its verb is `souls:edit` and its parameters are `{1: [operation, ...]}`,
    1 to 256 operations, with `6: claim id` when it is sent under a build claim (#3701, `replica::edit::claims`); its basis's sequence is the version it was planned against. It carries nothing else: no
    target, resources, fallbacks, replaced intent or body, since it drives none (`edit-not-bare`), and each operation
    is in its one byte form (`edit-not-a-batch`). The operations are place `{1: 1, 2: name, 3: kind's plain name, 4:
    kind's hash, 5: parent, 6: spot, 7: audience, 8: fields}` (7 left out for everyone, else the audience's id; 8
    left out when empty), move `{1: 2, 2: node, 3: spot}`, set `{1: 3, 2: node, 3: field, 4: value}` and remove `{1:
    4, 2: node}`. Doorway `{1: 5, 2: name, 3: door, 4: from, 5: to, 6: [x,z], 7: yaw, 8: width, 9: height,
    10: wall, 11: closed, 12: open}` binds
    a door leaf to a passage owned by its parent `from` place, to another place. Geometry is millimetres and
    millidegrees in the owning room's building frame. Its paired link, owner row and leaf backlink commit together;
    removing the leaf retires the passage under the same ownership and BUILDSAFE checks. `wall` is the exact pinned
    containing building of both places; `closed` and `open` contain 1–64 distinct authored solid rows each (nine
    bounded integers per row). Only exact unique `closed` rows are replaced, leaving unrelated solids intact.
    The check prepares the resulting wall field off-clock, and BUILDSAFE judges that same committed field. Leaf
    field 100 is engine-owned `[wall,closed,open]`; removal restores its patch only while the owned open rows still
    match (`edit.doorway-wall-changed`), with intervening wall writes refused `edit.stale` by the normal stamp check.
    Imported doors have no inferred restoration: their creator supplies an explicit wall Set in the same removal
    batch. The JSON batch uses `wall`, `closed` and `open` with the same meaning. A node is an id, or the
    temporary name of one placed earlier in the batch (an integer). A spot is
    `{1: position, 2: orientation, 3: support, 4: slot}` as T4's pose writes them (4 left out when none). The kind is
    split so no text is over the text limit. Any actor's edit reads; the world refuses one from anyone but its
    creator (`edit.not-the-creator`), checks the rest off the clock thread and answers each batch once (rule 8): a
    receipt mapping each name to the id the world minted, or the refusal's name and the operation that failed. Code:
    `replica::edit::wire`. This adds a kind and two optional answer fields and changes no other kind's bytes
    (`goldens.txt`): additive, as the coordinator decided on #3362, so the protocol stays version 1.
16. **A set-down is a form verb, `hands:set-down`** (E4's caller, #3604): its target is the thing the actor's body
    holds, parameter 1 the placement word by its placements name under `place:` (`place:next_to`; here when
    absent: a text in the log is a namespaced name), 2 the anchor's id for the words that need one, 3 the facing (a
    node's id, or `place:to_wall`; as it was when absent). The world plans, builds and
    judges it off the clock thread (E4's `sim::setdown` and G2's rule, on the edit checker's thread), then commits it
    at a tick with lookups only (still in the same hand, its new parent still there, the bodies judged by the kept
    guard) as one transfer under the intent: one receipt, or a refusal by name (`not-held`, `setdown.no-room`,
    `edit.would-bury`, ...). Code: `worldd::setdown`; the daemon's `set-down` command sends it.

**Step 0.** TRUNK's four orders are ranked fallbacks, a held stance, follow and standing in a queue: this page needs
no fifth, and no field for a start time or a condition.

## What would quietly break this

- **A refusal in a new format.** The client it is for cannot read it, and is told nothing.
- **An expiry in the client's clock.** It depends on that machine, and on what time it thinks it is.
- **A sequence per connection, not per actor.** A reconnect repeats an act.
- **A checker loaded unverified, or with imports.** A world's code runs on an owner's machine with its reach.
- **An unbounded fallback list, or parsing before the size check.** One intent spends the server's checking time.
- **An open order** (a condition language), or one that waits for a time or a condition. That is the world choosing
  for a Soul.
- **Words in an intent.** They reach the log, which can never forget them; an intent carries references (T8).
- **An edit answered per operation,** or committed in part. The creator could not tell which ids its names became,
  nor what stands; one batch is one answer, committed whole or refused whole.
- **The world as the actor of a creator's act,** or a creator's act on the Soul's sequence. Two writers would share
  one sequence.
- **An effect that cannot name the intent that caused it,** or a receipt that names one entry. A sit is a leave and
  an arrive; its receipt would point at half of it.
- **A checker that imports anything,** wasm-bindgen's glue included. It could not be run with nothing granted.
- **A field added to the envelope without a new protocol version.** Old checkers would accept what they cannot read.

### Named form arguments

Form parameter 1 keeps its existing `[[UTF-8 name bytes, value], ...]` representation: a thing id, a one-based
slot number, a declared part name as UTF-8 bytes, or T8 text by reference. Bare argument values use bytes so durable parts retain their names-only text contract; ids remain `[scope bytes, counter]`, including when a part name is exactly 16 bytes long. The thin client's `wireIntent` accepts `drawer=top`
alongside existing `item=<id>` arguments. Its numbered JSON surface also accepts name/value pairs, for example
`{"1":[["drawer","top"]]}`; string keys become the same UTF-8 byte keys. A text value may use the existing
`{"23":"private words"}` input wrapper or `{"21":"<id>"}` reference wrapper. The authority stores words and
replaces input text with its reference; another argument's text remains private to its sender. Arbitrary JSON
objects are refused. Duplicate argument names and incompatible physical move targets are refused rather than
selecting the last value. Signed whole-number parameters keep their exact canonical T0 values, including nested
coordinate arrays; floating-point parameters remain unsupported. Named room/floor movement uses its separate
existing target contract.
