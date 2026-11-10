# Portable rhythm box

`core-rhythm-box@1` stores three independently editable eight-step kick, snare and hat lanes. Multiple voices can strike together. A Soul programs the same portable box, selects 60, 90 or 120 BPM and starts or stops cyclic playback. This extends monophonic phrase playback with independent simultaneous percussion lanes and an explicit repeating transport.

Find the box through ordinary catalog/live data and use its literal `object:<id>:program-rhythm`, `set-tempo`, `start-loop` and `stop-loop` offers. Program text accepts one or more assignments such as `kick=10001000;snare=00100010;hat=10101010`; unspecified lanes persist. Tempo text is `60`, `90` or `120`. Missing or invalid text gives the box's own useful refusal.

State includes each numeric lane mask, its atomically updated visible pad bits, tempo, on/off, completed edit/start/stop counts and historical participant/receipt. Full inspection presents readable lane order. Edits and tempo require stopped playback; all operations require empty hands and the same box resting on a permitted fixed table. Native work must complete beside that box on its floor. Definition, owner/access, state, support, parent, body and receipt guards prevent stale or interrupted completion. Soul commits use `commitSoulWork`, preserving God Undo/redo.

Playback uses the existing depicted world beat and existing percussion synthesis. Start joins the current phase; it does not establish a new clock. Stop/removal/mute cancels scheduled future hits while begun short tails decay naturally. The selected pad grid remains visible. Carry/place while stopped retains the same box and pattern. No wearing, receiver, acoustic realism, live performance precision or subjective listening certification is claimed.

Issue: #1847. Required proof includes cold exact-ID native work/refusals, catalog/live state, cancellation, Undo/redo, same-box handling/restart, registered geometry and whole real-speed app media. Claude retains T3 integration authority.
