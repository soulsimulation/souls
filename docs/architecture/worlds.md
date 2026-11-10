# Worlds and the launcher

A world is one world-server process (`apps/server/src/main.ts`) with its own database, clock and log. What kind of world
it is comes from configuration:

| Setting | Effect |
|---|---|
| `WORLD_KEY` | `toy`, `mars`, `littlemartians`, `eden` select authored worlds with their own content; any other key is an entity world on the green field |
| `ENABLE_WORLD_ENGINE=1` | God mode and the entity world model (on for every non-authored key) |
| `ENGINE` | `mars` (the vendored Mars engine) or `toy` (default) |
| `WORLD_ID`, `WORLD_PATH`, `PUBLIC_URL` | Identity and public address; the world derives its base URL from `PUBLIC_URL` + `WORLD_PATH` |
| `MIND_DRIVER` | `edge` (default) or `central`; see [brain](brain.md) |
| `GENESIS_FILE` | A template the world is built from on first boot |

## Visitor controls

The world navbar groups controls on the left; the account/sign-in control stays on the right. Explore (magnifier,
⌘K / Ctrl+K) and owner-only God mode (bolt, ⌘G / Ctrl+G) retain their shortcuts and accessible names. Narrow screens
wrap the left group without hiding controls.

Up to three available account Souls appear inline beside New Soul. Four or more become one overlapping avatar pile;
its menu contains every available owned Soul and New Soul. Selecting a Soul opens its card and follows it, and moves
it first in the account/world's browser-local selection history. Unselected Souls use the server's stable order;
opening the menu does not change history. Server ownership and current availability filter every displayed avatar.
New Soul has one controller outside the account-keyed avatar group; only its entry is rendered in the inline or
menu slot. An open prompt survives delayed account data and a change between those layouts. The controller resets
on a real provider-identity change, so a previous account’s window code cannot carry into another account.

The split camera control shows Broadcast, Free or Following a Soul (and loading/recorded state where applicable).
Its main segment switches Broadcast → Free or returns Free/Following → Broadcast in one click. The chevron offers
explicit modes and Camera controls, including the existing movement guide, reset and device fullscreen option.
Dragging, zooming and movement keys retain their existing camera behavior.
Follow is coupled until the viewer pulls the camera out (#1316, `WorldFollow.ts`). Coupled, the camera finds a clear
view of the Soul, coming in close or following it into a house, on eased glides (no cut except an explicit jump such as
a new Follow). A zoom out or a drag round decouples it: it keeps the viewer's angle and distance, carried along with the
Soul, and occlusion never pulls it back in, also around a balloon basket or other ride. Zooming in stays coupled. A
short cue says so, and Follow again (the chevron menu or the Soul's card) couples it.
Free has no wall near the map's edge: a lost-camera guard (`WorldRtsCamera.keepPivotInBounds`) keeps the eye within one
far-zoom limit (320–1,400 m) of the world's ground rectangle, far beyond the map; where the pivot sits does not matter.
On a touch screen in Free (`apps/web/src/touch/WorldTouchFree.ts`), a touch that starts in the lower-left 45 % of the
view spawns a floating stick that walks the eye; one finger elsewhere looks in place, a pinch glides toward the point
between the fingers, a two-finger vertical drag rises or lowers, and a double-tap flies there. Each gesture feeds the
existing `WorldRtsCamera` path (WASD, Q/E, right-drag, wheel, double-click), so the same guard holds. A finished touch
look always commits its new pivot, kept within that guard's rectangle. Follow and Broadcast keep OrbitControls' touch
orbit and pinch. While the stick is available, a faint dashed ring marks its home in the lower left (#1387): a drag from
the ring moves, and a drag anywhere else turns. The ring is hidden while the floating stick is up, and in Follow and
Broadcast, where no stick exists. The first-run hint uses the same words.
On a touch screen, one tap on a Soul's body or name plate follows it at once, through the same `flyToSoul` glide as the
card's Follow button; the Soul's card collapses to a bottom chip (`SoulChip.tsx`: name, status line, Card). While
following, a fast one-finger sideways flick (`touch/soul-swipe.ts`: over 60 px, under 400 ms) goes to the next (left)
or previous (right) Soul here; slower drags still orbit. The order is a ring made on a swipe only: the followed Soul,
then the others by the director's interest score, then by distance. A tap on the ground while following hands you the
camera (Free) and glides it to that point (`WorldRtsCamera.flyToGround`). In Broadcast a touch screen's chip reads
"Now showing <name>" with a Follow button. Mouse clicks keep the card-and-button flow.
A press, long-press, double-tap or drag anywhere on a world page never selects text or shows a tap highlight. The
selection, callout and highlight are off on the page, its menus, its modal dialogs and the boot arrival (#1386). Fields,
code and the copyable start prompt keep their text. The first touch of a page on a touch screen shows three glyphs
(stick, drag, pinch; `touch/hints.tsx`). They stay up for at least 4 s whatever the person does, then fade on the next
drag, second finger or tap, or by themselves at 10 s (#1388). Once they have been up for 4 s, the device remembers them
in `localStorage` (`sim.touch-hints`). `?shot`
and automation (`navigator.webdriver`) never show it. `?hints=1` overrides `navigator.webdriver` only, for recording
proof of the hint. While a world page is visible, it holds a screen wake lock (`wake-lock.ts`, #1390), so a phone
does not dim while someone watches. It lets the lock go when the page is hidden and asks again when the page is shown.
After 30 minutes with no input it also lets go, and the next input asks again. Where the API is missing or the request
is refused, it does nothing. Phones get the camera menu as a bottom sheet (Broadcast, Free, Follow for a selected Soul or Stop
following, Camera controls, Fullscreen) clear of `env(safe-area-inset-*)`. A device with `navigator.vibrate` ticks for
12 ms when Follow starts and when a fly-to arrives (`touch/haptics.ts`).

Audio opens independent Sound effects and Music switches plus a radio station selector. Stations curate the existing
score playlist: All music, Quiet & ambient, Electronic and Upbeat. Choosing a station while music is off remembers
it without starting playback. Previous and next buttons around the track's name change the piece. With music on,
the new piece plays from its start; with music off, it is only selected and plays when music is turned on (#1393). The
Music switch shows what is actually sounding: Off, Starting…, On, or **Tap to play** when the browser held the music
back. That happens when `play()` was refused or a context stayed suspended or interrupted, as on iOS after the page was
in the background. The speaker button then carries an amber dot. Any tap resumes the contexts and retries from the same
place. A held-back piece is never counted as a broken file (#1389). Preferences persist in the browser; the existing file/synthesis playback, positional
world sounds, ducking and tab audio focus remain in use. Muting effects silences world sounds while leaving music's
switch independent. A previously saved master mute migrates to both switches off, preserving silence. Menus support Tab, arrow keys, Escape, outside clicks and touch.

## The world launcher (`tools/world-launcher`)

`launcher.mjs` runs many worlds behind one address. In production it is served under `/worlds`
(`https://sim.eden.art/worlds`); locally it listens on port 4980 and starts worlds on ports 5101–5149.

- **Homepage and list.** `GET <base>/` serves the web app's world list; `<base>/__sim/worlds.json` lists worlds and
  `<base>/__sim/templates.json` the templates.
- **Creating a world.** `POST <base>/__sim/worlds` with a signed-in session. The launcher checks account limits, allocates
  a slug and directory, starts the child with the creator as `WORLD_OWNER_ID` and the chosen template as `GENESIS_FILE`, and
  claims the world for its creator.
- **Proxying.** `<base>/w/<slug>/*` is proxied to the child (HTTP, SSE and WebSocket). A request to a sleeping world
  starts it.
- **Sleeping.** Children are restarted after a crash (with backoff), paused after a period without visitors, and may be
  released to exit later; the next visit wakes them. Unwatched worlds run at a slower clock
  (`SIM_UNWATCHED_PACE`, 0.25 by default for children); on return, the time of day jumps to the present
  (`apps/server/src/clock-catchup.ts`) without simulating the gap.
- **Real time (#1649, behind `SIM_REAL_TIME=1` while it rolls out).** A god world's clock is the real time in the world's
  own time zone (`time.timeZone`, an IANA name): one world hour is one real hour, and the date and time of day are the
  local wall time there. The engine never reads a wall clock: the server logs the day clock as a `dayConfig` rules event
  whose origin makes the engine read local time (`apps/server/src/god/real-clock.ts`), and logs a new one only at boot,
  on a zone change, or when a watched world has drifted a minute from the wall. A world without a zone is given one at
  its first real-time boot, recorded as one engine edit: `mars-college-2026` and `mars-college-2027` America/Los_Angeles,
  `rna-studio` Europe/Lisbon, every other world America/New_York. The same edit sets `time.clock: 'real'`.
  Everything that reads the world day follows the one clock: the engine's `env.datetime` (perception, light labels,
  schedules and the calendar, mandates, the ledger's clock), needs (a real day long), weather durations (real minutes)
  and the viewer's sun, which on real time is an equator sun on the local clock (daylight about 06:00 to 18:00, all
  year; `apps/web/src/sun-site.ts`). Authored worlds without a god (eden, mars, littlemartians run by `main.ts`) keep
  the local time of their migration zone through the same keeper. Old-world forks served by `tools/core` are out of scope.
  A re-alignment only moves the clock's origin (`realign`), so the day's state (last day turn, event, quiet) is kept.
  When daylight saving ends, the local clock, and so the world's, goes back an hour once.
- **Time setter on real time.** `POST /v1/god/env` on a production world (the deploy's marker `SIM_STAGE`: the keeper
  takes it from its unit, `sim-worlds@<stage>`, or its stage link's name, and the launcher passes it to every world;
  `production` and `legacy` are production) refuses `timeOfDay`
  (`time.real-clock`: preview another hour in the viewer or with `look --hour`) and a speed (`timeScale` > 0,
  `time.accelerated-production`); pausing (`timeScale: 0`) and resuming (`realTime: true`) stay allowed. On a dev world
  a set hour or speed puts the world on the dev-only accelerated clock (`time.clock: 'accelerated'`, as playtests need);
  `realTime: true` puts it back. `POST /v1/god/act` holds the same rule for a `world` op's time (`clock: 'accelerated'`,
  `set` or `dayTicks` on a production world: `time.accelerated-production`). With the flag off again, a migrated world's
  `time.clock` is cleared at boot so nothing reads a clock it does not run.
- **Choosing and changing the zone (#1649 part 3).** The New world dialog has a time zone field, prefilled with the
  creator's browser zone; the launcher refuses an invalid one (`time.zone-invalid`), keeps it on the registry row and
  passes it to the world as `WORLD_TIME_ZONE`, which the first real-time boot records as `time.timeZone` (before the slug
  defaults). The owner changes it with `POST /v1/god/env {timeZone}`: one `world` op, in the ledger and undoable; an
  invalid zone is `time.zone-invalid`, a co-builder token `cobuilder.scope` (or `cobuilder.disabled`), a helper token
  `helper.scope`. The clock re-aligns to the new local time at once. `GET /v1/god/status` reports the zone, so the
  launcher's list (`worlds.json` `timeZone`) follows an owner's change, and the viewer's time panel names it. When the
  shown clock jumps 20 world minutes or more while live, the viewer eases the sky and lights to the new time over about
  4 s (`apps/web/src/clock-ease.ts`); scrubbing history, reduced motion and `?shot` pages cut instead.
- **Registry.** `<data>/worlds.json` records each world (slug, owner, template, flags). Reserved slugs include `toy`,
  `mars`, `littlemartians`, `eden`, `assets`, `api`, `god` and `launcher`.
- **Thumbnails.** Each `worlds.json` row carries `thumbnail` (a URL or `null`) and `thumbnailSource` (`owner`,
  `template` or `null`). The owner sets the picture with a 16:9 JPEG
  ([API](api.md#world-owner-api-served-by-the-launcher)). It is checked and stripped by the upload gate in
  `apps/server/src/moderation/` (including the site admin's vetoes, which also stop a stored or default picture from
  being listed or served) and stored as `<data>/worlds/<slug>/thumbs/<sha>.jpg`, so it moves with the world on
  archive and restore. A world without one shows its template's default, `worlds/templates/thumbs/<template>.jpg`
  (`empty.jpg` for the empty plain), which is media pulled from the asset CDN and not kept in git. When neither
  exists, the row has no picture. Both kinds are served immutable under content-hashed URLs
  (`<base>/__sim/thumbs/<slug>/<sha>.jpg`, `<base>/__sim/thumbs/_template/<sha>.jpg`). Setting or clearing a
  thumbnail never wakes the world (`tools/world-launcher/thumbnail.mjs`). Each card on the root page shows the picture in a
  lazy-loaded 16:9 frame (`LauncherHome.tsx`). The owner's agent takes one with `eden-god thumbnail` (god SKILL.md, "Thumbnail").
- **Owner and operator API.** Handoff, archive and unlisting, and the loopback-only `op.mjs` commands: see
  [API](api.md#world-owner-api-served-by-the-launcher).
- **Keeper.** `keeper.mjs` holds the public port and hands over between launcher generations one world at a time, with
  the first world as a canary and rollback on failure. Release mechanics are in [release](../release.md).

### What a child runs with

`children.mjs` builds each child's environment: `ENGINE=mars`, `ENABLE_WORLD_ENGINE=1`, `BRAIN_MODE=fake` with empty
provider keys, `SEED_NATIVES=0`, `SOUL_LIFECYCLE=1`, `EDGE_FADING=1`, `SIM_UNWATCHED_PACE=0.25`, Clerk sign-in
(`AUTH_PROVIDER=clerk`, `ACCOUNT_AUTH_REQUIRED=1`, `ACCOUNT_REGISTRY_PATH`), the world's identity and paths, the
served skill and CLI files, the site relay settings (`SIM_SITE_URL`, `SIM_SITE_KEY`), and the Eyes settings when the
launcher's own environment sets them (see [Souls](souls.md#eyes)).

### Account limits

The launcher counts the worlds each signed-in account owns before allocating anything (`creation-policy.mjs`):

| Flag | Default | Meaning |
|---|---|---|
| `--max-worlds-per-account` | 5 | Worlds one account may own |
| `--new-account-hours` | 24 | How long an account counts as new (from its first sign-in on this launcher) |
| `--new-account-world-limit` | 2 | Total cap while new |
| `--new-account-create-limit` | 1 | Worlds created per window while new |
| `--new-account-window-minutes` | 60 | That window |

Refusals: 409 `account-world-limit`, 429 `new-account-velocity` with `Retry-After`. A god label (`godName`) already
shown on another account's world is refused with 409 `god-name-taken`.

### The original worlds

The original `eden`, `mars` and `littlemartians` worlds run as **forks** under the launcher (`fork-world.mjs`): a copy
of that world's data served at `<base>/w/<key>` with Clerk sign-in, its own account registry, edge minds and the fake
brain. A fork's boot must never shrink its history or change its Soul rows.

## Travel between worlds

A Soul can visit another world of the same launcher site (`apps/server/src/travel/`, mounted on worlds with god mode
and the edge API). Its **home world** stays the authority on where it is.

1. The origin checks the request and marks the Soul `departing`.
2. It sends a small **passport** (name, description, owner, portable body look, recent travel log) through the
   launcher's loopback relay (`/__sim/site/relay`) to the destination's `/v1/site/arrive`.
3. The destination reuses the Soul's earlier local incarnation or creates one through the normal lifecycle, and returns
   a new Soul token for the agent.
4. The origin marks its incarnation `away` and tells the home world. On refusal or timeout nothing moves.

Each world keeps its own history; only the passport moves. A god may close a world to visitors
(`POST /v1/god/visitors {open:false}`, refusal `travel.closed`); leaving and coming home always work. The CLI's
`travel <world>` and `travel home` switch the agent's folder to the new world.

A body made from an admitted definition (an upload, or a shared authored preset such as Pip or the centaur) travels as
a reference (`{ref: body_<sha>}`), never as its home URL (#795). The destination resolves it with the same rules as
`PUT /v1/edge/body {ref}`: the owner's own or a published definition, not withdrawn, a body type that world admits.
Bytes it lacks are pulled through the site path once the arriving Soul can change bodies (sha256 verified,
re-admitted, two pulls per owner per minute). Putting the body on is bounded: at most 12 s after the Soul is ready, of
which the pull gets at most 8 s, so arrival answers well inside the launcher relay's 55 s abort. A pull that runs out of
time is refused `body.source-slow`; it may still finish in the background and cache its verified bytes for a later
`PUT {ref}`, but it never puts the body on. A refused reference never refuses the trip: the Soul's body there is
unchanged (the default look for a first visit), and its travel log names the code. Travel pulls count against a per-owner budget, separate from
the per-Soul budget of `PUT {ref}`.
