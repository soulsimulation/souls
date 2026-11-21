---
type: perf
---
On Engine v2, a creator's land edits and `expand` upload only the terrain tiles they change (a new `rows` edit operation), so the upload for a knoll is kilobytes instead of the whole ground and a world grows past 1.2 km. The world still writes the whole ground to its log and to viewers on each land edit. An edit whose fields would outgrow a log record is refused by name (`edit.too-large`, and `part.too-large` for a tick's writes together) before it reaches the world, so it can no longer stop a world from answering.
