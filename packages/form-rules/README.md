# @souls/form-rules

What a form needs, decided from plain data (Soul Actions SA-F2, [#2843](https://github.com/soulsimulation/souls/issues/2843)),
what it does, as generic changes plus named events (SA-F2b, [#2844](https://github.com/soulsimulation/souls/issues/2844)),
the value of a field that changes with time (SA-F5a, [#2845](https://github.com/soulsimulation/souls/issues/2845)),
who may do a form, as a test on links (SA-F7a, [#2848](https://github.com/soulsimulation/souls/issues/2848)),
how a thing reacts, by rules on its kind (SA-F15, [#2853](https://github.com/soulsimulation/souls/issues/2853)),
and where a Soul entering a role of an activity is placed (SA-G1a, [#2872](https://github.com/soulsimulation/souls/issues/2872)).
`decide(input)` answers whether a form of a kind written in the [entry format](../../docs/soul-actions/entry-format.md)
can be done now. Nothing in today's server or client calls it yet; Engine v2's shared rules (R2,
[#2685](https://github.com/soulsimulation/souls/issues/2685)) write it again and run the same cases.

```sh
node --test packages/form-rules/src/*.test.ts        # every case in cases/, cases/effects/, cases/timed/, cases/who/, cases/react/ and cases/activity/, plus the library's own checks
node packages/form-rules/bin/check-reactions.mjs     # the check gate's rule check over every kind (exit 1 on a refusal)
node packages/form-rules/bin/browser-check.mjs       # the same verdicts, timed values and crossings in Node and in a browser build
```

## The answer

- `{verdict: "yes", read}`: every need is met.
- `{verdict: "no", reason, need, detail, fix, read}`: the first unmet need, by its index in the form. `reason` is one
  of `REASONS`; `detail` says what is missing (the field, what was found and wanted; the slot; the point and move;
  the link and how many there are). `fix` is one act that would meet the need, taken only from data: a form of the
  same thing that anyone, or its holder, may start and whose `set` (with `by`: the value it adds up to, within the field's bounds, so a crank that adds
  charge fixes too little charge), `link` or `unlink` effect meets it, or whose
  `transfer` into the thing would meet it at the field's `max` (out of it: at its `min`); the same form with another
  free slot; or a closed step (`walk_to` a point, `take`, `put`). Where the data offers none, `fix` is `null`.
- `{verdict: "unknown", need, node, field | link, read}`: a need read a field or link outside the asker's audience
  and no need was definitely unmet. A definite "no" from another need wins over "unknown".
- Malformed input never throws: it is `no` with reason `bad_input` and `detail.what`.
- A need that names its refusal's words (`says`, a key of the entry's text table) adds `says` to its `no`, so a client
  words the refusal as the kind's author did; a `bad_input` carries none.

`read` lists what the verdict read, as `[address, value]`: `<node>/field/<n>` (by the field's number),
`<node>/link/<n>` (how many links), `<node>/slot/<name>` (how many are in it), `<body>/hand/<name>`,
`<body>/effector_mm` and `move/<name>/reach_mm`. A commit compares these to tell whether anything changed.

## The needs

`NEEDS` is one closed list, shared with R2: `state` (a field `is` or is `not` a value, or lies within `at_least` and
`at_most`, whole numbers), `slot_free`, `within_reach` (of a point, by the reach of the move the form's step makes
there, compared as squares in big integers; reach to another thing is read in this order: of a `thing` argument the
form walks to, met when the thing is in the actor's place, since the walk is taken as done; else `"of": {"arg": "tap"}`
names the point of another thing given as a form argument, placed by that node's `at_mm` in the input, with no
rotation, the fix a `walk_to` its `stand` point, SA-F2; else, an unknown pose, `unknown`), `hand` (`free: true`, `empty: true` (every hand holds nothing, else
`hand_not_empty` with how many hold something) or `holds: <kind>`), `held_by_actor` (this thing, or a `thing` argument), `moves` (a `thing` argument moves `by` `carry`
or `push`, read from its kind's `motion.how`: `moves_by`, `motion_unsaid`, `needs_souls`, or `no_free_hand` when
carrying takes more hands), and `linked`
/ `unlinked` (whether the thing has any link of that type; whether the actor holds one is "who may", SA-F7a), and
`room` (every amount the form's `transfer` effects move has room where it lands, else `no_room`: a pour never
overflows) and `enough` (every amount they ask is there to give at the source, else `not_enough`, with the source, what
it can give and the amount asked), and `sum` (two or more `int` fields of this kind added up, `at_least` and/or
`at_most`; with `after_moves`, each as the form's transfers would leave it, measured as `room` measures them; a refusal
is `field_differs` with `detail: {fields, found, wanted}`). A need on a `timed` field reads its value at the state's `now_us` (below). A `state`
need with a `link` reads a field of the place at the end of that link (`from: "place"`, `most` 1): the place's kind
says the field's number and audience, the read is `<place>/field/<n>`, an asker outside it gets `unknown` naming the
place, and a refusal names the place in `detail.node` with no fix (nothing this thing does changes its place); with no
place linked it is `not_linked`. The place is never read from the tree (Engine v2 T2: a parent is lifetime and frame).
A `state` need with `of: {arg}` reads a field of the thing that argument names, the same way: the named thing's kind
says the field's number and audience, an asker outside it gets `unknown` naming the thing, a refusal names it in
`detail.node` with no fix, and a missing argument is `bad_input` (`argument_missing`). The range, hand and room needs and the `transfer` effect are not in the entry format yet; their cases use
the test kinds in `cases/kinds/test/`.

## A case

A case file in `cases/` is `{"format": "souls-form-cases/1", "about": ..., "cases": [...]}`. Each case is the act,
the state and the asker, and the expected verdict; adding one changes no code.

```json
{
  "name": "switch_on_out_of_reach",
  "act": { "this": "k1", "form": "switch_on", "args": {} },
  "state": {
    "actor": "b1",
    "nodes": {
      "k1": { "kind": "eden:kettle", "fields": { "water": "cold", "heating": false } },
      "b1": { "hands": { "left": null, "right": null }, "effector_mm": [-60, 40, 601] }
    },
    "moves": { "press": { "reach_mm": 600 } }
  },
  "asker": { "sees": ["public"] },
  "expect": { "verdict": "no", "reason": "out_of_reach", "need": 2, "fix": { "step": "walk_to", "point": "switch" } }
}
```

- A node has a `kind` (resolved from `content/kinds/` and `cases/kinds/`), `fields` (a missing field has its
  default), `links` (type to the linked ends), `slots` (name to its occupants), and for the actor `hands` (name to
  the held node or `null`; holding is the held thing's parent being the hand) and `effector_mm`, the effector's
  position in the frame of the act's thing (turning poses into that frame is geometry the engine supplies).
- An argument naming a slot is the slot's name on the act's thing, or `{"node", "slot"}` for another node's.
  Arguments arrive resolved: choosing them from a selector is not a rule.
- `now_us` in the state is world time in whole microseconds; it is needed only when a need reads a `timed` field.
- `asker.sees` is the audience rules the asker satisfies for these nodes, or `"all"` for the world itself.
- `expect` lists the keys to compare with the verdict; each key is compared whole, object key order aside.

## What a form does

`effects({kinds, act, state, receipt})` asks the rules as the world; if the answer is not yes, it returns that
verdict and no changes. Otherwise it returns `{verdict: "yes", receipt, actor, changes, events, timers}`, in the two
layers of Engine v2's contract T6:

- `changes`, generic changes any viewer can apply without the kinds: `set` (`node`, `field`, its number `n`, `to`,
  and for an amount the signed `by`), `link` / `unlink` (`node`, `link`, `n`, `end`), `reparent` (`node`, `to`),
  `create` (`node`, `kind`, `to`) and `remove` (`node`, with everything it holds). A place `to` is a slot
  `{node, slot}`, a hand `{node, hand}`, or loose in a node `{node}`.
- `events`, one per effect the entry declares, in order: its name, the node, and the indexes of its changes. The name
  is `namespace:name`: the declaring kind's namespace before the plain name its entry writes (`poured` in an
  `eden:` kind is `eden:poured`).
- `timers`: a `timer` effect is not a change to state; it is returned here with the index of its event. A timer is
  named by the form it starts: if the node already has pending timers of that form (`timers` on the node in the state,
  `{id, form, due_us}`, Engine v2 T6 rule 15), the new one carries `replaces`, their ids, which the engine clears, so
  a crank lamp put out early and lit again goes dark at its new time and not at the earlier one.

Every value in a result is one that Engine v2's encoding profile holds (T0, `v2/docs/encoding.md`): whole numbers and
names, never a float, a boolean or `null`. A flag is 0 or 1 (an entry may still write `true` or `false`, and the
rules compare them as 1 and 0); text is a key by reference, `{"text": <key>}`, never words; a value that is missing
is left out, and a `set` without `to` clears the field to its default. `outsideProfile(value)` names where a value
leaves the profile, with the profile's name for the refusal (`simple`, `null`, `float`, `text-not-name`, ...);
`effects` refuses to write such a value and `apply` refuses to accept one.

The entry's effects map to changes like this: `set` sets a field of the thing (on a timed value, `rate`: the value at the state's `now_us` with the new rate, `{value, per_s, set_us}` written whole; with `by` instead of `to`, the int value plus `by`, refused as `out_of_range` outside the field's `min`, or 0, and `max`, and written as `to` alone, since nothing balances a sip); `transfer` moves an amount of one
int field between two nodes (`from`, `into`: `"this"` or an argument; `amount`: a whole number, an argument, or
`"room"`), the least of what it asks and what the source has above its field's `min`, as two `set`s whose `by`s sum
to zero, or between two fields of this one thing (`into_field`, both ends `"this"`), as two `set`s on it that sum to
zero the same way; `reparent` moves the actor, the thing or a `thing` argument into a slot, the actor's first free hand or
`here`, loose in the actor's place (holding is a parent);
`create` makes a thing in a slot, the actor's first free hand or `here`, loose in the place the actor is in (where
on the ground or a surface is Engine v2's set-down, E4), with the id `<receipt>.<n>`; `link` / `unlink` join the
actor to the thing. Effects are worked out in order on a copy, so a later one sees an earlier one; one that cannot be
done refuses the whole form with `{verdict: "no", reason, effect, detail}`.

A stock's take (an entry's `stock` section names the form, [#2851](https://github.com/soulsimulation/souls/issues/2851))
is one event: its `create` into `actor_hand`, marked `stock: <name>` (and `carries`, the text fields the thing
carries by reference), and a `set` of the count with `by: -1`. The make is the other side of that `by`, so `apply`
counts it and the event balances. A take from an empty stock is refused `empty`, and from a container whose `closed`
audience does not include the actor (not linked by the link it names) `closed`, each as `{verdict: "no", reason,
effect, detail}` before the rules are asked. `stockList(kinds, state, node)` answers what a container is known to
hold, or `null` while it is closed to the actor; a case may name such reads in `lists`.

`apply(state, result)` applies a result to plain state, all of it or none: a refusal changes nothing; a receipt
already in `state.applied` changes nothing and says `again: true`; an event whose `by`s do not sum to zero, or a
change that cannot apply or a value outside the profile, refuses the batch with its index.

## Chance (SA-F13)

An effect `{"change": "draw", "outcomes": [{"name", "weight", "event", "set": [{"field", "to"}]}]}` has one of its rows
happen, by weight. A weight is a whole number or `{"field": <an int field of the thing>}` (a practice count), and nothing
else (Engine v2 E14 runs the draw by the same rule). The draw is the world's: `effects` takes `draw`, one whole number
below the table's total per draw effect, in order, as data, so a case is fixed and nothing here is random. The row
drawn is the first whose running total passes it. The result's event is the row's `event` and carries `outcome`, the
row's name, so the record says which was drawn. With no `draw` the answer is `{verdict: "unknown", reason: "draw",
effect, total, could_be: [{outcome, weight, event}]}`, the whole table with its weights now, and no changes. A draw
outside `0..total-1`, an empty table, or a weight that is not whole is refused as `bad_input`. A reaction rule never
draws (SA-F15). Only `set` changes are in a row for now; the entry format does not have `draw` yet, so cases use the
test kinds `test:dartboard` and `test:die`.

## An effect case

A file in `cases/effects/` is `{"format": "souls-effect-cases/1", "about": ..., "cases": [...]}`. A case is a state
and the acts done in it, in order, each with its `receipt`, an optional `actor` (another body in the same state), an optional `now_us` (the act's world time, when it differs from the state's) and
what `effects` should return (`expect`, compared like a rule case's). `after` names nodes and what each should be
once every act is applied (`null`: removed), compared whole. Every act that is done is also applied a second time
with its receipt, which must change nothing.

## A timed value

A field of type `timed` changes by itself with time (a kettle heats, a candle burns down) and is stored as three whole
numbers, `{value, per_s, set_us}`: its value when it was set, its rate per second in the field's unit, and the world
time it was set, in microseconds. Nothing is written between events; Engine v2's F5
([#2770](https://github.com/soulsimulation/souls/issues/2770)) settles and rewrites the three on any change and runs
the same cases.

- `valueAt(def, stored, now_us)`: the value plus `per_s x (now_us - set_us) / 1,000,000`, truncated toward zero (whole
  units accrued, so rising and falling behave alike), held within the field's `min` and `max`. The rounding of a
  falling value is F5's ([#2770](https://github.com/soulsimulation/souls/issues/2770)) to settle: a floor instead of
  truncating the change would read one unit lower for a falling value mid-step (a candle 1 mm shorter after 1 us).
- `crossing(def, stored, {at_least | at_most: level}, from_us)`: the first whole microsecond at or after `from_us` at
  which that value meets the level, so the crossing is rounded up and a need on the field turns from no to yes at
  exactly that time; `null` when it never does (the rate is zero or points away, or a bound stops it short).
- World time is a signed 64-bit count that never stops. Every number (the three, `now_us`, `from_us`, a level, `min`,
  `max`) may be a safe integer or a big integer, as T0's encoding reads a whole number beyond 2^53; everything is
  worked in big integers, and a result is a number when it is a safe integer, else a big integer. Only a number or
  result outside the signed 64-bit range is refused, as `{bad: "beyond_i64"}`; a time before `set_us` is refused as
  `{bad: "time_before_set"}`. A Rust build needs 128-bit intermediates (rate x elapsed time exceeds 64 bits).
  Case files are read with whole numbers beyond 2^53 as big integers (`parse` in `src/load.ts`).

A file in `cases/timed/` is `{"format": "souls-timed-cases/1", "about": ..., "cases": [...]}`. A case names a kind
and a field, a stored value, `values` as `[now_us, value]` and `crossings` as a level, `from_us` and the expected
time (or `null`). The `timed` type is not in the entry format yet; its cases use `cases/kinds/test/timed_kettle.json`.

## Who may

`whoMay(input)` takes the same input as `decide` and answers whether the actor may do the form at all; a commit asks
it before the needs. A form's `who` is one of a closed list (`WHO`), shared with Engine v2 F6
([#2771](https://github.com/soulsimulation/souls/issues/2771)), and every test is on links or holding, never on a field:

- `anyone`, the default. Owning does not lock: only a form whose `who` names the owner link does.
- `holder`: the thing is in one of the actor's hands (holding is a parent).
- `world`: a form a timer starts; no Soul's act may do it.
- `{"link": <type>}`: the actor, or the actor's Soul (the end of the body's `soul` link), is an end of a link of that
  type on the thing. Its owner, a member, the Soul whose turn it is, a Soul in a named role of the activity and a
  relation its creator set are all this one test, with the link type the kind declares.

The rule is the form's own data, so anyone can read it before trying. The answer is `{verdict: "yes", who, read}`;
`{verdict: "no", reason: "not_permitted", who, detail, read}`, where `who` is the rule and, for a link, `detail` is
`{link, ends}`, the ends that may ("its owner, s1"); `{verdict: "unknown", who, node, link, read}` when the link is
outside the asker's audience, so a hidden members list is never read or named; or `bad_input`. `read` holds
`<body>/soul`, `<node>/link/<n>/ends` and, for `holder`, the hands.

A file in `cases/who/` is `{"format": "souls-who-cases/1", "about": ..., "cases": [...]}`, each case shaped like a rule
case. Its three examples, a private workbench, a chess move and a lecture speech, use the test kinds in
`cases/kinds/test/`.

## Things react

A kind may carry `reactions`: named rules, each `{"when": <trigger>, "do": [<effect>, ...]}`, that answer what
happens to a thing, or to a thing linked to it, with no Soul acting. The trigger and the effects come from two closed
lists in [`src/reactions.json`](src/reactions.json), the one file shared with Engine v2 E18
([#2788](https://github.com/soulsimulation/souls/issues/2788)), which runs them.

- **Triggers** (`when.on`): `changed` (a `field` of this thing), `linked_changed` (a `field` of a thing at the other
  end of a `link`), `support_changed` (a `field` of the thing it rests on, or it comes to rest on a thing where that
  field differs), `rested` and `left` (something comes to rest on it or leaves), `body_entered` and `body_left` (a
  body enters or leaves the place it is in), `due` (a `timer` one of its forms set comes due) and `world` (the world
  announces a change of `light` or `weather`, Engine v2 E6). A trigger that carries a new value may filter on it
  with `is` or `not`.
- **Effects** (`do[].change`): `set` a field to a constant or to the trigger's new value (`{"trigger": "value"}`),
  `add` a whole amount to an int field (held within its `min` and `max`), or set the `rate` (`per_s`) of a timed field,
  which settles its value at `now_us` first. Each acts on this thing, or with `"target": {"link": <type>}` on every
  thing at the far end of that link, and may name its `event`.
- A rule never chooses, never draws, never moves a body and acts on no offer or activity. Only `set`, never "flip":
  setting a field to its own value is no change, and starts nothing.

`react({kinds, state, cause, receipt})` takes the state before a cause, which is a generic `set` or `reparent`
change or `{"due": <timer>, "node"}`, and returns what the rules do, in the shape `effects` returns (`actor:
"world"`), plus `fired`, the `[node, rule]` pairs started; `apply` applies it. A body is a node whose kind's owner is
`family`; `state.world` names the world's own node. It answers one cause: a chain of rules, its depth and a fan-out
spread over ticks are E18's.

`checkReactions(kinds)` is the check gate's: it refuses a rule outside the lists, one that names a body, an offer or
a draw (`acts_on_body`, `acts_on_offer`, `draws`), and any set of rules that could feed itself. It builds the graph
whose nodes are (kind, field), with an edge from what a rule watches to what it writes, across a link type to every
kind that declares it, and refuses each cycle with its fields and rules, as the kind loaded last among them. The
graph is drawn wide (every kind with the field may be a support), so it can refuse a safe set but never accepts a
loop.

A file in `cases/react/` is `{"format": "souls-react-cases/1", "about": ..., "cases": [...]}`: a state, a `cause`, a
`receipt`, what `react` should return (`expect`, compared like a rule case's) and the nodes `after` the cause and the
changes are applied. A file in `cases/react/check/` (`souls-react-check-cases/1`) is a list of kinds, loaded in that
order, and every error expected. The `reactions` section is not in the entry format yet; the five examples (a wall
switch and its lamps, a street lamp, a kettle on a stove, a shop, a chiming door) use test kinds in
`cases/kinds/test/`.

## An activity

An activity kind carries a `roles` section (proposed for the format on
[#2842](https://github.com/soulsimulation/souls/issues/2842); the format page's "An activity" section says what it
holds). `place(input)` takes a rule case's input whose act is an entering form of the activity: the form that links a
role to the actor and puts the actor into a slot argument. It returns `{verdict: "yes", role, place, args}`, with the
first free place by the role's rule filled into the argument, or `{verdict: "no", reason: "no_free_place", role,
detail: {places}}`, where `places` is how many places it looked at. A node's `at_mm` is its origin in the frame of the
place it is loose in. `enter(input)` asks who may (SA-F7a), then the place, then the form's needs and effects
(SA-F2b), and returns the effects with `role` and `place`. `apply` applies them.

A file in `cases/activity/` is `{"format": "souls-activity-cases/1", "about": ..., "cases": [...]}`. Each case has a
state, the `activity` node, and the Souls who `enter` in order: each with its `actor`, `form`, `receipt` and what
`enter` should return (`expect`). The test checks that every body is where the rules placed it and that no place is
given twice. Then it compares the nodes `after`. The examples are a lecture in three rooms and a supper whose host
must be its owner. Both are test kinds, because `roles` is not in the entry format yet.

### Leaving, the "now" line and the end

`leave(input)` takes a rule case's input whose act is a leaving form: the form that unlinks one role from the actor.
It asks who may, works out the form's effects, then applies the role's rule for leaving. A `required` role leaving,
or the last member leaving, ends the activity: the rules add a `released` event (every remaining member unlinked, and
a body in the activity's own slots moved out to its place) and an `ended` event (the activity removed). Their names
carry the kind's namespace. It returns the effects with `role` and `ended` (1 or 0).

`nowLine({kinds, state, node, asker})` reads the kind's `now` section: `{floor, stage, ends_us}`. `ends_us` is the
first microsecond the `ends` timed field reaches 0 (SA-F5a's `crossing`). A part outside the asker's audience is left
out and named in `unseen`. An activity nobody entered is removed by its own world form at that time; the engine's
timer runs it with `effects`.

A file in `cases/activity/leave/` is `{"format": "souls-activity-steps/1", "about": ..., "cases": [...]}`. Each case
has a state, the `activity` node and `steps` in order. A step does `enter`, `leave`, `now` (the now line) or `world`
(the world's form at `now_us`), with what it should return (`expect`). The test checks that no step removes a body.
Then it compares the nodes `after` and checks that the nodes in `gone` are removed. The example is a one-off talk
(`test:talk`).

### A standing activity

A kind with a `standing` section (see the format page) outlasts a sitting. `join(input)` runs a form that links the
actor as a member, with no place. `enter` and `leave` then also keep the stage: once `enough` are present as one
arrives, a `sitting_began` event sets the stage to `sitting`; when the last one present rises, `sitting_ended` returns
it to `idle`; a member who is present cannot part (`still_present`); and a standing activity is not ended by its last
member parting. `lapse(input)` is the end date: it runs the world form (the engine's timer, at the time its needs
state) and puts a `released` event first, unlinking every member; a body standing in the activity's own slots is moved
out to its place, so removing the activity removes no body. Cases are in `cases/activity/standing/`
(the same step format, with `join` and `world` running `lapse`); the example is a weekly class (`test:class`).

### Between two Souls

A pair (SA-G4, [#2876](https://github.com/soulsimulation/souls/issues/2876)) is an activity of two required roles with
a `pair` section (see the format page): give, hug, handshake, high five, dance and push the swing. `pairOf(entry,
moves)` answers whether a kind is one, or `{bad, detail}` naming the first thing wrong: the accepting form is allowed
only to the invited Soul and needs the asker's role linked and the countdown above 0; the asker offers by a form
allowed to one link; each role has a leaving form; the expiry is a world timer form at the countdown's end that needs
the other role unlinked and removes the offer; no form moves anything by a link except a give's thing into the
accepter's hand; contact points name a move from `content/moves/`. `accept(input)` asks who may, then, for a give,
that the asker still holds the thing in a hand (`not_held`), then `enter`s. An effect's `what` may be `{"link":
<type>}`, the one thing at the end of that link of this node, never a body. Cases are in `cases/activity/pairs/` (the
same step format, with `offer`, `accept`, `leave`, `world` running `lapse` and `now`); the test checks that no change
names a body that is neither the actor nor a member.

## Looks

`looks(input)` in `src/looks.ts` (SA-D1a, [#2885](https://github.com/soulsimulation/souls/issues/2885)) turns a kind's
looks table, a state and the time since it changed into where each part of its model is: rotate and slide in whole
millidegrees and millimetres, scale and glow in permille, show, tint, and pick by choice. The table is written in
[the entry format](../../docs/soul-actions/entry-format.md#the-looks-table); `checkTable` names what is wrong with one.
Its cases are `cases/looks/` (kinds in `cases/looks/kinds/`); `node --test packages/form-rules/src/looks.test.ts` runs
them and `node packages/form-rules/bin/looks-browser-check.mjs` checks Node against a browser build. Today's page
calls it for a def whose `make.args.looks_table` carries a table (`apps/web/src/gen-mesh/vocab-look.ts`); the wiring is
thrown away when Engine v2 draws things (V17, V8), the table and the function carry over.

A row may follow a timed field (below; SA-D1b, [#2886](https://github.com/soulsimulation/souls/issues/2886)): the
state holds its three stored numbers and `looks({..., now_us, fields})` reads it with `valueAt` at the viewer's world
time, so a level rises on screen with nothing sent after the record (a viewer behind the set time draws it as set).
The page sets its world clock with `setLooksClock` (`vocab-look.ts`) and places such parts again each frame.

## A timed value

A field of type `timed` changes by itself with time (a kettle heats, a candle burns down) and is stored as three whole
numbers, `{value, per_s, set_us}`: its value when it was set, its rate per second in the field's unit, and the world
time it was set, in microseconds. Nothing is written between events; Engine v2's F5
([#2770](https://github.com/soulsimulation/souls/issues/2770)) settles and rewrites the three on any change and runs
the same cases.

- `valueAt(def, stored, now_us)`: the value plus `per_s x (now_us - set_us) / 1,000,000`, truncated toward zero (whole
  units accrued, so rising and falling behave alike), held within the field's `min` and `max`. The rounding of a
  falling value is F5's ([#2770](https://github.com/soulsimulation/souls/issues/2770)) to settle: a floor instead of
  truncating the change would read one unit lower for a falling value mid-step (a candle 1 mm shorter after 1 us).
- `crossing(def, stored, {at_least | at_most: level}, from_us)`: the first whole microsecond at or after `from_us` at
  which that value meets the level, so the crossing is rounded up and a need on the field turns from no to yes at
  exactly that time; `null` when it never does (the rate is zero or points away, or a bound stops it short).
- World time is a signed 64-bit count that never stops. Every number (the three, `now_us`, `from_us`, a level, `min`,
  `max`) may be a safe integer or a big integer, as T0's encoding reads a whole number beyond 2^53; everything is
  worked in big integers, and a result is a number when it is a safe integer, else a big integer. Only a number or
  result outside the signed 64-bit range is refused, as `{bad: "beyond_i64"}`; a time before `set_us` is refused as
  `{bad: "time_before_set"}`. A Rust build needs 128-bit intermediates (rate x elapsed time exceeds 64 bits).
  Case files are read with whole numbers beyond 2^53 as big integers (`parse` in `src/load.ts`).

A file in `cases/timed/` is `{"format": "souls-timed-cases/1", "about": ..., "cases": [...]}`. A case names a kind
and a field, a stored value, `values` as `[now_us, value]` and `crossings` as a level, `from_us` and the expected
time (or `null`). The `timed` type is not in the entry format yet; its cases use `cases/kinds/test/timed_kettle.json`.
