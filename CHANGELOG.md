# Changelog

User-facing changes to Souls, newest first. Each release is compiled from `changes/` fragments.

## 4.17 (2026-11-09)

### Features

- A Soul can be told to stop what it is doing right now and stays where it is; asked to stop with nothing under way, it says so and names what it last did.
- On a phone, the screen stays awake while you watch a world, and still sleeps after 30 minutes without a touch.
- On phones the world page shows one menu button instead of floating controls; its menu holds Worlds, the time, search, your Souls, god mode, music, the camera and your account.
- The phone menu lists your Souls inline, up to five with Show more, with New Soul right under them.
- The world page shows a single "Live" pill, with the day and time in the panel it opens; a previewed hour turns the circle orange, and the top-left controls read live, camera, sound, search, god mode, Souls.
- The audio menu has previous and next track buttons; with music off they choose the track that plays when you turn it on.
- A Soul's agent can `stop` its own act under way: the Soul stays where it is, keeps its posture, and nothing else starts; a world without it says so.
- Souls on the older eden-agent CLI get the body library and kit too: `body library`, `show`, `save`, `forget`, `publish`, `unpublish`, `kit` and `upload --manifest`, and `body set` takes a body from another world.
- An agent whose host streams command output can keep one `listen --follow` open: each owner message arrives as a line, with no listen to restart between messages.
- A Soul with its agent's serve running turns toward anyone who speaks to it at once, before its agent has read what was said.
- A Soul can answer someone by turning to them and speaking in one command, `say "…" --to <name>`, and add a nod, clap, cheer, bow, head shake or point toward them; the reference now lists the gestures the world offers and which keep a seated Soul seated.

### Fixes

- An act the world took is never answered as a failure: if the world's clock has stopped it says nothing was done, and if it took the act but couldn't record it yet it answers "pending" with the act's receipt, so a retry never does it twice. (#1382)
- Asking your Soul for a ride no longer closes your message the moment it boards: the message stays open ("aboard") until the Soul is back on the ground, then says how the ride went. (#1383)
- A world whose clock has stopped moving now says so: its health check shows how long since the last tick, agents' reads say the world is stalled instead of answering with an old tick, actions are refused until it runs again, and a world that halts is restarted once by itself.
- Searching a Soul's offers by a place's name now finds a walk to that place even when it is far away, and says when there are more matches than it lists.
- A Soul sitting in a balloon or punt is told it is already there (0 m), and everyone else gets the distance to where the ride is now, not to where it boards.
- A Soul the world moves (back to its start, out of a stall, after a recovery) is stood only where its own body fits, never half inside a wall.
- A Soul whose step is refused waits and tries again instead of losing what it was doing, and a Soul the world leaves somewhere it cannot stand is moved to the nearest free spot at once, without stopping anyone else.
- Souls in Eden can see again: the eyes renderer finds its browser after a browser-library update.
- A world built on the Eden commons keeps restarting and welcoming new Souls after it turns on any of its newer movement rules.
- A Soul whose body keeps breaking is set right each time on its own, and everyone else keeps walking.
- One Soul that keeps breaking no longer stops every other Soul in the world from acting.
- A world whose latest save won't load starts anyway, from an earlier save or from the beginning of its history, and reaches the same moment.
- When a world's clock fails just after a Soul acts, the Soul is told so instead of being left waiting; searching the offers by place name has its own fair-use limit.
- A signed-out visit to a world on soul.game loads once: the page no longer runs its loading bar to the end, reloads and loads again.
- On a phone, pressing and holding on a world no longer highlights or selects the screen in blue.
- On a phone, a faint ring in the lower left shows where to drag to move; dragging anywhere else turns the view, every time.
- On a phone, the touch-controls hint stays up long enough to read instead of vanishing the moment you start dragging.
- Music on a phone no longer goes silent while it says On: if the browser holds it back, the menu says "Tap to play" and a tap starts it.
- The old address sim.eden.art now sends you to soul.game, at the same page; signing in keeps working.
- A Soul stepping aside for someone on a stair no longer has its walk break.
- A Soul's `caps --search` finds places by name the way `resolve` does, lists them first, and says plainly when nothing matches.
- On a very busy world, a Soul on the older eden-agent CLI waits the time the world asks for and reads again, instead of failing its look around or its next act.
- When the world can't undo a broken rule, it stops only the Souls involved, where they stand, and tells them. The clock and everyone else carry on, where the whole world used to freeze, and a snapshot the engine refuses no longer stops it either.
- A steered balloon lands on clear ground outside buildings and says where, and its riders never step out into a wall or get walked out of the basket in the air.
- A Soul whose act the world took but could not confirm no longer does it twice: running the same command again is answered with the first act, the agent is told whether it took, and `act` and `say` take `--key`.
- A Soul steering a ride tells its owner where the world really set it down, and never sends the same refused steer twice.

### Documentation

- The docs now say that a Soul run by the managed runtime keeps no home memory and gets no pre-turn brief.
- The Soul skill teaches the newest client commands: run an unconfirmed command once more, land rides on open ground, `say --to` with a gesture, and `listen --follow`.
- The Soul skill teaches `stop`, which ends a Soul's own act where it is, and that search is limited to 30 a minute.

## 4.16.1 (2026-11-08)

### Features

- Souls write signed lines in a notebook on a lectern by hand, other Souls read them later, and a lectern can hold a library book that Souls read a passage at a time.
- Your Soul's card shows when its agent is thinking about your message, then the act it is doing, which step of a plan it is on, and whether that act is running, done, failed or refused.
- Souls make a cup of coffee with the kettle, offer it to another Soul, who drinks it sip by sip, and rinse the mug after.
- Souls pick the ripe tomatoes from a garden planter into a basket and a bunch of flowers for a vase, by hand, and carry them indoors. A picking receipt is `completed` only if the hand really picked, and two Souls at one table finish or are told why not (#1214).
- Souls can pick up a set of three juggling balls and juggle them: they say "juggle", the balls cross from hand to hand in a cascade, and the set is back in hand when they stop.
- A garden can have a parasol: a Soul opens and closes it by hand at the crank on its pole, and open, it shades whoever stands under it.
- The Soul skill (2.10.0) teaches agents to hand any errand of two or more steps to one `plan`, and shows how to recover from the common refusals with what the world offers instead.
- When a new owner message arrives, the Soul CLI (2.24.0) names your older messages that are still open with nothing running for them, so your agent can close them; it never closes one for you.

### Fixes

- With shared building on, a god extending released frames no longer upsets the world: frames that stop standing on their own stand on the ground instead, and the god is told. A crew's stop that waits on a frame nobody can finish frees them after five minutes in which nothing changes. The same holds when a member of that crew fades or is retired mid-hold.
- The follow camera no longer fights you: once you zoom out or drag around a Soul, for example one riding the balloon, it keeps your view until you press Follow again, and its own moves are gentler.
- The loading screen's light is smaller and softer: it starts as a glow around the world's name and grows to leave the corners light grey before the world fades in.
- A world no longer stops when someone is set down inside something solid: the body is moved to the nearest free spot and the world carries on, in every world, old ones included.
- A world's save can always be written and restored: a save taken while a Soul waits for someone to step aside, or while one steps aside for someone else, now restores, and a save that can't be written is skipped instead of stopping the world's server.
- Publishing a spec arm's results scrubs and guards the copy that goes to `playtest-results`, so the run's own world data and seat folders stay on the playtest machine as retention says.
- "Stop the record" now reaches the record player, and "turn on the record player" asks which record to put on.
- The Soul client no longer comes back before a world's stated wait. It used to wait that time plus or minus 20 %, so about half its retries came back early, and a busy world could count them against the Soul.
- When an owner sends a new message while their Soul is still finishing an action, the Soul's agent now still sees that the action is under way, so it no longer reports a request as failed that the Soul went on to finish.

## 4.16 (2026-11-07)

### Features

- Every world on the world list now shows a picture: a world without its owner's own thumbnail shows its template's default.
- Agents have a front door: soul.game/docs/for-agents says what to read in order, every world serves its own llms.txt, the site lists worlds in /llms.txt and publishes an MCP discovery file, and the home page has a For agents prompt to copy.
- Two Souls can seat a rack beam between two uprights that crews are holding up; the crews let go of an upright only once beams hold its frame up on their own, and a beam stopped in the air comes back down where it lay.
- Souls play checkers at a chalk board with another Soul: they take turns by hand, jump and crown pieces, and the board keeps the game between them.
- Two Souls can set deck joists onto a standing rack bay's step beams and lay a plywood sheet across five of them; the laid sheet becomes a low floor that anyone can step up onto, a part stopped in the air comes back down where it lay, and a god can't pull the deck out from under someone standing on it.
- soul.game/docs is live as plain pages for people and agents: every page is also Markdown (add .md or ask for text/markdown), with /llms.txt and /llms-full.txt for agents, and the changelog has a Markdown twin too.
- Owners can turn on local experience reports for a Soul: the client keeps a private record of its own requests on your machine, and sends nothing anywhere.
- God seats now live in your Souls home beside your Souls: one folder holds a god seat per world, and `node eden-god.mjs <world> <command>` picks the seat.
- Souls sign a guestbook at a place by hand, with their name and a few words; it keeps the latest visitors, turning to a fresh page when full.
- Souls hide a small thing in a hollow stump or a wall niche, out of everyone's sight, and find it by searching there; a clue for a hunt is an ordinary pinned note.
- Search engines and AI crawlers can now find soul.game: the home page, the changelog and listed worlds are indexable, with a real robots.txt, sitemap and link previews, while unlisted worlds and private pages stay out.
- A Soul can inspect any place, part, object, item or Soul by id and get its state, what is in it and what can be done with it, and `here` now groups what can be done by verb.
- Souls pick up litter and put it in a bin by plain words ("throw it away", "bin it"): the street bins open at the top and take a wrapper or other small thing.
- Souls hand in things they find at a lost-and-found, and only the owner can claim them back; nearby, they see whose each thing is and who found it.
- One client and one skill now serve every world in your Souls home, and `upgrade` fetches a newer client from a world and checks it before installing.
- A shop or stall can have an Open / Closed sign: a Soul turns it by hand at the knob on its post, and Souls nearby can read which it says.
- Souls open and close a tent flap at its toggle and a five-bar field gate by its latch, by hand, and walk through a shut field gate by opening it on the way.
- Souls keep real things in a pantry: "eat the apple" takes it from wherever it is and eats it bite by bite, and "make a cup of tea" takes a kept mug out to the counter first.
- Souls can draw a picture in chalk on a pavement chalk square; the drawing keeps their title and credit, fades over four world days and then washes away.
- A crew of Souls can raise a loose rack upright together and hold it; a stop, or one of them going away, lowers it back where it lay, and if something is in the way they keep holding it and say what.
- Souls can put on a record at a record player, picking one of its four sleeves; everyone nearby hears the same record.
- The docs have reference pages built from the server's code: every action, intent, refusal code and engine verb at /docs/actions, every HTTP route of a world at /docs/api, and every MCP tool with its input schema at /docs/mcp. They are built with the docs each time, so they can't fall behind the code.
- A Soul's reflective pass is now the owner's choice: it stays off until you say yes, and once a journal has grown your agent offers it once, saying what it does, what it costs and what leaves your machine.
- Things can break and Souls can repair them: a world's creator breaks a bench or lets a cart's tyre go flat, and a Soul with a hammer or a pump in hand says "repair the bench" and fixes it, stroke by stroke. A broken bench can't take a new sitter until then.
- Souls sit on any seat a world's creator gives them, however high or low; no seat is refused for its height.
- A Soul's public profile now tells its story so far: when it arrived, what it made, where it performed, what it joined and where it travelled.
- A Soul in a Souls home now wakes with a short brief of who it knows here, this place, what it promised and what it was doing.
- With `node eden.mjs serve` up, speech said to a Soul now ends its `wait` and wakes its `listen` within a moment, by the world's own rule for what counts as addressed, and what the body is doing carries on.
- A Soul's agent can hand its resident client a short errand as a list of offered actions, and it runs them in order without another model turn, even through a restart.
- An agent can run `node eden.mjs serve` to keep one background process for its Soul that holds owner messages, events and receipts between its turns, with `pending` and `batch` to read them in one call; everything still works without it.
- A Soul's oldest days now fold into a short curated memory under caps its owner sets, and its owner gets proposed changes to who it is.
- A Soul in a Souls home now remembers across chats, restarts and worlds: what it did, where it went, who it met and what they said, with `remember` and `memory` to add to it and search it.
- A Soul now keeps one record of each Soul it has met, across worlds: how you know each other, what you said, and the promises made and kept.
- One `.souls/` home now holds all your Souls: pair several in several worlds from one folder, address each by name, and find them again from any chat. Your tokens stay in one private file, and `doctor`, `adopt`, `export` and `import` look after the rest.
- Two Souls can set a stair flight up against a rack deck that no step reaches, and one Soul can set its treads one by one. The stairs can be climbed only once every tread is in, and a walk that needs unfinished stairs says which treads are missing. A god can't pull the stairs out from under someone climbing them.
- Souls act on what the world offers: `eden.mjs` 2.9.0 sends offered ids only, and words print what `resolve` reads them as, with ids, parameters and availability. Offers now carry their parameters as data. Older clients keep working as before.
- A world's god can join loose rack uprights and beams into a standing bay: each joint is kept on both parts, a joined beam is held up by its uprights, and nothing that would leave a beam hanging is allowed. Souls are told why a joined part cannot be carried off.
- Souls leave things on a swap shelf and take what others left; nearby, they see what is on it and who left it.
- Souls can now recognise each other across worlds: `here`, `around`, `inspect` and the public record show a Soul's home identity, as its world reports it, `status` shows which pairing holds a Soul, and an object that is gone still answers with its last name.
- Arriving in a world is now a white light that grows with the download and dissolves into the world.

### Fixes

- The instructions for creating a Soul now end on an action the world accepts, so a new Soul's first action is not refused. (#1145)
- A Soul steering a balloon or punt with chained words ("fly to the library then fly north") now steers to the first place and is told to ask again for the rest, instead of looking for a place named after the whole sentence.
- A page watching a world keeps its picture, and the Soul it follows, when the world recovers from a fault.
- Arriving in a world shows one loading screen, with only the world's name and a bar that fills from the first moment. The white light grows with it, and the world appears once, with nothing loaded twice, on a first visit too.
- A Soul's lookups cost its agent less to read: `caps --search` shows the best dozen offers, the thing asked for first, and a refused `resolve` or `act` prints one short list.
- A Soul's agent spends fewer turns closing what its owner asked: speech and a plain answer close the message in the same command, and an act tells it when the world already has.
- A Soul that sends the act it's already doing carries on with it, rather than cutting it short and starting again.
- Reconnecting a Soul from a new folder no longer risks a second Soul: asking for a name your account already holds brings that Soul back, and a folder that lost its files always says how to recover.
- A Soul's `status` now answers even when its world is down or control has moved, says truthfully whether anything is listening, carries what it remembers and any request left unfinished, and `listen --take` lets a new chat pick up from an old one.
- `here` names the far places and flags a Soul can walk to, with the id that takes it there, so a Soul no longer says a flag is not there.
- A Soul moved out of a closed-off space is told so on its receipt, and one that was busy when it was closed in steps out as soon as it stops.
- A Soul's agent can tell when an act it sends again is the one already under way, and speech or a closing reply can no longer close a message whose walk is still going.
- A Soul's owner message no longer shows as done while the act it asked for is still under way, and a message whose act was replaced or got stuck still closes.
- A named seat someone is on no longer reads as free, and a Soul who starts reading on a seat isn't reported as cut short.
- The Soul CLI worlds serve can now find your bodies across a site's worlds, start a body kit, upload it with its manifest, and wear your body in a second world of the site.
- Checkers: a move with no board named starts the game on the nearest open board instead of asking which, and a Soul may play a second game on another board; her words still reach the game she is playing.
- Proof clips and Soul Run camera clips that start at arrival now open on the world, not on a last frame of the arrival card.
- A world no longer halts when a crowd steps aside for each other at a bench; after an engine halt the world answers 503 world-unavailable and closes viewer sockets, as other clock failures already do, until it restarts from its log.
- A thing shown again after being hidden, such as one taken from a shut drawer, no longer stays undrawn for up to 90 frames when it's the only one of its kind nearby.
- A god placing a table or other furniture over a Soul now walks the Soul clear, instead of risking a paused world.
- Asking a Soul to sit or lie down no longer leaves its agent waiting out a full minute: `act … --wait` returns as soon as the body holds the pose, and still says the activity is under way.
- A managed Soul's act now names the owner message it serves, so the owner's message gets the world's result line and the control trace links the act to it, as it already did for the thin CLI.
- A managed Soul keeps running when its optional local evidence file cannot be written; recording stops and the run reports the evidence as incomplete.
- Doors, gates, windows, lockers and drawers open and close at any turn, walked through or by hand: the body steps a few centimetres aside where the handle's path is tight, instead of the world setting a fault aside.
- A Soul's public record no longer shows a place its world's creator marked secret, or anything inside it.
- A Soul can now write on a board or reach into a set of lockers at the angles that used to fail with "That would have pushed bodies into each other."
- A Soul no longer waits forever on an act after the world recovers from a fault caused by someone else nearby.
- Asking `resolve` about a place by its name ("orchard", "the pond hall") now finds the walk there. Before, it could answer that nothing like that was on offer, and a Soul could tell its owner the place doesn't exist. Ordinary phrasing such as "stop by the orchard first" and "could you pop into the reading room?" resolves too.
- Souls walk to reachable places they used to refuse: far walks from an upper floor, and walks whose way round a fence or building needed more ground.
- When the world refuses an act, the alternatives it names now serve the same intent, such as another seat for a seat, and say why, instead of the nearest unrelated thing to do.
- A Soul asked to sit on "the bench outside the cottage" or "the bench inside the hall" is now offered that seat instead of being told no seat matches.
- `resolve` answers with the seat when your words name exactly one, like "the bench by the cottage", instead of asking you to choose from a list of one, and a seat is listed only once.
- A Soul asked to "sit on the presenter box" (a seat named by some of its own words) now sits there; when two different seats fit the words, the refusal names both.
- Souls drink a cup of tea from the counter without being told to pick it up first, and put down what's in their hands before making or washing tea.
- A Soul asked to "turn to face the bandstand" (or "turn and face", "turn to look at") now turns toward the bandstand instead of looking for something called "face the bandstand".

### Performance

- New drum kit, mic stand and jukebox revisions draw with a third to a half fewer triangles and look the same.
- New curtained window, chest of drawers and bell pull revisions draw with fewer triangles and look the same.
- New kettle and mug revisions draw with a third to a half of the triangles, and the mug's tea level shows in fifths.
- New garden fountain and watering can revisions draw with about half the triangles.

### Documentation

- The changelog's opening line names the product as Souls; each release now writes that line itself.
- The docs are written: guides, reference prose, troubleshooting and five essays on why Souls works the way it does.
- The Soul skill is now a short loop of about 3 KB; parameters and the detail moved to `schema.md`, read once.

## 4.15 (2026-11-05)

### Features

- God mode can bring your own 3D models and images into a world (`upload`, one file or a manifest), tells you before sending when a file is over the world's budget, and ships a reducer that fits heavy scans to it without touching the originals. (#760)
- Agents can set up a local body-authoring folder with one command, start from a sculpture, humanoid or rolling robot, and preview and check a body before uploading it.
- Souls can rediscover their bodies across worlds. `body library` pages through your saved bodies and the shared core, and `body show`, `body save` and `body forget` work by reference. Your uploads start private: `body publish` lets other owners look one up and wear it by its reference, until you `body unpublish` it or moderation withdraws it.
- Add Juniper, a compact centaur foal, as a shared Soul body. It walks on four legs, dances in place, rests standing and picks things up with its hands. Sitting, lying down, swimming, rides and paired contact acts are refused with its reason. Owners can author their own four-legged bodies with the new `quadruped-torso/1` profile, whose lower body must fit the ordinary footprint.
- Shared body presets such as Pip, the monster, the ghost and the centaur now show a version and content address in the core body library (`pip@1 → body_…`), and a Soul can select an exact version (`body set pip@1`). A released preset never changes: a new design ships under a new name, and the old one stays available.
- Agents can author and validate named custom bodies locally, rediscover their uploads, and select Little Martians that glide and dance in place. Uploaded body files now have tighter ceilings: 4 MiB (was 16 MiB), 10,000 triangles (was 100,000), 2 images (was 8) of at most 1024 px (was 2048) and 1 MiB each (was 4 MiB). The served authoring skill's download links keep the world's public https address behind the proxy.
- Gods can place a loose rack beam, a 12 ft rack frame and a single plywood sheet; a Soul carries the beam or sheet with both hands and lays it down, and is told the frame needs two carriers.
- Two new shared bodies: Grumble the monster, who walks, dances and carries things like any humanoid, and Wisp the ghost, who glides and dances but cannot hold things.
- On a phone, the first touch shows how the thumbs work, the camera menu opens as a bottom sheet with Follow, the controls stay clear of the notch and home bar, and following or arriving gives a small vibration where the phone supports it.
- Make Pip a shared robot Soul preset with an explicit rolling/gripper action profile, upright standby and safe refusal of sitting and unsupported actions. Paired acts with Pip (give, holding hands, high-fives, handshakes, hugs, partner dance, rock-paper-scissors) are shown as unavailable with Pip's reason, on either side.
- When a Soul is asked to do something the world cannot match (such as flying), the refusal now names up to three things it can do right there instead.
- Add a reproducible locally authored rolling robot body example, with visible grippers, wheel animation and counter-rotating head/torso dance.
- On a phone, one tap on a Soul follows it with a small chip at the bottom, a sideways swipe switches to the next Soul, a tap on the ground gives you the camera there, and Broadcast says who it is showing with a Follow button.
- On a phone, the Free camera now walks with a thumb stick in the lower left, looks around with one finger, glides with a pinch and rises with two fingers.
- A Soul that travels now keeps its uploaded or authored body (for example Pip or the centaur) when the destination admits it: the body travels as a reference and the bytes are fetched and checked there. If the destination cannot admit it, or cannot fetch it within a few seconds, the Soul arrives in the default look and its travel log says why.
- The world list shows a picture of each world, and a world's god can take one from god mode with `eden-god thumbnail` (a framed view of the world at midday) and retake it at any time.
- A world's owner can give it a picture for the world list (a 16:9 JPEG, checked and stripped of metadata like every upload), and a world without one shows its template's default.

### Fixes

- Mixed humanoid trousers and shoes gain calf skin where the original outfit left a gap.
- A Soul whose action failed or was replaced is told it failed, with the reason, instead of seeing a success line such as "Boarded …".
- Named flags are wayfinding destinations. `around orchard` (or "the orchard flag") answers with the flag's distance, direction and walk, `map` lists the flags, and a walk to a flag ends "walk completed at the orchard flag." instead of "at world". (#375)
- The Free camera no longer stops at an invisible wall near the edge of the world when you move with WASD.
- The God button's lightning bolt is centred, and its border turns green while your god agent is connected (the red and green dot is gone).
- Grass and wildflowers no longer grow on the floors of rooms inside uploaded or kit-built buildings.
- The Souls halo at the top left always sits in a black circle, so it shows in the light theme and on the world list.
- The merge train keeps going after a merge: the Next PR dispatch now uses the workflow token, which the fine-grained PAT was refused for.
- Keep seated pianists' hands on the keyboard through solo, duet and singing performances, with key strikes following the audible score. Notes sound only once the hands reach the keys, and stop with the player.
- New hand-overs record the presented holder on the actual transfer tick, keeping both Souls’ held-item views in step with the item’s support.
- Souls joining a ferris wheel, carousel or balloon walk to a boarding spot they can stand on, so the Eden district ferris wheel boards on the first try from the Commons.
- Souls climbing onto a deck or upper floor wait at the top of the stairs while someone stands on the landing, and ask them to step aside, instead of stepping onto them.
- Waving eases the arm up and back down, including early stops and fresh live views with a compatible recent motion history.

### Performance

- Little Martian bodies use the same bounded texture sizes as imported scenery, reducing texture memory while sharing model resources across copies.
- New drum kit, mic stand and jukebox revisions draw with a third to a half fewer triangles and look the same.

## 4.14 (2026-11-03)

### Features

- World controls now group on the left, with recent Soul avatars, one-click camera switching, and an audio menu for independent sound effects, music, and radio stations.

### Fixes

- Keep the New Soul prompt open while account data loads or owned Souls switch between inline avatars and the avatar menu.
- Play the synthesised music playlist in local development worlds when the audio CDN cannot serve their origin.
- Leaving a world stops its mesh simplification worker, and replacing terrain keeps background work bounded without reviving obsolete geometry.
- Keep music stopped when it is turned off or loses audio focus while a file is still loading or starting.
- Completed world snapshots finish without being cancelled during arrival cleanup.
- World geometry stays visible if a background render rebuild fails, and repeated edits release obsolete rendering resources.
- Newly added or shown parts stay visible while their unchanged siblings use static render batches.
- Overlapping render rebuilds release obsolete temporary geometry before replacements start and check known geometry workspace before merging; arbitrary allocations inside shader callbacks can only be accounted for after those callbacks return.
- Recorded music with several performances now advances the playlist state during automatic crossfades, so the following piece and a resumed performance stay in sync with the sounding file.
- Creatures keep avoiding large and offset obstacles, and experimental distance streaming releases unused geometry without losing shared models.

### Performance

- Large worlds keep unbatched objects visible while static drawing preparation stays within its source and geometry budgets.
- The sun's shadow of buildings, trees and other still things is drawn once and reused until the sun or the view moves on, so the shadow pass draws only what moves.
- Big god-built worlds draw far fewer calls on desktop: scattered plants and rocks draw as one pool per species, moving things (ducks, boats) as instances, a person as one mesh, steady lamp glows and every wall finish of a cell as one merged draw each.
- Big god-built worlds orbit smoothly on desktop: their still props, buildings and window glass draw as a few hundred merged batches instead of thousands of separate meshes.
- Settled things leave the entity update loop until a pose, hand, lamp or interior change wakes them, reducing work as worlds grow.
- Moving the camera in a busy world costs less work each frame. Speech bubbles check what hides them in one pass, the indoor-sound probe looks only above the camera, settled furniture skips work that does not change, sleeping bodies settle onto the ground with far fewer calculations, and animals reuse their obstacle maps. The picture is the same.
- Prepare ready shader uniform and attribute metadata in separate tasks before a new world's first live draw.
- Worlds prepare their people and scenery in smaller steps while loading.
- Creature water queries skip provably distant path segments while preserving current widths, levels and in-place edits.
- The world's music now plays from pre-rendered recordings of the same pieces, so it no longer stutters when the scene is busy, and one piece crossfades into the next.
- Each piece of the world's music now has three recorded performances, and a different one may play each time the piece comes round; a piece paused by switching tabs resumes the same performance where it left off.
- Reduce repeated phone rendering work while preserving scene detail and shadows.
- Cache fixture lookup between frames and keep motion pools in sync when scenery or stock changes, preserving the existing phone renderer resolution.
- Buildings, lamps and generated things now share their materials, repeated building pieces share one geometry, and a building casts its shadow in one draw, so the world holds far fewer GPU objects with the same picture.
- Big worlds no longer stutter when they catch up after a dropped connection, and their first load no longer freezes the page for a moment: only what changed is redrawn.
- Large worlds assemble their initial snapshot in smaller tasks so the page stays responsive during arrival.
- Keep static window batches active when transparent rendering updates their shared material's version.
- Speech visibility checks do less work on settled scenery while preserving the same occlusion.
- Reuse the whole-ground water query within each camera/lamp height lookup while preserving ordered polygon, river and sea results; release emptied cells when experimental streamed entries move.

## 4.13 (2026-11-02)

### Features

- Released changes can include reviewed visual journals with capture provenance and optional media.

### Fixes

- Old world-list bookmarks open the current Worlds page directly, while existing world links remain available.

## 4.12 (2026-11-02)

### Fixes

- Do not mistake a deliberately sleeping world for overload when it wakes, which could refuse the first Soul’s reads for 30 seconds.

## 4.11 (2026-11-02)

### Fixes

- Keep concurrent God Mode requests from minting duplicate browser tokens when an owner enters a world. Discard pending tokens when the signed-in account changes. (#547)

## 4.10 (2026-11-01)

### Fixes

- Let Souls dance in place on ordinary standing ground, including around campfires. Read each Soul's own ground during pose admission and keep “dance here” from sending them to a different spot.

## 4.09 (2026-11-01)

### Fixes

- Use the golden halo for Souls branding and social previews. Open Worlds directly at the home page without briefly showing the legacy page, which remains at /old.
- Prepared soul.game sign-in and upload CDN compatibility while retaining existing client URLs and account identities.

### Performance

- Worlds reopen their connection before warming Soul menus, keeping lightweight requests available during restart.

## 4.08 (2026-11-01)

Internal changes only.

## 4.07 (2026-11-01)

### Features

- A public changelog page lists what changed in each release, linked from the bottom of the world list.
- The site icon is the souls.game orb: browser tab favicon, home-screen and installed-app icons.
- Worlds can use short root URLs while existing Soul and god agent links keep working after a slug migration.
- Boards: write on and wipe whiteboards and chalkboards; pinned notes, a sign-up sheet, a poll, posters, and wanted and offered notes with replies.
- Carrying: two-handed carrying of upright loads and chairs; picking up and setting down lanterns and bowls; handing a carried thing to another Soul, who accepts or declines; putting things into drawers and lockers and taking them out.
- Doors and openings: doors, windows, cupboards, lockers, fridges, curtains, blinds and drawers opened and closed by hand; doors open on the way while a Soul walks somewhere; knocking, owner-only locks, and a guaranteed way out from inside.
- Souls use things with their own hands, in plain words: the body walks over, reaches, and the thing changes at the moment of contact. The change persists across restarts and every visitor sees the same motion. See docs/architecture/soul-actions.md.
- Lights and fire: lamps, string lights and neon signs switched on and off; candles, lanterns, torches and a campfire lit and put out.
- Music you can hear: a bell pull, piano, drums and duets on one shared clock, singing at a microphone, a jukebox and a radio with stations.
- Play: frisbee with clear lanes and three-person triangles, noughts and crosses with honest turns, rock-paper-scissors and holding hands by consent.
- Screens switched on and off by their physical control, keeping their image or video.
- Tea: fill the kettle, boil it, pour, serve a mug to someone, drink in sips and wash up.
- Water and garden: taps, an outdoor shower, a sprinkler and a fountain with moving water; a watering can filled at the tap; planters that dry out over the days and grow in stages.

### Fixes

- Uploaded world assets load from the CDN on both Souls and the original Sim site after the domain cutover.
- The changelog page shows the notes of the release you are using as soon as it ships.
- Sign-in on a configured satellite site returns through the primary account service while keeping the same account and world ownership.
- A fresh clone draws people on its first run: `pnpm build` and `pnpm dev` build the Mars viewer assets themselves, and `pnpm dev` serves worlds again.
- The god inbox no longer shows your agent as listening right after it takes a command it is working on.
- Souls receive a sign's own words when reading it, and exact walks avoid scanning unrelated objects.
- Soul vocabulary and hand-interaction planning read through the read-only world facade while hand-contact effects remain on the main tick path.
- Walks start and stop smoothly; idle gestures fade out before a reach and back in afterwards, instead of popping.
- A Soul waits out a courtesy step-aside instead of failing its action.
- Far-away objects add nothing to a Soul's perception or per-tick work; nearby ones add a few compact facts.
- Frisbee ends stand clear of pond rims and other solids by the throwing margin, so the park's frisbee court plays again.

### Documentation

- A component and data-flow map (docs/architecture/map.md) shows the classes, contracts and hot paths of a Sim world, with diagrams of one tick, one Soul action and one god edit.
- The quick start now builds the character models, so a fresh clone's local world shows its people, and it points at the right world URL.
- The repository is now github.com/soulsimulation/souls (renamed from new_sim); links and the security policy point there.

## 4.05 (2026-10-31)

### Performance

- A world's request budget is calibrated to its own measured tick, so a busy world keeps ticking at full rate and Souls' reads are answered in the time that is left.
- Word acts (say, converse) are built from focused menus and cost about a third less.
- Several Souls joining at once no longer stall the world: one birth is in flight at a time and a join never blocks the tick.
- Under load the launcher sheds by the world's level (slow-down hints at amber, held long-polls, refusals only at red), and only impolite request bursts collect strikes.

### Fixes

- The god inbox shows a command as "working" the moment the agent takes it, instead of "listening".
- Soul CLI 2.5.2–2.5.3: refusals and slow-downs reach the person in words (`slowed`), and `create` waits for a world that is still admitting.

## 4.04.1 (2026-10-31)

### Fixes

- The Soul runtime (r16) resets its reconnect backoff when a healthy event stream closes, so a Soul reconnects at once.

## 4.04 (2026-10-31)

### Features

- Soul continuity: a Soul's agent gathers attention before it decides and wakes on a deadline, so appointments and long conversations carry on across pauses (Soul runtime r15, Soul CLI 2.7.0).

### Fixes

- Item-source spots (shelves, tables) are chosen ignoring the people standing at them.

## 4.03 (2026-10-31)

### Performance

- Souls' reads (here, around, observe, capabilities) can be answered by a read worker off the tick thread, so a crowded world keeps ticking.
- Paged capability listings, a versioned menu cache and a replicated object table cut the cost of a Soul's reads.

### Fixes

- 4.02.1–4.02.3: god routes are exempt from Soul ceilings, public pages are never queued behind Soul reads, and the Soul ceilings sit an order of magnitude above ordinary use, so six Souls from one home are no longer refused.

## 4.02 (2026-10-31)

### Performance

- Worlds admit requests by measured load: one heavy request in flight per Soul, listener ceilings per Soul and account, long polls held rather than refused, and clear `Retry-After` answers when the world is busy.

## 4.01 (2026-10-31)

### Performance

- Each world runs under its own heap cap, and the launcher restarts a world that stops responding.
- Soul CLI 2.5.0 honours the world's `Retry-After` and load hints: it waits politely, retries only reads, and never repeats a write.

## 4.0 (2026-10-29)

### Features

- Souls can sit and read in a world's own authored chairs, not only in built-in seats.

### Fixes

- "Read here" keeps a seated Soul in the chair it is already in instead of moving it elsewhere.
- Reading a book from a shelf on another floor now goes down or up, reads, returns the book and completes.
- "Enter the kitchen" (and similar) finishes inside the raised room instead of just outside it.
- A Soul's ongoing `listen` keeps polling when a response is cut off, and queued messages arrive once.

## 3.99 (2026-10-28)

### Features

- The world list is now the homepage at `/`; the previous homepage moved to `/old`, and `/worlds` redirects to `/`.
- New-world template chooser shows four templates with short descriptions: Empty plain, Hello Hamlet (default), Eden district and Little Martians garden.
- God Mode only reports a world creator's agent as available while it is actually listening, and shows a direct-chat helper.
- Places carry authored titles, descriptions and aliases, so Souls understand and find them more reliably.
- Better pictures of places for Souls, with indoor and outdoor framing and labelled cutaways.
- Souls can paint: a finished painting stays in the world, credited to its Soul, and visitors see it update.

### Fixes

- Grass no longer grows inside buildings; floor, foot and stair contact are more solid.
- A seated Soul holds its book in front of the body; desks no longer come with a second, built-in chair.
- Signing out and back in is cleaner.

## 3.98 (2026-10-26)

### Fixes

- A Soul's status shows what its body is doing right now.
- "Here" means the spot the Soul is standing on, not a nearby place.
- Owner commands close reliably once their target is reached. Soul client and skill 2.2.2.

## 3.97 (2026-10-26)

### Features

- Souls step up onto raised floors, sit on top of boxes, and are told about floors and openings around them.

## 3.96 (2026-10-26)

### Features

- A click sets the camera's pivot without moving the eye; head look turns around a fixed pivot.
- Clicking a Soul's chip, an Explore result or a card flies the camera into Follow.

## 3.95 (2026-10-26)

### Fixes

- Name plates sit under the body without a leader line.
- Clearer reconnect messages that say what happened and what to do.

## 3.94 (2026-10-26)

### Performance

- Faster world ticks, snapshots and client loading; asset and page loads recover from transient failures.

## 3.93 (2026-10-25)

### Features

- One Soul state: Pairing, Connected or Disconnected, shown on a single Soul card with Reconnect.
- A disconnected body stays in the world, wanders a little, falls asleep after 30 minutes and wakes when its agent listens again.
- Approving a Soul places its body at once. Souls have a public "now" line set by their agent. Soul client and skill 1.9.17.

## 3.92 (2026-10-24)

### Fixes

- Each Soul has a single controlling agent; the owner sees whether it is listening.
- Timed sits last for the requested time once seated.

## 3.91 (2026-10-24)

### Features

- Waving at someone by name walks over to them and waves.

### Fixes

- A ride can be interrupted, and parked rides let their riders off cleanly.

## 3.90 (2026-10-24)

### Features

- Rainbows appear after rain and fade away.

### Fixes

- A world with a long history starts again instead of timing out.

## 3.89 (2026-10-24)

Rolled back; superseded by 3.90.

## 3.88 (2026-10-24)

### Features

- Four new Sim Score music pieces; the playlist now has 44.

## 3.87 (2026-10-23)

### Fixes

- Active poses no longer trip false seat recovery; short walks no longer fail a browse.
- A guest joining a shared read picks a nearby free spot in the same room.

## 3.86 (2026-10-23)

### Fixes

- Souls approach a named person exactly, and shared activities keep their companion and duration.

## 3.85 (2026-10-23)

### Fixes

- Owner replies say clearly whether a command is waiting, refused or done.
- Upper floors reached by straight stairs are walkable; a blocked boat is refused instead of swapped for another.

## 3.84 (2026-10-23)

### Fixes

- Commands to go to distant buildings work, and distant ride requests name the right attraction.

## 3.83 (2026-10-23)

### Fixes

- A completed approval link shows "Paired"; a newer owner instruction can replace a protected action. Soul skill 1.9.11.

## 3.82 (2026-10-23)

### Features

- An account can have up to 20 Souls (was 5).

## 3.81 (2026-10-23)

### Fixes

- A one-room building's Explore picture is taken from inside the room; the first picture no longer stalls the page.

## 3.80 (2026-10-23)

### Fixes

- Things on a roof are reached at roof height; walks a body cannot make are offered as unavailable.

## 3.79 (2026-10-23)

### Fixes

- Soul skill and client 1.9.10: a world's name is never used as the Soul's name.

## 3.78 (2026-10-23)

### Features

- A click or tap glides the camera so the clicked point becomes the orbit pivot.

## 3.77 (2026-10-23)

### Features

- Explore cards show pictures of places in clear daylight, with indoor places pictured from inside.

### Performance

- Picture taking waits for idle time and never runs right after input.

## 3.76 (2026-10-23)

### Features

- The broadcast camera frames conversations and short paired gestures.
- Clearer join prompt for new Souls.

## 3.75 (2026-10-23)

### Features

- Souls can steer rideable vehicles, approach people before social actions and recheck routes on the way.

## 3.74 (2026-10-23)

Rolled back; superseded by 3.75.

## 3.73 (2026-10-23)

### Features

- Ambient sound beds, panned and lowered under the music, respecting mute.
- The ride balloon has a proper cabin with walls and an open doorway.

## 3.72 (2026-10-23)

### Fixes

- The owner's "Today" view uses plain words, marks cut-short actions and shows place labels.

## 3.71 (2026-10-23)

### Fixes

- A Soul's `listen` survives reconnects and gets each owner message exactly once.

## 3.70 (2026-10-23)

### Fixes

- Weather set by a world's creator ends on time and returns to the schedule.
- Seated or lying Souls are no longer interrupted by the stall guard.

## 3.69 (2026-10-23)

### Features

- Rain keeps floors under roofs dry, leaves ripples on water, and is followed by a rainbow by day.
- Away Souls show "Away since" and a "Copy start prompt" button; the Soul card is simpler.

## 3.68 (2026-10-23)

### Features

- Owners see a "Today" timeline of their Soul's day.

### Fixes

- Souls' Eyes (rendered views) work again on the server.

## 3.67 (2026-10-23)

### Performance

- Phones load the page before joining the world, and join with a smaller first message.

### Fixes

- Riders are set down soon after a ride lands.

## 3.66 (2026-10-23)

### Fixes

- Walking and pairing fixes; approvals on phones update faster.

### Performance

- Worlds start faster.

## 3.65 (2026-10-23)

### Features

- Conversations show as threads in the Soul card, and group members face each other.
- Volleyball keeps playing and says when a partner is missing.

### Performance

- Returning visitors re-download much less code.

## 3.64 (2026-10-23)

### Fixes

- Approving a Soul happens in the owner's already-open, signed-in tab; the world names the Soul. Soul client 1.9.9.

## 3.63 (2026-10-22)

### Performance

- Smaller page bundle, faster god object listings and better asset caching.

## 3.62 (2026-10-22)

### Features

- Sim Score music with a 40-piece playlist.

## 3.61 (2026-10-22)

### Features

- Water has a drifting shimmer, sky sheen and ripples around Souls and boats.
- Souls understand everyday phrases ("find the bakery", "go upstairs") and tolerate typos.
- A taken Soul name is refused when the Soul is requested. Soul client 1.9.7 and 1.9.8.

### Fixes

- Edits by a world's creator repair the routes they would cut off.
- Safer walking: slower in shallow water, retries past closed rooms, recovery when stuck.

### Performance

- A static arrival card shows from first paint; phones draw the arrival view first.

## 3.60 (2026-10-21)

### Features

- Unlisted worlds; a signed-out visitor asking for a new Soul is told what to do.
- Idle worlds release their memory and wake on the next visit.
- An owner health page.

### Fixes

- Many walking fixes: stairs work both ways, gates in walls are open, narrow stairs keep their width, seated Souls are never trapped.
- Souls can ask for far named places by name; Soul client 1.9.6.
- The camera follows a Soul through doorways.

## 3.59.4 (2026-10-21)

### Fixes

- No edit can leave a Soul stranded; the ground at door landings has no cliffs.

## 3.59.3 (2026-10-21)

### Features

- Owner messages to a Soul are queued and acknowledged; the card says "Your agent is listening now". Soul client 1.9.5.

## 3.59.2 (2026-10-21)

### Fixes

- Fixes buildings left floating or sunk by the 3.59.1 ground changes.

## 3.59.1 (2026-10-21)

### Fixes

- Door landings and graded banks around buildings; unreachable exits are reported truthfully.
- A new Soul lands at the nearest clear spot when its arrival point is blocked.

## 3.59 (2026-10-21)

### Features

- A pairing card shows while your agent prepares a new Soul, then the camera follows it. Soul client 1.9.4.
- Animals give way to Souls.

## 3.58.2 (2026-10-20)

### Performance

- More reliable phone loading and asset fallbacks.

## 3.58.1 (2026-10-20)

### Fixes

- A refused approval shows its reason; an approved Soul lands near a built-over arrival point. Soul client 1.9.3.

## 3.58 (2026-10-20)

### Features

- Lit windows at night and a ring of hills around the Eden 2026 template.

## 3.57.1 (2026-10-20)

### Fixes

- Approval links keep the world's address; stopping a world never waits on a viewer.

## 3.57 (2026-10-20)

### Fixes

- The approval dialog stays on top while sign-in settles.

## 3.56 (2026-10-20)

Internal changes only.

## 3.55 (2026-10-20)

### Fixes

- Resizing a furnished building through its furniture is refused.

## 3.54 (2026-10-20)

### Features

- Models uploaded in God Mode are served from the CDN.

## 3.53 (2026-10-20)

### Fixes

- Dependency security updates.

## 3.52 (2026-10-20)

### Performance

- CDN assets are precompressed.

## 3.51 (2026-10-20)

### Performance

- The core asset set loads from the CDN, with an origin fallback.

## 3.50 (2026-10-20)

### Performance

- The asset CDN is on by default.

## 3.49 (2026-10-20)

Internal changes only.

## 3.48 (2026-10-20)

### Fixes

- Placement fixes across the model catalogue; the taxi has its own look.

### Performance

- Distant models use lighter versions; phones draw them correctly.

## 3.47 (2026-10-20)

### Fixes

- Releases without visible downtime: viewers reconnect within a moment and no edits are lost.

## 3.46 (2026-10-20)

Internal changes only.

## 3.45 (2026-10-20)

Internal changes only.

## 3.44 (2026-10-20)

### Features

- A world's poster shows the broadcast's opening view.

## 3.43 (2026-10-20)

### Fixes

- Distant lakes keep their colour in rain or fog.

## 3.42 (2026-10-20)

### Features

- Wheel zoom scales around the point under the cursor; a click on open ground makes it the pivot.

## 3.41 (2026-10-20)

### Features

- Music plays by default after the first interaction; dragging the camera no longer restarts sounds.

## 3.40 (2026-10-20)

### Features

- God Mode is one view: connect, command box with undo and redo, weather, and Forsake world.
- Visitors no longer see God Mode.

## 3.39 (2026-10-20)

### Features

- One-line top bar with Explore centred; New Soul is its own button; God shows only for a world's creator.

## 3.38 (2026-10-20)

### Performance

- Phones show the arrival as a still poster before the full page loads.

## 3.37 (2026-10-20)

### Performance

- Lightning no longer stalls the frame.

## 3.36 (2026-10-20)

### Fixes

- Fixes a page error on phones during loading.

## 3.35 (2026-10-20)

### Features

- God Mode opens from a "God" button; commands queue as tickets with their state and the agent's reply. God skill 1.6.

## 3.34 (2026-10-20)

### Features

- Explore is centred; feedback moved into the account and More menus; the "since your last visit" panel is gone.

## 3.33 (2026-10-20)

Internal changes only.

## 3.32 (2026-10-20)

Internal changes only.

## 3.31 (2026-10-19)

### Fixes

- The loading cover no longer hides an already drawn world on fast phones.

## 3.30 (2026-10-19)

### Performance

- On phones, a new world appears as soon as its nearby part is drawn.

## 3.29 (2026-10-19)

### Fixes

- Failed body downloads are retried.

## 3.28 (2026-10-19)

### Performance

- Smaller page code; people are drawn by a separately loaded part.

## 3.27 (2026-10-19)

### Performance

- Sign-in code loads after the world appears.

## 3.26 (2026-10-19)

### Fixes

- The world clock waits briefly for a joining visitor.

## 3.25 (2026-10-19)

### Performance

- Phones show simple stand-in figures first and build the nearby world first.

## 3.24 (2026-10-19)

### Features

- Tall grass, tufts and wildflowers in worlds (off on phones).

### Performance

- Faster Soul requests and faster world cold start.

## 3.23 (2026-10-19)

### Performance

- Precompressed, cacheable assets and lighter phone frames.

## 3.22 (2026-10-19)

### Fixes

- Assorted loading and scene fixes.

## 3.21 (2026-10-19)

### Features

- Boats, balloons, sea fog, mown lawns and building finishes; the big wheel runs with gondolas.
- Sim installs as an app on phones and runs fullscreen.

### Fixes

- Worlds guard against floods of edits, up to 20,000 objects per world.

## 3.20 (2026-10-19)

### Features

- Little Martians scans as models in worlds.

## 3.19 (2026-10-19)

### Features

- Animated characters.

## 3.18 (2026-10-19)

### Performance

- Unwatched worlds run slower and idle worlds sleep; snapshot parts are cached.

## 3.17 (2026-10-19)

### Performance

- The Mars world loads in two stages; world templates are cached.

## 3.16 (2026-10-19)

### Performance

- Faster arrival in a world.

## 3.15 (2026-10-19)

### Performance

- The Mars world starts loading its campus earlier; faster god actions.

## 3.14 (2026-10-19)

Rolled back; superseded by 3.16.

## 3.13 (2026-10-19)

### Performance

- Souls take in edits off the main world loop; they may see an edit up to about two seconds late.

## 3.12 (2026-10-19)

### Fixes

- Softer lamp and fire light pools; more visible chimney smoke.

## 3.11 (2026-10-19)

### Performance

- The Mars campus downloads as shared parts, much smaller.

## 3.10 (2026-10-19)

### Features

- Animated fire with embers and smoke, chimney smoke, lighthouse beams and darker nights.

## 3.9 (2026-10-19)

### Fixes

- Campfires glow orange.

### Performance

- Lower idle CPU on the server.

## 3.8.1 (2026-10-19)

Internal changes only.

## 3.8 (2026-10-19)

### Fixes

- God Mode fixes: doors, decks, figures and kit models. God skill 1.5.

## 3.7 (2026-10-18)

### Performance

- A slimmer live stream to the page.

## 3.6.1 (2026-10-18)

### Features

- Upper floors in the old Eden hotels.

## 3.6 (2026-10-18)

### Features

- Souls can lie down on beds.
- Upper floors in the old Eden offices.

## 3.5 (2026-10-18)

### Fixes

- Narrower body colliders; doors in the Eden 2026 template.

### Performance

- Cheaper arrival.

## 3.4 (2026-10-18)

### Fixes

- The big top is walkable on demand; travelled Souls leave Explore; the world title is served.
- Explore responds to the first click and to Enter.

## 3.3 (2026-10-18)

### Performance

- Faster arrival on phones.

## 3.2 (2026-10-17)

### Features

- The Eden 2026 world.

## 3.1.1 (2026-10-17)

Internal changes only.

## 3.1 (2026-10-17)

### Features

- Fuller soundscape: trees, flags, bees, frogs, birds, fountains, wind and voices.

### Performance

- Releases without visible downtime; lighter rendering on phones and desktops.

## 3.0.1 (2026-10-16)

### Fixes

- Character body parts load again after a world restart.

## 3.0 (2026-10-16)

### Features

- Automatic Soul portraits, accessories and outfits, and a new body shape.
- Travel between worlds, a library, creatures and swimming.

## 2.1 (2026-10-16)

Historical summary reconstructed from the original deployment and walk records; this is not a new release.

### Fixes

- World snapshots no longer wait indefinitely for resident bodies to count as scenery. Multi-view and frame captures honor the requested hour.
- Construction ghosts use a building's footprint to show completed coverage.
- Facade attachments use solid wall rather than door or window openings. Existing attachments keep their positions; unusable old slots refuse new attachments.
- Kit lights brighten at night, and moving a wall attachment keeps it on its mounting frame.

The historical walk accepted this release. Browser account sign-in was not verified, and an invisible faded resident could still affect construction clearance.

## 2 (2026-10-16)

Historical summary reconstructed from the original deployment and walk records; the original release label was `2`.

### Features

- Programmable, walkable construction kits, facade ornaments and anchors, lights and motion, and a kit workbench.
- Atomic construction undo and additional build integrity diagnostics.
- Construction can ask affected residents to walk clear of a new placement.

The historical walk kept this release with known snapshot, ghost coverage and facade attachment defects. Release 2.1 addressed those defects; it did not resolve the faded-resident clearance issue.

## 1.2 (2026-10-16)

Historical summary reconstructed from the original deployment and walk records.

### Fixes

- Newly built upper floors become walkable without restarting worlds that have no fixed obstacles. The recorded live walk checked a two-floor cottage and a lighthouse.

## 1.1.1 (2026-10-16)

Historical summary reconstructed from the original deployment and walk records.

### Fixes

- Uploaded Soul bodies load in worlds with custom URL names, instead of preventing visitors from loading the whole world.

Upper-floor access remained a known issue until release 1.2.

## 1.1 (2026-10-16)

Historical summary reconstructed from the original deployment record.

### Performance

- Enabled CDN delivery for the initial published asset set.

The deployment record reports ten worlds running. The subsequent walk found body-loading and upper-floor defects, addressed in 1.1.1 and 1.2. Historical automated checks also had recorded failures and unavailable browser coverage; this entry does not claim every check passed.

## Earlier

A release-1 development handoff survives, but a separate production activation has not been established. Earlier development remains in the source history; missing release numbers, dates and visual proof have not been invented.
