# Finite coffee grinding and mug replenishment

`core-hand-coffee-grinder@1` contains six supplied integral bean portions and a three-portion grounds drawer.
The portable tool exposes `object:<id>:grind` with string `amount` (`1`, `2`, `3`, default `1`), and
`object:<id>:dose` with string `mug` (required exact entity ID). Read the catalog/find for IDs, then inspect the
same grinder for its current material and work record. Four seconds of completed native work transforms beans
into retained grounds; two seconds doses one portion into a nearby existing `core-coffee-mug@1`.

The mug must be washed, empty and without grounds (`bag=false`); the operation restores its existing grounds
state atomically with decrementing the drawer. It can then use its existing native brew/sip/drink/wash faculty.
No old mug revision changes and no replacement mug or free stock is created. Bean portions plus retained grounds
plus supplied doses always total six. Interruption, access changes and source/target/support changes invalidate
unfinished work. Unrelated God Undo/Redo leaves completed Soul work intact.

Both items require ordinary supported accessible ground-level tabletops (world height0.65–1.35m), within1.2m
on the same level, with empty hands. Put the grinder down before working it. Integral material is visible through
coarse bean blocks and retained grounds; no loose powder custody, scientific mass/food safety, exact crank grip
or new pouring/physics faculty is claimed. Completion uses the shared Soul-work adapter, not God Undoable edits.

Follows the canonical Soul Actions direction (PR1557), #1737/#1751 and #1880. Main's existing coffee state and
strict served-ID client are reused; no new word rules or client changes.
