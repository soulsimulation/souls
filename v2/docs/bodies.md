# Bodies, skills, the host and the hatch

Engine v2 T9 (#2663), contract T9 in [TRUNK.md](TRUNK.md). It fixes what a body is (declared resources), what a skill
is (a claim on them), the one interface a skill touches the world through, and the code hatch's shape. Code:
`v2/crates/replica/src/bodies.rs` and `host.rs`; the built-in skills in `v2/crates/skills`. Fixtures:
`v2/crates/replica/fixtures/bodies/`. Checks: `crates/replica/tests/bodies.rs` and `crates/skills/tests/`. Moving
the real walk behind the interface and handing intents back after a restart (K13), the controller (B1) and running a
hatch (F8) are not here.

## Bodies and skills

1. **A body's family declares its resources:** each a name and a class from a closed list, 1 locomotion,
   2 manipulator, 3 gaze, 4 voice (a class added later takes the next number). A family is `{1: name, 2: [{1: name,
   2: class}, ...]}`; two resources of one name are refused (`resource-duplicate`). There is no fixed body plan: four
   legs and no hands, two of each, a beak.
2. **A skill claims classes or names, never anatomy:** every resource of a class (a walk takes all the legs), any
   one of a class (a carry takes one hand), or one by name (a family's own skill). So one walk runs unchanged on a
   dog and a person.
3. **A skill instance has its claims, what it blocks and what cancels it, and an end that always releases.** It
   blocks classes it does not hold (a sit blocks walking). It names the classes whose claim by a new skill cancels it
   (a new walk ends the old one). However it ends, done, cancelled, refused or failed, it releases all it holds.
4. **Starting is all or none, and every refusal has a name:** `resource-missing` (the family has none),
   `resource-held` (another skill holds it and is not cancelled by its class), `resource-blocked`,
   `instance-duplicate`. Several skills run at once on one body when their claims do not meet.
5. **A joint activity claims on several bodies, all or none.** A refusal on one body names it and changes no body.
   The activity is a node with one owner (T1), so it survives a restart.
6. **Reach is measured from an effector, which may be a held tool.** A held thing is a child of the hand's slot
   ([world-model.md](world-model.md) rule 2), so it moves with the hand and lengthens it (B12).

## The host and the wall

7. **A skill touches the world through one trait, `Host`, in `replica`:** world time (T5; never a machine's clock),
   its body, reading nodes (its body as of this tick, every other node as of the previous tick, T1), a closed list of
   geometry questions answered in integers, timers on its body, draws from the world's random numbers, controller
   inputs (a velocity in three dimensions and a movement mode, T4), and generic changes to its own node (T6), any
   other refused as `write-outside-own`. A skill is a `Skill`: its shape and a step that returns going, done or
   failed with a name. The built-in skills use the same trait.
8. **The wall is a crate boundary, and a scan for what the compiler allows.** Built-in skills live in
   `v2/crates/skills`, which depends on `replica` alone (K14's dependency list holds it there) under
   `#![forbid(unsafe_code)]`. A skill crate that names `sim`'s state does not compile, and neither does one that uses
   `unsafe`. Safe Rust cannot refuse a `static`, a `thread_local!`, `extern crate std` or a clock, so the scan
   refuses them by name (`skill-reads-clock`, `skill-keeps-global`), with `skill-names-state` for the fixtures'
   harness and `skill-allows-unsafe` for a crate root without the `forbid`.
9. **What survives a restart is the log.** Nodes and links survive, so a joint activity and a moving group do. A
   skill in progress is not stored: on a restart each active intent is handed to its skill again, or ended with a
   named reason (K13 builds it).

## The code hatch, shape only

10. **The hatch is one pure function named by the hash of its module** (SA-F9, #3000): `{1: module (its SHA-256
    multihash), 2: [read, ...], 3: steps most, 4: answers, 5: why}`. Reads are declared, whole values only: a field
    of the thing `{1: 1, 2: field}` or an argument of the form `{1: 2, 2: name}`; it reads nothing else. It answers a
    verdict `{1: 1}` or one field's new value `{1: 2, 2: field}`. Its steps are at most 1,000,000, counted by F8's
    own meter, never a runtime's. `why` is its text key. Refusals: `hatch-not-a-record`, `hatch-module-not-hash`,
    `hatch-reads-nothing`, `hatch-steps-over-limit`. It sits on a form (`forms.<name>.hatch`), inside the kind's hash.
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
- **A static, a thread-local or a clock in a skill.** Two runs of one log would differ; the scan catches the ones the
  compiler allows.
- **A skill's progress stored as state.** A restart would resume a half-step against a changed world.
- **A hatch that reads what it did not declare, or is metered by its runtime's own count.** Clients and the server
  would answer differently.
- **A hatch named by a name rather than a hash.** A changed module would change history.
- **A trusted value a skill can make up** (a claim, a grant). The host must make those; a skill only asks.
