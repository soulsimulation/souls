// The ground as drawn, the areas laid on it and what stands on it: heights on the drawn triangles, drapes flat on the
// ground, a slot's point carried without its yaw (T4), and the support check that counts what floats.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { NodeRec } from '../source/source.ts';
import { WorldView } from './world.ts';
import { drapeMesh } from './drapes.ts';
import { support } from './support.ts';

const ROT: NodeRec['rot'] = [1 << 30, 0, 0, 0];
const node = (o: Partial<NodeRec> & { id: string; kind: string }): NodeRec => ({ parent: null, slot: null, pos: [0, 0, 0], rot: ROT, at: null, ...o });

/** One 4 m tile of 1 m cells, a slope rising 0.5 m a metre in x, and a bump at (2, 2). */
function ground(): NodeRec {
  const n = 4, h = new DataView(new ArrayBuffer((n + 1) ** 2 * 4));
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) h.setInt32((j * (n + 1) + i) * 4, i * 500 + (i === 2 && j === 2 ? 1000 : 0), true);
  return node({ id: 'g', kind: 'eden:ground', parent: 'w', tileSize: 4000, tiles: [[0, 0, new Uint8Array(h.buffer), new Uint8Array(n * n)]] });
}

test('heights are read on the triangles the ground draws', () => {
  const w = new WorldView();
  w.apply([node({ id: 'w', kind: 'eden:world' }), ground()], []);
  assert.equal(w.heightAt(1, 1), 0.5);
  assert.equal(w.heightAt(2, 2), 2);
  assert.equal(w.heightAt(1.5, 0.5), 0.75);
  // Across the bump's cell (2..3, 2..3): the lower-left triangle (a, d, b) holds the bump at its corner a.
  assert.ok(Math.abs(w.heightAt(2.25, 2.25)! - (2 + (1.5 - 2) * 0.25 + (1 - 2) * 0.25)) < 1e-9);
  assert.equal(w.heightAt(9, 9), null);
});

test('A1: an area lies flat on the ground in its colour, no side longer than a metre', () => {
  const w = new WorldView();
  w.apply([node({ id: 'w', kind: 'eden:world' }), ground()], []);
  const mesh = drapeMesh([{ colour: 0xb3ac9e, lift: 0.04, points: [[0.2, 0.2], [3.8, 0.2], [3.8, 3.8], [0.2, 3.8]] }], (x, z) => w.heightAt(x, z))!;
  const p = mesh.geometry.getAttribute('position'), nrm = mesh.geometry.getAttribute('normal'), col = mesh.geometry.getAttribute('color');
  assert.ok(p.count >= 3 * 2 * 13, `${p.count} corners`);
  for (let i = 0; i < p.count; i++) {
    assert.ok(Math.abs(p.getY(i) - (w.heightAt(p.getX(i), p.getZ(i))! + 0.04)) < 1e-5, 'on the ground');
    assert.ok(nrm.getY(i) > 0, 'facing up');
    assert.ok(Math.abs(col.getX(i) - new THREE.Color(0xb3ac9e).r) < 1e-6, 'its colour');
  }
  for (let t = 0; t < p.count; t += 3) for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
    const d = Math.hypot(p.getX(t + a) - p.getX(t + b), p.getZ(t + a) - p.getZ(t + b));
    assert.ok(d <= 1 + 1e-9, `a side of ${d} m`);
  }
});

test('A2: a thing in a slot stands at the slot point, turned by its parent only; one carried twice floats', () => {
  const w = new WorldView();
  const table = node({ id: 't', kind: 'core:table', parent: 'g', pos: [1_000_000, 500_000, 1_000_000], slots: [[1, 0, 750, 0, 90_000, 1]] });
  const bowl = node({ id: 'b', kind: 'core:bowl', parent: 't', slot: 1, pos: [100_000, 0, 0] });
  w.apply([node({ id: 'w', kind: 'eden:world' }), ground(), table, bowl], []);
  const m = w.frame('b').elements;
  assert.deepEqual([m[12], m[13], m[14]].map((v) => Math.round(v * 1000)), [1100, 1250, 1000], 'the slot point, then the pose, no slot yaw');
  let s = support(w);
  assert.deepEqual([s.checked, s.floating], [2, 0]);
  // Today's pose (from the parent's origin, the slot point included) given as the slot's: 0.75 m too high.
  w.apply([{ ...bowl, pos: [100_000, 750_000, 0] }], []);
  s = support(w);
  assert.equal(s.floating, 1);
  assert.equal(Math.round(s.worst[0].off * 100), 75);
});
