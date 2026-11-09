import test from 'node:test';
import assert from 'node:assert/strict';
import { HINT_MIN_MS, HINT_MS, hintFadeAt, hintsAllowed } from '../src/touch/hints-policy.ts';
import { hapticTick, TICK_MS } from '../src/touch/haptics.ts';

// #893 A2/A3: only touch screens, once per device, never under ?shot or automation unless ?hints=1 asks for it.
test('hints: touch screens only, once per device', () => {
  assert.equal(hintsAllowed({ search: '', webdriver: false, coarse: true, seen: false }), true);
  assert.equal(hintsAllowed({ search: '', webdriver: false, coarse: false, seen: false }), false, 'desktop');
  assert.equal(hintsAllowed({ search: '', webdriver: false, coarse: true, seen: true }), false, 'remembered');
});
test('hints: ?shot and automation never; ?hints=1 beats webdriver only', () => {
  assert.equal(hintsAllowed({ search: '?shot=1', webdriver: false, coarse: true, seen: false }), false);
  assert.equal(hintsAllowed({ search: '', webdriver: true, coarse: true, seen: false }), false);
  assert.equal(hintsAllowed({ search: '?hints=1', webdriver: true, coarse: true, seen: false }), true);
  assert.equal(hintsAllowed({ search: '?hints=1&shot=1', webdriver: true, coarse: true, seen: false }), false);
  assert.equal(hintsAllowed({ search: '?hints=1', webdriver: true, coarse: true, seen: true }), false);
  assert.equal(hintsAllowed({ search: '?hints=1', webdriver: false, coarse: false, seen: false }), false);
});
test('haptics: a short tick on touch screens that vibrate, nothing elsewhere', () => {
  const calls: number[] = [], nav = { vibrate: (ms: number) => { calls.push(ms); return true; } };
  assert.equal(hapticTick(nav, () => true), true); assert.deepEqual(calls, [TICK_MS]);
  assert.equal(hapticTick(nav, () => false), false); assert.equal(hapticTick({}, () => true), false); assert.equal(hapticTick(undefined, () => true), false);
  assert.equal(calls.length, 1);
});
// #1388: a first touch is nearly always the start of a drag, which used to fade the hint as soon as it appeared.
test('hints: stay readable for the minimum whatever the person does, then go on their next gesture or by themselves', () => {
  assert.ok(HINT_MIN_MS >= 4000 && HINT_MS > HINT_MIN_MS);
  assert.equal(hintFadeAt(50), HINT_MIN_MS, 'a drag straight away waits for the minimum');
  assert.equal(hintFadeAt(HINT_MIN_MS - 1), HINT_MIN_MS);
  assert.equal(hintFadeAt(6000), 6000, 'a gesture once read fades it then');
  assert.equal(hintFadeAt(null), HINT_MS, 'no gesture: by itself');
  assert.equal(hintFadeAt(HINT_MS + 5000), HINT_MS, 'never later than by itself');
});
