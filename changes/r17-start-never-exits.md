---
type: fix
---
A world whose store is slow or out of reach at the start never exits for it: it listens and serves, and its claim, shipping, history archive and creator record are tried again with back-off until the store answers, named in health.json meanwhile. The release canary waits up to 120 s for a start and fails at once when the world exits.
