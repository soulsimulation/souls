// #1288: a repeat answers with the act under way (#1272), so a stuck act has to end by itself. Hello-hamlet, the real act path.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {bootEden} from '../test/eden-capabilities-timing.ts';
import {accept, factory, fixture, invite} from '../test/native-owner-fixture.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {GodMode} from './god/god.ts';
import {GroundHost, installGroundCapabilities} from './god/ground-host.ts';
import {installEngineBridge} from './god/engine-bridge.ts';

const hamlet = new URL('../../../worlds/templates/hello-hamlet.json', import.meta.url);
async function world(t: {after(f: () => void): void}) {
  const w = await bootEden(() => {}, hamlet); t.after(w.close);
  const act = (capability: string) => accept(w.host, Promise.resolve(w.edge.act(w.soul as never, {capability} as never))) as Promise<any>;
  const receipt = (id: string) => w.edge.receipt(w.soul.soulId, id)!;
  /** Hold every walk at pace 0, the shape of a live "walking on the spot" report, until the receipt ends. */
  const stuck = async (id: string) => {
    const execs = () => [...((w.host.engine as any).rt.services.walkExecs?.values() ?? [])] as {speed: number}[];
    for (let i = 0; i < 900 && ['waiting', 'started'].includes(receipt(id).phase); i++) {for (const ex of execs()) ex.speed = 0; await w.settle(1);}
    return receipt(id);
  };
  return {w, act, stuck};
}

test('#1288 W1, W6: a stuck jog ends walk.stuck, and the same jog sent again is a new act', {timeout: 300000}, async t => {
  const {w, act, stuck} = await world(t);
  const jogs = w.edge.capabilitiesPage(w.soul as never, {all: true}).capabilities.filter((c: any) => c.verb === 'jog' && c.available).map((c: any) => c.id);
  const jog = jogs.find((id: string) => /knoll|cottage/.test(id))!; assert.ok(jog, JSON.stringify(jogs));
  const first = await act(jog); assert.equal(first.accepted, true, JSON.stringify(first)); await w.settle(4);
  assert.equal((await act(jog)).repeat, true, 'while it runs, a repeat answers with it');
  const end = await stuck(first.receipt.id);
  assert.equal(end.phase, 'failed', JSON.stringify(end)); assert.equal(end.code, 'walk.stuck');
  const again = await act(jog); assert.equal(again.repeat, undefined); assert.notEqual(again.receipt.id, first.receipt.id);
});

test('#1288 W2: a stuck go-near ends walk.stuck', {timeout: 300000}, async t => {
  const {w, act, stuck} = await world(t);
  await invite(w, 'bob'); const bob = await accept(w.host, w.souls.create('dev:bob', {name: 'Bob', description: 'stands about'})) as {id: string; entity_id: string};
  await accept(w.host, w.host.enqueue('edge-relocate', 'test:put', {soulId: bob.id, entityId: bob.entity_id, to: [20, 20]})); await w.settle(6);
  const first = await act('go-near:' + bob.id); assert.equal(first.accepted, true, JSON.stringify(first));
  const end = await stuck(first.receipt.id);
  assert.equal(end.phase, 'failed', JSON.stringify(end)); assert.equal(end.code, 'walk.stuck');
});

test('#1288 W3, W6: a swim offer held up by a Soul treading in its place ends swim.stuck, and sending it again is a new act', {timeout: 300000}, async t => {
  const w = fixture(':memory:', factory, {durableClockV1: true}); w.brain.quiesce();
  const god = new GodMode(w.db, {worldId: w.host.worldId, ownerId: 'owner', tick: () => w.host.engine.world.tick, emit() {}});
  new GroundHost(w.db, w.host, god); const edge = new EdgeLedger(w.host, w.db);
  installGroundCapabilities(edge as never, god, w.host); installEngineBridge({host: w.host, god, edge, log() {}, worldClock: false, worldLore: false});
  t.after(() => {w.brain.quiesce(); w.host.stop(); edge.comms?.close(); w.db.close();});
  const tick = async (n: number) => {for (let i = 0; i < n; i++) {w.host.tickOnce(); if (i % 20 === 0) {await setImmediate(); w.host.drainInputs();}}};
  await tick(4);
  assert.equal((god.act({ops: [{op: 'place', def: 'core/pond@1', name: 'progress-pond', params: {depth: 3}, shape: {area: [[-22, -36], [-10, -36], [-10, -24], [-22, -24]]}}]} as never) as {accepted: boolean}).accepted, true); await tick(4);
  const soul = async (n: string) => {
    await invite(w, n); const row = await accept(w.host, w.souls.create('dev:' + n, {name: n, description: 'swims'})) as any; await tick(4);
    await accept(w.host, w.host.enqueue('edge-relocate', 'test:bank', {soulId: row.id, entityId: row.entity_id, to: [-4, -30], why: 'bank'})); await tick(4);
    return {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner};
  };
  const bob = await soul('bob'), ann = await soul('ann'), SWIM = 'swim:progress-pond/middle', open = (s: typeof bob, id: string) => ['waiting', 'started'].includes(edge.receipt(s.soulId, id)!.phase);
  const go = (s: typeof bob) => accept(w.host, Promise.resolve(edge.act(s as never, {capability: SWIM} as never))) as Promise<any>;
  const b = await go(bob); assert.equal(b.accepted, true, JSON.stringify(b));
  for (let i = 0; i < 4000 && open(bob, b.receipt.id); i++) await tick(1);
  const a = await go(ann); assert.equal(a.accepted, true, JSON.stringify(a));
  let held: any = null;
  for (let i = 0; i < 4000 && open(ann, a.receipt.id); i++) {if (i === 300) {held = await go(ann); (edge as any).swimsOpen = null;} await tick(1);}   // (null: as after a restart, rebuilt from the open receipts)
  assert.equal(held?.repeat, true, 'while it waits, a repeat answers with it'); assert.equal(held?.receipt.id, a.receipt.id);
  const end = edge.receipt(ann.soulId, a.receipt.id)!, body = (w.host.engine.world.entities as any)[ann.entityId];
  assert.equal(end.phase, 'failed', JSON.stringify(end)); assert.equal(end.code, 'swim.stuck');
  assert.equal(body.human.task, undefined); assert.ok(['tread', 'idle'].includes(body.human.activity), body.human.activity);
  const again = await go(ann); assert.equal(again.accepted, true, JSON.stringify(again)); assert.equal(again.repeat, undefined); assert.notEqual(again.receipt.id, a.receipt.id);
  // W4: held for a while, then he moves off: the swim goes on and arrives
  for (let i = 0; i < 300; i++) await tick(1);
  assert.ok(open(ann, again.receipt.id), 'held');
  await accept(w.host, w.host.enqueue('edge-relocate', 'test:bank', {soulId: bob.soulId, entityId: bob.entityId, to: [-4, -30], why: 'bank'}));
  for (let i = 0; i < 2000 && open(ann, again.receipt.id); i++) await tick(1);
  assert.equal(edge.receipt(ann.soulId, again.receipt.id)!.phase, 'completed');
});
