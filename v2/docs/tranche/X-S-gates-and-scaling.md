# Lanes X and S: gates, the cut-over, and what is carried over from Scaling

Draft, local only, 16 Nov 2026. Written to `v2/docs/tranche/FORMAT.md` (K15 puts the tranche's rules there); its
rules apply to every task and are not repeated. The trunk is `v2/docs/TRUNK.md`. This file becomes
`v2/docs/tranche/X-S-gates-and-scaling.md`. Read the preamble of your lane before your task: it holds what every
task in the lane shares. X10 and S8 are in `Z-added-at-reconciliation.md`; X11 to X14 are in
`P-product-whole.md`.

## Changes at the final pass

Every task: an `**Acceptance.**` list of at most five boxes added at its end (rule 11; the gates carry the four
gate boxes with their bars named in the first); Step 0 says what result means "stop and hand back" (rule 12);
citations of the local trunk, format, outline and design files replaced by repository paths or by the fact
itself (rule 16), and no reference to a section of the design or to its lettered requirements is left; Touches
narrowed (rule 17). No ID, stage, ceiling or kind changed. Beyond that:

| Task | Change | From |
|---|---|---|
| Preamble | The checked facts are "fact 1" to "fact 8", no longer F1 to F8, which are lane F's task IDs. Bars and steps of the Scaling tranche are written "the Scaling tranche's bar G3" and "#2505's step 3". Gate rule 2 says the gate machine is never the production host; rule 3 says where the declaration is posted and that an edited one voids the run; rule 9 (acceptance) added | Process audit, B5 and the gate table |
| X1 | Depends on: + E1, E2, and a design line that briefs name far places in words. The citation of the design's lettered gate restated | Brief; consistency audit question 20 |
| X2 | The bars now add up: the bars of I11 and of V11's readers that the task said it held are listed; the origin bar's base is a declared zero-viewer arm (no audience, a probe of 20 readers) read through a declared cache. The agents' load is named as I11's goal arms. The machine is the gate machine, not production. A hand-back point for the drivers | Brief; consistency audit question 18; process audit, gate table |
| X3 | Both pairs' arms and the 10 % rule are numbers. The viewers' base arm holds 24 scripted walkers. A noise floor above 10 % makes a pair void, never passed. Step 0 hands back on a noisy bench | Brief; process audit ("re-scorable"); consistency audit question 18 |
| X4 | Arm 2 arrives at 100 a second with a wave of 1,000 at 120 s, so 40,000 are attached by 400 s and held to 600 s (40 a second reached only 24,000). The world-time bound has a number (proposed: 1 s). A probe of 24 agents acts through the quiet, or "act bars back within 60 s" cannot be read. Step 0 hands back | Brief; process audit, gate table |
| X5 | Rule 15: the lane writes the runbook and the declaration and proves the generators at 1 % on the gate machine; Gene's yes, the CDN's written confirmation and the run itself wait for the owner's checklist; a second short step scores the run. Depends on: + O17, because the fork must be installed on the real path first. Generator addresses stay out of the issue | Brief; process audit, "split" table; inheritance audit, "can X6 to X10 be carried out" |
| X6 | Rooms, things and uploads only, read from a backup of each live world. Each imported thing names the Soul Actions entry for its kind, or is listed. Accounts, Souls, looks and creators left to X11. Depends on: W1, W2 and B13 removed with that work. Rule 15: the lane proves the importer on a fixture backup; reading production backups is the release owner's, with Gene's yes | Brief; inheritance audit; process audit |
| X7 | Depends on: + X11, X12, E17, O19, R18. The declaration says what installed clients do on a rollback, and what happens to accounts and Souls made after the switch. Rule 15: the lane rehearses on the preview and writes the declaration and the two commands; the switch and the walk on the real URL are the release owner's, with Gene's yes. Touches no longer says "deploy settings" | Brief; FINAL-AUDIT ruling; inheritance audit; process audit |
| X8 | Depends on: + O18, X14. A delete list that names every package and tool with nothing left to run it, the launcher and keeper among them; a keep list; the frozen upgrade answers kept; the strict proof tiers switched on for the core (K15). The document sweep is X14's; this task keeps `AGENTS.md` and the vision's history principle. Rule 15: Gene's yes, his approval of the deletion and his merge of the policy change wait for the owner's checklist. A hand-back point | Brief; inheritance audit; process audit |
| X9 | What a Soul owns and holds or wears travels with it; anything else must be put down first, and the travel is refused by name until it is. Depends on: + B4, E15 (things held, things worn). A hand-back point | FINAL-AUDIT ruling; consistency audit question 7 |
| Lane S preamble | The boxes under each task summarise the issue's acceptance; the issue wins. "Touches: none" tasks say the issue comment is the record | Process audit, "fix in place" |
| S1 | Step 0 says plainly that it waits for PRs #2594, #2600 and #2602 to merge | Brief |
| S2 | The outcome is #2524's A2 (2,000 viewers, 95 % back within 30 s) and no longer mentions the outline's figure. Waits for the coordinator's edit of #2524 | Brief; process audit |
| S3 | Gate boxes cover #2525 and #2548. Whether #2548 stays its own issue waits for the coordinator. Step 0 hands back | Process audit |
| S4 | The agent arm is 500, because the capacity gate found no fluid capacity to double. Waits for the coordinator's edit of #2546 | Brief |
| S5 | Rule 15: the lane writes the runbook and the declaration; the run is the release owner's, with Gene's yes. "Step S3" and "step S6" are "#2505's step 3" and "#2505's step 6". Generator addresses stay out of the issue | Process audit; rule 15 |
| S6 | Only the bars' re-run, its fix having merged. Gate boxes | Brief |
| S7 | Only a check of the logs | Brief |

**Could not resolve.**

1. **X4's world-time bound (1 s)** and **X3's rule for shares near zero** (a tenth of X2's allowance) are
   numbers I proposed so that the bars can be scored. The planner should confirm them before filing.
2. **X2's cache.** The origin bar can be read only with a cache between the readers and the origin. On the
   gate machine that is a local caching proxy with V2's rules; I could not see that V2 builds one for loopback.
   X2 declares it and hands back if there is none.
3. **X6 and Soul Actions.** "Names the Soul Actions entry" needs their map of kinds to entries (their task E11,
   written SA-E11 here). It is outside this tranche and is not in the header, where "E11" would be read as lane
   E's task. Without the map every thing is listed, which the outcome allows.
4. **S3 and #2548.** Whether #2548 stays its own issue or is folded into #2525 is the coordinator's decision
   before dispatch.
5. **Waits on a declared run.** X1, X2 and X5 spend most of their ceiling waiting on their own runs. The spec
   must say that this time is not counted, as the process audit asked.
6. **X5 and the second machine.** X5 still depends on O9, which is shown across two machines only if the owner
   buys one.
7. **X9's added dependencies (B4, E15)** are mine: without things held and worn there is nothing to carry or
   to refuse. If the planner would rather keep X9 small, the carried things become their own task.

Checked against `P-product-whole.md` after it appeared: X14 there depends on X7, not X8, so X8's dependency on
X14 makes no cycle; K15 there writes down the tiers X8 switches on; X5's, X7's and X8's headers here match what
that file asks of them.

## Changes to the outline

Every place where these bodies differ from the first outline of the tranche, with the reason.

| Task | Change | Reason |
|---|---|---|
| X1 | Depends on: add N1, I7, V10. Outcome: adds first-send acceptance of at least 95 % by cause, and says what "stuck" means | The outcome needs fact sheets (V10), a bout driven by agents (I7) and Eden's content (N1, Gene's barometer). The 95 % came with the first slice's last gate |
| X2 | Depends on: "all of stage 2" becomes N15, I11, V11, V16, F7, O6, O14. Outcome: the bars of N15, I11 and V11, held at once | "All of stage 2" makes the goal wait on web-app tasks that cannot move its numbers, and hides what it needs. The outline's outcome named the load and no bar |
| X4 | Ceiling 2 to 3. Outcome: adds no act or entry refused, and world time within a bound | Three kinds of reconnect are new arms of two drivers; #2546 had its flags built for it. "Nothing restarts" alone would pass a world that refuses people |
| X5 | Depends on: add X4 and V2 | #2547 ran after its loopback overload arms; the CDN's written terms come from V2. Its runbook overlaps O13: O13 should link to it, not write a second one |
| X6 | Depends on: add G6, W1, W2, W8. Outcome: says what "pairings kept" means | Ownership and uploads have nowhere to land without them. (At the final pass the Souls and accounts, with W1 and W2, went to X11) |
| X7 | Depends on: add X5, O7, O12 | A switch with no rehearsal on the real path, no per-world rollback and no proven restore is not ready |
| X8 | Depends on: X7 and its rollback window ended. Documents limited to the two the outcome names | Deleting inside the window removes the way back. Rewriting every document does not fit 4 h beside the deletion |
| X9 | Depends on: add T11, K10, O3, I1 | The transfer waits for the off-machine mark, arrives as a birth, and moves a socket |
| S2 | Outcome follows the issue (2,000 viewers, 95 % back within 30 s, none on the world's thread). Depends on: add PR #2603 | The outline's "500, all within 30 s" is not the issue's A2. `--restart-at` exists only in PR #2603 |
| S3 | Ceiling 2 to 3. Depends on: add PRs #2603 and #2628 | It now holds two 2 h designs. Arms above 2,000 viewers need the wide runner |
| S4 | "Twice the measured capacity" becomes 500 agents | #2532 measured no fluid capacity at all (under 24 agents), so twice it has no value |
| S5 | Depends on: add S4. The runbook is written first | The issue's own order. The runbook needs no yes and testers need it soonest |
| S6 | "The smallest fix" becomes "the bars re-run on the fix". Depends on: PR #2612 | The fix merged on 16 Nov (PRs #2623, #2624). `settled --wave` exists only in draft PR #2612 |

**Missing tasks, and where they went.**
- **The other worlds.** X7 moves Eden only and X8 deletes the old server. Now task X10, in
  `Z-added-at-reconciliation.md`; X8 waits for it.
- **#2631.** A join burst at 100 agents held the world's thread 11 s in route search and the hang watchdog
  killed it. Now task S8, in the same file.
- **Accounts and Souls, the inheritance walk, the public docs, the repository's docs and tools.** Now tasks X11
  to X14, in `P-product-whole.md`.

**Amended at the final audit:** the missing tasks are marked with the IDs they now have, so nobody files them twice.

**Tasks that may not need to exist.** S7 is a log check now that PR #2608 has merged; the coordinator could close
it from S3's logs. X9 is a build, not a gate or part of the cut-over, and nothing in lane X depends on it; it fits
lane O better.

**Where the Scaling issues contradict the outline's lists.**
- "S1 depends on #2520 to #2522 merged": none has merged. PRs #2594, #2600 and #2602 are open.
- "Retired: #2548": the agenda comment keeps #2548 going as its own task. Folding it into S3 is this outline's
  choice; #2548 stays open with its own acceptance until the coordinator edits it.
- "Finishing where they are" omits PR #2441 (unparked on 16 Nov, being rebased), PR #2628 (the wide runner) and
  the two fixes of #2615 (#2621, #2622, both closed).
- #2553's second half (memory per Soul) waited on the Scaling tranche's task A13, which has merged; the list
  shows only PR #2612.

## Checked facts used by several tasks

In this file "fact 1" to "fact 8" are the rows of this table. They were labelled F1 to F8 before the final pass;
F1 to F11 are lane F's tasks, and the one lane F task named in this file is the gate F7 (the Soul Actions cases
pass from outside), in X2's "Depends on".

| Fact | What | Source |
|---|---|---|
| 1 | One k6 instance carries 30,000 to 40,000 virtual users only with the system tuned; each costs 1 to 5 MB; above 80 % of its processor the generator's own numbers are wrong | https://grafana.com/docs/k6/latest/testing-guides/running-large-tests/ |
| 2 | Coordinated omission: a generator that waits for a slow answer before sending the next request skips exactly the samples that would have been worst. The cure is a fixed schedule, with latency counted from when a request was due | https://github.com/giltene/wrk2 and https://github.com/tsenart/vegeta |
| 3 | Each connection needs a file descriptor and a local port. One source address reaches one destination on about 28,000 ports by default and about 64,000 when the range is widened; past that, add source addresses | https://gatling.io/blog/scaling-load-tests and fact 1's page |
| 4 | A load test from one place exercises a small part of one edge location of a CDN | https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/load-testing.html |
| 5 | Cloudflare (the CDN `docs/operations/cdn.md` names) asks no permission for a simulated attack on your own, unshared zone; its self-serve terms limit a disproportionate share of non-page files; WebSockets end whenever it restarts its servers | https://developers.cloudflare.com/ddos-protection/reference/simulate-ddos-attack/ , https://www.cloudflare.com/service-specific-terms-application-services/ , https://developers.cloudflare.com/network/websockets/ |
| 6 | Resolvers and browsers keep a DNS answer past its stated life, and an open connection never follows a DNS change | https://codemia.io/archive/dns-resolution-in-the-browser-and-beyond |
| 7 | After a switch, what is written on the new side does not exist on the old one; a way back that was never rehearsed is unknown | https://www.bytebase.com/blog/database-blue-green-deployment/ |
| 8 | A Node worker's `resourceLimits` bound its JavaScript heap only, not buffers | https://github.com/nodejs/node/commit/89c837a48d |

---

# Lane X · Gates and the cut-over

## How every gate in this lane is run

1. **The world** is Eden's built content as N1 imported it (about 5,000 things), never the small test world.
2. **The machine** is the gate machine the coordinator names in the issue, by the neutral label it has in
   `v2/docs/machines.md` (O14). It is never the production host; only X5 runs on the real path, in the owner's
   window. Each program (world, gateway, view tier, origin, each driver) has cores of its own, and the plan is
   posted.
3. **The declaration** is one comment on the task issue, posted before the first run and never edited: the
   bars (the numbers in the task), the arms, each shape with its seed and what it offers (acts a second, the
   busiest tenth's share, the largest burst), the build hash, the machine by its label, and the stop
   conditions. Its link goes into the posted table. A run with no declaration, or with one edited afterwards,
   is void. Nothing is re-scored.
4. **Arms.** Even is the `uniform` shape and uneven is `event`, both from
   `tools/bench/capacity/profiles/shapes.json`. Viewers arrive in waves and leave after a heavy-tailed stay, from
   that file's `viewers` section. Two repeats per arm, shown as a range.
5. **Latency** is counted from when an act or a fetch was due by the schedule (fact 2).
6. **A void arm.** A driver above 0.8 of its cores (fact 1), or an arm that offered under 95 % of its intended
   acts, measured the bench. It is marked void, not passed.
7. **Posted:** one table per arm with both repeats, the artifact, the logs, and one paragraph naming the part
   nearest its limit.
8. **A finding, not a pass:** a missed bar; a restart, a halt or a stuck Soul; anyone refused, queued without end
   or sent elsewhere (a bar met by a cap, a queue or a redirect is failed); a result far from the expected number
   in either direction. Each finding is one proposed task. A gate fixes nothing.
9. **Acceptance** is the four gate boxes of rule 11. A gate is finished when it is scored, whatever the score,
   so a missed bar never blocks the merge of the bench that found it. X2 differs in one way: X7 waits for X2's
   bars to pass, not only for X2 to be scored.
