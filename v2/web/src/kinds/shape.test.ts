// Kinds drawn from their entries' shapes (#3871): every content kind builds, roles stay apart, `when` follows state,
// and the layer draws a thing once its kind's file arrives.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { kindEntryFiles } from '../../kind-entries.ts';
import { Catalogue, entryPath, type KindEntry } from './catalogue.ts';
import { KindLayer } from './layer.ts';
import { buildShape, when, whenKey } from './shape.ts';
import { kindState } from './state.ts';

const files = kindEntryFiles();
const entry = (name: string) => JSON.parse(files.get(`${name.replace(':', '/')}.json`)!) as KindEntry;
const roles = (g: THREE.Object3D) => g.children.filter((c) => c.userData.role).map((c) => c.userData.role as string);

test('every content kind with a shape builds in its default state, in metres, with something to draw', () => {
  let built = 0;
  for (const body of files.values()) {
    const e = JSON.parse(body) as KindEntry;
    const shape = e.looks?.shape;
    if (!shape?.shapes?.length) continue;
    const g = buildShape(shape, kindState(undefined, e.state ?? {}));
    const box = new THREE.Box3().setFromObject(g);
    if (shape.shapes.every((s) => s.when)) continue; // all of it depends on state
    assert.ok(!box.isEmpty(), e.kind);
    const size = box.getSize(new THREE.Vector3());
    assert.ok(Math.max(size.x, size.y, size.z) < 1000, `${e.kind}: ${size.toArray()} m`);
    built++;
  }
  assert.ok(built > 300, `${built} kinds built`);
});

test('a desk lamp: its body merged, its light and knob each a role, about half a metre tall', () => {
  const lamp = entry('eden:desk_lamp');
  const g = buildShape(lamp.looks!.shape!, { on: false });
  assert.deepEqual(roles(g).sort(), ['knob', 'light']);
  const h = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3()).y;
  assert.ok(h > 0.4 && h < 0.6, `${h} m`);
  const light = g.children.find((c) => c.userData.role === 'light')!;
  assert.ok(light.position.distanceTo(new THREE.Vector3(0, 0.4, 0.16)) < 1e-9, 'its pivot: the bulb');
  assert.ok(((light.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).emissiveIntensity > 0, 'the bulb glows');
});

test('a planter: soil, lid and weeds are roles the looks move', () => {
  const g = buildShape(entry('eden:planter').looks!.shape!, {});
  for (const r of ['fill', 'lid', 'blade']) assert.ok(roles(g).includes(r), r);
});

test('when: state terms as today (on, not on, a value, a list of values, a comparison)', () => {
  assert.equal(when('@on', { on: true }), true);
  assert.equal(when('!@on', { on: true }), false);
  assert.equal(when('@showing=sea|stars', { showing: 'stars' }), true);
  assert.equal(when('@dirt>=1', { dirt: 0 }), false);
  assert.equal(when('@dirt>=1 & !@on', { dirt: 2, on: false }), true);
  assert.equal(when('size=big', {}), true, 'a parameter term holds: an entry has no parameters');
  const look = { shapes: [{ kind: 'box', at: [0, 0, 0] as [number, number, number], when: '@on' }, { kind: 'box', at: [0, 0, 0] as [number, number, number] }] };
  assert.equal(whenKey(look, { on: true }), '1');
  assert.equal(whenKey(look, { on: false }), '0');
  assert.equal(buildShape(look, { on: false }).children.length, 1);
});

test('a node kind names its file; anything else has none', () => {
  assert.equal(entryPath('eden:desk_lamp@1220abcd'), 'assets/kinds/eden/desk_lamp.json');
  assert.equal(entryPath('eden:planter'), 'assets/kinds/eden/planter.json');
  assert.equal(entryPath('../x'), null);
});

test('the layer draws a thing once its kind arrives, tells the page, and redraws when its state changes what is drawn', async () => {
  const asked: string[] = [];
  const cat = new Catalogue('https://example.test/', async (url) => (asked.push(url), entry('eden:desk_lamp')));
  const told: string[] = [];
  const layer = new KindLayer(cat, (id) => told.push(id));
  const node = { id: 'a.1', kind: 'eden:desk_lamp@1220ab', parent: null, slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null } as never;
  layer.set(node, new THREE.Matrix4().makeTranslation(3, 0, 4));
  layer.set({ ...(node as object), id: 'a.2' } as never, new THREE.Matrix4());
  assert.equal(layer.has('a.1'), false, 'not before its kind arrives');
  await cat.entry('eden:desk_lamp');
  await Promise.resolve();
  assert.deepEqual(told, ['a.1', 'a.2']);
  assert.deepEqual(asked, ['https://example.test/assets/kinds/eden/desk_lamp.json'], 'one fetch per kind');
  assert.equal(layer.group.children.length, 2);
  assert.deepEqual(new THREE.Vector3().setFromMatrixPosition(layer.group.children[0].matrix).toArray(), [3, 0, 4]);
  layer.remove('a.2');
  assert.equal(layer.group.children.length, 1);
});

test('a thing of a kind with no shape is not drawn here: its stand-in stays', async () => {
  const cat = new Catalogue('https://example.test/', async () => ({ kind: 'eden:x', state: {} }));
  const layer = new KindLayer(cat);
  layer.set({ id: 'b.1', kind: 'eden:x', parent: null, slot: null, pos: [0, 0, 0], rot: [1, 0, 0, 0], at: null } as never, new THREE.Matrix4());
  await cat.entry('eden:x');
  await Promise.resolve();
  assert.equal(layer.has('b.1'), false);
});
