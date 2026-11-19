# Lane O · Operations (O1 to O14)

Draft, local only, 16 Nov 2026. Written to `v2/docs/tranche/FORMAT.md` (K15 puts the tranche's rules there). The
trunk is `v2/docs/TRUNK.md` (T7 and T11 matter most here). This file becomes `v2/docs/tranche/O-operations.md`,
which is what a task means by "the lane notes". O15 and O16 are in `Z-added-at-reconciliation.md`; O17 to O20
are in `P-product-whole.md`.

## Changes at the final pass

Every task: an `**Acceptance.**` list of at most five boxes added at its end (rule 11); Step 0 says what result
means "stop and hand back" (rule 12); citations of the local trunk, format and design files replaced by
`v2/docs/TRUNK.md`, `v2/docs/tranche/FORMAT.md`, `v2/docs/tranche/O-operations.md`, or by the fact itself (rule
16); no reference to a section of the design is left; Touches narrowed to modules and files (rule 17). No ID,
main purpose, stage, ceiling or kind changed. Beyond that:

| Task | Change | From |
|---|---|---|
| Preamble | The runbook is one page per situation under `v2/docs/runbook/`, with O13's index, in place of one file every O task appended to. A line on the Linux runner and a line on the owner's checklist added. Flags 3, 4 and 6 brought up to date. The word-count line removed (it no longer holds) | Process audit, "files that more than one task edits"; rule 15 |
| O1 | The pin is read from the world's directory record (the machine's cached copy, so a store out of reach holds no world down). A world that keeps failing is retried for ever with gaps of at most 30 s and reported as `restart-loop`; a pin naming a build not on the machine is reported and retried, never held. Seven outcome clauses grouped into five boxes. Step 0 hands back with no Linux runner named | Brief; ruling "a world's pinned build"; process audit |
| O2 | Step 0 hands back with no Linux runner named. The citation of the design restated | Process audit; rule 16 |
| O3 | The cost bar is stated: one piece about every 10 s, about $1.17 a month in upload fees for a world that never rests; pieces, checkpoints and V3's packed objects together under V3's $2. The seal age changed from 5 s to "10 s less the upload's measured time", because 5 s doubles the uploads and breaks the bar. A footgun on checkpoints shipped as many small objects. A hand-back point for checkpoint shipping | Brief; consistency audit question 18 and 19 |
| O4 | Touches gains the one optional field in `v2/crates/replica`, which the design already required. A fifth box: the log hash is equal with stamping on and off | Rule 17; the task's own footgun |
| O5 | The lag bound has a number (proposed: 2 s with no fault active, nothing owed 5 s after a fault clears). The run is a step of K1's CI script, not a new job in `ci.yml`; the nightly run is its own scheduled workflow. Gate boxes. A failing seed does not block the merge of the simulation | Process audit, gate table and section 2 item 3; rule 11 |
| O6 | Written as two steps: the lane declares the run and starts it on a timed runner as a transient unit, then stops; a second short dispatch after the declared end collects and posts the table. The kill at hour 23 is made by the run itself. "Flat" defined. The 24-hour Linux runner is on the owner's checklist | Brief; process audit, "split" table |
| O7 | The pin is changed in the directory record. Eight outcome clauses grouped into five boxes. Step 0 hands back with no Linux runner named. Design-section citations restated | Process audit; rule 16 |
| O8 | Rule citation repointed; `load.md` given its path | Rule 16 |
| O9 | The second machine is on the owner's checklist; two isolated instances on one machine stand in. A hand-back point for the kill table | Rule 15; ruling on ceilings |
| O10 | The ruling on a failed disk written in (time is owed, then paid exactly). Step 0 hands back if K4 cannot report a failed write | FINAL-AUDIT ruling; rule 12 |
| O11 | No change of substance | |
| O12 | Bars declared in a comment before the run. Two repeats per arm (four runs), where one even and one uneven run were called "both repeats". The scratch bucket and the public name after a real loss are the owner's | Process audit, gate table; consistency audit (O12, left); rule 15 |
| O13 | The page is the index `v2/docs/runbook/README.md` over the pages each task left, O17 to O20 among them. The walker is a second agent the coordinator dispatches. A lane proposes parking; the coordinator parks | Process audit, "fix in place" |
| O14 | Title is now "The machines written down and sized". The lane writes the script, the record and the priced table, and says whether today's system and the new one fit on the production machine together for the cut-over's rollback window. Running the script on a machine, the yes or no, and any purchase are on the owner's checklist. Provider names stay out of the machines page | Brief; inheritance audit, "changes to tasks that exist"; process audit; rule 15 |

**Could not resolve.**

1. **O5's lag bound and O6's "flat"** are numbers I proposed (2 s; within 5 %). No earlier text gave them.
   The planner should confirm or replace them before filing.
2. **O3's loss bar against its cost bar.** "At most 10 s of acknowledged acts lost" and "one upload every 10 s"
   fit only if the seal age is 10 s less the upload's time, so a busy world uploads slightly more often than
   every 10 s (about $1.17 to $1.30 a month). The task says so. If $1.17 must be exact, the loss bar becomes
   "10 s plus one upload".
3. **Waits on a declared run.** O6's ceiling (2 h) counts the lane's two steps and not the day between. The
   spec must say that time waiting on a declared run is not counted, as the process audit asked.
4. **The timed-run command for `v2/`.** O6 uses one `v2` command in `.github/scripts/timed-run.mjs` that the
   process audit says the first gate's bench should add (I10 or N15). I could not see that either task does.
5. **O15 and O16** (in the Z file) still name `v2/docs/runbook.md`. Under this file's rule each writes its own
   page under `v2/docs/runbook/`.
6. **`v2/crates/supervisor`** is still absent from the folder table of `v2/docs/tranche/FORMAT.md` (flag 5 below).

Checked after the other files were rewritten: V3's bar now reads "under $2 a month", with O3's $1.17 counted
inside it, which is what O3 says.

## Changes to the outline

| Task | Change | Reason |
|---|---|---|
| O1 | Outcome given numbers: back within 2 s, neighbours unmoved, and a world crashing in a loop is retried for ever with at most 30 s between tries | "Restarted alone" had no measure. Today's breaker rests a world 10 minutes to an hour after 5 failures; by the standing rule that is a frozen world |
| O2 | Outcome sharpened: the due change is committed within 1 s of its due time, with 100 alarms spread and 100 in one second; alarms survive a restart and a reboot; an intent to a sleeping world is answered within 3 s | "Wakes within 1 s" did not say of what. Today's measured failure was on exactly this path |
| O3 | Depends on: + V3. Outcome: + the lost count agrees with the driver's receipts; no irreversible act acknowledged past the mark; a still world uploads nothing | V3 (win 4) builds the first uploader and the bucket layout; a second one would fork the format |
| O4 | Outcome given numbers (parts sum within 1 ms; under 2 µs an act; health updates with the clock thread stuck) | Not measurable as written |
| O5 | Depends on: + I4, N10, O2. Outcome: + 15 minutes of CI, + a planted bug is caught | Each invariant needs its subsystem; a simulation has to be shown to find a bug |
| O6 | Depends on: + O1, O4. "Flat" defined | The memory numbers come from O1's limits, the tick numbers from O4 |
| O7 | Depends on: + I1, K6. Outcome: three planted bad builds, 60 s, and a refusal by name when the old build cannot read what the new one wrote | "Sockets held" is the gateway's; the rehearsal needs a fork; "bad build" was undefined |
| O8 | Depends on: + I8, I10. Outcome: + bars for honest agents | "99 % of ticks on time" is met by refusing everybody |
| O9 | Outcome: + a kill at each step leaves exactly one owner and the world serving within 10 s | No world is ever left without an owner |
| O10 | Ceiling 3 → 4 h. Depends on: + K7. "Never a halt" spelled out; recovery unattended | Three separate faults; re-anchoring the clock is K7's |
| O11 | Outcome: + the parts sum to the machine's price; a part not metered says so | Otherwise it cannot be wrong |
| O12 | Depends on: + W8. Outcome: + at most 10 s lost, counted; state hash equal | A restore must raise the epoch |
| O13 | Outcome: walked by an agent that did not write it. Each O task writes its own page | Keeps the 1 h ceiling honest |
| O14 | Row unchanged. The task prices and proposes; it buys nothing | Gene's yes |

**Flags (I changed nothing in the trunk):**

1. **The directory must outlive the machine a world ran on (T11, W8).** O9 and O12 need that. Settled at
   reconciliation (`v2/docs/TRUNK.md`): its truth is a few small objects in the object store, written
   conditionally so only one writer wins; machines keep a cached copy; there is no extra database. A W8 that
   keeps it in one database file on one machine does not meet this, and O9's and O12's Step 0 hand back.
2. **O4 needs one optional numbered field in the answer message (T10, T6).** Timings must stay out of anything
   hashed.
3. **O3's ten-second pieces cost about $1.17 a month** in upload fees at $4.50 a million, for a world that
   never rests. V3's bar is now "under $2 a month" for the busy world's whole month of writes, which the pieces
   fit inside. A store with no upload fee, or a tail sent to a second machine once O9 exists, would remove the
   line.
4. **The design's cost table** assumed one 1 Gbit link carries 20,000 viewers. It carries about 12,000. See
   "Checked facts".
5. **The folder table of `v2/docs/tranche/FORMAT.md` has no folder for the supervisor.** I used
   `v2/crates/supervisor`.
6. **A failed disk and "world time never stops" (O10).** A world that cannot write cannot advance. It owes the
   time and pays it exactly, as today's worlds do across a restart. Ruled at the final audit: accepted.
7. **O7 and T10:** changing a world's pinned build means every client reloads the checking library by hash.

**Missing tasks I proposed, and where they went:**

- **The three seams, as acceptance lines and not a new task.** The K lane says the fake disk and fake time
  are K4's storage interface and K7's time interface. Nobody owns the network's. K4, K7 and I1 should each say
  "takes it as an argument, and a fake exists"; otherwise O5's Step 0 fails and the simulation is a retrofit.
  K4 and K7 now say so; I1 had no such line at the final audit.
- **Someone is told:** now task O15, in `Z-added-at-reconciliation.md`.
- **Upgrading the gateway itself:** now task O16, in the same file.
- **Installing on the production machine, releases, the front door, backups of what is not in the log:** now
  tasks O17 to O20, in `P-product-whole.md`.

No task should go. O13 stays small because each task writes its own runbook page.

**Amended at the final audit:** flag 1 states what the trunk settled for the directory (conditional objects in the object store, a cached copy on each machine, no database); the proposed tasks are marked with the IDs they now have; the seams note says which tasks carry their line; the word list below gives the directory its full T11 meaning.

## What every task in this lane keeps

- **Words.** **systemd** is Linux's service manager; a **unit** is its description of one service. A **cgroup**
  is the kernel's box around a process's memory and processor use. The **supervisor** is our one program per
  machine that decides which worlds run. The **directory** is T11's shared record: where each world runs, its
  **epoch** (a number that rises each time a world changes writer), its pinned build, when it must wake and
  where each Soul is. Its truth is a few small objects in the object store, written conditionally; each machine
  keeps a cached copy. A **bucket** is a folder in object storage (files kept by a provider, reached over
  HTTP). To **sync** is to force written bytes onto the disk. A **pin** is the build hash a world's directory
  record names. A **canary** is the one world that takes a change first.
- **Today's operations** are on `main`: `docs/operations.md`, `docs/architecture/load.md` (section 4),
  `docs/architecture/worlds.md`, `docs/release.md`, `tools/world-launcher/keeper.mjs`, `guard.mjs`.
- **Linux only** for O1, O2, O6, O7, O10: cgroup version 2 and a recent systemd (`systemctl --version`; the
  growing restart delay is absent in old ones). A macOS laptop cannot prove them. The coordinator names a Linux
  runner in the issue; with none named, Step 0 hands back.
- **Production is never touched.** Tests use a scratch folder under `.local/`, and a local stand-in for the
  bucket unless the coordinator names a scratch one.
- **No hold.** Nothing in this lane may keep a world down or resting. Retry, fall back, say so loudly.
- **No device details** (host names, addresses, paths, provider ids) in any pull request or page. Machines
  are named by neutral labels ("production host", "runner A").
- **What only the owner can do is not the lane's work.** A purchase, a yes, a machine named, anything on
  production: the task says "Waits for the owner's checklist: <what>", and its acceptance holds only what a
  lane can do and prove.
- **A task that adds an operator command** writes its own page, `v2/docs/runbook/<situation>.md`: what you
  see, the one tested command, what you then see, how to undo. One page per situation, so no two tasks edit
  one file. O13 writes the index.
- **A measured outcome** is declared in a comment on the task issue before the run: the bars, the build, the
  seeds, the machine by its label. Two repeats.

## Checked facts (fetched 16 Nov 2026; re-check on the day)

| Item | Figure | Source |
|---|---|---|
| Hetzner AX42: 8 cores, 64 GB, 1 Gbit, unlimited traffic | €79 to €99 a month, €49 set-up | https://www.hetzner.com/dedicated-rootserver/matrix-ax/ |
| Hetzner AX41: 6 cores, 64 GB | €59 a month | same |
| Hetzner AX102: 16 cores, 128 GB | €159 to €259 a month, €129 set-up | same |
| Hetzner 10 Gbit link add-on | €43 a month; 20 TB out included, then €1 a TB; unlimited traffic no longer applies | https://docs.hetzner.com/robot/general/pricing/price-list-for-additional-products https://docs.hetzner.com/robot/general/traffic/ |
| OVH Advance-2 (2024): 8 cores, 64 GB, 3 Gbit unmetered and guaranteed | $198 a month; set-up equals one month | https://us.ovhcloud.com/bare-metal/advance/ |
| OVH Advance-1 (2024): 6 cores, 32 GB, same link | $147 a month | same |
| Cloudflare R2 | $0.015 a GB-month; uploads and lists $4.50 a million; reads $0.36 a million; no charge for bytes out; free each month: 10 GB, 1 million, 10 million | https://developers.cloudflare.com/r2/pricing/ |
| Backblaze B2 | $6.95 a TB-month; upload, download and list calls free; bytes out free to three times what is stored, then $0.01 a GB | https://www.backblaze.com/cloud-storage/pricing |
| Hetzner Object Storage | €6.49 a month with 1 TB stored and 1 TB out; no request fees; then €1 a TB out | https://www.hetzner.com/storage/object-storage/ |
| R2 uploads in parts | Each part at least 5 MiB and equal, at most 10,000 | https://developers.cloudflare.com/r2/objects/multipart-objects/ |

**Sizing, worked out when the engine was designed; none of it measured:**

| | One world: 1,000 agents, 20,000 viewers | 100 quiet worlds |
|---|---|---|
| Simulation and gateway | Under 2 cores (worked out) and about 1 GB (a guess): one AX42 | The same AX42. Asleep: nothing. All awake at 60 to 100 MB each: 6 to 10 GB of 64 |
| Viewers | 1.3 to 1.6 Gbit a second at peak, 52 to 65 TB a month, 40,000 to 80,000 requests a second (two to four files a second each). Either the 10 Gbit add-on (€43 + €32 to €45 over the 20 TB = €75 to €88), or one OVH Advance-2 carrying everything ($198), or two to three 1 Gbit cache machines (€59 to €99 each), or a CDN with no request fee (V2 proves it) | None |
| History | 0.75 GB a day, 274 GB a year: $4.11 a month on R2, $1.90 on B2, for each year kept | Under $1 |
| Uploads, one every 10 s while busy | 259,200 a month: $1.17 at $4.50 a million, nothing where uploads are free | Near nothing |
| **Total a month** | **About €155 to €190 on Hetzner, or about $200 on OVH** | **About €80 to €100** |

**Not verified:** Hetzner's 2026 price rises (sources disagree; the figures above are the live page); that R2
has no append call (its pages list none); that B2 rejects `If-None-Match` on upload (one third-party report);
which systemd version first had `RestartSteps=` (254 or 255); what Antithesis costs; 10 Gbit unmetered prices
elsewhere ($284 to $799 a month in search results only).

---
