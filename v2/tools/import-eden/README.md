# import-eden

Engine v2 N1 (#2649): Eden 2026's built content as a tree of nodes and links (K2's `replica::tree`), for the walkers of
win 1 and the named places of win 3. Two steps, both run by hand:

1. **Export** (TypeScript, `export/export.ts`), from the repository root:
   `node v2/tools/import-eden/export/export.ts`. It replays `worlds/templates/eden-2026.json` through today's content
   packages (`packages/world-compiler`, `packages/generators`, `packages/ground`, imported by relative path; never the
   server) and writes `.local/import-eden/eden-2026.facts.json`: every thing with its pose relative to its tree parent,
   its bake (rooms, floors, solids, openings with windows, stairs, slots), the doors paired with their doorways, the
   ground (recipe, 1 m heights and classes), the waters, the named places, and the model's own counts. Whole
   millimetres and millidegrees only. `--template <file>` replays another committed template (`worlds/templates/*.json`) the same way,
   resolving the core meshes it names from `worlds/core-assets/` as the server does (the Mars campus, `mars-two.json`;
   add `--map content/worlds/mars/map.json` so its things name their entries). The file is generated (about 12 MB) and never committed; the same template gives
   the same bytes.
2. **Load** (Rust, `src/`), from `v2/`:
   `cargo run -p import-eden --release -- ../.local/import-eden/eden-2026.facts.json [--catalog <catalog.json>]`.
   Everything goes in through `Tree::commit`, so T2's checks run on every change. It prints the count table beside the
   bake's, load time and memory, the ids of the waters, the canal and the west lake's shore and one window, and, given
   today's catalog as a JSON file, the difference list by id with a reason.

3. **Bake** (TypeScript, `bake/bake.ts`, V17 #2717), from the repository root after `pnpm install`:
   `node v2/tools/import-eden/bake/bake.ts [--write-records]`, or for a live world
   `node v2/tools/import-eden/bake/bake.ts --backup <sim.db> [--world <id>] [--map <map.json>] --out <dir>` (the same
   backup and map its facts were exported from, so `things` is keyed by the facts' `origin` ids; a template replay's
   seed gives other ids and maps none of a live world's things). It replays the same template, runs today's mesh builders
   (`apps/web/src/gen-mesh`, unchanged) in Node once per kind and set of geometry parameters (the builder's instance
   key, with tint, variation and stretch left on the instance), and writes each picture as binary glTF named by its T3
   hash (`souls/model/1`, then the bytes; `1220` and 64 hex digits) under `.local/import-eden/models/worlds/models/`, with
   `models.json`: every kind with its model, or the reason it has none, and its state table (state field → the named
   parts it changes), and `things`: each thing's model by today's id, the table v2/web's thing layer draws from (V8). A part shown only in some state is drawn into the one model as a group named `when:<condition>`,
   so no change of state needs another model. Runtime effects (fire, falling water, shadow proxies) and the page's
   runtime data are left out, so two runs give the same bytes. `--write-records` adds the models to the licence records
   (`tools/cdn/approved-derivatives.json`, `generated`), and the dry run
   `node tools/cdn/publish.mjs --dry-run --identity --root .local/import-eden/models --sources <csv> --out <plan>`
   then plans every model; a model with no record is listed as excluded, not published. Path and area shapes that drape
   on the ground are one per thing and are listed, as are ground and water. A kind made from a stored glTF file (`make: {kind:'mesh'}`; 127 of the
   Mars campus's 141 kinds, 6 of Eden's) is written as that file's bytes, unchanged: the viewer's rendition today's page
   gets (`worlds/core-assets/renditions.json`) when there is one, else the core asset (`pnpm assets:pull` brings them).
   Its kind carries `fit` (`[scale, x, y, z]`, today's `instantiate`: centred on x and z, standing on y = 0, its largest
   extent matched to the def's box, from the core index's measured bounds) and `flat` for a model a few centimetres
   thick, drawn a hair towards the camera as today. Its licence is its file's (`modelRecord`: served-public or a
   reviewed CC0 derivative), so it is not added to `generated`. v2/web loads every model with the meshopt decoder and
   keeps WebP and AVIF textures.

The mapping, the field numbers and what each node holds are in the module doc of `src/lib.rs`. In short: world →
open ground → things; a thing with rooms → a floor per level → rooms → the things in them and the windows; a doorway
is a link from the room it opens from to the room, the floor (a balcony) or the open ground it leads to, and its door
keeps the link's id; a stair is a link between two floors; each named place that is not a room is a node under the
open ground, holding nobody; the open ground holds the terrain, every 64 m tile's 1 m heights and class bytes as
exported (N1b, #3197). Today's ids, refs and hashes are stored as bytes, and names by reference (SHA-256), since
a log's only text is `namespace:name`. Kinds are named as the world's Soul Actions entries (`content/kinds`) name them
(C12, `kind_name`): the facts' `core:<name>` and `eden:eden_<name>` load as `eden:<name>`, so each thing finds its
entry.

A thing starts in the state today's world draws it in (#4784). The exporter writes its captured state as `state`: the
entity's bools and whole numbers over its def's defaults. Seeding with the world's entries (`load_with`), the import
gives each value to the thing's entry field with the same meaning, for fields numbered 28 and up: the same name; a
burning or running bool by either name (`on`, `lit`); a lamp's `level` from `on` (the entry's top level, or 0). So a
lamp that is on today starts on, and a fire that is burning starts lit.

A thing whose def has params (a building's size, storeys, material and roof, a tree's species, a door's size) keeps them
as field 19, today's JSON text as bytes, as the exporter writes them (`params`, W3): the old page draws a world from its
stream alone with them (`apps/web/src/v2-engine/source/stream-scene.ts`). Facts exported before W3 carry none. A def the
world defines itself (a template's `define`, which no page's library has: hello-hamlet's reading room) is kept once on
the open ground as field 102, `[[ref, def] …]` with each whole stored def as JSON text (the exporter's `ground.defs`, the
defs the world places), so that page draws it as the world's own page does (its roof) and not from the thing's solids.
On the ground and not on a thing, removing any thing of the def never loses it. It is in every baseline: Eden-2026's
31 such defs are about 64 KB of a baseline of about 9 MB. The open ground also keeps the world's ground palette as field
103, `souls:<palette>` (today's `state.ground.palette`, the exporter's `ground.palette`: a Mars camp's `desert`), which
that page colours the ground and its cover by; facts exported without one leave it out and the page draws grass.

A thing may name another kind's entry instead (field 27, `entry_name`): the exporter's `--map <map.json>` reads a
world's map (`content/worlds/<world>/map.json`, `souls-world-map/1`) and writes each placed copy's entry, as X6 does for
a backup. The Mars campus's chairs, sofas, tables and so on borrow existing entries this way
(`content/worlds/mars/map.json`). worldd and the client look an entry up by that name, else by the kind's own. A
borrowed seat or bed is set at the thing's own slot of the same number (its def's geometry), with the entry's stand
offset from it; an entry seat the thing has no slot for is not offered.
A row may instead name the kind its copies are (`kind`): a kind that joins parts (a frame stand, a rack frame, a beam,
a bay; `content/kinds/construction`) is read by its own name, so a copy that only borrowed its entry would never join.
The rack yard of `worlds/templates/mars-camp.json` is named so by the Mars map: exported with
`--map content/worlds/mars/map.json` it is a yard a crew builds from; without the map it is plain things.

Things on another thing's floor (C27, #3509): a thing at the root that stands within a step (220 mm) of a building's
own floor, one with a room on its level or raised more than a step (a pavilion's, a bandstand's, a deck's), and a
thing in a building's slot that lies on one of its floors (a roof terrace's tables and benches), is placed on that
floor, in the room there that holds it. The open ground is cut out under such a floor and a roof is no ground, so
otherwise nobody could stand by them. A lawn's or a path's low floor is ground cover and keeps its things on the
open ground. A decor thing at the root is placed on the floor too (verdelis-eden's bubbles and succulents under its
dome, 24 Nov), unless a point its kind's entry declares is off that floor: a cableway reaches far past its valley
station, so it stays on the open ground. That needs the world's entries (`load_with`, as `worldd seed` loads); with
none (`load`) a decor thing stays where it is, and a decor thing in a building's slot keeps its slot.

Stand points (C13, #3440): `clear_stand_points` moves each entry's stand point that lies within a body's clearance
(radius 280 mm, the cut's margin 60 and 20 for rounding) of its own kind's solids straight out until a body can stand
there, and returns one line for each point moved or left; `worldd seed --entries` applies it and prints those lines
(`stand point: …`), so the world's copy of the entries is moved and `content/kinds` is not.

One thing per slot (C9, #3397): today a slot may hold several things (a desk's top, a hall's planter spots), the tree
one. The first thing in the facts keeps the slot; each later one stays a plain child of the same parent at its own
place, standing on it, and the load prints it under "left out of a full slot" with what holds the slot (29 in Eden
2026), so K11's auditor finds no `slot-over-full`. None of Eden's 29 is lost or has a free slot to go to: each parent
has one slot of that kind (a desk's, a table's or a counter's top, a building's roof). The 8 on a top stay on it
where they were. The 21 on a roof are put on the roof's floor by C27 below, like the thing that holds the slot.

Tests: `cargo test -p import-eden` runs a small world written in the test. The Eden 2026 test needs the exported file:
`cargo test -p import-eden --release -- --ignored --nocapture`.
