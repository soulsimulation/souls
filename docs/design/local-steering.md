# Local steering before re-planning

**Nothing here is built.** Task #2537 (scaling tranche #2504, lane N). Code read at
`ade455516`; walk.ts is `mars/viewer/engine/locomotion/walk.ts`.

## Where the cost is

A walker stopped by a person who stays still for `decideAfter` (0.5 s, doubling per attempt, at most six) calls
`retryPeople`. It copies the grid, stamps standing people in and searches the whole route again (twice, if the
first fails on a person). The act meter (PR #2558, 24 and 50 agents) measured these re-plans (`route.people`) at
17–126 ms of clock per act: 76–93 % of the tick's route cost, against 2–5 ms for first plans. M4 (#2510) has not
reported, so nothing covers 100 agents yet.

The walk already steers locally, but only at a point (`sidestepTarget`, at most 0.8 m). Nothing checks the whole way
past, so a gap a little wider still ends in a re-plan.

## The rule (`local-pass/1`)

Where `retryPeople` would run, the walker first looks for a **bypass**: leave the corridor, pass the blocker at a
fixed lateral offset, rejoin.

- **Inputs:** the corridor from `ex.s` (`pointAt`, `tangentAt`), the radius `r`, the level's synced grid (no copy, no
  search), the standing people and loads within `LOOK`, and the blocker's stretch, `s_b − 2r − 0.3` to
  `s_b + 2r + 0.6` along the corridor.
- **Candidates, fixed order:** offsets `+0.1, −0.1, +0.2, −0.2 … ±1.2` m (right first, as `sidestepTarget` breaks
  ties). Each bypass (out, along the stretch, back) is sampled every 0.1 m. Every sample needs clearance ≥ `r` and a
  distance ≥ `2r` to each person (`r + SLEEP_BODY_MARGIN` to a sleeper's envelope) and each load. The first candidate
  that passes becomes `ex.sideTarget`, latched until `ex.s` leaves the stretch. The existing offset code walks it;
  the hard guards (`intrusion`, `guardBodyStep`) stay unchanged.
- **Does not apply** when the stretch meets a single-file narrow, the walker holds or yields a passage, the leg is a
  link, a link landing is within 1.5 m, or the blocker stands on the goal.
- **Gives up:** if no candidate passes, or the bypass is blocked again in the same stretch, the walker goes on to
  `retryPeople` at that decision. Each stretch gets one local attempt, which does not use up a re-plan, so the ladder
  and its back-off are unchanged. The worst case is today's behaviour, one 0.5 s decision later.

## Why it replays exactly

The bypass is a pure function of the tick's state: positions, the synced grid, ids in sorted order and a fixed
candidate order. It uses no random numbers, no clock and no search state carried between ticks. It runs inside the
walk step, in submission order; its latch is plain data in the snapshotted walk exec.

## Jam cases and their tests

| Case | Risk | Test (rule on, against off) |
|---|---|---|
| A ring filling up | sides flip, slots never fill | 12 walkers to 12 ring spots: all arrive, no longer block than the off arm, no violations |
| Two flows crossing in a doorway | local passes fight `traffic.yield` | excluded as a narrow; `doorway-passing.test.ts` and a 4-and-4 crossing equal tick for tick |
| A corridor with a sleeper | stepping into the sleep envelope | 1.6 m corridor: a pass that keeps the margin, or today's diagnostic; no collision violation |
| A stair foot | crowding the landing | excluded near landings; the `stair-foot` counted kit gives the same pass/fail per item |

Rule off: the walk gate and `walk-perf` goldens stay equal.

## What it would save

At most all of `route.people`: 17–126 ms per act. The saving is that times the share of re-plans that had a bypass,
and nothing measures the share yet. A shadow counter can: at each `retryPeople`, compute the bypass, use nothing and
count. A third would save about 6–42 ms per act. A local attempt (at most 24 candidates × about 40 samples) costs
tens of microseconds; a re-plan, milliseconds.

## Adoption and rollback

A logged rule like `cede-passage/1`: a `rules` event, adopted at boot in `edge-runtime-rules.ts`, sets
`runtimePolicy.localPassV1`, a named state-hash input. History before the event replays without it. Rollback is a
later `rules` event that sets it false. History is never edited.

## Proposed task

**N6 · local-pass/1 in shadow, with its jam tests (ceiling 4 h).** Build the bypass as a pure function in walk.ts. Add
a shadow counter, behind a debug switch and read by `eval-load`: re-plans, those that had a bypass, and their ms. Add
the four jam tests, with the flag on in tests only. Acceptance: the share at 50 and 100
agents over two repeats, the four tests green, the walk gate equal. Adopt later only if the share times `route.people`
is worth the rule.
