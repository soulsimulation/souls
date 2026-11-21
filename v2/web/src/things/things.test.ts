// V8 (#2718): a thing is a box until its model arrives, then drawn from it; a light writes one colour slot; models
// load nearest first.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { indexOf, type Part } from './models.ts';
import { FAR, HIDDEN, NEAR, SHARED, ThingLayer } from './things.ts';

const part = (glow = false): Part => {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 3).fill(1), 3));
  return { geometry, material: new THREE.MeshStandardMaterial(), matrix: new THREE.Matrix4(), key: 'k', glow };
};
const at = (x: number) => new THREE.Matrix4().makeTranslation(x, 0, 0);
const box = new THREE.Matrix4();

function layer(things: Record<string, string>) {
  const asked: string[] = [];
  const l = new ThingLayer({
    index: indexOf({ kinds: [], things }),
    fetch: (h) => (asked.push(h), new Promise(() => {})),
  });
  return { l, asked };
}

test('A4: a thing whose model has not arrived is a box, replaced when the model arrives', () => {
  const { l } = layer({ e_a: 'one', e_b: 'one' });
  l.set('a', 'e_a', at(0), box);
  l.set('b', 'e_b', at(5), box);
  assert.equal(l.waiting, 2);
  l.arrive('one', [part(), part()]);
  assert.equal(l.waiting, 0, 'no box left');
  const a = l.things.get('a')!;
  assert.equal(a.slots.length, 2, 'one slot per part');
  assert.ok(a.slots.every((s) => (s.batch as unknown as { mesh: THREE.BatchedMesh }).mesh.isBatchedMesh), 'a one-off model is batched');
  // a thing placed after its model arrived is drawn from it at once
  l.set('c', 'e_a', at(9), box);
  assert.equal(l.waiting, 0);
  assert.equal(l.things.get('c')!.slots.length, 2);
});

test('a box removed from the middle keeps the others in their slots', () => {
  const { l } = layer({ e_a: 'one', e_b: 'one', e_c: 'one' });
  for (const [i, id] of ['a', 'b', 'c'].entries()) l.set(id, `e_${id}`, at(i * 10), box);
  l.remove('a');
  assert.equal(l.waiting, 2);
  const m = new THREE.Matrix4(), p = new THREE.Vector3();
  for (const id of ['b', 'c']) {
    const s = l.things.get(id)!.slots[0];
    (s.batch as unknown as { mesh: THREE.InstancedMesh }).mesh.getMatrixAt(s.index, m);
    assert.equal(p.setFromMatrixPosition(m).x, id === 'b' ? 10 : 20);
  }
});

test('A3: switching one light on writes its glow slots and nothing else', () => {
  const things = Object.fromEntries(Array.from({ length: SHARED }, (_, i) => [`e_${i}`, 'lamp']));
  const { l } = layer(things);
  for (let i = 0; i < SHARED; i++) l.set(`t${i}`, `e_${i}`, at(i), box);
  l.arrive('lamp', [part(false), part(true)]);
  const t = l.things.get('t3')!, glow = t.slots.find((s) => s.glow)!;
  const mesh = (glow.batch as unknown as { mesh: THREE.InstancedMesh }).mesh;
  assert.ok(mesh.isInstancedMesh, 'a shared model is instanced');
  mesh.onAfterRender(null!, null!, null!, null!, null!, null!); // the frame that uploaded the adds
  const version = (mesh.geometry.getAttribute('position') as THREE.BufferAttribute).version;
  assert.equal(l.light('t3', true), 1);
  assert.deepEqual(mesh.instanceColor!.updateRanges, [{ start: glow.index * 3, count: 3 }]);
  assert.equal(mesh.instanceColor!.getX(glow.index), 1);
  assert.equal((mesh.geometry.getAttribute('position') as THREE.BufferAttribute).version, version, 'no geometry touched');
});

test('models load nearest the camera first', () => {
  const { l, asked } = layer({ e_far: 'far', e_near: 'near' });
  l.set('f', 'e_far', at(500), box);
  l.set('n', 'e_near', at(20), box);
  l.update(new THREE.Vector3(0, 0, 0));
  assert.deepEqual(asked, ['near', 'far']);
});

test('copies: each thing drawn again one spacing further east', () => {
  const l = new ThingLayer({ index: indexOf({ kinds: [], things: { e_a: 'one' } }), fetch: () => new Promise(() => {}), copies: 2, spacing: 1000 });
  l.set('a', 'e_a', at(3), box);
  assert.equal(l.waiting, 2);
  assert.equal(new THREE.Vector3().setFromMatrixPosition(l.things.get('a#1')!.matrix).x, 1003);
  l.remove('a');
  assert.equal(l.waiting, 0);
});

// C12 (#3683) A2: parts drop detail with distance as today's WorldDistanceDetail: sub-pixel parts are not drawn, small
// far parts go to the batch that casts no shadow, big parts (a building's walls) stay; a light still switches.
test('A2: parts drop detail with distance: hidden under the pixel, no shadow far away, back when near', () => {
  const things = Object.fromEntries(Array.from({ length: SHARED }, (_, i) => [`e_${i}`, 'lamp']));
  const detail = { minRadiusPx: 1.25, shadowNear: 24, shadowPerMetre: 14, shadowMaxRadius: 6 };
  const l = new ThingLayer({ index: indexOf({ kinds: [], things: { ...things, e_house: 'house' } }), fetch: () => new Promise(() => {}), detail, view: () => ({ height: 844, fov: 50 }) });
  for (let i = 0; i < SHARED; i++) l.set(`t${i}`, `e_${i}`, at(i * 100), box);
  l.set('house', 'e_house', at(500), box);
  // a lamp's small glow part (radius ~0.087 m) and its post (~0.87 m); a house's wall part (radius ~17 m) and a sill (~0.17 m)
  const small = part(true), post = part(false), wall = part(false), sill = part(false);
  small.matrix = new THREE.Matrix4().makeScale(0.1, 0.1, 0.1);
  wall.matrix = new THREE.Matrix4().makeScale(20, 20, 20);
  sill.matrix = new THREE.Matrix4().makeScale(0.2, 0.2, 0.2);
  l.arrive('lamp', [post, small]);
  l.arrive('house', [wall, sill]);
  l.update(new THREE.Vector3(0, 0, 0));
  const band = (id: string, k: number) => l.things.get(id)!.slots[k].band;
  assert.deepEqual([band('t0', 0), band('t0', 1)], [NEAR, NEAR], 'at the eye: everything, with shadows');
  assert.equal(band('t1', 0), FAR, 'a post 100 m away casts no shadow (24 + 14·0.87 m)');
  assert.equal(band('t1', 1), HIDDEN, 'a 9 cm glass 100 m away is under 1.25 px on a phone');
  assert.equal(band('house', 0), NEAR, 'a house wall 500 m away is drawn with its shadow');
  assert.equal(band('house', 1), HIDDEN, 'its sill is not');
  const hidden = l.things.get('t1')!.slots[1];
  assert.equal(hidden.batch, null);
  assert.equal(l.light('t1', true), 1, 'a hidden light still switches');
  const far = l.things.get('t1')!.slots[0];
  assert.equal((far.batch as unknown as { mesh: THREE.InstancedMesh }).mesh.castShadow, false);
  assert.equal(l.stats.hidden, (SHARED - 1) + 1 + 1, 'every far lamp\'s glass, the sill, and the 700 m lamp\'s post (1.1 px)');
  // The eye walks up to the far lamp: its parts come back, lit, into the casting batch.
  for (let f = 0; f < 10; f++) l.update(new THREE.Vector3(100, 0, 1));
  assert.equal(band('t1', 0), NEAR);
  assert.equal(band('t1', 1), NEAR);
  const back = l.things.get('t1')!.slots[1], mesh = (back.batch as unknown as { mesh: THREE.InstancedMesh }).mesh;
  assert.ok(mesh.castShadow);
  assert.equal(mesh.instanceColor!.getX(back.index), 1, 'lit, as switched while hidden');
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(back.index, m);
  assert.equal(new THREE.Vector3().setFromMatrixPosition(m).x, 100, 'at its place');
});

test('hover: pick never lands on a thing whose every part distance detail hides', () => {
  const detail = { minRadiusPx: 1.25, shadowNear: 24, shadowPerMetre: 14, shadowMaxRadius: 6 };
  const l = new ThingLayer({ index: indexOf({ kinds: [], things: { e_a: 'cup' } }), fetch: () => new Promise(() => {}), detail, view: () => ({ height: 844, fov: 50 }) });
  l.set('a', 'e_a', at(100), box);
  const cup = part();
  cup.matrix = new THREE.Matrix4().makeScale(0.1, 0.1, 0.1);
  l.arrive('cup', [cup]);
  const pick = () => l.pick(new THREE.Vector3(100, 0.5, -5), new THREE.Vector3(0, 0, 1))?.id ?? null;
  l.update(new THREE.Vector3(0, 0, 0));
  assert.equal(l.things.get('a')!.slots[0].band, HIDDEN);
  assert.equal(pick(), null, 'a 9 cm cup 100 m away is not drawn, so not picked');
  for (let f = 0; f < 10; f++) l.update(new THREE.Vector3(100, 0, -3));
  assert.equal(l.things.get('a')!.slots[0].band, NEAR);
  assert.equal(pick(), 'a', 'near: drawn and picked');
});

test('A2: no detail, no bands (the measure\'s other arm and every test above)', () => {
  const l = new ThingLayer({ index: indexOf({ kinds: [], things: { e_a: 'one' } }), fetch: () => new Promise(() => {}), detail: null });
  l.set('a', 'e_a', at(5000), box);
  l.update(new THREE.Vector3(0, 0, 0));
  assert.equal(l.things.get('a')!.slots[0].band, NEAR);
});
