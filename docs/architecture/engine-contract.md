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

A runtime policy is a `cfg` key a world may turn on after genesis by a logged `rules` event without changing its rules
version. The Mars engine keeps them in one registry, `RUNTIME_POLICY_KEYS` in `packages/engine-mars/src/engine.ts`
(with the render clock and ground-reclaim/1); a physical-binding snapshot reader ignores exactly those keys
(`physicalBindingCfgV1`), so adopting a policy on a bound world never makes its snapshots unrestorable (#1363). A new
flag goes in `RUNTIME_POLICY_FLAGS`; `runtime-policy-registry.test.ts` fails until it does.

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

A ride's `carrier_steer` with `land` may carry `landing: 'clear/1'` (#1324), and the ride object always sends it. The spot must
be clear on the fine clearance raster over a 2.6 m disc: the basket, its door and both seat exits, plus a body radius. That raster
holds the thin wall segments and closed doors the coarse solids drop, and it also holds benches, water edges and steep cells. Nothing
in the raw scene may stand over the disc either, so no wall, lintel, roof or god-built floor: the descent column is open sky. The ride
lands on the nearest such spot within 30 m, in rings of 2 m, and the plan returns `landing: {requested, at, adjustedM, reason}`.
With no spot it is refused `carrier.no-landing-spot`, naming how far the nearest clear ground is. The spot is read again through
the second half of the flight and on the touchdown tick. When the spot is no longer clear, the landing moves to the nearest clear
spot to the asked point: the ride climbs back to cruise height (35 m), flies across, then comes down. After a third move it
flies home. With no clear spot it hovers and looks again every
2 s, and flies home after the 2-minute hover. The ride state's `landNote` says which happened. A ride's own home is never
re-checked; a home that no longer reads clear is only reported, as a `carrier.home-not-clear` mark. A steer without the marker
keeps the landing it always chose, so recorded programmes replay unchanged.
A `carrier_ride` boarded with `clear: 'step-out/1'` (the ride object's join sends it) steps out only onto ground the body can stand
on. The leg to the door waits while the door spot isn't clear. The last leg goes to the exit, or to the nearest clear spot round it
that a straight step from the door reaches. The rider stands at the ground's height there. A 12 s set-down uses the same check,
searching up to 12 m round the exit, and a rider with nowhere clear stays aboard instead
of being placed in a wall. God edits never walk out a rider whose ride is in the air (#1339).

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
adopts once at boot (history before it replays as recorded; the physical-binding readers of the Eden worlds take it as a runtime policy, like the clock and the courtesy flags), every placement the engine writes outside a step also passes
it (`bodyStandsClear`) and keeps the invariant's body separation: an edge relocation, a recovery restore and a stall release
stand a body only where its own radius fits (a floater's 0.35 m or its own) and apart from other bodies by both radii, and a
stall release with nothing clear near leaves the body where it stands; upstairs under `stall-release-support/1` (#2133) it goes to the nearer clear landing of its flight instead, else stays held (`stall.no-floor-spot`). Under `stair-way/1` (#1428), a second logged runtime policy adopted at boot right after the guard, a walk climbing a stair has the stair's exit as its way, so another walker's make-way test that reads it never throws; without it the read is as recorded. Under `stand-height/1` (#1454), adopted at boot last (after quarantine-mark/1), a body the engine places upstairs (a restore, a settle, a stall release not from a carrier) stands at its floor's own height, never at the height it had; without it a body caught mid-climb could be stood on a floor cell in the air. Under `stand-height/2` (#1521), adopted right after it, the same holds on the ground floor of a world without a ground field (Eden core): a stall release on level 0 stands the body at that level's floor height. Without it, a body stalled mid-climb onto the commons deck was set down at y 0.24 in the air, and every later walk was refused `motion.teleport`, because the walk's first tick puts the body on its floor. Adopting `stand-height/2` also stands any free body already left that way on its floor, once. A free body is idle, with no programme, nothing holding it and not seated or riding, and stands more than a step (0.15 m) above level 0's floor. It goes to the same point if that point is clear, otherwise to the nearest free standing spot, with each spot in one plan kept apart from the others. Planning only reads: it never takes a body out of the entity table, so the live table keeps the same order as a replay. A stall release on level 0 that finds nowhere clear near a body standing in the air, not even its own point, leaves the body held (`stall.no-floor-spot`), never released in the air. The stall guard tells the owner once, with a failed `stall.no-floor-spot` receipt, and a `stand:here` answers the same refusal. The guard doesn't log another release while that hold is unchanged. The adoption's own event carries each body, its place and its Soul, and the Soul is told (`world.stood-on-floor`). Births keep their own arrival check. A carrier's rider
legs and set-downs are not covered yet: #1348 checks them on the same fine raster behind the ride's own marker. Other action-owned steps keep their own checks (the hand actuator above, hand-holding,
handovers, social poses, shore and swim travel) and do not go through the guard yet.

## Refusal

With the `souls-repair/1` rules (`soulsRepairV1`), a move that would break a rule is not applied
([#1150](https://github.com/soulsimulation/souls/issues/1150)). Every world the server runs has them by default
([#1323](https://github.com/soulsimulation/souls/issues/1323)). The server reads a world's history with
`soulsRepairReaderV1` over its own reader: the history replays and restores under the rules it was written with, and a world
whose history began without them adopts them in one logged `rules` event at its head, after replay and the clock check
(`{soulsRepairAdoptV1: {contract: 'souls-repair-adoption/1', tick, fromRulesVersion, toRulesVersion, fromStateHash}}`). Its
fold turns the rules on, and the world header's `rules_version` follows in the same acceptance. A new world is born without
them and adopts at tick 0. A snapshot restores under the policy it was taken with; the state hash never names the rules
(only the rules version does), so adoption leaves it unchanged. **Adoption is one way:** a reader without the rules (0.120,
or `marsFactory` alone) refuses an adopted history. `SIM_SOULS_REPAIR=0` adopts nothing, still replays a logged adoption, and
is ignored for a world that has adopted. A factory that already has the rules (`SIM_SOULS_REPAIR=1`, `SIM_SHARED_CARRY=1`, or
`soulsRepairV1: true`) is used as it is: an old history refuses it, as before.

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
  logged and told to the Soul. Apart from a body a rung 3 finds inside something, and a broken body that quarantine/1
  holds (below), this is the only time a body changes place without moving there.
- `step().refusals` reports each one. The host logs it as a `rules` event from `world:refusal`. Replay reads those only to
  compare the count, and a difference is reported, not fatal.

**Hold or settle** (`hold-settle/1`, #1334). This is a logged runtime policy (cfg `refusalSettleV1`), and every world
adopts it at boot after `body-step-guard/1`. Its adoption is refused, writing nothing, while the guard is off
(`hold-settle.guard-required`, #1442), so settle never places a body without `bodyStandsClear`. It acts only under the repair rules. A history from before its event
replays as it was recorded. Under it, rung 1 answers each violation on its own:

- **Hold.** The moves are undone as above, and the refusal row is written, but the programme is not stopped. The third
  refusal of one programme within 5 s fails it with `world.refused:<rule>`, as one refusal does without the rule. It no
  longer goes to the host.
- **Settle.** Some bodies can't be answered by an undo:
  - a body with no copy;
  - a body whose copied pose fails `bodyStandsClear`;
  - a moved rider or climber;
  - a body named by `collision.human-static` or `collision.human-human` without having moved (for `human-human`,
    every named body but the first by id);
  - a rider named by a `carrier.*` rule.

  Each of these bodies is settled in that tick:
  1. its programme ends with `world.settled:<rule>`;
  2. whatever action holds it is force-finished, and a held load is set down where it is (the `engine.action-threw`
     rule);
  3. its seat, door turn and ride mark are freed;
  4. it stands at the nearest pose the ring search accepts. That search uses body-step-guard/1's validator
     (`bodyStandsClear`, and keeping apart from other bodies), which is why the policy is adopted after the guard.

  Every body's spot is found before anything changes, so a settle places all its bodies or none. If one can't be
  placed, nothing is moved or ended, and the violation goes to the host as it was.

  The row has `relocated: true` and the poses, so the Soul is told. Settle replaces the relocation exception above: it
  is the one way the world moves a body without the body walking there.
- **Still for the host, alone:** a rule outside these classes, a body on a build programme, `human.riding`, `human.on`,
  a sleeping body, and a settle with any body no ring search can place. These are no longer a reason to send the whole tick: every
  other violation of that tick is still held, failed or settled.

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

**`standingHoldsV1`** (#1440, `quarantine-mark/1`, a host-only logged runtime policy adopted at boot last) is part of world state, absent when empty. Once a broken body has been held 3 times in a cooldown, the quarantine event carries `standing: [{id, pose}]`, and from then the engine itself holds that body again whenever it finds it broken, at the pose where it last stood whole (the logged pose, which the mark then follows while the body is whole), at the start and end of each step, so the host never reads it broken and logs no more holds. A mark ends when the body has stayed whole for 1200 ticks, or is gone. A replay folds the same event and keeps the same marks; without the policy, every hold is logged as before. The engine guards each runtime invariant once: a list appended to or swapped back in keeps its existing guards.

An entry stays a minute after it last fired, so a rule that flickers costs one row and stops nobody again. Each is counted
once and doesn't fault again. A key that fired last tick is a break still standing, and a body inside something may walk out
of it, never further in: a move that takes a body nearer the solid thing, inside its own width, or nearer the other body or
load, goes to rung 1 as any move would. A carried load's own `carry.load-static` names only the load, so that one isn't judged. A `motion.*` key never counts as standing. Anything else on the list only absorbs what has no plan:
a body that moves into forbidden geometry under a held key is refused by rung 1 as it would be with nothing held. The list keeps eight subjects of a rule; past that the rule goes on
whole (`subjects: ['*']`), which absorbs only what has no plan. So a rule that names someone new each tick writes a few rows
and stops, and a named fault always reaches the list, even while steps are failing. Each stop row answers a decision that
started what it stopped. A body inside something is relocated once.

The ladder comes with the rules, so every world the server runs has it by default (see Refusal for adoption). A world made
with the ladder, or that adopted it, can't go back: it needs these rules to replay. Under these rules an invariant that
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
anywhere, so acts are refused with `world.step-failing` (under quarantine/1, only those of the bodies its faults named), nothing rewinds, the launcher alerts as for a halt, and a due
snapshot is taken at once on a faulted tick. That snapshot is marked: it serves a boot, never a rewind, and one that won't
capture waits until the next is due. A snapshot from a clean tick in the stretch stays unmarked and can be a baseline. It ends when faults fall below three quarters of that, and a clean snapshot follows at once. While it lasts a faulted tick keeps the ordinary beat of batches and heartbeats. What still reaches it is a throw outside
any action, in the world's own step. A stop in place can't answer that. If a god's edit caused it, a god removing what they
placed clears it, and a rung 3 keeps god edits, so it survives a restart until then.

**The ladder's end: quarantine/1 (#1369).** A logged, host-only runtime policy (`runtimePolicy.quarantineV1`, adopted at
boot after body-step-guard/1; the engine never reads it, so no snapshot binding changes). Under it:
- When rung 3 can't go back (its baseline won't restore, its kept events won't re-apply, or the pending baseline won't
  materialize), the host puts back the head it had before rung 2, by reference, and quarantines what the fault named.
  It stops those bodies' programmes alone (`stopBodiesV1`, `world.quarantined`). It contains the fault's keys, and a body
  inside something is moved clear once, as rung 3 does. It logs one `quarantineV1` rules event, which a replay applies
  without reading an invariant. The glitch is rung `contained`, with the restore error as evidence. Everyone else goes on.
  The quarantined Soul can act again at once: it is never held or refused for the quarantine. The rule a rung 3 went back
  for stays on the head after that, and a snapshot is taken at once, so a restart never boots from the refused baseline.
- The in-place rung (a fault within the rewind cooldown, or with no baseline) does the same for a fault that names bodies,
  while steps are failing too (#1378). A fault that names none still stops everything in place, as above, unless it is an
  invariant that threw and what it was reading is found (#1377, below).
- An invariant that throws names nobody (`engine.thrown`). Under quarantine/1 the host restores the head to a scratch engine,
  and there the engine takes entities out of the table half at a time, bodies first (`thrownSourcesV1`), to find the one
  entity whose absence alone stops the throw (#1377). That entity is quarantined alone, at once, with no rewind, since going
  back would read it again. Everyone else's programmes go on. The glitch row names it (`thrownReading`), and the
  `quarantineV1` event carries it, so a replay reads the log and never probes. While steps fail, only that body is refused.
  A throw that no single entity explains, a step that throws outside any action, or a head that won't snapshot or restore
  keeps the stop-all, counted as before.
- A body quarantined again within the cooldown is held whole (#1378): the event also contains every rule on it (key
  `{code: '*', subjects: [body]}`), so a fault that comes back under a new rule each tick is absorbed instead of faulting
  the step. Only a violation whose every subject is held whole is covered; one that names a free body still faults.
- While steps are failing, only a Soul whose body a fault in the window named is refused `world.step-failing`; everyone is
  while any fault in the window named no body (#1378). The `engine.step-failing` glitch names who is refused.
- A broken body (`entity.corrupt`: a person with no human state, or any number in its pose or human state that is no
  finite number) can make every step or the state hash throw while no rule names it. It is found when a step faults,
  when the hash fails, or by a once-a-second sweep. It is then held: its programmes stopped, a fresh human state if its
  own is broken, and its last whole pose if its pose is broken. If no whole pose is on record, it goes to the nearest free
  spot by the arrival, which is loud: logged, counted and told to its Soul. The event carries the pose, so a replay holds
  it in the same place. A body that breaks again within a cooldown is quarantined and held again, alone (#1377): its own
  programmes stop and nobody else's. Its glitch row is written at most twice a cooldown; the log event, which a replay
  needs, every time.

**Any other number that is no number: nonfinite-hold/1 (#1496).** A logged, host-only runtime policy
(`runtimePolicy.nonFiniteHoldV1`, adopted at boot last, after quarantine-mark/1 and stand-height/1, effective only with quarantine/1). The durable clock
hashes the head every tick. When that hash still fails on a non-finite number after quarantine/1 has held any broken body,
for example an object's pose, a field of the world such as the weather, or a programme's own state:
- The engine (`planNonFiniteV1`) plans for every such number in the world (every entity, every kind) and in the
  programmes, all or nothing:
  - A body's pose and human state are never patched here; that is quarantine/1's, and a body quarantine/1 leaves broken
    (a pitch, for example) halts as below. A body's other fields are patched like any other number.
  - An entity's pose is one unit, and only a free component's pose is ever put back. A free component is on the
    ground, on a surface or in a hand. Its def (from the world's library, else the catalog; an unknown def is not free) has no slots, it is joined to nothing, nothing rests on it, and no body names it in its state:
    a seat, a berth or a link. Its kind can never carry, seat, berth or hold a body. The whole pose comes back from
    the last good snapshot (the recovery baseline) (`from: 'baseline'`), but only if the component's support is the
    same as it was then and no body stands within its radius.
  - Otherwise the component is set down at a free spot near the arrival (`from: 'arrival'`, the eject), found by the
    same search a held body uses, and its holder lets go.
  - Any other kind with a broken pose is not moved: it halts. That includes a carrier, a boat, a bed, a ride and a
    frame part.
  - Any other number goes back to its value at the same path in the baseline (`from: 'baseline'`), else 0
    (`from: 'zero'`).
  - More than 64 numbers, or a pose nothing legal can put back, plans nothing at all, so no patch is ever partial.
- What the patches touched stops (`state.non-finite`): a programme whose own state was patched, the programmes of a body
  whose fields were patched, and the holder of an item that was set down. Each of those Souls is named in the event, and
  the edge ledger ends its open acts and tells it.
- The baseline is restored once per baseline, into a scratch engine that is only read. A break that comes back every tick
  writes its event every tick, because a replay needs it. Its glitch row is written at most twice a cooldown.
- One `nonFiniteHoldV1` rules event (author `world:nonfinite-hold`) carries the exact patches. A replay writes the same
  ones through the same engine method (`applyNonFiniteV1`) and reads nothing. The glitch row (rung `contained`, rule
  `state.non-finite`) names each field and where its value came from. The hash is then taken again, and the frontier is
  written through the event, so no frontier is ever hashed over a non-finite head.
- A periodic capture skipped as `snapshot.non-finite` puts its numbers back the same way, so the next capture isn't
  skipped for them again.
- What it can't put back is still `engine.unhashable` or `durability.clock-frontier`, as below: a number in the Soul
  kernel, a body pose quarantine/1 left broken, any entity but a free component with a broken pose, or more than 64 numbers. The tick
  throws and the process exits, and the supervisor restarts it from the log. A world never runs on with its clock
  stopped. If a deterministic rule produces that number, the restart meets it again and loops; that is a known limit.

**What still halts:** a failed write (`failCheckpoint`, a database that won't write, a clock frontier that can't be
persisted), each named `durability.*`. Under quarantine/1 a baseline that won't restore is no longer one; without it, it
still halts as before (`recovery.baseline-unusable`). A state that still won't hash after its broken bodies are held halts
as `engine.unhashable`. Without `souls-repair/1`, `haltOnFault` is unchanged.

A snapshot the engine refuses to capture (a `snapshot.*` refusal such as `snapshot.unencodable`) does not halt. On the
periodic path (#1368), the manual `saveSnapshot` and the repair snapshot (#1376), it is skipped and counted at rung
`contained` as `durability.snapshot-skipped`, and the clock runs on. A manual save answers `pending: true` and logs an
`unsnappable-head` checkpoint. A head holding a number that is no number (a body's NaN pose) is skipped the same way, as
`snapshot.non-finite`, its row naming the first entity and field (#1492). Under `quarantine/1` the periodic path sweeps for
broken bodies just before it captures (whether the tick ceiling, a request or the replay debt brought it due), as well as once
a second, so the body is held on that tick and the capture sees it whole. Other capture faults propagate as before.

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
- **Plan once (#1770).** The adapter's engines keep route results per navigation epoch (`Spatial.routeMemo`: bounded,
  emptied when the epoch moves, never for predicate options), so an act's admission check, the tick's `perform` and the
  walk's start search each leg once. A route is a pure function of the epoch's grids and its inputs, so a reuse equals a
  fresh search; anything that changes what a walk may cross moves the epoch first. The edge ledger likewise reuses the
  strict gate's offer for the act in the same synchronous turn. `SIM_PLAN_ONCE=0` turns both off;
  `SIM_PLAN_ONCE_ORACLE=1` compares every reuse with a fresh computation and logs `[plan-once-oracle]` on a difference.
  The viewer's engine does not keep routes.
- **Broadcast.** Moving bodies send two-point keyframe paths every 5 ticks; activity and seat changes are field changes.
- **Snapshot** format `sim-mars-snapshot/1`: Mars's own snapshot plus the adapter's programs and world configuration.
  A program whose actions cannot be serialized defers the checkpoint; replay of the logged suffix continues it.
- **God-built worlds.** On launcher worlds the god's committed objects and terrain enter the engine as `world-edit`
  physics through `apps/server/src/god/engine-bridge.ts`; Souls then sit on, walk around and use them.

## The toy engine (`packages/engine-toy`)

A 100 × 100 m plane with a campfire, benches, a kiosk and a gate, two regions, straight timed walking at 1.35 m/s in
integer millimetres, and the shared verbs plus `do_activity`. It is a small reference for the contract and the
`toy` world's tests.
