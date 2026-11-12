import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { springAngle, springStep } from '../src/camera-spring.ts';
import { WorldFollow } from '../src/WorldFollow.ts';

/** Frames of `hz` for `seconds`; frame i (0-based) steps toward goal(i), the goal held over that frame. */
const run = (hz: number, seconds: number, goal: (frame: number) => number) => {
  let s = { x: 0, v: 0 }; const out: { t: number; x: number; v: number }[] = [];
  for (let i = 0; i < Math.round(seconds * hz); i++) { s = springStep(s.x, s.v, goal(i), 1.6, 1 / hz); out.push({ t: (i + 1) / hz, ...s }); }
  return out;
};

test('#2201 A2: the spring traces the same path at 30, 60 and 120 Hz, settles without overshoot, and starts from rest', () => {
  const at = (r: ReturnType<typeof run>, t: number) => r.find((f) => Math.abs(f.t - t) < 1e-9)!;
  const r30 = run(30, 3, () => 1), r60 = run(60, 3, () => 1), r120 = run(120, 3, () => 1);
  for (const t of [.5, 1, 2, 3]) {
    assert.ok(Math.abs(at(r30, t).x - at(r120, t).x) < 1e-9 && Math.abs(at(r60, t).x - at(r120, t).x) < 1e-9, `same place at ${t} s`);
    assert.ok(Math.abs(at(r30, t).v - at(r120, t).v) < 1e-9, `same speed at ${t} s`);
  }
  assert.ok(r120.every((f, i) => f.x <= 1 && (i === 0 || f.x >= r120[i - 1].x)), 'critically damped: never past the goal, never back');
  assert.ok(r120[0].x < 1e-3, `eases out of rest: ${r120[0].x} in the first 1/120 s`);
  assert.ok(at(r120, 2).x > .99, 'settled within the period and a bit');
});

test('#2201 A2: a goal that jumps mid-move changes the speed by a frame\'s acceleration, never in a step', () => {
  const jump: Record<number, number> = {};
  for (const hz of [30, 60, 120]) {
    const r = run(hz, 3, (i) => (i < hz ? 1 : -2)), w = 2 * Math.PI / 1.6;  // the goal jumps 3 units back at 1 s
    jump[hz] = Math.abs(r[hz].v - r[hz - 1].v);
    assert.ok(jump[hz] <= w * w * 3 / hz, `${hz} Hz: the speed changes by ${jump[hz].toFixed(3)}, a frame's acceleration`);
  }
  // a step would stay the same size at any frame rate (the old first-order glide's: 3 / 1.4 s, every time)
  assert.ok(jump[60] < jump[30] * .6 && jump[120] < jump[60] * .6 && jump[120] < 3 / 1.4 / 4, JSON.stringify(jump));
  const a = springAngle(3, 0, -3, 1.6, 1 / 60);
  assert.ok(a.x > 3, `the short way round across ±π: ${a.x}`);
});

test('#2201 A2: Follow springs round a wall that cuts the view: no velocity step at 30, 60 or 120 Hz, the same path at each', () => {
  const g = new THREE.Group(), wall = new THREE.Mesh(new THREE.BoxGeometry(3, 6, .3), new THREE.MeshBasicMaterial());
  wall.position.set(0, 3, 4.5); wall.visible = false; g.add(wall);
  const path = (hz: number) => {
    const f = new WorldFollow(), target = new THREE.Vector3(0, 1, 0), dt = 1 / hz, out: THREE.Vector3[] = [];
    let offset = new THREE.Vector3(0, 2, 8);
    for (let i = 0; i < hz * 4; i++) {
      if (i === hz) { wall.visible = true; g.updateWorldMatrix(true, true); }
      offset = f.resolve(target, offset, [g], dt); out.push(offset.clone());
    }
    wall.visible = false; return out;
  };
  const speeds: Record<number, number[]> = {};
  for (const hz of [30, 60, 120]) {
    const p = path(hz), v = p.slice(1).map((o, i) => o.distanceTo(p[i]) * hz);
    speeds[hz] = v;
    const moved = p[p.length - 1].distanceTo(p[hz - 1]);
    assert.ok(moved > 1, `${hz} Hz: the camera moved off the cut view (${moved.toFixed(2)} m)`);
    const steps = v.slice(1).map((s, i) => Math.abs(s - v[i]));
    assert.ok(v[hz - 1] < 24 / hz + 1e-6, `${hz} Hz: the move starts as a glide (${v[hz - 1].toFixed(2)} m/s in its first frame)`);
    assert.ok(Math.max(...steps) < 55 / hz, `${hz} Hz: largest speed change ${Math.max(...steps).toFixed(3)} m/s in a frame`);
  }
  const at = (hz: number, t: number) => speeds[hz][Math.round(t * hz) - 1];
  for (const t of [1.5, 2, 3]) assert.ok(Math.abs(at(30, t) - at(120, t)) < .6, `speed at ${t} s: ${at(30, t).toFixed(2)} at 30 Hz, ${at(120, t).toFixed(2)} at 120 Hz`);
});
