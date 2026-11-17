# Views

Engine v2 T7 (#2661), contract T7 in [TRUNK.md](TRUNK.md). It fixes that the full log is the archive, and that every
other thing a viewer, a history player or a replica receives is a view of it that can be made again. Code:
`v2/crates/replica/src/views.rs`. Fixture: `v2/crates/replica/fixtures/views/1-day.diag`, applied after T6's base.
Checks: `crates/replica/tests/views.rs`. The tier that computes views (R3), live subscriptions (R4), files and the CDN
(V1, V2) and packing (V3) are not here.

## The archive and its views

1. **The log is what is kept for ever.** Every entry T6 writes ([effects.md](effects.md)) is kept as stored. Nothing
   a viewer receives is kept in its place: a projection bug, or a change in who may see what, is fixed by building
   the view again.
2. **A view is a function of three inputs and names all three:** the log up to a position, the redaction list (T8,
   `audience.md` once it exists; until then an opaque, growing set of references) and the view's own
   version. Its output is `{1: node, 2: level, 3: audience, 4: header hash, 5: last sequence, 6: redaction list hash,
   7: version, 8: [record, ...]}`. The version is `souls/view/1` over the level's number, name and revision; the
   list's hash is `souls/redactions/1` over its references in id order. A view reads no clock, no setting, no kind's
   definition and no memory but what it built from earlier entries. The tree it needs (what is under a node) is
   derived from the log.
3. **Levels are a closed, ordered list, numbered for good:** 1 `full` (every entry the key may see, as stored);
   2 `sampled` (as full, a moving node's samples thinned to one a world second; one that starts, stops or hands off
   motion is always kept); 3 `outline` (what was created, with its id, kind and parent, removed, left or arrived,
   which is also the world-wide index level E1 fills with a place's name and outline); 4 `counts` (at most one record
   of at most 31 bytes per world second: the second, the nodes alive in the view, the entries seen). A level added
   later takes the next unused number and its place in the order; none is renumbered.
4. **A view is computed once per key: (node, level, audience).** It holds the entries whose audience is the key's and
   whose node was the key's node or under it just before the entry. One walk of the log feeds every key; any number
   of subscriptions with one key share one view. Every entry moves the view's position, seen or not. A stream only
   appends: a record once sent is never rewritten (a counts view's open second is its last record until a later
   second closes it).
5. **A private view is the public one plus a difference.** A key's audience is everyone or one audience id. A viewer
   in an audience is sent the public view and that audience's view, merged by sequence, so views grow with audiences,
   not with Souls. Only the public audience's views may go to shared caches; a private view never takes that path.
6. **A subscription is a scope, a level and a byte budget a world second.** A scope is some nodes, the whole world
   (its root) or one named Soul (its body, by `souls:body-of`). A client may hold several.
7. **Under strain, detail gives way, never time, entry or acts.** The server gives a subscription the highest level,
   from the one asked for down, whose busiest world second fits its budget, and says so: `{1: level, 2: level asked,
   3: "souls:over-budget"}`. Counts fits every budget of at least 31 bytes a second; a smaller one is refused when
   asked for (`budget-below-minimum`). An accepted subscription is never dropped.
8. **Words reach a view by reference.** The log holds a reference, never words (T8). Delivery to an audience entitled
   to them may put the words beside the reference, from the text store (K16), for references not on the redaction
   list. That changes no record of the view and is not one of its inputs.
9. **Summaries are integers.** A count, a second, a size: no float decides what a view holds.

**Step 0.** Each view reads the entries in order and T6's tree state before and after each, which the log alone
builds; the redaction list; and its level's version. Nothing else. Words put in beside references (rule 8) come at
delivery, after the view.

## What would quietly break this

- **Keeping only the viewer's history.** A projection bug or a change of audience could never be fixed.
- **A view that reads a clock, a settings file, a kind or live memory.** It could not be made again, and two tiers
  would disagree on the same log.
- **An output that does not name its inputs.** A cached view built before a redaction would look current.
- **A level renumbered,** or one inserted under an old number. Stored subscriptions would mean another level.
- **One view per Soul.** Views would multiply with Souls; a private view is the public one plus a difference.
- **A private view in a shared cache.** Anyone with the URL reads another audience's records.
- **Dropping a subscription, or slowing the world, under load.** Detail gives way; nothing else does.
- **Thinning away the sample that stops a body.** The viewer would move it on for ever.
- **A crossing without its old place.** A node cannot show that something left it unless the leave or reparent
  names where it was (T6 rule 3).
- **Words copied into a view's records.** A redaction would then have to rewrite every built view.
