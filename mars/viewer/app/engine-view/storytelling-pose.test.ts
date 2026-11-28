import test from 'node:test';
import assert from 'node:assert/strict';
import {activityFrame, idPhase} from './activity-poses.ts';

const period = 3 / .23;
const pose = (seconds: number, id = 'presenter') => activityFrame('tell-story', 'idle', seconds, id)!;
const distance = (a: ReturnType<typeof pose>, b: ReturnType<typeof pose>) => Math.max(...a.hands!.map((p, i) => Math.hypot(...p!.map((x, j) => x - b.hands![i]![j]))));

test('storytelling hand goals remain continuous through every phrase boundary and cycle wrap', () => {
  for (const id of ['presenter', 'guest', 'audience-questioner']) {
    for (let boundary = 1; boundary <= 6; boundary++) {
      const seconds = boundary / .23 - idPhase(id) * 7;
      const delta = distance(pose(seconds - 1e-6, id), pose(seconds + 1e-6, id));
      assert(delta < .00001, `${id} phrase ${boundary} jumps ${delta} m`);
    }
  }
});

test('a complete storytelling cycle has bounded hand speed and natural reachable goals', () => {
  const step = 1 / 120;
  let before = pose(0), maxSpeed = 0;
  for (let i = 1; i <= Math.ceil(period / step); i++) {
    const after = pose(i * step);
    maxSpeed = Math.max(maxSpeed, distance(before, after) / step);
    for (const hand of after.hands!) {
      assert(hand && hand.every(Number.isFinite));
      assert(hand[0] >= .03 && hand[0] <= .44, 'hands stay in front of the shoulder');
      assert(hand[1] >= -.08 && hand[1] <= .25, 'hands do not cross through the torso');
      assert(hand[2] >= -.65 && hand[2] <= .12, 'hands stay below the face');
      assert(Math.hypot(...hand) <= .65, 'the shoulder goal stays within ordinary arm reach');
    }
    before = after;
  }
  assert(maxSpeed < 1.3, `maximum hand-goal speed ${maxSpeed} m/s`);
});

test('storytelling preserves actor phase, underlying posture and random-access evaluation', () => {
  for (const seconds of [0, 1.3, 5, 9, period - .0001]) {
    const frame = pose(seconds), later = pose(seconds + period);
    assert(distance(frame, later) < .00001, 'the phrase cycle is periodic');
    assert.deepEqual(activityFrame('tell-story', 'sit', seconds, 'presenter'), frame, 'this upper-body overlay does not replace the seat');
    assert.equal(frame.hop, 0);
    assert.equal(frame.feetOut, 0);
    assert.equal(frame.lying, null);
    pose(seconds + 40);
    assert.deepEqual(pose(seconds), frame, 'a seek cannot inherit another sampled phase');
  }
  assert(distance(pose(0, 'presenter'), pose(0, 'guest')) > .01, 'existing per-actor phase remains visible');
});
