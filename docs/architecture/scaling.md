# Scaling: what it is for, and how to stay honest about it

Read this before any work whose point is that Souls carries more: more Souls, more agents acting, more people
watching, more worlds. It states the goal and the rules. It is not a plan; the current plan is the scaling tranche
named on the pinned agenda issue. Mechanisms are in [load](load.md), [worlds](worlds.md) and [split](split.md).

## The goal

The whole system (web app, server, client and operations) scales smoothly across everything that grows:

1. **Souls, agents and viewers**, first. Many Souls joined to one world, many agents acting in it at once, and many
   people watching it, all in the same popular world.
2. **Worlds**, second. Their number may be capped while the first three are solved.

It should scale far enough that the maintainer can be confident on the day Souls reaches the front page of a large
site, or holds a live event with hundreds of active agents, and in a shape that can keep scaling later, to very
large numbers, without building that now.

## Rules

- **Never limit someone's experience to meet a number.** No viewer cap, no "this world is full", no queue that makes
  an agent wait, no sending people to a quieter world. A crowded world is the product. A guard that only prevents a
  crash is acceptable when it is labelled as that and is not the plan.
- **One concern, one thread or process, one limit, one gauge.** The world's clock, agents' requests, viewers, static
  files and storage must each be able to reach its own limit without slowing the others. When one kind of load
  hurts another, that coupling is the defect.
- **The engine's rules hold.** Deterministic, world time never stops, nothing teleports or respawns silently, a stuck
  Soul or world is a blocker. A change in what a body does is a new logged rule; a pure speed-up proves the same
  result. Minds stay at the edge.
- **Measure, in even and in uneven load.** Real load is skewed, spiky and shifting in every dimension: a few agents
  make most of the acts, agents act in runs and then pause, people arrive and leave in waves, crowds gather in one
  place, many react at once. Every measurement runs an even arm and an uneven one (the shared shapes live in
  `tools/bench/capacity/profiles/`). A gain that shows only under even load is reported as that.
- **Any real gain counts.** There is no pass mark below which an improvement is worthless. A measured gain lands
  unless the complexity it adds outweighs it. State the expected effect before the work and the measured effect
  after, and never tune toward the expectation.

## Five questions to ask of any scaling change

1. Which of Souls, agents, viewers or worlds does this let grow, and by how much, measured how?
2. Does it move work off a shared thread or process, or only make it a little cheaper there?
3. What does a person see when this part is past its limit: slower, or broken?
4. Was it measured in uneven load, with a crowd in one place and people coming and going?
5. Is it still serving the goal above, or has a sub-problem become the task?

## What grows, and where its limit sits

| What grows | Where the limit sits | Its gauge |
|---|---|---|
| Agents acting in one world | The world's clock thread: the cost of each act, and of moving bodies | Act wait and clock cost per act, from the agent load run in `tools/playtest/eval/` |
| Souls joined to one world | Memory per Soul in the world's process | The settled-world bench in `tools/bench/capacity/settled/` |
| People watching one world | Whoever holds their connections and sends the stream | The viewers bench in `tools/bench/capacity/viewers/` |
| What each viewer is sent | Activity in the world times the number of viewers; the machine's link | Bytes per viewer by message type |
| What a browser can draw | The page, per Soul in view | Frame time in a real browser |
| New visitors | The front door: the page, the app's code, the first picture | Origin bytes against edge bytes |
| Worlds | Memory for worlds with something moving; disk for the rest | The launcher's health page and the hundred-world bench |

Numbers are deliberately not kept here: they change with every release. The measurement issues and the tranche
carry them.
