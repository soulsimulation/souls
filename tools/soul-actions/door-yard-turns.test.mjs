import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {Hono} from '../../apps/server/node_modules/hono/dist/index.js';
import {fixture, invite, accept, factory} from '../../apps/server/test/native-owner-fixture.ts';
import {EdgeLedger} from '../../apps/server/src/edge/ledger/ledger.ts';
import {mountEdgeRoutes} from '../../apps/server/src/edge/routes.ts';
import {GodMode} from '../../apps/server/src/god/god.ts';
import {installEngineBridge} from '../../apps/server/src/god/engine-bridge.ts';

// #1070: a door in a walled yard at any turn. The gap turns solid only at the close's contact, so a close from the far side has
// to end clear of it. A Soul walks in and out through the door (closed behind her both ways), then shuts it by hand from each
// side. Every leg completes or fails by name; nothing recovers a fault, breaks an invariant or jumps. Each turn is a fresh world.
const defs = (process.env.YARD_DEFS ?? 'core/door@3,core/door@2').split(',');
const turns = (process.env.YARD_TURNS ?? '0,0.4,0.571,0.785,1.2,1.571,1.9,2.356,2.9,3.7,4.712,5.5,5.712').split(',').map(Number);
const once = async (ref, r, stubs = [], {more = null, only = null} = {}) => {
 const f = fixture(':memory:', factory, {durableClockV1: true}); f.brain.quiesce();
 const edge = new EdgeLedger(f.host, f.db, undefined, {ambient: false}), app = new Hono(); let soul;
 const comms = mountEdgeRoutes(app, {host: f.host, db: f.db, souls: f.souls, ledger: edge, soul: () => soul});
 try {
  const god = new GodMode(f.db, {worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit() {}});
  installEngineBridge({host: f.host, god, edge, log() {}, worldLore: false, worldClock: false});
  const tick = async (n = 5) => {for (let i = 0; i < n; i++) {f.host.tickOnce(); await setImmediate(); f.host.drainInputs();}};
  await tick(); await invite(f, 'ana'); const row = await accept(f.host, f.souls.create('dev:ana', {name: 'Ana', description: 'Yard test'})); await tick();
  soul = {soulId: row.id, entityId: row.entity_id, name: row.name, owner: 'dev:ana'};
  const body = () => f.host.engine.world.entities[soul.entityId], [ax, az] = [body().pose.p[0], body().pose.p[2]];
  // the door 3 m ahead of her, the yard behind it, all turned about the door by r (local z runs into the yard)
  const c = Math.cos(r), s = Math.sin(r), o = [ax, az + 3], at = (x, z) => [+(o[0] + x * c + z * s).toFixed(3), +(o[1] - x * s + z * c).toFixed(3)];
  const placed = god.act({ops: [
   {op: 'place', def: 'core/garden-wall@1', name: 'walls', shape: {path: [at(-.6, 0), at(-4, 0), at(-4, 6), at(4, 6), at(4, 0), at(.6, 0)]}},
   {op: 'place', def: ref, name: 'door', p: o, r: r + Math.PI},
   {op: 'place', def: 'core/bench@1', name: 'inside-bench', p: at(1.5, 4), r},
   {op: 'place', def: 'core/floor-lamp@1', name: 'outside-lamp', p: at(0, -4)},
   ...stubs.map(([x0, z0, x1, z1], i) => ({op: 'place', def: 'core/garden-wall@1', name: `stub-${i}`, shape: {path: [at(x0, z0), at(x1, z1)]}})),
   ...(more?.(ax, az) ?? []),
  ]});
  assert.equal(placed.accepted, true, JSON.stringify(placed)); await tick(45);
  const moved = [], out = [];
  const leg = async (capability, name) => {
   const a = await (await accept(f.host, app.request('/v1/edge/act', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({capability})}))).json();
   if (!a.accepted) {out.push([name, a.code]); return;}
   let was = [...body().pose.p], rc;
   for (let n = 0; n < 2400; n++) {
    rc = edge.receipt(soul.soulId, a.receipt.id); if (['completed', 'failed', 'cancelled', 'replaced'].includes(rc?.phase)) break;
    await tick(1); if (body().human?.handActuator?.opening?.settle) out.settled = true; moved.push(Math.hypot(body().pose.p[0] - was[0], body().pose.p[2] - was[2])); was = [...body().pose.p];
   }
   out.push([name, rc?.code ?? rc?.phase]); await tick(10);
  };
  if (only) {await leg(only, only); return out;}
  const id = god.model.get('door').id, inside = () => (body().pose.p[0] - o[0]) * s + (body().pose.p[2] - o[1]) * c > 0, shut = () => god.model.get('door').state?.open === false;
  const through = async (name, wantInside) => {await leg(wantInside ? 'walk:inside-bench' : 'walk:outside-lamp', name); if (out.at(-1)[1] === 'completed') {assert.equal(inside(), wantInside, `${ref} r=${r} ${name}: the far side`); if (!stubs.length) assert.ok(shut(), `${ref} r=${r} ${name}: shut behind her`);}};
  await through('in', true); await through('out', false);
  // by hand from each side: the hand opens it, she crosses the open doorway, and it is shut from there
  for (const wantInside of [true, false]) {
   await leg(`object:${id}:open`, 'open');
   await leg(wantInside ? 'walk:inside-bench' : 'walk:outside-lamp', 'cross');
   await leg(`object:${id}:close`, wantInside ? 'close-inside' : 'close-outside');
   if (out.at(-1)[1] === 'completed') {assert.ok(shut(), `${ref} r=${r}: shut by hand`); assert.equal(inside(), wantInside, `${ref} r=${r}: on the side she shut it from`);}
  }
  assert.deepEqual(f.host.engine.runtime.violations, [], `${ref} r=${r}`);
  assert.equal(f.host.glitches.total, 0, `${ref} r=${r}: ${JSON.stringify(f.host.glitches.byRule)}`);
  assert.ok(Math.max(0, ...moved) < 0.2, `${ref} r=${r}: the body never jumps (${Math.max(...moved).toFixed(3)} m in a tick)`);
  return out;
 } finally {comms.close(); f.host.stop(); f.db.close();}
};

test('a door in a yard at every turn: walked through and shut from both sides', {timeout: 1200000}, async t => {
 for (const ref of defs) await t.test(ref, async () => {
  for (const r of turns) {
   const legs = await once(ref, r);
   if (process.env.YARD_LOG) console.log(ref, r, JSON.stringify(legs));
   for (const [name, code] of legs) {
    assert.notEqual(code, 'engine.fault-recovered', `${ref} r=${r} ${name}`);
    assert.ok(code === 'completed' || /^(contact|object|hand_actuator_v1|walk|place|capability)\.[a-z-]+$/.test(code ?? ''), `${ref} r=${r} ${name}: ${code}`);
   }
   assert.equal(legs.filter(([, c]) => c !== 'completed').length, 0, `${ref} r=${r}: ${JSON.stringify(legs)}`);
  }
 });
});

test('a wall just behind where a close would end: refused by name', {timeout: 120000}, async () => {
 const stubs = JSON.parse(process.env.YARD_STUBS ?? '[[-1.5,-0.75,1.5,-0.75]]'), legs = await once('core/door@3', 0.571, stubs);
 if (process.env.YARD_LOG) console.log('STUB', JSON.stringify(legs));
 assert.deepEqual(legs.filter(([n]) => n === 'close-outside'), [['close-outside', 'contact.no-room']]);
});

test('a walk whose close would have no room is refused by name', {timeout: 120000}, async () => {
 const legs = await once('core/door@3', 3.7, [[-1.01, -0.59, -0.34, -0.59], [-1.98, -0.97, -0.6, -0.97]]);
 assert.deepEqual(legs[1], ['out', 'contact.no-room']);
});

test('a close that ends clear carries nothing new, one that would not eases clear', {timeout: 120000}, async () => {
 // at 4.712 a close ends at exactly the limit, which is legal
 assert.equal((await once('core/door@3', 4.712)).settled, undefined);
 assert.equal((await once('core/door@3', 0.571)).settled, true);
});

test('a close whose end is too near a standing wall, not only the gap, eases clear or is refused', {timeout: 120000}, async () => {
 const legs = await once('core/door@3', 4.712, [[-0.73, 0.38, -0.17, 0.9]]);
 for (const [name, code] of legs) assert.notEqual(code, 'engine.fault-recovered', name);
});

test('a door beside the way, with no room to shut it, does not answer for the walk', {timeout: 120000}, async () => {
 // the store's locked door is the way; this yard's door borders the search and has a wall behind it
 const more = (ax, az) => {const at = (x, z) => [ax + 14 + x, az + 3 + z]; return [
  {op: 'place', def: 'core/garden-wall@1', name: 'store-walls', shape: {path: [at(-.6, 0), at(-4, 0), at(-4, 6), at(4, 6), at(4, 0), at(.6, 0)]}},
  {op: 'place', def: 'core/door@3', name: 'store-door', p: at(0, 0), r: Math.PI, state: {locked: true}},
  {op: 'place', def: 'core/bench@1', name: 'store-bench', p: at(-2.5, 1.5)}];};
 const legs = await once('core/door@3', 0.571, [[0, 0.8, 1.2, 0.8]], {more, only: 'walk:store-bench'});
 assert.deepEqual(legs, [['walk:store-bench', 'door.locked']]);
});

test('a sidestep still held when the gap turns solid fails by name, never a fault', {timeout: 120000}, async () => {
 for (const [r, stubs] of [[0.4, [[-1, 0.62, -0.3, 0.62]]], [0.571, [[-1, 0.62, -0.3, 0.62]]], [0.4, [[-1.1, 0.62, -0.4, 0.62]]]]) {
  const legs = await once('core/door@3', r, stubs);
  for (const [name, code] of legs) assert.notEqual(code, 'engine.fault-recovered', `r=${r} ${name}`);
  assert.ok(legs.some(([, code]) => code === 'contact.step-blocked'), `r=${r}: ${JSON.stringify(legs)}`);
 }
});
