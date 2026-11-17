# Audience and removing words

Engine v2 T8 (#2662), contract T8 in [TRUNK.md](TRUNK.md). It fixes who may see a record, keeps every word out of
the log, and makes words removable from a history that is never rewritten. Code: `v2/crates/replica/src/audience.rs`.
Fixtures: `v2/crates/replica/fixtures/audience/` (a header and a log). Checks: `crates/replica/tests/audience.rs`.
The store that keeps the words (K16), signing in (W1), removal end to end (W7) and who may act (F6) are not here.

## Who may see a record

1. **An audience is everyone, or an id naming a set of principals.** Principals are Souls and creators, each named by
   an id the directory mints (never an account id). A role is not a stored principal: it is a link (`roles.now`,
   whose turn it is) that the `linked` rule resolves to the Souls in it. **A record is seen by its audience's members
   as the log stood when it was written** (the state just before the entry), never as it stands when read, so a
   principal who joins later does not see what came before. Membership changes are effects: the link and unlink of
   T6 at the thing the audience belongs to.
2. **One resolver for SA-F8's four rules** (#2947), run when a record is committed: `everyone` is everyone;
   `creator` is the world's creator's own principal id; `owner` and `{linked, link: L}` are the thing's audience node
   for `souls:owns` or for `L`. An audience node is a child of the thing, of kind `souls:audience`, with the thing's
   own audience and fields `{1: 1 owner or 2 linked, 2: link type}`; it lives and dies with the thing. The commit
   creates it before the first record that needs it (`audience-not-declared` until then). Its members are the
   principals at the far end of that type's links at the thing. A rule names a link at the thing itself, never one
   on a parent (SA-F8's open point, settled here): a seat's player is a link on the seat. Any other audience id is one
   principal's own, with that one member for ever: a whisper's, or a creator's private state.
3. **A node has one audience (T6), so a field of another lives on a facet.** When a kind's field rule resolves to an
   audience other than its node's (a seat's `hand`), the field lives on a child of kind `souls:facet` with that
   audience, created with the node, and is written by that child's own entries ([effects.md](effects.md) rule 6). A
   `closed` container's fields (SA-F8) are a facet with the container's audience.
4. **How far a voice reaches is not who may read it** (E13). Speech is an event, `souls:said {1: reference, 2: reach
   in mm}`. Ordinary speech has the public audience and a short reach; a whisper has an audience of one, the
   listener.
5. **Account ids stay out of the log.** An actor is a Soul, a creator's principal id or the world (T6 rule 6).
   Re-checking links when an audience's members change (T2 rule 11) is the commit's (K3); it never rewrites a record.

## Words, kept apart

6. **All free text and every upload, however short, whoever wrote it, is kept apart under a reference.** The log
   holds `{21: id}` and nothing else in that record; field 21 alone is reserved for this in every record. A `text`
   field (SA-F6b, #2951) holds one. Words the kind's author wrote are part of the kind (its `text` section), not
   the log's.
7. **A reference is minted (T3), never a hash of the words.** A hash of a short text is guessed from a list, and it
   survives removal as a fingerprint.
8. **A view never holds words; delivery may.** A view (T7, [views.md](views.md)) carries references. Delivered to an
   audience entitled to the record, a reference gets its words beside it, `{21: id, 23: words}`, when the store has
   them and the redaction list does not name it. The archive never holds words.

## Removing words, and forks

9. **Removal deletes the words from the store and adds the reference to the redaction list.** No byte of the log and
   no hash changes. Every view built with the list marks the reference `{21: id, 22: 1}`, and delivery puts no words
   beside it. Copies outside the store (a reader's, a cache's) outlive the delete until purged; purging is W7's and
   V2's.
10. **A fork is a view of a checkpoint through one principal.** It keeps the ids and the nodes and links that
    principal sees; nothing under a node it drops; no body (a Soul is in one world, T3; K6 sets down what a body
    held); and removed words stay removed, since it shares the text store and the redaction list. One creator's fork
    never holds another's private state.

**Step 0.** T6's 13 fixtures hold 36 text items, every one a name: no free text sits in a record.

## What would quietly break this

- **Membership looked up when read.** A principal added later would see every old whisper and hand.
- **Audiences as a fixed list in stored bytes** (public, owner, creator). A hand of cards, a team or a whisper needs a
  rewrite of history.
- **An account id in an actor or an audience.** Removing a person would mean rewriting the log.
- **A reference that is a hash of its words.** Short words are guessed, and the hash outlives their removal.
- **Words inline anywhere in a record,** a name or a reason included. They can never be removed.
- **A view that holds words,** or a removal that rewrites a view. A redaction would then have to find every copy.
- **A private field on a public node.** T6 would write it in the node's public entry, for everyone.
- **A rule that follows a link on a parent.** Who sees a field would change when something else moves.
- **A fork through a world's whole state.** One creator's fork would hand over another's private notes.
- **A public cache of a private view, or a delete that forgets caches.** Removed words would still be served.
