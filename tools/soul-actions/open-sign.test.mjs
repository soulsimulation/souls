import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture, invite, accept, factory} from '../../apps/server/test/native-owner-fixture.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';
import {WorldModel} from '../../packages/world-compiler/src/model.ts';

// #427: an Open / Closed sign turned by hand at the knob on its post, by plain words; the state changes only at contact.
test('open sign: words, contact, what is read nearby, refusals, long tail', {timeout: 240000}, async t => {
 const f = fixture(':memory:', factory, {durableClockV1: true}); f.brain.quiesce();
 const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false}), app = new Hono(); let soul;
 const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => soul});
 t.after(() => {comms.close(); f.host.stop(); f.db.close();});
 const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
 installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
 const tick = async (n = 5) => {for (let i = 0; i < n; i++) {f.host.tickOnce(); await setImmediate(); f.host.drainInputs();}};
 await tick(); const make = async name => {await invite(f, name); const row = await accept(f.host, f.souls.create('dev:' + name, {name, description: 'Sign test'})); await tick(); return {soulId: row.id, entityId: row.entity_id, name: row.name, owner: 'dev:' + name};};
 const ana = await make('ana'), ben = await make('ben'); soul = ana;
 const post = (path, body) => accept(f.host, app.request(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})).then(r => r.json());
 const here = async () => (await (await app.request('/v1/edge/here?include=doHere')).json()).here;
 const finish = async r => {let rc; for (let n = 0; n < 1600; n++) {rc = edge.receipt(soul.soulId, r.receipt.id); if (['completed', 'failed', 'cancelled', 'replaced'].includes(rc?.phase)) break; await tick(1);} return rc;};
 const absent = JSON.stringify(await here()).length;
 const p = f.host.engine.world.entities[ana.entityId].pose.p;
 // 100 signs far off change nothing
 {const r = god.act({ops: Array.from({length: 100}, (_, i) => ({op: 'place', def: 'core/open-sign@1', name: `far-${i}`, p: [p[0] + 100 + i % 10 * 2, p[2] + Math.floor(i / 10) * 2]}))}); assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 400));} await tick(45);
 assert.equal(JSON.stringify(await here()).length, absent, 'here is the same with 100 signs far away');
 assert.equal(god.act({ops: [{op: 'place', def: 'core/open-sign@1', name: 'shop-sign', p: [p[0] + 1, p[2] + 2.5]}]}).accepted, true); await tick(45);
 const sign = god.model.get('shop-sign'), id = sign.id, state = () => god.model.get('shop-sign').state?.open;
 const facts = async () => JSON.stringify((await here())).includes('"open":false') ? false : JSON.stringify(await here()).includes('"open":true') ? true : null;
 assert.equal(await facts(), true, 'read nearby');
 // the contact: the state changes at the hand, not before
 const close = await post('/v1/edge/act', {capability: `object:${id}:close`, strict: true}); assert.equal(close.accepted, true, JSON.stringify(close));
 await tick(2); assert.notEqual(state(), false, 'not before contact');
 assert.equal((await finish(close)).phase, 'completed'); assert.equal(state(), false);
 assert.equal(await facts(), false, 'the fact follows the sign');
 assert.equal(WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())), undefined, god.model.library).get('shop-sign').state.open, false, 'it survives a restore');
 // refused: already closed
 const again = await post('/v1/edge/act', {capability: `object:${id}:close`, strict: true}); assert.equal(again.accepted, false); assert.equal(again.code, 'object.state');
 const open = await post('/v1/edge/act', {capability: `object:${id}:open`, strict: true}); assert.equal((await finish(open)).phase, 'completed'); assert.equal(state(), true);
 // interrupted before contact: as it was
 const body = () => f.host.engine.world.entities[soul.entityId];
 const cut = await post('/v1/edge/act', {capability: `object:${id}:close`, strict: true}); assert.equal(cut.accepted, true);
 for (let n = 0; n < 400 && !body().human?.handActuator; n++) await tick(1);
 await tick(4); await accept(f.host, edge.act(soul, {capability: 'stand:here'})); await tick(60);
 assert.equal(state(), true, 'interrupted before contact, it stays open');
 // private: the owner turns it, nobody else
 assert.equal(god.act({ops: [{op: 'place', def: 'core/open-sign@1', name: 'ben-sign', p: [p[0] - 2, p[2] + 2.5], owner: 'soul:ben', access: 'private'}]}).accepted, true); await tick(45);
 const mine = `object:${god.model.get('ben-sign').id}:close`;
 const denied = await post('/v1/edge/act', {capability: mine}); assert.equal(denied.accepted, false, JSON.stringify(denied).slice(0, 300)); assert.match(denied.code ?? '', /private|owner|access/);
 soul = ben; const own = await post('/v1/edge/act', {capability: mine, strict: true}); assert.equal(own.accepted, true, JSON.stringify(own).slice(0, 300)); assert.equal((await finish(own)).phase, 'completed'); assert.equal(god.model.get('ben-sign').state?.open, false);
 // other words keep their meanings, with a neon sign, a plain sign and a second shop sign about
 soul = ana;
 assert.equal(god.act({ops: [{op: 'place', def: 'core/neon-sign@1', name: 'neon', p: [p[0] + 3, p[2] + 3]}, {op: 'place', def: 'core/sign@1', name: 'welcome-sign', p: [p[0] - 3, p[2] + 1]}]}).accepted, true); await tick(45);
 assert.equal(god.act({ops: [{op: 'place', def: 'core/open-sign@1', name: 'cafe-sign', p: [p[0] + 2, p[2] + 2.5]}]}).accepted, true); await tick(45);
 // a name inside another name is not that name; a sign already there says so; the sign's own label and a trailing please work
 assert.equal(god.act({ops: [{op: 'place', def: 'core/open-sign@1', name: 'workshop-sign', p: [p[0] + 3, p[2] + 1.5]}, {op: 'set', id: 'cafe-sign', state: {open: false}}, {op: 'set', id: 'shop-sign', state: {open: false}}]}).accepted, true); await tick(45);
 const label = await post('/v1/edge/act', {capability: `object:${god.model.get('cafe-sign').id}:open`}); assert.equal(label.accepted, true, JSON.stringify(label).slice(0, 300));
 const kept = await post('/v1/edge/act', {capability: `object:${id}:close`}); assert.equal(kept.accepted, false); assert.equal(kept.code, 'object.state'); assert.equal(god.model.get('workshop-sign').state?.open, true);
});
