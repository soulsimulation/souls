// #628 (acts by id, #1737): on Eden 2026, 29 kitchen counters and an easel were published in the catalog and every act on
// them by id was refused spot.no-room. Each counter's own chair stood on its standing point and on the whole line straight
// back from it, though there was clear floor beside it. A standing spot now uses the nearest clear point beside it, still
// at the thing. A spot with no clear ground anywhere near is still refused, and the refusal names another one to use.
import test from 'node:test';
import assert from 'node:assert/strict';
import {activityCapabilities, besideAt, loadSpots, SIDE_STEP} from './edge/ledger/activities.ts';

type V2 = [number, number];
// a counter at (10, 0), 2 m long along x, its standing point 0.85 m in front (+z); a chair fills a 0.8 m strip in front of it
const counter = (x: number, z: number) => Math.abs(x - 10) < 1 && Math.abs(z) < 0.4;
const chairStrip = (x: number, z: number) => Math.abs(x - 10) < 0.4 && z >= 0.4 && z <= 2;
const kitchen = (x: number, z: number) => (counter(x, z) || chairStrip(x, z) ? 0 : 2);
const walled = (x: number, z: number) => (Math.hypot(x - 10, z) < 3 ? 0 : 2);
const spots = [
  {id: 'craft.e_counter', activity: 'craft', base: 'idle', at: [10, 0.85], faceTo: [10, 0], label: 'kitchen counter'},
  {id: 'craft.e_bench', activity: 'craft', base: 'idle', at: [40, 0.85], faceTo: [40, 0], label: 'workbench in the barn'},
];
const data = loadSpots({contract: 'activity-spots/1', spots}).data;
const world = (clearance: (x: number, z: number) => number) => ({me: [0, 0] as V2, seated: false, clearance, open: () => null, taken: () => false,
  enterable: () => true, seat: () => null, placeName: () => null, ancestors: () => [], groupSize: () => 0, clock: null});
const goal = (out: ReturnType<typeof activityCapabilities>, id: string) => {
  const step = out.plans.get(id)!.steps.find(s => /walk_to/.test(s.verb))!; return (step.params as {to: V2}).to;
};

test('a counter whose chair stands on its standing point is used from clear floor beside it, still at the counter', () => {
  const out = activityCapabilities(data, world(kitchen) as never, new Set(['craft.e_counter']));
  assert.ok(out.caps.some(c => c.id === 'craft:craft.e_counter' && c.available), 'offered when asked for by id');
  assert.equal(out.why.size, 0);
  const at = goal(out, 'craft:craft.e_counter');
  assert.ok(kitchen(at[0], at[1]) >= 0.28, `stands on clear floor (${at})`);
  assert.ok(Math.hypot(at[0] - 10, at[1] - 0.85) <= 0.9 + 1e-9, 'within 0.9 m of the spot');
  assert.ok(Math.abs(Math.hypot(at[0] - 10, at[1]) - 0.85) <= SIDE_STEP + 1e-9, 'about as far from the counter as the spot');
  const pose = out.plans.get('craft:craft.e_counter')!.steps.at(-1)!.params as {face?: V2};
  assert.deepEqual(pose.face, [10, 0], 'and works facing the counter');
});

test('a spot whose line back is clear keeps the first clear point on it, as before', () => {
  const back = (x: number, z: number) => (z < 1.2 && Math.abs(x - 10) < 3 ? 0 : 2);   // clear from 0.35 m straight back: the first 0.1 m step there is 0.4 m
  assert.deepEqual(goal(activityCapabilities(data, world(back) as never, new Set(['craft.e_counter'])), 'craft:craft.e_counter'), [10, 1.25]);
  // and a spot with room where it is stays where it is
  assert.deepEqual(goal(activityCapabilities(data, world(kitchen) as never, new Set(['craft.e_bench'])), 'craft:craft.e_bench'), [40, 0.85]);
});

test('a spot with no clear ground near it is still refused, and the refusal names another one', () => {
  const out = activityCapabilities(data, world(walled) as never, new Set(['craft.e_counter']));
  assert.equal(out.caps.some(c => c.id === 'craft:craft.e_counter'), false, 'not offered');
  const why = out.why.get('craft.e_counter')!;
  assert.equal(why.code, 'spot.no-room');
  assert.match(why.reason, /waiting will not change that/);
  assert.match(why.reason, /nearest other one is workbench in the barn \(craft:craft\.e_bench\)/);
});

test('besideAt: the nearest clear point to the spot, never inside the thing, null with none', () => {
  const p = besideAt([10, 0.85], [10, 0], 0.85, {clearance: kitchen})!;
  assert.ok(kitchen(p[0], p[1]) >= 0.28 && !counter(p[0], p[1]));
  assert.equal(besideAt([10, 0.85], [10, 0], 0.85, {clearance: walled}), null);
});

test('a refusal never names an alternative in a secret place the Soul does not know; it names the next one, or none', () => {
  const more = loadSpots({contract: 'activity-spots/1', spots: [...spots, {id: 'craft.e_far', activity: 'craft', base: 'idle', at: [80, 0.85], faceTo: [80, 0], label: 'potting table'}]}).data;
  const secret = (ids: string[]) => ({...world(walled), hidden: (id: string) => ids.includes(id)});
  const reason = (ids: string[]) => activityCapabilities(more, secret(ids) as never, new Set(['craft.e_counter'])).why.get('craft.e_counter')!.reason;
  assert.match(reason([]), /workbench in the barn \(craft:craft\.e_bench\)/);
  const next = reason(['craft.e_bench']);
  assert.doesNotMatch(next, /barn|e_bench/, 'the secret one is not named');
  assert.match(next, /potting table \(craft:craft\.e_far\)/, 'the nearest one it may know is');
  const none = reason(['craft.e_bench', 'craft.e_far']);
  assert.doesNotMatch(none, /nearest other one|barn|potting/, 'no alternative at all rather than a secret one');
  assert.match(none, /waiting will not change that, so nothing was done\.$/);
});

test('a spot with a little room where it is and its line back blocked keeps its own point (main used it there)', () => {
  // 0.1 m of clearance on the spot itself, nothing clear straight back, clear floor 0.6 m to the side: before #628 it walked to
  // the spot itself; the side search runs only where the old rule refused
  const band = (x: number, z: number) => (counter(x, z) ? 0 : Math.abs(x - 10) < 0.4 && z >= 0.4 && z <= 2 ? (Math.abs(x - 10) < 0.05 && Math.abs(z - 0.85) < 0.05 ? 0.1 : 0) : 2);
  assert.equal(band(10, 0.85), 0.1);
  assert.deepEqual(goal(activityCapabilities(data, world(band) as never, new Set(['craft.e_counter'])), 'craft:craft.e_counter'), [10, 0.85]);
});

test('a spot used from beside it is taken by a body standing on that point, and the refusal says so', () => {
  const first = goal(activityCapabilities(data, world(kitchen) as never, new Set(['craft.e_counter'])), 'craft:craft.e_counter');
  // another body 0.6 m past the beside point, away from the spot: more than 0.7 m from the spot itself, so only the new check sees it
  const body: V2 = [first[0] - 0.6, first[1]], near = (p: V2) => Math.hypot(p[0] - body[0], p[1] - body[1]) < 0.7;
  assert.ok(!near([10, 0.85]) && near(first), `the body is near the beside point only (${first})`);
  const out = activityCapabilities(data, {...world(kitchen), taken: (at: V2) => near(at)} as never, new Set(['craft.e_counter']));
  assert.equal(out.caps.some(c => c.id === 'craft:craft.e_counter'), false, 'not offered');
  assert.equal(out.why.get('craft.e_counter')?.code, 'spot.taken');
});
