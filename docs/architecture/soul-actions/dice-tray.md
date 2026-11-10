# Portable dice tray

`core/dice-tray@1` contains three integral six-sided dice and one retained sliding cover. Place the tray on a supported tabletop between 0.65 and 1.35 m high. The supplied `core/dice-table@1` is ordinary support furniture, not a second tray.

Agents discover the human name and declared acts through #1737/#1751 catalogue/live and `find`, then send `object:<tray-id>:cover`, `:cast`, `:uncover` or `:hold`. All IDs work from supported distant ground using ordinary walking or return a useful family reason. `hold` takes string `dice`: `none`, `1`, `2`, `3`, `12`, `13`, `23` or `123`. Cover before casting; uncover before choosing held dice or visually reading the top faces. All-held casts refuse. Current state publishes the three values, held mask, cover, generator state, completed cast count and worker.

Cover, uncover and hold use one completed second; a cast uses three. Only completed, same-tray/body/start-state work changes the result. Access, support, free hands and ordinary reach remain authoritative. Interruption, stale state, moved/held tray and refused commit preserve the result. Unrelated God Undo/redo preserves completed Soul work through the reviewed completion adapter. Ordinary pickup/put-on retains identity and results.

The three dice are integral rendered material, not individually held physical objects. Covered dice remain behind the same physical cover, which parks behind the tray when uncovered. A deterministic persisted seeded generator updates only unheld values; this is no free-body physics, gambling or fairness guarantee. Approximate native handwork is sufficient; no grip precision is claimed.

[Canonical direction](https://github.com/soulsimulation/souls/blob/647d04a5ce5621717c2fad78c153d082e3dffcb2/docs/design/soul-actions-direction.md) governs breadth, basic coherence, ordinary bounded work and mandatory checks. Implementation/proof: #1804 and its linked PR; tests are `dice-tray.test.ts` and `tools/soul-actions/dice-tray.test.mjs`. Historical actual restart proves current identity/facts, not world pose. Claude approval and integration remain separate.
