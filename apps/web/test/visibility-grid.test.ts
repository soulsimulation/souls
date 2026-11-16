import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldRenderedVisibility } from '../src/WorldRenderedVisibility.ts';
import { WorldBroadcast } from '../src/WorldBroadcast.ts';
import type { Entity } from '../../../mars/viewer/engine/world/types.ts';
import type { SampledEntity } from '../../../mars/viewer/engine/take/replay.ts';

// #2617: rays visit only the objects an XZ grid says their segment can meet (WorldVisibilityInstances.along). Every
// answer, and so every Broadcast choice, must be what visiting every object gives.
const material = new THREE.MeshBasicMaterial();
function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function town(seed: number) {
  const r = rng(seed), group = new THREE.Group();
  for (let k = 0; k < 160; k++) {   // huts, posts and a few long walls, some far apart, some large
    const w = .2 + r() * (k % 23 === 0 ? 60 : 5), h = .5 + r() * 6, d = .2 + r() * 5;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material); m.position.set(-90 + r() * 180, h / 2, -90 + r() * 180); m.rotation.y = r() * 3; m.geometry.computeBoundingSphere(); group.add(m);   // as a drawn frame leaves them
  }
  const trees = new THREE.InstancedMesh(new THREE.CylinderGeometry(.3, .3, 4), material, 80), q = new THREE.Matrix4();
  for (let i = 0; i < 80; i++) trees.setMatrixAt(i, q.makeTranslation(-60 + r() * 120, 2, -60 + r() * 120));
  trees.computeBoundingSphere(); group.add(trees);
  // no bounds yet (never pre-rejected): the grid always visits it
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), material); ground.rotation.x = -Math.PI / 2; group.add(ground);
  group.updateWorldMatrix(true, true);
  return group;
}
/** Every object on every ray: the answers before the grid. */
function everyObject(v: WorldRenderedVisibility) {
  const inst = (v as unknown as { instances: { along(r: THREE.Raycaster, out: number[]): number[] }; objects: THREE.Object3D[] });
  inst.instances.along = (_r, out) => { out.length = 0; for (let i = 0; i < inst.objects.length; i++) out.push(i); return out; };
}

test('rendered visibility answers the same with the grid as over every object', () => {
  for (const seed of [1, 2, 3]) {
    const root = town(seed), grid = new WorldRenderedVisibility(), all = new WorldRenderedVisibility();
    everyObject(all); grid.prepare([root]); all.prepare([root]);
    const r = rng(seed * 7), pt = (y = 0): [number, number, number] => [-100 + r() * 200, y + r() * 8, -100 + r() * 200];
    let blocked = 0;
    for (let k = 0; k < 300; k++) {
      const a = pt(), b = k % 10 === 0 ? [a[0], a[1] + 40, a[2]] : k % 7 === 0 ? [a[0] + .02, a[1] + 1, a[2] - .03] : pt();
      const pose = { position: a, target: b, fov: 50 }, subjects = { s: { p: [b[0], 0, b[2]] as [number, number, number], yaw: 0, height: 1.75 } };
      const g = grid.evaluate(() => [grid.reach(a, b), grid.clear(a, .8), grid.score(pose, ['s'], subjects), grid.seen(pose, ['s'], subjects), grid.foreground(pose, 16 / 9), grid.around(a, 12, 3)]);
      const e = all.evaluate(() => [all.reach(a, b), all.clear(a, .8), all.score(pose, ['s'], subjects), all.seen(pose, ['s'], subjects), all.foreground(pose, 16 / 9), all.around(a, 12, 3)]);
      assert.deepEqual(g, e, `seed ${seed} ray ${k}`);
      if (Number.isFinite(e[0])) blocked++;
    }
    assert.ok(blocked > 50, `the town blocks many rays (${blocked})`);
  }
});

test('a custom raycast among the occluders: the same answers, and instances validated once per query', () => {
  // The page's scenery holds hundreds of no-op custom raycasts; every path must still answer as over every object.
  const root = town(4), odd = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), material);
  odd.raycast = function (r, out) { THREE.Mesh.prototype.raycast.call(this, r, out); }; odd.position.set(3, 1, 3); root.add(odd); root.updateWorldMatrix(true, true);
  const grid = new WorldRenderedVisibility(), all = new WorldRenderedVisibility(); everyObject(all); grid.prepare([root]); all.prepare([root]);
  const r = rng(11);
  for (let k = 0; k < 100; k++) {
    const a = [-60 + r() * 120, r() * 6, -60 + r() * 120], b = [-60 + r() * 120, r() * 6, -60 + r() * 120];
    assert.deepEqual(grid.evaluate(() => [grid.clear(a, .8), grid.reach(a, b), grid.around(a, 12, 3)]), all.evaluate(() => [all.clear(a, .8), all.reach(a, b), all.around(a, 12, 3)]), `ray ${k}`);
  }
  // The custom raycast no longer sends the instanced trees back to revalidating their instances on every ray.
  const inst = (grid as unknown as { instances: { prepare(m: THREE.InstancedMesh): unknown } }).instances, prepare = inst.prepare.bind(inst);
  let validations = 0; inst.prepare = (m) => { validations++; return prepare(m); };
  grid.evaluate(() => { for (let k = 0; k < 50; k++) grid.reach([-60 + r() * 120, 2, -60 + r() * 120], [-60 + r() * 120, 2, -60 + r() * 120]); });
  assert.ok(validations <= 1, `instanced validations in one query of 50 rays: ${validations}`);
});

test('Broadcast makes the same choices with the grid, frame for frame', () => {
  const scene = { bounds: [-40, -40, 40, 40] as [number, number, number, number], levels: [], surfaces: [], obstacles: [], links: [] };
  const cast: Record<string, [number, number, number, string]> = { a: [0, 0, 0, 'talk'], b: [1.4, .6, 3, 'listen'], c: [.5, 1.8, 2, 'listen'], d: [-1.2, 1, 1, 'idle'], w: [-14, -4, 1.2, 'walk'] };
  const run = (grid: boolean) => {
    const roots = [town(9)], camera = new WorldBroadcast(), rendered = (camera as unknown as { rendered: WorldRenderedVisibility }).rendered;
    (camera as unknown as { tracker: { pose: () => null } }).tracker.pose = () => null;
    if (!grid) everyObject(rendered);
    const records: Record<string, Entity> = {}, frame: Record<string, SampledEntity> = {};
    for (const [id, [x, z, yaw, activity]] of Object.entries(cast)) { records[id] = { kind: 'human' } as Entity; frame[id] = { p: [x, 0, z], yaw, pitch: 0, roll: 0, activity, state: {} } as SampledEntity; }
    const out: unknown[] = [];
    for (let f = 0; f < 480; f++) {
      const wall = (f + 1) / 60, k = Math.floor(wall / 2) % 3;
      ['a', 'b', 'c'].forEach((id, i) => { frame[id].activity = i === k ? 'talk' : 'listen'; });
      frame.w.p = [-14 + wall * 1.3, 0, -4 + wall * .3];
      const shot = camera.sample(structuredClone(frame), records, scene, Math.floor(wall * 20), 1 / 20, 16 / 9, wall, 1 / 60, roots);
      out.push([shot?.shot, shot?.pose]);
    }
    return out;
  };
  const a = run(true), b = run(false);
  assert.deepEqual(a, b, 'identical shots and poses');
  assert.ok(new Set(a.map(x => (x as [string])[0])).size >= 2, 'the script makes editorial changes');
});
