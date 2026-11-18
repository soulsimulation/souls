# import-world

Engine v2 X6 (#2819): each world's built content brought over from a backup of its database, so the cut-over loses
nothing a creator made. N1's loader (`v2/tools/import-eden`) builds the tree; this tool reads a live world instead of
Eden's template, and prints the release owner's row per world.

One command, from the repository root:

```
node v2/tools/import-world/import-world.ts <backup.db>… [--world <id>] [--map <map.json>] [--out <dir>] [--json]
```

- **Reads only the backup file given.** A backup is a world's `sim.db` as today's nightly backup writes it
  (`tools/world-launcher/deploy/backup.mjs`: `<set>/worlds/<slug>.db`). The export runs under Node's permission model:
  it may read the content packages, the core asset index, the map and that one file, write only its facts file, and has
  no network. SQLite opens the file read-only and immutable. It reads the model (meta, defs, things) and the world's
  uploads; never its edits, receipts, snapshots or any other history.
- **What comes over.** Every thing, room, floor, door, doorway, stair, window and named place, as N1 maps them. An upload
  comes by its SHA-256 (its CDN key, `docs/operations/cdn.md`): a thing that names one (a mesh's asset, a picture's media)
  holds the hash in field 24. A thing whose kind has a Soul Actions entry in SA-E11's map
  (`content/worlds/eden/map.json`, or `--map`) names it in field 25; the others are listed with the reason (waiting for
  its entry, no row in the map, or no map at all).
- **The row.** Counts (things and the backup's thing rows, rooms, floors, doors, doorways, stairs, windows, places),
  uploads (and how many a thing names), differences (and how many are unexplained), things with no entry (and their
  kinds), clean or not, and the hash: SHA-256 over the tree's state hash and the uploads' hashes, equal on a second run.
  The differences are against the backup itself: a thing row with no node, a count unlike today's bake, a loader note,
  or an upload no thing names (kept by hash). A backup that does not export is a row that is not clean, with the reason.

Steps, if run apart: `node v2/tools/import-eden/export/export.ts --backup <file> --out <facts.json> [--map …]`, then
`cargo run -p import-world --release -- <facts.json>… [--json]` from `v2/`.

Test (makes its own fixture: a template world built and edited by today's server code, backed up with today's backup
tool, under `.local/import-world/test`; needs `pnpm install` and cargo):
`node --test v2/tools/import-world/test/import-world.test.ts`.
