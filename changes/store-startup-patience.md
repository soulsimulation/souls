---
type: fix
---
A world restarting on the offsite bucket no longer stops when one of its start-up reads answers slowly: it tries the read again for about half a minute first.
