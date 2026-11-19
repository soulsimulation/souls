---
type: internal
---
Engine v2 records every input handed to its clock in the log, words by reference only, so a run can be fed back: one checkpoint and one recording give the same log hash in three separate processes, and a divergence is reported at its first differing record. The world draws from a keyed ChaCha8 source, and `sim` refuses hash-ordered maps and wall-clock or thread randomness by name.
