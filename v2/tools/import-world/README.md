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

A world whose own backup is not at hand imports from its template's kept outputs on the asset CDN (#4281); the
template builder that ran today's server code (`template-world.ts`) was removed with v1 (0.134 D3).

Steps, if run apart: `node v2/tools/import-eden/export/export.ts --backup <file> --out <facts.json> [--map …]`, then
`cargo run -p import-world --release -- <facts.json>… [--json]` from `v2/`.

## Kept outputs: importing without v1 (0.133 R9a)

The exporters (`v2/tools/import-eden/export/export.ts`, `bake/bake.ts` and `export/backup.ts`) read worlds through v1's packages: the world compiler, its core library, the mesh generators and the old server.
0.134 deletes them. The Rust importers (`cargo run -p import-world` and `-p import-eden`) need only replica, so each
world is exported once while v1 still exists, and only the exporters' outputs are kept.

- **Template worlds** are built from repository content, so their outputs are public media on the asset CDN, listed in
  `tools/assets/manifest.json` under the set `import`, which is pulled only when named:
  `pnpm assets:pull --set import`. That gives `v2/tools/import-world/kept/<world>/facts.json`, `models.json` and
  `models/<hash>.glb` for `eden` (`worlds/templates/eden-2026.json`), `godmode-lab` (`hello-hamlet`) and
  `little-martians-arium` (`littlemartians-two`). Import them with no v1 in the path, from `v2/`:
  `cargo run --release -p import-world -- tools/import-world/kept/*/facts.json`. The rows match today's importer:
  godmode-lab `fe5c8323496d…` clean with 0 differences, Little Martians `230209a2232e…` clean with 5 differences, all
  explained, and Eden `ac207c47678a…` clean with 0 differences. Since 0.135 W3 each file also carries every thing's
  def params (`params`, the tree's field 19). Apart from those params, Eden's facts are byte for byte the ones it was
  imported from in 0.131 (its template as of then), and godmode-lab's and Little Martians' are byte for byte their earlier
  ones, except for the hash of the backup they were rebuilt from. The files without params stay on the CDN under their
  own keys.
- **Live worlds** (Mars College, and any world holding people's things or edits) are not published. Their facts and
  models are exported at the production switch (0.133 W4), from fresh backups, while v1 still exists, and the release
  owner keeps the outputs privately, beside the backups they came from. After 0.134 a live world is imported only from
  those kept files.

 a template world built and edited by today's server code, backed up with today's backup
tool, under `.local/import-world/test`; needs `pnpm install` and cargo):
`node --test v2/tools/import-world/test/import-world.test.ts`.
