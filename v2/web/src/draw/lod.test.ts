// #3785: the ground drawn simplified at a distance, as today's WorldMeshLod does its large meshes: sectors that share
// the ground's vertices and cover it exactly, levels with today's ratios and 1.5 cm cap, full detail up close and the
// coarsest level within a pixel's error far away.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import type { NodeRec } from '../source/source.ts';
import { WorldView } from './world.ts';
import { GroundLod, SECTOR_TILES } from './lod.ts';
import { MAX_WORLD_ERROR, simplifyLevels, type Simplifier } from './lod-core.ts';
import { PHONE_MESH_LOD, DESKTOP_MESH_LOD, meshLodFor } from './quality-tier.ts';

const ROT: NodeRec['rot'] = [1 << 30, 0, 0, 0];
const node = (o: Partial<NodeRec> & { id: string; kind: string }): NodeRec => ({ parent: null, slot: null, pos: [0, 0, 0], rot: ROT, at: null, ...o });

/** `side` × `side` tiles of 16 m (16 cells each): a gentle swell, flat enough that most triangles go. */
function ground(side: number): NodeRec {
  const n = 16, tiles: [number, number, Uint8Array, Uint8Array][] = [];
  for (let tz = 0; tz < side; tz++) for (let tx = 0; tx < side; tx++) {
    const h = new DataView(new ArrayBuffer((n + 1) ** 2 * 4));
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const x = tx * 16 + i, z = tz * 16 + j;
      h.setInt32((j * (n + 1) + i) * 4, Math.round(3000 * Math.sin(x / 40) * Math.cos(z / 50)), true);
    }
    tiles.push([tx, tz, new Uint8Array(h.buffer), new Uint8Array(n * n)]);
  }
  return node({ id: 'g', kind: 'eden:ground', parent: 'w', tileSize: 16_000, tiles });
}

await MeshoptSimplifier.ready;
const levels = (input: Parameters<typeof simplifyLevels>[1]) => Promise.resolve(simplifyLevels(MeshoptSimplifier as unknown as Simplifier, input));
const camera = (x: number, y: number, z: number) => {
  const c = new THREE.PerspectiveCamera(50, 390 / 844, 0.1, 2000);
  c.position.set(x, y, z);
  return c;
};

test('A1: the sectors share the ground\'s vertices and cover its triangles exactly; the one ground-wide mesh is hidden', async () => {
  const w = new WorldView();
  w.apply([node({ id: 'w', kind: 'eden:world' }), ground(SECTOR_TILES * 2)], []);
  const terrain = w.terrainMesh!, lod = new GroundLod(terrain, w.terrainTiles, PHONE_MESH_LOD, levels);
  assert.equal(lod.sectors.length, 4);
  assert.equal(terrain.visible, false);
  assert.equal(lod.group.parent, terrain.parent);
  const want = new Set<string>(), got = new Set<string>(), tri = (a: ArrayLike<number>, i: number) => [a[i], a[i + 1], a[i + 2]].join();
  const all = terrain.geometry.index!.array;
  for (let i = 0; i < all.length; i += 3) want.add(tri(all, i));
  for (const s of lod.sectors) {
    assert.equal(s.mesh.geometry.getAttribute('position'), terrain.geometry.getAttribute('position'), 'the ground\'s own vertices');
    assert.equal(s.mesh.material, terrain.material);
    const a = s.mesh.geometry.index!.array;
    for (let i = 0; i < a.length; i += 3) got.add(tri(a, i));
  }
  assert.deepEqual(got, want);
});

test('A1: up close a sector is drawn in full; far away from the coarsest level within a pixel, under 1.5 cm', async () => {
  const w = new WorldView();
  w.apply([node({ id: 'w', kind: 'eden:world' }), ground(SECTOR_TILES * 2)], []);
  const lod = new GroundLod(w.terrainMesh!, w.terrainTiles, PHONE_MESH_LOD, levels);
  // A metre over the first sector's ground (inside its box: its nearest point is no distance away). Every sector's levels
  // are asked for, two at a time, and arrive.
  const near = camera(20, 2.5, 20);
  for (let i = 0; i < 40 && lod.stats.ready < 4; i++) (lod.update(near, 844), await new Promise((r) => setTimeout(r, 5)));
  assert.equal(lod.stats.ready, 4, 'every sector has its levels');
  for (const s of lod.sectors) {
    assert.ok(s.levels!.length >= 1, 'a gentle swell simplifies');
    for (const l of s.levels!) assert.ok(l.error <= MAX_WORLD_ERROR + 1e-6 && l.triangles < s.triangles * 0.8);
  }
  const first = lod.sectors.find((s) => s.box.containsPoint(new THREE.Vector3(20, s.box.min.y, 20)))!;
  assert.equal(first.mesh.geometry, first.full, 'the sector under the camera is drawn in full');
  assert.ok(lod.stats.triangles < lod.stats.fullTriangles);
  // Far above, every sector draws its coarsest level; a desktop allows half the error, so never coarser than a phone.
  const far = camera(64, 900, 64);
  lod.update(far, 844);
  for (const s of lod.sectors) assert.equal(s.mesh.geometry, s.levels!.at(-1)!.geometry);
  // At a middle height a desktop, allowed half the error, draws at least as much as a phone.
  const desk = new GroundLod(w.terrainMesh!, w.terrainTiles, DESKTOP_MESH_LOD, levels);
  for (let i = 0; i < 40 && desk.stats.ready < 4; i++) (desk.update(near, 844), await new Promise((r) => setTimeout(r, 5)));
  const mid = camera(20, 14, 20);
  lod.update(mid, 844);
  desk.update(mid, 844);
  assert.ok(desk.stats.triangles >= lod.stats.triangles, `desktop ${desk.stats.triangles} vs phone ${lod.stats.triangles}`);
  desk.dispose();
  // Back down: full again.
  lod.update(near, 844);
  assert.equal(first.mesh.geometry, first.full);
  lod.dispose();
  assert.equal(w.terrainMesh!.visible, true);
});

test('A1: a level\'s error decides by today\'s pixels (one on a phone, half on a desktop); ?lod=0 and ?detail=0 turn it off', () => {
  assert.deepEqual(meshLodFor('phone'), { maxErrorPx: 1 });
  assert.deepEqual(meshLodFor('full'), { maxErrorPx: 0.5 });
  assert.equal(meshLodFor('phone', '?lod=0'), null);
  assert.equal(meshLodFor('full', '?detail=0'), null);
});

test('A1: until a sector\'s levels arrive, or if they fail, it is drawn in full', async () => {
  const w = new WorldView();
  w.apply([node({ id: 'w', kind: 'eden:world' }), ground(SECTOR_TILES)], []);
  const lod = new GroundLod(w.terrainMesh!, w.terrainTiles, PHONE_MESH_LOD, () => Promise.reject(new Error('no worker')));
  lod.update(camera(30, 900, 30), 844);
  await new Promise((r) => setTimeout(r, 0));
  lod.update(camera(30, 900, 30), 844);
  assert.equal(lod.sectors[0].mesh.geometry, lod.sectors[0].full);
  assert.deepEqual(lod.sectors[0].levels, []);
});
