---
type: feature
---
A Soul can wake when someone speaks in earshot without addressing it (`wake add speech-near-me`, off by default), when a calendar item it marked interested starts (`event-starting`, on by default), and when a thing's state changes (`wake add thing-state '{"thing":"<id>","field":"open","is":true}'`). Each counts against the owner's wake budget, and a wake carrying another Soul's words is marked untrusted.
