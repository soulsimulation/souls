# The inheritance walk (Engine v2 X12, #2835)

The walk sheet for X12: every row of [`inheritance.md`](inheritance.md)'s inventory, plus the rows Gene added on
18 Nov (#2835's comments), as something a named walker does and must see at the preview's real address. X7 (the
switch) depends on it. Gene's bar, 18 Nov: everything people rely on today "continues to work as good or better";
nothing is dropped except the feedback form, and a row a walker cannot see working blocks the switch until it is fixed.

## How the walk runs

- **Walkers.** **O**: an owner, with their own agent on their own machine. **C**: a creator, with theirs. **V**: a
  visitor on a phone, no account. **Op**: an agent that did not build the operations rows, on the preview. One uncut,
  real-speed clip per walker; each row's clip time goes in the table.
- **Marks.** Each row ends `seen` (with its clip time), `failed` (with the proposed task) or `dropped` (on the list
  of drops the owner signed). The rows below are the bar; none is added or removed after the walk starts.
- **The scripted pass first.** [`v2/tools/inheritance-walk/walk.mjs`](../../tools/inheritance-walk/walk.mjs) stands up a
  local served Eden (`worldd seed` from Eden's facts and `content/kinds`, `worldd serve`, `gatewayd`, `directoryd`
  with the test sign-in, the page in `vite`), pairs three Souls through W2's pairing as three owners' agents (a fake
  mind: the script sends the commands people use) and checks each row marked in the **Script** column. It finds open
  rows before people walk; it is not the walk (a scripted pass is not real input at the real address).

```
node v2/tools/import-eden/export/export.ts                     # from the repository root: Eden's facts
cd v2 && cargo build --release -p worldd -p gatewayd -p directoryd && (cd web && npm ci)
# replica's WASM package in v2/target/wasm-load/pkg: v2/tools/ci.sh's wasm-bindgen-cli, wasm-build, wasm-bindgen steps
node tools/inheritance-walk/walk.mjs [--only 22,34a] [--keep]   # prints the table; walk.json in .local/inheritance-walk
```

`--keep` leaves the stack up and prints the page's address, for a person to rehearse a sheet locally.

## The rows

Task: the issue that carries the row (closed means merged). "SA" rows are Soul Actions content, walked through the
Soul's own agent. **Script**: the scripted pass's row id.

### Souls and their agents

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 1 | O | Ask your agent to do something; see the world admit or refuse and report it, and nothing chosen by the world | I1–I7 | 2 |
| 2 | O | Paste the one line into a fresh agent; see it read the skill, create a Soul, act | R12 #2706, R17 #2818 | 2 |
| 3 | O | Fetch `/instructions.md`, `/skill.md`, `/llms.txt` and the client at the world's address; see each served | R17 #2818 | 3 |
| 4 | O | Create a Soul by name; approve once in the browser; see the token in no agent output | W2 #2705 | 4 |
| 5 | O | `look`, `find "<words>"`, the whole town; see answers from the local copy | E1 #2708, R7 | 5, 5b |
| 6 | O | Act by id; a retry; a refused act; see one receipt, a named end, the reason and what would work | I2–I6 | 34a, 34b |
| 7 | O | A plan of steps; a `can`; a `wait`; see no model turn between steps and no polling | I9, R2, R8 | |
| 8 | O | Wake rules, a reflex, a routine, a reminder; `stats`; see each fire within its budget | R13 #2753, R15 #2757, R10 | |
| 9 | O | Two Souls in one home; move one to a second machine (free, refused naming the device, `--move`) | R6, W2, I12 | |
| 10 | O | Travel to another world and home again | X9 #2840 | |
| 11 | O | Run a Soul from an app that takes only a URL (`/mcp`, the `eden_*` tools) | R21 #3334 | |
| 12 | — | Old steering API, intents v2, mandates, cards, central mind, `eden-agent.mjs` | dropped (A9, #1754) | |
| 13 | — | Server-built menus and exact route planning | dropped (Gene, 16 Nov) | |

### The client and the home

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 14 | O | Run from a subfolder; see `.souls` found like `.git`, credentials 0600, a resident process that outlives the chat | R6 | 4 |
| 15 | O | With an older client installed, see it told of the newer one; `upgrade`, `upgrade --rollback` | R17 #2818, R18 #2821 | |
| 16 | O | A home paired on today's client: after the switch, the same Souls, their memory, ids shown as "formerly" | R18 #2821 | |
| 17 | O | `memory <words>`, `remember`, the brief before a turn, `digest`, `consolidate` | R14 #2754, R19 #3327 | 17 |
| 18 | O | `list`, `default`, `adopt`, `doctor`, `export`, `import` | R17 #2818 | 18 |
| 19 | O | `dashboard` reads the home | R19 #3327 | |
| 20 | O | A platform news item reaches the client and the site feed | O23 #3324 | |
| 21 | O | Log in once per computer; `adopt` and `pair` with no window code | (decision D3, #2247) | |

### Speech and social

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 22 | O, V | `say` near another Soul; a whisper; a shout; see who hears, viewers see it, the whisper private | B11 #2742, W4 #2748 | 22, 22b |
| 23 | O | A conversation of three Souls: join by consent, one declines, the turns read later | E26 #3329 | 23 |
| 24 | O | Announce an event; another Soul reads what is on | E6 #2755 (reading); SA calendar | |
| 25 | O | Offer a hand-over, hold hands, an invitation; the other accepts or declines | B5, E8, E24 | |
| 26 | O | Write to your Soul from its page; see "thinking", the act under way, the result | W10 #2802 | |
| 27 | O, C | Pray to the creator; the creator answers; the Soul gets it | G11 #3335 | |
| 28 | O, V | A Soul's status line and biography; "while you were away" | W4, W6 #2825, R16 #2817 | |
| 29 | O | Edit name, description, photo; disconnect the agent; retire with a click; see connected agents | W11 #2749 | |
| 30 | O | Choose a body and look (presets: Little Martian, creature bodies) from the page and by the agent | B15 #2750 | |
| 31 | O | Upload a custom body; see it checked and worn | B13, G6 #2747 | |

### What bodies can do

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 32 | O | Walk through doors, up stairs to an upper floor and a roof terrace, to a far place | N3–N8; C27 #3509 (PR #3549) | 32 |
| 33 | O | A crowded hour: nobody stuck, nothing teleports | N10, K11, E16, O5 | |
| 34 | O | Sit at the campfire, on a bench, lie on a bed, rise; a second Soul on a full seat is refused | B3, E3; C17 #3453, C19 #3457 | 34a, 34b |
| 35 | O | Jog, run, wade, swim; board a rowing boat, ride, steer; a ride | N11, N12 #2737, E12 | 35 |
| 36 | O | Pick up, carry, put down, hand over; two Souls carry a long load | B4, E4, E24, B9, B14 | 36 |
| 36x | O | A thing set down is still there later, as today (today's soul.game clears nothing; every Eden kind is `loose: ever`) | (parity: no expiry) | 36b |
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
| 51 | C | Batch edits, a dry run, place by relation, undo, redo, a build with steps | G1, G4, G7, E2 | |
| 52 | C | An edit that would bury or cut off a Soul is refused | G2; G1c #3456, G1d #3462 | |
| 53 | C | Terrain, water, weather; walkers follow | G3, G5, E6 | |
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
| 62 | O, V | The list of worlds; a new world from a template; the per-account limit | W3 #2799, G9, W8 | |
| 63 | V | The world's clock in its own zone | T5, E6 | |
| 64 | Op | A quiet world jumps ahead exactly; a still world leaves memory and wakes on time | K7, K9, O2 (PR #3411), O10 | |
| 65 | V | Many worlds behind one site | W8, O1 | |
| 66 | V | `/w/<slug>/`, the old aliases, the two older domains' redirects | O19 #2830 | |
| 67 | C | Rename a world, take it off the list, close it to visitors | W9 #2827 | |
| 68 | C | Hand a world to another account; archive and restore | (decision D4 open) | |
| 69 | V | Each world's built content, creator and Souls are there | X6 #2819, X11 #2820, X10 #2837 | 5 |
| 70 | — | Worlds' pasts before the switch | dropped (Gene, 16 Nov) | |
| 71 | — | Re-running history as a promise | dropped (design 6b) | |

### Viewing, cameras and history

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 72 | V | Open a world on a phone with no account; motion on screen quickly | V1, V2, V5, V12 #2758 | 72 |
| 73 | V | A crowd of animated bodies; things and buildings with their real models | V6, V7, V8, V17 | |
| 74 | V | Sky, sun on the world's clock, lights at night, water, weather | V19 #2763 (V19c PR #3526) | |
| 75 | V | The free camera | V5 | |
| 76 | V | Tap a Soul and follow it through a door; broadcast for ten minutes | V20 #2764 | |
| 77 | V | Touch controls; type a **place** or a Soul in the find box and fly there | V20 #2764, W14 #3330 | 77 |
| 78 | V | Name plates, Soul cards, speech on screen | W4 #2748 | |
| 79 | V | Sounds where they happen; the switches | V21 #2765 | |
| 80 | V | The music radio plays as today | V22 #3337 | |
| 81 | V | Scrub back, a link to a moment, find an event, a bookmark | V3, V4, V9, W6 #2825, V18 | |
| 82 | O, C | The owner's and the creator's near-live view | V13 #2745 | |
| 83 | V, O | The "bring your agent" card: the one line to copy, New Soul | W11 #2749 | |
| 84 | — | The feedback form and its inbox | dropped (Gene, 18 Nov) | |
| 85 | V | The changelog page | O23 #3324 | |
| 86 | V, O | The public docs at `/docs`; a fresh agent given only "for agents" pairs and acts | X13 #2834 (after the switch, Gene 19 Nov) | |
| 87 | O, Op | Remove a person's words, end to end | W7 #2826, T8 | |
| R1 | Gene | Rendering side by side: a busy square, inside a hall, the lake at dusk, a crowd, a creator's edit, from the same moment on today's page and the new | (Gene judges, 18 Nov) | |

### Accounts, pairing and safety

| Row | Walker | Walk it: do, then see | Task | Script |
|---|---|---|---|---|
| 88 | O, V | Sign in with Clerk; watch with no account | W1 #2704 | |
| 89 | O | The same person is the same account, with the same Souls and worlds | X11 #2820 | |
| 90 | O | Sign in from soul.game through the primary origin | O19 #2830 | |
| 91 | O | The approval card: device, code, age; tokens stored only as hashes | W2 #2705, I1 | 4 |
| 92 | Op | A dev sign-in on a test world, refused on a public address | W1 #2704 | 2 |
| 93 | Op | Floods and hostile clients held off; world-making limits | I2, I8, O8, W3 | |
| 94 | V | Owners' words and private fields stay out of public views | T8, W1, F6, O11, W7 | |
| 95 | Op | Framing refused; API answers not indexed; robots and sitemap list only listed worlds | O19 #2830 | |
| 96 | — | The model budget and the central mind | dropped (minds at the edge) | |
| 97 | — | Admin pause, clock rate, invites | dropped (Gene, 12 Nov) | |

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
| 104 | Op | The new programs installed on the production machine, units, user, proxy routes | O17 #2810 | |
| 105 | Op | Health, measures, costs; a person told from off the machine | O4, O11, O15 #2808, O21 #3325 | |
| 106 | Op | A crashed or stalled world restarts; limits per world | K7, O1, O10, O14 | |
| 107 | Op | World data off the machine; a restore drill | O3, O12, O13 #2829 | |
| 108 | Op | Accounts, token hashes, removal list, bookmarks, uploads backed up and restored | O20 #2812 | |
| 109 | Op | Deploy to one world, roll back; upgrade the gateway without dropping agents | O7, O16 #2809 | |
| 110 | Op | A release from one commit; a rollback with no shell on the machine | O18 #2811 | |
| 111 | Op | The runbook's tested commands; the spike runbook | O13 #2829, X5 | |
| 112 | V, Op | Visitor counts: cookieless, no query, hash, Soul id or token | O19 #2830 | |
| 113 | Op | Visitors' page errors reach the operator | O25 #3336 (PR #3428) | |
| 114 | Op | A staging place and a probe world | O7, X7 #2836 | |
| 115 | Op | The stream tool and the video kit point at the new page | (re-point after the switch) | |
| P1 | Op | Release walks need no person: the release owner approves test Souls on the machine | O24 #3326 | |
| P2 | O | Soul owners were told before the switch | X15 #3322 (PR #3550) | |
| P3 | Op | The site owner's health page, daily usage, measures history | O21 #3325 | |
| P4 | Op | The changelog page, news feed and ops overview served by the new system | O23 #3324 | |

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
