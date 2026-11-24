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
