import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityFrame } from './activity-poses.ts';
import { ACT_BLEND, GET_UP, LIE_DOWN, TILT, blendFrames, lastPostureChange, postureKind, postureNow } from './posture-transition.ts';

test('posture kinds of the exercise and rest activities', () => {
  assert.equal(postureKind('situps'), 'back');
  assert.equal(postureKind('lie'), 'back');
  assert.equal(postureKind('pushups'), 'front');
  assert.equal(postureKind('jumping-jacks'), 'stand');
  assert.equal(postureKind('read', 'sit'), 'seat');
  assert.equal(postureKind('sit-ground'), 'ground');
});

test('sit-ups to jumping jacks: the body gets up from its back (LayToIdle 0 → 1), then the jacks ease in', () => {
  const at = (age: number) => postureNow('situps', undefined, 'jumping-jacks', 'jumping-jacks', undefined, age);
  assert.equal(at(0)!.rise, 0);
  let last = 0;
  for (let age = 0; age < GET_UP; age += 0.05) { const r = at(age)!.rise!; assert.ok(r >= last && r - last < 0.12, `rise ${r} after ${last}`); last = r; }
  assert.ok(last > 0.99);
  const s = at(GET_UP + ACT_BLEND / 2)!;
  assert.equal(s.rise, undefined);
  assert.ok(s.settle > 0 && s.settle < 1);
  assert.equal(at(GET_UP + ACT_BLEND + 0.01), null);
});

test('standing to sit-ups lies down; standing to push-ups tilts the plank down from the feet', () => {
  const lie = postureNow('idle', undefined, 'situps', 'situps', undefined, 0)!;
  assert.equal(lie.rise, 1);
  assert.ok(postureNow('idle', undefined, 'situps', 'situps', undefined, LIE_DOWN - 0.05)!.rise! < 0.02);
  const tilt = postureNow('jumping-jacks', undefined, 'pushups', 'pushups', undefined, TILT / 2)!.tilt!;
  assert.equal(tilt.act, 'pushups');
  assert.ok(tilt.k > 0 && tilt.k < 1);
  const up = postureNow('pushups', undefined, 'idle', 'idle', undefined, 0)!.tilt!;
  assert.deepEqual(up, { act: 'pushups', k: 1 });
});

test('back to face down gets up then goes down, within the second the history keeps', () => {
  const at = (age: number) => postureNow('situps', undefined, 'pushups', 'pushups', undefined, age);
  assert.equal(at(0)!.rise, 0);
  assert.ok(at(0.8)!.tilt);
  assert.equal(at(1.01), null);
});

test('a seat: straight from standing to sit draws sit-down, from sit to standing stand-up; the old engine phases are left alone', () => {
  assert.deepEqual(postureNow('idle', undefined, 'sit', 'sit', undefined, 0.3), { activity: 'sit-down', since: 0.3, settle: 0 });
  assert.deepEqual(postureNow('sit', undefined, 'idle', 'idle', undefined, 0.2), { activity: 'stand-up', since: 0.2, settle: 0 });
  assert.equal(postureNow('idle', undefined, 'sit-down', 'sit', undefined, 0.3), null);
  assert.equal(postureNow('stand-up', undefined, 'idle', 'idle', undefined, 0.1), null);
});

test('no transition while the body walks off, or without a change of posture', () => {
  assert.equal(postureNow('situps', undefined, 'idle', 'walk', undefined, 0.2), null);
  assert.equal(postureNow('idle', undefined, 'jumping-jacks', 'jumping-jacks', undefined, 0.1), null);
  assert.equal(postureNow(undefined, undefined, 'idle', 'idle', undefined, 0.1), null);
});

test('the latest posture change in a history survives an idle tick between two exercises', () => {
  // sit-ups from tick 0, idle for one tick at 40, jumping jacks from 41
  const t = [0, 40, 41], v = ['situps', 'idle', 'jumping-jacks'];
  const c = lastPostureChange(t, v, 2, 45, 0.05, () => undefined)!;
  assert.deepEqual({ from: c.from, to: c.to }, { from: 'situps', to: 'idle' });
  assert.ok(Math.abs(c.age - 0.25) < 1e-9);
  assert.ok(postureNow(c.from, c.fromBase, c.to, 'jumping-jacks', undefined, c.age)!.rise! > 0);
  assert.equal(lastPostureChange(t, v, 2, 40 + 40, 0.05, () => undefined), null); // 2 s later: over
});

test('a frame crossfade moves each hand from one goal to the other, never in one step', () => {
  const a = activityFrame('jumping-jacks', 'idle', 1.3, 's1'), b = activityFrame('stretch', 'idle', 1.3, 's1');
  assert.ok(a && b);
  let prev = blendFrames(a, b, 0)!;
  for (let k = 0.1; k <= 1.0001; k += 0.1) {
    const f = blendFrames(a, b, Math.min(1, k))!;
    for (const i of [0, 1] as const) {
      const p = prev.hands?.[i], q = f.hands?.[i];
      if (p && q) assert.ok(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 0.5);
    }
    assert.ok(Math.abs(f.feetOut - prev.feetOut) < 0.1);
    prev = f;
  }
  const off = blendFrames(a, null, 0.75)!;
  for (const i of [0, 1] as const) if (a.hands?.[i]) assert.ok(Math.abs(off.handW![i] - 0.25) < 1e-9);
  assert.equal(blendFrames(null, null, 0.5), null);
});
