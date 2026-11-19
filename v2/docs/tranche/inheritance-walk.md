# The inheritance walk (Engine v2 X12, #2835)

The walk sheet for X12: every row of [`inheritance.md`](inheritance.md)'s inventory, plus the rows Gene added on
18 Nov (#2835's comments), as something a named walker does and must see at the preview's real address. X7 (the
switch) depends on it. Gene's bar, 18 Nov: everything people rely on today "continues to work as good or better";
nothing is dropped except the feedback form, and a row a walker cannot see working blocks the switch until it is fixed.

## How the walk runs

- **Walker assignment (Gene, 19 Nov, #2835).** The development coordinator performs all four walks: **O**, an
  owner with an isolated test identity and agent home; **C**, a creator with a separate isolated identity and home;
  **V**, a visitor on a phone with no account; **Op**, operations (the coordinator did not build those rows).
  Use real input at the real preview address and one uncut, real-speed clip per role, recording each seen row's
  clip time. These assignments do not authorize this preparation lane to access production or personal seats.
  R1 still needs Gene's recorded rendering judgement.
- **Marks.** Each row ends `seen` (with its clip time), `failed` (with the proposed task) or `dropped` (on the list
  of drops the owner signed). The rows below are the bar; none is added or removed after the walk starts.
- **The scripted pass first.** [`v2/tools/inheritance-walk/walk.mjs`](../../tools/inheritance-walk/walk.mjs) stands up a
  local served Eden (`worldd seed` from Eden's facts and `content/kinds`, `worldd serve`, `gatewayd`, `directoryd`
  with the test sign-in, the page in `vite`), pairs three Souls through W2's pairing as three owners' agents (a fake
  mind: the script sends the commands people use) and checks each row marked in the **Script** column. It finds open
  rows before people walk; it is not the walk (a scripted pass is not real input at the real address).

The retained script is a rehearsal helper, unchanged by this mapping update. Its old facts-export default must
not be used to read production data. A future authorized rehearsal supplies synthetic/approved facts with
`--facts`, isolated output with `--out` under the worktree's ignored `.local/`, and matching native/WASM builds.
`--keep` leaves rehearsal services running; it does not create a preview. This preparation starts no services,
runs no import and makes no claim that a preview exists.

## Real-preview procedure for the coordinator

1. Before walking, post this fixed row list and its revision on #2835, name the four role recordings, and record
   the actual preview release head. Check the real address serves Eden with Soul Actions loaded; otherwise hand
   back without claiming A2. Keep deployment mappings and test identity bindings private. The signed drop list
   currently authorizes row 84 only; older proposed drops below are unresolved, not accepted exclusions.
2. **Owner (O).** In a fresh isolated home, follow the served instructions and real-provider approval, join and
   perform the O rows using the released client. Exercise login once, adopt/pair without another code, and the
   explicit device-move refusal. Exercise the former-Soul migration with an approved synthetic imported identity:
   distinct local alias, public slug and saved internal old-world id; same Soul/name/description/memory before and
   after approval, account isolation and later edits preserved. Check the copy follows the joined body without an
   extra discovery command, then speech, consent/activity, seats and queues including the obstructed Town route.
   B15 uses the approved hash-pinned core presets and explicit larger class; verify fit/doorway refusals and that a
   refused change keeps the old body. Ordinary uploads keep their existing limits. Source approval is not proof.
3. **Creator (C).** Use the real-provider creator exchange, with another account refused; create a world from an
   existing template and visit its advancing public stream. Pair its creator, edit a room/door/chair, approach and
   occupy it using the planner's committed map; reject stale results and retain BUILDSAFE refusals. Exercise prayer
   answer delivery privately. Offer a world to a recipient who explicitly accepts, then verify prior creator tokens
   lose authority. Archive by explicit world-name confirmation, retain its data/address, and let Op restore it.
4. **Phone visitor (V).** In a signed-out phone context, open canonical/preview world URLs without added query
   parameters; verify the correct advancing stream, public gateway selection, redirects and old aliases. Find both
   a named place and a Soul, follow motion/doors, and walk the remaining V/P6 rows. A page HTTP 200 is insufficient.
5. **Operations (Op).** At the authorized preview, verify the installed release contains the import executables
   from the same head, with operator-owned import receipts (this sheet authorizes no production import). Exercise
   site-owner /ops authentication and actual snapshot, release/probe, backup/restore and archive restore. Verify
   the real cutover mutation fence refuses old Eden acts/creator edits while other worlds work, and rollback restores
   released old-client behavior while retaining new-system accounts/Souls. Preserve the two-hour preview and
   twenty-four-hour rollback commitments. Only the release owner runs operational changes.
6. Post the result table with role, exact source head, `seen` + clip time, `failed` + next task, or signed `dropped`
   for each row. Keep every previous failed receipt/take with its source identity. Unwalked rows remain unproved;
   no scripted pass, merged PR or local recording supplies a preview clip time. Do not switch while blockers remain.

## Required caller mapping (19 Nov preparation snapshot)

These tasks are release prerequisites, not new rows or implementation dispatched by this sheet. All mapped rows
remain **preview-unproved**. A task issue, PR claim or successful focused check is source evidence only. The latest
agenda checkpoint is [#1960, 19 Nov](https://github.com/soulsimulation/souls/issues/1960#issuecomment-7017918807).

| Rows | Required task / source | What must be observed at preview |
|---|---|---|
| 5b (within 5) | #3571 | `find plaza`, `find west lake`, `find harbour` resolve local-copy places with stable ids and offered actions |
| 22/22b | #3572 | Served joined bodies receive say once; whisper reaches only the intended nearby recipient |
| 34/34b | #3573 | Thin-client fixture sit legally approaches bench/stump/armchair, observed slot matches receipt; second occupant refused |
| 77 | #3574 | Phone find resolves a place and Soul, unknown query has visible no-match |
| 104, 89, 69 | O17b #3581 | Installed account/world import binaries match the release; operator's authorized import validation is recorded |
| 21 | W15 #3582 (Gene: carry, 19 Nov) | Real login once; adopt and pair without another code; account/device boundaries preserved |
| 68 | W16 #3583, W17 #3584 (Gene: carry, 19 Nov) | Recipient-accepted handoff revokes old creator authority; archive and operator restore keep identity/data/address |
| 27, 50, 56 | G11 panel PR #3585; W18 #3586 | Real authenticated panel answers a prayer privately; local test-bearer proof cannot establish public sign-in |
| 2, 4, 50, 62, 88–91 | W18 #3586 | Public provider configuration/session reaches account, pairing, new-world and creator callers; wrong creator refused |
| 3, 65–66, 72, 90, 103, 114 | O19b #3587; front-door PR #3576 | Real public/preview URL bootstraps correct stream and actual gateway, without manually supplied query or internal address |
| 50, 62, 65, 68 | W3b #3588 | Create → placement → real serve/gateway → public advancing world, admitted Soul act, correct creator, restart |
| 15–16, 109, 114 | O19c #3589 | Actual launcher switch/back fences old Eden mutations, preserves other worlds and new data, guides released clients both ways |
| 16, 28–29, 89 | X11b #3591; R18b PR #3563 | Imported Soul listed before pairing, same approved identity/profile reaches joined body; wrong account refused |
| 33–34, 47 | B7c #3593; B7b PR #3592 | Previously obstructed queue follows supported Town route, takes slots once in FIFO order; unreachable approach ends by name |
| 2, 22–23, 47 | R21 #3594; C30 PR #3580 | Fresh authoritative post-join copy/body subscription without discovery command; original consent, private turns and activity journey completes |
| 32, 51–53 | K18d #3595; K18b #3437, G1f #3559 | Committed new ground/doorway reaches off-clock planner; obsolete route refused; creator room/door/chair works |
| 15–16, 89, 91 | R18c #3596 | Saved internal former world id is sent, local alias retained; missing/contradictory metadata refuses without guessing |
| 30–31, 39, 101 | B15 #2750 / PR #3568 (Gene approved core catalogue + larger class) | Served preset/body change with every fit/doorway check; ordinary upload limits preserved |
| P1, P3–P4, 105, 114 | O24 #3326; O23b #3578 | Operator-only test-Soul approval; site-owner /ops loads real data rather than a shell/503 |

### Observed sources, not preview results

- PR #3569 is observed merged on 19 Nov; it carries the C12–C27 forms chain, C2 and C3. That merge does not retest
  the old X12 findings or prove any real-preview row. This preparation branch remains based on `ae87d631e`.
- PR #3551 is observed merged: changelog/news/ops shell source. Its /ops data caller still requires #3578.
- PRs #3563 (former approval), #3579 (home commands), #3576 (served front door), #3585 (prayer panel) and #3568
  (body selection) are observed open. Their own evidence remains attached to their own source heads.
- PR #3580 is observed draft: C30's fifth served journey failed at recipient body-follow after join; #3594 carries
  the required refresh repair and original remaining journey. All five failed journeys remain failed evidence.
- PR #3592 is observed draft: B7b's third served journey stalled at furniture. A permitted clear-approach proof
  cannot establish #3593's obstructed approach. K18b's static-map checks cannot establish #3595's current-map proof.
- The previous X12 scripted pass belongs to its recorded integration tip in
  [the handback](https://github.com/soulsimulation/souls/issues/2835#issuecomment-7014357148): scripted rows 2, 4, 5
  and HTTP/stream metadata row 72 passed; failures and unchecked rows 32/45 are retained. None was rerun here.
  The two declared prior runs are not reset by this relocation or by filing follow-ups.
- Row 36's old reachability/set-down finding remains open: C18 #3454 / PR #3507 is the recorded reachability
  source, but the generic set-down gap still needs a bounded next-task proposal from the coordinator. A4 is not
  claimed complete by this preparation. Rows 32 and 45 still need the retained focused rehearsal before real input.

## The rows

Task: the issue or PR carrying the row; issue closure alone does not establish a merge or a preview result.
"SA" rows are Soul Actions content, walked through the Soul's own agent. **Script**: the scripted pass's row id.

### Souls and their agents

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 1 | O | Ask your agent to do something; see the world admit or refuse and report it, and nothing chosen by the world | I1–I7 | 2 |
| 2 | O | Paste the one line into a fresh agent; see it read the skill, create a Soul, act | R12 #2706, R17 #2818 | 2 |
| 3 | O | Fetch `/instructions.md`, `/skill.md`, `/llms.txt` and the client at the world's address; see each served | R17 #2818; front door PR #3576, O19b #3587 | 3 |
| 4 | O | Create a Soul by name; approve once in the browser; see the token in no agent output | W2 #2705 | 4 |
| 5 | O | `look`, `find "<words>"`, the whole town; see answers from the local copy | E1 #2708, R7; named places #3571 | 5, 5b |
| 6 | O | Act by id; a retry; a refused act; see one receipt, a named end, the reason and what would work | I2–I6 | 34a, 34b |
| 7 | O | A plan of steps; a `can`; a `wait`; see no model turn between steps and no polling | I9, R2, R8 | |
| 8 | O | Wake rules, a reflex, a routine, a reminder; `stats`; see each fire within its budget | R13 #2753, R15 #2757, R10 | |
| 9 | O | Two Souls in one home; move one to a second machine (free, refused naming the device, `--move`) | R6, W2, I12 | |
| 10 | O | Travel to another world and home again | X9 #2840 | |
| 11 | O | Run a Soul from an app that takes only a URL (`/mcp`, the `eden_*` tools) | R21 #3334 | |
| 12 | O | Old steering API, intents v2, mandates, cards, central mind, `eden-agent.mjs` | unresolved carry/drop: older proposal needs Gene’s signed decision; blocks A5 | |
| 13 | O | Server-built menus and exact route planning | unresolved carry/drop: older proposal needs Gene’s signed decision; blocks A5 | |

### The client and the home

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 14 | O | Run from a subfolder; see `.souls` found like `.git`, credentials 0600, a resident process that outlives the chat | R6 | 4 |
| 15 | O | With an older client installed, see it told of the newer one; `upgrade`, `upgrade --rollback` | R17 #2818, R18 #2821; O19c #3589, R18c #3596 | |
| 16 | O | A home paired on today's client: after the switch, the same Souls, their memory, ids shown as "formerly" | R18 #2821; R18b PR #3563, X11b #3591, R18c #3596 | |
| 17 | O | `memory <words>`, `remember`, the brief before a turn, `digest`, `consolidate` | R14 #2754, R19 #3327 | 17 |
| 18 | O | `list`, `default`, `adopt`, `doctor`, `export`, `import` | R17 #2818; R17b #3561 (PR #3579) | 18 |
| 19 | O | `dashboard` reads the home | R19 #3327 | |
| 20 | O | A platform news item reaches the client and the site feed | O23 #3324 (merged shell PR #3551); O23b #3578 | |
| 21 | O | Log in once per computer; `adopt` and `pair` with no window code | W15 #3582 (carry approved, Gene 19 Nov) | |

### Speech and social

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 22 | O, V | `say` near another Soul; a whisper; a shout; see who hears, viewers see it, the whisper private | B11 #2742, W4 #2748; served speech #3572, post-join #3594 | 22, 22b |
| 23 | O | A conversation of three Souls: join by consent, one declines, the turns read later | E26 #3329; C30 #3556 (draft #3580), R21 #3594 | 23 |
| 24 | O | Announce an event; another Soul reads what is on | E6 #2755 (reading); SA calendar | |
| 25 | O | Offer a hand-over, hold hands, an invitation; the other accepts or declines | B5, E8, E24 | |
| 26 | O | Write to your Soul from its page; see "thinking", the act under way, the result | W10 #2802 | |
| 27 | O, C | Pray to the creator; the creator answers; the Soul gets it | G11 #3335 (panel PR #3585); W18 #3586 | |
| 28 | O, V | A Soul's status line and biography; "while you were away" | W4, W6 #2825, R16 #2817 | |
| 29 | O | Edit name, description, photo; disconnect the agent; retire with a click; see connected agents | W11 #2749 | |
| 30 | O | Choose a body and look (presets: Little Martian, creature bodies) from the page and by the agent | B15 #2750 (PR #3568; core presets/larger class approved 19 Nov, checks retained) | |
| 31 | O | Upload a custom body; see it checked and worn | B13, G6 #2747 | |

### What bodies can do

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 32 | O | Walk through doors, up stairs to an upper floor and a roof terrace, to a far place | N3–N8; C27 #3509 (PR #3549); K18d #3595 | 32 |
| 33 | O | A crowded hour: nobody stuck, nothing teleports | N10, K11, E16, O5; B7b #3489 (draft #3592), B7c #3593 | |
| 34 | O | Sit at the campfire, on a bench, lie on a bed, rise; a second Soul on a full seat is refused | B3, E3; C17 #3453, C19 #3457; thin sit #3573, queue #3593 | 34a, 34b |
| 35 | O | Jog, run, wade, swim; board a rowing boat, ride, steer; a ride | N11, N12 #2737, E12 | 35 |
| 36 | O | Pick up, carry, put down, hand over; two Souls carry a long load | B4, E4, E24, B9, B14 | 36 |
| 36x | O | A thing set down is still there later, as today (today's soul.game clears no loose things; kind expiry policies vary) | (parity: no expiry) | 36b |
| 37 | O | Build with joined parts: a rack bay from the yard, changing crews, take it down | X17 #3342 (B18 #3339, B19 #3340) | |
| 38 | O, V | Gestures, gaze, a handshake, a dance, holding hands | E10, E11, B11, B5, B8 | |
| 39 | O | A small body, a creature, a floater | B12 | |
| 40 | O | Use a thing by hand from data; its state survives a restart; values that change with time | F1–F11, E18, E14 | |
| 41 | O | Lights and fire, doors, windows, locks, knocking | SA | |
| 42 | O | Water and the garden | SA | |
| 43 | O | Drawers, lockers, the swap shelf, lost and found, the pantry | SA | |
| 44 | O | Boards, notes, books, the guestbook, posters, paintings, chalk | SA | |
| 45 | O | Play the piano (seated at it), a duet, the jukebox, records, checkers, frisbee, juggling | SA (on B8, F8) | 45 |
| 46 | O | Tea, coffee, eating | SA | |
| 47 | O | Eden's own things and activity spots | SA (C22 #3485 sweep) | |
| 48 | O | What the Soul perceives near it; a closed container hides what it holds | R4, E22 | |
| 49 | O | Leave a body with no agent for an hour: it idles, then a zombie walks out of town and sleeps | B16 (Gene, 17 Nov) | |

### God mode and world building

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 50 | C | Pair the creator's agent with its one skill; one creator per world | G7 #2796 (PR #3475), G9, W2 | |
| 51 | C | Batch edits, a dry run, place by relation, undo, redo, a build with steps | G1, G4, G7, E2; G1f #3559, K18d #3595 | |
| 52 | C | An edit that would bury or cut off a Soul is refused | G2; G1c #3456, G1d #3462 | |
| 53 | C | Terrain, water, weather; walkers follow | G3, G5, E6; K18d #3595 | |
| 54 | C | Search the library of kinds | SA (C1, C2) | |
| 55 | C | A new kind, the creator's own model, rules on things | G6, K3, F6, E7 | |
| 56 | C | The creator's panel: place and drag by hand, undo | W5 #2801 (PR #3528) | |
| 57 | C | Write to the agent from the panel | W10 #2802 | |
| 58 | C | `look` (a picture of a place), a Soul's `view` and `shoot` | G10 #2800 | |
| 59 | C | Upload limits, private data stripped; hide an upload or a world; edit limits | G6, W9 #2827, T8, I8, O8 | |
| 60 | Op | The classifier seam can hold an upload for review | G6 | |
| 61 | C | Set the world's list picture | G10 #2800 | |

### Worlds, templates and travel

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 62 | O, V | The list of worlds; a new world from a template; the per-account limit | W3 #2799, G9, W8; W18 #3586, W3b #3588 | |
| 63 | V | The world's clock in its own zone | T5, E6 | |
| 64 | Op | A quiet world jumps ahead exactly; a still world leaves memory and wakes on time | K7, K9, O2 (PR #3411), O10 | |
| 65 | V | Many worlds behind one site | W8, O1 | |
| 66 | V | `/w/<slug>/`, the old aliases, the two older domains' redirects | O19 #2830; O19b #3587 | |
| 67 | C | Rename a world, take it off the list, close it to visitors | W9 #2827 | |
| 68 | C | Hand a world to another account; archive and restore | W16 #3583, W17 #3584; W3b #3588 (carry approved, Gene 19 Nov) | |
| 69 | V | Each world's built content, creator and Souls are there | X6 #2819, X11 #2820, X10 #2837 | 5 |
| 70 | Op | Worlds' pasts before the switch | unresolved carry/drop: older proposal needs Gene’s signed decision; blocks A5 | |
| 71 | Op | Re-running history as a promise | unresolved carry/drop: older proposal needs Gene’s signed decision; blocks A5 | |

### Viewing, cameras and history

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 72 | V | Open a world on a phone with no account; motion on screen quickly | V1, V2, V5, V12 #2758 | 72 |
| 73 | V | A crowd of animated bodies; things and buildings with their real models | V6, V7, V8, V17 | |
| 74 | V | Sky, sun on the world's clock, lights at night, water, weather | V19 #2763 (V19c PR #3526) | |
| 75 | V | The free camera | V5 | |
| 76 | V | Tap a Soul and follow it through a door; broadcast for ten minutes | V20 #2764 | |
| 77 | V | Touch controls; type a **place** or a Soul in the find box and fly there | V20 #2764, W14 #3330; place find #3574 | 77 |
| 78 | V | Name plates, Soul cards, speech on screen | W4 #2748 | |
| 79 | V | Sounds where they happen; the switches | V21 #2765 | |
| 80 | V | The music radio plays as today | V22 #3337 | |
| 81 | V | Scrub back, a link to a moment, find an event, a bookmark | V3, V4, V9, W6 #2825, V18 | |
| 82 | O, C | The owner's and the creator's near-live view | V13 #2745 | |
| 83 | V, O | The "bring your agent" card: the one line to copy, New Soul | W11 #2749 | |
| 84 | — | The feedback form and its inbox | dropped (Gene, 18 Nov) | |
| 85 | V | The changelog page | O23 #3324 (merged shell PR #3551); O23b #3578 | |
| 86 | V, O | The public docs at `/docs`; a fresh agent given only "for agents" pairs and acts | X13 #2834 (after the switch, Gene 19 Nov) | |
| 87 | O, Op | Remove a person's words, end to end | W7 #2826, T8 | |
| R1 | Gene | Rendering side by side: a busy square, inside a hall, the lake at dusk, a crowd, a creator's edit, from the same moment on today's page and the new | (Gene judges, 18 Nov) | |

### Accounts, pairing and safety

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 88 | O, V | Sign in with Clerk; watch with no account | W1 #2704; W18 #3586 | |
| 89 | O | The same person is the same account, with the same Souls and worlds | X11 #2820; X11b #3591, R18b PR #3563, R18c #3596 | |
| 90 | O | Sign in from soul.game through the primary origin | O19 #2830; O19b #3587 | |
| 91 | O | The approval card: device, code, age; tokens stored only as hashes | W2 #2705, I1 | 4 |
| 92 | Op | A dev sign-in on a test world, refused on a public address | W1 #2704 | 2 |
| 93 | Op | Floods and hostile clients held off; world-making limits | I2, I8, O8, W3 | |
| 94 | V | Owners' words and private fields stay out of public views | T8, W1, F6, O11, W7 | |
| 95 | Op | Framing refused; API answers not indexed; robots and sitemap list only listed worlds | O19 #2830; O19b #3587 | |
| 96 | Op | The model budget and the central mind | unresolved carry/drop: older proposal needs Gene’s signed decision; blocks A5 | |
| 97 | Op | Admin pause, clock rate, invites | unresolved carry/drop: older proposal needs Gene’s signed decision; blocks A5 | |

### Assets and the CDN

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 98 | Op | Models, textures and media by hash, immutable; `pnpm assets:pull` | V2, V12, V17 | |
| 99 | Op | New baked models pass the CDN licence records | V17 | |
| 100 | O, C | Creators' uploads by hash; today's upload addresses answer | G6, X6 | |
| 101 | V | Body models, the shared rig, motion clips | V6, V7, B13 | |
| 102 | Op | A new kind is given a model by the builders (`gen-mesh`) | V17; X8 #2839 keep-list | |
| 103 | V, Op | The visitor's real address; page cache rules; "back in a moment" when the origin is down | O19 #2830, V2 | |

### Operations, releases, backups, monitoring and analytics

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 104 | Op | The new programs installed on the production machine, units, user, proxy routes | O17 #2810; O17b #3581 | |
| 105 | Op | Health, measures, costs; a person told from off the machine | O4, O11, O15 #2808, O21 #3325 | |
| 106 | Op | A crashed or stalled world restarts; limits per world | K7, O1, O10, O14 | |
| 107 | Op | World data off the machine; a restore drill | O3, O12, O13 #2829 | |
| 108 | Op | Accounts, token hashes, removal list, bookmarks, uploads backed up and restored | O20 #2812 | |
| 109 | Op | Deploy to one world, roll back; upgrade the gateway without dropping agents | O7, O16 #2809; O19c #3589 | |
| 110 | Op | A release from one commit; a rollback with no shell on the machine | O18 #2811 | |
| 111 | Op | The runbook's tested commands; the spike runbook | O13 #2829, X5 | |
| 112 | V, Op | Visitor counts: cookieless, no query, hash, Soul id or token | O19 #2830; O19b #3587 | |
| 113 | Op | Visitors' page errors reach the operator | O25 #3336 (PR #3428) | |
| 114 | Op | A staging place and a probe world | O7, X7 #2836 | |
| 115 | Op | The stream tool and the video kit point at the new page | (re-point after the switch) | |
| P1 | Op | Release walks need no person: the release owner approves test Souls on the machine | O24 #3326 | |
| P2 | O | Soul owners were told before the switch | X15 #3322 (PR #3550) | |
| P3 | Op | The site owner's health page, daily usage, measures history | O21 #3325; O23b #3578 | |
| P4 | Op | The changelog page, news feed and ops overview served by the new system | O23 #3324 (merged shell PR #3551); O23b #3578 | |

### Development process

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 116 | Op | CI by changed paths; determinism and architecture rules in the build | K1, K7, K12, K14 | |
| 117 | Op | Walk, bundle, replay and conformance successors | N15, N18, O5, V12, V18 | |
| 118 | Op | The checks a release head must pass | O18 #2811 | |
| 119 | Op | Proof tiers for `v2/` and the core's sign-off | K15 #2637, K19 #3323 | |
| 120 | Op | Proof clips, e2e and the director skill on a local new-engine world | X16 #3331, X14 #2838 | |
| 121 | Op | Playtests, benches, load shapes, fault drills | X1, R11 #2707, E17 #2824, X2–X4 | |
| 122 | Op | `AGENTS.md`, the merge train, changelog fragments | X8 #2839 | |
| 123 | Op | The repository's docs name the new tree | X14 #2838 | |
| P5 | O | A closed harness is woken by its scheduler | R20 #3328 | |
| P6 | O, V | Every page works at phone width | W14 #3330 | |
