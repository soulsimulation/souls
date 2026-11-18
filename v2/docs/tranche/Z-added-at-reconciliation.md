# Tasks added at reconciliation (V17, V18, B14, F10, F11, X10, S8, O15, O16, R13, R14, W9, R15, R16)

Draft, local only, 16 Nov 2026. Written to `v2/docs/tranche/FORMAT.md`; its rules apply to every task and are
not repeated. The trunk is `v2/docs/TRUNK.md`, with its "Settled at reconciliation" table. K15 puts this file
at `v2/docs/tranche/Z-added-at-reconciliation.md`: the notes below are shared by its tasks, which cite them by
that path. The lane writers found work nobody owned; these fourteen tasks fill it. They were first written quickly by the planner. This file is their
fact-check and rewrite to the standard of the other lane files. Facts about today's code were read from
`origin/main` at ee208bfdb (`git show origin/main:<path>`).

## Changes made at the final audit

Every ID, title, lane, stage and kind is kept. These are the changes of outcome, ceiling and dependency.

| Task | Change | Reason |
|---|---|---|
| V17 | Outcome given counts: every one of Eden's 214 kinds has a picture or is listed; a second run gives equal hashes; no state change needs a new asset | "One asset per look" could not be counted, and looks that follow state would multiply assets |
| V18 | Depends on: V3, V7 becomes V3, V10. Outcome: + a planted break is caught; + a removed or changed entry fails | The outcome compares fact sheets, which are V10's; V7 is bones and has its own test. A gate has to be shown to catch something |
| B14 | Outcome: the board is 2 m by 0.3 m, the doorway 1.2 m, 20 runs, and the refusal case is a corner between 0.9 m corridors. Touches: `v2/crates/sim` only | The carriers' own bodies were not counted: held in line, board and carriers are 3.3 m and cannot make that corner at all. `v2/crates/skills` was not a folder in the rules' table then |
| F10 | Depends on: + E4. Outcome: + kept things remain; + no tick cost; + a jump equals stepping | Nothing is ever loose until a thing can be set down where there is no slot (E4). This lengthens F7's chain |
| F11 | Depends on: F3 becomes F2, F3, K3. Outcome: stopped three ways, a second Soul finishes, the 21st note refused | Stage effects are F2's, field types are K3's. "Keeps two stages" needed a test that tries to break it |
| X10 | Depends on: X7 becomes X6, X7. Outcome is a table per world; nothing is deleted | X6 is what imports each world. "Retired" must not mean deleted |
| S8 | Depends on: none becomes "PR #2624 merged" (it is). Outcome follows the issue's A1 to A3 (no stall over 2 s, equal hashes) | The issue is the task; its failing run predates the merged fix |
| O15 | Depends on: + O2, W8. Outcome: + a stalled clock, + three cases that must stay silent, + no probe wakes a world | A sleeping world is healthy and only the directory says which are asleep. An alert on every deploy is ignored |
| O16 | Depends on: + I4, I10. Outcome: + exactly one receipt per intent, + a kill meets the same bar | "No act lost or doubled" is I4's sequence and receipts, counted by I10's driver |
| R13 | Ceiling 3 to 4 h. Depends on: + R7, I4, W1. Outcome: both harnesses, the budget never passed, the no-reader case. Touches: + gateway, web | Owner messages need a mailbox, a frame and a box on a page; none exists in any task. See "Split" below |
| R14 | Ceiling 2 to 3 h. Depends on: + R7. Outcome made measurable | "Point at the folder" is not enough: the code that feeds memory reads the old API and must be written again |
| W9 | Depends on: + W2, W8, G6. Outcome: "who may enter" is the one switch that exists today (open or closed to visiting Souls); + revoke a device | The page lists pairings (W2), the name and listing are the directory's (W8), hiding is G6's state |
| R15 | Depends on: + R12, E1. Outcome: the 5 s bar is for entries that carry their intent; wakes go through R13; a restart fires each occurrence once; a fresh agent writes an entry and ends its turn | No harness can be woken to within 5 s by anything documented. "Maya reaches the cafe" needs E1's list. The skill is R12's file |
| R16 | Depends on: + R14. Outcome: + bytes, + checked against V10's fact sheet, + a stated look-back | The Soul's own past is in its memory, with the words; the public index has none |

**At the final pass** (16 to 17 Nov: the planner's rulings in the final audit, and rules 11 to 18 of
`v2/docs/tranche/FORMAT.md`, applied to all fourteen tasks).

- **Acceptance.** Every task ends with three to five boxes drawn from its Outcome and Proof.
- **Step 0.** F10, O16, R13, R14 and the rest now each name the result that means "stop and hand back".
- **Citations.** The trunk and the rules by repository path; "above" and "table above" by this file's path and
  heading; Soul Actions' rules quoted in the task, its formats "attached to this issue" (F11).
- **Labels.** S8's "A1 to A3" is "the issue's three acceptance boxes"; F11's "F6a, F6b" are named in words.
- **Touches.** Named: O15 and O16 write one page each under `v2/docs/runbook/`, not the shared runbook file;
  S8 names the two files the caller is expected in; V18 uses `v2/tools/ci.sh` and no workflow; R13 names the
  mailbox's proposed crate.
- **B14** depends on E23 as well as B9, and is written on E23's contract.
- **F10** (ruling): a kind says how long a loose thing lasts once nobody holds or owns it (a sofa for ever, a
  pie a few days); owned or in a slot it lasts. "Kept" is an owner's link or a slot; a thing set down with no
  owner follows its kind's lifetime, and no lifetime means for ever. E4 says the same.
- **X10** (rule 15): depends on X6, X7 and X11. The lane delivers the table, the import reports' follow-up and
  a rehearsed runbook page. Telling owners, each written yes, the importer on real backups and each switch
  wait for the owner's checklist.
- **V17:** models are published through today's `tools/cdn` licence records, by a dry run; the credentialed
  upload waits for the owner's checklist. It calls `apps/web/src/gen-mesh` unchanged.
- **V18:** kind `gate` becomes `build` (the process audit: a pass-or-fail check, not a measured gate), so the
  count of gates drops by one and `INDEX.md` needs rebuilding. The check is one line of `v2/tools/ci.sh`; the path
  of entries committed as binary files is gone (the path guard refuses them); the bucket and each release's
  recording are not the lane's.
- **O15:** where alerts go, and the test that one reaches a person, wait for the owner's checklist; the lane
  proves delivery to a test sink.
- **R13:** the box on the Soul's page moved to W10 (added by the inheritance audit); R13 keeps the client, the
  gateway frame and the mailbox.
- **R14:** says what happens to memory that names ids which change at the clean start (an alias file, filled
  by R18 from X11's table; unaliased ids read as "formerly"), and names `digest` and `consolidate` in the
  outcome.
- **W9:** the outcome says "close it to visitors" and "take it off the list" in those words; today's
  `visitors` switch is whether visiting Souls may enter (`docs/architecture/api.md`).
- **R15:** unchanged in substance. The 5 s bar holds only for entries that carry an intent written in
  advance; an entry that wakes goes through R13.
- **S8:** the highest tier, the walk gate and the coordinator's signature are stated; the coordinator records
  the exception to the pause on old-engine paths before dispatch.
- **Length.** 383 to 471 words with the checklist (median 422), 323 to 403 without.

Not resolved at the final pass:

1. **No text store** (the consistency audit's question 11). F11's document half hands back without one.
2. **The mailbox has no folder in the rules' table.** R13 names lane W's proposed `v2/crates/directoryd`; W10
   names `v2/crates/gatewayd` for the mailbox's scope. One place should be chosen.
3. **O15's watcher source is outside the repository.** The coordinator must attach it, or the lane takes the
   other path (a new watcher under `v2/tools/ops/watch`).
4. **X10's ceiling** rests on X6 and X11 having imported every world cleanly; how many worlds there are was
   not read.
5. **R15 uses a plan (I9)** for "lights on at dusk" and does not list I9. Not changed here.
6. **Soul Actions' texts** (F11's stage rule and state formats) are not in the repository: the coordinator
   attaches them to the issue.
7. **Length.** The bodies are over 380 words; R14, F10 and X10 grew most, from the rulings.

**Split, merge, move, drop.**

- **Split R13** into wake rules (client only, 2 h) and owner messages (mailbox, gateway frame; the page is now
  W10's). It is written here as one task with a hand-back point.
- **Split R15** if it passes three hours: (a) times, the file, restart and missed entries; (b) triggers on a
  change, the skill's lines and the two harness transcripts.
- **R9, R13 and R15 are one mechanism**: something seen in the copy, or a time, leads to an intent or a wake.
  R9 already says its matcher is written once for all three. Build them in that order.
- **W9:** move its account half (devices, revoke) to stage 2. Handing a world on and archiving it are still
  nobody's.
- **Move** each task into its lane's file once accepted. S8 belongs beside S6 (they share runs); O15 and O16
  need the O file's "What every task in this lane keeps".
- **Drop:** none. S8 may end at its Step 0, which is a valid outcome.

**Flags for other files (not edited here).**

1. X8 should depend on X10: its Step 0 already requires that no world runs on the old engine. (Done at the
   final audit.)
2. `INDEX.md` says "twelve tasks" here; there are fourteen. Its tables need rebuilding for the changes above.
3. The rules' folder table (`v2/docs/tranche/FORMAT.md`) lists no folder for a mailbox. R13 proposes it beside the accounts store (`v2/crates/directoryd`,
   itself proposed by lane W).
4. Server-side reminders (`POST /v1/edge/reminders`) are a timer the world holds for a mind. Under T10 they are
   not carried over; R15 replaces them. Nobody had said so.
5. The visitor counter's privacy rules (`AGENTS.md`, "Visitor analytics") must hold on every page of `v2/web`,
   W9's included. Lane W listed this as nobody's; it still is.
6. B14 as first written could not pass: with a carrier at each end held in line, a 2 m board is 3.3 m long and
   does not turn in a 1.2 m corner. B9's own design ("carriers stand at the ends, in line") has the same limit
   at any corner it meets.

**Counting.** Each task body below is 383 to 471 words with its acceptance checklist (323 to 403 without), not
counting its heading, header table and list marks.

**Not verified.**

- That an idle interactive Claude Code session takes a turn when a background command exits. Today's skill
  relies on it; the public tools page does not say it. R13's Step 0 tests it.
- The hooks page was read in part: the `asyncRewake` field's own line, not which events take it or whether it
  wakes an idle session. The `claude -p` flags, the Codex non-interactive, hooks and scheduled-task pages were
  fetched by a research helper or in summary, not read whole by me.
- The limit for turning a rectangle round a corner is my arithmetic; the unequal-width rule is from memory.
- That three's glTF exporter gives the same bytes twice, and that every builder runs in Node with shims.
- How many worlds production holds, and their owners: production was not read.
- Whether the run behind #2631 had a profiler attached, and whether the stall survives PR #2624.
- That the watcher's scheduler accepts a one-minute period.
- That a proxy closes a client's socket when its upstream restarts: inferred.
- Whether T8's text reference is a content hash or an id, and whether X6 keeps a table of old to new Soul ids.
- "No rename call today" rests on a search of `docs/architecture/api.md` only.

## Checked facts used by several tasks

**What can wake a harness** (pages read 16 Nov 2026; for R13 and R15).

| Mechanism | What the page says | Limit |
|---|---|---|
| Claude Code, a background command | Keeps running after a reply; no time limit in a local session (30 minutes, at most 2 hours, in unattended runs) | Not stated: that its exit starts a turn in an interactive session |
| Claude Code, Monitor | Each output line of a watched command is fed to the model | A watch ends after 5 minutes by default, 30 at most; then one notice |
| Claude Code, a hook with `asyncRewake` | Runs in the background and "wakes Claude on exit code 2" | Belongs to a session; untested |
| Claude Code, session tasks (`/loop`, `CronCreate`) | One-minute steps; one-off reminders | Fire only while the session is running and idle; recurring ones run up to 30 minutes late and expire after 7 days; no catch-up; 50 a session |
| Claude Code, Desktop tasks | Run on the owner's machine | The app open and the computer awake; one catch-up run |
| Claude Code, cloud tasks | Run on Anthropic's machines from a fresh clone | At least an hour apart; no local files |
| Claude Code, channels | A server pushes events into an open session | Research preview; a start flag; only listed plugins, or a "dangerously" flag; organisations must switch it on |
| `claude -p` | A scheduler can start a headless turn (`--resume`, `--max-turns`, `--max-budget-usd`) | A new run: money the owner must have chosen to spend |
| Codex CLI | `codex exec`, `codex exec resume`; hooks on its own events; `notify` points outward | No scheduler; no documented way into an open session |
| Codex app, scheduled tasks | Local projects | The computer on and the app running; not the CLI |

Sources: https://code.claude.com/docs/en/tools-reference · https://code.claude.com/docs/en/scheduled-tasks ·
https://code.claude.com/docs/en/channels · https://code.claude.com/docs/en/hooks ·
https://code.claude.com/docs/en/headless · https://learn.chatgpt.com/docs/hooks.md ·
https://learn.chatgpt.com/docs/automations.md · https://learn.chatgpt.com/docs/non-interactive-mode.md

**Today's client, and what becomes of it** (`tools/world-launcher/soul/`, `docs/architecture/souls.md`).

| Today | In v2 |
|---|---|
| `wake.mjs`: rules as data. Always on: owner message, speech to me, plan stopped. On by default: act ended, plan finished, event starting. Added by the agent: `soul-arrives`, `place-busy`, `thing-state`, `speech-near-me`, `idle`, `at` (a real time, once), `every` (at least 5 minutes) | R13 (rules, budget, delivery); `at` and `every` go to R15 |
| Budgets: `quiet` 4, `normal` 12, `lively` 60 wakes an hour, or a number; a cap a day; at most 50 queued; a handed wake is held 10 minutes | R13, unchanged |
| A time that passed while `serve` was not running is dropped, never fired late | R15: kept as the default, and now reported |
| `wake heartbeat`: a prompt, or a gated shell line (`pending --check && claude -p …`), for the owner's own scheduler, every 45 minutes by default | R15, as the path for wakes with no chat open |
| `listen --follow` in a background process; `pending` each turn where there is none | R7's `wait`; R13 |
| Owner messages: kept by the world until acknowledged; `ack`, `result`; an act sent `for` a message closes it; closed `failed` after 15 minutes | R13: a mailbox outside the log |
| Reminders kept by the world (`POST /v1/edge/reminders`), and the calendar's `schedule.starting` event | Not carried over: the calendar is data (E7), the timer is the client's (R15) |
| Memory: an append-only log and projections under `souls/<id>/memory/`; written with no request and no model call | R14 |
| `digest` (from memory), the owner's "while you were away" (`GET /v1/me/away`) | R16 |

**R15 in more detail** (the task body is held to its length; these bind it as well).

- **The decision.** Gene, 16 Nov: when to act is the agent's own business. The engine holds no order that waits
  for a time or a condition (T10), and nothing in this task runs in the world. A routine does not run while its
  owner's machine is off, and that is intended.
- **The three cases as entries.** "The pub at 8": a world time, and the intent to walk there. "Sit with Maya
  when she reaches the cafe": a change of Maya's place in E1's list, and a sit with ranked fallbacks. "Lights
  on at dusk": E6's dusk effect, and a plan (I9) that switches each lamp on.
- **Whose clock.** A world that was down owes time and pays it exactly, so world time can run behind real
  time. A world-time entry fires when the copy's world clock passes it. A sleeping world sends no frames:
  work the clock out from the last world time, real time and rate, and correct on the next frame. An intent
  sent to a sleeping world wakes it (O2: answered within 3 s).
- **Wakes are not under the 5 s bar.** A wake goes through R13: to an open reader at once, otherwise it waits,
  merged, for the next one, and says how late it is. A repeating entry that wakes counts against R13's budget,
  and repeats are at least 5 minutes apart (today's `every`).
- **Missed while off.** Defaults: a one-off entry `tell`s; a repeating one `drop`s and counts. A closed lid is
  "off": notice it by a gap between the daemon's own beats.
- **Once each.** An occurrence is keyed by entry id and due time, and marked before its intent is sent with a
  reserved sequence number (I4), so a crash sends it once.
- **The skill's lines** (R12's file, under 5 kB): "When your owner gives a time or a condition, write a
  schedule entry with the act it should send, and end your turn. Never sleep, loop, poll or hold `wait` for
  it. An entry you cannot write as an act is a wake: say so, it costs a turn."
- **One file, not two.** Today an owner-edited `memory/schedule.md` exists and the brief reads its lines (the
  retired runtime compiled it). Reuse that file or retire it by name; do not leave two schedules.

**#2615 and #2631, read once on 16 Nov with their comments.** #2615: births cost 6 to 7 s of the clock thread
each (a copy of the whole world per birth) and the load monitor restarted the world. Fixed by PR #2624 (merged
16 Nov 23:14 UTC; births placed on the live engine, about 0.2 s) and PR #2623 (merged 22:50; a world that still
ticks is not restarted). PR #2608 (stall stacks opt-in) merged 21:58. PR #2612 (the join-wave bench) is an open
draft. #2615 stays open until its bars are re-run (S6). #2631 is open with no comment and no pull request.

---
