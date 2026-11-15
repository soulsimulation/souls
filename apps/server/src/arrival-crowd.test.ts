// A crowd on the arrival point: the native placer's rings hold 91 bodies, and a direct create past that threw (no free
// standing room) inside the tick, which the world could only answer with a fault and a rewind of everything since its last
// snapshot. At 100 Souls on Eden 2026 that replay held the main thread past the watchdog's hang limit and the world was killed.
// A create onto a nearly full arrival point now carries birth-near/1 (no `first`): rings first as before, then free ground.
// A birth that threw before this (live or at boot) left a Soul row with no body and no mind: it is born again.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { marsFactory, GREEN_FIELD_WORLD } from '@souls/engine-mars';
import { fixture, factory } from '../test/native-owner-fixture.ts';
import { EdgeLedger } from './edge/ledger/ledger.ts';
import { GodMode } from './god/god.ts';
import { installEngineBridge } from './god/engine-bridge.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type F = ReturnType<typeof fixture>;
const create = (f: F, i: number) => f.souls.create(`crowd${i}`, { name: `Crowd ${i}`, description: 'arrival crowd fixture' });
const one = async (f: F, i: number) => { const p = create(f, i); f.host.drainInputs(); await p; };
const births = (f: F) => f.db.events(f.host.worldId, 0).filter((e) => e.kind === 'birth' && /^Crowd /.test(e.payload.name));
function allBorn(f: F, n: number) {
  const b = births(f); assert.equal(b.length, n);
  const pos = b.map((e) => { const body = f.host.engine.world.entities[e.payload.entityId]; assert.equal(body?.kind, 'human', `${e.payload.name} has a body`); assert.ok(f.host.minds.has(e.payload.soulId)); return [body!.pose.p[0], body!.pose.p[2]]; });
  for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) assert.ok(Math.hypot(pos[i][0] - pos[j][0], pos[i][1] - pos[j][1]) >= 0.79, `bodies ${i} and ${j} overlap`);
  assert.equal(f.host.rewinds, 0, 'no rewind');
  return b;
}
const arrival = (f: F) => (f.host.engine as any).arrivalCrowdV1(0, Infinity) as [number, number];

test('a hundred direct creates on one arrival point: every Soul is born, no fault, the first ones placed as before', async (t) => {
  const f = fixture(':memory:'); t.after(() => { f.host.stop(); f.db.close(); });
  for (let i = 0; i < 100; i++) await one(f, i);
  const b = allBorn(f, 100);
  assert.ok(b.slice(0, 60).every((e) => !e.payload.near), 'an arrival with room keeps the default placement');
  assert.ok(b.slice(91).every((e) => e.payload.near && !e.payload.near.first), 'a full arrival carries birth-near/1, rings first');
});

function godWorld(t: TestContext) {
  const w = fixture(':memory:', factory, { durableClockV1: true }); w.brain.quiesce();
  const god = new GodMode(w.db, { worldId: w.host.worldId, ownerId: 'owner', tick: () => w.host.engine.world.tick, now: () => 1_000_000, emit() {} });
  const edge = new EdgeLedger(w.host, w.db); installEngineBridge({ host: w.host, god, edge, log() {}, worldClock: false, worldLore: false });
  god.godIdentity(god.mintFor({ id: 'owner', role: 'user' }, 'builder'));
  t.after(() => { w.brain.quiesce(); w.host.stop(); edge.comms?.close(); w.db.close(); });
  return { ...w, god };
}

test('a ring partly built over: the solid counts against the free spots, so a hundred creates are all born', async (t) => {
  const w = godWorld(t); w.host.tickOnce(); await setImmediate(); w.host.drainInputs();
  const [ax, az] = arrival(w), slab = { schema: 'def/1', name: 'slab', version: 1, layer: 'solid', size: { box: [4, 3, 12] }, make: { kind: 'gen', gen: 'kit/2', args: { shapes: [{ kind: 'box', at: [0, 1.5, 0], size: [4, 3, 12] }] } } };
  const r: any = w.god.act({ ops: [{ op: 'define', def: slab }, { op: 'place', def: 'slab@1', name: 'slab', p: [ax + 3.2, az] }] });   // west face 1.2 m east of the arrival point
  assert.equal(r.accepted, true, JSON.stringify(r.failures));
  for (let i = 0; i < 3; i++) { w.host.tickOnce(); await setImmediate(); w.host.drainInputs(); }   // the bridge puts the slab in the engine
  for (let i = 0; i < 100; i++) await one(w, i);
  allBorn(w, 100);
});

test('a burst: 40 creates queued before one drain onto an arrival point holding 60', async (t) => {
  const f = fixture(':memory:'); t.after(() => { f.host.stop(); f.db.close(); });
  for (let i = 0; i < 60; i++) await one(f, i);
  const burst = Array.from({ length: 40 }, (_, k) => create(f, 60 + k)); f.host.drainInputs(); await Promise.all(burst);
  const b = allBorn(f, 100);
  assert.ok(b.slice(60).some((e) => e.payload.near), 'queued births count against the free spots');
});

test('a birth that threw at boot replay is born again: the Soul gets its body and its mind', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'arrival-crowd-')), path = join(dir, 'world.db'), repair = await marsFactory({ ...GREEN_FIELD_WORLD, soulsRepairV1: true });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const f = fixture(path, repair);
  for (let i = 0; i < 91; i++) await one(f, i);   // the 91 ring spots are taken
  // a birth logged before this change: no birth-near/1, so its replay throws (no free standing room)
  const id = 's_unborn00000', entityId = 'h_unborn00000', worldId = f.host.worldId;
  f.db.createSoul({ id, worldId, owner: 'dev:late', entityId, name: 'Crowd late', description: 'arrival crowd fixture', native: false });
  f.db.appendEvent(worldId, { seq: f.host.seq + 1, tick: f.host.engine.world.tick, kind: 'birth', author: `soul:${id}`, payload: { soulId: id, entityId, name: 'Crowd late', description: 'arrival crowd fixture', owner: 'dev:late' }, at: 0 });
  f.host.stop(); f.db.close();
  const g = fixture(path, repair); t.after(() => { g.host.stop(); g.db.close(); });
  assert.equal(g.host.minds.has(id), false); assert.ok(!g.host.engine.world.entities[entityId], 'no body');
  assert.deepEqual([...g.host.unbornV1], [id], 'boot names the Soul whose birth threw');
  assert.equal(g.souls.rebirthUnborn(), 1); g.host.drainInputs(); await setImmediate(); g.host.drainInputs();
  assert.equal((g.host.engine.world.entities as Record<string, any>)[entityId]?.kind, 'human'); assert.ok(g.host.minds.has(id));
  assert.equal(g.host.unbornV1.size, 0); assert.equal(g.souls.rebirthUnborn(), 0, 'once');
  const again = g.db.events(worldId, 0).filter((e) => e.kind === 'birth' && e.payload.soulId === id);
  assert.equal(again.length, 2); assert.ok(again[1].payload.near, 'born again with birth-near/1');
});

test('arrival-clearance/1: every direct create carries the hint, and while the rings have room it lands where it always did', async (t) => {
  const safe = await marsFactory({ ...GREEN_FIELD_WORLD, safeArrivalV1: true }), f = fixture(':memory:', safe), g = fixture(':memory:', safe);
  t.after(() => { for (const w of [f, g]) { w.host.stop(); w.db.close(); } });
  for (let i = 0; i < 12; i++) {
    await one(f, i);
    const p = g.host.enqueue('birth', `soul:x${i}`, { soulId: `s_x${i}`, entityId: `h_x${i}`, name: `Crowd ${i}`, description: 'arrival crowd fixture', owner: 'dev:x' }); g.host.drainInputs(); await p;
  }
  const a = births(f), b = births(g);
  assert.ok(a.every((e) => e.payload.near && !e.payload.near.first));
  assert.deepEqual(a.map((e) => f.host.engine.world.entities[e.payload.entityId]!.pose.p), b.map((e) => g.host.engine.world.entities[e.payload.entityId]!.pose.p));
});
