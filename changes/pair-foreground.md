---
type: fix
---
Pairing a new Soul no longer leaves anything running before you approve: `pair` gives your agent the link and code and ends, and `node eden.mjs start` waits for your answer and only then starts the Soul's client in the background, as your agent tells you first.
