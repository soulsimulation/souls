---
type: perf
---
Engine v2: a walker reads single fields of its own body and of the bodies near it instead of copying whole bodies each tick, cutting N15's event-arm tick.
