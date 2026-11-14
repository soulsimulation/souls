# Stair traffic

**A design note for a yes or no. Nothing here is built.** From
[#1367's diagnosis](https://github.com/soulsimulation/souls/issues/1367#issuecomment-6812140110) and PRs
[#2001](https://github.com/soulsimulation/souls/pull/2001), [#2152](https://github.com/soulsimulation/souls/pull/2152),
[#2117](https://github.com/soulsimulation/souls/pull/2117), [#2171](https://github.com/soulsimulation/souls/pull/2171) and
[#1453](https://github.com/soulsimulation/souls/pull/1453). Code read at `2cb175540`; walk.ts is
`mars/viewer/engine/locomotion/walk.ts`.

## 1. Why bounding waits can't reach 0

In the counted Tower House stair run, Souls freeze at the bottom flight's foot. Frozen walks went 7/3 on the base,
3/3 with wait-bound/1, 1/1 with wait-bound/3, never 0.

- **A bound ends a walk; it does not clear the doorway.** The ended walker still stands at the foot, and its
  re-sent walk rejoins the queue (cause C: Cal stood 146 s through repeated `route.blocked` ends). Completed acts
  doubled under wait-bound/3, but someone still froze.
- **The jam has more phases than a bound reads:** `walk`, `align`, `climb` at climbT 0 and above, or held by a
  make-way with no walk exec. wait-bound/1 restarted on every shove (15 walks); #2117 added only climbT 0;
  wait-bound/3 lost the exec under make-way, and its last run left an `align` walker and a climbT 0 walker #2032
  exempts. Each fix moves the frozen case to a phase it does not read.
- **The cause is structural.** The only place to wait for a single-file flight is its entry point, where the other
  direction steps off. Each reactive move shoves someone else and restarts their clock. The cycle must be prevented,
  not timed out.

## 2. Proposal: a flight is a leased resource

A new logged runtime rule, `link-lease/1`.

- **One direction at a time.** Each single-file link has a hashed lease: direction (up, down or free), holders
  (bodies on it or admitted to its entry), and a queue per end. Flights joined by a roomless landing lease as one.
- **Holding spots off the foot.** For each end the nav computes up to three spots, on that end's floor and clear of
  the flight and both approach points by a body width. A walker whose next leg is the link requests the lease about
  3 m out. Admitted, it climbs; otherwise it waits at a free holding spot (`traffic.lease-wait`, naming the link and
  holder). Nobody waits in the doorway, so a descender always has its exit.
- **Fair hand-over.** When the flight empties and the other end has a request, the lease turns if the current
  direction has admitted three walkers, or run 10 s, since that request. The longest wait is three traversals plus a
  hand-over.
- **Bounded, named containment.** A holder with no progress for 60 s backs down to its entry through the existing
  cancel, never a teleport, and waiting walks end `route.blocked` with `traffic.lease-timeout` naming it.
- **Deterministic and replay-safe.** Requests are served by tick, then entity id. A logged rules event adopts it;
  older history replays as recorded.

Head-on meetings cannot form (cause B); the queue stands off the foot (causes A and C).

## 3. What the engine already has

- **A direction-keyed hold:** `traffic()` (walk.ts:232-234: `actors`, `entry`, `dir`, `exclusive`), taken as the
  climb starts (walk.ts:1711-1719), released at the exit (walk.ts:1742-1749), already in the snapshot
  (`runtime/snapshot.ts:4`). It is the lease, taken too late.
- **Link legs:** `LinkLeg` (`spatial/path.ts:13`); `Link` with `width` and `approach` (`spatial/types.ts:24-42`). The
  nav builds link edges at `spatial/connectivity.ts:550-551`, the place to compute holding spots.
- **Climb phases:** `stepLink` (walk.ts:1639): `align` and occupied-link-routing/1's far-landing wait
  (walk.ts:1643-1683), the climb with `stairBlocker` and `landingBlocker` (walk.ts:1727-1738, 1283, 1303), and the
  back-down `stepLinkCancel` (walk.ts:1842).
- **`yieldLinkLanding`** (walk.ts:1761-1806): its `clearFlight` test and finite spot search find a holding spot.
  `makeWay` (walk.ts:1320) moves idle bodies off an end.
- **Rule plumbing:** `RUNTIME_POLICY_FLAGS`, `stateHashInputs`, `configureRuntimePolicy`
  (`packages/engine-mars/src/engine.ts:193`, `:375`, `:3022`); boot adoption in
  `apps/server/src/edge-runtime-rules.ts:12-21`.

## 4. Alternatives

- **A wider stair foot by design:** flights two bodies wide with a forecourt at each end, narrow ends refused at god
  admission. Cost: a def revision and conformance supplement per stair kind and a rebuild of authored stairs; ladders
  and narrow god-built stairs still freeze, and a wide flight still needs passing rules. Good for new content only.
- **Passing on the flight** ([#1722](https://github.com/soulsimulation/souls/issues/1722),
  [#1723](https://github.com/soulsimulation/souls/pull/1723) `stair-pass/1`): once a head-on meeting forms, a waiter
  steps aside or a climber backs down. Cost: a 3 h rebase and counted run; its playtest had no head-on episode to
  score. It fixes cause B after it forms, needs landing room and leaves the foot queue. Under the lease it is
  containment only.

## 5. Tasks

Each is T3. Task 4 runs the #1334 A9 stair kit, two repeats per arm, its bar declared before the run.

1. **Holding spots** (2 h), no behaviour change. Test: every Tower House flight end has two spots clear of the
   flight; walk gate unchanged.
2. **`link-lease/1`** (4 h): hashed lease, admission, hand-over, holding-spot waits, boot adoption. Tests: the a-1
   cycle completes; three up and three down finish within the computed bound; replay and boot-from-log hashes agree.
3. **Chained flights and idle bodies** (3 h): flights joined by a roomless landing lease as one; `makeWay` clears idle
   bodies from an approach. Test: the a-2 middle-flight head-on cannot form.
4. **Counted run** (2 h): base main, cand tasks 1-3. Bar per cand run: 0 frozen walks at the foot or mid-flight, 0
   `traffic.lease-timeout` ends, 0 ladder, `engine.*` or teleport rows, completed acts at least the base's; 2/2.

About 11 agent-hours. #2001 and #2152 still bound other motions; #2171 and #1723 park until task 4.

## 6. Question for Gene

**Build `link-lease/1` (tasks 1-4, about 11 agent-hours, T3), and park #2171 and #1723 until its counted run is
scored? Yes or no.**
