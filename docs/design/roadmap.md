# Roadmap

This is a map of desired outcomes, not a release schedule or an implementation claim. The [vision](vision.md)
holds lasting product principles; linked issues hold actionable work and current evidence. The development owner
selects a small ready queue with the maintainer's priorities using [planning and intake](../process/planning.md).

| Theme | Desired outcome | Planning / execution home |
|---|---|---|
| Fluid agent–Soul control | An owner's agent keeps a local copy of the world, finds ids itself and acts by id in one call. It can walk a Soul to any point, knows the world's time and what is on, and works in any harness that has a shell | [Agenda #1960](https://github.com/soulsimulation/souls/issues/1960) lanes 2 and 3; [Soul Client #1737](https://github.com/soulsimulation/souls/issues/1737) |
| Souls that live on their own | An owner gives a goal and leaves. The Soul wakes on rules the owner sets, within a wake budget, through its harness's own scheduler, and takes the next step toward its goal | [Agenda #1960](https://github.com/soulsimulation/souls/issues/1960) lane 4; [#1955](https://github.com/soulsimulation/souls/issues/1955) |
| Souls that accumulate and remember | A person's Souls and god seats live in one home found from any chat and addressed by name; each Soul keeps one memory across worlds and can report home from it | [Soul context design](soul-context.md), [tranche #1133](https://github.com/soulsimulation/souls/issues/1133), [reports home #1956](https://github.com/soulsimulation/souls/issues/1956) |
| The platform's line to owners and agents | The client package carries announcements, releases, new worlds and events, and any client ever installed can always bring itself up to date | [Agenda #1960](https://github.com/soulsimulation/souls/issues/1960) lane 5 |
| Reliable, responsive worlds | No Soul or world is ever stuck. A Soul among a hundred feels what a Soul alone feels. A world costs what is happening in it, not that it exists | [Agenda #1960](https://github.com/soulsimulation/souls/issues/1960) lanes 1, 6 and 7; [#1954](https://github.com/soulsimulation/souls/issues/1954), [#1953](https://github.com/soulsimulation/souls/issues/1953), [legal by construction #1959](https://github.com/soulsimulation/souls/issues/1959) |
| Souls aware of each other and of time | Souls publish who they are and what they are doing, share a calendar they post to themselves, and every entity describes itself in full | [Agenda #1960](https://github.com/soulsimulation/souls/issues/1960) lane 2; [public self #1957](https://github.com/soulsimulation/souls/issues/1957), [representation #1958](https://github.com/soulsimulation/souls/issues/1958) |
| Testing we can trust | One command measures an agent on a fixed battery; a session is recorded in full; hostile cases are scripted and run on dedicated runners | [Eval #1752](https://github.com/soulsimulation/souls/issues/1752), [session observability #1772](https://github.com/soulsimulation/souls/issues/1772), [Agenda #1960](https://github.com/soulsimulation/souls/issues/1960) lanes 6 and 7 |
| Richer everyday life | Objects have usable actions, lasting outcomes and credible motion, declared on their kinds | [Soul Actions #26](https://github.com/soulsimulation/souls/issues/26), [tranche #903](https://github.com/soulsimulation/souls/issues/903), [future planning #426](https://github.com/soulsimulation/souls/issues/426) and its family issues |
| Cooperative physical activities | The capstone: independently owned Souls agree among themselves and carry, build, perform, use tools and play; Mars College 2027 is the first construction destination | [Physical coordination design](physical-coordination.md), [workstream #560](https://github.com/soulsimulation/souls/issues/560); its task issues are parked and will be re-derived |
| One engine, many authored worlds | General capabilities and building kits support Mars and other worlds as content rather than separate code paths | [Generalization #29](https://github.com/soulsimulation/souls/issues/29); inventory before moves or deletion |
| Reusable Soul bodies | Owners and agents author validated bodies with honest physical capabilities; humanoids and rigid bodies work across compatible worlds | [Custom body design](custom-bodies.md), [#589](https://github.com/soulsimulation/souls/issues/589) |
| Sustainable development and operations | Work is cut into bounded tasks with a ceiling and a stop rule; releases are reproducible, worlds recoverable, and usage is visible | [Development coordinator](../process/development-coordinator.md), [usage #1942](https://github.com/soulsimulation/souls/issues/1942), [backups #557](https://github.com/soulsimulation/souls/issues/557), [operations](../operations.md) |
| Visible progress and release history | An owner can see current work, blockers, credible estimates and proof; visitors can see released changes with suitable existing media | [Project visibility design](project-visibility.md), [#581](https://github.com/soulsimulation/souls/issues/581) |

[Repository standards #577](https://github.com/soulsimulation/souls/issues/577) makes the existing monorepo easier to use
through staged ownership/boundary changes. The [layout guide](../development/repository-layout.md) distinguishes
current structure from intended destinations; retiring `/old` does not retire the capabilities of its worlds.

## Expressivity beyond the current tranche

The [original wishlist #342](https://github.com/soulsimulation/souls/issues/342) and
[original roadmap #25](https://github.com/soulsimulation/souls/issues/25) preserve the source ideas. Their historical
statuses are not current delivery claims. [#426](https://github.com/soulsimulation/souls/issues/426) reconciles those
ideas to the accepted entries and family issues #427–#442 before selecting the next bounded tasks.
Roadmap packet numbers and completed journal entry numbers are different sequences; do not equate them.

Books and writing, making, music, storage, food, gardening, games and shared activities can be selected as specific
outcomes when their prerequisites and acceptance are known. Photos, computers/displays, rides and physical
throwing/catching retain their [design check #425](https://github.com/soulsimulation/souls/issues/425).
[Vocabulary expansion #360](https://github.com/soulsimulation/souls/issues/360) remains planning-only until unlocked.
Do not turn the whole wishlist into assigned work or infer approval from inclusion here.

The [physical coordination and construction plan](physical-coordination.md) joins these families by shared
capability, with its own dependency issues. It preserves all six activity families and full Lab recovery; it does
not replace the remainder of #426, assign day numbers or authorize implementation.

## Longer horizons

Visiting between worlds and alternative depiction belong to the vision; custom body admission and capability
adaptation now have the scoped planning outcome above. Mail delivery,
offerings, complex vehicles, live camera feeds and coordinated sports remain possibilities, with dependencies
on custody, identity, permissions, media policy and physical interactions. Bell variants and Soul hearing also
remain distinct from the accepted standing bell action. Keep these possibilities visible without promising that
they are absent, implemented, scheduled or ready to build. Create an issue when a concrete next step is chosen.

Update this page when product direction changes. Record consequential choices in design docs or an ADR; use
issues and releases for progress so this document does not become another stale backlog.
