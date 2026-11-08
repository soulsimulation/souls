// landing/1 (#1324, #1339): a steered balloon never sets down in or on a building, and its riders never step out into
// one. Real host, god mode, engine bridge and ledger on a god-built world: a cottage (thin wall segments and a floor slab,
// which the coarse solids never held), benches, the balloon, a Soul aboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { coreRef } from '@souls/world-compiler';
import { kernelHash } from '@souls/kernel';
import { fixture, invite, accept, factory } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { WorldHost } from '../world.ts';
import { LAND_CLEAR } from '../../../../mars/viewer/engine/vehicles/carrier.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
// the green field is walkable ground over [-30, 30] in x and z; outside it nothing can stand
const BALLOON = [20, 20], HOUSE = [0, 0];
async function world(t: any, extra: any[] = []) {
  const f = fixture(':memory:', factory, { durableClockV1: true });
  const god = new GodMode(f.db, { worldId: f.host.worldId, ownerId: 'dev:admin', tick: () => f.host.engine.world.tick, emit: () => {} });
  const edge = new EdgeLedger(f.host, f.db);
  const bridge = installEngineBridge({ host: f.host, god, edge, log: () => {}, worldLore: true });
  const { Hono } = await import('hono');
  const { mountEdgeRoutes, edgeSoulResolver } = await import('../edge/routes.ts');
  const app = new Hono(), comms = mountEdgeRoutes(app, { host: f.host, db: f.db, souls: f.souls, soul: edgeSoulResolver(f.host, f.souls, () => undefined), ledger: edge } as never);
  const settle = async (n = 4) => { for (let i = 0; i < n; i++) { f.host.tickOnce(); await setImmediate(); f.host.drainInputs(); } };
  f.brain.quiesce();
  t.after(() => { comms.close(); f.brain.quiesce(); f.host.stop(); f.db.close(); });
  await settle(2);
  const r: any = god.act({ ops: [
    { op: 'place', def: coreRef('balloon'), name: 'sky-balloon', p: BALLOON },
    { op: 'place', def: coreRef('cottage'), name: 'rose-house', p: HOUSE },
    { op: 'place', def: coreRef('bench'), name: 'bench-a', p: [0, 8] }, { op: 'place', def: coreRef('bench'), name: 'bench-b', p: [8, -6] }, ...extra] }, 'set the scene');
  assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 800));
  await settle(3);
  await invite(f, 'ana');
  const row: any = await accept(f.host, f.souls.create('dev:ana', { name: 'Ana', description: 'a rider' }));
  const ana = { soulId: row.id, entityId: row.entity_id, name: row.name, owner: row.owner };
  for (let i = 0; i < 60; i++) await settle(1);
  const E = f.host.engine as any, W = () => E.world, body = () => W().entities[ana.entityId], car = () => W().entities['sky-balloon'];
  const act = async (capability: string, params: Record<string, unknown> = {}) => (await accept(f.host, edge.act(ana, { capability, params }))) as any;
  /** Tick until `until` (or n ticks), failing on any violation; `each` sees every tick. */
  const run = async (n: number, until: () => boolean, each?: () => void) => {
    for (let i = 0; i < n; i++) {
      f.host.tickOnce(); each?.();
      if (i % 20 === 0) { await setImmediate(); f.host.drainInputs(); }
      assert.deepEqual(E.runtime.violations, [], 'no violation at tick ' + W().tick);
      if (until()) return true;
    }
    return until();
  };
  const board = async () => {
    const join = edge.capabilities(ana).find((c: any) => c.id === 'object:ride-sky-balloon:join');
    assert.ok(join?.available, 'join offered');
    const a = await act(join!.id); assert.equal(a.accepted, true, JSON.stringify(a).slice(0, 400));
    assert.ok(await run(4000, () => body().human.carrier?.phase === 'seated'), 'seated');
    const st = await act('object:ride-sky-balloon:start'); assert.equal(st.accepted, true, JSON.stringify(st).slice(0, 400));
    assert.ok(await run(1200, () => car().carrier.phase === 'aloft' && car().pose.p[1] > 5), 'lifted off');
  };
  return { f, god, edge, bridge, E, W, body, car, act, run, board, settle, ana };
}
const flat = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[a.length === 2 ? 1 : 2] - b[b.length === 2 ? 1 : 2]);
/** No god-built floor (a building's slab) and no wall within the basket's disc round (x, z). */
function outdoors(E: any, x: number, z: number): boolean {
  const sc = E.rt.services.spatial.staticScene(E.world), own = new Set(sc.own);
  const d = (o: any) => { const c = Math.cos(-o.yaw), s = Math.sin(-o.yaw), lx = (x - o.c[0]) * c - (z - o.c[1]) * s, lz = (x - o.c[0]) * s + (z - o.c[1]) * c; return Math.hypot(Math.max(0, Math.abs(lx) - o.half[0]), Math.max(0, Math.abs(lz) - o.half[1])); };
  return !sc.surfaces.some((s: any) => !own.has(s.id) && d(s.obb) < LAND_CLEAR) && !sc.obstacles.some((o: any) => !String(o.id).startsWith('sky-balloon') && d(o.obb) < LAND_CLEAR - 0.05);
}
async function replayExact(w: any) {
  const f = w.f; f.host.drainInputs(); f.host.saveSnapshot(true);
  const head = { engine: f.host.engine.stateHash(), kernel: kernelHash(f.host.kernel) };
  f.db.db.prepare('DELETE FROM snapshots WHERE world_id=?').run(f.host.worldId);
  const h = new WorldHost(f.db, factory, f.host.seed, 1e9, f.host.worldId, { durableClockV1: true });
  try { assert.equal(h.boot().from, 'genesis'); assert.deepEqual({ engine: h.engine.stateHash(), kernel: kernelHash(h.kernel) }, head, 'replay from genesis exact'); } finally { h.stop(); }
}

test('A2/A6/A8: a steer to land at a cottage lands outside it, says how far, and the rider steps out clear; replay exact', { timeout: 900000 }, async (t) => {
  const w = await world(t);
  await w.board();
  const go = await w.act('object:ride-sky-balloon:steer', { to: 'rose-house', land: true });
  assert.equal(go.accepted, true, JSON.stringify(go).slice(0, 800));
  const landing = go.result?.landing ?? go.receipt?.result?.landing;
  assert.ok(landing, 'result.landing: ' + JSON.stringify(go).slice(0, 800));
  assert.ok(landing.adjustedM > 0, 'moved off the building: ' + JSON.stringify(landing));
  assert.ok(typeof landing.reason === 'string' && landing.reason.length > 0, 'says why');
  assert.ok(outdoors(w.E, landing.at[0], landing.at[1]), 'the chosen spot is outdoors: ' + JSON.stringify(landing));
  assert.ok(flat(landing.requested, HOUSE) < 8, 'aimed at the cottage, not elsewhere: ' + JSON.stringify(landing.requested));
  const sc = w.E.rt.services.spatial.staticScene(w.E.world), own = new Set(sc.own), inBox = (o: any, x: number, z: number) => { const c = Math.cos(-o.yaw), s = Math.sin(-o.yaw), lx = (x - o.c[0]) * c - (z - o.c[1]) * s, lz = (x - o.c[0]) * s + (z - o.c[1]) * c; return Math.abs(lx) <= o.half[0] && Math.abs(lz) <= o.half[1]; };
  assert.ok(!sc.surfaces.some((f: any) => !own.has(f.id) && inBox(f.obb, landing.requested[0], landing.requested[1])), 'aimed at the door outside, not the floor inside: ' + JSON.stringify(landing));
  console.log('[ride-landing] A2 landing', JSON.stringify(landing));
  assert.ok(await w.run(6000, () => w.car().carrier.phase === 'landed'), 'came down: ' + w.car().carrier.phase);
  const at = w.car().pose.p;
  assert.ok(flat(at, landing.at) < 0.01, `landed at the announced spot ${at} vs ${landing.at}`);
  assert.ok(outdoors(w.E, at[0], at[2]), 'landed outdoors');
  assert.ok(await w.run(1200, () => !w.body().human.carrier), 'stepped out');
  const p = w.body().pose.p;
  assert.ok(w.E.clearanceAtV1(p[0], p[2]) >= 0.28, `the rider stands clear: ${w.E.clearanceAtV1(p[0], p[2])}`);
  await replayExact(w);
});

test('A3: a steer with no clear ground within 30 m is refused at acceptance, naming the nearest clear ground', { timeout: 900000 }, async (t) => {
  const w = await world(t);
  await w.board();
  // 90 m west of the basket is past the field's edge (x -30): nothing stands there, and the field's edge is over 30 m away
  const no = await w.act('object:ride-sky-balloon:steer', { direction: 'W', distance: 90, land: true });
  assert.equal(no.accepted, false, JSON.stringify(no).slice(0, 600));
  assert.equal(no.code, 'ride.no-landing-spot', JSON.stringify(no).slice(0, 600));
  assert.match(no.reason, /nearest clear ground is about \d+ m away/, no.reason);
  assert.equal(w.car().carrier.steer, undefined, 'nothing changed');
  // the same place without land is a plain steer (it hovers there); 20 m west lands, on the field
  const ok = await w.act('object:ride-sky-balloon:steer', { direction: 'W', distance: 20, land: true });
  assert.equal(ok.accepted, true, JSON.stringify(ok).slice(0, 600));
});

test('A4/#1339: a god builds on the landing spot (and under the basket) mid-flight: it lands elsewhere, the rider stays aboard', { timeout: 900000 }, async (t) => {
  const w = await world(t);
  await w.board();
  const go = await w.act('object:ride-sky-balloon:steer', { direction: 'S', distance: 20, land: true });
  assert.equal(go.accepted, true, JSON.stringify(go).slice(0, 800));
  const planned = go.result.landing.at;
  assert.ok(await w.run(400, () => !!w.car().carrier.steer?.built), 'flying the steer');
  // #1339: a build right under the basket while it flies low; the rider must stay seated, the basket untouched
  const under = w.car().pose.p;
  const g1: any = w.god.act({ ops: [{ op: 'place', def: coreRef('cottage'), name: 'under-house', p: [Math.round(under[0]), Math.round(under[2])] }] }, 'build under the basket');
  assert.equal(g1.accepted, true, JSON.stringify(g1).slice(0, 400));
  // and a cottage on the landing spot itself
  const g2: any = w.god.act({ ops: [{ op: 'place', def: coreRef('cottage'), name: 'spot-house', p: [Math.round(planned[0]), Math.round(planned[1])] }] }, 'build on the landing spot');
  assert.equal(g2.accepted, true, JSON.stringify(g2).slice(0, 400));
  // #1339: count ticks the basket is in the air without its rider (a god walk-out used to take it out from under the basket)
  let offSeat = 0;
  const seatCheck = () => { if (w.car().carrier.phase === 'aloft' && !w.body().human.carrier) offSeat++; };
  assert.ok(await w.run(8000, () => w.car().carrier.phase === 'landed' || w.car().carrier.phase === 'parked', seatCheck), 'came down: ' + w.car().carrier.phase);
  assert.equal(offSeat, 0, 'the rider never left the basket in the air');
  const at = w.car().pose.p;
  assert.ok(outdoors(w.E, at[0], at[2]), `landed outdoors at ${at}`);
  assert.ok(flat(at, planned) > 1 || flat(at, w.car().carrier.home) < 0.5, 'not on the built spot');
  assert.equal(w.car().carrier.landNote?.code, 'moved', 'the ride moved its landing and says so: ' + JSON.stringify(w.car().carrier.landNote));
  assert.ok(await w.run(1200, () => !w.body().human.carrier), 'stepped out');
  const p = w.body().pose.p;
  assert.ok(w.E.clearanceAtV1(p[0], p[2]) >= 0.28, `the rider stands clear: ${w.E.clearanceAtV1(p[0], p[2])}`);
  await replayExact(w);
});

test('A10 property: seeded steer targets round a cottage and benches never pick a spot in, under or against anything', { timeout: 900000 }, async (t) => {
  const w = await world(t);
  await w.board();
  let seed = 1324; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const actor = w.ana.entityId;
  for (let i = 0; i < 60; i++) {
    const x = HOUSE[0] + (rnd() - 0.5) * 30, z = HOUSE[1] + (rnd() - 0.5) * 30;
    const l = w.E.previewSteerLandingV1({ actor, carrier: 'sky-balloon', x, z, land: true, landing: 'clear/1' });
    const why = w.E.previewMarsVerbV1('carrier_steer', { actor, carrier: 'sky-balloon', x, z, land: true, landing: 'clear/1' });
    assert.equal(!!l, !why, `the act's landing and the engine's verdict agree at (${x.toFixed(1)}, ${z.toFixed(1)}): ${JSON.stringify(why)}`);
    if (!l) continue;
    assert.ok(outdoors(w.E, l.at[0], l.at[2]), `outdoors at (${l.at[0]}, ${l.at[2]}) for (${x.toFixed(1)}, ${z.toFixed(1)})`);
    assert.ok(w.E.clearanceAtV1(l.at[0], l.at[2]) >= LAND_CLEAR, `the raster is clear round (${l.at[0]}, ${l.at[2]})`);
    assert.ok(l.adjustedM <= 30 && Math.abs(Math.hypot(l.at[0] - x, l.at[2] - z) - l.adjustedM) < 0.1, 'the distance it says it moved');
  }
});
