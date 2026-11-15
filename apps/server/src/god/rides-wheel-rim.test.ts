// #1976 (launch video, eden-district): a Soul riding the core ferris wheel went round in a car on a smaller, lower circle
// metres in front of the wheel, attached to nothing. The core wheel has no gondolas (its round pods turn with the rim), so
// the car is now fixed to the rim: its floor goes round the rim circle a set drop under it, concentric with the hub, just in
// front of the wheel's turning parts, once at the wheel's own speed; and the car faces into the wheel whatever its yaw.
import test from 'node:test';
import assert from 'node:assert/strict';
import { coreRef } from '@souls/world-compiler';
import { Db } from '../db.ts';
import { GodMode } from './god.ts';
import { CAR_HALF, RIM_DROP, RIM_GAP, installGodRides, wheelRim } from './rides.ts';
import { routePosition } from '../../../../mars/viewer/engine/vehicles/carrier.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
// the core wheel's own numbers (packages/world-compiler/src/core-kit/authoring/play.mjs): hub 8.6 m up, rim radius 7,
// its round pods (r 0.75) reach 0.75 m out of the wheel's plane
const HUB = 8.6, R = 7, FRONT = 0.75;

function ride(p: [number, number], r: number) {
  const db = new Db(':memory:');
  const god = new GodMode(db, { worldId: 'wheel-rim-test', ownerId: null, tick: () => 0, emit: () => {} } as any);
  const res: any = god.act({ ops: [{ op: 'place', def: coreRef('ferris-wheel'), name: 'region-seaside-resort.ferris-wheel', p, r }] }, 'wheel');
  assert.equal(res.accepted, true, JSON.stringify(res.failures));
  const e = god.model.get('region-seaside-resort.ferris-wheel')!, wp = god.model.worldPose(e), ground = god.model.terrain.sample(wp.x, wp.z);
  const def = god.model.resolvedDef(e.def) as any;
  const rides = installGodRides({ host: { listeners: [] } as any, edge: {} as any, model: god.model });
  const want = rides.wanted().find((w) => w.id === 'region-seaside-resort.ferris-wheel')!;
  rides.close(); db.close();
  // world → the wheel's own frame (x across, y up from its ground, z out of its front); a god thing turns by rotation.y = +yaw
  const c = Math.cos(wp.yaw), s = Math.sin(wp.yaw);
  const local = (q: readonly number[]) => { const dx = (q[0] - wp.x) / wp.s, dz = (q[2] - wp.z) / wp.s; return [dx * c - dz * s, (q[1] - ground) / wp.s, dx * s + dz * c]; };
  return { want, local, def, wp };
}

test('wheelRim reads the core wheel\'s hub, rim radius and how far its pods reach out of its plane', () => {
  const rim = wheelRim(ride([0, 0], 0).def)!;
  assert.deepEqual(rim.hub, [0, HUB]);
  assert.ok(Math.abs(rim.R - R) < 1e-9 && Math.abs(rim.front - FRONT) < 1e-6, JSON.stringify(rim));
  assert.equal(wheelRim({ make: { kind: 'gen', args: { shapes: [{ kind: 'sphere', at: [0, 1, 0], r: 1, role: 'wheel', pivot: [0, 1, 0] }] } } }), null, 'no rim, no rim car');
});

for (const [p, r] of [[[12, 46], 0.3], [[-40, 20], 0], [[30, -30], 2.4]] as const) test(`the car goes round fixed to the core wheel's rim, not beside it (yaw ${r})`, () => {
  const { want, local, wp } = ride([...p], r);
  assert.ok(want?.routeKeys, 'the wheel has a ride');
  const keys = want.routeKeys!, home = local(keys[0].p), start = keys.findIndex((k) => k.t === 6), end = keys.findIndex((k) => k.t === 81);
  assert.equal(want.route, 'ferris-wheel-rim');
  assert.ok(home[2] > 4 && Math.abs(home[0]) < 0.01 && Math.abs(home[1]) < 0.01, `riders still board on the ground in front of the wheel: ${home}`);
  assert.ok(start > 0 && end > start, 'on the rim at 6 s, back at the bottom at 81 s');
  // every tick of the turn: the rim point the car hangs from (RIM_DROP over its floor) is on the rim circle, concentric with
  // the hub, and the car stands just in front of the wheel's turning parts
  const route = { id: want.route, keys }, z = FRONT + RIM_GAP + CAR_HALF;
  let worst = 0, depth = 0, high = -Infinity, low = Infinity;
  for (let tick = 6 * 20; tick <= 81 * 20; tick++) {
    const q = local(routePosition(route, tick));
    worst = Math.max(worst, Math.abs(Math.hypot(q[0], q[1] + RIM_DROP - HUB) - R)); depth = Math.max(depth, Math.abs(q[2] - z));
    high = Math.max(high, q[1]); low = Math.min(low, q[1]);
  }
  assert.ok(worst < 0.05, `on the rim circle within 5 cm (was ${worst.toFixed(3)} m off)`);
  assert.ok(depth < 0.02, `against the wheel's front, ${z} m out (was ${depth.toFixed(3)} m off that)`);
  assert.ok(Math.abs(high - (HUB + R - RIM_DROP)) < 0.05 && Math.abs(low - (HUB - R - RIM_DROP)) < 0.05, `over the top and round the bottom of the rim (${low.toFixed(2)}..${high.toFixed(2)} m)`);
  // the car faces into the wheel (Core: local +x = (cos yaw, sin yaw)); the wheel's front is (sin wp.yaw, cos wp.yaw)
  const fx = Math.cos(want.yaw!), fz = Math.sin(want.yaw!);
  assert.ok(fx * Math.sin(wp.yaw) + fz * Math.cos(wp.yaw) < -0.999, `the car faces the wheel (yaw ${want.yaw}, wheel ${wp.yaw})`);
});
