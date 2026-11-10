import test from 'node:test';
import assert from 'node:assert/strict';
import { clockEaser } from './clock-ease.ts';

test('#1649 a clock jump of 20 minutes or more eases over the duration; smaller steps and cuts pass through', () => {
  let t = 0; const ease = clockEaser({ now: () => t });
  assert.equal(ease('2026-11-09T12:00:00'), '2026-11-09T12:00:00', 'the first clock is drawn as is');
  t = 50; assert.equal(ease('2026-11-09T12:00:01'), '2026-11-09T12:00:01', 'the clock running on passes through');
  t = 100; assert.equal(ease('2026-11-09T12:10:00'), '2026-11-09T12:10:00', 'a 10-minute re-alignment is not eased');
  // the owner moves the world from New York to Lisbon: five hours ahead
  t = 1000; const first = ease('2026-11-09T17:10:00')!;
  assert.equal(first, '2026-11-09T12:10:00', 'the jump starts from the time drawn');
  assert.equal(ease.active(), true);
  t = 3000; const mid = ease('2026-11-09T17:10:02')!;
  assert.ok(mid > '2026-11-09T13:00' && mid < '2026-11-09T16:30', `half way: ${mid}`);
  t = 5000; assert.equal(ease('2026-11-09T17:10:04'), '2026-11-09T17:10:04', 'after the duration: the clock itself');
  assert.equal(ease.active(), false);
  // back across midnight (a jump back): eased too, and the date carries
  t = 6000; ease('2026-11-09T23:50:00', { cut: true }); t = 6001; assert.equal(ease('2026-11-10T01:00:00'), '2026-11-09T23:50:00');
  // a cut (scrubbing history) shows the clock at once and ends the ease
  t = 7000; assert.equal(ease('2026-11-10T06:00:00', { cut: true }), '2026-11-10T06:00:00'); assert.equal(ease.active(), false);
  // no clock: nothing to ease
  assert.equal(ease(null), null);
  t = 8000; assert.equal(ease('2026-11-10T09:00:00.250'), '2026-11-10T09:00:00.250', 'after no clock, the next is drawn as is');
});

test('#1649 the easer keeps the input format (seconds or milliseconds)', () => {
  let t = 0; const ease = clockEaser({ now: () => t, durationMs: 1000 });
  ease('2026-11-09T12:00:00.000'); const out = ease('2026-11-09T18:00:00.000')!;
  assert.equal(out.length, 23); assert.equal(out, '2026-11-09T12:00:00.000');
  t = 500; assert.match(ease('2026-11-09T18:00:00.000')!, /^2026-11-09T15:00:00\.000$/, 'smoothstep half way is half the jump');
});
