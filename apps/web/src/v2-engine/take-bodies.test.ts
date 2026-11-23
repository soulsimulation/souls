// #4175: a v2 body in a slot sits (or lies) there in the take, stands when it leaves; a thing in its hand is its prop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { PEOPLE, templateNameFor } from '../../../../mars/viewer/app/engine-view/people-light.ts';
import { readFileSync } from 'node:fs';
import { entityOf, V2Bridge } from './bridge.ts';
import { TICK_US } from './takes.ts';
import { bodiesUrl, catalogueOf, defaultLookOf, entityWithLook, heldAt, legacyBodyOf, LOOKS, postureOf, propOf, seatOf } from './take-bodies.ts';

const E = entityWithLook('v2_b_7', defaultLookOf('b.7'));

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
  return sampleTake(c.take as unknown as Take, (tick - c.fromTick) * 0.05).entities[E];
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

test('a body with no body kind is the same default person on both pages', () => {
  // the v2 page's BODIES (crowd/bodies.ts, which needs three to import), read as text: its people in its order
  const src = readFileSync(new URL('../../../../v2/web/src/crowd/bodies.ts', import.meta.url), 'utf8');
  const v2Bodies = [...src.matchAll(/^  \['([a-z]+)', 'animated-/gm)].map((m) => m[1]);
  // and its id hash (FNV-1a), which picks a default person by `hash(id) % defaults`
  assert.ok(src.includes('let h = 2166136261;') && src.includes('h = Math.imul(h ^ s.charCodeAt(i), 16777619);') && src.includes('hash(id) % this.defaults'));
  const v2Hash = (x: string) => { let h = 2166136261; for (let i = 0; i < x.length; i++) h = Math.imul(h ^ x.charCodeAt(i), 16777619); return h >>> 0; };
  assert.deepEqual([...LOOKS], v2Bodies, 'the v2 page\'s people, in its order');
  assert.deepEqual([...LOOKS], [...PEOPLE], 'the old page\'s people, in the same order');
  for (let i = 0; i < 300; i++) {
    const id = `${(i * 7919).toString(16)}.${i}`, v2Look = v2Bodies[v2Hash(id) % v2Bodies.length];
    assert.equal(defaultLookOf(id), v2Look);
    assert.equal(templateNameFor(entityWithLook(entityOf(id), v2Look), PEOPLE), v2Look, `body ${id}`);
  }
});

test('a body kind is drawn in the old page\'s record of the same body, from the world\'s catalogue', () => {
  const pip = { family: 'floater', type: 'ceramic', model: 'pip', modelUrl: '/world-assets/pip.glb', radius: 0.35, hoverHeight: 1.45 };
  const h = 'ab'.repeat(32), catalogue = [{ hash: h, legacy: [pip] }, { hash: 'cd'.repeat(32), legacy: [null] }];
  assert.deepEqual(legacyBodyOf(h, new Map(catalogue.map((c) => [c.hash, c]))), pip);
  assert.equal(legacyBodyOf('cd'.repeat(32), new Map(catalogue.map((c) => [c.hash, c]))), null, 'a default body stays the default person');
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.looks(catalogue);
  b.receive({ t: 'snapshot', s: { nodes: [world, { ...body, body: h }], removed: [] } as never });
  for (let n = 0; n < 10; n++) b.receive(part(n));
  const take = b.view.takes.chunks[0].take as unknown as Take & { finalState: { entities: Record<string, { body?: unknown }> } };
  assert.deepEqual(take.finalState.entities[entityOf('b.7')].body, pip);
  assert.deepEqual(sampleTake(take, 0.5).entities[entityOf('b.7')].state.body, pip, 'and in its state, which the page reads first');
});

test('the catalogue is read from the v2 body assets the page names, and a body kind takes its look once it is in', () => {
  assert.equal(bodiesUrl('/v2/assets/bodies/'), '/v2/assets/bodies/bodies.json');
  for (const bad of ['https://elsewhere.example/assets/', '//elsewhere.example/', '/v2/../x/', '/v2/assets', 7, null]) assert.equal(bodiesUrl(bad), null, String(bad));
  const h = 'ef'.repeat(32), pip = { family: 'floater', model: 'pip', modelUrl: '/world-assets/pip.glb' };
  assert.deepEqual(catalogueOf({ format: 'souls/bodies/1', bodies: [{ hash: h, preset: 'pip', legacy: [pip] }, { hash: 'nope' }, null] }), [{ hash: h, preset: 'pip', legacy: [pip] }]);
  assert.equal(catalogueOf({ format: 'other', bodies: [] }), null);
  assert.equal(catalogueOf(null), null);
  // the catalogue arrives after the body is first drawn: chunks from then on carry its look
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, { ...body, body: h }], removed: [] } as never });
  for (let n = 0; n < 7; n++) b.receive(part(n));
  const before = b.view.takes.chunks.length;
  b.looks(catalogueOf({ format: 'souls/bodies/1', bodies: [{ hash: h, legacy: [pip] }] })!);
  for (let n = 7; n < 12; n++) b.receive(part(n));
  const looks = b.view.takes.chunks.map((c) => (c.take as { finalState: { entities: Record<string, { body?: unknown }> } }).finalState.entities[entityOf('b.7')].body);
  assert.ok(before > 0 && looks.slice(0, before).every((x) => x === undefined), 'before: the default person');
  assert.ok(looks.length > before && looks.slice(before).every((x) => JSON.stringify(x) === JSON.stringify(pip)), 'after: its own look');
});
