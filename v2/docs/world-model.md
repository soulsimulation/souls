# The world model

Engine v2 T2 (#2641), contract T2 in [TRUNK.md](TRUNK.md). It fixes what a parent means and how every other relation
is written. Ids are T3's ([ids.md](ids.md)). Code: `v2/crates/replica/src/world_model.rs`. Fixtures:
`v2/crates/replica/fixtures/world-model/`. Checks: `crates/replica/tests/world_model.rs`. Memory and speed (K2), the
spatial index (N16), poses (T4) and importing Eden (N1) are not here.

## The tree

1. **A node is an id, a kind, a parent and numbered fields,** plus the parent's slot it sits in, if any, and its
   audience. **A parent means two things only: lifetime and frame of reference.** A child ends when its parent ends
   and moves when its parent moves. Nothing else is read from the tree. **The tree is written flat:** one record
   per node, naming its parent, in the fixtures and in anything that stores or checkpoints it, never as nested
   values. The encoding refuses nesting deeper than 32, and containment depth is not bounded by the encoding.
2. **Nothing has two parents.** Holding and resting are changes of parent, never links. A thing held in a hand is
   a child of the hand's slot. A load carried by several bodies is a child of the carry activity's node, and each
   carrier is linked to that activity. A thing set down is a child of the place, or of the thing it rests on (E4).
   A node written twice is refused as `id-duplicate`.
3. **`remove` takes the subtree and every link ending in it.** That meaning is fixed (contract T6), so a viewer
   that applies a removal is left with no dangling link and needs no code of its own.
4. **There are no fixed levels.** A world, a town, a room, a boat, a body and a cup are all nodes. A door between
   two rooms is a child of the room it belongs to (contract T1), linked to the other.
5. **A kind says what it admits:** kinds as children (its entry's section 10) and kinds in each slot (section 6),
   as in the entry format (SA-F1, #2842). This is checked when a change is committed, never when it is applied, so
   a viewer that knows no kinds still applies the change. A child its parent's kind does not admit is refused as
   `child-not-admitted`.
6. **A node has at most 32 ancestors.** One more is refused as `depth-over-limit`, and a parent chain that comes
   back to itself as `tree-cycle`, with the cycle listed. The check walks up with a loop, never by recursion, and
   finds each node's depth once.

## Links

7. **Every other relation is a typed link:** an id (minted as a node's is, by T3's rules), a type, two ends, the end that
   owns it and an audience. An end is a node of this world or a Soul (Souls are global, [ids.md](ids.md) rule 7).
   An end that is neither is refused as `link-end-missing`. The owning end is a node, since a Soul is in no zone
   (`link-owner-not-node`). Owning, membership, a body's Soul, a carrier and a door's far side are links.
8. **A link is indexed at both ends.** Each index entry carries the link's id, type, other end and audience, so the
   links at a node are listed from the index alone: the asked node is read once, nothing else is visited.
9. **A link is shown only to an audience that can see both its ends.** Audience 0 is everyone; any other is a set
   of Souls, resolved when written (contract T8). A Soul is seen by everyone. A link may be narrower than its ends
   (who is in a public choir, shown to the members); one wider than an end is refused as `link-audience-wider`. A
   listing skips entries the viewer is not in, so a private link at a public node does not show that it exists.

## Derived, never stored

10. **Cells and the spatial index are derived.** The engine splits a node that fills up into cells and keeps an
    index for "what is near" (N16). Neither is ever a parent, part of an id, or in the log.

## The check and the fixtures

11. **The validity check runs at commit** and refuses the first fault in this order: ids, audiences, parents, the
    tree's shape, kinds, links. Its other names: `audience-unknown`, `parent-missing`, `kind-unknown`,
    `world-source` (text that is not a fixture).
12. **The five fixtures** are a door joining two rooms, a boat holding rooms, a load carried by two bodies,
    ownership (with a cup held in a hand) and membership. They are diagnostic notation with `#` comments; each
    names its layout. `kinds.diag` holds what each kind admits.

## What would quietly break this

- **A cell or a floor made a parent.** Walking across it becomes a reparent, and history records engine tuning.
- **A second meaning read from the parent:** who owns a thing, who may use it, who sees it. Each is a link.
- **Holding written as a link.** The held thing would no longer move with the hand, or would have two parents.
- **An index entry without its audience.** A private link listed at a public node shows that it exists.
- **A cascade written in code rather than in `remove`.** A future viewer would keep links whose end is gone.
- **Kinds checked when a change is applied.** A viewer without the kinds could no longer replay history.
- **A recursive walk of the tree.** Depth is data; a WASM stack is small.
- **The tree stored as nested values.** A world deeper than the encoding's nesting limit could not be written.
- **A link owned by a Soul.** No zone would write it.
