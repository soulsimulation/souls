// node --test v2/client/src/creator/terrain/terrain.test.mjs (Engine v2 G5, #2762)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { F, expand, heightAt } from './terrain.mjs';

const N = 16;
const flat = (tx, tz) => ({ tx, tz, heights: new Int32Array((N + 1) ** 2), classes: new Uint8Array(N * N) });
const ground = () => ({ id: 'ground', tileMm: N * 1000, tiles: [flat(0, 0), flat(1, 0), flat(0, 1), flat(1, 1)] });
const M = 1_000_000n;

test('heights are read as the engine reads them: bilinear in micrometres', () => {
  const t = flat(0, 0);
  t.heights[0] = 0; t.heights[1] = 1000; t.heights[N + 1] = 2000; t.heights[N + 2] = 3000;
  assert.equal(heightAt([t], N * 1000, 500_000n, 500_000n), 1_500_000n);
  assert.equal(heightAt([t], N * 1000, 1_000_000n, 0n), 1_000_000n);
  assert.equal(heightAt([t], N * 1000, 250_000n, 0n), 250_000n);
  assert.equal(heightAt([t], N * 1000, -1n, 0n), null, 'off every tile');
});

test('a hill: its place, the patched tiles, and each resting thing on it lifted in the batch', () => {
  const g = ground();
  const things = [
    { id: 'box', position: [16n * M, 0n, 22n * M], orientation: 'q', support: 's' },
    { id: 'far', position: [2n * M, 0n, 2n * M], orientation: 'q', support: 's' },
  ];
  const hill = { id: 'h', kind: 'bump', c: [16, 16], r: 8, h: 6 };
  const { ops, patched } = expand({ ground: g, landform: hill, things, placeKind: 'eden:place@x', outline: [[8, 8], [24, 8], [24, 24], [8, 24]] });
  assert.equal(patched, 4, 'the hill sits where four tiles meet');
  assert.deepEqual(ops.map((o) => o.op), ['place', 'set', 'move'], 'only the thing on the hill moves');
  assert.equal(ops[0].fields[F.PLACE_OF], 'eden:landform');
  assert.equal(ops[1].field, F.TILES);
  const after = ops[1].to.map(([tx, tz, h, c]) => ({ tx, tz, heights: new Int32Array(h.buffer, h.byteOffset, h.byteLength / 4), classes: c }));
  const rise = heightAt(after, g.tileMm, 16n * M, 22n * M);
  assert.ok(rise > 0n);
  assert.deepEqual(ops[2], { op: 'move', node: 'box', at: { position: [16n * M, rise, 22n * M], orientation: 'q', support: 's' } });
});

test('a pond is a water place with its level over the carved bed', () => {
  const pond = { id: 'p', kind: 'carve', area: [[4, 4], [12, 4], [12, 12], [4, 12]], bed: -1.2, edge: 2 };
  const { ops } = expand({ ground: ground(), landform: pond, water: { level: -0.2 }, placeKind: 'eden:place@x' });
  assert.equal(ops[0].fields[F.PLACE_OF], 'eden:water');
  assert.equal(ops[0].fields[F.WATER_LEVEL], -200);
  assert.deepEqual(ops[0].fields[F.OUTLINE][1], [12000, 4000]);
  const after = ops[1].to.map(([tx, tz, h, c]) => ({ tx, tz, heights: new Int32Array(h.buffer, h.byteOffset, h.byteLength / 4), classes: c }));
  assert.equal(heightAt(after, N * 1000, 8n * M, 8n * M), -1_200_000n, 'the bed in the middle');
});
