// Places (#3676): the list, the framed view shared by the preview and the place camera, and the place flight.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { fitFrame, placeBox, placeFrame, placeList } from './places.ts';
import { PlaceFlight } from './camera.ts';

const square = (x: number, z: number, side: number) => [[x, z], [x + side, z], [x + side, z + side], [x, z + side]];

test('#3676 A1: the list holds every named area once, by name, and leaves out unnamed and outline-less nodes', () => {
  const list = placeList([
    { id: 'b', placeName: 'west-lake', outline: square(0, 0, 1000) },
    { id: 'a', placeName: 'old_town plaza', outline: square(0, 0, 1000) },
    { id: 'c', placeName: 'West Lake', outline: square(5000, 0, 1000) },
    { id: 'd', placeName: 'lamp', outline: undefined },
    { id: 'e', placeName: null, outline: square(0, 0, 1000) },
  ]);
  assert.deepEqual(list, [{ id: 'a', name: 'old town plaza' }, { id: 'b', name: 'west lake' }]);
});

test('#3676 A2: the framed view holds every corner of the place inside the frame, seen from above', () => {
  const n = { outline: square(10_000, -20_000, 40_000) }, at = new THREE.Vector3(0, 2, 0);
  const box = placeBox(n, at);
  assert.deepEqual([box.min.x, box.max.x, box.min.z, box.max.z, box.min.y], [10, 50, -20, 20, 2]);
  assert.ok(box.max.y > 2 + 3 - 1e-9 && box.max.y <= 22);
  for (const aspect of [16 / 9, 390 / 844]) {
    const f = placeFrame(n, at, aspect), cam = new THREE.PerspectiveCamera(38, aspect, 0.1, 10_000);
    cam.position.copy(f.eye);
    cam.lookAt(f.target);
    cam.updateMatrixWorld(true);
    cam.updateProjectionMatrix();
    assert.ok(f.eye.y > f.target.y, 'the eye is above what it looks at');
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
      const p = new THREE.Vector3(x, y, z).project(cam);
      assert.ok(Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 && p.z < 1, `corner ${x},${y},${z} in frame at aspect ${aspect.toFixed(2)}`);
    }
  }
  const thing = placeBox({}, new THREE.Vector3(5, 0, 5));
  assert.deepEqual([thing.min.x, thing.max.x], [1, 9]);
  assert.ok(fitFrame(thing, new THREE.Vector3(0, 0, 0), 1).eye.distanceTo(thing.getCenter(new THREE.Vector3())) > 1);
});

test('#3676 A2: the place flight takes 1 to 3 s, eases from the camera, and ends exactly on the framed view', () => {
  const to = { eye: new THREE.Vector3(100, 60, 100), target: new THREE.Vector3(80, 0, 80) };
  const f = new PlaceFlight('p', new THREE.Vector3(0, 50, 0), new THREE.Vector3(0, 0, -10), to);
  assert.ok(f.seconds >= 1 && f.seconds <= 3);
  const first = f.step(0);
  assert.deepEqual(first.eye.toArray(), [0, 50, 0]);
  let last = first;
  for (let i = 0; i < 200 && !last.done; i++) last = f.step(1 / 60);
  assert.ok(last.done);
  assert.deepEqual([last.eye.toArray(), last.target.toArray()], [to.eye.toArray(), to.target.toArray()]);
});
