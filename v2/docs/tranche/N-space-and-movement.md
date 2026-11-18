# Lane N · Space and movement (N1 to N18)

Draft, local only, 16 Nov 2026, final pass 17 Nov. Everything above the first task is this lane's shared notes.
In the repository a lane opens them at `v2/docs/tranche/N-space-and-movement.md` (task K15 puts them there),
the rules every task keeps at `v2/docs/tranche/FORMAT.md`, and the trunk at `v2/docs/TRUNK.md`. A task below
that says "the lane notes" means this part of this file. Code references are to `origin/main` at `a5a31d203`
unless a line says otherwise; read them with `git show origin/main:<path>`.

Path shorthand, used in these notes only (the tasks spell paths out): `gen/` is `packages/generators/src/`,
`wc/` is `packages/world-compiler/src/`, `gr/` is `packages/ground/src/`, `god/` is `apps/server/src/god/`,
`spatial/` is `mars/viewer/engine/spatial/`.

## Changes at the final pass

Applied on 17 Nov from the final audit's rulings and the three audit reports. No ID, stage, ceiling or kind
changed. One main purpose was reworded (N8) and one gained two words (N16); both are listed.

**Every task (N1 to N18)**

- Ends with `**Acceptance.**`, at most five boxes. N15, the gate, has the four gate boxes with its bars in the
  first.
- Step 0 names the result that means "stop and hand back". For N8, N9 and N10 it is a baseline measurement,
  and it says what result makes the task unnecessary.
- Cites only repository paths. References to the planning folder's trunk and format files, to the design
  document and its sections, and to "above" were replaced by `v2/docs/TRUNK.md`,
  `v2/docs/tranche/FORMAT.md`, `v2/docs/tranche/N-space-and-movement.md`, a contract page, or the fact itself.
  Checked facts are restated in the task with their source; the list C1 to C14 stays in these notes.
- Touches names a module under `v2/crates/sim/src/` or a tool folder (table "Modules this lane owns").
- The closing "Amended at the final audit" lines are gone; what they said is in the task bodies and here.

**By task**

| Task | Change |
|---|---|
| N1 | The import also brings in named places that are not rooms (areas, the eight waters, their shores, piers, hills and mountains, paths, bridges, landmarks) and keeps every window as a node, because E1, E2, E10, E19 and E21 let an agent say "by the window" and "along the canal". Outcome, design, proof and acceptance say so. The importer imports only the three content packages; no file under `packages/` changes (the process audit's finding). The catalog it is compared with is made by a separate command, because `v2/` may not import the server. An order of work with a hand-back point at hour 3 (the ceiling looked too small) |
| N2 | Step 0 gains a hand-back. `--things` may also fill the square, so 10,000 fit |
| N3 | Says the ground stays in `sim` and that the server binds a described point (E2). Keeps each water's outline for N11. Touches names the dependency files it must edit |
| N4, N5, N6, N7 | Acceptance, Step 0 wording, paths, Touches. N7 says which arm its bars are scored on |
| N8 | **Main purpose reworded:** its last clause read as a ban on staying inside; it is now "so that no walker halts inside by itself". A body that chose to stay (E3) may remain; walkers pass it, since other bodies are a preference and not a wall. One acceptance box tests that. The baseline measures overlap, because walkers that pass through each other would otherwise look fine |
| N9 | The rule is about the engine's choice only: the engine never picks a spot in a doorway or on a stair; a body whose own order is to stay there is allowed. One acceptance box tests both halves |
| N10 | The 6 s rung asks only a still body with no order to stay there; a body that chose to stay is sent nothing and is passed. Depends on already had N8 |
| N11 | Wading and swimming are built as real movement on water, not as a flag: water gets patches of its own kind, a swim and a wade gait with today's speeds, shore links that name their moves, routes across water, and a body may be still in water. Depends on gains N5 and N10 (the body already needed both). An order of work with a hand-back point at hour 2 |
| N12 | Built on E23's moving group and adds no type of its own for membership, steering or leaving; Step 0 hands back if a ride does not fit E23. One acceptance box checks it. Restart stated (nodes and links survive) |
| N13 | Depends on gains N5 (the fall-back route). Touches is the skills crate, which exists by win 5 |
| N14 | Depends on gains K9 (the end is a timer). Says the at-rest track is the one E4's set-down uses |
| N15 | Depends on gains N18. Walkers' places come from the places N18 found reachable. Bars are declared in a comment on the issue, not in the pull request. "A miss also closes it" is now the gate rule: finished when scored. The machine is the owner's to name (rule 15) |
| N16 | The index holds things as well as bodies, so described spots (E2) and set-down checks (E4) can ask it. **Main purpose gains two words** ("who and what is near me"). Depends on gains N2 and N7. An order of work with a hand-back point at hour 2 |
| N17 | A hand-back point at hours 2 and 3 (the ceiling looked too small): the equal hash first, speed second |
| N18 | Says where the label producer may live, since `v2/` may not import today's engine. The heading "Added to the outline, and taken in" is gone: N18 is an ordinary task |

**In these notes**

- New sections: "What every task in this lane keeps", "Modules this lane owns", "Doorways and stairs: the
  rule" (E3 asked for it to be written into this lane's page).
- "How Eden maps to the tree" now covers named places and openings; the data table's rows for named places
  and open ground say what the importer reads; the source paragraph names the eight waters.
- The outline-changes table is kept as history, with the wording of one row changed.

**Not resolved, for the coordinator**

1. **Module names are this lane's proposal.** K1 and K2 lay out `v2/crates/sim/src/`; if their names differ,
   a lane uses theirs and says so under "Deviations".
2. **Contract page paths** (`v2/docs/pose.md`, `world-model.md`, `zones.md`) follow lane T's slugs as they
   stood on 16 Nov. If lane T renamed one, the citation is stale.
3. **N1 still has the tightest ceiling**, and now carries more. If its hand-back point is taken, the named
   places and windows become a new task of at most 3 h that E1 and E2 (win 3) wait for.
4. **Today's code as a tool.** N1's comparison catalog and N18's labels need the server and the engine, which
   `v2/` may not import. Both are written as commands run from the repository root, attached and not
   committed. A committed tool outside `v2/` would be on today's paths and tiers; that choice is yours.
5. **Eight waters, not seven.** The brief said a sea, a lake, a river and four ponds. The template also
   places the canal as a `core/lake`; today's catalog counts 7 waters, most likely because the river has no
   area shape. N1 imports all eight and lists the difference.
6. **N11 (3 h) and N16 (3 h) each grew.** Ceilings were left; each has an order of work and a hand-back
   point.
7. **E4 and N14 both need the at-rest track.** N14 now says whichever lands first builds it. E4 does not list
   N14, and I did not edit E4.
8. **N15's machine.** The task waits for the owner's checklist line that names the machine scoring the
   gates; I do not know that line's number. The one `v2` command for timed runners
   (`.github/scripts/timed-run.mjs`) is not in N15's Touches; it belongs with the repository's rules (K15).
9. **`INDEX.md` is stale** for N11, N13, N14, N15 and N16 (Depends on). `build-index.py` rebuilds it.
10. **Lane E cites "lane N, C13"** (E12). The C labels are kept so that still resolves.

## What every task in this lane keeps

- **Citations.** "T1", "T2", "T4" and so on are the trunk's contracts in `v2/docs/TRUNK.md`; their pages are
  `v2/docs/zones.md` (T1), `v2/docs/world-model.md` (T2) and `v2/docs/pose.md` (T4), with fixtures under
  `v2/crates/replica/fixtures/<page name>/`. A task ID such as N7 or E3 is a task of this tranche.
- **Proof before the cut-over** (rule 13 of `v2/docs/tranche/FORMAT.md`): the named tests passing, or a
  posted table from a run declared in a comment on the issue; an outcome that is watched adds an uncut,
  real-speed clip. Timings are two repeats. The walk, bundle, conformance and remote gates do not apply to a
  change that touches only `v2/`; the publication check and the secret scanner always do.
- **No file outside `v2/` changes** in any task of this lane. Today's packages may be called as tools by N1's
  exporter; nothing else in `v2/` imports today's server, engine or packages. A task that needs a file under
  `packages/` or `apps/` changed hands back.
- **Serial inside a module.** Two tasks that touch the same module are worked one after the other.

## Modules this lane owns

| Module or folder | What | Tasks |
|---|---|---|
| `v2/tools/import-eden/` | Exporter (TypeScript, `export/`) and loader (Rust, `src/`) | N1 |
| `v2/tools/testworld/` | The generated test world | N2 |
| `v2/crates/sim/src/ground/` | Patches cut from the tree; water patches (`water.rs`); the exit check (`exits.rs`) | N3, N10, N11 |
| `v2/crates/sim/src/links/` | Doors, stairs, ladders, boarding links; turn state (`turns.rs`) | N4, N8, N12 |
| `v2/crates/sim/src/routes/` | Routes and ability masks | N5, N11 |
| `v2/crates/sim/src/mover/` | The surface mover | N6, N11 |
| `v2/crates/sim/src/walk/` | The walk skill and keeping apart, until K13 moves it to `v2/crates/skills/src/walk/` | N7, N8, N9 |
| `v2/crates/sim/src/spots/` | Standing spots | N9 |
| `v2/crates/sim/src/unstick/` | The never-stuck ladder and the last rung | N10 |
| `v2/crates/sim/src/gaits/` | Gait data and its loader | N11 |
| `v2/crates/sim/src/tracks/` | Motion as a formula of time: rides, rest, straight, thrown | N12, N14 |
| `v2/crates/skills/src/close/` | Step, circle, follow, go near | N13 |
| `v2/crates/sim/src/index/` | The spatial index and cells | N16 |
| `v2/crates/sim/src/par/` | Nodes ticked in parallel | N17 |
| `v2/tools/bench/walkers/` | The walker bench | N15, N17 |
| `v2/tools/compare-reach/` | Reachability compared with today's labels | N18 |

## Doorways and stairs: the rule

One rule, read the same way by N8, N9, N10 and E3:

- **A walker does not halt in a doorway or on a stair by itself.** The engine never picks a standing spot
  there (N9), and a walker whose order ends while it is inside finishes the crossing first (N8).
- **A body that chose to stay there may remain** (E3, stage 2: "stand in the doorway", "sit halfway up the
  stairs"). It is not part of the link's turn state, it is sent no "make way" (N10), and walkers pass it,
  because other bodies are a preference and not a wall (N7).
- No task in this lane builds "nothing may be still inside a link" as a rule.

## History: changes made to the first outline

These were made when the lane was first written, before the final pass. The outline is a planning file and
is not in the repository.

| Task | Change | Reason |
|---|---|---|
| N1 | Outcome: counts are checked against the replayed model's bake; only places and things against the catalog. Depends adds T4 | The catalog's `counts` are places, things, acts and kinds (`apps/server/src/edge/catalog/catalog.ts`). It has no count of rooms, doors or stairs. Every imported node needs a pose |
| N2 | Outcome adds: same seed gives the same bytes, and the fixtures later tasks measure on are named. Depends adds T4 | N3, N7, N8 and N16 state their outcomes on this world; it must hold a 0.9 m door in a turned wall, a narrow stair, a square and a hall of known size |
| N3 | The third clause (95 % agreement with today's labels) moved to N18. In its place: every Eden node cuts, or is named. Depends adds N1 and N2 | Reachability between rooms needs doors and stairs as links (N4, which depends on N3), and today's labels have to be produced by running today's engine |
| N4 | Outcome restated at the level of links, driven by a script. "In the log" reads "in the effect stream" | Routes are N5 and walking is N7, both later. The durable log is K4, win 2 |
| N7 | K13 removed from Depends. Outcome adds an overlap measure. Proof adds the route through three closed doors | K13 is win 2 and follows N7. Without an overlap measure, walkers that ignore each other meet the speed bar |
| N6, N8, N9, N13, N16, N17 | The outline's words were given numbers, stated in each Outcome | Words such as "never leaves", "a ring", "costs the answer" and "falls with cores" cannot be scored as written |
| N10 | K11 removed from Depends; N8 added. Third clause restated as a check that later tasks call | K11 is win 2; N10 and the gate N15 are win 1. Step 0 runs scenes on N8 |
| N11 | "As stated" was given numbers | Undefined in the outline |
| N15 | Depends adds K7 and N18. Says what tick time excludes | The run needs the clock. The durable log, views and the gateway do not exist in win 1 |
| N17 | Depends adds N7 and K12; random numbers come from K12's one source | It needs walkers and a log hash; a second random scheme would change every draw |
| N18 | Added: Eden's reachability against today's labels | Whether exact geometry works on real content had not been checked |

**Trunk.** No task conflicts with `v2/docs/TRUNK.md`. Three places where the obvious build would break it are
flagged in the tasks: a position kept as a 2D point on a floor (N3, N6, against T4); a walker writing into a
queue on a link another node owns (N8, against T1); cells made into tree parents, which changes a body's
frame (N16, against T2).

## Words

- **Bake:** the physics facts today's code computes for one placed thing: boxes, floors, rooms, openings.
- **Oriented box:** a rectangle on the ground turned by an angle, with a bottom and a top height.
- **Patch:** the walkable ground of one node: one or more polygons with holes. A water patch is the same
  thing for water a body can swim on.
- **Cut:** divide a polygon into triangles that keep its edges (the standard method is called constrained
  Delaunay triangulation).
- **Portal:** the edge a walker crosses between two triangles or two patches.
- **String pulling** (the funnel method): turning a chain of triangles into the shortest bent line through
  their portals.
- **Raster:** a grid of small cells. Today's walk grid has 0.1 m cells.
- **ORCA:** a published method of crowd avoidance in which each walker treats each neighbour as a hard limit
  on its own velocity.
- **Free speed:** a walker's speed with nobody near (1.35 m/s walking today).
- **Walker-tick:** one walker during one tick.
- **Named place:** a place an agent can name that is not a room: an area, a water, a shore, a pier, a hill,
  a path, a bridge, a landmark.
- **Opening:** a gap in a wall. A door, gate or arch joins two places; a window joins nothing.

## What today's world data contains (for N1, N3, N11 and N18)

**The source.** `worlds/templates/eden-2026.json`, a committed template, not production data. Schema
`genesis/1`: `constants` (`extent: 1000`, `ground: 'land'`), `state`, and 366 batches of edit operations.
Counted on main: 5,149 `place`, 32 `define` (all generator `kit/2` kinds), 356 `set`, 10 `move`; 214 kinds in
use; 1,771 things placed at the world root, 2,987 in a slot of a parent (a room or a floor), 391 as plain
children; 304 area shapes and 102 path shapes. About 240 buildings (65 halls, 60 cottages, 24
townhouses, 18 shops, 16 houses, 13 sheds, 10 towers, 9 pavilions and others). 651 `core/door@2`, of which
649 are placed with `state.open: true`. 8 hills, 8 mountains, 4 bridges, 9 piers, 1 ladder, a carousel, a
big wheel, a cable car, 4 balloons, 19 pieces of rail track, 30 boats. Stairs are inside buildings, as links
of their bake; none is placed as a thing of its own.

**Water and named ground** (counted on `origin/main` at `ee208bfdb`). Eight waters: three `core/lake` (the
southern sea, the west lake and the canal), one `core/river`, four `core/pond`. Also 3 `core/shore`, 64
`core/footpath` and 93 `core/zone` areas. Today a body wades at 0.9 m/s and swims at 0.8 m/s
(`mars/viewer/engine/locomotion/swim.ts`), and a swimming body's root rides 1.2 m below the water's level
(`spatial/ground.ts`, `SWIM_ROOT_BELOW`).

**Turning it into a model.** Apply the world state, then each batch in order, with `applyBatch`
(`wc/compile.ts:754`) on a `WorldModel` (`wc/model.ts:85`) whose `library` is `coreLibrary()`
(`wc/library.ts:23`). Every batch must be accepted; `applyGenesis` (`god/god.ts:864`) shows the order.
`god/replay-world.ts` does the same in one process with no engine and no port.

**Per placed thing.** An `Entity` has `id` (`e_` plus 8 hex), `def`, `name`, `in {parent, slot}`, `p`
(`[x, z]` or `[x, y, z]`), `r` (yaw), `s` (scale), `params`, `shape` (`path` or `area`) and `state`.
`resolvedDef` gives its kind (`form` point, path or area; `layer`; `components`). `bake` (`wc/model.ts:229`)
gives the facts below in the kind's own frame (+y up, front +z, origin at the base centre). `worldPose`
(`wc/model.ts:340`) composes parent, slot and scale; `footprint` (`wc/model.ts:376`) gives world-frame boxes.

| Geometry | Where it comes from | What an importer must read |
|---|---|---|
| Rooms | `Baked.rooms` (`gen/types.ts:20`), made by `building/1` (`gen/building.ts:153`) and by footprint files of mesh and kit kinds (`gen/kit-footprint.ts`) | Polygon on the **inner faces** of the walls (`innerRect`, `gen/building-layout.ts:55`), floor index, height `y`, room height |
| Floors | `Baked.surfaces` (`gen/types.ts:14`): each room's polygon **minus stairwells**, plus porch, balcony, flat roof (`gen/building.ts:146`); landings of `stairs/1` | Level, `y`, polygon, `tag` (the room id) |
| Walls and solids | `Baked.colliders`: oriented boxes with `y0`, `y1` and a `tag` (`wall:f<k>:…`, `stairs:<id>`, `rail`, `post`). Walls are split at openings and the **sill and lintel pieces are kept** (`gen/building.ts:111`) | Box, height span, tag, and the kind's `layer` |
| Openings | `Baked.openings` (`gen/types.ts:16`): `kind` door, window, gate or arch; `at`, `yaw`, `width`, `height`, `sill`, `level`, `from`, `to`, `exterior`, `state` | All of it, windows included. Windows never join rooms |
| Door things | Separate entities whose kind has `components.opening` (`isDoorDef`, `god/doors.ts:22`). Shut when `state.open` is false (`isShut`, line 15). Which doorway each stands in: `buildingDoorFits` (`gen/building-doors.ts:16`), else by position (`doorInGap`, `god/doors.ts:37`) | The pairing, and open or shut |
| Stairs, ramps, ladders | `Baked.links` (`gen/types.ts:18`): `kind`, floor indices `from` and `to`, `path`, `width`, `y0`, `y1` (`gen/building.ts:160`, and `stairs/1` at line 313) | All of it |
| Seats and other slots | `Baked.slots`; a kind's own slots replace the generator's (`wc/model.ts:259`) | Kind, position, yaw, capacity |
| Open ground | Not a polygon. A height function of landform records, sampled at 1 m in 64 m tiles (`gr/types.ts`, `gr/tiles.ts`); each 1 m cell is classed walk, wade, swim, steep or outside (`mediaTile`, `gr/media.ts:188`). Steep is a rise over run above 0.5774; wading is up to 0.3 m deep (`gr/settle.ts:10`) | The recipe (`model.ground()`), the 1 m heights and classes, and each water's own polygon or path and width, with its level |
| Named places | Derived only in the server (`god/places.ts`), not in the bake: an area the creator laid out; a water (only where it has an area shape); a shore (the water's outline grown by 3 m); a building and its rooms; a landform (hill, mountain); a landmark (a named point thing at least 1.5 m wide standing on its own, street furniture excluded) | The importer derives them itself by the same rules (N1): read `god/places.ts`, do not import it |

**How Eden maps to the tree.** World, open ground, building, floor, room, thing; T2 fixes no levels, so a
kind says what it admits.

- **Doors and stairs.** A doorway (an opening of kind door, gate or arch) is a link between two rooms, or a
  room and the open ground, from the opening's `from` and `to`. A door thing is paired with its doorway and
  holds the link's open state; the door belongs to one side (T1). A stair, ramp or ladder is a link between
  two floors.
- **Windows.** A window is not a link. It is kept as a node under the room it opens from, with its position,
  width, height and sill, so that it can be named ("by the window", E2).
- **Named places that are not rooms.** Each is a node under the open ground with a name, a kind, its aliases
  and an outline (a polygon, or a line and a width): every `core/zone` area and other laid-out area; each of
  the eight waters; a shore for each water; each pier; each hill and mountain; each footpath; each bridge;
  each landmark. They exist so that an agent can say "along the canal", "on the beach", "by the fountain"
  (E1, E2, E10, E19, E21).
- **A named place holds nobody.** A body or a thing standing in a named place stays a child of the open
  ground, or of its room. A named place is found by its outline, never by parenthood: otherwise every step
  across an outline would be a transfer.
- **Origin fields.** Each node keeps today's id, path, kind reference and kind hash, for the difference lists
  and for X6.

**Traps in that data.**

- Yaw: the compiler's boxes turn clockwise seen from above and today's engine negates them
  (`god/engine-bridge.ts:861`).
- A path or area thing at the world root carries world-frame geometry whose heights are above the ground
  under it unless flagged `abs` (`wc/model.ts:379`).
- A child in a room slot has `p` relative to the slot's origin, in the parent's frame.
- A mesh kind takes its rooms and doorways from a footprint file in the asset store (`wc/model.ts:244`).
  Without pulled assets it bakes as one box.
- Some links exist only in the server: steps onto decks, hanging stair flights, steps onto mesh floors
  (`god/engine-bridge.ts`, lines 1133 and 1169). Today's engine also drops a stair's low boxes and lays a
  threshold strip under upper doorways (lines 855 and 922).
- The river is a path with a width, not a polygon. The sea runs to the world's edge.

**Today's ground and its recorded raster problems.** A 0.28 m body radius with a 0.06 m margin on a 0.1 m
grid: a cell is passable when its clearance is at least 0.34 m (`spatial/types.ts` `HUMAN_PROFILE`,
`spatial/path.ts:20`). There is no `clearance.ts` under `spatial/` on main; the rule is
`gen/clearance.ts` and the clearance field is built in `spatial/grid.ts`.

- `gen/clearance.ts`, measured over 19 yaws and 25 offsets: a gap between two wall pieces passes sometimes
  from 0.62 m and always only from 0.86 m; between two pieces of furniture, 0.72 m and 1.00 m (a 0.90 m gap
  passes 34 % of poses).
- `spatial/types.ts:15`, at `Obstacle.raster`: a turned wall grows by up to half a cell diagonal on each face; a
  0.9 m inside door kept less than the 0.34 m needed.
- `gen/building.ts:67`, `FITTED_MIN_W = 1.2`: a 1.0 m doorway holding a door frame closed in walls turned 20 to
  70 degrees, so doorways were widened. Eden's content has been shaped to fit the raster.
- `spatial/connectivity.ts`, header: a cottage sealed off because its door was too tight at that yaw.

**Today's labels.** `NavConnectivity` (`spatial/connectivity.ts`) groups passable cells into connected areas,
joins them through stairs, and takes the area holding the arrival point as the main one. `check(points)`
(line 675) answers for each point `{ok, code, area, door}`, where `code` is `nav.no-standing-room`,
`nav.disconnected` or `nav.one-way`, and `door` means "joined only through a closed hand door". The engine
exposes it as `navCheckV1` (`packages/engine-mars/src/engine.ts:3063`); the server calls it with
`{id, p, level, tol: 1.5}` (`god/engine-bridge.ts:1559`).

## The test world in numbers (N2; used by N3, N4, N6, N7, N8, N9, N10, N13, N16)

| Part | Size | Who measures on it |
|---|---|---|
| Square | 60 m by 60 m, open on four sides | N7's crossing |
| Hall | 30 m by 40 m, 300 seats in rows with aisles, two double doors of 2.4 m | N16 stands 1,000 bodies in it |
| Ring | A walkway 4 m wide round a solid middle 22 m across | N6's million steps |
| Building | Turned 33 degrees; two floors, four rooms a floor; one straight stair 1.0 m wide whose top lands 1.5 m from a 0.9 m door; a ladder to the flat roof; a corridor 0.9 m wide and 6 m long | N4, N8, N10 |
| Doors | Twelve, all placed shut: two of 0.9 m (one in the turned building, one square to the axes), six of 1.2 m, two of 1.5 m, two of 2.4 m | N3's door test, N4 |
| Things | None by default; `--things N` scatters small things on a seeded lattice | N16 |

## Checked facts about libraries and published figures (16 Nov 2026)

- **C1. `spade` 2.15.1** cuts polygons with exact arithmetic tests on 64-bit floats. Kept edges may touch at
  their ends and may not cross: `add_constraint` and the bulk loader panic on a crossing; `try_add_constraint`
  refuses instead. Coordinates must be zero or between 2^-142 and 2^201.
  https://docs.rs/spade/latest/spade/struct.ConstrainedDelaunayTriangulation.html
- **C2. `i_overlay` 9.2.0** does union, difference and growing of polygons on an integer grid; its float calls
  convert to that grid, and a fixed-scale call lets you choose it. Growing "works reliably only with valid
  polygons". Output is outer rings counter-clockwise, holes clockwise. Its sibling `i_triangle` 0.51.0 cuts
  that output. https://github.com/iShape-Rust/iOverlay
- **C3. `geo` 0.33.1:** its boolean and buffer calls are built on `i_overlay`, with crash fixes in 0.28 and
  0.29. It adds a wrapper, not a second engine. https://github.com/georust/geo/blob/main/geo/CHANGES.md
- **C4. `clipper2` 0.6.1** wraps the C++ Clipper2 library, needs a C++17 compiler, and scales floats to
  integers by 100 by default (1 cm). https://docs.rs/crate/clipper2/latest
- **C5. `polyanya` 0.18.0** finds shortest any-angle paths on a polygon mesh, in 32-bit floats. Layers are
  numbered in 8 bits (at most 256); no body size per query; no jump links.
  Its one published timing is a single long path: 3,823 nodes in 2,990 to 4,961 µs, so 0.8 to 1.3 µs a node
  and 3 to 5 ms for that path. https://github.com/vleue/polyanya and
  https://github.com/vleue/polyanya/issues/86
- **C6. `vleue_navigator` 0.17.0** is a plugin for the Bevy game engine over `polyanya`; open issues include
  no links (79) and a race (75). https://github.com/vleue/vleue_navigator
- **C7. "About 5 µs a walker":** a Go port of ORCA steps 1,000 agents in 5.44 ms on one worker of a 2015
  desktop processor. It leaves out the upkeep of its neighbour index and has no walls at all ("We have not
  yet implemented … polygonal obstacles"). https://github.com/downflux/go-orca
- **C8. `dodgy_2d` 0.5.5** (April 2025) is a Rust port of the reference ORCA library, with walls, in 32-bit
  floats. https://github.com/andriyDev/dodgy
- **C9. ORCA in a passage:** avoidance alone deadlocks at doors; adding a local planner raised success "from
  15% to 99%" in some cases. https://arxiv.org/abs/2107.00246
- **C10. String pulling** treats the walker as a point; width must come from shrinking the ground first.
  https://digestingduck.blogspot.com/2010/03/simple-stupid-funnel-algorithm.html
- **C11. Recast:** `recastnavigation-sys` 1.0.3 was last released in January 2024 and builds C++ with cmake;
  `rerecast` 1.0.0 is a Rust port, triangles in and mesh out, no search.
  https://docs.rs/crate/recastnavigation-sys/latest and https://github.com/janhohenheim/rerecast
- **C12. Doors in games:** Unreal runs a script when a walker reaches a "smart link" and waits for it to
  resume; a known failure is the walker taking a plain link beside it, so the door script never runs.
  https://forums.unrealengine.com/t/ai-smart-link-onsmartlinkreached-event-not-working/485410
  The Dark Mod queues walkers at a door, one through at a time, and a walker leaves the queue after waiting
  too long. https://bugs.thedarkmod.com/view.php?id=2345
- **C13. Moving platforms:** Unreal keeps a "movement base" per character; reports of doubled speed on
  landing come from mixing velocity relative to the base with world velocity.
  https://forums.unrealengine.com/t/character-doubles-speed-when-landing-on-moving-platform/1349459
- **C14. Rust's `sin` and `cos`** have precision that "varies by platform, Rust version".
  https://doc.rust-lang.org/std/primitive.f64.html#method.sin

---
