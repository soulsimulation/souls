// #1492: a body whose pose went NaN with nothing faulting is held by quarantine/1's once-a-second sweep. A periodic snapshot due
// before that sweep captured the broken head, the capture threw (`non-finite number in hashed state`) and pumpFrame rethrew it:
// the server process exited. Now the world sweeps on a tick a snapshot comes due, so the body is held first, and a capture that
// still meets a non-finite number is skipped by name (`snapshot.non-finite`, the entity and field) and never thrown.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, GREEN_FIELD_WORLD } from '@souls/engine-mars';
import { fixture, invite, accept } from '../test/native-owner-fixture.ts';
import { rowsOf } from '../test/glitch-rows.ts';

const repair = await marsFactory({ ...GREEN_FIELD_WORLD, sharedCarryV1: true, soulsRepairV1: true });
async function world(t: any, quarantine: boolean, durableClockV1 = true) {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {});
  const f = fixture(':memory:', repair, { durableClockV1 }); f.brain.quiesce();
  t.after(() => { try { f.host.stop(); f.db.close(); } catch { /* closed */ } });
  for (let i = 0; i < 5; i++) { f.host.tickOnce(); f.host.drainInputs(); }
  if (quarantine) await accept<unknown>(f.host, f.host.enableQuarantineV1('test'));
  await invite(f, 'ada');
  const row = await accept(f.host, f.souls.create('dev:ada', { name: 'Ada', description: 'snapshot test' })) as { entity_id: string };
  for (let i = 0; i < 5; i++) { f.host.tickOnce(); f.host.drainInputs(); }
  const h = f.host as any, ada = () => f.host.engine.world.entities[row.entity_id] as any;
  // between ticks, as a bug outside any rule would leave it: nothing faults, the sweep is not due this tick
  const breakAda = () => { while ((f.host.engine.world.tick + 1) % 20 === 0) { f.host.tickOnce(); f.host.drainInputs(); } ada().pose.p = [NaN, ada().pose.p[1], ada().pose.p[2]]; };
  return { f, h, ada, id: row.entity_id, breakAda };
}

test('#1492 under quarantine/1 a snapshot due while a body is broken holds the body first: no throw, the capture sees it whole', async (t) => {
  const { f, h, ada, breakAda } = await world(t, true, false);   // as a world without the durable clock (its per-tick hash would hold the body)
  breakAda(); f.host.requestSnapshot('test');
  const before = h.lastSnapshotTick;
  assert.doesNotThrow(() => f.host.tickOnce(), 'the tick never throws');
  assert.ok(ada().pose.p.every(Number.isFinite), 'held whole on that tick');
  assert.ok(h.lastSnapshotTick > before || h.periodicSnapshot, 'the snapshot was taken');
  assert.equal(f.host.clockAvailable, true);
});

test('#1492 a capture that meets a non-finite number is skipped by name, never thrown, and the world ticks on', async (t) => {
  const { f, h, id, breakAda } = await world(t, false, false);   // no quarantine/1 and no per-tick hash: only the capture reads it
  breakAda(); f.host.requestSnapshot('test');
  assert.doesNotThrow(() => f.host.tickOnce(), 'the tick never throws');
  const row = Object.entries(f.host.glitches.byRule).find(([rule]) => rule === 'durability.snapshot-skipped');
  assert.ok(row, `a skipped snapshot is counted: ${JSON.stringify(f.host.glitches.byRule)}`);
  const skipped = rowsOf(f.db).filter((r: any) => r.rule === 'durability.snapshot-skipped').at(-1) as any;
  assert.deepEqual([skipped?.evidence?.code, skipped?.evidence?.entity, skipped?.evidence?.field], ['snapshot.non-finite', id, 'pose.p[0]'], JSON.stringify(skipped));
  for (let i = 0; i < 5; i++) assert.doesNotThrow(() => { f.host.tickOnce(); f.host.drainInputs(); });
  assert.equal(f.host.clockAvailable, true);
});
