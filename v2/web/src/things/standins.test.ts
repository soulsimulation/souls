// #3786: far scattered things drawn as flat stand-ins, as today's WorldFarStandIns on a phone: a shared model's small
// part under 7 CSS pixels of radius becomes a camera-facing card of its own snapshot, with no shadow, and a model again
// as the camera nears; see-through parts, buildings and parts that cannot be photographed keep their detail.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { indexOf, type Part } from './models.ts';
import { CARD, FAR, HIDDEN, NEAR, ThingLayer } from './things.ts';
import { PHONE_STAND_INS, cardMatrix } from './standins.ts';
import { PHONE_DETAIL, standInsFor } from '../draw/quality-tier.ts';

const at = (x: number) => new THREE.Matrix4().makeTranslation(x, 0, 0);
/** A tree's crown: a sphere of radius 1 m standing on the ground (80 triangles). */
const crown = (material: THREE.Material = new THREE.MeshStandardMaterial()): Part => {
  const geometry = new THREE.SphereGeometry(1, 8, 6).translate(0, 1, 0);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(geometry.getAttribute('position').count * 3).fill(1), 3));
  return { geometry, material, matrix: new THREE.Matrix4(), key: 'k', glow: false };
};

function wood(n: number, snapshot: (() => THREE.Texture | null) | null, model = 'tree') {
  const things = Object.fromEntries(Array.from({ length: n }, (_, i) => [`e_${i}`, model]));
  const shots: number[] = [];
  const l = new ThingLayer({
    index: indexOf({ kinds: [], things }), fetch: () => new Promise(() => {}), detail: PHONE_DETAIL, standins: PHONE_STAND_INS,
    ...(snapshot ? { snapshot: () => (shots.push(1), snapshot()) } : {}), view: () => ({ height: 844, fov: 50 }),
  });
  // Trees 10, 60, 110, ... m east of the eye.
  for (let i = 0; i < n; i++) l.set(`t${i}`, `e_${i}`, at(10 + i * 50), new THREE.Matrix4());
  return { l, shots };
}
const band = (l: ThingLayer, id: string) => l.things.get(id)!.slots[0].band;

test('A1: a far tree is a card past 7 px, with no shadow, at its footprint; near, a model with its shadow again', () => {
  const { l, shots } = wood(12, () => new THREE.Texture());
  l.arrive('tree', [crown()]);
  l.update(new THREE.Vector3(0, 0, 0));
  // Radius 1 m (the crown's sphere): 7 px at about 130 m on a phone's 844 px; under 1.25 px past about 700 m.
  assert.equal(band(l, 't0'), NEAR, 'a tree 10 m away');
  assert.equal(band(l, 't2'), FAR, '110 m: still a model, over 7 px (with no shadow, C12)');
  assert.equal(band(l, 't5'), CARD, '260 m: a card');
  assert.equal(band(l, 't11'), CARD, '560 m: a card');
  assert.equal(band(l, 't3'), CARD, '160 m: a card');
  assert.equal(shots.length, 1, 'one snapshot for the part, shared by every card');
  const s = l.things.get('t5')!.slots[0], mesh = (s.batch as unknown as { mesh: THREE.InstancedMesh }).mesh;
  assert.equal(mesh.castShadow, false);
  assert.equal(mesh.receiveShadow, false);
  assert.equal(mesh.geometry.getAttribute('position').count, 4, 'two triangles');
  const m = new THREE.Matrix4();
  mesh.getMatrixAt(s.index, m);
  assert.deepEqual(m.toArray(), cardMatrix(s.part!.geometry.boundingBox!, s.matrix).toArray());
  assert.equal(new THREE.Vector3().setFromMatrixPosition(m).x, 260, 'on the tree\'s footprint');
  assert.equal(l.stats.cards, 9, '160 m and beyond');
  // The eye walks to the far end: those trees are models again, the near ones become cards.
  for (let f = 0; f < 10; f++) l.update(new THREE.Vector3(560, 0, 1));
  assert.equal(band(l, 't11'), NEAR);
  assert.ok((l.things.get('t11')!.slots[0].batch as unknown as { mesh: THREE.InstancedMesh }).mesh.castShadow);
  assert.equal(band(l, 't0'), CARD);
});

test('A1: what keeps its detail: see-through parts, too few things, no picture, or no stand-ins (a desktop)', () => {
  const glass = wood(12, () => new THREE.Texture(), 'glass');
  glass.l.arrive('glass', [crown(new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 }))]);
  glass.l.update(new THREE.Vector3(0, 0, 0));
  assert.notEqual(band(glass.l, 't11'), CARD);
  const few = wood(11, () => new THREE.Texture());
  few.l.arrive('tree', [crown()]);
  few.l.update(new THREE.Vector3(0, 0, 0));
  assert.notEqual(band(few.l, 't10'), CARD, 'today\'s 12 instances at least');
  const blank = wood(12, () => null);
  blank.l.arrive('tree', [crown()]);
  for (let f = 0; f < 3; f++) blank.l.update(new THREE.Vector3(0, 0, 0));
  assert.notEqual(band(blank.l, 't11'), CARD);
  assert.equal(blank.shots.length, 1, 'a part that cannot be photographed is not tried again');
  const none = wood(12, null);
  none.l.arrive('tree', [crown()]);
  none.l.update(new THREE.Vector3(0, 0, 0));
  assert.equal(none.l.standins, null);
  assert.notEqual(band(none.l, 't11'), CARD);
  assert.equal(standInsFor('full'), null, 'a desktop draws no cards, as today');
  assert.equal(standInsFor('phone'), PHONE_STAND_INS);
  assert.equal(standInsFor('phone', '?cards=0'), null);
  assert.equal(standInsFor('phone', '?detail=0'), null);
});

test('A1: a card still hides under the pixel, switches its light, and follows its thing when it moves', () => {
  const { l } = wood(12, () => new THREE.Texture());
  l.arrive('tree', [crown()]);
  l.update(new THREE.Vector3(0, 0, 0));
  const s = l.things.get('t5')!.slots[0];
  assert.equal(s.band, CARD);
  l.move('t5', at(300));
  const m = new THREE.Matrix4();
  (s.batch as unknown as { mesh: THREE.InstancedMesh }).mesh.getMatrixAt(s.index, m);
  assert.equal(new THREE.Vector3().setFromMatrixPosition(m).x, 300);
  for (let f = 0; f < 10; f++) l.update(new THREE.Vector3(-2000, 0, 0));
  assert.equal(band(l, 't5'), HIDDEN, 'two kilometres off: under 1.25 px');
});
