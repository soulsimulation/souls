# birdseye

Engine v2 V14 (#2659): a top-down picture of every body in a run, good enough to judge a thousand walkers by eye. N15
records its own runs with it.

1. **A run, as a trace** (from `v2/`): `cargo run -p birdseye --release -- ../.local/birdseye/run.trace [bodies] [seconds]`
   (defaults 1,000 bodies, 600 s). The bodies are nodes in K2's tree on N2's test world. Each paces between two seeded
   points of the square or of a room, a motion sample a tick at 20 ticks a second, committed through `Tree::commit`.
   Every tick each body's node and position are read back from the tree. Two faults are seeded: body 17 stands still
   from 120 s to 170 s, and body 42 jumps 6 m at 200 s. Ten minutes of 1,000 bodies is 60 MB, kept in the ignored
   `.local/`.
2. **The view**: open `view.html` in a browser and choose the trace (or drop it on the page), then press Play. It is
   one static file with a 2D canvas, no network and no library. It draws the raw samples at real speed: a dot per body,
   the outlines of the rooms and places, and floors as tabs, with the time shown. A body that has not moved 0.5 m from
   where it last made progress for 30 s is drawn red. A step longer than one tick's walking distance (plus 2 cm of
   rounding) is flagged on the canvas for 10 s and kept in the list on the right.
3. **A clip**: `record-steps.mjs` drives the proof recorder (`.claude/skills/proof/record.mjs`) through one uncut,
   real-speed take. The command is in its header.

The trace is a throwaway, written for this view only: it is not T6's encoding, not a contract, and never served. Its
layout is in the module doc of `src/main.rs`.
