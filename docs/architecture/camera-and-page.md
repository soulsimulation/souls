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
| Follow: choosing the shot round one Soul (distance, keeping its sightline clear, holding the viewer's own zoom and orbit, framing a ride from outside) | `apps/web/src/WorldFollow.ts` (`FOLLOW_MIN`/`FOLLOW_MAX`, `SPRING`, `DWELL`, `RIDE`) |
| Follow: moving smoothly to that shot, at any frame rate | `apps/web/src/WorldFollowMotion.ts`, `apps/web/src/camera-spring.ts` |
| Manual camera: drag, wheel, pinch, keys, double-click to focus | `apps/web/src/WorldRtsCamera.ts`, `apps/web/src/touch/WorldTouchFree.ts`, `apps/web/src/WorldNavigation.ts` |
| Never below the ground; what may block a view (the roots a shot checks its sightline against) | `apps/web/src/WorldCameraGround.ts`, `apps/web/src/WorldCameraRenderRoots.ts` |
| Framing a place or a named location (Explore) | `apps/web/src/WorldPlaceCamera.ts`, `framePlace` and `frameLocation` in `LiveWorld.tsx` |
| The first framing on arrival | `apps/web/src/viewer-arrival.ts` |
| A picture an agent asks for (a Soul's `shoot`, a creator's `look`): the camera on a named Soul, place or thing of a v2 world, on a `?shot=1` page | `apps/web/src/v2-engine/capture.ts` (`v2.capture`, as `v2/client/src/shoot/shoot.mjs` reads it), installed in `LiveWorld.tsx` through its `shotCamera` pin |

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
   its activity (walk, idle, sit, lie or a gesture), its speed, seat height and hand prop. A held thing is the hand
   prop: the old renderer (`humans.ts`) carries it in one hand at the engine's carry point, standing and walking, a
   book closed; a move at a book in the body's own hand (its `read` form) is the `read` pose, the book open in both
   hands, until the run ends. A load two Souls carry is not a prop: it rides its carry (`take-parts.ts`), gripped.
   A chunk is built only once
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
   (line 1054), `WorldFollow` chooses the shot, and `WorldFollowMotion` carries the camera there. While the followed
   Soul rides (its activity is `ride`, or it stands in a ride carrier's basket), the aim tracks it without lag and
   `WorldFollow.riding` keeps the camera outside the vehicle: at least `RIDE.distance` out and between `RIDE.pitch`
   and `RIDE.top` above the rider, never in or under the vehicle, which is camera-transparent. Broadcast
   reads its subject's position from the same frame (line 990).

So the camera sees a v2 body exactly where the page draws it, at the same tick. It follows the page's take entity
(`soul.entityId`, which `bridge.ts` derives from the v2 node id), never a v2 node directly, and it needs nothing from
v2 beyond what the takes carry.

## How the old page draws a world from the new engine's stream (0.135 W2)

A moved world's ground, buildings and things are drawn by the entity layer (`WorldEntityLayer.ts`) from the snapshot its
old world published (`snapshot.json`, `v2/docs/cutover.md`). A world with no such snapshot (one made on the new engine),
or any v2 world opened with `?scene=stream`, is drawn from its stream alone: `v2-engine/source/stream-scene.ts` builds the
layer's snapshot from the stream's first copy of the world (the open ground's terrain tiles and ground palette, field 103, so a
Mars camp's floor is desert and not the default grass; waters; and each imported
thing at its world pose with its library def, or the world's own def, which the open ground keeps once (import-eden's field 102),
and its def's params, field 19), and the layer takes it through `scene-offer.ts`. A rowing punt (on a course, no library
def) is drawn by the takes as today's `rowing-punt` fixture (`takes.ts`). The page's layout then falls back to a plain
field (`LiveWorld.tsx`, a 404 from `/v1/scene` on a v2 page). What the stream does not carry is drawn plain: from a world
imported before W3 (no field 19), a def's params beyond a building's size and storeys take the def's defaults; a def
neither the library nor the stream has (a world imported before field 102) is drawn from the thing's solids as boxes, and
`window.__soulsStreamScene.plain` lists each such case.

A thing placed while the world runs (a creator's, or one a Soul makes) is drawn by `creator-kinds.ts`: by a creator's
own kind, else the def the world's own things of its kind have, else the library def named like its kind, else its
entry's own shape (`looks.shape`, in its state: the parts its `when`s pick and its looks table moves), else a box the
size its entry gives (`take-parts.ts`, from `source/kind-bounds.ts`, which the build fills from `content/kinds`; the
shapes come in one data file beside the bundle, `KIND_LOOKS_URL`, fetched once, and replace the boxes when it lands).

A thing's state (a fire lit or out, a lamp on or off, a door open, a basket's fruit) is its node's kind state fields,
by number. `world-state.ts` names them by the thing's entry (`kind-state.json`, a second data file the build writes
from `content/kinds`: each kind's fields, numbers and defaults; a field the node never set is its default) and gives
them to the thing's def by the def's own keys (`drawnState`: a key the def has; a burning or running bool by the def's
own name for it, so an entry's `lit` is an older def's `on`; a lamp's `level` as its `on`). Each change is one
`world-diff` the layer applies when the picture reaches the part that made it. A thing drawn from the stream holds
no state, and its looks read a missing key differently (a kit part's `when: on` hides, a light shines), so each thing
gets its state explicitly once. The layer's lights and glows go out for `on: false` or `lit: false`. The world starts
the way today's world was captured: import-eden seeds each thing's entry fields from the exported state (a lamp that
was on is on, a burning fire is lit), so the page does not darken an imported world.

A load Souls carry rides its carry's node, which moves by motion samples, not by new records. `take-parts.ts` places
the node where its samples have it at the time the page draws, and hands that to `creator-kinds.ts` and to
`world-state.ts`, so a load the world was captured with moves with its carriers too. A load lifted or set down keeps
its old record until the page's time reaches the end of the part that changed it, and a load carried off its feet (a
6 m frame laid flat) is drawn tilted (the layer's `r: [yaw, x, z]`). The page's rewind does not draw a carry yet:
history chunks carry bodies and things on a course only.

## What follows from the boundary

- A body that jumps on screen jumps for the camera too. Fixes belong in the adapter (`bridge.ts`, `takes.ts`) or in
  the engine, never in the camera.
- When the world's stream goes quiet, no new chunk is built, so the picture and the camera hold the last frame. The
  page shows "This world's stream is not available right now". The quiet-world bug, where a world's last line does
  not arrive (lane C), sits on this same path. A reader that is behind and playing the parts it missed says how far
  behind it is as it goes, and the page shows "Catching up with this world." instead (`stream-health.ts`).
- Following a Soul needs it to have a body in the depicted frame (`canFollowSoul`). A Soul whose body the public copy
  cannot place is not followable until it can be placed again.
