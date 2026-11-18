# Engine v2 · Lane K · The core (K1 to K14, K16)

Draft, local only, 16 to 17 Nov 2026. Task bodies in the shape of the tranche's format rules, which a
developer reads at `v2/docs/tranche/FORMAT.md`; the rules every developer keeps are there and are not
repeated. The trunk contracts in `v2/docs/TRUNK.md` are fixed: where any older text and the trunk disagree,
the trunk wins. This file is published as `v2/docs/tranche/K-core.md` (K15 puts all three there). K15 itself
is written in another file and comes before K1.

## Changes at the final pass

Applied on 17 Nov from the final audit and the planner's rulings. Every task keeps its ID and main purpose.

**In every task**

| Change | Why |
|---|---|
| `**Acceptance.**` added at the end, at most five boxes, each from the Outcome and Proof | Format rule 11 |
| Step 0 names the result that means "stop and hand back" | Format rule 12 |
| Citations of the local plan folder, of numbered sections of the design document and of "change 1" replaced by repository paths (`v2/docs/TRUNK.md`, a contract's page under `v2/docs/`, `v2/docs/tranche/K-core.md`), or the fact is restated in the task | Format rule 16 |
| "Fact N" and "source N" are restated in the task with their link, and still point at `v2/docs/tranche/K-core.md` | Each issue must stand without the preamble |
| Touches narrowed to modules and files; `clippy.toml` is `v2/clippy.toml`; benches are named | Format rule 17; a lint file at the repository root is an unmapped path (process audit) |
| A measured task's Proof says the run is declared in an issue comment first, with two repeats | Format rules 8 and 13 |
| The "Amended at the final audit" line under a task is moved to "History" below | So that each task ends with its Acceptance |

**By task**

| Task | Change | Why |
|---|---|---|
| K1 | Depends on **K15**. Step 0 no longer describes one machine's software, and hands back if K15 is not on main. The `v2` CI job, its scope entry and the cargo cache are K15's (as K15 is written in the product-whole task file): K1 replaces K15's seed crate and adds its steps to `v2/tools/ci.sh`, which later tasks extend; `ci.yml` is not edited. The workspace takes every folder under `v2/crates` and `v2/tools`. Lint and toolchain files live under `v2/`. `v2/` packages stay out of the root pnpm workspace. One box says the pull request stays inside `v2/` | Planner's ruling (K15 first); process audit, "Fix in place" and section 2 |
| K2 | Hand-back point at hour 3. The hash-map order fact restated | Ruling on ceilings of 4 h |
| K3 | The hash is of the encoding profile's bytes (T0), not "T6's encoding". One more section a kind may gain later: how long a loose thing of the kind lasts. A box for a missing or bad kind | T0 split; ruling on things set down |
| K4 | Step 0 hands back over 10 ms. Order of work and a hand-back point. The three database sources and the sync rules restated. K16 named as a user of the storage interface. A box for "never retry a failed sync" | Format rule 12; ruling on ceilings |
| K5 | **Checkpoints are taken by amount of log**, said in the Outcome with a measure: the restart bar also holds after ten intervals. Restart restores what is in the log and leaves active intents to K13. A box for the state hash across a restart. Hand-back point | Brief; trunk contract T11; ruling on restart |
| K6 | **A fork carries no bodies, and what they held or wore is set down where they stood**, as effects at the head of the fork's log; Outcome and a box say so | Ruling on things held when a Soul is left out of a fork |
| K7 | Lint file path; the test's own restarter named in Touches; boxes | Process audit |
| K8 | Step 0 hands back if N15's scene does not load | Format rule 12 |
| K9 | Step 0 names the two pages it reads; a box for a rate change inside the gap | Format rule 16; its own footgun |
| K10 | Boxes only | |
| K11 | Five boxes: the first two are the auditor, the last three are the unit wrapper, marked as the half to hand back if either half will pass 2 hours | Process audit (two outcomes, six clauses) |
| K12 | "Why it exists" states the reason itself where it cited a design section. Step 0 hands back, or writes a seeded input script, when nothing can make a recording. A comparison tool is named in Touches | Format rules 12, 16, 17 |
| K13 | **No longer "enabling".** The bar is a named run (N15's even arm, two minutes, two repeats before and after) judged against the spread of the repeats. **It owns handing each active intent back to its skill after a restart, or ending it by name.** Depends on gains **K5**. Order of work and a hand-back point. "Set and cancel timers" corrected to T9's list | Process audit; planner's ruling on restart |
| K14 | **The float check covers all of the shared library by default**, so the selectors (E2) and the form rules (R2) are covered when they land; two seeded fixtures stand for them. A sixth seeded violation: a file outside `v2/` importing from it. Steps go into `v2/tools/ci.sh`. Four boxes | Brief; process audit (the reverse check; six clauses; `ci.yml` edits) |
| **K16 (new)** | **The text store**, win 2, 3 h, depends on T8 and K4 | Consistency audit question 11: I4, K12, B11, V1, W4, W7, F11 and E11 use a store that no task built |

**Could not resolve**

1. **K13 now holds two things in 4 h** (the wall with the walk skill moved, and the restart hand-back). It
   has a hand-back point at hour 3 that returns the restart half as a 2 h task. Real intents and their
   deadlines arrive with I4; K13 tests with a walk order written to the log by the test.
2. **K14's reverse check must run when only files outside `v2/` change,** and the `v2` job does not run
   then. The task adds one rule to `.github/scripts/guards.mjs` if that is small, and hands it back
   otherwise. K15 as written does not carry that rule; it could, and K14 would then only seed the violation.
3. **K16 and G6 both store uploads.** K16 keeps bytes under a minted reference; G6 (stage 2) names assets by
   content hash. K16's record can point at a content hash, so G6 can use it; G6's text was not changed.
4. **K16's "absent from every view" is proved on T7's and T8's fixture views.** The real view tier (R3) is
   win 3; W7 proves it end to end.
5. **K1 is written against K15 as it stood in the product-whole task file on 17 Nov** (K15 owns the `v2` job,
   the scope entry, a seed crate and `v2/tools/ci.sh`). If K15 changes, K1's Step 0 and Touches must follow.
6. **Nothing was run.** Every number is a bar to be measured.

## History (for the planner; no task needs it)

**Changes made when the lane was first written, against the first outline**

| # | Task | Change | Reason |
|---|---|---|---|
| 1 | K13, N7 | The stage order was impossible as listed: N7 (win 1) depended on K13, which is win 2. Settled: K13 is removed from N7's dependencies; N7 writes the walk skill against a small private interface; K13 then moves it behind the real one | A cycle between stages |
| 2 | K13 | Outcome gains a bar on N15's tick numbers after the move; a skill that reaches past the interface does not compile | "Enabling" hid a real regression risk |
| 3 | K4 | Outcome gains 50 simulated power cuts, and "damage before the tail is named, never trimmed" | Killing a process loses nothing the operating system already holds, so kills alone do not test the sync |
| 4 | K5 | Depends on: add **K2**. Fixture is N1's import. Checkpoints are triggered by amount of log (trunk contract T11), not "every few minutes"; public and private state hashed apart (T3) | Missing dependency; an older text behind the trunk |
| 5 | K6 | "Fresh ids" restated as "a new lineage and minting scope; carried ids unchanged; no bodies carried" | T3; renumbering would break references and hash sharing |
| 6 | K7 | The 2 s is measured from the stall to the new process's first tick on a small world; loading state is K5's 2 s. "Never reads the wall" means the date-and-time clock is read once at start and recorded as a T5 effect | Two bars were being added together; a world must still know the date to catch up |
| 7 | K8 | Depends on: add **K7**. State the core count | The bar is a tick percentile; eight readers on eight cores measures the machine |
| 8 | K9 | Depends on: add **K2**. Outcome states how many timers fire | Timers belong to nodes; "idle" with no number is unmeasurable |
| 9 | K10 | Depends on: add **K7**. Adds the uneven arm (200 in one second) and "every join completes, none refused" | Format rules 8 and 10 |
| 10 | K11 | The six faults are named. Two outcomes in one task | Measurable; honest about size |
| 11 | K12 | Depends on: add **K5**. Three separate processes | "From one checkpoint"; in-process repeats hide the commonest causes |
| 12 | K14 | Outcome restated as seeded violations that each fail by name | No static check proves the rule for all code |
| 13 | K2 | The tree container goes in `replica`, used by `sim` | R1 must apply the same effects to the same structure; two trees would drift |
| 14 | K13 | A crate `v2/crates/skills` | The compiler's crate boundary is the firmest wall |
| 15 | K1 | "Under 6 minutes" is pinned to the v2 CI job with a warm cache, with the cold time posted; the load test compares one value natively, in Node and in a browser | The bar did not say where or from what state |
| 16 | K2 | "Constant time" restated as "does not change when the world is ten times larger"; memory is what the allocator counted | Measurable as written |
| 17 | K3 | Outcome gains: a search of the source finds none of the three names; a fourth kind loads at run time; the hash moves with meaning and not with file layout | "No code names them" needed a test |

**Owners of three small things with no task of their own:** the fake disk and fake time that the fault
simulation (O5) needs are built as the storage interface in K4 and the time interface in K7. The world's
random source is in K12's design; whoever needs it first takes it as a 30-minute prerequisite (format
rule 6). "Decode before publish" is carried by V1.

**Amended at the final audit, before this pass** (each was a line under its task)

| Task | Amendment |
|---|---|
| K3 | One footgun: a kind has more than three sections coming (E18, E19, E21) and does not belong only to things |
| K8, K10 | Depends on gains N15, whose scripted scene their outcomes are measured on |
| K12 | One footgun: an input that carries words is recorded with their reference only |
| K13 | Depends on gains N7 and N15 |

## Words used in this lane

A **tick** is one step of the world clock; the **clock thread** is the only thread that changes a world. An
**effect** is one recorded change. To **sync** is to ask the operating system to put written bytes on the disk
itself (`fsync`, `fdatasync`). A **torn write** is one only partly on disk when power was lost. A **checksum**
is a short number computed from bytes that changes if they do. A **checkpoint** is the whole world written out
at one moment. A **crate** is a Rust package. A **lint** is a rule the build checks. A **panic** is Rust's
unexpected failure; it normally **unwinds** (backs out of) its thread, and can instead **abort** the process.
The **99th percentile** is the value 99 ticks in 100 stay under. A **monotonic clock** only counts upward; the
**wall clock** is date and time, and can jump. A **fixed-point** number is a whole number of a stated small
unit (millimetres, microseconds). A **generation count** is bumped each time a slot in an array is reused, so
an old handle to it is recognised as stale. **CRC-32C** is a common checksum that processors compute quickly.
A **root record** is the small file that names a checkpoint's top hashes. **Posted** means shown in the pull
request. **Both builds** means the native build and the WASM build of `replica`.

## Checked facts (16 Nov), cited from the tasks as `v2/docs/tranche/K-core.md`, fact N

1. **SQLite** appends to a log, syncs it per commit in its safe mode, and copies it back when it reaches 1,000
   pages; each record's checksum is chained from the one before and "salted" per log generation so stale
   records never look valid. <https://www.sqlite.org/wal.html>, <https://www.sqlite.org/fileformat2.html#walformat>
2. **LMDB** keeps no log: it never overwrites live pages and alternates two root pages, so there is nothing to
   recover. <http://www.lmdb.tech/doc/>
3. **TigerBeetle** replays its log from the last checkpoint, keeps several copies of its root record, and tells
   a torn tail from damage in the middle (the last from its design notes).
   <https://docs.tigerbeetle.com/concepts/safety/>, <https://docs.tigerbeetle.com/about/internals/data_file>
4. **Redis** syncs its append-only file every second by default; "always" is one write and one sync per batch
   (group commit). It loads a file cut at the end and refuses one damaged in the middle. Snapshots restart
   faster than a long log. <https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/>
5. **Deterministic simulation.** TigerBeetle keeps its logic single-threaded with disk, network and time
   replaced by seeded fakes; FoundationDB ends each run by drawing one more random number and comparing it
   across two runs. <https://docs.tigerbeetle.com/about/vopr>, <https://pierrez.github.io/fdb-book/meet_fdb/correctess.html>
6. **Order.** Rust's `HashMap` is seeded at random, so its order differs in every process. Any order that
   reaches an effect or a hash must be defined (insertion order, or sorted by id).
   <https://doc.rust-lang.org/std/collections/struct.HashMap.html>
7. **Fractional numbers ("floats").** Plain arithmetic repeats on one build and one kind of machine. Functions
   such as sine differ between maths libraries, sums done in parallel change with scheduling, and
   not-a-number bit patterns are unspecified. Stored and checked values are fixed-point whole numbers (T6).
   <https://rust-lang.github.io/rfcs/3514-float-semantics.html>, <https://rapier.rs/docs/user_guides/rust/determinism/>
8. **Sync.** `fdatasync` covers a file's changed size; a new or renamed file also needs its directory synced; a
   drive's own cache can still lie. On macOS only `F_FULLFSYNC` reaches the disk, slowly, so disk numbers are
   measured on Linux. <https://man7.org/linux/man-pages/man2/fsync.2.html>

**Not verified, so measured or checked by the task that relies on it.** How well `wasm-pack` is kept up since
its move, and (from a primary page) that WASM builds abort on a panic by default (K1). Build times for this
workspace: no published figure transfers (K1). Whether Clippy's `disallowed-types` accepts built-in number
types (K14). Any benchmark of snapshot publishing at 10,000 nodes, or of an entity-component crate against
plain arrays at 1,000 bodies: none found at this size (K2, K8). Sync latency on the production disk, which is
not written down (K4, K16; O14). TigerBeetle's torn-tail rule is from a mirror of its design notes; LMDB's two
root pages from its header documentation and secondary explanations.

---
