// Gestures on the page (#3741): a move record from the stream plays its clip over the posture with today's timing and
// returns to it; a cancel cuts it; a seated body keeps its legs; `Bow` is baked from the idle with today's bend.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { model } from '../pose/fixture.ts';
import { jointAt } from '../pose/pose.ts';
import type { BakedModel } from './bake.ts';
import { CrowdBodies } from './bodies.ts';
import { Crowd } from './crowd.ts';
import { GESTURE_CLIPS, Gestures, LEAVE, gestureAt } from './gestures.ts';

const S = 1_000_000;
const seconds = (n: string) => ({ Yes: 2.5, Idle_No_Loop: 2.5, Wave: 1.67, Bow: 1, Celebration: 4, Sitting_Nodding_Loop: 3 } as Record<string, number>)[n];
/** A move as `souls:form-move` carries it: content's phases from `start` (s). */
const move = (name: string, start: number, phases: number[], body = 'b.1') => {
  let at = start * S;
  return { body, name, start: start * S, ends: phases.map((p) => (at += p * S)), target: null };
};

test('nod and shake-head play Yes and Idle_No_Loop at 1.6x, in over start-up and out after the end', () => {
  const nod = move('nod', 10, [0.3, 1.2]);
  assert.equal(gestureAt([nod], 9.9 * S, false, seconds), null, 'not before its start');
  const mid = gestureAt([nod], 11 * S, false, seconds)!;
  assert.equal(mid.clip, 'Yes');
  assert.equal(mid.weight, 1, 'full after contact');
  assert.ok(Math.abs(mid.phase - (1 * 1.6) / 2.5) < 1e-9, 'one second in, at 1.6x of a 2.5 s clip');
  assert.ok(gestureAt([nod], 10.15 * S, false, seconds)!.weight < 1, 'coming in over start-up');
  assert.ok(gestureAt([nod], (11.5 + LEAVE / 2) * S, false, seconds)!.weight < 1, 'leaving after its end');
  assert.equal(gestureAt([nod], (11.5 + LEAVE + 0.01) * S, false, seconds), null, 'back to the posture');
  const shake = gestureAt([move('shake_head', 0, [0.3, 1.2])], 1 * S, false, seconds)!;
  assert.deepEqual([shake.clip, shake.phase], ['Idle_No_Loop', 1.6 / 2.5]);
});

test('every mapped move draws its clip; a move with none, or a model without the clip, draws nothing new', () => {
  for (const [name, g] of Object.entries(GESTURE_CLIPS)) assert.equal(gestureAt([move(name, 0, [0.3, 1])], 0.5 * S, false, () => 1)?.clip, g.clip, name);
  assert.equal(gestureAt([move('press', 0, [0.3, 1])], 0.5 * S, false, seconds), null);
  assert.equal(gestureAt([move('wave', 0, [0.3, 0.9])], 0.5 * S, false, () => undefined), null);
});

test('a one-shot is fitted to the move; seated, nod plays its seated clip', () => {
  const bow = move('bow', 0, [0.5, 0.6]);
  assert.ok(Math.abs(gestureAt([bow], 0.55 * S, false, seconds)!.phase - 0.5) < 1e-9, 'half way through the move, half the clip');
  assert.equal(gestureAt([bow], 1.1 * S, false, seconds)!.phase, 0.999, 'held at its end');
  assert.equal(gestureAt([move('nod', 0, [0.3, 1.2])], 1 * S, true, seconds)!.clip, 'Sitting_Nodding_Loop');
});

test('the store keeps each body\'s moves from the parts, once each, and a run ended early cuts its move', () => {
  const g = new Gestures();
  const wave = move('wave', 5, [0.3, 0.9]);
  g.apply({ moves: [wave], removed: [] });
  g.apply({ moves: [wave], removed: [] });
  assert.equal(g.moves.get('b.1')!.length, 1, 'a part played twice adds nothing');
  g.apply({ runEnds: [{ body: 'b.1', at: 5.5 * S, how: 'souls:claim-taken' }], removed: [] });
  assert.equal(g.at('b.1', (5.5 + LEAVE + 0.01) * S, false, seconds), null, 'gone after the cut');
  g.apply({ runEnds: [{ body: 'b.1', at: 9 * S, how: 'souls:done' }], removed: [] });
  assert.equal(g.moves.get('b.1')![0].cut, 5.5 * S, 'a later ending changes nothing');
  g.apply({ removed: ['b.1'] });
  assert.equal(g.moves.has('b.1'), false);
});

test('the crowd draws a gesture over idle, and above the hips only over a seat', () => {
  const m: BakedModel = model([new THREE.AnimationClip('Yes', 2.5, []), new THREE.AnimationClip('Idle_No_Loop', 2.5, []), new THREE.AnimationClip('Sitting_Idle_Loop', 2, [])]);
  const crowd = new Crowd([m], 4), bodies = new CrowdBodies(crowd);
  bodies.gestures.apply({ moves: [move('nod', 1, [0.3, 1.2], 'a'), move('shake_head', 1, [0.3, 1.2], 'b')], removed: [] });
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(0, 10, 30);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  for (const t of [0, 2 * S]) {
    bodies.begin(t);
    bodies.place('a', 0, 0, 0);
    bodies.place('b', 2, 0, 0, true);
    bodies.end(camera);
  }
  const yes = crowd.clip(0, 'Yes');
  assert.deepEqual([crowd.clipA[0], crowd.clipB[0], crowd.blend[0]], [crowd.clip(0, 'Idle'), yes, 1], 'standing: whole body');
  assert.deepEqual([crowd.clipA[1], crowd.clipB[1], crowd.blend[1]], [crowd.clip(0, 'Sitting_Idle_Loop'), crowd.clip(0, 'Idle_No_Loop'), 3], 'seated: above the hips');
  assert.deepEqual([...m.upper.keys()].filter((b) => m.upper[b]).map((b) => m.names[b]).includes('UpperLeg.L'), false, 'legs are not upper');
  assert.ok(m.upper[m.names.indexOf('Chest')] === 1 && m.upper[m.names.indexOf('Abdomen')] === 1);
  bodies.begin(4 * S);
  bodies.place('a', 0, 0, 0);
  bodies.end(camera);
  assert.deepEqual([crowd.clipB[0], crowd.blend[0]], [crowd.clip(0, 'Walk'), 0], 'back to the posture');
});

test('Bow is baked from the idle: the head goes forward and down at its middle, and stands at its ends', () => {
  const m = model([], ['Bow']), c = m.clips.find((k) => k.name === 'Bow')!, row = m.bones * 12;
  const data = m.bake.image.data as Float32Array, head = m.names.indexOf('Chest');
  const at = (f: number) => jointAt(m, data.slice((c.start + f) * row, (c.start + f + 1) * row), head);
  const [first, mid, last] = [at(0), at(Math.floor(c.frames / 2)), at(c.frames - 1)];
  assert.equal(c.seconds, 1);
  assert.ok(mid[2] - first[2] > 0.05, `forward: ${first} to ${mid}`);
  assert.ok(mid[1] < first[1], 'and down');
  assert.ok(Math.hypot(last[0] - first[0], last[1] - first[1], last[2] - first[2]) < 1e-3, 'upright again');
  const idle = m.clips.find((k) => k.name === 'Idle')!;
  assert.equal(m.clips.indexOf(idle), 0, 'the other clips bake as before');
});
