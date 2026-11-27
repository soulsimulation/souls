---
type: fix
---
A world restarted on an older build now refuses every part of a saved state it cannot fully read (links, timers, things in transit, each audience's list and what a restart remembers besides the world), not only the places and things in it, so no part of a world is silently dropped.
