// The one-off edit that gives a world imported with core-fountain@1 the rim seats' slot rows (fountain-rim-seats.mjs).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rimOps, slotRows } from './fountain-rim-seats.mjs';

const entry = JSON.parse(readFileSync(new URL('../../../content/kinds/washing/fountain.json', import.meta.url), 'utf8'));
const ring = [[2250, 0, 0, 270000], [1125, 0, 1949, 210000], [-1125, 0, 1949, 150000], [-2250, 0, 0, 90000], [-1125, 0, -1949, 30000], [1125, 0, -1949, 330000]];

test('the rows are the exporter\'s: @1 six stand points 1 to 6, @2 six rim seats 1 to 6 then the stands 7 to 12', () => {
  // As `node v2/tools/import-eden/export/export.ts` writes campus-quad-fountain's slots (n, at, yaw, capacity) with
  // Eden's template at @1 (before) and at @2 (this change).
  assert.deepEqual(slotRows('core/fountain@1', entry), ring.map(([x, y, z, yaw], i) => [i + 1, x, y, z, yaw, 1]));
  assert.deepEqual(slotRows('core/fountain@2', entry), [
    [1, 1925, 575, 0, 90000, 1], [2, 962, 575, 1667, 29994, 1], [3, -962, 575, 1667, 330006, 1],
    [4, -1925, 575, 0, 270000, 1], [5, -962, 575, -1667, 209994, 1], [6, 962, 575, -1667, 150006, 1],
    ...ring.map(([x, y, z, yaw], i) => [i + 7, x, y, z, yaw, 1]),
  ]);
});

test('only a fountain whose rows are still @1\'s is set, to @2\'s; a second run sends nothing', () => {
  const was = slotRows('core/fountain@1', entry), now = slotRows('core/fountain@2', entry);
  const world = { nodes: [
    { id: 'a-1', kind: 'eden:fountain', fields: { 13: was } },
    { id: 'a-2', kind: 'eden:fountain', fields: { 13: now } },
    { id: 'a-3', kind: 'eden:bench', fields: { 13: was } },
    { id: 'a-4', kind: 'eden:fountain', fields: { 13: was.slice(1) } },
  ] };
  assert.deepEqual(rimOps(world, was, now), { ops: [{ op: 'set', node: 'a-1', field: 13, value: now }], other: ['a-4'] });
  world.nodes[0].fields[13] = now;
  assert.deepEqual(rimOps(world, was, now), { ops: [], other: ['a-4'] });
});
