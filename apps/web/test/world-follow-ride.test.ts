import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldFollow, RIDE } from '../src/WorldFollow.ts';

// First-day E4: a followed Soul rides a climbing balloon. The basket and envelope are camera-transparent (WorldBalloonRide),
// so the sightline search alone let the camera sit at 2.4 m, level with and under the basket, and the Soul went out of view.
function balloon(floorY: number) {
  const g = new THREE.Group(), m = new THREE.MeshBasicMaterial();
  const basket = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 1.2), m); basket.position.set(0, floorY + .55, 0);
  const envelope = new THREE.Mesh(new THREE.SphereGeometry(4.2, 12, 8), m); envelope.position.set(0, floorY + 8, 0);
  for (const o of [g, basket, envelope]) { o.userData.cameraTransparent = true; if (o !== g) g.add(o); }
  g.updateWorldMatrix(true, true);
  return { g, basket: new THREE.Box3().setFromObject(basket), envelope: { centre: envelope.position.clone(), r: 4.2 } };
}

test('a riding Soul is followed from outside its vehicle: out past the envelope, above the basket, never under it', () => {
  const follow = new WorldFollow(); follow.riding = true;
  let offset = new THREE.Vector3(.6, -.4, 2.3);   // E4's camera: 2.4 m off, below the rider's chest
  for (let i = 0; i < 600; i++) {
    const floor = 40 + i / 60 * .5, b = balloon(floor), target = new THREE.Vector3(0, floor + 1, 0);   // climbing 0.5 m/s
    offset = follow.resolve(target, offset, [b.g], 1 / 60);
    const eye = target.clone().add(offset), s = new THREE.Spherical().setFromVector3(offset), rise = Math.PI / 2 - s.phi;
    assert.ok(offset.length() >= RIDE.distance - 1e-6, `frame ${i}: ${offset.length().toFixed(2)} m out`);
    assert.ok(rise >= RIDE.pitch - 1e-6 && rise <= RIDE.top + 1e-6, `frame ${i}: ${rise.toFixed(2)} rad above the rider`);
    assert.ok(!b.basket.containsPoint(eye) && eye.y > b.basket.max.y, `frame ${i}: over the basket's rim, not in or under it`);
    assert.ok(eye.distanceTo(b.envelope.centre) > b.envelope.r, `frame ${i}: outside the envelope`);
  }
});

test('a zoom in while riding keeps the camera outside; off the ride, Follow comes back in as asked', () => {
  const follow = new WorldFollow(), b = balloon(40), target = new THREE.Vector3(0, 41, 0); follow.riding = true;
  let offset = new THREE.Vector3(0, 4, 11);
  for (let i = 0; i < 30; i++) offset = follow.resolve(target, offset, [b.g], 1 / 60);
  follow.userInput(offset.clone(), offset.clone().setLength(3));
  for (let i = 0; i < 30; i++) offset = follow.resolve(target, offset, [b.g], 1 / 60);
  assert.ok(offset.length() >= RIDE.distance - 1e-6, `zoomed in to ${offset.length().toFixed(2)} m`);
  follow.riding = false;
  follow.userInput(offset.clone(), offset.clone().setLength(3));
  for (let i = 0; i < 30; i++) offset = follow.resolve(target, offset, [b.g], 1 / 60);
  assert.ok(offset.length() < RIDE.distance - 1, `off the ride the viewer's zoom holds: ${offset.length().toFixed(2)} m`);
});
