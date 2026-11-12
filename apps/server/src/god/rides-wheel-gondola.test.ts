// #2198 (maintainer smoke test, 12 Nov 2026): on Eden 2026's big wheel the Soul rode a car the viewer drew metres in front
// of the wheel, hanging in the air, instead of one of the wheel's own gondolas. The ride's route now goes round on the
// gondolas' floor circle, in the wheel's own plane, starting in its bottom gondola, whatever the wheel's pose.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Db } from '../db.ts';
import { GodMode } from './god.ts';
import { installGodRides, wheelCars } from './rides.ts';
import { routePosition } from '../../../../mars/viewer/engine/vehicles/carrier.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
const spec = JSON.parse(readFileSync(new URL('../../../../worlds/patches/eden-2026-landmarks-20261019/spec-wheel.json', import.meta.url), 'utf8'));
const bigWheel = spec.items.find((i: any) => i.kind === 'define' && i.name === 'eden-big-wheel').new;
// the def's own numbers (worlds/patches/eden-2026-landmarks-20261019/build.mjs): hub 15.4 m up, gondolas hung 13 m out,
// each cabin's floor 1.575 m under its hanger
const HUB = 15.4, R = 13, DROP = 1.575;

function ride(p: [number, number], r: number) {
  const db = new Db(':memory:');
  const god = new GodMode(db, { worldId: 'wheel-test', ownerId: null, tick: () => 0, emit: () => {} } as any);
  const res: any = god.act({ ops: [{ op: 'define', def: bigWheel }, { op: 'place', def: 'eden-big-wheel@1', name: 'resort-ferris-wheel', p, r }] }, 'wheel');
  assert.equal(res.accepted, true, JSON.stringify(res.failures));
  const e = god.model.get('resort-ferris-wheel')!, wp = god.model.worldPose(e), ground = god.model.terrain.sample(wp.x, wp.z);
  const rides = installGodRides({ host: { listeners: [] } as any, edge: {} as any, model: god.model });
  const want = rides.wanted().find((w) => w.id === 'resort-ferris-wheel')!;
  rides.close(); db.close();
  // world → the wheel's own frame (x across, y up from its ground, z out of its front)
  const c = Math.cos(wp.yaw), s = Math.sin(wp.yaw);
  const local = (q: readonly number[]) => { const dx = (q[0] - wp.x) / wp.s, dz = (q[2] - wp.z) / wp.s; return [dx * c - dz * s, (q[1] - ground) / wp.s, dx * s + dz * c]; };
  return { want, local };
}

test('wheelCars reads the big wheel\'s hub, gondola circle and cabin floor', () => {
  const cars = wheelCars(bigWheel)!;
  assert.ok(cars, 'the big wheel has gondolas');
  assert.deepEqual(cars.hub, [0, HUB]);
  assert.ok(Math.abs(cars.R - R) < 0.01 && Math.abs(cars.drop - DROP) < 0.01 && Math.abs(cars.z) < 1e-9, JSON.stringify(cars));
  assert.ok(Math.abs(cars.bottom + Math.PI / 2) < 1e-3, 'the bottom gondola hangs straight under the hub');
  assert.equal(wheelCars({ make: { kind: 'gen', args: { shapes: [{ kind: 'sphere', at: [0, 1, 0], role: 'wheel', pivot: [0, 1, 0] }] } } }), null, 'no gondolas, no cars');
});

for (const [p, r] of [[[184, 124], 0], [[40, -30], 0.9]] as const) test(`the ride goes round in the wheel's own gondolas, not in front of it (yaw ${r})`, () => {
  const { want, local } = ride([...p], r);
  assert.ok(want?.routeKeys, 'the wheel has a ride');
  const keys = want.routeKeys!, home = local(keys[0].p), start = keys.findIndex((k) => k.t === 6), end = keys.findIndex((k) => k.t === 81);
  assert.ok(home[2] > 3, `riders still wait on the ground in front of the wheel: ${home}`);
  assert.ok(start > 0 && end > start, 'boarding at 6 s, back at the bottom at 81 s');
  // the whole turn, every tick: on the gondolas' floor circle (centre hub - drop, radius R) and in the wheel's plane
  const route = { id: want.route, keys };
  let worst = 0, depth = 0, high = -Infinity;
  for (let tick = 6 * 20; tick <= 81 * 20; tick++) {
    const q = local(routePosition(route, tick)), d = Math.hypot(q[0], q[1] - (HUB - DROP)) - R;
    worst = Math.max(worst, Math.abs(d)); depth = Math.max(depth, Math.abs(q[2])); high = Math.max(high, q[1]);
  }
  assert.ok(worst < 0.05, `on the gondolas' floor circle within 5 cm (was ${worst.toFixed(3)} m off)`);
  assert.ok(depth < 0.2, `inside the gondola's 1.35 m depth, in the wheel's plane (was ${depth.toFixed(3)} m out of it)`);
  assert.ok(Math.abs(high - (HUB + R - DROP)) < 0.05, `over the top in the top gondola (${high.toFixed(2)} m)`);
  const board = local(keys[start].p);
  assert.ok(Math.hypot(board[0], board[1] - (HUB - R - DROP), board[2]) < 0.02, `boards in the bottom gondola: ${board}`);
});
