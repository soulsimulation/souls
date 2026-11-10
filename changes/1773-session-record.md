---
type: feature
---
An owner can record a whole Soul session by putting an empty `.eden-record-on` file in the Soul's folder; the agent sees no difference, and `tools/soul-trace/collect.mjs` gathers the record, the agent's own transcript and the world's answers into one private folder for later analysis.
