# Portable reflection cards

`core-reflection-cards@1` is one portable tray with eight unique integral cards and three spread positions. The public named deck order and face states persist. It supports quiet arrangement and reading, without chance, divination, hidden information or a shared card-game contract.

Find the tray normally and send literal `object:<id>:cut-deck` with a text offset from 1 through current deck count minus 1, `deal-card` with an empty position 1–3, `turn-card` with an occupied position 1–3, or `gather-cards`. Dealing moves the top unique card without replacement. Turning changes that same card's visible face. Gathering appends spread cards to deck bottom in position order. Names and short prompts appear in full current reflectionCards facts; face-down is visual, not secret.

Eight deck-rank enums, three spread enums and three face booleans are declared kind state, alongside completed operation counts and historical participant/receipt. A layout guard requires the eight identities exactly once and a contiguous deck. The exact-definition renderer projects each card once from bounded arrangement state; history is excluded from its geometry key. Stacked unused cards remain on the tray. Distinct colors and simple pips identify face-up cards; literal-text rendering is not required.

Operations require empty hands and the same tray on a permitted fixed table. Existing native walk and handwork complete beside it on its floor; definition, full state, owner/access, transform/support/parent, body/world and exact receipt guards reject stale work. Interruption grants no completed edit. `commitSoulWork` preserves God Undo/redo. Same-tray native pickup/carry/placement and restart preserve order/spread/history; integral cards have no independent loose custody or physics.

Issue #1854. Required proof includes cold exact IDs, discovery/live state, conservation/cancellation/Undo, registered geometry, whole real-speed app media, current-facts restart, context cost and the normal two-repeat-per-arm workflow. Named additive hooks and renderer/family registration require serial Claude T3 integration; CI, merge and release remain external.
