// 0.133 item 6: Build's place, move and remove from what the stream shows.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ARRIVAL, arrivalSet, buildKinds, groundOf, isPlace, isThing, moveOp, placeMiddle, placeOp, placeUnder, removeOp, shortKind, spotIn, thingNear, thingOf, type BuildNode } from './creator-build.ts';
import { entityId } from './creator-kinds.ts';

const S = '1a'.repeat(16), Q = 1 << 30, I: [number, number, number, number] = [Q, 0, 0, 0];
const HASH = '1220' + 'ab'.repeat(32);
const nodes = new Map<string, BuildNode>([
  [`${S}.1`, { id: `${S}.1`, kind: 'eden:world', parent: null, pos: [0, 0, 0], rot: I }],
  [`${S}.2`, { id: `${S}.2`, kind: 'eden:ground', parent: `${S}.1`, pos: [0, 0, 0], rot: I, tiles: [[0, 0]] }],
  [`${S}.3`, { id: `${S}.3`, kind: `eden:park_bench@${HASH}`, parent: `${S}.2`, pos: [4e6, 1e6, -2e6], rot: [0, 0, Q, 0], origin: 'e_bench1' }],
  [`${S}.4`, { id: `${S}.4`, kind: 'eden:humanoid@x', parent: `${S}.2`, pos: [4e6, 0, -2e6], rot: I, soul: 'soul-a' }],
  // a hut turned a quarter about +y, and a stool inside it, and one held in its slot
  [`${S}.5`, { id: `${S}.5`, kind: 'eden:hut@y', parent: `${S}.2`, pos: [10e6, 0, 0], rot: [Math.round(Q * Math.SQRT1_2), 0, Math.round(Q * Math.SQRT1_2), 0] }],
  [`${S}.6`, { id: `${S}.6`, kind: 'eden:stool@z', parent: `${S}.5`, pos: [1e6, 0, 0], rot: I }],
  [`${S}.7`, { id: `${S}.7`, kind: 'eden:cup@z', parent: `${S}.5`, pos: [0, 0, 0], rot: I, slot: 2 }],
  [`${S}.8`, { id: `${S}.8`, kind: 'souls:kind', parent: `${S}.1`, defines: `me:lamp@${HASH}` }],
  [`${S}.9`, { id: `${S}.9`, kind: 'eden:lawn@w', parent: `${S}.2`, pos: [0, 0, 0], rot: I, outline: [[0, 0], [1, 0], [1, 1]] }],
]);

test('the kinds offered are those of the things on the ground and the creator-defined, by full name; bodies, frames and areas are not things', () => {
  assert.deepEqual(buildKinds(nodes), ['eden:hut@y', `me:lamp@${HASH}`, `eden:park_bench@${HASH}`], 'what stands on the ground, not what is in a building');
  assert.equal(shortKind(`eden:park_bench@${HASH}`), 'park bench');
  assert.deepEqual([...nodes.values()].filter(isThing).map((n) => n.id.split('.')[1]), ['3', '5', '6', '7']);
});

test('a place goes on the open ground, at the clicked point in its frame, µm', () => {
  assert.equal(groundOf(nodes), `${S}.2`);
  assert.deepEqual(placeOp(nodes, `eden:park_bench@${HASH}`, [1.5, 0.25, -3]), { op: 'place', name: 1, kind: `eden:park_bench@${HASH}`, parent: `${S}.2`, at: { x: 1_500_000, y: 250_000, z: -3_000_000 } });
  assert.deepEqual(placeOp(new Map(), 'eden:x', [0, 0, 0]), { why: 'The world\'s ground is not loaded yet.' });
});

test('a move is in the thing\'s parent\'s frame and keeps its facing; one held in a slot is not moved', () => {
  assert.deepEqual(moveOp(nodes, `${S}.3`, [5, 1, -2]), { op: 'move', node: `${S}.3`, at: { x: 5e6, y: 1e6, z: -2e6 }, rot: [0, 0, Q, 0] });
  // the hut stands at x 10 turned +90° about y: the world's (10, 0, -1) is its (1, 0, 0)
  const at = spotIn(nodes, `${S}.5`, [10, 0, -1])!;
  assert.deepEqual([Math.round(at.x / 1000), Math.round(at.y / 1000), Math.round(at.z / 1000)], [1000, 0, 0]);
  assert.match((moveOp(nodes, `${S}.7`, [0, 0, 0]) as { why: string }).why, /held in a slot/);
  assert.match((moveOp(nodes, `${S}.4`, [0, 0, 0]) as { why: string }).why, /not in the world/, 'a Soul\'s body is never Build\'s');
  assert.deepEqual(removeOp(`${S}.3`), { op: 'remove', node: `${S}.3` });
});

test('a click names a thing by the entity the page draws it as, or by standing nearest', () => {
  assert.equal(thingOf(nodes, 'e_bench1'), `${S}.3`, 'the world\'s own thing by its origin');
  assert.equal(thingOf(nodes, entityId(`${S}.6`)), `${S}.6`, 'a creator\'s by the id made from its node');
  assert.equal(thingOf(nodes, entityId(`${S}.4`)), null);
  assert.equal(thingNear(nodes, [4.4, -2.2]), `${S}.3`);
  assert.equal(thingNear(nodes, [40, 40]), null);
});

test('#5006: a place under the pointer is the smallest area on the open ground there, and New Souls arrive here names it on the root', () => {
  const big = { id: `${S}.10`, kind: 'eden:place@p', parent: `${S}.2`, outline: [[-20000, -20000], [20000, -20000], [20000, 20000], [-20000, 20000]] };
  const pond = { id: `${S}.11`, kind: 'eden:place@p', parent: `${S}.2`, outline: [[2000, 2000], [6000, 2000], [6000, 8000], [2000, 8000]], placeName: 'the pond' };
  const room = { id: `${S}.12`, kind: 'eden:room@r', parent: `${S}.5`, outline: [[0, 0], [4000, 0], [4000, 4000]] };
  const all = new Map<string, BuildNode>([...nodes, [big.id, big], [pond.id, pond], [room.id, room]]);
  assert.equal(placeUnder(all, [3, 5]), pond.id, 'the pond, not the field round it');
  assert.equal(placeUnder(all, [-10, 0]), big.id);
  assert.equal(placeUnder(all, [30, 0]), null);
  assert.ok(isPlace(all, pond) && !isPlace(all, room), 'a room\'s outline is not a place on the open ground');
  assert.deepEqual(placeMiddle(pond), [4, 5]);
  assert.deepEqual(arrivalSet(all, pond.id), { sets: [{ node: `${S}.1`, field: ARRIVAL, value: [Uint8Array.from(Array(16).fill(0x1a)), 11] }] });
  assert.match((arrivalSet(all, `${S}.3`) as { why: string }).why, /not a place/);
});
