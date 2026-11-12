import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldFollow } from '../src/WorldFollow.ts';

const HZ = 60, target = new THREE.Vector3(0, 1, 0), asked = new THREE.Vector3(0, 2, 8);
/** A body as the world draws one: a skinned mesh (one bone), about a person's size. A moved one drops its cached
 *  bounding sphere (three caches it where the body first was). */
function body() {
  const geometry = new THREE.BoxGeometry(.5, 1.8, .35), n = geometry.attributes.position.count;
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: n * 4 }, (_, i) => (i % 4 === 0 ? 1 : 0)), 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial()), bone = new THREE.Bone();
  mesh.add(bone); mesh.bind(new THREE.Skeleton([bone])); return mesh;
}
const frames = (follow: WorldFollow, roots: THREE.Object3D[], seconds: number, offset: THREE.Vector3, each?: (t: number) => void) => {
  const out: { t: number; offset: THREE.Vector3; rule: string }[] = [];
  for (let i = 0; i < Math.round(seconds * HZ); i++) {
    each?.(i / HZ);
    offset = follow.resolve(target, offset, roots, 1 / HZ); out.push({ t: i / HZ, offset: offset.clone(), rule: follow.rule.name });
  }
  return out;
};

test('#2201 A3: forced over a wall, the camera comes back down to the asked-for view within 3 s of open space', () => {
  const g = new THREE.Group(), wall = new THREE.Mesh(new THREE.BoxGeometry(30, 3.5, .3), new THREE.MeshBasicMaterial());
  wall.position.set(0, 1.75, 3); g.add(wall); g.updateWorldMatrix(true, true);
  const follow = new WorldFollow();
  const over = frames(follow, [g], 4, asked.clone());
  const risen = over.at(-1)!.offset;
  assert.ok(new THREE.Spherical().setFromVector3(risen).phi < new THREE.Spherical().setFromVector3(asked).phi - .3, 'the wall forced the camera up');
  const ray = new THREE.Raycaster(target, risen.clone().normalize(), .05, risen.length());
  assert.equal(ray.intersectObject(wall).length, 0, 'and it sees the Soul over the wall');
  wall.visible = false;  // the Soul is out in the open: nothing blocks the asked-for view any more
  const open = frames(follow, [g], 4, risen.clone());
  const back = open.find((f) => f.offset.angleTo(asked) < .05 && Math.abs(f.offset.length() - asked.length()) < .3);
  assert.ok(back && back.t <= 3, `back at the asked-for view ${back ? back.t.toFixed(2) + ' s' : 'never'} after the wall went`);
  assert.ok(open.some((f) => f.rule === 'recover'), 'the trace records the recovery');
  assert.ok(open.slice(1).every((f, i) => f.offset.distanceTo(open[i].offset) < .25), 'eased, never a jump');
});

test('#2201 A3: a passage with a brief gap does not pull the camera down; a return comes only once space allows twice running', () => {
  const g = new THREE.Group(), wall = new THREE.Mesh(new THREE.BoxGeometry(30, 3.5, .3), new THREE.MeshBasicMaterial());
  wall.position.set(0, 1.75, 3); g.add(wall); g.updateWorldMatrix(true, true);
  const follow = new WorldFollow();
  let offset = frames(follow, [g], 4, asked.clone()).at(-1)!.offset;
  const risen = offset.clone();
  // a gap of .3 s (a doorway passed), then the wall again
  const gap = frames(follow, [g], 2, offset, (t) => { wall.visible = !(t >= .2 && t < .5); });
  offset = gap.at(-1)!.offset;
  assert.ok(gap.every((f) => f.rule !== 'recover'), 'no recovery from a brief gap');
  assert.ok(offset.angleTo(risen) < .05, `still over the wall (${offset.angleTo(risen).toFixed(3)} rad off)`);
});

test('#2201 A3: three Souls walking across the sightline: the camera holds its view; a Soul that stops in the way is avoided', () => {
  const g = new THREE.Group(), walkers = [body(), body(), body()];
  for (const w of walkers) { w.position.set(-50, .9, 1.5); g.add(w); }
  g.updateWorldMatrix(true, true);
  const follow = new WorldFollow();
  let offset = frames(follow, [g], 1, asked.clone()).at(-1)!.offset;
  const start = offset.clone();
  // each crosses at a walking pace (1.4 m/s), one after another, 1.2 s apart, 1.5 m from the Soul toward the camera
  let cut = 0;
  const crossing = frames(follow, [g], 6, offset, (t) => {
    walkers.forEach((w, i) => { w.position.x = -4 + 1.4 * (t - 1.2 * i); w.boundingSphere = null; }); g.updateWorldMatrix(true, true);
    if (new THREE.Raycaster(target, start.clone().normalize(), .05, start.length()).intersectObjects(walkers).length) cut++;
  });
  assert.ok(cut / HZ > .3, `the walkers cut the Soul's torso line on its way (${(cut / HZ).toFixed(2)} s in all)`);
  offset = crossing.at(-1)!.offset;
  const off = Math.max(...crossing.map((f) => f.offset.angleTo(start)));
  assert.ok(off < .02, `the camera held through all three (at most ${off.toFixed(3)} rad off)`);
  assert.ok(crossing.every((f) => f.rule !== 'search'), 'and never searched for another view');
  // one stops right in the way: after the dwell, the camera moves round it
  walkers[0].position.set(0, .9, 1.5); walkers[0].boundingSphere = null; g.updateWorldMatrix(true, true);
  const stopped = frames(follow, [g], 3, offset);
  const firstMove = stopped.find((f) => f.offset.angleTo(start) > .02);
  assert.ok(firstMove && firstMove.t >= .45, `the camera waits the dwell before reacting (${firstMove?.t.toFixed(2)} s)`);
  assert.ok(stopped.at(-1)!.offset.angleTo(start) > .1, 'then moves round the Soul in the way');
});
