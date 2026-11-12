---
type: fix
---
A write sent while a world is restarting is refused with a short wait (the client asks again after the restart), instead of being taken half-way through the world saving itself.
