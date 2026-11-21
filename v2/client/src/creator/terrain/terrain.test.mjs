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

test('#3728: the ground grows flat from its edge, and only grows', async () => {
  const { grownTiles } = await import('./terrain.mjs');
  const { extentOps, boundsOf } = await import('./land.mjs');
  const g = ground();
  // A slope along x on the old tiles' east edge: the new ground keeps each edge sample's height outward.
  for (const t of g.tiles.filter((t) => t.tx === 1)) for (let j = 0; j <= N; j++) t.heights[j * (N + 1) + N] = 500 * (t.tz * N + j);
  const added = grownTiles(g.tiles, g.tileMm, [0, 0, 48, 32]);
  assert.deepEqual(added.map((t) => [t.tx, t.tz]), [[2, 0], [2, 1]], 'a column of tiles to the east');
  const all = [...g.tiles, ...added];
  for (const z of [0n, 5n, 31n]) {
    assert.equal(heightAt(all, g.tileMm, 32n * M, z * M), heightAt(all, g.tileMm, 47n * M, z * M), `flat outward at z ${z}`);
  }
  assert.equal(heightAt(all, g.tileMm, 40n * M, 31n * M), 31n * 500_000n);
  assert.deepEqual(grownTiles(g.tiles, g.tileMm, [0, 0, 32, 32]), [], 'nothing past the old ground');
  // expand <m>: a centred square; land extend: one way from the extent now.
  assert.deepEqual(boundsOf({ verb: 'expand', extent: '100' }, [0, 0, 32, 32]), [-50, -50, 50, 50]);
  assert.deepEqual(boundsOf({ land: 'extend', toward: 'ne', metres: '10' }, [0, 0, 32, 32]), [0, -10, 42, 32]);
  assert.deepEqual(boundsOf({ land: 'extend', bounds: '-5,0,10,10' }, [0, 0, 32, 32]), [-5, 0, 32, 32], 'it only grows');
  assert.throws(() => boundsOf({ land: 'extend', toward: 'up', metres: '10' }, [0, 0, 32, 32]), (e) => e.code === 'land.flag');
  // The batch: every tile, the extent place, and a thing resting off the old ground moved to the new ground's height.
  const box = { id: 'box', position: [40n * M, 0n, 20n * M], orientation: [1000000, 0, 0, 0], support: { which: 0 } };
  const out = extentOps({ ...g, things: [box], bodies: [], placeKind: 'eden:place@x', extent: null }, { land: 'extend', toward: 'e', metres: '16' });
  assert.deepEqual(out.ops.map((o) => o.op), ['set', 'place', 'move']);
  assert.equal(out.ops[0].value.length, 6);
  assert.deepEqual(out.ops[1].fields, { [F.OUTLINE]: [[0, 0], [48000, 0], [48000, 32000], [0, 32000]], [F.PLACE_OF]: 'eden:extent' });
  assert.deepEqual(out.ops[2].atUm, [40_000_000, 10_000_000, 20_000_000]);
  // Again with the extent place there: its outline is set; asking for no more is refused by name.
  const again = extentOps({ ...g, things: [], bodies: [], placeKind: 'eden:place@x', extent: { id: 'x-9', outline: [[0, 0], [32, 0], [32, 32], [0, 32]] } }, { land: 'extend', bounds: '0,0,10,10' });
  assert.equal(again.ok, false);
  assert.equal(again.code, 'expand.nothing');
  const wider = extentOps({ ...g, things: [], bodies: [], placeKind: 'eden:place@x', extent: { id: 'x-9', outline: [[0, 0], [48, 0], [48, 32], [0, 32]] } }, { verb: 'expand', extent: '120' });
  assert.deepEqual(wider.ops[1], { op: 'set', node: 'x-9', field: F.OUTLINE, value: [[-60000, -60000], [60000, -60000], [60000, 60000], [-60000, 60000]] });
  // A Soul standing off the old ground where the new ground is not at 0 refuses it before anything is sent.
  const soul = { id: 's', position: [40n * M, 0n, 20n * M] };
  assert.equal(extentOps({ ...g, things: [], bodies: [soul], placeKind: 'eden:place@x', extent: null }, { land: 'extend', toward: 'e', metres: '16' }).code, 'edit.terrain-under-soul');
  // Too large for one edit: refused by name, with the most it can carry.
  const big = extentOps({ ...g, things: [], bodies: [], placeKind: 'eden:place@x', extent: null }, { verb: 'expand', extent: '16000' });
  assert.equal(big.code, 'expand.too-large');
});
