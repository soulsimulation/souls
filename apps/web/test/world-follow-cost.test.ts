import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldFollow } from '../src/WorldFollow.ts';

// #2216: the follow camera looks only at the scene near the Soul, gathered twice a second, instead of walking, updating
// and bounding the whole scene every frame. Its decisions must not change.
function world() {
  const g = new THREE.Group(), m = new THREE.MeshBasicMaterial();
  for (let x = -20; x <= 40; x += 7) { const house = new THREE.Mesh(new THREE.BoxGeometry(5, 4, 4), m); house.position.set(x, 2, 4.5); g.add(house); }
  const wall = new THREE.Mesh(new THREE.BoxGeometry(8, 3.5, .3), m); wall.position.set(-6, 1.75, -3); g.add(wall);
  // a far town the rays never reach: 600 boxes 150-300 m away, some hidden
  for (let i = 0; i < 600; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(3, 6, 3), m), a = i * 2.399, r = 150 + (i % 150);
    b.position.set(Math.cos(a) * r, 3, Math.sin(a) * r); b.visible = i % 7 !== 0; g.add(b);
  }
  g.updateWorldMatrix(true, true); return g;
}

test('#2216: gathering the scene near the Soul twice a second gives the same camera, frame for frame, as gathering all of it every frame', () => {
  const g = world(), near = new WorldFollow(), every = new WorldFollow();
  every.scene = { refresh: 0, least: 1e6, margin: 3 };
  let a = new THREE.Vector3(0, 3, 9), b = a.clone(), worst = 0;
  const rules: string[] = [];
  for (let i = 0; i < 900; i++) {
    const target = new THREE.Vector3(-15 + i / 60 * 1.4, 1, Math.sin(i / 120) * 2);  // a 15 s walk along the street
    a = near.resolve(target, a, [g], 1 / 60); b = every.resolve(target, b, [g], 1 / 60);
    worst = Math.max(worst, a.distanceTo(b)); if (near.rule.name !== every.rule.name) rules.push(`${i}: ${near.rule.name} vs ${every.rule.name}`);
  }
  assert.ok(worst < 1e-9, `the same camera every frame (largest difference ${worst} m)`);
  assert.deepEqual(rules, [], 'the same rule every frame');
});

test('#2216: between gatherings a frame casts its rays against the near scene only', () => {
  const g = world(), follow = new WorldFollow();
  let o = new THREE.Vector3(0, 3, 9);
  o = follow.resolve(new THREE.Vector3(0, 1, 0), o, [g], 1 / 60);
  const objects = (follow as unknown as { objects: THREE.Object3D[] }).objects.length;
  assert.ok(objects > 0 && objects < 20, `near objects ${objects} of ${g.children.length}`);
});
