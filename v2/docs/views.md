# Views

Engine v2 T7 (#2661), contract T7 in [TRUNK.md](TRUNK.md). It fixes that the full log is the archive, and that every
other thing a viewer, a history player or a replica receives is a view of it that can be made again. Code:
`v2/crates/replica/src/views.rs`. Fixtures: `v2/crates/replica/fixtures/views/` (`1-day.diag`, applied after T6's
base, and `goldens.txt`, each view's bytes by hash). Checks: `crates/replica/tests/views.rs`. The tier that computes
views (R3), live subscriptions (R4), files and the CDN (V1, V2) and packing (V3) are not here.

## The archive and its views

1. **The log is what is kept for ever.** Every entry T6 writes ([effects.md](effects.md)) is kept as stored. Nothing
   a viewer receives is kept in its place: a projection bug, or a change in who may see what, is fixed by building
   the view again.
2. **A view is a function of three inputs and names all three:** the log up to a position, the redaction list (T8,
   `audience.md` once it exists; until then an opaque, growing set of references) and the view's own version. Its
   output is `{1: node, 2: level, 3: audience, 4: header hash, 5: last sequence, 6: redaction list hash, 7: version,
   8: [record, ...]}`, with 5 left out before the first entry. Field 4 is the header of the bundle that holds the last
   sequence (the reference here builds within one bundle; K4's logs of several bundles move it on). The version is `souls/view/1` over the level's number, name and revision, and for `sampled` its sample
   spacing; the list's hash is `souls/redactions/1` over its references in id order. A view reads no clock, no
   setting, no kind's definition and no memory but what it built from earlier entries. The tree it needs (what is
   under a node) is derived from the log.
3. **Levels are a closed, ordered list, numbered for good:** 1 `full` (every entry the key may see, as stored);
   2 `sampled` (as full, a moving node's samples thinned to one a world second; one that starts, stops or hands off
   motion is always kept); 3 `outline`, which is also the world-wide index level (E1 adds a place's name, by
   reference, and its outline): `{1: sequence, 2: 1 created, 3: node, 4: kind, 5: parent}`, `{.., 2: 2 removed,
   3: node}`, `{.., 2: 3 left, 3: node}`, `{.., 2: 4 arrived, 3: node, 5: parent}` and `{.., 2: 5 back, 3: node}`,
   where an arrive from another zone also writes each node it carries as created, and only nodes in the key's subtree
   are written (before the entry for a removal or a leave, after it otherwise); 4 `counts` (at most one record of at
   most 31 bytes per world second: the second, the nodes alive in the view, the entries seen). A level added later
   takes the next unused number and its place in the order; none is renumbered, and order is never read from the
   numbers.
4. **A view is computed once per key: (node, level, audience),** by the tier that reads the log, never by the clock
   thread. It holds each entry whose audience is the key's and that touches the key's subtree: its node was the key's
   node or under it just before the entry, or a node it creates or brings in (a create, an arrive's subtree) is under
   it just after. When an arrival lands under the key and the view did not hold its leave, `full` and `sampled` first
   write the subtree as it was in flight, `{0: {1: sequence, 2: [[id, node], ...], 3: [[id, link], ...]}}` (field 0,
   which no entry has) in T6's state layout, so a view can draw what came in from elsewhere. It holds only the nodes of
   the key's audience, and links of that audience whose ends it may see (T2 rule 9); a view of another audience than
   the arrival's gets its own nodes this way too (a private note in a public box), and no record when there are none. One walk of the log feeds every key; any number of subscriptions with one key share one view. Every
   entry moves the view's position, seen or not. For one redaction list and version a stream only appends: a record
   once sent is never rewritten, except that a counts view's open second is its last record until a later second
   closes it.
5. **A private view is the public one plus a difference.** A key's audience is everyone or one audience id. A viewer
   is sent the public view and the view of each audience it is in (T8 says which), merged by sequence. Private views
   hold only their audience's entries, so most are small. Only the public audience's views may go to shared caches; a
   private view never takes that path.
6. **A subscription is a scope, a level and a byte budget a world second.** A scope is some nodes, the whole world
   (its root) or one named Soul (its body, by `souls:body-of`); a node under another node of the scope is left out,
   since that node's view holds it. A client may hold several.
7. **Under strain, detail gives way, never time, entry or acts.** A subscription is sent one view per node of its
   scope and audience; its least budget is 31 bytes a second for each. The server gives it the highest level, from
   the one asked for down, whose busiest world second over those views fits its budget, and says so: `{1: level}`, or
   `{1: level, 2: level asked, 3: "souls:over-budget"}` when it was lowered. Counts fits every budget from the least
   up; a smaller one is refused when asked for (`budget-below-minimum`). An accepted subscription is never dropped:
   `counts-over-bound` would name a counts view that broke its bound, a fault in the view.
8. **Words reach a view by reference.** The log holds a reference, never words (T8). Delivery to an audience entitled
   to them may put the words beside the reference, from the text store (K16), for references not on the redaction
   list. That changes no record of the view and is not one of its inputs.
9. **Summaries are integers.** A count, a second, a size: no float decides what a view holds.

**Step 0.** Each view reads the entries in order and T6's tree state before and after each, which the log alone
builds; the redaction list; and its level's version. Nothing else. Words put in beside references (rule 8) come at
delivery, after the view. How busy a view is (rule 7) is read by the grant, not by the view.

## What would quietly break this

- **Keeping only the viewer's history.** A projection bug or a change of audience could never be fixed.
- **A view that reads a clock, a settings file, a kind or live memory.** It could not be made again, and two tiers
  would disagree on the same log.
- **An output that does not name its inputs.** A cached view built before a redaction would look current.
- **A level renumbered,** or one inserted under an old number. Stored subscriptions would mean another level.
- **Scoping an entry by its node alone.** One entry may create a whole room's contents under its parent (T6 rule 6):
  the room's view would never show what is in it.
- **An arrival that names only its transfer.** The index would lose the parent of everything that ever moved.
- **A least budget per subscription, not per view.** A scope of many nodes would be accepted and then dropped.
- **One view per Soul.** Views would multiply with Souls; a private view is the public one plus a difference.
- **A private view in a shared cache.** Anyone with the URL reads another audience's records.
- **Dropping a subscription, or slowing the world, under load.** Detail gives way; nothing else does.
- **Thinning away the sample that stops a body.** The viewer would move it on for ever.
- **A subtree carried into a view whole.** A public box carrying a private note would show the note to everyone.
- **A crossing without its old place.** A node cannot show that something left it unless the leave or reparent
  names where it was (T6 rule 3).
- **Words copied into a view's records.** A redaction would then have to rewrite every built view.
