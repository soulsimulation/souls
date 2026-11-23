// X1 (0.134): copied from v2/web/src/clock/clock.test.ts, so the old page's stream reader needs nothing from v2/web.
// V5 (#2714) A3: no body is drawn past its newest recorded sample, and the clock never passes the newest part.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BEHIND_US, MAX_RATE, PERIOD_US, PlaybackClock, caughtUp } from './clock.ts';
import { Track } from './samples.ts';

const within = (p: number[], a: number[], b: number[]) =>
  p.every((v, i) => v >= Math.min(a[i], b[i]) - 1e-9 && v <= Math.max(a[i], b[i]) + 1e-9);

test('a body is drawn between its samples, and at its newest sample (never past it) after that', () => {
  const tr = new Track();
  const path: [number, [number, number, number]][] = [];
  for (let k = 0; k < 40; k++) path.push([k * 200_000, [k * 280_000, 0, (k % 7) * 50_000]]);
  for (const [at, pos] of path) tr.add(at, pos, 'ground');
  const newest = path[path.length - 1];
  // Every 1 ms up to two seconds after the newest sample, as a stalled stream would leave it.
  for (let t = -100_000; t <= newest[0] + 2_000_000; t += 1_000) {
    const p = tr.at(t)!;
    const i = path.findIndex(([at]) => at > t);
    if (i === -1) assert.deepEqual(p, newest[1], `at ${t} the body is past its newest sample`);
    else if (i === 0) assert.deepEqual(p, path[0][1]);
    else assert.ok(within(p, path[i - 1][1], path[i][1]), `at ${t} outside its two samples`);
  }
});

test('a new frame starts the track again rather than sliding between frames', () => {
  const tr = new Track();
  tr.add(0, [0, 0, 0], 'a');
  tr.add(500_000, [9e6, 0, 0], 'b');
  assert.deepEqual(tr.at(250_000), [9e6, 0, 0]);
});

test('trimming keeps what is drawn now', () => {
  const tr = new Track();
  for (let k = 0; k < 10; k++) tr.add(k * 100, [k, 0, 0], null);
  tr.trim(450);
  assert.deepEqual(tr.at(450), [4.5, 0, 0]);
  assert.equal(tr.samples.length, 6);
});

test('the clock sits four parts behind, never passes the newest part, catches up at most 5 % fast, and cuts when far behind', () => {
  const c = new PlaybackClock();
  let world = 10_000_000;
  // Parts arrive every half second, 0.8 s after their end.
  const newestAt = (w: number) => Math.floor((w - 800_000) / PERIOD_US) * PERIOD_US;
  for (let ms = 0; ms < 60_000; ms += 16) {
    world += 16_000;
    const before = c.t;
    const t = c.step(16, world, newestAt(world))!;
    assert.ok(t <= newestAt(world), 'past the newest part');
    if (before !== null) assert.ok(t - before <= 16_000 * MAX_RATE + 1e-6, 'faster than 5 %');
  }
  assert.ok(Math.abs(world - c.t! - BEHIND_US) < 100_000, `behind by ${world - c.t!}`);
  // No parts for 3 s: the clock holds at the newest part.
  const stuck = newestAt(world);
  for (let ms = 0; ms < 3000; ms += 16) c.step(16, (world += 16_000), stuck);
  assert.ok(c.t! <= stuck && stuck - c.t! < 20_000);
  assert.equal(c.state, 'holding: no parts');
  // A hidden tab for five minutes: one cut to four parts behind.
  world += 300_000_000;
  c.step(16, world, newestAt(world));
  assert.equal(c.state, 'cut');
  assert.ok(world - c.t! <= BEHIND_US + 1_000_000);
});

test('V5b (#3460) A2: a joiner on a still world starts at once, stays live as world time passes, and follows parts when something moves', () => {
  const c = new PlaybackClock();
  // Part 0 (the world as built) ends at 0.5 s; the world has been still since, for an hour. The writer marks it quiet up
  // to world-now less 0.25 s every half second (V1 rule 11), and the page polls the pointer every 0.25 s.
  const start = 3_600_000_000;
  let world = start;
  const part0 = PERIOD_US;
  let newestTo = part0;
  let marked = 0;
  const quiet = () => Math.floor((world - 250_000) / 500_000) * 500_000 - 250_000;
  let started: number | null = null;
  for (let ms = 0; ms < 20_000; ms += 16) {
    world += 16_000;
    if (ms % 250 < 16) marked = quiet();
    const t = c.step(16, world, caughtUp(newestTo, marked));
    if (t !== null && started === null) started = ms;
    if (t !== null) assert.ok(t <= Math.max(newestTo, marked), 'past the caught-up time');
  }
  assert.ok(started !== null && started <= 3000, `started drawing after ${started} ms`);
  assert.ok(Math.abs(world - c.t! - BEHIND_US) < 200_000, `live: behind by ${world - c.t!}`);
  assert.equal(c.state, 'playing');
  // Something moves at world-now: its part arrives 0.75 s after its stretch ends, and the clock plays through it.
  const moved = world;
  const to = Math.floor(moved / PERIOD_US) * PERIOD_US + PERIOD_US;
  for (let ms = 0; ms < 4000; ms += 16) {
    world += 16_000;
    if (world >= to + 750_000) newestTo = to;
    else if (ms % 250 < 16) marked = Math.min(quiet(), moved - 1);
    const before = c.t!;
    // The writer drops its quiet time once it writes the part; the worker keeps the last one (it still holds).
    c.step(16, world, caughtUp(newestTo, marked));
    assert.ok(c.t! >= before, 'the clock stepped back');
  }
  assert.equal(newestTo, to);
  assert.ok(c.t! >= moved, `the clock reached the movement: ${c.t! - moved}`);
  // No pointer quiet time: the clock holds at the newest part, as before.
  assert.equal(caughtUp(newestTo, null), newestTo);
  assert.equal(caughtUp(null, 7), 7);
  assert.equal(caughtUp(9, 7), 9);
});
