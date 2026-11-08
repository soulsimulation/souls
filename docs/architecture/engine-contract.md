# The engine contract

`packages/engine-contract` is the seam between the world server and any engine. Two engines implement it: the Mars
adapter (`packages/engine-mars`, `ENGINE=mars`, used by every launcher world) and the toy engine
(`packages/engine-toy`, the default when `ENGINE` is unset). Names mirror the Mars engine
([Mars engine overview](../mars/README.md)).

## Shared types

| Here | Mars source |
|---|---|
| `WorldState`, `Entity`, `Region`, `Pose`, `Environment`, `physicalView` (`world.ts`) | `world/types.ts` |
| `hashOf`, `stableStringify`, `sha256` (`hash.ts`) | `core/hash.ts` |
| `RngState`, `seedRng` (`rng.ts`) | `core/rng.ts` |
| `Runtime`, `DT = 1/20`, `RuntimeEvent`, `Invariant` (`runtime.ts`) | `runtime/runtime.ts` |
| `ActionDef`, `ActionRecord`, `Diagnostic`, `Reservation` (`actions.ts`) | `actions/types.ts` |
| `createRegistry`, `describeVerbs`, `jsonSchemaOf` (`registry.ts`) | `api/registry.ts` |
| `PoseSample = [tick, x mm, y mm, z mm, yaw mrad]` | `take/types.ts` |

## What the server needs from an engine (`engine.ts`)

```ts
interface Engine {
  rulesVersion: string; dt: number; schema: string;
  runtime: RuntimeView; world: WorldState;
  describeVerbs(): VerbInfo[];                         // { verb, description, inputSchema, scope? }
  stateHash(): string; physicalHash(): string;
  step(): { paths; changes; events; programs; refusals? };  // what changed this tick, for broadcast and the host
  perform(program): { id; ok; diagnostic? };           // start a program, replacing what the actor was doing
  stop(programId, opts?): void;                        // request a stop; committed physical work may finish safely;
                                                       // {untilSafe} keeps the programme until its native cleanup lands,
                                                       // retrying a refused cancel while the action moves
  canPerform(program): { code; message } | null;       // is the first step feasible now? no side effects
  programOf(actor): string | null;
  submit(verb, params, opts?); cancel(id, reason?);
  snapshot(): EngineSnapshot;                          // opaque to the server except { format, tick, stateHash }
  spawnHuman({ id, label, soul }): string; removeEntity(id): void;
  anchors(): Anchor[];                                 // regions and named places; stable ids
  describeSurroundings(actorId); regionAt(p); poseSampleOf(id); currentPath(id);
  enumerateActivities(actorId, intent);                // toy tests only
}
interface EngineFactory { rulesVersion; genesis(seed); create(world); restore(snap); canRestoreSnapshot?; canReplayHistory? }
```

Optional hooks cover recorded takes and scenes (`takeChunks`, `renderScene`, `takeScene`), snapshots and checkpoints
(`canSnapshot`, `captureSnapshot`, `captureCheckpoint`, `compact`), clocks and policies (`configureClock`,
`configureRuntimePolicy`, `beginQuiet`, `isQuiet`), body assignment (`assignBodyV1`), admission previews
(`previewAdmission`) and a set of paired `preview*V1` / `adopt*V1` transitions that add authored content to an existing
world as logged, replayable facts. The declarations are the reference.

- **Program** `{ actor, label, steps: {verb, params}[] }`: the verb steps one body runs. A `decision` event starts one.
  One actor runs one program.
- **ProgramEvent** `{ tick, id, actor, kind: 'step'|'completed'|'failed'|'cancelled', step, code?, message? }`: how the
  host learns that an action progressed, finished or was refused. Receipts are built from these.
- **Anchor** `{ id, kind: 'region'|'place', name, in?, entity?, point?, tags? }`: mirrored as kernel Things at genesis;
  the place tagged `arrival` is where new Souls appear.
- **VerbInfo.scope** `'world'` marks a verb that belongs to one engine, not the shared body language.
- An unknown verb fails with `action.unknown-verb`.

## Body language

Both engines describe the same shared verbs for one actor's body; the actor is implied by the program:
`walk_to {to, standoff?}` · `sit {on, seconds?}` · `stand` · `rest {seconds?}` · `wave {at?, seconds?}` ·
`converse {with, seconds?}` · `gather {at, seconds?}` · `perform {what?, seconds?}` · `ambient_wander {seconds?, radius?}`.
Edge capabilities offered to Souls are built on top of these and the engine's own verbs.

A Mars `walk_to` step may carry `stand: 'clear/1'` (#374). Its standoff point must have standing room for the walker's
body, the same radius the route's own goal check uses. Each turn around the target is read for that room before it is
planned. When no turn has both room and a route, the step takes a point with room on a wider ring around the target, at most
0.9 m beyond the standoff, so a ride still boards within its 3.2 m reach. It makes at most 8 more route plans for this. When there is none, it is refused `route.goal-blocked`, naming the blocker. A balloon, ferris wheel or carousel join marks its walk to the carrier this way; a punt walks to its bank's door as before.
This matters on paged ground, where a long walk's plan checks only its first fine hop, so a standoff point inside a
ride's own collider used to pass the plan. A step without the marker keeps the goal it always chose, so recorded
programmes replay unchanged.

`dance:here` uses the body's current standing footprint and never inserts a walk to a larger clearing or another
venue. A seated Soul still stands first; active movement and occupied support keep their native admission rules.
Direct `pose_v1` admission reads clearance at the actor's position, independently of the last paged ground window
queried. Lying poses retain their larger clearance requirement.

A reach's lean into a container and a stroke's step to a board go through `runtime/static-step.ts`, the walker's rule:
a step that would put the body below the `collision.human-static` limit, and worse than where it stands, is not taken,
and the hand works from where the body is. A stroke stays held for the rest of the stroke; a lean follows its path back
out. Invariants run at the end of every tick, so a held step would have been a violation on that same tick (unless something
later in that tick moved the obstacle), and every earlier step moves as it did.
An opening or a slide can't stop short, because its body follows the handle: where the next step would trip the same rule, the
rest of its path shifts aside by the smallest step with room, at most 0.18 m in all, easing back once there is room, and with no such step it fails `step-blocked`.
A door's gap turns solid only at the close's contact, so the plan reads that gap's raster at the close's end (`settleBeside`): a close that would end under the limit eases clear over the reach and swing (`opening.settle`, at most 0.18 m), and with no such place it is refused `contact.no-room`. A close that ends clear carries nothing extra.

One guard decides all of these (#1332): `guardBodyStep` in `runtime/static-step.ts` holds a step whose end is below the
limit and worse than where the body stands, and names the nearest blocker; it reads what the invariant reads (the grid of
the body's level at that point, the body's own radius, deep water exempt). The walker's hard static layer calls it on its
own grid and radius, so its steps are unchanged. Under `body-step-guard/1`, a logged runtime-policy `rules` event every world
adopts once at boot (history before it replays as recorded), every placement the engine writes outside a step also passes
it (`bodyStandsClear`) and keeps the invariant's body separation: an edge relocation, a recovery restore and a stall release
stand a body only where its own radius fits (a floater's 0.35 m or its own) and apart from other bodies by both radii, and a
stall release with nothing clear near leaves the body where it stands. Births keep their own arrival check. A carrier's rider
legs and set-downs are not covered yet: #1348 checks them on the same fine raster behind the ride's own marker. Other action-owned steps keep their own checks (the hand actuator above, hand-holding,
handovers, social poses, shore and swim travel) and do not go through the guard yet.

## Refusal

With the `souls-repair/1` rules (`soulsRepairV1`: on with `SIM_SOULS_REPAIR=1` or with `SIM_SHARED_CARRY=1`, and `SIM_SOULS_REPAIR=0`
turns it off under either; new worlds only for now: a world whose history lacks it refuses to boot with it on), a move that
would break a rule is not applied ([#1150](https://github.com/soulsimulation/souls/issues/1150)).

- `Engine.step` leaves no refusable violation standing. The bodies that moved go back to their pose before the tick, and
  their programmes end `failed` with `world.refused:<rule>` and a plain reason, in that tick.
- **Refusable:** `collision.human-static`, `collision.human-human`, `collision.human-load`, `motion.overspeed`,
  `motion.teleport`, `carry.load-static`, `lift.hands-out-of-reach`. A body that holds a load refuses with its load and
  everyone holding it. Cleanup is the action's own, and a stop never drops a load. An action that keeps its own position
  rewinds it in its `refused` hook: a carry backs up to 1 m along the route it came by and sets down there, further back if
  it can't lay the load there. A person or a solid behind it, or a refusal while backing, ends the backing where it stands.
- **Not refusable, left in `violations` for the host's repair:** any other rule in the same tick (a tick is refused whole
  or not at all), a violation naming only bodies that did not move, a build programme, a body ridden, carried, on a
  structure or on a flight, an action with no programme whose cancel is refused, and a third refusal of one programme within 5 s.
- Refusal is a function of world state and the rules version, never of input. A replay or restart recomputes it, so a
  restored runtime remembers the poses it restored (`rememberPosesAfterRestore`): the step check keeps its previous poses
  outside the snapshot, and would otherwise miss a jump on its first tick.
- A body that only turned did not move. Observers run in the end-of-tick pass, before the undo, so a take can show the
  refused pose for that one tick.
- **The one relocation exception.** A `collision.human-static` naming a body that did not move means the world landed on it
  (a god edit past the bridge's own walk-out). There is no pose to go back to, so it stands at the nearest free spot,
  logged and told to the Soul. Apart from a body a rung 3 finds inside something, below, this is the only time a body
  changes place without moving there.
- `step().refusals` reports each one. The host logs it as a `rules` event from `world:refusal`. Replay reads those only to
  compare the count, and a difference is reported, not fatal.

### The ladder

1. **Refuse** (above), inside `Engine.step`.
2. **Narrow replay:** the host's recovery plans, unchanged, each kept only if its replay is clean.
3. **Last rung,** when rung 2 fails or has no plan: restore the last clean baseline, stop every programme, re-apply
   everything since it except decisions and what only they explain (`decision`, `play`, `edge-stop`, intent admissions,
   arrivals and sleep stops), and set the clock to the fault's tick. This takes no engine step,
   so no rule can fire. It's logged as a recovery recipe with `lastRung`. Open receipts end `world.rewound`.
   With no baseline, or within a minute of the last one, it stays on the head, and rung 2 isn't tried: stop, contain, logged
   as `lastRungInPlace`, whenever it stopped something or the fault named something off the list, and otherwise once per
   rule per minute. A replay makes the same stops from that event. An event that won't re-apply costs only itself, and
   the recipe lists it. A Soul is told `world.rewound` only when something of its world ended: a stop in place that
   stopped nothing tells nobody.

**`containedV1`** is part of world state, absent when empty: what rung 3 could not repair. It holds what the fault itself
named, and the row or recipe carries those keys, so a replay applies them and nothing reads the invariants outside a step:
a read there would move the step check's memory where a replay's doesn't, and the boot would differ. A rule the step check
can only see across ticks, like `motion.teleport`, is contained the same way.

An entry stays a minute after it last fired, so a rule that flickers costs one row and stops nobody again. Each is counted
once and doesn't fault again. A key that fired last tick is a break still standing, and a body inside something may walk out
of it, never further in: a move that takes a body nearer the solid thing, inside its own width, or nearer the other body or
load, goes to rung 1 as any move would. A carried load's own `carry.load-static` names only the load, so that one isn't judged. A `motion.*` key never counts as standing. Anything else on the list only absorbs what has no plan:
a body that moves into forbidden geometry under a held key is refused by rung 1 as it would be with nothing held. The list keeps eight subjects of a rule; past that the rule goes on
whole (`subjects: ['*']`), which absorbs only what has no plan. So a rule that names someone new each tick writes a few rows
and stops, and a named fault always reaches the list, even while steps are failing. Each stop row answers a decision that
started what it stopped. A body inside something is relocated once.

`SIM_SHARED_CARRY` brings the ladder with it. `SIM_SOULS_REPAIR=0` keeps it off, which is how a shared world made before the
ladder boots. A world made with the ladder can't go back: it needs these rules to replay. Under these rules an invariant that
throws is a named `engine.thrown` violation, so it is contained like any other. A boot's replay survives what the live tick
survived: a step or event that threw is reported and passed. A replay that ends somewhere other than the live world, say past
a throw it didn't repeat, isn't refused under these rules: it is a legal world, so the boot goes on from it and reports
`clock-frontier.replay-differs`. What ran since the last snapshot can be lost that way, so a throw asks for a snapshot, at most
once per cooldown in a stretch of them.

**An action whose step or stop throws ends alone** (`engine.action-threw`, logged and counted as a refusal). Its whole tree ends,
its Soul is told, and whatever it held is set down where it is, on the bearer's level: the one time a load is let go without its
set-down, because the action that would have done it is what broke. A part joined to others stays where it is and stands by
itself, as a god's joined upright does, and the frames and beams of its group stand down with it (`settleFrames`), because laying
it flat would keep the joints and the crew at the other end could never let go. Crews holding the rest of that frame are let go
as `world.frame-let-go`, not counted, since nobody can finish it with them now. What a part does to a rule after that is the ladder's like anything else.

**A stop the ladder asked for ends within 20 seconds.** A programme stopped by a rung 3 or a stop in place keeps its own cleanup
that long, counted from the fault's tick, and is then abandoned the same way. So a stop that is refused
(`support.release-premature`) or a set-down that can't finish doesn't hold a body for good. A stop a Soul asked for that stays pending (`untilSafe` or
a physical stop) is given up the same way, as `world.stop-gave-up`, once nothing it waits on has changed for five minutes (its
body, what it holds and the joins of any frame held), or after half an hour whatever changes. That is world state, so a replay
does the same. A give-up isn't a glitch, and crews on the rest of that frame are let go as `world.frame-let-go`. A stop with no deadline yet, such as a refusal's, gets one the next
time the ladder fires, written in a stop-in-place row that tells nobody.

Going back doesn't answer a rule twice: a rule a rung 3 has gone back for stays on the head after that, a thrown step counting as
one rule, so what returns past the hold writes a small row, not a whole world. A restart allows it one more.

**A step that throws still moves the clock,** live and in a replay, so no cooldown or replay waits on a tick that isn't
coming. Half the ticks of ten seconds of world time faulted is `engine.step-failing`: the clock runs, bodies can't get
anywhere, so acts are refused with `world.step-failing`, nothing rewinds, the launcher alerts as for a halt, and a due
snapshot is taken at once on a faulted tick. That snapshot is marked: it serves a boot, never a rewind, and one that won't
capture waits until the next is due. A snapshot from a clean tick in the stretch stays unmarked and can be a baseline. It ends when faults fall below three quarters of that, and a clean snapshot follows at once. While it lasts a faulted tick keeps the ordinary beat of batches and heartbeats. What still reaches it is a throw outside
any action, in the world's own step. A stop in place can't answer that. If a god's edit caused it, a god removing what they
placed clears it, and a rung 3 keeps god edits, so it survives a restart until then.

**What still halts:** durability only (`failCheckpoint`, a database that won't write, a clock frontier that can't be
persisted, a stored baseline that won't restore). Each is named `durability.*`. Without `souls-repair/1`, `haltOnFault` is unchanged.

## Conformance

`@souls/engine-contract/conformance` exports `conformance(name, factory, drive)`: same seed and inputs give the same hash,
different seeds diverge, snapshot/restore mid-action continues identically, `physicalHash` ignores labels, verbs
describe with JSON Schema, an unknown verb fails cleanly. Both engines run it (`packages/engine-mars/src/mars.test.ts`,
`packages/engine-toy/src/toy.test.ts`). An engine that declares rules also runs `refusalConformance(name, factory, force)`; the toy engine
has none. (`packages/conformance` is a different gate: every core-library object bakes,
places and furnishes within budget.)

## The Mars adapter (`packages/engine-mars`)

The Mars engine is hard-forked under `mars/viewer/engine`. `load.ts` imports that in-repo tree (it fails if
`runtime/runtime.ts` is missing) and installs a Node SHA-256 provider with the same digests as the browser.

- **World configurations** (`engine.ts`): `GREEN_FIELD_WORLD` (launcher worlds and `eden`), `LITTLE_MARTIANS_WORLD`,
  Eden commons variants, the default proving ground (`mars`), and `MEAL_WORLD` for a test. `main.ts` picks one from
  `WORLD_KEY`. Rules version is `sim-mars/1+<Mars rules version>`, extended with the policies a world has adopted.
- **Lowering.** Each body-language step becomes Mars actions when it begins: `walk_to` plans a reachable point near the
  target and faces it; `sit` and `gather` take a fixture or region; `converse` joins two bodies when both are free;
  `rest` and `perform` wait; `ambient_wander` draws short legs from the world RNG.
- **Raw verbs.** Every Mars verb is also described as `mars:<verb>` with `scope: 'world'`.
- **One program per actor.** A program that moves the body first asks whatever holds it (a seat, a circle, a
  conversation) to release it, and fails with `actor.busy` if that takes too long. Feasibility is checked first
  (`canPerform`) because in Mars a refused instruction still disturbs the actor.
- **Broadcast.** Moving bodies send two-point keyframe paths every 5 ticks; activity and seat changes are field changes.
- **Snapshot** format `sim-mars-snapshot/1`: Mars's own snapshot plus the adapter's programs and world configuration.
  A program whose actions cannot be serialized defers the checkpoint; replay of the logged suffix continues it.
- **God-built worlds.** On launcher worlds the god's committed objects and terrain enter the engine as `world-edit`
  physics through `apps/server/src/god/engine-bridge.ts`; Souls then sit on, walk around and use them.

## The toy engine (`packages/engine-toy`)

A 100 × 100 m plane with a campfire, benches, a kiosk and a gate, two regions, straight timed walking at 1.35 m/s in
integer millimetres, and the shared verbs plus `do_activity`. It is a small reference for the contract and the
`toy` world's tests.
