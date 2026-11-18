// #1916: walk-to:here {at: [x, z]} on the Eden 2026 template. A Soul sent to the west goal line of the football pitch
// ([36, 112]) ends within 1 m of it, walked by the engine's own walk_to (no second movement path). A point inside a
// site under construction (site.under-construction) or inside another owner's private building (object.private) is
// refused as approach's target and that building's walk are (#2115 review), on a god-built native world.
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { coreRef } from '@souls/world-compiler';
import { fixture, invite, factory } from '../test/native-owner-fixture.ts';
import { EdgeLedger } from './edge/ledger/ledger.ts';
import { GodMode } from './god/god.ts';
import { installEngineBridge } from './god/engine-bridge.ts';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { accept } from '../test/native-owner-fixture.ts';
import { bootEden } from '../test/eden-capabilities-timing.ts';

const NO_EDEN = existsSync(new URL('../../../worlds/templates/eden-2026.json', import.meta.url)) ? false : 'needs worlds/templates/eden-2026.json (lane/engine content)';
type Act = { accepted?: boolean; code?: string; reason?: string; receipt?: { id: string; capability: string } };

test('Eden 2026: walk-to:here [36, 112] ends within 1 m of the west goal line', { timeout: 600_000, skip: NO_EDEN }, async (t) => {
  const w = await bootEden();
  t.after(() => w.close());
  const goal: [number, number] = [36, 112], body = () => w.host.engine.world.entities[w.soul.entityId]!;
  assert.ok(w.edge.capabilities(w.soul).some((c) => c.id === 'walk-to:here'), 'offered');
  const start = body().pose.p;
  assert.ok(Math.hypot(start[0] - goal[0], start[2] - goal[1]) > 5, `starts away from the goal (${start[0]}, ${start[2]})`);
  const out = await accept(w.host, Promise.resolve(w.edge.act(w.soul, { capability: 'walk-to:here', params: { at: goal } }))) as Act;
  assert.equal(out.accepted, true, JSON.stringify(out));
  assert.equal(out.receipt!.capability, 'walk-to:here');
  const tick = w.host.engine.world.tick;
  let phase = 'accepted';
  while (['accepted', 'waiting', 'started'].includes(phase) && w.host.engine.world.tick - tick < 600 * 20) { await w.settle(20); phase = w.edge.receipt(w.soul.soulId, out.receipt!.id)!.phase; }
  assert.equal(phase, 'completed');
  const end = body().pose.p, off = Math.hypot(end[0] - goal[0], end[2] - goal[1]);
  assert.ok(off <= 1, `ended ${off.toFixed(2)} m from [36, 112]`);
  assert.deepEqual(w.host.engine.runtime.violations, []);
});

test('walk-to:here: a point inside a site under construction or another owner\'s private building is refused, and the body stays put', { timeout: 600_000 }, async (t) => {
  const w = fixture(':memory:', factory, { durableClockV1: true }); w.brain.quiesce();
  const god = new GodMode(w.db, { worldId: w.host.worldId, ownerId: 'owner', tick: () => w.host.engine.world.tick, emit: () => {} });
  const edge = new EdgeLedger(w.host, w.db); installEngineBridge({ host: w.host, god, edge, log() {}, worldClock: false, worldLore: false });
  const caller = god.godIdentity(god.mintFor({ id: 'owner', role: 'user' }, 'builder'))!;
  t.after(() => { w.brain.quiesce(); w.host.stop(); edge.comms?.close(); w.db.close(); });
  const settle = async (n = 3) => { for (let i = 0; i < n; i++) { w.host.tickOnce(); await setImmediate(); w.host.drainInputs(); } };
  const built = god.act({ ops: [{ op: 'place', def: coreRef('pavilion'), name: 'church', p: [10, 0] }, { op: 'place', def: coreRef('pavilion'), name: 'private-house', p: [-15, 20], owner: 'soul:SomeoneElse', access: 'private' }] });
  assert.equal(built.accepted, true, JSON.stringify(built)); await settle();
  await invite(w, 'ana'); const row: any = await accept(w.host, w.souls.create('dev:ana', { name: 'Ana', description: 'curious' })); await settle(3);
  const soul = { soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner }, pos = () => { const p = w.host.engine.world.entities[soul.entityId]!.pose.p; return [p[0], p[2]]; };
  const started = god.builds.start({ id: 'church', title: 'Stone church', steps: ['shell', 'roof'], root: 'church', site: { at: [10, 0], size: [14, 12] } }, caller) as { ok?: boolean };
  assert.equal(started.ok, true, JSON.stringify(started)); await settle(1);
  const at = pos(), out = await accept(w.host, Promise.resolve(edge.act(soul, { capability: 'walk-to:here', params: { at: [10, 2.85] } }))) as Act;
  assert.equal(out.accepted, false, JSON.stringify(out)); assert.equal(out.code, 'site.under-construction');
  await settle(20); assert.deepEqual(pos(), at, 'the body never moved');
  // a point inside someone else's private building is refused as the walk to that building is
  const priv = await accept(w.host, Promise.resolve(edge.act(soul, { capability: 'walk-to:here', params: { at: [-15, 20] } }))) as Act;
  assert.equal(priv.accepted, false, JSON.stringify(priv)); assert.equal(priv.code, 'object.private');
  await settle(20); assert.deepEqual(pos(), at, 'the body never moved');
  assert.deepEqual(w.host.engine.runtime.violations, []);
});
