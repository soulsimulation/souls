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

// #427: a parasol opened and folded by hand at the crank on its pole, by plain words; open, it shades a Soul under it.
test('parasol: words, contact, shade, refusals, long tail', {timeout: 240000}, async t => {
 const f = fixture(':memory:', factory, {durableClockV1: true}); f.brain.quiesce();
 const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false}), app = new Hono(); let soul;
 const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => soul});
 t.after(() => {comms.close(); f.host.stop(); f.db.close();});
 const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
 installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
 const tick = async (n = 5) => {for (let i = 0; i < n; i++) {f.host.tickOnce(); await setImmediate(); f.host.drainInputs();}};
 await tick(); const make = async name => {await invite(f, name); const row = await accept(f.host, f.souls.create('dev:' + name, {name, description: 'Parasol test'})); await tick(); return {soulId: row.id, entityId: row.entity_id, name: row.name, owner: 'dev:' + name};};
 const ana = await make('ana'), ben = await make('ben'); soul = ana;
 const post = (path, body) => accept(f.host, app.request(path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})).then(r => r.json());
 const here = async () => (await (await app.request('/v1/edge/here?include=doHere')).json()).here;
 const finish = async r => {let rc; for (let n = 0; n < 1600; n++) {rc = edge.receipt(soul.soulId, r.receipt.id); if (['completed', 'failed', 'cancelled', 'replaced'].includes(rc?.phase)) break; await tick(1);} return rc;};
 const absent = JSON.stringify(await here()).length;
 const body = () => f.host.engine.world.entities[soul.entityId], p = body().pose.p;
 // 100 parasols far off change nothing
 {const r = god.act({ops: Array.from({length: 100}, (_, i) => ({op: 'place', def: 'core/parasol@1', name: `far-${i}`, p: [p[0] + 100 + i % 10 * 3, p[2] + Math.floor(i / 10) * 3]}))}); assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 400));} await tick(45);
 assert.equal(JSON.stringify(await here()).length, absent, 'here is the same with 100 parasols far away');
 assert.equal(god.act({ops: [{op: 'place', def: 'core/parasol@1', name: 'garden-parasol', p: [p[0] + 1, p[2] + 3]}]}).accepted, true); await tick(45);
 const id = god.model.get('garden-parasol').id, state = () => god.model.get('garden-parasol').state?.open;
 const row = async () => (await here()).objects.find(o => o.id === id);
 assert.equal((await row())?.state?.open, true, 'read nearby');
 assert.equal((await here()).me.shade, undefined, 'beside it, no shade');
 // only the base and the pole are solid, open or closed: she walks under the canopy
 const solids = () => JSON.stringify(god.model.footprintsOf(id)); const openSolids = solids(); assert.equal(god.model.footprintsOf(id).length, 2, openSolids);
 // words
 for (const [words, cap] of [['close the parasol', 'close'], ['Close the parasol', 'close']]) {const r = await post('/v1/edge/resolve', {capability: words}); assert.equal(r.resolve?.capability ?? r.resolve?.would?.capability, `object:${id}:${cap}`, `${words}: ${JSON.stringify(r).slice(0, 300)}`);}
 // the contact: the state changes at the hand, not before
 const close = await post('/v1/edge/act', {capability: 'close the parasol'}); assert.equal(close.accepted, true, JSON.stringify(close).slice(0, 300));
 for (let n = 0; n < 400 && !body().human?.handActuator; n++) await tick(1);
 assert.ok(body().human?.handActuator, 'the hand comes up'); assert.equal(state(), true, 'not before contact');
 assert.equal((await finish(close)).phase, 'completed'); assert.equal(state(), false);
 assert.equal(solids(), openSolids, 'the same solids closed');
 assert.equal((await row())?.state?.open, false, 'the fact follows the parasol');
 assert.equal((await here()).me.shade, undefined, 'closed, it shades nobody');
 assert.equal(WorldModel.fromSnapshot(JSON.parse(JSON.stringify(god.model.snapshot())), undefined, god.model.library).get('garden-parasol').state.open, false, 'it survives a restore');
 // refused: already closed
 const again = await post('/v1/edge/act', {capability: `object:${id}:close`, strict: true}); assert.equal(again.accepted, false); assert.equal(again.code, 'object.state');
 // open it from where she stands: she is under the canopy now
 const open = await post('/v1/edge/act', {capability: 'open the parasol'}); assert.equal((await finish(open)).phase, 'completed'); assert.equal(state(), true);
 const under = await here(); assert.equal(under.me.shade, god.model.get('garden-parasol').name ?? under.objects.find(o => o.id === id).name, `under it: ${JSON.stringify(under.me).slice(0, 300)}`);
 // night takes the shade away; a clockless world has no night
 const clockTo = day => Object.defineProperty(f.host, 'living', {configurable: true, value: {origin: f.host.engine.world.tick - Math.round(72000 * day), dayTicks: 72000, customs: []}});
 clockTo(0.5); const noon = await here(); clockTo(0.75); const night = await here(); Object.defineProperty(f.host, 'living', {configurable: true, value: undefined});
 assert.deepEqual([noon.light, night.light], ['day', 'night'], 'the clock reads as set'); assert.equal(noon.me.shade, under.me.shade); assert.equal(night.me.shade, undefined, 'no shade at night');
 // indoors a parasol is no shade: the same frame with her and it in one room
 {const {enclosureOf, enclosureAtPoint} = edge; edge.enclosureOf = () => 'room'; edge.enclosureAtPoint = () => 'room'; const inside = await here(); edge.enclosureOf = enclosureOf; edge.enclosureAtPoint = enclosureAtPoint; assert.ok(inside.objects.some(o => o.id === id), 'it is still seen'); assert.equal(inside.me.shade, undefined, 'indoors');}
 // on another level it shades nobody: the same frame with her body a floor up
 {const y = body().pose.p[1]; body().pose.p[1] = y + 3; const above = await here(); body().pose.p[1] = y; assert.equal(above.me.shade, undefined, 'a floor above');}
 // interrupted before contact: as it was
 const cut = await post('/v1/edge/act', {capability: `object:${id}:close`, strict: true}); assert.equal(cut.accepted, true);
 for (let n = 0; n < 400 && !body().human?.handActuator; n++) await tick(1);
 assert.ok(body().human?.handActuator, 'the hand comes up'); await tick(2); assert.equal(state(), true);
 await accept(f.host, edge.act(soul, {capability: 'stand:here'})); await tick(60);
 assert.equal(edge.receipt(soul.soulId, cut.receipt.id)?.phase, 'replaced'); assert.equal(state(), true, 'interrupted before contact, it stays open');
 // stepping out from under it: she walks to another parasol, and the first no longer shades her
 assert.equal(god.act({ops: [{op: 'place', def: 'core/parasol@1', name: 'far-side', p: [p[0] + 8, p[2] + 3], state: {open: false}}]}).accepted, true); await tick(45);
 const farSide = god.model.get('far-side').id, walked = await post('/v1/edge/act', {capability: `object:${farSide}:open`, strict: true}); assert.equal((await finish(walked)).phase, 'completed');
 assert.equal((await here()).me.shade, 'far-side', 'the one she stands under now');
 const shut = await post('/v1/edge/act', {capability: `object:${farSide}:close`, strict: true}); assert.equal((await finish(shut)).phase, 'completed');
 assert.equal((await here()).me.shade, undefined, 'out from under the first, and the second is closed');
 // the edge of the canopy, and things that aren't parasols: a rug under her feet shades nobody
 const at = () => body().pose.p, put = async (dx, name) => {assert.equal(god.act({ops: [{op: 'place', def: 'core/parasol@1', name, p: [at()[0] + dx, at()[2]]}]}).accepted, true); await tick(45); return (await here()).me.shade;};
 assert.equal(await put(-1.45, 'just-beyond'), undefined, 'beyond the rim');
 assert.equal(god.act({ops: [{op: 'remove', id: 'just-beyond'}]}).accepted, true); assert.equal(await put(-1.2, 'just-inside'), 'just-inside', 'inside the rim');
 assert.equal(god.act({ops: [{op: 'remove', id: 'just-inside'}, {op: 'place', def: 'core/rug@1', name: 'rug', p: [at()[0], at()[2]]}]}).accepted, true); await tick(45);
 assert.ok((await here()).objects.some(o => o.name === 'rug' || /rug/.test(o.name ?? '')), 'the rug is listed'); assert.equal((await here()).me.shade, undefined, 'a rug is no parasol');
 // a table beside it on her way: she stands on a clear side and it still works
 const [tx, tz] = [at()[0] + 4, at()[2]]; assert.equal(god.act({ops: [{op: 'place', def: 'core/parasol@1', name: 'table-side', p: [tx, tz]}, {op: 'place', def: 'core/table@1', name: 'garden-table', p: [tx - 0.75, tz]}]}).accepted, true); await tick(45);
 const beside = await post('/v1/edge/act', {capability: `object:${god.model.get('table-side').id}:close`, strict: true}); assert.equal(beside.accepted, true, JSON.stringify(beside).slice(0, 300)); assert.equal((await finish(beside)).phase, 'completed', 'a table across her approach'); assert.equal(god.model.get('table-side').state.open, false);
 // private: the owner works it, nobody else
 assert.equal(god.act({ops: [{op: 'place', def: 'core/parasol@1', name: 'ben-parasol', p: [p[0] - 4, p[2] + 3], owner: 'soul:ben', access: 'private'}]}).accepted, true); await tick(45);
 const mine = `object:${god.model.get('ben-parasol').id}:close`;
 const denied = await post('/v1/edge/act', {capability: mine}); assert.equal(denied.accepted, false, JSON.stringify(denied).slice(0, 300)); assert.match(denied.code ?? '', /private|owner|access/);
 soul = ben; const own = await post('/v1/edge/act', {capability: mine, strict: true}); assert.equal(own.accepted, true, JSON.stringify(own).slice(0, 300)); assert.equal((await finish(own)).phase, 'completed'); assert.equal(god.model.get('ben-parasol').state?.open, false);
});
