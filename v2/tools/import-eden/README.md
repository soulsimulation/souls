# import-eden

Engine v2 N1 (#2649): Eden 2026's built content as a tree of nodes and links (K2's `replica::tree`), for the walkers of
win 1 and the named places of win 3. Two steps, both run by hand:

1. **Export** (TypeScript, `export/export.ts`), from the repository root:
   `node v2/tools/import-eden/export/export.ts`. It replays `worlds/templates/eden-2026.json` through today's content
   packages (`packages/world-compiler`, `packages/generators`, `packages/ground`, imported by relative path; never the
   server) and writes `.local/import-eden/eden-2026.facts.json`: every thing with its pose relative to its tree parent,
   its bake (rooms, floors, solids, openings with windows, stairs, slots), the doors paired with their doorways, the
   ground (recipe, 1 m heights and classes), the waters, the named places, and the model's own counts. Whole
   millimetres and millidegrees only. The file is generated (about 12 MB) and never committed; the same template gives
   the same bytes.
2. **Load** (Rust, `src/`), from `v2/`:
   `cargo run -p import-eden --release -- ../.local/import-eden/eden-2026.facts.json [--catalog <catalog.json>]`.
   Everything goes in through `Tree::commit`, so T2's checks run on every change. It prints the count table beside the
   bake's, load time and memory, the ids of the waters, the canal and the west lake's shore and one window, and, given
   today's catalog as a JSON file, the difference list by id with a reason.

The mapping, the field numbers and what each node holds are in the module doc of `src/lib.rs`. In short: world →
open ground → things; a thing with rooms → a floor per level → rooms → the things in them and the windows; a doorway
is a link from the room it opens from to the room, the floor (a balcony) or the open ground it leads to, and its door
keeps the link's id; a stair is a link between two floors; each named place that is not a room is a node under the
open ground, holding nobody. Today's ids, refs and hashes are stored as bytes, and names by reference (SHA-256), since
a log's only text is `namespace:name`.

Tests: `cargo test -p import-eden` runs a small world written in the test. The Eden 2026 test needs the exported file:
`cargo test -p import-eden --release -- --ignored --nocapture`.
