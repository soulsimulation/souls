---
type: fix
---
A slow object store no longer fails a pairing approval or restarts the directory: an approval writes only its own world's files and answers within a few seconds from the world owner last read, a background copier rewrites them once the store answers, a start whose store does not answer keeps serving (it used to exit with `world-authority-unavailable`), a revoke or retire reaches the gateway at once or is refused, and a slow read never undoes a world handoff.
