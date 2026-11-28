# The entry format: a kind as data

An **entry** is one kind written as data for Engine v2 (spec [#2635](https://github.com/soulsimulation/souls/issues/2635)):
what a thing, a body's family or a kind of ground is, which state it keeps, where it can be held, stood at or sat in,
and what can be done with it. Entries live in `content/kinds/<family>/<name>.json`, where the folder only groups
them for people. The new engine reads the world's entry catalogue: `worldd seed --entries <dir>` copies entries
into the world, and `worldd serve` loads that world's `entries/` into its rules and activity kinds
([loader](../../v2/crates/worldd/src/serve.rs)). The development launcher copies `content/kinds` for a facts-backed
world ([run.sh](../../v2/tools/dev/run.sh)). Editing a catalogue file alone neither updates an already-running
world nor places an instance; a thing still needs the world's normal admission and placement path.

```sh
node tools/entry/format.mjs content/kinds      # validate every entry; prints each kind's provisional reference
node --test tools/entry/format.test.mjs        # the format's own tests
```

The validator is `tools/entry/format.mjs`. Its exported lists (`SECTIONS`, `NEEDS`, `STEPS`, `CHANGES`, ...) are the
format's whole vocabulary; this page explains them. Examples: [the kettle](../../content/kinds/kitchen/kettle.json),
[a bench](../../content/kinds/seating/bench.json), [a lecture](../../content/kinds/gathering/lecture.json).

## Rules that hold everywhere

1. **No floating-point number.** Every number is a whole number in a stated unit: lengths in millimetres (`_mm`),
   angles in millidegrees (`_mdeg`), durations in microseconds (`_us` or a field of type `duration`), rates per
   second (`<unit>/s`). The validator reads each number's source, so `1.0` is refused too.
2. **Nothing in ticks.** A key or unit that counts ticks is refused (contract T5).
3. **A relation is a link, never an id in a field.** A field cannot hold a Soul, body or node, and no value may be a
   Soul's id. Who speaks, who owns, whose turn it is: a typed link (contract T2).
4. **Human words go by reference.** Every phrase lives in the entry's `text` table and is named by its key; a string
   with a space anywhere else is refused (contract T8). A `text` state field holds a reference to words kept
   elsewhere, so they can be removed later without rewriting history: its default is `null`, and a form sets it only
   from a `text` argument (`{"arg": ...}`), never from words written in the entry or from another type. Words the
   entry's author wrote (a card, a form's label, a refusal's wording) are part of the kind and stay in `text`.
5. **Closed lists.** Owners, field types, audiences, point roles, needs, steps and changes are closed lists. The
   task that first needs a new member adds it, with its proof.
6. **No time of day and no waiting for a condition.** A `wait` step is a pause of stated microseconds. Opening hours
   and timetables are fields (SA-F16); when to act is the agent's client's business (contract T10).
7. **Written out in full.** A published entry `extends` nothing.

## Sections

Each section has a number, so one can be added without moving the others. Sections 0 to 19 are the kind's meaning
and are covered by its hash; 20 and up sit beside it under their own hash.

| # | Section | What it holds |
|---|---|---|
| 0 | `format` | `souls-entry/1` |
| 1 | `kind` | `namespace:name`. The hash is computed, never written in the file |
| 2 | `owner` | `thing`, `family` (a body's family) or `place` (a kind of ground or place) (E21, [#2791](https://github.com/soulsimulation/souls/issues/2791)) |
| 3 | `state` | Fields: `n` (a stable number), `type` (`bool`, `enum` with `values`, `int` with `unit`, `duration` in µs, `text` by reference, `list`, `schedule`, `timed`), `default`, `audience` (a rule); an `int` or `timed` value may have `min` / `max` (below) |
| 4 | `links` | Link types this kind takes part in: `n`, `from` (`soul`, `body`, `thing`, `place` or a kind), `most`, `most_per`, `per`, `audience` (below). A body's family declares `soul`, its link to its Soul |
| 5 | `points` | Named places in the thing's own frame: `role` (`stand`, `grip`, `contact`, `outlet`), `at_mm`, `yaw_mdeg` |
| 6 | `slots` | The children it admits: `admits` (`body`, `thing`), `kinds` (the kinds a thing slot takes; none listed takes any), `posture` (`sit`, `lie`), `most`, `at_mm`, `yaw_mdeg` (the way a body in it faces, the thing's +z turned by it; a thing placed live gets its slot rows from these), `stand` (a stand point), `board_mm` (a body's slot: when no body can stand at or near its stand point, as by a boat afloat, how far from the slot the clear ground it is got onto from may be; the step onto the slot crosses no other solid), `fits_mm`, and for a row of places `row`, `place`, `end` (below) |
| 7 | `geometry` | `bounds_mm`: [width, height, depth], the box every point and slot lies in (below); `solids_mm` (optional): the thing's own walk boxes, `[[cx, cz, hx, hz, yaw_mdeg, y0, y1]]` in its frame, given to what is placed of it in place of one box its bounds' size, so a thing with gaps (a rack frame's two posts) is walked through as one seeded from a model is |
| 8 | `forms` | What can be done with it (below) |
| 9 | `closed` | The fields and children that take the container's audience until it is opened (SA-F8, [#2849](https://github.com/soulsimulation/souls/issues/2849)) |
| 10 | (referenced kinds) | Engine v2 T3's table of the kinds this one names, written by the encoder, never in the file |
| 11 | `children` | Kinds it holds as child nodes, `{kind, most}`: a sign-up sheet's slots, a board's squares (below) |
| 13 | `vehicle` | A thing a Soul sits in or on and steers (below) |
| 14 | `ride` | A set trip between stops that nobody steers (below) |
| 15 | `stock` | The things a container is known to hold, yielded when taken (below) |
| 16 | `areas` | What a kind says about resting on it, or about a named part of its surroundings, where its shape cannot (below) |
| 17 | `roles` | An activity's roles: how much each is needed and where its members may be, and its "now" line, `now` (below) |
| 18 | `motion` | How a thing moves: `{"how"}`, one of `one_hand`, `two_hands`, `pushed_by_one`, `two_souls`, `wheeled`, `fixed` (below) |
| 19 | `loose` | How long it lasts once nobody holds or owns it: `{"ever": true}` or `{"us": <microseconds>}` (below) |
| 20 | `looks` | How it looks: `model` (a look id), `table`, the looks table, and `shape`: the parts of the thing, whole millimetres and millidegrees (below) |
| 21 | `text` | The words, by key |
| 22 | `card` | `text` (one line of purpose; `check` refuses one over 80 characters), optional `category` (one word) and `synonyms` (a list of words), each a key of the text table, never the words |
| 23 | `howtos` | A short chain of this kind's forms, with its words by key |
| 24 | `building` | A building kind's rooms, as a template's building of it has them at its def's defaults (written by `v2/tools/import-eden/export/buildings.ts`, never by hand): its walls (`solids`), `slots`, `floors`, `rooms` (each name a key of the text table), `openings` (doorways and windows), `stairs` and `doors`, in its frame, mm and millidegrees. A place of the kind gets them in the same edit (`worldd`'s `with_buildings`, #5006) |

A how-to is read by the agent's client from its copy of the entry (`how "<words>"`): the steps become acts on the nearest real
thing of this kind, at most six, each checked with `can`. A form that starts a timer is a wait, and the client continues the
chain with a wake entry of its own; the world never waits for a time or a condition.

Not defined yet, and refused with the name of the task that adds it: `reactions` (SA-F15, section 12).

**How it moves and how long it lasts loose** (sections 18 and 19, SA-F10, [#2882](https://github.com/soulsimulation/souls/issues/2882)).
Every kind of thing states both. `motion.how` is one closed list, shared with Engine v2 E5
([#2778](https://github.com/soulsimulation/souls/issues/2778)): `one_hand` and `two_hands` are carried (a cup; a chair),
`pushed_by_one` (a sofa) and `wheeled` (a wheelbarrow, a bicycle) are pushed by one Soul, `two_souls` (a bed, a long table)
by two (Engine v2 B9), `fixed` does not move. `moveBy(entry, {act, souls})` answers carry and push: a refusal names how the kind
moves (`moves_by`: "eden:sofa is pushed_by_one: it moves that way, not carried") or how many Souls it takes (`souls`).
Carried together (Engine v2 B9, 0.135 C2), a load is what its entry states: its longest side is carried lengthways, its
width is the larger of its other two sides, its two outermost `grip` points along its length are where its two carriers
hold it (each stands 0.35 m beyond its grip), and `state.carry_crew`'s default is how many must carry it (else
`state.hold_crew`'s, how many hold it standing: 0.135 C6, so a part one holds standing can take four to carry). Before the
lift, a crew too small, a carrier more than 0.7 m from its grip, and (when the lift names where the front goes) a way
too narrow for the load are refused by name (`carry-crew-too-small`, `carry-grip-out-of-reach`, `carry-load-blocked`).
A straight way that clips is searched for one that turns the load (0.135 R2: through a door narrower than its length,
carried in line, each move checked as a step is); no such way is `carry-load-blocked`, a search past its small budget
(a door near the lift, a few milliseconds) `carry-unproven`. The sweep and the search run off the world's clock, so
many lifts at once never make a tick late: a lift that names a destination is answered when its way comes back (at
the next tick when the search is quick), and one whose way has not come back by the act's deadline is refused
`carry-way-late`. A way found is said to the carry's audience at the lift (`souls:carry-way`, each pose where the front
and the back carriers stand), and the carriers walk it.
Who holds which grip ([#5067](https://github.com/soulsimulation/souls/issues/5067)) is the carry's own rule: the two
outermost grips go to the front and the back (the back the one at the carry's back as the load is held), the grips
between to the side carriers in join order from the back. It is kept on the carry's node (its field 6) and said to its
audience each time it changes (`souls:carry-grips`): `{1: carry, 2: load, 3: phase, 4: since µs, 5?: until µs, 6:
[{1: body, 2: point:<grip>, 3: grip [x, y, z], 4: [hand, hand]}, ...]}`, points in µm in the load's own (entry) frame,
the two hands 0.1 m either side of where the carrier holds along the load's length, from the carry's back toward its
front. The phases are `souls:carry` (lifted or taken), `souls:set-in` and `souls:return` (a seating's track, until it
ends), `souls:held` (seated, its crew still holding it: a frame in its bay) and `souls:released` (set down, seated or
broken off; the last holds kept). A carrier who leaves while the crew goes on holding takes only its own hold away. A load that stands as it
is held (a frame taken standing) is held by its front and its back at its edge on the line they stand on (a rack
frame's posts, a timber bent's), its lower hand at the carry's height and its upper 0.3 m above: for the 2.4 m rack
frame `[±609.5, 0, 0]` and `[±609.5, 300, 0]` mm in its own frame, which carried (its foot 1.05 m up) is 1.05 m and
1.35 m above the ground. A load is carried 1.05 m above its carriers' feet; an end carrier stands 0.35 m beyond its end grip,
or as near as 0.25 m for a load too low to block a walker where it is set down (a rack beam: its hands 0.15 m and
0.35 m ahead of it). Every carrier must be within reach of its
own hold, measured from its feet to the middle of its two hands as they are said: at most 0.7 m on the plan, and its
standing reach above its feet. No carrier is exempt, at any step:

- **Take** (`part:take`, `part:unseat`): refused `part.grip-out-of-reach`, naming the carrier and how far it stands,
  before anything is written, when any carrier would not reach its hold as the crew will hold the part. A part that
  stands is held at its edges along its carriers' line, so it is taken from beside its edges, along its wider side
  (0.35 m beyond each, within arm's reach of both hands: the client's `carry grip <part> front|back`), not from off its
  faces. A part that lies is measured, and held, by its middle.
- **Lift** (`carry:lift`): the same check against the same holds, refused `carry-grip-out-of-reach`.
- **Put** (`part:put`): refused `part.grip-out-of-reach` before anyone moves when any carrier is out of reach where the
  set-in track starts. A carrier who stepped away walks back to its grip and the crew puts again. On the track each
  carrier stands or walks beside the part, keeping its place at its grip: the world carries its body along the track's
  own line at its pace, over ground it can stand on, so it is where its hold is all the way. A set-in that moves the
  part less than 50 mm on the plan moves nobody. Beyond that a side carrier walks with the part where the straight way
  beside it is ground it can stand on, else it stands; the front and the back stand while they reach their holds at
  both ends of the track, else they walk with it. A carrier who can neither stand within reach nor walk beside the part
  refuses the put by the same name before anyone moves. While the set-in runs, a carrier who moves out of reach stops
  it by that name; the part goes back, and those who walked beside it walk back beside it.
- A rack beam goes into a bay from the bay's mouth (about 0.45 m off its slot's line: the frames' columns stand on that
  line, so nobody can stand on it within reach of an end grip). Its two end carriers stand, 0.57 m from their holds
  when it is seated; its side carriers walk in beside it, those on the bay's side into the open bay. A side carrier's
  place is 0.45 m off the load's side, so it still stands on ground when the part is seated beside it.
- Not checked yet: where the part is before a take. It still goes to its carriers' middle in one change of parent.

While it is carried (0.135 C7), with or without a destination named, every step is checked: a step that would take the
load into walls or other fixed geometry stops the carry, the load is set down where it last was, and the world says why
(`souls:carry-set-down`, `souls:carry-blocked`); its carriers walk on, free to lift again another way or leave.
Held and set down, its longest side runs from one carrier to the other (0.135 C4: a beam whose length is its z is turned
a quarter turn; an upright, whose length is its y, is laid flat). The carry itself is an entry too,
`content/kinds/construction/carry.json`: its two roles (`front`, `back`) make it an activity kind in a served world, and
its first slot admitting a `thing` is where the load rides.
`loose` is how long a loose thing lasts once nobody holds or owns it, Engine v2 F10
([#2773](https://github.com/soulsimulation/souls/issues/2773)): `{"ever": true}` or `{"us": <whole microseconds above zero>}`;
owned, or in a slot, a thing lasts. Both are meaning, so covered by the hash; a body's family says neither.
**The six things any thing allows** (go to, look at, point at, touch, lean on, wait by) are forms of the body's own entry
(`content/kinds/body/humanoid.json`, SA-G3) that take any thing; a kind writes none of them. A kind forbids one by name in an
area's `forbids`: leaning is `lean`, the others are `go_to`, `look_at`, `point`, `touch`, `wait_by`
(`content/kinds/street/railing.json` forbids leaning; `allowsBase(entry, form)` answers `forbidden` with the name and the area).
Cases are data: `tools/entry/cases/motion.json` and `packages/form-rules/cases/base.json` (a lamp post with no forms).

**Where to put it** (SA-F11, [#2883](https://github.com/soulsimulation/souls/issues/2883); one list with Engine v2 E2
[#2709](https://github.com/soulsimulation/souls/issues/2709) and E4 [#2772](https://github.com/soulsimulation/souls/issues/2772)).
A `put` step may carry `place` instead of a `slot`: `{"at": word, "anchor": {"arg": ...}, "facing": ...}`. The words are one closed
list in `packages/form-rules/placements.json`, which the format reads and nothing else repeats: `on`, `in`, `here`, `next_to`,
`in_front_of`, `behind`, `against`, `facing`, `middle` (of this room). The anchor is an argument of type thing, named or described
by a selector (a `takes` entry with `select`). `facing` is `{"toward": argument}`, `as_it_was` or `to_wall`; the word `facing`
turns a thing where it stands, so the position is not touched and no `facing` field is written beside it. A kind with no front
(a round table) says `geometry.front: "none"`; the default is `"z"`, the front the frame names. `place(thing, placement,
{anchor, facingAnchor, node, anchorNode})` decides only what plain data can: the thing may be moved (`fixed` is refused), the
anchor is named and is another node (`self` is decided by node id, so two chairs of one kind may stand next to each other), a
front exists where the word needs one (`behind` and `in_front_of` need the anchor's, `facing` and `toward` need the thing's). A
refusal has a `code` (`no_front`, `no_anchor`, `fixed`, `unsaid`, `self`, `unknown_word`, `unknown_facing`) and names the word and
the kind. The spot is the engine's choice, recorded (E4); whether it is free and legal is the world's answer. Cases:
`tools/entry/cases/placements.json`.

**Areas** (section 16, SA-D6, [#2861](https://github.com/soulsimulation/souls/issues/2861)). Engine v2 E3
([#2777](https://github.com/soulsimulation/souls/issues/2777)) finds where a body can sit, lie, stand or lean from a
kind's surfaces and shape, and E4 ([#2772](https://github.com/soulsimulation/souls/issues/2772)) lets a thing be set
down on any surface, so most kinds write no area. E3 reads a declared area first, then surfaces, then shape; the spot
a body or thing gets is the engine's choice. An area is a name and any of: `allows` (a posture, `sit`, `lie`, `stand`
or `lean`, to where: `on` the thing or on its `edge`), `forbids` (postures, by name), `takes` (kinds of thing that may
be set down on it) and a place, `at_mm` and `radius_mm` (whole millimetres in the thing's own frame, within 20 000 mm),
a named part of its surroundings: a tree's shade, a river's bank. A placed area is named by a `walk_to` step like a
point, so a body can be sent to it. Names are one list with points and slots. Refused: an area that says nothing; a
posture both allowed and forbidden; a forbidden posture the kind's own slot seats; and an area that only repeats what
the kind's slots already say (the check gate reports it under `shape`). A bed (`content/kinds/rest/bed.json`) allows
lying on it and sitting on its edge; a piano forbids lying on it and seats its pianist at the bench; a tree declares its shade. A rug or a lawn needs
no area (a body sits on the ground, SA-G3), and a thing that hangs uses a hang slot (SA-D3). Cases are data
(`tools/entry/cases/areas.json`). Section 16 is meaning, so covered by the hash.

**An activity** (section 17, SA-G1a, [#2872](https://github.com/soulsimulation/souls/issues/2872); Engine v2 B5,
[#2724](https://github.com/soulsimulation/souls/issues/2724)). A group activity (a lecture, a supper) is a node Souls enter.
Its kind is an ordinary entry plus `roles`:

```json
"roles": {
  "speaker": { "need": "required", "places": { "in": "this", "slots": ["lectern"] } },
  "listener": { "need": "optional", "places": { "in": "here", "posture": "sit", "within_mm": 12000 } }
}
```

A role is one of the kind's link types whose `from` is `body` or `soul`; membership is that link, and its `most` is how
many the role takes. `need` is `required` (the activity cannot start without it), `replaceable` (required, and another
may take it while it runs) or `optional`. `places` says where a member may be: `in: "this"`, the kind's own `slots` in the
order listed, each admitting a body; `in: "here"`, body slots of things in the same place within `within_mm` (whole
millimetres above zero) of the activity, nearest first. Either may name a `posture` (`sit`, `lie`). Entering is an
ordinary form that links the role to the actor and reparents the actor into a slot argument; the world moves no body.
On the new engine (0.135 G3), a role's `slots` (`in: "here"` may list them too) are where its members stand when the
activity starts: each slot's `stand` point, else the slot, in the activity's own frame. If all members stand on one
floor, each walks to its stand and turns to its facing before the moves begin; a member farther than `within_mm`
from their middle, or anyone when they stand on different floors or one is seated, stays where it is.
On the new engine (0.135 B10), an activity offered or proposed at the entry's own thing (the offer's target is the thing)
is that thing's: a Soul that offers in a role, or accepts or joins one, holds the role's link on the thing while it is a
member, so the kind's forms that ask for it (`who: {"link": "<role>"}`, `"need": "linked"`) pass for it and refuse others
by name. Its leave, or the offer's lapse or decline, takes the link down. Offered on the open ground, it links nothing.
A role may name a `move` of `content/moves` (0.134 T1): when the activity starts, each member of that role aims the move
at the other member, as a handshake, a hug or a high five (`content/kinds/together/`) does. The accept checks the move's
reach from the places the two will take, not from where they stand (0.134 item 5), so two who walked up to each other
can touch; each may step at most the move's reach to its place, so a pair farther apart is refused `together.too-far`
before anyone moves. A walk to a place ends within 5 cm of it, so a kind's places sit at least 10 cm inside its moves'
reach.
A role's move whose last phase holds (`hold_hand`, 0.134 T2) lasts until a member leaves or walks; then both are let go.
`"on_beat": true` (0.134 T3) puts the move on the world's beat: each member's begins on one beat, at its own body, and
again on the next beat after it ends, until the member leaves. The role's link `most` is how many take it, so a dance
(`dance_together`) offered to several takes up to eight.
`"follows": true` (0.135 G2) marks the role whose member follows the other's: once the offer is accepted, the follower's
own `souls:follow` order (`v2/docs/intents.md` rule 5) walks it along the leader's trail, 1 to 2.5 m behind, until either
leaves, the follower acts on its own, or the order ends (`follow`).
Starting, leaving and ending are SA-G1b's and B5's; the rules are `packages/form-rules/src/activity.ts`. Section 17 is
meaning, so covered by the hash.

**Vehicles and rides** (SA-F14, [#2884](https://github.com/soulsimulation/souls/issues/2884)). A kind says what a vehicle
is, never how the engine moves it. `vehicle`: `drive` (a slot admitting one body, posture `sit`: the drive seat; every
other body slot is a passenger seat), `steer` (a form of this kind, `who` is `holder`, with a `move` step: whoever holds
the drive seat steers), `speed_mm_s` (whole millimetres per second above zero), `ground` (`level`: ground without doors,
stairs or ladders; `deep_water`: water deep enough to swim in). Its size is `geometry.bounds_mm`, which is required.
Getting on and off is only while it stands still, and only where the rider could stand (`level`, `shallow`) or swim
(`deep_water`): `dismount(entry, {moving, spot})` answers with the code `moving` or `no_footing` and a reason naming the
spot (`door`, `stairs`, `ladder`, `blocked`). The cases are `tools/entry/cases/vehicle.json`.
`ride` is for a boat that is not rowed, a sail, and for a ride on a track (a big wheel, a carousel, a balloon, a cable car):
`seats` (body slots), `stops` (two or more `stand` points in the order of the trip; a round trip names its one stop twice),
`returns` (across and back, or ending at the last stop), `start` (the form an actor starts the trip with),
`speed_mm_s` and `ground`, which for a ride may also be `air` (a cable or a flight: a rider gets on and off only at its
stops). On Engine v2 a ride whose stops are one point, that does not return and whose ground is `air` (a balloon) flies a
loop from its stop and back, the thing and its riders together (`sim::courses::rides::course`, from the entry the thing
names, its world's map's included): it waits a minute at its stop each lap, a rider boards and leaves only there, a
form asked while it is away is refused `boarding-frame-away` saying in how many seconds it is back, and its trip ends
when it is home again (below). A ride whose stops differ moves its seats, never the thing (N14, `sim::courses::rides::seat_runs`):
across and back (`returns` true, a cable car) each seat waits at the stop its `stand` names, then runs to each other stop
keeping its offset from the stop's stand point and its height over the floor there; round a ring (`returns` false, three
or more seats, a big wheel or a carousel) the seats turn one step at a time between their declared points. Each waits
3 minutes at a stop. So a ride's seat is declared where it waits for riders, beside its stop and within standing reach.
The old page draws a cabin at each seat that moves, unless the ride's def has cars of its own (a big wheel's gondolas). A rider
boards only at its seat's own stop, gets off at any stop within reach, and is carried on between them (a rise there is
refused `boarding-frame-away`; a form that sits is refused before any walk while no cabin waits at its stop, saying
when the next is back). A trip ends when the seats next come to a stop: the fields its `start` form `set` (a bool or a
whole number, such as `under_way`) go back to their defaults, so a ride set off once is boarded again. A kind is a
vehicle or a ride, not both. Eden's own are in `content/kinds/vehicles/` and `content/kinds/rides/`
(SA-X33, [#2923](https://github.com/soulsimulation/souls/issues/2923)). Sections 13 and 14 are meaning, so covered by the hash.

**Stock** (section 15, SA-F12, [#2851](https://github.com/soulsimulation/souls/issues/2851)). What a bookshelf, a
wardrobe, a fridge or a stall is known to hold, made real when someone reaches for it. A stock is
`{kind, count, take, carries, refill}`: the kind it yields; `count`, an `int` state field in unit `count` with `min` 0
and a `max` (so it runs out; its default is how many a copy starts with); `take`, the form that takes one; optional
`carries`, one to four text fields of the yielded kind that come by reference from a library the world's creator
supplies (a book's title and first page); optional `refill`, `{every_us}`, one more every so long up to the `max`
(a timed value, SA-F5a). The take form is checked: it is a Soul's act that needs the count `at_least` 1 (an empty
stock refuses) and a free hand, and its one `create` makes the kind into `actor_hand`; it never sets the count. The engine
lowers the count by one in the same batch as the make (`takeStock` shows the batch: a `create` and a `set` with `by` -1), so
nothing is made from nothing, and the check gate's `makes` rule counts the stock as what pays for it. Stock is free to
take; buying, lending and debts are not here. A kind whose contents are
closed lists `count` in `closed.fields` and shows its stock only once opened (`stockOf` answers `null` until then; a shelf
or a stall is always open). The cases are `packages/form-rules/cases/stock/stock.json`. On the new engine
([#4837](https://github.com/soulsimulation/souls/issues/4837)) a world seeded with its stock file
(`worldd seed --stock content/worlds/<world>/stock.json`, `v2/crates/worldd/src/stock.rs`) works out each container's
pile from its stock row and draw; a take gives the thing it makes the carried fields of the row at the top of the pile,
as references to the library row's words, which the world serves beside the record as public words. It does not yet
lower the count. Eden's own storage
(`content/kinds/storage/`, SA-X26 [#2916](https://github.com/soulsimulation/souls/issues/2916)) names each stock's take form `take`. Section 15 is meaning, so covered by the hash.

**Links, children and lists.** Who belongs, who owns and whose turn it is are links (contract T2,
[#2641](https://github.com/soulsimulation/souls/issues/2641)), each found from either end. A link type is declared on
the kind at one end: `from` says what may be at the other end (`soul`, `body`, `thing` or a kind), `most` how many
`from` ends one of these takes (a slot has one signer; a lecture one speaker), `most_per` how many of these one `from`
end may be linked to (a Soul signs up to three slots). With `"per": "parent"`, `most_per` is counted among the things of
this kind under one parent, not across the world: one signature per Soul per guestbook, one vote per poll. The
`most_per` need reads it (below); a world-wide `most_per` is not read from one thing. A record that points at a Soul or a thing is never a list item:
it is a child node, declared in `children` (section 11) with a bound, and the Soul is a link on it. A sign-up sheet has up to 20
`eden:signup_slot` children; who signed a slot is its `signed` link, found from the Soul and, through its children, from
the sheet (`content/kinds/signup/`). What a thing admits is a check at commit by plain kind name (or category), never a hashed reference: the parent's hash covers its own `children` list but does not follow into the child kind. Holding is a change of parent, not a link.

A body's family declares the link type `soul` (`from: "soul"`, `most` 1): a body's link to its Soul (contract T2). A
link declared `from: "soul"` on a thing (an owner, a speaker) has a Soul at its end while the actor is a body, so who-may
follows the acting body's `soul` link (SA-F7a, [#2848](https://github.com/soulsimulation/souls/issues/2848)). Only a
body's family declares it.

**Bounds and timed values.** `min` / `max`: whole bounds of an `int` field (or a timed value); an amount moved never
takes it past them. A `transfer` fills to `max` and draws down to `min`. A `timed` field is a value that changes with
time (SA-F5a, [#2845](https://github.com/soulsimulation/souls/issues/2845)): `unit` (a whole-number unit: `count`, `mm`,
`g`, `mg`, `mC` or `permille`, or `us` for a countdown), and a default
of three whole numbers, `{"value", "per_s", "set_us"}`: the value in that unit, its rate in that unit per second, and the
world time it was set, in microseconds. A slow process takes a small unit so its rate stays a whole number a second:
the planter's water (SA-V4a) is in mg and dries at 5 mg a second (18 g an hour), and its stages come from timers a
world day apart. A range need reads it at the state's time; the arithmetic is
`packages/form-rules/README.md` ("A timed value").

A `list` field holds a short bounded list of small records: `most` (required, 1 to 100, so it stays in tens: it is set
whole on every change, Engine v2 F11, [#2774](https://github.com/soulsimulation/souls/issues/2774)), `of` (one to eight
named fields, each `bool`, `enum`, `int` or `duration`; never text and never an id, so a Soul cannot be inside a
record), an optional `key` (a field of the record; the rules add, remove or set one item by it) and an empty default.
`stateAtMax(entry)` counts a kind's state with every list full and every child kind at its bound; the check gate uses
it rather than the empty default.

**Schedules are data** (SA-F16, [#2854](https://github.com/soulsimulation/souls/issues/2854); feeds Engine v2 E7, R15).
Every "when" the world knows is a state field of type `schedule`, never part of a form: `{"n", "type": "schedule",
"most": 1 to 100, "default": [entries], "audience"}`. An entry is `{"repeat": "once", "from_us", "to_us"}` (two world
times, whole microseconds) or `{"repeat": "weekly", "days": ["mon", ...], "from_us", "to_us"}` (one to seven different
days of `mon` to `sun`, between two local times of day in whole microseconds, `to_us` after `from_us` and at most a day;
an evening past midnight is two entries). Local time is the clock of the place the thing stands in. A shop states its
hours as weekly entries; a weekly class states its sittings the same way; a one-off opening is a `once`. The default
is the hours a copy starts with; its owner sets the list whole. A form never writes a schedule. A ride's timetable is not
stored: it follows from its track (Engine v2 E7, N12). The world never waits for a time, reminds a mind or starts a
form at one: the client reads the schedule and acts when it chooses. A form that carries a start time (`at`, `start`,
`until`, `when`, `schedule`, ...), a step or need that waits for a time or a condition (`wait_until`, `time`, ...) is
refused, naming the field. Its only waits are a stated pause (`wait`, `us`) and a timer the world itself sets
(`timer`, `after_us`). A calendar entry is a kind (`content/kinds/calendar/entry.json`): `start` and `end` (durations
as world times), `words` (by reference), links `place`, `poster` and `interested`; `post` is a form, interest a link. No
new section number: a schedule is a field type in `state` (3). `stateAtMax` counts three values an entry.

**Audience** is a rule on every state field and link type, written out (there is no implied default), from one closed
list (`AUDIENCE_RULES` in `tools/entry/format.mjs`): `{"rule": "everyone"}`, `{"rule": "owner"}` (the thing's owner),
`{"rule": "linked", "link": "<link type>"}` (whoever is linked to this thing by that link of this kind: its members,
the Soul whose turn it is) and `{"rule": "creator"}` (the world's creator). A rule names a link type, never a Soul.
A kind may add a `closed` section (9), `{"audience": rule, "fields": ["stock"]}`: the fields it names, and its
children, take the container's own audience until it is opened (Engine v2 E22,
[#2792](https://github.com/soulsimulation/souls/issues/2792)); those fields declare no audience of their own, and the
rules (`@souls/form-rules`) read a need on one with the container's audience.
Delivering to viewers is the new engine's view tier. Point and slot names share one namespace, so a form's argument of type
`part` or `slot` can name "the top drawer" or "the left seat" and one form serves every part.

**Points, slots and the thing's own frame** (SA-D3, [#2855](https://github.com/soulsimulation/souls/issues/2855);
feeds Engine v2 K3, E2, E3 and B3). Every place is whole millimetres in the thing's own frame: the origin at the centre
of its footprint on the ground, x to its right, y up, z to its front. `bounds_mm` is [width, height, depth], so x runs
from -width/2 to width/2, y from 0 to height, z from -depth/2 to depth/2. A point is a name, a `role` (`grip`, `contact`
for a button or switch, `outlet` for a spout, `stand` for where a body stands, `joint` for a connector), a position and
an optional `yaw_mdeg`. A `joint` point is where a part joins another (Engine v2 B17,
[#3338](https://github.com/soulsimulation/souls/issues/3338)): it names its `connector` kind and the kind it `mates`
with (a rack beam's `beam_end` mates with an upright's `beam_seat`); no other point names either. The joint itself is a
link (section 4), never a parent: a beam seated between two uprights is a child of its bay
(`content/kinds/construction/`). The kind that declares the joining link bears on the kind it names, which stands; a
kind whose link names a kind that itself bears rests on it, a tier up, and needs as many of those held up as the link's
`most` (a shade cloth on its two rails, `content/kinds/carpentry/`).
A point or slot more than 100 mm outside the bounds is refused (a handle may stand proud of the box); a `stand` point
may lie up to 2000 mm outside, within a body's reach of the thing. A kind with any point (other than a stand) or slot
declares its bounds.

A thing slot may list `kinds` it admits (`"kinds": ["eden:cup"]`); a slot that lists none admits any thing, and a body's
slot lists none. Today's slot kinds and heights (seat, bed, surface, stand, hang, shelf) are carried as they are. Engine
v2 E3 (#2777) reads surfaces and shapes to find where a body can rest, so an entry need not declare a seat for every
place a body might perch.

A row of places names the slots in it with `row` and `place` (1 at the first end, counting up), and the two ends with
`end`: the lowest place says `"end": "first"` and the highest `"end": "last"`, so that "the stool on the end" and "the
back row" resolve (Engine v2 E2, #2709). A middle place names no end. Cases are data (`tools/entry/cases/slots.json`).

`looks.shape` is the parts of the thing the look gate draws (`node tools/entry/look.mjs`): `shapes`, `round`, `palette`,
`tags`, in whole millimetres (a polygon's points too), with an angle in whole millidegrees and a part's `scale` and
`glow` in permille. The format has no floating-point number and `look.mjs` converts to metres and fractions only when it
draws; a text, list or schedule field changes no part, so it is not drawn.

**The code hatch** (SA-F9, [#2850](https://github.com/soulsimulation/souls/issues/2850); Engine v2 F8
[#2823](https://github.com/soulsimulation/souls/issues/2823), T9 [#2663](https://github.com/soulsimulation/souls/issues/2663)).
A form may carry one `hatch`, for the rare thing no declared form can say (whether a chess move is legal, which step of a
lamp's pattern is lit). It is not a section: it is a key of the form, so the kind's hash covers it. It holds no code:

```json
"hatch": { "module": "prov-1220<64 hex>", "reads": [{"field": "pieces"}, {"field": "turn"}, {"arg": "from"}, {"arg": "to"}],
           "steps_most": 20000, "answers": "verdict", "why": "why_chess" }
```

`module` is the hash of the function's WASM module; `reads` is every field (a bool, enum, int, duration, timed value or
list) and every `count` or `duration` argument the function may see, and nothing else; `steps_most` is the meter, from 1 to
1 000 000; `answers` is `"verdict"` (the form can be done only if the function says yes) or `{"field": <name>}` (its whole
number answer is that field's new value); `why` names a text entry saying what no declared form could do. The function is
pure: no I/O, no clock, no randomness, no float, the same bytes in Node, the browser and the new engine. The check gate
(rule `hatch`) refuses a hatch that reads fewer than two things, or only bool fields with a verdict (a declared form's needs
say those), and a kind with more than four. It prints the number of hatches in the kit, and marks an entry that names one
`waiting_for_engine`: until Engine v2 runs hatches, such an entry is validated, hashed and checked, never run. Cases for the
two known uses are data (`tools/entry/cases/hatch.json`). No function is written.

## A form

```json
"switch_on": {
  "who": "anyone",
  "starts": "act",
  "needs": [{ "need": "state", "field": "water", "not": "empty" }, { "need": "within_reach", "point": "button" }],
  "steps": [{ "step": "move", "move": "press", "at": "button" }],
  "effects": [{ "change": "timer", "form": "boiled", "after_us": 150000000, "event": "boil_started" }]
}
```

- **who** may: `anyone`, `holder`, `world` (a form a timer starts, and only such a form), or `{"link": <type>}`.
- **starts**: `act` (a Soul's act) or `timer` (set by a `timer` change).
- **takes**: named arguments, typed `slot`, `part`, `thing`, `text`, `duration`, `count` or `placement` (one of the
  placement words below, chosen when the form is done; a `put` step's `place.at` may be such an argument). A `slot` or `thing` may
  be described with `select`: a candidate set (`of`: `things` or `free_slots`, optional `kind`, `in`: `this`,
  `here` or `parent`), an `anchor` (`me`, `this`), an `order` (`nearest`, `furthest`) and a `rank` (1, 2, ... or
  `last`), the same closed list as Engine v2 E2 ([#2709](https://github.com/soulsimulation/souls/issues/2709)).
  A `thing` argument the act leaves out is bound by its selector when the act commits (#3914): `in: this` the
  thing's own children, `here` those of the node the actor is in, `parent` those of the thing's parent, never the
  thing, the actor or a body; by squared distance from the anchor, ties by id; then the rank. None qualifying is
  refused by name: `none_selected` in the rules (`@souls/form-rules`), `thing.none-selected` from the world.
  Anywhere a point, slot or value is expected, `{"arg": <name>}` uses an argument. Two more types are a **choice from
  the form's own closed list**, `of`: `field` (two or more of this kind's state fields, of one type) and `value` (two
  or more values). A `set` or a `state` need may name a field argument as its `field`, and a value argument as its
  `to`, `is` or `not`: every choice is checked against every field it may meet, and the rules refuse an act whose
  choice is not in the list (`bad_input`, `not_a_choice`), so a form never writes a field it does not name. A field
  argument used as a place (`walk_to`, a move's `at`) needs a point, slot or placed area of the same name for each
  choice. A pruning shrub's one `prune` takes `{"shoot": {"type": "field", "of": ["left_low", ..., "right_high"]}}`
  and sets `{"field": {"arg": "shoot"}, "to": false}`; a sand garden's `brush` takes a `cell` (field) and a `pattern`
  (value, `along` or `across`). A refusal of a need compared with a value argument names as its fix the same act with
  another choice of that value (brush the other way); another choice of a field is another act, never a fix.
- **needs**: `state` (a field `is` or is `not` a value, or an `int` or `duration` field `at_least` and/or `at_most`
  a whole number), `slot_free`, `within_reach` (of a point, or of a `thing` argument), `held_by_actor` (this thing,
  or `{"thing": {"arg": ...}}`), `moves` (`{"thing": {"arg": ...}, "by": "carry" | "push"}`: the thing's kind moves
  that way by its section 18 `motion.how`; carrying takes as many free hands as it says, a push by one body is refused
  for `two_souls`; refused as `moves_by`, `motion_unsaid`, `needs_souls` or `no_free_hand`), `hand`
  (`{"free": true}`, one hand free; `{"empty": true}`, every hand empty; or `{"holds": "<namespace:name>"}`, a kind
  the hash follows), `linked`, `unlinked` (whether the link has any end; with `"end": "actor"`, whether the actor is
  one of its ends, so "only its author takes a note down" refuses with the original's words), `most_per` (the actor is
  linked by this link to fewer than its `most_per` things of this kind under this thing's parent, the link declared
  `"per": "parent"`; a thing under no parent counts alone; a refusal is `already_linked` with `on`, the things that hold
  the actor, so moving a vote is taking it back there first), `not_in_hand` (this thing is in nobody's hand, else
  `in_hand`; the actor's own hold names `put` as the fix: a lantern is set down before its wick is worked), `room`
  (no parameters: every amount the form's transfers move has room where it lands, else `no_room`; only on a form with a
  `transfer`), `enough` (no parameters: every amount the form's transfers ask is there to give at the source, else
  `not_enough`, so a pitcher asked for more than it holds refuses rather than pouring less), `sum` (below). A range
  need also takes a `timed` field.
  A `state` need with a `link` reads the **place the thing stands in**: `{"need": "state", "link": "place", "field":
  "rain", "at_least": 101}`, where the link type is declared `{"from": "place", "most": 1}`. The field is the place
  kind's, read by its number and only by its audience; the place is never read from the tree, since a parent means
  lifetime and frame only (Engine v2 T2, `v2/docs/world-model.md`), and never from a global weather call. Who links a
  thing to its place is outside the kind (Engine v2 E4, E6); a rain collector collects only while it rains there.
  A `state` need with `of` reads the **thing an argument names**: `{"need": "state", "of": {"arg": "mug"}, "field":
  "dirt", "at_most": 0}`, where `mug` is a `thing` argument. The field is the named thing's kind's, read by its number
  and only by its audience (an asker outside it gets `unknown` naming the thing and the field); a missing argument is
  `bad_input`. A coffee grinder doses only a washed, empty mug; a fire toasts only the skewer side not yet golden.
  A `sum` need adds two or more `int` fields of this kind, of one unit: `{"need": "sum", "fields": ["well_green",
  "well_mint"], "at_most": 4}` (`at_least` and/or `at_most`, whole numbers). With `"after_moves": true` it adds them as
  the form's transfers would leave them, so a capacity shared by several fields is never overfilled: a tea caddy's well
  holds four portions across its green and mint.
  An `any` need asks that at least one of two or more fields of this kind is `not` a value written out:
  `{"need": "any", "fields": ["back_left", "back_right", "front_left", "front_right"], "not": "smooth"}`; a refusal is
  `field_differs` with every field's value (`detail: {fields, found, wanted}`). A sand garden that is smooth everywhere
  refuses to be smoothed ("The sand is already smooth.").
  Any need may name its refusal's words with `says`, a key of the `text` table (words by reference, SA-F6b), so a
  conversion keeps the original's wording: `{"need": "hand", "empty": true, "says": "put_down_first"}`.
  SA-F2 evaluates them. **Reach to another thing** is read in this order: (1) the walk, taken as done: entries store
  no position for a loose thing (Engine v2 holds poses, and today's adapter walks first), so `within_reach` of a
  `thing` argument that the form `walk_to`s is met when the thing is in the actor's place, and refused `out_of_reach`
  when it is elsewhere; (2) else the measured pose: `"of": {"arg": ...}` names the thing whose point it is, placed by
  that node's `at_mm` in the input; (3) else `unknown`. A kettle's `fill` takes the nearest `eden:tap` (a selector on a
  kind) and moves toward it: the water comes from a thing in the world, never from a refill the kettle does by itself.
  Its effect is a `transfer` of `water` (grams) out of the tap and into the kettle until it is full, so a need for water
  on the switch names `fill` as its fix.
- **steps**, each a move or the walk: `walk_to` (a point, or a slot's stand point), `sit`, `rise`, `move` (a move
  by name, `at` a point, `toward` an argument; moves are their own data, SA-D4; `for_s` repeats it back to back, with
  no pause, for whole seconds from 1 to 3600, written out or `{"arg": <a count it takes>, "default": <seconds>}`
  (with no default, a move the act gives no such count is done once: a wave, unless asked to keep waving): the
  humanoid's `dance for=60` dances a minute, `dance` alone (default 3600) until the Soul's next act or `stop` (a
  stop or a walk ends it at the move's next phase, another form at once); its held activities and gestures are listed in `content/kinds/body/humanoid.json`;
  the log holds a
  record of it for viewers at its start and every 15 s (a viewer who comes in mid-dance draws it from the next), each
  planned to the latest it can end, and the run's end says where it stopped), `take`, `put`, `use_held`,
  `wait` (`us`), `settle` (`posture`, `sit` or `lie`: a ground posture taken where the body stands, with no slot;
  SA-G3, [#2875](https://github.com/soulsimulation/souls/issues/2875)). A form that starts with a `take` naming no
  move (a cup's `take`) first walks to its thing, unless the body is already within reach; the hand step of a `take`
  or `put` naming no move lands only with its thing within reach of the body, else the run ends `out-of-reach` with
  nothing moved ([#4086](https://github.com/soulsimulation/souls/issues/4086)).
- **A timer is named by the form it starts.** Starting a timer replaces the thing's pending timer for the same form
  (Engine v2 T6 rule 15: the engine clears it, a clear being "fired or cancelled"; T5: it is due at a world time in
  microseconds). A crank lamp put out early and lit again goes dark at its new time, not by the earlier timer. The
  timer's form still checks its own needs when it fires.
- **effects**, each a generic change plus a named event (contract T6): `set`, `reparent` (the actor, this thing or a
  `thing` argument, into a slot, the actor's hand or `here`, loose in the actor's place: holding is a change of
  parent), `link`, `unlink` (`from`: `actor`, or `all`, every end of the link on this thing: anyone takes down an
  out-of-date poster; it writes only this thing's own links, Engine v2 T6's rule that an entry writes its own node),
  `create` (a kind, `here`, in a slot or in the hand; `set`, a list of `{field, to}`, gives the made thing fields chosen at
  the bench, each a value or a value argument: a candle's shape and colour; T6's create carries its fields, and the check
  gate checks them against the made kind), `remove` (the actor, this thing or a `thing` argument), `timer`, `transfer`,
  `draw`. The body's `pick_up` and `push` reparent a thing argument into a free hand (a push holds the thing while it
  moves), and its `put` sets a held one down `here` by a placement word and an anchor described by a selector; another
  body has no `motion`, so it is never picked up or pushed. `packages/form-rules/README.md` ("What a form does")
  defines what each does. A `set` on a timed value gives its new `rate` (a whole number, in the field's unit per second)
  and, if it gives no `to`, its value is settled at the act's time; a `to` (a whole number) is the value from the act's
  time on (SA-V4b: watering soaks the planter's soil full). The kettle's switch gives its heat a rate and a timer for the
  boil; the timer's form needs the heat at the boil, so it reads boiled at that microsecond and not before. A `set` on
  an `int` field may give `by` (signed, never 0) instead of `to`: it adds to the value, within the field's bounds, for a
  count or an amount used up that nothing balances. A cup's `sip` lowers its `water` by 50 and raises its `sips` by 1.
- **transfer** (SA-F2b, [#2844](https://github.com/soulsimulation/souls/issues/2844)): `{"change": "transfer", "field",
  "from", "into", "amount", "event"}`. `field` is an `int` field of this kind, and of the same name and unit at the other
  end; `from` and `into` are each `"this"` or a `thing` argument; `amount` is a whole number above zero, a `count`
  argument, or `"room"` (fill to the target's `max`, so a field filled to the brim here has a `max`). It moves the least of
  what it asks and what the source has above its `min`: two `set`s whose amounts sum to zero. Between **two fields of
  one thing**, `from` and `into` are both `"this"` and `into_field` names the `int` field it lands in, of the same unit:
  `{"change": "transfer", "field": "green", "from": "this", "into": "this", "into_field": "well_green", "amount":
  {"arg": "green"}}`. It is two `set`s on the one thing that still sum to zero; to move a field's whole value, ask for
  its `max` (it moves what is there).
- **draw** (SA-F13, [#2852](https://github.com/soulsimulation/souls/issues/2852)): an outcome nobody chose.
  `{"change": "draw", "outcomes": [{"name", "weight", "event", "set": [{"field", "to"}]}]}`. Each `weight` is a whole
  number from 0 or `{"field": <an int field of this kind>}` (a practice count); names differ. The world draws a whole
  number below the total and passes it in as data; with no draw the answer is unknown and lists the whole table. A
  draw carries its events on its rows, not on itself.

A form owned by a body's family or a kind of ground is written the same way (`owner: "family"` or `"place"`).

## An activity (`roles`)

`roles` is a supported section of an ordinary entry, validated by
[`format.mjs`](../../tools/entry/format.mjs). At world startup,
[`activity_kinds`](../../v2/crates/worldd/src/serve.rs) compiles entries with at least two roles into joint activity
kinds. Examples include the [hall lecture](../../content/kinds/hall/lecture.json),
[handshake](../../content/kinds/together/handshake.json) and
[shared-beat dance](../../content/kinds/together/dance_together.json). Souls join through the existing activity
offer/accept flow and leave through its activity commands; declaring roles does not create another group mechanism.
A role can name a `move`, `on_beat: true` or `follows: true`; these are accepted by the validator and read by the
runtime. A move still needs its compiled engine definition and a page drawing path; a role declaration alone does
not prove visible contact.

```json
"roles": {
  "speaker": { "need": "required", "places": { "in": "this", "slots": ["lectern"] } },
  "listener": { "need": "optional", "places": { "in": "here", "posture": "sit", "within_mm": 12000 } }
}
```

- A **role** is one of the kind's link types; membership is that link to the body, and the link's `most` is how many
  the role takes. `need` is `required` (the activity cannot start without it), `replaceable` (required, and another
  may take it while it runs) or `optional`. Starting is Engine v2 B5's; leaving and ending are below.
- **places** say where a member of the role may be, in a fixed order. `in: "this"`: the activity's own `slots`, in
  the order listed, so a body becomes the activity's child. `in: "here"`: the slots of things in the same place as
  the activity whose origin is within `within_mm` of the activity's, nearest first, then by node id, then in the
  thing's slot order. Only a slot that admits a body counts, and, if `posture` is given, only one with that posture.
  The first slot with room is the place. If no slot has room, the answer is `no_free_place`, naming the role.
- An entry's **forms** can link a role to the actor and reparent it into a slot. The form's `who`, needs and steps
  govern that operation. Joint activities also use the runtime's offer, accept, use and leave commands; their
  declared places supply the members' approach stands. Do not substitute a link-only form for consent.
- Each Soul's approach and seating follow authoritative engine movement. A form's effects link and set the parent;
  they do not let the page move the body. Anything needing another Soul's yes uses an offer with an expiry
  (Engine v2 E8, [#2779](https://github.com/soulsimulation/souls/issues/2779)).
- **Leaving is a form** too: the one that unlinks one role from the actor, and moves the actor out of its place by
  its own `reparent` (SA-G1b, [#2873](https://github.com/soulsimulation/souls/issues/2873)). The role's `need` is its
  rule for leaving. A `required` role leaving ends the activity. A `replaceable` one re-opens its place: its link
  and its slot are free for the next Soul. An `optional` one changes nothing. A one-off activity also ends when its
  last member leaves.
- **Ending** releases every member: each is unlinked from its role. A body seated in another thing's slot stays
  seated. A body still in the activity's own slots is moved out to the place the activity is in, so removing the
  activity removes no body. Then the activity is removed. The rules name the two events `released` and `ended`.
  Nothing removes a member for being quiet.
- **The "now" line** (`roles.now`: a member of the activity's own section, 17, so no role is named `now`) names the parts of the activity's state that say what is happening
  now. Souls read it as a fact and schedule themselves by it; the engine never waits on their behalf.

  ```json
  "roles": { ..., "now": { "floor": "speaker", "stage": "phase", "ends": "left_us" } }
  ```

  `floor` is the link type whose ends have the floor. `stage` is an enum field. `ends` is a timed field (SA-F5a)
  counting down in microseconds; the activity ends at the first microsecond it reaches 0. A part the asker may not
  see is left out and named as unseen. The check gate takes a role for `floor`, an enum field for `stage` and a
  timed field for `ends`.
- **Unattended**, an activity is removed at that time by its own world form (`who: "world"`, `starts: "timer"`; the
  check gate counts the crossing as what arms it),
  whose needs are the time (`ends` at most 0) and that no role is linked. The engine's timer runs it then. While
  anyone is in it, the form is refused and nothing changes.
  The examples are `packages/form-rules/cases/kinds/test/talk.json` and the lecture, `content/kinds/hall/lecture.json`.

### Unsupported top-level activity sections

`standing` and `pair` are not entry sections: the validator's closed `SECTIONS` table rejects them. Earlier
proposals and test-rule examples using those keys are not authoring templates for a current entry. Persistent
membership can be expressed with ordinary state, links and forms where their existing rules support it; it does
not imply an automatic course or job lifecycle. Two-person actions use `roles` and the existing activity offer and
accept mechanism, as the handshake entry does. Do not add a `pair.contact` table or assume it supplies hand targets
on the page.

## A move

A form's `move` step names a move and a point; moves are their own data in `content/moves/<name>.json`
(SA-D4, [#2856](https://github.com/soulsimulation/souls/issues/2856); feeds Engine v2 B2, [#2681](https://github.com/soulsimulation/souls/issues/2681),
and T9, [#2663](https://github.com/soulsimulation/souls/issues/2663)). `souls-move/1`: `claims` and `blocks` (resource
classes `locomotion`, `manipulator`, `gaze`, `voice`, never anatomy), `cancels_on` (`claim_taken`, `out_of_reach`),
`effector` (`hand`, `held_point` or `aim`), `reach_mm` (whole millimetres: at most 700 for contact, or 20000
for `aim`) and `phases` in whole microseconds:
`start_up_us`, `recovery_us` and for a slide `slide_us`. `seated: true` (#4143) marks a move made from a seat (a
stretch, a slump): a body a seat, a bed or a standing slot holds makes it with its legs left to the slot, which its
`locomotion` claim and block then skip; any other move that claims the legs is refused there `resource-held`. Contact is the one instant at the end of start-up; a phase
includes its start and excludes its end. A key or unit in ticks is refused. `press` goes to a point; `slide` goes to a
point and then to a second one. Five more hand moves share that shape (SA-D4b, [#2857](https://github.com/soulsimulation/souls/issues/2857)):
`swing` (a hinged leaf pushed through its arc), `stroke` (a hand drawn along a line), `tug` (a handle drawn down) and
`knock` and `lock` (one contact, like `press`, with their own timing). The middle phase of the first three is named
`slide_us` and is the same straight path; an arc or a rotation is the viewer's to draw. `turn` grips a thing and
holds there while it turns over in place (a sand timer): its middle phase keeps the hand on the grip (the record's
second point is the grip). A rope pull is a `tug`. `pour` (SA-D5a, [#2858](https://github.com/soulsimulation/souls/issues/2858)) has the effector
`held_point`: a named point of the thing in the hand (a spout), so the reach is measured from it. Its `pour_us` is a
contact window after start-up (a move slides or pours, not both); the record adds `effector_mm`, the point's offset from
the hand, and the hand is placed so the point stays on `contact_mm` (the target's rim) for the window. `effectorAt` gives that point. `consume` (SA-D5c, [#2860](https://github.com/soulsimulation/souls/issues/2860)) is a sip or a bite: the same effector, a window `consume_us` per `count` in the record at the body's mouth point (`contact_mm`), claiming the hand and the mouth (`voice`) and leaving the gaze free. `strike` and `pump` (SA-D5b, [#2859](https://github.com/soulsimulation/souls/issues/2859)) are the same shape with the effector at the tool's head (a hammer's face, a pump's nozzle): a window `strike_us` per blow or `pump_us` per stroke, `count` of them in the record, claiming the hand only. `craft` is hand work at a point in front
of the body (carving, weaving, sewing, drilling, honing): slide-shaped, its `slide_us` is the working spell across a
small span from `contact_mm` to `to_mm`, claiming the hands by class (`manipulator`). Each hand has its own record; the
small repeated strokes inside the span are the viewer's to draw, and a longer spell is the step repeated.

```sh
node tools/entry/move.mjs content/moves    # validate every move; prints each one's provisional reference
node --test tools/entry/move.test.mjs      # acceptance, with cases in tools/entry/cases/moves.json
```

`tools/entry/pose.mjs` gives the hand's position in whole millimetres at any time from a move, a record
(`start_us`, `from_mm`, `contact_mm`, and `to_mm` for a slide) and a time. It has no imports and uses whole-number
arithmetic only (easing in permille; a position is rounded to the nearest millimetre, halves away from zero, Engine v2's
rule for positions, T4 [#2971](https://github.com/soulsimulation/souls/issues/2971); progress, a count, rounds down), so Node and a browser build give the same position. It does not check reach or
move the thing's frame into the world's: the caller passes world positions. This is the authoring diagnostic's
pose helper, not the page's rig. The native move loader accepts `hand` and `held_point` as its held-resource effector,
and `aim` as a non-contact target ([Move::from_entry](../../v2/crates/replica/src/moves.rs)). That declaration and a
sheet do not supply the page with actual hand targets: generic press/touch and take/put contact, including crew
hand feeds, still need their stream-to-page integration and final-draw validation.

## The looks table

`looks.table` is a list of rows that say how a thing looks in each state, with no code: a state `field`, a `part` of
the model and what to do to it (`do`): `rotate` (millidegrees, about an `axis`), `slide` (millimetres along an `axis`),
`scale` (permille, one axis or all), `show` (1 or 0), `glow` (permille), `tint` (a colour) or `pick` (no part: which
of several parts a choice shows). Three more kinds draw a thing's own moving picture from a field (SA-D2): `steam` (permille
of a plume leaving the part, so a kettle steams only above the level its range states), `flame` (permille of a flame
burning on the part, 0 is out), `grow` (a plant's stage in permille of a stage, 0 seed to 4000 fruiting; a value with no
amount draws no plants) and `wilt` (permille of how far those plants hang, 0 fresh to 1000 wilted; the planter's falls as its
water runs out, `content/kinds/garden/planter.json`). The part
is a role of the model (the closed list of roles of the shape language, the one the look gate draws with), not the
thing's name. A plant draws on plant roles (`stem`, `leaf`, `bloom`, `fruit`, `root`, and `shoot.1` to `shoot.6`
for shoots that go one by one), raked sand or soil on `furrow.1` to `furrow.4`; never on a creature's limbs (`arm`,
`wing`, `ear`, `leg`), which creature gaits move. The amount comes from `at` (field value to amount, for a bool or enum) or from
`range` and `to` (a whole-number field, linear between its ends, clamped; a fractional field is carried in permille).
`over_us` makes a part take that long to get there. Part names and look ids use letters, digits and `_ - . : / @`
only, so Engine v2's encoding accepts them. `looks(input)` in `packages/form-rules/src/looks.ts` is the one plain
function that turns a table, a state and the time since it changed into each part's placement, in whole numbers; its
cases are `packages/form-rules/cases/looks/`. Collision shapes never follow looks.

A `sound` row says what is heard (SA-D7). `sound` is one of the page's own synthesised set (`sound-plan.ts`: water, bell, hum,
chime, kettle and the rest) or `tune`; there are no audio files. `mode` is `loop` (default) or `once`. `reach_mm`, how far it
carries, is required on every sound row. It is driven by a `field` (`at` or `range` + `to` give the loudness in permille, 0 is
silent, so the sound stops when the field says so) or by a named `event` (with `level`, permille; played once from the record).
A `tune` row names a tune by id (`tune`) or a mood tag (`mood`, which picks one from `content/tunes/tunes.json` by hashing the
thing's id). A thing that carries sound to another place names the `link`. The function answers with what is heard
(`sounds` on the part, or on `@self` when the row has no part): which sound, loud how, reaching how far, and the microseconds
since the state began. A tune is notes, `[midi, start step, steps long]` over steps of `step_us`, repeating; which notes sound in
a window of world time is `tuneNotes`, a pure function of time, so every viewer, live or in replay, is at the same point of it.

```json
"table": [
  { "part": "fill", "field": "fullness", "do": "scale", "axis": "y", "range": [0, 1000], "to": [1, 1000] },
  { "part": "drawer", "field": "open", "do": "slide", "axis": "z", "at": { "true": 280, "false": 0 } }
]
```

## The hash, provisional

A kind's reference is `namespace:name@hash`. Until Engine v2's encoding (T0) exists, the hash is SHA-256 over a
canonical JSON form of the meaning sections (keys sorted, sections by number, no spacing) behind the purpose label
`souls/kind/provisional/1`, written `prov-1220<digest>` (multihash code and length, then the digest). A kind it
refers to (one it creates, or a selector's `kind`) is covered by that kind's own hash; kinds that refer to each
other in a circle are refused by name. Looks, words, card and how-tos have their own beside hash, so a better
picture or a fixed typo never renames a placed thing. Reordering keys changes neither hash.

**The provisional hash will change once**, when the real encoding lands. Nothing may store it as permanent, which
is why entries name each other by `namespace:name` and the tool resolves the hash.

## The check gate

```sh
node tools/entry/check.mjs kitchen        # one family (a folder of content/kinds); no argument checks them all
pnpm entry check kitchen                  # the same
node --test tools/entry/check.test.mjs    # one fixture per rule
```

One JSON line per file, then a summary; exit 1 if any entry has a finding. A finding is `{rule, form, field, path,
reason, fix}`: the rule broken, where, and the smallest change that passes. The format's own refusals are reported
under the rule they break; the rest are checked on top (`tools/entry/check.mjs`, `RULES`).

| Rule | Broken by | Format already refuses |
|---|---|---|
| `exact` | a float or a count in ticks | yes |
| `targets` | an argument whose selector picks the wrong list, or that nothing uses | partly (closed selector lists) |
| `makes` | a `create` that pays for nothing in its own form (a stock's take is paid by its count, lowered by the engine) | where it appears (`into`) |
| `engine-names` | a name using a word of today's engine | closed lists of steps, needs, changes |
| `no-waiting` | a timer form that arms itself, a time of day in a name | `wait` is stated microseconds |
| `bounded` | a link without `most`; state, links, forms or parts over the budget (`BUDGET`: 32 forms, 48 for a body's family, which cannot be split) | slots and lists carry `most` |
| `way-out` | a form no sequence of forms can reach (a chain of needs with no start) | no |
| `moves` | a thing says neither how it moves nor how long it lasts loose | no |
| `card` | no card, or a card whose purpose text is over 80 characters | no (a card that is given must name a text entry) |
| `no-labels` | a mood word in the card | no |
| `refs` | a kind that is not loaded, or kinds in a circle | no |

A state field that no form of the kind sets to some declared value is taken as set from outside, so a need on it is not
a dead end (the kettle's water is filled by something else). A field or value argument stands for each of its choices,
so a `set` through one reaches each field it lists, with each value it lists.
