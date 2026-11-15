// #2434 A1: an upstairs room door. A two-floor cottage moved by door-fit/2 onto its every-doorway revision
// (core/cottage@3), every door then shut: from the street, one walk to the upstairs bedroom opens the front door, climbs
// the stairs, opens the bedroom door and closes each behind; one walk back out does the same the other way. Reach and the
// connectivity audit agree.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from 'hono';
import {fixture, factory, invite, accept} from '../../test/native-owner-fixture.ts';
import {EdgeLedger} from '../edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../edge/routes.ts';
import {GodMode} from './god.ts';
import {installEngineBridge} from './engine-bridge.ts';
import {fitWorldDoorsV2} from './door-fit.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Vec2 = [number, number];
const AT: Vec2 = [10, 10], PARAMS = {floors: 2};

test('upstairs room behind two closed doors: one walk in and one walk out, every door by hand', {timeout: 400_000}, async t => {
  const w = fixture(':memory:', factory, {durableClockV1: true}); w.brain.quiesce();
  const god = new GodMode(w.db, {worldId: w.host.worldId, ownerId: 'dev:admin', tick: () => w.host.engine.world.tick, emit() {}});
  const edge = new EdgeLedger(w.host, w.db, undefined, {ambient: false});
  installEngineBridge({host: w.host, god, edge, log() {}, worldClock: false, worldLore: false});
  const comms = mountEdgeRoutes(new Hono(), {host: w.host, db: w.db, souls: w.souls, ledger: edge, soul: () => undefined as never});
  t.after(() => {w.brain.quiesce(); w.host.stop(); comms.close(); w.db.close();});
  const tick = async (n = 4) => {for (let i = 0; i < n; i++) {w.host.tickOnce(); await setImmediate(); w.host.drainInputs();}};
  const E = w.host.engine as any;
  const r0: any = god.engineAct([{op: 'place', def: 'core/cottage@1', name: 'house', p: AT, r: 0, params: PARAMS}, {op: 'place', def: 'core/floor-lamp@2', name: 'outside-lamp', p: [AT[0] + 2, AT[1] - 14]}] as any, 'test: a house as it was');
  assert.equal(r0.accepted, true, JSON.stringify(r0).slice(0, 600));
  // door-fit/2 before the first tick, as a boot rule runs before the engine is sent the world (no hand check: no walk graph yet)
  const rep = fitWorldDoorsV2(god, [], () => {});
  assert.equal(rep.buildings, 1, JSON.stringify(rep).slice(0, 600));
  await tick(20);
  const house = [...god.model.entities.values()].find((e: any) => e.name === 'house')!;
  assert.equal(house.def, 'core-cottage@3');
  const doors = () => [...god.model.entities.values()].filter((e: any) => /^house-door-/.test(e.name ?? '')) as any[];
  const base = god.model.worldPose(house).y, up = doors().filter(d => god.model.worldPose(d).y > base + 1);
  assert.equal(doors().length, 5, 'front, two inside and two upstairs: ' + JSON.stringify(rep));
  assert.equal(up.length, 2, 'two upstairs doors');
  assert.ok(up.every(d => d.state.open === true), 'an upstairs door starts open');
  const shut: any = god.act({ops: doors().map(d => ({op: 'set', id: d.id, state: {open: false}}))} as any); assert.equal(shut.accepted, true); await tick(10);
  assert.ok(doors().every(d => d.state.open === false), 'every door stands closed');
  const UP = E.rt.services.spatial.scene.levels.find((l: any) => l.y > 2).id;   // the upstairs floor's level
  const BED: Vec2 = [8.08, 11.005], OUT: Vec2 = [AT[0] + 2, AT[1] - 12];   // the upstairs bedroom, the street
  assert.equal(E.reachV1({p: OUT, level: 0}, {p: BED, level: UP}).ok, true, 'reach: the street to the bedroom through its doors');
  assert.equal(E.reachV1({p: BED, level: UP}, {p: OUT, level: 0}).ok, true, 'reach: and back out');
  assert.equal(E.navCheckV1([{id: 'bed', p: BED, level: UP, tol: 0.6}])[0].ok, true, 'audit: the bedroom is joined to the world');
  await invite(w, 'ana');
  const row: any = await accept(w.host, w.souls.create('dev:ana', {name: 'Ana', description: 'upstairs door test'}));
  const ana = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner}; await tick(3);
  const body = () => E.world.entities[ana.entityId];
  await accept(w.host, w.host.enqueue('edge-relocate', 'test:put', {soulId: ana.soulId, entityId: ana.entityId, to: OUT, why: 'in the street'}));
  await tick(6);
  const finish = async (res: any) => {let e: any; for (let n = 0; n < 6000; n++) {e = edge.receipt(ana.soulId, res.receipt.id); if (['failed', 'completed', 'replaced'].includes(e?.phase)) break; await tick(1);} return e;};
  // an upstairs room is walked to on demand (the listing names the ground floor's rooms)
  const r1: any = await accept(w.host, edge.act(ana, {capability: 'walk:house/bedroom'}));
  assert.equal(r1.accepted, true, JSON.stringify(r1).slice(0, 600));
  assert.match(r1.receipt.reason ?? '', /Through house-door-\d+ and house-door-\d+/, 'one walk through the front door and the bedroom door: ' + r1.receipt.reason);
  const e1 = await finish(r1);
  assert.equal(e1.phase, 'completed', JSON.stringify(e1).slice(0, 600));
  assert.equal(body().human.level, UP, 'upstairs');
  assert.ok(doors().every(d => d.state.open === false), 'each door closed behind');
  const r2: any = await accept(w.host, edge.act(ana, {capability: 'walk:outside-lamp'}));
  assert.equal(r2.accepted, true, JSON.stringify(r2).slice(0, 600));
  assert.match(r2.receipt.reason ?? '', /Through house-door-\d+ and house-door-\d+/, 'and back out the same way: ' + r2.receipt.reason);
  const e2 = await finish(r2);
  assert.equal(e2.phase, 'completed', JSON.stringify(e2).slice(0, 600));
  assert.equal(body().human.level ?? 0, 0, 'on the ground');
  assert.ok(doors().every(d => d.state.open === false), 'each door closed behind');
  assert.deepEqual(E.runtime.violations, []);
});
