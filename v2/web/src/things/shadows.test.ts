// #3787: far small one-off shapes stop casting shadows past today's distance rule, as instanced ones do, without a
// second batch: the shape stays in its material's one BatchedMesh and is left out of that batch's shadow draw list,
// which is rebuilt only when something changes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { indexOf, type Part } from './models.ts';
import { FAR, NEAR, ThingLayer } from './things.ts';

const at = (x: number) => new THREE.Matrix4().makeTranslation(x, 0, 0);
const shape = (scale: number, material: THREE.Material): Part => {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 3).fill(1), 3));
  return { geometry, material, matrix: new THREE.Matrix4().makeScale(scale, scale, scale), key: 'k', glow: false };
};
type Drawn = THREE.BatchedMesh & { _multiDrawCount: number; _indirectTexture: THREE.DataTexture };
/** Runs the batch's shadow hooks as three's shadow pass does, and returns the instances that pass draws. */
function shadowPass(mesh: THREE.BatchedMesh): number[] {
  const m = mesh as Drawn, cam = new THREE.PerspectiveCamera(), renderer = {} as THREE.WebGLRenderer;
  m.onBeforeShadow(renderer, new THREE.Scene(), cam, cam, m.geometry, m.material as THREE.Material, null as unknown as THREE.Group);
  const ids = Array.from((m._indirectTexture.image.data as Uint32Array).subarray(0, m._multiDrawCount));
  m.onAfterShadow(renderer, new THREE.Scene(), cam, cam, m.geometry, m.material as THREE.Material, null as unknown as THREE.Group);
  return ids.sort((a, b) => a - b);
}

test('A1: a far one-off shape casts no shadow, in the same batch; near again, it casts', () => {
  const detail = { minRadiusPx: 1.25, shadowNear: 24, shadowPerMetre: 14, shadowMaxRadius: 6 };
  const l = new ThingLayer({ index: indexOf({ kinds: [], things: { e_a: 'a', e_b: 'b' } }), fetch: () => new Promise(() => {}), detail, view: () => ({ height: 844, fov: 50 }) });
  const material = new THREE.MeshStandardMaterial();
  l.set('near', 'e_a', at(0), new THREE.Matrix4());
  l.set('far', 'e_b', at(100), new THREE.Matrix4());
  // Two one-off models (one thing each) sharing a material: a 1 m crate (radius ~0.87 m).
  l.arrive('a', [shape(1, material)]);
  l.arrive('b', [shape(1, material)]);
  l.update(new THREE.Vector3(0, 0, 0));
  const near = l.things.get('near')!.slots[0], far = l.things.get('far')!.slots[0];
  assert.equal(near.band, NEAR);
  assert.equal(far.band, FAR, '100 m: past 24 + 14·0.87 m');
  assert.equal(far.batch, near.batch, 'one batch a material: no second, shadowless one');
  const mesh = (near.batch as unknown as { mesh: THREE.BatchedMesh }).mesh, m = mesh as Drawn;
  assert.ok(mesh.castShadow);
  assert.deepEqual(shadowPass(mesh), [near.index], 'the shadow pass draws only the near crate');
  // The view's own draw list is back after the shadow pass: both crates are drawn.
  const main = m._multiDrawCount;
  assert.equal(main, 2);
  // Nothing changed: the shadow list is not rebuilt.
  const rebuilds = (near.batch as unknown as { rebuilds: number }).rebuilds;
  shadowPass(mesh);
  assert.equal((near.batch as unknown as { rebuilds: number }).rebuilds, rebuilds);
  // The eye walks to the far crate: it casts again, and the near one, now 100 m off, does not.
  for (let f = 0; f < 10; f++) l.update(new THREE.Vector3(100, 0, 1));
  assert.equal(far.band, NEAR);
  assert.equal(near.band, FAR);
  assert.deepEqual(shadowPass(mesh), [far.index]);
  // A shape hidden (an interior view, a fire) is in neither list.
  mesh.setVisibleAt(far.index, false);
  assert.deepEqual(shadowPass(mesh), []);
});
