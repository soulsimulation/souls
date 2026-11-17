# @souls/form-rules

What a form needs, decided from plain data (Soul Actions SA-F2, [#2843](https://github.com/soulsimulation/souls/issues/2843)),
what it does, as generic changes plus named events (SA-F2b, [#2844](https://github.com/soulsimulation/souls/issues/2844)),
and the value of a field that changes with time (SA-F5a, [#2845](https://github.com/soulsimulation/souls/issues/2845)).
`decide(input)` answers whether a form of a kind written in the [entry format](../../docs/soul-actions/entry-format.md)
can be done now. Nothing in today's server or client calls it yet; Engine v2's shared rules (R2,
[#2685](https://github.com/soulsimulation/souls/issues/2685)) write it again and run the same cases.

```sh
node --test packages/form-rules/src/*.test.ts        # every case in cases/, cases/effects/ and cases/timed/, plus the library's own checks
node packages/form-rules/bin/browser-check.mjs       # the same verdicts, timed values and crossings in Node and in a browser build
```

## The answer

- `{verdict: "yes", read}`: every need is met.
- `{verdict: "no", reason, need, detail, fix, read}`: the first unmet need, by its index in the form. `reason` is one
  of `REASONS`; `detail` says what is missing (the field, what was found and wanted; the slot; the point and move;
  the link and how many there are). `fix` is one act that would meet the need, taken only from data: a form of the
  same thing that anyone may start and whose `set`, `link` or `unlink` effect meets it; the same form with another
  free slot; or a closed step (`walk_to` a point, `take`, `put`). Where the data offers none, `fix` is `null`.
- `{verdict: "unknown", need, node, field | link, read}`: a need read a field or link outside the asker's audience
  and no need was definitely unmet. A definite "no" from another need wins over "unknown".
- Malformed input never throws: it is `no` with reason `bad_input` and `detail.what`.

`read` lists what the verdict read, as `[address, value]`: `<node>/field/<n>` (by the field's number),
`<node>/link/<n>` (how many links), `<node>/slot/<name>` (how many are in it), `<body>/hand/<name>`,
`<body>/effector_mm` and `move/<name>/reach_mm`. A commit compares these to tell whether anything changed.

## The needs

`NEEDS` is one closed list, shared with R2: `state` (a field `is` or is `not` a value, or lies within `at_least` and
`at_most`, whole numbers), `slot_free`, `within_reach` (of a point, by the reach of the move the form's step makes
there, compared as squares in big integers), `hand` (`free: true` or `holds: <kind>`), `held_by_actor`, and `linked`
/ `unlinked` (whether the thing has any link of that type; whether the actor holds one is "who may", SA-F7a), and
`room` (every amount the form's `transfer` effects move has room where it lands, else `no_room`: a pour never
overflows). A need on a `timed` field reads its value at the state's `now_us` (below). The range, hand and room needs and the `transfer` effect are not in the entry format yet; their cases use
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
- `timers`: a `timer` effect is not a change to state; it is returned here with the index of its event.

Every value in a result is one that Engine v2's encoding profile holds (T0, `v2/docs/encoding.md`): whole numbers and
names, never a float, a boolean or `null`. A flag is 0 or 1 (an entry may still write `true` or `false`, and the
rules compare them as 1 and 0); text is a key by reference, `{"text": <key>}`, never words; a value that is missing
is left out, and a `set` without `to` clears the field to its default. `outsideProfile(value)` names where a value
leaves the profile, with the profile's name for the refusal (`simple`, `null`, `float`, `text-not-name`, ...);
`effects` refuses to write such a value and `apply` refuses to accept one.

The entry's effects map to changes like this: `set` sets a field of the thing (on a timed value, `rate`: the value at the state's `now_us`, or `to` when the effect gives one, with the new rate, `{value, per_s, set_us}` written whole); `transfer` moves an amount of one
int field between two nodes (`from`, `into`: `"this"` or an argument; `amount`: a whole number, an argument, or
`"room"`), the least of what it asks and what the source has above its field's `min`, as two `set`s whose `by`s sum
to zero; `reparent` moves the actor or the thing into a slot or the actor's first free hand (holding is a parent);
`create` makes a thing in a slot, the actor's first free hand or `here`, loose in the place the actor is in (where
on the ground or a surface is Engine v2's set-down, E4), with the id `<receipt>.<n>`; `link` / `unlink` join the
actor to the thing. Effects are worked out in order on a copy, so a later one sees an earlier one; one that cannot be
done refuses the whole form with `{verdict: "no", reason, effect, detail}`.

`apply(state, result)` applies a result to plain state, all of it or none: a refusal changes nothing; a receipt
already in `state.applied` changes nothing and says `again: true`; an event whose `by`s do not sum to zero, or a
change that cannot apply or a value outside the profile, refuses the batch with its index.

## An effect case

A file in `cases/effects/` is `{"format": "souls-effect-cases/1", "about": ..., "cases": [...]}`. A case is a state
and the acts done in it, in order, each with its `receipt`, an optional `actor` (another body in the same state), an optional `now_us` (the act's world time, when it differs from the state's) and
what `effects` should return (`expect`, compared like a rule case's). `after` names nodes and what each should be
once every act is applied (`null`: removed), compared whole. Every act that is done is also applied a second time
with its receipt, which must change nothing.

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
