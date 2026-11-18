# Engine v2: the trunk

Draft, local only, 16 Nov 2026. The decisions that are hard to change once code and stored history rest on
them. Everything else in the design (`../ENGINE-V2-R2-20261116.md`) is a leaf: it can be replaced later without
moving these. Three independent reviewers were asked one question, "what here would force a v3?", from three
sides: scale and topology, data and formats, and how general the simulation is.

> **Approved by Gene, 16 Nov 2026 ("Trunk stands").** The eleven contracts below are the direction. The trunk
> stop after win 1 (task T12) still happens: there he reads the eleven contract pages as the lane T tasks wrote
> them, with their checked fixtures, beside win 1's numbers. A task that needs a contract changed hands back
> and says why; it does not change it.

## Verdict

**The trunk does not force a v3**, at the target or at ten times it, **provided the seams below go in before
the core's formats freeze** (before win 2). None of the reviewers proposed a different kind of trunk; all three
proposed the same kind with more room left in it. Each seam is a field, a rule or an interface now, and a
rewrite of stored history or of every authored kind later.

What would force a v3, so that nobody builds it by accident:

| If this ships | Then this later need is a rewrite |
|---|---|
| A position stored as a point on a flat floor | Flying, swimming at depth, jumping, climbing, sloped ground, a station with its own "up" |
| Things can only rest in slots | Throwing, catching, rolling, anything that moves by itself |
| A body is "legs, two hands, gaze, voice" with one driver | Four-legged, handless or many-armed bodies; walking while carrying while talking; tools; mounts |
| Skills reach into the world's state directly | Creators' own rules; thousands of kinds without an engine release each |
| A strict tree with fixed levels and nothing else | A door between two rooms, a boat with rooms, ownership, membership, a load carried by two |
| A world's version is one number; systems read each other's same-tick state | One world on more than one writer (beyond about 10,000 moving bodies) |
| Ids are a plain counter per world | Forks and travel between worlds without collisions |
| The viewer's history is the only thing kept | Fixing a projection bug, or changing who may see what, after the fact |
| "Public, owner, creator" as three fixed values in stored bytes | A hand of cards, a team, a whisper, a moderator |
| Stored numbers and times in ticks and floats | A different tick rate; the same answer in the client and the server |

**One limit no seam removes:** several thousand bodies in one room, each perceiving all the others. Nobody has
done that without slowing time, which your rules forbid. The answer here is that *detail* gives way (a crowd
is summarised), never time, entry or acts. That is rule 7 below, and it is the overload policy.

## The trunk, as eleven contracts

Each is one task in lane T: a one-page contract in `v2/docs`, the types in `v2/crates/replica`, and fixtures
that a test checks. Gene reads the eleven pages before win 2 begins.

**T1. Space is zones.** A world is a set of zones; a zone is a subtree with one writer and one log. Every world
has one zone today. Three rules make more than one possible later: a system reads other nodes' state as of the
previous tick and writes only its own; a change that crosses nodes is a paired leave and arrive carrying a
transfer id; a joint activity is itself a node with one owner, and a door belongs to one side. The first step
past one core is ticking nodes in parallel inside one process; a second machine comes after that. Travel
between worlds is the same transfer.

**T2. The world model.** Containment is a tree, and a parent means two things only: lifetime and frame of
reference. Everything else is a **typed link** with an id, two ends and an audience, indexed from both ends:
a door joins two rooms, a Soul owns a thing, a body belongs to an activity, two bodies carry one load. There
are no fixed levels; a kind says what children it admits, so a boat can hold rooms. A node that fills up is
split into cells by the engine, and a spatial index inside each node keeps "what is near" from being a scan.

**T3. Ids, names and hashes.** An id is a minting scope plus a counter, with a new scope for every world and
every fork. Souls are global; a body is linked to its Soul. A kind is `namespace:name@hash`, where the hash
covers everything the kind's meaning depends on. Fields have stable numbers, never only names. A version is
(lineage, zone, epoch, sequence). Every hash names its algorithm and version; public and private state are
hashed apart; nothing is signed yet.

**T4. Pose and motion.** A pose is a frame, a position in three dimensions, a full orientation and what
supports it (a surface, a slot, a volume, a track, or nothing). Every movable, body or thing, has exactly one
owner of its motion: a slot, a mover, a closed-form track (at rest, straight, thrown, on a rail) or, one day,
a physics island. A hand-off carries pose and velocity. The controller takes a velocity in three dimensions
and a movement mode; only the walk-on-a-surface mode is built. Regions have kinds (ground, water, air), and a
link names the move that crosses it.

**T5. Time.** World time is its own line in microseconds. How it maps to real time, the tick rate and the
tempo are effects in the log, not constants. Beats are whole numbers. Kinds state durations in microseconds
and rates per second, never in ticks.

**T6. Effects.** Every effect has two layers: a generic change that any future viewer can apply (create,
remove, reparent, set a field, link, unlink, a motion sample) and a named event that says what it meant. Its
envelope carries sequence, world time, cause, acting Soul, audience and node. Numbers in the record are
fixed-point integers in stated units and frames. Anything hashed is encoded deterministically (CBOR with
numbered fields); each segment's header names the build, the schema by hash and the kinds it uses.

**T7. The archive is the log, and everything else is a view of it.** The full log is what is kept for ever.
The viewer's stream, the history a browser plays, and every replica are views that can be made again. Views
are computed by a tier that reads the log, never by the clock thread, once per (node, level, audience). A
subscription is a scope, a level of detail and a byte budget, and the server may lower the level. That is the
whole overload policy: under strain, detail gives way.

**T8. Audience and erasure.** An audience is the id of a set of principals, resolved when written; it is not
a fixed list. All human text and every upload is stored by reference, however short, and every view consults
a redaction list, so words can be removed from history that is otherwise never rewritten. Account ids stay
out of the log. A fork is made through an audience, so one creator's fork never hands over another's private
state.

**T9. Bodies and behaviour.** A body's family declares its resources (two hands, four legs, a beak). A skill
is an instance that claims a set of resources, with rules for what it blocks and what cancels it; several run
at once; a joint activity claims resources on several bodies. Reach is measured from an effector, which may be
a held tool. Skills touch the world only through one narrow interface (read nodes, ask geometry, set timers,
draw random numbers, emit controller inputs and effects), and the built-in skills use that same interface.
The escape hatch for behaviour that data cannot express is a pure, metered function named by its hash, with
its reads declared; that is the shape a creator's own module will have later. No scripting language is
embedded.

**T10. Intents.** An intent names its actor, the version it was decided against, an expiry, a ranked list of
fallbacks and what it replaces. Checked acts are answered; moves inside a joint activity are accepted and
then resolved. The engine carries out a closed list of orders the agent wrote (ranked fallbacks, a held
stance, follow, standing in a queue) and nothing open-ended. It holds no order that waits for a time or a
condition: when to act is the agent's business, and its client schedules itself from the clocks, calendars
and timetables the world publishes (Gene, 16 Nov). **One exception, kept on purpose (Gene, 17 Nov):** a
body whose agent has been silent for an hour is wound down by the world: it wanders, becomes a zombie,
walks out of town and sleeps until its agent acts again (today's `wind-down/1`, task B16). The record names
the world as its actor. The protocol is versioned, and a client loads the checking library
that matches the world's pinned build, by hash.

**T11. Durability and ownership.** An effect is durable twice: on the machine's disk, and off the machine.
Acts are acknowledged at the first; anything that cannot be undone (travel to another world, anything with
stakes) waits for the second. One writer per zone is enforced by an epoch number in a shared directory, which
also records where each world runs, when a sleeping world must wake, and where each Soul is. Checkpoints are
taken by amount of log, so restart time does not grow with the world.

## Settled at reconciliation

The nine lane writers checked every task against these contracts and flagged where a task and the trunk
pulled apart. Each is settled here; the lane T tasks write them into the contract pages.

| Question raised | Settled as |
|---|---|
| Is a thing held in a hand a link or a change of parent? | A change of parent, into the hand's slot: it moves with the hand, which is what "frame" means. A load carried by several has the carry activity's node as its parent, and the carriers are linked to that activity. Nothing has two parents |
| What supports a hovering body? | The surface below it, with a height. A true flying mode is a later movement mode; the pose already allows it |
| What survives a restart? | Everything in the log: poses, parents, links, holds, and orders the agent wrote. A skill in progress is not stored. On restart each active intent is handed to its skill again, or ended with a named reason |
| "Human text": does speech an agent wrote count? | Yes. All free text, whoever wrote it, is stored by reference |
| May a view carry text inline? | Yes, for the audience entitled to it. The archive never does |
| What happens to ids that existed before a fork? | They keep their ids. New things in the fork get the fork's scope. Bodies are not carried into a fork: a Soul is in one world |
| Does undo break "an id is never reused"? | No. Undoing a removal brings back the same thing with its id. An id is never given to a different thing |
| The envelope says "acting Soul", but a creator or the world itself can act | The envelope carries an actor: a Soul, a creator, or the world |
| A segment header on every small live part is wasteful | The header is written once per bundle; parts name it by hash |
| Plans of many steps against the closed list of orders | A plan is run by the agent's resident client, step by step. The engine's list stays closed |
| The directory on one machine dies with that machine | Its truth is a few small objects in the object store, written conditionally so only one writer wins (confirmed supported by the store in use). Machines keep a cached copy. No extra database |
| The eleven pages must be read before win 2, but T7 to T11 were staged in win 2 | They form a **trunk stop** between win 1 and win 2. No win 2 code starts before Gene has read them |

## Chosen, and replaceable

Rust for the core; TypeScript and three.js for the page; one process per world; files over HTTP for viewers;
the walkable ground cut from the tree; cheap separation between walkers; which CDN and which machines; the
checkpoint format; every number in the design. None of these is trunk. Each can be changed behind the
contracts above.
