# Lane T · Trunk contracts: the task bodies (T0 to T12)

Draft, local only, 16 to 17 Nov 2026. Written to the tranche's format rules, which a developer reads at
`v2/docs/tranche/FORMAT.md`. The contracts' content is fixed by the trunk, `v2/docs/TRUNK.md`; these tasks fix
how each contract is written down and checked. This file is published as `v2/docs/tranche/T-trunk.md` (K15
puts all three there). Read the lane notes before any task.

## Changes at the final pass

Applied on 17 Nov from the final audit and the planner's rulings. Every task keeps its ID and main purpose.

**In every task**

| Change | Why |
|---|---|
| `**Acceptance.**` added at the end, at most five boxes, each from the Outcome and Proof | Format rule 11: the repository's proof check reads boxes |
| Step 0 names the result that means "stop and hand back" | Format rule 12. T5 had no hand-back and T12 had no Step 0 |
| "TRUNK", "`TRUNK.md`, settled", "lane note N" and "Slug" replaced by repository paths: `v2/docs/TRUNK.md`, `v2/docs/tranche/T-trunk.md`, and the task's own files spelled out | Format rule 16: a lane's checkout has no local plan folder |
| Touches lists the page, the source file, the test file, the fixture folder and the one `mod` line, in place of a slug | Format rule 17; the process audit could not check a slug |
| Proof says what the pull request shows, without pointing at a lane note | Same |
| Golden bytes are kept as hex text | The repository's path guard refuses a file with a zero byte and any `.bin` (process audit) |
| The "Amended at the final audit" line under each task is moved to "History" below | So that each task ends with its Acceptance |

**By task**

| Task | Change | Why |
|---|---|---|
| **T0 (new)** | **The encoding profile**, win 1, 2 h, trunk. Holds the profile (was lane note 3), the test vectors and three encoders that must agree: native, WASM, one JavaScript library | Planner's ruling: the encoding is split out of T3 |
| T1 | Two design lines: a joint activity is a node, so it survives a restart; a body that travels carries what its Soul owns and the leave is refused by name while it holds anything else. One acceptance box for that refusal | Rulings on restart and on things held when a Soul travels |
| T2 | No change of content | |
| T3 | Depends on **K1, T0**; ceiling back to **3 h**; the encoding profile, `encode.rs` and the CBOR library footguns moved to T0; Step 0 rewritten for ids and hashes; a refusal of circular kinds made a box; a fork carries no bodies and what they held is set down (K6) | The T0 split; ruling on forks |
| T4 | Step 0 gains a hand-back (no unit fits 64 bits) | Format rule 12 |
| T5 | Step 0 gains a hand-back. One design line: time a world could not run is owed and paid exactly | Format rule 12; ruling on a failed disk (O10) |
| T6 | Depends on gains **T0** (Step 0 hands back to T0, whose encoder it uses). Order of work and a hand-back point at hour 3. The actor for a creator driving a world's body is the creator. A box that no fixture holds free text or a float | T0 split; ruling on ceilings of 4 h; ruling on I12 |
| T7 to T12 | Stage is `trunk stop` (already so in the headers; the lane notes now say it) | Trunk, "Settled at reconciliation" |
| T8 | Ordinary speech has the public audience and a short reach; a whisper has an audience of one. The real store is K16's. A box for membership resolved when written | Ruling on speech; K16 added |
| T9 | Order of work and a hand-back point at hour 3. The hatch will be run by one WASM interpreter inside the shared library, which is not a scripting language. Nodes and links survive a restart; K13 hands intents back. The new crate needs no edit to a shared file | Rulings on ceilings, on F8 and on restart; process audit |
| T10 | Step 0 no longer cites the design document. Added: a queue may name the act taken at its head; a move inside an activity may name one of its next beats as a parameter; standing consent is the client's rule; a creator driving a world's body is the actor, with the creator's sequence; the build hash is the world's pinned build in its directory record | Rulings on B7, B8, consent, I12 and the pinned build |
| T11 | A world's directory record lists where it runs, its epoch, when it must wake and its pinned build, with a fixture and a box. "Cannot be undone" means travel between worlds and anything the owner names later; a swap has no stakes | Rulings on the pinned build and on stakes |
| T12 | Rewritten as the reading pack: what the owner is given to read (the pages, win 1's table and clip) and to decide. Signing moved to "Waits for the owner's checklist". Depends on **T0 to T11, N15**. Step 0 added. The README is built here from merged pull requests; no other task edits it. Decisions already settled or ruled are shown, not asked | Format rule 15; process audit (a lane cannot sign); the pack names N15's table and clip |

**Could not resolve**

1. **T0's header says K15 only, as instructed, but T0 writes into `v2/crates/replica`, which K1 creates.** Its
   Step 0 hands back if K1 has not merged. Adding K1 to T0's header removes the wasted dispatch; it adds no
   cycle. The planner's call.
2. **T12's "Depends on" now reads `T0 to T11, N15`.** If the dependency script cannot read a range that starts
   at T0, or the planner holds the stop by stage alone, put back `T1 to T11`.
3. **Which JavaScript CBOR library reproduces T0's vectors is not verified.** T0's Step 0 tests it first.
4. **The owner's checklist issue does not exist yet,** so T12 names the lines it waits for by their words,
   not by a number.
5. **T9 is still the tightest task in the lane** (a page, the host trait, a new crate, a compile wall, a scan
   and a toy skill in 4 h). It has a hand-back point; it was not split.
6. **The paths cited are the ones K15 commits, as K15 stood in the product-whole task file on 17 Nov:**
   `v2/docs/TRUNK.md`, `v2/docs/tranche/FORMAT.md` and `v2/docs/tranche/<lane file>`. If K15 changes them,
   the citations must follow.

## History (for the planner; no task needs it)

**Changes made when the lane was first written, against the first outline**

| Task | Change | Reason |
|---|---|---|
| T1 to T11 | Add **K1** to "Depends on" | Each puts types and a test in `v2/crates/replica`, which does not exist until K1; T3 to T6 also need K1's WASM build loading in Node |
| T3 | Outcome sharpened: the fork-then-visit-back case, counted hash cases, equal bytes in both builds | "Collide" was not measurable |
| T2 | Depends none → **T3**. Outcome adds a validity check with five named refusals | Nodes, links and kinds are named by T3's ids and kind names. "Fixtures express" alone cannot fail |
| T1 | Depends none → **T2, T3**. Outcome sharpened to an order test and three transfer cases | A zone is a subtree (T2); a transfer id is an id (T3). "Round-trips" was not measurable |
| T5 | Outcome names the rates (20, 30, 60) and the beat (the millionth at 130 a minute) | A beat at a tempo with a whole-microsecond period would pass by luck |
| T4 | Depends T2 → **T2, T5**. Outcome gains a stated tolerance and a drift bound | A track is a formula of world time; "keeps pose and velocity" needs a number |
| T6 | Depends T2, T3, T5 → **T2, T3, T4, T5**. Outcome: equal *bytes*, not only equal state; an unknown field survives | A motion sample carries T4's pose. Equal state can hide two byte forms, which breaks hashes |
| T7 | Outcome: "from the log alone" → from the log, the redaction list and the view's version; "equals the live one" → built in one pass equals built effect by effect; a bounded lowest level | T8 makes the redaction list an input. No live tier exists until R3. "Never dropped" is false without a bounded lowest level |
| T8 | Depends T6 → **T6, T7**. "A recorded hour" → a fixture log; removal also holds in a fork | Its outcome is stated over views; recorded hours arrive with K4 and V3 (W7 proves it end to end) |
| T9 | Depends T4 → **T1, T4**. "Does not compile" is kept for world state and `unsafe`; clocks and globals are caught by a scan. The hatch is shape only. Adds one folder, `v2/crates/skills` | "Read nodes" means T1's previous-tick copy. Rust cannot refuse a `static` at compile time. A compile-time boundary needs a crate |
| T10 | Outcome lists the intents by kind; the version refusal must be decodable by the old client | "Every kind" was open; a refusal the old client cannot read tells it nothing |
| T11 | Outcome: the *store* refuses a stale writer, a paused writer included; "undoable-never" reads "cannot be undone" | A writer checking its own epoch is not a guarantee (see its footguns) |

**Amended at the final audit, before this pass** (each was a line under its task)

| Task | Amendment |
|---|---|
| Preamble | Three flags against the trunk were open questions; each is settled in the trunk's table "Settled at reconciliation": T7 to T12 are a trunk stop between win 1 and win 2; all free text, whoever wrote it, is stored by reference; ids that existed before a fork keep their ids |
| T2 | One design line: a held thing is a child of the hand's slot; a shared load is a child of the carry activity's node with the carriers linked to it; a thing set down is a child of the place or the thing it rests on (E4) |
| T3 | The other path "rewriting every id on fork" removed; one design line for Souls being global, bodies not carried into a fork, and undo bringing back the same id |
| T4 | The pose line says what supports a hovering body: the surface below it, with a height |
| T6 | The envelope's "acting Soul" became an actor (a Soul, a creator, or the world); the header is written once per bundle and parts name it by hash |
| T7 | Levels and scope leave room for E1 (a world-wide index level; a scope that is the whole world or one named Soul); a view may carry text inline and the log never; Step 0 treats the redaction list as an opaque set of references until T8 exists |
| T8 | A view may carry text inline for the entitled audience while the archive never does; reach is not audience (E13) |
| T9 | The restart rule: a skill in progress is not stored; each active intent is handed to its skill again or ended by name |
| T10 | The fourth order is standing in a queue, not "wait for"; the envelope has no start time or condition; a target may be a selector (E2); orders survive a restart; plans are the client's; words in an intent are logged by reference |
| T11 | Where the directory's truth lives: conditional objects in the object store, a cached copy on each machine, no database |
| T12 | Three decisions marked as already settled; decision 4 names the four orders; no win 2 code starts before the pages are read |

**Not verified (each is covered by a Step 0 or a test):** whether minicbor and cbor4ii write every integer in
its shortest form (their docs do not say); whether any pair of CBOR libraries agrees byte for byte on real
records (not run; T0's vectors are the test); which ciborium release carries its canonical helpers (merged
June 2025; docs.rs shows 0.2.2); which JavaScript CBOR library can be made to emit the profile's bytes;
conditional writes on S3-compatible stores other than S3 and R2; the stack size a browser gives WASM.

## Lane notes (published as `v2/docs/tranche/T-trunk.md`; each task says where it relies on one)

1. **What a trunk task delivers, and no more:** one page in `v2/docs` (numbered rules, about 600 words,
   ending with a list "What would quietly break this"); the types in `v2/crates/replica` (written `replica`
   below); fixtures with a test. No runtime and no speed work: lanes K, N, B, I and R build those on the page.
   Each task's Touches names its files. **Proof** is always the page plus, for each sentence of the Outcome,
   the test's name and its output; a task lists what is extra. A trunk task gets a reviewer's pass before it
   merges (format rule 14).
2. **Words.** A *fixture* is a small example kept as a file and checked by a test. *Golden bytes* are a
   fixture's exact encoded bytes, committed as hex text (the repository's path guard refuses binary files);
   they change only in their own commit, with the reason. A *verdict* is any answer that must come out the
   same on the server and in a client: accept or refuse, a hash, the state after applying an effect.
   *Native* is the server build; *WASM* is the portable build of `replica` that runs in Node and a browser.
   *Both builds* means those two. *The trunk* is `v2/docs/TRUNK.md`; *settled* means its table "Settled at
   reconciliation".
3. **The encoding profile** is T0's: page `v2/docs/encoding.md`, code `replica/src/encode.rs`. Every later
   task uses it and none writes a second. Only `replica` encodes or decodes; TypeScript hands bytes through.
   A hash covers stored bytes, never a re-encoding.
4. **The no-float rule** covers everything stored, hashed or deciding a verdict, in `replica` and in what
   `sim` writes to the log: no `f32` or `f64`; no `usize` (32 bits in WASM, 64 native); no iterating a hash
   map (Rust seeds it at random in each process); no reading a clock; integer overflow checks left on in
   release builds (Rust turns them off by default, so a sum wraps silently). Floats are free in drawing code,
   and inside `sim` when the result is rounded to integers by one stated rule before it enters an effect.
   K14 checks it in the build.
5. **Order inside the lane:** after K15 and K1: T0, T3, T2, T1, T5, T4, T6 (win 1). Then, at the trunk stop
   after win 1's gate: T7, T8, T9, T10, T11, T12. No win 2 task is dispatched before the owner has signed the
   pages (held by stage).

---
