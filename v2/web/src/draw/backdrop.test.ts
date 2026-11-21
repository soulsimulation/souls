// C12 (#3683) A1: the far backdrop starts on the drawn ground's edge, runs past the camera's far plane, faces up and
// leaves the world's own ground uncovered.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import { WorldView } from './world.ts';
import { FAR, SKIRT } from './backdrop.ts';

const ROT: NodeRec['rot'] = [1 << 30, 0, 0, 0];
const node = (o: Partial<NodeRec> & { id: string; kind: string }): NodeRec => ({ parent: null, slot: null, pos: [0, 0, 0], rot: ROT, at: null, ...o });

/** Two 4 m tiles side by side, a slope rising 0.5 m a metre in x, class 1 everywhere. */
function ground(): NodeRec {
  const n = 4, tile = (tx: number): [number, number, Uint8Array, Uint8Array] => {
    const h = new DataView(new ArrayBuffer((n + 1) ** 2 * 4));
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) h.setInt32((j * (n + 1) + i) * 4, (tx * n + i) * 500, true);
    return [tx, 0, new Uint8Array(h.buffer), new Uint8Array(n * n).fill(1)];
  };
  return node({ id: 'g', kind: 'eden:ground', parent: 'w', tileSize: 4000, tiles: [tile(0), tile(1)] });
}

test('A1: the backdrop meets the ground at its edge and runs past the far plane, around a hole the world\'s size', () => {
  const w = new WorldView();
  w.apply([node({ id: 'w', kind: 'eden:world' }), ground()], []);
  assert.deepEqual(w.extent, [0, 0, 8, 4]);
  const b = w.backdrop!;
  assert.ok(b && w.group.children.includes(b.mesh), 'drawn with the world');
  assert.equal(b.mesh.castShadow, false);
  assert.ok(b.mesh.receiveShadow);
  const p = b.mesh.geometry.getAttribute('position'), nrm = b.mesh.geometry.getAttribute('normal');
  let onEdge = 0, maxX = -Infinity, minZ = Infinity;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    assert.ok(nrm.getY(i) > 0, 'facing up');
    // nothing inside the world's own ground
    assert.ok(!(x > 0 && x < 8 && z > 0 && z < 4), `vertex inside the world at ${x},${z}`);
    if (x >= 0 && x <= 8 && z >= 0 && z <= 4) {
      onEdge++;
      assert.ok(Math.abs(y - w.heightAt(Math.min(x, 8 - 1e-6), Math.min(z, 4 - 1e-6))!) < 1e-5, `on the edge's height at ${x},${z}`);
    } else assert.ok(Math.abs(y - b.level) < 1e-6, 'outside: one level');
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
  }
  assert.ok(onEdge >= 2 * (8 + 4), `${onEdge} edge points, a metre apart`);
  assert.equal(maxX, 8 + FAR);
  assert.equal(minZ, -FAR);
  assert.ok(FAR > 1200 && SKIRT === 80, 'past the camera\'s far plane; today\'s 80 m margin');
  // The colours are the drawn ground's own vertex colours at the edge (C11's height and slope colour), not a fixed one.
  const terrain = w.group.getObjectByName('terrain') as THREE.Mesh;
  const tp = terrain.geometry.getAttribute('position'), tc = terrain.geometry.getAttribute('color');
  const groundColour = new Map<string, THREE.Color>();
  for (let i = 0; i < tp.count; i++) groundColour.set(`${tp.getX(i)},${tp.getZ(i)}`, new THREE.Color().fromBufferAttribute(tc, i));
  const col = b.mesh.geometry.getAttribute('color'), edge = new Map<string, THREE.Color>();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    if (!(x >= 0 && x <= 8 && z >= 0 && z <= 4)) continue;
    const c = new THREE.Color().fromBufferAttribute(col, i), want = groundColour.get(`${x},${z}`);
    assert.ok(want, `a ground vertex at ${x},${z}`);
    assert.ok(Math.abs(c.r - want.r) + Math.abs(c.g - want.g) + Math.abs(c.b - want.b) < 1e-5, `the ground's colour at ${x},${z}`);
    edge.set(`${x},${z}`, c);
  }
  assert.equal(edge.size >= 2 * (8 + 4), true);
  // The south edge's colour changes along it (not one colour, not the mean): this gentle slope stays meadow, so it is
  // today's 4 m noise cell that differs between x 0 and 4 (x 0 and 8 happen to share a noise value).
  assert.notEqual(edge.get('0,0')!.getHex(), edge.get('4,0')!.getHex());
});
