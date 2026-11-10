// #1521 stand-height/2 on a host: its adoption stands any free body left in the air on level 0 (a world with no ground field) on
// its floor, once. The plan is read when the event is accepted and logged in it with each body's Soul, so a boot from the log
// stands the same bodies in the same places; a body already standing on its floor is untouched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { marsFactory, EDEN_SAFE_COMMONS_WORLD } from '@souls/engine-mars';
import { WorldHost } from './world.ts';
import { EdgeLedger } from './edge/ledger/ledger.ts';
import { STOOD_ON_FLOOR } from '@souls/engine-contract';
import { fixture, invite, accept, seed, worldId } from '../test/native-owner-fixture.ts';

const factory = await marsFactory({ ...EDEN_SAFE_COMMONS_WORLD, walkBlockV1: true, soulsRepairV1: true });
async function world(t: any) {
  t.mock.method(console, 'warn', () => {}); t.mock.method(console, 'error', () => {}); t.mock.method(console, 'log', () => {});
  const f = fixture(':memory:', factory, { durableClockV1: true }); f.brain.quiesce();
  t.after(() => { try { f.host.stop(); f.db.close(); } catch { /* closed */ } });
  const tick = (n: number) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); f.host.drainInputs(); } };
  tick(5);
  const born: string[] = [];
  for (const name of ['ada', 'bo']) { await invite(f, name); const row = await accept(f.host, f.souls.create(`dev:${name}`, { name: name[0].toUpperCase() + name.slice(1), description: 'stand height test' })) as { entity_id: string }; born.push(row.entity_id); }
  tick(5);
  return { f, tick, ada: born[0], bo: born[1], ents: () => f.host.engine.world.entities as Record<string, any> };
}
const repairs = (f: any) => f.db.events(worldId, 0).filter((e: any) => e.payload?.standHeightRepairV2);

test('#1521 adopting stand-height/2 stands a body left in the air on its floor, names its Soul, leaves the others, and a boot agrees', async (t) => {
  const { f, tick, ada, bo, ents } = await world(t);
  assert.ok(!(f.host.engine.world as any).groundV1, 'no ground field');
  const [x, , z] = ents()[ada].pose.p, boWas = structuredClone(ents()[bo].pose);
  ents()[ada].pose.p = [x, 0.24, z];   // as a stall release left it, mid-climb height on level 0
  await accept<unknown>(f.host, f.host.enableStandHeightV2('test'));
  assert.equal(ents()[ada].pose.p[1], 0, 'on its floor');
  assert.deepEqual([ents()[ada].pose.p[0], ents()[ada].pose.p[2]], [x, z], 'at the same point');
  assert.deepEqual(ents()[bo].pose, boWas, 'a body on its floor is untouched');
  const [e] = repairs(f);
  assert.deepEqual(e.payload.standHeightRepairV2.bodies.map((b: any) => [b.id, !!b.soul]), [[ada, true]], 'the body and its Soul are in the event');
  assert.equal(e.payload.runtimePolicy.standHeightV2, true, 'one event: the adoption carries the repair');
  tick(5);
  const next = new WorldHost(f.db, factory, seed, 1e9, worldId, { durableClockV1: true }); next.boot();
  assert.equal(next.engine.stateHash(), f.host.engine.stateHash(), 'a boot from the log agrees');
  await accept<unknown>(f.host, f.host.enableStandHeightV2('test'));
  assert.equal(repairs(f).length, 1, 'once: adopting again logs nothing');
});

test('#1521 with nobody in the air, the adoption logs no repair', async (t) => {
  const { f } = await world(t);
  await accept<unknown>(f.host, f.host.enableStandHeightV2('test'));
  assert.equal(repairs(f).length, 0);
  assert.equal((f.db.events(worldId, 0) as any[]).filter(e => e.payload?.runtimePolicy?.standHeightV2).length, 1);
});

test('#1521 review: each Soul the repair stands is told: its open act ends world.stood-on-floor and the notice is delivered to its stream', async (t) => {
  const { f, ada, ents } = await world(t);
  const edge = new EdgeLedger(f.host, f.db, undefined, { ambient: false }), delivered: [string, string][] = [];
  edge.attachComms({ streams: { headCursor: () => '0', deliver: (soulId: string, kind: string) => { delivered.push([soulId, kind]); return null; } }, fading: { status: () => null } } as never);
  const soulId = [...f.host.minds.values()].find(m => m.entityId === ada)!.soulId;
  f.db.db.prepare('INSERT INTO edge_receipts_v1 (world_id, receipt_id, soul_id, capability, phase, accepted_tick, created_at) VALUES (?,?,?,?,?,?,?)').run(f.host.worldId, 'r_open', soulId, 'walk:commons', 'waiting', f.host.engine.world.tick, Date.now());   // an act it was still waiting on
  const [x, , z] = ents()[ada].pose.p; ents()[ada].pose.p = [x, 0.24, z];
  await accept<unknown>(f.host, f.host.enableStandHeightV2('test'));
  assert.deepEqual(delivered, [[soulId, STOOD_ON_FLOOR.code]], 'the notice reached its stream');
  const r = edge.receipt(soulId, 'r_open')!;
  assert.deepEqual([r.phase, r.code], ['failed', STOOD_ON_FLOOR.code], 'its open act ended by name');
});
