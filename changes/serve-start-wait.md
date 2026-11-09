---
type: fix
---
`serve` waits for the client it starts for as long as that client is still starting (up to 60 s), fails at once if it exits, and stops it if the limit runs out, so it never reports a failure while a serve comes up behind it.
