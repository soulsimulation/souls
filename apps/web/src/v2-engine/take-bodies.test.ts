// #4175: a v2 body in a slot sits (or lies) there in the take, stands when it leaves; a thing in its hand is its prop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { V2Bridge } from './bridge.ts';
import { TICK_US } from './takes.ts';
import { heldAt, postureOf, propOf, seatOf } from './take-bodies.ts';

const Q = 2 ** 30, T0 = 1_000_000_000_000;
const node = (id: string, kind: string, parent: string | null, pos: [number, number, number], extra: object = {}) =>
  ({ id, kind, parent, slot: null as number | null, pos, rot: [Q, 0, 0, 0] as [number, number, number, number], at: null, ...extra });
const world = node('w.0', 'souls:place@1', null, [0, 0, 0]);
// a chair 2 m east with a seat 450 mm up; a bed 5 m east with a slot 600 mm up; a cup on the ground
const chair = node('w.3', 'eden:chair@1', 'w.0', [2_000_000, 0, 0], { slots: [[0, 0, 450, 0, 0, 1]] });
const bed = node('w.4', 'eden:bed@2', 'w.0', [5_000_000, 0, 0], { slots: [[0, 0, 600, 0, 0, 1]] });
const cup = node('w.5', 'eden:cup@1', 'w.0', [1_000_000, 0, 1_000_000]);
const body = node('b.7', 'souls:body@1', 'w.0', [0, 0, 0], { soul: 'soul-abc-7', name: 'Ada', at: T0 });
const part = (n: number, nodes: object[] = [], samples: [string, string, number | null, number, number, number, number][] = []) =>
  ({ t: 'part' as const, p: { number: n, from: T0 + n * 500_000, to: T0 + (n + 1) * 500_000, nodes, removed: [], samples } as never });
const on = (b: V2Bridge, s: number) => {
  const tick = T0 / TICK_US + Math.round(s / 0.05), c = b.view.takes.chunks.find((x) => x.fromTick <= tick && tick < x.toTick)!;
  return sampleTake(c.take as unknown as Take, (tick - c.fromTick) * 0.05).entities.v2_b_7;
};

test('a body in a chair\'s slot is drawn sitting at the seat\'s height, feet on the floor, and stands when it leaves', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, chair, { ...body, pos: [2_000_000, 0, 0] }], removed: [] } as never });
  b.receive(part(0));
  b.receive(part(1));
  b.receive(part(2, [{ ...body, parent: 'w.3', slot: 0, pos: [0, 0, 0] }])); // sits at 1 s
  b.receive(part(3));
  b.receive(part(4, [{ ...body, parent: 'w.0', slot: null, pos: [2_500_000, 0, 0] }])); // stands at 2 s, beside it
  for (let n = 5; n < 14; n++) b.receive(part(n));
  assert.equal(on(b, 0.5).activity, 'idle');
  const seated = on(b, 1.5);
  assert.equal(seated.activity, 'sit');
  assert.equal(seated.state.seatHeight, 0.45);
  assert.deepEqual(seated.p.map((x) => +x.toFixed(3)), [2, 0, 0], 'the take has the feet on the floor under the seat');
  const up = on(b, 3);
  assert.equal(up.activity, 'idle');
  assert.ok(!up.state.seatHeight, 'standing, no seat height');
});

test('a body in a bed\'s slot is drawn lying', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, bed, { ...body, parent: 'w.4', slot: 0, pos: [0, 0, 0] }], removed: [] } as never });
  for (let n = 0; n < 10; n++) b.receive(part(n));
  const lying = on(b, 0.5);
  assert.equal(lying.activity, 'lie');
  assert.equal(lying.state.seatHeight, 0.6);
});

test('a thing in a body\'s frame is drawn in its hand while held, and gone when put down', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, cup, body], removed: [] } as never });
  b.receive(part(0));
  b.receive(part(1));
  b.receive(part(2, [{ ...cup, parent: 'b.7', pos: [300_000, 1_000_000, 0] }])); // picked up at 1 s
  b.receive(part(3));
  b.receive(part(4, [{ ...cup, parent: 'w.0', pos: [500_000, 0, 0] }])); // put down at 2 s
  for (let n = 5; n < 14; n++) b.receive(part(n));
  assert.equal(on(b, 0.5).state.prop, undefined, 'empty hands before');
  assert.equal(on(b, 1.5).state.prop, 'cup');
  assert.ok(!on(b, 2.5).state.prop, 'empty hands after');
  assert.ok(!on(b, 3).state.prop, 'and in the chunks after');
});

test('the pure parts: seats, postures, props and what is held when', () => {
  assert.deepEqual(seatOf('eden:bench@3', [1, 0, 420, 0, 0, 2]), { height: 420, lie: false });
  assert.equal(seatOf('eden:hammock@1', [0, 0, 900, 0, 0, 1]).lie, true);
  assert.equal(seatOf('eden:bedside-table@1', [0, 0, 600, 0, 0, 1]).lie, false, 'a bedside table is not a bed');
  assert.equal(postureOf(null), null);
  assert.equal(postureOf({ height: 400, lie: true }), 'lie');
  assert.equal(propOf('eden:tea-cup@1'), 'cup');
  assert.equal(propOf('eden:paperback_book@2'), 'book');
  assert.equal(propOf('eden:crate@1'), 'tool');
  const held = [{ at: 10, prop: 'cup' }, { at: 20, prop: null }];
  assert.deepEqual([5, 10, 15, 20, 25].map((t) => heldAt(held, t)), [null, 'cup', 'cup', null, null]);
});
