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
| 10 | (reserved) | Engine v2 T3's hashed table of referenced kinds ([#2640](https://github.com/soulsimulation/souls/issues/2640), rule 14); not used here |
| 11 | `children` | Kinds it admits as child nodes, `{kind, most}`: a sign-up sheet's slots, a board's squares (below) |
| 12 | (reserved) | `reactions` (SA-F15) |
| 20 | `looks` | How it looks: `model` (a look id), and `table`, the looks table (below). `shape`: the parts of the thing, whole millimetres and millidegrees (below) |
| 21 | `text` | The words, by key |
| 22 | `card` | `{"text": <key>}`: one line of purpose |
| 23 | `howtos` | A short chain of this kind's forms, with its words by key |

Not defined yet, and refused with the name of the task that adds each: `reactions` (SA-F15), `motion` and `loose`
(SA-F10), `stock` (SA-F12), `areas` (SA-D6), `schedule` (SA-F16), `hatch` (SA-F9).

**Links, children and lists.** Who belongs, who owns and whose turn it is are links (contract T2,
[#2641](https://github.com/soulsimulation/souls/issues/2641)), each found from either end. A link type is declared on
the kind at one end: `from` says what may be at the other end (`soul`, `body`, `thing` or a kind), `most` how many
`from` ends one of these takes (a slot has one signer; a lecture one speaker), `most_per` how many of these one `from`
end may be linked to (a Soul signs up to three slots). A record that points at a Soul or a thing is never a list item:
it is a child node, declared in `children` (section 11) with a bound, and the Soul is a link on it. A sign-up sheet has up to 20
`eden:signup_slot` children; who signed a slot is its `signed` link, found from the Soul and, through its children, from
the sheet (`content/kinds/signup/`). What a thing admits is a check at commit by plain kind name (or category), never a hashed reference: the parent's hash covers its own `children` list but does not follow into the child kind. Holding is a change of parent, not a link.

A `list` field holds a short bounded list of small records: `most` (required, 1 to 100, so it stays in tens: it is set
whole on every change, Engine v2 F11, [#2774](https://github.com/soulsimulation/souls/issues/2774)), `of` (one to eight
named fields, each `bool`, `enum`, `int` or `duration`; never text and never an id, so a Soul cannot be inside a
record), an optional `key` (a field of the record; the rules add, remove or set one item by it) and an empty default.
`stateAtMax(entry)` counts a kind's state with every list full and every child kind at its bound; the check gate uses
it rather than the empty default.

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
- **needs**: `state` (a field `is` or is `not` a value), `slot_free`, `within_reach` (of a point), `held_by_actor`,
  `linked`, `unlinked`. SA-F2 evaluates them.
- **steps**, each a move or the walk: `walk_to` (a point, or a slot's stand point), `sit`, `rise`, `move` (a move
  by name, `at` a point, `toward` an argument; moves are their own data, SA-D4), `take`, `put`, `use_held`,
  `wait` (`us`).
- **effects**, each a generic change plus a named event (contract T6): `set`, `reparent` (the actor or this thing
  into a slot or the actor's hand: holding is a change of parent), `link`, `unlink`, `create` (a kind, `here`, in a
  slot or in the hand), `remove`, `timer`. SA-F2b defines what each does.

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
| `moves` | no `motion`/`loose` on a carried thing | not checked until SA-F10 defines them |
| `card` | no card, or a card whose purpose text is over 80 characters | no (a card that is given must name a text entry) |
| `no-labels` | a mood word in the card | no |
| `refs` | a kind that is not loaded, or kinds in a circle | no |

A state field that no form of the kind sets to some declared value is taken as set from outside, so a need on it is not
a dead end (the kettle's water is filled by something else).
