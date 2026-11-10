// #1751 on a native world with the object framework: a hand-worked thing far away is out of the whole menu (as before),
// its act sent by id is accepted and its plan walks there, and one in a secret place this Soul has not found stays unknown.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from 'hono';
import {coreRef} from '@souls/world-compiler';
import {fixture, factory, invite, accept} from '../../test/native-owner-fixture.ts';
import {EdgeLedger} from '../edge/ledger/ledger.ts';
import {GodMode} from './god.ts';
import {GroundHost, installGroundCapabilities} from './ground-host.ts';
import {installEngineBridge} from './engine-bridge.ts';
import {registerEdgeComms} from '../edge/comms/index.ts';
import {edgeSoulResolver} from '../edge/routes.ts';
import type {EdgeSoul} from '../edge/contract.ts';

test('a far hand-worked thing: left out of the whole menu, taken by id with a walk, unknown in a secret place', {timeout: 300_000}, async t => {
  const f = fixture(':memory:', factory, {durableClockV1: true}); f.brain.quiesce();
  const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}}), edge = new EdgeLedger(f.host, f.db);
  new GroundHost(f.db, f.host, god); installGroundCapabilities(edge, god, f.host);
  const bridge = installEngineBridge({host: f.host, god, edge, log() {}, worldClock: false, worldLore: true});
  const comms = registerEdgeComms(new Hono(), {host: f.host, db: f.db, souls: f.souls, soul: edgeSoulResolver(f.host, f.souls, () => undefined), ledger: edge}, {sweepMs: 0, fetch: null}); edge.attachComms(comms as never);
  t.after(() => {comms.close(); f.brain.quiesce(); f.host.stop(); f.db.close();});
  const tick = async (n = 4) => {for (let i = 0; i < n; i++) {f.host.tickOnce(); if (i % 20 === 0) {await setImmediate(); f.host.drainInputs();}}};
  await tick();
  const built = god.act({ops: [
    {op: 'place', def: coreRef('zone'), name: 'field', shape: {area: [[-30, -30], [30, -30], [30, 30], [-30, 30]]}, params: {use: 'park'}},
    {op: 'place', def: coreRef('desk-lamp'), name: 'near-lamp', p: [4, 2]},
    {op: 'place', def: coreRef('desk-lamp'), name: 'far-lamp', p: [90, 0]},
    {op: 'place', def: coreRef('zone'), name: 'hollow', shape: {area: [[-100, 80], [-80, 80], [-80, 100], [-100, 100]]}, params: {use: 'park'}},
    {op: 'place', def: coreRef('desk-lamp'), name: 'hidden-lamp', p: [-90, 90]},
    {op: 'place', def: coreRef('chest'), name: 'far-chest', p: [0, 70]},
    {op: 'place', def: coreRef('chest'), name: 'kept-chest', p: [0, -10]},
  ]} as never);
  assert.equal(built.accepted, true, JSON.stringify(built)); await tick(8);
  await invite(f, 'ana'); const row = await accept(f.host, f.souls.create('dev:ana', {name: 'Ana', description: 'M5 far hand acts'}));
  const soul: EdgeSoul = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner}; await tick(4); bridge.perceive.sync(true); edge.map();
  const id = (name: string) => god.model.get(name)!.id, near = id('near-lamp'), far = id('far-lamp'), hidden = id('hidden-lamp');
  const verb = (thing: string) => (god.model.entities.get(thing)!.state?.on ?? true) ? 'switch-off' : 'switch-on';
  const me = f.host.engine.world.entities[soul.entityId]!.pose.p;
  assert.ok(Math.hypot(90 - me[0]!, 0 - me[2]!) > 40, 'the far lamp is beyond the old 30 m sight');

  edge.invalidateBodies(); const whole = edge.coreA.binds(soul).caps;
  assert.ok(whole.some(c => c.id === `object:${near}:${verb(near)}`), 'a near lamp is in the whole menu');
  assert.equal(whole.some(c => c.object === far), false, 'a far lamp is not: whole menus are as before');

  // (an act's answer waits on the world's clock: tick while it is decided)
  // (as POST /v1/edge/act with strict: true, what the client sends: the offer gate first, then the act)
  const act = async (capability: string) => {const no = edge.offerGate(soul, {capability}); if (no) return no; let done = false; const p = edge.act(soul, {capability}).finally(() => {done = true;}); for (let i = 0; i < 400 && !done; i++) await tick(1); return p;};
  const out = await act(`object:${far}:${verb(far)}`);
  assert.equal(out.accepted, true, JSON.stringify(out));
  await tick(40);
  const body = f.host.engine.world.entities[soul.entityId]!.pose.p;
  assert.ok(Math.hypot(body[0]! - me[0]!, body[2]! - me[2]!) > 0.5, 'the body is on its way to the far lamp');

  // a thing that is not worked by a hand contact (a chest): from beyond sight, its change waits for the body to arrive
  const chest = id('far-chest'), open = () => god.model.entities.get(chest)!.state?.open === true, pos = () => f.host.engine.world.entities[soul.entityId]!.pose.p;
  assert.equal(open(), false);
  const went = await act(`object:${chest}:open`);
  assert.equal(went.accepted, true, JSON.stringify(went).slice(0, 300));
  await tick(20);
  assert.equal(open(), false, 'not open while the body is still far away');
  assert.ok(Math.hypot(pos()[0]!, pos()[2]! - 70) > 30, 'the body is still far from the chest');
  for (let i = 0; i < 200 && !open(); i++) await tick(20);
  assert.equal(open(), true, 'open once the body is there');
  assert.ok(Math.hypot(pos()[0]!, pos()[2]! - 70) < 3, 'opened by a body standing at the chest');

  // a far thing made private while the body walks to it: refused on arrival with the near act's named refusal; it stays shut
  const kept = id('kept-chest'), keptOpen = () => god.model.entities.get(kept)!.state?.open === true;
  const going = await act(`object:${kept}:open`) as {accepted: boolean; receipt?: {id: string}};
  assert.equal(going.accepted, true, JSON.stringify(going).slice(0, 300));
  await tick(20);
  assert.ok(Math.hypot(pos()[0]!, pos()[2]! + 10) > 30, 'the body is still far from the second chest');
  const shut = god.act({ops: [{op: 'set', id: kept, owner: 'soul:Other', access: 'private'}]} as never); assert.equal(shut.accepted, true, JSON.stringify(shut));
  const receipt = () => edge.receipt(soul.soulId, going.receipt!.id)!;
  for (let i = 0; i < 200 && ['waiting', 'started'].includes(receipt().phase); i++) await tick(20);
  assert.equal(receipt().phase, 'failed', JSON.stringify(receipt()).slice(0, 300));
  assert.equal(receipt().code, 'object.private', 'the same refusal a near act gets');
  assert.equal(keptOpen(), false, 'nothing changed');

  // a thing made a moment ago, before the world's own catch-up has given it an object: taken by id at once
  const made = god.act({ops: [{op: 'place', def: coreRef('desk-lamp'), name: 'new-lamp', p: [-60, -10]}]} as never); assert.equal(made.accepted, true);
  const fresh = id('new-lamp'), cold = await act(`object:${fresh}:${verb(fresh)}`);
  assert.equal(cold.accepted, true, JSON.stringify(cold).slice(0, 300));
  assert.equal(edge.knowledge.setSecret('g-hollow', true), true); await tick(4); bridge.perceive.sync(true);
  const no = await act(`object:${hidden}:${verb(hidden)}`);
  assert.equal(no.accepted, false, JSON.stringify(no).slice(0, 300));
  assert.equal(JSON.stringify(no).includes('hidden-lamp'), false, 'a secret place\'s thing is not named');
});
