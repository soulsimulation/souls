---
type: fix
---
A slow object store no longer fails a pairing approval or restarts the directory. An approval writes only its own world's files and answers within a few seconds, using the world owner last read when the store stalls. A background copier rewrites those files from a fresh read once the store answers. A start whose store does not answer is logged as degraded and keeps serving, where it used to exit with `world-authority-unavailable`.
