// 0.131 parity C3 (#3675): the phone's first-touch hints policy, haptics, and swiping between Souls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Flicks, HINT_MIN_MS, HINT_MS, SoulSwipe, TICK_MS, hapticTick, hintFadeAt, hintsAllowed, soulRing, swipeStep } from './touch.ts';

test('A1: the hints show on a first touch visit only, and fade once read', () => {
  const base = { search: '', webdriver: false, coarse: true, seen: false };
  assert.equal(hintsAllowed(base), true);
  assert.equal(hintsAllowed({ ...base, coarse: false }), false, 'not with a mouse');
  assert.equal(hintsAllowed({ ...base, seen: true }), false, 'once per device');
  assert.equal(hintsAllowed({ ...base, search: '?shot' }), false);
  assert.equal(hintsAllowed({ ...base, webdriver: true }), false, 'not under automation');
  assert.equal(hintsAllowed({ ...base, webdriver: true, search: '?hints=1' }), true, 'unless a proof asks');
  assert.equal(hintFadeAt(null), HINT_MS);
  assert.equal(hintFadeAt(100), HINT_MIN_MS, 'readable for HINT_MIN_MS whatever the person does');
  assert.equal(hintFadeAt(6000), 6000, 'dismissed by the next gesture');
});

test('A2: a vibration where navigator.vibrate exists on a touch screen, nothing elsewhere', () => {
  const got: number[] = [];
  const nav = { vibrate: (ms: number) => (got.push(ms), true) };
  assert.equal(hapticTick(nav, () => true), true);
  assert.deepEqual(got, [TICK_MS]);
  assert.equal(hapticTick(nav, () => false), false, 'not with a mouse');
  assert.equal(hapticTick({}, () => true), false, 'no vibrate: nothing');
  assert.equal(hapticTick(undefined, () => true), false);
  assert.equal(hapticTick({ vibrate: () => { throw new Error('blocked'); } }, () => true), false, 'a refusal is swallowed');
  assert.deepEqual(got, [TICK_MS]);
});

test('A3: a fast sideways flick is a swipe; a slow or vertical drag is not', () => {
  assert.equal(swipeStep(-120, 10, 200), 1, 'left: next');
  assert.equal(swipeStep(120, 10, 200), -1, 'right: previous');
  assert.equal(swipeStep(-120, 10, 900), 0, 'slow: the orbit');
  assert.equal(swipeStep(-40, 0, 100), 0, 'short');
  assert.equal(swipeStep(-120, 80, 200), 0, 'diagonal');
});

const touch = (pointerId: number, clientX: number, timeStamp: number, clientY = 300) => ({ pointerId, pointerType: 'touch', clientX, clientY, timeStamp });

test('A3: a pinch or a two-finger pan is never a swipe', () => {
  const f = new Flicks();
  f.pointerdown(touch(1, 300, 0));
  assert.equal(f.pointerup(touch(1, 150, 150)), 1, 'one finger flicks');
  // A pinch: the second finger spoils the gesture, even when the first lifts fast and far.
  f.pointerdown(touch(1, 300, 1000));
  f.pointerdown(touch(2, 200, 1010));
  assert.equal(f.pointerup(touch(1, 100, 1100)), 0);
  assert.equal(f.pointerup(touch(2, 50, 1120)), 0);
  // Every finger up: the next one-finger flick counts again.
  f.pointerdown(touch(3, 100, 2000));
  assert.equal(f.pointerup(touch(3, 250, 2100)), -1);
  // A mouse drag is the desktop's orbit.
  f.pointerdown({ ...touch(4, 300, 3000), pointerType: 'mouse' });
  assert.equal(f.pointerup({ ...touch(4, 100, 3100), pointerType: 'mouse' }), 0);
});

test('A3: the ring puts the heard first, then walkers, then the near; swipes walk it and come back', () => {
  const souls = [
    { id: 'a', p: [0, 0, 0] }, { id: 'far', p: [50, 0, 0] }, { id: 'near', p: [3, 0, 0] },
    { id: 'walker', p: [30, 0, 0], walking: true }, { id: 'talker', p: [80, 0, 0] },
  ];
  const t = 100e6;
  const ring = soulRing('a', souls, new Map([['talker', t - 5e6], ['far', t - 60e6]]), t);
  assert.deepEqual(ring, ['a', 'talker', 'walker', 'near', 'far']);
  const s = new SoulSwipe(), ids = souls.map((x) => x.id), make = () => ring;
  assert.equal(s.step('a', ids, 1, 0, make), 'talker');
  assert.equal(s.step('talker', ids, 1, 100, make), 'walker');
  assert.equal(s.step('walker', ids, -1, 200, make), 'talker', 'back');
  assert.equal(s.step('a', ['a'], 1, 300, () => ['a']), null, 'the only Soul here');
});
