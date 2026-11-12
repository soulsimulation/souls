import assert from 'node:assert/strict';
import test from 'node:test';
import { CARD_SIGHT, cardLook, fadeCard, type CardSight } from './WorldCardSight.ts';

// #2195: name cards show selectively. A ground camera ~1.7 m up, focused ~10 m ahead.
const ground = (o: Partial<CardSight> = {}): CardSight => ({ mine: false, revealed: false, state: 'awake', distance: 8, height: 1.7, depth: 8, focusDepth: 10, occluded: false, ...o });
const sky = (o: Partial<CardSight> = {}): CardSight => ground({ height: 40, distance: 45, depth: 44, focusDepth: 45, ...o });

test('another owner\'s awake Soul near the focus shows, quieter than full strength', () => {
  const l = cardLook(ground());
  assert.equal(l.opacity, CARD_SIGHT.other); assert.equal(l.emphasis, false);
  assert.ok(l.opacity < 1);
});

test('asleep, idle and zombie Souls of others are much quieter and have a shorter reach; speaking makes them active', () => {
  for (const state of ['asleep', 'idle', 'zombie'] as const) {
    assert.equal(cardLook(ground({ state, distance: 6, depth: 6 })).opacity, CARD_SIGHT.quiet);
    assert.ok(cardLook(ground({ state, distance: 6, depth: 6 })).opacity <= cardLook(ground({ distance: 6, depth: 6 })).opacity / 2);
    assert.equal(cardLook(ground({ state, distance: 11, depth: 11, focusDepth: 14 })).opacity, 0, `${state} beyond its shorter reach`);
  }
  assert.equal(cardLook(ground({ state: 'asleep', speaking: true, distance: 6, depth: 6 })).opacity, CARD_SIGHT.other);
});

test('others hide when occluded, behind the camera, or well behind the focus', () => {
  assert.equal(cardLook(ground({ occluded: true })).opacity, 0);
  assert.equal(cardLook(ground({ depth: -1 })).opacity, 0);
  assert.equal(cardLook(ground({ distance: 15.5, depth: 15.5 })).opacity, 0, 'focus 10 m, margin 4 m');
  assert.ok(cardLook(ground({ distance: 13.5, depth: 13.5 })).opacity > 0, 'within the margin');
  assert.ok(cardLook(ground({ focusDepth: null, distance: 13.5, depth: 13.5 })).opacity > 0, 'no focus: reach only');
});

test('others\' reach grows with camera height and the card fades near its edge rather than popping', () => {
  const at = (height: number, distance: number) => cardLook(ground({ height, distance, depth: distance, focusDepth: null })).opacity;
  const reach = (h: number) => CARD_SIGHT.reachM + CARD_SIGHT.reachPerHeightM * h;
  assert.equal(at(1.7, reach(1.7) + 0.1), 0);
  assert.ok(at(20, reach(1.7) + 0.1) > 0, 'a higher camera reaches further');
  // a monotone ramp to zero over the last share of the reach, no step
  let previous = at(1.7, 0.5);
  for (let d = 0.5; d < reach(1.7) + 1; d += 0.25) { const o = at(1.7, d); assert.ok(o <= previous + 1e-9); assert.ok(previous - o < 0.1, `no pop at ${d} m`); previous = o; }
  // straight down from 40 m, others are past their reach: the sky view is not a sheet of names
  assert.equal(cardLook(sky()).opacity, 0);
});

test('your own Souls show when visible from the ground and are hidden only by scenery or the camera\'s back', () => {
  assert.deepEqual(cardLook(ground({ mine: true })), { opacity: 1, emphasis: false });
  assert.equal(cardLook(ground({ mine: true, distance: 40, depth: 40, state: 'asleep' })).opacity, 1, 'past others\' reach and the focus, asleep');
  assert.equal(cardLook(ground({ mine: true, occluded: true })).opacity, 0);
  assert.equal(cardLook(ground({ mine: true, depth: 0 })).opacity, 0);
});

test('from a high or far camera your own Souls show, emphasised, even when hidden or far', () => {
  assert.deepEqual(cardLook(sky({ mine: true })), { opacity: 1, emphasis: true });
  assert.deepEqual(cardLook(sky({ mine: true, occluded: true, distance: 200, depth: 200 })), { opacity: 1, emphasis: true });
  assert.deepEqual(cardLook(ground({ mine: true, focusDepth: 40, distance: 120, depth: 120 })), { opacity: 1, emphasis: true }, 'far focus');
});

test('hover or selection reveals any card at full strength', () => {
  for (const s of [ground({ occluded: true }), ground({ state: 'asleep', distance: 60, depth: 60 }), sky(), ground({ distance: 30, depth: 30 })])
    assert.equal(cardLook({ ...s, revealed: true }).opacity, 1);
  assert.equal(cardLook(ground({ revealed: true, depth: -2 })).opacity, 0, 'never a card for a body behind the camera');
});

test('bad numbers hide the card instead of throwing', () => {
  assert.equal(cardLook(ground({ distance: Number.NaN })).opacity, 0);
  assert.equal(cardLook(ground({ height: Number.POSITIVE_INFINITY })).opacity, 0);
});

test('fadeCard eases toward its target and settles', () => {
  let o = 0; const seen: number[] = [];
  for (let i = 0; i < 30; i++) { o = fadeCard(o, 1, 1 / 60); seen.push(o); }
  assert.ok(seen[0] > 0 && seen[0] < 0.3, 'not a pop');
  assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]));
  assert.equal(o, 1, 'settles within half a second');
  assert.equal(fadeCard(Number.NaN, 0.4, 1 / 60), 0.4);
  assert.equal(fadeCard(0.5, 1, 0), 0.5);
});
