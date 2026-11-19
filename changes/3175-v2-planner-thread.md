---
type: internal
---
Engine v2: route searches and reach checks run on a planner thread off the clock, which only commits; a walk gets its place and legs a tick after it asks.
