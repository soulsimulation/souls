import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildCatalog, kindOf, type CatalogInput} from './catalog.ts';

const square = (x: number, z: number): [number, number][] => [[x, z], [x + 10, z], [x + 10, z + 10], [x, z + 10]];
const input = (): CatalogInput => ({worldId: 'w-1',
  places: [
    {id: 'world', name: 'World', kind: 'region', parent: null, level: 0, polygon: square(-100, -100)},
    {id: 'g-library', ref: 'library', name: 'Library', kind: 'building', parent: 'world', level: 0, polygon: square(0, 0), aliases: ['the stacks'], description: 'Reading tables and shelves.'},
    {id: 'g-grove', name: 'Hidden Grove', kind: 'grove', parent: 'world', level: 0, polygon: square(40, 40), secret: true},
    {id: 'basket', name: 'Balloon basket', kind: 'vehicle', parent: 'world', level: 0, polygon: square(0, 0), carrier: {entity: 'balloon'}},
  ],
  spots: [
    {id: 'eat.e_0aa1', place: 'g-library', activity: 'eat', also: ['drink'], at: [2.04, 3.06], label: 'reading table in Library'},
    {id: 'seesaw.e_0bb2.1', place: 'world', activity: 'seesaw', at: [20, 20], together: {need: 1}, title: 'Ride the see-saw'},
    {id: 'read.e_0cc3', place: 'g-grove', activity: 'read', at: [45, 45]},
  ],
  things: [
    {id: 'e_0aa1', kind: 'ew:core-table@2:c56a7cb231', name: 'library/reading-table', at: [2, 3], place: 'g-library'},
    {id: 'e_0dd4', kind: 'core-chair@1', name: 'grove-chair', at: [45, 45], place: 'g-grove'},
  ]});

test('a kind is named as people name it', () => {
  assert.equal(kindOf('ew:core-bowl@1:c56a7cb231'), 'core-bowl');
  assert.equal(kindOf('core-chair@12'), 'core-chair');
  assert.equal(kindOf('bench'), 'bench');
});

test('the same world gives the same bytes and the same version', () => {
  const a = buildCatalog(input()), b = buildCatalog({...input(), things: [...input().things].reverse(), spots: [...input().spots].reverse()});
  assert.equal(a.serialized, b.serialized);
  assert.equal(a.etag, b.etag);
  assert.equal(a.etag, `"${a.version}"`);
});

test('a place keeps its id, names its ref, and a carrier place is marked fixed', () => {
  const {payload} = buildCatalog(input()), lib = payload.places.find(p => p.id === 'g-library')!;
  assert.equal(lib.ref, 'library');
  assert.deepEqual(lib.at, [5, 5]);
  assert.deepEqual(lib.aliases, ['the stacks']);
  assert.equal(payload.places.find(p => p.id === 'basket')!.fixed, true);
});

test('every spot activity is an act by id, tied to its thing and place', () => {
  const {payload} = buildCatalog(input());
  assert.deepEqual(payload.acts.filter(a => a.place === 'g-library').map(a => a.id), ['drink:eat.e_0aa1', 'eat:eat.e_0aa1']);
  const eat = payload.acts.find(a => a.id === 'eat:eat.e_0aa1')!;
  assert.equal(eat.thing, 'e_0aa1');
  assert.deepEqual(eat.at, [2, 3.1]);
  const seesaw = payload.acts.find(a => a.verb === 'seesaw')!;
  assert.equal(seesaw.with, 1);
  assert.equal(seesaw.label, 'Ride the see-saw (world)');
});

test('a secret place, what stands in it and what is done in it are left out', () => {
  const {payload, serialized} = buildCatalog(input());
  assert.equal(payload.places.some(p => p.id === 'g-grove'), false);
  assert.equal(payload.things.some(t => t.id === 'e_0dd4'), false);
  assert.equal(payload.acts.some(a => a.place === 'g-grove'), false);
  assert.equal(serialized.includes('Hidden Grove'), false);
});

test('everything published is public, and the counts match', () => {
  const {payload} = buildCatalog(input());
  assert.equal(payload.scope, 'public');
  assert.deepEqual(payload.counts, {places: 3, things: 1, acts: 3, kinds: 1});
});
