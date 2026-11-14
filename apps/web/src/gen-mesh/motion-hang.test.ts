// E2: a big wheel's gondolas (kit role `gondola`, one group each) go round with the turning wheel and keep hanging upright.
//   node --test apps/web/src/gen-mesh/motion-hang.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { animate, hangPosition, ridingOffset } from './motion.ts';

test('hangPosition turns a hanger point about the hub', () => {
  const [x, y] = hangPosition([5, 0], Math.PI / 2);
  assert.ok(Math.abs(x) < 1e-9 && Math.abs(y - 5) < 1e-9);
});

test('a gondola rides round with the wheel and stays upright', () => {
  const obj = new THREE.Group(), wheel = new THREE.Group(), gondola = new THREE.Group(), other = new THREE.Group();
  wheel.name = 'role:wheel'; wheel.position.set(0, 10, 0);
  gondola.name = 'role:gondola'; gondola.position.set(5, 10, 0);
  other.name = 'role:door'; other.position.set(5, 10, 0);
  obj.add(wheel, gondola, other);
  const def = { components: { spin: { axis: 'z', rpm: 15, role: 'wheel' } }, tags: [] } as never;
  const t = 1e9 + 1; // a quarter turn at 15 rpm (one turn in 4 s)
  animate(obj, { id: 'w', def: 'x', p: [0, 0, 0] } as never, def, t, { y: 0, yaw: 0 });
  assert.ok(Math.abs(wheel.rotation.z - (t * 0.25 * Math.PI * 2)) < 1e-6);
  assert.ok(Math.abs(gondola.position.x) < 1e-3 && Math.abs(gondola.position.y - 15) < 1e-3, `at the top: ${gondola.position.toArray()}`);
  assert.equal(gondola.rotation.z, 0, 'hangs upright');
  assert.deepEqual(other.position.toArray(), [5, 10, 0], 'other roles stay put');
});

// #2198: a Soul rides the big wheel in one of its own gondolas: while the ride is out, the wheel turns from its own clock so
// that a gondola's floor is where the ride is, all the way round; it eases back to its clock when the ride is home.
test('a ridden wheel turns one of its own gondolas to the rider, all the way round, and back to its clock after', () => {
  const R = 13, drop = 1.575, rests = Array.from({ length: 16 }, (_, k) => { const a = (k / 16) * Math.PI * 2 - Math.PI / 2; return [R * Math.cos(a), R * Math.sin(a)] as [number, number]; });
  let st: { offset: number; car: number | null } = { offset: 0, car: null };
  const dt = 1 / 30, clock = (t: number) => (t * 0.8 / 60) * Math.PI * 2 + 1.234;   // the wheel's own clock, any phase
  let worst = 0, car: number | null = null;
  for (let i = 0; i < 30 * 85; i++) {
    const s = i * dt, turn = clock(1000 + s);
    // the ride: 6 s stepping in from in front of the wheel, then once round the gondolas' floor circle in 75 s
    const a = -Math.PI / 2 + (Math.max(0, Math.min(75, s - 6)) / 75) * Math.PI * 2;
    const at: [number, number, number] = s < 6 ? [0, -R - drop, 6 - s] : [R * Math.cos(a), R * Math.sin(a) - drop, 0];
    st = ridingOffset(rests, drop, { at, aloft: true }, turn, st, dt);
    if (car === null) car = st.car; else assert.equal(st.car, car, 'one gondola for the whole ride');
    if (s > 7) { const [x, y] = hangPosition(rests[car!], turn + st.offset); worst = Math.max(worst, Math.hypot(x - at[0], y - drop - at[1])); }
  }
  assert.ok(worst < 0.01, `the gondola's floor is at the rider all the way round (worst ${worst.toFixed(4)} m)`);
  // home: the wheel goes back to its own clock, easing
  for (let i = 0; i < 30 * 10; i++) st = ridingOffset(rests, drop, undefined, clock(2000 + i * dt), st, dt);
  assert.equal(st.offset, 0); assert.equal(st.car, null);
});
