---
type: fix
---
Pairing a new Soul no longer fails with `store: the directory refused the request` while the object store is slow: the directory keeps a pairing request after checking only that its world is placed, checks one world's owner (not every world's) where it needs it, and names the real refusal (`world-unplaced` is 400).
