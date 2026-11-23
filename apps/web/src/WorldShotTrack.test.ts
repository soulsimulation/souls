import assert from 'node:assert/strict';
import { test } from 'node:test';
import { livePose, parseShotTrack, poseNow, shotPose, shotTrackUrl } from './WorldShotTrack.ts';

const sample = (t: number, x: number) => ({ t, position: [x, 2, 0], target: [x, 1, 5], fov: 42, key: 'desired', cut: false, valid: true, readability: 1 });
const shot = { schema: 'souls-shot/1', fromTick: 100, toTick: 120, dt: 0.05, aspect: 0.8, move: 'track:L:medium', track: { schema: 'mars-camera-track/1', hz: 10, duration: 1, samples: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => sample(i / 10, i)) } };

test('a shot track gives the camera only inside its ticks', () => {
  const s = parseShotTrack(structuredClone(shot)); assert.ok(s);
  assert.equal(shotPose(s, 99), null); assert.deepEqual(shotPose(s, 125)!.position, [10, 2, 0], 'the last pose holds briefly'); assert.equal(shotPose(s, 141), null);
  assert.deepEqual(shotPose(s, 100)!.position, [0, 2, 0]);
  assert.ok(Math.abs(shotPose(s, 110)!.position[0] - 5) < 1e-9);
  assert.equal(shotPose(s, 120)!.fov, 42);
});
test('malformed tracks and foreign urls are refused', () => {
  assert.equal(parseShotTrack({ ...shot, schema: 'other' }), null);
  assert.equal(parseShotTrack({ ...shot, toTick: 100 }), null);
  assert.equal(parseShotTrack({ ...shot, track: { ...shot.track, samples: [{ ...sample(0, 0), fov: NaN }] } }), null);
  assert.equal(shotTrackUrl('?track=/shots/a.json'), '/shots/a.json');
  for (const bad of ['?track=https://elsewhere.example/a.json', '?track=//elsewhere.example/a.json', '?other=1']) assert.equal(shotTrackUrl(bad), null);
});
test('a live track runs by the clock from play(), holds its last pose, and never answers a range', () => {
  const live = parseShotTrack({ schema: 'souls-shot/1', live: true, seconds: 1, aspect: 1.6, move: 'path', track: structuredClone(shot.track) }); assert.ok(live);
  assert.equal(parseShotTrack({ schema: 'souls-shot/1', live: true, aspect: 1, move: 'x', track: shot.track }), null, 'a live track names its seconds');
  assert.equal(livePose(live, null), null); assert.equal(shotPose(live, 110), null);
  assert.ok(Math.abs(livePose(live, 0.5)!.position[0] - 5) < 1e-9); assert.deepEqual(livePose(live, 9)!.position, [10, 2, 0]);
  const range = parseShotTrack(structuredClone(shot))!;
  assert.equal(poseNow(range, null, 0), null, 'a range is shown only in recorded time');
  assert.deepEqual(poseNow(range, 100, 0)!.position, [0, 2, 0]);
});
