// #3756 on the old page: a v2 gesture move plays the old renderer's gesture pose as the take's activity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleTake } from '../../../../mars/viewer/engine/take/replay.ts';
import type { Take } from '../../../../mars/viewer/engine/take/types.ts';
import { ACTIVITY_OVERLAYS } from '../../../../mars/viewer/app/engine-view/activity-poses.ts';
import { cut, gestureAt, gestureFrom, gestureOf } from './take-gestures.ts';
import { chunkOf, TICK_US, type Body } from './takes.ts';

const FROM = 2000, t0 = FROM * TICK_US, frame = { rulesVersion: 'test/1', datetime: null };

test('each gesture move names an old pose; other moves draw nothing', () => {
  for (const [move, want] of [['eden:wave', 'wave'], ['souls:nod@1', 'nod'], ['clap', 'clap'], ['point', 'point'], ['shake_head', 'shake-head'], ['bow', 'bow'], ['cheer', 'cheer']])
    assert.equal(gestureOf(move), want, move);
  for (const move of ['wave', 'nod', 'clap', 'point', 'shake_head', 'bow', 'cheer', 'shrug', 'look_around', 'slump'])
    assert.ok(ACTIVITY_OVERLAYS.has(gestureOf(move)!) || ['dance', 'jump', 'stretch', 'listen'].includes(gestureOf(move)!), `${move} is an old pose`);
  for (const move of ['consume', 'pour', 'press', 'look', 'souls:walk']) assert.equal(gestureOf(move), null, move);
});

test('a standing body plays the gesture from the move start to its end, then stands idle; a cancel ends it early', () => {
  const g = gestureFrom({ name: 'eden:clap', start: t0 + 200_000, ends: [t0 + 400_000, t0 + 600_000] })!;
  const body: Body = { entity: 'v2_a_1', soul: 'soul-a-1', name: 'Ada', heading: 0, samples: [{ at: t0 - 1_000_000, p: [0, 0, 0] }], gestures: [g] };
  const take = chunkOf([body], FROM, frame).take as unknown as Take, at = (s: number) => sampleTake(take, s).entities.v2_a_1.activity;
  assert.equal(at(0.1), 'idle');
  assert.equal(at(0.3), 'clap');
  assert.equal(at(0.55), 'clap');
  assert.equal(at(0.7), 'idle');
  cut(body.gestures!, t0 + 300_000);
  assert.equal(gestureAt(body.gestures, t0 + 350_000), null, 'the run ended at 0.3 s');
  assert.equal(gestureAt(body.gestures, t0 + 250_000), 'clap');
});

test('a seated body keeps sitting through a gesture', () => {
  const g = gestureFrom({ name: 'eden:nod', start: t0, ends: [t0 + 900_000] })!;
  const body: Body = { entity: 'v2_a_2', soul: 'soul-a-2', name: 'Bo', heading: 0, gestures: [g],
    samples: [{ at: t0 - 1_000_000, p: [0, 0, 0], seat: { height: 450, lie: false } }] };
  const take = chunkOf([body], FROM, frame).take as unknown as Take;
  assert.equal(sampleTake(take, 0.5).entities.v2_a_2.activity, 'sit');
});

test('an aimed gesture (0.134 B1) turns the standing body toward its target while it plays, then back', () => {
  // a lamp 6 m off along +z; the body last walked along +x, so it faces +x (yaw 0)
  const g = gestureFrom({ name: 'eden:point', start: t0 + 200_000, ends: [t0 + 700_000] }, [0, 6000])!;
  const body: Body = { entity: 'v2_a_3', soul: 'soul-a-3', name: 'Cy', heading: 0, gestures: [g],
    samples: [{ at: t0 - 2_000_000, p: [-1000, 0, 0] }, { at: t0 - 1_000_000, p: [0, 0, 0] }] };
  const take = chunkOf([body], FROM, frame).take as unknown as Take, at = (s: number) => sampleTake(take, s).entities.v2_a_3;
  assert.ok(Math.abs(at(0.1).yaw) < 0.01, 'before: as it walked');
  assert.equal(at(0.4).activity, 'point');
  assert.ok(Math.abs(at(0.4).yaw - Math.PI / 2) < 0.01, `pointing, it faces the lamp: ${at(0.4).yaw}`);
  assert.ok(Math.abs(at(0.9).yaw) < 0.01, 'after: back as it stood');
  const seated: Body = { ...body, entity: 'v2_a_4', samples: [{ at: t0 - 1_000_000, p: [0, 0, 0], seat: { height: 450, lie: false } }] };
  assert.ok(Math.abs(sampleTake(chunkOf([seated], FROM, frame).take as unknown as Take, 0.4).entities.v2_a_4.yaw) < 0.01, 'seated, it keeps its seat\'s way');
  assert.equal(gestureFrom({ name: 'eden:clap', start: t0, ends: [t0 + 1] })!.toward, undefined, 'no target: unaimed');
});
