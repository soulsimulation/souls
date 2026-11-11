import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ANYWHERE, buildCatalog, kindOf, type CatalogInput} from './catalog.ts';
import {EDGE_ACT_VERBS} from '../events/schema.ts';

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

test('everything published is public, and the counts match; a place whose data says secret is listed (#1262)', () => {
  const {payload} = buildCatalog(input());
  assert.equal(payload.scope, 'public');
  assert.deepEqual(payload.counts, {places: 4, things: 2, acts: 4, kinds: 2});
  assert.ok(payload.places.some(p => p.id === 'g-grove') && payload.things.some(t => t.id === 'e_0dd4') && payload.acts.some(a => a.place === 'g-grove'));
});

test('what can be done on the spot is published as <verb>:here, and every such verb is one the world acts on', () => {
  const {payload} = buildCatalog(input());
  assert.ok(payload.anywhere.some(a => a.id === 'sit-ground:here' && /floor/.test(a.label)));
  assert.equal(payload.anywhere.length, ANYWHERE.length);
  for (const [verb] of ANYWHERE) assert.ok((EDGE_ACT_VERBS as readonly string[]).includes(verb), verb);
});

test('a ref two places share is published for neither: walk:<id> names its place, walk:<ref> would name none (#1737)', () => {
  const lake = {id: 'g-lake', ref: 'lake', name: 'Lake', kind: 'water', parent: 'world', level: 0, polygon: square(0, 0)};
  const bank = {id: 'g-lake.bank', ref: 'lake', name: 'Lake bank', kind: 'shore', parent: 'world', level: 0, polygon: square(0, 0)};
  const jetty = {id: 'g-jetty', ref: 'jetty', name: 'Jetty', kind: 'pier', parent: 'world', level: 0, polygon: square(0, 0)};
  const {payload} = buildCatalog({worldId: 'w', places: [lake, bank, jetty], spots: [], things: []});
  assert.deepEqual(payload.places.map(p => [p.id, p.ref ?? null]), [['g-jetty', 'jetty'], ['g-lake', null], ['g-lake.bank', null]]);
});
