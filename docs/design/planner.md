# Route planning off the clock thread (#1953 stage 3)

Status: proposed, not built. Issue #2414 (measurement and this note); parent #1953.

## Why

#1953 splits a world into three roles: the **clock** ticks and commits acts, the **gateway** owns every socket, and the
**planner** turns an act into a concrete plan on other cores. Stage 3 is the planner. It is started only when the
measurement says route planning is what limits a world.

MEASUREMENT

## How a route is made today

An act becomes a logged `play` event at the tick that drains it (`world.ts` `drainInputs`). When the programme's
`walk_to` step starts, the runtime calls the action's `plan` (`runtime.ts` `admit` → `walk.ts` `walkTo.plan` →
`planWalk` → `Spatial.route`) inside the step. A replay folds the same `play` event and plans the same route again,
inside its own step. Under way, a walk plans again around people (`retryPeople` → `routeAround`) and around a
detour or a blocked goal (`walk.ts` 429, 670, 691, 733), each inside a step.

Before the act is taken, the request thread also searches routes: `routeProblem` → `canPerform` for each exit of
`here`, and `binds` for the menu. Those are answers to the Soul, not the plan the engine runs.

## The design

The planner is a worker thread that holds a navigation copy: the read workers' `SpatialReplica`
(`split/spatial-replica.ts`), built from the engine's static scene export and kept current by the WorldDelta stream.
For an act whose programme starts with a walk, the gateway asks the planner for the walk's route before the act is
queued. The answer rides into the queue with the act.

### (a) A route made off the clock is a logged input the engine validates

The route travels **inside the accepted `play` event**, as an optional field:

    routeOfferV1: { step: 0, key: { navEpoch, physicsHash, actor, level, from: [x, z], goal, profile }, route }

`key` is everything `planWalk` reads: the static scene by its epoch and physics hash, the walker's level and exact
start point (no rounding), the goal and the body profile. A new logged runtime policy, `route-offer/1`, adopted at
boot after the existing policies, changes one thing in `admit`: before calling `walkTo.plan`, if the step carries an
offer, the engine computes the key from its own state. If every field is equal, it takes the offered route as the
plan, then runs the rest of `plan` (goal occupied, holding, gait on dry ground) unchanged. If any field differs, it
ignores the offer and plans as today. No new refusal: a stale offer costs only the planning it failed to save.

This keeps replay exact without trusting the worker. The route is part of the logged fact, so a replay reads the
same offer. The key check is a pure function of world state at that tick, so a replay makes the same accept or
ignore decision, and folds the same route. A history from before the policy has no offers and replays as recorded.
The offer is checked as data; the engine never asks whether the planner was right, only whether the inputs match.

This holds only if `Spatial.route` is a pure function of `key`. Two things could break that, and task P1 proves or
removes each: the paged ground windows the planner builds lazily (`focusPage`), and the connectivity labels, which
are warmed against the wall clock (`navWarmV1`). A route must give the same answer whether a window or a label was
already warm or not. If one does not, the in-tick planner already diverges between live and replay today, and that
is a bug to fix first.

Replans under way (`retryPeople`, detours, blocked goals) stay on the clock in this stage. They read people's
positions at that tick, so an offer computed earlier would almost never match. Moving them is not proposed here.

### (b) The navigation copy follows god edits and warm-up exactly

The copy needs nothing new to follow edits. `SpatialReplica` rebuilds when the export's epoch or physics hash moves
(`replica-scene-key.test.ts` covers a rollback that reuses an epoch). The key carries both, so an offer made on a
copy one edit behind is ignored at commit, never applied. The cost of a lagging copy is a miss, not a wrong route.

Warm-up matters only if (a)'s purity check fails. The copy labels connectivity on its own budget
(`spatial-replica.ts` `navWarmV1`), which differs from the clock's. If a route reads labels, the planner either waits
for complete labels before answering, or answers without them and lets the key carry a "labels complete" bit, which
the clock checks against its own.

### (c) Proving the worker's answer equals the clock's

Three layers, cheapest first:

1. **Key purity.** A test plans the same key on a cold service and on one warmed in a different order (windows,
   labels), over every Eden 2026 seat approach and a random sample of walks, and compares routes byte for byte.
2. **Shadow oracle.** With the planner on and `SIM_PLANNER_ORACLE=1`, the clock still plans every walk itself and
   compares its route with the offer whenever the keys match. Zero differences over a 24-Soul and a 50-Soul
   `eval-load` and the m4-v1 battery is the bar to turn the policy on.
3. **Replay.** The walk gate and the golden route hashes stay unchanged with the planner off. With it on, a world's
   history replayed from genesis reaches the live state hash.

## Tasks

Ceilings are observed wall clock for one lane.

| # | Task | Ceiling |
|---|---|---|
| P1 | Key purity: prove `Spatial.route` is a function of the key, cold against warm windows and labels; fix or name what is not | 2 h |
| P2 | `routeOfferV1` in the `play` payload, the `route-offer/1` policy and the key check in `admit`; offers built on the clock thread for the test; replay tests (accept, ignore, old history) | 3 h |
| P3 | The planner worker: a `SpatialReplica` fed by the delta stream, answering `route(key)` over a MessagePort | 3 h |
| P4 | The gateway asks the planner before queuing a walk act, with a deadline; a late answer queues the act with no offer | 2 h |
| P5 | Shadow oracle and the hit rate (offers taken / walks started) at 24 and 50 Souls | 2 h |
| P6 | Timed `eval-load` at 24 and 50 Souls, planner on against off, 2 repeats; bar declared before the run | 1.5 h |

About 13.5 h in six tasks, against #1953's estimate of 25 h in eight. Proof is P1, P5 and P6.

## Which stage first

FIRST
