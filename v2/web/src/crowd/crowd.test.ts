// The crowd (V6, #2715): the levels' clustering, and the page's bodies entering and leaving the crowd's arrays.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import type { BakedModel } from './bake.ts';
import { CrowdBodies } from './bodies.ts';
import { Crowd } from './crowd.ts';
import { cluster, simplify, type LodMesh } from './lod.ts';

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
    assert.ok([...Array(m.position.length / 3).keys()].some((from) =>
      m.skinIndex.slice(from * 4, from * 4 + 4).every((value, k) => value === c.skinIndex[v * 4 + k]) &&
      m.skinWeight.slice(from * 4, from * 4 + 4).every((value, k) => value === c.skinWeight[v * 4 + k])));
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

test('body hash loading is single-flight, preserves model-specific clips and never substitutes for unknown hashes', async () => {
  const crowd = new Crowd([model('default')], 1), bodies = new CrowdBodies(crowd);
  let requests = 0;
  crowd.worn = async (hash) => { requests++; if (hash === 'unknown') throw Error('body.unknown-hash'); const m = model(hash); m.clips.reverse(); m.clips[0].seconds = 4; m.fixedWalk = true; return m; };
  bodies.begin(0); bodies.place('one', 0, 0, 0, 'known'); bodies.place('two', 0, 0, 0, 'known');
  assert.equal(crowd.ready[0], 0); assert.equal(requests, 1);
  await Promise.resolve();
  bodies.begin(1); bodies.place('one', 0, 0, 0, 'known'); bodies.place('two', 0, 0, 0, 'known');
  assert.equal(crowd.ready[0], 1); assert.equal(crowd.models[crowd.model[0]].name, 'known');
  assert.equal(crowd.clipA[0], 1); assert.equal(crowd.clipB[0], 0); assert.equal(crowd.rateB[0], 1 / 4, 'rigid motion keeps its authored period');
  bodies.begin(2); bodies.place('one', 0, 0, 0, 'unknown'); await Promise.resolve();
  assert.equal(crowd.ready[0], 0); assert.equal(crowd.bodyLoads.get('unknown')?.reason, 'body.unknown-hash');
  bodies.place('one', 0, 0, 0); assert.equal(crowd.models[crowd.model[0]].name, 'default'); assert.equal(crowd.ready[0], 1);
});

test('material batches retain UV seams and actual maps while capacity growth removes every old batch', async () => {
  const { merge, geometry } = await import('./bake.ts');
  const root = new THREE.Group(), map = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  const red = new THREE.MeshStandardMaterial({ color: 0xff0000, map }), blue = new THREE.MeshStandardMaterial({ color: 0x0000ff });
  root.add(new THREE.Mesh(new THREE.BoxGeometry(), [red, blue, red, blue, red, blue]));
  const merged = merge({ scene: root } as any);
  assert.equal(merged.sourceMaterials[0], red); assert.equal(merged.sourceMaterials[1], blue); assert.ok(merged.mesh.uv?.some((v) => v === 1));
  const geo = geometry(merged.mesh), m = model('textured'); m.lods = [geo, geo, geo]; m.sourceMaterials = merged.sourceMaterials;
  const crowd = new Crowd([m], 1), count = crowd.group.children.length;
  assert.ok(count > 3); crowd.add(0); crowd.add(0); assert.equal(crowd.group.children.length, count);
  for (const child of crowd.group.children) assert.ok((child as THREE.InstancedMesh).material instanceof THREE.MeshStandardMaterial);
  const materials = crowd.group.children.map((child) => (child as THREE.InstancedMesh).material as THREE.MeshStandardMaterial);
  assert.ok(materials.some((material) => material.map === map)); assert.ok(materials.some((material) => material.color.getHex() === 0xff0000));
  const large = { ...strip(1), material: new Uint16Array(4), index: Uint32Array.from({ length: 300_000 }, (_, i) => i % 3) };
  const complete = geometry(large);
  assert.equal(complete.index!.count, large.index.length);
  assert.deepEqual(complete.groups, [{ start: 0, count: large.index.length, materialIndex: 0 }]);
  for (let i = 0; i < large.index.length; i++) assert.equal(complete.index!.getX(i), large.index[i]);
});

test('CMESH2 retains textured material seams and legacy CMESH1 remains byte-compatible', async () => {
  const { encodeMesh, decodeMesh } = await import('./lod.ts');
  const original = strip(4), legacy = encodeMesh(original); assert.equal(new TextDecoder().decode(legacy.slice(0, 6)), 'CMESH1');
  assert.deepEqual(encodeMesh(decodeMesh(legacy)), legacy);
  const textured = { ...original, uv: new Float32Array(original.position.length / 3 * 2).map((_, i) => i % 2), material: new Uint16Array(original.position.length / 3).fill(1) };
  const encoded = encodeMesh(textured); assert.equal(new TextDecoder().decode(encoded.slice(0, 6)), 'CMESH2');
  assert.deepEqual(decodeMesh(encoded), textured); assert.ok(cluster(textured, 0.015).uv); assert.ok(cluster(textured, 0.015).material?.every((m) => m === 1));
  const seam: LodMesh = {
    position: Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, -1, 0),
    normal: new Float32Array(18).fill(1), color: new Float32Array(18).fill(0.5),
    uv: Float32Array.of(0, 0, 1, 0, 0, 1, 0.8, 0.7, 0, 0, 1, 1), material: Uint16Array.of(0, 0, 0, 1, 1, 1),
    skinIndex: new Uint16Array(24), skinWeight: new Float32Array(24).map((_, i) => i % 4 === 0 ? 1 : 0),
    index: Uint32Array.of(0, 1, 2, 3, 4, 5),
  };
  const clustered = cluster(seam, 0.001);
  const at = [...Array(clustered.position.length / 3).keys()].filter((i) => clustered.position[i * 3] === 0 && clustered.position[i * 3 + 1] === 0);
  assert.equal(clustered.index.length, 6, 'both seam triangles survive geometrically');
  assert.equal(at.length, 2); assert.notDeepEqual([...clustered.uv!.slice(at[0] * 2, at[0] * 2 + 2)], [...clustered.uv!.slice(at[1] * 2, at[1] * 2 + 2)]);
  assert.notEqual(clustered.material![at[0]], clustered.material![at[1]]);

  // Independent corners on every textured grid triangle must not prevent geometric simplification.
  const points: number[] = [], uv: number[] = [], material: number[] = [], skin: number[] = [], weight: number[] = [];
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 0], [1, 1], [0, 1]]) {
      points.push((x + dx) / 32, (y + dy) / 32, 0); uv.push(dx, dy); material.push(x < 16 ? 0 : 1);
      skin.push(0, 1, 0, 0); weight.push((x + 1) / 33, 1 - (x + 1) / 33, 0, 0);
    }
  }
  const dense: LodMesh = { position: Float32Array.from(points), normal: new Float32Array(points.length).fill(1), color: new Float32Array(points.length).fill(0.5),
    uv: Float32Array.from(uv), material: Uint16Array.from(material), skinIndex: Uint16Array.from(skin), skinWeight: Float32Array.from(weight),
    index: Uint32Array.from({ length: points.length / 3 }, (_, i) => i) };
  const before = encodeMesh(dense), low = simplify(dense, 600);
  assert.ok(low.index.length > 0 && low.index.length / 3 <= 600);
  assert.deepEqual(encodeMesh(dense), before, 'full source input is unchanged');
  const tuple = (mesh: LodMesh, v: number) => JSON.stringify([mesh.material![v], ...mesh.uv!.slice(v * 2, v * 2 + 2),
    ...mesh.normal.slice(v * 3, v * 3 + 3), ...mesh.color.slice(v * 3, v * 3 + 3),
    ...mesh.skinIndex.slice(v * 4, v * 4 + 4), ...mesh.skinWeight.slice(v * 4, v * 4 + 4)]);
  const sourceCorners = new Set([...Array(dense.position.length / 3).keys()].map((v) => tuple(dense, v)));
  for (let v = 0; v < low.position.length / 3; v++) assert.ok(sourceCorners.has(tuple(low, v)));
  for (let i = 0; i < low.index.length; i += 3) {
    const [a, b, c] = [...low.index.slice(i, i + 3)];
    assert.equal(low.material![a], low.material![b]); assert.equal(low.material![b], low.material![c]);
    const cross = (low.position[b * 3] - low.position[a * 3]) * (low.position[c * 3 + 1] - low.position[a * 3 + 1]) -
      (low.position[b * 3 + 1] - low.position[a * 3 + 1]) * (low.position[c * 3] - low.position[a * 3]);
    assert.notEqual(cross, 0, 'no geometrically degenerate triangles survive');
  }
});
