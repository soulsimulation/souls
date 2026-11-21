// C9 (#3680): trees, plants and cloth sway with the world's wind, as today's `atmosphere/wind.ts`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { WIND, patchWind, setWind, visualWind, windModeOf, windStrength, windWeights } from './wind.ts';

/** One merged mesh of boxes (non-indexed, as V17's kit models are), each `[w, h, d, x, y, z]` in m. */
function merged(boxes: number[][]): THREE.BufferGeometry {
  const pos: number[] = [];
  for (const [w, h, d, x, y, z] of boxes) {
    const b = new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();
    pos.push(...(b.getAttribute('position').array as Float32Array));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return g;
}
const range = (w: Float32Array, from: number, to: number) => {
  const s = Array.from(w.subarray(from, to));
  return [Math.min(...s), Math.max(...s)];
};
const BOX = 36; // vertices of one non-indexed box

test('A1: plants by their kit material, cloth by its kind, as today names them', () => {
  assert.equal(windModeOf('kit plant trunk', 'core-tree'), 'trunk');
  assert.equal(windModeOf('kit plant foliage', 'core-tree'), 'crown');
  assert.equal(windModeOf('kit plant foliage', 'core-leaf-litter'), null, 'litter on the ground stays, as today');
  assert.equal(windModeOf('', 'core-flagpole'), 'flag');
  assert.equal(windModeOf('', 'eden-golf-flag'), 'flag');
  assert.equal(windModeOf('', 'core-laundry-line'), 'hang');
  assert.equal(windModeOf('', 'eden-bunting'), 'hang');
  assert.equal(windModeOf('', 'core-banner'), 'hang');
  assert.equal(windModeOf('building wall ashlar', 'core-house'), null);
  assert.equal(windModeOf('', 'core-bench'), null);
});

test('A1: a flag sways from its pole; the pole, its base and finial stay', () => {
  // core-flagpole's shape: base, pole, finial, and a 1.2 m flag 2 cm thick beside the pole near the top.
  const g = merged([[0.6, 0.2, 0.6, 0, 0.1, 0], [0.1, 8, 0.12, 0, 4.1, 0], [0.18, 0.18, 0.18, 0, 8.15, 0], [1.2, 0.75, 0.02, 0.62, 7.5, 0]]);
  const w = windWeights(g, new THREE.Matrix4(), 'flag')!;
  assert.deepEqual(range(w, 0, 3 * BOX), [0, 0], 'rigid parts do not move');
  const [lo, hi] = range(w, 3 * BOX, 4 * BOX);
  assert.ok(Math.abs(lo) < 1e-6 && Math.abs(hi - 1) < 1e-6, `flag pinned at the pole, free at the fly: ${lo}..${hi}`);
  for (let i = 3 * BOX; i < 4 * BOX; i++) {
    const x = g.getAttribute('position').getX(i);
    assert.ok(x < 0.1 ? w[i] === 0 : w[i] > 0.99, 'the pole side is the pinned edge');
  }
});

test('A1: washing hangs from its line; the posts and the line stay', () => {
  const g = merged([[0.08, 1.9, 0.08, -1.8, 0.95, 0], [0.08, 1.9, 0.08, 1.8, 0.95, 0], [3.6, 0.02, 0.02, 0, 1.8, 0], [0.5, 0.6, 0.02, 0, 1.49, 0]]);
  const w = windWeights(g, new THREE.Matrix4(), 'hang')!;
  assert.deepEqual(range(w, 0, 3 * BOX), [0, 0]);
  for (let i = 3 * BOX; i < 4 * BOX; i++) {
    const y = g.getAttribute('position').getY(i);
    assert.equal(w[i], y > 1.7 ? 0 : 1, 'pinned at the top, free at the bottom');
  }
});

test('A1: a rope strung between posts stays even when it sags (bunting); its pennants sway', () => {
  const g = merged([[10, 0.45, 0.027, 0, 2.8, 0], [0.41, 0.4, 0.08, 1, 2.5, 0]]);
  const w = windWeights(g, new THREE.Matrix4(), 'hang')!;
  assert.deepEqual(range(w, 0, BOX), [0, 0]);
  assert.deepEqual(range(w, BOX, 2 * BOX), [0, 1]);
});

test('A1: nothing that sways, no weights (a rigid model keeps its plain material)', () => {
  assert.equal(windWeights(merged([[0.1, 3, 0.1, 0, 1.5, 0]]), new THREE.Matrix4(), 'flag'), null);
});

test('A1: a plant bends from its root, by height in the model\'s frame', () => {
  const g = merged([[0.3, 4, 0.3, 0, 2, 0]]);
  const w = windWeights(g, new THREE.Matrix4().makeTranslation(0, 0.5, 0), 'trunk')!;
  assert.deepEqual(range(w, 0, BOX), [0.5, 4.5]);
});

test('A2: stronger weather strengthens the sway; still air leaves it near still; reduced motion holds it', () => {
  const at = (wind: number) => windStrength(100, wind);
  assert.equal(at(0), 0.15, 'still air: today\'s faint 0.15');
  for (let k = 1; k <= 10; k++) assert.ok(at(k / 10) >= at((k - 1) / 10) - 0.06, `no drop from ${(k - 1) / 10} to ${k / 10}`);
  assert.ok(at(0.36) > 2 * at(0), 'a breezy day sways at least twice still air');
  assert.ok(at(1) >= 0.15 + 0.75 * 0.95, 'a gale sways at least as hard as 0.75 wind');
  assert.equal(windStrength(100, 1, true), 0, 'reduced motion');
  // Above 0.75 the wind comes in heavy and light spells, repeatable at the same world time.
  const spells = Array.from({ length: 200 }, (_, i) => visualWind(i * 7, 1));
  assert.ok(Math.min(...spells) < 0.9 && Math.max(...spells) > 0.95, 'gusty spells in a gale');
  assert.equal(visualWind(1234.5, 0.9), visualWind(1234.5, 0.9));
});

test('A1: one shared uniform: wrapped world time, strength and a unit direction for the day', () => {
  setWind(7200 * 3 + 12.5, 0.5, 1, false);
  assert.equal(WIND.value.x, 12.5);
  assert.equal(WIND.value.y, windStrength(7200 * 3 + 12.5, 0.5));
  assert.ok(Math.abs(Math.hypot(WIND.value.z, WIND.value.w) - 1) < 1e-9);
  setWind(0, 0.5, 1, false);
  assert.ok(Math.abs(Math.atan2(WIND.value.w, WIND.value.z) - 1) < 1e-9, 'the day\'s bearing at time 0');
});

test('A3: the sway is a vertex-stage patch reading the shared uniform; other hooks are kept', () => {
  const m = new THREE.MeshStandardMaterial();
  let before = 0;
  m.onBeforeCompile = () => void before++;
  const key = m.customProgramCacheKey();
  patchWind(m, 'crown');
  const shader = { uniforms: {} as Record<string, { value: unknown }>, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  m.onBeforeCompile(shader as never, null as never);
  assert.equal(before, 1);
  assert.equal(shader.uniforms.uEdenWind, WIND);
  assert.match(shader.vertexShader, /attribute float edenWind;/);
  assert.match(shader.vertexShader, /#include <begin_vertex>\n+vEdenGust=0\.0;/);
  assert.match(shader.vertexShader, /USE_BATCHING/, 'batched one-off shapes sway from their own instance');
  assert.match(shader.fragmentShader, /vEdenGust\*\.12/, 'today\'s gust sheen on crowns');
  assert.notEqual(m.customProgramCacheKey(), key);
  const cloth = new THREE.MeshStandardMaterial();
  patchWind(cloth, 'flag');
  assert.notEqual(cloth.customProgramCacheKey(), m.customProgramCacheKey());
});
