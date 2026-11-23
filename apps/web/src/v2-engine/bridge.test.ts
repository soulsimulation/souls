// #4153: the bridge turns what the v2 reader's worker posts into the page's takes and Souls (bridge.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { V2Bridge, doingOf } from './bridge.ts';
import { TICK_US, TICKS } from './takes.ts';

const Q = 2 ** 30, T0 = 1_000_000_000_000; // world µs, a whole number of chunks
const node = (id: string, parent: string | null, pos: [number, number, number], extra: object = {}) => ({ id, kind: 'eden:floor@1', parent, slot: null, pos, rot: [Q, 0, 0, 0] as [number, number, number, number], at: null, ...extra });
// A building 100 m east, turned a quarter turn about +y; a floor in it 3 m up; a body on the floor.
const half = Math.SQRT1_2 * Q;
const world = node('w.0', null, [0, 0, 0], { kind: 'souls:place@1' });
const building = { ...node('w.1', 'w.0', [100_000_000, 0, 0]), rot: [half, 0, half, 0] as [number, number, number, number] };
const floor = node('w.2', 'w.1', [0, 3_000_000, 0]);
const body = node('b.7', 'w.2', [1_000_000, 0, 0], { kind: 'souls:body@1', soul: 'soul-abc-7', name: 'Ada', at: T0 });
const part = (n: number, samples: [string, string, number | null, number, number, number, number][], extra: object = {}) =>
  ({ t: 'part' as const, p: { number: n, from: T0 + n * 500_000, to: T0 + (n + 1) * 500_000, nodes: [], removed: [], samples, ...extra } });

test('a body in a turned building is drawn in the world frame, with the page\'s Soul and entity ids', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, building, floor, body], removed: [] } });
  // walks 2 m along the floor's +x over 2 s, sampled every 0.5 s; the parts run 6 s on so whole chunks are made
  for (let n = 0; n < 12; n++) b.receive(part(n, n <= 4 ? [['b.7', 'w.2', null, T0 + n * 500_000, 1_000_000 + n * 500_000, 0, 0]] : []));
  assert.deepEqual([...b.view.souls.values()], [{ id: 's_abc-7', entityId: 'v2_b_7', name: 'Ada', description: '', doing: 'standing', state: 'awake' }],
    'shown 2 s behind the newest part, its last step 2 s before that: standing');
  const take = b.view.takes.chunks.find((c) => c.fromTick === T0 / TICK_US)!.take as unknown as Take;
  const at = (s: number) => sampleTake(take, s).entities.v2_b_7;
  // a quarter turn about +y takes the floor's +x to the world's -z: (100 + 0, 3, -1) m at the start
  assert.deepEqual(at(0).p.map((x) => +x.toFixed(3)), [100, 3, -1]);
  assert.deepEqual(at(1).p.map((x) => +x.toFixed(3)), [100, 3, -2]);
  assert.equal(at(0.5).activity, 'walk');
  assert.ok(Math.abs(at(0.5).yaw - Math.atan2(-1, 0)) < 0.002, 'it faces the way it walks in the world (-z)');
});

test('no chunk until the world is past it by the v2 page\'s lag; a body the copy cannot place is hidden, not moved', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, building, floor, body], removed: [] } });
  b.receive(part(0, [['b.7', 'w.2', null, T0, 1_000_000, 0, 0]]));
  assert.equal(b.view.takes.chunks.length, 0, 'half a second in: nothing whole yet');
  for (let n = 1; n < 5; n++) b.receive(part(n, []));
  assert.equal(b.view.takes.chunks.length, 0, '2.5 s in: the first chunk ends 1 s in, within the 2 s lag');
  b.receive(part(5, []));
  assert.equal(b.view.takes.chunks.length, 1, '3 s in: the world is 2 s past the first chunk');
  b.receive(part(6, [], { removed: ['b.7'] })); // into a frame that is not public: the worker says it is gone
  for (let n = 7; n < 16; n++) b.receive(part(n, []));
  const chunks = b.view.takes.chunks, hidden = chunks.filter((c) => c.fromTick * TICK_US >= T0 + 6 * 500_000);
  assert.ok(chunks.some((c) => 'v2_b_7' in (c.take as { tracks: object }).tracks), 'drawn before it went');
  assert.ok(hidden.length && hidden.every((c) => !('v2_b_7' in (c.take as { tracks: object }).tracks)), 'not drawn after');
  assert.equal(b.view.takes.serverTick, chunks.at(-1)!.toTick);
  assert.equal((chunks.at(-1)!.toTick - chunks[0].fromTick) % TICKS, 0);
});

test('B3-3: a Soul\'s card fields from the stream: its description, and what it is doing now as the v2 page says it', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, building, floor, { ...body, description: 'Keeps the bees.' }], removed: [] } });
  const soul = () => b.view.souls.get('s_abc-7')!;
  // walking: a step every half second up to the time shown (2 s behind the newest part)
  for (let n = 0; n < 8; n++) b.receive(part(n, [['b.7', 'w.2', null, T0 + n * 500_000, 1_000_000 + n * 100_000, 0, 0]]));
  assert.equal(soul().description, 'Keeps the bees.');
  assert.equal(soul().doing, 'walking');
  // speaking while its sentence is on at the time shown
  b.receive(part(8, [], { said: [{ speaker: 'b.7', at: T0 + 2_000_000, length: 3_000_000, words: 'Morning!' }] }));
  assert.equal(soul().doing, 'speaking');
  // the world winds it down (B16): zombie, until it is awake again; then standing (no step for a while)
  for (let n = 9; n < 16; n++) b.receive(part(n, [], n === 9 ? { happened: [{ at: T0 + 2_500_000, node: 'b.7', name: 'souls:zombie' }] } : {}));
  assert.deepEqual([soul().doing, soul().state], ['zombie', 'zombie']);
  b.receive(part(16, [], { happened: [{ at: T0 + 8_000_000, node: 'b.7', name: 'souls:awake' }] }));
  for (let n = 17; n < 20; n++) b.receive(part(n, []));
  assert.deepEqual([soul().doing, soul().state], ['standing', 'awake']);
  // seated while it is in a slot
  assert.equal(doingOf({ ...body, slot: 2 }, [], T0, false, undefined), 'seated');
  assert.equal(doingOf(body, [{ at: T0 }], T0, false, undefined), 'standing', 'one placement is not a walk');
});
