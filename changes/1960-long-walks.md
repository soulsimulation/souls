---
type: fix
---
Engine v2: a long walk across a world no longer ends `act.timed-out` after 180 s while the Soul is still walking. Its deadline follows the planned route, as in today's game, and a walk that stalls still ends `walk.blocked`.
