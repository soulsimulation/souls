# Ids, names and hashes

Engine v2 T3 (#2640), contract T3 in [TRUNK.md](TRUNK.md). It fixes how things, kinds, fields and versions are named
and which bytes a hash covers. Every byte comes from the [encoding profile](encoding.md). Code:
`v2/crates/replica/src/ids.rs`. Fixtures: `v2/crates/replica/fixtures/ids/`. Checks: `crates/replica/tests/ids.rs`
(native, in `cargo test`) and the `ids-goldens` step of `v2/tools/ci.sh` (the WASM build in Node). Signing, the node
hash tree (K5) and loading kinds (K3) are not here.

## Ids

1. **An id is a scope and a counter.** The scope is 16 random bytes, new for every world and every fork. It comes
   from the directory or the operating system's random source, never from the world's random numbers, which a fork
   replays. Sixteen bytes, because 8 would give a 3 % chance of a clash at a billion scopes.
2. **The counter starts at 0 and stays below 2^53**, the largest range a JavaScript number holds exactly. A scope
   that runs out is refused by name, `id-counter-exhausted`.
3. **An id is encoded `[h'<scope>', counter]`.**
4. **An id is never given to a different thing.** A counter is minted once. Undoing a removal brings back the same
   thing with its id.
5. **A fork keeps the ids it carries;** they are shared with the parent. New things in the fork get the fork's
   scope. A fork carries no bodies, since a Soul is in one world; what a body held is set down where it stood (K6).
6. **An arrival whose id the destination knows gets a fresh id there and keeps the old one as its origin.** Known
   means the destination holds a node with that id, or holds a removal that undo could bring back. A thing that
   left by travel is not known, since travel is not undone. Otherwise the arrival keeps its id.
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
    `souls/kind/1`, `souls/geometry/1`, `souls/state-public/1`, `souls/state-private/1` and `souls/fixture/1`.
    Hashing something new, or the same thing differently, takes a new label.
11. **Public and private state are hashed apart.** A node's public fields have one hash and each private audience's
    fields another. A hash of small private state can be guessed by trying values, so it is shown only to those
    who can see that state.

## Kinds

12. **A kind is named `namespace:name@hash`.** Each part is made of name characters, with one `:` and no `@`. The
    hash is the `souls/kind/1` hash of the kind's meaning: every section numbered below 20, the name included.
13. **Everything is numbered.** Sections, fields, points and forms are maps keyed by number. A field's name, type,
    default and audience are in its entry, so changing any of them or its number renames the kind.
14. **A kind refers to other kinds through section 10,** which maps a local number to `namespace:name`. The rest of
    the kind uses that number. In the hashed bytes each name becomes the full `namespace:name@hash`, so a change in a
    referred kind renames every kind that refers to it. Geometry is covered by its `souls/geometry/1` hash
    (section 7).
15. **Sections 20 and up sit beside the kind:** looks, words, card and how-tos. They are kept under their own
    hash, so a better picture renames no placed thing (SA-F1, #2842).
16. **A form step names a move by plain name.** The kind's hash covers that name, not the move. The record of a move
    in progress carries the move's own hash, so a replay uses that exact revision. A change in what a move claims
    is a new move name. Retuning only its timing keeps the name (SA-D4, PR #2958).
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
- **Treating a removed id as free.** Undo would then bring back a thing that shares its id with an arrival.
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
