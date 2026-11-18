# Engine v2 + Scaling: the inheritance audit

Draft, local only, 16 Nov 2026. One question: does this tranche end with a system that can take over from
today's, with nothing people rely on left behind by accident?

Read for it: `INDEX.md`, `TRUNK.md`, `FORMAT.md`, every task's title, main purpose, outcome and "Stays out"
(all 191), and lanes X, Z, O, G and W in full. Today's system was read from `origin/main` at `ee208bfdb`
(the documents named in the brief, the three served skills, the Soul client's skill, and the file lists of
`apps/`, `packages/`, `tools/` and `.github/workflows/`). Nothing was run.

## The answer in short

**The engine is covered. The product around it is not yet.** Of 123 things people or the operator rely on
today, 62 have a task here, 8 belong to Soul Actions, 6 are dropped by a recorded decision, and **47 have
no owner**. Fourteen of those 47 stop the cut-over itself; the rest are things a tester would notice missing,
or small things that need a yes or a no from Gene.

**Why the gap exists.** The first design (`SPEC-20261116-engine-v2.md`) put the new core inside today's
server, so sign-in, pages, the launcher, the keeper, releases, the skills and the docs all stayed as they
were. It also had a task for exactly this audit (E0, "every route, command and page feature assigned or
retired"), one for the skills and docs (C7), one for Eyes (C8), one for the core in CI and in a release (H2)
and one for the gates (H7). Revision 2 replaced the whole server and web app, and cut "the whole same-as-today
lane". Those five tasks went with it and nothing took their place. The lane writers saw parts of this: the
lists headed "Not covered by any listed task" in `tasks/G-W-worlds-and-web.md`, and "Missing tasks" in
`tasks/I-R-intents-and-replica.md` and `tasks/O-operations.md`. The twelve tasks in
`tasks/Z-added-at-reconciliation.md` closed about half of what they listed.

**The chain holds up to the goal gate (X2) and breaks at the cut-over.** X7 depends on X2, X5, X6, O7 and
O12. It depends on no task that makes the product whole (the pages, the skills, the client's delivery, alerts,
the runbook), and three things it needs are built by nobody: the new programs installed on the production
machine, a front door that routes to them, and a way for a client already on someone's laptop to become the
new client. Section 2 walks it.

---

## 1. The inventory

**Status** is one of four. `v2`: a task in this tranche carries it. `SA`: Soul Actions writes it as content.
`Dropped`: a recorded decision removes it. `UNOWNED`: nothing carries it and no decision drops it.
For an UNOWNED row, **weight** says how much it matters: `cut-over` (the switch cannot honestly happen without
it), `noticed` (a tester would see it gone), `small` (ask Gene; a drop is likely fine).

### Souls and their agents

| # | What people rely on today | Where it goes | Status |
|---|---|---|---|
| 1 | A Soul's mind runs in its owner's own agent; the world only admits, refuses and reports what happened | T10, I1 to I4, I7; `FORMAT.md` rule 10 | v2 |
| 2 | One line starts it: the agent reads a skill, creates or reconnects a Soul, and acts | R12 | v2 |
| 3 | The world serves the instructions, the skill and the client at its own address (`/instructions.md`, `/skill.md`, `/llms.txt`, `/eden.mjs`) | None. R12 writes the skill; nothing packages or serves the client (K1 keeps "packaging" out) | UNOWNED · cut-over |
| 4 | Create a Soul by name; the owner approves once in the browser; the token is never shown to the model | W1, W2, I1, R6 | v2 |
| 5 | Read the world from a local copy: where I am, who and what is near, the whole town, find by words | R1, R3 to R5, R7, E1, E19 | v2 |
| 6 | Act by id; a receipt and a named end; a retry never acts twice; a refusal says why and what would work | I2, I4 to I6, F2, E16 | v2 |
| 7 | Plans with no model turn between steps; "can I?" answered locally; waiting without polling | I9, R2, R8, R6, R7 | v2 |
| 8 | Wake rules within a budget, reflexes, routines and reminders, the cost of each achieved intent | R13, R9, R15, E7, R10 | v2 |
| 9 | Several Souls in one home; moving a Soul between machines (free when no agent is connected, refused naming the device, forced with `--move`) | R6, W2, I12 | v2 |
| 10 | Travel to another world and home again | X9 | v2 |
| 11 | The MCP endpoint for apps that take only a URL (`/mcp`, the `eden_*` tools; public page `docs/site/mcp.md`) | None | UNOWNED · small |
| 12 | The older steering API, intents v2, mandates, cards, the central mind, the legacy `eden-agent.mjs` | Design requirement A9 (no conformance to today's API); minds stay at the edge; #1754 | Dropped |
| 13 | Menus the server builds for each Soul (`here` offers) and exact route planning | Gene, 16 Nov (`FOR-COORDINATOR-20261116-engine-v2.md`): replaced by the local copy, ranked fallbacks and steering | Dropped |

### The client and the Soul's home on the owner's machine

| # | What people rely on today | Where it goes | Status |
|---|---|---|---|
| 14 | The `.souls` home found like `.git`, credentials at mode 0600, one resident process per Soul that outlives the chat | R6 | v2 |
| 15 | The client says when a newer one is served, upgrades itself and the skill, keeps one version back, trusts only its first site. Installed clients upgrade through a frozen path (#1938: `/v1/config` `soulClient`, `/eden.mjs`, `/skill.md`, the 426 answer) | None. R5 and R6 keep self-upgrade out; X7 says only "a named answer telling them to update" | UNOWNED · cut-over |
| 16 | A Soul already paired in someone's home keeps its folder, its memory and its identity | None. X6 is the server side and keeps memories out; R14 assumes "no migration" although Soul and place ids change at the clean start | UNOWNED · cut-over |
| 17 | Memory: the log and its pages, people and promises, the brief before each turn, the owner's digest, opt-in consolidation | R14, R7 | v2 |
| 18 | Home commands: `list`, `default`, `adopt`, `doctor`, `export`, `import` | None. R7 names `status`, `look`, `find`, `act`, `wait`, `stop` | UNOWNED · noticed |
| 19 | The local read-only dashboard (`dashboard`) | None (R10 keeps dashboards out) | UNOWNED · small |
| 20 | Platform news reaching every client (`news`, the site feed) | None | UNOWNED · small |
| 21 | Login once per computer (`login`, `accounts`; `adopt` and `pair` with no window code) | None. Decided 12 to 14 Nov (#2242 to #2246); W2 builds one approval per Soul | UNOWNED · noticed |

### Speech and social features

| # | What people rely on today | Where it goes | Status |
|---|---|---|---|
| 22 | Saying something: who hears it, viewers see it, a whisper, a shout, a private exchange | B11, E13, T8, R4, W4 | v2 |
| 23 | A conversation: a group Souls join by consent, whose turns its members can read later | None. B11 keeps "conversations" out. Nearest: B5 and E8 (joining), R16 (the past) | UNOWNED · small |
| 24 | The town calendar: a Soul announces an event, everyone reads what is on | Reading: E6, E7. Announcing: none (B11 keeps "the calendar" out) | UNOWNED · small |
| 25 | Offers and consent between Souls (a hand-over, holding hands, a game, an invitation) | B5, E8, E24 | v2 |
| 26 | The owner writes to their Soul from its page and sees "thinking", the act under way, the result | The client's half: R13. The page and the server's half: none (W4 keeps "owner controls" out). The I and R lane calls this "today's main loop" | UNOWNED · cut-over |
| 27 | Prayers to the world's creator, and answers | None | UNOWNED · small |
| 28 | A Soul's public status line and biography; what happened while the owner was away | W4, W6, R16 | v2 |
| 29 | The owner edits a Soul's name, description and photo, disconnects its agent, retires it (with a click), sees connected agents | None. W2 and W4 keep these out; W9's outcome lists none of them | UNOWNED · noticed |
| 30 | The owner chooses a Soul's body and look (the look editor; presets such as the Little Martian and creature bodies) | The engine's side: B12, B13, E15. Choosing: none | UNOWNED · noticed |
| 31 | A custom body, uploaded and checked | B13, G6 | v2 |

### What bodies can do

| # | What people rely on today | Where it goes | Status |
|---|---|---|---|
| 32 | Walk anywhere: doors opened on the way, stairs, upper floors, far places | N3 to N8 | v2 |
| 33 | Nobody is ever stuck; nothing teleports | N10, K11, E16, O5 | v2 |
| 34 | Sit, lie and rise; one body per seat | B3, E3 | v2 |
| 35 | Jog, run, wade and swim; rides and boats, with steering | N11, N12, E12 | v2 |
| 36 | Pick up, carry, put down, hand over; two Souls carry a long load | B4, E4, E24, B9, B14 | v2 |
| 37 | Building with parts that join and bear load (rack bays, connectors, the `support.none` rule) | None. The Soul Actions "Mars build" tasks were marked "call off or wait" in a planner's note, not by Gene | UNOWNED · small |
| 38 | Gestures, manner and gaze; a handshake, a dance, holding hands | E10, E11, B11, B5, B8 | v2 |
| 39 | Body families and sizes (people, small bodies, creatures, floaters) | B12 | v2 |
| 40 | Any thing used by hand from data: reach, the effect once, state that survives a restart, values that change with time | F1 to F6, F9 to F11, E18, E14 | v2 |
| 41 | Lights and fire; doors, windows, locks, knocking | Soul Actions (X3, X18, X25) | SA |
| 42 | Water and the garden | Soul Actions (V4a to V6, X2, X29) | SA |
| 43 | Things and containers: drawers, lockers, a swap shelf, lost and found, a pantry | Soul Actions (X14, X26, F12) | SA |
| 44 | Writing: boards, notes, books, a guestbook, posters, paintings, chalk | Soul Actions (X6, X7, X11, X34) | SA |
| 45 | Music and play: instruments, duets, a jukebox, records, checkers, frisbee, juggling | Soul Actions (X9, X15, X16, X31, X32, D7), on B8 and F8 | SA |
| 46 | Food and drink: tea, coffee, eating | Soul Actions (V1a to V3, X1, X13, X30) | SA |
| 47 | Eden's own things and its 1,365 activity spots | Soul Actions (X24 to X35, E11, E12) | SA |
| 48 | What a Soul perceives of the things near it; a closed container hides what it holds | R4, E22 | v2 |
| 49 | A body whose agent has gone: it idles, and after an hour walks out of town and sleeps | None. It conflicts with `FORMAT.md` rule 10 (the world never chooses for a Soul) and nobody has said which wins | UNOWNED · noticed |

### God mode and world building

| # | What people rely on today | Where it goes | Status |
|---|---|---|---|
| 50 | One creator per world, who pairs their agent with one skill | G7, G9, W2 | v2 |
| 51 | Edits in batches (place, move, set, remove), a dry run, placing by relation, undo and redo, builds with steps | G1, G4, G7, E2 | v2 |
| 52 | An edit that would bury or cut off a Soul is refused | G2 | v2 |
| 53 | Terrain, water and weather; the ground and the walkers follow | G3, G5, E6 | v2 |
| 54 | Searching the library of kinds of thing | Soul Actions (C1, C2) | SA |
| 55 | New kinds and the creator's own models; rules on things (hours, ownership, access) | G6, K3, F6, E7; authoring an entry is Soul Actions P8 | v2 |
| 56 | The creator's panel: place and drag by hand, undo | W5 | v2 |
| 57 | The creator writes to their agent from the panel | None (G7 keeps "panel messages" out) | UNOWNED · noticed |
| 58 | A picture of the world for an agent: the creator's `look`, a Soul's `view` and `shoot` | None (G7 keeps "pictures of the world" out) | UNOWNED · noticed |
| 59 | The upload gate (limits, private data stripped); hiding an upload or a world; edit limits | G6, W9, T8, I8, O8 | v2 |
| 60 | The classifier hook that can hold an upload for review | None (G6 keeps "a content classifier" out) | UNOWNED · small |
| 61 | The world's picture on the list, set by its owner | W3 shows a picture; nothing sets one | UNOWNED · small |

### Worlds, templates and travel

| # | What people rely on today | Where it goes | Status |
|---|---|---|---|
| 62 | The list of worlds; a new world from a template; limits per account | W3, G9, W8 | v2 |
| 63 | Real time in the world's own time zone | T5, E6 (choosing the zone when a world is made is not named) | v2 |
| 64 | World time never stops; a quiet world jumps ahead exactly; a still world leaves memory and wakes on time | K7, K9, O2, O10 | v2 |
| 65 | Many worlds behind one site | W8, O1 | v2 |
| 66 | The same addresses keep working: `/w/<slug>/`, the old aliases, the redirects from the two older domains | None. X7 says "the same public name" | UNOWNED · cut-over |
| 67 | Rename a world, take it off the list, close it to visitors | W9 | v2 |
| 68 | Hand a world to another account; archive and restore one | None. The W lane flags both as needing Gene's rule | UNOWNED · small |
| 69 | Each production world's built content, its creator and its Souls | N1, X6, X10 | v2 |
| 70 | Worlds' pasts: event logs, receipts, recorded motion | Gene, 16 Nov: one clean start, history is expendable | Dropped |
| 71 | Re-running history from the intents, as a promise | Design section 6b | Dropped |

### Viewing, cameras and history

| # | What people rely on today | Where it goes | Status |
|---|---|---|---|
| 72 | Watch any world live with no account, on a desktop or a phone, with motion on screen quickly | V1, V2, V5, V12 | v2 |
| 73 | A crowd of animated bodies; things and buildings with their real models | V6, V7, V8, V17 | v2 |
| 74 | The sky, the sun on the world's clock, lights at night, water, weather | None. V8 keeps "water, weather" out and no task draws the sky | UNOWNED · noticed |
| 75 | A free camera | V5 | v2 |
| 76 | Following a Soul; the broadcast camera that picks shots by itself | None. V9 and V15 keep "directed cameras" out | UNOWNED · noticed |
| 77 | Touch controls and the phone layout; finding a place or a Soul and flying there | None (V6 and V12 only measure on a phone) | UNOWNED · noticed |
| 78 | Name plates, Soul cards, speech on screen | W4 | v2 |
| 79 | The sounds of the world, heard where they happen | The content is Soul Actions D7. Playing it: none (V8, V12, V15 and B8 each keep sound out) | UNOWNED · noticed |
| 80 | The music radio (Sim Score) | None | UNOWNED · small |
| 81 | Scrub back, a link to a moment, finding an event, bookmarks; all history kept | V3, V4, V9, W6, T7, V18 | v2 |
| 82 | The owner's and the creator's own near-live view | V13 | v2 |
| 83 | The "bring your agent" card on a world's page: the one line to copy, New Soul | None (W2 builds the approval card only) | UNOWNED · noticed |
| 84 | The feedback form and the world owner's inbox for it | None | UNOWNED · small |
| 85 | The changelog page | None | UNOWNED · small |
| 86 | The public docs at soul.game/docs (run a Soul, build a world, for agents, limits) | None. X8: "Other documents: one proposed task", and that task does not exist | UNOWNED · cut-over |
| 87 | Removing a person's words | W7, T8 | v2 |

### Accounts, pairing and safety

| # | What people rely on today | Where it goes | Status |
|---|---|---|---|
| 88 | Sign in with Clerk; no account needed to watch | W1 | v2 |
| 89 | Existing accounts: the same person is the same account, with the same Souls and worlds | X6 (W1 keeps "importing today's accounts" out) | v2 |
| 90 | The sign-in bridge on the primary sign-in origin, and the satellite set-up that soul.game signs in through | None. W1 says "the provider stays Clerk" and no more. Today the launcher serves the bridge | UNOWNED · cut-over |
| 91 | The approval card (device, code, age); tokens stored only as hashes | W2, I1 | v2 |
| 92 | A dev sign-in for local and test worlds, refused on a public address | None. R11 at win 3 needs a signed-in owner on a test world | UNOWNED · cut-over |
| 93 | Floods and hostile clients held off; limits on making worlds | I2, I8, O8, W3 | v2 |
| 94 | Privacy: owners' words and private fields stay out of public views; site owners | T8, W1, F6, O11, W7 | v2 |
| 95 | Pages refuse framing; API answers are not indexed; robots and sitemap list only listed worlds | None | UNOWNED · small |
| 96 | The model budget per world and the central mind | Minds stay at the edge; the new world makes no model call | Dropped |
| 97 | Admin pause, clock rate and invites | Gene, 12 Nov: world time never stops; invites are off today | Dropped |

### Assets and the CDN

| # | What people rely on today | Where it goes | Status |
|---|---|---|---|
| 98 | Models, textures and media served by hash, immutable; repository media pulled by manifest (`pnpm assets:pull`) | V2, V12, V17; `tools/assets` stays | v2 |
| 99 | The licence records that admit a file to the CDN | `tools/cdn` stays, but no task says the new baked models pass through its records | UNOWNED · small |
| 100 | Creators' uploads served by hash; the upload addresses that exist today | G6, X6 | v2 |
| 101 | Body models, the shared rig, motion clips | V6, V7, B13 | v2 |
| 102 | The builders that turn a kind into a model (`apps/web/src/gen-mesh`) | V8 and V17 run them as tools. X8 deletes the old web app, and its keep-list does not name them | UNOWNED · cut-over |
| 103 | The site behind the CDN: the visitor's real address, the cache rules for the page, a "back in a moment" page when the origin is down | Cache rules for the stream: V2. The rest: none | UNOWNED · noticed |

### Operations, releases, backups, monitoring and analytics

| # | What people rely on today | Where it goes | Status |
|---|---|---|---|
| 104 | The programs installed on the production machine: service units, an unprivileged user, proxy routes, secrets | O1 writes the world's unit. Nothing installs the supervisor, gateway, directory, origin and view tier there | UNOWNED · cut-over |
| 105 | Health, measures, costs, and a message to a person from off the machine | O4, O11, O15 | v2 |
| 106 | A crashed or stalled world restarts; no world is held down; limits per world | K7, O1, O10, O14 | v2 |
| 107 | World data copied off the machine; a restore drill; a blank machine to a serving site | O3, O12, O13 | v2 |
| 108 | A backup of what is not in the log: accounts, token hashes, the removal list, bookmarks, uploads | None. T8 keeps accounts out of the log on purpose; O12 restores "from the archive alone" | UNOWNED · cut-over |
| 109 | Deploy to one world first, roll back by the machine; upgrade the gateway without dropping agents | O7, O16 | v2 |
| 110 | A release from one commit: built once, staged, checked, the changelog and tag written, the news posted; a rollback with no shell on the machine | None for the new programs. O7 moves a pin; nothing builds, carries or records a release | UNOWNED · cut-over |
| 111 | The runbook of tested commands; the spike runbook | O13, X5 | v2 |
| 112 | Visitor counts: cookieless, no query, hash, Soul id or token, automation left out | None. V5 says "if one is added"; the W lane lists it as uncovered | UNOWNED · noticed |
| 113 | Visitors' page errors collected for the operator | None | UNOWNED · small |
| 114 | A staging place and a probe world | O7 (the canary), X7 (the preview) | v2 |
| 115 | Streaming a world live and capturing promo clips | V15 makes clips. The stream tool and the video kit point at today's page | UNOWNED · small |

### Development process

| # | What people rely on today | Where it goes | Status |
|---|---|---|---|
| 116 | CI chosen by changed paths; determinism and architecture rules checked by the build | K1, K7, K12, K14 | v2 |
| 117 | The walk, bundle, replay and conformance gates | Their successors: N15, N18 and O5; V12's byte budget; V18; kinds by hash (T3, K3). X8 retires the old ones | v2 |
| 118 | The full gate that a release head must pass | None. X8 retires the old suite; no task says what a new release head must pass | UNOWNED · cut-over |
| 119 | Proof tiers by path, and the maintainer's sign-off on engine changes | None. `PROOF-POLICY.yml` has no rule for `v2/`, so every change there computes T1: no clip for the page, no sign-off for the core | UNOWNED · cut-over |
| 120 | Proof clips, the e2e harness and the director skill on a local world; one command to run a local world | None | UNOWNED · noticed |
| 121 | Playtests, benches, load shapes, fault drills | X1, R11, E17, I10, X2 to X4, O5, O6 | v2 |
| 122 | The rules in `AGENTS.md`; the merge train and changelog fragments | X8; unchanged | v2 |
| 123 | The repository's own docs: architecture, operations, release, testing, development | None. X8 rewrites two documents and leaves the rest | UNOWNED · noticed |

### Counts

| Status | Rows |
|---|---|
| Carried by this tranche (`v2`) | 62 |
| Soul Actions (`SA`) | 8 |
| Dropped by a recorded decision | 6 |
| UNOWNED | 47 (cut-over 14, noticed 16, small 17) |
| **All** | **123** |

The 14 that stop the cut-over: rows 3, 15, 16, 26, 66, 86, 90, 92, 102, 104, 108, 110, 118, 119.

---

## 2. The chain

### Stage by stage: does each end in something seen working?

| Stage | Ends in | Seen working? | What to watch |
|---|---|---|---|
| Now (lane S) | Gate tables on today's engine, posted on the issues | Yes | Independent of the rest. Worth what testers meet before X7 |
| Win 1 | N15's table and a clip of 1,000 walkers in Eden from above (V14) | Yes, as a top-down debug picture | The N7 and K13 cycle between stages was found and settled by the lane writers (K13 follows N7) |
| Trunk stop | Eleven pages Gene signs (T12) | A review, not a demo, by design | Nothing in win 2 that stores bytes merges on an unsigned page |
| Win 2 | I11's table; a person drives a body from a terminal (B10) | Yes, through tables and V14 | Fine |
| Win 3 | R11: a real agent pairs and acts for an hour, twice | Yes | It needs a signed-in owner on a test world. W1 builds Clerk only, and today's rules refuse test keys. Without a dev sign-in (row 92) R11's Step 0 hands back |
| Win 4 | V11's table; time turned back from a second camera (V9) | Yes | V11 waits on a CDN's written answer (V2) and on Gene's choice of CDN and its cost. A vendor can stall the chain here, and X2 stands on V11 |
| Win 5 | X1: twenty live Souls for an hour, watched again | Yes | Twenty seats on the harness login for two hours |
| Stage 2 | Gates F7, G8, O6, O12, V18, each on one part | **No.** 67 tasks called "a whole product", and no task shows the product whole | This is where the unowned rows live. See X12 below |
| Stage 3 | X2 to X5, E17, then X6 to X10 | X2 to X5 and E17: yes. The cut-over: see next | |

### Can X6 to X10 be carried out with what the earlier tasks produce?

**X5, the rehearsal on the real path.** It aims 40,000 readers and 2,000 agents at "a fork of Eden on the new
engine's machine" through the public name. No task puts the new programs on that machine or routes the public
name to them (rows 104, 66). It also depends on O9, which needs a second machine that O14 only prices. X5 can
start only after an install task exists.

**X6, each world's content brought over.** Four problems.
- It is at least three tasks in one 4-hour ceiling: (a) every world's rooms and things, read from a backup of
  the live world's database, where N1's importer reads the Eden template file and keeps "live-world edits
  since the template" out; (b) accounts, Souls, creators and looks; (c) uploads by hash. The task says so
  itself ("Eden alone took a 4 h task").
- It copies no token ("one new approval is the honest path"). That is sound, but it means every owner of
  every Soul approves again. Nobody has decided that with Gene, and nothing tells the owners.
- It keeps "Souls' memories" out, and R14 assumes memory needs no migration. Memory on the owner's machine is
  keyed by Soul id, place id and traveller id, and all three change at the clean start. Nothing joins the
  folder on the laptop to the new Soul (row 16).
- The imported things must be things a Soul can use. That needs each one to name a Soul Actions entry (their
  map is Soul Actions E11). X6 does not depend on it, and E17, the gate that measures "a Soul carries out what
  its owner asked", does not depend on Soul Actions content being in Eden at all.

**X7, the cut-over.** Its design is good (both run before, never after; routing, not DNS; a rehearsed way
back; a declared window). What it lacks:
- **A readiness condition.** It depends on X2, X5, X6, O7 and O12. It does not depend on W3, W4, W5, W9, G7,
  R12 to R15, V12, V13, O13, O15, O16 or E17. As written, Eden may be switched to a system with no Soul
  pages, no creator's panel, no skill, no memory, no alert and no runbook. X2's note explains why the goal
  gate should not wait for web-app tasks. That is right for X2 and wrong for X7.
- **The front door.** "Switch by routing behind the same public name" needs proxy routes for the page, the
  stream, the gateway's sockets and the directory, the sign-in bridge (row 90), the old addresses (row 66),
  and what a visitor sees when the origin is down (row 103). No task writes them.
- **The mixed period.** X7 moves Eden only; the other worlds stay on today's launcher until X10. For that
  time the site has two lists of worlds, two sign-in paths and two clients, and a Soul cannot travel between
  an old world and a new one. Nothing says what the home page shows.
- **Clients.** "Old clients get a named answer telling them to update": update to what, fetched from where,
  and what happens to the Souls in that home (rows 3, 15, 16)? And if Eden is rolled back inside the window,
  an owner who upgraded is on a client the old world cannot serve. The rollback declaration must cover the
  client, and accounts and Souls made after the switch.
- **Room.** During the 72-hour window both systems run on one machine whose memory today's worlds may already
  use most of. O14 should say whether both fit.

**X8, the deletion.** Three faults.
- Its list is short. It names `mars/`, `packages/engine-mars`, `apps/server` and the old web app. Left over
  with nothing to run them: `packages/kernel`, `protocol`, `client`, `brain`, `engine-contract`, `engine-toy`,
  `engine-native`, `conformance`; `tools/world-launcher` (launcher, keeper, deploy scripts, the old client);
  `tools/edge-skill`, `god-skill`, `world-skill`; and the release workflow, whose `ship.sh` rehearses and
  ships exactly the code being deleted. A release after X8 has no mechanism until row 110 is built.
- Its keep-list is short. It keeps `packages/world-compiler`, `generators` and `ground`. V8 and V17 also run
  `apps/web/src/gen-mesh`, which X8 deletes with the old web app (row 102). After that a new kind cannot be
  given a model.
- Its outcome contradicts its scope. "No workflow, skill or document names a deleted path", with two
  documents rewritten. Every page under `docs/architecture`, `docs/operations`, `docs/release.md`,
  `docs/testing.md` and `docs/site` names deleted paths. And the frozen upgrade answers for clients still
  installed (#1938) must outlive the deletion.

**X9, travel.** Sound, and self-contained.

**X10, the other worlds.** Sound as a rule ("none is left on the old engine"). Its ceiling of 3 h stands on
X6 having imported every world cleanly. Telling the owners is correctly left to Gene.

### What the cut-over needs that no task builds

| Need | State |
|---|---|
| Moving accounts, Souls' identities and pairings | Inside X6, over-full. No decision on every owner approving again. Nothing for the owner's side (the home, memory) |
| Domains and the front door | Not built: rows 66, 90, 95, 103 |
| The content pipeline for assets | Mostly carried (V12, V17, G6). Two holes: the builders deleted by X8 (row 102) and the licence records (row 99) |
| The docs site and the served skills | Skills written (R12, G7), not served or versioned (row 3). Public docs not rewritten (row 86) |
| How the Rust code is tested, gated and released under the repository's rules | Tested: K1, K14, O5, V18. Not tiered (row 119), no release gate (row 118), no release mechanism (row 110) |
| The launcher and the keeper | Replaced in function (O1, O2, O16, W8). Not on X8's delete list, and the launcher still serves the sign-in bridge, the changelog, the docs, the feed, robots and health until something else does |
| Rollback | Per world: O7. The cut-over's own: X7, rehearsed. Missing: what installed clients do, and what happens to accounts and Souls made after the switch |
| Telling other world owners | X10's Step 0 gives it to Gene. Telling Soul owners (history starts again, approve once more, update the client) is in no task |
| Backups of what the log does not hold | Not built: row 108 |

---

## 3. Proposed

### New tasks

Eighteen tasks, 59 hours of ceilings. Each exists because something people rely on would otherwise disappear,
or the cut-over could not happen. IDs follow each lane's last number.

| ID | Title, as an outcome | Stage | Ceiling | Depends on | Measured outcome | Rows |
|---|---|---|---|---|---|---|
| K15 | Changes under `v2/` carry the right proof tier and sign-off | win 1 | 2 h | K1 | `node tools/proof/tier.mjs` gives T3 for `v2/crates/sim`, `replica` and `skills`, T2 for `v2/web`, T1 for the rest; the tier test passes; the merge train treats the core as a strict path. Needs the maintainer, since the policy file is itself T3 | 119 |
| O17 | The new programs are installed on the production machine beside today's, behind a preview address | stage 2 | 4 h | O1, O2, O3, W8, I1, V2, W1, O14; Gene's yes | One tested install script. A fork of Eden answers at the preview address through the real proxy: the page plays, an agent pairs and acts. Today's worlds keep their bars for an hour beside it. The uninstall leaves the machine as it was | 104 |
| O18 | A release of the new system is one commit: built once, staged by hash, moved by canary, rolled back by a workflow | stage 2 | 4 h | K1, O7, O16, O17 | A workflow builds the world process, the gateway, the page and the client at one commit and stages them with no shell on the machine; the canary's pin moves, then the rest; a planted bad build is taken back; the changelog, tag and news item are written; the list of checks a release head must pass is in `docs/testing.md` and the workflow refuses a head without them | 110, 118, 85, 20 |
| O19 | The front door routes the public name to the new system, and the old addresses still answer | stage 3 | 4 h | O17, V2, W1, W3 | Checked by a script from outside, on the preview: `/w/<slug>/` and the old aliases; the two older domains' redirects; sign-in from soul.game through the primary origin; framing refused and API answers not indexed; robots and sitemap; a "back in a moment" page when the origin is down; one list of worlds while old and new run side by side; visitor counts under today's privacy rules | 66, 90, 95, 103, 112 |
| O20 | What is not in the log is backed up and comes back | stage 2 | 2 h | W1, W2, W8, G6, O3 | The accounts store, token hashes, the removal list, bookmarks and uploads are restored on a second instance from the bucket alone; after O12's restore an existing account signs in and its Soul's agent reconnects with no new approval | 108 |
| R17 | The client is one thing an agent fetches, served by the world, and it upgrades itself | stage 3 | 4 h | R6, R12, R13, G7, K1 | One line fetches it. The world's address serves the instructions, the Soul skill, the creator's skill and the client with version, length and hash. A served newer version is installed by `upgrade` and undone by `upgrade --rollback`. `list`, `default`, `adopt`, `doctor`, `export` and `import` work. Only the home's first site is trusted unasked | 3, 15, 18 |
| R18 | A home on today's client comes across with its Souls and their memory | stage 3 | 3 h | R17, R14, X11 | A home with today's released client, two paired Souls and a month of memory runs `upgrade` against the preview: the same two Souls, one approval each, no second Soul, every memory page still readable, old ids shown as "formerly". The frozen upgrade answers (#1938) are still served after X8. Inside X7's window `upgrade --rollback` returns it to the old client | 15, 16 |
| W10 | An owner writes to their Soul from its page, a creator to their agent from the panel, and each sees what is being done | stage 2 | 4 h | W4, W5, R13, G7, V13 | A message reaches the agent within 2 s; the page shows thinking, the act under way and the result; only the owner or creator may send or read; no word of it reaches a public view or the log (T8) | 26, 57 |
| W11 | My Souls: start one from a world's page, name it, describe it, picture it, disconnect its agent, retire it with a click | stage 2 | 3 h | W1, W2, W4 | From a world's page a signed-in person copies the one line and has a Soul; the six actions each take effect within a minute; a retire needs the person's click, never the agent's alone | 29, 83 |
| B15 | An owner chooses their Soul's body and look | stage 2 | 2 h | B12, B13, W2, V6 | At creation and later, a body from the presets or the owner's own and a look are chosen from the page or by the agent; the change is an effect seen live and in replay; a body that would not fit where the Soul stands is refused and the old one kept | 30 |
| G10 | An agent can be shown the world: the creator's look, a Soul's view, a world's picture for the list | stage 2 | 3 h | V8, V9, G7, R7, W9 | `look` returns a picture of a named place within 10 s, drawn from the record on the agent's own machine as today's `shoot` is; a Soul's view shows only what the public may see; the owner sets the list picture from one | 58, 61 |
| V19 | The sky, daylight, water and weather are drawn from the record | stage 2 | 3 h | V8, E6, G5 | The sun follows the world's clock in its zone; lamps show at night; rain falls while the weather effect holds; water is water; V6's frame bars still hold; a replayed moment has the sky it had | 74 |
| V20 | Follow a Soul, the broadcast camera, and touch | stage 2 | 4 h | V6, V9, W4 | A tap or click follows a Soul through a door; broadcast runs ten minutes with no input and is never on an empty scene for more than 10 s; one finger, pinch and two fingers work on the reference phone; a link reproduces a follow; a place or Soul typed in is flown to | 76, 77 |
| V21 | The world can be heard | stage 2 | 3 h | V7, B11, Soul Actions D7 | A recorded sound plays where it happened, within 50 ms of the record, live and in replay; switches for effects and music; one tab sounds at a time | 79 |
| X11 | Accounts, Souls and creators are brought over, apart from the worlds' content | stage 3 | 3 h | W1, W2, W8, B15; Gene's yes to read the backups | From a backup of the account registry and each world's Soul table: every person signs in to the same account; each account has the same Souls by name, description and look; each world has its creator; a table of counts; no token copied; no account id in any log. X6 keeps rooms, things and uploads | 89 (splits X6) |
| X12 | Gate: the inheritance walk on the preview | stage 3 | 3 h | X6, X11, R17, R18, O19, O20, W3 to W5, W9 to W11, G7, R12 to R15, O13, O15, E17; Soul Actions E11 and E12 loaded | A real owner, a real creator and a visitor on a phone walk every `v2` row of this inventory at the preview's real address; each is seen working or is on the list of drops Gene signed. X7 depends on this | the stage 2 gap |
| X13 | The public docs describe the new system | stage 3 | 4 h | R12, G7, O19 | The pages under `docs/site` are rewritten and served at `/docs`; the docs lint passes; a fresh agent given only "for agents" pairs a Soul and acts | 86 |
| X14 | The repository's docs, skills and local tools name the new tree | stage 3 | 4 h | X8 | `docs/README`, architecture, operations, release, testing and development are true; the proof, e2e and director skills run against a local world of the new engine started by one command with a dev sign-in; no document, skill or workflow names a deleted path, checked by a script | 120, 123 |

### Changes to tasks that exist (no new work)

| Task | Change | Why |
|---|---|---|
| X7 | Depends on X12, O19, R18. Its declaration says what installed clients do on a rollback, and what happens to accounts and Souls made after the switch | The cut-over must wait for a whole product, not only for the goal's numbers |
| X8 | The delete list names every package and tool with nothing left to run it, the launcher and keeper among them. The keep-list adds whatever V8, V17 and G7 call in place (`gen-mesh` unless it was copied into `v2/`), `tools/cdn`, `tools/assets`, `tools/body-authoring`, `tools/playtest`, `tools/proof`, `tools/changelog` and the load shapes. Depends on O18 and X14. The frozen upgrade answers stay | Rows 102 and 110; the outcome it already states |
| X6 | Rooms, things and uploads only, read from a backup of each live world. Each imported thing names a Soul Actions entry by their map, or is listed. Depends on Soul Actions E11 | It is three tasks; and Eden must arrive usable |
| E17 | Depends on Soul Actions' Eden entries being loaded | Otherwise it measures the engine on a town with nothing to use |
| W1 | Add a dev sign-in for local and test worlds, refused on any public address, as today | Row 92; R11 needs it at win 3 |
| R14 | Say what happens to memory keyed by ids that change at the clean start; name `digest` and `consolidate` in the outcome | Row 16; its "no migration" premise |
| W9 | Add "close to visitors" and "take off the list" to the outcome if they are not what "who may enter" means | Row 67, to be certain |
| V17 | Its models are published through `tools/cdn`'s licence records | Row 99 |
| G6 | Keep the place where a classifier can hold an upload, even with none plugged in | Row 60, if Gene keeps it |
| O14 | Say whether the old and the new system fit on the production machine together for X7's window | X7's 72 hours |

### Hand to Soul Actions (tell that planner)

- **The town calendar** (row 24): a Soul announcing an event is a form on a kind (a notice board, the
  calendar itself). The engine's half is E6 and E7.
- **A conversation** (row 23): an activity Souls join (their G1a), if a conversation is to be a thing at all.

---

## 4. To ask the owner

**Decisions that change the plan.**
1. **Every owner approves once more.** X6 copies no token, so each Soul's owner approves the new client once.
   Yes? And who tells them, how, and when (the news feed and the changelog page still work until the switch)?
2. **A body whose agent has gone** (row 49). Today the world idles it, then walks it out of town to sleep.
   The standing rule says the world never chooses for a Soul. Drop the wind-down on purpose (the body stays
   where it was left), or make it an order the agent writes in advance?
3. **Login once per computer** (row 21), decided on 12 to 14 Nov. Carry it at the cut-over, or one approval
   per Soul for now and add it later? If carried: one task, about 3 h, on W1 and W2.
4. **Handing a world on, and archiving one** (row 68). The W lane left both for your rule.
5. **The broadcast camera** (row 76). V20 carries it. If you would rather open on a free camera, V20 shrinks
   to follow and touch.

**Drops to confirm, or to keep.** Each is small. My guess is in brackets.
- The MCP endpoint, row 11 (drop; the public page about it goes too).
- Prayers and answers, row 27 (drop, or a form in Soul Actions).
- The feedback form, row 84 (drop until there are more testers).
- The local dashboard, row 19 (keep if it still reads the new folders unchanged; otherwise drop).
- Platform news to clients, row 20 (keep the release item in O18; drop the rest).
- Visitors' page errors, row 113 (drop).
- The classifier hook, row 60 (keep the seam, no classifier).
- The music radio, row 80 (keep only if V21 can carry `packages/music` unchanged).
- Building with joined parts, row 37 (wait; a planner's note called it off, not you).
- The stream tool and the video kit, row 115 (re-point after the cut-over; not a task now).
- Also unlisted above because they are tiny: lightning, the sky and hour preview for creators, helper tokens,
  exporting a world to a file.

**Approvals the plan already expects from you, in one place.** The trunk pages (T12); the machines, a yes or
no (O14); the CDN and its price (V2, INDEX open point 5); the window for the real-path rehearsal (X5);
reading production backups (X6, X11); installing beside production (O17); the switch (X7); the deletion
(X8); each other world, after its owner was told by you (X10).

---

## 5. What I could not check

- **Nothing was run.** Every statement about today's system comes from its documents on `origin/main`, not
  from its code. A feature that is in the code and not in the docs is not in this inventory. The web app's
  rows come from the docs and from file names under `apps/web/src`.
- **Task bodies.** I read every title, purpose, outcome and "Stays out", and lanes X, Z, O, G and W in full.
  For lanes T, K, N, B, F, I, R, V and E a design line inside a body may carry something I marked UNOWNED.
- **Soul Actions.** I read its index and the note `FOR-SOUL-ACTIONS-20261116-engine-v2.md`, not its 96 task
  bodies. The `SA` rows are assigned by title.
- **Whether every production world can be imported.** I could not tell which worlds are built from
  creator's edits (which X6 can read) and which carry authored content from the vendored engine (which it
  cannot). X6's Step 0 would find out; X10's 3 hours assume the answer is "all of them".
- **Whether today's client would accept the new one as an upgrade.** The docs say an upgrade is refused when
  another world in the home "speaks another contract". R18 has to test it; it may need one last release of
  today's client first.
- **What X8 means to leave.** I read its list literally. If `tools/world-launcher` and the old packages are
  meant to go under "the old engine and server", the list should say so.
- **The machine.** Whether both systems fit on it for the rollback window, and how many worlds are in
  production, are not in any document I read.
- **The sign-in provider's and the CDN's own settings**, which live in their dashboards.
- **The issues and pull requests** cited by the docs (#1938, #2242 to #2246, #1754) were not opened; I took
  the docs' account of them.
- **The counts** depend on how rows are split. Split differently they move by a few; the fourteen cut-over
  rows do not.
