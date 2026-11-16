import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture, invite, accept, factory} from '../../apps/server/test/native-owner-fixture.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';

// #1217: a tea act's receipt says `completed` only if its change was made (as #1214 for harvest). Ana is sent to put on a
// full, cold kettle on a counter in front of her.
const ENDED = ['completed', 'failed', 'cancelled', 'replaced'];
async function kitchen(t, walls = () => []) {
 const f = fixture(':memory:', factory, {durableClockV1: true}); f.brain.quiesce();
 const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false}), app = new Hono(); let soul;
 const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => soul});
 t.after(() => { comms.close(); f.host.stop(); f.db.close(); });
 const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
 installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
 const tick = async (n = 5) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); } };
 await tick();
 await invite(f, 'ana'); const row = await accept(f.host, f.souls.create('dev:ana', {name: 'Ana', description: 'Tea test'})); await tick();
 soul = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: 'dev:ana'};
 const at = f.host.engine.world.entities[soul.entityId].pose.p, [ax, az] = [at[0], at[2]];
 const sc = god.act({ops: [...walls(ax, az),
  {op: 'place', def: 'core/counter@1', name: 'counter', p: [ax, az - 2.4]},
  {op: 'place', def: 'core/kettle@3', name: 'kettle', in: {parent: 'counter', slot: 'top'}, p: [0.3, 0.1], r: Math.PI / 2, state: {level: 1, heatTick: -1}}]});
 assert.equal(sc.accepted, true, JSON.stringify(sc.failures?.slice(0, 3))); await tick(45);
 const kettle = [...god.model.entities.values()].find(e => e.name === 'kettle').id, heatTick = () => god.model.entities.get(kettle).state?.heatTick ?? -1;
 const boil = async () => {
  const r = await (await accept(f.host, app.request('/v1/edge/act', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({capability: `object:${kettle}:boil`})}))).json();
  assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 300)); return () => edge.receipt(soul.soulId, r.receipt.id);
 };
 const end = async (receipt) => { for (let n = 0; n < 4000 && !ENDED.includes(receipt().phase); n++) await tick(1); const e = receipt(); assert.ok(ENDED.includes(e.phase), 'the act ended: ' + JSON.stringify(e).slice(0, 300)); return e; };
 return {f, god, tick, kettle, heatTick, boil, end};
}

// The counter is 1.7 m away but round a wall: in a pen open to the east, beside Ana's pen open to the west (about 90 m of
// walking). The faculty used to watch a body for only a minute before its first motion, so the press went unwatched.
const pens = (ax, az) => [
 {op: 'place', def: 'core/garden-wall@1', name: 'counter-pen', shape: {path: [[ax + 20, az - 5], [ax - 20, az - 5], [ax - 20, az - 0.8], [ax + 20, az - 0.8]]}},
 {op: 'place', def: 'core/garden-wall@1', name: 'ana-pen', shape: {path: [[ax - 20, az + 1.6], [ax + 20, az + 1.6], [ax + 20, az - 0.45]]}}];
test('a tea act whose hand arrives more than a minute after it began still switches the kettle on', {timeout: 300000}, async t => {
 const k = await kitchen(t, pens);
 const e = await k.end(await k.boil());
 assert.ok(e.endedTick - e.acceptedTick > 1200, 'the switch was reached more than a minute after the act began: ' + (e.endedTick - e.acceptedTick));
 assert.equal(e.phase, 'completed', JSON.stringify(e).slice(0, 300));
 assert.ok(k.heatTick() > e.acceptedTick + 1200, 'the kettle was switched on, at the press: ' + k.heatTick());
 assert.deepEqual(k.f.host.engine.runtime.violations, []);
});

test('the kettle is put on by someone else before the hand reaches it: failed by name, not completed', {timeout: 300000}, async t => {
 const k = await kitchen(t);
 const receipt = await k.boil(); await k.tick(4);
 const on = k.f.host.engine.world.tick;
 assert.equal(k.god.act({ops: [{op: 'set', id: k.kettle, state: {heatTick: on}}]}).accepted, true);
 const e = await k.end(receipt);
 assert.equal(e.phase, 'failed', JSON.stringify(e).slice(0, 300));
 assert.equal(e.code, 'contact.not-applied');
 assert.match(e.reason, /the kettle was not switched on: .*kettle was already on when your hand reached the switch/);
 assert.equal(k.heatTick(), on, 'the kettle heats from when it was put on, once');
});
