// nav-connect/1's rescue sweep steps a Soul out of a closed-off pocket with a logged edge-relocate. A Soul treading in deep
// water is not in a pocket: swimming is its way out. On main the sweep judged it cut off from the walkable ground and moved
// it about 6 m ashore in one tick, idle (a teleport). A god's pond; a Soul swims out and treads; the engine's rescue read
// answers nothing for it, and the bridge's sweep after the labelling finishes (as at boot) leaves it where it treads.
import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {accept, factory, fixture, invite} from '../test/native-owner-fixture.ts';
import {EdgeLedger} from './edge/ledger/ledger.ts';
import {GodMode} from './god/god.ts';
import {GroundHost, installGroundCapabilities} from './god/ground-host.ts';
import {installEngineBridge} from './god/engine-bridge.ts';

test('nav-connect/1 never steps a Soul treading in deep water ashore', {timeout: 300000}, async t => {
  const w = fixture(':memory:', factory, {durableClockV1: true}); w.brain.quiesce();
  const god = new GodMode(w.db, {worldId: w.host.worldId, ownerId: 'owner', tick: () => w.host.engine.world.tick, emit() {}});
  new GroundHost(w.db, w.host, god); const edge = new EdgeLedger(w.host, w.db);
  installGroundCapabilities(edge as never, god, w.host); installEngineBridge({host: w.host, god, edge, log() {}, worldClock: false, worldLore: false});
  t.after(() => {w.brain.quiesce(); w.host.stop(); edge.comms?.close(); w.db.close();});
  const tick = async (n: number) => {for (let i = 0; i < n; i++) {w.host.tickOnce(); if (i % 20 === 0) {await setImmediate(); w.host.drainInputs();}}};
  const engine = w.host.engine as unknown as {navWarmV1(ms: number): boolean; navRescueV1(id: string, budgetMs?: number): unknown};
  await tick(4);
  assert.equal((god.act({ops: [{op: 'place', def: 'core/pond@1', name: 'progress-pond', params: {depth: 3}, shape: {area: [[-22, -36], [-10, -36], [-10, -24], [-22, -24]]}}]} as never) as {accepted: boolean}).accepted, true); await tick(4);
  await invite(w, 'bo'); const row = await accept(w.host, w.souls.create('dev:bo', {name: 'bo', description: 'swims'})) as any; await tick(4);
  await accept(w.host, w.host.enqueue('edge-relocate', 'test:bank', {soulId: row.id, entityId: row.entity_id, to: [-4, -30], why: 'bank'})); await tick(4);
  const bo = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner};
  const body = () => (w.host.engine.world.entities as any)[bo.entityId];
  const b = await accept(w.host, Promise.resolve(edge.act(bo as never, {capability: 'swim:progress-pond/middle'} as never))) as any; assert.equal(b.accepted, true, JSON.stringify(b));
  for (let i = 0; i < 4000 && ['waiting', 'started'].includes(edge.receipt(bo.soulId, b.receipt.id)!.phase); i++) await tick(1);
  assert.equal(edge.receipt(bo.soulId, b.receipt.id)!.phase, 'completed'); assert.equal(body().human.activity, 'tread');
  const at = [...body().pose.p];
  assert.equal(engine.navRescueV1(bo.entityId, Infinity), null, 'a treading body is not judged cut off');
  // the labelling finishes now (on main this was the load-dependent boot sweep that stepped Bo ashore); the bridge sweeps
  engine.navWarmV1(Infinity); await tick(40);
  const relocates = (w.db.db.prepare("SELECT payload FROM events WHERE world_id=? AND kind='edge-relocate'").all(w.host.worldId) as {payload: string}[]).filter(r => r.payload.includes('nav-connect'));
  assert.deepEqual(relocates, [], 'no nav-connect relocate was logged');
  const p = body().pose.p; assert.ok(Math.hypot(p[0] - at[0], p[2] - at[2]) < 0.5, `Bo stayed where he treads (${JSON.stringify(at)} -> ${JSON.stringify(p)})`);
  assert.equal(body().human.activity, 'tread');
});
