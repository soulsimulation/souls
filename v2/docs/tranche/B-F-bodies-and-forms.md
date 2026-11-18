# Engine v2 tranche · Lane B (bodies and control) and Lane F (forms on the new engine)

Draft, local only, 16 Nov 2026. Task bodies in the shape of `v2/docs/tranche/FORMAT.md`; its rules apply to
every task and are not repeated. The trunk (`v2/docs/TRUNK.md`) is fixed: nothing here changes it. Task K15
puts this file in the repository as `v2/docs/tranche/B-F-bodies-and-forms.md`; that path is how a task or a
pull request cites these notes.

## Changes at the final pass

Applied after the final audit (rules 11 to 18 of the format, and the planner's rulings). No ID, stage, kind or
ceiling changed. One title changed (B7). One header cell changed (F7's "Depends on").

**Done to every task (B1 to B13, F1 to F9).**

- It now ends with **Acceptance**: at most five boxes, each one thing that can be shown true or false, taken
  from its Outcome and Proof. F7, the gate, has the four gate boxes.
- Its Step 0 names what to check and the result that means "stop and hand back".
- Every citation of a file a checkout lacks is gone. The trunk is `v2/docs/TRUNK.md`; a contract page is named
  by its path (`v2/docs/world-model.md` for T2, `pose.md` for T4, `effects.md` for T6, `bodies.md` for T9,
  `intents.md` for T10, and so on); "trunk flag N", "design 3.3", "the design's" and every Soul Actions section
  number were replaced by the fact itself, stated in the task.
- Touches names modules. The new tree does not exist yet, so the module names are proposals, listed once
  under "Where this lane's code goes".
- The "Amended at the final audit" line that closed thirteen tasks was folded into the task's text and
  removed, so that a task ends with its acceptance. What those lines recorded is in the table below.
- Soul Actions task IDs are written `SA-x`: that tranche's F9 and E3b are not this tranche's F9 and E3.

**Task by task.**

| Task | Change | Why |
|---|---|---|
| B1 | The footgun no longer cites a design section: it states that an early draft said "one driver per body" and the contract says one per resource. Step 0 states the stage-order fact itself. Touches: `sim/src/controller`, one place in K13's `sim/src/host`, `v2/tools/body-script` | Rules 16, 17 |
| B2 | Step 0 says "stop and hand back if either is missing". Touches: `sim/src/moves`, `replica/src/moves.rs`, one bench scenario | Rules 12, 17 |
| B3 | "Queueing for a seat (B7)" and perches (E3) stay as amended earlier. Touches: `sim/src/slots` | Rule 17 |
| B4 | Main purpose no longer says a thing passes between slots and hands only. The design states both parents: a thing held in one hand is a child of that hand's slot; a load carried by several is a child of the carry activity's node, with the carriers linked to it. Setting down where there is no slot is named as E4's. Travel and forks follow the ruling on held things, and are named as not built here | Ruling on held things; the trunk's settled row; the lane E coordinator note |
| B5 | **A restart no longer ends the activity.** Its node and membership links are in the log and survive; a move in progress is handed to its skill again or ended by name. One acceptance box tests it. Standing consent is named as the client's | Ruling "What survives a restart". The consistency audit had left the old line |
| B6 | The clip is named in the acceptance. Touches: `sim/src/activity/contact`, `v2/tools/bout` | Rules 13, 17 |
| B7 | **Title is now "Orders the agent wrote: a held stance, follow, standing in a queue".** Purpose, outcome and body say the same; "wait for" is gone everywhere. The queue order may name the one act done at its head ("queue for this seat and sit", "queue and board"). The engine holds no order that waits for a time or a condition. Step 0 hands back if T10's page lists other orders. Touches: `skills/src/orders`, `sim/src/orders` | Rulings on B7; T10 as approved |
| B8 | A move inside a joint activity may name one of that activity's next beats, at most about two seconds ahead (2 s unless the kind states less). It is a parameter of a move already accepted, not a start time; the intent envelope gains no field. The "question for the owner" is removed. One acceptance box tests the bound | Ruling on B8 |
| B9 | Depends on E23 (already in the header) and says what E23 is: the one moving group, defined once and used by carrying, pushing, walking together, vehicles and rides. Step 0 hands back if E23's contract cannot hold a carried board. A hand-back point at hour three is written in. The group's node and links survive a restart by the ruling; resuming the walk stays out | The lane E coordinator note 1; ruling on restart; ruling on 4 h ceilings |
| B10 | The bar is set: at most 5 intents a second. The recording is checked by eye for device details. Touches: `v2/tools/keys` | Process audit |
| B11 | Ordinary talk is public with a short reach, stated as ruled. "Stays out" names who owns conversations, the calendar and sound | Ruling on speech; inheritance rows 23, 24, 79 |
| B12 | The floater's support is cited from `v2/docs/TRUNK.md`. Touches names lane N's modules | Rules 16, 17 |
| B13 | A harmless gesture is drawn as the stand-in the agent named or a neutral one: the engine never picks a "nearest" clip | E11 as rewritten |
| F1 | Step 0 hands back if no schema is merged or it has a waiting step. The runner is a skill, so it lives in `v2/crates/skills/src/form_runner` | Rules 12, 17; T9 and K13 put built-in skills in their own crate |
| F2 | Touches narrowed | Rule 17 |
| F3 | "Nothing is resumed" is stated as a fact of the form contract, with no section number. A form done where there is no thing reserves nothing (E21 asks) | Rule 16 |
| F4 | **Still 4 h, with the hand-back point at hour three.** Purpose and outcome no longer say a made thing never appears on the ground or passes only between slots: E4 lets a thing be made or set down at a described spot, with the same effect. How long a made thing lasts is its kind's data. Step 0 now checks a premise | Rulings on ceilings and on loose things; the lane E coordinator note 2 |
| F5 | "Expiry rules (F10)" reworded to the ruling. Trunk citation fixed | Ruling on loose things |
| F6 | Step 0 gained its hand-back. An audience is the trunk's (the id of a set of principals), never a fixed list of three | Process audit; consistency audit |
| F7 | "Depends on" names the Soul Actions run tool driving a world from outside. The first acceptance box names what is run: every Soul Actions entry's cases, driven from outside through the same acts an agent sends. The declaration goes in an issue comment; the table goes in the pull request and on the task issue | Process audit; rule 11 |
| F8 | **The hatch is one WASM interpreter inside the shared library, and no scripting language**, as ruled; the open flag is closed. The old "other path" (functions compiled in from a registry) contradicts the ruling and is now the proposed rescope if Step 0 fails. Touches names the dependency list K14 guards | Ruling on F8 |
| F9 | Step 0 gained its hand-back. The refusal of a shape change is in the proof and the acceptance | Process audit |

**In the notes.** Flag 6 (F8 and T9) is closed by the ruling. Flag 3 no longer cites a design section. A
loose thing, `SA-x` and "within noise" are in "Words". A table of modules was added. The lane F introduction
no longer tells a developer to read a local note first; it states the three facts that note carried.

**Earlier amendments (the final audit), now inside the task text.** B3: "waiting for a seat" became queueing.
B4: Step 0 and the transfer state what the trunk settled; the transfer takes any parent. B7: the third order
is the queue. B8: a bound on how far ahead a beat may be. B9: E23 added. B11: reach and audience are two
fields. B12: a floater's height is part of the pose. B13: only physical actions are refused when undeclared.
F1: a form need not belong to a thing; "wait" is a fixed pause. F3: queueing, not waiting. F4: "never on the
ground" removed. F5: the line between F5 and E18. F7: F10 and F11 added to the dependencies.

**Not resolved.**

1. **Where the Soul Actions schema and cases live in the repository.** That tranche is not filed and its run
   tool (`tools/entry/run.mjs`) is a draft, not on main. F1's Step 0 and F7 say "the task issue names the
   path". The coordinator must fill it in at filing.
2. **F7 cannot be dispatched** until the Soul Actions coordinator confirms that the run tool is merged and
   drives a world from outside. The header says so; I do not know which checklist line carries it.
3. **Module names are proposals.** If lanes K and N settle other names for `v2/crates/sim`, the Touches here
   need one pass.
4. **B15** (an owner chooses their Soul's body and look), which the inheritance audit proposes for lane B, is
   not in this file, and the file the final audit names for it (`tasks/P-product-whole.md`) is not in the
   folder.
5. **`INDEX.md` is stale** for B7's title and F7's "Depends on" until `build-index.py` is run again.
6. **F10** (in the Z file, not edited) still tests "kept" as an owner's link or a parent that is a slot or a
   hand. The ruling makes the lifetime data on the kind; this file's text follows the ruling.
7. B10 uses V14, F2 uses I4 and K4, and F3 uses K5, without listing them. All are earlier stages; left as the
   consistency audit left them.
8. E23 depends on B5 (win 5), so B9 cannot start before win 5 is under way. Stage order allows it.

## Changes to the outline

"The outline" is the planner's first task list, which is not in the repository; nothing a task needs is only
there. No ID, title, stage, kind or ceiling was changed at that step. Dependencies and outcomes were:

| Task | Change | Reason |
|---|---|---|
| B1 | Outcome: a four-legged body as well as a humanoid; inputs logged when they change; bytes posted | A record per tick is 20,000 a second at 1,000 bodies. T9's own test is the four-legged body |
| B2 | Depends: + K3. Outcome: "no tick time" given a measure; a refusal beyond reach added | Moves and a thing's named points load through K3 |
| B3 | Outcome: 600 requests for 300 seats, three arrival orders | "Never held twice" needs a test that tries |
| B6 | Depends: + N13 | The "step" of "jab, block and step" is N13's input. Without it B6 builds a second one |
| B7 | Depends: + B3, N13 | A queue for a seat needs seats; "follow" is N13's mover |
| B8 | Depends: + N13. Outcome: intents up to 500 ms apart, measured in the record, 100 runs, a late intent is a named miss | Bodies must step into place. As written, the measure is true by construction if the engine places both hands |
| B9 | Depends: + B4. Outcome narrowed: 100 m, one door passed straight, set down, a bad route refused before the lift | What four hours can hold (see the task) |
| B10 | Depends: + B3, I4 | Sitting needs seats; an intent needs a commit and a receipt, not only a socket |
| B11 | Depends: + T8 | Speech is text by reference with an audience |
| B12 | Depends: + N5, N10 | "All route" needs routes; a size change is a geometry change |
| B13 | Depends: + V6 | "Drawn simply in a crowd" needs the crowd renderer |
| F3 | Outcome: "every stage" read as every step boundary and mid-step; a legal posture added | Stage commits of long forms are F11's |
| F4 | Fixed order and a hand-back point at hour 3; the end of loose things moved out | It is three Soul Actions tasks (10 h of ceilings there). The end of a loose thing is F10's |
| F7 | Depends: + I4. A precondition on the Soul Actions run tool is named | See the task's Step 0 |
| F8 | Depends: + R2, F1 | The hatch is called from a form's rules and its runner |
| F9 | Depends: + N1, F3. Outcome: walkers present, a thing in use waits, a restart resumes | The 467 lamps come from N1's import; "in use" is F3's reservation |

**Tasks added since, in `v2/docs/tranche/Z-added-at-reconciliation.md`:** B14 (a long load turns through a
door, after B9), F10 (a loose thing that nobody keeps comes to an end), F11 (a long form commits in stages;
lists and documents). A thing handed from one Soul to another is E8 and E24.

**No task should be removed.** Two overlaps need a line drawn. K9 and F5 both say "the due list": K9 has the
list, and F5 the values and the forms an event starts. N13 and B7 both say "follow": N13 moves the body, B7
makes it an order.

## Flags against the trunk (the trunk is not changed)

All six are settled. They are kept so that nobody reopens them.

1. **B4 and T2.** A held cup moves in the hand's frame. Settled in `v2/docs/TRUNK.md`: a change of parent,
   into the hand's slot; a load carried by several has the carry activity's node as its parent, and the
   carriers are linked to that activity. Nothing has two parents.
2. **B12 and T4.** T4 builds only the walk-on-a-surface mode. Settled: a hovering body is supported by the
   surface below it, with a height.
3. **One driver per body.** An early draft of the design said a body has "exactly one driver at a time". T9
   says several skills run at once on separate resources. Lane B follows T9.
4. **Stage order.** N7 (win 1) is built before K13 (win 2) and before T9, which is written at the trunk stop
   between win 1 and win 2. So win 1 moves bodies before the controller contract exists. B1's Step 0 checks
   that no second path into the mover was left behind.
5. **What survives a restart.** Settled: everything in the log survives (poses, parents, links, holds, and
   orders the agent wrote), so a joint activity and a moving group survive. A skill in progress is not
   stored: on restart each active intent is handed to its skill again, or ended with a named reason. Forms
   take the second of those (F3).
6. **F8 and T9.** T9 says "no scripting language is embedded". Ruled: the hatch is one WASM interpreter
   inside the shared library, running a small module named by its hash. That is not a scripting language.

## Words used in both lanes

- **Resource:** a part of a body that can be busy: legs, each hand, gaze, voice. A body's **family** lists them.
- **Skill:** a routine inside the engine that drives a body through the **host interface** (read nodes, ask
  geometry, set timers, draw random numbers, emit controller inputs and effects) and nothing else.
- **Claim:** a skill's hold on one resource of one body. One holder at a time.
- **Move:** one timed thing a body does, written as data.
- **Slot:** a named place on a thing that holds one thing or one body (a seat, a shelf, a hand). A slot is what
  B3, B4 and F4 build; E3 and E4 later let a body or a thing rest where there is no slot.
- **Link:** a typed relation with two ends, found from either end (owns, belongs to, carries).
- **Effect:** one change written to the world's log. **The record** is that log as later read back.
- **Activity:** a node that Souls join by their own intent, with roles. Bodies touch only inside one.
- **Form:** one thing a Soul can do with a kind of thing (or, once E21 lands, with its own body or the ground
  it stands on): who may, what it needs, the steps, what changes. Data, written by the Soul Actions tranche.
  Lane F builds only what runs it.
- **Loose thing:** a thing nobody holds or owns and that is in no slot. How long a loose thing lasts is data
  on its kind: a sofa for ever, a pie a few days. Owned, or in a slot, it lasts. F10 builds the ending.
- **Within noise:** no further apart than two runs of the same thing. State that spread before measuring.
- **SA-x:** task x of the Soul Actions tranche, which writes content and its format. Its IDs collide with
  this tranche's (its F9 is not lane F's F9), so they always carry the prefix.

## Where this lane's code goes

The new tree does not exist yet, so these module names are proposals. The first task to name a module creates
it. If the merged tree already has another name for the same thing, use that name and say so under
"Deviations". Two tasks that share a module are ordered by their dependencies or their stages.

| Module | What it holds | Created by | Also edited by |
|---|---|---|---|
| `v2/crates/sim/src/controller` | Claims, controller inputs, the neutral input, how a family answers | B1 | B11, B12 |
| `v2/crates/sim/src/moves` | Move instances, one timer per phase end, reach | B2 | B4 |
| `v2/crates/sim/src/slots` | Reserving and releasing a slot; hands as slots; the transfer | B3 | B4 |
| `v2/crates/sim/src/activity` | Activity nodes, join and leave; `contact`, `beat` and `carry` inside it | B5 | B6, B8, B9 |
| `v2/crates/sim/src/orders` | An order's record in the log and its ends; a queue's line of spots | B7 | |
| `v2/crates/sim/src/speech` | Utterances and their hearers | B11 | |
| `v2/crates/sim/src/forms` | Handing a form to the runner; applied keys; reservations; amounts, make and remove; the who-may check at commit | F1 | F2, F3, F4, F6 |
| `v2/crates/sim/src/timed` | Timed values and their crossings on K9's due list | F5 | |
| `v2/crates/sim/src/refresh` | The job that moves placed things to a newer revision | F9 | |
| `v2/crates/skills/src/orders` | The three order skills | B7 | |
| `v2/crates/skills/src/form_runner` | The form runner | F1 | F2, F3, F4, F8 |
| `v2/crates/replica/src/` `moves.rs`, `activity.rs`, `speech.rs`, `timed.rs`, `who_may.rs`, `hatch/` | The records and the pure functions both sides run | B2, B5, B11, F5, F6, F8 | B6 (`activity.rs`) |

---

# Lane B · Bodies and control
