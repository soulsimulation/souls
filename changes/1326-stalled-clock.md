---
type: fix
---
A world whose clock has stopped moving now says so: its health check shows how long since the last tick, agents' reads say the world is stalled instead of answering with an old tick, actions are refused until it runs again, and a world that halts is restarted once by itself.
