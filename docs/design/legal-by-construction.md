# Legal by construction

**A design note for a yes or no. Nothing here is built.** Issue
[#1983](https://github.com/soulsimulation/souls/issues/1983), under [#1959](https://github.com/soulsimulation/souls/issues/1959).
Code read at `6e68020db`.

Today the engine moves, checks, then undoes poses only; anything else goes to the repair ladder (`recoverFault` in
`apps/server/src/world.ts`). The goal: a state that breaks a rule is never committed.

## Today's invariants

Rule | Prevented before | Detected after | File that decides
---|---|---|---
`collision.human-static` | Steps (step guard), placements (`placeClearV1`), arrivals; not god edits | Yes | `mars/viewer/engine/runtime/static-step.ts`, `runtime/invariants.ts`, `packages/engine-mars/src/arrival-search.ts`
`collision.human-human` | Placements and arrivals, each its own spacing | Yes | `runtime/invariants.ts`
`motion.teleport`, `motion.overspeed` | No | Yes | `runtime/invariants.ts`, `packages/engine-mars/src/ground-bridge.ts`
`support.unsupported`, `support.holder-missing` | No | Yes | `runtime/invariants.ts`
Sleep safety | At lie-down | Yes | `mars/viewer/engine/activities/sleep.ts`
`carry.*`, `collision.human-load` | Set-down only | Yes | `mars/viewer/engine/carry/invariants.ts`, `carry/validate.ts`
Construction (`support.*`, `frame.*`, `deck.*`, `stair.*` and others) | Plan feasibility | Yes | `mars/viewer/engine/construction/`, `packages/engine-mars/src/{beam-connect,deck-install,stair-install,raise-hold}.ts`
`vehicle.*`, `forklift.*`, `carrier.alight` | Carrier landing (marks only) | Yes | `mars/viewer/engine/vehicles/`
Object inside a solid | God admission only (`overlap.solid`, `support.none`) | No | `packages/world-compiler/src/compile.ts`
Ways a god edit cuts off | Repaired in the same batch | No | `apps/server/src/god/buildsafe.ts`
Seat out of reach | God admission | No | `apps/server/src/god/use-check.ts`

## 1. God edits through the check-on-a-copy path

**Today.** `commitBatch` (`apps/server/src/god/god.ts`) refuses an edit only for objects and for a resident's own body.
Residents in the way are walked out (`god/walkout.ts`, Gene's G1 rule of 15 October), and `applyWorldEditV1`
(`engine.ts`) moves any standing body a new solid buries to clear ground; seated, sleeping and riding bodies are
skipped, and buried upstairs bodies end `trapped`.
Authored installs (food delivery, lecture) already check a detached copy against every invariant, refuse
`physical-conflict`, and commit only a fact matching the preview.

**Change.** God edits take that path: a batch that breaks a rule on the copy is refused, naming the body, the rule
and the nearest legal alternative. No walkouts. **This reverses G1.** A Soul that does not move (asleep, seated,
idle, or its owner away) blocks the edit for as long as it stays, and an edit to a seat, bed or item in use is
refused too. The god can wait or build elsewhere. **Open question for Gene:** may a god
order named Souls off a site, as an ordinary walk that is itself refused when it has no route?

- **Touches:** `god/god.ts`, `god/engine-bridge.ts`, `god/walkout.ts` (retired), `engine.ts`, a rules version.
- **Cost:** none per tick; per edit, one snapshot, restore and invariant pass (unmeasured).
- **Proof:** tests: a wall on a standing Soul is refused by name, on an empty spot accepted; a burying undo is
  refused; the walk gate. Playtest: a god builds round six Souls; bar 0 faults, 0
  relocations.
- **Tasks:** 1a preview a world-edit on a copy and measure it (3 h); 1b refuse in `commitBatch` under a rules
  version (4 h); 1c the god client shows the refusal (1 h).

## 2. One shared legality rule

**Today.** "May this stand here" has eight answers: the invariant (radius less 3 cm), the step guard (the same),
`placeClearV1`, `applyWorldEditV1` (0.9 of the radius), `standableNearV1` (radius plus 12 cm), arrival search (0.8 m
from anyone), walkout landing, and the carry and carrier checks. A body set down where the invariant rejects it halted Eden
([#1325](https://github.com/soulsimulation/souls/issues/1325)).

**Change.** One `legalAt(rt, entity, pose)` in `runtime/legal.ts`. Each invariant becomes "every entity is legal where
it is". Admission and placement call it, and may want more room, never less. Objects inside solids become an
invariant ([#1411](https://github.com/soulsimulation/souls/issues/1411), from `runtime/solid-overlaps.ts`).

- **Touches:** `runtime/invariants.ts`, `static-step.ts`, `solid-overlaps.ts`, `engine.ts`, `arrival-search.ts`,
  `carry/validate.ts`, `vehicles/carrier.ts`, `items/actions.ts`.
- **Cost:** the body rules cost what they cost now. The object rule reads only objects moved this tick.
- **Proof:** a property test that anything a placement accepts passes the invariants
  (`tools/soul-actions/mover-fuzz-world.test.mjs`); the walk gate. Playtest: crowded arrivals and carries; bar 0
  `collision.*` faults.
- **Tasks:** 2a `legalAt` for bodies, read by the invariants and the step guard (3 h); 2b placements and arrival
  call it (4 h); 2c the object invariant (4 h).

## 3. All checker memory inside the hashed state

**Today.** `motion.teleport` compares against poses kept in a `WeakMap` outside the world (`invariants.ts`), so a
restored runtime starts blind (patched by `rememberPosesAfterRestore`). The server decides rungs from memory
the hash never sees: `rewoundRules`, `quarantinedAt`, `wholePoses`, `faultTicks` (`world.ts`; only
`lastRewindTick` is rebuilt at boot).

**Change.** Previous poses become a hashed world field (later part 4's journal).
Every input to a rung choice is either in engine state or in a logged event a replay reads.

- **Touches:** `runtime/invariants.ts`, `engine.ts`, `world.ts`, a rules version and a conformance supplement.
- **Cost:** hashing five numbers per moving body per tick.
- **Proof:** restore mid-run and step both copies: same hashes and violations, a jump on the first tick
  included. Playtest: the counted scenario with a restart mid-run.
- **Tasks:** 3a teleport memory into state (2 h); 3b server rung memory logged or hashed (3 h).

## 4. A tick journalled and rolled back whole

**Today.** Rung 1 (`refusalCopyV1`, `refuseV1` in `engine.ts`; `refuse.ts`) copies the poses of bodies an action can
move, and their loads, and restores them for seven rules. Supports, grips, item state, action records and holds
written in the same tick stay. Other rules, and riders, climbers and carried bodies, go to the ladder.

**Change.** The runtime journals the prior value of each entity, action record and hold the tick changes. If the invariants find a new violation, the whole tick rolls back, the actions it names are refused with a
reason, and the tick runs again without them, at most twice, then contained. The journal is taken up front from the
entities that can change (bodies, held things, moving parts), and a fuzz test diffs full snapshots to prove nothing
writes outside it.

- **Touches:** `runtime/runtime.ts`, `engine.ts`, `refuse.ts`, `world.ts`.
- **Cost:** a copy of each active entity per tick, so it grows with activity, not world size; one more step on a
  refused tick. Proposed bar: busy Eden tick p50 up at most 10%.
- **Proof:** a fuzz of every mover: each tick ends legal or exactly as it began; replay hashes agree;
  `refuse.test.ts` and `hold-settle.test.ts` carried over. Playtest: the 14-Soul bench that halted in
  [#1120](https://github.com/soulsimulation/souls/issues/1120), and a construction scene; bar 0 rewinds, 0 halts.
- **Tasks:** 4a journal and completeness test, no behaviour change, measured (4 h); 4b roll back and re-run under a
  rules version (4 h); 4c refusal reasons for construction, vehicle and carry rules (3 h); 4d retire the pose copy
  (2 h).

## What stays

The ladder stays for:

- **Old history.** Older logs replay under their own rules, walkouts included.
- **Corruption.** A snapshot that won't decode or a replay whose hash differs.
- **Engine bugs.** An action or invariant that throws, or a violation no refused action explains.
- **Halts.** A failed store write (`durability.*`), an unhashable state (`engine.unhashable`) and a step that keeps
  failing (`engine.step-failing`).
- **New rules over old state.** A rule adopted over a world already breaking it is contained.

BUILDSAFE stays: it is prevention already.

## Order

Parts 1 and 3 are independent. Part 4 builds on parts 2 and 3. About 37 agent-hours in 12 tasks, each T3.
