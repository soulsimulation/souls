# The look gate's rubric for bodies

A body sheet from `node tools/entry/look.mjs <entry> --body <form>` shows one hand action at five moments (start,
reaching, contact, holding or returning, end) from two views. The author, agent or person, judges the sheet by eye
against the five questions below and writes the answers in the pull request. The bar: the sheet reads as the action,
natural if comical.

Each question gets **pass**, **fail** or **n/a**, with the frame that decides it (for example `a3`, view A at moment 3).
A sheet with any fail is revised (the entry's points, the `--on` height, or the move) and drawn again, up to three
times. After three revisions, a fail is reported as is.

1. **Reads as the action.** Someone who sees only the contact frame of each view could name the action: pressing a
   switch, pouring into a cup, drinking from a cup.
2. **The hand goes to the thing.** At contact, the orange mark (the effector) is on the red mark (the form's point),
   and both are on the thing or on what it is used on. The printed hand-to-target number agrees: a few centimetres
   at most. Above 30 cm is a fail whatever the picture shows.
3. **Nothing passes through anything.** No limb, held thing or vessel goes through the body, the counter or the
   thing, at any moment in either view.
4. **Not contorted.** The arm bends at the elbow the way an arm bends. It is not stretched past its length: the sheet
   prints "arm short by N mm" when it is. The body faces what it works on.
5. **Feet on the ground.** Both feet stand flat on the floor in every frame. Nothing floats that should rest on
   something.

What the sheet cannot show, and so the rubric does not ask: the motion between moments (that is video), other body
types, the hand's grip shape (the figure's hand is a ball), and tilt anywhere but the held thing's pour or sip.

## A new kind

One command writes a new kind's three files where the existing kinds keep theirs, and all three pass the checks as
written:

```sh
node tools/entry/new.mjs <family> <kind>     # e.g. node tools/entry/new.mjs tide-gauges tide_gauge
node tools/entry/check.mjs <family>          # the entry check
node --test packages/form-rules/src/*.test.ts  # the rules and effects cases
```

`<family>` is a folder of `content/kinds` (new or existing, words joined by `-`); `<kind>` becomes `eden:<kind>` (words
joined by `_`). It refuses a name that is taken and writes nothing then. It writes:

- `content/kinds/<family>/<kind>.json`, the entry: a switch, one on/off field (`on`, number 28) and the two forms that
  set it (`switch_on`, `switch_off`), each needing the field the other way and the `switch` point within reach.
- `packages/form-rules/cases/<kind>.json`, the rules cases: a yes for each form and a refusal for each of its needs.
- `packages/form-rules/cases/effects/<kind>.json`, the effects case: one run through both forms, and the state after.

What to fill, in this order:

1. The entry ([entry format](../../docs/soul-actions/entry-format.md)): its `state` fields, `points`, `geometry`,
   `forms` (needs, steps, effects and their events), `motion` and `loose`, then `looks` (a shape drawn from its parts)
   and `text` and `card` (one line of purpose, at most 80 characters, no labels such as "quiet").
2. The rules cases: for each form (at most four kept) one case where every need is met, and one refusal for each need,
   with its `reason`, `need` index and `fix`.
3. The effects case: one run through the kind's main chain, each step's `changes` and `events`, and the state `after`.
   A bool is set as `1` or `0`.
4. Both case files together stay at most 12 KB (the slimming rule). A case may be deleted, never changed to pass.

Then run the two checks above and `node tools/entry/check.mjs prove <family>`, which also draws the kind's look and
wants a yes for each form and a refusal for each need.
