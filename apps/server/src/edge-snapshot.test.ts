// Lane O2: the keyed snapshot is the only snapshot a shared cache may keep, and only while its key is current.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Hono, type Context } from 'hono';
import { Db } from './db.ts';
import { ApiError } from './souls.ts';
import { GodMode } from './god/god.ts';
import { mountGodRoutes } from './god/routes.ts';
import { mountModeration } from './moderation/routes.ts';
import { EDGE_SNAPSHOT_CACHE, SNAPSHOT_EPOCH_FILE, SNAPSHOT_KEY_HEADER, mountEdgeSnapshot, safeKey, snapshotEpoch, snapshotKey, withSnapshotKey, withWorldClock } from './edge-snapshot.ts';

/** The http.ts wiring in miniature: moderation first, then the edge snapshot, then the god routes. */
function world(t: { after(f: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'edge-snapshot-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new Db(':memory:');
  const god = new GodMode(db, { worldId: 'edge-1', ownerId: 'dev:owner', tick: () => 1, emit: () => {}, assetDir: dir } as never);
  const app = new Hono();
  const bearer = (c: Context) => c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const requireUser = async () => { throw new ApiError(401, 'unauthorized', 'sign in'); };
  const moderation = mountModeration(app, { db: db.db, worldId: 'edge-1', bearer, requireUser, god, siteLog: join(dir, 'site.jsonl') });
  const key = () => snapshotKey({ editSeq: god.model.editSeq, buildsRev: god.store.buildsRev(), moderation: moderation.version() });
  mountEdgeSnapshot(app, key);
  mountGodRoutes(app, { god, worldName: 'Edge', requireUser, soulFromBearer: () => null, baseOf: () => 'http://localhost:6510/w/edge', limitIp: () => {} });
  return { god, app, key };
}

test('a keyed snapshot is shared-cacheable only while its key is current; everything else stays no-store', async (t) => {
  const w = world(t);
  assert.equal(w.god.act({ ops: [{ op: 'place', def: 'core/box@1', p: [3, 4], name: 'crate' }] }).accepted, true);
  const k0 = w.key();
  assert.match(k0, /^\d+\.\d+\.\d+\.\d+$/);

  const plain = await w.app.request('/v1/world/snapshot');
  assert.equal(plain.status, 200); assert.equal(plain.headers.get('cache-control'), 'no-store', 'the plain URL (resync, God UI) is never cached');
  assert.equal(plain.headers.get(SNAPSHOT_KEY_HEADER), k0);

  const keyed = await w.app.request(`/v1/world/snapshot?v=${k0}`, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(keyed.status, 200); assert.equal(keyed.headers.get('cache-control'), EDGE_SNAPSHOT_CACHE);
  assert.equal(keyed.headers.get('content-encoding'), 'gzip', 'compression still applies');
  const body = JSON.parse(gunzipSync(Buffer.from(await keyed.arrayBuffer())).toString('utf8'));
  assert.equal(body.seq, w.god.model.editSeq); assert.deepEqual(body.entities.map((e: { name: string }) => e.name), ['crate']);

  for (const v of ['', 'nonsense', '0.0.0.0', `${k0}.1`]) {
    const r = await w.app.request(`/v1/world/snapshot?v=${encodeURIComponent(v)}`);
    assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store', `v=${v} is not the current key`);
  }

  // an edit moves the key: the old key now answers the current world, uncached
  assert.equal(w.god.act({ ops: [{ op: 'place', def: 'core/box@1', p: [9, 9], name: 'barrel' }] }).accepted, true);
  const k1 = w.key(); assert.notEqual(k1, k0);
  const stale = await w.app.request(`/v1/world/snapshot?v=${k0}`);
  assert.equal(stale.headers.get('cache-control'), 'no-store'); assert.equal(stale.headers.get(SNAPSHOT_KEY_HEADER), k1);
  assert.equal((await stale.json()).entities.length, 2);
  assert.equal((await w.app.request(`/v1/world/snapshot?v=${k1}`)).headers.get('cache-control'), EDGE_SNAPSHOT_CACHE);
});

test('the key changes when the edit seq, the builds revision or the moderation version does, and is URL/script safe', () => {
  const base = { editSeq: 7, buildsRev: 2, moderation: '3.0' };
  assert.equal(snapshotKey(base), '7.2.3.0');
  assert.notEqual(snapshotKey({ ...base, editSeq: 8 }), snapshotKey(base));
  assert.notEqual(snapshotKey({ ...base, buildsRev: 3 }), snapshotKey(base));
  assert.notEqual(snapshotKey({ ...base, moderation: '3.1' }), snapshotKey(base));
  assert.throws(() => snapshotKey({ ...base, moderation: '"</script>' }));
  assert.equal(safeKey(() => { throw new Error('db closed'); }), null);
  assert.equal(safeKey(null), null);
});

test('the page HTML carries the key first thing in <head>; no key leaves it untouched', () => {
  const html = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n    <title>Sim</title>\n    <script>prefetch()</script>\n  </head><body></body></html>';
  const out = withSnapshotKey(html, '12.0.0.0');
  assert.ok(out.includes('<head><script>window.__simSnapshotKey="12.0.0.0"</script>\n    <meta charset'));
  assert.ok(out.indexOf('__simSnapshotKey') < out.indexOf('prefetch()'), 'set before the prefetch script runs');
  assert.equal(withSnapshotKey(html, null), html);
  assert.equal(withSnapshotKey('<p>no head</p>', '1.0.0.0'), '<p>no head</p>');
  const a = 'a'.repeat(32), b = 'b'.repeat(32);
  assert.ok(withSnapshotKey(html, '12.0.0.0', { defs: a, ground: b }).includes(`<script>window.__simSnapshotKey="12.0.0.0";window.__simSnapshotParts=["${a}","${b}"]</script>`), 'P7: the parts ride with the key');
  assert.ok(!withSnapshotKey(html, '12.0.0.0', { defs: '</script>', ground: b }).includes('__simSnapshotParts'), 'only well-formed refs');
});

test("P7d: the page HTML carries the world's clock for the phone's early poster; anything but an ISO time leaves it untouched", () => {
  const html = '<!doctype html><html><head><title>Sim</title></head><body></body></html>';
  assert.ok(withWorldClock(html, '2026-03-04T21:15:00.000Z').includes('<head><script>window.__simWorldClock="2026-03-04T21:15:00.000Z";</script><title>'));
  for (const bad of [null, 12, '', 'now', '2026-03-04T21:15:00Z"</script><script>x()', '2026-03-04']) assert.equal(withWorldClock(html, bad), html);
  assert.equal(withWorldClock('<p>no head</p>', '2026-03-04T21:15:00Z'), '<p>no head</p>');
  // and how many Souls live there (the poster's view): with the clock, alone, or not at all for anything but a count
  assert.ok(withWorldClock(html, '2026-03-04T21:15:00.000Z', 7).includes('<head><script>window.__simWorldClock="2026-03-04T21:15:00.000Z";window.__simWorldSouls=7;</script><title>'));
  assert.ok(withWorldClock(html, null, 0).includes('<head><script>window.__simWorldSouls=0;</script><title>'));
  for (const bad of [null, -1, 1.5, '3', NaN]) assert.equal(withWorldClock(html, null, bad), html);
});

/** E6: a world on disk as a launcher child runs it (<dataDir>/sim.db), its key wired as http.ts does. The site log sits
 *  outside the world folder, as in production, so a restore does not bring it back. */
function diskWorld(dataDir: string, siteLog: string) {
  mkdirSync(dataDir, { recursive: true });
  const db = new Db(join(dataDir, 'sim.db'));
  const god = new GodMode(db, { worldId: 'edge-1', ownerId: 'dev:owner', tick: () => 1, emit: () => {}, assetDir: dataDir } as never);
  const bearer = (c: Context) => c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const requireUser = async () => { throw new ApiError(401, 'unauthorized', 'sign in'); };
  const moderation = mountModeration(new Hono(), { db: db.db, worldId: 'edge-1', bearer, requireUser, god, siteLog });
  const epoch = snapshotEpoch(dataDir);
  const key = () => snapshotKey({ editSeq: god.model.editSeq, buildsRev: god.store.buildsRev(), moderation: moderation.version(), epoch });
  const place = (name: string, p: [number, number]) => assert.equal(god.act({ ops: [{ op: 'place', def: 'core/box@1', p, name }] }).accepted, true);
  return { db, god, key, place };
}
const withoutEpoch = (k: string) => k.split('.').slice(0, -1).join('.');

test('E6 A1: a world restored to an earlier state answers a different key than it had before the restore', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-epoch-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const site = join(dir, 'site.jsonl'), live = diskWorld(join(dir, 'live'), site);
  live.place('crate', [3, 4]);
  const atBackup = live.key();
  // the nightly backup: an online copy of sim.db alone (backup-restic.mjs carries only sim.db from a world's folder)
  mkdirSync(join(dir, 'backup')); live.db.db.exec(`VACUUM INTO '${join(dir, 'backup', 'sim.db')}'`);
  live.place('barrel', [9, 9]);
  const beforeRestore = live.key();
  live.db.close();
  // the restore: restic writes that copy into an empty folder, and the world boots from it
  mkdirSync(join(dir, 'restored')); copyFileSync(join(dir, 'backup', 'sim.db'), join(dir, 'restored', 'sim.db'));
  const back = diskWorld(join(dir, 'restored'), site);
  assert.equal(back.god.model.editSeq, 1, 'the database is back at the earlier state');
  assert.equal(withoutEpoch(back.key()), withoutEpoch(atBackup), 'the three old parts alone would repeat the old key');
  assert.notEqual(back.key(), atBackup, 'the restored seq answers a new key');
  back.place('lamp', [1, 1]);   // a different edit reuses seq 2
  assert.equal(withoutEpoch(back.key()), withoutEpoch(beforeRestore));
  assert.notEqual(back.key(), beforeRestore, 'the reused seq answers a key the edge has never held');
  assert.match(back.key(), /^[0-9]+(\.[0-9]+)*$/, 'A3: still digits and dots');
  back.db.close();
});

test('E6 A2: a restart keeps the key', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'edge-epoch-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const site = join(dir, 'site.jsonl'), data = join(dir, 'world');
  const first = diskWorld(data, site);
  first.place('crate', [3, 4]);
  const k = first.key(), epoch = readFileSync(join(data, SNAPSHOT_EPOCH_FILE), 'utf8').trim();
  first.db.close();
  const again = diskWorld(data, site);
  assert.equal(again.key(), k, 'same world, same history: the same key after the restart');
  assert.equal(k.split('.').at(-1), epoch, 'the epoch is the last part');
  again.db.close();
});
