# testworld

Engine v2 N2 (#2650): a small world of known numbers, generated from a seed, for N3, N4, N6, N7, N8, N9, N10, N13
and N16 to state their outcomes on. It is written as N1's facts file (`souls/import-eden/1`) and loaded by N1's loader
into K2's tree through `Tree::commit`, so it takes the same road as Eden 2026.

From `v2/`:

```sh
cargo run -p testworld --release -- [--seed S] [--things N] [--out DIR]
```

Defaults: seed 1, no things, `../.local/testworld/`. It writes `testworld-s<S>-t<N>.facts.json` and, beside it,
`testworld-s<S>-t<N>.manifest.txt`: every named constant (`SQUARE_SIDE = 60000 mm`, …), the counts and the file's
SHA-256. Then it reads the file back, loads it, and prints the load time and the tree's counts beside the file's.
Neither file is committed; the same seed and count always give the same bytes.

What it holds (sizes are the table "The test world in numbers" in `v2/docs/tranche/N-space-and-movement.md`; the
layout is in the module doc of `src/lib.rs`):

| Part | Key in `Import::nodes` |
|---|---|
| The square, 60 m, open on four sides | `square` (an area thing), `square.area` (its place) |
| The hall, 30 m by 40 m, 300 seats as slots of `hall`, five aisles | `hall`, `hall/hall`, `hall.aisle-{centre,west,east,back,front}` |
| The ring: solid middle 22 m across, walkway 4 m wide | `ring`, `ring.walkway` (a closed line with its width) |
| The building, turned 33 degrees: rooms `r0a`–`r0d`, `r1a`–`r1d`, the `corridor`; the stair from floor 0 to 1, the ladder from 1 to the roof (floor 2) | `building`, `building/floor-{0,1,2}`, `building/<room>` |
| Twelve doors, all shut | `door-<thing>-<doorway>`, e.g. `door-building-narrow` (0.9 m, top of the stair), `door-hall-side` (0.9 m, square to the axes) |
| `--things N` small boxes on a seeded lattice in the rooms, the hall and the square | `box-00001` … |

Tests (`cargo test -p testworld`): every part and size read back from the tree, the same seed giving the same bytes,
and 10,000 things clear of every doorway, aisle and the ring's walkway.
