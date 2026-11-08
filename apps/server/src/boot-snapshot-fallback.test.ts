// #1379: a boot whose latest snapshot won't restore falls back to an older snapshot, then genesis, and replays the log
// from there to the same head. Each skipped snapshot is a named glitch (rung `recovery`, rule
// `boot.snapshot-unrestorable`), never silent, and the host takes a fresh snapshot soon. A fallback that fails too names
// both failures. Before this, `WorldHost.boot()` threw on the first bad snapshot and the world could not start.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setImmediate} from 'node:timers/promises';
import {marsFactory} from '@souls/engine-mars';
import {Db} from './db.ts';
import {WorldHost} from './world.ts';

const RULE = 'boot.snapshot-unrestorable';
const drain = async () => { for (let i = 0; i < 8; i++) await setImmediate(); };

/** A world with a Soul, three periodic snapshots and logged events after the last one. */
async function lived(t: {after(f: () => void): void}) {
  const factory = await marsFactory(), root = mkdtempSync(join(tmpdir(), 'souls-bootfb-'));
  const db = new Db(join(root, 'world.db'));
  t.after(() => { db.close(); rmSync(root, {recursive: true, force: true}); });
  const h = new WorldHost(db, factory, 'bootfb', 20); h.boot();
  void h.enqueue('birth', 'test', {soulId: 'sa', entityId: 'a', name: 'Ada', description: 'test', owner: 'owner'});
  for (let i = 0; i < 70; i++) { h.tickOnce(); await drain(); }
  void h.enqueue('birth', 'test', {soulId: 'sb', entityId: 'b', name: 'Ben', description: 'test', owner: 'owner'});
  for (let i = 0; i < 5; i++) { h.tickOnce(); await drain(); }
  const head = {tick: h.engine.world.tick, seq: (h as unknown as {seq: number}).seq, hash: h.engine.stateHash()};
  h.stop();
  const ticks = (db.db.prepare('SELECT tick FROM snapshots WHERE world_id = ? ORDER BY tick').all(h.worldId) as {tick: number}[]).map((r) => r.tick);
  assert.ok(ticks.length >= 3, `three snapshots taken: ${ticks}`);
  const reboot = () => {
    const b = new WorldHost(db, factory, 'bootfb', 1e9, h.worldId);
    t.after(() => b.stop());
    const out = b.boot();
    while (b.engine.world.tick < head.tick) b.tickOnce();
    return {b, out, at: {tick: b.engine.world.tick, seq: (b as unknown as {seq: number}).seq, hash: b.engine.stateHash()}};
  };
  // a body the reader refuses: a runtime snapshot the engine can't restore (as #1368's make-way wait was before #1375)
  const spoil = (tick: number) => db.db.prepare('UPDATE snapshots SET snapshot = ? WHERE world_id = ? AND tick = ?').run(JSON.stringify({runtime: {format: 'not-a-snapshot'}, minds: []}), h.worldId, tick);
  const glitches = () => db.db.prepare('SELECT rung, rule, tick, evidence FROM glitches_v1 WHERE world_id = ? AND rule = ?').all(h.worldId, RULE) as {rung: string; rule: string; tick: number; evidence: string}[];
  return {db, factory, h, head, ticks, reboot, spoil, glitches};
}

test('#1379 A6 a boot from a good snapshot falls back to nothing and records no glitch', async (t) => {
  const w = await lived(t);
  const {b, out, at} = w.reboot();
  assert.equal(out.from, 'snapshot');
  assert.deepEqual(at, w.head);
  assert.equal(w.glitches().length, 0);
  assert.equal(w.db.latestSnapshotText(b.worldId)!.tick, w.ticks.at(-1), 'no extra snapshot');
});

test('#1379 A1 A3 A5 an unrestorable latest snapshot: boot takes the one before, replays the log to the same head, and says so', async (t) => {
  const w = await lived(t);
  const latest = w.ticks.at(-1)!;
  w.spoil(latest);
  const {b, out, at} = w.reboot();
  assert.equal(out.from, 'snapshot');
  assert.ok(out.replayed > 0, 'the log after the older snapshot is replayed');
  assert.deepEqual(at, w.head, 'same tick, seq and state hash as the world that ran');
  const g = w.glitches();
  assert.equal(g.length, 1, 'one named glitch for the one skipped snapshot');
  assert.equal(g[0].rung, 'recovery');
  const ev = JSON.parse(g[0].evidence) as {tick: number; seq: number; from: string; reason: string};
  assert.equal(ev.tick, latest);
  assert.equal(typeof ev.seq, 'number');
  assert.equal(ev.from, 'snapshot');
  assert.ok(ev.reason.length > 0, 'the reason is kept');
  // A5: the host snapshots on its first tick after the fallback (snapshotEvery is 1e9 here), so the next boot needn't fall back
  for (let i = 0; i < 3; i++) { b.tickOnce(); await drain(); }
  const fresh = w.db.latestSnapshotText(b.worldId)!;
  assert.ok(fresh.tick > latest, `a fresh snapshot after the fallback: ${fresh.tick}`);
  assert.doesNotThrow(() => w.factory.restore((JSON.parse(fresh.text) as {runtime: never}).runtime));
});

test('#1379 A2 no snapshot restores: boot starts from genesis and replays the whole log to the same head', async (t) => {
  const w = await lived(t);
  for (const tick of w.ticks) w.spoil(tick);
  const {out, at} = w.reboot();
  assert.equal(out.from, 'genesis');
  assert.deepEqual(at, w.head);
  assert.equal(w.glitches().length, w.ticks.length, 'every skipped snapshot is named');
  assert.ok(w.glitches().every((g) => JSON.parse(g.evidence).from === 'genesis'));
});

test('#1379 A4 a fallback that fails too throws, naming the replay error and the first unrestorable snapshot', async (t) => {
  const w = await lived(t);
  for (const tick of w.ticks) w.spoil(tick);
  const create = w.factory.create;
  w.factory.create = () => { throw new Error('genesis.test-refused'); };
  t.after(() => { w.factory.create = create; });
  const b = new WorldHost(w.db, w.factory, 'bootfb', 1e9, w.h.worldId);
  t.after(() => b.stop());
  assert.throws(() => b.boot(), (e: Error) => {
    assert.match(e.message, /^boot\.fallback-failed: snapshot tick \d+ would not restore/);
    assert.match(e.message, /genesis\.test-refused/);
    assert.ok(e.cause instanceof Error, 'the first restore failure is the cause');
    return true;
  });
});
