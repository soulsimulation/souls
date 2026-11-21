---
type: perf
---
On Engine v2, a creator's land edits and `expand` send only the terrain tiles they change (a new `rows` edit operation), so a knoll is kilobytes instead of the whole ground and a world grows past 1.2 km.
