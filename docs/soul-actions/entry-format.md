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
| 3 | `state` | Fields: `n` (a stable number), `type` (`bool`, `enum` with `values`, `int` with `unit`, `duration` in µs, `text` by reference, `list`), `default`, `audience` (a rule) |
| 4 | `links` | Link types this kind takes part in: `n`, `from` (`soul`, `body`, `thing` or a kind), `most`, `most_per`, `audience` (below) |
| 5 | `points` | Named places in the thing's own frame: `role` (`stand`, `grip`, `contact`, `outlet`), `at_mm`, `yaw_mdeg` |
| 6 | `slots` | The children it admits: `admits` (`body`, `thing`), `kinds` (the kinds a thing slot takes; none listed takes any), `posture` (`sit`, `lie`), `most`, `at_mm`, `stand` (a stand point), `fits_mm`, and for a row of places `row`, `place`, `end` (below) |
| 7 | `geometry` | `bounds_mm`: [width, height, depth], the box every point and slot lies in (below) |
| 8 | `forms` | What can be done with it (below) |
| 10 | `children` | Kinds it holds as child nodes, `{kind, most}`: a sign-up sheet's slots, a board's squares (below) |
| 20 | `looks` | How it looks; its table is SA-D1a's. `shape`: the parts of the thing, whole millimetres and millidegrees (below) |
| 21 | `text` | The words, by key |
| 22 | `card` | `text` (one line of purpose, at most 80 characters), optional `category` (one word) and `synonyms` (a list of words), each a key of the text table, never the words |
| 23 | `howtos` | A short chain of this kind's forms, with its words by key |

Not defined yet, and refused with the name of the task that adds each: `reactions` (SA-F15), `motion` and `loose`
(SA-F10), `stock` (SA-F12), `areas` (SA-D6), `hatch` (SA-F9).

**Links, children and lists.** Who belongs, who owns and whose turn it is are links (contract T2,
[#2641](https://github.com/soulsimulation/souls/issues/2641)), each found from either end. A link type is declared on
the kind at one end: `from` says what may be at the other end (`soul`, `body`, `thing` or a kind), `most` how many
`from` ends one of these takes (a slot has one signer; a lecture one speaker), `most_per` how many of these one `from`
end may be linked to (a Soul signs up to three slots). A record that points at a Soul or a thing is never a list item:
it is a child node, declared in `children` with a bound, and the Soul is a link on it. A sign-up sheet has up to 20
`eden:signup_slot` children; who signed a slot is its `signed` link, found from the Soul and, through its children, from
the sheet (`content/kinds/signup/`). Holding is a change of parent, not a link.

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
`tags`, in whole millimetres, with an angle in whole millidegrees. The format has no floating-point number and
`look.mjs` converts to metres only when it draws.

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
- **takes**: named arguments, typed `slot`, `part`, `thing`, `text`, `duration` or `count`. A `slot` or `thing` may
  be described with `select`: a candidate set (`of`: `things` or `free_slots`, optional `kind`, `in`: `this`,
  `here` or `parent`), an `anchor` (`me`, `this`), an `order` (`nearest`, `furthest`) and a `rank` (1, 2, ... or
  `last`), the same closed list as Engine v2 E2 ([#2709](https://github.com/soulsimulation/souls/issues/2709)).
  Anywhere a point, slot or value is expected, `{"arg": <name>}` uses an argument.
- **needs**: `state` (a field `is` or is `not` a value, or an `int` or `duration` field `at_least` and/or `at_most`
  a whole number), `slot_free`, `within_reach` (of a point, or of a `thing` argument), `held_by_actor`, `hand`
  (`{"free": true}`, or `{"holds": "<namespace:name>"}`, a kind the hash follows), `linked`, `unlinked`.
  SA-F2 evaluates them. A kettle's `fill` takes the nearest `eden:tap` and needs it within reach: the water comes from
  a thing in the world, never from a refill the kettle does by itself.
- **steps**, each a move or the walk: `walk_to` (a point, or a slot's stand point), `sit`, `rise`, `move` (a move
  by name, `at` a point, `toward` an argument; moves are their own data, SA-D4), `take`, `put`, `use_held`,
  `wait` (`us`).
- **effects**, each a generic change plus a named event (contract T6): `set`, `reparent` (the actor or this thing
  into a slot or the actor's hand: holding is a change of parent), `link`, `unlink`, `create` (a kind, `here`, in a
  slot or in the hand), `remove`, `timer`. SA-F2b defines what each does.

A form owned by a body's family or a kind of ground is written the same way (`owner: "family"` or `"place"`).

## The hash, provisional

A kind's reference is `namespace:name@hash`. Until Engine v2's encoding (T0) exists, the hash is SHA-256 over a
canonical JSON form of the meaning sections (keys sorted, sections by number, no spacing) behind the purpose label
`souls/kind/provisional/1`, written `prov-1220<digest>` (multihash code and length, then the digest). A kind it
refers to (one it creates, or a selector's `kind`) is covered by that kind's own hash; kinds that refer to each
other in a circle are refused by name. Looks, words, card and how-tos have their own beside hash, so a better
picture or a fixed typo never renames a placed thing. Reordering keys changes neither hash.

**The provisional hash will change once**, when the real encoding lands. Nothing may store it as permanent, which
is why entries name each other by `namespace:name` and the tool resolves the hash.
