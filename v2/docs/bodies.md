# Bodies, skills, the host and the hatch

Engine v2 T9 (#2663), contract T9 in [TRUNK.md](TRUNK.md). It fixes what a body is (declared resources), what a skill
is (a claim on them), the one interface a skill touches the world through, and the code hatch's shape. Code:
`v2/crates/replica/src/bodies.rs` and `host.rs`; the built-in skills in `v2/crates/skills`. Fixtures:
`v2/crates/replica/fixtures/bodies/`. Checks: `crates/replica/tests/bodies.rs` and `crates/skills/tests/`. Moving
the real walk behind the interface and handing intents back after a restart (K13, T9b) and running a hatch (F8) are
not here. The controller (B1) is summarised under [The controller](#the-controller-b1).

## Bodies and skills

1. **A body's family declares its resources:** each a name and a class from a closed list, 1 locomotion,
   2 manipulator, 3 gaze, 4 voice (a class added later takes the next number; another is `class-unknown`), and for a
   manipulator the body's slot that holds what it holds. There is no fixed body plan: four legs and no hands, two of
   each, a beak. A family is authored as a kind whose owner is `family` (SA-F1, E21), with its resources in a
   meaning section of its entry: section 13, `{1: resources, 2: actions, 3: full model, 4: simple model}` (B13,
   `kinds/body.rs`; `v2/tools/import-body` writes it for a body from the authoring kit);
   `replica` holds it decoded as `{1: name, 2: [{1: name, 2: class, 3: slot}, ...]}`, never an authored or stored
   form. Unknown fields, and two resources of one name, are refused (`not-a-family`, `resource-duplicate`).
2. **A skill claims classes or names, never anatomy:** every resource of a class (a walk takes all the legs), any
   one of a class (a carry takes one hand), or one by name (a family's own skill). So one walk runs unchanged on a
   dog and a person.
3. **A skill instance has its claims, what it blocks and what cancels it, and an end that always releases.** It
   blocks classes it does not hold (a sit blocks walking). It names the classes whose claim by a new skill cancels it
   (a new walk ends the old one). However it ends, done, cancelled, refused or failed, it releases all it holds.
4. **Starting is all or none, and every refusal has a name.** For each resource a new skill claims, a running
   instance that holds it or blocks its class gives way if it names that class in what cancels it, and otherwise
   refuses (`resource-held`, `resource-blocked`): cancelling beats blocking. A new skill that blocks a class another
   instance holds cancels that instance the same way, or is refused (`resource-blocked`); a sit never starts under a
   walk that goes on. Each resource is judged on its own: an instance cancelled for one claim still refuses another
   claim on a class it does not give way to. Also `resource-missing` (the family has none) and `instance-duplicate`. Several skills run at
   once on one body when their claims do not meet.
5. **A joint activity claims on several bodies, all or none.** Every body is planned before any starts, so a refusal
   on one body names it and changes no body.
   The activity is a node with one owner (T1), so it survives a restart.
6. **Reach is measured from an effector, which may be a held tool.** A held thing is a child of the hand's slot
   ([world-model.md](world-model.md) rule 2), so it moves with the hand and lengthens it (B12).

## The host and the wall

7. **A skill touches the world through one trait, `Host`, in `replica`:** world time (T5; never a machine's clock),
   its body, reading nodes (its body as of this tick, every other node as of the previous tick, T1), a closed list of
   geometry questions answered in integers (a distance, a point, and the bodies near it: their ids, positions and
   velocities on the node it stands on, as of the previous tick), timers on its body set and cleared (T6 rule 15),
   draws from the world's random numbers, controller inputs (T4's own `ControllerInput`: a velocity in three
   dimensions in the body's frame and a movement mode), a request to be carried across a link by the link's move
   (T4; the controller carries it, its read shows field 40 meanwhile, and a shut door on the way is opened for it by
   the world, the body as the acting Soul, while it stands that tick), and entries of its own node (T6 rule 6:
   generic changes, all or none, with the named event that says what they meant), any other node refused as
   `write-outside-own`, a motion change on its own body refused as `motion-outside-controller` and a reparent of its
   own body as `reparent-outside-controller` (it moves only by controller inputs and crossings). A skill
   is a `Skill`: its shape and a step that returns going, done or failed with a name. The built-in skills use the
   same trait. A skill only asks: the claims it holds are made by the body, so nothing it returns needs sealing.
8. **The wall is a crate boundary, and a scan for what the compiler allows.** Built-in skills live in
   `v2/crates/skills`, which depends on `replica` alone (K14's dependency list holds it there) under
   `#![forbid(unsafe_code)]`. A skill crate that names `sim`'s state does not compile, and neither does one that uses
   `unsafe`, and the crate denies float arithmetic (lane note 4). Safe Rust cannot refuse a `static`, a
   `thread_local!`, `extern crate std` or a clock, so a scan of every source file, by tokens with comments and
   literals blanked, refuses them by name: `skill-reads-clock` (`std::time`, `Instant`, `SystemTime`, `UNIX_EPOCH`),
   `skill-keeps-global`, `skill-reaches-out` (`std::env`, `fs`, `net`, `process`, `thread`), `skill-uses-hash-order`
   (`HashMap`, `HashSet`, `RandomState`), `skill-names-state` (the fixtures' harness) and `skill-allows-unsafe` (a
   crate root without the `forbid`); `use std as` counts as reaching out. A name reached through a re-export or a
   macro gets past a scan of text.
   **The walk's fields (T9b A3).** A walker waiting for a link taken in turns sets field 41 on its own body,
   `[link, distance µm]`, and clears it with `[]`; the world shows field 42 (1) on such a link and field 43, the body
   its owning node lets in, both read with `read(link)`. The owner reads the marks as of the last tick and writes
   its grants; a walker never writes the link. **N10 and N9 (T9c #3127).** The world sets on a walker's body field
   44 (1: the shoulder turn, no body pushes it), field 45 (a new route, `[count, [[x, y, z] or [x, y, z, link],
   ...]]`, walked from its first leg: N10's reroute, or the way to a standing spot N9 granted) and field 46 (1: the
   world walks it out to legal ground, and the walk stands); it shows field 47 (1) on a body standing on its own
   granted spot. Ending a walk by name is the world's: it ends the run. A new run on a body starts without the marks
   of the run before it: fields 41, 44 and 45 go when it starts (#3168). A crossing is carried only from within 1 m
   of the link's near end (else `link-not-here`), and lands on a point the far surface's mover holds, moved onto it
   by less than a body's radius if need be (else `link-end-off-ground`); both are refused before the body moves.
9. **What survives a restart is the log.** Nodes and links survive, so a joint activity and a moving group do. A
   skill in progress is not stored: on a restart each active intent is handed to its skill again, or ended with a
   named reason (K13 builds it).

## The controller (B1)

The controller (`v2/crates/sim/src/controller`, B1 #2680) is the only way a body is moved or posed: it holds each
body's mover state and is the one caller of the mover. It also carries a body across a link along the link's line
(T9b #3120, `sim::host::carry`), and answers a dry run (what one step would do to a copy, moving nothing) for the
world's geometry answers. By its own rule, with no driver, it carries a body found on illegal ground to the nearest
legal point (N10's walk-out, T9c #3127). Skills run on its bodies through `sim::host::Runner`, a tick at a time; N7's
`Crowd` is retired (T9c). A driver is a claim
made by rule 4's rules, so a second driver asking for a held resource is refused by name and the first driver's input
stands. A driver is a skill, its staged inputs handed on by `sim::host::hand_on` under its run's driver, or a script
(`v2/tools/body-script`). One input type serves every family: velocity and mode (T4), facing and stance, set only by
the driver holding all the body's locomotion, and one move per resource, set by that resource's driver; anything else
is `resource-not-held` or `resource-missing`. An unheld resource gets the neutral input (still, hands down, facing
kept), which never moves a body. An input is logged only when it changes.

Gaze and voice (B11 #2742). Where a body looks is part of its input (a node, a point or ahead, record field 8), set
by the driver holding its gaze and logged when it changes. Its voice carries one utterance at a time: a new one
replaces the one under way or waits behind it, by the intent's `replace`, and lasts its length from its words, one
timer. The world writes each as `souls:said {1: {21: words}, 2: reach mm, 3: [hearer, ...], 4: length µs}` in an
entry whose audience says who may read it ([audience.md](audience.md) rule 4, `replica::speech`). Its hearers are
resolved when it is written and recorded (`sim::speech`): for ordinary talk, the Souls whose interest set (R4) holds
the speaker, found from the bodies within the set's leave distance, never a scan. So a body walks, carries and talks
at once, each under its own driver.

## Moves (B2)

A move (`v2/crates/replica/src/moves.rs`, B2 #2681) is data: its claims, blocks and cancels in rule 2 to 4's terms,
named phases in µs (a phase includes its start and excludes its end; contact is the instant the first phase ends), an
effector (the body, the resource it holds, or a named point of the thing held), a reach in µm (at most 700 mm) and a
contact point by name. Fixtures: `v2/crates/replica/fixtures/moves/`. `v2/crates/sim/src/moves` runs it: the reach is
asked of the geometry first (`out-of-reach` with the distance), the claim is a controller driver with the move set on
each resource it holds, and each phase end is one timer in K9's due list. Nothing polls; a later claim that takes the
move's resources cancels it at its next phase end (`claim-taken`).

## The code hatch, shape only

10. **The hatch is one pure function named by the hash of its module** (SA-F9, #3000): `{1: module (its SHA-256
    multihash), 2: [read, ...], 3: steps most, 4: answers, 5: why}`. Reads are declared, whole values only: a field
    of the thing `{1: 1, 2: field}` or an argument of the form `{1: 2, 2: name}`; it reads nothing else. It answers a
    verdict `{1: 1}` or one field's new value `{1: 2, 2: field}`. Its steps are 1 to 1,000,000, counted by F8's own
    meter, never a runtime's. `why` is its text key. Refusals: `hatch-not-a-record` (unknown fields included),
    `hatch-module-not-hash`, `hatch-reads-nothing`, `hatch-steps-out-of-range`. One read is the engine's floor; SA-F9's
    gate asks for two, against hatches that bypass the closed lists. It sits on a form (`forms.<name>.hatch`), inside
    the kind's hash.
11. **No scripting language is embedded.** F8 will run a hatch in one WASM interpreter inside `replica`, with no
    imports, so the client and the server give the same answer. That is an interpreter of a pure function, not a
    language a world is written in.

**Step 0.** A throwaway skill crate depending on `replica` alone, naming `sim::walk::Walker`, does not compile:
`error[E0433]: failed to resolve: use of unresolved module or unlinked crate 'sim'`. The same crate using only
`replica` compiles. The boundary is a wall.

## What would quietly break this

- **A body plan in the engine** (legs, two hands, gaze, voice). Four-legged, handless or many-armed bodies need a
  rewrite.
- **A skill that names a limb.** It runs on one family only.
- **An end that does not release.** A cancelled walk keeps the legs, and the body is stuck.
- **A skill inside `sim`, or a `pub(crate)` door.** Inside one crate a later `pub(crate)` reopens state silently; a
  crate boundary cannot.
- **A pointer's address in a skill** (`&x as *const u8 as usize`). It differs from run to run; no scan sees it.
- **A static, a thread-local or a clock in a skill.** Two runs of one log would differ; the scan catches the ones the
  compiler allows.
- **A skill's progress stored as state.** A restart would resume a half-step against a changed world.
- **A hatch that reads what it did not declare, or is metered by its runtime's own count.** Clients and the server
  would answer differently.
- **A hatch named by a name rather than a hash.** A changed module would change history.
- **A trusted value a skill can make up** (a claim, a grant). The host must make those; a skill only asks.
