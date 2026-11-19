// The crowd (V6, #2715): the levels' clustering, and the page's bodies entering and leaving the crowd's arrays.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import type { BakedModel } from './bake.ts';
import { CrowdBodies } from './bodies.ts';
import { Crowd } from './crowd.ts';
import { cluster, type LodMesh } from './lod.ts';

/** A strip of `n` quads along x, 1 cm wide and 5 cm high, two triangles each. */
function strip(n: number): LodMesh {
  const v = (n + 1) * 2, pos = new Float32Array(v * 3), index: number[] = [];
  for (let i = 0; i <= n; i++) pos.set([i * 0.01, 0, 0, i * 0.01, 0.05, 0], i * 6);
  for (let i = 0; i < n; i++) index.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3);
  return {
    position: pos, normal: new Float32Array(v * 3), color: new Float32Array(v * 3),
    skinIndex: new Uint16Array(v * 4).map((_, k) => (k % 4 === 0 ? Math.floor(k / 8) : 0)), skinWeight: new Float32Array(v * 4).map((_, k) => (k % 4 === 0 ? 1 : 0)),
    index: new Uint32Array(index),
  };
}

test('clustering merges the vertices of a cell, drops collapsed triangles and keeps a vertex its skin', () => {
  const m = strip(10);
  assert.deepEqual(cluster(m, 0.001).index.length, m.index.length, 'a cell smaller than any edge changes nothing');
  const c = cluster(m, 0.035);
  assert.ok(c.index.length < m.index.length && c.index.length > 0);
  assert.equal(c.position.length / 3, Math.max(...c.index) + 1, 'only used vertices kept');
  for (let v = 0; v < c.position.length / 3; v++) {
    const from = [...Array(m.position.length / 3).keys()].find((u) => m.position[u * 3] === c.position[v * 3] && m.position[u * 3 + 1] === c.position[v * 3 + 1])!;
    assert.equal(c.skinIndex[v * 4], m.skinIndex[from * 4]);
  }
});

const model = (name: string): BakedModel => ({
  name, lods: [0, 1, 2].map(() => new THREE.BoxGeometry()), bones: 2, materials: 1, triangles: [12, 12, 12], height: 1.8,
  names: ['a', 'b'], parents: Int16Array.of(-1, 0), joints: new Float32Array(6),
  bake: new THREE.DataTexture(new Float32Array(2 * 3 * 4 * 4), 6, 4, THREE.RGBAFormat, THREE.FloatType),
  clips: [{ name: 'Idle', start: 0, frames: 2, seconds: 2 }, { name: 'Walk', start: 2, frames: 2, seconds: 1 }],
});

test('bodies enter the crowd when placed and leave it when a frame no longer places them', () => {
  const crowd = new Crowd([model('a'), model('b')], 2);
  const bodies = new CrowdBodies(crowd);
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 10, 30);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  bodies.begin(0);
  for (const [k, id] of ['p', 'q', 'r'].entries()) bodies.place(id, k, 0, 0);
  bodies.end(camera);
  assert.equal(crowd.count, 3, 'grown past its first capacity');
  assert.equal(crowd.stats.visible, 3);
  // q walks 1.5 m in a second of world time; p leaves.
  bodies.begin(1_000_000);
  bodies.place('q', 1, 0, 1.5);
  bodies.place('r', 2, 0, 0);
  bodies.end(camera);
  assert.equal(crowd.count, 2);
  const at = [...Array(crowd.count).keys()].map((i) => [crowd.x[i], crowd.z[i]]);
  assert.deepEqual(at.sort(), [[1, 1.5], [2, 0]], 'the bodies left are q and r, where they were placed');
  const iq = [...Array(crowd.count).keys()].find((i) => crowd.x[i] === 1)!;
  assert.ok(crowd.blend[iq] > 0.5, 'q walks');
  assert.ok(Math.abs(crowd.yaw[iq]) < 1e-6, 'q faces +z, the way it moved');
  assert.ok(crowd.stats.draws >= 1 && crowd.stats.draws <= 2 * 3, 'at most one draw per model per level');
});
