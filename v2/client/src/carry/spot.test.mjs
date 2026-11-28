// A loading spot and the heavy loads crews carry to it (carry/spot.mjs): the bay each carrier's walk aims at, read from
// the copy and the kind entries, and the refusals by name before anyone moves.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { requestOf } from '../cli/souls.mjs';
import { byName, carryIntents, loadOf, placer } from './carry.mjs';
import { baysOf, crewOf } from './spot.mjs';

const ROOT = join(import.meta.dirname, '../../../../content/kinds/construction');
const kinds = Object.fromEntries(['carry', 'loading_spot', 'pallet_crates', 'generator', 'timber_bundle'].map((f) => {
  const e = JSON.parse(readFileSync(join(ROOT, `${f}.json`), 'utf8')); return [e.kind, e];
}));
const id = (n) => `${'cd'.repeat(16)}-${n}`;
const near = (a, b, what) => a.forEach((v, k) => assert.ok(Math.abs(v - b[k]) < 2, `${what}: ${a} vs ${b}`));
const ONE = 2 ** 30, YAW90 = [Math.round(ONE * Math.SQRT1_2), 0, Math.round(ONE * Math.SQRT1_2), 0];

// As Mars camp has them: the spot at (24, 24) m, its bays 1 to 4 from east to west; a generator lifted by a crew of four
// at (14, 24), its length along z: the front (this Soul) at its south end, the back at its north end, the sides east.
const GROUND = id(1), SPOT = id(2), CREW = id(3), GEN = id(4), ME = id(5), BACK = id(6), SIDE = id(7), SIDE2 = id(8);
const copy = (extra = [], { front = [14e6, 25.35e6], back = [14e6, 22.65e6] } = {}) => new Map([
  [GROUND, { id: GROUND, kind: 'eden:ground', parent: null }],
  [SPOT, { id: SPOT, kind: 'mars:loading_spot', name: 'loading-spot', parent: GROUND, pos: [24e6, 0, 24e6] }],
  [CREW, { id: CREW, kind: 'mars:carry_activity', parent: GROUND, members: [{ body: ME }, { body: BACK }, { body: SIDE }, { body: SIDE2 }] }],
  [GEN, { id: GEN, kind: 'mars:generator', name: 'generator', parent: CREW, pos: [0, 0, 0] }],
  [ME, { id: ME, kind: 'souls:body', soul: 's1', parent: GROUND, pos: [front[0], 0, front[1]] }],
  [BACK, { id: BACK, kind: 'souls:body', soul: 's2', parent: GROUND, pos: [back[0], 0, back[1]] }],
  [SIDE, { id: SIDE, kind: 'souls:body', soul: 's3', parent: GROUND, pos: [14.9e6, 0, 23.55e6] }],
  ...extra.map((r) => [r.id, { parent: GROUND, ...r }]),
]);
const ctxOf = (rows, over = {}) => {
  const at = placer(rows, () => null, (r) => kinds[r?.kind]);
  const ends = [ME, BACK].map((b) => [rows.get(b).pos[0], rows.get(b).pos[2]]);
  return {
    ns: 'mars', ground: GROUND, kinds, me: ME, placeOf: at, kindOf: (n) => rows.get(n)?.kind,
    crewMiddle: () => [(ends[0][0] + ends[1][0]) / 2, (ends[0][1] + ends[1][1]) / 2], heldBy: () => GEN,
    crewEnds: () => ({ ids: [ME, BACK], at: ends }), crewSize: (c) => rows.get(c)?.members?.length,
    loose: () => [...rows.values()].filter((r) => r.parent === GROUND && !r.soul && !/activity|place/.test(r.kind)).map((r) => r.id), ...over,
  };
};
const to = (rows, over) => carryIntents({ do: 'to', crew: CREW, where: SPOT }, ctxOf(rows, over));

test('the loads take the crews their entries name, and the spot has four bays that fit the longest', () => {
  assert.deepEqual(['mars:pallet_crates', 'mars:generator', 'mars:timber_bundle'].map((k) => crewOf(kinds[k])), [2, 4, 4]);
  assert.deepEqual(['mars:pallet_crates', 'mars:generator', 'mars:timber_bundle'].map((k) => 2 + loadOf(kinds[k]).inner.length), [2, 4, 6], 'one carrier a grip: at most');
  const bays = baysOf({ pos: [24e6, 0, 24e6] }, kinds['mars:loading_spot'], 'mars:timber_bundle');
  assert.deepEqual(bays.map((b) => [b.name, b.point]), [['bay_1', [27.6e6, 24e6]], ['bay_2', [25.2e6, 24e6]], ['bay_3', [22.8e6, 24e6]], ['bay_4', [20.4e6, 24e6]]]);
  assert.ok(bays.every((b) => b.half[0] >= 2.4e6), 'a 4.8 m bundle fits each');
});

test('the loading spot is found by name as said: "the loading spot"', () => {
  assert.equal(byName({ do: 'to', crew: CREW, where: 'the loading spot' }, copy()).where, SPOT);
  assert.equal(byName({ do: 'to', crew: CREW, where: 'loading-spot' }, copy()).where, SPOT, 'its name as look shows it');
  // a whole name still wins over one said loosely
  const two = copy([{ id: id(20), kind: 'mars:pallet_crates', name: 'loading spot' }]);
  assert.equal(byName({ do: 'to', crew: CREW, where: 'loading spot' }, two).where, id(20));
});

test('each carrier walks so the load goes into the first free bay, the far one first, keeping its place at the load', () => {
  const r = to(copy());
  assert.equal(r.bay, 'bay_1');
  near(r[0].params[1], [27.6e6, 0, 25.35e6], 'the front, at the bay\'s south end');
  assert.deepEqual(r[0].params[3], [0, 1e6], 'the load\'s heading there, its front to the south: the front\'s walk turns the crew');
  near(carryIntents({ do: 'to', crew: CREW, where: SPOT }, { ...ctxOf(copy()), me: SIDE })[0].params[1], [28.5e6, 0, 23.55e6], 'a side, beside it');
  // a pallet set down in bay 1: the next bay
  const one = copy([{ id: id(20), kind: 'mars:pallet_crates', pos: [27.5e6, 0, 24.3e6] }]);
  assert.equal(to(one).bay, 'bay_2');
  near(to(one)[0].params[1], [25.2e6, 0, 25.35e6], 'into bay 2');
});

test('a load carried crosswise is turned square into the bay, the nearer way', () => {
  // the crew east-west: the front east of the back; the bay runs north-south
  const r = to(copy([], { front: [15.35e6, 24e6], back: [12.65e6, 24e6] }));
  near(r[0].params[1], [27.6e6, 0, 25.35e6], 'the front ends at the bay\'s south end');
});

test('a full spot, a crew too small, a load that fits no bay and nothing lifted are refused before anyone moves', () => {
  const full = copy([0, 1, 2, 3].map((k) => ({ id: id(20 + k), kind: 'mars:pallet_crates', pos: [27.6e6 - k * 2.4e6, 0, 24e6] })));
  const r = to(full);
  assert.equal(r.code, 'carry-spot-full');
  assert.match(r.detail, /bay_1 by .*bay_4 by/);
  const small = to(copy(), { crewSize: () => 2 });
  assert.equal(small.code, 'carry-crew-too-small');
  assert.match(small.detail, /2 carrying mars:generator; it takes 4/);
  const long = { ...kinds['mars:generator'], geometry: { bounds_mm: [1000, 1100, 6000] } };
  assert.equal(to(copy(), { kinds: { ...kinds, 'mars:generator': long } }).code, 'carry-spot-no-fit');
  assert.equal(to(copy(), { heldBy: () => null }).code, 'carry-crew-unseen');
  assert.equal(to(copy(), { kindOf: (n) => (n === GEN ? 'mars:rack_beam' : copy().get(n)?.kind) }).code, 'carry-spot-wrong-load');
  // a bay named still goes there, as into any slot
  assert.equal(carryIntents({ do: 'to', crew: CREW, where: SPOT, slot: 'bay_3' }, ctxOf(full))[0].verb, 'mars:walk');
});

test('a side carrier grips beside the n-th grip between the ends, counted from the back', () => {
  const rows = copy([{ id: id(30), kind: 'mars:timber_bundle', name: 'timber-bundle', pos: [11.6e6, 0, 24e6] }, { id: id(31), kind: 'mars:generator', pos: [0, 0, 0], rot: YAW90 }]);
  const grip = (thing, end, n) => carryIntents({ do: 'grip', thing, end, n }, ctxOf(rows));
  near(grip(id(30), 'right', '1')[0].params[1], [11.6e6 + 800_000, 0, 22.5e6], 'the first, east of it');
  near(grip(id(30), 'left', '4')[0].params[1], [11.6e6 - 800_000, 0, 25.5e6], 'the fourth, west of it');
  near(grip(id(31), 'right', '2')[0].params[1], [450_000, 0, -1_000_000], 'a generator turned east: its right is north');
  assert.equal(grip(id(30), 'right', '5').code, 'carry-grip-unknown');
});

test('the command line: a place named in words is one name; a side grip takes its number', () => {
  const r = (...w) => requestOf(w).req;
  assert.deepEqual(r('carry', 'to', CREW, 'the', 'loading', 'spot'), { op: 'carry', do: 'to', crew: CREW, where: 'the loading spot' });
  assert.deepEqual(r('carry', 'to', CREW, 'loading-spot'), { op: 'carry', do: 'to', crew: CREW, where: 'loading-spot' });
  assert.deepEqual(r('carry', 'grip', 'generator', 'right', '2'), { op: 'carry', do: 'grip', thing: 'generator', end: 'right', n: '2' });
});
