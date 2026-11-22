// Looks applied to parts (#3871): a lamp lights and darkens, a planter's plants grow and wilt, parts show and hide.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { kindEntryFiles } from '../../kind-entries.ts';
import { Catalogue, type KindEntry } from './catalogue.ts';
import { KindLayer } from './layer.ts';

const files = kindEntryFiles();
const entry = (name: string) => JSON.parse(files.get(`${name.replace(':', '/')}.json`)!) as KindEntry;
const part = (g: THREE.Object3D, role: string) => g.children.find((c) => c.userData.role === role)!;
const mat = (o: THREE.Object3D) => (o.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
const node = (id: string, kind: string, fields: Record<number, unknown>) => ({ id, kind, parent: null, slot: null, pos: [0, 0, 0], rot: [1 << 30, 0, 0, 0], at: null, fields }) as never;

async function drawn(kind: string, fields: Record<number, unknown>) {
  const cat = new Catalogue('https://example.test/', async () => entry(kind));
  const layer = new KindLayer(cat);
  const seen: string[] = [];
  layer.onLooks.push((id) => seen.push(id));
  layer.set(node('t.1', `${kind}@1220ab`, fields), new THREE.Matrix4());
  await cat.entry(kind);
  await Promise.resolve();
  return { layer, seen, at: (fields: Record<number, unknown>, t: number | null = null) => (layer.set(node('t.1', `${kind}@1220ab`, fields), new THREE.Matrix4()), layer.draw(t), layer.picture('t.1')!) };
}

test('a desk lamp switched on glows warm; switched off its bulb is dark and grey', async () => {
  const { layer, seen, at } = await drawn('eden:desk_lamp', { 28: 0 });
  const off = mat(part(layer.picture('t.1')!, 'light'));
  assert.equal(off.emissiveIntensity, 0);
  assert.equal(off.color.getHexString(), '6b665e');
  const on = mat(part(at({ 28: 1 }), 'light'));
  assert.ok(on.emissiveIntensity > 0.5, `${on.emissiveIntensity}`);
  assert.equal(on.color.getHexString(), 'ffe2a8');
  assert.ok(mat(part(at({ 28: 0 }), 'light')).emissiveIntensity === 0, 'and off again');
  assert.deepEqual(seen, ['t.1', 't.1', 't.1'], 'the hook runs each time the looks change');
  layer.draw(null);
  assert.equal(seen.length, 3, 'and not when nothing changed');
});

test('a planter: its plants grow with its stage and wilt as its water runs out; its lid and weeds show by state', async () => {
  const water = (value: number) => ({ value, per_s: -5, set_us: 0 });
  const { layer, at } = await drawn('eden:planter', { 28: water(1_000_000), 29: 'bare', 32: 0, 33: 0 });
  const plants = () => layer.picture('t.1')!.children.find((c) => c.name === 'plant growth') as THREE.Group & { userData: { look?: { g: number; w: number } } };
  layer.draw(0);
  assert.equal(plants(), undefined, 'bare: nothing grows');
  assert.equal(part(layer.picture('t.1')!, 'lid').visible, false, 'no tray');
  assert.equal(part(layer.picture('t.1')!, 'blade').visible, false, 'no weeds');
  at({ 28: water(2_000_000), 29: 'leafy', 32: 1, 33: 1 }, 0);
  assert.equal(plants().visible, true);
  assert.deepEqual(plants().userData.look, { g: 2, w: 0, m: 1 });
  assert.equal(part(layer.picture('t.1')!, 'lid').visible, true);
  assert.equal(part(layer.picture('t.1')!, 'blade').visible, true);
  at({ 28: water(2_000_000), 29: 'fruiting', 32: 1, 33: 1 }, 0);
  assert.equal(plants().userData.look!.g, 4);
  // dry: the water falls 5 mg a second from 680000 mg; 400000 s later it is empty and the plants hang
  at({ 28: { value: 680_000, per_s: -5, set_us: 0 }, 29: 'fruiting', 32: 1, 33: 1 }, 0);
  const half = plants().userData.look!.w;
  layer.draw(400_000 * 1_000_000);
  assert.ok(half > 0.4 && half < 0.6, `half wilted: ${half}`);
  assert.equal(plants().userData.look!.w, 1, 'wilted once dry, with nothing sent: the timed water read at the time drawn');
});

test('a big wheel set under way turns its wheel over the time its looks say, then holds; a carousel the same', async () => {
  for (const [kind, axis, deg, over] of [['eden:big_wheel', 'z', 22.5, 4_687_500], ['eden:carousel', 'y', 90, 3_750_000]] as const) {
    const { layer, at } = await drawn(kind, { 28: 0 });
    layer.draw(1_000_000);
    const turn = () => (part(layer.picture('t.1')!, 'wheel').rotation[axis] * 180) / Math.PI;
    assert.equal(turn(), 0);
    at({ 28: 1 }, 2_000_000);
    assert.equal(turn(), 0, `${kind}: it starts where it was`);
    layer.draw(2_000_000 + over / 2);
    assert.ok(Math.abs(turn() - deg / 2) < 0.01, `${kind}: half way: ${turn()}`);
    layer.draw(2_000_000 + over * 2);
    assert.ok(Math.abs(turn() - deg) < 0.01, `${kind}: all the way: ${turn()}`);
  }
});
