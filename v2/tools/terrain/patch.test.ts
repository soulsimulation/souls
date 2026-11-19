// node --test v2/tools/terrain/patch.test.ts (Engine v2 G5, #2762)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TILE_M, bakeTile, emptyGround, groundSchema } from '../../../packages/ground/src/index.ts';
import { patch, type Tile } from './patch.ts';

const flat = (tx: number, tz: number, n = TILE_M, h = 0): Tile => ({ tx, tz, heights: new Int32Array((n + 1) ** 2).fill(h), classes: new Uint8Array(n * n) });

test('a hill on flat ground is today\'s baked tile, to the millimetre, and only the tiles it reaches change', () => {
  const hill = { id: 'h', kind: 'bump', c: [70, 40], r: 20, h: 6 };
  const tiles = [flat(0, 0), flat(1, 0), flat(2, 0)];
  const out = patch(tiles, TILE_M * 1000, hill);
  assert.deepEqual(out.map((t) => t.tx), [0, 1], 'the hill reaches tiles 0 and 1, not 2');
  const g = groundSchema.parse({ ...emptyGround(), landforms: [hill] });
  for (const t of out) {
    const baked = bakeTile(g, t.tx, t.tz);
    assert.deepEqual([...t.heights], [...baked].map((m) => Math.round(m * 1000)), `tile ${t.tx} equals today's`);
  }
  assert.equal(Math.max(...out[1]!.heights), 6000);
});

test('a pond is carved to its bed from the ground that is there, and raised ground elsewhere is kept', () => {
  const t = flat(0, 0, 16, 1500);
  const [out] = patch([t], 16_000, { id: 'p', kind: 'carve', area: [[4, 4], [12, 4], [12, 12], [4, 12]], bed: -1, edge: 2 });
  assert.ok(out);
  assert.equal(out.heights[8 * 17 + 8], -1000, 'the middle is at the bed');
  assert.equal(out.heights[0], 1500, 'a corner far from it keeps its height');
});
