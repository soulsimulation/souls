import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture, invite, accept, factory} from '../../apps/server/test/native-owner-fixture.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';

// #1216: within 3 m a pick-up is `take_item` alone, so take_item's own approach walk is the walk that has to end. Two Souls
// picking up from one table at once (the layout that found it) deadlocked for good, each receipt `started`; a basket on the
// ground was refused from every distance, its own footprint leaving each stand of the ground ring too tight for a body.
// Both fixes are item-approach/1, a logged runtime policy the world adopts at boot (edge-runtime-rules.ts); history recorded
// before the adoption replays as it ran.
const ENDED = ['completed', 'failed', 'cancelled', 'replaced'];
async function world(t, ops, ben, {path = ':memory:', policy = true} = {}) {
 const f = fixture(path, factory, {durableClockV1: true}); f.brain.quiesce();
 const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false}), app = new Hono(); let soul;
 const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => soul});
 let closed = false; const close = () => { if (closed) return; closed = true; comms.close(); f.host.stop(); f.db.close(); }; t.after(close);
 const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
 installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
 const tick = async (n = 5) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); } };
 await tick();
 if (policy) await accept(f.host, f.host.enableItemApproachV1());
 const join = async (k, name) => { await invite(f, k); const row = await accept(f.host, f.souls.create('dev:' + k, {name, description: 'Pick-up test'})); await tick(); return {soulId: row.id, entityId: row.entity_id}; };
 const ana = await join('ana', 'Ana'), b = ben ? await join('ben', 'Ben') : null;
 const W = () => f.host.engine.world, at = W().entities[ana.entityId].pose.p, [ax, az] = [at[0], at[2]];
 if (b) { await accept(f.host, f.host.enqueue('edge-relocate', `edge:${b.soulId}`, {soulId: b.soulId, entityId: b.entityId, to: [ax + ben[0], az + ben[1]], why: 'test placement'})); await tick(20); }
 const sc = god.act({ops: ops(ax, az)}); assert.equal(sc.accepted, true, JSON.stringify(sc.failures?.slice(0, 3))); await tick(45);
 const id = n => [...god.model.entities.values()].find(e => e.name === n).id;
 const act = async (s, item) => { soul = s; const r = await (await accept(f.host, app.request('/v1/edge/act', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({capability: `pick-up:${id(item)}`, strict: true})}))).json(); return r.accepted ? {soulId: s.soulId, id: r.receipt.id} : r; };
 const receipt = r => edge.receipt(r.soulId, r.id);
 const end = async (rs, ticks) => { for (let n = 0; n < ticks && !rs.every(r => ENDED.includes(receipt(r)?.phase)); n++) await tick(1); return rs.map(receipt); };
 return {f, ana, ben: b, W, id, act, end, tick, close, receipt};
}

const table = (ax, az) => [
 {op: 'place', def: 'core/table@1', name: 'garden-table', p: [ax + 2.5, az + 1.9]},
 {op: 'place', def: 'core/harvest-basket@1', name: 'basket', in: {parent: 'garden-table', slot: 'top'}, p: [0.15, 0.1]},
 {op: 'place', def: 'core/flower-vase@1', name: 'vase', in: {parent: 'garden-table', slot: 'top'}, p: [-0.15, 0.1]}];

test('two Souls picking up from one table at once both end route.blocked within the blocked-walk limit', {timeout: 120000}, async t => {
 const g = await world(t, table, [3, 0]);
 const a = await g.act(g.ana, 'basket'), b = await g.act(g.ben, 'vase');
 assert.ok(a.id && b.id, JSON.stringify([a, b]).slice(0, 300));
 const rs = await g.end([a, b], 7200);
 // the intended end: both approaches deadlock, each is stopped by the limit, and each receipt names it
 assert.deepEqual(rs.map(r => [r.phase, r.code]), [['failed', 'route.blocked'], ['failed', 'route.blocked']], JSON.stringify(rs).slice(0, 400));
 // the limit counts 1200 ticks of a blocked walk, after the runtime has named the deadlock
 for (const r of rs) assert.ok(r.endedTick - r.acceptedTick < 2400, `ended after ${r.endedTick - r.acceptedTick} ticks`);
 for (const id of [g.id('basket'), g.id('vase')]) assert.equal(g.W().entities[id].support.kind, 'resting-on', 'neither took a thing');
 assert.deepEqual(g.f.host.engine.runtime.violations, []);
});

test('a journal recorded before item-approach/1 replays as it ran; the limit applies from the adoption on', {timeout: 180000}, async t => {
 const dir = mkdtempSync(join(tmpdir(), 'pick-up-approach-')), path = join(dir, 'world.db'); t.after(() => rmSync(dir, {recursive: true, force: true}));
 const g = await world(t, table, [3, 0], {path, policy: false});
 const rs = [await g.act(g.ana, 'basket'), await g.act(g.ben, 'vase')];
 await g.tick(3000);   // the deadlock is named by about 360 ticks: both approaches stay blocked well past the 1200-tick limit
 assert.deepEqual(rs.map(r => g.receipt(r).phase), ['started', 'started'], 'without the policy, the old rules: no limit on the approach');
 const tick = g.W().tick, hash = g.f.host.engine.stateHash();
 g.close();
 const f = fixture(path, factory, {durableClockV1: true}); t.after(() => { f.host.stop(); f.db.close(); });   // boot: snapshot and journal replay
 for (let i = 0; f.host.engine.world.tick < tick && i < 4000; i++) f.host.tickOnce();
 assert.equal(f.host.engine.world.tick, tick);
 assert.equal(f.host.engine.stateHash(), hash, 'the replay of the old journal has the recorded state hash');
 const runtime = f.host.engine.runtime, open = () => [...runtime.records.values()].filter(r => r.verb === 'take_item' && !['completed', 'failed', 'cancelled'].includes(r.status));
 assert.equal(open().length, 2, 'both takes are still in their approach after the replay');
 // adopted now: the old blocked approaches end by the limit on the ticks that follow
 await accept(f.host, f.host.enableItemApproachV1());
 for (let i = 0; open().length && i < 3000; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); }
 assert.equal(open().length, 0, 'after adoption, both approaches end');
 assert.deepEqual([...runtime.records.values()].filter(r => r.verb === 'take_item').map(r => [r.status, r.diagnostic?.code]), [['failed', 'route.blocked'], ['failed', 'route.blocked']]);
});

test('a basket on the ground is picked up from any distance', {timeout: 120000}, async t => {
 for (const d of [1, 1.5, 2.5, 4]) await t.test(`${d} m`, async t => {
  const g = await world(t, (ax, az) => [{op: 'place', def: 'core/harvest-basket@1', name: 'basket', p: [ax + d, az]}]);
  const r = await g.act(g.ana, 'basket'); assert.ok(r.id, JSON.stringify(r).slice(0, 300));
  const [x] = await g.end([r], 3000);
  assert.equal(x.phase, 'completed', JSON.stringify(x).slice(0, 400));
  assert.deepEqual(g.W().entities[g.id('basket')].support, {kind: 'in-hand', by: g.ana.entityId, hand: 'right'});
  assert.deepEqual(g.f.host.engine.runtime.violations, []);
 });
});

test('a thing fenced in on the ground is refused item.unreachable: no hand reaches through the fence', {timeout: 120000}, async t => {
 for (const [def, w] of [['core/harvest-basket@1', 0.3], ['core/harvest-basket@1', 0.35], ['core/apple@1', 0.3], ['core/apple@1', 0.35]]) await t.test(`${def} in a pen ${w} m across from its middle`, async t => {
  const g = await world(t, (ax, az) => { const x = ax + 2.5, z = az;
   return [{op: 'place', def, name: 'thing', p: [x, z]},
    {op: 'place', def: 'core/fence@1', name: 'pen', shape: {path: [[x - w, z - w], [x + w, z - w], [x + w, z + w], [x - w, z + w], [x - w, z - w]]}}]; });
  const r = await g.act(g.ana, 'thing');
  const x = r.id ? (await g.end([r], 3000))[0] : r;
  assert.equal(x.code, 'item.unreachable', JSON.stringify(x).slice(0, 400));
  assert.notEqual(g.W().entities[g.id('thing')].support?.kind, 'in-hand');
 });
});

test('a basket walled in on the ground is refused item.unreachable, never left started', {timeout: 120000}, async t => {
 const g = await world(t, (ax, az) => { const x = ax + 2.5, z = az, w = 0.45;
  return [{op: 'place', def: 'core/harvest-basket@1', name: 'basket', p: [x, z]},
   {op: 'place', def: 'core/garden-wall@1', name: 'pen', shape: {path: [[x - w, z - w], [x + w, z - w], [x + w, z + w], [x - w, z + w], [x - w, z - w]]}}]; });
 const r = await g.act(g.ana, 'basket');
 const x = r.id ? (await g.end([r], 3000))[0] : r;
 assert.notEqual(x.phase, 'started', JSON.stringify(x).slice(0, 300));
 assert.equal(x.code, 'item.unreachable', JSON.stringify(x).slice(0, 400));
});
