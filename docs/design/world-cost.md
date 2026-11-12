# A universe of worlds: a world costs what moves in it, not its scenery

Design note for a yes or no from the maintainer, under [#1954](https://github.com/soulsimulation/souls/issues/1954).
Nothing here is built. The maintainer, 12 Nov 2026: "it's less about 'how many' worlds and more 'how much stuff'...
why do worlds consume so much memory to begin with?" [#2235](https://github.com/soulsimulation/souls/issues/2235)
makes world time never stop, so every world runs at wall pace whether anyone watches or not. Always-on worlds have
to become cheap.

**Why a world costs so much.** Each world is its own Node process that rebuilds the whole template as live
JavaScript objects: navigation, geometry, about 4,500 entities, caches and a copy of the code. Two worlds made from
one template hold the same bytes twice. About 99 % of a quiet world's state is its template, and a quiet tick still
reads the whole entity table to show that nothing changed.

Sources: memory from [#1973](https://github.com/soulsimulation/souls/issues/1973), limits and wake times from
[#1982](https://github.com/soulsimulation/souls/issues/1982), tick spans from
[#1961](https://github.com/soulsimulation/souls/issues/1961), and the time audit on #2235. Section 1b is a new local
run made for this note. Numbers marked *guess* are estimates, not measurements.

## 1. Where a world's cost goes today

### 1a. Memory: a quiet Eden 2026 world (#1973, macOS workstation, no Souls)

| Part | MB | Shared with another world from the same template? |
|---|---|---|
| Navigation (fine tiles, levels, connectivity) | 71 | buffers (62 MB) byte-identical |
| Entity table, live | 67 | 99.7 % identical until something happens |
| Code and runtime (compiled code, module sources, the TypeScript stripper) | 65 | identical, but each isolate holds its own copy |
| Caches (nav LRU 25, water 9, shape tables 12, layouts, memos) | 56 | mostly, but each world fills its own on demand |
| Page tables | 36 | per process |
| Server objects and framework | 28 | per world |
| Geometry and definitions | 27 | buffers (5.5 MB) byte-identical |
| Recovery copy (a full copy of the runtime at the last snapshot) | 16 | follows the live table |
| Watchdog worker thread | 11 | per process |
| History (batch ring, take recorder) | 10 | per world |
| Malloc outside the heap (SQLite, Node) and other | about 100 | per process |
| **Dirty footprint** | **475** | rss is 1.1 GB; the rest is clean or shared pages |

On Linux the production setting is RSS 717 MB with one resident (`production.mjs`, `WORLD_MALLOC_ENV`). Pss, the
Linux counterpart of the 475 MB footprint, has not been measured on the production host. **That is a question for
the maintainer**: `Pss` from `/proc/<pid>/smaps_rollup` of one quiet Eden world.

**Policy, not physics.** An Eden-class world gets a 2,048 MB heap cap. The unit is capped at `MemoryHigh=8G` and
`MemoryMax=9G`, and no world boots below 2,500 MB free. Together that holds about 9 Eden-class worlds on the 16 GB
host (#1982), and on Linux they bind before the heap caps do.

### 1b. CPU: one quiet tick (new run for this note)

Eden 2026 on the `walkers` bench of #1961 (`slopes.mjs`), with fake minds and Eyes off. The world runs at full pace
(`SIM_UNWATCHED_PACE=1`, which is how #2235 will run every world), for 2,000 ticks with the CPU profiler on. The
machine is a 16-core Apple-silicon workstation under other lanes' load (load average 8–12), so the results are
indicative. This is an empty world: no Souls. A second arm, with 10 idle Souls, was stopped before its window so a
release could have the machine; it remains to be run (task 1).

Over the whole window the mean tick was 4.3 ms, with p50 1.5 ms and p99 33 ms. That includes the nav warm-up after
boot (2.9 s of CPU in the window's first 10 s) and one snapshot tick of 210 ms. After the warm-up, at steady state:

| Steady quiet tick, laptop (ms per tick; nested rows are inclusive and overlap) | ms |
|---|---|
| **Whole tick** (`tickOnce`) | **2.28** |
| Engine step | 1.53 |
| — table identity scans (`sameArray` in `stableIndices`: proving that the 4,500-entity table did not change) | 0.55 |
| — take recorder (the per-tick finish and sample, final-state copy) | 0.74 |
| — refusal copy (`recutV1`) | 0.46 |
| After-tick listeners | 0.65 |
| — lifecycle journal `recover`, which runs every tick with nothing to recover | 0.40 |
| Drain, broadcast, clock, load monitor | about 0.1 |

At 20 ticks/s the steady tick is 4.6 % of a laptop core, which would be about 14 % on the production host at ×3, or **about 7 ms of
the 12 ms**. Almost all of it is work that is O(entities) and proves nothing happened.

**Unexplained: 12 ms in production against 2–3 ms on the bench.** This is the first thing to measure (task 1 below).
The candidates, with the evidence for each:

| Candidate | Evidence | Size, *guess* |
|---|---|---|
| Slower host cores | `relevant.ts`: the same pass took 3 ms on the laptop and about 9 ms on the production host. `load.md`: a read takes 100–300 ms on the production host against 33 ms on the laptop | ×3 |
| Residents and natives | Production Eden has Souls, and every bench quiet arm so far has none. For each Soul, `advanceLives` runs needs and an O(Souls²) proximity test every tick, and an idle Soul gets an ambient act within 400 ticks | unmeasured (task 1) |
| Snapshots and the recovery copy | one snapshot tick took 210 ms here, and snapshots come about every 400 ticks with activity (#1961) | +0.5 ms on the laptop |
| Nav re-warm | the warm-up after boot cost 2.9 s of CPU in 10 s; in a long-running world the 25 MB connectivity LRU may evict and recompile | unknown |
| Viewers, broadcast, Eyes, a 2 GB heap's GC | not modelled on any bench | unknown |

## 2. Designs

The rule throughout is the engine contract: a fixed tick, the world RNG, and replay to the same state. #2235's
equivalence bar applies to every design. A run with the design and a tick-by-tick run must reach the same state hash,
and where they don't, the world keeps ticking.

| # | Design | Saves | Risks | Smallest first step |
|---|---|---|---|---|
| **D1** | **A quiet tick costs O(changes).** A table version that every add, remove, replace and field write bumps replaces the per-tick identity scans (`sameArray` via `stableIndices`, `relevantEntities`, the recorder's final-state copy, `recutV1`'s refusal copy). The lifecycle journal's `recover` runs only when the journal has entries. | The scans, the recorder copy and the refusal copy are about 1.5 ms and the journal 0.4 ms of a steady 2.3 ms laptop tick. Target: under 0.5 ms on the laptop, about 2 ms on the production host (*guess*) | A write that skips the version bump gives a stale memo, and the world diverges. Mitigation: a debug mode re-runs the old scan and asserts, and golden takes stay byte-identical | One counter on `WorldState.entities` writes, with `stableIndices` keyed on it. Measure the step ms on idle0 |
| **D2** | **Exact needs in closed form.** A need is stored as an anchor `(value, tick, rate)`, and `need(t) = clamp(value + rate·(t − tick)/dayTicks)` is evaluated from the anchor. The anchor resets only when activity, company or nourishment changes, and those are events. Stepping and skipping then compute the same expression and give the same bits. Integer fixed point (units of 1/dayTicks) works too | Makes skipping possible for worlds with Souls. Also drops `advanceLives`' per-tick O(Souls²) proximity test to event time | The trajectory moves by float rounding once: a deliberate golden change in its own reviewed commit. The company test needs proximity events (enter or leave 4 m), which the engine already has for bodies | `advanceNeeds` from an anchor, plus a test that 400 single steps and one evaluation are bit-identical |
| **D3** | **Skip to the next event.** Every deadline (kernel `until`, receipts, weather `until`, calendar, expiries, snapshot, `ambientLife`'s 400-tick idle mark, day and phase boundaries) goes into one timer wheel keyed by tick. When nothing moves, no programme runs and no RNG is drawn before T, `skipTo(T)` sets the tick and nothing else, and everything that is a pure function of time is read lazily. The wall-keyed `body-rule.ts` timers move to ticks first (#2235 audit) | An empty world: about 100 % of its tick CPU. A world whose Souls all sleep: the same until the next wake. A world with awake idle Souls: little, because an ambient act comes at least every 20 s and walking must be stepped | Any time-dependent state missing from the wheel breaks equivalence. Mitigation: #2235 A5′, the same seed ticked and skipped must give equal hashes, run in CI on an empty world, a sleeping world and a native world | `quietUntil()` on the engine, *read-only*, logged next to each tick. It proves the horizon before anything skips |
| **D4** | **Hibernate on a proven horizon.** When D3's horizon is more than a few minutes away, the launcher exits the world and wakes it at T or on the next request, and the boot runs `skipTo` | Memory and CPU drop to zero while the world hibernates. An empty or sleeping world then costs only disk | A wake is a cold boot (6.8 s median, worst 22 s, #1982). A template pack (D6) makes it cheaper | The launcher reads `quietUntil` and exits only when the horizon is more than 10 min away |
| **D5** | **Scenery as packed data.** About 4,400 of Eden's 4,500 entities are plain fixtures (`relevant.ts`). They become columns in typed arrays and are made into objects on first write (copy-on-write). The recovery copy keeps only the objects | Entity table 67 → about 20 MB, recovery copy 16 → about 4 MB (*guess*), about 60 MB per world | Iteration order, snapshot bytes and take bytes must not change: the packed table must list in the same order and serialize the same. This is engine work, so T3 | Measure first: pack Eden's plain fixtures offline and report their bytes as objects against columns |
| **D6** | **Template packs.** The template's compiled navigation, geometry and packed scenery are built once per template revision into one binary file. A world loads the file instead of rebuilding | Boot CPU, *guess* a few seconds of the 6.8 s cold boot, which makes D4 cheap. Also the base for D7 | A stale pack after a def revision. Mitigation: key the pack on the template and library hashes, and on a mismatch rebuild as today | Time the boot by phase, to see how much of 6.8 s is nav build |
| **D7** | **Worlds as worker threads of one process, sharing the template.** One process per template group, one worker per world, each world on its own thread and event loop. The pack's buffers live in `SharedArrayBuffer`s and are read-only. A world that edits a tile copies only that tile (copy-on-write) | Per world: nav buffers 62, geometry 5.5, packed scenery about 15, page tables about 30, watchdog 11 (one per process), malloc arenas about 30 (*guess*). About 150 MB | Isolation: a JS fault or a heap-limit kill (`resourceLimits`) ends one worker, and the supervisor restarts it from its snapshot. A native crash takes the whole group, so the group size is the blast radius. Code (65 MB) stays per isolate | Two Eden worlds as workers in one process with shared nav buffers. Measure Pss for the pair against two processes, then kill one worker and watch the other keep ticking |
| **D8** | **Endgame: shards of k worlds per isolate.** One thread runs k worlds, and code, definitions and caches are shared by content. Each world holds only its diff over the template plus its Souls | Per quiet world, *guess* 60–100 MB in all | No per-world V8 heap limit, so one world's runaway allocation can bring down its shard. One world's long tick delays the others on its thread, so it needs D1 and per-world tick budgets first. Module-level registries (`CATALOG`) become shared state | Only after D1, D3 and D7, and only if D7's numbers say it is needed |

Rejected: **a slower clock for unwatched worlds** (today's quarter pace), because #2235 forbids it, and
**approximate catch-up**, because the maintainer set the bar at equivalence.

## 3. Capacity on the current 16 GB host

Assumptions:

- An Eden-class quiet world takes 717 MB on Linux today, the RSS from `production.mjs`; Pss may be lower.
- The memory budget for worlds is 7.4 GB under today's unit (8 GB `MemoryHigh` less the 768 MB floor), or 12.5 GB if
  policy gives worlds the whole host less 3.5 GB.
- CPU: 8 vCPU (Hetzner's listing for cpx42; the repo does not state it), with 6 cores for ticks.
- A quiet tick is 12 ms in production, so 0.24 of a core at 20 ticks/s.
- A walking Soul costs 0.38 ms per tick on the laptop (#1961), about 1.1 ms on the production host, which is 0.023 of a core. That
  is a world's whole tick budget at about 35 walkers.
- An idle Soul's cost and a Soul's memory (*guess*: a few MB) are unmeasured.
- The Souls column gives the walking Souls the CPU left over can carry, with the budget column's worlds running.

Each row includes the rows above it.

| Step | Memory per quiet world | Quiet tick in production | Worlds at the 7.4 GB budget | Worlds at 12.5 GB | Worlds by CPU | Walking Souls by CPU (7.4 GB worlds) | Binds first |
|---|---|---|---|---|---|---|---|
| Today | 717 MB | 12 ms | **10** | 17 | 25 | 155 | memory |
| Admit by measured Pss, if Pss ≈ 500 MB | 500 | 12 ms | 14 | 25 | 25 | 115 | memory |
| D1 quiet tick O(changes) | 717 | about 2 ms *guess* | 10 | 17 | 150 | 240 | memory |
| D2–D4 exact skip and hibernation | 717 while awake, 0 hibernated | 0 while skipping | 10 awake, plus any number hibernated | 17 awake | 150 awake | 240 | memory, awake worlds only |
| D5 packed scenery, D6 packs | about 640 *guess* | about 2 ms | 11 | 19 | 150 | 240 | memory |
| D7 workers sharing the template | about 490 *guess* | about 2 ms | 15 | 25 | 150 | 235 | memory |
| **All, with D8** | **60–100 *guess*** | about 2 ms | **75–120** | **125–200** | 150 | 50–130 | **CPU** |

Read the table this way. The steps that keep one isolate per world (D5–D7) only reach about 1.5×. The 65 MB of code,
the per-world server state and the caches stay per world. Two things change the shape:

- **Hibernation (D4).** A world where nothing moves costs nothing, so the limit becomes worlds with something moving
  in them, not worlds that exist.
- **Shards (D8).** A world becomes its diff.

Both depend on D1 and D3. CPU is the second wall under always-on: 25 worlds today, and D1 lifts it furthest.

## 4. Recommended order

Each task is bounded. A ceiling is a limit, not a target.

| # | Task | Ceiling | The measurement that proves it |
|---|---|---|---|
| 1 | **Explain 12 ms against 2.6 ms.** Add an idle-Souls arm to the `walkers` bench: full pace, 0 and 10 joined Souls that never act, a few lines in `slopes.mjs`. Run it here and on a production-class box, the souls-timed executor (#1943) or one the maintainer names. Production itself is never touched. The maintainer reads `/healthz` `load.quietTickMs`, the Soul count and Pss of one quiet Eden world on the host | 2 h | A table that accounts for at least 80 % of the 12 ms by CPU class, Souls, snapshots and viewers |
| 2 | **D1, the table version.** Replace the per-tick identity scans with a version counter | 3 h | idle0 steady step ms falls by at least 30 % (`sameArray` alone is about a third of the step). Golden takes are byte-identical and the walk gate stays green |
| 3 | **D1, the recorder and the journal.** The per-tick take finish and the refusal copy touch only changed entities, and `recover` runs only when the journal has entries | 3 h | idle0 steady tick at most half of today's, with the same goldens |
| 4 | **D2, needs from an anchor.** The golden change goes in its own commit | 3 h | 400 single steps and one evaluation give bit-identical needs. #2235's A5′ hash test passes for a world with Souls |
| 5 | **D3, read-only horizon.** `quietUntil()` is logged per tick, and nothing skips yet | 3 h | Over one hour of an empty and a sleeping world, every logged horizon is confirmed by the ticked run: no state change and no RNG draw before it |
| 6 | **D3 and D4, skip and hibernate.** Skip empty and sleeping worlds, and let the launcher exit past a 10 min horizon | 4 h | A5′ hash equality for skipped against ticked runs. The CPU per wall hour of an empty world falls by at least 90 % |
| 7 | **D7 spike.** Two Eden worlds as workers with shared nav buffers | 4 h | Pss of the pair against two processes. Killing one worker leaves the other at full tick service |

D5, D6 and D8 come after task 7, depending on what it measures. Task 1 is first because a cheaper quiet tick is the
precondition for everything after it, and the cost it would save is still unexplained.
