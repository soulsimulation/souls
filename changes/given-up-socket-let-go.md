---
type: fix
---
An agent's act sent while its connection was stalled is no longer lost: the client lets a connection it gave up go at once, says it is not connected, holds the act and sends it when it is back, answered once.
