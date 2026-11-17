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
   with a space anywhere else is refused (contract T8).
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
| 3 | `state` | Fields: `n` (a stable number), `type` (`bool`, `enum` with `values`, `int` with `unit`, `duration` in µs, `text` by reference), `default`, `audience` |
| 4 | `links` | Link types this kind takes part in: `n`, `from` (`soul`, `body`, `thing`), `most`, `audience` |
| 5 | `points` | Named places in the thing's own frame: `role` (`stand`, `grip`, `contact`, `outlet`), `at_mm`, `yaw_mdeg` |
| 6 | `slots` | The children it admits: `admits` (`body`, `thing`), `posture` (`sit`, `lie`), `most`, `at_mm`, `stand` (a stand point), `fits_mm` |
| 7 | `geometry` | `bounds_mm` |
| 8 | `forms` | What can be done with it (below) |
| 20 | `looks` | How it looks; its table is SA-D1a's |
| 21 | `text` | The words, by key |
| 22 | `card` | `{"text": <key>}`: one line of purpose |
| 23 | `howtos` | A short chain of this kind's forms, with its words by key |

Not defined yet, and refused with the name of the task that adds each: `reactions` (SA-F15), `motion` and `loose`
(SA-F10), `stock` (SA-F12), `areas` (SA-D6), `schedule` (SA-F16), `hatch` (SA-F9).

**Audience** is a rule resolved to an audience id when a record is written: `public`, `holder`, `owner`, `members`
(those linked to the node) or `creator`. Point and slot names share one namespace, so a form's argument of type
`part` or `slot` can name "the top drawer" or "the left seat" and one form serves every part.

## A form

```json
"switch_on": {
  "who": "anyone",
  "starts": "act",
  "needs": [{ "need": "state", "field": "water", "not": "empty" }, { "need": "within_reach", "point": "switch" }],
  "steps": [{ "step": "move", "move": "press", "at": "switch" }],
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
  may take it while it runs) or `optional`. Starting, leaving and ending are SA-G1b's and Engine v2 B5's.
- **places** say where a member of the role may be, in a fixed order. `in: "this"`: the activity's own `slots`, in
  the order listed, so a body becomes the activity's child. `in: "here"`: the slots of things in the same place as
  the activity whose origin is within `within_mm` of the activity's, nearest first, then by node id, then in the
  thing's slot order. Only a slot that admits a body counts, and, if `posture` is given, only one with that posture.
  The first slot with room is the place. If no slot has room, the answer is `no_free_place`, naming the role.
- **Entering is a form** of the kind. It links the role to the actor and moves the actor into a slot argument
  (`reparent`), and the role's places fill that argument. Who may enter a role is that form's `who`.
- The world moves no body. Each Soul walks and sits by its own steps; the form's effects only link and set the parent.
  Anything that needs another Soul's yes is an offer with an expiry (Engine v2 E8, [#2779](https://github.com/soulsimulation/souls/issues/2779)).

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
