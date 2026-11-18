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
   fallbacks, 10: replaces, 11: body}`.** 3, 4, 8, 9, 10 and 11 are left out when empty, never written empty
   (`not-canonical`), and an intent re-encodes to exactly its own bytes. Any other field is refused
   (`intent-not-a-record`): there is no field for a start time or a condition, and a new field is a new protocol
   version.
3. **What each field holds.** The actor is a Soul or a creator's principal id (T6); a creator driving a body the
   world owns is the actor, with the creator's own sequence, and field 11 names that body; it is there exactly when
   the actor is a creator (`creator-without-body`, `body-not-a-creators`). **Field 11 is proposed here for the
   owner's decision at the trunk stop:** the issue's field list has no place for the body, and lane I's I13 hands
   back without one (`v2/docs/tranche/I-R-intents-and-replica.md`, "Could not resolve" 2). The sequence is per actor
   and never reused, so a reconnect never repeats an act. The basis is the version it was decided against (T3:
   lineage, zone, epoch, sequence). The expiry is in world time (T5), never the client's clock. The target is a node,
   or a selector from a closed list that the engine binds at commit and records as its choice: the first, any free
   slot of a kind in a node with its binding rule as a field (`replica::selector`, I5; a sit from the gateway takes it,
   I5b), and E2 adds the rest.
   Resources are T9's claims (`{1: 1 all, 2 one or 3 named, 2: class or name}`). Parameters are the form's arguments;
   none may be a time or a condition, the one exception being a move's next beat (rule 9).
4. **An intent's kind is its verb.** A form's verb (`namespace:form`) is a checked act. The engine's own verbs are
   `souls:move` (a move inside a joint activity), `souls:cancel` and the orders; any other `souls:` verb is refused
   (`order-unknown`). Follow and queue need a target (`order-without-target`); naming the act at a queue's head is
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
   sequence, ...]}`, naming the entries that carried it out (one act may be several, since each entry writes one
   node). A refusal is `{.., 3: 2, 4: reason, 5: version now, 6: [node, ...]}`, naming what changed since its basis
   (6 left out when empty). Bytes refused before an actor and a sequence are read get `{3: 5, 4: reason}`. How an act
   ends later (done, failed, timed out) is I4's.
9. **A move inside a joint activity is accepted, then resolved:** `{.., 3: 3, 4: intent id}`, then `{.., 3: 4, 4:
   outcome}`; a miss is an outcome, not a refusal. Its parameter may name one of the activity's next beats, at most
   about two seconds ahead (B8): a parameter of a move already accepted, not an order waiting on the world.
10. **A cancel ends and a replace supersedes the actor's own earlier intent,** named by its sequence in field 10. A
    cancel without it is refused (`cancel-without-replaces`), and so is one that carries anything else
    (`cancel-not-bare`).
11. **A size limit applies before parsing:** an intent over 4,096 bytes is refused (`intent-too-large`) before any
    byte is read as CBOR.

## Versions and the checker

12. **The first frame each way never changes:** `{1: protocol version, 2: build hash}`, and, from a world that cannot
    speak the client's version, `3: {1: "souls:protocol-version", 2: client's version, 3: world's version}`. A
    version refusal uses that frame only, so a client of any version reads a refusal from any later world; the reader
    keeps field 3's name, and its versions when there. A frame over 256 bytes is refused before parsing. The goldens
    hold a client's frame and a version refusal, from both builds. The build hash is the world's pinned build, a
    field of its directory record (T11). This protocol is version 1.
13. **The checker is `replica` as WASM, verified by hash, run with no imports.** The checker artifact is `replica`
    built for `wasm32-unknown-unknown` with the `checker` feature, which leaves out every wasm-bindgen export, so the
    module imports nothing; the build hash is the SHA-256 multihash of that `.wasm` file's bytes (what `sha256sum`
    gives, `1220` and 64 hex digits). A client loads it only when that hash is the one asked for
    (`checker-not-the-build`), and only a WASM module (`checker-not-wasm`) with no import entries
    (`checker-has-imports`). The `checker-artifact` step of `v2/tools/ci.sh` builds it and loads it by its hash. Its
    checking exports are I2's.
14. **The fixtures** are one intent per kind (a checked act, a move, ranked fallbacks, a held stance, follow,
    standing in a queue, a cancel, a replace), as diagnostic notation. `goldens.txt` holds each one's kind and bytes;
    the native and the WASM builds must give it exactly.

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
- **The world as the actor of a creator's act,** or a creator's act on the Soul's sequence. Two writers would share
  one sequence.
- **An effect that cannot name the intent that caused it,** or a receipt that names one entry. A sit is a leave and
  an arrive; its receipt would point at half of it.
- **A checker that imports anything,** wasm-bindgen's glue included. It could not be run with nothing granted.
- **A field added to the envelope without a new protocol version.** Old checkers would accept what they cannot read.
