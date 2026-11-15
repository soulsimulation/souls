// #2433: a paged window's upper floor is assembled from pieces (one per group of floors at least two cells apart), kept
// across windows. Oracle: every assembled floor is bit-identical to buildGridsOverFloors of the same window (free,
// clearance, blockers and lattice), over random towns of nearby, touching and overlapping floors, obstacles across the
// gaps and floors cut by the window's edge; and a window that takes in one more building rebuilds only that building.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGridsOverFloors, type LevelGrid } from '../spatial/grid.ts';
import { GroundNav, type TileRect } from '../spatial/tiled.ts';
import { G_WALK, GROUND_TILE_M, type GroundField } from '../spatial/ground.ts';
import type { Obstacle, SpatialScene, Surface } from '../spatial/types.ts';

const flat: GroundField = {
  id: 'flat-2433', extent: [-256, -256, 256, 256], wadeMax: 0.6, maxSlope: 1,
  height: () => 0, waterLevel: () => null, medium: () => G_WALK, mediaTile: () => new Uint8Array(GROUND_TILE_M * GROUND_TILE_M),
};
const bytes = (a: ArrayBufferView) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const bounds = (r: TileRect): [number, number, number, number] => [r[0] * GROUND_TILE_M, r[1] * GROUND_TILE_M, (r[2] + 1) * GROUND_TILE_M, (r[3] + 1) * GROUND_TILE_M];
function sameGrid(a: LevelGrid | undefined, b: LevelGrid | undefined, what: string) {
  if (!a || !b) { assert.equal(a, b, what); return; }
  for (const k of ['level', 'y', 'cell', 'nx', 'nz', 'ox', 'oz', 'x0', 'z0'] as const) assert.equal(a[k], b[k], `${what}: ${k}`);
  assert.ok(bytes(a.free).equals(bytes(b.free)), `${what}: free`);
  assert.ok(bytes(a.clearance).equals(bytes(b.clearance)), `${what}: clearance`);
  assert.deepEqual([...a.blockers], [...b.blockers], `${what}: blockers`);
}

test('#2433: assembled floors equal buildGridsOverFloors bit for bit, over random towns and windows', () => {
  let seed = 2433;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const between = (a: number, b: number) => a + (b - a) * rand();
  for (let town = 0; town < 6; town++) {
    let n = 0;
    const surfaces: Surface[] = [], obstacles: Obstacle[] = [];
    // buildings on a street grid; neighbours 0 to 0.4 m apart (touching, one cell, two cells, more), some rotated, some overlapping
    for (let b = 0; b < 14; b++) {
      const c: [number, number] = [-60 + (b % 5) * 22 + between(-3, 3), -40 + Math.floor(b / 5) * 30 + between(-3, 3)];
      const half: [number, number] = [between(3, 9), between(3, 9)], yaw = rand() < 0.3 ? between(0, 3) : 0;
      surfaces.push({ id: `f${n++}`, level: 1, y: 3, obb: { c, half, yaw } });
      if (rand() < 0.5) { const gap = [0, 0.1, 0.2, 0.3, 0.4][Math.floor(rand() * 5)]; surfaces.push({ id: `f${n++}`, level: 1, y: 3, obb: { c: [c[0] + 2 * half[0] + gap, c[1]], half, yaw: 0 } }); }
      if (rand() < 0.3) surfaces.push({ id: `f${n++}`, level: 2, y: 6, obb: { c, half: [half[0] * 0.8, half[1] * 0.8], yaw } });
      for (let k = 0; k < 6; k++) obstacles.push({ id: `o${n++}`, kind: 'component', obb: { c: [c[0] + between(-half[0], half[0]), c[1] + between(-half[1], half[1])], half: [between(0.05, 2), between(0.05, 0.5)], yaw: between(0, 3) }, y0: rand() < 0.8 ? 3 : 6, y1: 5 + 3 * rand() });
      // a wall across the gap to the next building, and a thin post right in it
      obstacles.push({ id: `o${n++}`, kind: 'component', obb: { c: [c[0] + half[0], c[1]], half: [0.3, half[1]], yaw: 0 }, y0: 3, y1: 5.5 });
      if (rand() < 0.5) obstacles.push({ id: `o${n++}`, kind: 'component', obb: { c: [c[0] + half[0] + 0.15, c[1] + 1], half: [0.04, 0.04], yaw: 0 }, y0: 3, y1: 5, raster: 'centre' } as Obstacle);
    }
    const scene: SpatialScene = {
      bounds: [-256, -256, 256, 256], levels: [{ id: 0, y: 0, label: 'ground' }, { id: 1, y: 3, label: 'floor 1' }, { id: 2, y: 6, label: 'floor 2' }],
      surfaces, obstacles, links: [],
    };
    const nav = new GroundNav(flat, 0.1, { paged: true }); nav.setFloors([]); nav.setSolids(obstacles);
    // windows that move and grow over the town: floors cut by an edge, a building taken in at a time
    const windows: TileRect[] = [[-1, -1, -1, -1], [-1, -1, 0, -1], [-1, -1, 0, 0], [0, -1, 0, 0], [-2, -1, 0, 0], [-1, 0, 0, 0], [0, 0, 0, 0], [-1, -1, -1, 0]];
    for (const r of windows) for (const id of [1, 2]) {
      const want = buildGridsOverFloors({ ...scene, bounds: bounds(r), levels: scene.levels.filter((l) => l.id === id) }, 0.1).levels.get(id);
      const got = nav.levelOver(r, id, scene);   // undefined: no floor of that level reaches the window (gridsOver leaves the level out)
      if (got) sameGrid(got, want, `town ${town} window ${r} level ${id}`); else assert.ok(!want!.free.some((x) => x), `town ${town} window ${r} level ${id}: no floor`);
    }
    assert.ok(nav.stats.pieceHits > 0, `town ${town}: pieces were kept across windows`);
  }
});

test('#2433: a window that takes in one more building rebuilds that building only', () => {
  const floor = (id: string, x: number): Surface => ({ id, level: 1, y: 3, obb: { c: [x, 20], half: [5, 5], yaw: 0 } });
  const scene: SpatialScene = {
    bounds: [-256, -256, 256, 256], levels: [{ id: 0, y: 0, label: 'ground' }, { id: 1, y: 3, label: 'floor 1' }],
    surfaces: [floor('a', 10), floor('b', 30), floor('c', 50), floor('far', 90)],
    obstacles: [{ id: 'wall', kind: 'component', obb: { c: [30, 22], half: [3, 0.1], yaw: 0 }, y0: 3, y1: 5.5 }], links: [],
  };
  const nav = new GroundNav(flat, 0.1, { paged: true }); nav.setFloors([]); nav.setSolids(scene.obstacles);
  nav.levelOver([0, 0, 0, 0], 1, scene);
  assert.equal(nav.stats.pieceBuilds, 3, 'one tile: a, b and c, one piece each');
  const before = nav.stats.pieceBuilds;
  const g = nav.levelOver([0, 0, 1, 0], 1, scene);
  assert.equal(nav.stats.pieceBuilds - before, 1, 'the wider window builds only the far building');
  sameGrid(g, buildGridsOverFloors({ ...scene, bounds: [0, 0, 128, 64], levels: [scene.levels[1]] }, 0.1).levels.get(1), 'wider window');
});

test('#2433 review: an obstacle whose raster mode alone changes is not served from a kept piece', () => {
  const lv = { id: 1, y: 3, label: 'floor 1' };
  const door = (raster?: 'centre'): Obstacle => ({ id: 'door', kind: 'component', obb: { c: [10.03, 10.03], half: [1, 0.04], yaw: 0.7 }, y0: 3, y1: 5, ...(raster ? { raster } : {}) } as Obstacle);
  const scene = (farX: number, raster?: 'centre'): SpatialScene => ({
    bounds: [-256, -256, 256, 256], levels: [{ id: 0, y: 0, label: 'ground' }, lv],
    surfaces: [{ id: 'a', level: 1, y: 3, obb: { c: [10, 10], half: [3, 3], yaw: 0 } }, { id: 'far', level: 1, y: 3, obb: { c: [farX, 10], half: [3, 3], yaw: 0 } }],
    obstacles: [door(raster)], links: [],
  });
  // `far` moves, so the whole-window floor misses; the piece of `a` would hit if its key left the raster mode out
  const nav = new GroundNav(flat, 0.1, { paged: true }); nav.setFloors([]);
  const s1 = scene(40, 'centre'), s2 = scene(41);
  nav.setSolids(s1.obstacles); nav.levelOver([0, 0, 0, 0], 1, s1);
  nav.setSolids(s2.obstacles);
  sameGrid(nav.levelOver([0, 0, 0, 0], 1, s2), buildGridsOverFloors({ ...s2, bounds: bounds([0, 0, 0, 0]), levels: [lv] }, 0.1).levels.get(1), 'raster mode changed');
});
