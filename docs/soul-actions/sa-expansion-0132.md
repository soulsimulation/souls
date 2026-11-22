# Soul Actions expansion for 0.132: team work

Design proposal for [#2841](https://github.com/soulsimulation/souls/issues/2841), grounded in Engine v2 at
`df0af717`. This note adds no executable behavior. **Phase 2 starts only after 0.131 ships.** Its slices below need
separate acceptance and review before implementation; their estimates are agent-hours, not targets.

The outcome is independently controlled Souls carrying a load together, assembling a pallet-rack bay from real
parts, and taking it apart without losing material or support. Kinds and procedures describe the work as data.
Engine mechanisms must also work with a second compatible load or assembly in another world; no world names,
cast selection or rack-specific dispatch in engine code. All execution stays in `v2/`; the older engine is out of scope.

## What exists, and what is missing

| Current source | Reuse | Gap to qualify or extend |
|---|---|---|
| [Entry format](entry-format.md), `content/kinds/construction/` | Grip/joint points, compatible connectors, bay slots, `hold_crew`, motion and immutable kind references | The rack entries have no assembly forms; `motion.how` alone is not a construction procedure |
| [B5 activities](../../v2/crates/sim/src/activity/mod.rs), its `offer.rs` | Each Soul joins by its own intent, revision check, all-or-none body claims, offer accept/decline/expiry, restored membership | Bind agreement to the particular load, destination, maneuver and cleanup; gather and verify real readiness |
| [E23 moving group](../../v2/docs/moving-group.md), [B9 carry](../../v2/crates/sim/src/activity/carry/mod.rs) | One moving frame, linked walkers, load as its child, sweep and paired transfer | B9 uses fixed 2 m board geometry and two carrier places; it excludes gathering, corners, stairs, blocked set-down and active-carry recovery |
| [B18 structure](../../v2/crates/sim/src/structure/mod.rs), [B19 seating](../../v2/crates/sim/src/activity/seating/mod.rs) | Data-read support/crew rules; atomic take, joint removal, installation and joint creation; occupancy/reach refusal; geometry rebuild | B19 requires two crew, has limited support semantics and no loads/decks/stairs; qualify generic connector use and expose the operation through forms |
| [World host engine](../../v2/crates/worldd/src/engine.rs), `skills/src/form_runner/` | Activity/carry intents, form receipts and clock-driven execution | Host dispatch exposes lift/set-down, not B19 seating; host restore retains activities but explicitly omits open offers and carries |

These are source observations, not served-world proof. The broader
[physical coordination design](../design/physical-coordination.md) supplies agreement and conservation goals;
its older-engine implementations are not qualification of v2. In particular, E23's desired always-accepted leave
differs from B18's current refusal of a holder's leave when support would be lost. Resolve that through safe-stop
execution below before exposing construction to owners. The host's leave path also removes its carry runner when
the last activity member leaves without calling `set_down`; it does not establish a safe load release.

## Data and general mechanisms

Entries declare geometry, grips, connector compatibility, crew requirements, role places, admissible placement,
text and available forms. A versioned procedure declares a finite maneuver, prerequisites, dependency edges,
stable checkpoints and allowed cleanup. An assembly blueprint names required part kinds, transforms and joints.
Those are proposals for validated data, not additions secretly accepted by `souls-entry/1` today. Extend the
closed vocabulary only for a demonstrated need, with entry/form-rules cases and decoder parity.

The engine supplies only what ordinary forms cannot safely express: atomic claims across bodies/materials/joints,
one group route and motion owner, a shared work barrier, guarded connection transactions, and recovery. Use B5,
E23, B18 and B19 rather than introducing parallel movement, support or membership ledgers. People and materials
are nodes and typed links; no IDs in state fields. Entries use whole millimetres and microseconds; adapters
convert to v2 pose units once. New meaning gets a new kind revision; existing kinds keep their bytes.

| Action | General support it needs beyond content |
|---|---|
| Carry together | Agreed role/readiness barrier; data-defined E23 load/crew outline; atomic claims and safe set-down; active-operation recovery |
| Assemble | The same crew lifecycle plus B19 form dispatch, connector/slot transaction and B18 support guard; shared dependency/checkpoint progress |
| Disassemble | The same transactions in reverse dependency order, temporary-support handoff, occupied-surface/egress checks and conserved-instance recovery |

## Consent, roles and one shared operation

1. Propose one maneuver: exact material instances, destination/slot, kind and procedure revisions, required roles,
   expected duration, permissible route variation and safe-stop policy. The organizer gains no control over others.
2. Each owner accepts or declines its own role; offers expire without moving or reserving bodies. Discussion,
   proximity and prior project membership do not imply acceptance. Changed material, crew, destination or scope
   requires a new revision and renewed acceptance at a safe checkpoint.
3. Gather through ordinary admitted walks. Readiness requires actual footing, reach, grips, free capabilities and
   tool/material availability. Moving away invalidates readiness. A role name is not a teleport or a reach override.
4. Start against the accepted revision: recheck ownership/admission, support, full crew/load sweep, destination,
   cleanup feasibility and all claims. Acquire every necessary body capability, material and connector or nothing.
   One actor/resource cannot start two conflicting operations. Concurrent starts use deterministic commit order.
5. Run one operation on the fixed world clock. The load rides the E23 frame; carriers remain walkers. Exactly one
   role steers; its intent chooses the agreed destination, never a second motion path. Claim only capabilities in use;
   observation and unrelated speech remain available. Begin with two carriers and level routes; unsupported crew
   sizes, corners or vertical maneuvers get named refusals until separately qualified.

A persistent work node relates the accepted activity, resources and desired assembly. Shared progress is the
completed dependency/checkpoint set derived from committed part placement and joint changes, not one timer per
Soul or a mutable percentage that can disagree with the structure. Timed hand work advances only while every
required role is ready and holds its claims. Removing a required role pauses progress. A barrier commits once,
all-or-none; retries return the existing correlated per-member receipts and cannot double-install a part.

Expose the current phase, material, role, blocker, safe-stop request and actual outcome in the replica/client.
Optional presentation may derive a percentage from the same facts. A stopped operation is interrupted, not
successfully delivered. A later crew can propose the remaining work without inheriting the former crew's consent.

## Rack assembly and disassembly

The first rack journey uses loose upright and beam instances, a bay blueprint and two consenting carriers per
moving part. Carry parts to an unoccupied work zone; seat the first upright with its required holders, then the
second; install compatible beams in the dependency order that makes both uprights independently supported.
Holders release only after B18 accepts the actual committed structure. Do not require an arbitrary fixed six-Soul
cast: simultaneous roles follow the blueprint and support obligations. Temporarily occupied carriers cannot be
reused for another beam while they are still holding an upright.

Each installation uses B19's guarded transaction: reserve the destination and connectors, verify reach and clear
body/load volumes, animate the accepted track, then atomically change parent and create joints. Recheck at the
commit boundary; stale permissions, geometry or occupancy interrupt safely. A renderer observes this track and
the resulting tree; it never seats a part early. Installed geometry becomes authoritative for walking through the
existing rebuild path, including creator edits. Progress completes only when all required joints actually exist.

Disassembly reverses dependencies, not a recorded animation. First remove stored loads/occupants and verify
support and egress. Supply temporary holding/bracing before removing a beam that supports another part. B19
takes the same instance into the crew frame and removes its joints in one guarded batch. Carry it to a valid
stand or ground placement; repeat until the original parts are recovered. Removing a last support, an occupied
surface or an incompatible joint is refused with the blocking dependency and leaves the tree unchanged. No
spawning a replacement rack, deleting recovered parts, bypassing structural checks or silently moving bystanders.

Moving a completed rack is a separate operation: the current bay is `fixed`. It needs a new handling definition
and proof for the complete assembly's outline, joints and contents; individual-part carry is no such proof.
Loaded racks, decks, stairs, ladders, lifting machinery, cutting and arbitrary mesh construction remain outside
the first qualification. Refuse these explicitly rather than treating the simple support rule as a load model.

## Interruptions and persistence

Withdrawal always records a safe-stop request immediately. Before coupling it releases the participant freely;
after coupling it stops progress and performs only the disclosed cleanup. Retain physical support until a legal
set-down, independent brace or separately consenting replacement has taken it. Never erase a membership link
first and repair the falling load afterward. If no legal release exists, expose a supported blocked state and the
needed assistance; do not freeze the world or claim a bounded release time that cannot be met.

An obstruction stops the group before collision. A minor replan stays within accepted scope; a changed maneuver
requires agreement. A disconnect permits only the already accepted segment and cleanup, never a new job. Lost
tool, invalid target, creator edit and material conflict follow the same guarded interruption path. No teleport,
silent respawn, clipping, inferred new crew or clock suspension is an escape.

Persist authoritative nodes, accepted scope/revision, links, parent/support, committed work and operation/intent
identity through the existing event log. Do not serialize a second skill cursor: after restart reconstruct claims
and operation from those facts and revalidate before handing its intent back to the skill, or end it with a named
interruption at a supported checkpoint. Do not resume motion from an unverified stale plan. Prove recovery after
lift, mid-route, during seating, after joint commit and during safe stop. Retry after any such boundary must not
duplicate a transfer, joint, material or completion receipt. Active-carry restore is a required gap, not assumed.

## Phase 2 slices, after 0.131 ships

Each row is an independently reviewable outcome. Recheck the shipped 0.131 source before dispatch, use fake
minds and isolated data, and split a row further if its demonstrated prerequisite exceeds the estimate. These
estimates include focused tests and proof; they do not authorize engine implementation in this design PR.
The seven slices total **27–41 agent-hours**, including qualification and client presentation; this is an
estimate of the bounded first journey, not a spend target or authorization to start phase 2.

| Slice | Agent-hours | Likely area and acceptance/proof |
|---|---:|---|
| P1: bounded agreement and readiness | 4–6 | B5/replica and host; bind scope/revision, gather without coercion, acquire all-or-none. Two distinct activities; decline, expiry, stale accept and conflicting start produce no partial claims; served client receipts agree |
| P2: data-defined two-body carry | 5–7 | B9/E23 and kind readers; derive grips/outline/places from pinned data. Two different-sized loads through a clear level route; wrong crew, unreachable grip, narrow passage and unsafe destination refused before lift; no duplicate motion owner |
| P3: shared work barrier | 3–5 | Skills/replica and host; one progress fact and one commit per operation. Two different collaborative procedures; role loss pauses, simultaneous/retried completion commits once, incompatible second task refuses; unrelated actors keep running |
| P4: safe withdrawal and recovery | 5–7 | Activity/carry/host; reconcile leave/support, legal cleanup and restored claims. Stop, disconnect, obstruction and restart at each boundary above; blocked set-down remains supported and visible; replay/retry conserves identities and effects |
| P5: generic guarded assembly forms | 4–6 | B19/host, entry vocabulary and form-rules cases; expose take/seat/unseat with connector/slot and support guards. Rack part plus a second compatible assembly fixture; occupied, incompatible and support-breaking transactions change nothing; geometry rebuild affects real walks |
| P6: rack procedure as content | 3–5 | New kind/procedure files and cases only, after P1–P5. Assemble and reverse one unloaded bay from the same parts; absent material and premature holder release give useful blockers; another crew resumes remaining work at a checkpoint |
| P7: team journey in the thin client/page | 3–5 | `v2/client` and `v2/web`; discover forms, accept/decline, read shared phase, request stop and observe recovery. Real input in a served v2 world; member, nonmember and viewer see only permitted facts; reload shows committed state |

P1 precedes P2/P3; P4 qualifies them before exposure. P5 can be reviewed against existing B19 independently,
but owner-facing execution waits for P1/P4. P6 follows P1–P5; P7 may develop against fixed contracts but completes
after P6. Larger crews, corners, raising and assembled-rack movement each need a later bounded slice and proof.

For each new mechanism, require a materially different second fixture and a genuine refusal, deterministic
replay/idempotency checks, and focused Rust/Node/type checks on the farm. Use the applicable post-cutover proof
tier; no waiver is implied here. Visible milestones also need real-input, uncut real-speed served-world video of
success, refusal, interruption and restart with current v2 client/page, then independent review. No production
data, production walks, deployment or merge is part of this plan.

Measure idle work, events and public payload with no team operation, an irrelevant distant project, and an active
crew. Expected incremental per-tick work/events are zero when absent or idle; active work is bounded by involved
members, touched parts and nearby geometry. Record actual values and unrelated-walk behavior in the implementing
PR rather than claiming this docs-only proposal has established performance or runtime safety.
