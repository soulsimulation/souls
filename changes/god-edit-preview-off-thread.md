---
type: internal
---
A god edit can be previewed in a worker, off the world's tick thread: the world only takes the stepped checkpoint it already uses, so an Eden-size preview no longer stalls the clock for about a second.
