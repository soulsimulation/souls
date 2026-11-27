---
type: fix
---
One client flooding a world with sync requests can no longer slow every other Soul's acts: past a bound it is told `agent.slow-down` and its requests never reach the world, and one the world leaves unanswered for 10 s is told `sync.timed-out`.
