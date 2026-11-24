// K4 (0.135): a thing on a course (a balloon) is in the takes, where its course has it, so the camera can follow it and
// the page can frame a ride with it; a Soul in its slot rides with it, standing (bridge.ts, takes.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { recordedTakeChunkSchema } from '@souls/protocol';
import { V2Bridge, type CourseAt } from './bridge.ts';
import { DT, TICK_US } from './takes.ts';
import { defaultLookOf, entityWithLook } from './take-bodies.ts';

const Q = 2 ** 30, T0 = 1_000_000_000_000;
const E = entityWithLook('v2_b_7', defaultLookOf('b.7'));
const rot: [number, number, number, number] = [Q, 0, 0, 0];
const world = { id: 'w.0', kind: 'souls:place@1', parent: null, slot: null, pos: [0, 0, 0] as [number, number, number], rot, at: null };
// A balloon at (10, 0, 0) m with a rider's slot 0.3 m forward, 0.1 m up; its course (a stand-in for the replica's) rises
// 1 m a second from T0 and drifts +z 2 m a second.
const balloon = { id: 'w.9', kind: 'eden:balloon@1', parent: 'w.0', slot: null, pos: [10_000_000, 0, 0] as [number, number, number], rot, at: null,
  origin: 'festival-balloon-id', slots: [[1, 300, 100, 0, 0, 1]], course: new Uint8Array([1]) };
const courseAt: CourseAt = (_f, t) => { const s = Math.max(0, Number(t) - T0) / 1e6; return [10_000_000n, BigInt(Math.round(s * 1e6)), BigInt(Math.round(s * 2e6)), 0n, 1_000_000n, 2_000_000n]; };
const body = { id: 'b.7', kind: 'souls:body@1', parent: 'w.9', slot: 1, pos: [0, 0, 0] as [number, number, number], rot, at: T0, soul: 'soul-abc-7', name: 'Ada' };
const part = (n: number) => ({ t: 'part' as const, p: { number: n, from: T0 + n * 500_000, to: T0 + (n + 1) * 500_000, nodes: [], removed: [], samples: [] } });

function ride() {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  let asked = 0;
  b.onCourse = () => { asked++; b.courseAt = courseAt; };
  b.receive({ t: 'snapshot', s: { nodes: [world, balloon, body], removed: [] } });
  for (let n = 0; n < 12; n++) b.receive(part(n));
  const at = (s: number) => {
    const tick = T0 / TICK_US + Math.round(s / DT), c = b.view.takes.chunks.find((x) => x.fromTick <= tick && tick < x.toTick)!;
    return { c, f: sampleTake(c.take as unknown as Take, (tick - c.fromTick) * DT) };
  };
  return { b, at, asked: () => asked };
}

test('a balloon on its course is a followable thing in the takes, under its old entity id, where the course has it', () => {
  const { at, asked } = ride();
  assert.equal(asked(), 1, 'the course reader is asked for once, when the first node with a course comes');
  for (const s of [1, 2.5, 4]) {
    const { c, f } = at(s), e = f.entities['festival-balloon-id'];
    assert.ok(recordedTakeChunkSchema.safeParse(c).success);
    assert.deepEqual(e.p.map((x) => +x.toFixed(3)), [10, s, 2 * s], `at ${s} s`);
    const rec = (c.take as { finalState: { entities: Record<string, { kind: string; carrier?: unknown }> } }).finalState.entities['festival-balloon-id'];
    assert.equal(rec.kind, 'vehicle', 'never a stand-in box: the page\'s layers draw it');
    assert.ok(rec.carrier, 'a ride: the page frames its riders with it');
  }
});

test('a Soul in the balloon\'s slot goes up with it, standing at its place and riding, not walking', () => {
  const { at } = ride();
  for (const s of [1, 3]) {
    const r = at(s).f.entities[E];
    assert.deepEqual(r.p.map((x) => +x.toFixed(3)), [10.3, s + 0.1, 2 * s], `at ${s} s: the slot's point on the course`);
    assert.equal(r.activity, 'ride');
    assert.equal((r.state as { seatHeight?: unknown }).seatHeight ?? null, null, 'stands at its place, not sat 0.1 m up');
  }
});

test('before the course reader is in, the balloon and its rider stand where they were placed', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, balloon, body], removed: [] } });
  for (let n = 0; n < 6; n++) b.receive(part(n));
  const c = b.view.takes.chunks[0], f = sampleTake(c.take as unknown as Take, 0);
  assert.deepEqual(f.entities['festival-balloon-id'].p, [10, 0, 0]);
  assert.deepEqual(f.entities[E].p.map((x) => +x.toFixed(3)), [10.3, 0.1, 0]);
});

test('the reader\'s worker posts a course\'s places with each part, and the page reads them without loading the replica', async () => {
  const { coursePlaces } = await import('./course-samples.ts');
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, balloon, body], removed: [] } });
  for (let n = 0; n < 12; n++) {
    const p = part(n).p;
    b.receive({ t: 'part', p: { ...p, courses: coursePlaces(courseAt, [balloon], p.from, p.to) } });
  }
  for (const s of [1, 2.5, 4]) {
    const tick = T0 / TICK_US + Math.round(s / DT), c = b.view.takes.chunks.find((x) => x.fromTick <= tick && tick < x.toTick)!;
    const f = sampleTake(c.take as unknown as Take, (tick - c.fromTick) * DT);
    assert.deepEqual(f.entities['festival-balloon-id'].p.map((x) => +x.toFixed(3)), [10, s, 2 * s], `the balloon at ${s} s`);
    assert.deepEqual(f.entities[E].p.map((x) => +x.toFixed(3)), [10.3, s + 0.1, 2 * s], `its rider at ${s} s`);
  }
});

test('a rowing punt on its course is a `rowing-punt` fixture in the takes, which the take\'s fixture views draw as a punt', () => {
  const punt = { ...balloon, id: 'w.8', kind: 'core:rowing_punt@1220ab', origin: 'e_punt0' };
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.courseAt = courseAt;
  b.receive({ t: 'snapshot', s: { nodes: [world, punt], removed: [] } });
  for (let n = 0; n < 6; n++) b.receive(part(n));
  const rec = (b.view.takes.chunks[0].take as { finalState: { entities: Record<string, { kind: string; def: string; carrier?: unknown }> } }).finalState.entities.e_punt0;
  assert.equal(rec.kind, 'fixture');
  assert.equal(rec.def, 'rowing-punt', 'today\'s def name (mars engine-view fixtures.ts draws it)');
  assert.ok(rec.carrier, 'still a ride');
});

// N14: a cable car at (20, 0, 0) m whose cabin seat (slot 1, declared 0.45 m up) moves with its cabin: its course (a
// stand-in for the replica's) runs +z 1 m a second from T0, 0.45 m up, in the thing's frame.
const cableCar = { id: 'w.6', kind: 'eden:cable_car@1', parent: 'w.0', slot: null, pos: [20_000_000, 0, 0] as [number, number, number], rot, at: null,
  origin: 'alpine-cable-car', slots: [[1, 0, 450, 0, 0, 1]], seats: { 1: new Uint8Array([2]) } };
const seatAt: CourseAt = (_f, t) => { const s = Math.max(0, Number(t) - T0) / 1e6; return [0n, 450_000n, BigInt(Math.round(s * 1e6)), 0n, 0n, 1_000_000n]; };
const rider = { ...body, parent: 'w.6', slot: 1 };

test('N14: a Soul in a seat that moves with its cabin is carried by the seat, and the page draws a cabin there with it', async () => {
  const { coursePlaces, seatKey } = await import('./course-samples.ts');
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, cableCar, rider], removed: [] } });
  for (let n = 0; n < 12; n++) {
    const p = part(n).p, courses = coursePlaces(seatAt, [cableCar], p.from, p.to);
    assert.ok(courses[seatKey('w.6', 1)], 'the worker posts the seat\'s places');
    b.receive({ t: 'part', p: { ...p, courses } });
  }
  for (const s of [1, 2.5, 4]) {
    const tick = T0 / TICK_US + Math.round(s / DT), c = b.view.takes.chunks.find((x) => x.fromTick <= tick && tick < x.toTick)!;
    const f = sampleTake(c.take as unknown as Take, (tick - c.fromTick) * DT);
    const cabin = f.entities['alpine-cable-car#cabin-1'], seated = f.entities[E];
    assert.deepEqual([cabin.p[0], cabin.p[2]].map((x) => +x.toFixed(3)), [20, s], `the cabin at ${s} s`);
    assert.ok(cabin.p[1] < 0.45, 'its floor under the seat');
    assert.deepEqual([seated.p[0], seated.p[2]].map((x) => +x.toFixed(3)), [20, s], `its rider with it at ${s} s`);
    const rec = (c.take as { finalState: { entities: Record<string, { def: string; carrier?: unknown }> } }).finalState.entities['alpine-cable-car#cabin-1'];
    assert.equal(rec.def, 'ride-cabin', 'drawn as a cabin (WorldRideCars)');
    assert.ok(rec.carrier, 'a ride: the page frames its rider with it');
  }
});
