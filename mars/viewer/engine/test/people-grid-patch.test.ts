// #2405 A2: gridsWithObstacles lowers clearance only near the people it adds (grid.ts lowerClearance), never the
// level's whole EDT. Its result must be bit-identical to the full recompute — `edt` over the new free cells — on random
// cases: wide windows, many small people, people overlapping each other and the edges, and a base whose stored
// clearance is not its own exact EDT (a ground composite: each fine tile's EDT, side by side).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrids, edt, gridsWithObstacles, type GridSet, type LevelGrid } from '../spatial/grid.ts';
import { seedRng, nextRandom } from '../core/rng.ts';
import type { Obstacle, SpatialScene } from '../spatial/types.ts';

const bits = (a: Float32Array) => new Uint32Array(a.buffer, a.byteOffset, a.length);

function assertExact(got: LevelGrid, free: Uint8Array, what: string) {
  const want = bits(edt(free, got.nx, got.nz, got.cell)), have = bits(got.clearance);
  const k = have.findIndex((v, i) => v !== want[i]);
  assert.equal(k, -1, `${what}: clearance differs at cell ${k}`);
}

test('gridsWithObstacles === the full EDT recompute on random windows and people (clearance bits, free, blockers)', () => {
  const rand = ((st) => () => nextRandom(st))(seedRng('people-grid-patch'));
  let cases = 0;
  for (let n = 0; n < 40; n++) {
    const w = 20 + rand() * 40, d = 20 + rand() * 40, cell = rand() < 0.8 ? 0.1 : 0.25;
    const bounds: [number, number, number, number] = [-w / 2, -d / 2, w / 2, d / 2];
    const walls: Obstacle[] = Array.from({ length: Math.floor(rand() * 15) }, (_, k) => ({
      id: `wall${k}`, kind: 'component', y0: 0, y1: 2.5,
      obb: { c: [(rand() - 0.5) * w, (rand() - 0.5) * d], half: [0.1 + rand() * 4, 0.1 + rand() * 1.5], yaw: rand() < 0.5 ? 0 : rand() * Math.PI },
    }));
    const scene: SpatialScene = { bounds, levels: [{ id: 0, y: 0, label: 'ground' }], links: [], obstacles: walls,
      surfaces: [{ id: 'ground', level: 0, y: 0, obb: { c: [0, 0], half: [w / 2, d / 2], yaw: 0 } }] };
    const people: Obstacle[] = Array.from({ length: 1 + Math.floor(rand() * 24) }, (_, k) => ({
      id: `p${k}`, kind: 'component', y0: 0, y1: 1.8,
      obb: { c: [(rand() - 0.5) * (w + 1), (rand() - 0.5) * (d + 1)], half: [0.3, 0.3], yaw: rand() * Math.PI },
    }));
    const want = buildGrids({ ...scene, obstacles: [...walls, ...people] }, cell).levels.get(0)!;
    for (const cols of [true, false]) {
      const base = buildGrids(scene, cell, undefined, cols);
      const got = gridsWithObstacles(base, people).levels.get(0)!;
      assert.deepEqual(got.free, want.free, `case ${n} cols=${cols}: free`);
      assert.deepEqual([...got.blockers].sort(), [...want.blockers].sort(), `case ${n} cols=${cols}: blockers`);
      const k = bits(got.clearance).findIndex((v, i) => v !== bits(want.clearance)[i]);
      assert.equal(k, -1, `case ${n} cols=${cols}: clearance differs at cell ${k}`);
      assert.notEqual(got.clearance, base.levels.get(0)!.clearance, 'the base is never written');
      cases++;
    }
    // a base whose stored clearance is capped (as a composite of fine tiles): the result is still edt of the new free cells
    const plain = buildGrids(scene, cell).levels.get(0)!;
    const capped: LevelGrid = { ...plain, clearance: plain.clearance.map((c) => Math.min(c, 0.7)) };
    const before = capped.clearance.slice();
    const got = gridsWithObstacles({ cell, levels: new Map([[0, capped]]) } as GridSet, people).levels.get(0)!;
    assertExact(got, want.free, `case ${n} capped base`);
    assert.deepEqual(capped.clearance, before, `case ${n}: the capped base is never written`);
    cases++;
  }
  assert.equal(cases, 120);
});
