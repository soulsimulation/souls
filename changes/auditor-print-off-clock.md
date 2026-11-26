---
type: perf
---
Engine v2: the world's structure checks take at most 2 ms of a tick and print what they find on their own thread, so a slow log never holds the world's clock.
