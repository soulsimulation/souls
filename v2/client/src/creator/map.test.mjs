// R8d: the world at a glance from the copy (map.mjs): extent, buildings, named things, roads and zones, in metres.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAP_MOST, mapOf } from './map.mjs';

test('map: the extent of what stands, buildings with their rooms, named things, roads and zones, each centred, in metres', () => {
  const d = { nodes: [
    { id: 'w-0', kind: 'souls:place', parent: null },
    { id: 'w-1', kind: 'eden:ground', parent: 'w-0', at: [0, 0, 0] },
    { id: 'w-2', kind: 'eden:hall', parent: 'w-1', at: [2000, 0, 40000], text: 'Town hall' },
    { id: 'w-3', kind: 'eden:room', parent: 'w-2', at: [0, 0, 0] },
    { id: 'w-4', kind: 'eden:room', parent: 'w-2', at: [3000, 0, 0] },
    { id: 'w-5', kind: 'eden:bench', parent: 'w-1', at: [-10000, 0, 5000], text: 'Lovers\' bench' },
    { id: 'w-6', kind: 'eden:footpath', parent: 'w-1', at: [0, 0, 20000] },
    { id: 'w-7', kind: 'eden:cup', parent: 'w-3', at: [500, 800, 500] },
  ] };
  const entries = { 'eden:hall': { geometry: { bounds_mm: [20000, 8000, 12000] } }, 'eden:bench': { geometry: { bounds_mm: [1800, 900, 600] } } };
  const zones = { 142: [['zone:market', 'use:commercial', [[0, 0], [10000, 0], [10000, 6000], [0, 6000]]]] };
  const map = mapOf(d, zones, entries);
  assert.deepEqual(map.extent, { west: -10.9, east: 12, north: 4.7, south: 46, width: 22.9, depth: 41.3, things: 3 });
  assert.deepEqual(map.buildings.shown, [{ id: 'w-2', kind: 'eden:hall', name: 'Town hall', at: [2, 40], size: [20, 12], rooms: 2 }]);
  assert.deepEqual(map.named.shown, [{ id: 'w-5', kind: 'eden:bench', name: 'Lovers\' bench', at: [-10, 5], size: [1.8, 0.6] }]);
  assert.deepEqual(map.roads.shown, [{ id: 'w-6', kind: 'eden:footpath', at: [0, 20] }]);
  assert.deepEqual(map.zones.shown, [{ name: 'market', use: 'commercial', at: [5, 3], size: [10, 6] }]);
});

test('map: at most MAP_MOST of each, the rest counted; an empty world has no extent', () => {
  const nodes = [{ id: 'w-0', kind: 'souls:place', parent: null }, ...Array.from({ length: MAP_MOST + 5 }, (_, i) => ({ id: `w-${i + 1}`, kind: 'eden:bench', parent: 'w-0', at: [i * 1000, 0, 0], text: `bench ${i}` }))];
  const map = mapOf({ nodes });
  assert.equal(map.named.shown.length, MAP_MOST); assert.equal(map.named.more, 5);
  assert.equal(mapOf({ nodes: [{ id: 'w-0', kind: 'souls:place', parent: null }] }).extent, null);
});
