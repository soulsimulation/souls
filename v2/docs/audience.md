# Audience and removing words

Engine v2 T8 (#2662), contract T8 in [TRUNK.md](TRUNK.md). It fixes who may see a record, keeps every word out of
the log, and makes words removable from a history that is never rewritten. Code: `v2/crates/replica/src/audience.rs`.
Fixtures: `v2/crates/replica/fixtures/audience/` (a header and a log). Checks: `crates/replica/tests/audience.rs`.
The store that keeps the words and the redaction list is K16's (`v2/crates/sim/src/text/mod.rs`); signing in (W1),
removal end to end (W7) and who may act (F6) are not here.

## Who may see a record

1. **An audience is everyone, or an id naming a set of principals, and that set is written once.** Principals are
   Souls and creators, each named by an id the directory mints, never an account id. Any audience id that is not an
   audience node (rule 2) is one principal's own, with that one member for ever: a whisper's, a creator's private
   state. An audience node's members are its own `souls:member` links, written in the entry that creates it and never
   changed (a later member link or unlink is refused as `audience-members-fixed`). So **a record is seen by its
   audience's members as they were when it was written**: a principal who joins later is a member of a new audience,
   not the old one, and is never sent what came before. A viewer is sent the public views, its own and those of each
   audience it is a member of (T7 rule 5).
2. **One resolver for SA-F8's four rules** (#2947), run when a record is committed. `everyone` is everyone; `creator`
   is the world's creator's own principal id. `owner` and `{linked, link: L}` name the principals at the far end of
   `souls:owns` or `L` links at the thing itself (never on a parent: SA-F8's open point, settled here), each body
   counted as its Soul by `souls:body-of` (whichever end the body is). `souls:owns` is the one owner relation: a
   kind's own `owner` link in the entry format is `souls:owns` on the tree, not `<namespace>:owner`, so who may use a
   thing as its owner (F6's `{"link": "owner"}`) is who sees it as owner (#3265). They resolve to the thing's
   audience node for that rule whose members are exactly those principals: a child of the thing, of kind
   `souls:audience`, with the
   thing's own audience and fields `{1: 1 owner or 2 linked, 2: link type}`. When none matches (none yet, or someone
   joined or left), the commit writes a new one first (`audience-not-declared` names the members it needs). A role
   (`roles.now`, section 17) is a link type, resolved like any other. A creator cannot be a link end (T2 rule 7), so
   `owner` and `linked` name Souls. **When an audience is superseded,** the commit moves what has it to the new one,
   in entries of each audience: each facet ends and a new one takes its fields (rule 3), and each link of the old
   audience at the thing is unlinked and linked again under the new one, with a new link id. A node other than a
   facet may not have a group audience (`audience-group-node`), except a `closed` container's children, which are
   E22's. Each change of members thus costs a new audience node, one member link per member and the moves: a crowd
   that churns under a `linked` rule (a lecture's listeners) should take the public audience, or a rule B5 and R3
   measure first.
3. **A node has one audience for life (T6), so a field of another lives on a facet.** When a kind's field rule
   resolves to an audience other than its node's (a seat's `hand`), the field lives on a child of kind `souls:facet`
   with that audience, written by its own entries ([effects.md](effects.md) rule 6). The commit creates it, in an
   entry of that audience, before the field's first value. What opening a `closed` container (SA-F8 section 9) does
   to its fields and children is E22's; on this page it is a facet with the `closed` rule's audience.
   **Until E22, a sync keeps a closed container's contents apart** (#3915): the world answers a record under a node
   whose kind's entry declares `closed` with empty bytes, as it answers a node not granted, to any Soul that is not
   in the rule's audience at the container now (`owner` and `linked` resolved as above; `creator` is the creator
   alone) and is not the Soul that put the thing in. The creator always sees in. The client holds such a record as
   withheld, a leaf it never reads and asks for again at every sync. The container's record, and each ancestor's up
   to its top, is served to that Soul without the withheld children's hashes, under hashes of its own, so its copy
   neither counts nor can test them. The view tier's hub sends an entry that puts a thing into such a container, or
   touches one in it, to its actor alone. The page's public stream (#3948) asks as nobody: what such a container
   holds is out of its state, baselines included, and out of its entries, by the same rule (`Closed::hides`, and the
   hub's `Inside` for entries), until it is taken out; a part where only hidden things changed is not written. A
   stream begun before keeps them until its next generation, which starts without them and, when that differs, with
   no hand-off (a viewer starts again from its baseline). Code: `v2/crates/worldd/src/closed.rs`,
   `v2/crates/worldd/src/view_out/mod.rs`.
4. **How far a voice reaches is not who may read it** (E13). Speech is an event, `souls:said {1: reference, 2: reach
   in mm}`. Ordinary speech has the public audience and a short reach; a whisper has an audience of one, the
   listener. The speaker's own client keeps what it said.
5. **Account ids stay out of the log.** An actor is a Soul, a creator's principal id or the world (T6 rule 6).
   Re-checking links at a node when its audience changes (T2 rule 11) is the commit's (K3); it never rewrites a
   record.

## Words, kept apart

6. **All free text and every upload, however short, whoever wrote it, is kept apart under a reference.** The log
   holds `{21: id}` and nothing else in that record; field 21 alone is reserved for this in every record, with 22 and
   23 for what a view and delivery add. A `text` field (SA-F6b, #2951) holds one. Words the kind's author wrote are
   part of the kind (its `text` section), not the log's.
7. **A reference is minted (T3), never a hash of the words, and belongs to one audience line:** the audience of the
   entry that first carries it, and, when that is an audience node, every node that supersedes it for the same thing
   and rule (so a seat's text survives a player joining). The store keeps that audience with the words. A record may
   carry only a reference its own entry mints or one already of its own audience (or moved into it by the commit); a
   reference enters a superseding audience only through the commit's move of a facet (the field's current value, rule
   2). Anything else is refused at commit (`reference-audience`), public words quoted in a private record included,
   and delivery gives words to no view outside the line even if such a record exists. The fixture log holds one such
   refused record on purpose (seq 13), to show delivery does not leak it.
8. **A view never holds words; delivery may.** A view (T7, [views.md](views.md)) carries references. Delivered, a
   reference gets its words beside it, `{21: id, 23: words}`, when the view's audience is on the reference's line,
   the store has them and the redaction list does not name them. Words not at hand leave the reference bare. The list
   must be the one the view names (`redactions-differ`), so an older list never undoes a removal.

## Removing words, and forks

9. **Removal deletes the words from the store and adds the reference to the redaction list.** The log is not an input
   to removal: no byte and no hash of it changes. Every view built with the list marks the reference `{21: id, 22:
   1}`. Copies outside the store (a reader's, a cache's) outlive the delete until purged. W7 (#2826,
   `worldd remove-words`, `v2/crates/worldd/src/removal.rs`) removes one person's words by author and time on a
   stopped world, or on a running one, which takes the ask on a thread of its own and never stops its clock; who may
   ask (the person for their own Souls, the world's creator, a site owner) is the directory's to say
   (`directoryd::pairing::removal`): the stream's text files are written again without them (a cache keeps one a minute at most), a
   start writes recovered text files without them, and a fork's history views are re-derived with the list at its
   start. A body's current name and description are kept: the directory holds them and a start sets them again.
   The list is a lineage family's (a world and its forks); views name it by hash.
10. **A fork is a view of a checkpoint through one principal's audiences:** everyone's, its own and those it is a
    member of at the checkpoint. It keeps the ids and the nodes and links it sees; nothing under a node it drops; no
    body (a Soul is in one world, T3; K6 sets down what a body held); and removed words stay removed, since it shares
    the text store and the redaction list. One creator's fork never holds another's private state.

**Step 0.** T6's 13 fixtures hold 36 text items, every one a name: no free text sits in a record.

## What would quietly break this

- **Membership looked up when read, or an audience whose members change.** A principal added later would be sent
  every old hand and whisper.
- **Audiences as a fixed list in stored bytes** (public, owner, creator). A hand of cards, a team or a whisper needs a
  rewrite of history.
- **An account id in an actor or an audience.** Removing a person would mean rewriting the log.
- **A reference that is a hash of its words, or one shared across audiences.** Short words are guessed; a public
  record naming a whisper's reference would publish the whisper.
- **Words inline anywhere in a record,** a name or a reason included. They can never be removed.
- **A view that holds words,** or a removal that rewrites a view. A redaction would then have to find every copy.
- **A private field on a public node.** T6 would write it in the node's public entry, for everyone.
- **A line that admits old references into any record.** A later joiner would read what the earlier members said.
- **A superseded audience left on a link or a node.** A member who left keeps seeing it; one who joined never does.
- **A rule that follows a link on a parent,** or a body end not counted as its Soul. Who sees a field would change
  when something else moves, or nobody would.
- **A fork through a world's whole state.** One creator's fork would hand over another's private notes.
- **A public cache of a private view, or a delete that forgets caches.** Removed words would still be served.
