// Engine v2 X6 (#2819): the fixture, a live local world backed up with today's own tool. Never committed: made by the test.
//
// Today's GodMode builds the world from a template on a SQLite file under the given folder (`<data>/worlds/<slug>/sim.db`,
// the launcher's layout), then a creator edits it: a thing moved, a door shut, an image uploaded and hung, a kind the
// creator defined and placed twice, and a lamp and a two-floor house placed from the library. Then today's nightly backup
// (tools/world-launcher/deploy/backup.mjs) copies it, and the copy's path is returned.
//
//   node v2/tools/import-world/test/fixture.ts [<dir>]      (from the repository root; default .local/import-world/fixture)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Db } from '../../../../apps/server/src/db.ts';
import { GodMode, type Genesis } from '../../../../apps/server/src/god/god.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
export const SLUG = 'x6-fixture';
// A 1×1 PNG, the upload.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000050001a5f645400000000049454e44ae426082', 'hex');

export type Fixture = { backup: string; upload: string; moved: string; movedTo: [number, number]; shut: string; placed: string[] };

export function makeFixture(dir: string): Fixture {
  const data = join(dir, 'data'), dbFile = join(data, 'worlds', SLUG, 'sim.db');
  mkdirSync(join(data, 'worlds', SLUG), { recursive: true });
  const genesis = JSON.parse(readFileSync(join(ROOT, 'worlds/templates/hello-hamlet.json'), 'utf8')) as Genesis;
  const db = new Db(dbFile);
  const ok = (r: unknown, what: string) => {
    const a = r as { accepted: boolean; ids?: string[]; created?: string[] };
    if (!a.accepted) throw new Error(`${what}: ${JSON.stringify(r).slice(0, 600)}`);
    return a;
  };
  let upload = '', moved = '', shut = '', movedTo: [number, number] = [0, 0];
  const placed: string[] = [];
  try {
    const god = new GodMode(db, { worldId: SLUG, ownerId: null, tick: () => 1, emit: () => {}, genesis, assetDir: join(data, 'assets') });
    const things = [...god.model.entities.values()];
    const before = new Set(god.model.entities.keys());
    // A thing moved, in its parent's frame: the first bench the template placed.
    const bench = things.find((e) => /bench/.test(e.def))!;
    const p = bench.p ?? [0, 0], px = p[0], pz = p.length === 2 ? p[1] : p[2];
    moved = bench.id; movedTo = [px + 3, pz + 1];
    ok(god.act({ ops: [{ op: 'move', id: bench.id, p: movedTo }] }), 'move');
    // A door shut.
    const door = things.find((e) => /door/.test(e.def))!;
    shut = door.id;
    ok(god.act({ ops: [{ op: 'set', id: door.id, state: { open: false } }] }), 'shut a door');
    // An upload, hung on a picture frame.
    const a = god.assets.put(PNG, { name: 'fixture-picture' });
    upload = a.sha;
    ok(god.act({ ops: [{ op: 'place', def: 'core/picture-frame@1', name: 'fixture-picture', p: [12, 0, -14], state: { media: `/assets/${a.sha}.${a.ext}` } }] }), 'hang the upload');
    // A kind the creator made, and two of it placed.
    const def = { schema: 'def/1', name: 'fixture-plinth', version: 1, layer: 'decor', description: 'A plinth the creator made.', make: { kind: 'none' }, size: { box: [1, 1, 1] } };
    ok(god.act({ ops: [{ op: 'define', def }, { op: 'place', def: 'fixture-plinth@1', name: 'plinth-one', p: [16, 0, -16] }, { op: 'place', def: 'fixture-plinth@1', p: [18, 0, -16] }] }), 'define and place a kind');
    // Things placed from the library: a lamp, and a two-floor house (its stair).
    ok(god.act({ ops: [{ op: 'place', def: 'core/floor-lamp@2', p: [14, 0, -18] }] }), 'place a lamp');
    ok(god.act({ ops: [{ op: 'place', def: 'core/cottage@3', name: 'two-floor-house', p: [-30, 0, 20], params: { floors: 2 } }] }), 'place a two-floor house');
    placed.push(...[...god.model.entities.keys()].filter((id) => !before.has(id)));
  } finally { db.close(); }
  const out = join(dir, 'backup');
  execFileSync(process.execPath, [join(ROOT, 'tools/world-launcher/deploy/backup.mjs'), data, out], { stdio: 'pipe' });
  const day = readdirSync(out).filter((d) => /^\d{8}$/.test(d)).sort().at(-1)!;
  return { backup: join(out, day, 'worlds', `${SLUG}.db`), upload, moved, movedTo, shut, placed };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  console.log(JSON.stringify(makeFixture(resolve(process.argv[2] ?? '.local/import-world/fixture'))));
}
