# Engine v2 tranche: how a task is written, and the rules every task carries

Draft, local only. Every task file under `tasks/` follows this. The rules below are stated once here and are
not repeated in each task.

## The rules every developer agent keeps

1. **The main purpose is the task.** Restate it in one line when you start, and check your work against it
   every hour and before any sub-step longer than 20 minutes. If most of your time or your diff is going into
   something the purpose does not name, stop that thing.
2. **Step 0 first.** Check the task's premise in 20 minutes or less, by running or reading what it names. If
   the premise is false, hand back with what you found.
3. **You may change how.** A listed other path, or your own, when the code or a measurement shows it is
   better and it reaches the same outcome within the same lane and ceiling. Write it in the pull request under
   "Deviations", with the evidence.
4. **You may not change what.** The purpose, the outcome and the ceiling belong to the coordinator. So do the
   trunk contracts in `TRUNK.md`: a task that needs one changed hands back and says why.
5. **You may close or park a task.** If you find it brings no benefit, duplicates another, or leads into a
   known bad pattern, say so with evidence and stop. That is a complete and valid outcome.
6. **No scope creep, no captive sub-goals.** A prerequisite you discover that is small (about 30 minutes or 50
   lines, same area) goes in the same pull request and is listed. Anything larger is handed back as a proposed
   task. An interesting side problem is a note in the pull request, not work.
7. **Hand back at once** when Step 0 fails, when the design does not fit and no other path does, when the
   expected effect will clearly not appear, or when you pass one and a half times your own estimate with the
   outcome not in sight. Say what you tried, the numbers, and one proposed rescope.
8. **Measure honestly.** Declare the bar before the run. Two repeats. Even and uneven load where load matters,
   using the shared load shapes. Never tune toward the expected number: a result far from it is a finding.
9. **A ceiling is a limit, not a target.** Stop when the outcome is met.
10. **Standing product rules:** minds stay at the edge; the world never chooses for a Soul beyond orders the
    agent wrote, with one exception kept on purpose (a body whose agent has been silent for an hour is wound
    down: task B16); world time never stops; no Soul or world is ever stuck; nothing teleports; no cap, queue or
    redirect meets a bar; today's engine is not modified by this tranche except where a task in lane S says so.

## Rules added at the final audit

11. **Acceptance is a checklist.** Every task ends with `**Acceptance.**` and at most five boxes (`- [ ] ...`),
    each one thing that can be shown true or false. The repository's proof check reads them. For a task with
    a measure, one box is the measure. For a gate the boxes are: the bars were declared in a comment before the
    run; the run was made as described; the table is posted; every missed bar has a proposed next task. A gate
    is finished when it is scored, whatever the score.
12. **Step 0 says when to hand back.** It names what to check and the result that means "stop and hand back".
13. **Proof before the cut-over.** Work under `v2/` is not in production. Its proof is the named tests passing,
    or a posted table from a run declared in an issue comment; an outcome that is watched adds a clip. The
    walk, bundle, conformance and remote gates do not apply to a change that touches only `v2/`. The
    publication check and the secret scanner always do. "Done" in the repository's sense is claimed only at
    the cut-over (X7).
14. **Trunk tasks** (kind `trunk`) get a reviewer's pass before they merge, and Gene signs the pages at T12.
15. **What a lane cannot do is not in its task.** A step that needs Gene (a purchase, a yes, production) is in
    the owner's checklist issue, and the task says which line it waits for.
16. **A task cites only what a lane can open:** paths in the repository. The trunk is `v2/docs/TRUNK.md`; these
    rules are `v2/docs/tranche/FORMAT.md`; each lane's shared notes are `v2/docs/tranche/<lane file>`. K15
    puts them there.
17. **Touches names modules or files,** not whole crates, where it can.
18. **Rule 10's exception:** X8 deletes today's engine and server; lane S changes today's engine.

## The shape of one task

```
### <ID> · <Title, as an outcome>

| Lane | Stage | Ceiling | Depends on | Kind |
|---|---|---|---|---|
| <letter> | <win 1..5, stage 2, stage 3> | <1..4 h> | <ids or none> | <trunk / build / gate / carried over> |

**Main purpose.** One sentence.

**Why it exists.** Which goal or claim it serves, and what depends on it.

**Outcome.** The measured thing that closes it. Or: "Enabling work, no measure. Done when: ...".

**Step 0.** What to check first, and when to hand back.

**Design (given).**
- ...

**Other paths you may take.**
- ...

**Footguns and risks.** Checked facts, with a source where there is one.
- ...

**Stays out.** The stretch that is not this task.

**Proof.** What the pull request shows.

**Touches.** Modules or files in the new tree.

**Acceptance.**
- [ ] ...   (at most five)
```

**Kind** says what sort of task it is: `trunk` (it fixes something hard to change later, so it gets an extra
review before it merges), `build`, `gate` (it demonstrates a hard goal or a performance curve and posts a
table), or `carried over` (from the Scaling tranche, on today's engine).

## Where the code lives

A new top-level folder `v2/` in this repository, with no import from today's server or engine:

| Folder | What |
|---|---|
| `v2/crates/replica` | The shared library: schema, encoding, applying effects, queries, form rules. Builds native and to WASM |
| `v2/crates/sim` | The world: tree, clock, controllers, movers, log. Native only |
| `v2/crates/skills` | Built-in skills, which reach the world only through the host interface |
| `v2/crates/worldd` | The world process |
| `v2/crates/gatewayd` | Agents' sockets |
| `v2/client` | The resident daemon and the thin command (TypeScript, loads `replica` as WASM) |
| `v2/web` | The new web app (TypeScript, three.js, loads `replica` as WASM) |
| `v2/tools` | Importers, the scripted driver, benches, the fault simulation |
| `v2/docs` | The trunk contracts, one page each |

Today's packages for world content (`packages/world-compiler`, `packages/generators`, `packages/ground`) may
be *called as tools* by importers; nothing in `v2/crates` depends on them.
