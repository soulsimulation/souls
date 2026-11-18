# Lanes G and W: building worlds; the web app, accounts and the directory

Draft, local only, 16 Nov 2026; final pass applied 17 Nov. Written to `v2/docs/tranche/FORMAT.md`. The trunk
contracts (`v2/docs/TRUNK.md`, cited as T1 to T11) are fixed. Seventeen tasks: G1 to G9 and W1 to W8. This file
is the two lanes' shared notes: a lane opens it at `v2/docs/tranche/G-W-worlds-and-web.md` (K15 puts it there).

## Changes at the final pass

Applied from `FINAL-AUDIT.md`, the three audit reports and rules 11 to 18 of the format. IDs, titles, stages,
kinds and ceilings are unchanged. Main purposes are unchanged except G9's ("fresh ids" became "a new id
scope", as ruled).

**In every task**

- An `**Acceptance.**` checklist of at most five boxes ends the task (rule 11). G8 is a gate and carries the
  four gate boxes, with the bars named in the first.
- Step 0 says which result means "stop and hand back" (rule 12). G6 and W2 had none.
- Every citation of the local `TRUNK.md` or "the settled table" is now `v2/docs/TRUNK.md`, "Settled at
  reconciliation", or the settled fact itself. Today's files are cited by full repository path
  (`god/store.ts` is `apps/server/src/god/store.ts`, `worlds.md` is `docs/architecture/worlds.md`, and so on).
- Touches name modules, not whole crates (rule 17). The module names under `v2/` are proposals for folders that
  do not exist yet; a lane may rename one and say so under "Deviations". "(proposed)" is dropped from
  `v2/crates/directoryd` and `v2/crates/assets`: each is a new crate, made by the first task that touches it.
- The lines "Amended at the final audit" that closed twelve tasks and two preamble blocks are moved out of the
  task bodies into the table at the end of this section; what they said is in the tasks' own fields.
- No label in this file collided with a task ID or a bar; none was renamed.

**By task**

| Task | Change |
|---|---|
| G1 | The "three views" bar names its views (a replica, the viewer's stream, the archive) and says they are tested at the view tier, on what R3 emits; V1's parts and V3's bundles are not waited for. The actor of an edit is the creator. Two boxes come from the design and a footgun (who and size; staleness judged per touched node) |
| G2 | Paths; Touches narrowed to one module for the one function |
| G3 | Touches say which two modules of `v2/crates/sim` it enters (N3's ground, N7's walk skill) |
| G4 | Step 0 cites `v2/docs/TRUNK.md`. A box asks for the stated bound on kept before-values |
| G5 | Paths. The landform's expansion is its own module under the creator's client, since G7 is not a dependency |
| G6 | Keeps the place where a classifier could hold an upload, with none plugged in (allow, hold or reject; a classifier that fails holds). Gives a creator a way to upload a file and place it: one upload call and one kind whose picture is a model reference, placed through G1's gate. Depends on gains **G1**. Step 0 has a hand-back. An order of work with a hand-back point at 2.5 h, because the ceiling stays 3 h |
| G7 | The creator's scope in W2's approval is named in Touches (the earlier amendment gave it to this task) |
| G8 | The bars are declared in a comment on the issue, not in the pull request; the table goes on the task's issue. The machine is the one the coordinator names for gates, by neutral label. Acceptance is the four gate boxes |
| G9 | Main purpose says "a new id scope": ids that existed before the fork keep their ids; new things get the fork's scope. A fork carries no bodies, and what they held is set down where they stood (ruling) |
| W1 | Adds a sign-in for local and test worlds that is refused on any public address, as today; the win 3 gate (R11) needs it. The account store stays one small database file with one owning program; its backup off the machine is O20's, and this task gives O20 a consistent copy to take. Accounts are imported by X11, not X6. If `v2/web` does not exist yet, this task makes the smallest project there |
| W2 | Step 0 has a hand-back. The owner in the proof signs in with W1's sign-in for test worlds |
| W3 | The reference laptop is stated in the task. Touches narrowed |
| W4 | States the rule on text: stored by reference; a view may carry it inline for the audience entitled to it; the archive never does. Ordinary speech is public with a short reach; a whisper has an audience of one (ruling) |
| W5 | The session exchange shared with V13 is named in Touches |
| W6 | Touches gain the account store's module, since a bookmark is saved there, and one line in O20's list of stores. The fifth box asks for the stated cost of a year's lookup |
| W7 | States the same rule on text, and so which places hold words (views that carry them inline) and which never do (the archive, V1's parts). Backups of the removal list and stored text are O20's, and the list gains its line in O20's list of stores |
| W8 | A world's record carries where it runs, its epoch, when it must wake and its pinned build; a Soul's record says which one world it is in. The calls gain "set a world's pinned build". The directory's truth stays a few small objects in the object store written conditionally, with a cached copy on each machine (already rewritten at the consistency audit) |

**Could not resolve**

1. **Two crates are still not in the format's folder table:** `v2/crates/directoryd` (accounts, pairing, the
   directory, removal) and `v2/crates/assets` (uploads). Seven tasks here name them. The coordinator names
   them; until then they stand as written.
2. **G6 now holds three things in 3 h:** the check, the hold point, and upload-and-place. The ceiling is the
   coordinator's, so it is unchanged, and the task hands upload-and-place back if the first two take 2.5 h.
   A fourth hour, or a split, may be wanted.
3. **No task builds the text store** that W4 and W7 read through (the consistency audit's question 11; no
   ruling in `FINAL-AUDIT.md`; `tasks/P-product-whole.md` lists it as open too). W7 builds the removal list. W7's Step 0 hands back if a place holding words can be neither rebuilt nor
   purged, which a missing store would trigger.
4. **Handing a world to someone else, and archiving one,** have no task (`FINAL-AUDIT.md`, "For Gene", point 4).
5. **G8 names V14's clip** but does not list V14 in its header. V14 is win 1, so it exists by stage 2; the
   header is left as it was.

**Amendments made earlier in the final audit, moved here from the task bodies**

| Task | What was amended |
|---|---|
| Preamble | Both tensions with the trunk are marked settled, and the three uncovered pages are marked as W9's. An audience was "the set of people"; it is the id of a set of principals (T8), and principals are Souls and roles, never accounts |
| G1 | Depends on gained R3, because the outcome and the proof test three views and the view tier is what builds a view. The actor of an edit's effects is the creator |
| G2 | The callers name E4 and E16, so the way-out check is written once. "Held thing linked to a body" became a child of the hand's slot. "In use" covers a body resting where there is no seat (E3). The crate case is tested through the function, because the set-down is built later, in E4 |
| G3 | A body may stay in a doorway or on a stair (E3), so "finishes crossing" is limited to walkers. The rebuild is the one path for any change of ground, because E4 and E16 change ground outside a creator's batch |
| G4 | Step 0 asked a question since answered (a removed thing returns under its own id); it now checks the page |
| G5 | The weather field and its effect are E6's; this task sets it. Depends on gained E6 |
| G7 | Depends on gained R8, because `check` is R8's local checking. The creator-scope approval is this task's to add to W2's flow |
| G9 | "Fresh ids" was read as "a fresh id scope" (now in the main purpose). Depends on gained O1 and V1, because the outcome starts a world's process and waits for its first served part |
| W1 | The outcome named a pairing and a new world, which W2 and G9 build later; what the scan can cover at this stage is stated |
| W3 | "The creator's panel offered" is an entry point; the panel is W5. The list reads the directory's cached copy |
| W4 | Step 0 states what was settled about text in views, and counts V1's text files as part of the stream. Depends on gained V6. Speech has an audience and a reach (E13), set where it is written |
| W5 | The exchange of a signed-in session for a gateway token is one piece built once, shared with V13 |
| W8 | The store was one SQLite file on one host. It is now a few small objects in the object store, written conditionally, with a cached copy on each machine and no extra database. Step 0 gained a test of the store's conditional write |

## Changes made when the lanes were written

Against the first plan of the lanes. Kept as a record.

| Task | Change | Reason |
|---|---|---|
| G1 | Depends: add I4, K3. Outcome sharpened | An edit enters as an intent and is answered by I4's receipt; a placed thing names a kind by hash. Both finish in win 2, so nothing waits |
| G2 | Depends: add G3. Outcome names four refusal cases | "Cut off" is judged on the ground the edit would leave, which G3 builds. One build per edit, not two |
| G3 | Depends: add N7. Outcome defines "stale ground" | The walk skill is what re-routes. Stale ground is now countable |
| G4 | Outcome sharpened to equal content hashes | "In the log" alone does not show an undo restored anything |
| G5 | Depends: add G2. Outcome adds water, weather and a refusal | Ground must not change under a Soul; the listed outcome measured terrain only |
| G6 | Ceiling 2 to 3. Depends: add T8 | Stripping private data and bounding decode are part of safety; uploads are stored by reference and can be removed (T8) |
| G7 | Depends: add W2, R7. Outcome sharpened | A fresh agent must pair, and uses the thin command |
| G8 | Depends: add G2. Outcome adds three edits that must be refused | "Nobody stuck" under edits is only meaningful with the refusal rule on |
| W1 | Outcome adds "no call to the provider per request" | It was implied; now measured |
| W2 | Depends: add R6 | "The token goes to the daemon" cannot be shown without the daemon |
| W3 | Depends: add W1, V5 | A signed-in person, and a page to be "in" |
| W4 | Outcome sharpened to zero added requests at 1,000 Souls | "One subscription, not a request" made countable |
| W5 | Depends: add W1 | Only the world's creator may open the panel |
| W6 | Depends: add V9, W1. Outcome bounded to a week and one second | A bookmark is V9's link, saved to an account |
| W7 | Depends: add V15, W1 | The outcome names video; removal needs to know who asks |
| W8 | Outcome adds a paused writer that returns, and a directory that is down | Two fresh processes is the easy case; the stale one is the real one |

**Two questions the trunk has since settled** (`v2/docs/TRUNK.md`, "Settled at reconciliation").

1. T8 stores all free text by reference. W4 needs speech on screen with no request per sentence, and W7 needs
   it gone within a minute. Settled: all free text, whoever wrote it, is by reference; a view may carry text
   inline for the audience entitled to it; the archive never does.
2. T3 says an id is never reused. G4's undo of a removal wants the removed thing back under its own id.
   Settled: undoing a removal brings back the same thing with its id; an id is never given to a different
   thing.

**What these seventeen tasks do not cover, and where it went.**

- The owner's account page (my Souls, my paired devices, revoke, move): W9 and W11.
- A world's settings (name, who may enter, off the list): W9. Handing a world on and archiving one: no task.
- The buttons that hide an upload or a whole world: W9. G6 records the state.
- An owner writing to their Soul, a creator to their agent, from the page: W10.
- The visitor counter's privacy rules (`AGENTS.md`, "Visitor analytics") in `v2/web`: O19.
- X8 deletes today's server. It keeps `packages/world-compiler`, `packages/generators` and `packages/ground`,
  which G5 and G7 call as tools.

No listed task should be removed.

## Read this before any task here

**Words.** The **creator** is the one account that may edit a world; today's code and documents say "god".
There is exactly one per world and there are no co-builders. A **batch** is a list of edit operations that
commit together or not at all. An **effect** is one recorded change in a world's log (T6). An **audience** is
the id of a set of principals who may see a field, never a fixed list; a **principal** is one member of such a
set, a Soul or a role, never an account (T8). An **epoch** is a number that rises each time a world's writer
changes (T11). The **copy** is a client's replica of the world. A **node** is one entry in the world tree (a
room, a thing, a slot). A **view** is anything rebuilt from the log: the viewer stream, history, a copy (T7).

**What exists today, and what becomes of it.** Read main with `git show origin/main:<path>`.

| Today | Where | In these tasks |
|---|---|---|
| The batch compiler: `plan()` returns a diff and its inverse, or failures with code, field and fix | `packages/world-compiler/src/compile.ts` (depends only on `generators`, `ground`, `zod`) | A tool, called from `v2/client` and `v2/tools`; never from `v2/crates` |
| Parametric kinds and terrain maths | `packages/generators`, `packages/ground` | A tool |
| The commit, the edit journal with inverses, the undo stack | `apps/server/src/god/store.ts`, `apps/server/src/god/god.ts` | Specification only; rewritten on the log |
| The safety rule: `body.in-the-way`, `body.in-use`, `body.sealed-in`, `body.protected` | `apps/server/src/god/engine-bridge.ts` (`legalCheck`), `apps/server/src/god/seal-check.ts`, `AGENTS.md` (BUILDSAFE) | The rule is kept; the code is rewritten |
| The upload gate, its numbers and the classifier hook | `apps/server/src/moderation/validate.ts`, `apps/server/src/moderation/classifier.ts`, `apps/server/src/god/assets.ts`, `packages/generators/src/creation-limits.ts` | Specification and defaults; rewritten |
| Session checks and the account registry | `apps/server/src/auth.ts`, `docs/operations/auth.md` | Specification; rewritten |
| Templates, world creation, account limits | `worlds/templates/*.json`, `tools/world-launcher`, `docs/architecture/worlds.md` | Inputs and specification |
| The creator's command and skill | `tools/god-skill`, `docs/architecture/godmode.md` | Specification for verbs and refusals; rewritten thin |

**Rules that hold in every task here.** One creator per world. An edit that would bury or cut off a Soul is
refused, never repaired afterwards, and no Soul is moved to make room. World time never stops: no edit pauses
the clock and nothing sets the time of day. No account id enters a log.

---

## Lane G · Building worlds
