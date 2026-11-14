// node --test tools/world-launcher/worlds-memory.test.mjs (#2233 A6; no world processes: the pool's own rules)
// One memory figure for worlds: each state name, the order in which worlds are unloaded to make room, and admission
// refused on the estimate of a world still loading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChildPool, LOAD_MB, worldClass, worldState } from './children.mjs';
import { pssMb } from './production.mjs';

const dir = mkdtempSync(join(tmpdir(), 'worlds-mem-'));
const MIN = 60_000, now = Date.now();
const pool = (o = {}) => new ChildPool({ root: process.cwd(), range: [1, 2], logDir: join(dir, 'logs'), ...o });
/** A world in the pool's map as a running (or other) process would leave it; stop() is recorded instead of signalling. */
function kid(p, slug, { status = 'running', lastUsed = now, pid = 100 + p.kids.size, world = {} } = {}) {
  const k = { slug, world: { slug, ...world }, status, port: 1, child: status === 'running' ? { pid } : null, lastUsed, restarts: 0 };
  p.kids.set(slug, k); return k;
}
const recording = (p) => { const stopped = []; p.stop = async (slug) => { stopped.push(slug); p.kids.get(slug).status = 'stopped'; p.kids.get(slug).child = null; }; return stopped; };

test('each state name, from the pool status and the world\'s still answer (old readers keep `status`)', () => {
  assert.equal(worldState({ status: 'running' }), 'awake');
  assert.equal(worldState({ status: 'running' }, { still: false }), 'awake');
  assert.equal(worldState({ status: 'running' }, { still: true }), 'still');
  assert.equal(worldState({ status: 'handover' }), 'awake');
  for (const s of ['starting', 'waiting', 'restarting']) assert.equal(worldState({ status: s }), 'starting', s);
  assert.equal(worldState({ status: 'failed' }), 'failed');
  assert.equal(worldState({ status: 'stopped', held: { failures: 5 } }), 'failed');
  assert.equal(worldState({ status: 'stopped' }), 'unloaded');
  assert.equal(worldState({ status: 'asleep' }), 'unloaded');
  const p = pool(); kid(p, 'a');
  const st = p.status('a');
  assert.equal(st.status, 'running', 'the old field is unchanged');
  assert.equal(typeof st.inMemorySec24h, 'number');
});

test('room is made in order: still worlds (horizon at least 60 s away) first, then worlds quiet for 10 min; a busy world never', async () => {
  const still = new Map(), busy = new Set();
  const p = pool({ still: (k) => still.get(k.slug) ?? null, busy: (s) => busy.has(s) });
  const stopped = recording(p);
  kid(p, 'quiet-old', { lastUsed: now - 30 * MIN });
  kid(p, 'quiet', { lastUsed: now - 11 * MIN });
  kid(p, 'still-near', { lastUsed: now - 40 * MIN }); still.set('still-near', { still: true, untilWallMs: now + 30_000, at: now });
  kid(p, 'still-b', { lastUsed: now - 5 * MIN }); still.set('still-b', { still: true, untilWallMs: now + 5 * MIN, at: now });
  kid(p, 'still-a', { lastUsed: now - 8 * MIN }); still.set('still-a', { still: true, untilWallMs: null, at: now });
  kid(p, 'watched', { lastUsed: now - 50 * MIN }); still.set('watched', { still: true, untilWallMs: null, at: now }); busy.add('watched');
  kid(p, 'acted-since', { lastUsed: now - MIN }); still.set('acted-since', { still: true, untilWallMs: null, at: now - 2 * MIN });   // its still answer is older than its last act
  kid(p, 'awake', { lastUsed: now - 2 * MIN });
  const order = [];
  for (let i = 0; i < 6; i++) order.push(await p.unloadForRoom('new', now));
  // still worlds first, acted in longest ago first; still-near's horizon is under 60 s away, so it goes only as a quiet
  // world (40 min), with the others quiet for 10 min or more, oldest first; then nothing
  assert.deepEqual(order, ['still-a', 'still-b', 'still-near', 'quiet-old', 'quiet', null]);
  assert.deepEqual(stopped, ['still-a', 'still-b', 'still-near', 'quiet-old', 'quiet']);
  assert.equal(p.kids.get('watched').status, 'running', 'a watched world is never unloaded');
  assert.equal(p.kids.get('acted-since').status, 'running', 'acted in since it said it was still, and not quiet');
  assert.equal(p.kids.get('awake').status, 'running');
});

test('admission counts running worlds\' Pss and each loading world\'s estimate, and refuses with world capacity when nothing can go', async () => {
  const big = join(dir, 'eden.json'), small = join(dir, 'hamlet.json');
  writeFileSync(big, 'x'.repeat(1_100_000)); writeFileSync(small, '{}');
  assert.equal(worldClass({ templateFile: big }), 'eden'); assert.equal(worldClass({ templateFile: small }), 'small'); assert.equal(worldClass({ fork: true }), 'eden');
  const p = pool({ worldsMemMb: 1400, pss: () => 300, maxRunning: 1 });
  recording(p);
  kid(p, 'one');                                                              // 300 MB measured
  kid(p, 'eden', { status: 'starting', world: { templateFile: big } });       // 650 MB estimated while it loads
  kid(p, 'new', { status: 'starting', world: { templateFile: small } });
  assert.deepEqual(p.memUse('new'), { running: 300, loading: LOAD_MB.eden, waiting: 0 });
  // 300 + 650 + 310 = 1260 of 1400: fits, and maxRunning 1 is not the limit with a memory figure
  assert.equal(p.roomFor('new').ok, true);
  kid(p, 'two', { status: 'waiting' });                                       // waiting for a load slot: not counted against 'new'
  assert.equal(p.roomFor('new').ok, true);
  kid(p, 'three');                                                            // +300: 1560 > 1400
  const r = p.roomFor('new'); assert.equal(r.ok, false); assert.equal(r.needMb, 1560);
  // the same without the loading Eden world would fit: the refusal is on its estimate
  p.kids.get('eden').status = 'stopped'; assert.equal(p.roomFor('new').ok, true); p.kids.get('eden').status = 'starting';
  // 'one' and 'three' were used just now and are not still: nothing can be unloaded, so the load is refused
  await assert.rejects(p.makeRoom('new'), (e) => e.code === 'capacity' && /memory is full \(1560 of 1400 MB/.test(e.message));
  assert.ok(p.problems().some((x) => x.code === 'worlds.capacity'), 'a host problem code on the health data');
});

test('Pss is read from smaps_rollup, at most every 30 s per process', () => {
  assert.equal(pssMb(7, () => 'Rss:  900000 kB\nPss:  512000 kB\n'), 500);
  assert.equal(pssMb(7, () => { throw new Error('ENOENT'); }), null);
  let reads = 0;
  const p = pool({ worldsMemMb: 10_000, pss: () => { reads++; return 200; } });
  kid(p, 'a');
  p.memUse(null, now); p.memUse(null, now + 10_000); assert.equal(reads, 1);
  p.memUse(null, now + 30_000); assert.equal(reads, 2);
});
