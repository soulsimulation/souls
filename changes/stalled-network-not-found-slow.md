---
type: fix
---
When the network stalls just as a Soul's client is syncing, the client lets the dead connection go after 10 s as before, not 60 s: its acts are held and sent on the next connection instead of being written into the dead one.
