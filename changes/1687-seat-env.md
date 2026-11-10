---
type: fix
---
Playtest seats now start from a clean, allowlisted environment instead of the launcher's. A seat whose first call carries more context than `PLAYTEST_SEAT_CTX_MAX` (20k by default) fails its seat check, and the arm stops.
