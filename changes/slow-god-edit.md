---
type: fix
---
A creator's edit that removes the last floor of a deck or platform on the open ground is checked in a fraction of a second in a large world, not 7 to 10 seconds, and edits sent while 8 are still being checked are refused at once (`edit.checker-busy`) and can be sent again.
