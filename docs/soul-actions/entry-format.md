# The entry format: a kind as data

An **entry** is one kind written as data for Engine v2 (spec [#2635](https://github.com/soulsimulation/souls/issues/2635)):
what a thing, a body's family or a kind of ground is, which state it keeps, where it can be held, stood at or sat in,
and what can be done with it. Entries live in `content/kinds/<family>/<name>.json`, where the folder only groups
them for people. Nothing in today's server reads them; the tools of the Soul Actions tranche
([#2841](https://github.com/soulsimulation/souls/issues/2841)) do, and Engine v2's kinds loader (K3,
[#2667](https://github.com/soulsimulation/souls/issues/2667)), shared rules (R2,
[#2685](https://github.com/soulsimulation/souls/issues/2685)) and runner (F1,
[#2766](https://github.com/soulsimulation/souls/issues/2766)) read this format as merged on main.

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
| 4 | `links` | Link types this kind takes part in: `n`, `from` (`soul`, `body`, `thing` or a kind), `most`, `most_per`, `audience` (below). A body's family declares `soul`, its link to its Soul |
| 5 | `points` | Named places in the thing's own frame: `role` (`stand`, `grip`, `contact`, `outlet`), `at_mm`, `yaw_mdeg` |
| 6 | `slots` | The children it admits: `admits` (`body`, `thing`), `kinds` (the kinds a thing slot takes; none listed takes any), `posture` (`sit`, `lie`), `most`, `at_mm`, `stand` (a stand point), `fits_mm`, and for a row of places `row`, `place`, `end` (below) |
| 7 | `geometry` | `bounds_mm`: [width, height, depth], the box every point and slot lies in (below) |
| 8 | `forms` | What can be done with it (below) |
| 9 | `closed` | The fields and children that take the container's audience until it is opened (SA-F8, [#2849](https://github.com/soulsimulation/souls/issues/2849)) |
| 10 | (referenced kinds) | Engine v2 T3's table of the kinds this one names, written by the encoder, never in the file |
| 11 | `children` | Kinds it holds as child nodes, `{kind, most}`: a sign-up sheet's slots, a board's squares (below) |
| 13 | `vehicle` | A thing a Soul sits in or on and steers (below) |
| 14 | `ride` | A set trip between stops that nobody steers (below) |
| 15 | `stock` | The things a container is known to hold, yielded when taken (below) |
| 16 | `areas` | What a kind says about resting on it, or about a named part of its surroundings, where its shape cannot (below) |
| 17 | `roles` | An activity's roles: how much each is needed and where its members may be (below) |
| 18 | `motion` | How a thing moves: `{"how"}`, one of `one_hand`, `two_hands`, `pushed_by_one`, `two_souls`, `wheeled`, `fixed` (below) |
| 19 | `loose` | How long it lasts once nobody holds or owns it: `{"ever": true}` or `{"us": <microseconds>}` (below) |
| 20 | `looks` | How it looks: `model` (a look id), `table`, the looks table, and `shape`: the parts of the thing, whole millimetres and millidegrees (below) |
| 21 | `text` | The words, by key |
| 22 | `card` | `text` (one line of purpose; `check` refuses one over 80 characters), optional `category` (one word) and `synonyms` (a list of words), each a key of the text table, never the words |
| 23 | `howtos` | A short chain of this kind's forms, with its words by key |

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
lying on it and sitting on its edge; a piano forbids sitting and lying; a tree declares its shade. A rug or a lawn needs
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
`ride` is for a boat that is not rowed, a sail: `seats` (body slots), `stops` (two or more `stand` points in the order
of the trip), `returns` (across and back, or ending at the last stop), `start` (the form an actor starts the trip with),
`speed_mm_s` and `ground`. A kind is a vehicle or a ride, not both. Sections 13 and 14 are meaning, so covered by the hash.

**Stock** (section 15, SA-F12, [#2851](https://github.com/soulsimulation/souls/issues/2851)). What a bookshelf, a
wardrobe, a fridge or a stall is known to hold, made real when someone reaches for it. A stock is
`{kind, count, take, carries, refill}`: the kind it yields; `count`, an `int` state field in unit `count` with `min` 0
and a `max` (so it runs out; its default is how many a copy starts with); `take`, the form that takes one; optional
`carries`, one to four text fields of the yielded kind that come by reference from a library the world's creator
supplies (a book's title and first page); optional `refill`, `{every_us}`, one more every so long up to the `max`
(a timed value, SA-F5a). The take form is checked: it is a Soul's act that needs the count `at_least` 1 (an empty
stock refuses) and a free hand, and its one `create` makes the kind into `actor_hand`; it never sets the count. The engine
lowers the count by one in the same batch as the make (`takeStock` shows the batch: a `create` and a `set` with `by` -1), so
nothing is made from nothing. Stock is free to take; buying, lending and debts are not here. A kind whose contents are
closed lists `count` in `closed.fields` and shows its stock only once opened (`stockOf` answers `null` until then; a shelf
or a stall is always open). The cases are `packages/form-rules/cases/stock/stock.json`. Section 15 is meaning, so covered by the hash.

**Links, children and lists.** Who belongs, who owns and whose turn it is are links (contract T2,
[#2641](https://github.com/soulsimulation/souls/issues/2641)), each found from either end. A link type is declared on
the kind at one end: `from` says what may be at the other end (`soul`, `body`, `thing` or a kind), `most` how many
`from` ends one of these takes (a slot has one signer; a lecture one speaker), `most_per` how many of these one `from`
end may be linked to (a Soul signs up to three slots). A record that points at a Soul or a thing is never a list item:
it is a child node, declared in `children` (section 11) with a bound, and the Soul is a link on it. A sign-up sheet has up to 20
`eden:signup_slot` children; who signed a slot is its `signed` link, found from the Soul and, through its children, from
the sheet (`content/kinds/signup/`). What a thing admits is a check at commit by plain kind name (or category), never a hashed reference: the parent's hash covers its own `children` list but does not follow into the child kind. Holding is a change of parent, not a link.

A body's family declares the link type `soul` (`from: "soul"`, `most` 1): a body's link to its Soul (contract T2). A
link declared `from: "soul"` on a thing (an owner, a speaker) has a Soul at its end while the actor is a body, so who-may
follows the acting body's `soul` link (SA-F7a, [#2848](https://github.com/soulsimulation/souls/issues/2848)). Only a
body's family declares it.

**Bounds and timed values.** `min` / `max`: whole bounds of an `int` field (or a timed value); an amount moved never
takes it past them. A `transfer` fills to `max` and draws down to `min`. A `timed` field is a value that changes with
time (SA-F5a, [#2845](https://github.com/soulsimulation/souls/issues/2845)): `unit` (a whole-number unit), and a default
of three whole numbers, `{"value", "per_s", "set_us"}`: the value in that unit, its rate in that unit per second, and the
world time it was set, in microseconds. A range need reads it at the state's time; the arithmetic is
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
[#2792](https://github.com/soulsimulation/souls/issues/2792)); those fields declare no audience of their own.
Delivering to viewers is the new engine's view tier. Point and slot names share one namespace, so a form's argument of type
`part` or `slot` can name "the top drawer" or "the left seat" and one form serves every part.

**Points, slots and the thing's own frame** (SA-D3, [#2855](https://github.com/soulsimulation/souls/issues/2855);
feeds Engine v2 K3, E2, E3 and B3). Every place is whole millimetres in the thing's own frame: the origin at the centre
of its footprint on the ground, x to its right, y up, z to its front. `bounds_mm` is [width, height, depth], so x runs
from -width/2 to width/2, y from 0 to height, z from -depth/2 to depth/2. A point is a name, a `role` (`grip`, `contact`
for a button or switch, `outlet` for a spout, `stand` for where a body stands), a position and an optional `yaw_mdeg`.
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
  Anywhere a point, slot or value is expected, `{"arg": <name>}` uses an argument.
- **needs**: `state` (a field `is` or is `not` a value, or an `int` or `duration` field `at_least` and/or `at_most`
  a whole number), `slot_free`, `within_reach` (of a point, or of a `thing` argument), `held_by_actor` (this thing,
  or `{"thing": {"arg": ...}}`), `moves` (`{"thing": {"arg": ...}, "by": "carry" | "push"}`: the thing's kind moves
  that way by its section 18 `motion.how`; carrying takes as many free hands as it says, a push by one body is refused
  for `two_souls`; refused as `moves_by`, `motion_unsaid`, `needs_souls` or `no_free_hand`), `hand`
  (`{"free": true}`, or `{"holds": "<namespace:name>"}`, a kind the hash follows), `linked`, `unlinked`, `room`
  (no parameters: every amount the form's transfers move has room where it lands, else `no_room`; only on a form with a
  `transfer`), `enough` (no parameters: every amount the form's transfers ask is there to give at the source, else
  `not_enough`, so a pitcher asked for more than it holds refuses rather than pouring less). A range need also takes a
  `timed` field.
  SA-F2 evaluates them. **Reach to another thing** is read in this order: (1) the walk, taken as done: entries store
  no position for a loose thing (Engine v2 holds poses, and today's adapter walks first), so `within_reach` of a
  `thing` argument that the form `walk_to`s is met when the thing is in the actor's place, and refused `out_of_reach`
  when it is elsewhere; (2) else the measured pose: `"of": {"arg": ...}` names the thing whose point it is, placed by
  that node's `at_mm` in the input; (3) else `unknown`. A kettle's `fill` takes the nearest `eden:tap` (a selector on a
  kind) and moves toward it: the water comes from a thing in the world, never from a refill the kettle does by itself.
  Its effect is a `transfer` of `water` (grams) out of the tap and into the kettle until it is full, so a need for water
  on the switch names `fill` as its fix.
- **steps**, each a move or the walk: `walk_to` (a point, or a slot's stand point), `sit`, `rise`, `move` (a move
  by name, `at` a point, `toward` an argument; moves are their own data, SA-D4), `take`, `put`, `use_held`,
  `wait` (`us`), `settle` (`posture`, `sit` or `lie`: a ground posture taken where the body stands, with no slot;
  SA-G3, [#2875](https://github.com/soulsimulation/souls/issues/2875)).
- **effects**, each a generic change plus a named event (contract T6): `set`, `reparent` (the actor, this thing or a
  `thing` argument, into a slot, the actor's hand or `here`, loose in the actor's place: holding is a change of
  parent), `link`, `unlink`, `create` (a kind, `here`, in a slot or in the hand), `remove` (the actor, this thing or a
  `thing` argument), `timer`, `transfer`, `draw`. The body's `pick_up` and `push` reparent a thing argument into a free
  hand (a push holds the thing while it moves), and its `put` sets a held one down `here` by a placement word and an
  anchor described by a selector; another body has no `motion`, so it is never picked up or pushed. `packages/form-rules/README.md` ("What a form does")
  defines what each does. A `set` on a timed value gives no `to` but its new `rate` (a whole number, in the field's unit
  per second): its value is settled at the act's time. The kettle's switch gives its heat a rate and a timer for the
  boil; the timer's form needs the heat at the boil, so it reads boiled at that microsecond and not before. A `set` on
  an `int` field may give `by` (signed, never 0) instead of `to`: it adds to the value, within the field's bounds, for a
  count or an amount used up that nothing balances. A cup's `sip` lowers its `water` by 50 and raises its `sips` by 1.
- **transfer** (SA-F2b, [#2844](https://github.com/soulsimulation/souls/issues/2844)): `{"change": "transfer", "field",
  "from", "into", "amount", "event"}`. `field` is an `int` field of this kind, and of the same name and unit at the other
  end; `from` and `into` are each `"this"` or a `thing` argument; `amount` is a whole number above zero, a `count`
  argument, or `"room"` (fill to the target's `max`, so a field filled to the brim here has a `max`). It moves the least of
  what it asks and what the source has above its `min`: two `set`s whose amounts sum to zero.
- **draw** (SA-F13, [#2852](https://github.com/soulsimulation/souls/issues/2852)): an outcome nobody chose.
  `{"change": "draw", "outcomes": [{"name", "weight", "event", "set": [{"field", "to"}]}]}`. Each `weight` is a whole
  number from 0 or `{"field": <an int field of this kind>}` (a practice count); names differ. The world draws a whole
  number below the total and passes it in as data; with no draw the answer is unknown and lists the whole table. A
  draw carries its events on its rows, not on itself.

A form owned by a body's family or a kind of ground is written the same way (`owner: "family"` or `"place"`).

## An activity (proposed: `roles`)

A group activity (a lecture, a supper, later a handshake, a dance or a bout) is a node Souls enter (SA-G1a,
[#2872](https://github.com/soulsimulation/souls/issues/2872); Engine v2 B5, [#2724](https://github.com/soulsimulation/souls/issues/2724)).
Its kind is an ordinary entry plus a `roles` section, which the validator does not take yet: it is proposed on
[#2842](https://github.com/soulsimulation/souls/issues/2842), and until then the examples are test kinds
(`packages/form-rules/cases/kinds/test/lecture_activity.json`, `supper.json`).

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
- **Entering is a form** of the kind. It links the role to the actor and moves the actor into a slot argument
  (`reparent`), and the role's places fill that argument. Who may enter a role is that form's `who`.
- The world moves no body. Each Soul walks and sits by its own steps; the form's effects only link and set the parent.
  Anything that needs another Soul's yes is an offer with an expiry (Engine v2 E8, [#2779](https://github.com/soulsimulation/souls/issues/2779)).
- **Leaving is a form** too: the one that unlinks one role from the actor, and moves the actor out of its place by
  its own `reparent` (SA-G1b, [#2873](https://github.com/soulsimulation/souls/issues/2873)). The role's `need` is its
  rule for leaving. A `required` role leaving ends the activity. A `replaceable` one re-opens its place: its link
  and its slot are free for the next Soul. An `optional` one changes nothing. A one-off activity also ends when its
  last member leaves.
- **Ending** releases every member: each is unlinked from its role. A body seated in another thing's slot stays
  seated. A body still in the activity's own slots is moved out to the place the activity is in, so removing the
  activity removes no body. Then the activity is removed. The rules name the two events `released` and `ended`.
  Nothing removes a member for being quiet.
- **The "now" line** (proposed: a `now` section) names the parts of the activity's state that say what is happening
  now. Souls read it as a fact and schedule themselves by it; the engine never waits on their behalf.

  ```json
  "now": { "floor": "speaker", "stage": "phase", "ends": "left_us" }
  ```

  `floor` is the link type whose ends have the floor. `stage` is an enum field. `ends` is a timed field (SA-F5a)
  counting down in microseconds; the activity ends at the first microsecond it reaches 0. A part the asker may not
  see is left out and named as unseen.
- **Unattended**, an activity is removed at that time by its own world form (`who: "world"`, `starts: "timer"`),
  whose needs are the time (`ends` at most 0) and that no role is linked. The engine's timer runs it then. While
  anyone is in it, the form is refused and nothing changes.
  The example is `packages/form-rules/cases/kinds/test/talk.json`.

- **A standing activity** (proposed: a `standing` section; SA-G2, [#2874](https://github.com/soulsimulation/souls/issues/2874))
  outlasts a sitting: a course or a job. It names `members`, a link type for those who belong across days; `present`,
  a link type (a role with places) for those at the sitting now; `enough`, how many present start a sitting; and
  `stage`, an enum field with the values `sitting` and `idle`. The list is closed: `members`, `present`, `enough`,
  `stage`, `sitting`, `idle`.

  ```json
  "standing": { "members": "member", "present": "present", "enough": 3, "stage": "phase", "sitting": "sitting", "idle": "idle" }
  ```

  Joining and parting are forms that link and unlink `members`, with no place. A standing activity does not end when
  its last member parts, or when no one is present; it keeps its members, state and end date while empty. Whether a
  sitting starts is checked when a member arrives (a role entered as above): once `enough` are present the rules set
  the stage to `sitting` (event `sitting_began`), once. When the last one present rises the stage returns to `idle`
  (event `sitting_ended`). Present is a subset of members: only a member may arrive (the form's `who`), and a member
  who is present cannot part (`still_present`). At its end date (its `ends` field, as above) its world form removes it,
  members or not: each member is unlinked first (event `released`) and no body moves. Nothing waits for a time: hours
  are a schedule (SA-F16). The example is `packages/form-rules/cases/kinds/test/class.json`.

- **Between two Souls** (proposed: a `pair` section; SA-G4, [#2876](https://github.com/soulsimulation/souls/issues/2876)):
  give, hug, handshake, high five, dance, push the swing. Bodies touch only inside an activity both joined. A pair has
  two `required` roles. The offer is a proposal for one Soul (Engine v2 E8, [#2779](https://github.com/soulsimulation/souls/issues/2779)):
  its `invited` link names who may accept, a `proposer` link who may offer. The asker enters its role by its own act;
  the invited Soul accepts by entering the other, while the countdown (`now.ends`) is above 0. At 0, with nobody
  accepting, the world's timer form (`expires`) removes the offer: the asker is released (`released`) and the form's
  event names the outcome. A give names the link to its thing (`gives`): the accepting form moves it into the
  accepter's free hand in the same batch (`"what": {"link": "offered"}`), both sides or neither (E24,
  [#2793](https://github.com/soulsimulation/souls/issues/2793)). `contact` states, in the activity's own frame, each
  role's move, the point its effector touches in whole millimetres and the beat the contact lands on; a beat is
  `beat_us` whole microseconds (B8, [#2740](https://github.com/soulsimulation/souls/issues/2740)). The list is closed:
  `invited`, `accept`, `expires`, `gives`, `beat_us`, `contact`.

  ```json
  "pair": { "invited": "invited", "accept": "accept", "expires": "lapse", "beat_us": 500000,
            "contact": [{ "role": "asker", "move": "press", "contact_mm": [-10, 1000, 0], "beat": 1 },
                        { "role": "partner", "move": "press", "contact_mm": [10, 1000, 0], "beat": 1 }] }
  ```

  The examples are test kinds (`give`, `hug`, `handshake`, `high_five`, `dance`, `push_swing` in
  `packages/form-rules/cases/kinds/test/`).

## A move

A form's `move` step names a move and a point; moves are their own data in `content/moves/<name>.json`
(SA-D4, [#2856](https://github.com/soulsimulation/souls/issues/2856); feeds Engine v2 B2, [#2681](https://github.com/soulsimulation/souls/issues/2681),
and T9, [#2663](https://github.com/soulsimulation/souls/issues/2663)). `souls-move/1`: `claims` and `blocks` (resource
classes `locomotion`, `manipulator`, `gaze`, `voice`, never anatomy), `cancels_on` (`claim_taken`, `out_of_reach`),
`effector` (`hand`), `reach_mm` (whole millimetres, at most 700, under a full arm) and `phases` in whole microseconds:
`start_up_us`, `recovery_us` and for a slide `slide_us`. Contact is the one instant at the end of start-up; a phase
includes its start and excludes its end. A key or unit in ticks is refused. `press` goes to a point; `slide` goes to a
point and then to a second one. Five more hand moves share that shape (SA-D4b, [#2857](https://github.com/soulsimulation/souls/issues/2857)):
`swing` (a hinged leaf pushed through its arc), `stroke` (a hand drawn along a line), `tug` (a handle drawn down) and
`knock` and `lock` (one contact, like `press`, with their own timing). The middle phase of the first three is named
`slide_us` and is the same straight path; an arc or a rotation is the viewer's to draw. `pour` (SA-D5a, [#2858](https://github.com/soulsimulation/souls/issues/2858)) has the effector
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
move the thing's frame into the world's: the caller passes world positions.

## The looks table

`looks.table` is a list of rows that say how a thing looks in each state, with no code: a state `field`, a `part` of
the model and what to do to it (`do`): `rotate` (millidegrees, about an `axis`), `slide` (millimetres along an `axis`),
`scale` (permille, one axis or all), `show` (1 or 0), `glow` (permille), `tint` (a colour) or `pick` (no part: which
of several parts a choice shows). Three more kinds draw a thing's own moving picture from a field (SA-D2): `steam` (permille
of a plume leaving the part, so a kettle steams only above the level its range states), `flame` (permille of a flame
burning on the part, 0 is out) and `grow` (a plant's stage in permille of a stage, 0 seed to 4000 fruiting). The part
is a role of the model (the closed list of roles of the shape language), not the thing's name. The amount comes from `at` (field value to amount, for a bool or enum) or from
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
| `makes` | a `create` that pays for nothing in its own form | where it appears (`into`) |
| `engine-names` | a name using a word of today's engine | closed lists of steps, needs, changes |
| `no-waiting` | a timer form that arms itself, a time of day in a name | `wait` is stated microseconds |
| `bounded` | a link without `most`; state, links, forms or parts over the budget (`BUDGET`) | slots and lists carry `most` |
| `way-out` | a form no sequence of forms can reach (a chain of needs with no start) | no |
| `moves` | a thing says neither how it moves nor how long it lasts loose | no |
| `card` | no card, or a card whose purpose text is over 80 characters | no (a card that is given must name a text entry) |
| `no-labels` | a mood word in the card | no |
| `refs` | a kind that is not loaded, or kinds in a circle | no |

A state field that no form of the kind sets to some declared value is taken as set from outside, so a need on it is not
a dead end (the kettle's water is filled by something else).
