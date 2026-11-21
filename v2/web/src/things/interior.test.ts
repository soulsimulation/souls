// C10 (#3681): a generated building's interior view as today's (`attachInteriorView`), and its lit windows' rooms as
// today's (`building-windows.ts`, pinned in `today-windows.json`).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as THREE from 'three';
import { indexOf, type Part } from './models.ts';
import { buildingView, decide, hidden, storeyOf } from './interior.ts';
import { ThingLayer } from './things.ts';
import { EDEN_ROOM_GLSL, PANE_GLSL, isNightGlass, nightWindows, setWindowLife, windowLife, windowsLitAt } from './windows.ts';

const TODAY = JSON.parse(readFileSync(new URL('./today-windows.json', import.meta.url), 'utf8'));

/** A two-storey building as the bake writes one (8 x 6 m, storeys of 3 m, a gable roof to 5.8 m), turned `yaw`. */
function building(yaw = 0): Part[] {
  const root = new THREE.Group(), inner = new THREE.Group();
  root.name = 'building';
  inner.name = 'building-canonical';
  inner.rotation.y = yaw;
  root.add(inner);
  const box = (group: string, layer: string, y0: number, y1: number, half = [4, 3]) => {
    let g = inner.getObjectByName(group);
    if (!g) (g = new THREE.Group(), (g.name = group), inner.add(g));
    const geo = new THREE.BoxGeometry(2 * half[0], y1 - y0, 2 * half[1]).translate(0, (y0 + y1) / 2, 0);
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
    mesh.name = `${group}_${layer}`;
    g.add(mesh);
  };
  box('level-0', 'floor', 0, 0.1);
  box('level-0', 'wall', 0, 3);
  box('slab-1', 'floor', 2.92, 3.1);
  box('level-1', 'wall', 3, 6);
  box('slab-2', 'wall', 5.9, 6.02);
  box('roof', 'roof', 6, 8.8, [4.3, 3.3]);
  root.updateMatrixWorld(true);
  const parts: Part[] = [];
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) parts.push({ geometry: m.geometry, material: m.material as THREE.Material, matrix: m.matrixWorld.clone(), key: m.name, glow: false, storey: storeyOf(m)! });
  });
  return parts;
}

test('A1: the bake\'s groups read back as storeys, and the layout from their bounds', () => {
  const parts = building();
  assert.deepEqual(parts.map((p) => [p.key, p.storey!.level, p.storey!.slab, p.storey!.wall]), [
    ['level-0_floor', 0, false, false], ['level-0_wall', 0, false, true], ['slab-1_floor', 1, true, false],
    ['level-1_wall', 1, false, true], ['slab-2_wall', 2, true, true], ['roof_roof', Infinity, false, false],
  ]);
  const v = buildingView(parts, new THREE.Matrix4().makeTranslation(100, 2, 50))!;
  assert.deepEqual([v.halfX, v.halfZ, v.fh, v.floors, v.top].map((x) => Math.round(x * 100) / 100), [4.3, 3.3, 3, 2, 8.8]);
  assert.equal(storeyOf(new THREE.Mesh()), null, 'a thing that is not a generated building has no storeys');
});

test('A1: today\'s decision: inside the footprint the roof and the storeys above the camera go, its ceiling stays', () => {
  const at = new THREE.Matrix4().makeTranslation(100, 2, 50);
  const v = buildingView(building(), at)!;
  const eye = (x: number, y: number, z: number) => new THREE.Vector3(100 + x, 2 + y, 50 + z);
  assert.deepEqual(decide(v, eye(10, 1.6, 0)), { hideRoof: false, hideAbove: Infinity, keepSlab: -1 }, 'outside');
  assert.deepEqual(decide(v, eye(1, 1.6, 1)), { hideRoof: true, hideAbove: 0, keepSlab: 1 }, 'ground floor, eye level');
  assert.deepEqual(decide(v, eye(1, 4.6, 1)), { hideRoof: true, hideAbove: 1, keepSlab: 2 }, 'first floor');
  assert.deepEqual(decide(v, eye(1, 9, 1)), { hideRoof: false, hideAbove: Infinity, keepSlab: -1 }, 'above the roof');
  assert.deepEqual(decide(v, eye(10, 1.6, 0), true, 0), { hideRoof: true, hideAbove: 0, keepSlab: -1 }, '?hideRoofs=1&cut=0');
  const c = decide(v, eye(1, 1.6, 1)), s = (level: number, slab = false) => hidden({ level, slab, wall: false, inner: new THREE.Matrix4() }, c, v.floors);
  assert.deepEqual([s(0), s(1, true), s(1), s(2, true), s(Infinity)], [false, false, true, true, true]);
  // turned a quarter: the long side runs along z
  const turned = buildingView(building(Math.PI / 2), at)!;
  assert.equal(decide(turned, eye(0, 1.6, 3.9)).hideRoof, true);
  assert.equal(decide(turned, eye(3.9, 1.6, 0)).hideRoof, false);
});

test('A1: the layer hides a building\'s roof, upper storey and its furniture while the camera is inside, and shows them after', () => {
  const l = new ThingLayer({ index: indexOf({ kinds: [], things: { e_hall: 'hall', e_up: 'chair', e_down: 'chair' } }), fetch: () => new Promise(() => {}) });
  const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
  l.set('hall', 'e_hall', at(100, 0, 50), null);
  l.set('up', 'e_up', at(101, 3.1, 50), null); // a chair on the first floor
  l.set('down', 'e_down', at(101, 0.1, 50), null); // and one on the ground floor
  l.arrive('hall', building());
  const chair = new THREE.BoxGeometry(0.5, 0.9, 0.5);
  chair.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(chair.getAttribute('position').count * 3).fill(1), 3));
  l.arrive('chair', [{ geometry: chair, material: new THREE.MeshStandardMaterial(), matrix: new THREE.Matrix4(), key: 'c', glow: false }]);
  const shown = (id: string) => l.things.get(id)!.slots.map((s) => {
    const mesh = (s.batch as unknown as { mesh: THREE.BatchedMesh | THREE.InstancedMesh }).mesh;
    if ((mesh as THREE.BatchedMesh).isBatchedMesh) return (mesh as THREE.BatchedMesh).getVisibleAt(s.index);
    const m = new THREE.Matrix4();
    (mesh as THREE.InstancedMesh).getMatrixAt(s.index, m);
    return m.determinant() !== 0;
  });
  assert.equal(l.interior(new THREE.Vector3(120, 1.6, 50)), 0, 'outside: nothing to decide');
  assert.deepEqual(shown('hall'), [true, true, true, true, true, true]);
  assert.equal(l.interior(new THREE.Vector3(100.5, 1.6, 50.5)), 1);
  assert.deepEqual(shown('hall'), [true, true, true, false, false, false], 'roof, first-floor walls and the top slab hidden; ground floor and its ceiling kept');
  assert.deepEqual([shown('up'), shown('down')], [[false], [true]], 'the first floor\'s chair goes with its storey');
  assert.equal(l.interior(new THREE.Vector3(100.5, 1.6, 50.5)), 0, 'the same camera decides nothing new');
  l.interior(new THREE.Vector3(130, 1.6, 50));
  assert.deepEqual([shown('hall').every(Boolean), shown('up'), shown('down')], [true, [true], [true]], 'outside again: all shown');
});

test('hover: pick never lands on furniture a building\'s interior view hides', () => {
  const l = new ThingLayer({ index: indexOf({ kinds: [], things: { e_hall: 'hall', e_up: 'chair', e_down: 'chair' } }), fetch: () => new Promise(() => {}) });
  const at = (x: number, y: number, z: number) => new THREE.Matrix4().makeTranslation(x, y, z);
  const seat = new THREE.Matrix4().makeScale(0.5, 0.9, 0.5);
  l.set('hall', 'e_hall', at(100, 0, 50), null);
  l.set('up', 'e_up', at(101, 3.1, 50), seat); // a chair on the first floor
  l.set('down', 'e_down', at(101, 0.1, 50), seat); // and one on the ground floor
  l.arrive('hall', building());
  const east = new THREE.Vector3(0, 0, 1);
  const pick = (y: number) => l.pick(new THREE.Vector3(101, y, 45), east)?.id ?? null;
  assert.deepEqual([pick(3.5), pick(0.5)], ['up', 'down'], 'outside: both chairs');
  l.interior(new THREE.Vector3(100.5, 1.6, 50.5));
  assert.deepEqual([pick(3.5), pick(0.5)], [null, 'down'], 'inside: the first floor\'s chair is hidden, so not picked');
  l.interior(new THREE.Vector3(130, 1.6, 50));
  assert.equal(pick(3.5), 'up', 'outside again: picked again');
});

test('A2: the lit windows\' room and glass shaders are today\'s, byte for byte, and switch on by today\'s curve', () => {
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  assert.equal(sha(EDEN_ROOM_GLSL), TODAY.roomGlsl);
  assert.equal(sha(PANE_GLSL), TODAY.paneGlsl);
  for (const [h, v] of TODAY.litAt) assert.equal(windowsLitAt(h), v, `hour ${h}`);
  setWindowLife(null, 0);
  assert.equal(windowLife().x, 0.6, 'no hour yet: today\'s 0.6');
  setWindowLife(20, 3700);
  assert.deepEqual([windowLife().x, windowLife().y], [windowsLitAt(20), 100]);
});

test('A2: the glass is patched once, only where the night lighting is installed', () => {
  const glass = new THREE.MeshStandardMaterial({ transparent: true });
  glass.name = 'building window glass (night rooms)';
  assert.ok(isNightGlass(glass) && !isNightGlass(new THREE.MeshStandardMaterial()));
  nightWindows(glass);
  const shader = () => ({ uniforms: {} as Record<string, unknown>, vertexShader: 'void main() {\n#include <begin_vertex>\n}', fragmentShader: 'void main() {\n#include <emissivemap_fragment>\n}' });
  const plain = shader();
  glass.onBeforeCompile(plain as never, null!);
  assert.equal(plain.vertexShader, shader().vertexShader, 'no night lighting: plain glass');
  const lit = { ...shader(), uniforms: { uEdenNight: { value: {} } } as Record<string, unknown> };
  glass.onBeforeCompile(lit as never, null!);
  assert.ok(lit.uniforms.uEdenWindows);
  assert.ok(lit.vertexShader.includes('attribute vec4 edenPane;') && lit.vertexShader.includes('mat3(batchingMatrix)') && lit.vertexShader.includes('mat3(instanceMatrix)'));
  assert.ok(lit.fragmentShader.includes(EDEN_ROOM_GLSL) && lit.fragmentShader.includes(PANE_GLSL));
});
