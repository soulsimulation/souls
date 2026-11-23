# The camera and the page

What the old page's camera owns, what the page around it owns, and how the camera follows a body that the new
engine (`v2/`) moves. This records how things are; it builds nothing. Release 0.133, task R7. Paths are from the
repository root, and line numbers are anchors at the commit that added this file.

## The rule

The engine owns where every body and thing is. The camera only observes: it reads positions from the frame the page
draws and moves nothing in the world. The viewer handle says so in its contract: "Commands never steer or pause the
world" (`apps/web/src/WorldViewer.ts`, `WorldViewerHandle`). The same rule is in `AGENTS.md` under the engine
invariants: renderers, pose adapters and cameras observe state and never own a second movement path.

## What the camera owns

The camera is the viewer's eye: its position, its aim and how it gets from one shot to the next. Nothing it does goes
back to the engine.

| Concern | Where |
|---|---|
| The three modes: `broadcast`, `manual` (orbit, or free with WASD), `follow` | `apps/web/src/WorldBroadcast.ts` (`WorldCameraMode`), switched in `apps/web/src/LiveWorld.tsx` |
| Broadcast: the automatic director that picks a subject and a shot | `apps/web/src/WorldBroadcast.ts`; design in `docs/design/auto-camera.md` |
| Follow: choosing the shot round one Soul (distance, keeping its sightline clear, holding the viewer's own zoom and orbit) | `apps/web/src/WorldFollow.ts` (`FOLLOW_MIN`/`FOLLOW_MAX`, `SPRING`, `DWELL`) |
| Follow: moving smoothly to that shot, at any frame rate | `apps/web/src/WorldFollowMotion.ts`, `apps/web/src/camera-spring.ts` |
| Manual camera: drag, wheel, pinch, keys, double-click to focus | `apps/web/src/WorldRtsCamera.ts`, `apps/web/src/touch/WorldTouchFree.ts`, `apps/web/src/WorldNavigation.ts` |
| Never below the ground; what may block a view (the roots a shot checks its sightline against) | `apps/web/src/WorldCameraGround.ts`, `apps/web/src/WorldCameraRenderRoots.ts` |
| Framing a place or a named location (Explore) | `apps/web/src/WorldPlaceCamera.ts`, `framePlace` and `frameLocation` in `LiveWorld.tsx` |
| The first framing on arrival | `apps/web/src/viewer-arrival.ts` |

## What the page owns

The page is everything round the picture. It decides *what* to look at; the camera decides *how*.

| Concern | Where |
|---|---|
| Which world's data feeds the picture: the old socket, or a v2 world's public stream | `apps/web/src/useSouls.ts` (the switch, line 46), `apps/web/src/v2-engine/use-v2-souls.ts` |
| The list of Souls, and each Soul's id, name and take entity id | the `Souls` object `useSouls` returns (`conn.replica.souls`, filled for v2 at `use-v2-souls.ts` line 81) |
| Selecting a Soul, and asking the camera to follow it | the card's Follow button (`apps/web/src/SoulCard.tsx`, `camera.follow`), Explore's search, `follow-soul-request.ts` (the Shell asks the viewer to follow a newly approved Soul) |
| The commands the page may give the camera | `WorldViewerHandle` in `apps/web/src/WorldViewer.ts`: `setCameraMode`, `flyToSoul`, `selectSoul`, `canFollowSoul`, `framePlace`, `frameLocation` and the rest. These are presentation only. |
| The camera's controls and help on screen | `apps/web/src/ViewerFrame.tsx` |
| Labels, speech, cards over bodies | `LiveWorld.tsx` (labels and the speech layer, which read the same frame as the camera) |

## How the old page's camera reads the new engine's bodies

The camera never talks to the new engine. It reads the same frame of take entities that the renderer draws, and the
v2 adapter turns the engine's public stream into that frame's input.

1. **The stream.** A served v2 world writes its public stream as files under `views/`. The page's inline config
   names that folder (`__simConfig.v2Stream`), which switches `useSouls` to `useV2Souls`.
2. **The reader.** `apps/web/src/v2-engine/bridge.ts` starts the v2 page's own reader in a worker
   (`v2/web/src/source/worker.ts`, on the replica WASM). For each part it played, the reader posts the changed nodes,
   every motion sample, what was said, and the move records (`source.ts`, `PartRec`).
3. **Bodies in the world frame.** The bridge places each body's samples in the world frame, composing parents and
   slots (`Bridge.sample`). It records a seat or bed posture (`take-bodies.ts`), held things, speech
   (`take-speech.ts`) and gestures (`take-gestures.ts`). A body in a frame the public copy cannot place is hidden,
   never moved.
4. **Takes.** `apps/web/src/v2-engine/takes.ts` (`chunkOf`) turns those samples into one-second `mars-take/4`
   chunks, the format the old server streams. Each tick carries the body's position, its heading (from its motion),
   its activity (walk, idle, sit, lie or a gesture), its speed, seat height and hand prop. A chunk is built only once
   the world is past its end, so a body is never pushed past its newest sample.
   A thing on a course (a balloon, a punt) is in the chunks too (0.135 K4): a `vehicle` record with a `carrier`,
   under the page's id for that thing, where the replica's `courseAt` has it at each tick. The page's own layers draw
   it (the entity layer moves a god's balloon to it); the take only lets the camera follow it and frame a ride with it.
   A body in its slot rides with it, standing, activity `ride` (hands on the rim), which Broadcast scores as riding.
5. **The frame.** `LiveWorld.tsx` reads the chunks (`liveChunks`, line 763) and samples them at the depicted
   tick (`sampleTake` in `mars/viewer/engine/take/replay.ts`). It keeps the result as
   `shown.current.entities` (line 951): a position `p` and heading `yaw` for each take entity.
6. **The camera.** For each Soul, `LiveWorld.tsx` looks up its entity in that frame (`at.entities[soul.entityId]?.p`,
   line 995). For the Soul being followed, that position is the focus (line 1019). Follow aims one metre above it
   (line 1054), `WorldFollow` chooses the shot, and `WorldFollowMotion` carries the camera there. Broadcast
   reads its subject's position from the same frame (line 990).

So the camera sees a v2 body exactly where the page draws it, at the same tick. It follows the page's take entity
(`soul.entityId`, which `bridge.ts` derives from the v2 node id), never a v2 node directly, and it needs nothing from
v2 beyond what the takes carry.

## What follows from the boundary

- A body that jumps on screen jumps for the camera too. Fixes belong in the adapter (`bridge.ts`, `takes.ts`) or in
  the engine, never in the camera.
- When the world's stream goes quiet, no new chunk is built, so the picture and the camera hold the last frame. The
  page shows "This world's stream is not available right now". The quiet-world bug, where a world's last line does
  not arrive (lane C), sits on this same path.
- Following a Soul needs it to have a body in the depicted frame (`canFollowSoul`). A Soul whose body the public copy
  cannot place is not followable until it can be placed again.
