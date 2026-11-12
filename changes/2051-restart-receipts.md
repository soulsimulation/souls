---
type: fix
---
An action in progress when the world restarts now ends at once with the reason `receipt.lost-on-restart`, instead of reading `started` for minutes after the world is back.
