// #2193: a wall, fence or hedge along a path on a hillside blocks walking along its whole length. Its collider was one prism
// at the height of the ground under its centre, so its uphill stretch sank under the ground (out of the body band the walk
// raster reads) and Souls walked through it (Eden 2026's vine rows on the vineyard slope).
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { coreRef } from '@souls/world-compiler';
import { fixture, factory } from '../../test/native-owner-fixture.ts';
import { EdgeLedger } from '../edge/ledger/ledger.ts';
import { GodMode } from './god.ts';
import { installEngineBridge } from './engine-bridge.ts';
import { GroundHost } from './ground-host.ts';
import { slopePieces } from './slope-solids.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Vec2 = [number, number];
function world(t: TestContext) {
  const w = fixture(':memory:', factory, { durableClockV1: true });
  w.brain.quiesce();
  const god = new GodMode(w.db, { worldId: w.host.worldId, ownerId: 'owner', tick: () => w.host.engine.world.tick, emit() {} });
  new GroundHost(w.db, w.host, god);
  const edge = new EdgeLedger(w.host, w.db), bridge = installEngineBridge({ host: w.host, god, edge, log() {}, worldClock: false, worldLore: false });
  t.after(() => { w.brain.quiesce(); w.host.stop(); edge.comms?.close(); w.db.close(); });
  const settle = async (n = 4) => { for (let i = 0; i < n; i++) { w.host.tickOnce(); await setImmediate(); w.host.drainInputs(); } };
  const act = (ops: any[]) => { const r = god.act({ ops }) as any; assert.equal(r.accepted, true, JSON.stringify(r).slice(0, 600)); return r; };
  return { ...w, god, bridge, settle, act, E: w.host.engine as any };
}

for (const def of ['garden-wall', 'fence', 'hedge']) test(`#2193: a ${def} running up a hillside blocks walking along its whole length`, { timeout: 300_000 }, async (t) => {
  const w = world(t); await w.settle(2);
  // a knoll 6 m high; the run goes from its foot to near its top, 30 m long (as Eden's 40 m vine rows on the vineyard slope)
  w.act([{ op: 'place', def: coreRef('knoll'), name: 'knoll', p: [40, 10], params: { height: 6, radius: 30, peak: 1, edge: 8 } }]);
  await w.settle(2);
  w.act([{ op: 'place', def: coreRef(def), name: 'run', shape: { path: [[8, 10], [38, 10]] } }]);
  await w.settle(4);
  const m = w.god.model, rise = m.terrain.sample(36, 10) - m.terrain.sample(10, 10);
  assert.ok(rise > 3, `the run climbs the knoll: ${rise.toFixed(2)} m`);
  // along the run, every metre of it: is a crossing from one side to the other walkable?
  const open: string[] = [];
  for (let x = 12; x <= 34; x += 1) {
    const r = w.E.reachV1({ p: [x, 8.6], level: 0 }, { p: [x, 11.4], level: 0 });
    if (r.ok && r.length < 6) open.push(`x=${x} (${r.length.toFixed(1)} m)`);
  }
  assert.deepEqual(open, [], `walked straight through the ${def}: ${open.join(', ')}`);
});

test('#2193: slopePieces leaves a solid on flat ground alone and cuts one on a slope into pieces that follow it', () => {
  const obb = { c: [0, 0] as Vec2, half: [10, 0.15] as Vec2, yaw: 0 };
  assert.equal(slopePieces(obb, 0, 1.8, () => 2), null, 'flat: unchanged');
  const pieces = slopePieces(obb, 0, 1.8, (x) => 0.2 * x)!;
  assert.equal(pieces.length, 20);
  for (const p of pieces) {
    const g = 0.2 * p.obb.c[0];
    assert.ok(p.y0 <= g && p.y1 >= g + 1.8 - 1e-9, `piece at x=${p.obb.c[0]} spans its ground ${g.toFixed(2)}: ${p.y0}..${p.y1}`);
    assert.ok(p.y1 - p.y0 <= 1.8 + 0.2 + 1e-9, 'no taller than the slope under it needs');
  }
  assert.ok(Math.abs(pieces.reduce((s, p) => s + 2 * p.obb.half[0], 0) - 20) < 0.02, 'the pieces cover its length');
});

// #2193: a cottage flight between two end walls is entered from the side at both ends (19 of Eden 2026's 157 straight
// flights: artists' studios, cliff houses, hillside homes). Its engine link rose along the straight line from the side
// approach to the side arrival, half a metre outside the flight: a Soul climbed through the air beside the stairs and up
// through the floor beside the stairwell. The climb now follows the flight.
test('#2193: a side-entered cottage flight is climbed on the flight, never beside it', { timeout: 300_000 }, async (t) => {
  const w = world(t); await w.settle(2);
  const STUDIO = { w: 7, d: 6.5, floors: 2, floorHeight: 3.4, material: 'plaster', roof: 'shed', style: 'cottage', roofPitch: 32, front: 's', porch: 0, balcony: false, windows: 0.6, wallThickness: 0.22 };
  w.act([{ op: 'place', def: coreRef('cottage'), name: 'studio', p: [20, 0], r: 2.72, params: STUDIO }]);
  await w.settle(4);
  const m = w.god.model, e = m.get('studio')!, def = m.resolvedDef(e.def)!, wp = m.worldPose(e), c = Math.cos(wp.yaw), s = Math.sin(wp.yaw);
  const toWorld = ([x, z]: Vec2): Vec2 => [wp.x + (x * c + z * s) * wp.s, wp.z + (-x * s + z * c) * wp.s];
  const flight = m.bake(def, e.params ?? {}, e.seed ?? 0, e.shape).links!.find((l: any) => l.kind === 'stairs')!;
  const [bottom, top] = [toWorld(flight.path[1]), toWorld(flight.path[2])], u: Vec2 = [top[0] - bottom[0], top[1] - bottom[1]], run = Math.hypot(...u);
  const lateral = (p: Vec2) => Math.abs((p[0] - bottom[0]) * u[1] - (p[1] - bottom[1]) * u[0]) / run;
  assert.ok(lateral(toWorld(flight.path[0])) > flight.width / 2 && lateral(toWorld(flight.path[3])) > flight.width / 2, 'the flight is entered from the side at both ends (the case this covers)');
  const upstairs = w.bridge.nav.things().find((th: any) => th.kind === 'room' && th.ref.startsWith('studio/') && (w.bridge.nav.goal(th, [20, 0])?.level ?? 0) > 0)!;
  const downstairs = w.bridge.nav.things().find((th: any) => th.kind === 'room' && th.ref.startsWith('studio/') && w.bridge.nav.goal(th, [20, 0])?.level === 0)!;
  const start = w.bridge.nav.goal(downstairs, [20, 0])!, goal = w.bridge.nav.goal(upstairs, start.p)!;
  w.E.spawnHuman({ id: 'climber', label: 'Climber', soul: 's_climber', near: { first: true, at: start.p } });
  const body = w.E.world.entities.climber, y0 = body.pose.p[1];
  const adm = w.E.perform({ actor: 'climber', label: 'up', steps: [{ verb: 'mars:walk_to', params: { x: goal.p[0], z: goal.p[1], level: goal.level } }] });
  assert.ok(adm.ok, JSON.stringify(adm));
  const beside: string[] = []; let top_ = y0;
  for (let n = 0; n < 2400 && (body.human.level !== goal.level || body.human.activity !== 'idle'); n++) {
    w.host.tickOnce(); if (n % 20 === 0) { await setImmediate(); w.host.drainInputs(); }
    const p: Vec2 = [body.pose.p[0], body.pose.p[2]], y = body.pose.p[1]; top_ = Math.max(top_, y);
    if (y > y0 + 0.1 && y < y0 + STUDIO.floorHeight - 0.1 && lateral(p) > flight.width / 2) beside.push(`y=${y.toFixed(2)} ${lateral(p).toFixed(2)} m off the flight's axis`);
  }
  assert.equal(body.human.level, goal.level, `climbed to the upper floor (rose to ${top_.toFixed(2)}, at ${body.pose.p})`);
  assert.deepEqual(beside.slice(0, 5), [], `${beside.length} ticks in the air beside the flight`);
});
