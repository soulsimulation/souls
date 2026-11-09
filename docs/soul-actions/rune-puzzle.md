# Rune puzzle

`core/rune-puzzle@1` is a solo, gesture-operated two-by-three puzzle. Amber tiles are on. Choose a named tile to flip it and its orthogonal neighbors; diagonal tiles do not flip. Make every tile dark, then **Claim solved round**. The bottom stripe turns green and the completed-round count increases once. Reset restores the same challenge while retaining that count.

Nearby offers name the six tiles and legal actions. The normal served CLI `inspect <board-id> --all` and nearby here facts expose the current tile booleans, rules, solved flag and win count through a bounded definition-specific facts callback. The generic raw `object` route can retain stale values after mutations; see #1633. Use current inspect facts for this puzzle. One solution is northwest, northeast, south. Other sequences are possible.

This uses ordinary admitted declarative effects with native wave feedback. The state transition commits on admission: stopping the wave retains that transition. It does not simulate pressing a physical button, delay effects until contact, or introduce a solver or multiplayer turn system. Existing access and native admission apply. The board identity and both partial and solved state persist in model snapshots.
