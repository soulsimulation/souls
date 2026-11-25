// The live clock (live-clock.ts): PR #4790's finding, "lags through time". Under load the page drew the world further
// and further behind, froze, then skipped seconds ahead. Here the page's frames and the server's chunks come as they
// did then (slow frames, a frame stalled for seconds, chunks late then all at once), and the drawn tick is checked
// against the live delay the page means to keep.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CUT_S, LiveClock, MAX_RATE } from './live-clock.ts';

const TPS = 20;
const DELAY = 12;

/** Runs `seconds` of real time in frames of `frame(t)` s; the server's tick at real time t is `server(t)`, and the
 *  page holds chunks up to `held(t)`. Returns each frame's [real time, tick drawn, target]. */
function run(seconds: number, frame: (t: number) => number, server: (t: number) => number, held: (t: number) => number) {
  const clock = new LiveClock();
  const out: [number, number, number][] = [];
  for (let t = 0; t < seconds;) {
    const dt = frame(t);
    t += dt;
    const target = server(t) - DELAY;
    out.push([t, clock.step(dt, target, TPS, 0, held(t)), target]);
  }
  return { clock, out };
}
const steady = (t: number) => 200 + t * TPS;

test('slow frames (5 a second) never leave the page behind its live delay', () => {
  const { out } = run(120, () => 0.2, steady, (t) => steady(t));
  for (const [t, tick, target] of out.filter(([t]) => t > 2)) assert.ok(Math.abs(target - tick) <= 1, `at ${t.toFixed(1)} s it is ${((target - tick) / TPS).toFixed(2)} s behind`);
});

test('a frame stalled for 3.5 s is caught up by playing faster, never by a skip', () => {
  const { out } = run(30, (t) => (t >= 10 && t < 10.05 ? 3.5 : 1 / 30), steady, (t) => steady(t));
  for (let i = 1; i < out.length; i++) {
    const [t, tick] = out[i], [t0, tick0] = out[i - 1];
    // what a frame moves the world on by, in the frame's own time (the stalled frame stands for at most MAX_FRAME_S)
    assert.ok(tick - tick0 <= MAX_RATE * TPS * Math.min(1, t - t0) + 1e-6, `at ${t.toFixed(2)} s: ${((tick - tick0) / TPS).toFixed(2)} s in one frame`);
  }
  const [, last, target] = out.at(-1)!;
  assert.ok(Math.abs(target - last) <= 1, 'caught up again');
});

test('chunks late for 3 s then all at once: it holds at the newest, then catches up at no more than MAX_RATE', () => {
  // the server's estimate stands still while no chunk comes (serverNow's cap), then jumps when they do
  const late = (t: number) => (t >= 10 && t < 13 ? steady(10) : steady(t));
  const { out } = run(30, () => 1 / 30, late, late);
  for (let i = 1; i < out.length; i++) {
    const [t, tick] = out[i], [t0, tick0] = out[i - 1];
    assert.ok(tick - tick0 <= MAX_RATE * TPS * (t - t0) + 1e-6, `at ${t.toFixed(2)} s: a skip of ${((tick - tick0) / TPS).toFixed(2)} s`);
    assert.ok(tick <= late(t), 'never past the newest chunk');
  }
  const [, last, target] = out.at(-1)!;
  assert.ok(Math.abs(target - last) <= 1, 'caught up again');
});

test('far behind (a hidden tab) is one cut to the live point, not minutes of fast replay', () => {
  const clock = new LiveClock();
  clock.step(1 / 30, 1000, TPS, 0, 1000);
  const tick = clock.step(1 / 30, 1000 + (CUT_S + 5) * TPS, TPS, 0, 1e9);
  assert.equal(tick, 1000 + (CUT_S + 5) * TPS);
  assert.equal(clock.cuts, 1);
});
