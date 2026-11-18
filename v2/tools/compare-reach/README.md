# compare-reach

Engine v2 N18 (#2658): for every place in today's catalog of a world built from the Eden 2026 template, whether the
new ground (N3's patches, N4's links, N5's map) and today's engine agree that it can be reached from the arrival point.
N15 draws its walkers' places from the places both reach.

Three steps, all run by hand; every file they write is generated and kept in the ignored `.local/`:

1. **Facts** (N1): `node v2/tools/import-eden/export/export.ts` from the repository root writes
   `.local/import-eden/eden-2026.facts.json`.
2. **Today's labels**: a one-off script run from the repository root, attached to the pull request and never committed
   (`v2/` never imports today's engine). It boots the world from the template the way `bootEden`
   (`apps/server/test/eden-capabilities-timing.ts`) does, in memory with fake minds and an isolated `DATA_DIR`, warms
   the labels, and calls `navCheckV1` once per catalog place with `{id, p, level, tol: 1.5}`. A place's point is its
   outline's centroid, or the 1 m grid point inside the outline nearest it. It writes `.local/compare-reach/labels.json`
   in whole millimetres: per place its point, level, the height of today's surface there for an upper level, today's
   terrain height and medium under the point, and the verdict (`ok`, `code`, `door`, `area`); and the arrival point.
3. **Compare** (from `v2/`):
   `cargo run -p compare-reach --release -- ../.local/import-eden/eden-2026.facts.json ../.local/compare-reach/labels.json`.
   It prints the agreement, the differences by class, and every difference with its class and cause.

The new verdict and the classes are described in the module doc of `src/main.rs`.
