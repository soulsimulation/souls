// #1368: a periodic snapshot whose capture throws must never stop the clock or the process. Main e0ad750a2 exited at tick
// 5212 of a stair rate run on an uncaught `snapshot.unencodable` thrown by the periodic capture inside tickOnce. The host
// now names an engine capture refusal (a `snapshot.*` SnapshotError: glitch rung `contained`, rule
// `durability.snapshot-skipped`), skips that snapshot and ticks on; the next due snapshot is taken as usual. Other capture
// faults keep their pinned path (periodic-snapshot.test.ts, checkpoint-hash-lifecycle.test.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {marsFactory} from '@souls/engine-mars';
import {SnapshotError} from '../../../mars/viewer/engine/runtime/snapshot.ts';
import {Db} from './db.ts';
import {WorldHost} from './world.ts';

test('#1368 a periodic snapshot that cannot be captured is skipped and named; the world ticks on and snapshots later', async (t) => {
  const factory = await marsFactory();
  const db = new Db(join(mkdtempSync(join(tmpdir(), 'souls-snapskip-')), 'world.db'));
  const h = new WorldHost(db, factory, 'snapskip', 20); h.boot();
  t.after(() => { h.stop(); db.close(); });
  void h.enqueue('birth', 'test', {soulId: 'sa', entityId: 'a', name: 'Ada', description: 'test', owner: 'owner'});
  const drain = async () => { for (let i = 0; i < 8; i++) await setImmediate(); };
  for (let i = 0; i < 25; i++) h.tickOnce();
  await drain();
  const before = db.latestSnapshot(h.worldId)?.tick ?? -1;
  const unencodable = new SnapshotError('snapshot.unencodable', 'cannot take a resumable snapshot: detour.clearOf is a function');
  const mock = t.mock.method(h.engine as {captureCheckpoint(): unknown}, 'captureCheckpoint', () => { throw unencodable; });
  const t0 = h.engine.world.tick;
  for (let i = 0; i < 60; i++) assert.doesNotThrow(() => h.tickOnce(), `tick ${h.engine.world.tick}`);
  await drain();
  assert.equal(h.engine.world.tick, t0 + 60, 'the clock kept advancing');
  assert.equal(h.clockAvailable, true, 'the clock is still available (no halt)');
  assert.ok(mock.mock.callCount() >= 2 && mock.mock.callCount() <= 3, `one attempt per due snapshot, not one per tick (${mock.mock.callCount()})`);
  assert.deepEqual(h.glitches.byRule['durability.snapshot-skipped'], {contained: mock.mock.callCount()}, 'each skip is named');
  assert.equal(db.latestSnapshot(h.worldId)?.tick ?? -1, before, 'no snapshot was written for the skipped captures');
  mock.mock.restore();
  for (let i = 0; i < 25; i++) h.tickOnce();
  await drain();
  assert.ok((db.latestSnapshot(h.worldId)?.tick ?? -1) > t0 + 60, 'the next due snapshot is written');
});
