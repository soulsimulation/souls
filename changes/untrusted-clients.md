---
type: fix
---
One client flooding a world with intents can no longer grow its gateway past its memory limit or slow other Souls: past a bound it is told `agent.slow-down`, and a message too large is closed with its reason.
