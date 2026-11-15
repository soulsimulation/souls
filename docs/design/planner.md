# Planner: binding and routes off the clock thread (#1953 stage 3)

Status: proposed, not built. Measurement and note: #2414. Parent: #1953.

## What the clock thread does today

#2414 profiled the world's main thread in `eval-load` on `souls-timed` (run 43669471732, main 44455d070, 120 s of
load, read workers off) and put every sample in one group:

| Group | 24 Souls: ms | longest single-turn share, ms | 50 Souls: ms | longest single-turn share, ms |
|---|---|---|---|---|
| Ticks (walk steps, take recut, listeners) | 28,993 | 1,119 | 42,256 | 430 |
| Connectivity audit and planner scans | 19,956 | 1,370 | 19,730 | 1,391 |
| Acts, request side (bind, check, scans inside) | 12,034 | 675 | 16,636 | 567 |
| Acts, tick side (route planning, commit) | 3,224 | 777 | 8,245 | 1,036 |
| Non-act requests and pushes | 5,031 | 472 | 7,446 | 186 |
| Snapshots | 2,826 | 307 | 3,351 | 222 |
| GC | 4,653 | 187 | 6,883 | 286 |
| Busy, of the profile window | 78,220 of 140,850 | | 106,820 of 167,530 | |

`Spatial.route`, from every caller, took 2,838 ms at 24 Souls and 5,973 ms at 50. At 50 Souls, `retryPeople`
(re-planning around people under way) took 5,682 ms. The act's `bindsCore` took 6,037 and 8,855 ms, most of it in
`worldProfile`.

**Binding and checking an act** cost 15 % of the clock thread. **Route search** costs at most 3.6–5.6 %, and re-plans
under way, which read where people stand that tick, cannot move.

## Stage 3a: bind and check in a worker (first)

The act's accepted `decision` event already carries the bound programme (`steps`). A replay folds those steps and
never re-binds. Moving the binding changes no logged fact and needs no rules change.

- In mode 2, read workers already run `binds()` over a replica (`split/menu-world.ts`). The gateway sends
  `POST /v1/edge/act` to a worker. The worker binds and checks the offer, then posts
  `{soulId, option, steps, gen, navEpoch}` to the clock over the admission port.
- The clock runs the acceptance guard it runs today (`enqueueChecked`) against live state at the drain. If the
  worker's `gen` is more than a few ticks old, the clock binds again itself. Refusals keep today's reasons.
- **Equality proof:** an oracle mode binds on both and compares `steps` field by field, as `read-oracle.ts` does for
  reads. The one permitted difference is a verdict that has not yet reached the replica (one delta).

## Stage 3b: routes off the clock (later, gated on a re-measure)

### (a) An off-clock route is a logged input the engine validates

The route rides in the accepted `decision` event as an optional field:

    routeOfferV1: { step, key: { navEpoch, physicsHash, actor, level, from: [x, z], goal, profile }, route }

`key` is everything `planWalk` reads. A new logged runtime policy, `route-offer/1`, changes `runtime.admit` only. Before
it calls `walkTo.plan`, the engine computes the key from its own state:

- If every field is equal, it takes the offered route and runs the rest of `plan` (goal occupied, holding, gait)
  unchanged.
- Otherwise it plans as today. There is no new refusal: a stale offer only fails to save the planning.

A replay reads the same offer, decides the same way and folds the same route.

This needs `Spatial.route` to be a pure function of `key`, the same whether the paged ground windows (`focusPage`)
and the connectivity labels (warmed on the wall clock, `navWarmV1`) were warm or cold. If it is not, live and replay
already diverge today; that is fixed first.

### (b) The navigation copy follows god edits and warm-up exactly

`SpatialReplica` rebuilds whenever the export's epoch or physics hash moves; `replica-scene-key.test.ts` covers a
rollback that reuses an epoch. The key carries both, so an offer from a copy one edit behind is ignored at commit.
A lagging copy costs a miss, never a wrong route. If a route reads labels, the copy answers only once its labels are
complete, and the key carries a "labels complete" bit the clock checks against its own.

### (c) Proving the worker's answer equals the clock's

1. **Key purity:** over every Eden 2026 seat approach and a sample of walks, the same key gives byte-equal routes on a
   cold service and on one warmed in another order.
2. **Shadow oracle:** with `SIM_PLANNER_ORACLE=1`, the clock still plans each walk and compares whenever the keys
   match. The bar is zero differences at 24 and 50 Souls and on m4-v1.
3. **Replay:** with the planner off, the walk gate and the golden route hashes are unchanged. With it on, a history
   replayed from genesis reaches the live state hash.

## Tasks

Ceilings are observed wall clock for one lane.

| # | Task | Ceiling |
|---|---|---|
| B1 | Acts to a read worker: bind and check there, `steps` to the clock over the admission port; guard at the drain | 3 h |
| B2 | Bind oracle, then timed `eval-load` 24 and 50, on against off, 2 repeats, bar declared first | 2 h |
| P1 | Key purity of `Spatial.route`, cold against warm; fix or name what is not pure | 2 h |
| P2 | `routeOfferV1`, `route-offer/1` and the key check in `admit`; replay tests (accept, ignore, old history) | 3 h |
| P3 | The planner answers `route(key)` from the worker's `SpatialReplica`; the act carries the offer | 2.5 h |
| P4 | Shadow oracle, hit rate (offers taken / walks started), timed `eval-load` on against off | 2.5 h |

B1–B2: about 5 h. P1–P4: about 10 h, started only if a re-measure after B2 shows route search above 10 % of the
clock thread at 50 Souls.

## Which stage first

The largest measured cost is one that no thread move takes off the clock: the planner's own sync. `syncPaged` →
`navChanged` → `navScan` runs inside walk steps and reads. It took 9,222 ms at 24 Souls and 16,007 ms at 50, with a
1.4 s turn. The connectivity audit is next, with 1.37 s turns (#2408 bounds them). Making these cheaper is #1953
stage 2 work, and it comes first.

Of the thread moves, stage 3a (binding) gives the most: 12–17 s of clock time per 120 s. Stage 1 (non-act requests)
gives 5.0–7.4 s, and stage 3b (routes) at most 3–6 s.
