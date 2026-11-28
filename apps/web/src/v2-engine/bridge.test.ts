// #4153: the bridge turns what the v2 reader's worker posts into the page's takes and Souls (bridge.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { BEHIND_US, CHUNK, PLAY_DELAY, V2Bridge, doingOf } from './bridge.ts';
import { DT, TICK_US } from './takes.ts';
import { defaultLookOf, entityWithLook } from './take-bodies.ts';
import { setCarryHeading } from './carry-heading.ts';
import { Quaternion, Vector3 } from 'three';
import { readFileSync } from 'node:fs';

/** The body's take entity: its id with the letter that gives it the v2 page's default look (take-bodies.ts). */
const E = entityWithLook('v2_b_7', defaultLookOf('b.7'));

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

// Real bridge -> recorded chunk -> ordinary take replay, with the worker's native parent/slot/local-Q records.
function standingSlotProjection({ cold = false, posture = 'stand', known = true, updates = false, aimed = false, reenter = false, leaveToSeat = false, centered = false, parentPitch = 0, localRoll = 0, nestedYaw = 0, slotYaw = 83000 } = {}) {
  const bridge = new V2Bridge({ rulesVersion: 'test/1' });
  const yaw = (r: number) => [Math.cos(r / 2) * Q, 0, Math.sin(r / 2) * Q, 0] as [number, number, number, number];
  const kind = 'fixture:platform@1', parentYaw = Math.PI / 2, localYaw = Math.PI / 6;
  const slotZ = centered ? 0 : -350, occupiedX = centered ? 3_000_000 : 2_650_000;
  const parentQ = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), parentYaw).multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), parentPitch));
  const outerQ = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), nestedYaw), worldQ = outerQ.clone().multiply(parentQ);
  const localQ = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), localYaw).multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), localRoll));
  const wireQ = (q: Quaternion) => [q.w * Q, q.x * Q, q.y * Q, q.z * Q] as [number, number, number, number];
  const platform = node('p.1', 'outer.1', [3_000_000, 0, 1_000_000], { kind, rot: wireQ(parentQ), slots: [[1, 0, 100, slotZ, slotYaw, 1]] });
  const entry = node('k.1', null, [0, 0, 0], { kind: 'souls:kind@1', defines: kind,
    entry: new TextEncoder().encode(JSON.stringify({ owner: 'thing', slots: { place: { admits: 'body', at_mm: [0, 100, slotZ], posture, yaw_mdeg: 83000 } } })) });
  const approach = node('b.7', 'w.0', [5_000_000, 0, 1_000_000], { kind: 'souls:body@1', soul: 'soul-abc-7', at: T0 });
  const occupied = { ...approach, parent: 'p.1', slot: 1, pos: [0, 0, 0] as [number, number, number], rot: wireQ(localQ), at: T0 + 1_000_000 };
  const chair = node('c.2', 'w.0', [8_000_000, 0, 1_000_000], { kind: 'fixture:chair@1', slots: [[1, 0, 470, 0, 0, 1]] });
  const chairEntry = { ...entry, id: 'k.2', defines: 'fixture:chair@1', entry: new TextEncoder().encode(JSON.stringify({ owner: 'thing', slots: { seat: { admits: 'body', at_mm: [0, 470, 0], posture: 'sit' } } })) };
  bridge.receive({ t: 'snapshot', s: { nodes: [world, node('outer.1', 'w.0', [0, 0, 0], { rot: wireQ(outerQ) }), platform, ...(known ? [entry] : []), ...(leaveToSeat ? [chair, chairEntry] : []), cold ? { ...occupied, at: T0 } : approach], removed: [] } });
  let oldChunk = '';
  for (let n = 0; n < 17; n++) {
    const samples: [string, string, number | null, number, number, number, number][] = !cold && n < 2
      ? [['b.7', 'w.0', null, T0 + n * 500_000, 5_000_000 - n * 500_000, 0, 1_000_000]] : [];
    const nodes = !cold && n === 2 ? [occupied] : updates && !reenter && n === 6 ? [{ ...platform, rot: yaw(Math.PI), at: T0 + 3_250_000 }]
      : updates && n === 10 ? [leaveToSeat ? { ...occupied, parent: 'c.2', at: T0 + 5_000_000 } : reenter ? { ...occupied, at: T0 + 5_050_000 } : { ...approach, pos: [occupiedX, 0, 1_000_000], at: T0 + 5_000_000 }] : [];
    if (updates && !leaveToSeat && n >= 10 && n <= (reenter ? 10 : 12)) samples.push(['b.7', 'w.0', null, T0 + n * 500_000, occupiedX + (n - 10) * 500_000, 0, 1_000_000]);
    if (reenter && n === 10) samples.push(['b.7', 'p.1', 1, T0 + 5_050_000, 0, 0, 0]);
    if (updates && !reenter && n === 6) samples.push(['b.7', 'p.1', 1, T0 + 3_100_000, 0, 0, 0]);
    bridge.receive(part(n, samples, { nodes, ...(aimed && n === 4 ? { moves: [{ body: 'b.7', name: 'souls:point', start: T0 + 2_000_000,
      ends: [T0 + 2_300_000, T0 + 4_500_000], target: 'w.0', run: 'aim' }] } : {}) }));
    if (n === 5) oldChunk = JSON.stringify(bridge.view.takes.chunks.find(c => c.fromTick === T0 / TICK_US + 20));
  }
  const at = (seconds: number) => {
    const tick = T0 / TICK_US + seconds / DT, c = bridge.view.takes.chunks.find(c => c.fromTick <= tick && tick < c.toTick)!;
    assert(c, `published chunk at ${seconds}`);
    return sampleTake(c.take as unknown as Take, (tick - c.fromTick) * DT).entities[E];
  };
  const forward = new Vector3(0, 0, 1).applyQuaternion(worldQ.clone().multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), slotYaw / 1000 * Math.PI / 180)));
  const point = new Vector3(0, .1, slotZ / 1000).applyQuaternion(parentQ).add(new Vector3(3, 0, 1)).applyQuaternion(outerQ);
  return { bridge, at, oldChunk, expected: Math.atan2(forward.z, forward.x), expectedPoint: point.toArray() };
}

// Retained conference timing: leave toward +Z, native face toward -Z at7.95s,
// then a70mm/500ms return to the raised standing slot at8.45s.
function slowStandingReentry(period = 500_000, quiet = false) {
  const bridge = new V2Bridge({ rulesVersion: 'test/1' });
  const yaw = (r: number) => [Math.cos(r / 2) * Q, 0, Math.sin(r / 2) * Q, 0] as [number, number, number, number];
  const platform = node('p.1', 'w.0', [0, 0, 4_000_000], { kind: 'fixture:lectern@1', rot: yaw(Math.PI), slots: [[1, 0, 100, -350, 0, 1]] });
  const entry = node('k.1', null, [0, 0, 0], { kind: 'souls:kind@1', defines: platform.kind,
    entry: new TextEncoder().encode(JSON.stringify({ owner: 'thing', slots: { lectern: { admits: 'body', at_mm: [0, 100, -350], posture: 'stand' } } })) });
  const occupied = node('b.7', 'p.1', [0, 0, 0], { kind: 'souls:body@1', soul: 'soul-abc-7', slot: 1, at: T0 });
  const free = { ...occupied, parent: 'w.0', slot: null, pos: [0, 0, 4_420_000] as [number, number, number], rot: yaw(2.8855), at: null };
  bridge.receive({ t: 'snapshot', s: { nodes: [world, platform, entry, occupied], removed: [] } });
  type Sample = [string, string, number | null, number, number, number, number];
  const samples: Sample[] = [[ 'b.7', 'w.0', null, T0 + 3_000_000, 0, 0, 4_350_000 ],
    ['b.7', 'w.0', null, T0 + 3_050_000, 0, 0, 4_420_000], ['b.7', 'w.0', null, T0 + 3_100_000, 0, 0, 4_420_000],
    ['b.7', 'w.0', null, T0 + 7_950_000, 0, 0, 4_420_000], ['b.7', 'p.1', 1, T0 + 8_450_000, 0, 0, 0]];
  const records = [{ at: T0 + 3_100_000, value: free }, { at: T0 + 7_950_000, value: { ...free, rot: yaw(Math.PI / 2) } },
    { at: T0 + 8_450_000, value: { ...occupied, at: null } }];
  let frozen = '';
  for (let from = T0, number = 0; from < T0 + 12_000_000; from += period, number++) {
    const to = from + period;
    bridge.receive({ t: 'part', p: { number, from, to, nodes: records.filter(r => r.at >= from && r.at < to).map(r => r.value), removed: [],
      samples: samples.filter(r => r[3] >= from && r[3] < to) } });
    if (quiet && to === T0 + 8_000_000) {
      bridge.receive({ t: 'pointer', p: { newest: number, newestTo: to, period, anchorWorld: to, anchorWallMs: 0, quietUntil: T0 + 8_300_000 } });
      frozen = JSON.stringify(bridge.view.takes.chunks.find(c => c.fromTick === T0 / TICK_US + 140));
    }
  }
  const at = (seconds: number) => {
    const tick = T0 / TICK_US + seconds / DT, chunk = bridge.view.takes.chunks.find(c => c.fromTick <= tick && tick < c.toTick)!;
    assert(chunk, `reentry chunk at ${seconds}`);
    return sampleTake(chunk.take as unknown as Take, (tick - chunk.fromTick) * DT).entities[E];
  };
  return { bridge, at, frozen };
}

test('a native standing turn continues through slow opposite walking and slot acquisition across immutable chunks', () => {
  const ordinary = slowStandingReentry(), split = slowStandingReentry(250_000), live = slowStandingReentry(500_000, true);
  const angle = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const times = Array.from({ length: 45 }, (_, i) => 7.8 + i / 25);
  const expected = times.map(t => ordinary.at(t));
  assert.ok(Math.abs(ordinary.at(7.8).yaw - Math.PI / 2) < .002, 'the previous departure really faces the opposite way');
  assert.ok(Math.abs(ordinary.at(9).yaw + Math.PI / 2) < .002, 'the native slot front is eventually attained');
  for (let i = 1; i < times.length; i++) assert(angle(expected[i - 1].yaw, expected[i].yaw) <= 1.5 * Math.PI / .6 / 25 + .005,
    `25fps continuity at ${times[i]}: ${expected[i - 1].yaw} to ${expected[i].yaw}`);
  for (const [i, t] of times.entries()) {
    const p = t <= 7.95 ? [0, 0, 4.42] : t < 8.45 ? [0, .1 * (t - 7.95) / .5, 4.42 - .07 * (t - 7.95) / .5] : [0, .1, 4.35];
    expected[i].p.forEach((v, k) => assert.ok(Math.abs(v - p[k]) <= .001, 'the authoritative position interpolation is unchanged'));
    for (const other of [split, live]) assert(angle(expected[i].yaw, other.at(t).yaw) < .002, `same history across part/quiet boundaries at ${t}`);
  }
  for (const i of [44, 0, 30, 3, 12, 20]) assert.deepEqual(ordinary.at(times[i]), expected[i], 'fresh/backward seeks are independent of earlier sampling');
  for (const boundary of [8, 8.45, 9]) assert(angle(live.at(boundary - .00001).yaw, live.at(boundary + .00001).yaw) < .002, `continuous seam/acquisition at ${boundary}`);
  assert.equal(live.frozen, JSON.stringify(live.bridge.view.takes.chunks.find(c => c.fromTick === T0 / TICK_US + 140)), 'the earlier published chunk stays immutable');
});

test('the actual lecture slot faces through its authored lectern front toward the conference benches', () => {
  const entry = JSON.parse(readFileSync(new URL('../../../../content/kinds/hall/lecture.json', import.meta.url), 'utf8'));
  // Retained conference-rehearsal layout: lectern [0,0,4], yaw pi; benches [-1.4,0,0] and [1.4,0,0].
  // Native slot admission records identity local Q. Neither geometry nor audience is an implementation input.
  const parentQ = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI);
  const slot = entry.slots.lectern, position = new Vector3(0, 0, 4), b = new V2Bridge({ rulesVersion: 'test/1' });
  const kind = `${entry.kind}@fixture`, lecture = node('lecture.1', 'w.0', [0, 0, 4_000_000], { kind, rot: [0, 0, Q, 0] });
  b.receive({ t: 'snapshot', s: { nodes: [world, lecture,
    node('lecture.kind', null, [0, 0, 0], { kind: 'souls:kind@1', defines: kind, entry: new TextEncoder().encode(JSON.stringify(entry)) }),
    node('b.7', lecture.id, [0, 0, 0], { kind: 'souls:body@1', soul: 'fixture-presenter', slot: 1, at: T0 })], removed: [] } });
  for (let n = 0; n < 17; n++) b.receive(part(n, []));
  const shaft = entry.looks.shape.shapes.find((s: { size: number[] }) => s.size[1] === 980);
  assert(shaft, 'actual authored lectern shaft');
  const authoredFront = new Vector3(shaft.at[0] - slot.at_mm[0], 0, shaft.at[2] - slot.at_mm[2]).normalize().applyQuaternion(parentQ);
  const root = new Vector3(...slot.at_mm as [number, number, number]).multiplyScalar(.001).applyQuaternion(parentQ).add(position);
  const audienceDirection = new Vector3().addVectors(new Vector3(-1.4, 0, 0), new Vector3(1.4, 0, 0)).multiplyScalar(.5).sub(root).setY(0).normalize();
  assert(authoredFront.dot(audienceDirection) > .999, 'independent authored geometry front agrees with the retained room layout');
  for (const seconds of [3, 2.45, 2.5, .8, 4, 2]) {
    const tick = T0 / TICK_US + seconds / DT, c = b.view.takes.chunks.find(c => c.fromTick <= tick && tick < c.toTick)!;
    const e = sampleTake(c.take as unknown as Take, (tick - c.fromTick) * DT).entities[E];
    const front = new Vector3(Math.cos(e.yaw), 0, Math.sin(e.yaw));
    assert(front.dot(authoredFront) > .999, `actual lecture front at ${seconds}; +X would face sideways`);
    assert(front.dot(audienceDirection) > .999, 'audience direction independently excludes sideways facing');
    e.p.forEach((v, i) => assert(Math.abs(v - root.toArray()[i]) < .001, 'native occupied root and height stay exact'));
  }
});

test('standing slot keeps its declared front, platform height and cold/backward/adjacent replay', () => {
  for (const cold of [false, true]) {
    const f = standingSlotProjection({ cold });
    for (const seconds of [4, 2, 3.5, 2.45, 2.5, 0.8, 3]) {
      const e = f.at(seconds);
      if (!cold && seconds < 1) { assert.equal(e.activity, 'walk'); continue; }
      assert.ok(Math.abs(e.yaw - f.expected) < .002, `native composed Q at ${seconds}: ${e.yaw}`);
      assert.deepEqual(e.p, [2.65, .1, 1], 'slot and height retain their recorded position');
      assert.equal(e.activity, 'idle'); assert.equal(e.state.seatHeight, undefined);
    }
    assert.ok(Math.abs(f.at(2).yaw + 83000 / 1000 * Math.PI / 180) < .002, 'slot yaw turns the occupant front, without moving its root');
  }
});

test('a published release and reentry fifty milliseconds later retain the attained turn without a snap', () => {
  const f = standingSlotProjection({ updates: true, reenter: true });
  const angle = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  assert(angle(f.at(5.025).yaw, f.at(4.95).yaw) > .01, 'the actual free interval starts its ordinary turn-out');
  assert(angle(f.at(5.05 - .00001).yaw, f.at(5.05 + .00001).yaw) < .001, 'reentry begins from the attained public-time turn');
  assert(angle(f.at(5.025).yaw, f.at(5.5).yaw) > .01, 'reentry returns to the authoritative composed facing');
});

test('standing slot front composes nested parent and public slot yaw, independently of body-local rotation', () => {
  const f = standingSlotProjection({ cold: true, parentPitch: .4, localRoll: .2, nestedYaw: .3, slotYaw: 47000 });
  const e = f.at(3);
  assert.ok(Math.abs(e.yaw - f.expected) < .002, 'parent transforms and public row yaw turn +Z; contradictory local body Q does not override the slot owner');
  e.p.forEach((v, i) => assert.ok(Math.abs(v - f.expectedPoint[i]) <= .001, 'facing preserves the existing native slot transform'));
});

test('standing facing follows timestamped parent changes, releases on a native cut, and never rewrites a published take', () => {
  const f = standingSlotProjection({ updates: true, aimed: true, centered: true });
  const before = f.at(2.5), after = f.at(4), cut = f.at(5.5);
  assert.equal(before.activity, 'point', 'the aimed action remains present; slot ownership does not prove its target-directed arm depiction');
  assert.ok(Math.abs(before.yaw - f.expected) < .002, 'later parent and aimed move do not overwrite earlier native facing');
  assert.ok(Math.abs(f.at(3.2).yaw - f.expected) < .002, 'a later parent pose cannot lend its final quaternion to an earlier body sample in the same part');
  const delta = Math.atan2(Math.sin(after.yaw - (Math.PI / 2 - Math.PI - 83000 / 1000 * Math.PI / 180)), Math.cos(after.yaw - (Math.PI / 2 - Math.PI - 83000 / 1000 * Math.PI / 180)));
  assert.ok(Math.abs(delta) < .002, `parent turn composed at its own time: ${after.yaw}`);
  assert.deepEqual(before.p, after.p, 'facing adds no movement path');
  assert.equal(cut.activity, 'walk'); assert.ok(Math.abs(f.at(5.9).yaw) < .002, 'after turning out, ordinary movement owns facing');
  const difference = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  for (const boundary of [1, 2, 3, 4.5, 5]) {
    for (let i = -1; i < 13; i++) {
      const a = f.at(boundary + i * DT), b = f.at(boundary + (i + 1) * DT);
      assert(difference(a.yaw, b.yaw) <= 1.5 * Math.PI / .6 * DT + .005, `bounded existing turn interpolation around ${boundary}, tick ${i}`);
    }
  }
  assert(difference(f.at(1.05).yaw, f.at(.95).yaw) > .001, 'entry actually begins turning');
  assert(difference(f.at(1.05).yaw, f.at(2).yaw) > .1, 'entry does not snap to final native facing');
  assert.equal(f.oldChunk, JSON.stringify(f.bridge.view.takes.chunks.find(c => c.fromTick === T0 / TICK_US + 20)));
});

test('standing facing preserves unknown, seated, lying and main-owned carried headings', () => {
  const unknown = standingSlotProjection({ known: false }), seated = standingSlotProjection({ posture: 'sit' }), lying = standingSlotProjection({ posture: 'lie' });
  assert.equal(unknown.at(3).activity, 'sit'); assert.equal(unknown.at(3).p[1], 0, 'unknown retains legacy slot projection');
  assert.equal(seated.at(3).activity, 'sit'); assert.equal(seated.at(3).p[1], 0);
  assert.notEqual(seated.at(3).yaw, seated.expected, 'seat facing keeps its own slot-yaw owner');
  assert.equal(lying.at(3).activity, 'lie'); assert.equal(lying.at(3).p[1], 0);
  const reseated = standingSlotProjection({ updates: true, leaveToSeat: true }).at(5);
  assert.equal(reseated.activity, 'sit'); assert.ok(Math.abs(reseated.yaw - Math.PI / 2) < .002, 'new seat owns facing immediately, without a standing release tail');
  try {
    setCarryHeading(() => .37);
    const carried = standingSlotProjection();
    assert.ok(Math.abs(carried.at(3).yaw - .37) < .002, 'existing carried-heading hook wins');
    assert.deepEqual(carried.at(3).p, [2.65, .1, 1]);
  } finally { setCarryHeading(null); }
});

test('a body in a turned building is drawn in the world frame, with the page\'s Soul and entity ids', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, building, floor, body], removed: [] } });
  // walks 2 m along the floor's +x over 2 s, sampled every 0.5 s; the parts run 6 s on so whole chunks are made
  for (let n = 0; n < 12; n++) b.receive(part(n, n <= 4 ? [['b.7', 'w.2', null, T0 + n * 500_000, 1_000_000 + n * 500_000, 0, 0]] : []));
  assert.deepEqual([...b.view.souls.values()], [{ id: 's_abc-7', entityId: E, name: 'Ada', description: '', doing: 'standing', state: 'awake' }],
    'shown 0.3 s behind the newest part, its last step long before that: standing');
  // the chunk that holds `s` seconds in, sampled there
  const at = (s: number) => {
    const tick = T0 / TICK_US + Math.round(s / DT), c = b.view.takes.chunks.find((x) => x.fromTick <= tick && tick < x.toTick)!;
    return sampleTake(c.take as unknown as Take, (tick - c.fromTick) * DT).entities[E];
  };
  // a quarter turn about +y takes the floor's +x to the world's -z: (100 + 0, 3, -1) m at the start
  assert.deepEqual(at(0).p.map((x) => +x.toFixed(3)), [100, 3, -1]);
  assert.deepEqual(at(1).p.map((x) => +x.toFixed(3)), [100, 3, -2]);
  assert.equal(at(0.5).activity, 'walk');
  assert.ok(Math.abs(at(0.5).yaw - Math.atan2(-1, 0)) < 0.002, 'it faces the way it walks in the world (-z)');
});

test('first day: a body-kind figure with no Soul link is drawn but is not a Soul (the Souls panel, the navbar)', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  const figure = node('b.9', 'w.2', [2_000_000, 0, 0], { kind: 'souls:body@1', at: T0 });
  b.receive({ t: 'snapshot', s: { nodes: [world, building, floor, body, figure], removed: [] } });
  for (let n = 0; n < 12; n++) b.receive(part(n, n === 0 ? [['b.7', 'w.2', null, T0, 1_000_000, 0, 0], ['b.9', 'w.2', null, T0, 2_000_000, 0, 0]] : []));
  assert.deepEqual([...b.view.souls.keys()], ['s_abc-7']);
  const drawn = Object.keys((b.view.takes.chunks.at(-1)!.take as unknown as { finalState: { entities: object } }).finalState.entities);
  assert.ok(drawn.length >= 2, `both bodies are drawn: ${drawn}`);
});

test('no chunk until the world is past it by the v2 page\'s lag; a body the copy cannot place is hidden, not moved', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, building, floor, body], removed: [] } });
  b.receive(part(0, [['b.7', 'w.2', null, T0, 1_000_000, 0, 0]]));
  assert.equal(b.view.takes.chunks.length, 0, 'half a second in: the first chunk ends there, within the 0.3 s lag');
  b.receive(part(1, []));
  assert.equal(b.view.takes.chunks.length, 1, 'a second in: the world is past the first chunk by the lag');
  for (let n = 2; n < 6; n++) b.receive(part(n, []));
  b.receive(part(6, [], { removed: ['b.7'] })); // into a frame that is not public: the worker says it is gone
  for (let n = 7; n < 16; n++) b.receive(part(n, []));
  const chunks = b.view.takes.chunks, hidden = chunks.filter((c) => c.fromTick * TICK_US >= T0 + 6 * 500_000);
  assert.ok(chunks.some((c) => E in (c.take as { tracks: object }).tracks), 'drawn before it went');
  assert.ok(hidden.length && hidden.every((c) => !(E in (c.take as { tracks: object }).tracks)), 'not drawn after');
  assert.equal(b.view.takes.serverTick, chunks.at(-1)!.toTick);
  assert.equal((chunks.at(-1)!.toTick - chunks[0].fromTick) % CHUNK, 0);
});

test('B3-3: a Soul\'s card fields from the stream: its description, and what it is doing now as the v2 page says it', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, building, floor, { ...body, description: 'Keeps the bees.' }], removed: [] } });
  const soul = () => b.view.souls.get('s_abc-7')!;
  // walking: a step every half second up to the time shown (0.3 s behind the newest part)
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
  assert.equal(doingOf({ ...body, slot: 2 }, [], T0, false, undefined), 'sitting');
  // first day (25 Nov): what it says is what its body is drawn doing, never "seated" in a balloon or "standing" in a dance
  assert.equal(doingOf({ ...body, slot: 2 }, [], T0, false, undefined, 'ride'), 'riding');
  // first day, round 4: in a balloon still at its stop, aboard and when it takes off; riding once it is under way
  assert.equal(doingOf({ ...body, slot: 2 }, [], T0, false, undefined, 'ride', 42), 'aboard — takes off in\u00a042\u00a0s');
  assert.equal(doingOf({ ...body, slot: 2 }, [], T0, false, undefined, 'lie'), 'lying down');
  assert.equal(doingOf(body, [{ at: T0 }], T0, false, undefined, 'dance'), 'dancing');
  assert.equal(doingOf(body, [{ at: T0 }], T0, false, undefined, 'jumping-jacks'), 'exercising');
  assert.equal(doingOf(body, [{ at: T0 }], T0, false, undefined, 'read'), 'reading');
  assert.equal(doingOf(body, [{ at: T0 }], T0, false, undefined, 'walk'), 'walking');
  assert.equal(doingOf(body, [{ at: T0 }], T0, false, undefined, 'idle'), 'standing');
  assert.equal(doingOf(body, [{ at: T0 }], T0, true, undefined, 'dance'), 'speaking', 'its words first');
  assert.equal(doingOf(body, [{ at: T0 }], T0, false, undefined), 'standing', 'one placement is not a walk');
});

test('B3-4: a walker\'s chunks are made 0.3 s behind the newest part and played 0.6 s behind them, and never stutter', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, building, floor, body], removed: [] } });
  // a body walking 1.4 m/s along the floor, sampled every 0.2 s (as a walker is at 100 Souls), in 0.5 s parts
  const speed = 1.4, step = 200_000, lags: number[] = [];
  for (let n = 0; n < 40; n++) {
    const samples: [string, string, number | null, number, number, number, number][] = [];
    for (let at = T0 + n * 500_000; at < T0 + (n + 1) * 500_000; at += step) samples.push(['b.7', 'w.2', null, at, 1_000_000 + Math.round((at - T0) * speed), 0, 0]);
    b.receive(part(n, samples));
    // where the page plays as this part comes (LiveWorld: serverTick less the source's play delay), behind the part's end
    if (n >= 2) lags.push(T0 + (n + 1) * 500_000 - (b.view.takes.serverTick - b.view.takes.playDelay) * TICK_US);
  }
  assert.equal(b.view.takes.playDelay, PLAY_DELAY);
  // as a part comes, what the page plays is at most the lag rounded to a whole chunk, plus the play delay, behind the
  // part's end: 1.1 s, so with the stream's own half second an act shows within 2 s (it was 2 s + 1 s + 1.5 s)
  const most = Math.ceil(BEHIND_US / (CHUNK * TICK_US)) * CHUNK * TICK_US + PLAY_DELAY * TICK_US;
  assert.equal(Math.max(...lags), most);
  assert.ok(most + 500_000 < 2_000_000, `${most} µs`);
  // smooth: tick to tick across every chunk and every chunk boundary, the body moves its walking step, never held and jumped
  const pos: number[][] = [];
  for (const c of b.view.takes.chunks) {
    const take = c.take as unknown as Take;
    for (let k = c === b.view.takes.chunks[0] ? 0 : 1; k <= CHUNK; k++) pos.push(sampleTake(take, k * DT).entities[E].p);
  }
  const steps = pos.slice(1).map((p, i) => Math.hypot(p[0] - pos[i][0], p[2] - pos[i][2]));
  assert.ok(steps.length > 100 && Math.max(...steps) <= speed * DT * 1.5 && Math.min(...steps) >= speed * DT * 0.5, `steps ${Math.min(...steps)}..${Math.max(...steps)} m`);
});

/** LiveWorld's live clock (LiveWorld.tsx's frame loop) at 60 frames a second over the bridge's takes, `delay` ticks
 *  behind: the frames whose played tick is held at the newest chunk's end (nothing on the page moves). */
function heldFrames(arrivals: { at: number; m: Parameters<V2Bridge['receive']>[0] }[], delay: number): number {
  let clock = 0, liveTick: number | null = null, last: number | null = null, held = 0, i = 0;
  const b = new V2Bridge({ rulesVersion: 'test/1' }), now = performance.now;
  performance.now = () => clock;
  try {
    for (clock = arrivals[0].at; clock <= arrivals.at(-1)!.at; clock += 1000 / 60) {
      while (i < arrivals.length && arrivals[i].at <= clock) b.receive(arrivals[i++].m);
      const t = b.view.takes;
      if (!t.chunks.length) continue;
      const step = last === null ? 0 : Math.min(0.1, (clock - last) / 1000), before = liveTick;
      last = clock;
      const target = t.serverTick + Math.min(2, Math.max(0, (clock - t.receivedAt) / 1000)) * 20 - delay;
      liveTick = liveTick === null || Math.abs(target - liveTick) > 80 ? target : liveTick + step * 20 + (target - liveTick) * Math.min(1, step * 1.5);
      liveTick = Math.max(t.chunks[0].fromTick, Math.min(t.chunks.at(-1)!.toTick, liveTick));
      if (before !== null && clock > arrivals[0].at + 5000 && liveTick - before < step * 10 && liveTick === t.chunks.at(-1)!.toTick) held++;
    }
  } finally { performance.now = now; }
  return held;
}

test('PL: on the stream\'s own cadence the page never plays up to the newest chunk; two ticks less play delay would', () => {
  // a part every half second, give or take 30 ms (PL, a local Eden with 16 and 20 Souls
  // walking: gaps p10 0.49 s, p90 0.51 s; the few parts later than that, about 4 %, hold the page at any delay under 1 s)
  const lag = [180, 190, 175, 185, 200, 170, 180, 195];
  const arrivals: { at: number; m: Parameters<V2Bridge['receive']>[0] }[] = [{ at: 0, m: { t: 'snapshot', s: { nodes: [world, building, floor, body], removed: [] } } }];
  for (let n = 0; n < 60; n++) {
    const samples: [string, string, number | null, number, number, number, number][] = [];
    for (let at = T0 + n * 500_000; at < T0 + (n + 1) * 500_000; at += 200_000) samples.push(['b.7', 'w.2', null, at, 1_000_000 + Math.round((at - T0) * 1.4), 0, 0]);
    arrivals.push({ at: (n + 1) * 500 + lag[n % lag.length], m: part(n, samples) });
  }
  assert.equal(heldFrames(arrivals, PLAY_DELAY), 0);
  assert.ok(heldFrames(arrivals, PLAY_DELAY - 2) > 0, 'the play delay is the least that holds no frame');
  // BEHIND_US: a part ends on the half-second grid the chunks are on, so up to one chunk it costs nothing more; it must
  // cover a walker's next sample (every 0.2 s, p99 0.25 s)
  assert.ok(BEHIND_US >= 250_000 && BEHIND_US <= CHUNK * TICK_US);
});

test('0.135: a page that opens mid-dance draws the dance from the next record the world writes again, to the run\'s end', () => {
  // The dance (`act dance for=60`) began 20 s before this page's first part, so the page never saw its first record. The
  // world writes it again every 15 s, each planned to the latest the dance can end; the run ends 60.8 s after it began.
  const began = T0 - 20_000_000, planned = began + 60_000_000 + 800_000, again = T0 + 10_000_000, ended = began + 60_800_000;
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, building, floor, body], removed: [] } });
  // What the page draws each half second, read from each chunk as it is made (the bridge keeps only the last few).
  const drawn = new Map<number, string | undefined>();
  const N = 100; // 50 s of parts
  for (let n = 0; n < N; n++) {
    const from = T0 + n * 500_000, extra: Record<string, unknown> = {};
    if (again >= from && again < from + 500_000) extra.moves = [{ body: 'b.7', name: 'souls:dance', start: again, ends: [again + 400_000, planned], target: 'b.7', run: '9' }];
    if (ended >= from && ended < from + 500_000) extra.runEnds = [{ body: 'b.7', at: ended, how: 'done' }];
    b.receive(part(n, n === 0 ? [['b.7', 'w.2', null, T0, 1_000_000, 0, 0]] : [], extra));
    for (const c of b.view.takes.chunks) for (let tick = c.fromTick; tick < c.toTick; tick++) {
      const s = Math.round((tick * TICK_US - T0) / 100_000) / 10;
      if (s * 2 !== Math.round(s * 2) || drawn.has(s)) continue;
      const e = sampleTake(c.take as unknown as Take, (tick - c.fromTick) * DT).entities[E];
      if (e) drawn.set(s, e.activity);
    }
  }
  const at = (s: number) => drawn.get(s);
  assert.equal(at(5), 'idle', 'before the record comes again the page has nothing to draw');
  for (let s = 10.5; s < 40.5; s += 0.5) assert.equal(at(s), 'dance', `dancing ${s} s after the page opened`);
  assert.equal(at(42), 'idle', 'standing once the run ended');
});

test('a Soul that walked up to a turned chair sits facing out of it, never the way it walked (its back to the back)', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  const ground = node('w.0', null, [0, 0, 0], { kind: 'souls:place@1' });
  // a chair 3 m east, turned a quarter turn about +y, so its front (+z, where its stand point is) faces world +x
  const chair = { ...node('c.1', 'w.0', [3_000_000, 0, 0], { kind: 'eden:chair@1' }), rot: [half, 0, half, 0] as [number, number, number, number], slots: [[1, 0, 470, 20, 0, 1]] };
  const ada = node('b.7', 'w.0', [5_000_000, 0, 0], { kind: 'souls:body@1', soul: 'soul-abc-7', name: 'Ada', at: T0 });
  b.receive({ t: 'snapshot', s: { nodes: [ground, chair, ada], removed: [] } });
  // walks west to its stand point (1 m over 1 s), then sits at 1.5 s
  for (let n = 0; n < 12; n++) {
    const samples: [string, string, number | null, number, number, number, number][] = n <= 2 ? [['b.7', 'w.0', null, T0 + n * 500_000, 5_000_000 - n * 500_000, 0, 0]] : [];
    const seated = { ...ada, parent: 'c.1', slot: 1, pos: [0, 0, 0], at: T0 + 1_000_000 };
    // and rises at 4 s, back to its stand point
    const risen = { ...ada, pos: [4_000_000, 0, 0], at: T0 + 4_000_000 };
    b.receive(part(n, samples, n === 3 ? { nodes: [seated] } : n === 8 ? { nodes: [risen] } : {}));
  }
  const at = (s: number) => {
    const tick = T0 / TICK_US + Math.round(s / DT), c = b.view.takes.chunks.find((x) => x.fromTick <= tick && tick < x.toTick)!;
    return sampleTake(c.take as unknown as Take, (tick - c.fromTick) * DT).entities[E];
  };
  assert.ok(Math.abs(Math.abs(at(0.5).yaw) - Math.PI) < 0.002, `walking west: ${at(0.5).yaw}`);
  assert.equal(at(3).activity, 'sit');
  assert.ok(Math.abs(at(3).yaw) < 0.002, `seated, it faces out of the chair (+x): ${at(3).yaw}`);
  assert.equal(at(5).activity, 'idle');
  assert.ok(Math.abs(at(5).yaw) < 0.002, `risen, it still faces out of the chair, never turning back to it: ${at(5).yaw}`);
});

test('a walk that ends with the world turning the body (to face what it walked to) is drawn turning there, smoothly', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  const ground = node('w.0', null, [0, 0, 0], { kind: 'souls:place@1' });
  const ada = node('b.7', 'w.0', [0, 0, 0], { kind: 'souls:body@1', soul: 'soul-abc-7', name: 'Ada', at: T0 });
  b.receive({ t: 'snapshot', s: { nodes: [ground, ada], removed: [] } });
  // walks 2 m along +x over 2 s; at 2.5 s the world turns it a quarter turn where it stands, to face +z (worldd
  // Bodies::face; the page's heading is atan2(dz, dx), so +z is pi/2, the orientation a turn of -pi/2 about +y)
  const turned = [Math.cos(-Math.PI / 4) * Q, 0, Math.sin(-Math.PI / 4) * Q, 0] as [number, number, number, number];
  for (let n = 0; n < 14; n++) {
    const samples: [string, string, number | null, number, number, number, number][] = n <= 4 ? [['b.7', 'w.0', null, T0 + n * 500_000, n * 500_000, 0, 0]] : [];
    if (n === 5) samples.push(['b.7', 'w.0', null, T0 + 2_500_000, 2_000_000, 0, 0]);
    b.receive(part(n, samples, n === 5 ? { nodes: [{ ...ada, pos: [2_000_000, 0, 0], rot: turned, at: T0 + 2_500_000 }] } : {}));
  }
  const at = (s: number) => {
    const tick = T0 / TICK_US + Math.round(s / DT), c = b.view.takes.chunks.find((x) => x.fromTick <= tick && tick < x.toTick)!;
    return sampleTake(c.take as unknown as Take, (tick - c.fromTick) * DT).entities[E];
  };
  assert.ok(Math.abs(at(1).yaw) < 0.002, 'it faces the way it walks (+x)');
  assert.ok(Math.abs(at(2.25).yaw) < 0.002, 'stopped, it still faces the way it came until the world turns it');
  const mid = at(2.65).yaw;
  assert.ok(mid > 0.05 && mid < Math.PI / 2 - 0.05, `turning, not snapped: ${mid}`);
  assert.ok(Math.abs(at(3.5).yaw - Math.PI / 2) < 0.002, `then it faces where the world turned it (+z): ${at(3.5).yaw}`);
});

test('a walker\'s record lands after its part\'s motion samples: no burst to a jog at the walk\'s end, no step back', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  b.receive({ t: 'snapshot', s: { nodes: [world, building, floor, body], removed: [] } });
  // as the world writes it: 1.4 m/s, a sample every 0.2 s (off the parts' half-second grid), and each part the body's record where its last sample put
  // it; the walk ends 0.35 s into part 12, whose record carries no motion time (local Eden, 25 Nov: a 15 m/s burst)
  const speed = 1.4, end = T0 + 12 * 500_000 + 350_000, x = (at: number) => 1_000_000 + Math.round((Math.min(at, end) - T0) * speed);
  for (let n = 0; n < 24; n++) {
    const from = T0 + n * 500_000, samples: [string, string, number | null, number, number, number, number][] = [];
    for (let at = Math.ceil((from - 50_000) / 200_000) * 200_000 + 50_000; at < from + 500_000 && at < end; at += 200_000) samples.push(['b.7', 'w.2', null, at, x(at), 0, 0]);
    if (from <= end && end < from + 500_000) samples.push(['b.7', 'w.2', null, end, x(end), 0, 0]);
    const last = samples.at(-1);
    b.receive(part(n, samples, last ? { nodes: [{ ...body, pos: [last[4], 0, 0], at: last[3] === end ? null : last[3] }] } : {}));
  }
  const pos: number[][] = [];
  for (const c of b.view.takes.chunks) {
    const take = c.take as unknown as Take;
    for (let k = c === b.view.takes.chunks[0] ? 0 : 1; k <= CHUNK; k++) pos.push(sampleTake(take, k * DT).entities[E].p);
  }
  // the floor's +x is the world's -z: walking on, z only falls, and never faster than a walk
  const steps = pos.slice(1).map((p, i) => pos[i][2] - p[2]);
  assert.ok(steps.length > 100 && Math.max(...steps) <= speed * DT * 1.05 && Math.min(...steps) >= -1e-6, `steps ${Math.min(...steps).toFixed(3)}..${Math.max(...steps).toFixed(3)} m a tick`);
});


test('an old run end in the new move part cannot erase the new same-tick gesture',()=>{
  const bridge=new V2Bridge({rulesVersion:'test/1'});
  bridge.receive({t:'snapshot',s:{nodes:[world,building,floor,body],removed:[]}});
  for(let n=0;n<8;n++)bridge.receive(part(n,n===0?[['b.7','w.2',null,T0,1_000_000,0,0]]:[],n===0?{
    moves:[{body:'b.7',name:'souls:sit_ups',start:T0,ends:[T0+3_000_000],target:'b.7',run:'new'}],
    runEnds:[{body:'b.7',at:T0,run:'old'}],
  }:{}));
  const chunk=bridge.view.takes.chunks.find(c=>c.fromTick*TICK_US<=T0+1_000_000&&c.toTick*TICK_US>T0+1_000_000)!;
  const drawn=sampleTake(chunk.take as unknown as Take,(T0+1_000_000-chunk.fromTick*TICK_US)/1e6).entities[E];
  assert.equal(drawn.activity,'situps');
});


test('a self-target floor move never aims back at its old position while the native body walks',()=>{
  const b=new V2Bridge({rulesVersion:'test/1'});b.receive({t:'snapshot',s:{nodes:[world,building,floor,body],removed:[]}});
  for(let n=0;n<8;n++)b.receive(part(n,[['b.7','w.2',null,T0+n*500_000,1_000_000+n*500_000,0,0]],n===0?{moves:[{body:'b.7',name:'souls:stargaze',start:T0,ends:[T0+4_000_000],target:'b.7',run:'floor'}]}:{}));
  const chunks=b.view.takes.chunks;for(const c of chunks){const take=c.take as unknown as Take;const e=sampleTake(take,.5).entities[E];assert.ok(Math.abs(e.yaw+Math.PI/2)<.01,'canonical floor rotation preserves the actual course heading');}
});


test('an overlapping part keeps a completed activity turn after its own final walking sample', () => {
  // Sanitized recorded sequence: part ranges overlap; the ended motion leaves node.at null but a final sample remains.
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  const ground = node('w.0', null, [0, 0, 0], { kind: 'souls:place@1' });
  const facing = (yaw: number): [number, number, number, number] => [Math.cos(-yaw / 2) * Q, 0, Math.sin(-yaw / 2) * Q, 0];
  const a = node('b.7', 'w.0', [395377, 0, -858299], { kind: 'souls:body@1', at: null, rot: facing(Math.PI / 4) });
  const other = node('b.9', 'w.0', [1000000, 0, 0], { kind: 'souls:body@1', at: null, rot: facing(-2.356194489) });
  b.receive({ t: 'snapshot', s: { nodes: [ground, a, other], removed: [] } });
  const stopped = { ...a, pos: [122000, 0, -1247000] as [number, number, number] };
  b.receive(part(0, [['b.7', 'w.0', null, T0 + 250000, 355107, 0, -915556], ['b.7', 'w.0', null, T0 + 450000, 194029, 0, -1144584],
    ['b.7', 'w.0', null, T0 + 600000, 122000, 0, -1247000], ['b.9', 'w.0', null, T0 + 300000, 1000000, 0, 0]],
    { from: T0, to: T0 + 600000, nodes: [stopped, { ...other, rot: facing(-2.1844889988272453) }] }));
  const final = { ...stopped, rot: facing(.9571036547625479) };
  b.receive(part(1, [['b.7', 'w.0', null, T0 + 650000, 122000, 0, -1247000], ['b.9', 'w.0', null, T0 + 990000, 1000000, 0, 0]],
    { from: T0 + 500000, to: T0 + 1000000, nodes: [final] }));
  for (let n = 2; n < 10; n++) b.receive(part(n, []));
  const at = (s: number, entity = E) => { const tick = T0 / TICK_US + Math.round(s / DT), c = b.view.takes.chunks.find(x => x.fromTick <= tick && tick < x.toTick)!; return sampleTake(c.take as unknown as Take, (tick - c.fromTick) * DT).entities[entity]; };
  assert.ok(Math.abs(at(1.3).yaw - .957103655) < .002, 'the final recorded turn survives the preceding walk and unrelated later body sample');
  assert.deepEqual(at(1.3).p.map(x => +x.toFixed(3)), [.122, 0, -1.247], 'authoritative position is unchanged');
  assert.ok(at(.75).yaw > -2.184 && at(.75).yaw < .9, 'it eases from the actual walking heading');
  const finalPose = at(1.3); at(.1); at(2.3); assert.deepEqual(at(1.3), finalPose, 'fresh take seeks reproduce the same pose');
  const otherEntity = entityWithLook('v2_b_9', defaultLookOf('b.9'));
  assert.ok(Math.abs(at(1.3, otherEntity).yaw + 2.184488999) < .002, 'the other body keeps its own authoritative turn');
});

test('null-at turns without body samples use the part start, while declared turn times remain authoritative', () => {
  for (const declared of [null, T0 + 400000]) {
    const b = new V2Bridge({ rulesVersion: 'test/1' });
    const ground = node('w.0', null, [0, 0, 0], { kind: 'souls:place@1' });
    const a = node('b.7', 'w.0', [0, 0, 0], { kind: 'souls:body@1', at: T0 });
    b.receive({ t: 'snapshot', s: { nodes: [ground, a], removed: [] } });
    const changed = { ...a, at: declared, rot: [Math.SQRT1_2 * Q, 0, -Math.SQRT1_2 * Q, 0] as [number, number, number, number] };
    b.receive(part(0, declared === null ? [] : [['b.7', 'w.0', null, T0 + 490000, 0, 0, 0]], { nodes: [changed] }));
    for (let n = 1; n < 8; n++) b.receive(part(n, []));
    const tick = T0 / TICK_US + 4, c = b.view.takes.chunks.find(x => x.fromTick <= tick && tick < x.toTick)!;
    const yaw = sampleTake(c.take as unknown as Take, (tick - c.fromTick) * DT).entities[E].yaw;
    assert.ok(declared === null ? yaw > .2 : Math.abs(yaw) < .002, 'a later sample cannot replace a declared turn time, and no-sample turns still ease');
  }
});


test('a history bundle standing turn precedes its later bundled motion samples', () => {
  for (const moved of [true, false]) {
    const b = new V2Bridge({ rulesVersion: 'test/1' });
    const ground = node('w.0', null, [0, 0, 0], { kind: 'souls:place@1' });
    const a = node('b.7', 'w.0', [0, 0, 0], { kind: 'souls:body@1', at: T0 });
    b.receive({ t: 'snapshot', s: { nodes: [ground, a], removed: [] } });
    const turned = { ...a, at: null, rot: [Math.SQRT1_2 * Q, 0, -Math.SQRT1_2 * Q, 0] as [number, number, number, number] };
    b.receive(part(0, [['b.7', 'w.0', null, T0 + 1e6, moved ? 1000000 : 0, 0, 0]], { from: T0, to: T0, nodes: [turned] }));
    for (let n = 1; n < 8; n++) b.receive(part(n, []));
    const tick = T0 / TICK_US + (moved ? 40 : 7), c = b.view.takes.chunks.find(x => x.fromTick <= tick && tick < x.toTick)!;
    const yaw = sampleTake(c.take as unknown as Take, (tick - c.fromTick) * DT).entities[E].yaw;
    assert.ok(Math.abs(yaw - (moved ? 0 : Math.PI / 2)) < .002,
      moved ? 'the later walking heading wins after the as-at-read turn' : 'the as-at-read standing orientation is not postponed');
  }
});
