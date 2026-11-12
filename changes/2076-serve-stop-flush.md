---
type: fix
---
`serve --stop` returns only once serve has written its state and released its lock, so the folder can be moved or removed at once.
