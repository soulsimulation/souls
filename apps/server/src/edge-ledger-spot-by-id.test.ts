// #1737: a spot named by its id is offered wherever the Soul stands (the catalog publishes every spot, and an act on one
// walks there), and one that cannot be used says why. The listing itself is unchanged: nearest few, within reach.
import test from 'node:test';
import assert from 'node:assert/strict';
import {activityCapabilities, loadSpots, SPOT_REACH} from './edge/ledger/activities.ts';

const spots = [
  ...Array.from({length: 6}, (_, i) => ({id: `eat.e_near${i}`, activity: 'eat', base: 'sit', at: [5 + i, 0], label: `near table ${i}`})),
  {id: 'eat.e_far', activity: 'eat', base: 'sit', at: [SPOT_REACH + 400, 0], also: ['drink'], label: 'far table'},
  {id: 'eat.e_shut', activity: 'eat', base: 'sit', at: [900, 10], place: 'shut-house', label: 'table in the shut house'},
  {id: 'eat.e_busy', activity: 'eat', base: 'sit', at: [900, 20], label: 'busy table'},
  {id: 'eat.e_wall', activity: 'eat', base: 'sit', at: [900, 30], label: 'table in the wall'},
];
const data = {...loadSpots({contract: 'activity-spots/1', spots}).data, nearest: 4};
const world = () => ({me: [0, 0] as [number, number], seated: false, clearance: (x: number, z: number) => (x === 900 && z === 30 ? 0 : 2), open: () => null,
  taken: (_at: [number, number], id?: string) => id === 'eat.e_busy', enterable: (place: string | undefined) => place !== 'shut-house', seat: () => null,
  placeName: () => null, ancestors: () => [], groupSize: () => 0, clock: null});
const ids = (want?: string[]) => activityCapabilities(data, world() as never, want ? new Set(want) : undefined);

test('the listing offers the nearest few of an activity and nothing beyond reach', () => {
  const eat = ids().caps.filter(c => c.verb === 'eat').map(c => c.id);
  assert.deepEqual(eat, ['eat:eat.e_near0', 'eat:eat.e_near1', 'eat:eat.e_near2', 'eat:eat.e_near3']);
  assert.equal(ids().why.size, 0);
});

test('a spot asked for by id is offered past the reach and past the nearest-few cap, with a plan that walks there', () => {
  const out = ids(['eat.e_far', 'eat.e_near5']);
  for (const id of ['eat:eat.e_far', 'drink:eat.e_far', 'eat:eat.e_near5']) {
    assert.ok(out.caps.some(c => c.id === id && c.available), id);
    assert.ok(out.plans.get(id)!.steps.some(s => /walk_to/.test(s.verb)), `${id} walks there`);
  }
  // asking for one does not spend the listing's own allowance
  assert.equal(out.caps.filter(c => c.verb === 'eat' && /near[0-3]$/.test(c.id)).length, 4);
  assert.equal(out.why.size, 0);
});

test('an asked spot that cannot be used is not offered, and says why', () => {
  const out = ids(['eat.e_shut', 'eat.e_busy', 'eat.e_wall']);
  for (const id of ['eat.e_shut', 'eat.e_busy', 'eat.e_wall']) assert.equal(out.caps.some(c => c.id === `eat:${id}`), false, id);
  assert.equal(out.why.get('eat.e_shut')!.code, 'place.closed');
  assert.equal(out.why.get('eat.e_busy')!.code, 'spot.taken');
  assert.equal(out.why.get('eat.e_wall')!.code, 'spot.no-room');
  assert.match(out.why.get('eat.e_busy')!.reason, /busy table is taken right now/);
});

test('#2189: a spot a Soul is using names that Soul in its refusal; the code is unchanged', () => {
  const named = (by: string | null) => activityCapabilities(data, {...world(), takenBy: (_at: [number, number], id?: string) => (id === 'eat.e_busy' ? by : null)} as never, new Set(['eat.e_busy'])).why.get('eat.e_busy')!;
  const ana = named('Ana');
  assert.equal(ana.code, 'spot.taken');
  assert.match(ana.reason, /^busy table is taken right now: Ana is using it, so nothing was done\. Ask again when Ana has finished/);
  // taken by a body that is not a Soul (or nobody to name): the reason names no one, as before
  assert.equal(named(null).reason, 'busy table is taken right now, so nothing was done. Another one of the same kind may be free.');
});
