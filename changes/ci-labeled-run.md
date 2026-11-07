---
type: internal
---
A `ci:run` or `merge:ready` label now starts a `pull_request` CI run, so a deferred `ci-ok` clears for the merge queue without a push; other labels do nothing.
