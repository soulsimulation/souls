// #4153: the bridge turns what the v2 reader's worker posts into the page's takes and Souls (bridge.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { V2Bridge } from './bridge.ts';
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
  assert.deepEqual([...b.view.souls.values()], [{ id: 's_abc-7', entityId: 'v2_b_7', name: 'Ada' }]);
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

test('a body first seen standing that later moves by its record is drawn where it moves, with no jump', () => {
  const b = new V2Bridge({ rulesVersion: 'test/1' });
  // a second floor in the same building, 3 m along the first's +x and level with it
  const next = node('w.3', 'w.1', [3_000_000, 3_000_000, 0]);
  b.receive({ t: 'snapshot', s: { nodes: [world, building, floor, next, body], removed: [] } });
  // stands 2 s at 1 m along the floor, then its record walks 1 m/s along +x, onto the second floor at 3 m, with no
  // motion samples; its motion samples start 6 s in, on the second floor, and go on at the same pace
  const x = (n: number) => 1_000_000 + Math.max(0, n - 4) * 500_000; // floor-frame µm at part n
  for (let n = 0; n < 20; n++) {
    const at = T0 + n * 500_000, onNext = x(n) >= 3_000_000;
    const rec = n >= 5 && n < 12 ? [{ ...body, parent: onNext ? 'w.3' : 'w.2', pos: [x(n) - (onNext ? 3_000_000 : 0), 0, 0] as [number, number, number], at }] : [];
    const samples: [string, string, number | null, number, number, number, number][] = n >= 12 && n < 15 ? [['b.7', 'w.3', null, at, x(n) - 3_000_000, 0, 0]] : [];
    b.receive(part(n, samples, { nodes: rec }));
  }
  const chunks = b.view.takes.chunks, path: number[][] = [];
  for (const c of chunks) for (let k = 0; k < TICKS; k++) path.push(sampleTake(c.take as unknown as Take, k * TICK_US / 1e6).entities.v2_b_7.p);
  assert.ok(path.length >= 8 * TICKS, 'chunks cover the stand, the walk and the samples');
  const walked = Math.hypot(path.at(-1)![0] - path[0][0], path.at(-1)![1] - path[0][1], path.at(-1)![2] - path[0][2]);
  assert.ok(walked > 4, `it walks the whole way (${walked.toFixed(2)} m)`);
  // 1 m/s is 5 cm a tick; allow twice that
  const step = Math.max(...path.slice(1).map((p, i) => Math.hypot(p[0] - path[i][0], p[1] - path[i][1], p[2] - path[i][2])));
  assert.ok(step <= 0.1, `no step over 10 cm a tick (largest ${step.toFixed(2)} m)`);
});
