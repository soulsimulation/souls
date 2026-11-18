import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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

test('a place carries its outline to 0.1 m; a place on a carrier, in the carrier\'s own frame, has none (#1915)', () => {
  const base = input(), {payload} = buildCatalog({...base, places: base.places.map(p => p.id === 'g-library' ? {...p, polygon: [[0.04, 0], [10.06, 0], [10, 9.96], [0, 10]]} : p)});
  assert.deepEqual(payload.places.find(p => p.id === 'g-library')!.outline, [[0, 0], [10.1, 0], [10, 10], [0, 10]]);
  assert.equal(payload.places.find(p => p.id === 'basket')!.outline, undefined);
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
  assert.deepEqual(payload.counts, {places: 4, things: 2, acts: 4, kinds: 2, handKinds: 0, handThings: 0});
  assert.ok(payload.places.some(p => p.id === 'g-grove') && payload.things.some(t => t.id === 'e_0dd4') && payload.acts.some(a => a.place === 'g-grove'));
});

test('what can be done on the spot is published as <verb>:here, and every such verb is one the world acts on', () => {
  const {payload} = buildCatalog(input());
  assert.ok(payload.anywhere.some(a => a.id === 'sit-ground:here' && /floor/.test(a.label)));
  assert.equal(payload.anywhere.length, ANYWHERE.length);
  for (const [verb] of ANYWHERE) assert.ok((EDGE_ACT_VERBS as readonly string[]).includes(verb), verb);
});

test('walk-to:here is published with the acts done on the spot (#1916)', () => {
  const {payload} = buildCatalog(input());
  assert.deepEqual(payload.anywhere.find(a => a.id === 'walk-to:here'), {id: 'walk-to:here', verb: 'walk-to', label: 'Walk to a point on your level'});
});

// #1751: what a kind of thing takes by hand, from the def's own action list (the engine bridge's thingActs)
const switchable = {acts: [{verb: 'switch-on', label: 'Switch on', when: [{field: 'on', is: false}]}, {verb: 'switch-off', label: 'Switch off', when: [{field: 'on', is: true}]}], state: {on: true}};
test('a kind worked by hand is published once with its acts and the state they read; a revision without them says so', () => {
  const base = input(), {payload} = buildCatalog({...base, things: [...base.things,
    {id: 'e_l1', kind: 'core-desk-lamp@1', name: 'desk-lamp-1', at: [3, 3], place: 'g-library', hand: switchable},
    {id: 'e_l2', kind: 'ew:core-desk-lamp@1:abc', name: 'desk-lamp-2', at: [4, 4], place: 'g-library', hand: switchable},
    {id: 'e_l0', kind: 'core-desk-lamp@0', name: 'old-lamp', at: [5, 5], place: 'g-library', hand: null},
    {id: 'e_l3', kind: 'core-desk-lamp@3', name: 'dim-lamp', at: [6, 6], place: 'g-library', hand: {acts: [...switchable.acts, {verb: 'dim', label: 'Dim'}], state: {on: false}}},
    {id: 'e_l9', kind: 'core-desk-lamp@1', name: 'grove-lamp', at: [45, 45], place: 'g-grove', hand: switchable},
    {id: 'e_bk', kind: 'core-ash-bucket@1', name: 'bucket', at: [7, 7], place: 'g-library', hand: {acts: [], state: {ash: 0}}}]});
  assert.deepEqual(Object.keys(payload.kinds), ['core-ash-bucket', 'core-desk-lamp', 'core-desk-lamp@3'], 'a revision with other acts or defaults has its own entry');
  assert.deepEqual(payload.kinds['core-ash-bucket'], {acts: [], state: {ash: 0}}, 'a kind that only has state (a bucket another thing fills) is published too');
  assert.equal(payload.things.find(t => t.id === 'e_l3')!.hands, 'core-desk-lamp@3');
  assert.deepEqual(payload.kinds['core-desk-lamp@3']!.state, {on: false});
  assert.deepEqual(payload.kinds['core-desk-lamp']!.acts.map(a => a.verb), ['switch-on', 'switch-off']);
  assert.deepEqual(payload.kinds['core-desk-lamp']!.state, {on: true});
  assert.equal(payload.things.find(t => t.id === 'e_l0')!.byHand, false);
  assert.equal(payload.things.find(t => t.id === 'e_l1')!.byHand, undefined);
  assert.equal(payload.things.some(t => t.id === 'e_l9'), true, 'a thing in a place whose data says secret is listed too (#1262)');
  assert.equal(payload.counts.handKinds, 3); assert.equal(payload.counts.handThings, 5);
});

test('a ref two places share is published for neither: walk:<id> names its place, walk:<ref> would name none (#1737)', () => {
  const lake = {id: 'g-lake', ref: 'lake', name: 'Lake', kind: 'water', parent: 'world', level: 0, polygon: square(0, 0)};
  const bank = {id: 'g-lake.bank', ref: 'lake', name: 'Lake bank', kind: 'shore', parent: 'world', level: 0, polygon: square(0, 0)};
  const jetty = {id: 'g-jetty', ref: 'jetty', name: 'Jetty', kind: 'pier', parent: 'world', level: 0, polygon: square(0, 0)};
  const {payload} = buildCatalog({worldId: 'w', places: [lake, bank, jetty], spots: [], things: []});
  assert.deepEqual(payload.places.map(p => [p.id, p.ref ?? null]), [['g-jetty', 'jetty'], ['g-lake', null], ['g-lake.bank', null]]);
});

test('native Eden: a building with an interior gives its doors, with position, level and facing, from its door gaps (#2261)', () => {
  const read = (f: string) => JSON.parse(readFileSync(new URL(`../../../../../worlds/eden/${f}`, import.meta.url), 'utf8'));
  const {places} = read('places.v1.json') as {places: CatalogInput['places']}, {interiors} = read('activity-spots.v1.json') as {interiors: NonNullable<CatalogInput['interiors']>};
  const {payload} = buildCatalog({worldId: 'eden', places, spots: [], things: [], interiors});
  const place = (id: string) => payload.places.find(p => p.id === id)!;
  // the Library: one door, the middle of its south wall (z -2.8), where #2224 read it from a walk in
  assert.deepEqual(place('eden-library-1').doors, [{at: [74, -2.8], level: 0, facing: 'south', approach: [74, -1.8]}]);
  // the Yurt: its south wall runs x 64.5..70.5 (middle 67.5); its door is 1.7 m west of the middle
  const yurt = place('eden-yurt');
  assert.deepEqual(yurt.doors, [{at: [65.8, -15.5], level: 0, facing: 'south', approach: [65.8, -14.5]}]);
  assert.ok(Math.abs(yurt.doors![0]!.at[0] - yurt.at[0]) > 1.5);
  // a door on a side wall faces that way (the Greenhouse's west wall); a place with no interior has none
  assert.deepEqual(place('eden-greenhouse').doors, [{at: [64, 35], level: 0, facing: 'west', approach: [63, 35]}]);
  assert.equal(payload.places.filter(p => p.doors).length, interiors.length);
  assert.equal(place('region-campus.library-annex').doors, undefined);
});
