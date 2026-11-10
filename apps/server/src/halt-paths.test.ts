// #1511: no halt leaves a frozen world silently. Each named halt path stops the clock and sets live.json `halted` (load/monitor.ts),
// which the launcher's guard acts on (#1326, tools/world-launcher/children.mjs): it restarts the world from its log once per
// breaker window, and a second halt in the window stays halted (503) and is an ALERT. One test per path the issue names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, MEAL_WORLD } from '@souls/engine-mars';
import { fixture } from '../test/native-owner-fixture.ts';
import { LoadMonitor } from './load/monitor.ts';
import { liveOf, newSharedLoad } from './load/shared.ts';

const repair = await marsFactory({ ...MEAL_WORLD, sharedCarryV1: true, soulsRepairV1: true });
function world(t: any) {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {});
  const f = fixture(':memory:', repair, { durableClockV1: true }); f.brain.quiesce();
  t.after(() => { try { f.host.stop(); f.db.close(); } catch { /* closed */ } });
  for (let i = 0; i < 5; i++) { f.host.tickOnce(); f.host.drainInputs(); }
  return { f, h: f.host as any };
}
/** What the launcher reads: live.json's `halted`, as the load monitor publishes it from this host. */
function liveHalted(host: any) { const shared = newSharedLoad(), m = new LoadMonitor({ host, now: () => 5000, shared }); m.sample(); m.stop(); return liveOf(shared, 1, 5000).halted === true; }
const halts = (f: any) => Object.entries(f.host.glitches.byRule as Record<string, {halt?: number}>).filter(([, v]) => v.halt).map(([k]) => k);

test('#1511 a clock frontier that cannot be written halts by name and publishes halted (the tick throws: the process exits)', (t) => {
  const { f, h } = world(t);
  assert.equal(liveHalted(f.host), false, 'a running world is not halted');
  t.mock.method(h.clockFrontiers, 'write', () => { throw new Error('disk full'); });
  assert.throws(() => f.host.tickOnce(), /disk full/);
  assert.equal(f.host.clockAvailable, false); assert.deepEqual(halts(f), ['durability.clock-frontier']);
  assert.equal(liveHalted(f.host), true);
});

test('#1511 snapshotFaultedHead\'s swallowed frontier halt is still a halt: the clock stops and live.json says halted', (t) => {
  const { f, h } = world(t);
  t.mock.method(h.clockFrontiers, 'write', () => { throw new Error('disk full'); });
  assert.doesNotThrow(() => h.snapshotFaultedHead(), 'swallowed: not rethrown');
  assert.equal(f.host.clockAvailable, false); assert.deepEqual(halts(f), ['durability.clock-frontier']);
  assert.equal(liveHalted(f.host), true, 'not silent: the launcher sees it');
});

test('#1511 failCheckpoint (a repair that cannot be written: durability.repair) stops the clock and publishes halted', (t) => {
  const { f, h } = world(t);
  t.mock.method(f.db, 'appendEvent', () => { throw new Error('disk full'); });
  assert.equal(h.writeRepair({ seq: h.seq + 1, tick: f.host.engine.world.tick, kind: 'rules', author: 'world:test', payload: {}, at: 0 }), false);
  assert.equal(f.host.clockAvailable, false); assert.deepEqual(halts(f), ['durability.repair']);
  assert.equal(liveHalted(f.host), true);
});

test('#1511 failCheckpoint (a periodic checkpoint that fails: durability.checkpoint) stops the clock and publishes halted', (t) => {
  const { f, h } = world(t);
  h.failCheckpoint(new Error('checkpoint write failed'));
  assert.equal(f.host.clockAvailable, false); assert.deepEqual(halts(f), ['durability.checkpoint']);
  assert.equal(liveHalted(f.host), true);
});

test('#1511 haltOnFault (an edge world\'s unrecoverable fault) stops the clock and publishes halted', (t) => {
  const { f, h } = world(t);
  h.haltOnFault(new Error('fixture.unrepairable'), 'no resumable recovery baseline');
  assert.equal(f.host.clockAvailable, false); assert.equal(halts(f).length, 1);
  assert.equal(liveHalted(f.host), true);
});

test('#1511 steps that keep failing (engine.step-failing) publish halted though the clock runs', (t) => {
  const { f, h } = world(t);
  h.stepFailing = 'every step faults';
  assert.equal(f.host.clockAvailable, true);
  assert.equal(liveHalted(f.host), true);
});
