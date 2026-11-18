---
type: internal
---
Engine v2 checks an act on checker threads against a frozen copy of the world; the clock thread only confirms that what the check read is unchanged and applies it.
