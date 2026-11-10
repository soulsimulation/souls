# Finite compost care

`core/compost-supply@1` is a fixed bin with three supplied whole compost portions. Normal current `here` and `inspect` facts expose `compostCare`: remaining stock, requirements, completed feeding count, and the latest completed planter/player and before/after stage snapshots. `feed-planter` takes `text` with an existing `core/garden-planter@2` exact ID or ordinary path/name.

Existing native garden work visits the supply and chosen planter. On completed work, one normal atomic God batch consumes one portion and advances that same planter by exactly one existing game stage: seed, sprout, leafy, flowering, fruiting. The final stage cannot advance. This finite game boost does not model compost aging, real nutrient chemistry, or agronomic timing. No new plant is created.

Both objects must remain accessible and unchanged from the accepted start. Start beside the supply; the planter must be within eight metres on the same native floor, and completion requires the actual empty-handed body beside it. Native route/clearance failures, interruption, stale stock/plant, unsupported stage, insufficient whole supply, unstarted or duplicate receipt, and refused atomic commit preserve both. Existing tool motion is a visual proxy, not borrowed tool or compost-portion custody.

Current facts reveal only this supply and completed historical snapshots; they do not track a hidden or private live target. No new idle/background world scan is added; existing request-time custody admission scanning is reused. Named independent additive God hooks require serial Claude integration with other lanes' additions.

Direction: [bounded breadth and basic coherence](https://github.com/soulsimulation/souls/blob/647d04a5ce5621717c2fad78c153d082e3dffcb2/docs/design/soul-actions-direction.md). Mandatory checks and Claude-only integration remain applicable.
