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
| `apps/server/src/main.ts` | The world is wired at module top level with top-level await, so a module script starts only one world. **Done (#2389):** `world-main.ts` `startWorld(config)` boots one world from its own config; `main.ts` runs `startWorld(loadConfig(process.env))` | Form 2 |
| `apps/server/src/world-main.ts` (SIGTERM/SIGINT, `process.exit`, exit 75), `standby.ts` | Stop, planned restart and the standby handover are per process. Workers get no signals, and one world's `process.exit` ends all | Both |
| `apps/server/src/config.ts`, and its direct readers `god/engine-bridge.ts`, `god/world-clock.ts`, `god/governance-edge.ts`, `edge/ledger/ledger.ts` | One `config` per program, read from `process.env` at import. **Done (#2389):** `loadConfig(env)` returns a world's config with its own `env`; the readers take `worldConfig(host)` (`host.config`, set by `startWorld`). The module-level `config` stays as the default for tests and tools only, and `god/versions.ts` reads the program's `build` | Form 2 |
| `apps/server/src/load/shared.ts` (`sharedLoad`), `load/api-times.ts` (`sharedApi`), `load/boot-progress.ts`, `load/clock-source.ts`, `load/stall-log.ts`, `load/monitor.ts`, `load/admission.ts` | Load level, API times, boot phase, the clock view and the stall log: one per program. **Done (#2416):** `newWorldLoad()` gives each world its own shared numbers, API times and boot progress (`BootProgress`); its monitor, admission, watchdog thread, read pool, `live.json` and `/healthz` read them; the clock view rides on each request (`clockNow(c)`), and each world's admission feeds its own stall log. The module-level `sharedLoad`, `sharedApi` and boot slots stay as the default for tests and tools | Form 2 |
| `apps/server/src/load/watchdog.ts`, `load/stall-stack.ts` | The watchdog reports the process pid. The stall stack attaches the inspector to the main thread, so under form 1 it would pause the wrong thread | Both |
| `mars/viewer/engine/locomotion/walk.ts` (`setWalkReach`), `god/poster-boards.ts` (`setWorldDaySource`), `god/ground-host.ts` (`DEEP_MIDDLE` listed whole), `god/context-views.ts` (`closeContextViews`), `world-main.ts` (`globalThis.__soulsReadPool`, `setKitViewerContract`), `mars/viewer/engine/spatial/path.ts` (`strandedMetrics`, served by `http.ts`) | World state in module scope: the last world to set it wins. Walk reach feeds `walk_to` validation, so it touches replay. **Done (#2416):** walk reach is in the world's registry (`groundRegistry(base, groundReach(fact))`, also on a snapshot restore); the world day is read from the world's host (`worldDayOf(host)`) and passed to the boards; the deep middles are per `installGroundCapabilities`; each world closes its own context views; the read pool is returned by `startWorld`. Shared on purpose: `strandedMetrics` is a content-keyed memo (its answer is a function of the grids and goal it is keyed by; the debug counters are the program's), and `setKitViewerContract` follows the viewer bundled with the program's code, the same for every world. `apps/server/src/world-module-state.test.ts` fails on new module-level mutable state | Form 2 |
| `process.env` read after boot: `http.ts`, `auth.ts`, `hub.ts`, `edge/routes.ts`, `edge/eyes/routes.ts`, `god/assets.ts`, `moderation/store.ts`, `god/workbench.ts`, `god/real-clock.ts`, `god/layers.ts`, `god/ground-host.ts`, `edge/ledger/ledger.ts`, `packages/engine-mars/src/engine.ts` | World name, steward token, data paths and rule flags come from the one process env. **Done (#2389):** they read the world's `cfg.env`. What stays is listed by file, with its reason, in `apps/server/src/world-config-reads.test.ts`: import-time measurement switches (the same for every world in a program) and default-parameter fallbacks for tests and tools | Form 2; form 1 only with a per-worker env |
| `apps/server/src/eden-bootstrap.ts` (`edenOriginHistoryFactory`), `packages/engine-mars/src/engine.ts` (`marsCommonsTransitionFactory`), `split/god-replica.ts` (`defaultAssetDir()`) | Calls that take no world env yet: these factories build `marsFactory` from `process.env`, and a read worker's replica finds its asset dir from the program's env. `world-config-reads.test.ts` lists the replica's call and `marsFactory`'s default env. **Done (#2416)** for `edenOriginHistoryFactory` and `marsCommonsTransitionFactory`: they take the world's env (`world-factory.ts` passes it). The Eden life readers (`retainedCommonsShoreFactory` and the other transition factories) and `god-replica.ts` still read the program's | Form 2 |
| `apps/server/src/god/host-render-slot.ts`, `god/look-renderer.ts` | Lock liveness is checked by pid, so a dead world's lock is never stale while the program lives. **Done (#2444, #2469):** a slot is freed only by its own render's end (each caller releases in `finally`), never by its world's stop mid-render; a stopped world's renders end with its stop (its context views abort them), so its slot does not outlive them; still one render at a time on the host | Both |
| Content caches: `packages/engine-mars/src/ground-bridge.ts` (`RECIPES`, `FIELDS`), `catalog-adapter.ts` / `CATALOG`, `mars/viewer/engine/spatial/grid.ts`, `path.ts`, the library and the generator memos | Keyed by content, so sharing them is the point of form 2. But their byte caps become shared, and a registry can let a world resolve a hash it never logged | Shareable |
| `apps/server/src/load/watchdog.ts` (`faultGuard`, `installFaultGuard`), `load/watchdog-worker.ts` (the kill), `world-main.ts` (`/__sim/fault`) (#2366) | One fault guard per program: the `uncaughtException` and `unhandledRejection` handlers cannot tell which world threw, and its storm exit (70) and stopped-clock exit end every world. The watchdog's hard limits end the whole process. **Done (#2444):** each world's guard notes only the errors from its own async context (`installFaultGuard` `mine`); by design a shard has one watchdog thread (`shareWatchdog`) and a fault ends it; the launcher reloads its worlds | Form 2 |
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
| B3 | World state out of module scope: walk reach per engine, world day, the ground middles, context views, the read pool | 3 h | T3 | `mars/viewer/engine/locomotion/walk.ts`, `packages/engine-mars/src/ground-bridge.ts`, `apps/server/src/god/{poster-boards,engine-bridge,ground-host,context-views}.ts`, `world-main.ts` |
| B4 | Env reads after boot become world config fields | 2 h | T2 | the `process.env` readers in the table above |
| B5 | The shard program and the launcher's use of it: load and stop one world by message, one watchdog per shard, a fault ends the shard and its worlds reload, render locks by world, off by default | 4 h | T3 | new `tools/world-launcher/shard.mjs` (from `tools/bench/capacity/colocate/host.mjs`), `tools/world-launcher/{children,registry,production}.mjs`, `apps/server/src/load/watchdog.ts`, `apps/server/src/god/host-render-slot.ts` |
| B6 | Measure the built shard: the `colocate` bench with `--forms shard`, 50 small worlds. **Done (#2451):** [measured](#the-built-shard-measured-b6-2451) | 2 h | T0 | `tools/bench/capacity/colocate/` |

### The shard program (B5, #2444)

`tools/world-launcher/shard.mjs`, off unless the launcher's environment sets `SIM_SHARDS` to the worlds per shard (2 to
8). With it off, `ChildPool` spawns one process per world exactly as before.

- **Placement.** `ChildPool.launch` asks `ShardSet` for the world. A world goes into a shard only when its command is the
  world server's own (`apps/server/src/main.ts`; not a fork, a standby or a world with read workers) and its registry
  entry does not say `shard: false`. Worlds share a shard only when every setting but their own (`PER_WORLD` in
  shard.mjs: name, key, path, port, data dir, owner, zone, health port, load pins) is equal, so no world runs under
  another's settings. The program's heap cap is a world's cap times the shard's size.
- **Load and stop by message.** `{op:'load'}` runs `startWorld(loadConfig(env), {signals: false, exit})` with the world's
  own env; `{op:'stop'}` runs its shutdown (snapshot saved), after which none of its timers, handlers or watchdog entry
  stay in the program: the hub's, the Souls' and the brain's intervals, the real-time clock check, the portrait sweeps
  and the refusal log's count timer are cleared (`world-stop-timers.test.ts`). The requests still open at the end of
  its stop are answered 503 `world.stopping` (or closed, when their answer had begun) and its connections closed, as a
  world process's exit closes them; its stopped code never answers them (#2469, `world-stop-inflight.test.ts`). Each
  world's log lines are tagged in the program and written to its own log.
- **A world still loading** cannot be cut short inside the program. A SIGKILL (a stalled boot, a stop past its grace, a
  handover's settle) drops it instead. Its boot's open wait, the initial projection, ends at once (`startWorld`'s
  `abort`, as SIGTERM ends a process's), and it stops as soon as its boot ends. #2469: a drop never ends its program,
  however long that boot takes (#2444 ended it after 3 s). One writer per data dir: a world's next load is sent to a
  program only once every earlier load of its data dir has exited. A world whose boot fails in a shard clears its
  timers as its stop does.
- **Faults are the world's own.** An uncaught error or rejection is noted by the fault guard of the world whose code it
  came from (its async context, `renderWorld`), never by its neighbours. One from a world still loading is that boot
  failing (exit 70, as a world process would crash); one from no world is logged by the shard and counted against none.
- **Handover.** A world in a shard shares its pid with worlds that run on, so the next launcher does not wait for that pid
  to end: the previous launcher answers the release only once that world's own exit came (`stopChild` refuses to
  report a stop without it).
- **One watchdog per shard.** `shareWatchdog()` starts one thread; each world adds its live.json and health port to it.
  A hang or heap verdict shows in every world of the shard: the world whose tick was running is named in its live.json
  `killed`. When no world's tick is running (a sibling's boot or a long request holds the thread), no world is named:
  naming a serving neighbour would count an innocent world while the culprit reloaded uncounted and could end its next
  shard the same way. With no world named, every world of the shard exits as the crash it was (the breaker counts each)
  and loads again in a program of its own, so a hang that repeats is held.
- **A fault ends the shard.** A fault storm, a clock stopped by a fault, a boot that throws (exit 70) or the watchdog's
  hang or heap rule (SIGKILL) ends the program. The world that ended it exits as the crash it was (the breaker counts
  it) and reloads in a program of its own; the others exit as a planned restart (75) and reload at once, together, in
  a fresh program. Each replays its log to the durable clock frontier it left and catches its clock up. #2469: a
  reload never goes into a shard that runs, since a boot holds its program's thread and stalled the worlds there
  (#2451). The fresh program takes no other world until every world of the group has loaded or exited, or
  `RELOAD_HOLD_MS` (60 s) has passed.
- **The handle.** A world in a shard is a ChildProcess-shaped handle (pid, stdout, stderr, kill, `exit`): SIGTERM stops
  it alone, SIGKILL ends its shard (drops it while it loads, never ending the program), SIGSTOP is refused (a world in a shard is never frozen alone). Its Pss is the
  shard's split between its worlds.

**Proved** (`tools/world-launcher/shard.test.mjs`, loaded workstation): three Eden core worlds in one shard; one stopped
and loaded again while the other two ticked on in the same program; `stop` and `storm` injected into one world each
ended the shard, and all three were serving again in other programs 12.8 s and 15.8 s after the fault, each restored
exactly at its frontier (tick and engine hash), no tick owed. Two worlds in one shard, one held at the red load level:
a god edit in one left the other's entities, edits and owner as they were; each read its own level, day and state
hash, and each restored exactly the state it saved.

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

### The built shard, measured (B6, #2451)

The `colocate` bench with `--forms shard --small 50` runs the shard program (`tools/world-launcher/shard.mjs`) through
the launcher's own `ShardSet`, beside 50 programs of one world each. The bench's settings: commit `7c589c47f`, on
`souls-timed` runners (Linux, Node 22, 48 CPUs, 125.6 GB). It loads 50 fresh `hello-hamlet` worlds with fake minds and
Eyes off, using the launcher's own command and production decoration. Shards hold 8 worlds, so 50 worlds take 7
programs. Every world ticks (`SIM_SKIP=0`), as in #2300; a still world now jumps its clock instead (#2298). That is
the worst case for a shared thread. Every memory reading follows a full GC of every program's heap. Runs: timed-run
43742744860 (both forms), 43742742507 (shard; its baseline arm stopped at world 48, exit 1 at boot) and 43744144947
(the baseline again).

| Form | Programs | Pss of 50 quiet worlds | Per world | Tick p50 / p99, 60,000 ticks pooled | CPU while quiet | Load, median (max) |
|---|---|---|---|---|---|---|
| One program per world | 50 | 11,150 and 11,136 MB | **223 MB** | 0.5 / 2.0 ms | 1.06 cores | 3.6 s (3.9) |
| Shards of 8 | 7 | 5,338 and 5,438 MB | **107 and 109 MB** | 0.3 / 1.6 to 1.7 ms | 0.52 to 0.54 cores | 1.2 s (4.1) |

- A shard holds a small world in about half the memory of a program of its own, including its share of the shard's
  program: 107 MB against 223 MB. #2300 estimated 98 MB per further small world plus about 170 MB per program, which
  comes to 122 MB per world at this size. It also used half the CPU.
- Ticks are not slower in a shard. The worst p99 was 1.7 ms. With a mean tick of 0.3 ms, eight ticking small worlds
  keep their thread busy for about 2.4 ms in every 50.
- A world's first load in a shard is the program's own cold start (4 s). Every further load takes about 1.2 s, against
  3.6 s for a program of its own.

**One more world** (a 51st):

| Form | Load to first `/healthz` | Longest gap the other worlds saw | Pss added |
|---|---|---|---|
| One program per world | 3.5 s | 0.27 s | 324 and 331 MB (15 s after its first answer) |
| Shards of 8 | 0.6 s | 0.38 s, the 2 worlds of its own shard | 83 and 91 MB |

**One world fails** (each fault watched 60 s). In the shard form, every world that exits loads again at once, as the
pool restarts a planned exit. The crash backoff of the world that ended the shard is left out.

| Fault | One program per world | Shards of 8: the 7 other worlds of its shard | Shards of 8: the 43 worlds of the other shards |
|---|---|---|---|
| A step that throws every tick (`storm`, exit 70 at 2.5 s) | The others did not notice (0.40 s) | Down until reloaded: longest gap 4.2 to 4.4 s (81 to 84 failed polls); all serving at the end | Longest gap 2.4 s |
| A 60 s hang (the watchdog's kill at 10.8 s) | The others did not notice (0.39 s) | Longest gap 14.2 to 14.3 s; all serving at the end | Longest gap 2.6 to 3.0 s |

- A shard fails as a whole and comes back in about 4 s after a storm, or about 14 s after a hang, as #2300 expected.
- The worlds of the other shards are not untouched. The 8 reloaded worlds go into programs that still have room, and
  each load holds that program's thread for its boot, which stops its worlds for up to 3 s. Reloading them into a
  fresh program instead would keep the other shards clear. The design already sends an Eden-class load to a fresh
  shard; a fault's reload is not yet treated that way.
- The world that hung was not the one blamed. In every run it exited as a planned restart (75), and a neighbour was
  counted as the crash: the hang ran outside a tick (a timer), where the watchdog names the first world it judged.

**Writing the running world on every callback** (#2445 review item 5, measured, not built): an async hook writes the
running world's number (its `renderWorld` context) into a shared slot before every callback of the program, so a
watchdog could blame the world that holds the thread. With it on (`--callback-slot`, runs 43742801627 and
43742803800), shards of 8 measured 5,334 and 5,360 MB, ticks 0.3 / 1.7 ms (mean 0.4 ms) and 0.53 to 0.55 cores.
Without it: 5,338 to 5,438 MB, 0.3 / 1.6 to 1.7 ms (mean 0.3 ms) and 0.52 to 0.54 cores. Memory, p50 and p99 are
within the spread between runs. The mean tick and the CPU may be up to about 0.1 ms and 0.03 cores higher: at most a
few percent of a quiet shard, and near what different runners of the same kind can tell apart.

### Capacity on the production host: measured for small worlds

These are the same assumptions as the estimates above: quiet fresh worlds, 7.4 GB under today's unit or 12.5 GB with
the whole host. Small worlds use the Pss measured here; Eden worlds were not measured by B6 and keep #2300's estimate.

| Form | Small worlds at 7.4 GB | Small at 12.5 GB | Eden worlds at 7.4 GB (estimate) | Eden at 12.5 GB (estimate) |
|---|---|---|---|---|
| One program per world | about 33 | about 56 | about 14 | about 24 |
| Shards of 8 | **about 69** | **about 117** | about 25 | about 43 |

Shards fit about 2.1 times as many small worlds as programs of their own, slightly more than #2300 estimated (61 and
104).

## A world that does not crash (#2366)

The base the shards need: one world on today's launcher survives its own errors and comes back fast and exactly from a
hang or a memory runaway.

- **Errors are contained.** A tick that throws past the engine's own fault handling (#1150: a listener, the drain, the
  broadcast) is reported through `WorldHost.onFault` and the clock goes on with the next frame. A timer, a rejected
  promise or a request handler that throws reaches the world's fault guard (`load/watchdog.ts` `faultGuard`, installed
  once the world serves; a boot that throws still exits). Each is logged as
  `[world] fault world.fault.<tick|step|uncaught|rejection|request> (n in 60 s): <stack>`, the stack once a minute per
  name; a request gets 500. Each listener's `afterTick` is its own step, caught on its own (`world.fault.step in <step>
  at tick <n>`, the step by a stable identity: its `name`, else a hash of its source), so one bad listener never skips
  the rest of the tick (the other listeners, the broadcast, the heartbeat, the snapshot). The counts by name are in
  `/healthz` `faults`. Fifty in a minute is a broken world: a crash exit (70, never the planned 75, so the launcher's
  breaker counts it and its backoff applies), with the step that threw most of them written to
  `<DATA_DIR>/fault-exit.json` for the next boot. A tick fault that leaves the clock stopped for good (its timer gone, or
  unavailable without a named halt) exits the same way, `world.fault.clock-stopped` or `.clock-unavailable`: an unrunning
  clock owes no ticks, so nothing else would notice. No snapshot is taken on either: the restart replays the log. Engine
  invariant corruption keeps its own handling: rewind, quarantine, a named halt (#1150).
- **Hard limits in the watchdog thread.** It still sees the world while the main thread is stuck. A serving world
  whose main thread has not turned for `SIM_HANG_KILL_MS` (10 s), or whose heap has stayed at `SIM_HEAP_KILL_PCT`
  (95) % of the old-space cap for `SIM_HEAP_KILL_MS` (5 s) while garbage collection took `SIM_HEAP_KILL_GC_PCT` (30) %
  of the last 10 s (it thrashes), is ended with SIGKILL. A steady live set near the cap that collects calmly is left
  alone: a restart would only rebuild it and loop. A rule holds only over two looks in a
  row, and a gap between looks (the process was frozen) starts it again. live.json gets `killed`; the launcher
  restarts the world as `wedged`, and the stall stack (#457, after 2 s) names the frame it was stuck in. A SIGKILL
  loses nothing accepted: acts are logged before they are answered, and the boot replays the log and catches the
  clock up (#2235).
- `SIM_FAULT_INJECT=1` (tests only) adds a loopback `POST /__sim/fault?kind=tick|timer|rejection|request|hang|alloc|leak|stop|storm`,
  and (#2378) `hang-at&tick=N&ticks=K` (a step stuck at ticks N to N+K-1 on every boot), `corrupt` (a Soul's body broken
  in memory) and `disk&mb=N` (the headroom check reads N MB free; no `mb`: the disk again). #2458 adds `throw` (the next
  tick's engine step throws, recovered as an engine fault) and `throw-at&tick=N&replayMs=K` (the step from tick N throws
  on every boot; each tick a recovery replays takes at least K ms, as on a busy world). Every recovery logs one line:
  `[world] recovery hold <ms> ms at tick <t>: <n> replays (<ticks> ticks), …; since the last snapshot …`. The eval's
  load mode injects `throw` with `--fault-every-sec <s>` and reports those lines (`recoveries`).
- **A recovery is bounded (#2458).** An engine error inside a tick replays from the last snapshot on the main thread:
  about 2 s fixed (mostly the engine's restore) plus 4 to 6 ms a replayed tick at 24 to 100 Souls. The snapshot debt
  counts the whole tick, not the engine step alone, which measured 0.6 ms a tick and let 1800 to 4800 ticks build up
  (holds of 8 to 18 s on souls-timed). A jump over still ticks (most of a setup's ticks) adds them at the running
  average whole tick (`tickCostMs`), since a recovery replays each one. So the existing rule (3 s of debt, at most one snapshot per 20 s, capture at
  most 5 % of the time) keeps a busy world's replay to about 20 s of ticks. Under the repair rules, a recovery tries no
  further plan replay after holding 3 s (`RECOVERY_REPLAY_BUDGET_MS`): the last rung, which steps no ticks, ends it.

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
| A thrown error in a tick, a listener's step, a timer, promise or request handler | Logged by name and counted in `/healthz` `faults`; the same process runs on, the other listeners and the broadcast too. 50 in a minute is a crash exit (70) the breaker counts, its step recorded for cause 2 (#2366) | never down; a storm: down 2.6 s, serving at 43 s (workstation) | same process; a storm: frontier tick and hash, log prefix | `tools/world-launcher/crash-proof.test.mjs` |
| A tick fault that leaves the clock stopped (its timer gone, or unavailable without a named halt) | A crash exit (70) the breaker counts; nothing else would notice, as an unrunning clock owes no ticks (#2366) | down 0.3 s, serving at 31 s (workstation) | frontier tick and hash, log prefix | `crash-proof.test.mjs` |
| A hang, a runaway heap | The watchdog's kill (hang 10 s; heap 95 % for 5 s while gc takes 30 %, so a calm live set near the cap is left alone), the launcher's restart, the catch-up (#2366) | 7.5 to 27 s | frontier tick and hash, log prefix, accepted Soul | `crash-proof.test.mjs` |
| 1. Invariant corruption: a Soul's body broken in memory (its pose no number) | quarantine/1 (#1369) holds that body where it last stood whole, by a logged event; everyone else runs on. Edge worlds adopt it at boot; the fault adopts it first on a central-mind world | quarantined 0.14 to 0.18 s after the fault; never down | same process, the hold is in the log | `tools/world-launcher/no-stuck-world.test.mjs` |
| 2. A restart loop: a step that hangs (or storms) on every boot | Each listener's step has a stable identity (its `name`, else a hash of its source), never its place in the list, which changes at runtime. The watchdog's kill names the step the tick was in (`live.json` `killed.step`; a boot-stall kill is named by the last `live.json`; a fault storm by `fault-exit.json`). The same step in two deaths in a row, in one chain (each death within 1200 ticks of the one before plus the window that one had earned; a durable-clock world dies one tick later each boot, as its frontier is written before the listeners): the next boot skips that step from the first of those ticks to 1200 past the last, doubling for each death past two up to 72 000 (`[world] step quarantined: <step> skipped from tick T until tick U`, logged once; glitch `world.step-quarantined`; `/healthz` `quarantine` while it is skipped) | workstation 37.5 s on an Eden core world: a hang kill at tick T, a boot-stall kill at T+1, the third boot skips the step (earlier, by place on a toy world: CI runner 17.5 s) | log prefix kept; the skipped step is a listener's, which changes no engine state | `no-stuck-world.test.mjs` (A2, an Eden core world), `restart-loop.test.ts` |
| 3. A database wait: another process holds the write lock | Each statement waits at most 5 s (`busy_timeout`), then fails: a named halt (`durability.clock-frontier`) the guard restarts (#2133). A tick whose writes wait past the hang limit (10 s) in all ends in the watchdog's kill instead. Either way the launcher restarts the world, and it serves once the lock is gone | 12 s lock, CI runner: halted, serving again at 15.2 s. Workstation: killed at 10.8 s (hang rule), serving at 31 s | frontier tick and hash, log prefix, accepted Soul | `no-stuck-world.test.mjs` |
| 4. The disk filling | Every minute the world reads its free space; under `SIM_DISK_MIN_FREE_MB` (1024) it logs `[load] disk.low`, prunes by the existing retention rules (the hourly backups' rule, brain calls, talk, local takes) and holds its hourly backup. Nothing beyond retention is deleted. A write that still fails is a named halt, restarted by the guard (#2133) | alert and prune at once; never down | same process | `no-stuck-world.test.mjs`, `apps/server/src/load/restart-loop.test.ts` |
| 5. A launcher terminal state | The breaker's `held` is a rest, not an end: it boots again after 10 min, doubling for each hold in a row up to 1 h; an operator's resume ends it sooner. A handover's fence clears the rest's timer: `unfence()` arms it again, and `ensure()` resumes a world whose rest is over. A capacity refusal never ends `failed` (#2367) | the rest | as its restart | `tools/world-launcher/guard.test.mjs` (c2, c3) |
| 6. A recovery that outlasts the hang limit (#2458): an engine error on a busy world replays from its last snapshot on the main thread, past the watchdog's 10 s | A recovery is its own step for the watchdog (`world recovery`, id `2da2deea`). A kill inside one quarantines that step after **one** death (any other step needs two), so the restart meets the same error and contains it where it happens (`[world] world.recovery-quarantined: …`, glitch `world.recovery-quarantined`, the in-place rung: what runs stops, nothing replays) instead of replaying the same stretch again. Before, every restart did, and was killed again: 10 kills, then the breaker's hold | one kill, one restart, the restart's recovery held 2 ms (workstation) | the quarantine and the in-place rung are logged events | `tools/world-launcher/recovery-loop.test.mjs`, `apps/server/src/recovery-bounded.test.ts` |

What is left, named so it is not mistaken for covered:

- A step that is the engine's own (the step, the drain of logged inputs) and hangs or throws on every boot is not
  skipped: skipping it would change world state. It cycles through kills (or storm exits), the breaker's rest and a
  retry; the stall stack names the frame.
- A listener step that still hangs after its quarantine window dies once more and is skipped again for twice the window
  (up to 72 000 ticks, an hour): the world serves between, but that step's work is missing while it is skipped.
- A process that aborts (SIGABRT at V8's heap limit) before its watchdog names a step leaves no step to quarantine; a
  heap that aborts at the same tick on every boot cycles the same way.
