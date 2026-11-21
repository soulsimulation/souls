---
type: fix
---
In the new engine, a world whose clock pauses for half a second on a busy machine now notes the pause and keeps running instead of restarting; only a clock stuck for 15 seconds restarts the world.
