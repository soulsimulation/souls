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
  assert.equal(doingOf({ ...body, slot: 2 }, [], T0, false, undefined), 'seated');
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
