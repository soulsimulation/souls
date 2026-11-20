---
type: internal
---
Retain opt-in native join-delivery stage, final-frame and relay evidence when the held-sync regression fails. Correct its relay's extended-length tag handling so a 127-byte payload is forwarded without being mistaken for a 64-bit length header.
