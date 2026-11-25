// Engine v2 X6 (#2819): a live world's built content, read from one backup file of its database. The exporter
// (v2/tools/import-eden/export/export.ts `--backup`) calls `fromBackup` in place of its template replay.
//
// The file is opened read-only and immutable (`file:…?immutable=1`): no lock, no journal, no write, and nothing but that
// file. Read: the model's meta, defs and things (world_meta_v1, world_defs_v1, world_entities_v1, as
// apps/server/src/god/store.ts `load` reads them) and the world's uploads (world_assets_v1). Never read: edits,
// receipts, snapshots, events or any other history. An upload is brought by its SHA-256, the key its bytes have on the
// CDN (docs/operations/cdn.md); a thing that names an upload (a mesh's asset, a picture's media) carries its hash.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { WorldModel, coreLibrary, type AssetInfo, type Entity, type StoredDef } from '../../../../packages/world-compiler/src/index.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const CORE_INDEX = join(ROOT, 'worlds/core-assets/index.json');

/** The repository's core assets as AssetStore reads them: the extra indexes beside the core index, then the core
 *  index over them. The template replay (export.ts) resolves a template's core meshes with it too. */
export function coreAssets(): Record<string, AssetInfo> {
  const core: Record<string, AssetInfo> = {};
  if (existsSync(CORE_INDEX)) for (const f of [...readdirSync(dirname(CORE_INDEX)).filter((n) => n.endsWith('.index.json')).sort().map((n) => join(dirname(CORE_INDEX), n)), CORE_INDEX])
    Object.assign(core, (JSON.parse(readFileSync(f, 'utf8')) as { assets?: Record<string, AssetInfo> }).assets ?? {});
  return core;
}

export type Upload = { sha: string; kind: string; ext: string; bytes: number; name: string | null };
type MapRow = { def: string; entry?: string; kind?: string; waiting?: string; issue?: number; note?: string };

/** The world ids a backup file holds (one, for a world's own sim.db). */
export function worldsIn(path: string): string[] {
  const db = open(path);
  try { return (db.prepare('SELECT world_id FROM world_meta_v1 ORDER BY world_id').all() as { world_id: string }[]).map((r) => r.world_id); }
  finally { db.close(); }
}

function open(path: string): DatabaseSync {
  if (!statSync(path).isFile()) throw new Error(`${path}: not a file`);
  const u = new URL('file:' + resolve(path));
  u.searchParams.set('immutable', '1');
  return new DatabaseSync(u, { readOnly: true });
}

/** Today's def ref and the map's `def` name one revision the same way: `core/door@2` is `core-door@2`. */
const mapKey = (ref: string) => ref.replace(/^core\//, 'core-');

/** A world map's entry for each def ref that has one (`souls-world-map/1` rows with an `entry`). */
export function entryMap(mapPath: string): (ref: string) => string | undefined {
  const rows = (JSON.parse(readFileSync(mapPath, 'utf8')).rows as MapRow[]).filter((r) => r.entry);
  const by = new Map(rows.map((r) => [mapKey(r.def), r.entry!]));
  return (ref) => by.get(mapKey(ref));
}

/** A world map's kind for each def ref whose copies are that kind (rows with a `kind`). A kind that joins parts (a rack
 *  frame, a beam, a frame stand, a bay) is read by its own name, so its copies are of it rather than borrowing its entry. */
export function kindMap(mapPath: string): (ref: string) => string | undefined {
  if (!existsSync(mapPath)) return () => undefined;
  const rows = (JSON.parse(readFileSync(mapPath, 'utf8')).rows as MapRow[]).filter((r) => r.kind);
  const by = new Map(rows.map((r) => [mapKey(r.def), r.kind!]));
  return (ref) => by.get(mapKey(ref));
}

/** A footprint upload's physics as the world's asset store keeps it (`<sha>.meta.json`, which AssetStore.info reads):
 *  the walls, rooms, openings and slots a mesh def names by its `footprint`. */
function footprintBaked(dir: string, sha: string): AssetInfo['baked'] | undefined {
  const f = join(dir, `${sha}.meta.json`);
  if (!existsSync(f)) return undefined;
  try { return (JSON.parse(readFileSync(f, 'utf8')) as { baked?: AssetInfo['baked'] }).baked; }
  catch (e) { throw new Error(`footprint-unreadable: ${sha}: ${(e as Error).message}`); }
}

/** The model, the facts file's head, and what each thing adds to its record (its uploads, its entry or why none).
 *  `assetsDir` is the world's asset store (v1's `worlds/assets`): a footprint upload's physics are read from it. A mesh
 *  def that names a footprint whose physics are not at hand is refused, never baked as one box over its bounds: that
 *  box would block a whole building, as it did verdelis-eden's dome over its entry (24 Nov). */
export function fromBackup(path: string, world: string, mapPath: string, assetsDir = '') {
  const db = open(path);
  try {
    const worlds = (db.prepare('SELECT world_id FROM world_meta_v1').all() as { world_id: string }[]).map((r) => r.world_id);
    if (!world) { if (worlds.length !== 1) throw new Error(`${path} holds ${worlds.length} worlds (${worlds.join(', ')}): name one with --world`); world = worlds[0]!; }
    const metaRow = db.prepare('SELECT body FROM world_meta_v1 WHERE world_id=?').get(world) as { body: string } | undefined;
    if (!metaRow) throw new Error(`${path}: no world ${world}`);
    const meta = JSON.parse(metaRow.body);
    const defs = (db.prepare('SELECT body FROM world_defs_v1 WHERE world_id=? ORDER BY hash').all(world) as { body: string }[]).map((r) => JSON.parse(r.body) as StoredDef);
    const entities = (db.prepare('SELECT body FROM world_entities_v1 WHERE world_id=? ORDER BY id').all(world) as { body: string }[]).map((r) => JSON.parse(r.body) as Entity);
    const hasAssets = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='world_assets_v1'").get();
    const uploads = hasAssets ? db.prepare('SELECT sha, kind, ext, bytes, tris, textures, box, name FROM world_assets_v1 WHERE world_id=? ORDER BY sha').all(world) as (Upload & { tris: number; textures: number; box: string })[] : [];

    // The compiler's asset lookup: the repository's core index (as AssetStore reads it: the extra indexes beside it,
    // then the core index over them) and this world's uploads.
    const core = coreAssets();
    const own = new Map(uploads.map((u) => {
      const baked = u.kind === 'footprint' && assetsDir ? footprintBaked(assetsDir, u.sha) : undefined;
      return [u.sha, { tris: u.tris, bytes: u.bytes, textures: u.textures, box: JSON.parse(u.box),
        ...(u.kind === 'image' && (u.ext === 'png' || u.ext === 'jpg') ? { image: { ext: u.ext } } : {}),
        ...(baked ? { baked } : {}) } as AssetInfo];
    }));
    const assets = (sha: string) => own.get(sha) ?? core[sha];
    const missing = [...new Set(defs.map((d) => d.make).filter((mk) => mk.kind === 'mesh' && mk.footprint && !assets(mk.footprint)?.baked)
      .map((mk) => (mk as { footprint: string }).footprint))].sort();
    if (missing.length) throw new Error(`footprint-missing: ${missing.join(', ')}: a mesh def names a footprint whose physics are not at hand; pass --assets <the world's asset store>`);
    const library = coreLibrary();
    const m = WorldModel.fromSnapshot({ constants: meta.constants, state: meta.state, seed: meta.seed, seq: meta.seq, editSeq: meta.editSeq, defs, defRefs: meta.defRefs, entities, ground: meta.ground }, assets, library);

    // SA-E11's map from a kind and revision to its Soul Actions entry.
    const map = existsSync(mapPath) ? new Map((JSON.parse(readFileSync(mapPath, 'utf8')).rows as MapRow[]).map((r) => [mapKey(r.def), r])) : null;
    const shas = new Set(uploads.map((u) => u.sha));
    const named = (v: unknown) => [...new Set(JSON.stringify(v ?? null).match(/[0-9a-f]{64}/g) ?? [])].filter((h) => shas.has(h)).sort();
    const thing = (e: Entity, d: { ref: string; make: unknown }) => {
      const asset = named([d.make, e.state, e.params]);
      const row = map?.get(mapKey(d.ref));
      const none = !map ? 'no map in the repository' : !row ? 'no row in the map' : row.entry || row.kind ? null : `waiting${row.waiting ? ' ' + row.waiting : ''}${row.issue ? ` (#${row.issue})` : ''}`;
      return { ...(asset.length ? { asset } : {}), ...(row?.entry ? { entry: row.entry } : {}), ...(none ? { noEntry: none } : {}) };
    };
    const file = readFileSync(path);
    const head = {
      world,
      backup: { sha256: createHash('sha256').update(file).digest('hex'), bytes: file.length },
      map: map ? { sha256: createHash('sha256').update(readFileSync(mapPath)).digest('hex') } : null,
      entityRows: entities.map((e) => e.id),
      uploads: uploads.map((u) => ({ sha: u.sha, kind: u.kind, ext: u.ext, bytes: u.bytes, ...(u.name ? { name: u.name } : {}) })),
    };
    return { m, head, thing };
  } finally { db.close(); }
}
