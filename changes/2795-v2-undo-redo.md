---
type: internal
---
Engine v2 undoes, redoes and rewinds a world creator's edits by appending batches of inverse effects that bring back the same things with their ids, refusing an undo that would touch something changed since.
