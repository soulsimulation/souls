// Clap, point, shrug and stretch (#3757), made at bake time from the rig with today's hand goals: each reaches its
// pose in its middle and starts and ends on the idle, so its weight only blends poses near each other.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { model } from '../pose/fixture.ts';
import { jointAt } from '../pose/pose.ts';
import { CLIPS } from './bodies.ts';
import { GESTURE_CLIPS } from './gestures.ts';
import { MAX_CLIPS } from './shader.ts';

const m = model([], ['Clap', 'Point', 'Shrug', 'Stretch']);
const row = m.bones * 12, data = m.bake.image.data as Float32Array;
/** Joint `bone` of clip `clip` at fraction `u`, in the model's space (+z ahead, +x the body's left). */
const at = (clip: string, u: number, bone: string) => {
  const c = m.clips.find((k) => k.name === clip)!, f = c.start + Math.round(u * (c.frames - 1));
  return jointAt(m, data.slice(f * row, (f + 1) * row), m.names.indexOf(bone));
};
const idle = (bone: string) => at('Idle', 0, bone);
const near = (a: number[], b: number[], tol = 1e-3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;
const ends = (clip: string) => {
  for (const b of ['Wrist.L', 'Wrist.R', 'UpperArm.L', 'Chest', 'Middle1.R']) {
    assert.ok(near(at(clip, 0, b), idle(b)), `${clip} starts on the idle (${b})`);
    assert.ok(near(at(clip, 1, b), idle(b)), `${clip} ends on the idle (${b})`);
  }
};

test('the four moves play their made clips, fitted to the move, and every model\'s clips fit the shader', () => {
  for (const [move, clip] of [['clap', 'Clap'], ['point', 'Point'], ['shrug', 'Shrug'], ['stretch', 'Stretch']]) {
    assert.deepEqual(GESTURE_CLIPS[move], { clip, mode: 'once' });
    assert.ok(m.clips.some((k) => k.name === clip), `${clip} baked`);
  }
  assert.ok(CLIPS.length <= MAX_CLIPS, `${CLIPS.length} clips`);
});

test('clap: both hands come in front of the chest and meet near the middle, at today\'s 2.2 a second', () => {
  ends('Clap');
  const sh = idle('UpperArm.L');
  // |sin(pi * 2.2 * t)| is 0 at t = 1/2.2 s: the hands together, 0.45 s into the 0.9 s move.
  const l = at('Clap', 0.505, 'Wrist.L'), r = at('Clap', 0.505, 'Wrist.R');
  assert.ok(l[2] - sh[2] > 0.25 && r[2] - sh[2] > 0.25, `ahead of the shoulders: ${l} ${r}`);
  assert.ok(Math.abs(l[0] - r[0]) < 0.08, `together: ${l[0]} ${r[0]}`);
  assert.ok(l[1] < sh[1] && l[1] > sh[1] - 0.35, 'below the shoulders, at the chest');
  const apart = at('Clap', 0.75, 'Wrist.L')[0] - at('Clap', 0.75, 'Wrist.R')[0];
  assert.ok(apart > Math.abs(l[0] - r[0]) + 0.04, `apart again between claps: ${apart}`);
});

test('point: the right hand reaches out ahead at shoulder height and holds; the left stays', () => {
  ends('Point');
  const sh = idle('UpperArm.R');
  for (const u of [0.45, 0.6]) {
    const r = at('Point', u, 'Wrist.R');
    assert.ok(r[2] - sh[2] > 0.4, `out ahead: ${r}`);
    assert.ok(Math.abs(r[1] - sh[1]) < 0.12, `at shoulder height: ${r[1]} ${sh[1]}`);
  }
  assert.ok(near(at('Point', 0.5, 'Wrist.L'), idle('Wrist.L')), 'the left hand stays');
});

test('shrug: the shoulders rise and the forearms open forward, and come back', () => {
  ends('Shrug');
  const up = at('Shrug', 0.5, 'UpperArm.L')[1] - idle('UpperArm.L')[1], upR = at('Shrug', 0.5, 'UpperArm.R')[1] - idle('UpperArm.R')[1];
  assert.ok(up > 0.015 && upR > 0.015, `shoulders up: ${up} ${upR}`);
  const l = at('Shrug', 0.5, 'Wrist.L'), r = at('Shrug', 0.5, 'Wrist.R');
  assert.ok(l[2] - idle('Wrist.L')[2] > 0.1 && r[2] - idle('Wrist.R')[2] > 0.1, 'forearms forward');
  assert.ok(l[0] > idle('UpperArm.L')[0] && r[0] < idle('UpperArm.R')[0], 'hands out past the shoulders');
});

test('stretch: both hands go up over the head and the body leans to one side, then the other', () => {
  ends('Stretch');
  const head = idle('Chest')[1] + 0.3;
  for (const w of ['Wrist.L', 'Wrist.R']) assert.ok(at('Stretch', 0.5, w)[1] > head, `${w} overhead: ${at('Stretch', 0.5, w)}`);
  const a = at('Stretch', 0.4, 'Chest')[0], b = at('Stretch', 0.62, 'Chest')[0];
  assert.ok(Math.sign(a) !== Math.sign(b) && Math.abs(a) > 0.01 && Math.abs(b) > 0.01, `leans both ways: ${a} ${b}`);
});
