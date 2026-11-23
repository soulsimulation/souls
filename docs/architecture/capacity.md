# Capacity runs

The published capacity runs of the new engine, newest first. Each run gives the machine, the agents (M) and intents a
second (N) one world carried, the viewers (Q) it served, each limit's measured value, and which limit gave way first.
Why and how to measure is in [scaling](scaling.md). These are measurements of one build on one machine. They are not
promises.

## 0.133, 23 Nov 2026: the planner asks each question once (S7, S8)

**Builds:** before = main `9717c6ff2` (with C6, before S7); after = S8's head (#4355): S7's cheaper passages and
triangles (#4335) and S8's one request per walk, line and form cursor out at the planner at a time. **Machine,
placement and load:** a timed runner on the build machine, 6 CPUs: the world (worldd, gatewayd, the viewers' origin)
on 5, the driver on 1. Stage 2a's rung (`v2/tools/bench/stage2a/rung.sh`), 120 s, two repeats, before and after
alternating, by `.github/workflows/planner-500.yml`. Figures are ranges over the two repeats.

| Rung (agents, rate, arm) | intents/s | planner cores, before / after | ticks on time, before / after | viewer delay p95 ms, before / after |
| --- | --- | --- | --- | --- |
| 500, burst, even | 333 | 0.38–0.39 / 0.40–0.41 | 100 / 99.82–99.96 % | 711–777 / 849–1007 |
| 500, burst, uneven | 327 | 0.42–0.45 / 0.43–0.66 | 99.82–100 / 99.91–100 % | 813–851 / 826–1075 |
| 750, burst, even | 500 | 1.0 / 1.0 | 99.91 / 99.78–99.87 % | 650–706 / 797–817 |
| 750, burst, uneven | 503 | 1.0 / 1.0 | 99.05–99.30 / 98.86–99.35 % | 803–806 / 798–821 |
| 1,000, `every4`, even | 250 | 1.0 / 1.0 | 99.86–99.91 / 99.87–99.96 % | 925–2269 / 1093–1607 |

**What it shows.** At 500 agents in bursts the planner either keeps up at about 0.4 of a core or sits at a full
core, and which one happens varies from run to run on the same build. Before S8, a walk, a walker's line or a form's
walk question still out at the planner was asked again every tick. A planner that fell behind therefore answered
each request once for every tick it was behind, and stayed at a full core. Across the four runs of this work it
sat at a full core in 7 of 20 rungs before S8 (one more at 0.9) and in 1 of 12 after: S7's run (main 3 of 4, S7 4 of 4), S7 against
S8's first version (0 of 4, 0 of 4), main against S8 with exact generations (0 of 4, 1 of 4), and the run above
(0 of 4, 0 of 4). "Before" counts main and S7 together. In the run above, before also kept up, so that run
alone does not separate them; the tests do (`s8_*` in `sim/tests/planner.rs` and `worldd/src/acts/tests.rs`). At
750 agents in bursts and 1,000 agents `every4` the planner is at a full core before and after. That is its real
demand, not repeats: each form's walk question is a full `stand_near_shape` search (C7's profile below). Ticks stay
on time, and the viewer delay p95 stays under 1.1 s at 750 burst and under 2.3 s at 1,000 `every4`. The next step is
C7's: a cheaper `stand_near_shape`, or forms' walk questions answered on more than one thread. The 1,000 `every4`
uneven rows did not print in this run.

## 0.133, 23 Nov 2026: past 500 agents

**Build:** main `456552d8b` with #4325 (C6: whose a thing is reads two marks, which keeps the clock on time at 500
agents in bursts) merged in. The agent ladder now goes to 750 and 1,000 agents (`v2/tools/driver/loads.mjs`).
**Machine, placement and load:** as in the run below. The agent ladder ran at 750 and 1,000 agents, `every4` and
burst, even and uneven, 120 s per rung, two repeats side by side. The viewer ladder's top rungs (2,000, 3,500 and
5,000) ran with 16 reader processes instead of 8. The readers' event loop stayed at a p99 of 11–24 ms, so the bench
was not the limit this time.

| | Value |
| --- | --- |
| **M** agents in one world | **750** with every limit met (`every4`, about 187 intents a second) |
| **N** intents a second | **about 330** with every limit met (500 agents, burst, after #4325: ticks on time 100 %, viewer delay p95 639–783 ms) |
| **Q** viewers of one world | **5,000** held once they are in: stream latency p99 330–610 ms, no drops. A join wave of 1,500 or more newcomers within 5 s misses the first picture (see below). |
| **Gave way first** | Agents: **the planner thread's route searches**, at 750 agents in bursts (500 intents a second) and at 1,000 agents `every4` (250 a second). The planner is at a full core there. Acts wait for its answers before they start and move, so the viewer delay p95 passes 2 s on every verb alike (2.5–3.1 s by verb at 750 even burst), and in the even burst arm acceptance p95 rises to 1.5 s. The clock still keeps time there (96.7–100 % on time). It gives way only at 1,000 agents in bursts (667 a second: 61–72 % on time). |

### Each limit, measured

| Rung (agents, rate) | intents/s | accepted p95 ms | viewer delay p50 / p95 ms | ticks on time | planner / clock cores |
| --- | --- | --- | --- | --- | --- |
| 750, `every4` | 187 | 148–164 | 500–561 / 772–901 | 99.78–99.96 % | 0.38–0.84 / 0.32–0.39 |
| 750, burst | 500 | 114–1540 | 511–605 / 1507–2652 | 96.67–99.74 % | 0.99–1.0 / 0.42–0.50 |
| 1,000, `every4` | 246–250 | 79–96 | 434–584 / 1663–2662 | 99.96–100 % | 1.0 / 0.34–0.36 |
| 1,000, burst | 667–671 | 356–1738 | 621–764 / 1977–8033 | 61.45–72.03 % | 1.0 / 0.71–0.77 |

The stream writer stayed at 0.16–0.39 of a core with `idle.check` at 0. Stuck Souls on the uneven arms grew with
the count (18–30 at 750, 47–49 at 1,000): the behaviour fault noted below, not a capacity limit.

**Where the planner's core goes** (an in-process 199 Hz sampling profile of `worldd` at 1,000 agents, uneven
`every4`; a measurement build only): 95 % is `walk::town::View::stand_near_shape`, a form's walk asking where to
stand near a thing's outline (the planner's `FormQuery::Walk`). Under it: `mover::walk` 16 %, `mover::enter` 12 %,
`routes::gap` 11 %, `routes::spot_for` 10 %, `routes::locate` 10 %, `walk::town::in_passage_but` 7 %,
`mover::orient` 4 %, `routes::cross` 3 %. The next step is in routing and town code (lanes A2 and S): make
`stand_near_shape` cheaper, or answer forms' walk questions on more than one thread. It was not changed here.

**Viewers.** With 16 reader processes, 5,000 viewers keep a latency p99 of 330–610 ms and no drops once they are in.
A step that starts 2,000 viewers in one 5 s wave gives a first picture p95 of 13–14 s. Adding 1,500 more gives
3.8–4.6 s at 3,500 and 13.6–17.7 s at 5,000 (bar 3 s). Every joiner fetches an 8.9 MB baseline, so a wave of 1,500 is
about 13 GB from the viewers' origin within seconds. That points to the origin's sending of baselines to a join wave,
not to steady viewing. The origin's own processor share is still not sampled (it reads 0), so this is inferred,
not measured.

## 0.132, 23 Nov 2026

**Build:** main `ae5bae670`. That is A1, A2-1 (#4220), C1 (#4208), C4 (#4279) and #4003, plus C5 (#4288) merged in for
the run.

**Machine:** the shared build machine: AMD Ryzen Threadripper 3960X (24 cores, 48 threads) with 125 GB of memory. The
machine is shared, with its load at 2 to 8 during the runs (SMOKE grade).

**Placement:**

- **Agent ladder** (`v2/tools/bench/stage2a/ladder.sh`): the world's processes (worldd, gatewayd, the viewers' origin)
  were pinned to 8 threads and the agents' driver to 8 others.
- **Viewer ladder** (`tools/bench/capacity/viewers/v2.mjs`): the world, the origin and 8 reader processes shared 16
  threads, with 20 walking Souls.

The two agent-ladder repeats ran side by side on separate threads, and the viewer ladder ran beside them. The
`timed-run` workflow has no command for these two ladders, so they ran on the build machine's farm with this pinning
instead of a `souls-timed` runner.

**Load:** Eden with M test Souls driven by the real Soul Actions mix. Fake minds; no model runs.

- `every4`: each agent acts every 4 s.
- `burst`: 2.7 times that rate.
- `even` and `uneven` arms.
- 120 s per rung, two repeats.
- Viewers in steps of 100 to 5,000: a join wave, 60 s windows and 2 % slow readers, two repeats.

| | Value |
| --- | --- |
| **M** agents in one world | **500** (the top of the ladder; every rung kept its acts answered and visible) |
| **N** intents a second | **about 230** with every capacity limit met (350 agents, burst). At 330 a second (500 agents, burst) the clock gave way. 125 a second at 500 agents (`every4`) was met. |
| **Q** viewers of one world | **2,000** with all six viewer bars met in both repeats. At 5,000 the first picture missed its bar. |
| **Gave way first** | Agents: **the world's clock**. At 500 agents in the burst arm (327 to 333 intents a second), ticks on time fell to 92.8 to 96.2 % (bar 99 %), with tick p99 at 65 to 115 ms against a 50 ms tick. The planner thread was at 0.91 to 1.0 of a core, the first thread at a full core. Viewers: **the first picture** at 5,000, with a p95 of 25 s against a 3 s bar. |

### Each limit, measured

| Limit | Bar | Measured (range over rungs and repeats) | Held? |
| --- | --- | --- | --- |
| Act answered (send → accepted) | — | p50 40–68 ms, p95 115–236 ms | yes, all rungs |
| Viewer delay (send → first visible move on the public stream) | 1 s typical, 2 s worst 1 in 20 | p50 347–553 ms, p95 582–829 ms; worst p99 2.3 s (500 even burst, repeat 2) | yes, all rungs |
| Acts seen on the public stream | all | 99.8–99.9 % (the rest were taken in the run's last moments) | yes |
| Ticks on time (50 ms tick) | ≥ 99 % | 100 % up to 350 `every4`; 99.35–100 % at 350 burst and 500 `every4`; **92.8–96.2 % at 500 burst** | **no at 500 burst** |
| Busiest world thread | under a core | planner 0.91–1.0 and clock 0.51–0.55 core at 500 burst; clock 0.33–0.39 at 500 `every4` | **planner at a full core at 500 burst** |
| Public stream writer | under half a core | 0.15–0.30 core; `idle.check` 0 ms per 10 s | yes |
| World memory | — | 1.24–1.86 GB resident | — |
| Stuck Souls (refused only, never moving) | 0 | 0–2 on even arms; 5 at 200 uneven, 12 at 350 and 500 uneven `every4` | **no on uneven arms, from 200 agents**: a behaviour fault, not load (it does not grow with load) |
| Viewers: first picture p95 | ≤ 3 s | 70–200 ms up to 2,000; **25 s at 5,000** | **no at 5,000** |
| Viewers: stream latency p99 | ≤ 2 s | 290–330 ms up to 2,000; 1.4 s at 5,000 | yes |
| Viewers: drops (errors, sent back to a baseline, left behind) | 0 | 0 up to 2,000; 48–90 left behind at 5,000 | no at 5,000 |
| Viewers: origin memory | ≤ 256 MB | 51–57 MB | yes |
| Viewers: the world's tick with viewers | within 10 % of no viewers | 1.5–2.1 ms mean in every window, with and without viewers | yes |
| Bytes a viewer is sent | — | about 15 KB a second (27 KB a second at 5,000); a joiner fetches an 8.9 MB baseline | — |

### What it does not show

- **The 5,000-viewer step may measure the bench, not the origin.** The bench's own reader processes' event loop
  reached a p99 of 89–91 ms at that step, against 11 ms below it. The origin's processor share read 0 in every window,
  because the sampler sees only the origin's first process. The next viewer run should give the readers their own
  cores before reading 5,000 as the origin's limit.
- The strict stage-2a bar (first visible move p50 ≤ 100 ms, p95 ≤ 300 ms) is missed everywhere. A part is cut every
  0.5 s, which sets that floor. Shortening the period is not in 0.132.
- One run per rung per repeat on a shared machine. A difference of under about 20 % between two rungs is within this
  machine's noise.
