---
type: internal
---
A Soul CLI test waits for the background `serve` it started to exit before removing its temporary folder, so it no longer fails on a slow exit.
