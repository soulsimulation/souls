# Soul Actions direction

Current product direction, adopted 2026-11-09. Read this before planning, implementing, reviewing or handing off
Soul Actions. It supersedes salvage-first ordering and precision-first product acceptance in earlier plans;
historical measurements and failed evidence remain facts. It does not supersede engine contracts, existing
mandatory checks, proof tiers or maintainer authority.

## Goal: broaden what Souls can do

Breadth is the priority across Soul–object/asset, Soul–Soul and Soul–world interaction. An action should advance
these five outcomes, as applicable:

1. **Usable things:** assets expose state and available actions, from fridges, balls, bikes and shelves to
   instruments, containers, tools, art materials and the long tail.
2. **Real operation:** Souls use them with the necessary permission, ownership and lasting outcomes.
3. **Understandable rigging:** a person can understand how the Soul, object and any other participants interact.
4. **Visible consequences:** movement and object changes follow the authoritative state and its timing.
5. **Agent understanding:** context exposes relevant objects, actions, requirements and outcomes so agents can
   discover, reason about and use the capability.

Tests, tools and infrastructure support these outcomes. They are not a substitute for a new usable capability.
Reuse existing faculties and animations; show something working early.

## Product acceptance: basic coherence

Catch obvious body/object pass-through, feet through tables, disappearing or duplicated props, impossible
ownership, major snaps and incompatible occupancy. Keep engine authority, persistence, ownership, collision,
support and other established invariants. Never hide a prop or move an authoritative actor to fake success.

Imperfect grips, approximate contact, stiff fingers, crude transitions and nonlifelike motion are acceptable
when the action remains understandable and has no obvious contradiction. More lifelike animation and finer
contact are optional polish. A diagnostic discrepancy is not a new blocker unless it demonstrates an established
invariant failure or an obvious visible defect. Do not create new precision thresholds as product acceptance.
Preserve historical numeric results without promoting them into universal requirements for new actions.

## Mandatory engineering and proof

Follow [adding an action](../architecture/adding-an-action.md), [engine contract](../architecture/engine-contract.md),
[testing](../testing.md) and the existing [proof policy](../process/PROOF-POLICY.yml). Keep required focused tests,
conformance, walk/bundle checks when affected, tier evidence, review and approvals. Use real input and an uncut
real-speed recording where required; an early visual check helps find obvious defects before expensive proof.
Do not repeat a passing check without a relevant source change or unresolved concern.

If an existing binding requirement conflicts with this direction, record the exact requirement and escalate to
the Claude steward; do not silently weaken it. Multi-Soul and engine-contract changes retain full T3 coordination
and any higher applicable tier. Record dependencies and continue independent work while those are resolved.

## Budget, checklist and parking rule

An ordinary action using existing capability should take **30–60 minutes including focused verification**.
A genuinely complex action may take a few hours, but the current breadth portfolio caps a dispatched action at
**one lane × two hours**. Scope or split a complex action before dispatch; extra time needs an explicit decision.
These are work budgets, not permission to skip required checks or call unfinished work complete.

For each slice:

- Name the new capability, relevant five outcomes, reused faculty and bounded acceptance before edits.
- Make it visible early, then perform an actual visual check at normal speed; fix obvious contradictions.
- Verify state, permission/ownership, interruption and agent discovery as relevant, with proportionate required checks.
- Return a reviewable PR with evidence, remaining limits and optional polish clearly separated.

At the time limit, deliver or park with a concrete reason, preserved WIP/evidence, the missing requirement and
exact next step; then select an independent action. A substantial prerequisite gets its own bounded issue and
must not capture the whole tranche or multiple lanes. Avoid repeated action-diagnostic, frozen-protocol or
microexperiment approval cycles. Build a small tool only when it immediately advances one of the five outcomes.

## Priorities and dispatch

Prioritize breadth in **exercise, meditation and quiet rituals, camping, music, artmaking and open-ended land art**.
Select small independent additions that fit the available capability; dependencies are recorded, not erased.
Inclusion is direction, not authorization to bypass a protected contract or an unresolved design decision.

Every future Soul Actions dispatch and handoff must require this document, state the new capability and time
budget, distinguish basic coherence from optional polish, and name any mandatory-check conflict or dependency.
Current work and evidence belong in [#903](https://github.com/soulsimulation/souls/issues/903) and linked issues/PRs;
this document is not a second status ledger.
