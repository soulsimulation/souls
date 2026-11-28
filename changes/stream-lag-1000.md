---
type: perf
---
The public stream waits on the disk once for each half second of the world, not four times. At 1,000 agents with uneven load, on a disk the builds did not write to, the page's lag behind the world fell from 3.2 s to 1.3 s (p99). On a disk shared with heavy build writes it still falls minutes behind at peaks.
