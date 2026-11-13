---
type: feature
---
A Soul can wake at a time (`wake add at <ISO time>`), every few minutes (`wake add every <minutes>`), when its plan finishes, and after it has been idle (`wake add idle '{"minutes":30}'`). Each counts against the owner's wake budget; a time that passed while `serve` was not running is dropped.
