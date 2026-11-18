# Engine v2 + Scaling: the final audit, and the planner's rulings

16 to 17 Nov 2026. Five independent audits were run on the whole tranche before hand-over. Their full reports
are beside this file: `AUDIT-consistency.md`, `AUDIT-inheritance.md`, `AUDIT-process.md`, and the "Changes made
at the final audit" sections at the top of `tasks/E-expressiveness.md` and `tasks/Z-added-at-reconciliation.md`.
This file records what they found, what was ruled, and what remains for Gene.

## What the audits found

| Audit | Finding | What was done |
|---|---|---|
| Dependencies (by script) | 191 tasks, every dependency exists, none on a later stage, no cycles, longest chain 17 | Re-run after every change |
| Consistency | 89 of 153 lane tasks still stated a rule that a later decision had changed (the engine waiting on conditions; nothing set on the ground; the copy holding only counts; a directory in one database file) | Amended in place, each with an "Amended at the final audit" line |
| Facts, lane E and the added tasks | 38 tasks the planner wrote had never been fact-checked | Rewritten to the standard of the other lanes, with sources |
| Inheritance | Of 123 things people or operations rely on today, 47 had no home. The chain held to the goal gate and broke at the cut-over: nothing installed the new programs on the production machine, routed the public address, released the code, packaged the client, or moved accounts | 18 tasks added (`tasks/P-product-whole.md`), 10 amended; drops and decisions listed for Gene |
| Process | Not fileable as written: no acceptance checklist the repository's proof check can read; no rule for how `v2/` is tested and tiered; bodies citing files a lane's worktree lacks; nine tasks a lane cannot finish alone; 52 first steps with no hand-back condition | `FORMAT.md` changed; every task given an acceptance checklist; a first task (K15) for the repository's rules; owner's steps moved to a checklist |

## Rulings on the open questions

Planner's calls, made so that developers are not left to guess. Any of them is Gene's to overturn.

| Question | Ruling |
|---|---|
| Is a move on a named beat a start time? (B8) | No. Inside a joint activity a move may name one of that activity's next beats, at most about two seconds ahead. It is a parameter of a move already accepted, not an order waiting on the world |
| May a queue name what is done at its head? (B7) | Yes: "queue for this seat and sit", "queue and board". That is the body waiting its turn |
| Standing consent ("I accept high fives") | A rule in the Soul's own client. It works only while the owner's machine is on, like every reflex |
| Is ordinary speech public? | Yes, with a short reach. A whisper has an audience of one |
| What survives a restart? | Nodes and links do, so a joint activity and a moving group survive. Skills in progress are handed their intent again (K13) or end by name |
| Things held or worn when a Soul travels | What the Soul owns goes with it. Anything else must be put down first; the move is refused by name until it is. A fork carries no bodies; what they held is set down where they stood |
| A creator driving a world's body (I12) | The recorded actor is the creator. Sequence numbers are per actor |
| The code hatch (F8) | One WASM interpreter inside the shared library. No scripting language |
| A failed disk (O10) | The world's time is owed while nothing can be written, then paid exactly. Accepted |
| A world's pinned build | A field of the world's record in the directory (W8, T11) |
| R12, the skill an agent installs | Moves to win 3: the win 3 gate needs it |
| The account store (W1) | Stays one small database file, backed up off the machine (O20) |
| What the cut-over waits for (X7) | The goal gate (X2), the inheritance walk (X12), the request battery (E17), the front door (O19), and a client that upgrades itself (R18) |
| The trunk stop | Held by stage: no win 2 task is dispatched before T12 is signed. Stated in the spec |
| Does a thing a Soul set down last? | Its kind says how long a loose thing of that kind lasts once nobody holds or owns it: a sofa for ever, a pie a few days. Owned, or in a slot, it lasts |
| Does a swap have stakes? (E24, T11) | No. Stakes means travel between worlds and anything Gene names later |
| The tier of work under `v2/` | Ordinary tests and a posted table until the cut-over; the strict tiers switch on for the core at the cut-over (K15, X8) |
| Ceilings that look too small | Kept at four hours at most, each with a hand-back point written in. Two were split: the encoding profile out of T3 (T0) and world-owned bodies out of I12 (I13) |
| Bars that did not add up (X2, X3, X4, I3, I11, V3, G1) | Corrected in the tasks |

## For Gene

**Decisions that change the plan**

1. **Every owner approves once more at the cut-over.** No token is copied across, so each Soul's owner approves the new client once. Who tells them, and when?
2. ~~A body whose agent has gone.~~ **Decided by Gene, 17 Nov:** keep today's wind-down as the one exception to the rule that the world never chooses for a Soul (task B16).
3. **Login once per computer,** decided 12 to 14 Nov. Carry it at the cut-over (one task, about 3 h), or one approval per Soul for now?
4. **Handing a world to someone else, and archiving one.** No task builds either.
5. **The camera a visitor lands on.** The broadcast camera is carried (V20). If you would rather open on a free camera, V20 shrinks.

**Dropped unless you say keep:** the MCP endpoint; prayers and answers; the feedback form; visitors' page-error reports; the music radio unless it carries over unchanged; building with joined parts.

**Kept in a reduced form:** the local dashboard if it reads the new folders unchanged; platform news as the release item only; the place where a classifier can hold an upload, with none plugged in.

**Your approvals the plan expects, in one place:** the repository's rules for `v2/` (K15); the trunk pages (T12); the machines (O14); the CDN and its price (V2); the window for the real-path rehearsal (X5); reading production backups (X6, X11); installing beside production (O17); the switch (X7); the deletion (X8); each other world, after you have told its owner (X10).

## What is still not proven

Nothing has been run. Every outcome is a bar to be measured. The writers' own lists of facts they could not verify are at the top of each task file and stand. The private list of machine names the publication check can use is absent, so the check passed on patterns only.
