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

**Form 1 without the shared template.** Form 1 ran without its navigation and geometry held once and shared read-only. Sharing them means building the navigation on `SharedArrayBuffer`s, which is a product change and more than a bench can do. #1973 measured the byte-identical buffers of an Eden world at about 68 MB: navigation 62 and geometry 5.5. The same-shaped objects, about 30 MB, cannot be shared between isolates. With sharing, form 1 is *estimated* at about 420 MB for each further Eden world and still about 220 MB for a small one. That is 15 % below the baseline for Eden, and it does not change the recommendation.

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
| `apps/server/src/load/watchdog.ts` (`faultGuard`, `installFaultGuard`), `load/watchdog-worker.ts` (the kill), `main.ts` (`/__sim/fault`) (#2366) | One fault guard per program: the `uncaughtException` and `unhandledRejection` handlers cannot tell which world threw, and its storm restart (exit 75) ends every world. The watchdog's hard limits end the whole process | Form 2 |
| `apps/server/src/god/edit-preview.ts` (`live`, `pending`) | One preview worker and `PREVIEW_MAX_PENDING` (2) per program: one world's previews refuse another's | Form 2 |
| `apps/server/src/edge/ledger/vocabulary.ts` (`knownMemo`, `synonymWords`, `stepVerbs`), `god/mirror.ts` (`lastGroundHashed`) | One-slot memos. Keyed by their input, so never wrong, but two worlds taking turns rebuild them every call | Form 2 (cost) |
| `apps/server/src/moderation/classifier.ts` (`selected`), `god/context-timing.ts` (`emitted`) | The upload classifier and the timing budget are per program | Form 2 |

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

## A world that does not crash (#2366)

The base the shards need: one world on today's launcher survives its own errors and comes back fast and exactly from a
hang or a memory runaway.

- **Errors are contained.** A tick that throws past the engine's own fault handling (#1150: a listener, the drain, the
  broadcast) is reported through `WorldHost.onFault` and the clock goes on with the next frame. A timer, a rejected
  promise or a request handler that throws reaches the world's fault guard (`load/watchdog.ts` `faultGuard`, installed
  once the world serves; a boot that throws still exits). Each is logged as
  `[world] fault world.fault.<tick|uncaught|rejection|request> (n in 60 s): <stack>`, the stack once a minute per name;
  a request gets 500. Fifty in a minute is a broken world: a planned restart (snapshot, exit 75). Engine invariant
  corruption keeps its own handling: rewind, quarantine, a named halt (#1150).
- **Hard limits in the watchdog thread.** It still sees the world while the main thread is stuck. A serving world
  whose main thread has not turned for `SIM_HANG_KILL_MS` (10 s), or whose heap has stayed at `SIM_HEAP_KILL_PCT`
  (95) % of the old-space cap for `SIM_HEAP_KILL_MS` (5 s), is ended with SIGKILL. A rule holds only over two looks in a
  row, and a gap between looks (the process was frozen) starts it again. live.json gets `killed`; the launcher
  restarts the world as `wedged`, and the stall stack (#457, after 2 s) names the frame it was stuck in. A SIGKILL
  loses nothing accepted: acts are logged before they are answered, and the boot replays the log and catches the
  clock up (#2235).
- `SIM_FAULT_INJECT=1` (tests only) adds a loopback `POST /__sim/fault?kind=tick|timer|rejection|request|hang|alloc|leak`,
  and (#2378) `hang-at&tick=N` (a step stuck at tick N on every boot), `corrupt` (a Soul's body broken in memory) and
  `disk&mb=N` (the headroom check reads N MB free; no `mb`: the disk again).

**Measured** (`tools/world-launcher/crash-proof.test.mjs`): a real fake-mind Eden core world with its durable clock,
under the launcher's `ChildPool`, a 5 s hang limit and a 768 MB heap cap. The workstation was loaded (load average 28 on
16 cores), so the boots are slower than a runner's (#2300: 3 s small, 13 s Eden).

| Fault | Fault to process gone | Fault to serving again | Ended by | Exact |
|---|---|---|---|---|
| Tick, timer, promise, request handler throws | not ended | not ended | | Same process, still ticking |
| 10-minute busy loop | 5.7 s | 21.5 s | hang rule | Log prefix kept; boot hash = live frontier hash (tick 44); 656 ticks caught up in 9.6 s |
| Runaway allocation in one turn | 5.6 s | 24.4 s | hang rule (GC thrash) | Same (tick 703); 709 ticks in 11.5 s |
| Heap growing across turns | 10.7 s | 27.2 s | heap rule, 733 of 864 MB | Same (tick 1447); 562 ticks in 8.0 s |

"Exact" is asserted each time: every event logged before the fault is in the log after the restart, in order, with
the Soul admitted before the faults; the restarted boot's engine hash at the frontier tick equals the hash the live
world wrote to its durable clock frontier before it was killed; and no replay difference is logged. The catch-up ran
every tick it owed. Earlier runs at load 25 caught up at 3 ticks a second and stopped after 32 rounds with ticks owed
(#2235's limit), so an overloaded host still loses clock time on a restart. Without a heap cap, the same leak ran 45 s
to 3.9 GB before the heap rule ended it. With the default 10 s limit, a hang ends about 5 s later than above.

The same test on a GitHub-hosted CI runner (run 43638957576): the hang was gone at 5.6 s and serving again at 7.5 s,
with 154 ticks caught up in 0.4 s. The one-turn runaway and the growing heap reached V8's own heap limit first and
aborted (SIGABRT) at 13.1 s and 16.0 s; they were serving again at 16.9 s and 20.4 s. That is the same recovery path,
and exact by the same checks. On that runner's heap the heap rule is a backstop, not the first to act.

For the shards (B5), every limit here ends the whole program, as the table above (A4) says: one world's hang, heap or
fault storm ends its shard, and the launcher reloads all of its worlds.

## A world that never stays stuck (#2378)

Every freeze cause known, its recovery, and the test that injects it. A world comes back by itself in each one: no one
is paged. Times are from the fault to the world serving again, measured on the loaded workstation (load average about
20 on 16 cores; a cold boot there takes 9 to 20 s, a runner's 3 to 13 s, #2300).

| Cause | Recovery | Measured | Exact | Test |
|---|---|---|---|---|
| A thrown error in a tick, timer, promise or request handler | Logged by name; the same process runs on; 50 in a minute is a planned restart (#2366) | never down | same process | `tools/world-launcher/crash-proof.test.mjs` |
| A hang, a runaway heap | The watchdog's kill (hang 10 s, heap 95 % for 5 s), the launcher's restart, the catch-up (#2366) | 7.5 to 27 s | frontier tick and hash, log prefix, accepted Soul | `crash-proof.test.mjs` |
| 1. Invariant corruption: a Soul's body broken in memory (its pose no number) | quarantine/1 (#1369) holds that body where it last stood whole, by a logged event; everyone else runs on. Edge worlds adopt it at boot; the fault adopts it first on a central-mind world | quarantined 0.14 to 0.18 s after the fault; never down | same process, the hold is in the log | `tools/world-launcher/no-stuck-world.test.mjs` |
| 2. A restart loop: a step that hangs at the same tick on every boot | The watchdog's kill names the step the tick was in (`live.json` `killed.step`; a boot-stall kill is named by the last `live.json`). Two deaths in a row at the same step of the same tick: the next boot skips that step at that tick (`[world] step quarantined: afterTick[i] (frame) skipped at tick T`, glitch `world.step-quarantined`) | 35 s: two kills at a 3 s hang limit, three boots | log prefix kept; the skipped step is a listener's, which changes no engine state | `no-stuck-world.test.mjs` (A2) |
| 3. A database wait: another process holds the write lock | Each statement waits at most 5 s (`busy_timeout`), then fails: a named halt (`durability.clock-frontier`) the guard restarts (#2133). A tick whose writes wait past the hang limit (10 s) in all ends in the watchdog's kill instead. Either way the launcher restarts the world, and it serves once the lock is gone | 12 s lock, CI runner: halted, serving again at 15.2 s. Workstation: killed at 10.8 s (hang rule), serving at 31 s | frontier tick and hash, log prefix, accepted Soul | `no-stuck-world.test.mjs` |
| 4. The disk filling | Every minute the world reads its free space; under `SIM_DISK_MIN_FREE_MB` (1024) it logs `[load] disk.low`, prunes by the existing retention rules (the hourly backups' rule, brain calls, talk, local takes) and holds its hourly backup. Nothing beyond retention is deleted. A write that still fails is a named halt, restarted by the guard (#2133) | alert and prune at once; never down | same process | `no-stuck-world.test.mjs`, `apps/server/src/load/restart-loop.test.ts` |
| 5. A launcher terminal state | The breaker's `held` is a rest, not an end: it boots again after 10 min, doubling for each hold in a row up to 1 h; an operator's resume ends it sooner. A capacity refusal never ends `failed` (#2367) | the rest | as its restart | `tools/world-launcher/guard.test.mjs` (c2) |

What is left, named so it is not mistaken for covered:

- A step that is the engine's own (the step, the drain of logged inputs) and hangs at the same tick on every boot is
  not skipped: skipping it would change world state. It cycles through kills, the breaker's rest and a retry; the
  stall stack names the frame.
- A process that aborts (SIGABRT at V8's heap limit) before its watchdog names a step leaves no step to quarantine; a
  heap that aborts at the same tick on every boot cycles the same way.
