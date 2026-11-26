// #4153: the bridge turns what the v2 reader's worker posts into the page's takes and Souls (bridge.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { BEHIND_US, CHUNK, PLAY_DELAY, V2Bridge, doingOf } from './bridge.ts';
import { DT, TICK_US } from './takes.ts';
import { defaultLookOf, entityWithLook } from './take-bodies.ts';

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
