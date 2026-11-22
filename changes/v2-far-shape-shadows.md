---
type: perf
---
In the v2 page, far small one-off shapes stop casting shadows past today's distance, as shared ones already did, by leaving them out of their batch's shadow draws instead of moving them to a second batch.
