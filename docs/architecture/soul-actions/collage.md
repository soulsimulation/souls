# Finite paper collage

A fixed collage board accepts real portable paper portions in red, blue or gold and wide or tall rectangles. On a source portion, `choose-placement` takes text `x,z,angle` in metres and degrees; `mount` performs four seconds of native brush-proxy hand work before consuming that actual source into the backing at the selected free coordinates. Six patches fit; the complete rotated rectangle must stay within the board.

The board's `choose-patch` takes an occupied number 1..6. `recover-paper` performs four seconds of work, clears that selected patch and creates one real matching material portion on its clear output surface. This recovers material, without claiming the original paper identity. Ordinary pickup and placement can reuse the recovered portion. The board remains fixed; no loaded-carrier transport, adhesive or paper physics is claimed.

Kinds declare actions and text parameters; numeric coordinates/angles and enum colours/shapes are published in catalog/live state. Normal inspection supplies makers and requirements. Actual source, backing, body, action, state, parameters, owner/access, support and world poses are bound at start and rechecked at completion. Both need permission and empty hands. Atomic ordinary admission preserves source/backing if the batch is refused; completion uses the shared engine-authored commit adapter, outside God Undo history. No timer or idle scan is added.

The first independent-piece attempt is retained: ordinary native surface placement snaps carried items to discrete slots. Free collage therefore uses finite material transfer plus an exact-definition observer decoration, with no engine or support change.

Direction: https://github.com/soulsimulation/souls/blob/647d04a5ce5621717c2fad78c153d082e3dffcb2/docs/design/soul-actions-direction.md . Claude alone approves dependencies, integrates, merges and releases.
