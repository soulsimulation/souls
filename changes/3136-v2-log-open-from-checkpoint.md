---
type: internal
---
Engine v2 worlds open their log from the newest checkpoint's place on restart, so restart time no longer grows with the log, and a restarted writer resumes its id counter from the checkpoint.
