# Capacity runs

The published capacity runs of the new engine, newest first. Each run gives the machine, the agents (M) and intents a
second (N) one world carried, the viewers (Q) it served, each limit's measured value, and which limit gave way first.
Why and how to measure is in [scaling](scaling.md). These are measurements of one build on one machine. They are not
promises.

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
