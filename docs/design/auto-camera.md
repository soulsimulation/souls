# Auto-camera: best-angle tracking, easing, overhead recovery, eventful broadcast

Design note for [#2194](https://github.com/soulsimulation/souls/issues/2194), from the maintainer's smoke test of
12 Nov 2026. Nothing here is built yet. Everything runs on the client from state it already has: cheap geometry, no
model. Cameras observe state and never move a body ([engine contract](../architecture/engine-contract.md)).

## What exists, and why it goes wrong

**Follow** (`apps/web/src/WorldFollow.ts`). Every 0.2 s it scores 26 candidate viewpoints on a sphere round the
Soul (rise first, then orbit, then come in) and keeps the best one with a clear sightline. Sightline checks use
`limit()`: 5 rays from torso, head and shoulders, plus 2 reverse rays for one-sided walls. When nothing nearby is
clear, it searches 48 directions all round. The camera glides there in spherical coordinates with first-order
exponential easing (`GLIDE`) under a speed cap. The #1316 coupling rules hold on top: a viewer's gesture is shown
immediately, and a deliberate pull-out decouples the camera. `rule` records why it moved, and `?camtrace` records
that rule (`camera-trace.ts`).

- *Stuck overhead.* `choose()` costs a candidate `angle(current→c) + 0.6·angle(asked→c) + …`, and the held viewpoint
  gets a 0.25 bonus. Once a narrow passage forces the camera up, returning to the asked-for angle Δ away costs Δ,
  while staying costs 0.6Δ − 0.25. Staying always wins, so the camera never comes back down.
- *Jitter.* The occluder roots include other Souls' bodies (`people.obstructionRoots()`). A held viewpoint that gets
  cut triggers an immediate re-search and the hurried 0.6 s glide. A Soul walking across the sightline sends the
  camera away and then back.
- *Angles.* The cost function knows nothing about faces, sky or sun. While walking it drifts directly behind the
  Soul, so it mostly shows the back of a head.

**Broadcast** (`WorldBroadcast.ts` over `WorldDirector.ts`; the mars `Director` frames the shot). `WorldDirector`
ranks candidates by activity score, then by key in alphabetical order (`localeCompare`). It holds a shot 8–24 s,
cools a subject for 30 s after showing it, and falls back to `bestLandmark` (the busiest landmark, then the least
recently shown). Only the idle tour (`WorldTour`, `rng(Date.now())`) varies between visits. The same world state
therefore gives the same cut order on every visit. Subject shots come from the solver's fixed programs. The only
moving shot of a subject is the rider drift.

**Related, not merged.** The launch-video kit ([#1963](https://github.com/soulsimulation/souls/issues/1963), branch
`agent/1963-launch-video-kit`) adds `packages/camera`. Its `moves.ts` has tracking moves (track, lead, chase, orbit,
crane, push, pan) in the subject's own frame. Its `pathfinder.ts` scores shots on sight, faces, size, smoothness,
clean foreground, level horizon, lead room and parallax. The scoring below uses the same vocabulary, so the two can
merge into one set of terms.

## 1. Shot score

`shotScore(eye, subject, ctx) → {total, parts}` is one pure function in a new module, `apps/web/src/shot-score.ts`.
Follow candidates and Broadcast hotspot shots both use it. Each part is in 0..1. Every part except occlusion is
arithmetic on positions, so it costs no rays.

| Part | Heuristic | Weight |
|---|---|---|
| occlusion | Share of `limit()`'s probe rays (head, torso, shoulders) that reach the eye. Below 0.6 the candidate is rejected. | gate, 3 |
| face | θ is the angle between the subject's yaw and the direction to the camera. `max((1+cosθ)/2, 0.8·\|sinθ\|)`: 1 face-on, 0.8 in side profile, 0 from behind. A walker uses its heading for yaw. | 2.5 |
| sky | Eye below head height looking level or slightly up (pitch −5°…+15°) scores 1 by geometry. Above that, one 60 m ray from the head continued away from the camera: no hit means sky or distant background behind the head. | 1 |
| sun | `s` = flat sun direction (`Daylight`'s sun light), `f` = flat view direction. Light falling on the subject from the camera's side: `(1 − f·s)/2`. If the sun is within half the field of view plus 10° of the view, score 0, except below 8° elevation (golden hour, neutral). Weight 0 when `daylight < 0.2`. | 1 |
| framing | Subject height fills 0.3–0.6 of the frame (follow) or the shot's framing fill (broadcast). Penalised looking down more than 26° (the pathfinder's `COMFORT.pitchDown`). For a walker, the eye sits on the leading side. | 1.5 |
| stay | Angle from the held viewpoint, scaled by 1/π. Inverted, so moving costs. | 1.5 |
| asked | Angle from the viewer's asked-for offset, plus the relative radius error. Inverted. | 2 |

`total` is the weighted mean. The scorer only runs for automatic choices. A viewer's gesture and a decoupled camera
(#1316) are never scored over. Walking changes accordingly: the drift goes to the side-behind (about ±110° off the
heading, whichever side is nearer the current eye) instead of straight behind. The face part already prefers that
angle, so the drift and the search agree.

## 2. Trajectory and easing

- **Critically damped spring.** Each eye coordinate on the sphere (θ, φ, r) and the look target follow the exact
  closed-form step. With x the offset from goal and ω = 2π/T: `x' = (x + (v + ωx)·dt)·e^{−ωt}`, and `v` updates from
  the same form. It holds at any dt, so 30, 60 and 120 Hz displays behave the same, as `followWeight` already does.
  Velocity stays continuous when the goal jumps, which the present first-order glide does not. T is 1.6 s calm,
  0.6 s blocked by static geometry, 1.2 s returning. The speed cap (`GLIDE.speed`, 6 m/s; 12 m/s blocked) stays as
  a safety limit, and gestures still set the pose and zero the velocity.
- **Choice hysteresis.** A new viewpoint replaces the held one only if it scores at least 0.12 higher in two
  consecutive searches (0.4 s), or if the held one is gated out.
- **Occluder dwell.** A ray hit is classified by its root. Static (architecture, fixtures, terrain) keeps today's
  immediate reaction. Transient (bodies, moving carriers) must cut the sightline for 0.5 s before the camera reacts.
  A body crossing the frame passes through the shot as it would on film. A Soul that stops in the way is still
  avoided.
- **Never through geometry.** The spring moves the goal on the sphere, and the existing per-frame clear check and
  `fit()` still bound the rendered eye. Easing adds no second movement path, and the camera stays out of solids.

## 3. Recovery from forced positions

The camera is *forced* when the held viewpoint differs from the asked-for one because the asked-for one was blocked:
it rose more than 0.3 rad in φ, came in below 0.7 of the radius, or the wide search picked it. While forced:

1. Every 0.5 s, probe a ladder of viewpoints from the held one toward the asked-for one: 25 %, 50 %, 75 % and 100 %
   of the way in φ, θ and r. That is 4 candidates × 5 rays.
2. A rung counts as clear only if `limit()` reaches its radius plus a 0.5 m margin ("space allows"), and only if it
   stays clear at the next probe as well. A brief gap in a passage therefore does not pull the camera down.
3. The camera springs to the furthest clear rung (T = 1.2 s). In this mode the stay part is dropped and asked gets
   double weight, which removes the cost bias that keeps the camera overhead today.
4. After a forced rise, at most one return every 1.5 s, so the camera never ping-pongs in a passage with openings.
   Once at the asked-for viewpoint, the camera is no longer forced, and `rule` records `recover` for the trace.

## 4. Broadcast scheduler

`WorldDirector` keeps its role and its cut discipline (`MIN_CUT`, the holds, conversations first, speck rejection).
Its argmax with an alphabetical tie-break becomes a seeded, weighted draw:

- **Eventfulness E**: today's `activityScore` plus the fresh-event bonus, plus 0.5 per active member beyond two in a
  gathering, plus 2 for speech in the last 10 s, plus up to 1.5 for motion energy (mean member speed and changes of
  activity in the last 20 s).
- **Novelty N**: `exp(−age/90 s)` for each of the subject, its place (a 20 m grid cell) and the shot type. Priority is
  `E · (1 − 0.6·N_subject)(1 − 0.3·N_place)(1 − 0.2·N_type)`.
- **Shuffle**: among candidates within 20 % of the best priority, draw one in proportion to priority (Gumbel-max
  draw). The rng is seeded once per page load (`rng(Date.now())`, as `WorldTour` does) and injected, so tests can
  fix the seed. Two visits to the same world state give different orders, and an important event still comes first.
- **Hotspots**: bodies within 6 m that are active (the existing `GROUP` rule) form a hotspot with a centroid, a
  member count, an activity sum and a velocity. The centroid is smoothed with an EMA of 1.5 s, so one member
  stepping away does not shift it.
- **Moving tracking shots**: a hotspot segment runs one of orbit, dolly, crane-up or push around the moving centroid,
  chosen by type novelty and scored with `shotScore`. These are `WorldTour.makeMove` moves with a moving target, or
  `packages/camera/moves.ts` if #1963 has merged. Like `riderShot`, the path is checked against the drawn scenery
  once at the start and then every second, and a blocked move re-solves to the next one. Segments run 10–20 s.
- **Inputs**: entity frames (p, yaw, activity), `speakingNow`, carriers, and the world's landmark and tour views, all
  already in `WorldBroadcast.sample`. Nothing new comes from the server.

## 5. Per-frame cost budget

**Budget** on the desktop tier with the CPU unthrottled, Eden 2026 and a 12-Soul god world:

- Camera work (`follow.resolve` or `broadcast.sample`) at most 0.5 ms median and 1.5 ms p95 per frame.
- At most 2 ms median with 4× CPU throttle (the phone tier).
- If the baseline measured in T1 is already over these numbers, the budget becomes no worse than the baseline, and
  the note is amended.
- *Amended (#2201 A1, 12 Nov 2026):* the baseline is over. Following a walking Soul on a local Eden 2026 world with four
  Souls, `follow.resolve` takes 8.5 ms median and 10.5 ms p95 per frame (about 21 rays median, 28 p95), and 40 ms median,
  54 ms p95 at 4× CPU throttle. The budget for A2–A4 is therefore no worse than that baseline.

**Rays**: one search is at most 160 rays, against about 180 today (26 candidates × up to 7 rays). The sky part adds one ray per candidate, and only
the top 8 candidates get it. Recovery adds 20 rays every 0.5 s. A search is spread over frames with the same work
counter Broadcast uses (`WorldRenderedVisibility.work`, `DECISION_RAYS` = 100 per frame), so one frame never runs a
whole search.

**Measurement**: under `?camtrace`, `performance.now()` around the camera call each frame, and the ray count,
written into the trace. The trace panel reports median and p95 ms and rays per frame. `orbit-profile.mjs` (its CDP
profile, with the camera functions added to its list) gives inclusive time per function as a cross-check. Measure
on a quiet machine, two repeats per arm (base vs head), as the playtest rule asks.

## 6. Tasks

Each task gets its own task issue on agenda #1960. Ceilings are limits, in observed wall-clock hours. Each web task
is T2: an uncut, real-speed clip of the journey on a local fake-mind world, plus the camtrace cost summary of base
vs head.

| # | Task | Ceiling | Touches | Proof |
|---|---|---|---|---|
| T1 | Camera cost meter: ms and rays per frame in `?camtrace`, median and p95 in the panel. Baseline recorded on the issue. | 1 h | `camera-trace.ts`, its test, `LiveWorld.tsx` (≤ 10 lines), `WorldFollow.ts` (ray counter) | Trace summary from two runs and a short clip of the trace panel |
| T2 | Follow overhead recovery (§3) and occluder dwell (§2). | 2 h | `WorldFollow.ts`, `WorldFollow.test.ts` | Clip: walk through a narrow alley or stair into a plaza, back at the asked-for angle within 3 s of open space. Clip: three Souls cross the sightline, camera holds. Trace shows `recover` and no `search` flips from passers-by. |
| T3 | Critically damped spring easing (§2). | 1 h | `WorldFollow.ts`, new `camera-spring.ts` and its test | Clip at 60 Hz and the trace at 30 Hz: no velocity steps at goal changes, #1316 coupling tests unchanged |
| T4 | Shot score (§1) in follow candidates, side-behind walking drift. | 2 h | new `shot-score.ts` and its test, `WorldFollow.ts` | Clip: a walk of 60 s or more, day and dusk, face or profile in view most of it; cost within budget |
| T5 | Broadcast shuffle by eventfulness and novelty (§4). | 1.5 h | `WorldDirector.ts`, `WorldDirector.test.ts` | Two uncut 3-minute broadcast clips of one world from two page loads: different cut orders, conversations still first, no subject twice within 90 s unless it is the only event (`__soulsBroadcastCuts`) |
| T6 | Hotspot tracking shots in Broadcast (§4). | 2 h | `WorldBroadcast.ts`, `WorldDirector.ts`, their tests | Clip: a gathering filmed with a moving orbit or dolly that re-solves round a building, never passes through one |

Order: T1, then T2 (the two reported bugs), then T3 and T4, then T5 and T6. T5 does not depend on T2–T4 and can run in
parallel. The total ceiling is 9.5 h. The walk and bundle gates stay green in every task. T4 and T6 are the only
tasks that can move the bundle, and `shot-score.ts` is small arithmetic.

**Not in scope**: learned or AI shot selection, server-side camera state, a shot list (that is #1963), new free-camera
or RTS controls, and the decoupling rules of #1316.

---

**Maintainer: dispatch T1–T6 as written, starting with T1 and T2 (yes/no)?**
