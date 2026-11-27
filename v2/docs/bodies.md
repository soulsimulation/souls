# Bodies, skills, the host and the hatch

Engine v2 T9 (#2663), contract T9 in [TRUNK.md](TRUNK.md). It fixes what a body is (declared resources), what a skill
is (a claim on them), the one interface a skill touches the world through, and the code hatch's shape. Code:
`v2/crates/replica/src/bodies.rs` and `host.rs`; the built-in skills in `v2/crates/skills`. Fixtures:
`v2/crates/replica/fixtures/bodies/`. Checks: `crates/replica/tests/bodies.rs` and `crates/skills/tests/`. Moving
the real walk behind the interface and handing intents back after a restart (K13, T9b) are not here; running a
hatch (F8) is rule 11. The controller (B1) is summarised under [The controller](#the-controller-b1).

## Bodies and skills

1. **A body's family declares its resources:** each a name and a class from a closed list, 1 locomotion,
   2 manipulator, 3 gaze, 4 voice (a class added later takes the next number; another is `class-unknown`), and for a
   manipulator the body's slot that holds what it holds. There is no fixed body plan: four legs and no hands, two of
   each, a beak. A family is authored as a kind whose owner is `family` (SA-F1, E21), with its resources in a
   meaning section of its entry: section 13, `{1: resources, 2: actions, 3: full model, 4: simple model}` (B13,
   `kinds/body.rs`; `v2/tools/import-body` writes it for a body from the authoring kit);
   `replica` holds it decoded as `{1: name, 2: [{1: name, 2: class, 3: slot}, ...]}`, never an authored or stored
   form. Unknown fields, and two resources of one name, are refused (`not-a-family`, `resource-duplicate`).
2. **A skill claims classes or names, never anatomy:** every resource of a class (a walk takes all the legs), any
   one of a class (a carry takes one hand), or one by name (a family's own skill). So one walk runs unchanged on a
   dog and a person.
3. **A skill instance has its claims, what it blocks and what cancels it, and an end that always releases.** It
   blocks classes it does not hold (a sit blocks walking). It names the classes whose claim by a new skill cancels it
   (a new walk ends the old one). However it ends, done, cancelled, refused or failed, it releases all it holds.
4. **Starting is all or none, and every refusal has a name.** For each resource a new skill claims, a running
   instance that holds it or blocks its class gives way if it names that class in what cancels it, and otherwise
   refuses (`resource-held`, `resource-blocked`): cancelling beats blocking. A new skill that blocks a class another
   instance holds cancels that instance the same way, or is refused (`resource-blocked`); a sit never starts under a
   walk that goes on. Each resource is judged on its own: an instance cancelled for one claim still refuses another
   claim on a class it does not give way to. Also `resource-missing` (the family has none) and `instance-duplicate`. Several skills run at
   once on one body when their claims do not meet.
5. **A joint activity claims on several bodies, all or none.** Every body is planned before any starts, so a refusal
   on one body names it and changes no body.
   The activity is a node with one owner (T1), so it survives a restart.
6. **Reach is measured from an effector, which may be a held tool.** A held thing is a child of the hand's slot
   ([world-model.md](world-model.md) rule 2), so it moves with the hand and lengthens it (B12): a move that reaches
   with the hand reaches from the named tip of a tool held in it. Take and put are moves whose contact instant is one
   transfer, a leave and an arrive in one part; a thing's kind says whether it takes one hand or two (section 18,
   `motion`); a body with no hands is refused `take-needs-hands` (B4, `sim::slots`).

## The host and the wall

7. **A skill touches the world through one trait, `Host`, in `replica`:** world time (T5; never a machine's clock),
   its body, reading nodes (its body as of this tick, every other node as of the previous tick, T1), a closed list of
   geometry questions answered in integers (a distance, a point, and the bodies near it: their ids, positions and
   velocities on the node it stands on, as of the previous tick), timers on its body set and cleared (T6 rule 15),
   draws from the world's random numbers, controller inputs (T4's own `ControllerInput`: a velocity in three
   dimensions in the body's frame and a movement mode), a request to be carried across a link by the link's move
   (T4; the controller carries it, its read shows field 40 meanwhile, and a shut door on the way is opened for it by
   the world, the body as the acting Soul, while it stands that tick), and entries of its own node (T6 rule 6:
   generic changes, all or none, with the named event that says what they meant), any other node refused as
   `write-outside-own`, a motion change on its own body refused as `motion-outside-controller` and a reparent of its
   own body as `reparent-outside-controller` (it moves only by controller inputs and crossings). A skill
   is a `Skill`: its shape and a step that returns going, done or failed with a name. The built-in skills use the
   same trait. A skill only asks: the claims it holds are made by the body, so nothing it returns needs sealing.
8. **The wall is a crate boundary, and a scan for what the compiler allows.** Built-in skills live in
   `v2/crates/skills`, which depends on `replica` alone (K14's dependency list holds it there) under
   `#![forbid(unsafe_code)]`. A skill crate that names `sim`'s state does not compile, and neither does one that uses
   `unsafe`, and the crate denies float arithmetic (lane note 4). Safe Rust cannot refuse a `static`, a
   `thread_local!`, `extern crate std` or a clock, so a scan of every source file, by tokens with comments and
   literals blanked, refuses them by name: `skill-reads-clock` (`std::time`, `Instant`, `SystemTime`, `UNIX_EPOCH`),
   `skill-keeps-global`, `skill-reaches-out` (`std::env`, `fs`, `net`, `process`, `thread`), `skill-uses-hash-order`
   (`HashMap`, `HashSet`, `RandomState`), `skill-names-state` (the fixtures' harness) and `skill-allows-unsafe` (a
   crate root without the `forbid`); `use std as` counts as reaching out. A name reached through a re-export or a
   macro gets past a scan of text.
   **The walk's fields (T9b A3).** A walker waiting for a link taken in turns sets field 41 on its own body,
   `[link, distance µm]`, and clears it with `[]`; the world shows field 42 (1) on such a link and field 43, the body
   its owning node lets in, both read with `read(link)`. The owner reads the marks as of the last tick and writes
   its grants; a walker never writes the link. **N10 and N9 (T9c #3127).** The world sets on a walker's body field
   44 (1: the shoulder turn, no body pushes it), field 45 (a new route, `[count, [[x, y, z] or [x, y, z, link],
   ...]]`, walked from its first leg: N10's reroute, or the way to a standing spot N9 granted) and field 46 (1: the
   world walks it out to legal ground, and the walk stands); it shows field 47 (1) on a body standing on its own
   granted spot. Ending a walk by name is the world's: it ends the run. Field 48 is the queue spot the world assigns
   a body (B7, `[x, y, z]` in its floor's frame). **Crowds (0.133 A2-4).** A wide link is taken in turns too while
   its mouth is crowded: a walker near it that sees three bodies within 1.5 m of its end marks itself waiting
   (field 41), and the link shows field 42 until none waits and none is inside on its turn. Grants are fair, at any link
   taken in turns: a waiter passed over by later ones twice (six times at a narrow link) goes next. A walk held near its goal by a body at rest nearer it sets field 49 (1)
   on its own body and is done short of it; the world writes its `souls:move-ended` as
   `done.as-near-as-the-crowd-allows` and takes the field off. A walk to its own granted spot ends so only when a
   body at rest stands on that spot, or once held there past a way round's ticks; its spot is then released. A
   place whose own standing spots its walk reaches are all held overflows (A2-5): the next sent there is granted the
   nearest free standing point round it on the open ground (never in a room), out to 15 m, a body's room from every
   other and joined to the place on foot; it walks there, holds it like any spot (kept across a change of the ground
   while it is still one), and its walk ends `done.as-near-as-the-crowd-allows`. A place the walker cannot reach at
   all, or with no such point within 15 m, is refused `spot-none-free`. A target with no standing place on its 10 rings
   (the middle of a pond wider than they reach) has the rings go on out to 15 m, to the first with one: the walk ends on
   its nearest bank, and only a target with none within 15 m is refused `spot-none-near` (0.133). A done walk's
   `souls:move-ended` carries field 7: how far from its target the body ended, mm (0 on or inside its area; to a body,
   from that body), which the client gives as `away_m` on the walk's receipt. A walk that ends any other way
   (refused, stopped, replaced, timed out) carries none.
9. **What survives a restart is the log.** Nodes and links survive, so a joint activity and a moving group do. A
   skill in progress is not stored: on a restart each active intent is handed to its skill again, or ended with a
   named reason (K13 builds it). A body is logged where it stands, never mid-crossing: while it is carried across a
   link its row keeps where it last stood. **Every body a restart starts stands at a point it may stand on, and its
   next move is answered from there.** A logged body where it may not stand (an older log, a kill mid-climb out of a
   seat, an edit since) is resumed by one rule, in order: carried on along a clean way, never through a cut, to a
   landing or the floor's nearest legal point (`climb-out`, `resume-nearest`); else seated again in the seat it was
   climbing out of when that seat is free and, moving with a cabin, at its own stop (`resume-seated`,
   `resume-seated-other`); else placed at once at its floor's nearest legal point at least a body's width from every
   other body there (`resume-placed`). A body logged seated whose seat is still there sits in it again; with its seat
   taken it stands at the seat's stand point, or the nearest legal point to it (`resume-stood`). A body that cannot be
   placed on its own ground at all (its floor or seat gone, no legal point on it) is placed at the world's entry, where
   Souls are born (`resume-entry`). A legal point or a landing here is never ground sealed off from the main ground:
   dry ground no walk from the world's entry reaches, read on the map for the body's own size
   (`sim::mover::Floors::sealed`). A body logged in such a pocket is placed out of it; with no entry known, no ground
   is sealed. None is silent:
   each is an entry on the body, `souls:restarted` (fields 1 body, 2 how, 3 node, 4 from, in the frame the log had it
   in, 5 to), written with the first tick, which its Soul's client
   reads as it reads the ladder's; the next row heals the log. Left out, by name, while the others start: only a body
   with no recorded build, or one whose ground holds no legal point for its build at all (a world with no ground).
   One bad row never leaves a world refusing every move.

## The controller (B1)

The controller (`v2/crates/sim/src/controller`, B1 #2680) is the only way a body is moved or posed: it holds each
body's mover state and is the one caller of the mover. It also carries a body across a link along the link's line
(T9b #3120, `sim::host::carry`), and answers a dry run (what one step would do to a copy, moving nothing) for the
world's geometry answers. By its own rule, with no driver, it carries a body found on illegal ground to the nearest
legal point (N10's walk-out, T9c #3127). Skills run on its bodies through `sim::host::Runner`, a tick at a time; N7's
`Crowd` is retired (T9c). A driver is a claim
made by rule 4's rules, so a second driver asking for a held resource is refused by name and the first driver's input
stands. A driver is a skill, its staged inputs handed on by `sim::host::hand_on` under its run's driver, or a script
(`v2/tools/body-script`). One input type serves every family: velocity and mode (T4), facing and stance, set only by
the driver holding all the body's locomotion, and one move per resource, set by that resource's driver; anything else
is `resource-not-held` or `resource-missing`. An unheld resource gets the neutral input (still, hands down, facing
kept), which never moves a body. An input is logged only when it changes.

Gaze and voice (B11 #2742). Where a body looks is part of its input (a node, a point or ahead, record field 8), set
by the driver holding its gaze and logged when it changes. Its voice carries one utterance at a time: a new one
replaces the one under way or waits behind it, by the intent's `replace`, and lasts its length from its words, one
timer. The world writes each as `souls:said {1: {21: words}, 2: reach mm, 3: [hearer, ...], 4: length µs}` in an
entry whose audience says who may read it ([audience.md](audience.md) rule 4, `replica::speech`). Its hearers are
resolved when it is written and recorded (`sim::speech`): for ordinary talk, the Souls whose interest set (R4) holds
the speaker, found from the bodies within the set's leave distance, never a scan. So a body walks, carries and talks
at once, each under its own driver. Each tick the world brings the interest sets up to date after the controller's step and
writes the utterances it started (`sim::speech::heard`, #3231); the view tier addresses each utterance's entry to the
subscriptions that follow one of its recorded hearers, and to no other.

## Moves (B2)

A move (`v2/crates/replica/src/moves.rs`, B2 #2681) is data: its claims, blocks and cancels in rule 2 to 4's terms,
named phases in µs (a phase includes its start and excludes its end; contact is the instant the first phase ends), an
effector (the body, the resource it holds, or a named point of the thing held), a reach in µm (at most 700 mm) and a
contact point by name. Fixtures: `v2/crates/replica/fixtures/moves/`. `v2/crates/sim/src/moves` runs it: the reach is
asked of the geometry first (`out-of-reach` with the distance), the claim is a controller driver with the move set on
each resource it holds, and each phase end is one timer in K9's due list. Nothing polls; a later claim that takes the
move's resources cancels it at its next phase end (`claim-taken`). worldd measures a thing where the world's tree has
it as committed, up to the floor under it, from the point of each slot it stands in (#4120): a thing made into a slot
or set down a tick ago is reached where it is, not where the walkers' town last saw it (the town takes only parts that
change its ground).

**Aimed moves** (0.134 B1). A move that touches nothing says so with the effector `aim` (`{1: 4}`): a point, a wave, a
nod, a bow and a look aim at their target instead of reaching it. An aimed move has no contact, and its reach is the
target's distance, as the geometry measures it, up to `AIM_MOST` (20 m). Every other move touches, and its reach
stays at most `REACH_MOST` (700 mm), so a hand still reaches no farther than an arm. Within 20 m distance alone is
checked; a wall between does not block an aim. Beyond it, up to `SIGHT` (60 m, the client's sight), an aim at a thing
the body sees is made from afar (#5063): the geometry's `Reach::seen` says so (worldd: the thing stands on the floor
the body stands on, the open ground or its own storey, found where it stands, not by what holds it in the tree), and the act's `souls:act-ended` carries its words in field 8
(`look: from afar, 30000 mm to <id>, reach 20000 mm`), which the client gives as `from_afar` on the act's receipt (and
`act --wait`'s answer). A thing inside a building
seen from outside it (or the reverse), on another storey or past 60 m is refused `out-of-reach`, its words adding `not
in sight` or `sight 60000 mm`; one in a closed container is refused without its distance or its name (#4339). On the
open ground a building standing between the two is not checked yet. A form's move toward its thing turns the standing
body to face it first (worldd's `face_to`), near or far; the page draws that turn and the move's pose.

## Postures and seats (B3)

`v2/crates/sim/src/slots` (B3 #2682) seats bodies. A seat is one slot of a thing, with its kind's data
(`replica::moves::Place`, fixture `v2/crates/replica/fixtures/seats/`): the slot's height above the floor, taken from
the model geometry, and a point to stand at. Sitting and lying are moves (`sit.diag`, `lie.diag`). At a move's contact
instant the controller hands the body from the floor into the slot (`Controller::slot_in`, T4's hand-off from mover to
slot) with the stance the request named. Postures are the controller's stance input: stand, sit, lie. Rising
(`rise.diag`) is the reverse: at contact the body is handed back onto the floor at the stand point
(`Controller::stand`).

- **Reserved at commit.** One tick's requests are taken together and ordered by a stable key: the body's id, then the
  seat's. The first takes the seat. Each later request is refused `place-taken`, and the refusal names the holder. The
  hold is keyed by the seat's thing, so finding the holder is one lookup, never a scan.
- **A seat above standing reach is refused** `place-out-of-reach`. Its height alone is compared with the body's
  standing reach: 2.06 m for the standard 1.75 m body, scaled by the admitted build's height, unscaled for a hovering
  body (`sim::slots::standing_reach`, today's SEATDEF). The move's own reach is horizontal, to the seat's stand point.
- **A seated body has no timer and no mover.** A driver with no timer holds its legs and its stance, and the
  controller keeps it apart from the bodies it steps, so a tick never visits it. A form's move made from a seat
  (`seated` in `content/moves`: a stretch, a slump) by a body in a slot leaves the legs to the slot: it neither claims
  nor blocks them, so the seat's hold never refuses it `resource-held` (#4143). Every other move that claims the legs
  (a jump, a dance, a bow) is still refused `resource-held` there: a gateway sit writes no `posture`, so a form's
  posture need alone would not stop it. A rise during a seated stretch does not cancel the stretch, which holds no
  leg; it plays out its hand phases. A form at another thing that walks (the lamp across the room, asked from the
  sofa) rises from the seat first (`Forms::open`), once settled in it, unless the seat's thing moves (a ride, a boat):
  its rides are left by their own forms. A take of a thing within reach of the seat is done from the seat. A gateway
  walk (`<ns>:walk`) asked while seated is still refused `resource-held`; the client's answer offers the rise.
- **The engine releases the seat, never the skill.** It does so when the holder rises (at the rise's contact), and
  when the sit is cancelled before contact by a later claim on its legs.
- **Never stuck.** A later claim on the legs can cancel a sit after contact, or a rise before contact. The body is
  then handed back onto the floor at the stand point, under the new claim's driver, and the seat is released. Left in
  the slot, it would be stuck, because a tick never steps a body in a slot.
- **Climbing out** (E11d). A rise whose stand point, and the short search out from it (the body's own radius), are
  all off the floor (a boat moored with its stand point's side away from the bank, the floor changed under a seat)
  climbs out instead (`slots::climb_point`): to the thing's other stand points first, then the nearest floor within
  3 m of the seat (`CLIMB_BOUND`). A target is a dry floor point within a step's height (220 mm) of the seat's own
  floor, with no body standing within the landing room (315 mm). The straight line from the seat to it may pass off
  the floor only over water or wading ground (`Floors::wet`, the map's wet pieces) or over the seat's thing's own
  boxes (`Slots::footprint`, given by `worldd` from the tree), and once on the floor it stays on it. So it never
  crosses a wall, a fence, a box or another hull. At the rise's contact the body is handed onto the floor's frame at
  the seat's point, and the world carries it along that line at walking speed, as N10's walk-out does, waiting at the
  end while someone stands there (#4215). It never appears there. The climb is named `climb-out`
  (`slots::ClimbOut`), and the rise's run goes on once the body stands on the floor. With no such floor the rise ends
  `off-surface` at contact. The body is not stuck: it stays seated with its seat held, does what a seated body does,
  leaves the world as one does, and rises once there is floor near again. A restart that finds a body off its floor (killed mid-climb) places it where it was and
  never refuses it, so one body never stops the others starting (`Slots::resume`). It climbs on by the climb's own
  rule from where it is, over water or the boxes of the thing it is over (`climb-out`); else to the floor's nearest
  legal point when that line is as clean (`resume-nearest`); else it is never carried through a cut: it is seated
  again in the seat it was climbing out of, so its next rise climbs out or is refused by name, or, with no such seat
  free (a seat moving with its cabin counts only at its own stop, `Slots::at_own_stop`), placed at the floor's nearest
  legal point (`resume-placed`), where its next walk is answered. Rule 9 above has the whole restart rule. A thing's
  boxes are refreshed when an edit changes anything under it.
- **A taken stand point.** `slots::clear_spot` finds the nearest clear point, and the body walks there. It never
  appears there.

## Moves from the gateway (I4b)

`v2/crates/worldd/src/bodies.rs` (I4b #3156) lets an intent from the gateway drive a body. A form's verb named `walk`,
`sit` or `rise` (`eden:sit`, as T10's fixtures) is taken like any act (I4), then committed at the next tick by what
already moves bodies: a walk is N7's walk behind the host, sent to a point (`Runner::send`, N9), to a target's point
(parameter 1, `[x, y, z]` µm) or a seat's stand point, at the gait parameter 2 names (`gait:walk`, `gait:jog` or
`gait:run`, `sim::gaits`' speeds, 0.135 G1; any other is refused `move.unknown-gait`; none walks), and for a lifted
carry's front, the carry's heading at its goal (parameter 3, `[x, z]`: the crew turns with it, `moving-group.md`; read
from no other walker); a sit is B3's `Slots::commit`, one tick's sits together; a
rise is B3's `Slots::rise`. The checks are the moves' own, made as they start: claims, reach, the seat, the route.
Bodies step in ticks caught up to world time. A move writes an entry when it starts and one when it ends, both caused
by the intent, and is answered once, at its end: a receipt naming both when done, else a refusal naming how it ended
(`claim-taken`, `resource-held`, ...). A new move ends a walk still going for an earlier intent as `claim-taken`. A
sit or a rise past its act's deadline runs to its end, so a seat is never left half taken.

A form's run on the same body yields to its Soul's own walk (intents rule 10). A run whose walk is running when the
Soul's walk takes the claim on its legs ends `claim-taken` in the next tick, as one waiting for its plan does; a run
in a hand move is left (`left`) at the move's phase end. Only a running walk holds a route claim: a run that awaited
its plan with one and then goes straight to a move (an approach with no way) gives it back (S11, 0.133).

A form walker asks the planner for its line once while it is on the same floor (S11): pushed along by the bodies
round it while it waits, it keeps its question, and the line that comes back is followed from where it now is, or
asked again when it is pushed off it. A walk's place and legs are still asked for the body exactly as it stands.

C14 (#3442): a walk to a node that is neither a point nor a seat (a room, the square, an area) goes to a free standing
spot in it: its middle by E2's shared library (`replica::select`), granted by N9's table, the same every run. A walk,
sit or lie with ranked fallbacks (other targets of the same form) takes the first that holds: a sit's or a lie's
through I5's `sim::commit::bind` (the first free seat), a walk's the first with somewhere to go; none is refused by
name (`place-taken`). 0.133 Q2: a walk to a building (a node with rooms under it, not a room, the ground or a
place) ends in its main room: of its rooms at most three levels down, the one with the largest outline, the first by id
on a tie; a building whose main room the walker cannot reach is refused like any target out of reach. A walk to
another body ends 1.2 m beside it on the walker's side (along +z when they stand on different floors), and to a seated
body at the thing it sits in. That point is fixed when the walk starts: a body that moves on meanwhile is not followed,
and `away_m` is measured from where it stands at the end. A walk to the world's root is refused `move.whole-world`.
A walk to a place on the open ground (a child of the ground with an outline or a line and nothing built on it: a
range, a sea, a lake, a wood, a square, a path) goes to its edge nearest the walker, worked out on the ground's frame
from wherever the walker stands: first on it there when its middle is ground the walker may stand on and reach (an area 0.6 m inside its outline, a line on itself). An area whose middle is not (a harbour round its water) is walked into by the nearest area within it whose middle is (its boardwalk), the same way, when that area lies within 20 m of the edge the walker comes to (a river's bridge 200 m along it does not). Else, where
that cannot be stood on or the walker's part of the map does not reach it (a sea, a ridge), the first point a body may
stand on that the walker may reach, stepping back toward the walker a metre at a time from 0.6 m outside the edge. A
walker already within it, or with no such point nearer it, is there. It ends facing the nearest point of the place, or its middle when it stands on
its edge.
The started entry names what was taken: field 5 its rank, field 6 its target. Before starting,
the move is checked by `replica::move_check`, the function a client's `can` runs (R8) on its copy and its own
receipts, so its `no` is the world's name: `move.no-target`, `move.bad-point`, `resource-held` (a walk while seated),
`place-already-held`, `place-taken`, `not-seated`. A seat's holds are not in a client's copy, so its verdict on a sit
on a free-looking seat stays `unknown`.

## The wind-down (B16)

The one move the world starts on a body (TRUNK T10, Gene 17 Nov; today's `wind-down/1`): `skills::wind_down` decides,
`worldd::bodies` carries it out. A Soul whose agent has not acted for an hour (an intent with `Intent::agent_act`: a
reflex its client sends never counts) stands up and wanders (`idle`: a walk of 5 to 15 m every 2 to 4 minutes, each
ending farther from the town's centre), becomes a `zombie` 30 minutes later and walks to its sleeping spot (the
nearest open ground with 3 m of open ground round it, 3 m from another Soul's spot, within 80 m), then lies down there
`asleep`, held by a driver of its own, at the latest 50 minutes after it began wandering. Its agent's next act lets it
go on that tick (`awake`) and runs. Each move goes through `Bodies::start` like any move intent (N7's walk, B3's rise)
and is written as the world's record (cause and actor the world, event `souls:idle|zombie|asleep|awake` with the rule's
state); a restart rebuilds the rule from those records. Choices come from a hash of the body's id, never the world's
random source. It never moves a body something else holds (an open act, an order, a carry). A sleeping body is on no
due list. BUILDSAFE judges it as any body on the ground, so an edit cannot bury it. `WORLDD_WIND_DOWN=wander,zombie,
leg_min,leg_max,bound` (seconds) shortens the clocks in a test world. The page's Soul card reads its word from the
records. A restart rebuilds it from the records after its checkpoint; a body the checkpoint has lying on the ground
sleeps on, and one wandering or walking out starts its hour again.

## The code hatch, shape only

10. **The hatch is one pure function named by the hash of its module** (SA-F9, #3000): `{1: module (its SHA-256
    multihash), 2: [read, ...], 3: steps most, 4: answers, 5: why}`. Reads are declared, whole values only: a field
    of the thing `{1: 1, 2: field}` or an argument of the form `{1: 2, 2: name}`; it reads nothing else. It answers a
    verdict `{1: 1}`, one field's new value `{1: 2, 2: field}`, or a verdict and, with a yes, the new values of up to
    eight fields `{1: 3, 2: [field, ...]}` (a board's pieces, whose turn, the phase). Its steps are 1 to 1,000,000, counted by F8's own
    meter, never a runtime's. `why` is its text key. Refusals: `hatch-not-a-record` (unknown fields included),
    `hatch-module-not-hash`, `hatch-reads-nothing`, `hatch-steps-out-of-range`. One read is the engine's floor; SA-F9's
    gate asks for two, against hatches that bypass the closed lists. It sits on a form (`forms.<name>.hatch`), inside
    the kind's hash.
11. **No scripting language is embedded.** F8 (#2823) runs a hatch in one WASM interpreter inside `replica`
    (`wasmi`, `v2/crates/replica/src/hatch`), with no imports, so the world, the daemon and a page give the same
    verdict at the same counted steps. That is an interpreter of a pure function, not a language a world is written
    in. A module is refused at load by name: `hatch-module-hash-differs`, `-invalid`, `-float` (any float
    instruction), `-imports`, `-memory` (over 1 MiB), `-shape`. It exports `memory`, an `i32` global `input` and
    `run: (i32) -> i64`; the host writes each read at `input` as a count of i64 words and the words (a list or a
    record flattened in order, an enum's value as its place in the field's `values`). A hatch that answers fields
    also exports an `i32` global `output`: when `run` answers 1 it has written there, for each answered field in
    order, a count of words (at most 1,024) and the words, the same shape as a read; the form runner turns them into
    the fields' values by their definitions and refuses a misfit `hatch-answer-malformed` (past a bound, not one of
    an enum's values, the wrong number of words, more records than the list's `most`), a bad count
    `hatch-output-malformed`. Over its budget a call ends `hatch-over-budget`; any other fault `hatch-trapped`, in
    that call only. The form runner binds and calls it (`bind_hatch`, `run_hatch`); a no refuses the act
    `hatch-said-no` with its `why`.

**Step 0.** A throwaway skill crate depending on `replica` alone, naming `sim::walk::Walker`, does not compile:
`error[E0433]: failed to resolve: use of unresolved module or unlinked crate 'sim'`. The same crate using only
`replica` compiles. The boundary is a wall.

## What would quietly break this

- **A body plan in the engine** (legs, two hands, gaze, voice). Four-legged, handless or many-armed bodies need a
  rewrite.
- **A skill that names a limb.** It runs on one family only.
- **An end that does not release.** A cancelled walk keeps the legs, and the body is stuck.
- **A skill inside `sim`, or a `pub(crate)` door.** Inside one crate a later `pub(crate)` reopens state silently; a
  crate boundary cannot.
- **A pointer's address in a skill** (`&x as *const u8 as usize`). It differs from run to run; no scan sees it.
- **A static, a thread-local or a clock in a skill.** Two runs of one log would differ; the scan catches the ones the
  compiler allows.
- **A skill's progress stored as state.** A restart would resume a half-step against a changed world.
- **A hatch that reads what it did not declare, or is metered by its runtime's own count.** Clients and the server
  would answer differently.
- **A hatch named by a name rather than a hash.** A changed module would change history.
- **A trusted value a skill can make up** (a claim, a grant). The host must make those; a skill only asks.


## Released body choices

`node v2/tools/import-body/presets.ts --out <prepared> --media <checkout>` prepares every released Little Martian,
Pip, monster, ghost, centaur and procedural duck, snail and dog. Ordinary uploads keep their existing size, texture
and validation limits. Released scans require their exact manifest pin; authored examples require their existing
normalized revision pin. Procedural models were sampled once from the released source into shared model bakes, rather
than creating a rig for each Soul. The released bakes and their simple meshes are installed byte for byte from their
manifest pins (`v2/tools/import-body/released/`), never baked again: the rig's sines and exponentials differ in the
last bit between machines, and a changed byte would change the preset's hash. A changed creature is a new preset.
Meshes and sampled clips determine the admitted Small, Standard, Large or Giant class.

A Soul uses `wear <preset-or-hash>`. Successful native admission records field32's content hash; refused fit keeps
the previous body. Both live and history workers carry that field to the same crowd renderer. Only an absent hash
selects the default person. A requested model is hidden while loading, then becomes ready or named unavailable;
it never substitutes another preset. Materials, maps and UV seams remain model-specific instanced batches.

The page build accepts the explicit prepared directory as `V2_BODY_ASSETS`. Its fixed manifest validates regular
files, source pins and the complete catalogue/model/default/decoder closure before publishing `assets/bodies/`.
Install and release publish them without building the page: `node v2/tools/ops/release/bodies.ts --from <prepared>
--out <page folder>` runs the same check and writes the install's page folder (`assets/bodies/`), which the front
door serves at `/assets/bodies/` (X2).
Install and release callers prepare that input through the existing verified asset pull. No runtime model fetch
comes from a recorded arbitrary URL. Optional public-boot field7 pins the regular `bodies.json`; template creation
and fork carry only its validated bytes. Without field7 the legacy support encoding is unchanged.

The prepared catalogue also pins canonical released BODY-v1 definitions for account migration. Mapped `import-accounts --bodies` (removed in 0.134 D3) recorded choices only in the private per-world birth file. Serve validates that fixed `births.json` against its actual header and catalogue before handing choices to the existing C3 path. Existing bodies and subsequent wear are unchanged; private birth choices are never public boot support. A look the catalogue cannot carry (a custom humanoid look, an unknown definition, another URL form) is born in the default body, counted by reason in the import's row, and kept whole in the private account store for a later migration; it never silently becomes the default and never drops the Soul. A `births.json` row with no body may carry `look`, a humanoid look's params as JSON text (one object, at most 2,048 bytes, as `life:look` takes): that Soul's body is born on the default body wearing it, as if its first act had been `life:look` (Eden's old residents, `v2/tools/ops/cutover/eden-residents.mjs`). A row with both, or a look that is not one object or is too long, refuses the file.

A humanoid look made in today's editor (core/humanoid@2 params: hair, skin, top, ...) rides on the default body as the
body node's field 33 (`skills::wear::LOOK`, engine-reserved on bodies in `replica::fields`), the params as UTF-8 JSON.
It is written only by the Soul's own `life:look` (parameter 1: the params' bytes, one JSON object of at most 2 KiB), one
`Change::Set` by the body answered with a receipt; refused `look.wears-body` while field32 holds a hash, `look.worn`
when it already carries those bytes and `look.malformed` otherwise. The world does not read it; a page draws it over
the default body, and a worn hash always wins.
