// Engine v2 X6 (#2819): the importer on a live local world's backup. Builds the fixture (test/fixture.ts: today's server
// code, a template, a creator's edits, today's backup tool), then runs the one command. Needs node, the workspace's
// packages (pnpm install) and cargo; from the repository root:
//
//   node --test v2/tools/import-world/test/import-world.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { exportArgv } from '../import-world.ts';
import { makeFixture, SLUG } from './fixture.ts';

const ROOT = resolve(import.meta.dirname, '../../../..');
const DIR = join(ROOT, '.local/import-world/test');
rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
const fx = makeFixture(DIR);
// A small map in SA-E11's format: an entry, a kind waiting for its entry, and (by omission) kinds with no row.
const MAP = join(DIR, 'map.json');
writeFileSync(MAP, JSON.stringify({ format: 'souls-world-map/1', world: 'test', rows: [
  { def: 'core/door@2', entry: 'eden:door' }, { def: 'core/cottage@3', entry: 'eden:cottage' }, { def: 'core/hall@4', entry: 'eden:hall' },
  { def: 'core/bench@1', entry: 'eden:bench' }, { def: 'core/floor-lamp@2', entry: 'eden:floor_lamp' },
  { def: 'core/picture-frame@1', waiting: 'SA-X34', issue: 2924 },
] }));

type Row = { world: string; clean: boolean; hash: string; rows: number; counts: Record<string, number>; uploads: string[]; uploadsNamed: number;
  withEntry: number; noEntry: { def: string; why: string; ids: string[] }[]; differences: { what: string; ids: string[]; reason: string; explained: boolean }[]; history: boolean };
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
function importWorld(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(ROOT, 'v2/tools/import-world/import-world.ts'), ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const rows = (out: string) => out.trim().split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Row);
const facts = (dir: string) => JSON.parse(readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith('.facts.json'))!), 'utf8'));

const before = sha(fx.backup);
const first = importWorld([fx.backup, '--map', MAP, '--out', join(DIR, 'run1'), '--json']);
const second = importWorld([fx.backup, '--map', MAP, '--out', join(DIR, 'run2'), '--json']);

test('A1: every thing, room, door and upload of the edited world is a node, a link or an asset by hash; nothing unexplained', () => {
  assert.equal(first.status, 0, first.stderr);
  const [w] = rows(first.stdout);
  assert.equal(w!.world, SLUG);
  assert.ok(w!.clean, JSON.stringify(w!.differences));
  assert.equal(w!.counts.things, w!.rows, 'every thing row in the backup is a thing node');
  assert.equal(w!.differences.filter((d) => !d.explained).length, 0);
  assert.ok(w!.counts.rooms! > 0 && w!.counts.doors! > 0 && w!.counts.doorways! > 0 && w!.counts.stairs! > 0, JSON.stringify(w!.counts));
  assert.deepEqual(w!.uploads, [fx.upload]);
  assert.equal(w!.uploadsNamed, 1, 'the hung picture names the upload by hash');
  // The creator's edits came over: the moved bench where it was moved to, the shut door shut, the new things present.
  const f = facts(join(DIR, 'run1'));
  const thing = (id: string) => f.things.find((t: { id: string }) => t.id === id);
  for (const id of fx.placed) assert.ok(thing(id), `placed ${id}`);
  assert.equal(thing(fx.shut).door.open, false);
  assert.deepEqual(thing(fx.placed.find((id) => thing(id).ref === 'core-picture-frame@1')!).asset, [fx.upload]);
  assert.ok(f.kinds.some((k: { ref: string }) => k.ref === 'fixture-plinth@1'), 'the kind the creator made');
  const [x, , z] = thing(fx.moved).pose as number[];
  assert.deepEqual([x, z], fx.movedTo.map((v) => Math.round(v * 1000)), 'the bench where the creator moved it (its parent\'s frame)');
});

test('A2: each thing names its kind\'s entry or is on the list of things with none', () => {
  const [w] = rows(first.stdout);
  const listed = w!.noEntry.reduce((n, k) => n + k.ids.length, 0);
  assert.equal(w!.withEntry + listed, w!.counts.things);
  const why = Object.fromEntries(w!.noEntry.map((k) => [k.def, k.why]));
  assert.equal(why['core-picture-frame@1'], 'waiting SA-X34 (#2924)');
  assert.equal(why['fixture-plinth@1'], 'no row in the map');
  const none = importWorld([fx.backup, '--map', join(DIR, 'no-map.json'), '--out', join(DIR, 'run-nomap'), '--json']);
  const [n] = rows(none.stdout);
  assert.equal(n!.withEntry, 0);
  assert.ok(n!.noEntry.every((k) => k.why === 'no map in the repository'));
  assert.equal(n!.noEntry.reduce((s, k) => s + k.ids.length, 0), n!.counts.things);
});

test('A3: a second run gives an equal hash, and no history comes over', () => {
  assert.equal(second.status, 0, second.stderr);
  const [a] = rows(first.stdout), [b] = rows(second.stdout);
  assert.match(a!.hash, /^[0-9a-f]{64}$/);
  assert.equal(a!.hash, b!.hash);
  assert.equal(a!.history, false, 'no motion, flight, timer or time effect in the imported state');
  const db = new DatabaseSync(`file:${fx.backup}?immutable=1`, { readOnly: true });
  assert.ok((db.prepare('SELECT count(*) n FROM world_edits_v1').get() as { n: number }).n > 0, 'the backup holds edits; none are read');
  db.close();
  const f = facts(join(DIR, 'run1'));
  for (const k of ['edits', 'events', 'receipts', 'snapshots', 'history']) assert.equal(f[k], undefined, k);
});

test('A4: the export reads only the backup given by path, read-only, and has no network', () => {
  const out = join(DIR, 'spy', 'x.facts.json');
  mkdirSync(dirname(out), { recursive: true });
  const spy = join(ROOT, 'v2/tools/import-world/test/sqlite-spy.mjs');
  const argv = exportArgv(fx.backup, out, MAP);
  const r = spawnSync(process.execPath, [`--allow-fs-read=${spy}`, '--import', spy, ...argv], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const opens = r.stderr.split('\n').filter((l) => l.startsWith('sqlite-open ')).map((l) => JSON.parse(l.slice(12)) as { path: string; options: { readOnly?: boolean } });
  assert.ok(opens.length >= 1);
  for (const o of opens) {
    const u = new URL(o.path);
    assert.equal(decodeURIComponent(u.pathname), resolve(fx.backup), 'only the backup is opened');
    assert.equal(u.searchParams.get('immutable'), '1');
    assert.equal(o.options.readOnly, true);
  }
  assert.equal(sha(fx.backup), before, 'the backup is unchanged');
  assert.ok(!existsSync(fx.backup + '-wal') && !existsSync(fx.backup + '-shm'), 'no journal beside it');
  // The same grants refuse the network and any other file, the live world's own database among them.
  const probe = `const fs = require('node:fs'); let fsr = 'read'; try { fs.readFileSync(${JSON.stringify(join(DIR, 'data/worlds', SLUG, 'sim.db'))}); } catch (e) { fsr = e.code; }
    require('node:net').connect(9, '127.0.0.1').on('error', (e) => console.log(JSON.stringify({ fs: fsr, net: e.code })));`;
  const p = spawnSync(process.execPath, [...argv.slice(0, argv.findIndex((a) => !a.startsWith('--'))), '-e', probe], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(p.stdout), { fs: 'ERR_ACCESS_DENIED', net: 'ERR_ACCESS_DENIED' }, p.stderr);
});

test('A5: one command prints the row per world, and a backup that does not import is a row with its reason', () => {
  const bad = join(DIR, 'not-a-backup.db');
  writeFileSync(bad, 'not a database');
  const r = importWorld([fx.backup, bad, '--map', MAP, '--out', join(DIR, 'run3')]);
  assert.equal(r.status, 0, r.stderr);
  const table = r.stdout.split('\n').filter((l) => l.startsWith('| '));
  assert.match(table[0]!, /\| world \| clean \| things \(rows\) \|.*\| uploads \(named\) \| differences \(unexplained\) \| no entry: things \(kinds\) \|/);
  assert.match(table.find((l) => l.startsWith(`| ${SLUG} |`))!, new RegExp(`^\\| ${SLUG} \\| yes \\|`));
  assert.match(table.find((l) => l.startsWith('| not-a-backup.db |'))!, /^\| not-a-backup\.db \| \*\*no\*\* \|/);
  assert.match(r.stdout, /export: the backup did not export: /);
});
