// V20 (#2764): follow through a door, the flight's time, finding a Soul by name, and broadcast's ten minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldView } from '../draw/world.ts';
import type { NodeRec } from '../source/source.ts';
import { Follow, enters, inside, solidsNear } from './follow.ts';
import { Flight, flightSeconds, shotOffset } from './flight.ts';
import { Broadcast } from './broadcast.ts';
import { findPlace, findSoul, placeAt } from './director.ts';

const node = (id: string, kind: string, o: Partial<NodeRec> = {}): NodeRec => ({ id, kind, parent: null, slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null, ...o });
const S = 1_000_000;

/** A wall across x = 0 with a 1.2 m doorway at z = 0, a lintel over it, and a Soul walking through it at 1 m/s. */
function doorWorld(): WorldView {
  const w = new WorldView();
  const wall = node('wall', 'test:wall', {
    // [cx, cz, hx, hz, yaw, y0, y1, tag] mm: the wall either side of the doorway, and the lintel above it.
    solids: [[0, -5600, 100, 5000, 0, 0, 3000, 1], [0, 5600, 100, 5000, 0, 0, 3000, 1], [0, 0, 100, 600, 0, 2200, 3000, 1]],
  });
  const samples: [string, string, null, number, number, number, number][] = [];
  for (let s = 0; s <= 16; s++) samples.push(['soul', 'g', null, s * S, (s - 8) * S, 0, 0]);
  w.apply([node('g', 'eden:ground'), wall, node('soul', 'souls:body', { parent: 'g', at: 16 * S, pos: [8 * S, 0, 0] })], [], samples as never);
  return w;
}

for (const [arm, aspect] of [['laptop', 16 / 9], ['phone', 390 / 844]] as const) {
  test(`A1: a followed Soul stays in frame through a door (${arm})`, () => {
    const w = doorWorld();
    const camera = new THREE.PerspectiveCamera(50, aspect, 0.3, 1200);
    // Behind and to one side, so the sightline crosses the wall as the Soul goes through.
    const f = new Follow('soul', shotOffset(new THREE.Vector3(-14, 6, 7), new THREE.Vector3(-8, 1, 0)));
    const boxes = solidsNear(w, new THREE.Vector3(), 100);
    let naiveCut = 0, frames = 0;
    for (let ms = 0; ms <= 16_000; ms += 33) {
      const t = ms * 1000, target = f.target(w, t)!;
      const eye = f.eye(w, target, 0.033);
      camera.position.copy(eye);
      camera.lookAt(target);
      camera.updateMatrixWorld();
      const ndc = target.clone().project(camera);
      assert.ok(Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z > -1 && ndc.z < 1, `in frame at ${ms} ms`);
      assert.ok(!inside(boxes, eye), `eye inside a wall at ${ms} ms`);
      assert.ok(boxes.every((b) => enters(b, target, eye) === null), `a wall hides the Soul at ${ms} ms`);
      assert.ok(eye.distanceTo(target) >= 0.3 - 1e-9, 'never inside the near plane');
      if (boxes.some((b) => enters(b, target, target.clone().add(f.wanted)) !== null)) naiveCut++;
      frames++;
    }
    // The case is real: without the clearance the wall would have hidden the Soul for part of the walk.
    assert.ok(naiveCut > 10, `the wall cut the asked sightline in ${naiveCut} of ${frames} frames`);
  });
}

test('A4: a flight takes 1 to 3 s and ends on the follow shot', () => {
  assert.equal(flightSeconds(0, 0), 1);
  assert.equal(flightSeconds(5000, Math.PI), 3);
  for (const [eye, pivot] of [[new THREE.Vector3(0, 300, 300), new THREE.Vector3()], [new THREE.Vector3(9, 3, 9), new THREE.Vector3(10, 1, 10)]]) {
    const target = new THREE.Vector3(10, 1, 10), f = new Flight('a', eye, pivot, target);
    let s = 0, pose = f.step(0, target);
    while (!pose.done) (pose = f.step(1 / 60, target)), (s += 1 / 60);
    assert.ok(s >= 1 - 1e-6 && s <= 3 + 1 / 60, `${s} s`);
    assert.ok(pose.target.distanceTo(target) < 1e-9);
    const d = pose.eye.distanceTo(target);
    assert.ok(d >= 6 - 1e-9 && d <= 12 + 1e-9, `${d} m out`);
  }
});

test('A4: a typed name finds its Soul: exactly, then the start of a name, then within one', () => {
  const souls = [{ id: '1', name: 'Oriel' }, { id: '2', name: 'Orin' }, { id: '3', name: 'Maren' }, { id: '4', name: null }];
  assert.equal(findSoul(souls, 'orin'), '2');
  assert.equal(findSoul(souls, ' ORI '), '1');
  assert.equal(findSoul(souls, 'ren'), '3');
  assert.equal(findSoul(souls, 'nobody'), null);
  assert.equal(findSoul(souls, ''), null);
});

test('#3574: a typed name finds a named place when no Soul has it, at the middle of its outline', () => {
  const places = [node('t2', 'eden:zone', { placeName: 'Plaza' }), node('p1', 'eden:place', { placeName: 'land-west-lake', outline: [[0, 0], [1, 1]] }), node('p2', 'eden:place', { placeName: 'Plaza', outline: [[0, 0], [1, 1]] }), node('p3', 'eden:place'), node('b', 'souls:body')];
  const souls = [{ id: 's1', name: 'Oriel' }];
  const find = (typed: string) => findSoul(souls, typed) ?? findPlace(places, typed);
  assert.equal(find('plaza'), 'p2', 'the area before the thing of the same name');
  assert.equal(find(' LAKE '), 'p1');
  assert.equal(find('west lake'), 'p1', 'a hyphen reads as a space');
  assert.equal(find('west-lake'), 'p1');
  assert.equal(find('ori'), 's1', 'a Soul still comes first');
  assert.equal(find('nowhere'), null);
  assert.equal(find(''), null);
  const at = placeAt({ outline: [[0, 0], [4000, 0], [4000, 2000], [0, 2000]] }, 1.5)!;
  assert.deepEqual([at.x, at.y, at.z], [2, 1.5, 1]);
  assert.equal(placeAt({}, 0), null);
});

test('A5: ten minutes of broadcast with no input, never 10 s without a body to frame', () => {
  const b = new Broadcast();
  const bodies = new Set(Array.from({ length: 40 }, (_, i) => `b${i}`));
  let gap = 0, worst = 0, t = 0, kept = 0;
  const seen = new Set<string>();
  for (let frame = 0; frame < 600 * 30; frame++) {
    t += S / 30;
    // Someone speaks every 7 s; every 50 s the subject leaves the world and another arrives.
    if (frame % 210 === 0) b.heard({ said: [{ speaker: `b${(frame / 210) % 40}`, at: t - 500_000, length: 2 * S, reach: 0, ref: '', words: 'hello' }] });
    if (frame % 1500 === 1499 && b.subject) (bodies.delete(b.subject), bodies.add(`n${frame}`));
    const p = b.pick(t, 1 / 30, { has: (id) => bodies.has(id), walking: () => false, ids: () => bodies });
    if (p.id && bodies.has(p.id)) (gap = 0), kept++, seen.add(p.id);
    else gap += 1 / 30;
    worst = Math.max(worst, gap);
  }
  assert.ok(worst < 10, `${worst} s without a subject`);
  assert.equal(kept, 600 * 30, 'a drawn subject every frame');
  assert.ok(b.cuts > 20 && seen.size > 10, `${b.cuts} cuts over ${seen.size} subjects`);
});
