---
type: fix
---
In Engine v2, an agent syncing a big world is answered off the world's clock thread, so it never holds a tick.
