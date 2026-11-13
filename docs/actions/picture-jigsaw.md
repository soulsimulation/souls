# Persistent picture jigsaw

Place `core/picture-jigsaw@1` as a fixed worktable. Four unique integral tiles start visibly in the right-hand tray; the left grid has cells `tl`, `tr`, `bl`, and `br`. This is a four-piece stylized tree reconstruction with quarter turns, rather than freeform drawing or loose-token physics.

Normal nearby `here` and current `inspect` facts expose `pictureJigsaw`: every piece's current location and rotation, picture clues and target, empty cells, progress, last player, and lifetime solves. Choose `place-1` through `place-4` with `text` such as `tl 90`; lift a placed tile before moving it. An occupied cell refuses. A lifted tile returns to its own tray position with its current orientation. All four target sections at rotation zero earn one solve per round; reset restores the initial tray and retains lifetime solves.

Each move, lift, or reset requires two completed seconds of existing native tabletop craft, an accessible unchanged table, nearby same-floor native body and empty hands. Cancellation, stale target/state, unstarted or duplicate receipts do not change the pattern. The brush is an existing work-motion proxy, not a borrowed physical tool. The table is fixed and its four tiles are integral components; no carryable puzzle or independent tile custody is claimed. State and lifetime results persist on the same table through restart.

This action adds named independent God hooks and an exact-definition state mesh through the existing tag mesh mechanism. Integration should preserve other lanes' named additions rather than replacing shared hook blocks. No generic reader, engine, movement, ownership, or contact contract changes are required.

Direction: [bounded breadth and basic coherence](https://github.com/soulsimulation/souls/blob/647d04a5ce5621717c2fad78c153d082e3dffcb2/docs/design/soul-actions-direction.md). Existing mandatory proof and Claude-only integration remain applicable.
