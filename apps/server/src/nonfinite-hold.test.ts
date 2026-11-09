// #1496: on a durable-clock world the frontier hashes the head every tick. A non-finite number that quarantine/1 does not hold
// (anything but a human's pose, yaw, level or human state) made persistClockFrontier halt and rethrow, and pumpFrame rethrew it
// out of the process. Under nonfinite-hold/1 each such number is put back to its value in the last good snapshot by one logged
// event, what it touched stops, the frontier is written through that event, and a boot from the log agrees.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { marsFactory, MEAL_WORLD } from '@souls/engine-mars';
import { WorldHost } from './world.ts';
import { fixture, invite, accept, seed, worldId } from '../test/native-owner-fixture.ts';
import { rowsOf } from '../test/glitch-rows.ts';

const repair = await marsFactory({ ...MEAL_WORLD, sharedCarryV1: true, soulsRepairV1: true });
async function world(t: any, opts: { hold?: boolean; baseline?: boolean } = {}) {
  const { hold = true, baseline = true } = opts;
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {});
  const f = fixture(':memory:', repair, { durableClockV1: true }); f.brain.quiesce();
  t.after(() => { try { f.host.stop(); f.db.close(); } catch { /* closed */ } });
  const tick = (n: number) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); f.host.drainInputs(); } };
  tick(5);
  await accept<unknown>(f.host, f.host.enableQuarantineV1('test'));
  if (hold) await accept<unknown>(f.host, f.host.enableNonFiniteHoldV1('test'));
  await invite(f, 'ada');
  const row = await accept(f.host, f.souls.create('dev:ada', { name: 'Ada', description: 'nonfinite test' })) as { entity_id: string };
  tick(5);
  const h = f.host as any;
  if (baseline) {   // a last good snapshot to go back to
    f.host.requestSnapshot('test'); tick(1);
    for (let i = 0; i < 200 && (h.periodicSnapshot || !h.recoveryBaseline); i++) await setImmediate();
    assert.ok(h.recoveryBaseline, 'a recovery baseline');
  } else { h.recoveryBaseline = null; h.recoveryCapture = null; }   // nothing good to go back to
  const ents = () => f.host.engine.world.entities as Record<string, any>;
  const boot = () => { const next = new WorldHost(f.db, repair, seed, 1e9, worldId, { durableClockV1: true }); next.boot(); return next; };
  return { f, h, ents, tick, ada: row.entity_id, boot };
}
const held = (f: any) => rowsOf(f.db).filter((r: any) => r.rule === 'state.non-finite') as any[];
const events = (f: any) => f.db.events(worldId, 0).filter((e: any) => e.payload?.nonFiniteHoldV1);

test('#1496 an object whose pose is NaN goes back to its last good pose: no throw, one logged patch, a boot agrees', async (t) => {
  const { f, h, ents, tick, boot } = await world(t);
  const was = ents().bowl1.pose.p[0];
  ents().bowl1.pose.p[0] = NaN;   // between ticks, as a bug outside any rule would leave it
  assert.doesNotThrow(() => f.host.tickOnce(), 'the tick never throws');
  assert.equal(ents().bowl1.pose.p[0], was, 'back to its last good value');
  assert.equal(f.host.clockAvailable, true, 'the clock goes on');
  const [row] = held(f);
  assert.deepEqual(row?.evidence?.fields, [{ field: 'world:entities.bowl1.pose.p.0', from: 'baseline' }], JSON.stringify(row));
  assert.equal(events(f).length, 1, 'one logged event');
  assert.equal(h.seq, events(f)[0].seq, 'the frontier is written through the patch');
  tick(5);
  const next = boot();
  assert.equal(next.engine.world.tick, f.host.engine.world.tick);
  assert.equal(next.engine.stateHash(), f.host.engine.stateHash(), 'a boot from the log agrees');
});

test('#1496 a NaN in a programme is put back, that programme stops and its body is named so its Soul is told', async (t) => {
  const { f, tick, ada, boot } = await world(t);
  const m = [...f.host.minds.values()].find(x => x.entityId === ada)!;
  await accept(f.host, f.host.enqueue('decision', 'scripted:test', { soulId: m.soulId, entityId: ada, option: 'rest', label: 'Rest', steps: [{ verb: 'rest', params: { seconds: 30 } }], reevalTicks: 1e9, fallback: false, trigger: 'scripted-test' }));
  tick(2);
  const id = f.host.engine.programOf(ada);
  assert.ok(id, 'a programme runs');
  const prog = (f.host.engine as any).programs.get(id);
  prog.since = NaN;
  assert.doesNotThrow(() => f.host.tickOnce());
  assert.equal(f.host.engine.programOf(ada), null, 'that programme stopped');
  const [row] = held(f);
  assert.deepEqual(row?.evidence?.fields, [{ field: `programme:${id}.since`, from: 'zero' }], JSON.stringify(row));
  assert.deepEqual(row?.evidence?.programmes, [id]);
  assert.deepEqual(events(f)[0].payload.nonFiniteHoldV1.souls, [m.soulId], 'its Soul is named, so it is told');
  tick(3);
  assert.equal(boot().engine.stateHash(), f.host.engine.stateHash(), 'a boot from the log agrees');
});

test('#1496 a NaN in a world field outside any entity is put back too', async (t) => {
  const { f, ents, tick, boot } = await world(t);
  const w = f.host.engine.world as any;
  const was = w.env.weather.wind;
  w.env.weather.wind = NaN;
  assert.doesNotThrow(() => f.host.tickOnce());
  assert.equal(w.env.weather.wind, was);
  assert.deepEqual(held(f)[0]?.evidence?.fields, [{ field: 'world:env.weather.wind', from: 'baseline' }]);
  void ents;
  tick(3);
  assert.equal(boot().engine.stateHash(), f.host.engine.stateHash(), 'a boot from the log agrees');
});

test('#1496 with no last good value an object is set down at the arrival, logged as the eject', async (t) => {
  const { f, ents, boot } = await world(t, { baseline: false });
  const was = { ...ents().bowl2.pose, p: [...ents().bowl2.pose.p] };
  ents().bowl2.pose.p[1] = NaN;
  assert.doesNotThrow(() => f.host.tickOnce());
  assert.ok(ents().bowl2.pose.p.every(Number.isFinite));
  const [row] = held(f);
  assert.equal(ents().bowl2.support?.kind, 'ground', JSON.stringify(row));
  assert.notDeepEqual(ents().bowl2.pose.p, was.p, 'moved: the forced move is the eject');
  assert.deepEqual(row?.evidence?.fields, [{ field: 'world:entities.bowl2', from: 'arrival' }]);
  assert.deepEqual(row?.evidence?.arrival, ['bowl2']);
  assert.equal(boot().engine.stateHash(), f.host.engine.stateHash(), 'a boot from the log agrees');
});

test('#1496 without nonfinite-hold/1 the frontier still halts by name and the tick throws (the process exits and restarts from the log, as before)', async (t) => {
  const { f, ents } = await world(t, { hold: false });
  ents().bowl1.pose.p[0] = NaN;
  assert.throws(() => f.host.tickOnce(), /non-finite number in hashed state/);
  assert.equal(f.host.clockAvailable, false);
  assert.deepEqual(Object.keys(f.host.glitches.byRule).filter(r => r.startsWith('durability.clock') || r === 'engine.unhashable'), ['durability.clock-frontier']);
});

test('#1496 a non-finite number outside what the engine can put back (the kernel) still halts by name: the process exits and restarts from the log', async (t) => {
  const { f, h } = await world(t);
  h.kernel.nextId = NaN;
  assert.throws(() => f.host.tickOnce(), /non-finite number/);
  assert.equal(f.host.clockAvailable, false, 'halted, never ticking on corrupt state');
  assert.ok(f.host.glitches.byRule['durability.clock-frontier']?.halt, JSON.stringify(f.host.glitches.byRule));
  assert.equal(held(f).length, 0, 'nothing patched: no frontier over corrupt state');
});
