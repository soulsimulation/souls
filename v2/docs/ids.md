# Ids, names and hashes

Engine v2 T3 (#2640), contract T3 in [TRUNK.md](TRUNK.md). It fixes how things, kinds, fields and versions are named
and which bytes a hash covers. Every byte comes from the [encoding profile](encoding.md). Code:
`v2/crates/replica/src/ids.rs`. Fixtures: `v2/crates/replica/fixtures/ids/`. Checks: `crates/replica/tests/ids.rs`
(native, in `cargo test`) and the `ids-goldens` step of `v2/tools/ci.sh` (the WASM build in Node). Signing, the node
hash tree (K5) and loading kinds (K3) are not here.

## Ids

1. **An id is a scope and a counter, and every writer that mints has its own scope.** A world's first zone mints
   from the world's scope. Each fork, and each zone writer after the first (contract T1), gets a fresh scope. So two
   writers in one world never give out the same id. A scope is 16 random bytes from the directory or the operating
   system's random source. It never comes from the world's random numbers, which a fork replays. Sixteen bytes,
   because 8 would give a 3 % chance of a clash at a billion scopes.
2. **The counter starts at 0 and stays below 2^53**, the largest range a JavaScript number holds exactly. A scope
   that runs out is refused by name, `id-counter-exhausted`.
3. **An id is encoded `[h'<scope>', counter]`.**
4. **In one world's history, an id is never given to a different thing.** A counter is minted once. Undoing a
   removal brings back the same thing with its id.
5. **A fork keeps the ids it carries;** they are shared with the parent. New things in the fork get the fork's
   scope. A fork carries no bodies, since a Soul is in one world; what a body held is set down where it stood (K6).
6. **An arrival whose id the destination has ever held gets a fresh id there and keeps the old one as its origin.**
   Otherwise it keeps its id. "Ever held" covers three kinds of id. The first two are the counters below a bound in
   each scope the world minted from or inherited at its fork. The third is the ids that arrived from other scopes
   (`Held`). It includes things that left, so a fork's copy and a thing coming home are both renamed, and one id
   never names two things in the world's history. The destination's writer applies arrivals one after another, and
   each arrival is recorded before the next, so two arrivals in one tick never keep the same id.
7. **Souls are global.** A Soul's id is minted by the directory, not by a world, so it is the same in every world.
   A body is a node of its world, linked to its Soul (contract T2).
8. **A version is (lineage, zone, epoch, sequence),** encoded `[h'<lineage>', <zone id>, epoch, sequence]`. The
   lineage is the scope the world or fork was created with. The zone is the id of the zone whose log holds the
   change. The epoch is the writer's term in the directory (contract T11). The sequence is the change's place in that
   zone's log. Two zones never share a counter, so a second writer needs no shared number.

## Hashes

9. **A hash is written as algorithm code, digest length and digest** (a multihash). The one algorithm is SHA-256,
   code `0x12`, which multicodec lists as permanent (BLAKE3 is still a draft there). In a record it is 34 bytes. In
   a name it is those bytes as lower-case hex, `1220` and 64 digits. A new algorithm is a new code, and old hashes
   keep theirs.
10. **A hash's input is its purpose label, as one profile text item, and then the stored bytes.** The labels are
    `souls/kind/1`, `souls/kind-beside/1`, `souls/geometry/1`, `souls/state-public/1`, `souls/state-private/1`
    and `souls/fixture/1`, with `souls/header/1` and `souls/schema/1` for the log ([effects.md](effects.md)) and
    `souls/view/1` and `souls/redactions/1` for views ([views.md](views.md)), `souls/model/1` for a stored
    model of a kind's picture, binary glTF (V17, `v2/tools/import-eden/README.md`), `souls/upload/1` for an
    upload's stored bytes (G6, `v2/crates/assets`), and `souls/move/1` for a move's revision (rule 16, F13).
    Hashing something new, or the same thing differently, takes a new label.
11. **Public and private state are hashed apart.** A node's public fields have one hash and each private audience's
    fields another. A hash of small private state can be guessed by trying values, so it is shown only to those
    who can see that state.

## Kinds

12. **A kind is named `namespace:name@hash`,** in lower case as SA-F1 has it. The namespace is `a-z 0-9 -` and the
    name is `a-z 0-9 _`, each starting with a letter, so no two kinds differ only in case. The hash is the
    `souls/kind/1` hash of the kind's meaning: every section numbered below 20, the name included.
13. **Everything is numbered.** Sections, fields, points and forms are maps keyed by number. A field's name, type,
    default and audience are in its entry, so changing any of them or its number renames the kind.
14. **A kind refers to other kinds through section 10,** which maps a local number to `namespace:name`. The rest of
    the kind uses that number. In the hashed bytes each name becomes the full `namespace:name@hash`, so a change in a
    referred kind renames every kind that refers to it. Geometry is covered by its `souls/geometry/1` hash
    (section 7).
15. **Sections 20 and up sit beside the kind:** looks, words, card and how-tos. They have their own
    `souls/kind-beside/1` hash, so a better picture renames no placed thing (SA-F1, #2842).
16. **A form step names a move by plain name.** The kind's hash covers that name, not the move. A move's reach,
    effector, resources, blocks and cancels are its claims. A change to any of them needs a new move name. Only its
    timing may be retuned under the same name (SA-D4, PR #2958). The record of a move in progress carries the move's
    own hash, so a replay uses that exact revision. To check an act before any record exists, a client uses the
    move revisions that the current log segment's header names by hash, beside the kinds (contract T6, #2645).
17. **Kinds that refer to each other in a circle are refused** as `kind-circular`, with the circle listed:
    `t:a -> t:b -> t:c -> t:a`. A kind naming itself is a circle of one. Also refused by name are
    `kind-unknown-reference`, `kind-duplicate` and `kind-source` (text that is not a kind).
18. **The source is not the meaning.** Key order, comments (`#` to the end of the line), spacing and the file name
    do not reach the hashed bytes.
19. **No new name characters.** T0's set (letters, digits, `_ - . : / @`) holds every full kind name, label and
    hash written as text.
20. **The golden file** `fixtures/ids/goldens.txt` holds an id, a version, the fork fixture and the two fixture kinds,
    each with its bytes and its hash or name. Both builds must give this file exactly. It changes only in its own
    commit, with the reason.

## Open for K3

- A local reference number that points at no entry of section 10 is not checked here. K3 must refuse it, or a
  referred kind escapes the hash.
- Renumbering local references renames a kind without a change of meaning. K3 should number them in order of
  first use.
- SA-F1's inline geometry (`bounds_mm`) becomes a `souls/geometry/1` hash in section 7.

## The hash cases

Base: `fixtures/ids/kettle.diag`, which refers to `cup.diag`. Each case edits the text once.

| The kettle's hash changes for | It stays the same for |
|---|---|
| a field's type, `int` to `count` | key order (two fields swapped, and one field's keys reversed) |
| a field's default, 20000 to 25000 | comments (all removed, one added) |
| a field's audience, `holder` to `owner` | spacing (tabs and newlines added) |
| a field's number, 2 to 3 | the file name (read from another file) |
| a field added | a look beside the kind (SA-F1) |
| a point moved 5 mm | |
| a form given another step | |
| the geometry's hash | |
| the referred cup's default | |

## What would quietly break this

- **A scope drawn from the world's random numbers.** A fork replays them, so parent and fork would mint the same ids.
- **A second zone writer minting from the world's scope.** Two writers would give out the same ids.
- **Narrowing "ever held" to "held now".** A thing that left, or a removed one that undo brings back, would then
  share its id with an arrival.
- **Hashing the source text.** Comments and key order would rename kinds. Only the encoded meaning is hashed.
- **A reference written as a plain name in the hashed bytes.** A change in the referred kind would leave the
  referring kind's name unchanged.
- **Moving a look below section 20,** or meaning above it. Pictures would rename kinds, or meaning would escape the
  hash.
- **Changing what a move claims under the same move name.** Kinds that use it would change meaning without a new
  name.
- **A hash without its label,** or one label for two purposes. A public and a private hash of the same bytes would
  then be equal.
- **Showing a private hash outside its audience.** Small state is found by trying values.
- **A counter above 2^53 read in JavaScript.** It rounds without an error.
- **A second hash routine.** Both builds share this one, and FIPS 180-4's examples check it.
