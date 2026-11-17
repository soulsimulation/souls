# @souls/form-rules

What a form needs, decided from plain data (Soul Actions SA-F2, [#2843](https://github.com/soulsimulation/souls/issues/2843)).
`decide(input)` answers whether a form of a kind written in the [entry format](../../docs/soul-actions/entry-format.md)
can be done now. Nothing in today's server or client calls it yet; Engine v2's shared rules (R2,
[#2685](https://github.com/soulsimulation/souls/issues/2685)) write it again and run the same cases.

```sh
node --test packages/form-rules/src/*.test.ts        # every case in cases/, plus the library's own checks
node packages/form-rules/bin/browser-check.mjs       # the same verdicts in Node and in a browser build (1,000 generated cases)
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
/ `unlinked` (whether the thing has any link of that type; whether the actor holds one is "who may", SA-F7a).
The range and hand needs are not in the entry format yet; their cases use the test kind in `cases/kinds/test/`.

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
- `asker.sees` is the audience rules the asker satisfies for these nodes, or `"all"` for the world itself.
- `expect` lists the keys to compare with the verdict; each key is compared whole, object key order aside.
