# Lanes I and R · Intents and the gateway; the replica and the agent's client

Draft, local only, 16 to 17 Nov 2026. Task K15 publishes this file as
`v2/docs/tranche/I-R-intents-and-replica.md`; every task below cites it by that path. Task bodies are in the
shape of `v2/docs/tranche/FORMAT.md`; its rules (1 to 18) apply to every task and are not repeated. The trunk is
`v2/docs/TRUNK.md` (contracts T6, T7, T8 and T10 bind these two lanes; their pages are `v2/docs/effects.md`,
`v2/docs/views.md`, `v2/docs/audience.md` and `v2/docs/intents.md`). Facts about today's code were read from
`origin/main` at a5a31d203 (`git show origin/main:<path>`); the load numbers in I10 and I11 were computed from
`tools/bench/capacity/profiles/shapes.mjs` at ee208bfdb.

## Changes at the final pass

Made on 17 Nov 2026 from `FORMAT.md` rules 11 to 18, the planner's rulings and the three audits. Every task
(I1 to I13, R1 to R12) was touched.

**In every task**

| Change | Rule or source |
|---|---|
| `**Acceptance.**` added at the end, at most five boxes; the two gates (I11, R11) use the four gate boxes with the bars named in the first | Rule 11 |
| Step 0 names the result that means "stop and hand back". It had none in I6, I7, I8, I9, R1, R3, R4, R5, R7, R8, R9, R11 and R12; it was sharpened in I1, I3, I4, I5, I10, I11, I12, R2, R6 and R10 | Rule 12 |
| Citations of the design document ("Design 3.6", "design, section 4"), of `TRUNK.md`, `FORMAT.md` and "see Changes" replaced by the repository path, or by the fact itself. Goals once cited as "goal A4", "goal A8" are stated in words | Rule 16 |
| "Declared in the pull request" became "declared in a comment on the task issue before the run" | Rules 11 and 13 |
| Touches narrowed from crates to modules. **The module names are this pass's proposal**: see "Touches, how to read them" | Rule 17 |
| Labels that could be read as a task or a bar: the goals "A2", "A4", "A5" and "A8" and the basis mark "T" are now plain words. No checked fact, bar or step in this file carried a task's ID | Final-pass instruction 4 |
| Each "Amended at the final audit" line is kept, placed before Acceptance | |
| The preamble: paths as K15 will publish them; "Touches, how to read them" added; the outline-change table and "The acceptance claim" reworded without the design's section numbers; two words added to the glossary (actor, daemon) | Rule 16 |

**Task by task**

| Task | Change |
|---|---|
| I1 | Why it exists restated without the design. Touches gains the world's end of the local socket. A footgun on the first frame (T10 says it never changes) |
| I2 | Fixtures are bytes: stored as hex text, since the repository's path guard refuses binary files (process audit, section 2, item 6) |
| I3 | **The bar stays at 0.05 ms of the clock thread per committed act.** What it means in a tick is now written out: under 1 ms a tick at the target's largest burst, a whole tick for 1,000 commits in one tick (reported with that tick's lateness). The older "0.02 ms" note is removed |
| I4 | **Depends on gains K16** (the text store, the one place free text is kept by reference). Step 0 checks it. One box that no text is in the log |
| I5 | **Outcome rewritten to be achievable:** of 120 Souls sent into a hall with 60 seats within 30 s, every seat is taken, and at least 90 % of the Souls reach a named end (seated, or told there is no seat) on their first send |
| I6 | The fetch for a refusal over the byte limit is named as R5's (a later stage); this task ends at ids and hashes |
| I7 | The round-trip time once cited from the design is called a planning estimate; the bout's own is a box |
| I8 | "I11's a tenth at 2 a second" is now I11's stretch arm. A creator driving a world's body is the actor (I13), so one bucket covers a creator's whole cast |
| I9 | **Title is now "Plans, run by the agent's client".** The body has the client's resident program run the steps one by one; the engine holds no plan, and a box says so. The "Trunk flag" paragraph is folded into the design. **Depends on gains R8 and R10**: each step is checked locally (R8) and the outcome counts model turns with R10's `stats` |
| I10 | The two loads I11 needs are defined here, with their checked numbers: `target` and `stretch`. **I10 writes the stretch load**, as a merge of two schedules in `v2/tools/driver/loads.mjs`; the shared `shapes.json` is not edited. Step 0 also hands back if K14's import check refuses the shared shapes |
| I11 | **Title is now "Gate, win 2: the acts target, and a faster stretch".** Two declared arms on a world of Eden's complexity: the target (1,000 agents, 5,000 acts a minute in bursts, everyone walking into one hall), to which the bars apply, and the stretch (the same with a tenth of the agents at 2 intents a second), which is reported. The curve arms are kept. The order of runs and what to do if run time counts against the ceiling are written in |
| I12 | **Split.** It keeps "One session, many bodies": one client drives several bodies it owns. Sequence and budget are per actor, and each owned body's Soul is its own actor, so the outcome's ten separate sequences stand |
| I13 | **New: "A body that belongs to a world"** (lane I, stage 3, 2 h, depends on T10, I12, build). A creator's session drives a body the world owns; the recorded actor is the creator and sequence numbers are per actor (ruling) |
| R1 | The generated stream is made from a seed at test time, not committed |
| R2 | Step 0 no longer cites the local Soul Actions note; the fact is restated |
| R4 | States outright that the copy holds an index of every place and thing in the world and can find a Soul (E1), and that only the live detail of bodies is limited by nearness. A box that a client holds several scopes |
| R5 | The six-hour recorded log is a run artifact, never a tracked file |
| R7 | The same statement as R4, in the brief and in a box: nothing shows the rest of the world as counts |
| R9 | **Also the home of a standing consent** ("I accept high fives"): a rule in the Soul's own client that answers an offer with no model turn (ruling; E8 uses it). `send` may take values from the matched event, so a rule can join the offer it matched |
| R10 | Why it exists restated without the design |
| R11 | **Depends on gains R12**, and the run uses R12's merged skill (the "working draft" text is gone). Step 0 needs W1's dev sign-in. The declaration goes in an issue comment |
| R12 | **Moves to stage `win 3`** (ruling). **The skill teaches self-scheduling:** given a time or a condition, the agent writes an entry in the client's schedule (R15) and ends its turn; it never waits inside a turn and never polls |

**Could not resolve**

1. **K16** is I4's new dependency by instruction. It was not in `tasks/K-core.md` when this file was edited; the
   index script will fail on I4 until it is.
2. **I13 and the envelope.** T10's field list (actor, verb, target, parameters, sequence, basis, expiry,
   resources, fallbacks, replaces) has no field that names the body driven when the actor is a creator. I13's
   Step 0 checks the page and hands back if there is no way; it does not add a field. T10's owner should say.
3. **R12 before R15.** R12 (win 3) now teaches `schedule add`, which R15 (stage 2) builds. Until then the thin
   command refuses it as unknown, and the skill says what to do. R15's body in
   `tasks/Z-added-at-reconciliation.md` still says "The skill gains: …"; it should now only check R12's lines
   against the built command. Not edited: not my file.
4. **R2 and Soul Actions.** That tranche's rules file and case format have no repository path I could name.
   R2's Step 0 says to search, and what to do in each case.
5. **Run time against ceilings.** I11's runs take about 160 minutes of machine time in a 3 h ceiling, R11's two
   hours in 3 h. Whether a wait on a declared run counts is for the tranche spec to say (the process audit
   asks for it). Each gate now says in what order to run and what to post if it does count.
6. **The one `v2` command for timed runs** (process audit, section 2, item 7) is in no task of these lanes.
   I10, I11 and R11 declare and start their runs by hand and touch no file under `.github/`.
7. **Module names in Touches** are proposals; no crate's layout exists yet.
8. **The target load's parameters** (`presence` 1, `gatheredShare` 1, `medianSec` 18) are what I found gives
   5,000 acts a minute at 1,000 agents with the shared `event` shape's unevenness. "5,000 acts a minute in
   bursts" is read as the mean, with one-second bursts about three times it. The plain `event` shape at 1,000
   agents intends about 2,850 a minute.
9. **I11's bar "under 1 % refused for load"** stands beside I8's "none is refused for load" and rule 10. Left
   as written: a bar.
10. **A reviewer's pass for I1** (tokens) was proposed by the process audit. Rule 14 gives one to trunk tasks
    only, so I1 does not ask for one.
11. **`INDEX.md` is stale** for these lanes: titles of I9 and I11; dependencies of I4, I9 and R11; R12's stage;
    the new I13. Run `build-index.py`.
12. **I9 stays in lane I**, though it touches only the client.

## Touches, how to read them

Rule 17 asks for modules, not crates. No crate has a layout yet, so the module names in these two lanes are
proposed here. If an earlier task has already named the module, use its name and list the difference under
"Deviations". A new file inside a named folder, and that folder's tests, need no permission. Anything outside
the named folders is outside Touches.

| Folder | What lives there | Tasks |
|---|---|---|
| `v2/crates/gatewayd/src/` `socket.rs`, `token.rs`, `world_link.rs`, `resume.rs`, `session.rs`, `subscribe.rs` | Agents' sockets | I1, I2 (one call), I12, I13, R4, R5 |
| `v2/crates/replica/src/` `intent_decode.rs`, `refusals.rs`, `selector.rs` | The envelope's check, refusal names, selectors | I2, I5 |
| `v2/crates/replica/src/` `apply.rs`, `query.rs`, `hash.rs`, `wasm.rs`, `sync.rs`, `rules/` | The copy | R1, R2, R5, I6 |
| `v2/crates/worldd/src/checkers/` | Checker threads, budgets, refusals | I3, I5, I6, I7, I8, I13 |
| `v2/crates/worldd/src/gateway_link.rs`, `answers.rs` | The world's end of the gateway's socket; answers after the sync | I1, I4 |
| `v2/crates/worldd/src/views/` | The view tier and subscriptions | R3, R4 |
| `v2/crates/sim/src/commit/` | Confirming read sets, applying, receipts, deadlines, sequences, moves | I3, I4, I5, I7 |
| `v2/client/src/` `home/`, `daemon/`, `sync/`, `cli/`, `brief/`, `find/`, `check/`, `match/`, `reflex/`, `stats/`, `plan/` | The resident daemon and the thin command | R5 to R10, I9 |
| `v2/client/skill/` | The skill an agent installs | R12 |
| `v2/tools/driver/` | The scripted driver and its loads | I10 |
| `v2/tools/bench/<name>/` | One folder per bench or gate scorer | every task with a posted table |

A measured run in these lanes is declared in a comment on the task issue before it starts (build, machine by a
neutral label, loads, seeds, the bar), run twice, and posted as a table (rules 8 and 13). Raw run files are
never committed.

## Changes to the outline, before the final pass

Kept for the record; where the final pass changed a row again, the table above is the newer word.

| Task | Change | Reason |
|---|---|---|
| I3 | Outcome sharpened: the 0.05 ms bar is at the 99th percentile, in an even run and in one burst of 1,000; the mean is reported | At 0.05 ms, 1,000 commits fill a whole 50 ms tick. The bar is kept; I3 now states what follows |
| I4 | Dependency added: K9. "Answered" is measured from arrival at the world process to the answer leaving it | A named end for every act needs a deadline, and a deadline needs the due list |
| I5 | Outcome rewritten; dependency added: B3 | As first written it could not be met: 120 Souls cannot be 90 % seated on 60 seats. Seats need B3. The run includes a thinking delay, without which it measures nothing |
| I8 | Outcome sharpened: none of the 1,000 is refused for load; one flooding Soul is held without moving the others | A refusal is not an answer that meets a bar (rule 10) |
| I9 | Written as a plan run by the agent's daemon | T10's closed list of orders is ranked fallbacks, a held stance, follow and standing in a queue. A plan is not on it (`v2/docs/TRUNK.md`, "Settled at reconciliation") |
| I10 | Outcome sharpened: under one core *and* at least 95 % of intended acts sent on time | A driver that falls behind makes every gate measure the driver |
| I11 | Guard bars added; loads declared. Depends on gained N1, N7, N9 and N10 | The title said 5,000 acts a minute while the outcome's own mix came to about 16,600; the shared shapes cannot express "a tenth at 2 a second". Today's "act wait" measured less than the new one does |
| I12 | Dependencies I1, I4, I8 named | It held two separate things (many bodies per session; a body owned by a world); now I12 and I13 |
| R1 | Dependency added: K2. Outcome adds a generated stream of 100,000 effects | K2 and R1 both own "the tree"; one must define the type. Fixtures alone are a small sample |
| R2 | Outcome sharpened: a third verdict, "unknown", and the cases where client and server may differ | The client cannot see private fields the server can |
| R5 | The 2 s bar applies with the library cached; a changed build is reported beside it | Six hours may include a deploy; the download depends on the owner's link |
| R6 | Outcome made measurable (outlives the chat, reconnects, single instance, a canary token) | "The model never sees the token" had no test |
| R11 | Dependencies added: R10, I10, R4, I5, N1. Acceptance is counted per decision, with a minimum sample and two runs | See "The acceptance claim" below |

**Missing tasks (three), since added.** Today's client does these and no task in these two lanes as first
written carried them over: (1) **wake rules and their delivery** on the new daemon (`wake.mjs`: rules as data, a
budget per hour, merging, a held queue); (2) **the Soul's memory** fed from the replica (`memory.mjs`,
`memory-folder.mjs`, the brief built from memory); (3) **owner messages**: the path from the owner's page to the
agent and back (`listen`, `ack`, `result`), which is today's main loop. Tasks R13 (wake rules and owner
messages), R14 (memory) and R15 (the client's schedule) now carry them.

## Words used here

- **Intent**: one small message from an agent saying what its Soul should do. **Envelope**: the fixed fields
  around it (actor, basis, expiry, fallbacks, what it replaces).
- **Actor**: who an intent or effect is recorded as coming from: a Soul, a creator, or the world.
- **Basis**: the version of the world the agent decided against. **Version**: a place in the world's log.
- **Fallbacks**: a ranked list of candidates the agent wrote; the engine takes the first that holds.
- **Effect**: one recorded change to the world. **The log**: the ordered file of all effects.
- **Replica** or **copy**: the part of the world a client keeps locally, kept current by a stream of effects.
- **Frozen copy**: a read-only picture of the world that other threads may read while the clock thread works.
- **Clock thread**: the one thread that changes a world. **Tick**: one step of it (50 ms to start).
- **Checker**: a thread that decides whether an act can happen. **Read set**: the nodes a check looked at, each
  with its version.
- **Receipt**: the answer that an act was accepted. **Outcome**: how it ended.
- **Idempotent**: sending the same thing twice has the effect of sending it once.
- **Token**: the secret that proves a client may drive a Soul.
- **Open loop**: a load driver that sends each act at its planned time whether or not the last was answered.
- **99th percentile**: the value 99 of 100 measurements are under.
- **WASM**: a compiled form that runs in Node and in browsers. **CBOR**: a compact binary encoding.
- **Harness**: the coding-agent program the owner runs (Claude Code, Codex). **Model turn**: one call to the model.
- **Daemon** or **resident program**: the client's process that stays running on the owner's machine between
  model turns (R6).
- **Interest set**: the bodies near enough to a body to be sent to its agent in full. It is not the list of who
  hears: an utterance has its own reach and audience, and a device can carry it further (E13). It limits only
  the live detail of bodies: every place and thing in the world is in the copy as an index (E1).
- **Target arm**, **stretch arm**: the two loads of the win 2 gate (I11), defined in I10.

## What exists today, and what the new client keeps

| Today (`tools/world-launcher/soul/`, `docs/architecture/souls.md`) | In v2 |
|---|---|
| The Souls home (`home.mjs`): `.souls/` found upward like `.git`, `credentials.json` at mode 0600, `souls/<id>/runtime/` | Kept unchanged (R6) |
| `serve`: one resident process per Soul, a lock, a Unix socket, a log; hands over to a newer client | R6 |
| The copy: the whole world's structure (`/v1/edge/catalog`; Eden: 1,510 places, 4,518 things, 1,365 acts, 1.4 MB) and a live picture pushed with `epoch:seq`, a hash check every 5 s, the last 120 changes kept for a returning client | R1, R3, R4, R5: a replica by subscription; E1: a world-wide index of every place and thing, and where each Soul is |
| `look`, `find`, `query` answered locally (`catalog.mjs`) | R7 |
| `handActs`: the client's own copy of the world's conditions | R2, R8: one rule library |
| `act <id>`, a receipt, `Idempotency-Key` or `clientRef` | I4: sequence numbers; I5: ranked lists |
| Refusals with `code`, `reason`, and `alternatives` the world chose | I6: the code and what changed |
| `plan '[…]'`, run with no turn between steps | I9: run by the client |
| Token `sim_<soulId>_<secret>` | I1, R6 |
| `listen`: Claude Code is woken when a background command exits, or by the lines of a followed one; Codex runs it as each turn's last command | R6, R7 `wait`; wake rules and owner messages are R13 |
| The brief: 1,500 bytes from memory (`brief.mjs`) | R7: from the replica |
| The skill: 61 lines, 4 kB (`skill.md`) | R12 |

## The acceptance claim, and how it is measured for real

The design this tranche started from claimed: first-send acceptance is 98 % when a model thinks for 1 s and 92 %
at 8 s; 8 to 20 % when a crowd is shown the same nearest seat; 92 to 99 % with ranked fallbacks. Those numbers
came from a reviewer's scratch model, outside the repository. I could not read it, and real model latency was
never checked against it. Three tasks replace it with measurements:

- **I5** measures the mechanism with scripted agents. Thinking time is a declared input: 1 s, 8 s, and the live
  agents' own time to a first act (median 7.4 s, 90th percentile 13.5 s, 55 samples:
  `tools/bench/capacity/profiles/cadence.json`). The crowd rule is the reviewer's: every agent picks the nearest
  free seat it sees. Each arm runs with and without fallbacks.
- **R8** measures how many doomed sends the local check stops, and that it stops no good one.
- **R11** measures the real thing: a live model, its real thinking time (from basis to send), whether it writes
  fallbacks at all, in a world where scripted agents want the same things. It counts per decision: an act the
  daemon stopped locally still cost a model turn, so it counts as not accepted.

A result far from the scratch model's numbers is a finding and is posted as one.

## Sources, and what was not verified

Fetched and read on 16 Nov 2026: Claude Code channels and hooks pages; the Codex sample configuration; AI Town's
`ARCHITECTURE.md`; the Project Sid paper; GitHub's REST rate-limit page; issues #2510 and #2532 with comments.
From search summaries only: Shopify's limits page, the Generative Agents paper, wasm-bindgen's deployment guide,
tokio's channel pages, Discord's gateway page, tungstenite issue 480. From memory, not fetched: RFC 8949, RFC
9110, KIP-98, the `subtle` crate, wrk2's note on coordinated omission, the 104-byte socket path limit, Linux's
default of 1,024 open files. Computed on 17 Nov 2026 by importing the shared load shapes: the act counts of the
`event`, `target`, even and `stretch` loads quoted in I10 and I11 (seeds 1 to 3, 600 s).

**Not verified:** any head-to-head memory figure for the three Rust WebSocket libraries at 10,000 sockets (none
found); that Codex has no way to be woken from outside (none is documented; absence is not proof); that Claude
Code wakes a session when a background command exits (today's skill relies on it; I found no official page);
Chrome's current limit for compiling WASM synchronously (4 kB in older notes, possibly raised); the reviewer's
acceptance model; the tables behind #2510 and #2532 (they are comments on #2504, which I did not open); that a
fresh agent ends its turn after a refused `schedule add` (R12 tests it).

**Amended at the final audit:** in the notes above, the I9 and I12 rows, "Missing tasks", the meaning of "interest set" and two rows of the today table were brought up to date: the closed list of orders is ranked fallbacks, a held stance, follow and standing in a queue (no "wait for"); the envelope names an actor; R13 and R14 now carry the missing work; hearing is by reach and audience (E13); the world beyond the room is an index (E1), not counts.

---

## Lane I · Intents and the gateway
