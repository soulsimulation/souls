---
type: internal
---
Engine v2: timers wait in one list ordered by world time, so a tick with nothing due costs a few nanoseconds and a world with nothing moving jumps to the next due time, writing exactly what it would have written tick by tick.
