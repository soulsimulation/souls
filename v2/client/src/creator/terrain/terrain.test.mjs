// node --test v2/client/src/creator/terrain/terrain.test.mjs (Engine v2 G5, #2762)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { F, bodiesUnder, changedCells, expand, heightAt } from './terrain.mjs';

const N = 16;
const flat = (tx, tz) => ({ tx, tz, heights: new Int32Array((N + 1) ** 2), classes: new Uint8Array(N * N) });
const ground = () => ({ id: 'ground', tileMm: N * 1000, tiles: [flat(0, 0), flat(1, 0), flat(0, 1), flat(1, 1)] });
const M = 1_000_000n;
const tilesOf = (value) => value.map(([tx, tz, h, c]) => {
  const b = Buffer.from(h.hex, 'hex');
  return { tx, tz, heights: new Int32Array(b.buffer, b.byteOffset, b.byteLength / 4), classes: Buffer.from(c.hex, 'hex') };
});

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
    { id: 'box', position: [16n * M, 0n, 22n * M], orientation: [1000000, 0, 0, 0], support: { which: 0 } },
    { id: 'far', position: [2n * M, 0n, 2n * M], orientation: [1000000, 0, 0, 0], support: { which: 0 } },
  ];
  const hill = { id: 'h', kind: 'bump', c: [16, 16], r: 8, h: 6 };
  const { ops, patched } = expand({ ground: g, landform: hill, things, placeKind: 'eden:place@x', outline: [[8, 8], [24, 8], [24, 24], [8, 24]] });
  assert.equal(patched, 4, 'the hill sits where four tiles meet');
  assert.deepEqual(ops.map((o) => o.op), ['place', 'set', 'move'], 'only the thing on the hill moves');
  assert.equal(ops[0].fields[F.PLACE_OF], 'eden:landform');
  assert.equal(ops[1].field, F.TILES);
  const after = tilesOf(ops[1].value);
  const rise = heightAt(after, g.tileMm, 16n * M, 22n * M);
  assert.ok(rise > 0n);
  assert.deepEqual(ops[2], { op: 'move', node: 'box', atUm: [16_000_000, Number(rise), 22_000_000], orientation: [1000000, 0, 0, 0], support: { which: 0 } });
  assert.equal(ops[0].in, 'ground');
  assert.ok(ops[0].fields[F.LANDFORM].hex, 'the landform travels as bytes');
});

test('a pond is a water place with its level over the carved bed', () => {
  const pond = { id: 'p', kind: 'carve', area: [[4, 4], [12, 4], [12, 12], [4, 12]], bed: -1.2, edge: 2 };
  const { ops } = expand({ ground: ground(), landform: pond, water: { level: -0.2 }, placeKind: 'eden:place@x' });
  assert.equal(ops[0].fields[F.PLACE_OF], 'eden:water');
  assert.equal(ops[0].fields[F.WATER_LEVEL], -200);
  assert.deepEqual(ops[0].fields[F.OUTLINE][1], [12000, 4000]);
  const after = tilesOf(ops[1].value);
  assert.equal(heightAt(after, N * 1000, 8n * M, 8n * M), -1_200_000n, 'the bed in the middle');
});

test('#3695: a Soul standing where the ground changes is found before anything is sent; one standing clear is not', () => {
  const g = ground();
  const hill = { id: 'h', kind: 'bump', c: [16, 16], r: 4, h: 2 };
  const { tiles } = expand({ ground: g, landform: hill, placeKind: 'eden:place@x', outline: [[12, 12], [20, 12], [20, 20], [12, 20]] });
  const changed = changedCells(g.tiles, tiles, g.tileMm);
  assert.ok(changed.cells.size > 0);
  const on = { id: 'on', position: [16n * M, 0n, 16n * M] }, off = { id: 'off', position: [2n * M, 0n, 2n * M] };
  assert.deepEqual(bodiesUnder(changed, [on, off], 350_000).map((b) => b.id), ['on']);
});

test('#3695: the land verbs make today\'s landforms from today\'s flags and defaults, and refuse by name', async () => {
  const { landformOf } = await import('./land.mjs');
  const flat = () => 2;
  const hill = landformOf('hill', { at: '10,20' }, flat, 'x');
  assert.deepEqual(hill.landform, { id: 'x', kind: 'bump', c: [10, 20], r: 80, h: 25, peak: 1 });
  assert.equal(landformOf('knoll', { path: '[[0,0],[10,0]]' }, flat, 'x').landform.kind, 'ridge');
  const pond = landformOf('pond', { circle: '0,0,5' }, flat, 'x');
  assert.equal(pond.landform.kind, 'carve');
  assert.equal(pond.water.level, 1.8, 'just under the ground there');
  assert.equal(pond.landform.bed, 0.6);
  const ditch = landformOf('ditch', { path: '[[0,0],[9,0]]' }, flat, 'x').landform;
  assert.ok(ditch.levels.every((l) => l === 1), 'cut a metre below the ground along it');
  assert.equal(landformOf('flatten', { at: '0,0' }, flat, 'x').landform.level, 2);
  for (const [verb, a, code] of [['smooth', { at: '0,0' }, 'land.smooth'], ['hill', { at: '0,0', height: '900' }, 'land.flag'], ['dig', {}, 'land.verb'], ['plateau', {}, 'land.flag']]) {
    assert.throws(() => landformOf(verb, a, flat, 'x'), (e) => e.code === code, `${verb}: ${code}`);
  }
});
