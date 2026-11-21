---
type: fix
---
A lockstep world run reports back only once its ticks are on the disk and in the sync copy, so a sync asked right after sees the run (fixes the flaky E7b clock-mapping test).
