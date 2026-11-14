# World cost

## Several worlds in one program (#2300)

Today every world in memory is its own program. About 210 MB of each is the program rather than the world (#1973):
code, the runtime's memory outside its heap, page tables and the watchdog thread. #2300 tried two ways of holding
several worlds in one program and measured them beside today's form:

- **Baseline.** One program per world, as today.
- **Form 1, threads.** One program, each world on its own worker thread with its own V8 isolate, env and heap limit.
  This is design D7 without the shared template buffers.
- **Form 2, one thread.** One program, every world on one thread. The modules are loaded once and shared: code,
  definitions and content caches. This is design D8.

The bench is `tools/bench/capacity/colocate/colocate.mjs` (timed-run command `colocate`). It is measurement code and
the launcher never uses it. Form 2 runs `main.ts` once per world under its own query string and refills the one
`config` object before each world loads.

**Run.** Commit `1b6861c51`, timed-run 43596287431 on a `souls-timed` runner: Linux, Node 22, 6 own cores of a
48-CPU host, load 0.84 at the start. The same six worlds in each form: four from `hello-hamlet`, two Eden 2026. All
fresh genesis, fake minds, Eyes off, the launcher's own command and production decoration. Every memory read follows
a full GC of every world's heap. A second run (43593412253, no forced GC) agrees except for form 2's settled total:
without a forced GC its single 12 GB heap limit let 600 MB of garbage wait.

### Memory: Pss in MB

| Form | Six worlds, quiet | Six, plus one Soul walking in a small world and one in an Eden world | Small world: first · each further | Eden world: first · second |
|---|---|---|---|---|
| Baseline | 2,064 | 2,318 | 260 · 255 | 547 · 493 |
| Form 1, threads | 1,954 | 2,164 | 271 · 225 | 508 · 484 |
| Form 2, one thread | **1,294** | **1,558** | 267 · **98** | 338 · **255** |

For the baseline, each world's figure is its program's Pss; Pss already splits the binary's shared code pages between
the programs. For the forms, a world's figure is how much the program's Pss rose when that world loaded. The first
world includes the program.

- Form 1 saves about 30 MB per world (5 to 12 %). Each isolate still compiles and holds its own code and server
  state.
- Form 2 saves about 155 MB per further small world and 240 to 290 MB per Eden world. A program of six holds 37 %
  less than six programs.

### Tick time: ms per tick, p50 / p99, 1,200 ticks in 60 s

| Form | Small world, quiet | Small world, while e1 is busy | Eden e2, quiet | Eden e2, while e1 is busy | e1 busy (10 walkers) |
|---|---|---|---|---|---|
| Baseline | 0.4 / 1.7 | 0.4 / 1.8 | 2.9 / 32.8 | 2.8 / 35.2 | 9.3 / 90.7 |
| Form 1 | 0.3 / 1.6 | 0.4 / 1.8 | 3.0 / 32.7 | 2.9 / 37.6 | 8.8 / 87.6 |
| Form 2 | 0.2 / 1.3 | 0.2 / 1.0 | 2.3 / 40.3 | 2.7 / 36.7 | 6.8 / 77.1 |

On six cores, no form slows one world's tick because another world is busy. Every world kept 20 ticks a second. In
form 2 the ticks are shorter because the code is warm and shared. But the worlds take turns on one thread, so the
thread's load is the sum of their ticks: here about 12 ms in every 50 ms. A world's tick is not slowed until that
sum nears 50 ms; after that, every world on the thread is late.

### Loading one more world

| Form | Small world: seconds to first `/healthz` | Eden world: seconds | Longest gap in the other worlds' `/healthz` while the Eden world loaded |
|---|---|---|---|
| Baseline | 3.07 | 13.18 | 0.28 s |
| Form 1 | 2.57 | 12.38 | 0.26 s |
| Form 2 | **0.84** | 11.45 | **12.0 s (84 failed polls)** |

In form 2 a world loads fast because the code is already compiled. But the load runs on the shared thread, and an
Eden-class load stops every other world on it for about 12 s.

### One world fails: what the others saw over the next 30 s

| Fault in one world | Baseline | Form 1 | Form 2 |
|---|---|---|---|
| Uncaught exception | That program exits. The others don't notice (longest gap 0.2 s) | That thread ends, the program stays up. The others don't notice (0.4 s) | **The program exits within 0.4 s and every world goes with it** |
| Runaway allocation | The world's heap fills toward its own limit and the others don't notice | The thread is stopped at its own heap limit after 11 s (`ERR_WORKER_OUT_OF_MEMORY`). The others don't notice (0.4 s) | No limit for one world: the shared heap grows toward the program's limit. The others saw 1 s gaps, and then the whole program dies |
| A 15 s tick | Only that world stalls | Only that world stalls (others 0.4 s) | **Every world stalls for 16.5 s** |

Seen on the way, form 2 locally: one world's load-level planned restart (`black for 60 s`, exit 75) ended every world
in the program. The load gauges are one per program.

### What assumes one world per program (A4)

| Where | What | Breaks |
|---|---|---|
| `apps/server/src/main.ts` | The world is wired at module top level with top-level await, so a module script starts only one world | Form 2 |
| `apps/server/src/main.ts` (SIGTERM/SIGINT, `process.exit`, exit 75), `standby.ts` | Stop, planned restart and the standby handover are per process. Workers get no signals, and one world's `process.exit` ends all | Both |
| `apps/server/src/config.ts`, and its direct readers `god/engine-bridge.ts`, `god/world-clock.ts`, `god/governance-edge.ts`, `edge/ledger/ledger.ts` | One `config` per program, read from `process.env` at import | Form 2 |
| `apps/server/src/load/shared.ts` (`sharedLoad`), `load/api-times.ts` (`sharedApi`), `load/boot-progress.ts`, `load/clock-source.ts`, `load/stall-log.ts`, `load/monitor.ts`, `load/admission.ts` | Load level, API times, boot phase, the clock view and the stall log: one per program | Form 2 |
| `apps/server/src/load/watchdog.ts`, `load/stall-stack.ts` | The watchdog reports the process pid. The stall stack attaches the inspector to the main thread, so under form 1 it would pause the wrong thread | Both |
| `mars/viewer/engine/locomotion/walk.ts` (`setWalkReach`), `god/poster-boards.ts` (`setWorldDaySource`), `god/ground-host.ts` (`DEEP_MIDDLE` listed whole), `god/context-views.ts` (`closeContextViews`), `main.ts` (`globalThis.__soulsReadPool`) | World state in module scope: the last world to set it wins. Walk reach feeds `walk_to` validation, so it touches replay | Form 2 |
| `process.env` read after boot: `http.ts`, `auth.ts`, `hub.ts`, `edge/routes.ts`, `edge/eyes/routes.ts`, `god/assets.ts`, `moderation/store.ts`, `god/workbench.ts`, `god/real-clock.ts`, `god/layers.ts`, `god/ground-host.ts`, `edge/ledger/ledger.ts`, `packages/engine-mars/src/engine.ts` | World name, steward token, data paths and rule flags come from the one process env | Form 2; form 1 only with a per-worker env |
| `apps/server/src/god/host-render-slot.ts`, `god/look-renderer.ts` | Lock liveness is checked by pid, so a dead world's lock is never stale while the program lives | Both |
| Content caches: `packages/engine-mars/src/ground-bridge.ts` (`RECIPES`, `FIELDS`), `catalog-adapter.ts` / `CATALOG`, `mars/viewer/engine/spatial/grid.ts`, `path.ts`, the library and the generator memos | Keyed by content, so sharing them is the point of form 2. But their byte caps become shared, and a registry can let a world resolve a hash it never logged | Shareable |

### Recommendation

Build form 2 as **shards**: one program holding up to *k* worlds. Form 1 saves only 5 to 12 % because each isolate
keeps its own code and state, and that does not pay for a supervisor. Form 2 roughly halves an Eden world and
divides a small one by 2.6. But its failures are shared, so a shard has to be built to fail as a whole and come back
exactly:

- A shard holds quiet worlds, at most 8.
- An Eden-class load goes to a shard of its own, or to a fresh shard, never into one where worlds are moving.
- A fault, a black load level or one world's long tick ends the shard. The launcher reloads its worlds, and they
  catch up exactly (#2235).
- Per-world tick time is watched, and the world that holds the thread is named.

| # | Task | Ceiling | Tier | Touches |
|---|---|---|---|---|
| B1 | A world is a function. `main.ts` → `startWorld(config)`, `config.ts` → `loadConfig(env)`, and the direct `config` readers take the world's own | 4 h | T3 | `apps/server/src/main.ts`, new `apps/server/src/world-main.ts`, `config.ts`, `god/engine-bridge.ts`, `god/world-clock.ts`, `god/governance-edge.ts`, `edge/ledger/ledger.ts`, `god/versions.ts` |
| B2 | Load gauges per world: `sharedLoad`, `sharedApi`, boot progress, clock source, stall log | 3 h | T2 | `apps/server/src/load/*.ts`, `apps/server/src/http.ts` |
| B3 | World state out of module scope: walk reach per engine, world day, the ground middles, context views, the read pool | 3 h | T3 | `mars/viewer/engine/locomotion/walk.ts`, `packages/engine-mars/src/ground-bridge.ts`, `apps/server/src/god/{poster-boards,engine-bridge,ground-host,context-views}.ts`, `main.ts` |
| B4 | Env reads after boot become world config fields | 2 h | T2 | the `process.env` readers in the table above |
| B5 | The shard program and the launcher's use of it: load and stop one world by message, one watchdog per shard, a fault ends the shard and its worlds reload, render locks by world, off by default | 4 h | T3 | new `tools/world-launcher/shard.mjs` (from `tools/bench/capacity/colocate/host.mjs`), `tools/world-launcher/{children,registry,production}.mjs`, `apps/server/src/load/watchdog.ts`, `apps/server/src/god/host-render-slot.ts` |
| B6 | Measure the built shard: the `colocate` bench with `--forms shard`, 50 small worlds | 2 h | T0 | `tools/bench/capacity/colocate/` |

### Capacity on the production host: estimates

These are estimates from this runner's Pss. They assume quiet fresh worlds, a 16 GB host, 7.4 GB for worlds under
today's unit or 12.5 GB with the whole host, and shards of 8. Form 2's shard cost is the program (about 170 MB) plus
98 MB per small world, or plus 338 MB for the first Eden world and 255 MB for each further one.

| Form | Small worlds at 7.4 GB | Eden worlds at 7.4 GB | Small at 12.5 GB | Eden at 12.5 GB |
|---|---|---|---|---|
| Baseline | about 29 | about 14 | about 49 | about 24 |
| Form 1 | about 32 | about 15 | about 55 | about 25 |
| Form 2, shards | **about 61** | **about 25** | **about 104** | **about 43** |

Joined Souls add memory in every form. The first walking Soul in a small world and one in an Eden world added 210 to
260 MB here. Moving bodies are what the host's memory limits once still worlds unload (#2241).
