// V8 (#2718): a thing is a box until its model arrives, then drawn from it; a light writes one colour slot; models
// load nearest first.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { indexOf, type Part } from './models.ts';
import { SHARED, ThingLayer } from './things.ts';

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
