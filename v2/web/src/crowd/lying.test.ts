// Lying on the page (#3791): a body whose stance is lie plays the baked `Lie` (today's LayToIdle first frame, laid out
// with the hips over the body point and the head along its back), blending in and out on world time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { model } from '../pose/fixture.ts';
import { jointAt } from '../pose/pose.ts';
import { CrowdBodies } from './bodies.ts';
import { Crowd } from './crowd.ts';
import { FADE, LIE_CLIP, Lying, lyingAt } from './lying.ts';

const S = 1_000_000;

/** A stand-in for LayToIdle's first frame: the body tipped onto its back, head toward +x, hips off the origin. */
const lay = () => new THREE.AnimationClip('LayToIdle', 2, [
  new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 2], [
    ...new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2).toArray(),
    ...new THREE.Quaternion().toArray(),
  ]),
  new THREE.VectorKeyframeTrack('Hips.position', [0, 2], [0.3, 0.2, 0.4, 0, 1, 0]),
]);

test('lying blends in over FADE from when it lay down and out over FADE from when it stood', () => {
  const span = [{ from: 10 * S, to: 20 * S }];
  assert.equal(lyingAt(span, 9 * S), 0);
  assert.ok(lyingAt(span, (10 + FADE / 2) * S) > 0 && lyingAt(span, (10 + FADE / 2) * S) < 1, 'coming in');
  assert.equal(lyingAt(span, 15 * S), 1);
  assert.ok(lyingAt(span, (20 + FADE / 2) * S) < 1, 'going out');
  assert.equal(lyingAt(span, (20 + FADE) * S), 0, 'standing again');
  const l = new Lying();
  l.down('a', 1 * S);
  l.down('a', 2 * S);
  assert.deepEqual(l.spans.get('a'), [{ from: 1 * S, to: null }], 'one span while it lies');
  l.up('a', 5 * S);
  l.up('a', 6 * S);
  assert.deepEqual(l.spans.get('a'), [{ from: 1 * S, to: 5 * S }]);
});

test('Lie is baked from LayToIdle\'s first frame: hips over the body point, lying flat, head along -z', () => {
  const m = model([lay()], [LIE_CLIP]), c = m.clips.find((k) => k.name === LIE_CLIP)!, row = m.bones * 12;
  const data = m.bake.image.data as Float32Array, frame = data.slice(c.start * row, (c.start + 1) * row);
  const hips = jointAt(m, frame, m.names.indexOf('Hips')), chest = jointAt(m, frame, m.names.indexOf('Chest'));
  assert.equal(c.frames, 2);
  assert.ok(Math.abs(hips[0]) < 1e-4 && Math.abs(hips[2]) < 1e-4, `hips over the point: ${hips}`);
  assert.ok(Math.abs(chest[1] - hips[1]) < 0.05, `lying flat: ${hips} ${chest}`);
  assert.ok(chest[2] < -0.3 && Math.abs(chest[0]) < 1e-4, `head along -z: ${chest}`);
});

test('the crowd draws a body in a lie stance lying, along the bed\'s yaw, from its first frame when first seen so', () => {
  const m = model([lay(), new THREE.AnimationClip('Sitting_Idle_Loop', 2, [])], [LIE_CLIP]);
  const crowd = new Crowd([m], 4), bodies = new CrowdBodies(crowd);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 10, 30);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const lie = crowd.clip(0, LIE_CLIP);
  // A page opened while `a` is already in bed: lying at once.
  bodies.begin(100 * S);
  bodies.place('a', 0, 0.5, 0, true, { yaw: 1.2 });
  bodies.place('b', 3, 0, 0);
  bodies.end(camera);
  assert.deepEqual([crowd.clipB[0], crowd.blend[0], crowd.yaw[0]], [lie, 1, Math.fround(1.2)], 'in bed: lying along the bed');
  assert.notEqual(crowd.clipB[1], lie, 'a standing body is not');
  // `b` lies down on the ground where it stands (the wind-down): it comes in over FADE, facing as it faced.
  const faced = crowd.yaw[1];
  bodies.begin(101 * S);
  bodies.place('a', 0, 0.5, 0, true, { yaw: 1.2 });
  bodies.place('b', 3, 0, 0, false, {});
  bodies.end(camera);
  assert.equal(crowd.blend[1], 0, 'it lay down this frame');
  bodies.begin((101 + FADE / 2) * S);
  bodies.place('a', 0, 0.5, 0, true, { yaw: 1.2 });
  bodies.place('b', 3, 0, 0, false, {});
  bodies.end(camera);
  assert.ok(crowd.blend[1] > 0 && crowd.blend[1] < 1 && crowd.clipB[1] === lie, 'coming in');
  assert.equal(crowd.yaw[1], faced);
  // Woken, it stands again over FADE.
  for (const t of [102, 102 + FADE + 0.01]) {
    bodies.begin(t * S);
    bodies.place('a', 0, 0.5, 0, true, { yaw: 1.2 });
    bodies.place('b', 3, 0, 0);
    bodies.end(camera);
  }
  assert.notEqual(crowd.clipB[1], lie, 'standing again');
});
